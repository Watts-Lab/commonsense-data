# Commonsense Survey Explorer

An interactive visualization server for the commonsense survey dataset. Built with Python's standard `http.server` and Chart.js — no web framework required.

## Overview

The explorer opens on a **Home** page (what the survey asks, who took part, the two scores, design points and the LLM study, then one card per view). The **Test yourself** button in the top bar (and the other links to the survey) open the survey site, where a visitor rates statements themselves, in a new tab. There are six views, each reachable from the top bar and linked in order at the bottom of each view:

| Tab | What it shows |
|-----|---------------|
| **Individual Scores** | How commonsensical each participant is, scored against the majority of a chosen group ("Score participants from … against the majority in …"); the histogram marks the median |
| **Statement Scores** | How commonsensical each statement is among a chosen group's raters, searchable and filterable by the six statement features, with quick views (most shared, most divisive, most misjudged, rejected by most). A statement's modal shows how each country answered |
| **Design Points** | Mean commonsensicality of each of the 64 combinations of the six features, with 95% CIs, and the statements behind each |
| **Group Comparison** | Two countries side by side: participant scores, statement scores (also on the statements both scored), and the statements scored in both, with those whose two majorities point opposite ways marked and listed |
| **Countries** | One statement per row, its score (or the share who agree) in every country with at least 10 ratings, with a filter for statements whose countries' majorities differ |
| **LLM Evaluations** | Results of Nguyen, Watts & Whiting (2026), *PNAS Nexus*: 44 language models scored against 2,046 people as individual respondents and as simulated populations. Opens on an overview laid out like Home: a hero, then bands that each make one point: the core task (three cards to page through: a statement and its two questions, one person's answers, and one LLM's answers with the probability of yes behind each; each of the 2,046 people rated 50 statements, each of the 44 LLMs all 4,407), the paper's two main findings (as individuals, only 10 of 44 models score above the median person; as simulated crowds, the best correlates with people at r = .43, against .60 between two halves of people), each with one chart and a button into the story that works it through, and why it matters. Two views tell one model's score as a story that opens one step per click of a Next button fixed at the bottom of the window: as one more participant (one statement and its two questions, the model's answers checked against the people's majority, all statements, the geometric mean on the paper's level-curve chart, and head to head with one person, then every person, on each person's own 50 statements), and as a generator of a population (one statement scored among its raters and in the model's population, every statement counted and then plotted as people's score against the population's, with the best-fit line and the correlation, the split-half baseline recomputed live from two random halves of the people, plotted the same way, with r over 1,000 random splits, and the verdict). Under each story, a folded "Explore further" ranks every model (with model size, certainty and kinds of statements). A separate study with fixed data, so the date filter doesn't apply |

The **date filter** in the top bar (a button with presets and a custom range) limits every view except LLM Evaluations to ratings made in that range; participants are still compared with majorities computed from all dates. The Design Points view also links to three statement-generation pages (Design Point Coverage → Published Statement Audit → TypeSafe Judgments).

All scores are computed on-the-fly at request time and then cached in memory. The server has no database — it reads from CSV files at startup.

---

## File structure

```
visualize/
├── server.py               # HTTP server + API endpoints
├── utils.py                # Score computation (individual & statement)
├── update-data.py          # Builds data/ CSVs from raw source files
├── index.html              # Single-page app shell
├── static/
│   ├── app.js              # Frontend logic: routing, top bar, date filter, every panel but Home and LLM
│   ├── home.js, home.css   # Home (landing) page
│   ├── intro.js, intro.css # "About this …" intro cards at the top of the score panels
│   ├── llm.js, llm.css     # LLM Evaluations panel
│   ├── llm-evals-overview.svg
│   └── style.css
├── llm_evals.py            # Serves data/llm_evals/ (LLM Evaluations panel)
├── extract_llm_evals.py    # Writes data/llm_evals/ from the study's website
├── build_llm_leaderboard.py # Bootstrap intervals and feature gaps (offline; rerun after extract)
└── data/                   # Committed; update-data.py rebuilds answers.csv and crt_rme_demo.csv
    ├── answers.csv
    ├── crt_rme_demo.csv
    ├── statement_properties.csv
    └── llm_evals/          # Fixed LLM-evaluation snapshot (see extract_llm_evals.py)
```

The server also reads `../../statements/statements_1.csv` relative to its own location (i.e., `commonsense-data/statements/statements_1.csv`).

---

## Prerequisites

```
python >= 3.10
pandas
numpy
scipy          # optional — falls back to a lookup table for t-critical values
```

Install with:

```bash
pip install pandas numpy scipy
```

---

## Local development

### 1. Build the data files

From inside `visualize/`, run:

```bash
python update-data.py
```

This reads from:
- `../../individuals/` — CRT, RME, and demographics CSVs
- `../../answers/` — per-user statement ratings
- `../../demo_matches/all_matches_hungarian.csv` — pre-computed ID matches from the Hungarian algorithm

And writes:
- `data/answers.csv`
- `data/crt_rme_demo.csv`

> **Note:** The Hungarian matching step has already been run and its output is committed to the repository. `update-data.py` only needs to be re-run when the raw survey data changes (i.e., when new participants complete the survey).

### 2. Start the server

```bash
python server.py          # defaults to port 8080
python server.py 9000     # custom port
```

Then open [http://localhost:8080](http://localhost:8080).

The server loads all data into memory on startup and prints a summary:

```
Loading data…
Ready — 35,717 participants, 3,241,504 answers, 10,000 statements, 55 countries.
Open http://localhost:8080
```

---

## Deployment

The server is a Python process that must stay running. It cannot be deployed to GitHub Pages directly, which only serves pre-built static files. Two practical options are described below.

---

### Option A: Amazon EC2 (recommended for dynamic serving)

This runs `server.py` as a persistent process on an EC2 instance and is the most direct path.

#### Initial setup

1. Launch an EC2 instance (e.g., `t3.small` or larger, Amazon Linux 2023 or Ubuntu).
2. Clone the repository and install dependencies:

   ```bash
   git clone <repo-url> commonsense-data
   cd commonsense-data/.scripts/visualize
   pip install pandas numpy scipy
   python update-data.py
   ```

3. Run the server, binding to all interfaces:

   ```bash
   python server.py 8080
   ```

4. Open port 8080 (or 80/443) in the instance's security group.

#### Keeping the server running with systemd

Create `/etc/systemd/system/commonsense.service`:

```ini
[Unit]
Description=Commonsense Survey Explorer
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/commonsense-data/.scripts/visualize
ExecStart=/usr/bin/python3 server.py 8080
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable commonsense
sudo systemctl start commonsense
```

#### Serving via nginx (optional, for HTTPS or a subdomain)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;   # score computation can take a few seconds
    }
}
```

#### Updating data automatically

When the GitHub Actions workflow commits new data (see [CI section](#cicd-with-github-actions) below), the EC2 instance needs to pull the latest commit and regenerate `data/`. The simplest approach is a deploy webhook or a scheduled pull:

```bash
# /home/ec2-user/refresh.sh
#!/bin/bash
set -e
cd /home/ec2-user/commonsense-data
git pull
cd .scripts/visualize
python update-data.py
sudo systemctl restart commonsense
```

Add to crontab to run shortly after the nightly CI commit (e.g., 01:00 UTC):

```cron
0 1 * * * /home/ec2-user/refresh.sh >> /home/ec2-user/refresh.log 2>&1
```

---

### Option B: GitHub Pages (static pre-computation)

GitHub Pages cannot run Python, but all API responses can be pre-computed and saved as static JSON files. The frontend already fetches data via `fetch('/api/...')` — those paths just need to point to static files instead.

This approach requires a **build step** added to the GitHub Actions workflow that:

1. Runs `update-data.py` to build the data CSVs.
2. Runs a build script that calls every server endpoint and writes the responses as `.json` files.
3. Deploys `index.html`, `static/`, and the pre-computed JSON directory to GitHub Pages.

#### Build script sketch (`build_static.py`)

```python
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))

# Monkey-patch server helpers to run without an HTTP server
import server as srv

os.makedirs("public/api", exist_ok=True)

# Countries
with open("public/api/countries", "wb") as f:
    f.write(srv.COUNTRIES_JSON)

countries = ["all"] + [c["country"] for c in json.loads(srv.COUNTRIES_JSON)]

# Statement scores, design points
for c in countries:
    safe = c.replace(" ", "_").replace("/", "-")
    with open(f"public/api/statement-scores?country={safe}", "wb") as f:
        f.write(srv.get_statement_scores(c))
    with open(f"public/api/design-points?country={safe}", "wb") as f:
        f.write(srv.get_design_points(c))

# Individual scores (target × reference)
for target in countries:
    for ref in countries:
        ts = target.replace(" ", "_"); rs = ref.replace(" ", "_")
        with open(f"public/api/scores?target={ts}&reference={rs}", "wb") as f:
            f.write(srv.get_scores(target, ref))
```

> **Note:** With ~55 countries the scores endpoint produces ~3,000 combinations. Pre-computation will take several minutes and generate a large number of files. Consider limiting combinations (e.g., skip target × reference pairs where the reference is not "all countries") if build time or repository size becomes a concern.

The frontend `app.js` fetch URLs would also need updating (`/api/scores?target=...` → `/api/scores%3Ftarget=...` or a path-based scheme), which requires minor URL-rewriting logic in the JS.

---

## CI/CD with GitHub Actions

The repository already has a workflow at `.github/workflows/pull-data.yml` that runs nightly (00:00 UTC) to pull fresh data from the Amazon RDS database and commit it.

To add the visualization data build to that workflow, append the following step **after** the existing `Commit data changes` step:

```yaml
- name: Build visualize data
  run: |
    cd .scripts/visualize
    python update-data.py
    git add data/
    git diff --cached --quiet || git commit -m "Rebuild visualize data at $(date)"
    git push || echo "No changes to push"
```

For **GitHub Pages deployment**, also add:

```yaml
- name: Prepare visualize for Pages
  run: |
    mkdir -p public
    cp .scripts/visualize/index.html public/
    cp -r .scripts/visualize/static public/
    cd .scripts/visualize && python build_static.py

- name: Deploy visualize to GitHub Pages
  uses: peaceiris/actions-gh-pages@v3
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./public
    force_orphan: true
```

For **EC2 deployment**, trigger a remote rebuild via SSH after the data commit:

```yaml
- name: Deploy to EC2
  uses: appleboy/ssh-action@v1
  with:
    host: ${{ secrets.EC2_HOST }}
    username: ec2-user
    key: ${{ secrets.EC2_SSH_KEY }}
    script: /home/ec2-user/refresh.sh
```

Add `EC2_HOST` and `EC2_SSH_KEY` as repository secrets.

---

## API reference

All endpoints are served under `/api/` and respond with JSON.

| Endpoint | Parameters | Description |
|----------|-----------|-------------|
| `GET /api/countries` | — | Sorted list of countries with participant counts |
| `GET /api/home-summary` | — | Everything the Home page shows besides the map: totals, share of participants by country, score medians and the participant histogram, example statements, feature gaps and the highest- and lowest-scoring design points. Read back from the scores, statement-scores and design-points endpoints; precomputed for all dates at startup |
| `GET /api/statement-scores` | `country` | Statement-level commonsensicality scores |
| `GET /api/scores` | `target`, `reference` | Individual commonsensicality scores |
| `GET /api/design-points` | `country` | Scores aggregated by the 64 property combinations |
| `GET /api/dp-statements` | `country`, property flags | Statements for one design point |
| `GET /api/group-compare` | `groupA`, `groupB` | Side-by-side individual + statement comparison; `paired` rows carry both groups' scores, shares who agree and majorities |
| `GET /api/user-detail` | `userId`, `target`, `reference` | Statement-level detail for one participant, with whether each statement counts and the reference majority (`counted`, `ref_majority`) |
| `GET /api/statement-countries` | `statementId` | Every country that rated a statement, most ratings first: count, shares who agree and think most agree, majority (`maj`) and, with 10+ ratings, that country's score |
| `GET /api/country-matrix` | — | Every statement's cell per country (Countries panel): score `s` and share who agree `a` (both 0–100) with 10+ ratings, else only the count `n` |
| `GET /api/country-cell` | `statementId`, `country` | One cell's count and shares, for its worked calculation |
| `GET /api/statement-meta` | `statementId` | Source and category of a statement, from `statements_1.csv` |
| `GET /api/statement-audit` | — | Judge agreement with published statements' stored labels, per design point |
| `GET /api/statement-audit-statements` | property flags, `metric` | Published statements for one design point, with every judge's answer |
| `GET /api/llm-evals` | — | Every model's scores as an individual (consensus, awareness, commonsensicality and the share of participants beaten, recomputed exactly from its ratings), its yes/no cross-tabs with the majority (`tab`), head-to-head counts (`head`), scores by feature (`by_feature`), P(yes) histograms (`hist`) and tie counts, its score as a population (Pearson `r`, `r_p`, `r_sig`, `mae`, `features`), its metadata (`organization`, `access`, `released`, `params_b`, `size_family`, `method`) and bootstrap intervals (`ci`); the participants' percentiles (`human_reference`) and statement-level summaries (`humans`); the worked examples (`examples`); the participants' split-half benchmark over 1,000 random splits (`split_half`: mean r, its 95% range and every split's r, `rs`); the out-of-sample R² of people's statement scores on every model's crowd together and on a few single crowds (`ensemble`, 50-fold, as the paper computes it); the number of tests behind `r_sig`'s Bonferroni correction (`n_tests`, one per model); the paper's quoted figures (`paper`), plus every participant's scores and how many of their 50 statements are written around stand-in names ("If max helps sam …") |
| `GET /api/llm-evals/statements` | — | Every LLM-study statement as compact rows (`fields`): text, source, category, properties, participants' shares answering yes and their counts, their score, the median across models, how many models answer yes, and whether it is written around stand-in names (`placeholder`, which the stories never pick as examples) |
| `GET /api/llm-evals/model` | `id` | One model's P(yes) to both questions and its population's score, per statement, and its score on each participant's own statements (`vs`) |
| `GET /api/llm-evals/statement` | `id` | One statement's score among participants and in every model's population, and every model's P(yes) |
| `GET /api/llm-evals/participant` | `id` | One participant's 50 answers |
| `GET /api/llm-evals/split` | `seed` (0–999), `statement` | One random split of the participants into halves A and B: the correlation between the halves' statement scores (`r`, over the `n_used` statements both halves rated), every statement's score in each half (`scores.a`, `scores.b`, in statement-id order, `null` where a half has no rater), and the statement's raters in each half as `[I_agree, others_agree]` pairs (`example`) |

Use `country=all` (or `target=all` / `reference=all`) to include all countries.

All numeric scores are in `[0, 1]`. Expensive endpoints (scores, group-compare) are cached in memory after the first request.

---

## Data pipeline summary

```
Amazon RDS  ──► pull_data.py  ──► individuals/, answers/   (daily via GitHub Actions)
                                        │
                                  update-data.py
                                        │
                              data/answers.csv
                              data/crt_rme_demo.csv
                                        │
                                   server.py
                                        │
                              http://localhost:8080
```

`update-data.py` performs the following steps:
1. Reads CRT, RME, and demographics records from `individuals/`.
2. Reads answer records from `answers/`.
3. Joins users matched by the Hungarian algorithm (`demo_matches/all_matches_hungarian.csv`) with users whose session IDs were consistent across all four record types.
4. Writes the final `answers.csv` and `crt_rme_demo.csv` into `data/`.

Only users who appear in **all four** record types (answers, CRT, RME, demographics) are included.
