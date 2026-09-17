"""Persist, confirm, submit, and collect asynchronous judge batches."""
import csv
import hashlib
import json
import os
import uuid
from copy import deepcopy
from urllib.parse import quote

import jsonschema
import requests
from dotenv import load_dotenv

BATCH_URL = "https://openrouter.ai/api/beta/batches"
TERMINAL = {"completed", "failed", "expired", "cancelled"}


def save_state(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def auth_headers(root):
    load_dotenv(root / ".env")
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise ValueError("OPENROUTER_API_KEY is required to submit or retrieve a batch.")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def collect_batches(output, args, api):
    """Collect finished jobs and reserve rows belonging to jobs still in flight."""
    reserved = set()
    completed = api.load_completed(output, args.gen, args.judge)
    for path in sorted(output.parent.glob("batch-*.state.json")):
        state = json.loads(path.read_text(encoding="utf-8"))
        if state["gen_model"] != args.gen or state["judge_model"] != args.judge:
            raise ValueError(f"Model mismatch in {path}")
        if state["phase"] in {"prepared", "collected", "terminal", "rejected"}:
            continue
        if not state.get("batch_id"):
            raise RuntimeError(
                f"Submission outcome is unknown for {path}. Check OpenRouter's batch list "
                "and add the accepted batch_id to this state file before rerunning; "
                "do not resubmit until you know whether the request was accepted."
            )
        response = requests.get(
            f"{BATCH_URL}/{quote(state['batch_id'], safe='')}",
            headers=auth_headers(api.ROOT), timeout=60,
        )
        response.raise_for_status()
        batch = response.json()
        save_state(path.with_name(path.name.replace('.state.json', '.response.json')), batch)
        status = batch["status"]
        print(f"Batch {state['batch_id']}: {status}; counts={batch.get('request_counts')}")
        if status not in TERMINAL:
            reserved.update(row["source_id"] for row in state["records"])
            continue
        if status != "completed":
            state["phase"] = "terminal"
            save_state(path, state)
            print(f"Batch ended without results: {batch.get('error')}; its rows can be retried.")
            continue
        usage = batch.get("usage") or {}
        print(f"Batch usage: {json.dumps(usage)}")
        if usage.get("is_byok"):
            print("BYOK: usage.cost is the OpenRouter fee; provider inference is billed separately.")
        records = {row["source_id"]: row for row in state["records"]}
        saved = 0
        failures = []
        seen = set()
        for item in batch.get("results") or []:
            request_id = item.get("custom_id")
            custom_id = state.get("request_ids", {}).get(request_id, request_id)
            if custom_id in seen or custom_id not in records:
                raise ValueError(f"Unexpected or duplicate batch result ID: {custom_id}")
            seen.add(custom_id)
            if custom_id in completed:
                continue
            try:
                if item.get("error"):
                    raise ValueError(str(item["error"]))
                response_item = item["response"]
                if response_item["status_code"] != 200:
                    raise ValueError(str(response_item))
                choice = response_item["body"]["choices"][0]
                if choice["finish_reason"] == "length" or choice["message"].get("refusal"):
                    raise ValueError("Judge response truncated or refused")
                result = api.parse_llm_json(choice["message"].get("content") or "")
                jsonschema.validate(result, state["schema"])
                flattened = {f"{key}_{field}": value for key, fields in result["features"].items()
                             for field, value in fields.items()}
                row = dict(records[custom_id], judge_model=args.judge, **flattened,
                           commonsense=result["commonsense"],
                           commonsense_explanation=result["commonsense_explanation"])
            except (ValueError, KeyError, IndexError, TypeError, AssertionError, jsonschema.ValidationError) as exc:
                detail = exc.message if isinstance(exc, jsonschema.ValidationError) else str(exc)
                failures.append({"source_id": custom_id, "error": detail})
                print(f"FAILED {custom_id}: {detail}")
                continue
            # Write errors must stop collection so the remaining rows are not lost.
            wrote_header = output.exists() and output.stat().st_size > 0
            with output.open("a", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=api.COLUMNS)
                if not wrote_header:
                    writer.writeheader()
                writer.writerow(row)
            completed.add(custom_id)
            saved += 1
        for custom_id in records.keys() - seen - completed:
            failures.append({"source_id": custom_id, "error": "Missing batch result"})
        state.update(phase="collected", failures=failures)
        save_state(path, state)
        print(f"Batch collected: {saved} saved; {len(failures)} failed or missing.")
    return completed, reserved


def run_batch(args, records, output, api):
    output.parent.mkdir(parents=True, exist_ok=True)
    completed, reserved = collect_batches(output, args, api)
    pending = [row for row in records if row["source_id"] not in completed | reserved]
    print(f"Batch mode: {len(pending)} eligible rows; {len(reserved)} rows reserved by active batches.")
    if args.limit is not None:
        pending = pending[:args.limit]
    if not pending:
        print("No new batch requests needed. Rerun this command later to collect active batches.")
        return
    model = args.judge.removesuffix(":batch")
    reasoning = api.get_reasoning_config(model)
    stem = f"batch-{uuid.uuid4().hex}"
    jsonl_path = output.parent / f"{stem}.jsonl"
    state_path = output.parent / f"{stem}.state.json"
    schema = None
    request_ids = {}
    with jsonl_path.open("x", encoding="utf-8") as handle:
        for row in pending:
            prompt, response_format = api.create_prompt(row["statement"])
            current_schema = response_format["json_schema"]["schema"]
            jsonschema.Draft202012Validator.check_schema(current_schema)
            if schema is not None and schema != current_schema:
                raise ValueError("All batch requests must use the same schema.")
            schema = current_schema
            messages = ([{"role": "system", "content": api.PROMPT_CONFIG["system"]}]
                        if api.PROMPT_CONFIG.get("system") else [])
            messages.append({"role": "user", "content": prompt})
            body = {"messages": messages, "max_tokens": 16384,
                    "response_format": response_format if args.response_mode == "json_schema"
                    else {"type": "json_object"}, **deepcopy(reasoning)}
            # Batch API does not support provider preferences.
            body.pop("provider", None)
            request_id = hashlib.sha256(row["source_id"].encode()).hexdigest()
            request_ids[request_id] = row["source_id"]
            handle.write(json.dumps({"custom_id": request_id, "body": body}, ensure_ascii=False) + "\n")
    state = {"phase": "prepared", "gen_model": args.gen, "judge_model": args.judge,
             "api_model": model, "records": pending, "schema": schema,
             "jsonl_file": jsonl_path.name, "request_ids": request_ids}
    save_state(state_path, state)
    print(f"Prepared {len(pending)} requests: {jsonl_path}")
    print(f"API model: {model}; completion window: 24h. This submits paid requests.")
    try:
        answer = input("Start requesting this batch? [y/N]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = ""
    if answer not in {"y", "yes"}:
        print("Not submitted. Prepared JSONL and metadata remain available for inspection.")
        return
    headers = auth_headers(api.ROOT)
    with jsonl_path.open(encoding="utf-8") as handle:
        items = [json.loads(line) for line in handle if line.strip()]
    # Field order matters: OpenRouter stream-parses endpoint/model before requests.
    payload = {"endpoint": "/v1/chat/completions", "model": model, "requests": items}
    state["phase"] = "submitting"
    save_state(state_path, state)
    # Never automatically retry a POST: an ambiguous failure may already be accepted.
    response = requests.post(BATCH_URL, headers=headers, data=json.dumps(payload), timeout=120)
    if response.status_code >= 400:
        try:
            error_body = response.json()
        except ValueError:
            error_body = {"message": response.text}
        error = {"http_status": response.status_code, "body": error_body}
        save_state(output.parent / f"{stem}.response.json", error)
        state["submission_error"] = error
        if response.status_code == 422:
            state["phase"] = "rejected"
        save_state(state_path, state)
        raise RuntimeError(
            f"Batch submission returned HTTP {response.status_code}: "
            f"{json.dumps(error_body, ensure_ascii=False)}. No automatic retry was made."
        )
    response.raise_for_status()
    batch = response.json()
    state.update(phase="submitted", batch_id=batch["id"])
    print(f"Batch accepted: {batch['id']}; status={batch.get('status')}")
    save_state(state_path, state)
    save_state(output.parent / f"{stem}.response.json", batch)
    print(f"Saved batch state: {state_path}")
    print("Rerun the same command to retrieve results; active rows will not be submitted again.")
