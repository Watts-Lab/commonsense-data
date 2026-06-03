# Survey Record Matching: Problem and Solution

## 1. Background

The survey platform collects five kinds of data for each participant:

| Source | What it contains |
|---|---|
| **Experiments** | Which statements were assigned to the participant |
| **Answers** | The participant's ratings of those statements |
| **CRT** | Cognitive Reflection Test responses and score |
| **RME** | Reading the Mind in the Eyes test responses and score |
| **Demographics** | Background information (age, gender, country, education, …) |

All five are identified by a `userSessionId` string that is supposed to be the same across all records belonging to one participant. The intended data model is:

```
AwnUtky9zGp_LIa_pI1CFA3zP_4cC-Uz  ← answers row
AwnUtky9zGp_LIa_pI1CFA3zP_4cC-Uz  ← CRT row
AwnUtky9zGp_LIa_pI1CFA3zP_4cC-Uz  ← RME row
AwnUtky9zGp_LIa_pI1CFA3zP_4cC-Uz  ← demographics row
```

The survey flow is strictly ordered:

```
[Statement ratings] → [CRT] → [RME] → [Demographics]
```

The participant cannot proceed to the next step without completing the current one.

---

## 2. The Problem

A bug introduced during data collection caused the platform to generate a **fresh `userSessionId` for each step** instead of reusing the one assigned at the start of the session. As a result, a single participant's records look like this:

```
pPMBt4yIsEBcKAIV5G4hgn43Vce80uua  ← CRT row
ajsJsfQnhIchzgx_JcHpSLJTs1RCJIst  ← RME row
y0YJPVyrRVIUB-JWKU_q5xdmhSH0Zfkl  ← demographics row
```

There is no shared key anymore. Joining the tables in the usual way produces no matches for these participants, making it impossible to pair, say, a CRT score with the demographics of the same person.

The dataset contains **45,343 CRT records**, **43,354 RME records**, and **42,437 demographics records** in total. Of these, only **7,532 participants** have a consistent `userSessionId` across all sources (they were collected before or after the bug window). The remaining tens of thousands of records need to be matched by other means.

---

## 3. The Key Signal: `startAt`

Each record in the `individuals` table stores an `experimentInfo` JSON blob. Buried inside it is a field called `secondsElapsed`. A natural reading of this field would be "how long the participant spent on this particular step", but it is actually the **total elapsed time since the participant first loaded the survey**.

This means:

```
startAt  =  createdAt  −  secondsElapsed
         ≈  moment the participant began the survey session
```

Because this quantity refers to the same physical event (session start), it converges to the same timestamp across all components that belong to the same participant.

### Example — normal participant (consistent IDs)

| Component    | `createdAt` | `secondsElapsed` | `startAt`      |
|---|---|---|---|
| CRT          | 19:56:52    | 101.7 s          | **19:55:10.3** |
| RME          | 19:58:19    | 188.2 s          | **19:55:10.8** |
| Demographics | 19:59:27    | 257.2 s          | **19:55:09.8** |

All three `startAt` values agree within **~1 second**. The spread is due to floating-point timing noise from the client browser.

### Example — bug-affected participant (mismatched IDs)

| Component    | `userSessionId`                     | `createdAt` | `secondsElapsed` | `startAt`          |
|--------------|-------------------------------------|-------------|------------------|--------------------|
| CRT          | `pPMBt4yIsEBcKAIV5G4hgn43Vce80uua`  | 20:43:15    | 42.8 s           | **20:42:32.2**     |
| RME          | `ajsJsfQnhIchzgx_JcHpSLJTs1RCJIst`  | 20:44:25    | 113.4 s          | **20:42:31.6**     |
| Demographics | `y0YJPVyrRVIUB-JWKU_q5xdmhSH0Zfkl`  | 20:45:34    | 182.3 s          | **20:42:31.7**     |

Even though the three `userSessionId`s are completely different, all three `startAt` values are within **0.7 seconds** of each other. This is the primary matching signal.

> **Intuition.** Imagine a stopwatch that starts the moment the participant's browser loads the survey. Every subsequent submission records both the wall-clock time and the stopwatch reading. Even if each submission is assigned a random ID, subtracting the stopwatch reading from the wall clock always recovers the moment the stopwatch was started — i.e. the shared session origin.

---

## 4. A Secondary Signal: Response Fingerprints

The survey platform **accumulates all prior answers** into every new submission. Concretely:

- The **CRT record** contains only the CRT answers.
- The **RME record** contains the CRT answers *and* the RME answers.
- The **demographics record** contains the CRT answers, the RME answers, *and* the demographic answers.

This means the CRT answer set — keys `drill_hammer`, `rachel`, `toaster`, `apples`, `eggs`, `dog_cat` — appears verbatim inside every downstream record from the same session. We call this the **CRT fingerprint**.

### Example

CRT record for `pPMBt4yIsEBcKAIV5G4hgn43Vce80uua`:
```json
"responses": { "dog_cat": 72 }
```

The RME record `ajsJsfQnhIchzgx_JcHpSLJTs1RCJIst` embeds exactly the same CRT answers, plus the ten RME items:
```json
"responses": { "dog_cat": 72, "rme_item_4": "insisting", "rme_item_6": "fantasizing", ... }
```

If the CRT fingerprint extracted from a proposed CRT record *matches* the fingerprint embedded in a proposed RME or demographics record, that is evidence the two records belong to the same participant. A mismatch is evidence against.

> **Caveat.** `demographicsLongInternational` records (a newer survey variant, ~2,081 records) do **not** embed prior responses at all. Fingerprint matching is simply skipped for those records; `startAt` proximity is the only signal.

---

## 5. Why Fingerprints Alone Are Not Enough

CRT fingerprints are not globally unique. The most common full 6-question pattern (`apples=15, dog_cat=72, drill_hammer=15, eggs=11, rachel=19, toaster=125`) appears in **7,881 records** — these are participants who answered all CRT items correctly. Across all records, only ~7,000 fingerprints are unique (appear exactly once).

Therefore, fingerprints can **narrow the candidate pool** and **break ties**, but cannot serve as the sole matching key. `startAt` proximity remains the primary signal, with the fingerprint acting as corroborating evidence.

---

## 6. The Two-Stage Solution

The matching is implemented in `recover_demo.py`.

### Stage 1 — Form (CRT, RME, Demographics) triplets

**Goal:** For each demographics record, find the one CRT record and the one RME record that belong to the same participant.

**Anchor:** The demographics record is used as the anchor because it is the *last* step, meaning there are fewer demographics records than CRT or RME records (only participants who reached the end contribute one).

**Cost function for a proposed (Demo, CRT) pair:**

```
cost(Demo_i, CRT_j)  =  |startAt_i − startAt_j|   (seconds)
                       + fp_mismatch_penalty        (0 or 5 s)
```

where `fp_mismatch_penalty = 5 s` is added when both fingerprints are non-empty but disagree. The same cost function is applied to (Demo, RME) pairs.

After running the assignment separately for Demo→CRT and Demo→RME, the two result sets are inner-joined on the demographics `userSessionId`. Only demographics records matched to *both* a CRT record and an RME record form a valid triplet.

A third quality column, `fp_crt_rme`, cross-validates the triplet by checking whether the CRT record's fingerprint matches the fingerprint embedded in the RME record. This check is independent of the matching process and catches cases where two different participants coincidentally shared the same `startAt`.

### Stage 2 — Match triplets to answer sessions

**Goal:** For each triplet, find the answers session that belongs to the same participant.

**Rationale:** Because `startAt` is the session origin, the last answer's `createdAt` is also close to the CRT `startAt`. The participant finishes rating statements, the browser records the last answer, and almost immediately the CRT page loads.

**Reference time:** The CRT `startAt` is used as the triplet's reference because CRT is the first individual component, making it temporally closest to the last answer.

**Cost function:**

```
cost(triplet_k, answers_l)  =  |CRT_startAt_k − last_answer_createdAt_l|  (seconds)
```

No fingerprint signal is available here (answer records do not embed prior responses).

---

## 7. Why the Hungarian Algorithm Over Greedy

The original `recover_demo.py` used a greedy nearest-neighbour approach: for each demographics record, find the closest CRT record, then deduplicate conflicts by keeping the pair with the smallest time difference. This is applied iteratively until no new matches are found.

**The core problem with greedy** is that a locally optimal pick can force a globally suboptimal outcome. Here is a minimal example:

```
Participant A  startAt = T + 0.00 s
Participant B  startAt = T + 0.15 s

CRT record X   startAt = T + 0.10 s   ← belongs to A
CRT record Y   startAt = T + 0.50 s   ← belongs to B
```

Each participant's CRT was submitted ~0.1 s after their session started.

| Pair  | Time diff |
|---|---|
| A → X | 0.10 s |
| A → Y | 0.50 s |
| B → X | **0.05 s** |
| B → Y | 0.35 s |

**Greedy behaviour:**

1. Compute closest CRT for every demo. Both A and B nominate X (A: 0.10 s, B: 0.05 s).
2. Conflict: two demos claim the same CRT. B wins because 0.05 s < 0.10 s. A is left unmatched this round.
3. Next iteration: A's only remaining option is Y (0.50 s). A → Y.

**Final greedy result:** A → Y, B → X — **both wrong**.

**Hungarian behaviour:** The algorithm minimises the *total* assignment cost:

| Assignment | Total cost                         |
|------------|------------------------------------|
| A→X, B→Y   | 0.10 + 0.35 = **0.45 s** ← chosen  |
| A→Y, B→X   | 0.50 + 0.05 = 0.55 s               |

**Final Hungarian result:** A → X, B → Y — **both correct**.

The greedy approach made a locally rational decision (B→X because 0.05 s < 0.10 s) that turned out to be globally harmful. The Hungarian algorithm sees the full picture at once and avoids this.

In a real batch Prolific study, many participants can start within seconds of each other. The larger the overlap among candidates, the more opportunities there are for greedy errors to **cascade**: a wrong pick in one pair propagates to the next, which propagates further. The Hungarian algorithm eliminates these cascades.

---

## 8. Windowed Processing

Building a cost matrix over all ~34,000 demographics records and ~36,000 CRT records at once would require a ~34,000 × 36,000 matrix (~10 billion entries), which is both too slow and too memory-intensive.

Instead, matching is done in **non-overlapping 1-hour time windows**:

1. All records are sorted by `startAt`.
2. Each window covers a 1-hour slice of anchor (`startAt`) timestamps.
3. Candidate targets are those whose `startAt` falls within `[window_start − threshold, window_end + threshold)`. The ±`threshold` fringe ensures records sitting just outside a window boundary can still be matched to anchors inside it.
4. A global `used_targets` set prevents a target near a window boundary from being claimed by two successive windows.
5. The Hungarian algorithm is applied to the small submatrix for each window.

Because `threshold = 5 s` is much smaller than the window width of `3600 s`, records from different windows can never compete for the same target. Within a typical 1-hour window the number of concurrent participants is small (median window: tens of records), so the submatrices are tiny and the solve is near-instantaneous.

```
Time →
|── window 0 (1 h) ──|── window 1 (1 h) ──|── window 2 (1 h) ──| …
     ↑ anchors here        ↑ anchors here
  [±5s fringe]          [±5s fringe]
  targets here          targets here
```

---

## 9. Output and Quality Metrics

The matching produces two CSV files in `demo_matches/`.

### `triplet_results_hungarian.csv`

One row per matched (Demo, CRT, RME) triplet.

| Column | Description |
|---|---|
| `demo` | `userSessionId` of the demographics record |
| `crt` | `userSessionId` of the matched CRT record |
| `rme` | `userSessionId` of the matched RME record |
| `diff_demo_crt_s` | `\|startAt_demo − startAt_crt\|` in seconds |
| `diff_demo_rme_s` | `\|startAt_demo − startAt_rme\|` in seconds |
| `fp_demo_crt` | `True` if demo's embedded CRT fingerprint matches the CRT record |
| `fp_demo_rme` | `True` if demo's embedded CRT fingerprint matches the RME record |
| `fp_crt_rme` | `True` if the CRT record's fingerprint matches the RME record's embedded CRT fingerprint (independent cross-check) |

### `all_matches_hungarian.csv`

One row per fully matched quintet (answers + CRT + RME + demographics). Includes all columns from the triplet file plus:

| Column | Description |
|---|---|
| `answers` | `userSessionId` of the matched answers session |
| `diff_answers_s` | `\|CRT_startAt − last_answer_createdAt\|` in seconds |
| `method` | `"hungarian"` (matched by this script) or `"common_id"` (matched by shared ID) |

### Interpreting quality flags

A high-confidence match has `diff_demo_crt_s` and `diff_demo_rme_s` both close to 0 (< 1 s is typical), `fp_crt_rme = True` (when fingerprints are non-empty — not applicable for `demographicsLongInternational`), and `diff_answers_s` close to 0.

The `fp_crt_rme` column is the most useful filter for auditing suspicious matches: if the CRT record and the RME record embedded opposite fingerprints, they almost certainly do not belong to the same person.

---

## 10. Known Limitations

1. **Concurrent batch launches.** If a large Prolific batch starts many participants simultaneously, multiple records from different participants can share very similar `startAt` values. Within a window, the Hungarian algorithm still finds the globally optimal assignment, but "optimal" is defined by total time difference — if two participants genuinely started at the same second, the assignment cannot be verified by timing alone. The fingerprint cross-check is the only additional safeguard in that case.

2. **`demographicsLongInternational` records.** These do not embed prior responses, so `fp_demo_crt`, `fp_demo_rme`, and `fp_crt_rme` are all `False` for those participants. They are matched on `startAt` only.

3. **Partial completers.** Participants who dropped out mid-survey leave orphan records (e.g., a CRT record with no corresponding demographics). These are not matched and are excluded from `all_matches_hungarian.csv`. The number of unmatched records is visible from the difference between total record counts and matched counts.

4. **`startAt` jitter.** The client-side timer is not perfectly synchronised with the server clock. Empirically, `startAt` values for the same participant agree within ~1 second. The matching threshold of 5 seconds is generous enough to absorb this jitter while still being tight enough to reject most false positives.
