# Statement Explorer

Start the explorer from the repository root:

```bash
python .scripts/statement-generation/server.py
```

Open http://localhost:8080. Use `--port 9000` to choose another port.
The server uses only Python's standard library and binds to localhost.

Choose a model in the toolbar to view its statements, explanations, confidence
scores, and design-point coverage. Search and feature filters stay active when
switching models; pagination resets to the first page.

Models are discovered from `data/<model-name>/statements.csv`, with `/` replaced
by `--` in folder names. Refresh the page after generating another model's data.
Use this server instead of a generic static server so model discovery works.

## Judge generated statements

```bash
python .scripts/statement-generation/judge.py --gen google/gemini-3.8-flash --judge openai/gpt-6-astra
```

Run from the repository root with the local `requirements.txt` dependencies installed
and `OPENROUTER_API_KEY` configured in the environment or this folder's `.env`.
The command makes paid model requests. `--workers 4` controls concurrency.
Add `--random-prompt-view` to preview the judge prompt and schema without API calls.
Edit `judge_prompt.yml` to change the evaluation instructions and schema.

Each source row gets all six feature classifications in one judge request, each with
confidence (1–4) and an explanation, plus a common-sense yes/no assessment and explanation. Generator
labels and explanations are not sent to the judge. The six feature-pair definitions
come from `prompt.yml` to keep terminology consistent.

Results go to `data/<gen>/evaluations/<judge>/statements.csv`, with `/` converted to
`--` in model folder names. Successful rows are saved incrementally; reruns skip
completed source rows. Identical duplicate source rows retain separate IDs, and
edited rows get new IDs. Existing evaluations are retained when source rows change
or disappear. Changing the judge prompt does not invalidate saved evaluations;
move the evaluation file aside before intentionally judging everything again.

Use `--limit 1 --workers 1` to check a single pending statement before a larger run.
The judge prints per-attempt cost, running reported cost, saved-row progress, and
final input/output token totals. Invalid responses and retries count toward cost;
missing API cost data is reported explicitly. The prompt includes the full schema,
retries include validation feedback, and routing requires parameter support.

The default API response mode is `json_object`; the full schema is included in the
prompt and validated locally before saving. Use `--response-mode json_schema` to
opt into provider-side strict schemas. For BYOK requests, reported totals combine
OpenRouter fees and separately reported upstream inference cost, without double-counting
input/output breakdowns.

## Batch judging

Add `:batch` to the judge name to prepare and submit an asynchronous batch:

```bash
python .scripts/statement-generation/judge.py \
  --gen openai/gpt-6-astra --judge google/gemini-3.8-flash:batch
```

The command writes `batch-<id>.jsonl` in
`data/openai--gpt-6-astra/evaluations/google--gemini-3.8-flash:batch/`, one eligible
request per line. `--limit` still applies. It then asks
`Start requesting this batch? [y/N]:`; only `y` or `yes` submits. Declining or
closing stdin leaves the files locally without submitting a batch.

OpenRouter accepts an inline `requests` array, so the script reads the prepared
JSONL into that array and posts to `/api/beta/batches`. The API model omits the
`:batch` suffix; local folders and CSV model labels retain it. Provider preferences
are omitted for batch requests. Prompts, source records, and the validation schema
are saved with each job so later source/prompt edits do not change its mapping.

Rerun the same command to check saved batch IDs and collect completed results into
`statements.csv`. Requests still in flight are skipped. Completed responses undergo
full schema validation; failed or missing judgments become eligible for another
batch, again requiring confirmation. Submission errors with an uncertain outcome
stop automatic resubmission; inspect the saved state and OpenRouter's batch list
before retrying. Batch completion can take up to the 24-hour window; retrieve results
within OpenRouter's 30-day retention period.

## Judge the published statements

`judge_published.py` runs the same judge prompt over the platform's 1,265 published
statements (the GPT set added in October 2024), so the judges' answers can be compared
with the stored feature labels. Run from the repository root:

```bash
# 1. Snapshot the published statements and stored labels (free, no API calls)
python .scripts/statement-generation/judge_published.py prepare

# 2. Preview the prompt (free), try one statement, then run each judge (paid)
python .scripts/statement-generation/judge_published.py judge --random-prompt-view
python .scripts/statement-generation/judge_published.py judge --model-name x-ai/grok-4.6 --limit 1 --workers 1
python .scripts/statement-generation/judge_published.py judge --model-name x-ai/grok-4.6            # direct
python .scripts/statement-generation/judge_published.py judge --model-name z-ai/glm-5.3-flash:batch # batch API

# 3. Check progress (free)
python .scripts/statement-generation/judge_published.py status
```

The snapshot is `existing/published/statements.csv`; each judge's results go to
`existing/published/evaluations/<judge>/statements.csv`, in the same format as
generated-statement evaluations. This folder is deliberately outside `data/`, which the
Design Point Coverage page treats as generator output. Each run uses one judge
(`--model-name`); all runs resume where they stopped.

- **Direct mode** (no suffix) sends requests immediately, `--workers` at a time (default 4).
- **Batch mode** (`:batch` suffix) prepares a batch, asks before submitting it, and collects
  finished results when you rerun the same command. `--workers` doesn't apply and is rejected.
- The two modes save to separate folders, but each skips statements the other has already
  rated, and direct mode also skips statements in a batch that is still running. Switching
  modes partway therefore never rates a statement twice, and the audit page counts
  `<model>` and `<model>:batch` as one judge.

The recommended judges (listed in `--help`) are the ones already used on generated
statements, so the results are comparable; there is no OpenAI judge because the published
statements were written by GPT. `prepare` refuses to overwrite a snapshot that no longer
matches the published set unless given `--overwrite`.

Results appear on the explorer's Published Statement Audit page (`/statement_audit`,
linked from Design Point Coverage) after a server restart.

## Judge the published statements with TypeSafe

`judge_published_typesafe.py` has TypeSafe's Jev (`typesafe/jev-1.13`, through OpenRouter with
the same `OPENROUTER_API_KEY`) classify the same snapshot. Each statement is one request with
seven questions: a two-option Choice per feature pair, using the definitions and examples in
`prompt.yml`, and a Noul for common sense. It needs `typesafe-sdk` from `requirements.txt`.

```bash
python .scripts/statement-generation/judge_published_typesafe.py --random-prompt-view   # free
python .scripts/statement-generation/judge_published_typesafe.py --limit 1 --workers 1  # paid
python .scripts/statement-generation/judge_published_typesafe.py                        # paid
```

Jev returns probabilities instead of explanations, so results go to
`existing/published/typesafe/<model>/statements.csv` with their own columns: per feature, the
chosen label, the probability of its 1-valued label (e.g. `fact_probability`), and TypeSafe's
0–1 confidence, plus `commonsense_probability`. The explorer's TypeSafe Judgments page (`/typesafe_audit`)
reads it after a server restart; the audit page and `judge_published.py status` don't. Reruns skip statements already saved. Each answered request is also
appended to `raw.jsonl` in the same folder: the JSON request body as sent and Jev's JSON response.
