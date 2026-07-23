#!/usr/bin/env python3
"""
simulate_budget.py — Besample recruitment budget simulation (row-priority dynamic frontier).

See strategy.md in this folder for the full algorithm write-up. Summary:

Scope
-----
Only published statements (statement_published.csv: published == 1) and the 16 countries
recruitable on Besample (besample_costs.csv) are considered.

Ranking
-------
For every cell (i, j): remaining(i, j) = max(0, 10 - n(i, j)).
For every statement i: R(i) = sum over the 16 countries of remaining(i, j) — total ratings
still needed to fully fill that statement's row everywhere. Statements are globally sorted
ascending by R(i) (statements with R(i) == 0 are already complete and dropped).

Per-country dynamic frontier
-----------------------------
For country j, filter the global order to remaining(i, j) > 0 -> queue_j. Maintain an active
set of up to 15 statements (the highest-priority unfilled ones for j). Each participant is
shown the current active set; after their ratings are confirmed, any statement that reaches
remaining == 0 is dropped from the active set and replaced from queue_j. This recruits exactly
enough participants to fill each cell to 10, with no overshoot, and lets each participant see a
distinct set of statements rather than a fixed block.

Concurrency (not simulated)
----------------------------
The live system tracks pending(i, j) reservations with a 45-minute session timeout (see
strategy.md, Step 7), so effective_remaining = 10 - n(i,j) - pending(i,j). This simulation
assumes every reservation completes (no timeouts), so it only needs to track confirmed n(i,j)
one participant at a time.

Budget allocation
------------------
Countries are recruited round-robin, cheapest cost-per-respondent first, one participant per
country per round, until the budget is exhausted or every country's queue is fully drained.

Outputs
-------
  simulation_results.csv    — per-country allocation summary
  statement_selection.csv   — every (country, participant, slot, statement) row
  simulation_summary.md     — human-readable report
"""

from pathlib import Path
import pandas as pd

# ─── Configuration ────────────────────────────────────────────────────────────
BUDGET      = 1_000.0
MIN_RATINGS = 10
BLOCK_SIZE  = 15   # statements shown per participant

# ─── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR     = Path(__file__).resolve().parent
DATA_DIR       = SCRIPT_DIR.parents[1] / 'visualize' / 'data'
STATEMENTS_CSV = SCRIPT_DIR.parents[2] / 'statements' / 'statements_1.csv'

# ─── Load data ────────────────────────────────────────────────────────────────
answers   = pd.read_csv(DATA_DIR / 'answers.csv')
demo      = pd.read_csv(DATA_DIR / 'crt_rme_demo.csv')[['userSessionId', 'country_reside']]
published = pd.read_csv(DATA_DIR / 'statement_published.csv', usecols=['statementId', 'published'])
costs     = pd.read_csv(SCRIPT_DIR / 'besample_costs.csv')
stmt_text = pd.read_csv(STATEMENTS_CSV, usecols=['id', 'statement']
            ).rename(columns={'id': 'statementId'})

BESAMPLE_COUNTRIES = costs['country'].tolist()
published_ids       = published.loc[published['published'] == 1, 'statementId'].tolist()
stmt_lookup: dict    = dict(zip(stmt_text['statementId'], stmt_text['statement']))

# ─── Step 1: restrict to published statements x Besample countries ───────────

merged = answers.merge(demo, on='userSessionId', how='left')
merged = merged[
    merged['country_reside'].isin(BESAMPLE_COUNTRIES) &
    merged['statementId'].isin(published_ids)
]

cell_n = merged.groupby(['statementId', 'country_reside']).size().reset_index(name='n')

n_pivot = (
    cell_n.pivot(index='statementId', columns='country_reside', values='n')
    .reindex(index=published_ids, columns=BESAMPLE_COUNTRIES)
    .fillna(0)
    .astype(int)
)
n_pivot.index.name = 'statementId'

matrix_total_cells  = n_pivot.shape[0] * n_pivot.shape[1]
matrix_filled_cells = int((n_pivot >= MIN_RATINGS).sum().sum())
matrix_subthresh     = int(((n_pivot >= 1) & (n_pivot < MIN_RATINGS)).sum().sum())

# ─── Steps 2 & 4: remaining need per cell, per row ─────────────────────────────

remaining = (MIN_RATINGS - n_pivot).clip(lower=0)          # remaining(i, j)
R = remaining.sum(axis=1).rename('R_i')                     # R(i)

# ─── Step 5: global row priority (drop fully-filled rows, tie-break by id) ────
#
# IMPLEMENTATION NOTE FOR THE LIVE SYSTEM (JS/etc. port):
# This whole block — remaining(i,j), R(i), and the sort below — is a point-in-time
# snapshot computed from the current `n(i,j)` matrix. In production this must be
# RECOMPUTED ON A TIMER, e.g. every hour (see strategy.md, Step 5 > "Refresh cadence"),
# not just once at the start of a recruiting session:
#   1. Recompute remaining(i,j) = max(0, 10 - n(i,j)) using CONFIRMED ratings only
#      (n(i,j)), never pending(i,j) reservations (see Step 7 / the CountryFrontier
#      notes below).
#   2. Recompute R(i) = sum of remaining(i,j) across all 16 countries, for every
#      statement.
#   3. Re-sort ascending by R(i) (ties broken by statementId, arbitrarily) and drop
#      any statement whose R(i) is now 0 (fully filled everywhere).
#   4. Feed the refreshed list into every country's frontier (below) — see the
#      CountryFrontier docstring for how to reconcile an in-progress queue against
#      a newly refreshed global order.
global_order_df = (
    R[R > 0]
    .reset_index()
    .sort_values(['R_i', 'statementId'], ascending=[True, True])
    .reset_index(drop=True)
)
global_order = global_order_df['statementId'].tolist()

# ─── Step 6: per-country dynamic frontier ─────────────────────────────────────

class CountryFrontier:
    """
    Per-country statement-choice engine for one country j. This is THE piece of logic
    a re-implementation (JS or otherwise) needs to reproduce exactly. See strategy.md,
    Step 6, for the prose version — this docstring is the step-by-step reference.

    State to persist per country (e.g. one row per country in a database, or one
    object in memory if a single process owns recruitment):
      queue          — list[statementId], the country's candidate statements, already
                       filtered to remaining(i,j) > 0 and sorted by the GLOBAL order
                       (ascending R(i), see Step 5). This list is fixed at construction
                       time (see "Reconciling against a refreshed global order" below
                       for what to do when Step 5 recomputes on its hourly timer).
      ptr            — index into `queue` marking how far we've consumed candidates to
                       fill the active set so far. Everything at queue[:ptr] has either
                       been shown to a participant already, or is currently active.
                       Everything at queue[ptr:] has never been looked at yet.
      active         — list[statementId], length <= BLOCK_SIZE (15), the CURRENT set of
                       statements to show the *next* participant recruited for this
                       country. This is the only thing that actually needs to be read
                       when a new participant needs an assignment.
      remaining_map  — dict[statementId -> int], how many more ratings statement i still
                       needs from country j to reach MIN_RATINGS (10). Decremented as
                       participants complete sessions (see "On session completion").

    ── Initialization (do this once per country, and again each time Step 5 refreshes) ──
      queue         = [s for s in global_order if remaining(s, j) > 0]   # already sorted
      remaining_map = {s: remaining(s, j) for s in queue}
      ptr           = min(15, len(queue))
      active        = queue[0:ptr]                                       # first 15

    ── Assigning a participant (whenever a new participant starts a session) ──
      Show them exactly `active` (up to 15 statement IDs). Do NOT mutate remaining_map
      or active yet — those only change once the session's ratings are CONFIRMED
      (submitted) or the session TIMES OUT (see strategy.md, Step 7). Concretely, at
      assignment time you should also bump `pending(i,j)` for each statement in
      `active` (not modeled in this offline simulation, which assumes every session
      completes — see the module docstring's "Concurrency" section).

    ── On session completion (participant finished; ratings confirmed) ──
      For every statement i in the set that was shown to this participant:
        1. remaining_map[i] -= 1          (and n(i,j) += 1, pending(i,j) -= 1 live)
        2. if remaining_map[i] == 0: this statement is done for country j — drop it
           from `active`. It must never be shown to another participant in this
           country again.
      After processing all 15, refill `active` back up to 15 slots:
        3. while len(active) < 15 and ptr < len(queue):
             candidate = queue[ptr]; ptr += 1
             if remaining_map[candidate] > 0:      # guards against stale/filled entries
                 active.append(candidate)
      This refill always pulls the NEXT statement in global-rank order that isn't
      already active and isn't already filled — never skips ahead arbitrarily and
      never re-picks something already showing.

    ── On session timeout (45 minutes, no completion — strategy.md Step 7) ──
      Nothing changes in remaining_map or active. Only pending(i,j) is decremented (in
      the live system). From this class's point of view, a timed-out session simply
      never happened — no step() call should be made for it.

    ── Stopping condition for this country ──
      Recruitment for country j stops when either the country's budget is exhausted,
      or `active` is empty (len(queue) == ptr and nothing left with remaining > 0),
      whichever comes first.

    ── Reconciling against a refreshed global order (hourly, per Step 5) ──
      When Step 5 recomputes the global order, don't just discard in-flight state:
        1. Rebuild `queue` from the new global order, filtered to remaining(i,j) > 0
           using CURRENT remaining_map values (statements already fully filled for
           country j stay excluded regardless of their new global rank).
        2. Anything currently in `active` should stay active (a participant may
           already be mid-session looking at it) even if its rank shifted.
        3. Everything else follows the new order for future refills — i.e. `ptr`
           conceptually resets to "wherever the new queue's un-shown statements
           begin," and the next refill pulls from the freshly-ranked list, not the
           stale one.
    """

    def __init__(self, queue: list, remaining_map: dict):
        self.queue = queue
        self.remaining_map = dict(remaining_map)
        self.ptr = min(BLOCK_SIZE, len(queue))
        self.active = list(queue[:self.ptr])
        self.initial_n: dict = {}   # filled in by caller
        self.participants: list = []   # list of list[statementId]

    def has_next(self) -> bool:
        return len(self.active) > 0

    def step(self) -> list:
        """
        Recruit one participant and return the statement IDs shown to them.

        NOTE: this offline simulation treats "assign" and "confirm" as the same
        instant (see module docstring — pending reservations always complete here).
        A live implementation must split this into two separate events per the
        docstring above: (1) assign `active` + bump pending(i,j) when the session
        starts, and (2) only run the decrement/drop/refill logic below once the
        session is actually confirmed complete (or skip it entirely on timeout).
        """
        # 1. Freeze the current active set — this is what the participant sees.
        assigned = list(self.active)
        self.participants.append(assigned)

        # 2. Session confirmed: decrement remaining need for every statement they
        #    just rated, and drop any that just reached the MIN_RATINGS threshold.
        new_active = []
        for sid in assigned:
            self.remaining_map[sid] -= 1
            if self.remaining_map[sid] > 0:
                new_active.append(sid)   # still needs more ratings — stays active

        # 3. Refill dropped slots from the queue, strictly in global-rank order,
        #    skipping anything already filled (defensive — shouldn't happen since
        #    the queue was pre-filtered, but cheap to guard against staleness).
        needed = BLOCK_SIZE - len(new_active)
        while needed > 0 and self.ptr < len(self.queue):
            candidate = self.queue[self.ptr]
            self.ptr += 1
            if self.remaining_map.get(candidate, 0) > 0:
                new_active.append(candidate)
                needed -= 1

        # 4. This becomes the active set shown to the NEXT participant recruited
        #    for this country — may differ from `assigned` in one or more slots.
        self.active = new_active
        return assigned


frontiers: dict = {}
for country in BESAMPLE_COUNTRIES:
    remaining_col = remaining[country]
    queue_c = [sid for sid in global_order if remaining_col.at[sid] > 0]
    remaining_map_c = {sid: int(remaining_col.at[sid]) for sid in queue_c}
    fc = CountryFrontier(queue_c, remaining_map_c)
    fc.initial_n = {sid: int(n_pivot.at[sid, country]) for sid in queue_c}
    frontiers[country] = fc

# ─── Step 8: round-robin budget allocation, one participant at a time ─────────

costs_sorted = costs.sort_values(['total_cost_per_respondent_usd', 'country']).reset_index(drop=True)
cost_lookup  = dict(zip(costs_sorted['country'], costs_sorted['total_cost_per_respondent_usd']))

budget_left = BUDGET
while True:
    made_purchase = False
    for country in costs_sorted['country']:
        fc   = frontiers[country]
        cost = cost_lookup[country]
        if fc.has_next() and budget_left >= cost - 1e-9:
            fc.step()
            budget_left -= cost
            made_purchase = True
    if not made_purchase:
        break

stop_reason = (
    'all country queues fully drained'
    if all(not fc.has_next() for fc in frontiers.values())
    else 'budget exhausted'
)

# ─── Assemble per-country results & selection rows ────────────────────────────

R_lookup = R.to_dict()
result_rows    = []
selection_rows = []

for priority, (_, cost_row) in enumerate(costs_sorted.iterrows(), start=1):
    country = cost_row['country']
    fc      = frontiers[country]
    n_participants = len(fc.participants)
    total_cost     = round(n_participants * cost_row['total_cost_per_respondent_usd'], 2)

    completed_from_partial = 0
    completed_from_zero    = 0
    for sid in fc.queue:
        if fc.remaining_map[sid] == 0:
            if fc.initial_n[sid] >= 1:
                completed_from_partial += 1
            else:
                completed_from_zero += 1
    new_cells        = completed_from_partial + completed_from_zero
    still_incomplete = len(fc.queue) - new_cells

    for p_idx, stmts in enumerate(fc.participants, start=1):
        for slot, sid in enumerate(stmts, start=1):
            selection_rows.append({
                'country':      country,
                'participant':  p_idx,
                'slot':         slot,
                'statementId':  sid,
                'initial_n':    fc.initial_n.get(sid, 0),
                'R_i':          int(R_lookup.get(sid, 0)),
                'statement':    stmt_lookup.get(sid, ''),
            })

    result_rows.append({
        'priority':                 priority,
        'country':                 country,
        'continent':                cost_row['continent'],
        'cost_per_respondent':      cost_row['total_cost_per_respondent_usd'],
        'n_participants':           n_participants,
        'total_cost':               total_cost,
        'new_cells_from_partial':   completed_from_partial,
        'new_cells_from_zero':      completed_from_zero,
        'new_cells':                new_cells,
        'still_incomplete_cells':   still_incomplete,
        'queue_exhausted':          not fc.has_next(),
    })

results   = pd.DataFrame(result_rows)
selection = pd.DataFrame(selection_rows)

budget_spent    = results['total_cost'].sum()
total_new_cells = int(results['new_cells'].sum())

results.to_csv(SCRIPT_DIR / 'simulation_results.csv', index=False)
selection.to_csv(SCRIPT_DIR / 'statement_selection.csv', index=False)

# ─── Build markdown summary ───────────────────────────────────────────────────

lines = []
W = lines.append

W('# Besample Recruitment — Launch Plan (Row-Priority Dynamic Frontier)')
W('')
W(f'**Date:** 2026-07-23  ')
W(f'**Script:** `simulate_budget.py`  ')
W(f'**Strategy:** `strategy.md`  ')
W(f'**Full statement list:** `statement_selection.csv`')
W('')
W('---')
W('')
W('## Matrix scope (published statements × Besample countries)')
W('')
W('| Metric | Value |')
W('|--------|-------|')
W(f'| Published statements | {len(published_ids):,} |')
W(f'| Besample countries | {len(BESAMPLE_COUNTRIES)} |')
W(f'| Matrix size | {n_pivot.shape[0]:,} × {n_pivot.shape[1]} = {matrix_total_cells:,} |')
W(f'| Filled cells (n ≥ {MIN_RATINGS}) before this batch | {matrix_filled_cells:,} |')
W(f'| Sub-threshold cells (1–{MIN_RATINGS - 1}) before this batch | {matrix_subthresh:,} |')
W(f'| Statements with R(i) > 0 (still need work) | {len(global_order):,} |')
W('')
W('---')
W('')
W('## Budget summary')
W('')
W('| Parameter | Value |')
W('|-----------|-------|')
W(f'| Budget | ${BUDGET:,.2f} |')
W(f'| Budget spent | ${budget_spent:,.2f} |')
W(f'| Budget remaining | ${budget_left:.2f} |')
W(f'| Min. ratings per cell | {MIN_RATINGS} |')
W(f'| Statements shown per participant | {BLOCK_SIZE} |')
W(f'| Countries recruited | {int((results["n_participants"] > 0).sum())} |')
W(f'| Total participants | {results["n_participants"].sum():,} |')
W(f'| **Total new filled cells** | **{total_new_cells:,}** |')
W(f'| — from partially-filled cells (top-ups) | {results["new_cells_from_partial"].sum():,} |')
W(f'| — from zero-rating cells (brand new) | {results["new_cells_from_zero"].sum():,} |')
W(f'| Stopping condition | {stop_reason} |')
W('')
W('---')
W('')
W('## Country launch order')
W('')
W('Countries are listed cheapest-cost-per-respondent first, matching the round-robin priority')
W('used in the simulation. Recruitment is dynamic: each participant may see a different set of')
W('15 statements, adjusted after every completed session (see `strategy.md`, Step 6). There is no')
W('longer a fixed "block of 10" — the participant counts below are individuals.')
W('')
W('| Priority | Country | Continent | $/respondent | Participants | Cost | New cells (partial → filled) | New cells (zero → filled) | Queue exhausted? |')
W('|:--------:|---------|-----------|-------------:|-------------:|-----:|------------------------------:|---------------------------:|:----------------:|')
for _, r in results.iterrows():
    W(f'| {r["priority"]} | **{r["country"]}** | {r["continent"]} | ${r["cost_per_respondent"]:.2f} | '
      f'{r["n_participants"]} | ${r["total_cost"]:.2f} | {r["new_cells_from_partial"]} | '
      f'{r["new_cells_from_zero"]} | {"yes" if r["queue_exhausted"] else "no"} |')
W('')
W('---')
W('')
W('## Per-country participant statement lists')
W('')
W('Participants are numbered in recruitment order within their country. Because active sets are')
W('refreshed dynamically, consecutive participants in the same country do not necessarily see the')
W('same 15 statements.')
W('')
W('| Country | Participant | Statement IDs |')
W('|---------|------------:|---------------|')
for _, r in results.iterrows():
    country = r['country']
    country_sel = selection[selection['country'] == country]
    for p_idx in sorted(country_sel['participant'].unique()):
        ids = ','.join(map(str, country_sel.loc[country_sel['participant'] == p_idx, 'statementId']))
        W(f'| {country} | {p_idx} | {ids} |')
W('')

W('---')
W('')
W('## Notes')
W('')
W('- **Re-run before each batch launch.** `answers.csv` is refreshed nightly. Re-running')
W('  `python simulate_budget.py` recomputes `n(i,j)`, `R(i)`, and the launch plan from scratch.')
W('- **`statement_selection.csv`** lists every (country, participant, slot, statement) row in')
W('  machine-readable form.')
W('- **No fixed blocks.** Unlike the 2026-06-29 strategy, participants are not grouped into')
W('  identical-statement batches of 10 — each participant\'s 15 statements come from that')
W('  country\'s live active set at the moment they are recruited.')
W('- **Concurrency/timeouts not modeled here.** This simulation assumes every recruited')
W('  participant completes their session. The live system must track `pending(i,j)` reservations')
W('  with a 45-minute timeout so concurrent sessions don\'t over-assign the same near-complete')
W('  cell — see `strategy.md`, Step 7.')

md_text = '\n'.join(lines)
(SCRIPT_DIR / 'simulation_summary.md').write_text(md_text, encoding='utf-8')

# ─── Console summary ─────────────────────────────────────────────────────────

DIVIDER = '─' * 72
print(DIVIDER)
print(f'  BUDGET SIMULATION — row-priority dynamic frontier, MIN_RATINGS = {MIN_RATINGS}')
print(DIVIDER)
print(f'  Total budget       : ${BUDGET:>8,.2f}')
print(f'  Budget spent       : ${budget_spent:>8,.2f}')
print(f'  Budget remaining   : ${budget_left:>8.2f}')
print(f'  Countries recruited: {int((results["n_participants"] > 0).sum())}')
print(f'  Total participants : {results["n_participants"].sum():,}')
print(f'  Total new cells    : {total_new_cells:,}')
print(f'    from partial     : {results["new_cells_from_partial"].sum():,}')
print(f'    from zero        : {results["new_cells_from_zero"].sum():,}')
print(f'  Stop reason        : {stop_reason}')
print(DIVIDER)
print()
print(results[['priority', 'country', 'n_participants', 'total_cost', 'new_cells']].to_string(index=False))
print()
print('Outputs written:')
print(f'  simulation_results.csv  ({len(results)} rows)')
print(f'  statement_selection.csv ({len(selection)} rows)')
print('  simulation_summary.md')
