"""LLM commonsense evaluations from Nguyen, Watts & Whiting (2026), PNAS Nexus.

Backs the "LLM Evaluations" panel (/llm_evaluations) and the Home page's LLM
section. Reads data/llm_evals/ (DATA_DIR/llm_evals), a fixed snapshot written
by extract_llm_evals.py from the study's website; see that script for the
files. It is a separate study from the live survey: its participants,
statements and ratings are not in answers.csv, and the date filter doesn't
apply.

Scores are 0-1, as in utils.py. Each model answered the survey's two questions
for every statement with a probability of "yes", and was scored two ways:

- as an individual respondent: its answer counts as yes at 50% or more, and it
  gets a participant's consensus, awareness and commonsensicality against the
  participants' majority (models.csv; human_percentile is the share of
  participants it beats on each participant's own 50 statements). The panel
  recomputes all four exactly from the ratings, which match models.csv; only
  models.csv's 4-decimal rounding differs.
- as a simulated population: its probabilities stand for the share of a
  population answering yes, which gives each statement a commonsensicality
  score. "r" is the Pearson correlation of those scores with the participants'
  scores across statements.

All of these, the participants' scores and every statement's scores are
computed here from the answers (participant_ratings.csv and model_ratings/),
not read from the snapshot's 4-decimal summaries (models.csv,
statement_scores.csv, participants.csv), which only check them: a value
rounded to 4 decimals and then shown to 0.1 points is misprinted about 1 time
in 20. The models' P(yes) are unrounded once build_llm_leaderboard.py
--fix-rounding has rewritten them from the study's repo.

Everything the panel's step-by-step stories show is computed here from those
files: each model's yes/no counts and their cross-tab with the majority, its
scores on each statement feature, how sure its probabilities are, the gap to
the participants' statement scores, (per model, on request) its score on each
participant's own statements, and the participants' split-half benchmark
(get_split(): the participants split at random into two halves, each half
scoring every statement as its own crowd, and the two lists correlated, over
SPLITS seeded splits). Optional extras: model_meta.csv (hand-curated:
developer, open or proprietary, release month, whether the model is in the
paper (kept for reference; nothing reads it), the parameter count and family of the
models in the size analysis (the paper's 23, and Gemma 4 26B and 31B; see
SIZE_FIT), and how P(yes) was obtained), leaderboard.csv and
human_reference.csv (bootstrap intervals) and features.csv (the paper's
Fig. 3C feature gaps), the last three written by build_llm_leaderboard.py.
Without them the panel still loads; it just shows less. PAPER holds the
published figures the panel quotes but cannot recompute from this snapshot.
"""
import csv
import math
import os
import re
import statistics

import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data")), "llm_evals")
PROP_COLS = ["fact", "physical", "literal_language", "positive", "knowledge", "everyday"]
HIST_BINS = 10   # P(yes) histograms: 0-10%, ..., 90-100%
SURE = 0.05      # "sure": P(yes) at most 5% or at least 95%
SPLITS = 1000    # random splits of the participants into halves, as in the paper
DP = 10          # decimals of the scores and shares sent to the page: enough that
                 # rounding them again to 0.1 points never changes a digit

_cache = None

# Published figures quoted by the panel (Nguyen, Watts & Whiting 2026, PNAS
# Nexus 5(3): pgag029, main text and SI). Everything else is computed from the
# snapshot. The panel presents all 44 models as one set: every figure it
# computes (ranks, averages, the Bonferroni correction, the ensemble R²) is
# over all of them, not only the 35 in the paper.
PAPER = {
    "n_recruited": 2141,            # MTurk participants recruited; 2,046 kept
    "fielded": "2–14 September 2022",
    "age_mean": 44.25,
    "female_pct": 51.22,
    "temperature": 1.0,
    "split_half_r": 0.60,           # two random halves of the participants, statement scores
    "split_half_lo": 0.58,          # (get_split() recomputes all three from the ratings)
    "split_half_hi": 0.61,
    "size_beta": 8.6,               # points per tenfold parameters, mixed-effects
    "size_p": 0.002,
    "size_lo": 3.4,
    "size_hi": 13.4,
    "size_n": 23,
    "size_families": 6,
    "doi": "10.1093/pnasnexus/pgag029",
}

# The size regression over the models model_meta.csv gives a size and a
# family, which the panel's "Model size" chart shows: the paper's mixed model
# refitted (commonsensicality in points on log10 of the parameter count, a
# random intercept per family; the REML slope and a profile-likelihood 95%
# interval, with statsmodels 0.15). On the paper's 23 models it gives the
# published 8.6 (3.4 to 13.4); on these 25, which add Gemma 4 26B and 31B to
# the Gemma family, 8.4 (3.6 to 12.9). get_summary() sends it only while
# model_meta.csv sizes exactly these models; otherwise the panel quotes the
# paper's figure as the paper's. Refit it when the sized models change.
SIZE_FIT = {
    "beta": 8.4, "lo": 3.6, "hi": 12.9, "families": 6,
    "ids": [
        "Qwen--Qwen2-0.5B-Instruct", "Qwen--Qwen2-1.5B-Instruct", "Qwen--Qwen2-7B-Instruct",
        "Qwen--Qwen2-57B-A14B-Instruct", "Qwen--Qwen2-72B-Instruct",
        "google--flan-t5-small", "google--flan-t5-base", "google--flan-t5-large", "google--flan-t5-xl", "google--flan-t5-xxl",
        "google--gemma-2b-it", "google--gemma-7b-it", "google--gemma-4-26b-a4b-it", "google--gemma-4-31b-it",
        "meta-llama--Llama-2-7b-chat-hf", "meta-llama--Llama-2-13b-chat-hf", "meta-llama--Llama-2-70b-chat-hf",
        "meta-llama--Meta-Llama-3-8B-Instruct", "meta-llama--Meta-Llama-3-70B-Instruct",
        "mistralai--Mistral-7B-Instruct-v0.2", "mistralai--Mixtral-8x7B-Instruct-v0.1", "mistralai--Mixtral-8x22B-Instruct-v0.1",
        "tiiuae--falcon-7b-instruct", "tiiuae--falcon-40b-instruct", "tiiuae--falcon-180B-chat",
    ],
}

# Statements written around stand-in names ("If max helps sam then ..."),
# nearly all from ATOMIC and the situation prompts: 1,448 of 4,407. The
# stories never pick them as examples, and start the head-to-head with a
# person who rated as few of them as anyone (6 of 50; nobody rated none).
PLACEHOLDER = re.compile(r"\b(?:alex|sam|max|jake|john|mary)\b", re.IGNORECASE)

# The statements the paper works through (Figs. 2A and 3A)
EXAMPLE_INDIVIDUAL = "Eighty percent of success is showing up."
EXAMPLE_POPULATION = "Experience is imperative to run a country."


def _read(name: str) -> list[dict]:
    with open(os.path.join(DATA_DIR, name), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _read_optional(name: str) -> list[dict]:
    return _read(name) if os.path.exists(os.path.join(DATA_DIR, name)) else []


def _num(v: str | None) -> float | None:
    return float(v) if v not in (None, "") else None


def _pearson(x: list[float], y: list[float]) -> float | None:
    n = len(x)
    if n < 2:
        return None
    mx, my = sum(x) / n, sum(y) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(x, y))
    vx = sum((a - mx) ** 2 for a in x)
    vy = sum((b - my) ** 2 for b in y)
    return cov / math.sqrt(vx * vy) if vx and vy else None


def _p_two_sided(r: float, n: int) -> float:
    """Two-sided p of a Pearson r on n pairs. Uses the normal tail of
    t = r * sqrt((n - 2) / (1 - r^2)), which for n in the thousands matches the
    t distribution to well under any reported precision."""
    if abs(r) >= 1:
        return 0.0
    t = abs(r) * math.sqrt((n - 2) / (1 - r * r))
    return math.erfc(t / math.sqrt(2))


def _hist(values: list[float]) -> list[int]:
    counts = [0] * HIST_BINS
    for v in values:
        counts[min(HIST_BINS - 1, int(v * HIST_BINS))] += 1
    return counts


def _individual(yes1: list[int], yes2: list[int], maj: list[int], keep=None) -> dict:
    """A respondent's counts against the majority: the cross-tab of each answer
    with the majority ([[yes & maj yes, yes & maj no], [no & maj yes, no & maj
    no]]) and the resulting consensus, awareness and commonsensicality, over the
    statements whose index passes keep (all by default)."""
    tab = {1: [[0, 0], [0, 0]], 2: [[0, 0], [0, 0]]}
    n = 0
    for i, mj in enumerate(maj):
        if keep is not None and not keep(i):
            continue
        n += 1
        tab[1][1 - yes1[i]][1 - mj] += 1
        tab[2][1 - yes2[i]][1 - mj] += 1
    con = (tab[1][0][0] + tab[1][1][1]) / n if n else None
    awa = (tab[2][0][0] + tab[2][1][1]) / n if n else None
    return {
        "n": n,
        "q1": tab[1],
        "q2": tab[2],
        "consensus": con,
        "awareness": awa,
        "commonsensicality": math.sqrt(con * awa) if n else None,
    }


def _crowd_scores(sid: np.ndarray, ia: np.ndarray, oa: np.ndarray, w: np.ndarray, n_stmts: int):
    """Each statement's commonsensicality in a crowd of raters, as in utils.py:
    the ratings kept are those with weight 1 in w. Returns the scores (NaN for
    a statement with no rater in the crowd) and each statement's rater count."""
    k = np.bincount(sid, weights=w, minlength=n_stmts)
    agree = np.bincount(sid, weights=w * ia, minlength=n_stmts)
    others = np.bincount(sid, weights=w * oa, minlength=n_stmts)
    with np.errstate(invalid="ignore", divide="ignore"):
        pa, po = agree / k, others / k
        # ties (half agree) count as a majority that agrees, as everywhere else
        score = np.sqrt(2 * np.abs(pa - 0.5) * np.where(pa >= 0.5, po, 1 - po))
    return score, k


def _half(seed: int, n_people: int) -> np.ndarray:
    """Split seed's half A: a random half of the participants (by index)."""
    perm = np.random.default_rng(seed).permutation(n_people)
    half = np.zeros(n_people, dtype=bool)
    half[perm[: n_people // 2]] = True
    return half


def _split_scores(sp: dict, seed: int):
    """Both halves' statement scores for one split, which statements both
    halves rated, and the Pearson r between the halves over those."""
    in_a = _half(seed, sp["n_people"])[sp["person"]].astype(float)
    a, ka = _crowd_scores(sp["sid"], sp["ia"], sp["oa"], in_a, sp["n_stmts"])
    b, kb = _crowd_scores(sp["sid"], sp["ia"], sp["oa"], 1 - in_a, sp["n_stmts"])
    ok = (ka > 0) & (kb > 0)
    return a, b, ok, float(np.corrcoef(a[ok], b[ok])[0, 1])


# Out-of-sample R² of people's statement scores regressed on model crowds'
# scores, as the paper's notebook computes it (GroupCommonSense.ipynb: OLS with
# an intercept, sklearn's KFold(n_splits=50, shuffle=True, random_state=100),
# the mean of the 50 folds' R²). With the paper's 35 models this reproduces
# its 0.361; ENSEMBLE_SINGLE are the single crowds its Fig. 4B shows.
ENSEMBLE_FOLDS, ENSEMBLE_SEED = 50, 100
ENSEMBLE_SINGLE = ["tiiuae--falcon-180B-chat", "google--flan-t5-xxl", "gemini-pro", "claude-3-opus", "gpt-4o-2024-05-13"]


def _oos_r2(y: np.ndarray, xs: list) -> float:
    n = len(y)
    X = np.column_stack([np.ones(n)] + xs)
    order = np.arange(n)
    np.random.RandomState(ENSEMBLE_SEED).shuffle(order)        # as sklearn's KFold shuffles
    sizes = np.full(ENSEMBLE_FOLDS, n // ENSEMBLE_FOLDS)
    sizes[: n % ENSEMBLE_FOLDS] += 1
    r2s, start = [], 0
    for size in sizes:
        test = order[start:start + size]
        start += size
        train = np.ones(n, dtype=bool)
        train[test] = False
        beta = np.linalg.lstsq(X[train], y[train], rcond=None)[0]
        resid = y[test] - X[test] @ beta
        r2s.append(1 - (resid ** 2).sum() / ((y[test] - y[test].mean()) ** 2).sum())
    return float(np.mean(r2s))


def _load() -> dict:
    models = [
        {
            "id": row["model_id"],
            "name": row["model"],
            "consensus": float(row["consensus"]),
            "awareness": float(row["awareness"]),
            "commonsensicality": float(row["commonsensicality"]),
            "human_percentile": float(row["human_percentile"]),
        }
        for row in _read("models.csv")
    ]
    statement_rows = _read("statements.csv")
    n_stmts = len(statement_rows)
    props = [[int(row[col]) for col in PROP_COLS] for row in statement_rows]

    # Every participant's answers, and each statement's raters and yes counts:
    # everything about people below is computed exactly from these
    participant_ratings = {}
    n_raters = [0] * n_stmts
    k_agree = [0] * n_stmts
    k_others = [0] * n_stmts
    for row in _read("participant_ratings.csv"):
        sid, ia, oa = int(row["statement_id"]), int(row["I_agree"]), int(row["others_agree"])
        participant_ratings.setdefault(int(row["participant_id"]), []).append([sid, ia, oa])
        n_raters[sid] += 1
        k_agree[sid] += ia
        k_others[sid] += oa
    maj = [1 if 2 * k_agree[i] >= n_raters[i] else 0 for i in range(n_stmts)]  # ties count as agree
    if any(mj != (float(row["I_agree_mean"]) >= 0.5) for mj, row in zip(maj, statement_rows)):
        print("llm_evals: a statement's majority differs from statements.csv")

    # Each model's P(yes) to both questions, and its yes/no answers
    ratings = {}
    for m in models:
        rows = _read(os.path.join("model_ratings", f"{m['id']}.csv"))
        assert len(rows) == n_stmts, m["id"]
        ratings[m["id"]] = [[float(row["I_agree"]), float(row["others_agree"])] for row in rows]

    # Each statement's commonsensicality among the participants and in each
    # model's population, computed here rather than read from
    # statement_scores.csv, whose 4 decimals misprint about 1 in 20 of them at
    # the panel's 0.1 points (that file only checks these). The models' come
    # from their P(yes), which build_llm_leaderboard.py --fix-rounding writes
    # unrounded; from the website's 4-decimal P(yes) a score near 0 can be a
    # point off, and the check below says so.
    def crowd(p: float, q: float) -> float:  # shares answering yes to the two questions
        return math.sqrt(2 * abs(p - 0.5) * (q if p >= 0.5 else 1 - q))

    scores = {"humans": [crowd(k_agree[i] / n_raters[i], k_others[i] / n_raters[i]) for i in range(n_stmts)]}
    for m in models:
        scores[m["id"]] = [crowd(p1, p2) for p1, p2 in ratings[m["id"]]]
    gap = max(abs(float(row[col]) - scores[col][int(row["statement_id"])])
              for row in _read("statement_scores.csv") for col in scores)
    if gap > 0.001:
        print(f"llm_evals: statement scores differ from statement_scores.csv by up to {gap:.4f}; "
              "rerun build_llm_leaderboard.py with --ratings-dir and --fix-rounding")
    models_yes1 = [0] * n_stmts
    models_yes2 = [0] * n_stmts

    meta = {row["model_id"]: row for row in _read_optional("model_meta.csv")}
    board = {row["model_id"]: row for row in _read_optional("leaderboard.csv")}
    features = {}
    for row in _read_optional("features.csv"):
        features.setdefault(row["subject"], {})[row["feature"]] = [
            float(row["diff"]), _num(row["lo"]), _num(row["hi"])]

    humans = scores["humans"]
    for m in models:
        mid = m["id"]
        r = _pearson(scores[mid], humans)
        m["r"] = round(r, DP) if r is not None else None
        p = _p_two_sided(r, n_stmts) if r is not None else None
        m["r_p"] = p
        # Bonferroni-corrected for one test per model, as the paper corrects
        # for its own number of models
        m["r_sig"] = p is not None and min(1.0, p * len(models)) < 0.05
        m["mae"] = round(sum(abs(a - b) for a, b in zip(scores[mid], humans)) / n_stmts, DP)

        p1 = [pair[0] for pair in ratings[mid]]
        p2 = [pair[1] for pair in ratings[mid]]
        yes1 = [1 if v >= 0.5 else 0 for v in p1]
        yes2 = [1 if v >= 0.5 else 0 for v in p2]
        for i in range(n_stmts):
            models_yes1[i] += yes1[i]
            models_yes2[i] += yes2[i]
        ind = _individual(yes1, yes2, maj)
        # Exact values from the counts: models.csv rounds to 4 decimals, which
        # can round a percentage the wrong way (Claude 3 Sonnet: 61.5466%
        # stored as 0.6155, then shown as 61.6%)
        for key in ("consensus", "awareness", "commonsensicality"):
            if abs(ind[key] - m[key]) > 0.0006:
                print(f"llm_evals: {mid} {key} {ind[key]:.4f} differs from models.csv {m[key]}")
            m[key] = round(ind[key], DP)
        m["tab"] = {"q1": ind["q1"], "q2": ind["q2"]}
        m["n_yes"] = [sum(yes1), sum(yes2)]
        m["n_diverge"] = sum(1 for a, b in zip(yes1, yes2) if a != b)
        m["hist"] = [_hist(p1), _hist(p2)]
        m["n_sure"] = sum(1 for v in p1 if v <= SURE or v >= 1 - SURE)
        # P(yes) of exactly 50% (a tie, which counts as yes) and within 0.1
        # points of it, which usually means the reply began with neither yes
        # nor no: the study splits that probability evenly between the two
        m["n_tie"] = [sum(1 for v in p1 if v == 0.5), sum(1 for v in p2 if v == 0.5)]
        m["n_half"] = [sum(1 for v in p1 if abs(v - 0.5) < 0.001), sum(1 for v in p2 if abs(v - 0.5) < 0.001)]
        # Scored only on the statements with each side of each feature
        m["by_feature"] = {
            col: [
                round(_individual(yes1, yes2, maj, keep=lambda i, j=j, side=side: props[i][j] == side)["commonsensicality"], DP)
                for side in (1, 0)
            ]
            for j, col in enumerate(PROP_COLS)
        }

        row = meta.get(mid, {})
        m["organization"] = row.get("organization") or None
        m["access"] = row.get("access") or None          # "open" or "proprietary"
        m["released"] = row.get("released") or None      # YYYY-MM
        m["params_b"] = _num(row.get("params_b"))        # billions; the size analysis's (SIZE_FIT)
        m["size_family"] = row.get("size_family") or None
        m["method"] = row.get("method") or None          # "probabilities" or "sampling"
        m["note"] = row.get("note") or None
        b = board.get(mid)
        m["ci"] = {
            "cs": [_num(b["commonsensicality_lo"]), _num(b["commonsensicality_hi"])],
            "rank": [int(b["rank_lo"]), int(b["rank_hi"])],
            "win": [_num(b["win_rate_lo"]), _num(b["win_rate_hi"])],
            "r": [_num(b["r_lo"]), _num(b["r_hi"])],
            "r_rank": [int(b["r_rank_lo"]), int(b["r_rank_hi"])],
        } if b else None
        m["features"] = [features[mid][col] for col in PROP_COLS] if mid in features else None
    human_reference = [
        {"percentile": int(row["percentile"]), "commonsensicality": float(row["commonsensicality"]),
         "ci": [_num(row["lo"]), _num(row["hi"])]}
        for row in _read_optional("human_reference.csv")
    ]

    # Each participant's matches with the majority on their own statements, and
    # their scores from them (participants.csv rounds those to 4 decimals and
    # only checks them)
    person_counts = {
        pid: (sum(1 for sid, ia, _ in rs if ia == maj[sid]), sum(1 for sid, _, oa in rs if oa == maj[sid]), len(rs))
        for pid, rs in participant_ratings.items()
    }
    participants = [[pid, pc / n, pa / n, math.sqrt(pc * pa) / n] for pid, (pc, pa, n) in sorted(person_counts.items())]
    published = {int(row["participant_id"]): float(row["commonsensicality"]) for row in _read("participants.csv")}
    if any(abs(published.get(p[0], -1) - p[3]) > 0.0001 for p in participants):
        print("llm_evals: participant scores differ from participants.csv")
    # The split-half benchmark: every rating as arrays, and r for each of the
    # SPLITS seeded splits of the participants into two halves (about 1 s)
    index = {pid: i for i, (pid, _, _, _) in enumerate(participants)}
    flat = [(index[pid], sid, ia, oa) for pid, rs in participant_ratings.items() for sid, ia, oa in rs]
    person, sid_arr, ia_arr, oa_arr = (np.array(col) for col in zip(*flat))
    split = {"n_people": len(participants), "n_stmts": n_stmts, "person": person, "sid": sid_arr,
             "ia": ia_arr.astype(float), "oa": oa_arr.astype(float), "ids": [p[0] for p in participants]}
    split_rs = np.array([_split_scores(split, seed)[3] for seed in range(SPLITS)])
    split["rs"] = split_rs
    lo, hi = np.percentile(split_rs, [2.5, 97.5])
    split_summary = {"n_splits": SPLITS, "n_half": len(participants) // 2, "mean": round(float(split_rs.mean()), DP),
                     "lo": round(float(lo), DP), "hi": round(float(hi), DP),
                     "rs": [round(float(r), 6) for r in split_rs]}

    # Every model's crowd together, and a few single crowds, as predictors of
    # people's statement scores (out-of-sample R²)
    y = np.array(scores["humans"])
    names = {m["id"]: m["name"] for m in models}
    ensemble = {
        "folds": ENSEMBLE_FOLDS,
        "n_models": len(models),
        "r2": round(_oos_r2(y, [np.array(scores[m["id"]]) for m in models]), DP),
        "single": [[names[mid], round(_oos_r2(y, [np.array(scores[mid])]), DP)] for mid in ENSEMBLE_SINGLE if mid in names],
    }

    # Each model's matches on each participant's own statements: the
    # head-to-heads behind "beats". The comparison uses exact counts (sqrt is
    # monotone and both scores share the same statements), so a tie is never
    # broken by rounding.
    person_sids = [(pid, [sid for sid, _, _ in participant_ratings[pid]]) for pid, _, _, _ in participants]
    head_to_head = {}
    for m in models:
        ok1 = [1 if (pair[0] >= 0.5) == (mj == 1) else 0 for pair, mj in zip(ratings[m["id"]], maj)]
        ok2 = [1 if (pair[1] >= 0.5) == (mj == 1) else 0 for pair, mj in zip(ratings[m["id"]], maj)]
        vs, wins, ties = [], 0, 0
        for pid, sids in person_sids:
            kc, ka = sum(ok1[s] for s in sids), sum(ok2[s] for s in sids)
            pc, pa, n = person_counts[pid]
            vs.append(round(math.sqrt(kc * ka) / n, 4))
            wins += kc * ka > pc * pa
            ties += kc * ka == pc * pa
        head_to_head[m["id"]] = vs
        m["head"] = {"wins": wins, "ties": ties, "losses": len(vs) - wins - ties}
        if abs(wins / len(vs) - m["human_percentile"]) > 1.5 / len(vs):
            print(f"llm_evals: {m['id']} beats {wins / len(vs):.4f} differs from models.csv {m['human_percentile']}")
        m["human_percentile"] = round(wins / len(vs), DP)

    statements = []
    for i, row in enumerate(statement_rows):
        statements.append({
            "id": int(row["statement_id"]),
            "text": row["statement"],
            "source": row["source"],
            "category": row["category"],
            "props": props[i],
            "I_agree": round(k_agree[i] / n_raters[i], DP),
            "others_agree": round(k_others[i] / n_raters[i], DP),
            "humans": round(humans[i], DP),
            "llm_median": round(statistics.median(scores[m["id"]][i] for m in models), DP),
            "n": n_raters[i],
            "k_agree": k_agree[i],
            "k_others": k_others[i],
            "models_yes": [models_yes1[i], models_yes2[i]],
            "placeholder": int(bool(PLACEHOLDER.search(row["statement"]))),
        })
    by_text = {s["text"]: s["id"] for s in statements}
    # SIZE_FIT holds for exactly the models model_meta.csv sizes
    sized = sorted(m["id"] for m in models if m["params_b"] and m["size_family"])
    size_fit = None
    if sized == sorted(SIZE_FIT["ids"]):
        size_fit = {k: v for k, v in SIZE_FIT.items() if k != "ids"} | {"n": len(sized)}
    elif sized:
        print(f"llm_evals: model_meta.csv sizes {len(sized)} models, not SIZE_FIT's {len(SIZE_FIT['ids'])}; "
              "the panel quotes the paper's size regression until SIZE_FIT is refitted")
    n_placeholder ={pid: sum(statements[sid]["placeholder"] for sid, _, _ in rs) for pid, rs in participant_ratings.items()}
    share_agree = [s["I_agree"] for s in statements]
    return {
        "models": models,
        "model_ids": {m["id"] for m in models},
        "scores": scores,
        "ratings": ratings,
        "maj": maj,
        "statements": statements,
        "participants": participants,
        "n_placeholder": n_placeholder,
        "participant_ratings": participant_ratings,
        "head_to_head": head_to_head,
        "split": split,
        "split_summary": split_summary,
        "ensemble": ensemble,
        "size_fit": size_fit,
        "human_reference": human_reference,
        "humans": {
            "n_majority_agree": sum(maj),
            "hist": [_hist(share_agree), _hist([s["others_agree"] for s in statements])],
            "n_sure": sum(1 for v in share_agree if v <= SURE or v >= 1 - SURE),
            "features": [features["humans"][col] for col in PROP_COLS] if "humans" in features else None,
            "median_statement": statistics.median(humans),
        },
        "examples": {
            "individual": by_text.get(EXAMPLE_INDIVIDUAL),
            "population": by_text.get(EXAMPLE_POPULATION),
        },
        "model_payloads": {},
    }


def _data() -> dict:
    global _cache
    if _cache is None:
        _cache = _load()
    return _cache


def get_summary() -> dict:
    """Every model's scores in both settings (with its metadata, counts and
    bootstrap intervals when those files exist), the participants' percentiles
    and statement-level summaries, the paper's quoted figures, and every
    participant's scores as [id, consensus, awareness, commonsensicality,
    how many of their 50 statements use a PLACEHOLDER name]."""
    if not os.path.exists(os.path.join(DATA_DIR, "models.csv")):
        return {"models": [], "participants": [], "missing": DATA_DIR}
    d = _data()
    return {
        "n_statements": len(d["statements"]),
        "n_participants": len(d["participants"]),
        "n_ratings": sum(len(r) for r in d["participant_ratings"].values()),
        "properties": PROP_COLS,
        "hist_bins": HIST_BINS,
        "sure": SURE,
        "models": d["models"],
        "human_reference": d["human_reference"],
        "humans": d["humans"],
        "examples": d["examples"],
        "split_half": d["split_summary"],
        "ensemble": d["ensemble"],
        "n_tests": len(d["models"]),   # the Bonferroni correction behind r_sig
        "paper": PAPER,
        "size_fit": d["size_fit"],
        "participants": [[p[0], *(round(v, DP) for v in p[1:]), d["n_placeholder"][p[0]]] for p in d["participants"]],
    }


STATEMENT_FIELDS = ["id", "text", "source", "category", "props", "I_agree", "others_agree", "humans", "llm_median",
                    "n", "k_agree", "k_others", "models_yes", "placeholder"]


def get_statements() -> dict:
    """Every statement as a row of STATEMENT_FIELDS: its properties (PROP_COLS
    order), the share of participants answering yes to each question, its
    commonsensicality among participants ("humans") and the median across the
    models' populations, how many participants rated it and how many of them
    said yes to each question, how many models said yes to each, and whether
    it uses a PLACEHOLDER name (1 or 0). Rows are
    arrays, and source and category indexes into "sources" and "categories",
    which keeps the payload about half the size."""
    d = _data()
    if "statements_payload" not in d:
        statements = d["statements"]
        sources = sorted({s["source"] for s in statements})
        categories = sorted({s["category"] for s in statements})
        src_idx = {v: i for i, v in enumerate(sources)}
        cat_idx = {v: i for i, v in enumerate(categories)}
        d["statements_payload"] = {
            "properties": PROP_COLS,
            "fields": STATEMENT_FIELDS,
            "sources": sources,
            "categories": categories,
            "rows": [
                [s["id"], s["text"], src_idx[s["source"]], cat_idx[s["category"]], s["props"],
                 s["I_agree"], s["others_agree"], s["humans"], s["llm_median"],
                 s["n"], s["k_agree"], s["k_others"], s["models_yes"], s["placeholder"]]
                for s in statements
            ],
        }
    return d["statements_payload"]


def get_model(model_id: str) -> dict:
    """One model's P(yes) to both questions and its population's
    commonsensicality, per statement in statement-id order, and how it fares
    against each participant on that participant's own statements: "vs" holds
    its commonsensicality on each participant's statements (in participant-id
    order) and "head" the participants it beats, ties and trails."""
    d = _data()
    if model_id not in d["model_ids"]:
        raise ValueError(f"Unknown model: {model_id!r}")
    if model_id not in d["model_payloads"]:
        m = next(x for x in d["models"] if x["id"] == model_id)
        d["model_payloads"][model_id] = {
            "id": model_id,
            "ratings": d["ratings"][model_id],
            "scores": [round(v, DP) for v in d["scores"][model_id]],
            "vs": d["head_to_head"][model_id],
            "head": m["head"],
        }
    return d["model_payloads"][model_id]


def get_statement(statement_id: int) -> dict:
    """One statement's commonsensicality among participants and in each
    model's population, and each model's P(yes) to both questions (in
    get_summary()'s model order)."""
    d = _data()
    if not 0 <= statement_id < len(d["statements"]):
        raise ValueError(f"Unknown statement: {statement_id}")
    return {
        "id": statement_id,
        "humans": round(d["scores"]["humans"][statement_id], DP),
        "scores": [round(d["scores"][m["id"]][statement_id], DP) for m in d["models"]],
        "ratings": [d["ratings"][m["id"]][statement_id] for m in d["models"]],
    }


def get_participant(participant_id: int) -> dict:
    """One participant's answers as [statement_id, I_agree, others_agree]."""
    d = _data()
    if participant_id not in d["participant_ratings"]:
        raise ValueError(f"Unknown participant: {participant_id}")
    return {"id": participant_id, "ratings": d["participant_ratings"][participant_id]}


def get_split(seed: int, statement_id: int) -> dict:
    """One of the SPLITS random splits of the participants into halves A and
    B (seeds 0 to SPLITS - 1, the same splits behind split_half in
    get_summary()): the Pearson r between the two halves' statement scores,
    over the n_used statements both halves rated; every statement's score in
    each half ("scores": two lists in statement-id order, None where a half
    has no rater of it), for the population story's scatter plot; and
    statement_id's raters in each half as [I_agree, others_agree] pairs."""
    d = _data()
    sp = d["split"]
    if not 0 <= seed < SPLITS:
        raise ValueError(f"Unknown split: {seed}")
    if not 0 <= statement_id < sp["n_stmts"]:
        raise ValueError(f"Unknown statement: {statement_id}")
    a, b, ok, r = _split_scores(sp, seed)
    half = _half(seed, sp["n_people"])
    raters = {"a": [], "b": []}
    for i in np.flatnonzero(sp["sid"] == statement_id):
        raters["a" if half[sp["person"][i]] else "b"].append([int(sp["ia"][i]), int(sp["oa"][i])])
    return {
        "seed": seed,
        "r": round(r, DP),
        "n_used": int(ok.sum()),
        "scores": {key: [round(float(v), DP) if not np.isnan(v) else None for v in arr] for key, arr in (("a", a), ("b", b))},
        "example": {"id": statement_id, **raters},
    }
