# Commonsense Survey Explorer — Handoff Document

**Last updated:** 2026-06-29  
**Hosted at:** https://commonsense.seas.upenn.edu/report  
**Repo path:** `commonsense-data/.scripts/visualize/`

---

## 1. Project Goal

An interactive single-page visualization of the commonsense survey dataset. Built entirely with Python's stdlib `http.server` and Chart.js — no web framework, no build step. The server loads all data into memory at startup and computes scores on demand (with in-process caching).

The explorer has five tabs:

| Tab | What it shows |
|-----|---------------|
| **Statement Scores** | Commonsensicality score per statement, filterable by country group and 6 binary statement properties; sortable table with bar charts |
| **Individual Scores** | Per-user commonsensicality scores with target / reference country selection |
| **Design Points** | Average commonsensicality across all 64 property combinations (6 binary properties = 2⁶ combinations) |
| **Group Comparison** | Side-by-side histogram + scatter comparison between two country groups |
| **Countries** | Statement × country commonsensicality matrix; only cells with ≥ 10 ratings shown |

All scores are `commonsensicality = sqrt(consensus × awareness) × 100`, where:
- `consensus = 2 × |I_agree_mean − 0.5|`
- `awareness = others_agree_mean` if majority agree, else `1 − others_agree_mean`

---

## 2. File Structure

```
.scripts/visualize/
├── server.py               # HTTP server + all API endpoints (815 lines)
├── utils.py                # Score computation helpers
├── update-data.py          # Rebuilds data/ CSVs from raw source files
├── index.html              # Single-page app shell + all panel HTML
├── static/
│   ├── app.js              # All frontend logic (2,649 lines)
│   └── style.css           # All styles (1,401 lines)
├── data/                   # Pre-built CSVs (committed to git)
│   ├── answers.csv         # Updated nightly by CI
│   ├── crt_rme_demo.csv    # Updated nightly by CI
│   └── statement_properties.csv  # Static; 6 binary property columns per statement
├── Dockerfile
└── README.md               # Deployment instructions (EC2 + nginx)

commonsense-data/
└── statements/
    └── statements_1.csv    # Statement text; read at server startup via relative path
```

**Key path dependency:** `server.py` reads `statements_1.csv` from `../../statements/statements_1.csv` relative to its own location. If deploying only the `visualize/` subdirectory (not the full repo), set the env var `STATEMENTS_PATH=/path/to/statements_1.csv`.

---

## 3. Deployment

- **Host:** AWS EC2 behind nginx at `commonsense.seas.upenn.edu`
- **nginx config:** `/report/` proxies to `localhost:8080/` (strips the `/report/` prefix). A top-level `/api` location proxies to a *different* server (`localhost:4000`), so all API calls from the visualizer **must** use `/report/api/...` — not bare `/api/...`.
- **API base URL:** `app.js` computes `API` dynamically at line 10 from the `<script>` tag's own `src` attribute, so it automatically resolves to `/report/api` when served from `/report/static/app.js` and to `/api` in local dev. Any new `fetch()` calls must use `` `${API}/endpoint` `` — never a hardcoded `/api/` path.
- **Auto-reload:** Static files (JS, CSS, HTML) take effect immediately on hard-refresh — no server restart needed. Only changes to `server.py` or `utils.py` require a restart. Use `watchmedo auto-restart --patterns="*.py" --recursive -- python server.py` for dev.
- **Data updates:** `answers.csv` and `crt_rme_demo.csv` are rebuilt nightly by a GitHub Actions CI job that reads from an Amazon RDS database. `update-data.py` is **not** needed for normal hosting — only run it when the raw survey data pipeline changes.

---

## 4. Server API Endpoints

All under `/api/`:

| Endpoint | Params | Cache | Notes |
|----------|--------|-------|-------|
| `GET /api/countries` | — | yes | Sorted by participant count |
| `GET /api/statement-scores` | `country` | yes | Statement-level scores; `country=all` for global |
| `GET /api/scores` | `target`, `reference` | yes | Individual scores |
| `GET /api/design-points` | `country` | yes | 64 property combos |
| `GET /api/dp-statements` | `country`, prop flags | yes | Statements for one design point |
| `GET /api/group-compare` | `groupA`, `groupB` | yes | Distributions + scatter data |
| `GET /api/user-detail` | `userId`, `target`, `reference` | no | Per-statement detail for one user |
| `GET /api/statement-countries` | `statementId` | no | Top-5 countries by rating count |
| `GET /api/country-matrix` | — | yes (key `"v4"`) | Full statement × country matrix |
| `GET /api/country-cell` | `statementId`, `country` | no | Raw stats for one cell (modal) |

All numeric scores are 0–100 (percentage). Expensive endpoints are cached in-process as `dict` keyed by params after first computation.

---

## 5. Countries Panel — Architecture

This is the most recently built and most complex tab.

### Data flow

1. `GET /api/country-matrix` → `get_country_matrix()` in `server.py` (cache key `"v4"`)
2. Returns `{ countries: [...], country_n_statements: {...}, rows: [...] }`
3. Each row: `{ statementId, statement, scores: { country: {s?, n} }, sd, fact, physical, literal_language, positive, knowledge, everyday }`
   - Full cell (n ≥ 10): `{ s: <score 0–100>, n: <count> }`
   - Sub-threshold cell (1 ≤ n < 10): `{ n: <count> }` — **no `s` key**
   - Absent cell (n = 0): key not present in `scores` dict
   - `sd` = standard deviation of scores across countries for that statement
   - Property fields (`fact` etc.) = 0, 1, or null
4. Frontend stores in `countryMatrixData`; annotates `row._n = Object.values(row.scores).filter(e => e.s != null).length` — counts only fully-filled cells (n ≥ 10), not sub-threshold ones

### Cell rendering (three cases)

```javascript
if (entry != null && entry.s != null)   // full cell (n ≥ 10)
  → class cm-score-cell cm-score-cell-clickable  — shows score + "N = X"
else if (entry != null)                 // sub-threshold (1–9)
  → class cm-score-cell cm-score-cell-sub        — shows "N = X" only, not clickable
else                                    // absent (n = 0)
  → class cm-score-cell cm-score-cell-sub        — shows "N = 0", not clickable
```

Clicking a full cell calls `GET /api/country-cell?statementId=X&country=Y`. The endpoint returns `{"error": "not enough ratings"}` for n < 10 (click handler already guards on `cell.error`).

### Column headers

- **Country column** (`title` attribute): `"${countryName}, ${n_statements} statements"` — shown on hover
- **N column** (`title`): `"Number of countries that have at least 10 ratings for a statement"`
- **SD column** (`title`): `"Standard deviation of a statement's commonsensicality score among all applicable countries"`

### Sticky columns

Four columns are frozen on horizontal scroll via CSS `position: sticky`:

| Column | `left` offset | Width |
|--------|--------------|-------|
| `#` (rank) | 0px | 36px |
| Statement | 36px | 320px |
| *N* (country count) | 356px | 52px |
| *SD* | 408px | 64px |

`cm-table-wrap` is the **sole** scroll container (`overflow: auto; flex: 1; min-height: 0`). `#panelCountries .scores-wrap` has `overflow: hidden` — this is intentional and critical. If `.scores-wrap` gets `overflow-y: auto` back, the sticky columns break.

### Sorting

State: `cmSortKey` ('n' | 'stmt' | 'sd' | country-name), `cmSortDir` ('asc' | 'desc').  
Default: sort by *N* descending, tiebreaker SD descending.  
`getSortedCmRows()` operates on `getFilteredCmRows()` output.

### Search & filter

State: `cmSearchQuery` (string), `cmPropFilters` (same shape as `ssPropFilters`).  
`getFilteredCmRows()` applies property filters then text search against `row.statement`.  
HTML IDs for checkboxes: `cmFilter_<key>_1` and `cmFilter_<key>_0` (parallel to `ssFilter_*` in Statement Scores).  
The toolbar summary updates dynamically to show "X of Y statements" when filters are active.

### Cell click → modal

Clicking a score cell calls `GET /api/country-cell?statementId=X&country=Y`, which returns `{ statementId, statement, n_ratings, I_agree_mean, others_agree_mean }`. The existing `openStmtDetail(cell, country)` function is reused to render the modal.

---

## 6. Statement Properties

Six binary properties annotate every statement:

| Key | 1 | 0 |
|-----|---|---|
| `fact` | Fact | Opinion |
| `physical` | Physical | Social |
| `literal_language` | Literal language | Figure of speech |
| `positive` | Positive | Normative |
| `knowledge` | Knowledge | Reasoning |
| `everyday` | Everyday | Abstract |

`PROP_DEFS` in `app.js` (line 112) defines labels and hover-tooltip definitions. `applyPropFilters(rows, filters)` at line ~360 is shared logic used by both Statement Scores and Countries panels. The Countries panel has its own `cmPropFilters` state and `getFilteredCmRows()` — do not reuse `ssPropFilters`.

---

## 7. Key CSS Patterns

### `.scores-wrap` (all panels except Countries)
```css
padding: 16px max(20px, 12.5vw) 50vh;
```
`12.5vw` per side → ~75vw content width. The `50vh` bottom padding is needed for infinite-scroll feel but is overridden to `16px` on the Countries panel.

### Countries panel width system
- `.cm-table-wrap`: `max-width: 75%; margin: auto` — the scroll container
- `#panelCountries .search-filter-row, #panelCountries .table-nav-row`: `width: 75%; margin: auto` — matches table width
- Note: `width: 75%` (not `max-width`) is required for the flex children to actually stretch to that width

### Countries table vertical alignment

```css
.cm-table tbody td { vertical-align: bottom; }
```
This single rule applies to **all** body cells (rank, statement, N, SD, and score columns). It ensures the N line in sub-threshold and zero cells aligns with the N line in full score cells on the same row. **Do not put `vertical-align: bottom` on `.cm-score-cell` alone** — that misaligns the sticky columns against the score columns when statement text wraps to multiple lines.

### Bar charts in tables
- `#scoresTable .pct-track { max-width: 44px }` — Individual Scores
- `#stmtScoresTable .pct-track { max-width: 40px }` — Statement Scores
- `#stmtTable .pct-track { max-width: 65px }` — Statement Ratings modal (unchanged)
- `#dpDetailTable .pct-track { max-width: 50px }` — Design Points (unchanged)

### Country column headers
`.cm-country-th-inner` uses `align-items: flex-end` (right-aligned) to match the right-aligned numeric cells below.

---

## 8. Known Gotchas & Failed Attempts

### U+202F narrow no-break spaces in `app.js`
Template literals in `app.js` contain U+202F (narrow no-break space, `\xe2\x80\xaf`) instead of regular spaces in some `= ${...}` patterns (e.g. `N = ${fmtNum(entry.n)}`). The `Edit` tool cannot match these — it silently fails or errors. **Fix:** use a Python `content.find()` / `content.replace()` script for any edit touching those lines.

### `overflow: auto` on `.scores-wrap` breaks Countries panel
The CSS spec makes `overflow-x: auto` implicitly set `overflow-y: auto`. Combined with the `50vh` bottom padding, this caused only ~4 rows to be visible. The fix (already in place) is `#panelCountries .scores-wrap { overflow: hidden }` and making `cm-table-wrap` the sole scroll container.

### `vertical-align: bottom` must be on all `tbody td`, not just `.cm-score-cell`

An earlier attempt applied `vertical-align: bottom` only to `.cm-score-cell`. This caused the sticky rank/statement/N/SD columns to stay at `vertical-align: middle` (their default), producing visible misalignment on rows where statement text wraps. The fix is `.cm-table tbody td { vertical-align: bottom }` so all cells in a row share the same baseline.

### Alternating column shading — reverted
An attempt was made to alternate column background shading (like the Design Points table). It was reverted at the user's request. Do not re-introduce it.

### `max-width` vs `width` for flex children
Setting `max-width: 75%` on a flex child (e.g. `.search-filter-row`) does not force it to fill that width — the element sizes to its content. Must use `width: 75%` to actually stretch to that size.

### `cmPropFilters` declaration order
`cmPropFilters` uses `PROP_DEFS` (defined at line 112 in `app.js`). Must be declared **after** `PROP_DEFS`, not with the other country matrix state variables at the top of the file. Currently placed near `ssPropFilters` at line ~250.

### Country matrix cache key
Bump the cache key whenever the shape of the matrix payload changes — stale in-process cache will otherwise serve old data during a rolling restart.

| Key | When introduced | What changed |
| --- | --------------- | ------------ |
| `"v1"` | initial | — |
| `"v2"` | — | Added property columns (`fact`, `physical`, …) to each row |
| `"v3"` | 2026-06-29 | Added sub-threshold cells (`{"n": X}`, no `s`) to `scores` dict |
| `"v4"` | 2026-06-29 | Changed `MIN_RATINGS` from 5 to 10 |

Current key is **`"v4"`**. Next breaking change → use `"v5"`.

### `MIN_RATINGS` threshold — must stay in sync across files

The minimum-ratings threshold for a filled cell is defined in **three places**; they must always match:

| File | Location | Current value |
| ---- | -------- | ------------- |
| `server.py` | `get_country_matrix()` → `MIN_RATINGS` | 10 |
| `server.py` | `get_country_cell()` → `if len(sub) < 10` | 10 |
| `index.html` | toolbar label `"≥ 10 ratings shown"` | 10 |
| `app.js` | N column `title` attribute | 10 |

Note: the `MIN_RATINGS = 5` inside `get_user_detail()` and the `n >= 5` inside the Design Points functions are **separate thresholds for different panels** and should not be changed here.

---

## 9. Files In Flight (uncommitted changes as of 2026-06-29)

| File | Status | Notes |
|------|--------|-------|
| `.scripts/visualize/static/style.css` | Modified, not staged | See below |
| `.scripts/visualize/static/app.js` | Modified, not staged | See below |
| `.scripts/visualize/server.py` | Modified, not staged | See below |
| `.scripts/visualize/index.html` | Modified, not staged | Toolbar label updated to ≥ 10 |
| `.scripts/visualize/data/answers.csv` | Modified, not staged | Auto-updated by nightly CI — commit separately via CI workflow |
| `.scripts/visualize/data/crt_rme_demo.csv` | Modified, not staged | Same — CI-managed |

**`style.css` changes this session:**

- `padding: 16px max(20px, 12.5vw) 50vh` — content width widened from 15vw to 12.5vw per side
- `#scoresTable .pct-track { max-width: 44px }` — narrowed from 55px
- `#stmtScoresTable .pct-track { max-width: 40px }` — narrowed from 50px
- `.cm-table tbody td { vertical-align: bottom }` — new rule for Countries panel row alignment
- `.cm-country-th-inner { align-items: flex-end }` — right-aligns country column headers (was `center`)

**`app.js` changes this session:**

- Three-branch cell rendering (full / sub-threshold / zero) in `renderCmPage()`
- `row._n` now counts only `e.s != null` entries (excludes sub-threshold from N column)
- Country column header `title` now shows `"${name}, ${n} statements"`
- N column header `title` tooltip added
- SD column header `title` tooltip added

**`server.py` changes this session:**

- `get_country_matrix()`: `MIN_RATINGS` 5 → 10; computes `agg_all` before filtering; adds `sub_n_lookup` for 0 < n < 10 cells; cache key `"v2"` → `"v4"`
- `get_country_cell()`: threshold `< 5` → `< 10`

The following files were changed in prior sessions and **already committed**:

| File | Commit | Summary |
|------|--------|---------|
| `index.html`, `server.py`, `app.js`, `style.css` | `41318bd` | Added Countries panel (statement × country matrix) |
| `app.js` | `fd2d967` | Fixed hardcoded `/api/` → `${API}/` for `/report/` deployment |

**To commit for this session:** stage and commit the four source files together:
```
Countries panel: sub-threshold N display, MIN_RATINGS 5→10, header tooltips, alignment fixes
```

---

## 10. Suggested Next Steps

1. **Highlight cells by value** — add a color scale (e.g. cool-warm) to the Countries matrix cells so high/low commonsensicality is immediately visible without reading numbers.

2. **Row-level highlight on hover** — currently only individual cells highlight; highlighting the full row would help track across wide tables.

3. **Export / download** — a CSV download button for the filtered Countries table view would be useful for researchers.

4. **Paginate countries columns** — with 63 countries the table is very wide. An option to show/hide specific countries (or select a region subset) would improve usability.

5. **Statement detail modal improvement** — when clicking a country cell, the modal currently shows raw `I_agree_mean` and `others_agree_mean`. Adding a small bar chart similar to the Statement Scores modal (with consensus / awareness breakdown) would make it more consistent.

6. **Mobile / narrow viewport** — the current layout assumes a wide desktop screen. The `12.5vw` padding collapses to `20px` on mobile but the tables themselves are not responsive.

7. **Performance** — `get_country_matrix()` is slow on first load (several seconds). Consider pre-computing and writing to `data/country_matrix.json` as part of `update-data.py`, then just serving the file directly.
