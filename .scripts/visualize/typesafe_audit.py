"""TypeSafe (Jev) judgments of the published statements.

Backs the "TypeSafe Judgments" page (/typesafe_audit), linked from the
Published Statement Audit page. Reads what
.scripts/statement-generation/judge_published_typesafe.py writes:

    existing/published/statements.csv                     statement + stored labels
    existing/published/typesafe/<model>/statements.csv    one TypeSafe model's answers

plus the LLM judges' answers statement_audit.py reads, so the page can compare
Jev with the stored labels and with each LLM judge. Unlike those judges, Jev
returns probabilities: per feature the chosen label, P(the 1-valued label) and
a 0-1 confidence, plus P(common sense). The page computes its agreement rates,
histograms and AUCs from the per-statement rows served here.

Rows are matched to the snapshot by source_row and skipped when the statement
text differs (the snapshot was re-prepared since that run).
"""
import pandas as pd

import statement_audit
from statement_coverage import FEAT_KEYS, _judge_value

TYPESAFE_DIR = statement_audit.AUDIT_DIR / "typesafe"

_cache = None


def _load_model(df: pd.DataFrame, statements: pd.DataFrame) -> dict:
    rows = {}
    for _, j in df.iterrows():
        src = int(j["source_row"])
        if not 1 <= src <= len(statements) or statements.iloc[src - 1]["statement"] != j["statement"]:
            continue
        rows[src] = {
            "choice": [int(j[f"{key}_classification"] == key) for key in FEAT_KEYS],
            "p": [round(float(j[f"{key}_probability"]), 4) for key in FEAT_KEYS],
            "conf": [round(float(j[f"{key}_confidence"]), 4) for key in FEAT_KEYS],
            "cs": round(float(j["commonsense_probability"]), 4),
        }
    return {
        "response_models": sorted(df["response_model"].dropna().astype(str).unique()),
        "input_tokens": int(df["input_tokens"].fillna(0).sum()),
        "rows": rows,
    }


def _load():
    source = statement_audit.AUDIT_DIR / "statements.csv"
    if not source.exists():
        return None
    statements = pd.read_csv(source)
    judges, by_row = statement_audit._load_judgments(statements)
    models = {}
    for path in sorted(TYPESAFE_DIR.glob("*/statements.csv")) if TYPESAFE_DIR.exists() else []:
        if not path.stat().st_size:
            continue
        df = pd.read_csv(path)
        if not df.empty:
            models[str(df["judge_model"].iloc[0])] = _load_model(df, statements)
    return {"statements": statements, "judges": judges, "by_row": by_row, "models": models, "payloads": {}}


def get_audit(model: str = "") -> dict:
    """Every statement one TypeSafe model judged, with its stored labels and the
    LLM judges' labels (1/0, or None when unrecognized), in "judges" order.
    The first model found is the default."""
    global _cache
    if _cache is None:
        _cache = _load()
    if _cache is None:
        return {"feature_keys": FEAT_KEYS, "models": [], "statements": [],
                "missing": str(statement_audit.AUDIT_DIR / "statements.csv")}
    models = list(_cache["models"])
    if not models:
        return {"feature_keys": FEAT_KEYS, "models": [], "statements": [], "missing": str(TYPESAFE_DIR)}
    if model and model not in _cache["models"]:
        raise ValueError(f"Unknown TypeSafe model: {model!r}")
    model = model or models[0]
    if model in _cache["payloads"]:
        return _cache["payloads"][model]

    results = _cache["models"][model]
    statements = []
    for idx, stmt in _cache["statements"].iterrows():
        jev = results["rows"].get(idx + 1)
        if jev is None:
            continue
        rated = {j["judge_model"]: j for j in _cache["by_row"].get(idx + 1, [])}
        # Aligned with "judges"; None where that judge hasn't rated the statement
        llm = [
            {
                "f": [_judge_value(rated[judge]["features"][key]["classification"], key) for key in FEAT_KEYS],
                "cs": rated[judge]["commonsense"],
            } if judge in rated else None
            for judge in _cache["judges"]
        ]
        statements.append({
            "row": idx + 1,
            "id": int(stmt["statementId"]),
            "statement": stmt["statement"],
            "stored": [int(stmt[key]) for key in FEAT_KEYS],
            **jev,
            "llm": llm,
        })
    payload = {
        "feature_keys": FEAT_KEYS,
        "models": models,
        "model": model,
        "response_models": results["response_models"],
        "input_tokens": results["input_tokens"],
        "n_statements": len(_cache["statements"]),
        "judges": _cache["judges"],
        "statements": statements,
    }
    _cache["payloads"][model] = payload
    return payload


def get_statement(row: int) -> dict:
    """The LLM judges' full answers (with explanations) for one snapshot row."""
    if _cache is None:
        get_audit()
    by_row = _cache["by_row"] if _cache else {}
    return {"row": row, "judges": by_row.get(row, [])}
