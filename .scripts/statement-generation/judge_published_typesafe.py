"""Judge the platform's published statements with a TypeSafe System One model.

The TypeSafe counterpart to judge_published.py: it reads the same snapshot
(existing/published/statements.csv; run `judge_published.py prepare` first) and
sends one request per statement to --model-name (default typesafe/jev-1.13,
through OpenRouter). Each request asks seven independent questions about the
statement, which the model answers in parallel:

  - one two-option Choice per feature pair (e.g. fact or opinion), whose
    options carry the definitions and examples from prompt.yml, and
  - one Noul: is the statement an example of human common sense?

System One models return typed answers and probabilities instead of text, so
there are no explanations or 1-4 confidence ratings. Results therefore have
their own columns and go to existing/published/typesafe/<model>/statements.csv,
not evaluations/, whose schema `judge_published.py status` and the audit page
expect. Per feature they hold the chosen label, the probability of the
feature's 1-valued label (e.g. P(fact)), and TypeSafe's 0-1 confidence; plus
the common-sense probability. Reruns skip statements already saved.

Every answered request is also appended to raw.jsonl in the same folder: the
JSON request body exactly as sent and the JSON response, one line each.

Paid (per input token); preview a request for free with --random-prompt-view.
Needs OPENROUTER_API_KEY in the environment or this folder's .env.
"""

import argparse
import asyncio
import csv
import json
import os
import random

from dotenv import load_dotenv
from tqdm import tqdm

import judge
import judge_published
from generate import FEATURE_DEFINITIONS

DEFAULT_MODEL = "typesafe/jev-1.13"
# TypeSafe models on OpenRouter use its API key with this API root; the SDK
# appends /v1/systemone (https://docs.typesafe.ai/sdk/python/usage).
OPENROUTER_BASE_URL = "https://openrouter.ai/api"
OUTPUT_DIR = judge_published.SOURCE_DIR / "typesafe"
COMMONSENSE_ID = "commonsense"
COLUMNS = [
    "source_id",
    "source_row",
    "statement",
    "gen_model",
    "judge_model",
    "response_model",
    *[
        f"{key}_{field}"
        for key in judge.FEATURE_KEYS
        for field in ("classification", "probability", "confidence")
    ],
    "commonsense_probability",
    "input_tokens",
]


def question_id(key):
    # Ids are only for code; the model never sees them.
    return key.replace(" ", "_")


def feature_question(pair, choices):
    """A two-option Choice for one feature pair, e.g. fact or opinion."""
    return {
        "type": "choice",
        "instructions": f"Classify `statement` as {pair.replace('/', ' or ')}.",
        "criteria": {
            label: {"definition": details["definition"], "examples": details["examples"]}
            for label, details in choices.items()
        },
    }


QUESTIONS = {
    **{
        question_id(pair.split("/")[0]): feature_question(pair, choices)
        for pair, choices in FEATURE_DEFINITIONS.items()
    },
    COMMONSENSE_ID: {
        "type": "noul",
        "instructions": "Is `statement` an example of human common sense?",
    },
}


def state_for(statement):
    return {"statement": statement}


def output_path(model):
    return OUTPUT_DIR / model.replace("/", "--") / "statements.csv"


def load_completed(path, model):
    if not path.exists() or path.stat().st_size == 0:
        return set()
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != COLUMNS:
            raise SystemExit(f"{path} has unexpected columns; move it aside before rerunning.")
        completed = set()
        for row in reader:
            if row["judge_model"] != model:
                raise SystemExit(f"Unexpected judge_model {row['judge_model']!r} in {path}")
            completed.add(row["source_id"])
        return completed


def to_row(record, response, model):
    row = {
        "source_id": record["source_id"],
        "source_row": record["source_row"],
        "statement": record["statement"],
        "gen_model": record["gen_model"],
        "judge_model": model,
        # The versioned model that actually answered.
        "response_model": response.model,
        "commonsense_probability": response.answers[COMMONSENSE_ID].noul,
        # No request_id: the SDK reads it from the x-typesafe-request-id
        # header, which OpenRouter doesn't pass through, and raises without it.
        "input_tokens": response.usage.input_tokens,
    }
    for key in judge.FEATURE_KEYS:
        answer = response.answers[question_id(key)]
        row[f"{key}_classification"] = answer.choice
        # The feature key names its 1-valued label, as in the stored labels.
        row[f"{key}_probability"] = answer.probabilities[key]
        row[f"{key}_confidence"] = answer.confidence
    return row


async def run(records, output, model, workers):
    """Judge records, saving each as it finishes; returns the failure messages."""
    from typesafe_sdk import AsyncTypeSafeClient

    load_dotenv(judge.ROOT / ".env")
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("OPENROUTER_API_KEY is not set in the environment or .env.")
    output.parent.mkdir(parents=True, exist_ok=True)
    raw_path = output.with_name("raw.jsonl")
    wrote_header = output.exists() and output.stat().st_size > 0
    semaphore = asyncio.Semaphore(workers)
    failures, saved, input_tokens = [], 0, 0

    async with AsyncTypeSafeClient(api_key=api_key, base_url=OPENROUTER_BASE_URL, model=model) as client:
        async def judge_one(record):
            async with semaphore:
                try:
                    response = await client.system_one(state=state_for(record["statement"]), questions=QUESTIONS)
                except Exception as exc:  # reported per statement; a rerun retries it
                    return record, None, None, f"{type(exc).__name__}: {exc}"
            # Exactly what went over the wire; bodies only, so no API key.
            http = response.raw_http_response
            raw = {
                "source_id": record["source_id"],
                "source_row": record["source_row"],
                "url": str(http.request.url),
                "request": json.loads(http.request.content),
                "response": http.json(),
            }
            try:
                return record, to_row(record, response, model), raw, None
            except Exception as exc:
                return record, None, raw, f"{type(exc).__name__}: {exc} (response saved to {raw_path.name})"

        for finished in tqdm(asyncio.as_completed([judge_one(r) for r in records]), total=len(records)):
            record, row, raw, error = await finished
            if raw is not None:
                with raw_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(raw, ensure_ascii=False) + "\n")
            if error is not None:
                failures.append(f"Row {record['source_row']} ({record['source_id']}): {error}")
                tqdm.write(f"FAILED {failures[-1]}")
                continue
            with output.open("a", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=COLUMNS)
                if not wrote_header:
                    writer.writeheader()
                    wrote_header = True
                writer.writerow(row)
            saved += 1
            input_tokens += row["input_tokens"] or 0

    print(f"Finished: {saved} saved; {len(failures)} failed; {input_tokens} input tokens.")
    if failures:
        print("Failed statements:\n" + "\n".join(failures))
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-name", default=DEFAULT_MODEL, metavar="MODEL",
                        help="OpenRouter id of the TypeSafe model (default: %(default)s).")
    parser.add_argument("--workers", type=int, default=4,
                        help="Concurrent requests (default: 4). The SDK retries rate-limited requests with backoff.")
    parser.add_argument("--limit", type=int, help="Judge at most this many pending statements.")
    parser.add_argument("--random-prompt-view", action="store_true",
                        help="Print the request for one random statement without calling the API.")
    args = parser.parse_args()
    if "/" not in args.model_name or args.model_name != args.model_name.strip():
        parser.error(f"--model-name should be an OpenRouter id like {DEFAULT_MODEL}, got {args.model_name!r}")
    if args.workers < 1:
        parser.error("--workers must be positive")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")

    records = judge_published.load_records()
    if args.random_prompt_view:
        record = random.choice(records)
        print(f"POST {OPENROUTER_BASE_URL}/v1/systemone (source row {record['source_row']}); request body:")
        request = {"model": args.model_name, "state": state_for(record["statement"]), "questions": QUESTIONS}
        print(json.dumps(request, indent=2, ensure_ascii=False))
        return

    output = output_path(args.model_name)
    completed = load_completed(output, args.model_name)
    pending = [r for r in records if r["source_id"] not in completed]
    print(f"Judge: {args.model_name} (TypeSafe via OpenRouter); "
          f"{len(records) - len(pending)}/{len(records)} published statements already judged; {len(pending)} remaining.")
    if not pending:
        return
    if args.limit is not None:
        pending = pending[:args.limit]
        print(f"This run is limited to {len(pending)} statements.")
    print(f"Saving to {output}")
    if asyncio.run(run(pending, output, args.model_name, args.workers)):
        raise SystemExit("Some statements failed; rerun the same command to retry just those.")


if __name__ == "__main__":
    main()
