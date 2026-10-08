"""Judge the platform's published statements with OpenRouter models, one per run.

The published statements (statements_1.csv with published = 1: the GPT set
added in October 2024) go through the same judge prompt as generated
statements. The judges' answers can then be compared with the stored feature
labels, to check whether those labels mean the same thing as the labels on
generated statements, and to flag statements the judges don't consider common
sense.

  prepare  Snapshot the published statements and their stored labels into
           existing/published/statements.csv. Free; no API calls.
  judge    Judge that snapshot with the --model-name model, saving to
           existing/published/evaluations/<model>/statements.csv. Paid.
           A ":batch" suffix (e.g. z-ai/glm-5.3-flash:batch) uses the batch
           API: the run prepares a batch, asks before submitting it, and
           collects finished results when rerun. Without the suffix, requests
           are sent directly, --workers at a time. The two modes save to
           separate folders, as in judge.py, but each skips statements the
           other has already rated, so switching modes never judges a
           statement twice; the audit page treats both folders as one judge.
  status   Show how many statements each judge has rated so far. Free.

This lives outside data/ on purpose: the Design Point Coverage page treats
every data/<model>/statements.csv as a generator's output.
"""

import argparse
import sys
from pathlib import Path

import pandas as pd

import gap_analysis
import judge

ROOT = Path(__file__).resolve().parent
SOURCE_DIR = ROOT / "existing" / "published"
SOURCE_CSV = SOURCE_DIR / "statements.csv"
# Stands in for the generator in the evaluation CSVs' gen_model column.
GEN_LABEL = "platform/published"
# The judges already used on generated statements, so the two sets of results
# are comparable. No OpenAI model: the published statements were written by
# GPT, and a model family may rate its own output favorably.
RECOMMENDED_JUDGES = [
    "z-ai/glm-5.3-flash:batch",
    "meta/muse-spark-1.3",
    "x-ai/grok-4.6",
    "google/gemini-3.8-flash",
    "qwen/qwen3.8-max-0902",
    "deepseek/deepseek-v4.1-flash",
]


def prepare(args):
    statements = pd.read_csv(
        gap_analysis.REPO_ROOT / "statements" / "statements_1.csv",
        usecols=["id", "statement", "statementSource", "published"],
    )
    published = statements[statements["published"] == 1]
    props = gap_analysis.load_wide_properties()
    merged = published.merge(props, left_on="id", right_on="statementId", how="left")
    missing = merged[judge.FEATURE_KEYS].isna().any(axis=1)
    if missing.any():
        raise SystemExit(
            f"{int(missing.sum())} published statements have no stored labels "
            f"(ids: {merged.loc[missing, 'id'].tolist()[:10]}…)."
        )
    for key in judge.FEATURE_KEYS:
        merged[key] = merged[key].astype(int)
    out = merged[["id", "statement", "statementSource", *judge.FEATURE_KEYS]].rename(
        columns={"id": "statementId"}
    )
    if SOURCE_CSV.exists() and not args.overwrite:
        current = pd.read_csv(SOURCE_CSV)
        if current.equals(out):
            print(f"{SOURCE_CSV} is already up to date ({len(out)} statements).")
            return
        raise SystemExit(
            f"{SOURCE_CSV} exists and differs from the current published set "
            f"({len(current)} → {len(out)} statements, or changed text/labels). "
            "Rerun with --overwrite to replace it; saved evaluations are kept, and "
            "changed rows are judged again as new rows."
        )
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    out.to_csv(SOURCE_CSV, index=False)
    print(f"Wrote {len(out)} published statements to {SOURCE_CSV}")


def load_records():
    if not SOURCE_CSV.exists():
        raise SystemExit(f"{SOURCE_CSV} not found; run `prepare` first.")
    return judge.load_statements(SOURCE_CSV, GEN_LABEL)


def output_path(judge_model):
    return SOURCE_DIR / "evaluations" / judge_model.replace("/", "--") / "statements.csv"


def batch_reserved(batch_model):
    """Statements in this judge's batches that are submitted but not yet collected."""
    import json

    reserved = set()
    for path in output_path(batch_model).parent.glob("batch-*.state.json"):
        state = json.loads(path.read_text(encoding="utf-8"))
        # Same phases judge_batch.collect_batches treats as still in flight
        if state["phase"] not in {"prepared", "collected", "terminal", "rejected"}:
            reserved.update(row["source_id"] for row in state["records"])
    return reserved


def run_judge(args):
    records = load_records()
    if args.random_prompt_view:
        import random
        import json

        prompt, schema = judge.create_prompt(random.choice(records)["statement"])
        print(judge.PROMPT_CONFIG.get("system", ""), prompt, json.dumps(schema, indent=2), sep="\n\n")
        return
    model = args.model_name
    batch = model.endswith(":batch")
    # judge.run_sync / judge_batch.run_batch read these attributes.
    run_args = argparse.Namespace(
        gen=GEN_LABEL, judge=model, workers=args.workers or 4,
        limit=args.limit, response_mode=args.response_mode,
    )
    output = output_path(model)
    print(f"Judge: {model} ({'batch API' if batch else f'direct requests, {run_args.workers} at a time'}); "
          f"{len(records)} published statements")
    other = model.removesuffix(":batch") if batch else f"{model}:batch"
    skip = judge.load_completed(output_path(other), GEN_LABEL, other)
    if skip:
        print(f"Skipping {len(skip)} statement{'s' if len(skip) != 1 else ''} already rated by {other}.")
    if not batch:
        in_flight = batch_reserved(other) - skip
        if in_flight:
            print(f"Skipping {len(in_flight)} statement{'s' if len(in_flight) != 1 else ''} in {other} batches still running; "
                  "rerun the batch command to collect them.")
        skip |= in_flight
    records = [r for r in records if r["source_id"] not in skip]
    if batch:
        from judge_batch import run_batch

        try:
            run_batch(run_args, records, output, judge)
        except (RuntimeError, ValueError) as exc:
            # e.g. a rejected submission or a batch whose outcome is unknown
            raise SystemExit(f"Batch stopped: {exc}")
        return
    if judge.run_sync(run_args, records, output):
        raise SystemExit("Some statements failed; rerun the same command to retry just those.")


def status(args):
    records = load_records()
    print(f"{len(records)} published statements in {SOURCE_CSV}")
    folders = sorted((SOURCE_DIR / "evaluations").glob("*/")) if (SOURCE_DIR / "evaluations").exists() else []
    if not folders:
        print("No judge results yet.")
    for folder in folders:
        model = folder.name.replace("--", "/")
        done = judge.load_completed(folder / "statements.csv", GEN_LABEL, model)
        current = sum(r["source_id"] in done for r in records)
        batches = len(list(folder.glob("batch-*.state.json")))
        extra = f"; {batches} batch file(s)" if batches else ""
        print(f"  {model:<36} {current:>5} / {len(records)} rated{extra}")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Recommended judges (one run each):\n  " + "\n  ".join(RECOMMENDED_JUDGES),
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare", help="Snapshot published statements and stored labels.")
    p.add_argument("--overwrite", action="store_true", help="Replace a snapshot that differs.")
    j = sub.add_parser("judge", help="Judge the snapshot with one model (paid).")
    j.add_argument("--model-name", metavar="MODEL",
                   help="OpenRouter judge model; add :batch to use the batch API. Recommended: "
                        + " ".join(RECOMMENDED_JUDGES))
    j.add_argument("--workers", type=int,
                   help="Concurrent requests (default: 4). Direct mode only; a batch is submitted as one request.")
    j.add_argument("--limit", type=int, help="Judge (or batch) at most this many pending statements.")
    j.add_argument("--response-mode", choices=["json_object", "json_schema"], default="json_object")
    j.add_argument("--random-prompt-view", action="store_true",
                   help="Print one prompt and schema without API calls.")
    sub.add_parser("status", help="Show how far each judge has got.")
    args = parser.parse_args()
    if args.command == "judge":
        if not args.random_prompt_view:
            if not args.model_name:
                parser.error("judge needs --model-name (or --random-prompt-view to preview the prompt)")
            if "/" not in args.model_name or args.model_name != args.model_name.strip():
                parser.error(f"--model-name should be an OpenRouter id like x-ai/grok-4.6, got {args.model_name!r}")
            if args.model_name.endswith(":batch") and args.workers is not None:
                parser.error("--workers applies to direct requests only; a :batch judge is submitted as one batch")
        if args.workers is not None and args.workers < 1:
            parser.error("--workers must be positive")
        if args.limit is not None and args.limit < 1:
            parser.error("--limit must be positive")
    {"prepare": prepare, "judge": run_judge, "status": status}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
