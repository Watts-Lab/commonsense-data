"""
recover_demo.py

Two-stage matching of survey records for participants where the platform bug
created a distinct userSessionId for each component (answers, CRT, RME, demo)
instead of reusing the same ID throughout the session.

Key insight
-----------
`secondsElapsed` stored in each experimentInfo blob is the *total* elapsed time
from the moment the participant loaded the survey, not just the time spent on
that individual component.  Therefore:

    startAt = createdAt - secondsElapsed

converges to the same timestamp (the session start) across CRT, RME, and demo
records that belong to the same participant.  This shared startAt is the primary
matching signal.

Additionally, the platform accumulates all prior responses into each new
submission:
  RME  experimentInfo  embeds the CRT answers.
  Demo experimentInfo  embeds the CRT + RME answers.
We extract the CRT answer subset as a secondary "fingerprint" signal.

Two-stage pipeline
------------------
Stage 1  Match each Demo record to one CRT record and one RME record using
         the Hungarian algorithm (globally optimal bipartite matching).
         Cost = |startAt difference| in seconds, plus a penalty when non-empty
         fingerprints disagree.  Processing is done in 1-hour windows so that
         cost matrices stay small; a global used-set prevents a record near a
         window boundary from being claimed twice.

Stage 2  Match each (Demo, CRT, RME) triplet to one answer session.
         The CRT startAt is used as the triplet's reference time (it is the
         first individual component, occurring right after the last answer).
         Same Hungarian / windowed approach.

Records whose userSessionId already appears identically in all four sources
(pre-bug / post-bug cohort) are carried over directly without matching.

Output
------
demo_matches/triplet_results_hungarian.csv   – stage-1 results
demo_matches/all_matches_hungarian.csv       – final quintets (answers+CRT+RME+demo)
"""

import json
import os

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment
from tqdm import tqdm

# ─────────────────────────────────────────────────────────────────────────────
# Tuneable parameters
# ─────────────────────────────────────────────────────────────────────────────

THRESHOLD_S = 5.0  # max |startAt| difference (s) to consider a valid match
FP_MISMATCH_COST_S = 5  # extra cost (s) when non-empty fingerprints disagree
LARGE_COST = 1e9  # sentinel for forbidden pairings inside the cost matrix
WINDOW_S = 3600  # processing-window width (s); must satisfy WINDOW_S >> THRESHOLD_S
MIN_ANSWERS = 5  # minimum answers a session must have to be considered

# ─────────────────────────────────────────────────────────────────────────────
# 1.  Load and prepare data
# ─────────────────────────────────────────────────────────────────────────────

print("=" * 80)
print("LOADING DATA\n")


def _read_csvs(base_path):
    files = sorted(f for f in os.listdir(base_path) if f.endswith(".csv"))
    return pd.concat(
        [pd.read_csv(os.path.join(base_path, f)) for f in files],
        ignore_index=True,
    )


# — Answers ——————————————————————————————————————————————————————————————————
print("Loading answers …")
df_answers = _read_csvs("../answers")
df_answers.rename(columns={"sessionId": "userSessionId"}, inplace=True)
df_answers["createdAt"] = pd.to_datetime(df_answers["createdAt"])

# Keep only sessions with enough answers; retain the *last* answer per session.
# The createdAt of the last answer is the best proxy for when the participant
# finished the rating task and moved on to the CRT.
session_counts = df_answers.groupby("userSessionId")["createdAt"].count()
df_answers = df_answers[
    df_answers["userSessionId"].isin(
        session_counts[session_counts >= MIN_ANSWERS].index
    )
]
df_answers_last = (
    df_answers.sort_values("createdAt")
    .drop_duplicates(subset=["userSessionId"], keep="last")
    .set_index("userSessionId")
)
print(f"  Answer sessions (≥{MIN_ANSWERS} answers): {len(df_answers_last):,}")

# — Individuals (CRT / RME / Demo) ————————————————————————————————————————————
print("Loading individuals …")
df_ind = _read_csvs("../individuals")
df_ind["createdAt"] = pd.to_datetime(df_ind["createdAt"])

# Compute startAt = createdAt − secondsElapsed.
# secondsElapsed is cumulative from session start, so startAt ≈ session start
# for every component of the same participant.
df_ind["secondsElapsed"] = df_ind["experimentInfo"].map(
    lambda x: json.loads(x)["secondsElapsed"]
)
df_ind["startAt"] = df_ind["createdAt"] - pd.to_timedelta(
    df_ind["secondsElapsed"], unit="s"
)


def _prep_individuals(df, info_types):
    """Filter to the given informationType(s), deduplicate (keep last per
    session), drop nulls, and index by userSessionId."""
    out = df[df["informationType"].isin(info_types)].copy()
    out.sort_values("createdAt", inplace=True)
    out.drop_duplicates(subset=["userSessionId"], keep="last", inplace=True)
    out.dropna(subset=["userSessionId"], inplace=True)
    out["userSessionId"] = out["userSessionId"].astype(str)
    return out.set_index("userSessionId")


df_crt = _prep_individuals(df_ind, ["CRT"])
df_rme = _prep_individuals(df_ind, ["rmeTen"])
df_demo = _prep_individuals(df_ind, ["demographics", "demographicsLongInternational"])
del df_ind

print(f"  CRT records : {len(df_crt):9,}")
print(f"  RME records : {len(df_rme):9,}")
print(f"  Demo records: {len(df_demo):9,}")

# ─────────────────────────────────────────────────────────────────────────────
# 2.  Sessions already complete (same userSessionId in all four sources)
# ─────────────────────────────────────────────────────────────────────────────

common_ids = (
    set(df_answers_last.index)
    & set(df_crt.index)
    & set(df_rme.index)
    & set(df_demo.index)
)
print(f"\nSessions with matching IDs across all 4 sources: {len(common_ids):,}")

df_crt_rem = df_crt.drop(index=common_ids)
df_rme_rem = df_rme.drop(index=common_ids)
df_demo_rem = df_demo.drop(index=common_ids)
df_ans_rem = df_answers_last.drop(index=common_ids)
print(
    f"Remaining"
    + "\n"
    + f"  CRT    : {len(df_crt_rem):9,}  "
    + "\n"
    + f"  RME    : {len(df_rme_rem):9,}  "
    + "\n"
    + f"  Demo   : {len(df_demo_rem):9,}  "
    + "\n"
    + f"  Answers: {len(df_ans_rem):9,}"
)

# ─────────────────────────────────────────────────────────────────────────────
# 3.  Fingerprint helpers
#
#     The survey platform stores cumulative responses in each submission:
#       CRT record  → contains CRT answers only
#       RME record  → contains CRT answers + RME answers
#       Demo record → contains CRT answers + RME answers + demo answers
#
#     We extract just the CRT answer keys as a frozenset fingerprint.
#     When two records belong to the same participant, their CRT fingerprints
#     must be identical; mismatches add evidence *against* a proposed pairing.
#     Note: fingerprints are NOT globally unique (many participants give the
#     same CRT answers), so they serve as a tiebreaker, not a primary key.
# ─────────────────────────────────────────────────────────────────────────────

CRT_KEYS = frozenset({"drill_hammer", "rachel", "toaster", "apples", "eggs", "dog_cat"})


def _parse_responses(info_str):
    try:
        return json.loads(info_str).get("responses", {})
    except Exception:
        return {}


def _crt_fingerprint(responses):
    subset = {k: v for k, v in responses.items() if k in CRT_KEYS}
    return frozenset(subset.items())


def _build_fps(df):
    return df["experimentInfo"].map(_parse_responses).map(_crt_fingerprint)


crt_fps = _build_fps(df_crt_rem)
rme_fps = _build_fps(df_rme_rem)  # CRT keys embedded in the RME record
demo_fps = _build_fps(df_demo_rem)  # CRT keys embedded in the Demo record

# ─────────────────────────────────────────────────────────────────────────────
# 4.  Core matching function — windowed Hungarian bipartite matching
# ─────────────────────────────────────────────────────────────────────────────


def match_bipartite_hungarian(
    df_anchor,
    df_target,
    threshold_s=THRESHOLD_S,
    anchor_fps=None,
    target_fps=None,
    fp_mismatch_cost=FP_MISMATCH_COST_S,
    window_s=WINDOW_S,
    desc="matching",
):
    """Optimally match anchor records to target records (1-to-1).

    The matching minimises total |startAt_anchor − startAt_target| across all
    accepted pairs.  Pairs separated by more than `threshold_s` are forbidden.

    Parameters
    ----------
    df_anchor / df_target
        DataFrames indexed by userSessionId with a 'startAt' column.
    threshold_s
        Maximum allowed |startAt| difference (seconds) for a valid match.
    anchor_fps / target_fps
        Optional pd.Series[frozenset] of CRT fingerprints, indexed like the
        corresponding DataFrame.  When both are provided, a fingerprint
        mismatch (both non-empty but unequal) adds `fp_mismatch_cost` to the
        pair's cost.
    fp_mismatch_cost
        Penalty in seconds for a fingerprint mismatch.
    window_s
        Width of the processing window (seconds).  Must satisfy
        window_s >> threshold_s so that records from different windows never
        compete for the same match.

    Returns
    -------
    pd.DataFrame with columns:
        anchor_id, target_id, time_diff_s, fp_match
    """
    if df_anchor.empty or df_target.empty:
        return pd.DataFrame(
            columns=["anchor_id", "target_id", "time_diff_s", "fp_match"]
        )

    # Convert startAt to float seconds since Unix epoch (handles tz-naive datetimes)
    t_anchor = df_anchor["startAt"].astype("int64").values / 1e9
    t_target = df_target["startAt"].astype("int64").values / 1e9
    a_ids = df_anchor.index.values
    t_ids = df_target.index.values

    # used_targets prevents a target near a window boundary from being
    # claimed by two successive windows.
    used_targets = set()
    records = []

    t_min, t_max = t_anchor.min(), t_anchor.max()
    n_windows = int(np.ceil((t_max - t_min) / window_s)) + 1

    for w in tqdm(range(n_windows), desc=f"  {desc}", leave=False):
        # Define the time boundaries of this window (in seconds since epoch).
        w_lo = t_min + w * window_s
        w_hi = w_lo + window_s

        # ── Select anchors ────────────────────────────────────────────────────
        # Only anchors whose startAt falls strictly inside [w_lo, w_hi) are
        # processed here.  Because windows are non-overlapping for anchors,
        # every anchor is processed in exactly one window.
        a_mask = (t_anchor >= w_lo) & (t_anchor < w_hi)
        if not a_mask.any():
            continue
        ai = np.where(a_mask)[0]
        a_t, a_id = t_anchor[ai], a_ids[ai]

        # ── Select candidate targets ──────────────────────────────────────────
        # A target is a candidate if it could possibly be within threshold_s of
        # any anchor in this window — i.e. its startAt is in
        # [w_lo − threshold_s, w_hi + threshold_s).  The extra ±threshold_s
        # fringe captures targets that sit just outside the window boundaries
        # but are still close enough to an anchor inside it.
        # We also skip targets already claimed by a previous window (used_targets)
        # to prevent the same target from being matched twice at a boundary.
        t_cand = (t_target >= w_lo - threshold_s) & (t_target < w_hi + threshold_s)
        if not t_cand.any():
            continue
        ti = np.where(t_cand)[0]
        avail = np.array([t_ids[k] not in used_targets for k in ti])
        if not avail.any():
            continue
        ti = ti[avail]
        t_t, t_id = t_target[ti], t_ids[ti]

        n_a, n_t = len(a_t), len(t_t)

        # ── Build the cost matrix ─────────────────────────────────────────────
        # Entry [i, j] = |startAt_anchor[i] − startAt_target[j]| in seconds.
        # This is the primary matching cost: smaller = more likely the same user.
        diff = np.abs(a_t[:, None] - t_t[None, :])  # shape (n_a, n_t)
        cost = diff.astype(float)

        # ── Apply fingerprint mismatch penalty ────────────────────────────────
        # If both the anchor and target carry a non-empty CRT fingerprint and
        # those fingerprints disagree, add fp_mismatch_cost to the pair's cost.
        # This steers the solver away from pairings where the accumulated CRT
        # responses are inconsistent, without making fingerprint agreement a
        # hard requirement (which would break demographicsLongInternational
        # records that carry no embedded fingerprint).
        if anchor_fps is not None and target_fps is not None:
            for i, aid in enumerate(a_id):
                afp = anchor_fps.get(aid, frozenset())
                if not afp:
                    # Anchor has no fingerprint (e.g. demographicsLongInternational);
                    # skip — we have no signal to penalise anything.
                    continue
                for j, tid in enumerate(t_id):
                    if diff[i, j] > threshold_s:
                        continue  # will be masked to LARGE_COST below; skip the lookup
                    tfp = target_fps.get(tid, frozenset())
                    if tfp and afp != tfp:
                        cost[i, j] += fp_mismatch_cost

        # ── Forbid pairs outside the time threshold ───────────────────────────
        # Set their cost to LARGE_COST so the solver never picks them.
        # Any assignment the solver returns with cost ≥ LARGE_COST is filtered
        # out after the solve step.
        cost[diff > threshold_s] = LARGE_COST

        # ── Pad to a square matrix ────────────────────────────────────────────
        # scipy's linear_sum_assignment requires a square (or at least
        # rectangular) matrix.  We pad with LARGE_COST so that dummy rows/
        # columns are never chosen as real matches.
        n = max(n_a, n_t)
        cost_sq = np.full((n, n), LARGE_COST)
        cost_sq[:n_a, :n_t] = cost

        # ── Solve the assignment problem ──────────────────────────────────────
        # linear_sum_assignment implements the Hungarian algorithm and returns
        # the pair of index arrays (row_ind, col_ind) that minimises the total
        # cost.  Each row and each column appears in the solution at most once,
        # giving a globally optimal 1-to-1 matching within this window.
        row_ind, col_ind = linear_sum_assignment(cost_sq)

        # ── Collect valid matches ─────────────────────────────────────────────
        for r, c in zip(row_ind, col_ind):
            # Discard padding rows/columns introduced when n_a ≠ n_t.
            if r >= n_a or c >= n_t:
                continue
            # Discard pairs the solver was forced to pick but that are
            # actually forbidden (outside the time threshold).
            if diff[r, c] > threshold_s:
                continue
            aid, tid = a_id[r], t_id[c]
            afp = (
                anchor_fps.get(aid, frozenset())
                if anchor_fps is not None
                else frozenset()
            )
            tfp = (
                target_fps.get(tid, frozenset())
                if target_fps is not None
                else frozenset()
            )
            # fp_match is True only when both fingerprints are non-empty and equal.
            fp_match = bool(afp and tfp and afp == tfp)

            # Mark this target as used so it cannot be re-matched in a later window.
            used_targets.add(tid)
            records.append(
                {
                    "anchor_id": aid,
                    "target_id": tid,
                    "time_diff_s": float(diff[r, c]),
                    "fp_match": fp_match,
                }
            )

    return pd.DataFrame(records)


# ─────────────────────────────────────────────────────────────────────────────
# 5.  Stage 1 — Match Demo → CRT and Demo → RME to form triplets
# ─────────────────────────────────────────────────────────────────────────────

print("\n" + "=" * 80)
print("STAGE 1 — MATCHING CRT / RME / DEMO TRIPLETS\n")

print("Matching Demo → CRT …")
demo_crt = match_bipartite_hungarian(
    df_demo_rem,
    df_crt_rem,
    anchor_fps=demo_fps,
    target_fps=crt_fps,
    desc="Demo→CRT",
)
print(f"  Matches: {len(demo_crt):,}")

print("Matching Demo → RME …")
demo_rme = match_bipartite_hungarian(
    df_demo_rem,
    df_rme_rem,
    anchor_fps=demo_fps,
    target_fps=rme_fps,
    desc="Demo→RME",
)
print(f"  Matches: {len(demo_rme):,}")

# Join into triplets: only keep Demo records matched to both CRT and RME.
triplets = demo_crt.rename(
    columns={
        "anchor_id": "demo",
        "target_id": "crt",
        "time_diff_s": "diff_demo_crt_s",
        "fp_match": "fp_demo_crt",
    }
).merge(
    demo_rme.rename(
        columns={
            "anchor_id": "demo",
            "target_id": "rme",
            "time_diff_s": "diff_demo_rme_s",
            "fp_match": "fp_demo_rme",
        }
    ),
    on="demo",
    how="inner",
)

# Cross-validate: do the CRT record and RME record agree on the CRT fingerprint?
# This is independent of how they were matched to Demo and catches cases where
# two different users happen to share the same startAt.
triplets["fp_crt_rme"] = triplets.apply(
    lambda row: bool(
        crt_fps.get(row["crt"], frozenset())
        and rme_fps.get(row["rme"], frozenset())
        and crt_fps.get(row["crt"]) == rme_fps.get(row["rme"])
    ),
    axis=1,
)

print(f"\nComplete triplets (Demo + CRT + RME): {len(triplets):,}")
print(f"  fp_demo_crt agreement : {triplets['fp_demo_crt'].mean():.1%}")
print(f"  fp_demo_rme agreement : {triplets['fp_demo_rme'].mean():.1%}")
print(f"  fp_crt_rme  agreement : {triplets['fp_crt_rme'].mean():.1%}")

triplets.to_csv("../demo_matches/triplet_results_hungarian.csv", index=False)
print("Saved → demo_matches/triplet_results_hungarian.csv")

# ─────────────────────────────────────────────────────────────────────────────
# 6.  Stage 2 — Match triplets to answer sessions
#
#     All four startAt values (answers last-createdAt, CRT startAt, RME startAt,
#     demo startAt) converge to the same session-start timestamp.  We use the
#     CRT startAt as the triplet's reference because CRT is the first individual
#     component and therefore closest in time to the last answer.
# ─────────────────────────────────────────────────────────────────────────────

print("\n" + "=" * 80)
print("STAGE 2 — MATCHING TRIPLETS TO ANSWER SESSIONS\n")

# Attach each triplet's reference time (CRT startAt) so the matcher can use it
triplets["startAt"] = df_crt_rem.loc[triplets["crt"].values, "startAt"].values

# Represent answer sessions by their last-answer createdAt under the name startAt
df_ans_timed = df_ans_rem[["createdAt"]].rename(columns={"createdAt": "startAt"})

# Index triplets by their CRT id (unique per triplet after stage-1 Hungarian)
triplets_indexed = triplets.set_index("crt")[["startAt"]]

print("Matching triplets → answer sessions …")
triplet_answer = match_bipartite_hungarian(
    triplets_indexed,
    df_ans_timed,
    anchor_fps=None,
    target_fps=None,
    desc="Triplets→Answers",
)
print(f"  Matches: {len(triplet_answer):,}")

triplet_answer.rename(
    columns={
        "anchor_id": "crt",
        "target_id": "answers",
        "time_diff_s": "diff_answers_s",
    },
    inplace=True,
)

full_matches = triplets.drop(columns=["startAt"]).merge(
    triplet_answer[["crt", "answers", "diff_answers_s"]],
    on="crt",
    how="inner",
)
full_matches["method"] = "hungarian"
print(f"Complete quintet matches: {len(full_matches):,}")

# ─────────────────────────────────────────────────────────────────────────────
# 7.  Add already-complete sessions and save
# ─────────────────────────────────────────────────────────────────────────────

print("\n" + "=" * 80)
print("ADDING SESSIONS WITH MATCHING IDs\n")

common_rows = []
for sid in tqdm(common_ids, desc="Processing", leave=True):
    if sid not in df_answers_last.index:
        continue
    common_rows.append(
        {
            "demo": sid,
            "crt": sid,
            "rme": sid,
            "answers": sid,
            "diff_demo_crt_s": 0.0,
            "diff_demo_rme_s": 0.0,
            "diff_answers_s": 0.0,
            "fp_demo_crt": True,
            "fp_demo_rme": True,
            "fp_crt_rme": True,
            "method": "common_id",
        }
    )

df_common = pd.DataFrame(common_rows)
all_matches = pd.concat([full_matches, df_common], ignore_index=True)

n_hungarian = (all_matches["method"] == "hungarian").sum()
n_common = (all_matches["method"] == "common_id").sum()
h = all_matches[all_matches["method"] == "hungarian"]

print(f"\nTotal matched sessions : {len(all_matches):,}")
print(f"  via Hungarian        : {n_hungarian:,}")
print(f"  via common ID        : {n_common:,}")
if len(h):
    print(f"\nHungarian match quality (median time differences):")
    print(f"  diff_demo_crt_s : {h['diff_demo_crt_s'].median():.3f} s")
    print(f"  diff_demo_rme_s : {h['diff_demo_rme_s'].median():.3f} s")
    print(f"  diff_answers_s  : {h['diff_answers_s'].median():.3f} s")
    print(f"  fp_crt_rme agreement: {h['fp_crt_rme'].mean():.1%}")

out_path = "../demo_matches/all_matches_hungarian.csv"
all_matches.to_csv(out_path, index=False)
print(f"\nSaved → {out_path}")
