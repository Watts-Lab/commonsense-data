"""Compare LLM judges' answers with the stored labels of published statements.

Backs the "Published Statement Audit" page (/statement_audit), linked from the
Design Point Coverage page. Reads the snapshot and judge results written by
.scripts/statement-generation/judge_published.py:

    existing/published/statements.csv                    statement + stored labels
    existing/published/evaluations/<judge>/statements.csv one judge's answers

A judge "agrees" with a statement when it rates it common sense AND gives all
six features the stored label — the same test the Coverage page applies to
generated statements, so the two pages' numbers mean the same thing.

A model run directly and through the batch API ("<model>" and
"<model>:batch" folders) counts as one judge; judge_published.py never rates a
statement in both, and if both hold one anyway the first folder's answer is kept.

Rows are grouped by the stored labels' design point. "Any judge" counts
statements at least one judge agrees with; "Common sense" counts statements
at least one judge rated commonsense = 1.
"""
import itertools
import os
from pathlib import Path

import pandas as pd

from statement_coverage import FEAT_KEYS, STATEMENT_GEN_DIR, _judge_value

AUDIT_DIR = Path(os.environ.get("STATEMENT_AUDIT_DIR", STATEMENT_GEN_DIR / "existing" / "published"))

_cache = None


def _load_judgments(statements: pd.DataFrame) -> tuple[list[str], dict]:
    """source row -> list of judgments; also returns the judge names found."""
    judges, by_row = [], {}
    eval_dir = AUDIT_DIR / "evaluations"
    for path in sorted(eval_dir.glob("*/statements.csv")) if eval_dir.exists() else []:
        if not path.stat().st_size:
            continue
        try:
            df = pd.read_csv(path)
        except (pd.errors.ParserError, pd.errors.EmptyDataError):
            continue
        if df.empty:
            continue
        judge_model = str(df["judge_model"].iloc[0]).removesuffix(":batch")
        if judge_model not in judges:
            judges.append(judge_model)
        for _, j in df.iterrows():
            src = int(j["source_row"])
            if any(prev["judge_model"] == judge_model for prev in by_row.get(src, [])):
                continue  # already rated in this model's other mode
            if src - 1 >= len(statements):
                continue
            stmt = statements.iloc[src - 1]
            if stmt["statement"] != j["statement"]:
                continue  # snapshot was re-prepared since this judge ran
            matches = {key: _judge_value(j[f"{key}_classification"], key) == int(stmt[key]) for key in FEAT_KEYS}
            commonsense = int(j.get("commonsense", 0))
            by_row.setdefault(src, []).append({
                "judge_model": judge_model,
                "commonsense": commonsense,
                "commonsense_explanation": str(j.get("commonsense_explanation", "")),
                "features": {
                    key: {
                        "classification": j[f"{key}_classification"],
                        "confidence": int(j[f"{key}_confidence"]),
                        "explanation": str(j[f"{key}_explanation"]),
                    }
                    for key in FEAT_KEYS
                },
                "matches": matches,
                "agrees": commonsense == 1 and all(matches.values()),
            })
    return judges, by_row


def _pct(numerator: int, denominator: int):
    return round(100 * numerator / denominator, 1) if denominator else None


def get_audit() -> dict:
    global _cache
    if _cache is not None:
        return _cache
    source = AUDIT_DIR / "statements.csv"
    if not source.exists():
        _cache = {"feature_keys": FEAT_KEYS, "judges": [], "rows": [], "agreement": [],
                  "n_statements": 0, "by_combo": {}, "missing": str(source)}
        return _cache
    statements = pd.read_csv(source)
    judges, by_row = _load_judgments(statements)

    entries_by_combo = {}
    for idx, stmt in statements.iterrows():
        combo = tuple(int(stmt[key]) for key in FEAT_KEYS)
        judgments = by_row.get(idx + 1, [])
        n = len(judgments)
        entry = {
            "statementId": int(stmt["statementId"]),
            "statement": stmt["statement"],
            "labels": dict(zip(FEAT_KEYS, combo)),
            "judges": judgments,
            "n_judges": n,
            "n_agree": sum(j["agrees"] for j in judgments),
            "n_commonsense": sum(j["commonsense"] for j in judgments),
        }
        entry["any_judge"] = entry["n_agree"] >= 1
        entry["commonsense"] = entry["n_commonsense"] >= 1
        entries_by_combo.setdefault(combo, []).append(entry)

    rows = []
    for combo in itertools.product([0, 1], repeat=len(FEAT_KEYS)):
        entries = entries_by_combo.get(combo, [])
        if not entries:
            continue
        per_judge = {}
        for judge_model in judges:
            rated = [j for e in entries for j in e["judges"] if j["judge_model"] == judge_model]
            per_judge[judge_model] = {"agree": sum(j["agrees"] for j in rated), "rated": len(rated)}
        rows.append({
            **dict(zip(FEAT_KEYS, combo)),
            "published": len(entries),
            "judges": per_judge,
            "any_judge": sum(e["any_judge"] for e in entries),
            "commonsense": sum(e["commonsense"] for e in entries),
            "rated": sum(1 for e in entries if e["n_judges"]),
        })

    # How often each judge (and at least one of the judges) matches the stored labels
    all_entries = [e for es in entries_by_combo.values() for e in es]
    agreement = []
    for judge_model in judges:
        rated = [j for e in all_entries for j in e["judges"] if j["judge_model"] == judge_model]
        n = len(rated)
        agreement.append({
            "judge": judge_model, "n": n,
            "commonsense": _pct(sum(j["commonsense"] for j in rated), n),
            "features": {key: _pct(sum(j["matches"][key] for j in rated), n) for key in FEAT_KEYS},
            "all_features": _pct(sum(all(j["matches"].values()) for j in rated), n),
            "full": _pct(sum(j["agrees"] for j in rated), n),
        })
    if len(judges) > 1:
        voted = [e for e in all_entries if e["n_judges"]]
        n = len(voted)
        agreement.append({
            "judge": "Any judge", "n": n,
            "commonsense": _pct(sum(e["commonsense"] for e in voted), n),
            "features": {key: _pct(sum(any(j["matches"][key] for j in e["judges"]) for e in voted), n)
                         for key in FEAT_KEYS},
            "all_features": _pct(sum(any(all(j["matches"].values()) for j in e["judges"]) for e in voted), n),
            "full": _pct(sum(e["any_judge"] for e in voted), n),
        })

    _cache = {"feature_keys": FEAT_KEYS, "judges": judges, "rows": rows, "agreement": agreement,
              "n_statements": len(statements), "by_combo": entries_by_combo}
    return _cache


def get_audit_statements(combo: tuple, metric: str) -> list:
    """All published statements for the design point, each tagged "qualifies"
    for the requested metric — the caller shows every statement, not just the
    ones that qualify, dimming the rest."""
    entries = get_audit()["by_combo"].get(combo, [])
    if metric == "published":
        for e in entries:
            e["qualifies"] = (not e["n_judges"]) or bool(e["n_agree"])
    elif metric == "any_judge":
        for e in entries:
            e["qualifies"] = e["any_judge"]
    elif metric == "commonsense":
        for e in entries:
            e["qualifies"] = e["commonsense"]
    elif metric.startswith("judge:"):
        judge_model = metric.removeprefix("judge:")
        for e in entries:
            e["qualifies"] = any(j["judge_model"] == judge_model and j["agrees"] for j in e["judges"])
    else:
        raise ValueError(f"Unknown metric: {metric!r}")
    # Qualifying first (most-agreed-with first among them), so the statements
    # to keep and to question are at opposite ends.
    return sorted(entries, key=lambda e: (
        not e["qualifies"], -e["n_agree"], e["n_judges"] - e["n_commonsense"], e["statementId"],
    ))
