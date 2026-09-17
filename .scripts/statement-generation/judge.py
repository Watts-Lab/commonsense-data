"""Evaluate generated statements with a separate OpenRouter model."""

import argparse
import csv
import hashlib
import json
import os
import traceback
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from pathlib import Path
from string import Template

import jsonschema
import yaml
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

from generate import FEATURE_DEFINITIONS, get_reasoning_config, parse_llm_json

ROOT = Path(__file__).resolve().parent
with (ROOT / "judge_prompt.yml").open(encoding="utf-8") as handle:
    PROMPT_CONFIG = yaml.safe_load(handle)

FEATURE_KEYS = [pair.split("/")[0] for pair in FEATURE_DEFINITIONS]
COLUMNS = [
    "source_id",
    "source_row",
    "statement",
    "design_point",
    "gen_model",
    "judge_model",
    *[
        f"{key}_{field}"
        for key in FEATURE_KEYS
        for field in ("classification", "confidence", "explanation")
    ],
    "commonsense",
    "commonsense_explanation",
]


def create_prompt(statement):
    definitions = []
    response_format = deepcopy(PROMPT_CONFIG["response_format"])
    features_schema = response_format["json_schema"]["schema"]["properties"]["features"]
    for number, (pair, choices) in enumerate(FEATURE_DEFINITIONS.items(), start=1):
        key = pair.split("/")[0]
        definitions.append(
            f"{number}. {pair.replace('/', ' or ')}:\n"
            + "\n".join(
                f"- {label}: {details['definition']}"
                for label, details in choices.items()
            )
        )
        feature_schema = deepcopy(PROMPT_CONFIG["feature_schema"])
        feature_schema["properties"]["classification"]["enum"] = list(choices)
        features_schema["properties"][key] = feature_schema
        features_schema["required"].append(key)
    prompt = Template(PROMPT_CONFIG["template"]).substitute(
        statement_json=json.dumps(statement, ensure_ascii=False),
        feature_definitions="\n\n".join(definitions),
        response_schema=json.dumps(response_format["json_schema"]["schema"], indent=2),
    )
    return prompt, response_format


def load_statements(path, model_name):
    records = []
    occurrences = {}
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if "statement" not in (reader.fieldnames or []):
            raise ValueError(f"Missing statement column in {path}")
        for number, row in enumerate(reader, 1):
            if not (row.get("statement") or "").strip():
                raise ValueError(f"Empty statement at source row {number}")
            if row.get("model") and row["model"] != model_name:
                raise ValueError(
                    f"Unexpected model at source row {number}: {row['model']}"
                )
            # Preserve duplicate source rows while detecting edited source content.
            digest = hashlib.sha256(
                json.dumps(row, sort_keys=True).encode()
            ).hexdigest()
            occurrences[digest] = occurrences.get(digest, 0) + 1
            records.append(
                {
                    "source_id": f"{digest}:{occurrences[digest]}",
                    "source_row": number,
                    "statement": row["statement"],
                    "design_point": row.get("design_point", ""),
                    "gen_model": model_name,
                }
            )
    return records


def load_completed(path, gen_model, judge_model):
    if not path.exists() or path.stat().st_size == 0:
        return set()
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != COLUMNS:
            raise ValueError(
                f"Evaluation CSV {path} does not use the six-feature schema. Move it aside before rerunning; old evaluations are preserved."
            )
        completed = set()
        for row in reader:
            if row["gen_model"] != gen_model or row["judge_model"] != judge_model:
                raise ValueError(f"Unexpected model in {path}")
            evaluation = {
                "features": {
                    key: {
                        "classification": row[f"{key}_classification"],
                        "confidence": int(row[f"{key}_confidence"]),
                        "explanation": row[f"{key}_explanation"],
                    }
                    for key in FEATURE_KEYS
                },
                "commonsense_explanation": row["commonsense_explanation"],
            }
            # Accept prior boolean CSVs when resuming; new judgments use 0/1.
            commonsense_values = {"0": 0, "1": 1, "False": 0, "True": 1}
            if row["commonsense"] not in commonsense_values:
                raise ValueError(f"Invalid commonsense value in {path}")
            evaluation["commonsense"] = commonsense_values[row["commonsense"]]
            jsonschema.validate(
                evaluation, create_prompt(row["statement"])[1]["json_schema"]["schema"]
            )
            completed.add(row["source_id"])
        return completed


class UsageTracker:
    """Track every returned attempt, including invalid responses, across workers."""
    def __init__(self):
        self.lock = threading.Lock()
        self.cost = 0.0
        self.requests = 0
        self.missing_cost = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0

    def record(self, response, row_number, attempt):
        usage = getattr(response, "usage", None)
        router_cost = getattr(usage, "cost", None)
        details = getattr(usage, "cost_details", None) or {}
        upstream_cost = details.get("upstream_inference_cost")
        if upstream_cost is None:
            parts = [details.get("upstream_inference_prompt_cost"),
                     details.get("upstream_inference_completions_cost")]
            if all(isinstance(value, (int, float)) for value in parts):
                upstream_cost = sum(parts)
        is_byok = bool(getattr(usage, "is_byok", False))
        # BYOK bills inference at the provider; usage.cost is only the router fee.
        # Never add the upstream total to its input/output components again.
        if is_byok:
            cost = (float(router_cost) + float(upstream_cost)
                    if router_cost is not None and upstream_cost is not None else None)
        else:
            cost = router_cost
        with self.lock:
            self.requests += 1
            self.prompt_tokens += getattr(usage, "prompt_tokens", 0) or 0
            self.completion_tokens += getattr(usage, "completion_tokens", 0) or 0
            if cost is None:
                self.missing_cost += 1
            else:
                self.cost += float(cost)
            request_cost = "unavailable" if cost is None else f"${float(cost):.6f}"
            tqdm.write(f"Row {row_number}, attempt {attempt}: cost={request_cost}; "
                       f"total reported cost=${self.cost:.6f}; responses={self.requests}"
                       + (f"; BYOK router={router_cost}, provider={upstream_cost}" if is_byok else ""))

    def summary(self):
        return (f"Total reported cost: ${self.cost:.6f}; responses: {self.requests}; "
                f"input tokens: {self.prompt_tokens}; output tokens: {self.completion_tokens}; "
                f"responses without cost: {self.missing_cost}. "
                "Includes retries and invalid responses; excludes charges absent from API responses.")


def evaluate_statement(record, judge_model, client, reasoning_config, max_retries=3, usage_tracker=None, response_mode="json_object"):
    prompt, response_format = create_prompt(record["statement"])
    jsonschema.Draft202012Validator.check_schema(response_format["json_schema"]["schema"])
    messages = [
        *([{"role": "system", "content": PROMPT_CONFIG["system"]}]
          if PROMPT_CONFIG.get("system") else []),
        {"role": "user", "content": prompt},
    ]
    extra_body = deepcopy(reasoning_config)
    extra_body.setdefault("provider", {})["require_parameters"] = True
    for attempt in range(max_retries):
        response = client.chat.completions.create(
            model=judge_model,
            messages=messages,
            max_tokens=16384,
            response_format=(response_format if response_mode == "json_schema"
                             else {"type": "json_object"}),
            extra_body=extra_body,
        )
        if usage_tracker is not None:
            usage_tracker.record(response, record["source_row"], attempt + 1)
        try:
            message = response.choices[0].message
            if getattr(message, "refusal", None):
                raise ValueError(f"Judge refused: {message.refusal}")
            if response.choices[0].finish_reason == "length":
                raise ValueError("Judge response exceeded the token limit")
            result = parse_llm_json(message.content or "")
            jsonschema.validate(result, response_format["json_schema"]["schema"])
            flattened = {
                f"{key}_{field}": value
                for key, details in result["features"].items()
                for field, value in details.items()
            }
            return dict(
                record,
                judge_model=judge_model,
                **flattened,
                commonsense=result["commonsense"],
                commonsense_explanation=result["commonsense_explanation"],
            )
        except (ValueError, AssertionError, jsonschema.ValidationError) as exc:
            if isinstance(exc, jsonschema.ValidationError):
                detail = f"{exc.json_path}: {exc.message}"
            else:
                detail = f"{type(exc).__name__}: {exc}"
            choice = response.choices[0]
            raw_content = choice.message.content or ""
            preview = raw_content[:2000]
            if len(raw_content) > 2000:
                preview += "… [truncated]"
            diagnostic = (
                f"Row {record['source_row']}, attempt {attempt + 1}/{max_retries}: "
                f"{detail}\nFinish reason: {choice.finish_reason}\n"
                f"Response preview: {preview!r}"
            )
            tqdm.write(diagnostic)
            if attempt == max_retries - 1:
                # Avoid jsonschema's enormous schema dump in the final traceback.
                raise ValueError(f"Judge response invalid: {detail}") from None
            messages.append({"role": "user", "content": Template(
                PROMPT_CONFIG["retry_template"]
            ).substitute(error=detail)})
            tqdm.write(
                f"Row {record['source_row']}: retrying ({attempt + 2}/{max_retries})."
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gen", required=True, help="Model that generated the statements."
    )
    parser.add_argument(
        "--judge", required=True, help="OpenRouter model used to evaluate them."
    )
    parser.add_argument(
        "--workers", type=int, default=4, help="Concurrent requests (default: 4)."
    )
    parser.add_argument(
        "--random-prompt-view",
        action="store_true",
        help="Preview one prompt and schema without API calls.",
    )
    parser.add_argument(
        "--response-mode", choices=["json_object", "json_schema"], default="json_object",
        help="API response mode; both modes enforce the full schema locally (default: json_object).",
    )
    parser.add_argument("--limit", type=int, help="Evaluate at most this many pending rows.")
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be positive")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    gen_dir = ROOT / "data" / args.gen.replace("/", "--")
    output = gen_dir / "evaluations" / args.judge.replace("/", "--") / "statements.csv"
    records = load_statements(gen_dir / "statements.csv", args.gen)
    if args.random_prompt_view:
        import random

        if not records:
            parser.error("No statements available to preview")
        prompt, schema = create_prompt(random.choice(records)["statement"])
        print(
            PROMPT_CONFIG.get("system", ""),
            prompt,
            json.dumps(schema, indent=2),
            sep="\n\n",
        )
        return
    if args.judge.endswith(":batch"):
        import sys
        from judge_batch import run_batch

        run_batch(args, records, output, sys.modules[__name__])
        return
    completed = load_completed(output, args.gen, args.judge)
    pending = [row for row in records if row["source_id"] not in completed]
    print(f"Generator: {args.gen}; judge: {args.judge}")
    print(
        f"{len(records) - len(pending)}/{len(records)} source rows already evaluated; {len(pending)} remaining."
    )
    if not pending:
        print("No judge queries needed.")
        return
    if args.limit is not None:
        pending = pending[:args.limit]
        print(f"This run is limited to {len(pending)} pending rows.")
    print(f"Response mode: {args.response_mode}; full local schema validation enabled.")
    reasoning_config = get_reasoning_config(args.judge)
    load_dotenv(ROOT / ".env")
    client = OpenAI(
        base_url="https://openrouter.ai/api/v1", api_key=os.getenv("OPENROUTER_API_KEY")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    wrote_header = output.exists() and output.stat().st_size > 0
    print(f"Saving evaluations to {output}")
    failures = []
    saved = 0
    usage_tracker = UsageTracker()
    with client, ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                evaluate_statement, row, args.judge, client, reasoning_config,
                usage_tracker=usage_tracker, response_mode=args.response_mode,
            ): row
            for row in pending
        }
        for future in tqdm(as_completed(futures), total=len(futures)):
            row = futures[future]
            try:
                result = future.result()
                with output.open("a", newline="", encoding="utf-8") as handle:
                    writer = csv.DictWriter(handle, fieldnames=COLUMNS)
                    if not wrote_header:
                        writer.writeheader()
                    writer.writerow(result)
                wrote_header = True
                saved += 1
                tqdm.write(f"Done: row {row['source_row']} ({saved}/{len(pending)} saved)")
            except Exception as exc:
                error = f"Row {row['source_row']} ({row['source_id']}): {type(exc).__name__}: {exc}"
                failures.append(error)
                tqdm.write(f"FAILED {error}\n{traceback.format_exc()}")
    print(f"Finished: {saved} evaluations saved; {len(failures)} failed.")
    print(usage_tracker.summary())
    if failures:
        print("Failed evaluations:\n" + "\n".join(failures))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
