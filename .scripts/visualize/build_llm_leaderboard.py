"""Bootstrap intervals for the LLM Evaluations leaderboard (static/llm.js).

Reads the fixed study snapshot in data/llm_evals/ (written by
extract_llm_evals.py) and writes two files next to it:

    data/llm_evals/leaderboard.csv      one row per model: 95% intervals for its
                                        commonsensicality as a respondent, its
                                        win rate against participants, its rank,
                                        and the same for its population's
                                        correlation (r) with participants
    data/llm_evals/human_reference.csv  the participants' 10th, 25th, 50th, 75th
                                        and 90th percentile commonsensicality,
                                        with 95% intervals
    data/llm_evals/features.csv         for the participants and each model's
                                        population, the gap in statement
                                        commonsensicality between the two sides
                                        of each of the six statement features
                                        (the paper's Fig. 3C), with intervals

Point estimates are the published ones (models.csv), computed from the
answers: statement scores come from each model's P(yes) and, for the
participants, from their ratings, as llm_evals.py computes them, rather than
from statement_scores.csv's 4 decimals; only the intervals are new. Every statement's majority answer is held fixed.
A model's commonsensicality, its population's r and both ranks resample the
4,407 statements; the participants' percentiles and each model's win rate
(the share of participants it beats on their own 50 statements) resample the
2,046 participants. So the intervals cover which statements and which people
happened to be sampled, not noise in the majority itself: resampling raters
inside each statement would also move the majority, but it biases every
majority-based score downward, so it is left out.

A model's answer counts as yes when its P(yes) >= 0.5, as in the study. The
snapshot's model_ratings/*.csv round P(yes) to 4 decimals (the study website
does), which turns values just under 0.5 into 0.5 and flips them to yes (this
matters for Mistral-7B: about 2 points of consensus), and misprints about 1 in
35 of them when the panel shows them to 0.1 points (51.85% for 51.8544%, shown
as 51.8%). Pass --ratings-dir with the study repo's unrounded ratings
(open-llm-commonsense-eval/data/model_ratings, one <model>/ratings.csv per
model) to work from those; --fix-rounding then also rewrites the snapshot's
P(yes) with them, to 10 decimals, which the panel then shows correctly to the
last digit. Rerun this after every extract_llm_evals.py run.

Needs numpy and pandas (offline only; the server never imports this):
    python .scripts/visualize/build_llm_leaderboard.py \
        --ratings-dir ../open-llm-commonsense-eval/data/model_ratings --fix-rounding
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
DATA = BASE_DIR / "data" / "llm_evals"
QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]


def _p(v: float) -> str:
    """A P(yes) to 10 decimals ("0.68" for 0.6799999999999999), or in full
    should that rounding move it to the other side of 0.5."""
    s = f"{v:.10f}".rstrip("0")
    s = s + "0" if s.endswith(".") else s
    return s if (float(s) >= 0.5) == (v >= 0.5) else repr(float(v))


def fix_rounding(path: Path, snap: pd.DataFrame, src: pd.DataFrame, mid: str) -> None:
    """Rewrite the snapshot's P(yes) with the study's unrounded values (to 10
    decimals), keeping its rows, header and line endings."""
    raw = path.read_bytes().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    assert raw.split(eol)[0].split(",") == ["statement_id", "I_agree", "others_agree"], path
    assert (np.abs(snap[["I_agree", "others_agree"]].values - src[["I_agree", "others_agree"]].values) <= 1.5e-4).all(), mid
    flips = int(((snap.I_agree.values >= 0.5) != (src.I_agree.values >= 0.5)).sum()
                + ((snap.others_agree.values >= 0.5) != (src.others_agree.values >= 0.5)).sum())
    lines = ["statement_id,I_agree,others_agree"] + [
        f"{sid},{_p(a)},{_p(b)}" for sid, a, b in zip(snap.statement_id.values, src.I_agree.values, src.others_agree.values)]
    out = eol.join(lines) + (eol if raw.endswith(eol) else "")
    if out.encode("utf-8") != raw.encode("utf-8"):
        path.write_bytes(out.encode("utf-8"))
        print(f"{mid}: P(yes) rewritten unrounded" + (f" ({flips} of them rounded across 0.5)" if flips else ""))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--ratings-dir", type=Path, help="the study's unrounded model_ratings directory")
    ap.add_argument("--fix-rounding", action="store_true", help="rewrite rounded-up 0.5 values in the snapshot (needs --ratings-dir)")
    ap.add_argument("-B", type=int, default=1000, help="bootstrap samples (default 1000)")
    ap.add_argument("--seed", type=int, default=20261020)
    args = ap.parse_args()
    if args.fix_rounding and not args.ratings_dir:
        ap.error("--fix-rounding needs --ratings-dir")

    models = pd.read_csv(DATA / "models.csv")
    statements = pd.read_csv(DATA / "statements.csv")
    ratings = pd.read_csv(DATA / "participant_ratings.csv").sort_values(["participant_id", "statement_id"])
    scores = pd.read_csv(DATA / "statement_scores.csv")
    S, K = len(statements), len(models)
    pids = np.sort(ratings.participant_id.unique())
    P = len(pids)
    assert (pids == np.arange(P)).all(), "participant ids must be 0..P-1"

    # Majority answer per statement, fixed throughout (ties count as agree)
    maj = (statements.I_agree_mean.values >= 0.5).astype(int)
    sid = ratings.statement_id.values
    pid = ratings.participant_id.values
    starts = np.r_[0, np.flatnonzero(np.diff(pid)) + 1]  # first rating of each participant
    p_con = (ratings.I_agree.values == maj[sid]).astype(float)
    p_awa = (ratings.others_agree.values == maj[sid]).astype(float)

    # Each model's yes/no answers
    yes_ia, yes_oa = np.zeros((K, S), int), np.zeros((K, S), int)
    p1, p2 = np.zeros((K, S)), np.zeros((K, S))
    for k, mid in enumerate(models.model_id):
        snap_path = DATA / "model_ratings" / f"{mid}.csv"
        snap = pd.read_csv(snap_path)
        src = pd.read_csv(args.ratings_dir / mid / "ratings.csv") if args.ratings_dir else snap
        src = src.set_index("statement_id").loc[snap.statement_id.values]
        yes_ia[k] = (src.I_agree.values >= 0.5).astype(int)
        yes_oa[k] = (src.others_agree.values >= 0.5).astype(int)
        if args.fix_rounding:
            fix_rounding(snap_path, snap, src, mid)
        p1[k], p2[k] = src.I_agree.values, src.others_agree.values
    m_con = (yes_ia == maj).astype(float)  # K x S
    m_awa = (yes_oa == maj).astype(float)
    # The model's answers on each participant's own statements (K x ratings)
    mr_con, mr_awa = m_con[:, sid], m_awa[:, sid]

    # Statement scores, as llm_evals.py computes them: each model's population
    # from its P(yes) (K x S), the participants from their answers
    def crowd(p: np.ndarray, q: np.ndarray) -> np.ndarray:
        return np.sqrt(2 * np.abs(p - 0.5) * np.where(p >= 0.5, q, 1 - q))

    G = crowd(p1, p2)
    n_r = np.bincount(sid, minlength=S)
    H = crowd(np.bincount(sid, weights=ratings.I_agree.values, minlength=S) / n_r,
              np.bincount(sid, weights=ratings.others_agree.values, minlength=S) / n_r)
    published = np.vstack([scores.humans.values, *(scores[mid].values for mid in models.model_id)])
    print(f"max gap to statement_scores.csv: {np.abs(np.vstack([H, G]) - published).max():.4f}")

    # Per-participant scores on their own 50 statements, for people and for each
    # model on the same statements. Fixed: only which participants are drawn varies.
    den = np.add.reduceat(np.ones(len(sid)), starts)
    h_cs = np.sqrt(np.add.reduceat(p_con, starts) / den * np.add.reduceat(p_awa, starts) / den)
    mk_cs = np.sqrt(np.add.reduceat(mr_con, starts, axis=1) / den * np.add.reduceat(mr_awa, starts, axis=1) / den)
    # A win is a strictly higher score, as in the study; ties (frequent on 50
    # statements) are not wins, and 1e-9 keeps float noise from making them so
    beats = (mk_cs > h_cs + 1e-9).astype(float)  # K x P

    def by_statements(v: np.ndarray) -> dict:
        """Statistics that resample statements (weights v)."""
        cs = np.sqrt((m_con @ v / v.sum()) * (m_awa @ v / v.sum()))
        vw = v / v.sum()
        gm, hm = G @ vw, H @ vw
        cov = ((G - gm[:, None]) * (H - hm) * vw).sum(1)
        r = cov / np.sqrt(((G - gm[:, None]) ** 2 * vw).sum(1) * ((H - hm) ** 2 * vw).sum())
        return {"cs": cs, "r": r}

    def by_participants(w: np.ndarray) -> dict:
        """Statistics that resample participants (weights w). Resampling
        statements here would shrink each person's item count and spread
        their scores out, biasing the percentiles and win rates."""
        return {"wins": beats @ w / w.sum(), "quant": np.quantile(np.repeat(h_cs, w.astype(int)), QUANTILES)}

    point = {**by_statements(np.ones(S)), **by_participants(np.ones(P))}
    # The published numbers must come back before any interval is trusted
    gap_cs = np.abs(point["cs"] - models.commonsensicality.values).max()
    gap_wins = np.abs(point["wins"] - models.human_percentile.values).max()
    print(f"max gap to models.csv: commonsensicality {gap_cs:.4f}, win rate {gap_wins:.4f}")
    if gap_cs > 0.001 or gap_wins > 0.002:
        print("WARNING: point estimates differ from models.csv; pass --ratings-dir with the unrounded ratings")

    rng = np.random.default_rng(args.seed)
    draws = {key: [] for key in point}
    for _ in range(args.B):
        v = rng.multinomial(S, np.full(S, 1 / S)).astype(float)
        w = rng.multinomial(P, np.full(P, 1 / P)).astype(float)
        for key, val in {**by_statements(v), **by_participants(w)}.items():
            draws[key].append(val)
    draws = {key: np.array(val) for key, val in draws.items()}

    def ranks(x: np.ndarray) -> np.ndarray:  # 1 = highest, per row
        return (-x).argsort(-1).argsort(-1) + 1

    def interval(x: np.ndarray, integer: bool = False):
        if integer:
            return np.percentile(x, 2.5, axis=0, method="lower"), np.percentile(x, 97.5, axis=0, method="higher")
        return np.percentile(x, 2.5, axis=0), np.percentile(x, 97.5, axis=0)

    cs_lo, cs_hi = interval(draws["cs"])
    w_lo, w_hi = interval(draws["wins"])
    rk_lo, rk_hi = interval(ranks(draws["cs"]), integer=True)
    r_lo, r_hi = interval(draws["r"])
    rr_lo, rr_hi = interval(ranks(draws["r"]), integer=True)
    out = pd.DataFrame({
        "model_id": models.model_id,
        "rank": ranks(models.commonsensicality.values),
        "rank_lo": rk_lo.astype(int), "rank_hi": rk_hi.astype(int),
        "commonsensicality_lo": cs_lo.round(4), "commonsensicality_hi": cs_hi.round(4),
        "win_rate_lo": w_lo.round(4), "win_rate_hi": w_hi.round(4),
        "r": point["r"].round(4), "r_lo": r_lo.round(4), "r_hi": r_hi.round(4),
        "r_rank": ranks(point["r"]), "r_rank_lo": rr_lo.astype(int), "r_rank_hi": rr_hi.astype(int),
    })
    out.to_csv(DATA / "leaderboard.csv", index=False)

    q_lo, q_hi = interval(draws["quant"])
    human = pd.DataFrame({
        "percentile": [int(q * 100) for q in QUANTILES],
        "commonsensicality": np.quantile(h_cs, QUANTILES).round(6),
        "lo": q_lo.round(4), "hi": q_hi.round(4),
    })
    human.to_csv(DATA / "human_reference.csv", index=False)
    print(f"wrote {DATA / 'leaderboard.csv'} and {DATA / 'human_reference.csv'} from {args.B} bootstrap samples")
    write_features(statements, {"humans": H, **dict(zip(models.model_id, G))}, models, args.B, args.seed)


# The six statement features (statements.csv columns), each split into its
# first side (1) and second side (0), as in the paper's Fig. 3C
FEATURES = ["fact", "physical", "literal_language", "positive", "knowledge", "everyday"]


def write_features(statements: pd.DataFrame, scores: dict, models: pd.DataFrame, B: int, seed: int) -> None:
    """data/llm_evals/features.csv: for the participants ("humans") and every
    model's simulated population, the mean statement commonsensicality of a
    feature's first side minus its second (e.g. facts minus opinions), with a
    95% interval from B bootstrap resamples of the statements. The point
    estimate is the difference on all statements; the paper reports bootstrap
    means, which differ from it by a few hundredths of a point. Six decimals,
    so that the panel's 0.1 points are the point estimate's own rounding."""
    rng = np.random.default_rng(seed)
    S = len(statements)
    idx = rng.integers(0, S, size=(B, S))
    rows = []
    for subject in ["humans", *models.model_id]:
        vals = scores[subject]
        v = vals[idx]
        for feat in FEATURES:
            flag = statements[feat].values.astype(float)
            f = flag[idx]
            point = vals[flag == 1].mean() - vals[flag == 0].mean()
            boot = (v * f).sum(1) / f.sum(1) - (v * (1 - f)).sum(1) / (1 - f).sum(1)
            lo, hi = np.percentile(boot, [2.5, 97.5])
            rows.append({"subject": subject, "feature": feat, "diff": round(point, 6), "lo": round(lo, 6), "hi": round(hi, 6),
                         "n1": int(flag.sum()), "n0": int(S - flag.sum())})
    pd.DataFrame(rows).to_csv(DATA / "features.csv", index=False)
    print(f"wrote {DATA / 'features.csv'} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
