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
