# Statement Sampling Strategy — Row-Priority Dynamic Frontier

**Date:** 2026-07-23
**Repo path:** `commonsense-data/.scripts/besample/sampling_20260723/`
**Supersedes:** `statement_sampling_strategy.md` (2026-06-29) and `sampling_20260629/` for the purposes of
the current Besample budget round. That version's Tier A/B ranking and design-point-diversity
selection are **not** used here — this strategy replaces them with a global row-priority ordering
and a dynamic, per-participant assignment scheme. If design-point diversity is wanted again, it
would need to be reintroduced explicitly (e.g. as a tiebreaker in Step 5).

---

## 1. Scope

Only two axes of the full commonsense matrix are in play for this recruitment round:

- **Statements:** only those with `published = 1` in `visualize/data/statement_published.csv`.
- **Countries:** only the 16 countries recruitable on Besample (listed in `besample_costs.csv`).

As of 2026-07-23:

| Metric | Value |
|---|---:|
| Published statements | 1,265 |
| Besample countries | 16 |
| Matrix size (statements × countries) | 20,240 |
| Filled cells (n ≥ 10) | 422 |
| Sub-threshold cells (1–9 ratings) | 5,051 |
| Empty cells (0 ratings) | 14,767 |

All statement selection and budget simulation operates only on this restricted 1,265 × 16 matrix.
Ratings from non-Besample countries, or on unpublished statements, are ignored for planning purposes
(though they still count toward the matrix as displayed on the live report).

---

## 2. Definition of "filled"

A cell (statement _i_, country _j_) is **filled** once `n(i,j) ≥ 10`, where `n(i,j)` is the number of
ratings collected so far for statement _i_ from participants residing in country _j_. Once a cell is
filled, it is permanently excluded from future candidate selection — there is no value in collecting
additional ratings for it.

---

## 3. No overshoot: recruit exactly to threshold

For a partially-filled cell (1 ≤ `n(i,j)` ≤ 9), we should recruit **only as many additional
participants from country _j_ as are needed to bring it to exactly 10** — not a full batch of 10 more.
E.g. if `n(i,j) = 8`, we need exactly 2 more ratings for statement _i_ from country _j_, not 10.

This breaks the assumption behind the old "fixed block of 10 participants, all rating the same 15
statements" model, since different statements have different remaining needs and a fixed block would
either overshoot (waste ratings past 10) or undershoot (leave cells still sub-threshold) most of them.
Recruitment is therefore **dynamic and per-participant**: each participant can be assigned a distinct
set of 15 statements, chosen based on the live state of the matrix at the moment they are recruited —
see Step 6.

---

## 4. Remaining need per cell and per row

For every cell:

```
remaining(i, j) = max(0, 10 - n(i, j))
```

For every statement (row) _i_, sum the remaining need across all 16 countries:

```
R(i) = Σⱼ remaining(i, j)          # total ratings still needed to fully fill row i everywhere
```

`R(i)` ranges from 0 (row already fully filled across all 16 countries) to 160 (no country has any
rating on this statement yet). It is the "cost to fully complete this row."

---

## 5. Global row priority

Sort statements **ascending by `R(i)`**, after dropping any statement with `R(i) = 0` (already
complete everywhere). This is a single, global ranking — not per-country — that prioritizes rows
that are cheapest to finish completely across the whole matrix.

Ties in `R(i)` are broken arbitrarily (statement ID, purely for run-to-run determinism) — no
design-point or other secondary criterion is applied.

This global order is the backbone that every country's recruitment draws from in Step 6.

### Refresh cadence

`n(i,j)` changes continuously as sessions complete across every country, so `R(i)` and the global
order are **not** computed once and frozen for the whole recruitment round — they must be
**recomputed regularly, e.g. every hour**. Each refresh:

1. Re-derives `remaining(i,j) = max(0, 10 - n(i,j))` from the latest **confirmed** counts only
   (`n(i,j)`, not `pending(i,j)` — see Step 7).
2. Recomputes `R(i)` for every statement and re-sorts the global order from scratch.
3. Feeds the refreshed order into every country's frontier (Step 6), which re-filters its own
   queue against it.

A statement's global rank can move between refreshes even if country _j_ itself hasn't rated it —
e.g. if other countries complete ratings on it, its `R(i)` drops and it may newly enter or rise
within country _j_'s queue. The per-country active set (Step 6) should be reconciled against the
refreshed queue at each refresh: statements no longer eligible (now filled) drop out, and newly
higher-priority statements can displace lower-priority ones that haven't been shown to a
participant yet.

---

## 6. Per-country dynamic frontier

Recruitment for country _j_ is driven by this global order, filtered and continuously adapted to
that country's own state:

1. **Country queue.** Filter the global order down to statements where `remaining(i, j) > 0` —
   call this `queue_j`. It stays in global-rank order.
2. **Active set.** Initialize `A` = the first `min(15, len(queue_j))` statements from `queue_j`.
3. **Assign.** The next participant recruited from country _j_ is shown the statements in `A`.
4. **Update.** When their ratings are confirmed, decrement `remaining(i, j)` by 1 for every
   statement in `A`. Any statement that reaches `remaining(i, j) = 0` is removed from `A`.
5. **Refill.** Pull the next unfilled statement(s) from `queue_j` (in order, skipping anything
   already active or already filled) to bring `A` back up to 15.
6. **Repeat** for the next participant, until either the recruitment budget for country _j_ is
   exhausted, or `queue_j` is fully drained (every eligible statement for country _j_ reached 10).

This guarantees:
- No participant is ever shown a statement already at threshold for their country (no waste).
- The active set always reflects the current highest-priority incomplete statements for that
  country, as closely as the country's own data allows.
- The window advances at a different pace per statement depending on how much of a head start it
  already had in that country — this is the "wiggle": strict global order is respected as the
  selection criterion, but completion order naturally departs from it based on country-specific need.

---

## 7. Concurrency and session integrity

Participants can be recruited **concurrently** in a given country, and not every session finishes —
an abandoned session must not count. This is handled with a reservation (lock) on top of the
confirmed count:

- `n(i, j)` — confirmed ratings (participant completed their session).
- `pending(i, j)` — ratings currently reserved by an in-progress (unfinished) session.
- **Effective remaining** used for all assignment decisions (Steps 4–6) is
  `10 - n(i, j) - pending(i, j)`, not just `10 - n(i, j)`. This prevents two concurrent participants
  from both being assigned the last open slot on the same cell.
- **On completion:** `pending(i, j) -= 1`, `n(i, j) += 1`.
- **On timeout:** each session has a **45-minute** cap. If a participant hasn't finished within 45
  minutes, their reservation is released — `pending(i, j) -= 1` and `n(i, j)` is left untouched, i.e.
  treated as if that participant never started. The freed slot becomes available again.

**Simulation assumption:** `simulate_budget.py` assumes every `pending(i, j)` reservation eventually
completes (no timeouts), since in practice abandonment happens rarely enough not to materially affect
budget planning. The pending/timeout mechanism above is what the **live recruitment system** must
implement; the offline simulation only needs the simpler confirmed-count model (`n(i,j)` incrementing
directly, one participant at a time) to produce a realistic launch plan.

---

## 8. Budget allocation across countries

Recruitment is still bounded by an overall Besample budget (`$1,000` in the current run). The
per-participant granularity from Step 3 replaces the old "blocks of 10" unit, but the cross-country
balancing philosophy carries over unchanged from the previous approach: recruiting all budget into
the single cheapest country produces unusable, wildly unbalanced country coverage, so budget is
distributed via **round-robin**, cheapest country first, **one participant at a time**:

1. Order the 16 countries by `total_cost_per_respondent_usd` ascending (from `besample_costs.csv`).
2. In each round, go through the countries in that order; for each country that still has an
   open queue (Step 6) and whose per-participant cost still fits the remaining budget, recruit
   exactly one participant there (running that country's frontier one step).
3. Repeat rounds until a full pass recruits nobody — either the budget is exhausted, or every
   country's queue is completely drained (the entire restricted matrix is filled).

This is the same round-robin principle as before, just applied at the participant level instead of
the block level, which is possible now that assignment is no longer batched.

---

## 9. What changed vs. the 2026-06-29 strategy

| | 2026-06-29 (`statement_sampling_strategy.md`) | 2026-07-23 (this document) |
|---|---|---|
| Matrix scope | All 10,110 statements × 148+ countries | 1,265 published statements × 16 Besample countries |
| Ranking | Per-country Tier A (sub-threshold) then Tier B (by global N_i), independently per country | Single global ranking by `R(i)` (total remaining need per row), shared across countries |
| Design-point diversity | Greedy secondary objective within each block | Not used |
| Recruitment unit | Fixed blocks of 10 participants, identical 15 statements each | Individual participants, dynamically assigned, adjusted after every completion |
| Overshoot | Possible (a block always adds 10 ratings even if fewer were needed) | Eliminated — each cell receives exactly enough ratings to reach 10 |
| Concurrency/session handling | Not modeled | Reservation (`pending`) with 45-minute timeout, released back to the pool on abandonment |
| Cross-country budget balance | Round-robin over blocks | Round-robin over individual participants (same principle, finer granularity) |
