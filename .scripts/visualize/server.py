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
import statement_coverage
import statement_audit
import typesafe_audit
import llm_evals

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
# "item1" is the survey form's unanswered default for country_reside, not a
# country (39 participants). They are relabelled NO_COUNTRY: they count in
# "All countries" but in no country of their own, so _in_countries() drops
# them wherever results are listed or grouped by country (dropdowns, the Home
# map and its counts, the Countries matrix, a statement's countries).
NO_COUNTRY = "Not stated"
demo["country_reside"] = demo["country_reside"].replace({"item1": NO_COUNTRY})

# A participant is someone who rated at least MIN_PARTICIPANT_RATINGS
# statements (Josh, October 2026). Anyone with fewer is dropped here, answers
# and all, so every count, map and score on the site uses the same people.
# This is a floor on raw ratings, separate from utils.py's
# min_statements_per_user, which counts only statements with 10+ ratings.
MIN_PARTICIPANT_RATINGS = 5
_n_rated = answers.groupby("sessionId")["statementId"].nunique()
_participants = _n_rated.index[_n_rated >= MIN_PARTICIPANT_RATINGS]
answers = answers[answers["sessionId"].isin(_participants)]
demo = demo[demo["sessionId"].isin(_participants)]


def _in_countries(df: pd.DataFrame, col: str = "country_reside") -> pd.DataFrame:
    return df[df[col] != NO_COUNTRY]

statements = pd.read_csv(
    STATEMENTS_PATH,
    usecols=["id", "statement", "statementSource", "statementCategory", "published"],
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
    demo[["sessionId", "country_reside"]],
    on="sessionId",
    how="inner",
)

# Country list sorted by participant count
_countries = (
    _in_countries(demo)["country_reside"]
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
    f"{len(_countries)} countries."
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


# ── Score histogram (Individual Scores, Statement Scores) ──────────────────

# Decimals of the 0-1 scores and shares sent by /api/scores and
# /api/statement-scores. The page rounds them again to one decimal of a
# percent, so 4 decimals double-rounded (68.853% -> 0.6885 -> "68.8%"); 5 keep
# that to a rare tie. _score_histogram() bins the same rounded values.
SCORE_DP = 5


def _score_histogram(scores: pd.Series, n_bins: int = 20) -> tuple[list, list]:
    """Counts of 0-1 scores in n_bins equal bins, computed the way app.js
    filters table rows when a bar is clicked: on the SCORE_DP-rounded
    values sent to the client, with half-open [lo, hi) bins (the last one
    closed) and the same rounded edges. np.histogram on the unrounded floats used slightly
    different edges (0.6000000000000001 rather than 0.6), so a score lying on
    an edge, such as 9/15 = 0.6, was counted in the bar below the one whose
    list showed it."""
    edges = [round(i / n_bins, 4) for i in range(n_bins + 1)]
    values = np.round(scores.to_numpy(dtype=float), SCORE_DP)
    counts = []
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        upper = values <= hi if i == n_bins - 1 else values < hi
        counts.append(int(((values >= lo) & upper).sum()))
    return counts, edges


# ── Participants per country (Home map, dropdowns) ─────────────────────────
_countries_cache: dict = {}


def get_countries(date_from: str = "", date_to: str = "") -> bytes:
    """Participants per country, most first. Without dates this is the
    startup list of every participant, which the dropdowns use so their
    options don't depend on the date filter. With dates it counts the
    participants who rated at least one statement in the window, like n_users
    in /api/country-summary, so the Home map follows the global date filter."""
    if not date_from and not date_to:
        return COUNTRIES_JSON
    key = (date_from, date_to)
    if key in _countries_cache:
        return _countries_cache[key]
    m = _in_countries(_filter_date(merged, date_from, date_to))
    rows = (
        m.groupby("country_reside")["sessionId"]
        .nunique()
        .sort_values(ascending=False)
        .reset_index()
        .rename(columns={"country_reside": "country", "sessionId": "n_users"})
        .to_dict(orient="records")
    )
    encoded = json.dumps(rows, ensure_ascii=False).encode("utf-8")
    _countries_cache[key] = encoded
    return encoded


# ── Per-country statement aggregation (cached) ─────────────────────────────
_cache: dict = {}


def get_statements(country: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (country, date_from, date_to)
    if key in _cache:
        return _cache[key]

    m = _filter_date(merged, date_from, date_to)
    subset = m if country == "all" else m[m["country_reside"] == country]

    n_users = int(subset["sessionId"].nunique())

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
    ans_cols = ["sessionId", "statementId", "I_agree", "others_agree"] + (["createdAt"] if has_ts else [])
    ref_cols = ["sessionId", "statementId", "I_agree"]

    target_ratings = (
        m[ans_cols]
        if target == "all"
        else m[m["country_reside"] == target][ans_cols]
    ).copy()

    reference_ratings = (
        merged[ref_cols]
        if reference == "all"
        else merged[merged["country_reside"] == reference][ref_cols]
    ).copy()

    raw_n_users = int(target_ratings["sessionId"].nunique())

    scores = individual_commonsensicality(target_ratings, reference_ratings)

    # Attach per-user statement count (from the full target data, before scoring filters)
    stmt_counts = (
        target_ratings.groupby("sessionId")["statementId"]
        .count()
        .rename("n_statements")
    )
    scores = scores.join(stmt_counts, how="left")
    scores["n_statements"] = scores["n_statements"].fillna(0).astype(int)

    # Attach per-user country
    user_country = (
        m.groupby("sessionId")["country_reside"].first().rename("country")
    )
    scores = scores.join(user_country, how="left")

    # Attach per-user first / last answer timestamps
    if has_ts:
        ts = target_ratings.groupby("sessionId")["createdAt"].agg(
            first_answer="min", last_answer="max"
        )
        ts = ts.apply(lambda col: col.dt.strftime("%Y-%m-%d"))
        scores = scores.join(ts, how="left")

    counts, bin_edges = _score_histogram(scores["commonsensicality"])

    float_cols = ["consensus", "awareness", "commonsensicality"]
    rows_df = scores.reset_index().sort_values("commonsensicality", ascending=False)
    rows_df[float_cols] = rows_df[float_cols].round(SCORE_DP)
    rows = rows_df.to_dict(orient="records")

    # Excluded users: present in target but didn't qualify for scoring
    qualifying_ids = set(scores.index)
    excluded_ids = set(target_ratings["sessionId"].unique()) - qualifying_ids
    if excluded_ids:
        excl_counts = (
            target_ratings[target_ratings["sessionId"].isin(excluded_ids)]
            .groupby("sessionId")["statementId"]
            .count()
            .rename("n_statements")
        )
        excl_country = (
            m[m["sessionId"].isin(excluded_ids)]
            .groupby("sessionId")["country_reside"]
            .first()
            .rename("country")
        )
        excl_df = (
            excl_counts.to_frame()
            .join(excl_country, how="left")
            .sort_values("n_statements", ascending=False)
            .reset_index()
        )
        if has_ts:
            excl_ts = (
                target_ratings[target_ratings["sessionId"].isin(excluded_ids)]
                .groupby("sessionId")["createdAt"]
                .max()
                .dt.strftime("%Y-%m-%d")
                .rename("last_answer")
            )
            excl_df = excl_df.join(excl_ts, on="sessionId", how="left")
        users_excluded = excl_df.to_dict(orient="records")
    else:
        users_excluded = []

    # Per-country average commonsensicality (qualifying users only)
    if len(scores) > 0 and "country" in scores.columns:
        ca = (
            _in_countries(scores, "country").groupby("country")["commonsensicality"]
            .agg(mean="mean", n="count")
            .reset_index()
        )
        country_avg = {
            row["country"]: {"mean": round(float(row["mean"]), 4), "n": int(row["n"])}
            for _, row in ca.iterrows()
            if row["n"] >= 10
        }
        country_insufficient = {
            row["country"]: int(row["n"])
            for _, row in ca.iterrows()
            if row["n"] < 10
        }
    else:
        country_avg = {}
        country_insufficient = {}

    payload = {
        "n_users": len(rows),
        "raw_n_users": raw_n_users,
        "histogram": {"counts": counts, "bin_edges": bin_edges},
        "users": rows,
        "users_excluded": users_excluded,
        "country_avg": country_avg,
        "country_insufficient": country_insufficient,
    }

    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _scores_cache[key] = encoded
    return encoded


# ── Country summary (lightweight, cached) ──────────────────────────────────
_summary_cache: dict = {}


def get_country_summary(country: str, date_from: str = "", date_to: str = "") -> bytes:
    key = (country, date_from, date_to)
    if key in _summary_cache:
        return _summary_cache[key]

    m = _filter_date(merged, date_from, date_to)
    subset = m[m["country_reside"] == country]

    n_users = int(subset["sessionId"].nunique())

    agg = (
        subset.groupby("statementId")
        .agg(n_ratings=("I_agree", "count"), i_agree_mean=("I_agree", "mean"))
        .reset_index()
    )

    n_statements_total = int(len(agg))
    qualified = agg[agg["n_ratings"] >= 10]
    n_statements_qualified = int(len(qualified))
    avg_i_agree = float(subset["I_agree"].mean()) if len(subset) > 0 else 0.0

    qualified_cats = (
        qualified.merge(
            statements[["statementId", "statementCategory"]],
            on="statementId",
            how="left",
        )
        .groupby("statementCategory")
        .size()
        .sort_values(ascending=False)
        .reset_index()
        .rename(columns={0: "n"})
    )
    top_categories = [
        {"category": str(row["statementCategory"]), "n": int(row["n"])}
        for _, row in qualified_cats.iterrows()
        if row["statementCategory"]
    ]

    payload = {
        "n_users": n_users,
        "n_statements_total": n_statements_total,
        "n_statements_qualified": n_statements_qualified,
        "avg_i_agree": round(avg_i_agree, 4),
        "top_categories": top_categories,
    }
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _summary_cache[key] = encoded
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

    n_users = int(subset["sessionId"].nunique())

    counts, bin_edges = _score_histogram(scores["commonsensicality"])

    float_cols = [
        "I_agree_mean",
        "others_agree_mean",
        "consensus",
        "awareness",
        "commonsensicality",
    ]
    rows_df = scores.reset_index().sort_values("commonsensicality", ascending=False)
    rows_df[float_cols] = rows_df[float_cols].round(SCORE_DP)
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
        "histogram": {"counts": counts, "bin_edges": bin_edges},
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

    # Every statement in this design point, rated or not; only those with
    # enough ratings to get a score (qualified) count toward the mean.
    in_dp = statements.dropna(subset=PROP_COLS)
    for col, val in props.items():
        in_dp = in_dp[in_dp[col].astype(int) == val]
    rows_df = in_dp[["statementId", "statement", "published"]].set_index("statementId")
    rows_df = rows_df.join(scores, how="left")
    rows_df["n_ratings"] = (
        ratings["statementId"].value_counts().reindex(rows_df.index).fillna(0)
    )
    rows_df["qualified"] = rows_df.index.isin(scores.index)
    rows_df["statement"] = rows_df["statement"].fillna("")
    rows_df["published"] = rows_df["published"].fillna(0).astype(int)

    float_cols = [
        "I_agree_mean",
        "others_agree_mean",
        "consensus",
        "awareness",
        "commonsensicality",
    ]
    rows_df = rows_df.reset_index().sort_values(
        ["qualified", "n_ratings"], ascending=False
    )
    rows_df[float_cols] = rows_df[float_cols].round(4)
    rows_df["n_ratings"] = rows_df["n_ratings"].astype(int)
    rows_df["statementId"] = rows_df["statementId"].astype(int)
    # NaN is not valid JSON; unqualified statements have no scores
    rows_df = rows_df.astype(object).where(rows_df.notna(), None)

    rows = rows_df[
        ["statementId", "statement", "published", "qualified", "n_ratings"] + float_cols
    ].to_dict(orient="records")

    n_qualified = sum(r["qualified"] for r in rows)
    payload = {
        "n": len(rows),
        "n_qualified": n_qualified,
        "n_excluded": len(rows) - n_qualified,
        "rows": rows,
    }
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
    m = _in_countries(_filter_date(merged, date_from, date_to))

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
    # Share who agree, 0–100: the Countries panel's "% agree" view, which shows
    # the direction of each country's majority that the score leaves out
    agree_lookup = (
        (agg.set_index(["statementId", "country_reside"])["I_agree_mean"] * 100).round(2).to_dict()
    )
    stmt_mean    = agg.groupby("statementId")["score"].mean().round(2)
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
                scores[c] = {
                    "s": float(v),
                    "n": int(n_lookup[(stmt_id, c)]),
                    "a": float(agree_lookup[(stmt_id, c)]),
                }
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
            "mean": float(stmt_mean.get(stmt_id, 0.0)),
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


def get_user_detail(user_id: str, reference: str, date_from: str = "", date_to: str = "") -> bytes:
    MIN_RATINGS = 10

    m = _filter_date(merged, date_from, date_to)
    user_ratings = m[m["sessionId"] == user_id][
        ["statementId", "I_agree", "others_agree"]
    ].copy()

    if user_ratings.empty:
        return json.dumps(
            {"rows": [], "n_scoring": 0, "A": 0, "B": 0}, ensure_ascii=False
        ).encode("utf-8")

    stmt_ids = user_ratings["statementId"].unique()

    # ── Compute A, B, N using the exact same filtering as individual_commonsensicality
    # The reference group ignores the date filter, matching get_scores().
    ref_group = (
        merged if reference == "all" else merged[merged["country_reside"] == reference]
    )

    ref_counts = ref_group["statementId"].value_counts()
    common_stmts = set(ref_counts[ref_counts >= MIN_RATINGS].index)

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

    # Whether each statement counts (10+ reference ratings) and the reference
    # majority (1 = agrees; from the unrounded share), so the modal marks
    # answers by the same rule as the score above
    ref_agg["counted"] = ref_agg["statementId"].isin(common_stmts)
    ref_agg["ref_majority"] = ref_agg["statementId"].map(maj_vote)
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
        raw_n = int(data["sessionId"].nunique()) if not data.empty else 0
        if data.empty:
            return [], 0
        # The reference group ignores the date filter, matching get_scores().
        ref = merged if g == "all" else merged[merged["country_reside"] == g]
        try:
            df = individual_commonsensicality(data, ref)[
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
                sa.loc[common_ids, ["commonsensicality", "I_agree_mean"]]
                .rename(columns={"commonsensicality": "score_a", "I_agree_mean": "p_a"})
                .join(
                    sb.loc[common_ids, ["commonsensicality", "I_agree_mean"]].rename(
                        columns={"commonsensicality": "score_b", "I_agree_mean": "p_b"}
                    )
                )
                .reset_index()
                .merge(
                    statements[["statementId", "statement"]],
                    on="statementId",
                    how="left",
                )
            )
            # Each group's majority (agree when at least half agree, from the
            # unrounded share): the scatter marks statements where they differ
            df["maj_a"] = (df["p_a"] >= 0.5).astype(int)
            df["maj_b"] = (df["p_b"] >= 0.5).astype(int)
            for col in ("score_a", "score_b", "p_a", "p_b"):
                df[col] = df[col].round(4)
            df["statement"] = df["statement"].fillna("")
            paired = df[
                ["statementId", "statement", "score_a", "score_b", "p_a", "p_b", "maj_a", "maj_b"]
            ].to_dict(orient="records")

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
    # Every country that rated the statement, most ratings first, with how its
    # participants answered. A country with at least 10 ratings also gets its
    # own score: statement_commonsensicality() groups by its statementId
    # column, so passing the country in that column scores each country.
    sub = _in_countries(m.loc[m["statementId"] == sid, ["country_reside", "I_agree", "others_agree"]])
    agg = (
        sub.groupby("country_reside")
        .agg(
            n_ratings=("I_agree", "size"),
            I_agree_mean=("I_agree", "mean"),
            others_agree_mean=("others_agree", "mean"),
        )
        .reset_index()
        .sort_values(["n_ratings", "country_reside"], ascending=[False, True])
    )
    scored = statement_commonsensicality(sub.rename(columns={"country_reside": "statementId"}))["commonsensicality"]
    rows = []
    for c, n, p, q in agg.itertuples(index=False):
        row = {
            "country": c, "n_ratings": int(n),
            "I_agree_mean": round(float(p), 4), "others_agree_mean": round(float(q), 4),
            "maj": int(p >= 0.5),  # from the unrounded share; a tie counts as agree
        }
        if c in scored.index:
            row["score"] = round(float(scored[c]), 4)
        rows.append(row)
    return json.dumps(rows, ensure_ascii=False).encode("utf-8")


# ── Statement source / category (shown when a statement is clicked) ───────


def get_statement_meta(stmt_id: str) -> bytes | None:
    try:
        sid = int(stmt_id)
    except ValueError:
        return None
    row = statements[statements["statementId"] == sid]
    if row.empty:
        return None
    row = row.iloc[0]
    meta = {
        "source": row["statementSource"] if pd.notna(row["statementSource"]) else None,
        "category": row["statementCategory"] if pd.notna(row["statementCategory"]) else None,
    }
    return json.dumps(meta, ensure_ascii=False).encode("utf-8")


# ── Home / landing-page summary (cached) ───────────────────────────────────
# Everything the Home page shows besides the map, in one request. Scores are
# read back from get_scores(), get_statement_scores() and get_design_points()
# rather than recomputed, so the Home numbers always match the Individual
# Scores, Statement Scores and Design Points panels (and the first visit warms
# those caches).
_home_cache: dict = {}

# Example statements on the Home page prefer at least this many ratings, so
# their percentages are stable.
_HOME_EXAMPLE_MIN_RATINGS = (100, 30, 10)
_HOME_EXAMPLES_PER_LIST = 8
# Scores at which the Statement Scores card shows an example statement
_HOME_SCALE_TARGETS = (0.95, 0.75, 0.5, 0.25, 0.05)
# Countries listed in "Share of participants" at most; the page shows as many
# as fit beside the map and folds the rest into "All other countries"
_HOME_COMPOSITION_MAX = 30


def _round_or_none(x, nd: int = 4):
    return None if x is None or pd.isna(x) else round(float(x), nd)


def _home_stmt(row) -> dict:
    return {
        "id": int(row["statementId"]),
        "text": row["statement"],
        "n": int(row["n_ratings"]),
        "p": round(float(row["I_agree_mean"]), 4),
        "q": round(float(row["others_agree_mean"]), 4),
        "m": round(float(row["commonsensicality"]), 4),
    }


def get_home_summary(date_from: str = "", date_to: str = "") -> bytes:
    key = (date_from, date_to)
    if key in _home_cache:
        return _home_cache[key]

    m = _filter_date(merged, date_from, date_to)
    indiv = json.loads(get_scores("all", "all", date_from, date_to))
    stmt = json.loads(get_statement_scores("all", date_from, date_to))
    dps = json.loads(get_design_points("all", date_from, date_to))

    # ── Totals and who took part ──
    per_country = _in_countries(m).groupby("country_reside")["sessionId"].nunique().sort_values(ascending=False)
    has_ts = "createdAt" in m.columns and len(m) > 0
    totals = {
        "participants": int(m["sessionId"].nunique()),
        "ratings": int(len(m)),
        "statements_rated": int(m["statementId"].nunique()),
        "statements_scored": int(stmt["n_statements"]),
        "countries": int(len(per_country)),
        "countries_10": int((per_country >= 10).sum()),
        "median_ratings_per_participant": (
            float(m.groupby("sessionId").size().median()) if len(m) else 0.0
        ),
        "first_date": m["createdAt"].min().strftime("%Y-%m-%d") if has_ts else None,
        "last_date": m["createdAt"].max().strftime("%Y-%m-%d") if has_ts else None,
    }
    top = per_country.head(_HOME_COMPOSITION_MAX)
    composition = [{"country": c, "n": int(n)} for c, n in top.items()]
    if len(per_country) > len(top):
        composition.append({"country": "Other", "n": int(per_country.iloc[len(top):].sum())})

    # ── Individual scores ──
    cs = np.array([u["commonsensicality"] for u in indiv["users"]], dtype=float)
    individual = {"n": int(len(cs)), "histogram": indiv["histogram"]}
    if len(cs):
        q1, med, q3 = np.quantile(cs, [0.25, 0.5, 0.75])
        individual.update(median=round(float(med), 4), q1=round(float(q1), 4), q3=round(float(q3), 4))

    # ── Statement scores ──
    df = pd.DataFrame(stmt["rows"])
    statement = {"n": int(len(df))}
    examples = {}
    scale = []
    if len(df):
        q1, med, q3 = np.quantile(df["commonsensicality"].to_numpy(dtype=float), [0.25, 0.5, 0.75])
        statement.update(median=round(float(med), 4), q1=round(float(q1), 4), q3=round(float(q3), 4))

        for n_min in _HOME_EXAMPLE_MIN_RATINGS:
            pool = df[df["n_ratings"] >= n_min]
            if len(pool) >= 60:
                break
        k = _HOME_EXAMPLES_PER_LIST
        agree, disagree = pool[pool["I_agree_mean"] >= 0.5], pool[pool["I_agree_mean"] < 0.5]
        lists = {
            # Highest scores with an agreeing / a disagreeing majority
            "universal": agree.nlargest(k, "commonsensicality"),
            "rejected": disagree.nlargest(k, "commonsensicality"),
            # Closest to a 50/50 split
            "divisive": pool.nsmallest(k, "consensus"),
            # Lowest awareness: the majority agrees but few expect it, or
            # disagrees while most expect agreement
            "underestimated": agree.nsmallest(k, "awareness"),
            "overestimated": disagree.nsmallest(k, "awareness"),
        }
        examples = {name: [_home_stmt(r) for _, r in rows.iterrows()] for name, rows in lists.items()}
        examples["min_ratings"] = int(n_min)

        # One short example statement near each target score: the most-rated
        # one within 5 points of it (else the closest), so examples are
        # familiar core statements
        short = pool[pool["statement"].str.len() <= 60]
        short = short if len(short) >= len(_HOME_SCALE_TARGETS) else pool
        used = set()
        for target in _HOME_SCALE_TARGETS:
            cand = short[~short["statementId"].isin(used)]
            if not len(cand):
                break
            dist = (cand["commonsensicality"] - target).abs()
            near = cand[dist <= 0.05]
            row = near.loc[near["n_ratings"].idxmax()] if len(near) else cand.loc[dist.idxmin()]
            used.add(row["statementId"])
            scale.append(_home_stmt(row))

    # ── Statement features: mean score on each side of each feature ──
    properties = []
    for col in PROP_COLS:
        side = {}
        for val in (1, 0):
            vals = df.loc[df[col] == val, "commonsensicality"] if len(df) else pd.Series(dtype=float)
            n = int(len(vals))
            mean = float(vals.mean()) if n else None
            lo = hi = None
            if n >= 2:
                margin = _t_crit(n - 1) * float(vals.std()) / np.sqrt(n)
                lo, hi = mean - margin, mean + margin
            side[val] = {"n": n, "mean": _round_or_none(mean), "lo": _round_or_none(lo), "hi": _round_or_none(hi)}
        properties.append({"key": col, "v1": side[1], "v0": side[0]})

    # ── The highest- and lowest-scoring design points, with their most-rated
    # statements as examples. Ranked as on the Design Points panel: only
    # design points with >= 5 scored statements, by mean score ──
    ranked = dps["rows"]  # sorted by mean, highest first

    def _dp_card(rank):
        row = ranked[rank - 1]
        mask = pd.Series(True, index=df.index)
        for col in PROP_COLS:
            mask &= df[col] == row[col]
        ex = df[mask].sort_values("n_ratings", ascending=False).head(3)
        return {
            "features": {c: int(row[c]) for c in PROP_COLS},
            "n": row["n"], "mean": row["mean"], "ci_lo": row["ci_lo"], "ci_hi": row["ci_hi"],
            "rank": rank,
            "examples": [_home_stmt(r) for _, r in ex.iterrows()],
        }

    design_points = {
        "n_ranked": len(ranked),
        "top": _dp_card(1) if ranked else None,
        "bottom": _dp_card(len(ranked)) if len(ranked) > 1 else None,
    }

    payload = {
        "date_from": date_from,
        "date_to": date_to,
        "totals": totals,
        "composition": composition,
        "individual": individual,
        "statement": statement,
        "examples": examples,
        "scale": scale,
        "properties": properties,
        "design_points": design_points,
    }
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _home_cache[key] = encoded
    return encoded


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
            self._send_json(get_countries(date_from, date_to))
        elif parsed.path == "/api/home-summary":
            self._send_json(get_home_summary(date_from, date_to))
        elif parsed.path == "/api/country-summary":
            country = params.get("country", [""])[0]
            self._send_json(get_country_summary(country, date_from, date_to))
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
            self._send_json(get_user_detail(user_id, reference, date_from, date_to))
        elif parsed.path == "/api/group-compare":
            group_a = params.get("groupA", ["all"])[0]
            group_b = params.get("groupB", ["all"])[0]
            self._send_json(get_group_compare(group_a, group_b, date_from, date_to))
        elif parsed.path == "/api/statement-countries":
            stmt_id = params.get("statementId", [""])[0]
            self._send_json(get_statement_countries(stmt_id, date_from, date_to))
        elif parsed.path == "/api/statement-meta":
            meta = get_statement_meta(params.get("statementId", [""])[0])
            if meta is None:
                self._send_error_json(404, "Unknown statementId")
                return
            self._send_json(meta)
        elif parsed.path == "/api/country-matrix":
            self._send_json(get_country_matrix(date_from, date_to))
        elif parsed.path == "/api/country-cell":
            stmt_id = int(params.get("statementId", ["0"])[0])
            country = params.get("country", [""])[0]
            self._send_json(get_country_cell(stmt_id, country, date_from, date_to))
        elif parsed.path == "/api/statement-coverage":
            data = statement_coverage.get_coverage()
            self._send_json(json.dumps({"feature_keys": data["feature_keys"], "rows": data["rows"]}).encode("utf-8"))
        elif parsed.path == "/api/statement-coverage-statements":
            metric = params.get("metric", ["supplementable"])[0]
            try:
                combo = tuple(int(params[key][0]) for key in statement_coverage.FEAT_KEYS)
            except (KeyError, ValueError):
                self._send_error_json(400, "Missing or invalid feature parameters")
                return
            try:
                statements = statement_coverage.get_statements_for_combo(combo, metric)
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return
            self._send_json(json.dumps({"statements": statements, "metric": metric}, ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/statement-audit":
            data = statement_audit.get_audit()
            payload = {k: v for k, v in data.items() if k != "by_combo"}
            self._send_json(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/statement-audit-statements":
            metric = params.get("metric", ["published"])[0]
            try:
                combo = tuple(int(params[key][0]) for key in statement_audit.FEAT_KEYS)
            except (KeyError, ValueError):
                self._send_error_json(400, "Missing or invalid feature parameters")
                return
            try:
                statements = statement_audit.get_audit_statements(combo, metric)
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return
            self._send_json(json.dumps({"statements": statements, "metric": metric}, ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/typesafe-audit":
            try:
                data = typesafe_audit.get_audit(params.get("model", [""])[0])
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return
            self._send_json(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/typesafe-audit-statement":
            try:
                row = int(params["row"][0])
            except (KeyError, ValueError):
                self._send_error_json(400, "Missing or invalid row")
                return
            self._send_json(json.dumps(typesafe_audit.get_statement(row), ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/llm-evals":
            self._send_json(json.dumps(llm_evals.get_summary(), ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/llm-evals/statements":
            self._send_json(json.dumps(llm_evals.get_statements(), ensure_ascii=False).encode("utf-8"))
        elif parsed.path == "/api/llm-evals/split":
            seed, stmt = params.get("seed", [""])[0], params.get("statement", [""])[0]
            if not (seed.isdigit() and stmt.isdigit()):
                self._send_error_json(400, "Missing or invalid seed or statement")
                return
            try:
                data = llm_evals.get_split(int(seed), int(stmt))
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return
            self._send_json(json.dumps(data).encode("utf-8"))
        elif parsed.path in ("/api/llm-evals/model", "/api/llm-evals/statement", "/api/llm-evals/participant"):
            kind = parsed.path.rsplit("/", 1)[1]
            raw = params.get("id", [""])[0]
            if not raw:
                self._send_error_json(400, "Missing id")
                return
            try:
                if kind == "model":
                    data = llm_evals.get_model(raw)
                elif not raw.isdigit():
                    raise ValueError(f"Invalid id: {raw!r}")
                elif kind == "statement":
                    data = llm_evals.get_statement(int(raw))
                else:
                    data = llm_evals.get_participant(int(raw))
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return
            self._send_json(json.dumps(data, ensure_ascii=False).encode("utf-8"))
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
    # Precompute the Home page (the landing page every visitor opens), which
    # also warms the all-time Individual and Statement Scores caches.
    # A failure here must not stop the server; the page retries on first visit.
    import time
    _t0 = time.perf_counter()
    try:
        get_home_summary()
        print(f"Home summary ready ({time.perf_counter() - _t0:.1f}s).")
    except Exception:
        import traceback

        traceback.print_exc()
        print("Home summary warm-up failed; it will be computed on first request.")
    # The LLM study (Home section 5 and the LLM Evaluations panel) reads all
    # 44 models' ratings once; load it now rather than on a visitor's request
    _t0 = time.perf_counter()
    try:
        llm_evals.get_summary()
        print(f"LLM evaluations ready ({time.perf_counter() - _t0:.1f}s).")
    except Exception:
        import traceback

        traceback.print_exc()
        print("LLM evaluations warm-up failed; they will load on first request.")
    httpd = http.server.HTTPServer(("", PORT), Handler)
    print(f"Open http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
