#!/usr/bin/env python3
"""
Survey data visualization server — no external dependencies beyond pandas.
Usage:  python3 server.py [port]
Then open http://localhost:8080
"""

import http.server
import itertools
import json
import os
import sys
import urllib.parse

import numpy as np
import pandas as pd

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
from utils import individual_commonsensicality, statement_commonsensicality

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
# Default to the in-repo location for local dev; override with STATEMENTS_PATH
# (e.g. in the Docker image where the file is vendored next to the app).
STATEMENTS_PATH = os.environ.get(
    "STATEMENTS_PATH",
    os.path.join(BASE_DIR, "..", "..", "statements", "statements_1.csv"),
)

# ── Load data once at startup ──────────────────────────────────────────────
print("Loading data…")
answers = pd.read_csv(os.path.join(DATA_DIR, "answers.csv"))
if "createdAt" in answers.columns:
    answers["createdAt"] = pd.to_datetime(answers["createdAt"], utc=False)
demo = pd.read_csv(os.path.join(DATA_DIR, "crt_rme_demo.csv"))
statements = pd.read_csv(
    STATEMENTS_PATH,
    usecols=["id", "statement", "statementCategory"],
).rename(columns={"id": "statementId"})

# Load statement properties and merge into statements
stmt_props = pd.read_csv(os.path.join(DATA_DIR, "statement_properties.csv")).rename(
    columns={"literal language": "literal_language"}
)
statements = statements.merge(stmt_props, on="statementId", how="left")

PROP_COLS = [
    "fact",
    "physical",
    "literal_language",
    "positive",
    "knowledge",
    "everyday",
]

# Join answers with country / CRT / RME info (one row per answer)
merged = answers.merge(
    demo[["userSessionId", "country_reside"]],
    on="userSessionId",
    how="inner",
)

# Country list sorted by participant count
_countries = (
    demo["country_reside"]
    .value_counts()
    .reset_index()
    .rename(columns={"country_reside": "country", "count": "n_users"})
    .to_dict(orient="records")
)
COUNTRIES_JSON = json.dumps(_countries, ensure_ascii=False).encode("utf-8")

print(
    f"Ready — {len(demo):,} participants, "
    f"{len(answers):,} answers, "
    f"{len(statements):,} statements, "
    f"{demo['country_reside'].nunique()} countries."
)

# ── Date filter helper ─────────────────────────────────────────────────────


def _filter_date(df: pd.DataFrame, date_from: str, date_to: str) -> pd.DataFrame:
    if not date_from and not date_to:
        return df
    if "createdAt" not in df.columns:
        return df
    result = df
    if date_from:
        result = result[result["createdAt"] >= pd.Timestamp(date_from)]
    if date_to:
        result = result[result["createdAt"] < pd.Timestamp(date_to) + pd.Timedelta(days=1)]
    return result


# ── Per-country statement aggregation (cached) ─────────────────────────────
_cache: dict = {}


def get_statements(country: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (country, date_from, date_to)
    if key in _cache:
        return _cache[key]

    m = _filter_date(merged, date_from, date_to)
    subset = m if country == "all" else m[m["country_reside"] == country]

    n_users = int(subset["userSessionId"].nunique())

    agg = (
        subset.groupby("statementId")
        .agg(
            n_ratings=("I_agree", "count"),
            i_agree_pct=("I_agree", "mean"),
            others_agree_pct=("others_agree", "mean"),
        )
        .reset_index()
        .sort_values("n_ratings", ascending=False)
        .merge(statements, on="statementId", how="left")
    )

    agg["i_agree_pct"] = agg["i_agree_pct"].round(4)
    agg["others_agree_pct"] = agg["others_agree_pct"].round(4)
    agg["statementId"] = agg["statementId"].astype(int)
    agg["n_ratings"] = agg["n_ratings"].astype(int)
    agg["statement"] = agg["statement"].fillna("")
    agg["statementCategory"] = agg["statementCategory"].fillna("")
    for col in PROP_COLS:
        agg[col] = agg[col].apply(lambda x: int(x) if pd.notna(x) else None)

    payload = {
        "n_users": n_users,
        "n_statements": len(agg),
        "rows": agg[
            [
                "statementId",
                "statement",
                "statementCategory",
                "n_ratings",
                "i_agree_pct",
                "others_agree_pct",
            ]
            + PROP_COLS
        ].to_dict(orient="records"),
    }

    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _cache[key] = encoded
    return encoded


# ── Individual commonsensicality scores (cached) ───────────────────────────
_scores_cache: dict = {}


def get_scores(target: str, reference: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (target, reference, date_from, date_to)
    if key in _scores_cache:
        return _scores_cache[key]

    m = _filter_date(merged, date_from, date_to)
    has_ts = "createdAt" in m.columns
    ans_cols = ["userSessionId", "statementId", "I_agree", "others_agree"] + (["createdAt"] if has_ts else [])
    ref_cols = ["userSessionId", "statementId", "I_agree"]

    target_ratings = (
        m[ans_cols]
        if target == "all"
        else m[m["country_reside"] == target][ans_cols]
    ).copy()

    reference_ratings = (
        m[ref_cols]
        if reference == "all"
        else m[m["country_reside"] == reference][ref_cols]
    ).copy()

    raw_n_users = int(target_ratings["userSessionId"].nunique())

    scores = individual_commonsensicality(target_ratings, reference_ratings)

    # Attach per-user statement count (from the full target data, before scoring filters)
    stmt_counts = (
        target_ratings.groupby("userSessionId")["statementId"]
        .count()
        .rename("n_statements")
    )
    scores = scores.join(stmt_counts, how="left")
    scores["n_statements"] = scores["n_statements"].fillna(0).astype(int)

    # Attach per-user country
    user_country = (
        m.groupby("userSessionId")["country_reside"].first().rename("country")
    )
    scores = scores.join(user_country, how="left")

    # Attach per-user first / last answer timestamps
    if has_ts:
        ts = target_ratings.groupby("userSessionId")["createdAt"].agg(
            first_answer="min", last_answer="max"
        )
        ts = ts.apply(lambda col: col.dt.strftime("%Y-%m-%d"))
        scores = scores.join(ts, how="left")

    counts, bin_edges = np.histogram(
        scores["commonsensicality"].to_numpy(dtype=float), bins=20, range=(0.0, 1.0)
    )

    float_cols = ["consensus", "awareness", "commonsensicality"]
    rows_df = scores.reset_index().sort_values("commonsensicality", ascending=False)
    rows_df[float_cols] = rows_df[float_cols].round(4)
    rows = rows_df.to_dict(orient="records")

    # Excluded users: present in target but didn't qualify for scoring
    qualifying_ids = set(scores.index)
    excluded_ids = set(target_ratings["userSessionId"].unique()) - qualifying_ids
    if excluded_ids:
        excl_counts = (
            target_ratings[target_ratings["userSessionId"].isin(excluded_ids)]
            .groupby("userSessionId")["statementId"]
            .count()
            .rename("n_statements")
        )
        excl_country = (
            m[m["userSessionId"].isin(excluded_ids)]
            .groupby("userSessionId")["country_reside"]
            .first()
            .rename("country")
        )
        excl_df = (
            excl_counts.to_frame()
            .join(excl_country, how="left")
            .sort_values("n_statements", ascending=False)
            .reset_index()
        )
        users_excluded = excl_df.to_dict(orient="records")
    else:
        users_excluded = []

    payload = {
        "n_users": len(rows),
        "raw_n_users": raw_n_users,
        "histogram": {
            "counts": counts.tolist(),
            "bin_edges": [round(float(e), 4) for e in bin_edges],
        },
        "users": rows,
        "users_excluded": users_excluded,
    }

    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _scores_cache[key] = encoded
    return encoded


# ── Statement-level commonsensicality scores (cached) ─────────────────────
_stmt_scores_cache: dict = {}


def get_statement_scores(country: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (country, date_from, date_to)
    if key in _stmt_scores_cache:
        return _stmt_scores_cache[key]

    m = _filter_date(merged, date_from, date_to)
    subset = m if country == "all" else m[m["country_reside"] == country]
    ratings = subset[["statementId", "I_agree", "others_agree"]].copy()

    scores = statement_commonsensicality(ratings)
    scores = scores.join(
        statements.set_index("statementId")[["statement"] + PROP_COLS], how="left"
    )
    scores["statement"] = scores["statement"].fillna("")
    for col in PROP_COLS:
        scores[col] = scores[col].apply(lambda x: int(x) if pd.notna(x) else None)

    n_users = int(subset["userSessionId"].nunique())

    counts, bin_edges = np.histogram(
        scores["commonsensicality"].to_numpy(dtype=float), bins=20, range=(0.0, 1.0)
    )

    float_cols = [
        "I_agree_mean",
        "others_agree_mean",
        "consensus",
        "awareness",
        "commonsensicality",
    ]
    rows_df = scores.reset_index().sort_values("commonsensicality", ascending=False)
    rows_df[float_cols] = rows_df[float_cols].round(4)
    rows = rows_df.to_dict(orient="records")

    # Excluded statements: have ratings but fewer than the minimum
    qualifying_stmt_ids = set(scores.index)
    excl_agg = (
        subset.groupby("statementId")
        .agg(
            n_ratings=("I_agree", "count"),
            I_agree_mean=("I_agree", "mean"),
            others_agree_mean=("others_agree", "mean"),
        )
        .reset_index()
    )
    excl_agg = excl_agg[~excl_agg["statementId"].isin(qualifying_stmt_ids)].copy()
    excl_agg = excl_agg.merge(
        statements.set_index("statementId")[["statement"] + PROP_COLS],
        on="statementId", how="left",
    )
    excl_agg["statement"] = excl_agg["statement"].fillna("")
    for col in PROP_COLS:
        excl_agg[col] = excl_agg[col].apply(lambda x: int(x) if pd.notna(x) else None)
    excl_agg["I_agree_mean"] = excl_agg["I_agree_mean"].round(4)
    excl_agg["others_agree_mean"] = excl_agg["others_agree_mean"].round(4)
    excl_agg["n_ratings"] = excl_agg["n_ratings"].astype(int)
    excl_agg["statementId"] = excl_agg["statementId"].astype(int)
    excl_agg = excl_agg.sort_values("n_ratings", ascending=False)
    rows_excluded = excl_agg.to_dict(orient="records")

    payload = {
        "n_statements": len(rows),
        "n_users": n_users,
        "histogram": {
            "counts": counts.tolist(),
            "bin_edges": [round(float(e), 4) for e in bin_edges],
        },
        "rows": rows,
        "rows_excluded": rows_excluded,
    }

    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _stmt_scores_cache[key] = encoded
    return encoded


# ── Design-point commonsensicality (cached) ───────────────────────────────
_dp_cache: dict = {}

try:
    from scipy.stats import t as _scipy_t

    def _t_crit(df):
        return float(_scipy_t.ppf(0.975, df=df))
except ImportError:

    def _t_crit(df):
        for threshold, val in [
            (120, 1.980),
            (60, 2.000),
            (40, 2.021),
            (30, 2.042),
            (20, 2.086),
            (15, 2.131),
            (10, 2.228),
            (9, 2.262),
            (8, 2.306),
            (7, 2.365),
            (6, 2.447),
            (5, 2.571),
            (4, 2.776),
            (3, 3.182),
            (2, 4.303),
        ]:
            if df >= threshold:
                return val
        return 12.706


def get_design_points(country: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (country, date_from, date_to)
    if key in _dp_cache:
        return _dp_cache[key]

    m = _filter_date(merged, date_from, date_to)
    subset = m if country == "all" else m[m["country_reside"] == country]
    ratings = subset[["statementId", "I_agree", "others_agree"]].copy()

    scores = statement_commonsensicality(ratings)
    scores = scores.join(statements.set_index("statementId")[PROP_COLS], how="left")
    scores = scores.dropna(subset=PROP_COLS)
    for col in PROP_COLS:
        scores[col] = scores[col].astype(int)

    rows_with_data, rows_no_data = [], []

    for vals in itertools.product([0, 1], repeat=len(PROP_COLS)):
        mask = pd.Series(True, index=scores.index)
        for col, val in zip(PROP_COLS, vals):
            mask &= scores[col] == val
        group = scores[mask]["commonsensicality"]
        n = int(len(group))

        props = {col: int(v) for col, v in zip(PROP_COLS, vals)}
        row = {**props, "n": n, "mean": None, "ci_lo": None, "ci_hi": None}

        if n >= 1:
            m = float(group.mean())
            row["mean"] = round(m, 4)
        if n >= 2:
            s = float(group.std())
            margin = _t_crit(n - 1) * s / np.sqrt(n)
            row["ci_lo"] = round(max(0.0, m - margin), 4)
            row["ci_hi"] = round(min(1.0, m + margin), 4)

        (rows_with_data if n >= 5 else rows_no_data).append(row)

    rows_with_data.sort(key=lambda r: r["mean"], reverse=True)
    rows_no_data.sort(key=lambda r: r["n"], reverse=True)

    payload = {"rows": rows_with_data, "rows_excluded": rows_no_data}
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _dp_cache[key] = encoded
    return encoded


# ── Statements for a single design point (cached) ─────────────────────────
_dp_stmts_cache: dict = {}


def get_dp_statements(country: str, props: dict, date_from: str = "", date_to: str = "") -> bytes:
    cache_key = (country, date_from, date_to) + tuple(props[col] for col in PROP_COLS)
    if cache_key in _dp_stmts_cache:
        return _dp_stmts_cache[cache_key]

    m = _filter_date(merged, date_from, date_to)
    subset = m if country == "all" else m[m["country_reside"] == country]
    ratings = subset[["statementId", "I_agree", "others_agree"]].copy()

    scores = statement_commonsensicality(ratings)
    scores = scores.join(
        statements.set_index("statementId")[["statement"] + PROP_COLS], how="left"
    )
    scores = scores.dropna(subset=PROP_COLS)
    for col in PROP_COLS:
        scores[col] = scores[col].astype(int)

    mask = pd.Series(True, index=scores.index)
    for col, val in props.items():
        mask &= scores[col] == val

    filtered = scores[mask].copy()
    filtered["statement"] = filtered["statement"].fillna("")

    float_cols = [
        "I_agree_mean",
        "others_agree_mean",
        "consensus",
        "awareness",
        "commonsensicality",
    ]
    rows_df = filtered.reset_index().sort_values("n_ratings", ascending=False)
    rows_df[float_cols] = rows_df[float_cols].round(4)
    rows_df["n_ratings"] = rows_df["n_ratings"].astype(int)
    rows_df["statementId"] = rows_df["statementId"].astype(int)

    rows = rows_df[["statementId", "statement", "n_ratings"] + float_cols].to_dict(
        orient="records"
    )

    payload = {"n": len(rows), "rows": rows}
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _dp_stmts_cache[cache_key] = encoded
    return encoded


# ── Country × statement commonsensicality matrix (cached) ────────────────
_country_matrix_cache: dict = {}


def get_country_matrix(date_from: str = "", date_to: str = "") -> bytes:
    key = (date_from, date_to)
    if key in _country_matrix_cache:
        return _country_matrix_cache[key]

    MIN_RATINGS = 10
    m = _filter_date(merged, date_from, date_to)

    agg_all = (
        m.groupby(["country_reside", "statementId"])
        .agg(
            n_ratings=("I_agree", "count"),
            I_agree_mean=("I_agree", "mean"),
            others_agree_mean=("others_agree", "mean"),
        )
        .reset_index()
    )
    agg = agg_all[agg_all["n_ratings"] >= MIN_RATINGS].copy()

    agg["consensus"] = 2 * np.abs(agg["I_agree_mean"] - 0.5)
    agg["maj_vote"] = (agg["I_agree_mean"] >= 0.5).astype(int)
    agg["awareness"] = np.where(
        agg["maj_vote"] == 1,
        agg["others_agree_mean"],
        1 - agg["others_agree_mean"],
    )
    # Store as percentage 0–100, 2 dp
    agg["score"] = (np.sqrt(agg["consensus"] * agg["awareness"]) * 100).round(2)

    # Columns: countries sorted by number of qualifying statements (desc)
    country_counts = agg.groupby("country_reside").size().sort_values(ascending=False)
    countries = country_counts.index.tolist()

    # Rows: statements sorted by number of qualifying countries (desc)
    stmt_counts = agg.groupby("statementId").size()
    stmt_texts = (
        agg.merge(statements[["statementId", "statement"]], on="statementId", how="left")
        .groupby("statementId")["statement"]
        .first()
        .fillna("")
    )
    stmt_order = stmt_counts.sort_values(ascending=False).index

    score_lookup = agg.set_index(["statementId", "country_reside"])["score"].to_dict()
    n_lookup     = agg.set_index(["statementId", "country_reside"])["n_ratings"].to_dict()
    stmt_sd      = agg.groupby("statementId")["score"].std().fillna(0.0).round(2)

    # Sub-threshold lookup: cells with 0 < n < MIN_RATINGS (score hidden, n shown)
    sub = agg_all[agg_all["n_ratings"] < MIN_RATINGS]
    sub_n_lookup = sub.set_index(["statementId", "country_reside"])["n_ratings"].to_dict()

    _prop_cols = ["fact", "physical", "literal_language", "positive", "knowledge", "everyday"]
    stmt_props_df = (
        statements[["statementId"] + _prop_cols]
        .drop_duplicates("statementId")
        .set_index("statementId")
    )

    rows = []
    for stmt_id in stmt_order:
        scores = {}
        for c in countries:
            v = score_lookup.get((stmt_id, c))
            if v is not None:
                scores[c] = {"s": float(v), "n": int(n_lookup[(stmt_id, c)])}
            else:
                sub_n = sub_n_lookup.get((stmt_id, c))
                if sub_n is not None:
                    scores[c] = {"n": int(sub_n)}
        if stmt_id in stmt_props_df.index:
            prow = stmt_props_df.loc[stmt_id]
            props = {col: (None if pd.isna(prow[col]) else int(prow[col])) for col in _prop_cols}
        else:
            props = {col: None for col in _prop_cols}
        rows.append({
            "statementId": int(stmt_id),
            "statement": str(stmt_texts.get(stmt_id, "")),
            "scores": scores,
            "sd": float(stmt_sd.get(stmt_id, 0.0)),
            **props,
        })

    payload = {
        "countries": countries,
        "country_n_statements": {c: int(country_counts[c]) for c in countries},
        "rows": rows,
    }
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _country_matrix_cache[key] = encoded
    return encoded


# ── Country cell detail (no cache — lightweight per-cell query) ──────────


def get_country_cell(stmt_id: int, country: str, date_from: str = "", date_to: str = "") -> bytes:
    m = _filter_date(merged, date_from, date_to)
    mask = (m["statementId"] == stmt_id) & (m["country_reside"] == country)
    sub = m[mask]
    if len(sub) < 10:
        return json.dumps({"error": "not enough ratings"}).encode("utf-8")
    n = int(len(sub))
    I_agree_mean = float(sub["I_agree"].mean())
    others_agree_mean = float(sub["others_agree"].mean())
    stmt_rows = statements[statements["statementId"] == stmt_id]
    stmt_text = str(stmt_rows["statement"].iloc[0]) if len(stmt_rows) > 0 else ""
    return json.dumps(
        {
            "statementId": stmt_id,
            "statement": stmt_text,
            "n_ratings": n,
            "I_agree_mean": I_agree_mean,
            "others_agree_mean": others_agree_mean,
        },
        ensure_ascii=False,
    ).encode("utf-8")


# ── User detail (no cache — lightweight per-user query) ───────────────────


def get_user_detail(user_id: str, reference: str, target: str, date_from: str = "", date_to: str = "") -> bytes:
    MIN_RATINGS = 10

    m = _filter_date(merged, date_from, date_to)
    user_ratings = m[m["userSessionId"] == user_id][
        ["statementId", "I_agree", "others_agree"]
    ].copy()

    if user_ratings.empty:
        return json.dumps(
            {"rows": [], "n_scoring": 0, "A": 0, "B": 0}, ensure_ascii=False
        ).encode("utf-8")

    stmt_ids = user_ratings["statementId"].unique()

    # ── Compute A, B, N using the exact same filtering as individual_commonsensicality
    target_group = (
        m if target == "all" else m[m["country_reside"] == target]
    )
    ref_group = (
        m if reference == "all" else m[m["country_reside"] == reference]
    )

    target_counts = target_group["statementId"].value_counts()
    ref_counts = ref_group["statementId"].value_counts()
    valid_target = target_counts[target_counts >= MIN_RATINGS].index
    valid_ref = ref_counts[ref_counts >= MIN_RATINGS].index
    common_stmts = set(valid_target) & set(valid_ref)

    ref_avg = (
        ref_group[ref_group["statementId"].isin(common_stmts)]
        .groupby("statementId")["I_agree"]
        .mean()
    )
    maj_vote = (ref_avg >= 0.5).astype(int)

    user_qual = user_ratings[user_ratings["statementId"].isin(common_stmts)].merge(
        maj_vote.rename("maj_vote"), on="statementId", how="inner"
    )
    MIN_STMTS_USER = 5
    N_scoring = int(len(user_qual))  # qualifying count (may be < 5)
    disqualified = N_scoring < MIN_STMTS_USER
    A = (
        int((user_qual["I_agree"] == user_qual["maj_vote"]).sum())
        if not disqualified
        else 0
    )
    B = (
        int((user_qual["others_agree"] == user_qual["maj_vote"]).sum())
        if not disqualified
        else 0
    )

    # ── Full display rows (all rated statements with reference averages) ───────
    ref_agg = (
        ref_group[ref_group["statementId"].isin(stmt_ids)]
        .groupby("statementId")
        .agg(
            ref_n_ratings=("I_agree", "count"),
            ref_i_agree_mean=("I_agree", "mean"),
            ref_others_agree_mean=("others_agree", "mean"),
        )
        .reset_index()
        .round(4)
    )

    result = user_ratings.merge(ref_agg, on="statementId", how="left").merge(
        statements[["statementId", "statement"]], on="statementId", how="left"
    )
    result["statement"] = result["statement"].fillna("")
    result["I_agree"] = result["I_agree"].astype(int)
    result["others_agree"] = result["others_agree"].astype(int)
    result["statementId"] = result["statementId"].astype(int)

    rows = [
        {k: (None if pd.isna(v) else v) for k, v in r.items()}
        for r in result.sort_values("statementId").to_dict(orient="records")
    ]
    return json.dumps(
        {
            "rows": rows,
            "n_scoring": N_scoring,
            "A": A,
            "B": B,
            "disqualified": disqualified,
        },
        ensure_ascii=False,
    ).encode("utf-8")


_compare_cache: dict = {}


def get_group_compare(group_a: str, group_b: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (group_a, group_b, date_from, date_to)
    if key in _compare_cache:
        return _compare_cache[key]

    m = _filter_date(merged, date_from, date_to)

    def filter_group(g):
        return m if g == "all" else m[m["country_reside"] == g]

    def indiv_detail(g):
        data = filter_group(g)
        raw_n = int(data["userSessionId"].nunique()) if not data.empty else 0
        if data.empty:
            return [], 0
        try:
            df = individual_commonsensicality(data, data)[
                ["consensus", "awareness", "commonsensicality"]
            ]
            df = df.round(4)
            items = [
                {
                    "userId": str(uid),
                    "consensus": float(row["consensus"]),
                    "awareness": float(row["awareness"]),
                    "score": float(row["commonsensicality"]),
                }
                for uid, row in df.iterrows()
            ]
            return items, raw_n
        except Exception:
            return [], raw_n

    def stmt_detail(g):
        data = filter_group(g)
        if data.empty:
            return pd.DataFrame(), []
        try:
            df = statement_commonsensicality(data)
            detail = (
                df[
                    [
                        "n_ratings",
                        "I_agree_mean",
                        "others_agree_mean",
                        "commonsensicality",
                    ]
                ]
                .reset_index()
                .merge(
                    statements[["statementId", "statement"]],
                    on="statementId",
                    how="left",
                )
            )
            detail["statement"] = detail["statement"].fillna("")
            items = [
                {
                    "statementId": int(r["statementId"]),
                    "statement": str(r["statement"]),
                    "n_ratings": int(r["n_ratings"]),
                    "I_agree_mean": round(float(r["I_agree_mean"]), 4),
                    "others_agree_mean": round(float(r["others_agree_mean"]), 4),
                    "score": round(float(r["commonsensicality"]), 4),
                }
                for _, r in detail.iterrows()
            ]
            return df, items
        except Exception:
            return pd.DataFrame(), []

    indiv_a, raw_n_a = indiv_detail(group_a)
    indiv_b, raw_n_b = indiv_detail(group_b)
    sa, stmt_a_items = stmt_detail(group_a)
    sb, stmt_b_items = stmt_detail(group_b)

    paired = []
    if not sa.empty and not sb.empty:
        common_ids = sa.index.intersection(sb.index)
        if len(common_ids):
            df = (
                sa.loc[common_ids, ["commonsensicality"]]
                .rename(columns={"commonsensicality": "score_a"})
                .join(
                    sb.loc[common_ids, ["commonsensicality"]].rename(
                        columns={"commonsensicality": "score_b"}
                    )
                )
                .reset_index()
                .merge(
                    statements[["statementId", "statement"]],
                    on="statementId",
                    how="left",
                )
            )
            df["score_a"] = df["score_a"].round(4)
            df["score_b"] = df["score_b"].round(4)
            df["statement"] = df["statement"].fillna("")
            paired = df[["statementId", "statement", "score_a", "score_b"]].to_dict(
                orient="records"
            )

    result = json.dumps(
        {
            "individuals": {
                "a": indiv_a,
                "b": indiv_b,
                "raw_n_a": raw_n_a,
                "raw_n_b": raw_n_b,
            },
            "statements": {"a": stmt_a_items, "b": stmt_b_items, "paired": paired},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    _compare_cache[key] = result
    return result


def get_statement_countries(stmt_id: str, date_from: str = "", date_to: str = "") -> bytes:
    if not stmt_id:
        return json.dumps([], ensure_ascii=False).encode("utf-8")
    try:
        sid = int(stmt_id)
    except ValueError:
        return json.dumps([], ensure_ascii=False).encode("utf-8")
    m = _filter_date(merged, date_from, date_to)
    rows = (
        m[m["statementId"] == sid]["country_reside"]
        .value_counts()
        .head(5)
        .reset_index()
        .rename(columns={"country_reside": "country", "count": "n_ratings"})
        .to_dict(orient="records")
    )
    return json.dumps(rows, ensure_ascii=False).encode("utf-8")


# ── HTTP handler ───────────────────────────────────────────────────────────
class Handler(http.server.SimpleHTTPRequestHandler):
    def _send_json(self, body: bytes):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, code: int, message: str):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self._handle_GET()
        except Exception as exc:
            import traceback

            traceback.print_exc()
            try:
                self._send_error_json(500, str(exc))
            except Exception:
                pass

    def _handle_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        date_from = params.get("date_from", [""])[0]
        date_to = params.get("date_to", [""])[0]

        if parsed.path == "/api/countries":
            self._send_json(COUNTRIES_JSON)
        elif parsed.path == "/api/statements":
            country = params.get("country", ["all"])[0]
            self._send_json(get_statements(country, date_from, date_to))
        elif parsed.path == "/api/scores":
            target = params.get("target", ["all"])[0]
            reference = params.get("reference", ["all"])[0]
            self._send_json(get_scores(target, reference, date_from, date_to))
        elif parsed.path == "/api/statement-scores":
            country = params.get("country", ["all"])[0]
            self._send_json(get_statement_scores(country, date_from, date_to))
        elif parsed.path == "/api/design-points":
            country = params.get("country", ["all"])[0]
            self._send_json(get_design_points(country, date_from, date_to))
        elif parsed.path == "/api/dp-statements":
            country = params.get("country", ["all"])[0]
            props = {col: int(params.get(col, ["0"])[0]) for col in PROP_COLS}
            self._send_json(get_dp_statements(country, props, date_from, date_to))
        elif parsed.path == "/api/user-detail":
            user_id = params.get("userId", [""])[0]
            reference = params.get("reference", ["all"])[0]
            target = params.get("target", ["all"])[0]
            self._send_json(get_user_detail(user_id, reference, target, date_from, date_to))
        elif parsed.path == "/api/group-compare":
            group_a = params.get("groupA", ["all"])[0]
            group_b = params.get("groupB", ["all"])[0]
            self._send_json(get_group_compare(group_a, group_b, date_from, date_to))
        elif parsed.path == "/api/statement-countries":
            stmt_id = params.get("statementId", [""])[0]
            self._send_json(get_statement_countries(stmt_id, date_from, date_to))
        elif parsed.path == "/api/country-matrix":
            self._send_json(get_country_matrix(date_from, date_to))
        elif parsed.path == "/api/country-cell":
            stmt_id = int(params.get("statementId", ["0"])[0])
            country = params.get("country", [""])[0]
            self._send_json(get_country_cell(stmt_id, country, date_from, date_to))
        elif parsed.path == "/" or parsed.path.startswith("/static/"):
            http.server.SimpleHTTPRequestHandler.do_GET(self)
        else:
            # SPA fallback: serve index.html for all panel routes
            index_path = os.path.join(BASE_DIR, "index.html")
            with open(index_path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0]):
            print(" ", args[0], args[1])


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    os.chdir(BASE_DIR)
    httpd = http.server.HTTPServer(("", PORT), Handler)
    print(f"Open http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
