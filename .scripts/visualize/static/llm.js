"use strict";

// ══ LLM Evaluations panel ══════════════════════════════════════════════════
// Results of Nguyen, Watts & Whiting (2026), PNAS Nexus, from a fixed snapshot
// that llm_evals.py serves at /api/llm-evals*. Loaded after app.js and uses
// its globals: API, MOUNT_PATH, TAB_SLUGS, PAGE_SIZE, PROP_DEFS, esc, fmtNum,
// fmtPct, fixStatement, applyPropFilters, mirrorPager. home.js
// reads the summary through llmGet() and llmSummaryStats() and links into a
// view with llmShowView().
//
// Three views share one model selection, kept in the URL (?view=…&model=…):
// - Overview: laid out like Home, a hero and bands that each make one point:
//   how the study works (the statements, the two questions, a person's and
//   an LLM's answers, a summary), the two main findings as Home section 5
//   draws them, and why it matters (llmRenderLanding).
// - LLMs as individuals: one model's score told as a story in six chapters
//   that open one click of Next at a time: the model's answers to one
//   statement, all statements and its score, and the model head to head
//   with each person on that person's own 50 statements
//   (llmRenderIndividual).
// - LLMs as populations: the same for a model read as a generator of a
//   population: one statement scored in both populations, every statement
//   counted and plotted (people's score against the population's) with the
//   best-fit line and r, the split-half baseline (two random halves of the
//   people, from /api/llm-evals/split, plotted the same way, and r over 1,000
//   splits) and the verdict (llmRenderPopulation).
// (The Statements and Participants views were removed at Josh's request;
// the statement and participant modals stay, opened from the stories.)
// Scores arrive as 0-1 and are shown as percentages. People are blue and
// models orange, proprietary models striped (llmModelCls()). All 44 models
// are one set: every rank, count and average is over all of them.

// Tokens, not resolved colours, so the charts follow a theme change
const LLM_HUMAN = "var(--c-agree)";    // people (the app's blue)
const LLM_MODEL = "var(--c-expect)";   // models
const LLM_VIEWS = ["overview", "individual", "population"];
const LLM_PROP_SHORT = { literal_language: ["Literal", "Figurative"] }; // as the other filters word it
// The paper's examples: the models in its SI histogram of P(yes), and the
// five populations of Fig. 3C
const LLM_CERTAINTY_MODELS = ["gpt-3.5-turbo-0125", "gpt-4o-2024-05-13", "claude-3-opus", "gemini-pro", "google--flan-t5-xxl"];
const LLM_FEATURE_MODELS = ["tiiuae--falcon-180B-chat", "google--flan-t5-xxl", "claude-3-opus", "gemini-pro", "gpt-4o-2024-05-13"];

const LLM = {
  data: null,           // summary + statements, prepared by llmPrepare()
  view: "overview",
  model: null,          // selected model id
  featModel: null,     // the features card's model: the story's, until one is picked there
  // The individual story: how far it has got (stage, see LLM_IND_OPEN), the
  // model's statement in chapter 1 (ex), the person in chapter 4 and the one
  // of their statements it shows (pex), and which of chapter 2's two counts
  // have finished (ran.c, the model's own opinions; ran.a, its predictions)
  ind: { stage: 0, ex: null, person: null, personRatings: null, pex: null, ran: { c: false, a: false }, order: null },
  // The population story: its stage (see LLM_POP_OPEN), statement, chapter
  // 7's split (seed) and the splits seen so far, busy while a split loads,
  // which of chapter 5's two counts have finished (ran.h, people's scores;
  // ran.m, the model's population's), the stage whose plot is drawing
  // (anim), and the order statements are counted and plotted in
  pop: { stage: 0, ex: null, seed: 0, split: null, splits: [], busy: false, ran: { h: false, m: false }, anim: null, order: null },
  tables: {},
  renderSeq: 0,         // drops a model render superseded by a newer one
  pendingAt: null,      // a card to scroll to once the view draws (llmShowView)
};

// ── Data ────────────────────────────────────────────────────────────────────

const _llmRequests = {};
// Cached GET under /api; a failed request is retried on the next call
function llmGet(path) {
  if (!_llmRequests[path]) {
    _llmRequests[path] = fetch(`${API}${path}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        delete _llmRequests[path];
        throw err;
      });
  }
  return _llmRequests[path];
}

function llmQuantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Ranks and the participants' spread, shared with home.js
function llmSummaryStats(summary) {
  const models = summary.models.map((m) => ({ ...m, scores: [m.consensus, m.awareness, m.commonsensicality] }));
  // Rank as an individual: by the share of people it beats on their own 50
  // statements (the leaderboard's order), ties by commonsensicality
  [...models].sort((a, b) => b.human_percentile - a.human_percentile || b.commonsensicality - a.commonsensicality)
    .forEach((m, i) => { m.rankInd = i + 1; });
  [...models].sort((a, b) => (b.r ?? -2) - (a.r ?? -2)).forEach((m, i) => { m.rankR = i + 1; });
  // placeholder: how many of the person's 50 statements use a stand-in name
  // ("If max helps sam …"); the stories avoid showing those
  const participants = summary.participants.map(([id, consensus, awareness, cs, placeholder]) => ({ id, scores: [consensus, awareness, cs], placeholder: placeholder ?? 0 }));
  const sorted = [0, 1, 2].map((k) => participants.map((p) => p.scores[k]).sort((a, b) => a - b));
  const rs = models.map((m) => m.r).filter((r) => r !== null).sort((a, b) => a - b);
  return {
    ...summary,
    models,
    participants,
    humanMedian: llmQuantile(sorted[2], 0.5),
    humanP10: llmQuantile(sorted[2], 0.1),
    humanP90: llmQuantile(sorted[2], 0.9),
    medianR: llmQuantile(rs, 0.5),
  };
}

function llmPrepare(summary, stmts) {
  const d = llmSummaryStats(summary);
  d.modelById = new Map(d.models.map((m) => [m.id, m]));
  d.byName = [...d.models].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  d.sources = stmts.sources;
  d.categories = stmts.categories;
  d.statements = stmts.rows.map((row) => {
    const s = {};
    stmts.fields.forEach((key, i) => { s[key] = row[i]; });
    s.source = stmts.sources[s.source];
    s.category = stmts.categories[s.category];
    stmts.properties.forEach((key, i) => { s[key] = s.props[i]; }); // for applyPropFilters
    s.raw = s.text;  // as it was put to the models
    s.text = fixStatement(s.text);
    s.lower = s.text.toLowerCase();
    s.majority = s.I_agree >= 0.5 ? 1 : 0; // ties count as agree, as in the paper
    return s;
  });
  const ns = d.statements.map((s) => s.n);
  d.ratersMin = Math.min(...ns);
  d.ratersMax = Math.max(...ns);
  d.ratersMean = ns.reduce((a, b) => a + b, 0) / ns.length;
  d.participantById = new Map(d.participants.map((p) => [p.id, p]));
  return d;
}

function llmModel(id = LLM.model) {
  return LLM.data && LLM.data.modelById.get(id);
}

// ── Formatting ──────────────────────────────────────────────────────────────

// A P(yes) as a percentage; values just under 50% (a no) never read as 50.0%
function llmProb(v) {
  return v < 0.5 && v >= 0.4995 ? "49.9%" : v >= 0.5 && v < 0.5005 && v !== 0.5 ? "50.0%" : llmPctFine(v);
}

// A 0-1 share as a percentage. Within 0.05 points of either end it shows two
// decimals (99.96%, not 100.0%), so a share that is not quite all or none
// reads that way; closer than 0.005 points it rounds to 100.0% or 0.0%.
function llmPctFine(v) {
  const s = (v > 0.9995 && v < 1) || (v > 0 && v < 0.0005) ? (v * 100).toFixed(2) : null;
  return s && s !== "100.00" && s !== "0.00" ? `${s}%` : fmtPct(v);
}

// A correlation without its leading zero, as quantities bounded by 1 are
// written: .43, −.13 (dp decimals)
function llmR(v, dp = 2) {
  if (v === null || v === undefined) return "—";
  return `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp).replace(/^0(?=\.)/, "")}`;
}

// An r axis tick: 0, .2, .4, −.2
function llmRTick(v) {
  return Math.abs(v) < 1e-9 ? "0" : llmR(v, 1);
}

// A 0-1 difference as signed percentage points
function llmPts(v, dp = 1) {
  const p = v * 100, eps = 0.5 * 10 ** -dp;
  return `${p >= eps ? "+" : p <= -eps ? "−" : ""}${Math.abs(p).toFixed(dp)}`;
}

function llmOrdinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${s}`;
}

// "0.7252" for a 0-1 value shown in a calculation
function llmDec(v, dp = 4) {
  return v.toFixed(dp);
}

// A p-value, also without the leading zero: <.001, .03
function llmP(v) {
  return v < 0.0005 && v > 0 ? "<.001" : (v < 0.01 ? v.toFixed(3) : v.toFixed(2)).replace(/^0(?=\.)/, "");
}

function llmCount(n, one, many = `${one}s`) {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

const LLM_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function llmMonth(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return `${LLM_MONTHS[m - 1]} ${y}`;
}

function llmAccessLabel(m) {
  return m.access === "open" ? "Open weights" : m.access === "proprietary" ? "Proprietary" : "";
}

function llmName(m) {
  return esc(m.name);
}

// Bar class for a model: open-weight solid, proprietary striped
function llmModelCls(m) {
  return m.access === "proprietary" ? "is-prop" : "is-open";
}

// "agrees" / "disagrees" for a 1 / 0 answer
function llmAgrees(v) {
  return v ? "agrees" : "disagrees";
}

// Yes or No in plain ink: whether it matches the majority is a mark beside
// it (llmMatch). Every answer, and every majority, reads Yes or No, so the
// two can be compared at a glance (never "Yes" against "Agree").
function llmYesNo(v) {
  return `<span class="llm-yn">${v ? "Yes" : "No"}</span>`;
}

// ✓ or ✗ against the majority: a small glyph, no badge
function llmMatch(ok) {
  return ok
    ? '<span class="llm-match ok" title="Matches most people">✓</span>'
    : '<span class="llm-match no" title="Differs from most people">✗</span>';
}

// An answer and its mark, as the stories' answer grids show it
function llmAnswer(v, maj) {
  return `<span class="llm-answer">${llmYesNo(v)}${maj === undefined ? "" : llmMatch(v === maj)}</span>`;
}

function llmHelp(label, def) {
  return `<button class="prop-help-btn" type="button" data-col-label="${esc(label)}" data-col-def="${esc(def)}">?</button>`;
}

// A 0-1 value as a bar in the participants' (human) or the model's colour
function llmBar(v, kind = "human") {
  return (
    `<div class="pct-wrap"><div class="pct-track"><div class="llm-fill-${kind}" style="width:${(v * 100).toFixed(1)}%"></div></div>` +
    `<span class="pct-label">${fmtPct(v)}</span></div>`
  );
}

// Splits a statement into tooltip lines
function llmWrap(text, width = 56) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

// ── Bar lists ───────────────────────────────────────────────────────────────
// The panel's ranked charts are HTML rows: a label, a bar on a shared scale
// and the value, so every name stays readable and every row is clickable.
// A scale is {min, max, ticks, fmt}; reference lines ({x, cls}) run through
// every row at the same position, labelled once in the axis row.

function llmPos(x, s) {
  return Math.max(0, Math.min(100, ((x - s.min) / (s.max - s.min)) * 100));
}

function llmTrack(v, s, cls = "", refs = []) {
  const z = llmPos(Math.max(s.min, Math.min(s.max, 0)), s), p = llmPos(v, s);
  return (
    `<div class="llm-track">` +
    refs.map((r) => `<span class="llm-ref ${r.cls || ""}" style="left:${llmPos(r.x, s).toFixed(2)}%"></span>`).join("") +
    (s.min < 0 ? `<span class="llm-ref is-zero" style="left:${z.toFixed(2)}%"></span>` : "") +
    `<span class="llm-fill ${cls}" style="left:${Math.min(z, p).toFixed(2)}%;width:${Math.abs(p - z).toFixed(2)}%"></span></div>`
  );
}

// The axis row: ticks along the bottom, reference labels above their lines
function llmAxis(s, refs = []) {
  return (
    `<div class="llm-axis" aria-hidden="true">` +
    refs.filter((r) => r.label).map((r) => {
      const p = llmPos(r.x, s);
      return `<span class="llm-axis-ref ${r.cls || ""}${p > 70 ? " is-right" : ""}" style="left:${p.toFixed(2)}%">${r.label}</span>`;
    }).join("") +
    s.ticks.map((t) => {
      const p = llmPos(t, s);
      const minor = s.minor && s.minor.includes(t) ? " is-minor" : "";
      return `<span class="llm-tick${p < 1 ? " is-first" : p > 99 ? " is-last" : ""}${minor}" style="left:${p.toFixed(2)}%">${s.fmt(t)}</span>`;
    }).join("") +
    `</div>`
  );
}

const LLM_PCT_SCALE = { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => `${Math.round(v * 100)}%` };

// A row's attributes when it opens a model
function llmRowOpen(m, view) {
  return ` data-model="${esc(m.id)}" data-open="${view}" role="button" tabindex="0" aria-label="${esc(`${m.name}: work through it step by step`)}"`;
}

// ── Charts ──────────────────────────────────────────────────────────────────


// ── Tables ──────────────────────────────────────────────────────────────────
// A sortable, filterable, paginated table built from the app's own table
// classes. cfg: columns [{key, label, cls, value(row), html(row), help}],
// rows() (the unfiltered rows), sort {key, dir}, search {placeholder,
// match(row, q)}, selects [{key, label, options [[value, text]], pred(row,
// value)}], props (statement property filter), onRow(row), noun
// ("statements"), pageSize (default PAGE_SIZE).

function llmPropFilterHtml() {
  return (
    `<div class="prop-filter-panel"><button class="prop-filter-toggle" type="button" aria-expanded="false">` +
    `<span class="prop-filter-arrow">▶</span> Filter by features</button><div class="prop-filter-grid hidden">` +
    PROP_DEFS.map((d) => {
      const [v1, v0] = LLM_PROP_SHORT[d.key] || [d.v1, d.v0];
      return (
        `<div class="prop-filter-row"><div class="prop-filter-label-cell"><span class="prop-filter-row-label">${esc(v1)} or ${esc(v0)}?</span>` +
        `<button class="prop-help-btn" type="button" data-prop-key="${d.key}">?</button></div>` +
        `<label class="prop-opt"><input type="checkbox" data-prop="${d.key}" data-v="1"> ${esc(v1)}</label>` +
        `<label class="prop-opt"><input type="checkbox" data-prop="${d.key}" data-v="0"> ${esc(v0)}</label></div>`
      );
    }).join("") +
    `</div></div>`
  );
}

function llmTable(root, cfg) {
  const t = {
    page: 1, q: "", sort: { ...cfg.sort }, selects: {}, extra: null, view: [],
    props: Object.fromEntries(PROP_DEFS.map(({ key }) => [key, { v1: false, v0: false }])),
  };
  root.innerHTML =
    `<div class="llm-table-controls">` +
    (cfg.search ? `<input type="search" class="stmt-search-input" data-role="search" placeholder="${esc(cfg.search.placeholder)}" autocomplete="off" aria-label="${esc(cfg.search.placeholder)}">` : "") +
    (cfg.selects || []).map((s) =>
      `<select class="select" data-select="${s.key}" aria-label="${esc(s.label)}">` +
      s.options.map(([v, text]) => `<option value="${esc(v)}">${esc(text)}</option>`).join("") + `</select>`,
    ).join("") +
    `</div>` +
    (cfg.props ? llmPropFilterHtml() : "") +
    `<div class="table-nav-row"><span class="scores-filter-label" data-role="label"></span>` +
    `<p class="click-hint">${esc(cfg.hint || "Click a row to explore more.")}</p>` +
    `<div class="pagination"><button class="page-btn" data-role="prev" aria-label="Previous page">&#8249;</button>` +
    `<span class="page-info" data-role="info"></span>` +
    `<button class="page-btn" data-role="next" aria-label="Next page">&#8250;</button></div></div>` +
    `<div class="table-scroll-wrap"><table class="llm-table${cfg.cls ? ` ${cfg.cls}` : ""}"><thead><tr></tr></thead><tbody></tbody></table></div>`;
  const $ = (sel) => root.querySelector(sel);
  const thead = $("thead tr"), tbody = $("tbody"), wrap = $(".table-scroll-wrap");
  mirrorPager($(".pagination"), wrap); // app.js: a second pager under the table

  const filtered = () => {
    let rows = cfg.rows();
    if (t.q && cfg.search) rows = rows.filter((r) => cfg.search.match(r, t.q));
    for (const s of cfg.selects || []) {
      if (t.selects[s.key]) rows = rows.filter((r) => s.pred(r, t.selects[s.key]));
    }
    if (cfg.props) rows = applyPropFilters(rows, t.props);
    if (t.extra) rows = rows.filter(t.extra.pred);
    const col = cfg.columns.find((c) => c.key === t.sort.key);
    if (col && col.value) {
      const dir = t.sort.dir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const va = col.value(a), vb = col.value(b);
        if (va === vb) return 0;
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return typeof va === "string" ? dir * va.localeCompare(vb) : dir * (va - vb);
      });
    }
    return rows;
  };

  t.refresh = (resetPage = false) => {
    if (resetPage) t.page = 1;
    const rows = filtered();
    t.rows = rows;
    const size = cfg.pageSize || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    t.page = Math.min(t.page, pages);
    thead.innerHTML = cfg.columns.map((c) => {
      const label = typeof c.label === "function" ? c.label() : c.label;
      const active = c.key === t.sort.key;
      return c.value
        ? `<th class="${c.cls || ""} sortable${active ? " sort-active" : ""}" data-sort="${c.key}">${label}` +
          `${c.help ? ` ${llmHelp(typeof c.helpLabel === "function" ? c.helpLabel() : c.helpLabel || label, typeof c.help === "function" ? c.help() : c.help)}` : ""}` +
          ` <span class="sort-icon">${active ? (t.sort.dir === "asc" ? "▲" : "▼") : ""}</span></th>`
        : `<th class="${c.cls || ""}">${label}</th>`;
    }).join("");
    const start = (t.page - 1) * size;
    t.view = rows.slice(start, start + size);
    tbody.innerHTML = t.view.length
      ? t.view.map((r, i) =>
          `<tr data-i="${i}"${cfg.onRow ? ' class="llm-row-link"' : ""}>` +
          cfg.columns.map((c) => `<td class="${c.tdCls || ""}">${c.html(r, start + i)}</td>`).join("") + `</tr>`,
        ).join("")
      : `<tr><td colspan="${cfg.columns.length}" class="empty-row">No ${cfg.noun || "rows"} match these filters.</td></tr>`;
    const noun = cfg.noun || "rows", total = cfg.rows().length;
    $('[data-role="label"]').textContent = t.extra
      ? `${t.extra.label} · ${fmtNum(rows.length)} of ${fmtNum(total)} ${noun} · click the bar again to clear`
      : rows.length < total
        ? `${fmtNum(rows.length)} of ${fmtNum(total)} ${noun}`
        : `${fmtNum(rows.length)} ${noun}`;
    $('[data-role="info"]').textContent = `Page ${fmtNum(t.page)} of ${fmtNum(pages)}`;
    $('[data-role="prev"]').disabled = t.page <= 1;
    $('[data-role="next"]').disabled = t.page >= pages;
  };
  t.setSelect = (key, value) => {
    t.selects[key] = value;
    const sel = root.querySelector(`select[data-select="${key}"]`);
    if (sel) sel.value = value;
    t.refresh(true);
  };

  thead.addEventListener("click", (e) => {
    if (e.target.closest(".prop-help-btn")) return;
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (t.sort.key === th.dataset.sort) t.sort.dir = t.sort.dir === "asc" ? "desc" : "asc";
    else t.sort = { key: th.dataset.sort, dir: "desc" };
    t.refresh(true);
  });
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (tr && cfg.onRow) cfg.onRow(t.view[Number(tr.dataset.i)]);
  });
  $('[data-role="prev"]').addEventListener("click", () => { t.page--; t.refresh(); revealTableTop(root); });
  $('[data-role="next"]').addEventListener("click", () => { t.page++; t.refresh(); revealTableTop(root); });
  const search = $('[data-role="search"]');
  if (search) {
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { t.q = search.value.trim().toLowerCase(); t.refresh(true); }, 150);
    });
  }
  root.querySelectorAll("select[data-select]").forEach((sel) =>
    sel.addEventListener("change", () => { t.selects[sel.dataset.select] = sel.value; t.refresh(true); }),
  );
  if (cfg.props) {
    const toggle = root.querySelector(".prop-filter-toggle");
    toggle.addEventListener("click", () => {
      const panel = toggle.closest(".prop-filter-panel");
      const grid = panel.querySelector(".prop-filter-grid");
      const opening = grid.classList.contains("hidden");
      grid.classList.toggle("hidden", !opening);
      panel.classList.toggle("is-open", opening);
      toggle.setAttribute("aria-expanded", String(opening));
    });
    root.querySelectorAll("input[data-prop]").forEach((box) =>
      box.addEventListener("change", () => {
        t.props[box.dataset.prop][box.dataset.v === "1" ? "v1" : "v0"] = box.checked;
        t.refresh(true);
      }),
    );
  }
  return t;
}

// Select filters shared by every statement table
function llmStatementSelects(show) {
  const d = LLM.data;
  return [
    { key: "show", label: "Show", options: show.map(([v, text]) => [v, text]), pred: (r, v) => show.find((s) => s[0] === v)[2](r) },
    { key: "source", label: "Source", options: [["", "All sources"], ...d.sources.map((s) => [s, llmSourceName(s)])], pred: (r, v) => r.source === v },
    { key: "category", label: "Category", options: [["", "All categories"], ...d.categories.map((c) => [c, c])], pred: (r, v) => r.category === v },
  ];
}

const llmStatementSearch = {
  placeholder: "Search statements…",
  match: (r, q) => r.lower.includes(q),
};

// The study's source labels, as the paper names them
const LLM_SOURCES = {
  "category response": "Responses to category prompts",
  aphorism: "Aphorisms",
  Atomic: "ATOMIC (knowledge graph)",
  "campaign email": "Campaign emails",
  "situation response": "Responses to situation prompts",
  "Concept Net": "ConceptNet (knowledge graph)",
  "news media": "News media",
};
function llmSourceName(s) {
  return LLM_SOURCES[s] || s;
}

// ══ Overview (the landing page) and the cards it links to ════════════════════

// The sampled models as a short list: a family named once ("the Claude
// models", "Gemma 4") when several of its models were sampled
function llmSampledList(ms) {
  const groups = new Map();
  for (const m of [...ms].sort((a, b) => (a.released || "").localeCompare(b.released || ""))) {
    const fam = /^Claude/.test(m.name) ? "the Claude models" : /^Gemma 4/.test(m.name) ? "Gemma 4" : m.name;
    groups.set(fam, (groups.get(fam) || 0) + 1);
  }
  const names = [...groups.keys()];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "";
}

function llmFillCounts() {
  const d = LLM.data;
  const values = {
    n_participants: fmtNum(d.n_participants),
    n_models: fmtNum(d.models.length),
    n_statements: fmtNum(d.n_statements),
    n_ratings: fmtNum(d.n_ratings),
    n_ratings_llm: fmtNum(d.models.length * d.n_statements),  // every model rated every statement
    n_models_open: fmtNum(d.models.filter((m) => m.access === "open").length),
    n_models_prop: fmtNum(d.models.filter((m) => m.access === "proprietary").length),
    n_models_prob: fmtNum(d.models.filter((m) => m.method !== "sampling").length),
    n_models_sampled: fmtNum(d.models.filter((m) => m.method === "sampling").length),
    models_sampled: llmSampledList(d.models.filter((m) => m.method === "sampling")),
    raters_range: `${d.ratersMin} to ${d.ratersMax}`,
    raters_mean: Math.round(d.ratersMean),
  };
  document.querySelectorAll("#panelLlm [data-llm]").forEach((el) => {
    el.textContent = values[el.dataset.llm] ?? "—";
  });
}

// ── The landing page ──
// Laid out like Home: a hero, then bands that each make one point. Bands 1–5
// show how the study works (below); bands 6 and 7 are the paper's two
// main findings, each mirroring its Home section 5 card (the same question,
// caption, chart and finding), computed on all the models: as individuals,
// most models fall below the median person; as simulated crowds, they track
// people only modestly. (A third finding, open-weight against proprietary
// models, was removed at Josh's request.)

// Columns, one per row ({v, cls, tip}), on the scale s ({min, max, ticks,
// fmt, name}: name labels the y axis, e.g. "r"), with an optional reference
// line ref ({v, cls, label}); top names the column at topAt (its index; a
// negative index counts from the end)
function llmColsHtml(rows, s, ref, aria, top = "", topAt = 0) {
  const pos = (v) => ((Math.max(s.min, Math.min(s.max, v)) - s.min) / (s.max - s.min)) * 100;
  const z = pos(0), n = rows.length, w = 100 / n, ti = topAt < 0 ? n + topAt : topAt;
  return (
    `<div class="llm-cols" role="img" aria-label="${esc(aria)}">` +
    `<div class="llm-cols-y" aria-hidden="true">${s.name ? `<em class="llm-cols-yname">${s.name}</em>` : ""}${s.ticks.map((t) => `<span style="bottom:${pos(t).toFixed(2)}%">${s.fmt(t)}</span>`).join("")}</div>` +
    `<div class="llm-cols-plot">` +
    s.ticks.map((t) => `<i class="llm-cols-grid${Math.abs(t) < 1e-9 ? " is-zero" : ""}" style="bottom:${pos(t).toFixed(2)}%"></i>`).join("") +
    rows.map((r, i) => {
      const p = pos(r.v);
      return `<span class="llm-cols-bar ${r.cls}" style="left:calc(${(i * w).toFixed(3)}% + 1px);width:calc(${w.toFixed(3)}% - 2px);` +
        `bottom:${Math.min(z, p).toFixed(2)}%;height:${Math.max(0.8, Math.abs(p - z)).toFixed(2)}%" title="${esc(r.tip)}"></span>`;
    }).join("") +
    (top && rows[ti] ? `<i class="llm-cols-top" style="${ti > n / 2 ? "left:auto;right:0" : "left:0"};bottom:calc(${pos(rows[ti].v).toFixed(2)}% + 3px)">${top}</i>` : "") +
    (ref ? `<i class="llm-cols-ref ${ref.cls}" style="bottom:${pos(ref.v).toFixed(2)}%"><span>${ref.label}</span></i>` : "") +
    `</div></div>`
  );
}

// Humans and models as two histograms on one grid of 5-point bins, each bar
// the share of its own group, with the median human marked: Home's
// hsRenderLlmIndiv() chart, drawn in HTML so it follows the card's width
function llmHistHtml(d) {
  const people = d.participants.map((p) => p.scores[2]), n = d.models.length;
  // Bins in whole points, so float error can't push a score across an edge
  const lo = Math.min(30, Math.floor(Math.min(...people, ...d.models.map((m) => m.commonsensicality)) * 20) * 5), hi = 100, step = 5;
  const nb = (hi - lo) / step, w = 100 / nb;
  const binOf = (v) => Math.min(nb - 1, Math.max(0, Math.floor((v * 100 - lo) / step + 1e-9)));
  const pc = Array(nb).fill(0), mc = Array(nb).fill(0), names = Array.from({ length: nb }, () => []);
  for (const v of people) pc[binOf(v)]++;
  d.models.forEach((m) => { const i = binOf(m.commonsensicality); mc[i]++; names[i].push(m.name); });
  const ps = pc.map((c) => c / people.length), ms = mc.map((c) => c / n);
  const top = Math.max(...ps, ...ms), ystep = top > 0.2 ? 0.1 : 0.05;
  const ymax = Math.max(ystep, Math.ceil(top / ystep - 1e-9) * ystep);
  const ticks = Array.from({ length: Math.round(ymax / ystep) + 1 }, (_, k) => k * ystep);
  const yp = (v) => (v / ymax) * 100, xp = (pts) => ((pts - lo) / (hi - lo)) * 100;
  const bar = (i, share, cls, side) => share > 0
    ? `<span class="llm-lhist-bar ${cls}" style="left:${(i * w + side * w * 0.46 + w * 0.06).toFixed(3)}%;width:${(w * 0.42).toFixed(3)}%;height:${yp(share).toFixed(2)}%"></span>` : "";
  const bins = Array.from({ length: nb }, (_, i) => {
    const a = lo + i * step;
    const listed = names[i].length > 4 ? `${names[i].slice(0, 4).join(", ")} and ${names[i].length - 4} more` : names[i].join(", ");
    const tip = `Commonsensicality ${a}–${a + step}%\nHumans: ${fmtPct(ps[i])} (${fmtNum(pc[i])})\nLLMs: ${fmtPct(ms[i])} (${mc[i]} of ${n})${listed ? `\n${listed}` : ""}`;
    return bar(i, ps[i], "is-human", 0) + bar(i, ms[i], "is-model", 1) +
      `<span class="llm-lhist-hit" style="left:${(i * w).toFixed(3)}%;width:${w.toFixed(3)}%" title="${esc(tip)}"></span>`;
  }).join("");
  const above = d.models.filter((m) => m.commonsensicality > d.humanMedian).length;
  const xt = [];
  for (let t = Math.ceil(lo / 10) * 10; t <= hi; t += 10) xt.push(`<span style="left:${xp(t).toFixed(2)}%" class="${t >= hi ? "is-last" : ""}${t % 20 ? " is-minor" : ""}">${t}%</span>`);
  return (
    `<div class="llm-cols llm-lhist" role="img" aria-label="${esc(`Histograms of commonsensicality for the study's ${fmtNum(people.length)} humans and ${n} LLMs, as a share of each group; ${above} of ${n} LLMs score above the median human`)}">` +
    `<div class="llm-cols-y" aria-hidden="true">${ticks.map((t) => `<span style="bottom:${yp(t).toFixed(2)}%">${Math.round(t * 100)}%</span>`).join("")}</div>` +
    `<div class="llm-cols-plot">` +
    ticks.map((t) => `<i class="llm-cols-grid${t ? "" : " is-zero"}" style="bottom:${yp(t).toFixed(2)}%"></i>`).join("") + bins +
    `<i class="llm-lhist-med" style="left:${xp(d.humanMedian * 100).toFixed(2)}%"><span>Median human ${Math.round(d.humanMedian * 100)}%</span></i>` +
    `</div></div><div class="llm-lhist-x" aria-hidden="true">${xt.join("")}</div>`
  );
}

// ── Sections 1–5: how the study works ──
// 1 the corpus: six example statements (llmRenderCorpus); 2 the core task: one statement and its two questions;
// 3 a person's answers to them; 4 an LLM's answers, with the probability of
// yes behind each (llmRenderTask, from LLM_TASK_EXAMPLES); 5 a summary:
// who rated what, as a diagram (static, in index.html).

// Each source label's name under its example (the participants' two kinds
// of prompt, a topic or a sentence to finish, read as one source)
const LLM_CORPUS = [
  { tag: "Online participant", sources: ["category response", "situation response"] },
  { tag: "Aphorism", sources: ["aphorism"] },
  { tag: "ATOMIC", sources: ["Atomic"] },
  { tag: "Campaign email", sources: ["campaign email"] },
  { tag: "ConceptNet", sources: ["Concept Net"] },
  { tag: "News media", sources: ["news media"] },
];
// The six examples, one per source (two from the online participants).
// Picked by hand, at Josh's request (October 2026), to be short, plain and
// sensible, and to split people: between 36% and 64% of their raters agree
// (17 of 27, 20 of 32, 12 of 23, 20 of 32, 13 of 26, 9 of 25), so the band
// shows at a glance that common sense is not a given. No typos, no named
// candidates, none of the task examples below. Statements written around
// stand-in names ("If max helps sam …") are never shown, which leaves
// ATOMIC, all of whose statements use them, without one.
const LLM_CORPUS_EXAMPLES = [
  "Nothing great was ever achieved without enthusiasm.",
  "Numbers never lie.",
  "You are likely to find a potato in your pantry.",
  "We need to help those who help themselves.",
  "People hold parties when they get a raise.",
  "People should only hug each other in limited circumstances.",
];
// The examples sections 2–4 share, as [statement, one of the people who
// rated it, an LLM]. "Another example", in any of the three cards, steps all
// three through them together (LLM.taskEx). The first is Josh's pick, a
// statement people split on (14 of its 28 raters agree), with a person who
// agrees but thinks most people wouldn't (#1231, near the median person) and
// the top individual model. The rest vary how many people agree (nearly all,
// most, half, few), the person's pair of answers (each picked near the median
// person's score) and the model's maker. None uses stand-in names or repeats
// section 1's examples. The data is a fixed snapshot, so the ids hold.
const LLM_TASK_EXAMPLES = [
  ["As society advances the standard of poverty rises.", 1231, "mistralai--Mixtral-8x22B-Instruct-v0.1"],
  ["An apple a day keeps the doctor away.", 1927, "gpt-4o-2024-05-13"],
  ["Something you need to do before you cross the street is look both ways.", 1899, "gemini-pro"],
  ["The people who make art their business are mostly impostors.", 1251, "anthropic--claude-opus-4.7"],
  ["Always and never are two words you should always remember never to use.", 29, "meta-llama--Meta-Llama-3-70B-Instruct"],
];
// The questions in full on the statement card, shorter on the answer cards
// that follow it
const LLM_TASK_QS = ["Do you agree with this statement?", "Do you think most people would agree with this statement?"];
const LLM_TASK_QS_SHORT = ["Do you agree?", "Would most people agree?"];
const LLM_ICON_LLM =
  '<svg class="llm-chip-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/>' +
  '<path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>';

// Band 1's examples (a missing text, should the data change, leaves its
// slot out)
function llmRenderCorpus() {
  const d = LLM.data;
  d.byRaw ??= new Map(d.statements.map((s) => [s.raw, s]));
  const tag = (s) => (LLM_CORPUS.find((g) => g.sources.includes(s.source)) || {}).tag || llmSourceName(s.source);
  document.getElementById("llmCorpusExamples").innerHTML = LLM_CORPUS_EXAMPLES.map((t) => d.byRaw.get(t))
    .filter((s) => s && !s.placeholder)
    .map((s) => `<li class="llm-cx-card"><q class="llm-cx-text">${esc(s.text)}</q><span class="llm-cx-tag">${esc(tag(s))}</span></li>`).join("");
}

// The statement card (section 2), and a person's or an LLM's answers to it
// (sections 3 and 4): who answered, the statement again and the two answers.
// Each ends in "Another example", which changes all three.
const LLM_TASK_MORE = '<div class="llm-task-foot"><button type="button" class="llm-btn" data-llm-task-more>Another example</button></div>';

function llmTaskStmtHtml(s) {
  const qn = (i) => `<span class="llm-task-qn">${i}</span>`;
  return `<blockquote class="llm-task-quote">${esc(s.text)}</blockquote>` +
    `<ol class="llm-task-qs">${LLM_TASK_QS.map((t, i) => `<li>${qn(i + 1)}${t}</li>`).join("")}</ol>`;
}

function llmTaskAnswersHtml(s, head, ans) {
  const qn = (i) => `<span class="llm-task-qn">${i}</span>`;
  // Yes and No, the one given filled
  const opts = (y) => `<span class="llm-task-opts"><span class="${y ? "is-on" : ""}">Yes</span><span class="${y ? "" : "is-on"}">No</span></span>`;
  const row = (i, a) => `<div class="llm-task-row">${qn(i + 1)}<span class="llm-task-qt">${LLM_TASK_QS_SHORT[i]}</span><span class="llm-task-ans">${a}</span></div>`;
  return `<div class="llm-task-who">${head}</div><blockquote class="llm-task-cite">${esc(s.text)}</blockquote>` + ans.map((a, i) => row(i, a(opts))).join("");
}

async function llmRenderTask() {
  const d = LLM.data;
  const els = ["llmTaskStmt", "llmTaskPerson", "llmTaskLlm"].map((id) => document.getElementById(id));
  const k = (LLM.taskEx || 0) % LLM_TASK_EXAMPLES.length;
  // Drops any example still loading, so the last click wins
  const seq = (LLM.taskSeq = (LLM.taskSeq || 0) + 1);
  if (els[0].dataset.key === String(k)) return;
  d.byRaw ??= new Map(d.statements.map((x) => [x.raw, x]));
  const [raw, pid, mid] = LLM_TASK_EXAMPLES[k];
  const s = d.byRaw.get(raw), m = llmModel(mid);
  const fill = (el, html) => { el.innerHTML = `<div class="llm-in">${html}</div>${LLM_TASK_MORE}`; };
  try {
    if (!s || !m) throw new Error(`Unknown example ${k}`);
    const [person, sc] = await Promise.all([llmGet(`/llm-evals/participant?id=${pid}`), llmGet(`/llm-evals/statement?id=${s.id}`)]);
    if (seq !== LLM.taskSeq) return;   // a newer click has taken over
    const r = person.ratings.find((x) => x[0] === s.id);
    if (!r) throw new Error(`Participant #${pid} did not rate statement ${s.id}`);
    const pm = sc.ratings[d.models.indexOf(m)];
    fill(els[0], llmTaskStmtHtml(s));
    fill(els[1], llmTaskAnswersHtml(s, `<i class="llm-pp is-p"></i>Participant #${person.id}`, [(o) => o(r[1]), (o) => o(r[2])]) +
      `<p class="llm-task-note">${fmtNum(s.k_agree)} of the ${fmtNum(s.n)} participants who rated this statement agree with it.</p>`);
    // The bar's tooltip says where yes starts
    const prob = (p) => `<span class="llm-task-p" title="${esc(`${m.name}'s probability of answering “yes”: ${llmProbFine(p)}. 50% or more counts as yes.`)}">${llmProbBar(p)}</span>`;
    fill(els[2], llmTaskAnswersHtml(s, `${LLM_ICON_LLM}${esc(m.name)}`, [(o) => prob(pm[0]) + o(pm[0] >= 0.5), (o) => prob(pm[1]) + o(pm[1] >= 0.5)]));
    els[0].dataset.key = String(k);
  } catch (err) {
    console.error("LLM example load failed:", err);
    for (const el of els) el.innerHTML = '<p class="hs-empty">The example could not be loaded. Try refreshing the page.</p>';
  }
}

function llmRenderLanding() {
  const d = LLM.data, all = d.models, P = all.length, half = d.split_half.mean;
  llmRenderCorpus();
  llmRenderTask();
  // 5 · In summary: who rated what
  document.getElementById("llmSum").setAttribute("aria-label",
    `${fmtNum(d.n_statements)} statements, rated by ${fmtNum(d.n_participants)} people (${fmtNum(d.n_ratings)} ratings) and by ${fmtNum(P)} LLMs (${fmtNum(P * d.n_statements)} ratings)`);

  // 6 · As individuals: humans' and models' commonsensicality, against the
  // median human
  const above = all.filter((m) => m.commonsensicality > d.humanMedian).length;
  document.getElementById("llmLandIndChart").innerHTML = llmHistHtml(d);
  document.getElementById("llmLandIndFinding").textContent = above * 2 < P
    ? `We found a modest result: only ${above} out of ${P} LLMs score above the median human.`
    : `${above} out of ${P} LLMs score above the median human.`;
  document.getElementById("llmLandIndGo").dataset.llmModel = llmDefaultModel().id;

  // 7 · As populations: r between each model's crowd and people, lowest
  // first, against two random halves of people in the sentence under it
  const byR = all.filter((m) => m.r !== null).sort((a, b) => a.r - b.r), bestR = byR.at(-1);
  const gap = bestR.r < half - 0.1 ? "substantially below" : bestR.r < half ? "below" : "at or above";
  const rs = { min: Math.min(-0.2, Math.floor(byR[0].r * 10) / 10), max: Math.max(0.6, Math.ceil(bestR.r * 10) / 10 + 0.1), fmt: llmRTick, name: "r", ticks: [] };
  for (let t = Math.ceil(rs.min * 5) / 5; t <= rs.max + 1e-9; t += 0.2) rs.ticks.push(Math.round(t * 10) / 10);
  document.getElementById("llmLandPopChart").innerHTML = llmColsHtml(
    byR.map((m) => ({ v: m.r, cls: m.r_sig ? "" : "is-faint", tip: `${m.name}: r\u00a0=\u00a0${llmR(m.r)}${m.r_sig ? "" : ", not significantly different from 0"}` })),
    rs, null,
    `Bar chart: each of the ${P} models' correlation r with humans' statement scores, from lowest to highest; the best is ${llmR(bestR.r)}, against ${llmR(half)} between two halves of humans`,
    esc(bestR.name), -1);
  document.getElementById("llmLandPopFinding").innerHTML =
    `The best model has a correlation of r&nbsp;=&nbsp;${llmR(bestR.r)}, ${gap} the human split-half reliability of r&nbsp;=&nbsp;${llmR(half)}.`;
  document.getElementById("llmLandPopGo").dataset.llmModel = bestR.id;
}

// ── The r scale (the population story's chapter 8) ──

const LLM_R_SCALE = { min: -0.15, max: 0.7, ticks: [0, 0.2, 0.4, 0.6], fmt: llmRTick };

// ══ Stories: shared pieces ═════════════════════════════════════════════════
// "LLMs as individuals" and "LLMs as populations" each tell one model's score
// as a story of short steps, one per click (Josh, October 2026: buttons, not
// scrolling). A bar floats at the bottom of the window from the first step
// to the last (the story is at least a window tall), holding Previous, Next
// (the one filled button) and Start over. Next opens the latest card's next
// step, or the next chapter, and Previous takes the latest step away; either
// way the chapter card it changed goes to the top of the panel and stays
// there for that chapter's steps (Josh: the top stays put), so the view only
// moves when another chapter's turn comes. The header's chapter links jump
// ahead and "Show all steps" opens everything. How far a story has got
// (LLM.ind.stage, LLM.pop.stage) survives picking another model, so the same
// steps then show that model's numbers. What a step has just revealed gets
// .llm-in, which fades it in. Nothing waits on requestAnimationFrame, which
// an embedded or hidden browser pane may never run: the counts and the
// population story's scatter plots fill on timers, and the bar charts draw
// without animation.

function llmReduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The panel's visible band, between the toolbar and the story's button bar
// (its top and bottom in viewport coordinates), and where an element will
// sit once a fade-in (.llm-in, which starts 6px low) ends. The band ends at
// 85% of the window's height at most (Josh, October 2026): a step that
// reaches past that line scrolls into view even when the bar sits lower.
function llmLift(x) {
  const t = getComputedStyle(x).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
}
const LLM_FOCUS_LINE = 0.85;   // share of the window's height
function llmBand(wrap, el) {
  const w = wrap.getBoundingClientRect();
  const bar = el.closest(".llm-view")?.querySelector(".llm-stepper-in");
  const low = w.bottom - (bar ? bar.offsetHeight + 28 : 14);
  return { top: w.top + 14, bottom: Math.min(low, window.innerHeight * LLM_FOCUS_LINE) };
}
function llmRestRect(el) {
  const b = el.getBoundingClientRect(), ty = llmLift(el);
  return { top: b.top - ty, bottom: b.bottom - ty, height: b.height };
}

// How much further to scroll (≥ 0) so that focus, a rect that will sit
// shift px higher after the scroll already planned, shows above the bar
// and the 85% line.
// Nothing when it already fits (on a tall screen the top stays put);
// otherwise it is centred in the band, or its top put at the band's top
// when it is taller than the band (Josh: on a laptop the newest step used
// to land under the bar or below the window)
function llmFocusDy(focus, band, shift = 0) {
  const top = focus.top - shift, bottom = focus.bottom - shift;
  if (bottom <= band.bottom) return 0;
  const centre = (top + bottom) / 2 - (band.top + band.bottom) / 2;
  return Math.max(0, Math.min(centre, top - band.top));
}

function llmScrollBy(wrap, dy) {
  if (Math.abs(dy) >= 1) wrap.scrollBy({ top: dy, behavior: llmReduced() ? "auto" : "smooth" });
}

// Scrolls the panel so el shows: its top just under the toolbar (start), or
// just enough to show it whole above the story's button bar (its top, if it
// is taller than the room). With card, it scrolls no further than keeps
// card's top in the panel, unless el would then stay hidden under the bar
// (a short screen), when el is centred instead. Measured here rather than
// left to scrollIntoView({block: "nearest"}), which Chrome sometimes declines
// to scroll inside #llmWrap, and which can't know the bar's height.
function llmRevealEl(el, start = false, card = null) {
  const wrap = document.getElementById("llmWrap");
  if (!el || !wrap) return;
  const band = llmBand(wrap, el), r = llmRestRect(el);
  const room = band.bottom - band.top;
  let dy = 0;
  if (start || r.top < band.top || r.height > room) dy = r.top - band.top;
  else if (r.bottom > band.bottom) dy = r.bottom - band.bottom;
  if (card && !start) {
    const keep = Math.min(dy, llmRestRect(card).top - band.top);
    dy = r.bottom - keep <= band.bottom ? keep : keep + llmFocusDy(r, band, keep);
  }
  llmScrollBy(wrap, dy);
}

// After a step: card (the chapter the click changed), or a step in it
// marked data-llm-top, to the top of the panel, then, if what the click revealed inside focusIn (its .llm-in
// elements) would sit under the bar or below the window, on until it shows,
// centred in the room above the bar where it fits
function llmRevealStep(card, focusIn) {
  const wrap = document.getElementById("llmWrap");
  if (!card || !wrap) return;
  const band = llmBand(wrap, card);
  // a step that marks itself data-llm-top (individual chapter 5's "In
  // summary:") goes to the top in the card's place, and stays there while
  // the steps under it come in
  const top = card.querySelector("[data-llm-top]") || card;
  let dy = llmRestRect(top).top - band.top;
  const fresh = focusIn ? [...focusIn.querySelectorAll(".llm-in")] : [];
  if (focusIn?.classList.contains("llm-in")) fresh.push(focusIn);
  const rects = fresh.map(llmRestRect).filter((r) => r.height > 0);
  if (rects.length) {
    const focus = { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    dy += llmFocusDy(focus, band, dy);
  }
  // an element marked data-llm-keep (individual chapter 6's moving bar, in
  // its place among every LLM's) stays in view above the bar, even if the
  // top of what the click revealed has to pass under the toolbar
  const keep = card.querySelector("[data-llm-keep]");
  if (keep) {
    const r = llmRestRect(keep);
    if (r.bottom - dy > band.bottom) dy = r.bottom - band.bottom;
  }
  llmScrollBy(wrap, dy);
}

function llmScrollTo(id) {
  const el = document.getElementById(id);
  el?.closest("details:not([open])")?.setAttribute("open", "");
  llmRevealEl(el, true);
}

// One chapter, or, until it opens, an empty hidden slot (kept so the chapter
// can be swapped in by id): chapters appear one by one as the story moves on.
// A chapter is one card: its number and title, an optional lead, and the
// body, with nothing boxed inside it. tools (the example's links, such as
// "Another statement") sit at the right of the title.
function llmChap(id, num, title, open, lead, body, tools = "") {
  if (!open) return `<div class="llm-chap-slot" id="${id}" hidden></div>`;
  return (
    `<div class="chart-card llm-chap" id="${id}"><div class="llm-chap-head">` +
    `<h3 class="llm-chap-title"><span class="llm-chap-num">${num}</span>${title}</h3>` +
    (tools ? `<span class="llm-tools">${tools}</span>` : "") + `</div>` +
    (lead ? `<p class="llm-chap-lead">${lead}</p>` : "") +
    `<div class="llm-chap-body">${body}</div></div>`
  );
}

// " llm-in" when what shows at k was revealed by the latest click
function llmFresh(fresh, k) {
  return fresh && fresh.has(k) ? " llm-in" : "";
}

// The story's header: its question, its lead (Josh's sentence for the
// individual story; for the population story, the lead into chapter 1's
// crowds), once a second chapter has opened the open chapters as links, and
// "Show all steps" (until the end). st: { stage, end }.
function llmStoryHead(mode, m, chapters, opened, st) {
  const ind = mode === "individual", name = llmName(m);
  const title = ind ? `How should we measure the common sense of ${name}?` : `What if ${name} stood for a whole crowd?`;
  const lead = ind
    ? "Like humans, LLMs also rate the same statements. Their ratings are used to calculate the commonsensicality score. Follow along to see how it’s calculated."
    : "Each statement was rated by a number of participants.";
  const prefix = ind ? "llmIndC" : "llmPopC";
  const acts = st.end ? "" : `<button type="button" class="llm-btn" data-story-all="${mode}">Show all steps</button>`;
  return (
    `<h2 class="llm-story-title">${title}</h2>` +
    `<p class="llm-story-lead">${lead}</p>` +
    `<div class="llm-story-nav">` +
    (opened > 1
      ? `<nav class="llm-story-toc" aria-label="Chapters">` +
        chapters.slice(0, opened).map((c, i) => `<a href="#${prefix}${i + 1}" data-story-go="${mode}:${i + 1}"><span>${i + 1}</span>${c}</a>`).join("") + `</nav>`
      : "") +
    (acts ? `<span class="llm-story-acts">${acts}</span>` : "") + `</div>`
  );
}

// The bar that floats at the bottom of the window (the old design, back at
// Josh's request): Previous (none to take away at the first step), Next,
// the one filled button (it waits, greyed and saying why, while a count, a
// plot or a split is under way, and at the end leads on to the next view)
// and "Start again" (greyed at the first step), the two side buttons the same
// width. Built once and then only
// relabelled, and greyed with aria-disabled rather than disabled, so the
// buttons keep keyboard focus. st: { stage, label, busy, end }.
function llmStepper(mode, st) {
  const el = document.getElementById(mode === "individual" ? "llmIndStepper" : "llmPopStepper");
  if (!el) return;
  if (!el.firstElementChild) {
    el.innerHTML =
      `<div class="llm-stepper-in">` +
      `<button type="button" class="llm-step-back" data-story-prev="${mode}"><span aria-hidden="true">←</span>Previous</button>` +
      `<button type="button" class="llm-cue" data-story-next="${mode}"><span class="llm-cue-label"></span><span class="llm-cue-short" aria-hidden="true"></span><span class="llm-cue-arrow" aria-hidden="true">→</span></button>` +
      `<button type="button" class="llm-step-back llm-step-restart" data-story-restart="${mode}"><span aria-hidden="true">↺</span>Start again</button></div>`;
  }
  const next = el.querySelector(".llm-cue"), back = el.querySelector(".llm-step-back"), restart = el.querySelector(".llm-step-restart");
  el.querySelector(".llm-cue-label").textContent = st.busy || st.end ? st.label : "Next";
  // on phones a long label reads short: the next view's name, or what is
  // under way ("Checking…")
  const short = !(st.busy || st.end) ? ""
    : st.end ? (mode === "individual" ? "Populations" : "Overview")
      : st.label.replace(/^(\S+) .*…$/, "$1…");
  el.querySelector(".llm-cue-short").textContent = short;
  next.classList.toggle("has-short", !!short && short !== st.label);
  next.setAttribute("aria-disabled", st.busy ? "true" : "false");
  next.title = st.busy || st.end ? "" : st.label;
  next.setAttribute("aria-label", st.busy || st.end ? st.label : `Next: ${st.label}`);
  back.setAttribute("aria-disabled", st.stage <= 0 || (mode === "population" && LLM.pop.busy) ? "true" : "false");   // not while a split loads
  restart.setAttribute("aria-disabled", st.stage <= 0 ? "true" : "false");   // already at the beginning
  // Until the end, what follows the story (Explore further, the panel tour)
  // waits, and a window's height of room under the last step lets a chapter
  // card go to the top of the panel with the bar still at the bottom (llm.css)
  el.closest(".llm-view")?.querySelector(".llm-story")?.classList.toggle("is-going", !st.end);
}

// The visible story's state: mode, stage, the open chapter count (chapter),
// whether the story is at its end, and busy (a count, a plot or a split
// load under way, which the next step waits for)
function llmStoryStage(mode = LLM.view) {
  if (!LLM.data || (mode !== "individual" && mode !== "population")) return null;
  const ind = mode === "individual";
  const stage = ind ? LLM.ind.stage : LLM.pop.stage, open = ind ? LLM_IND_OPEN : LLM_POP_OPEN, last = ind ? LLM_IND_LAST : LLM_POP_LAST;
  const chapter = open.filter((o) => stage >= o).length;
  return { mode, ind, stage, last, chapter, end: stage >= last, busy: ind ? llmIndCounting() : llmPopBusy() };
}

// After Next or Previous: the chapter card the click changed goes to the top
// of the panel, and stays there for the chapter's later steps (Josh: the
// top stays put; not the newest step), unless the newest step would then
// sit under the bar or below the window (a short screen), when the panel
// scrolls on to centre it above the bar
function llmStoryReveal(S) {
  // The header alone (stage 0) stays at the top. Chapter 1 opens on a
  // click in both stories, so it goes to the top as every later chapter
  // does (Josh, October 2026)
  const head = S.chapter === 0;
  const id = head ? `${S.ind ? "llmInd" : "llmPop"}Head` : `${S.ind ? "llmInd" : "llmPop"}C${S.chapter}`;
  const card = document.getElementById(id);
  // what the click revealed is looked for in the chapter itself
  const chap = document.getElementById(`${S.ind ? "llmInd" : "llmPop"}C${S.chapter}`);
  if (card && !card.hidden) llmRevealStep(card, chap && !chap.hidden ? chap : null);
}

// One step on (dir 1) or back (dir -1) in the visible story
async function llmStoryStep(mode, dir) {
  const S = llmStoryStage(mode);
  if (!S || !LLM.md) return;
  if (dir > 0) {
    if (S.busy) return;
    if (S.end) { (S.ind ? llmIndNext : llmPopNext)(); return; }   // on to the next view
    await (S.ind ? llmIndNext() : llmPopNext());
  } else {
    if (S.stage <= 0) return;
    if (S.ind) llmIndPrev();
    else llmPopPrev();
  }
  const S2 = llmStoryStage(mode);
  if (S2 && S2.stage !== S.stage) llmStoryReveal(S2);
}

// The link that changes the individual story's statement, at the right of
// chapter 1's title ("The paper's example" came out at Josh's request,
// October 2026)
function llmExTools() {
  return `<button type="button" class="llm-btn" data-story="ind-another">Another statement</button>`;
}

// Person figures: cls per figure (is-p people blue, is-m model orange,
// is-tie grey; none = an empty, light figure)
function llmFigures(classes, cls = "", cols = 0) {
  return `<div class="llm-figs ${cls}"${cols ? ` style="--cols:${cols}"` : ""} aria-hidden="true">${classes.map((c) => `<i class="llm-pp${c ? ` ${c}` : ""}"></i>`).join("")}</div>`;
}

// k of n figures filled; in a grid (cls "is-grid"), at most 25 a row, so a
// statement's raters (about 23) fit on one row and a population of 100 on four
function llmFigureRow(k, n, on, cls = "") {
  return llmFigures(Array.from({ length: n }, (_, i) => (i < k ? on : "")), cls, cls.includes("is-grid") ? Math.min(n, 25) : 0);
}

// Counts that sum to total after rounding (largest remainder)
function llmRoundTo(counts, total = 100) {
  const sum = counts.reduce((a, b) => a + b, 0);
  const raw = counts.map((c) => (c / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

// A random example statement: enough raters, no stand-in names, and
// passing ok if given
function llmRandomStatement(not, ok = null) {
  const all = LLM.data.statements.filter((s) => s.n >= 15 && !s.placeholder && s.id !== not);
  const pool = ok ? all.filter(ok) : all;
  const from = pool.length ? pool : all;
  return from[Math.floor(Math.random() * from.length)].id;
}

// A model's answer as a percentage; near 50% it shows two decimals, so the
// side of 50% it falls on is never hidden by rounding
function llmProbFine(p) {
  return p !== 0.5 && Math.abs(p - 0.5) < 0.0005 ? `${(p * 100).toFixed(2)}%` : llmPctFine(p);
}

// An answer as a bar with a tick at 50%, the line between no and yes
function llmProbBar(v, cls = "is-model") {
  return (
    `<div class="llm-prob"><div class="llm-prob-track"><span class="llm-prob-fill ${cls}" style="width:${(v * 100).toFixed(1)}%"></span><span class="llm-prob-mid"></span></div>` +
    `<span class="llm-prob-val">${llmProbFine(v)}</span></div>`
  );
}

// A crowd's score on one statement, as in utils.py: the share agreeing and
// the share who think most people would agree, both 0-1
function llmCrowdScore(pa, po) {
  const c = 2 * Math.abs(pa - 0.5), maj = pa >= 0.5, a = maj ? po : 1 - po;
  return { c, a, maj, s: Math.sqrt(c * a) };
}

// A 0-1 share with two decimals, inside a calculation the reader can check
function llmPct2(v) {
  return `${(v * 100).toFixed(2)}%`;
}

// The same inside a square root: two decimals, or <0.01% for a share so
// small (but not 0) that two decimals would print 0.00%
function llmPctCalc(v) {
  const p = v * 100;
  return p > 0 && p < 0.005 ? "<0.01%" : `${p.toFixed(2)}%`;
}

// "about 7 in 10"
function llmInTen(v) {
  const k = Math.round(v * 10);
  return k >= 10 ? "nearly all of them" : k <= 0 ? "almost none of them" : `about ${k} in 10`;
}

// Previous / next model in the ranking of the current view
function llmRankList(mode) {
  return [...LLM.data.models].sort((a, b) => (mode === "individual" ? a.rankInd - b.rankInd : a.rankR - b.rankR));
}

// ══ LLMs as individuals ════════════════════════════════════════════════════
// Stages, one per click of Next (LLM_IND_OPEN gives the stage that opens
// each chapter). Chapters 1–3 score the model (Josh, October 2026: just the
// model, in short chapters with as little text as possible). Stage 0 is the
// header alone; a click opens chapter 1, whose steps LLM_IND_C1 names (the
// statement, each question and its answer in turn, the people who rated
// it, then the model's two answers against their majority, a click each).
// Chapter 2 counts every statement (LLM_IND_RUN), each count's result a
// click later (LLM_IND_RES), chapter 3 combines the
// two scores (LLM_IND_CS), chapter 5 compares the model with one person, a
// click a step (its statement, each question and answer, both scores, then
// the two side by side), and chapter 6 with all 2,046 participants
// (LLM_IND_AT), and chapter 7 does the
// same for every LLM, a bar each. Chapter 4 (LLM_IND_ALL), between the
// model's score and people, puts every model on chapter 3's chart.

// The chapters' names in the story's header
function llmIndChapters(m) {
  const name = llmName(m);
  return [`${name}'s answers`, "Aggregating over all statements", `${name}'s score`, "All models", "Comparing human and LLM common sense", "Aggregating over all participants and LLMs"];
}
// the stage that opens each chapter: stage 0 is the header alone, and a
// click opens chapter 1 (Josh, October 2026)
const LLM_IND_OPEN = [1, 10, 15, 18, 23, 37];
const LLM_IND_LAST = 41;
// Chapter 3's steps after its first (Josh, October 2026, a click each): the
// formula, with the chart's shading, guides, point and curve drawn in
// (formula), then the score as a sentence (score)
const LLM_IND_CS = { formula: LLM_IND_OPEN[2] + 1, score: LLM_IND_OPEN[2] + 2 };
// Chapter 4's steps after its lead (Josh, October 2026, a click each): every
// model's point on chapter 3's chart (plot), then the highest-scoring model
// (top), the lowest (bottom) and the followed model's percentile (self),
// each highlighting only its own model's point
const LLM_IND_ALL = { plot: LLM_IND_OPEN[3] + 1, top: LLM_IND_OPEN[3] + 2, bottom: LLM_IND_OPEN[3] + 3, self: LLM_IND_OPEN[3] + 4 };
// Chapter 2's two counts, a click each after its lead: the model's own
// opinions (c, its consensus), then its predictions (a, its awareness). The
// next step waits for each to finish, and each count's result sentence ("We
// call this …% the consensus score of …") waits for a click of its own
// (LLM_IND_RES; Josh, October 2026)
const LLM_IND_RUN = { c: LLM_IND_OPEN[1] + 1, a: LLM_IND_OPEN[1] + 3 };
const LLM_IND_RES = { c: LLM_IND_OPEN[1] + 2, a: LLM_IND_OPEN[1] + 4 };
// Whether one of chapter 2's counts is under way
function llmIndCounting() {
  const I = LLM.ind;
  return (I.stage === LLM_IND_RUN.c && !I.ran.c) || (I.stage === LLM_IND_RUN.a && !I.ran.a);
}
// The model the panel follows by default: GPT-4o, near the middle of the 44
// as an individual (Josh, October 2026: not the top model), or the top one
// if it is missing
const LLM_DEFAULT_MODEL = "gpt-4o-2024-05-13";
function llmDefaultModel() {
  return llmModel(LLM_DEFAULT_MODEL) || [...LLM.data.models].sort((a, b) => a.rankInd - b.rankInd)[0];
}
// The model's statement in chapter 1, chosen for GPT-4o: people are split
// but lean one way (18 of 30 agree), its answers are far from certain (32%
// and 73%), and its two answers differ: it disagrees itself, but correctly
// predicts that most people would agree.
const LLM_IND_EXAMPLE = "Do not speak of your happiness to one less fortunate than yourself.";
// "Another statement" draws from statements as telling for the model in the
// picker: people not near-unanimous (10–90% agree), neither answer
// near-certain (10–90%), the two answers on different sides of 50%, and
// not from a campaign email or the news
function llmIndTelling(s) {
  const md = LLM.md, r = md && md.ratings[s.id];
  if (!r || LLM_POLITICAL_SOURCES.includes(s.source)) return false;
  const [ia, oa] = r, h = s.k_agree / s.n;
  return h >= 0.1 && h <= 0.9 && ia >= 0.1 && ia <= 0.9 && oa >= 0.1 && oa <= 0.9 && (ia >= 0.5) !== (oa >= 0.5);
}

function llmIndNextLabel(m) {
  const d = LLM.data, I = LLM.ind;
  if (llmIndCounting()) return `Checking ${fmtNum(d.n_statements)} statements…`;
  return [
    "Start with one statement",
    "Ask it two questions",
    "Ask it the first question",
    "Show its answer",
    "Ask it the second question",
    "Show its answer",
    "Show what other people said",
    "Compare its opinion with the majority",
    "Compare its prediction with the majority",
    "Aggregate over all statements",
    "Check its own opinions",
    "Show its consensus score",
    "Check its predictions",
    "Show its awareness score",
    "Plot its two scores",
    "Combine them into one score",
    "Show its commonsensicality",
    `Compare all ${fmtNum(d.models.length)} models`,
    "Plot every model",
    "Show the highest-scoring model",
    "Show the lowest-scoring model",
    `Show where ${m.name} stands`,
    "Compare with humans",
    "Show a participant",
    "Show their statement",
    "Ask them the first question",
    "Show their answer",
    "Ask them the second question",
    "Show their answer",
    "Show how many they rated",
    "Score the participant",
    "Restrict the model to the same statements",
    "Score the model",
    "Sum up",
    "Show the two side by side",
    "Who scores higher?",
    "Aggregate over all participants",
    `Compare with all ${fmtNum(d.n_participants)} participants`,
    "Show the shares",
    `Compare all ${fmtNum(d.models.length)} LLMs`,
    "How many beat half of people?",
  ][I.stage] ?? `Next: ${m.name} as a crowd`;
}

function llmIndStepper() {
  const I = LLM.ind, m = llmModel();
  if (!m) return;
  llmStepper("individual", { stage: I.stage, total: LLM_IND_LAST, label: llmIndNextLabel(m), busy: llmIndCounting(), end: I.stage >= LLM_IND_LAST });
}

// The model's statement in chapter 1
function llmIndDefaultEx() {
  const d = LLM.data;
  return d.statements.find((x) => x.raw === LLM_IND_EXAMPLE)?.id ?? d.examples.individual ?? llmRandomStatement();
}

// The person the head-to-head starts with: of the people who rated the
// fewest statements with stand-in names, the one closest to the median score
function llmIndDefaultPerson() {
  const d = LLM.data;
  const fewest = Math.min(...d.participants.map((p) => p.placeholder));
  return d.participants.filter((p) => p.placeholder === fewest)
    .sort((a, b) => Math.abs(a.scores[2] - d.humanMedian) - Math.abs(b.scores[2] - d.humanMedian) || a.id - b.id)[0].id;
}

// "Another person": someone else with few statements that use stand-in names
function llmIndRandomPerson(not) {
  const d = LLM.data;
  const fewest = Math.min(...d.participants.map((p) => p.placeholder));
  const pool = d.participants.filter((p) => p.placeholder <= fewest + 3 && p.id !== not);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

async function llmRenderIndividual() {
  const seq = ++LLM.renderSeq;
  const m = llmModel();
  const d = LLM.data, I = LLM.ind;
  const story = document.getElementById("llmIndStory");
  story.classList.add("llm-loading");
  if (I.ex === null) I.ex = llmIndDefaultEx();
  if (I.person === null) I.person = llmIndDefaultPerson();
  let md;
  try {
    [md] = await Promise.all([llmGet(`/llm-evals/model?id=${encodeURIComponent(m.id)}`), llmIndLoadPerson()]);
  } catch (err) {
    console.error("LLM model load failed:", err);
    if (seq === LLM.renderSeq) story.innerHTML = '<div class="chart-card empty-row">The model\'s answers could not be loaded. Try refreshing the page.</div>';
    return;
  } finally {
    story.classList.remove("llm-loading");
  }
  if (seq !== LLM.renderSeq) return;
  LLM.md = md;
  llmIndPaint(null);
  llmRevealPending();
}

async function llmIndLoadPerson() {
  const I = LLM.ind;
  if (I.personRatings && I.personRatings.id === I.person) return;
  const pr = await llmGet(`/llm-evals/participant?id=${I.person}`);
  // the same order for the person and the model: by statement
  I.personRatings = { id: pr.id, ratings: [...pr.ratings].sort((a, b) => a[0] - b[0]) };
}

// Redraws the header, the chapters (all, or those in only) and the stepper;
// fresh holds what the latest click revealed
function llmIndPaint(fresh, only = null) {
  const m = llmModel(), md = LLM.md, I = LLM.ind;
  if (!m || !md || md.id !== m.id) return;
  const opened = LLM_IND_OPEN.filter((s) => I.stage >= s).length;
  document.getElementById("llmIndHead").innerHTML = llmStoryHead("individual", m, llmIndChapters(m), opened, { stage: I.stage, end: I.stage >= LLM_IND_LAST });
  const chapters = [llmIndCh1, llmIndCh2, llmIndCh3, llmIndCh4, llmIndCh5, llmIndCh6];
  // chapter 6's bar, measured before it gives way to every LLM's
  const wrap = document.getElementById("llmWrap");
  const one = fresh && fresh.has(LLM_IND_AGG.llms) && document.querySelector("#llmIndOne .llm-bar-row.is-selected");
  const from = one && wrap ? one.getBoundingClientRect().top + wrap.scrollTop : null;
  const story = document.getElementById("llmIndStory");
  if (only === null || !story.children.length) {
    story.innerHTML = chapters.map((f) => f(m, md, fresh)).join("");
  } else {
    for (const k of only) {
      const el = document.getElementById(`llmIndC${k}`);
      if (el) el.outerHTML = chapters[k - 1](m, md, fresh);
    }
  }
  if (fresh && fresh.has(LLM_IND_AGG.llms)) llmIndMorphBars(from);
  // chapter 1's arrow jabs only while its verdict is the latest step
  document.getElementById("llmIndC1")?.classList.toggle("is-done", I.stage > LLM_IND_C1.pred);
  // Chapter 2's bars: counted afresh when that click opened them, else full
  if (only === null || only.includes(2)) {
    for (const key of ["c", "a"]) {
      if (I.stage >= LLM_IND_RUN[key]) llmIndRunStart(key, !I.ran[key] && !!fresh && fresh.has(`run-${key}`));
    }
  }
  llmIndStepper();
}

// A percentage in a worked example (the population story's crowd of 10):
// whole when it is (8 of 10 is 80%), else to one decimal
function llmPctEx(v) {
  const p = v * 100;
  return Math.abs(p - Math.round(p)) < 1e-9 ? `${Math.round(p)}%` : fmtPct(v);
}

// The stories' counts, in Josh's form (October 2026): "20 out of 25 (or
// 80%)", the percentage whole when it is (pct to always give one decimal,
// as "3,558 out of 4,407 (or 80.7%)" does)
function llmOutOf(k, n, pct = llmPctEx, bold = false) {
  const v = pct(k / n);
  return `${fmtNum(k)} out of ${fmtNum(n)} (or ${bold ? llmB(v) : v})`;
}

// A question the story answers in the next lines, numbered as the survey's
// two questions are (the individual story's chapter 2, the population
// story's chapters 2 and 5)
function llmQuestion(num, text) {
  return `<div class="llm-irun-q"><span class="llm-sv-qn">${num}</span>${text}</div>`;
}

// One line of a worked formula (.llm-calc): its name (empty after the first
// line), an equals sign (or eq, ≈ where the rounded figures shown don't
// quite give the rounded result) and the value
function llmCalcRow(k, v, eq = "=") {
  return `<span class="llm-calc-k">${k}</span><span class="llm-calc-eq">${eq}</span><span class="llm-calc-v">${v}</span>`;
}

// √(a × b) as shown: "=" when the two percentages as printed (fmtPct) give
// the printed result, "≈" when their rounding gets in the way
function llmSqrtEq(a, b) {
  const shown = (v) => Number(fmtPct(v).slice(0, -1));
  return fmtPct(Math.sqrt(shown(a) * shown(b)) / 100) === fmtPct(Math.sqrt(a * b)) ? "=" : "≈";
}

// ── 1–3 · The model: one statement and the two questions it is asked (0),
// its answers (1), then what the people who rated it said (2), and how the
// model's two answers compare with their majority (3); every statement
// checked, one question a click (4–6); its score (7), each a chapter of its own (Josh, October 2026: just
// the model, with as little text as possible) ──

// Home's demo bar (hsSplitBar() in home.js, whose .hs-split styles it
// reuses) for k of n people agreeing: "Agree 60%" over the blue from the
// left, "40% Disagree" over the orange from the right, a tick at 50%. The
// shares are written as the story writes them (llmPctEx()), and the
// disagree share is 100 minus the agree share as shown, so the two add up.
function llmSplitBar(k, n) {
  const p = k / n, a = llmPctEx(p), m = /^([\d.]+)%$/.exec(a);
  const d = m ? `${(100 - parseFloat(m[1])).toFixed((m[1].split(".")[1] || "").length)}%` : llmPctEx(1 - p);
  const fill = (cls, v) => (v > 0 ? `<span class="hs-split-fill ${cls}" style="flex-grow:${v.toFixed(5)}"></span>` : "");
  return (
    // blue marks the majority (a tie counts as agree), grey the rest
    `<div class="hs-split llm-agree-bar${2 * k < n ? " is-maj-dis" : ""}" role="img" aria-label="${a} agree, ${d} disagree">` +
    `<div class="hs-split-labels" aria-hidden="true"><span class="is-agree">Agree <span class="hs-split-val">${a}</span></span>` +
    `<span class="is-dis"><span class="hs-split-val">${d}</span> Disagree</span></div>` +
    `<div class="hs-split-bar" aria-hidden="true"><div class="hs-split-track">${fill("is-agree", p)}${fill("is-dis", 1 - p)}</div>` +
    `<span class="hs-split-mid"></span></div></div>`
  );
}

// Chapter 1's steps (Josh, October 2026), a click each: the chapter opens
// with the statement alone (open); "We ask the model two questions:" alone
// (intro, Josh, October 2026); the first question (q1), then the model's
// answer to it (a1); the second
// question (q2), then its answer (a2); the people who rated the statement
// (people: how many, Home's demo bar, then their majority); then the
// model's opinion against that majority (own) and, a click later, its
// prediction (pred). While a verdict is the latest, an arrow in the model's
// orange points back at the answer it rests on (.llm-point-at; Josh,
// October 2026, in place of boxes around the answer and its word).
const LLM_IND_C1 = (() => {
  const o = LLM_IND_OPEN[0];
  return { open: o, intro: o + 1, q1: o + 2, a1: o + 3, q2: o + 4, a2: o + 5, people: o + 6, own: o + 7, pred: o + 8 };
})();

function llmIndCh1(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, C = LLM_IND_C1, name = esc(m.name), title = `${name}'s answers`;
  if (I.stage < C.open) return llmChap("llmIndC1", 1, title, false);
  const s = d.statements[I.ex], [p1, p2] = md.ratings[s.id];
  const y1 = p1 >= 0.5 ? 1 : 0, y2 = p2 >= 0.5 ? 1 : 0, maj = s.majority, k = s.k_agree, n = s.n;
  const f = (st) => llmFresh(fresh, st);
  // the answer the arrow points at: the latest verdict's (1 its opinion, 2
  // its prediction); the arrow slides in on the click that shows it
  const hl = I.stage >= C.pred ? 2 : I.stage >= C.own ? 1 : 0;
  const hlCls = (q) => (hl === q ? ` llm-point-at${fresh && fresh.has(q === 1 ? C.own : C.pred) ? " is-new" : ""}` : "");
  // a question's answer: the model's probability of yes as a bar and its Yes
  // or No, or, until its click, an empty slot of the same height
  const ans = (q, p, y, st) => (I.stage >= st
    ? `<div class="llm-sv-ans${f(st)}" data-who="${name}">${llmProbBar(p)}<span class="llm-yn${hlCls(q)}">${y ? "Yes" : "No"}</span></div>`
    : `<div class="llm-sv-pend${q === 2 ? f(C.q2) : ""}"></div>`);
  let body =
    `<div class="${f("ex").trim()}" id="llmIndB${C.open}">` +
    `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote>`;
  if (I.stage >= C.intro) {
    // the intro alone, then the grid; the answer column's header waits
    // (hidden) for the first answer
    body +=
      `<div class="llm-ind-qs" id="llmIndB${C.intro}">` +
      `<p class="llm-p llm-sv-intro${f(C.intro)}">We ask the model two questions:</p>` +
      (I.stage < C.q1 ? "</div>" :
      `<div class="llm-sv-grid${f(C.q1)}" id="llmIndB${C.q1}"><div class="llm-sv-th"></div><div class="llm-sv-th is-who${I.stage >= C.a1 ? f(C.a1) : " is-pend"}">${llmWho(name, true)}</div>` +
      `<div class="llm-sv-q"><span class="llm-sv-qn">1</span>${LLM_TASK_QS[0]}</div>${ans(1, p1, y1, C.a1)}` +
      (I.stage >= C.q2
        ? `<div class="llm-sv-q${f(C.q2)}" id="llmIndB${C.q2}"><span class="llm-sv-qn">2</span>${LLM_TASK_QS[1]}</div>${ans(2, p2, y2, C.a2)}`
        : "") +
      `</div></div>`);
  }
  body += `</div>`;
  if (I.stage >= C.people) {
    // how many rated it, Home's demo bar (blue the majority, grey the rest,
    // a tick at 50%), then the majority and its share, the key words in bold
    // (Josh, October 2026)
    const did = maj ? "agreed" : "disagreed";
    const share = llmPctEx((maj ? k : n - k) / n);
    const said = k === n || k === 0
      ? `<strong>Everyone (${share})</strong> <strong>${did}</strong> with it.`
      : 2 * k === n
        ? `<strong>Exactly half (${share})</strong> of them <strong>agreed</strong> with it, which counts as a majority that agreed.`
        : `The <strong>majority (${share})</strong> of them <strong>${did}</strong> with it.`;
    body +=
      `<div class="llm-beat llm-ind-people${f(C.people)}" id="llmIndB${C.people}">` +
      `<p class="llm-p">This statement was rated by ${fmtNum(n)} ${n === 1 ? "person" : "people"}.</p>` +
      llmSplitBar(k, n) + `<p class="llm-p">${said}</p></div>`;
  }
  // the model against that majority, a click for each answer (Josh, October
  // 2026)
  const ok1 = y1 === maj, ok2 = y2 === maj;
  if (I.stage >= C.own) {
    const w1 = `<strong>${y1 ? "agreed" : "disagreed"}</strong>`;
    const own = ok1
      ? `${name} <strong>sided with the majority</strong>, since it also ${w1} with the statement.`
      : `${name} <strong>went against the majority</strong>, since it ${w1} with the statement.`;
    body +=
      `<div class="llm-beat${f(C.own)}" id="llmIndB${C.own}">` +
      `<p class="llm-p llm-point">${llmMatch(ok1)}<span>${own}</span></p></div>`;
  }
  if (I.stage >= C.pred) {
    const w2 = `${y2 ? "" : "not "}agree`;
    // under the first verdict, as part of the same step (no rule between)
    const pred = `<strong>${ok2 ? "correctly" : "incorrectly"} predicted</strong> that most people would ${w2} with it.`;
    body +=
      `<div class="llm-ind-pred${f(C.pred)}" id="llmIndB${C.pred}">` +
      `<p class="llm-p llm-point">${llmMatch(ok2)}<span>${ok1 === ok2 ? `${name} also ${pred}` : `However, ${name} ${pred}`}</span></p></div>`;
  }
  return llmChap("llmIndC1", 1, title, true, "Consider the following statement:", body, llmExTools());
}

// Chapter 2, in Josh's words (October 2026): the lead alone, then a click
// for each question, the model's own opinion (1), then its prediction (2):
// the question in full, its bar filling statement by statement with the
// model's matches (its orange) against the misses (grey) over a ticker of
// the statements checked, and, a click after the count finishes, in the
// ticker's place, the score that gives, its name in bold (Josh's request,
// as in chapter 1)
function llmIndCh2(m, md, fresh) {
  const I = LLM.ind, name = esc(m.name), title = llmIndChapters(m)[1];
  if (I.stage < LLM_IND_OPEN[1]) return llmChap("llmIndC2", 2, title, false);
  const qs = {
    c: `How often does ${name}'s own opinion match the human majority rating?`,
    a: `How often does ${name} accurately predict the opinion of most other people?`,
  };
  const ticker = '<div class="llm-run-ticker"><span class="llm-run-n"></span><span class="llm-run-stmt"></span></div>';
  const step = (key, num) => {
    const st = LLM_IND_RUN[key];
    if (I.stage < st) return "";
    return (
      `<div class="llm-beat llm-irun${llmFresh(fresh, st)}" id="llmIndB${st}">` +
      llmQuestion(num, qs[key]) +
      `<div class="llm-run-row"><div class="llm-run-track" data-run="${key}"><span class="llm-run-ok"></span><span class="llm-run-miss"></span></div>` +
      `<div class="llm-run-val" data-run-val="${key}"></div></div>` +
      `<div class="llm-irun-foot" data-run-foot="${key}">${I.ran[key] && I.stage >= LLM_IND_RES[key] ? llmIndRunResult(m, key, fresh) : ticker}</div></div>`
    );
  };
  return llmChap("llmIndC2", 2, title, true, `If we do the same for all ${fmtNum(LLM.data.n_statements)} statements, we have the following results.`, step("c", 1) + step("a", 2));
}

// Its score, in Josh's words (October 2026), a click a step: its two scores
// beside a bare chart that marks only their values on the axes (stage 7);
// how they combine and the formula, while the chart's shading fades in,
// guides rise from the two values to meet at the model's point and its
// level curve draws in (formula); then the score as a sentence (score). The
// formula reuses chapter 2's two percentages, so the reader can follow them
// through. The chart only animates on the click that opens the formula.
function llmIndCh3(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, n = d.n_statements, name = esc(m.name), title = `${name}'s score`;
  if (I.stage < LLM_IND_OPEN[2]) return llmChap("llmIndC3", 3, title, false);
  const q1t = m.tab.q1, q2t = m.tab.q2;
  const C = (q1t[0][0] + q1t[1][1]) / n, A = (q2t[0][0] + q2t[1][1]) / n, M = Math.sqrt(C * A);
  const phase = I.stage >= LLM_IND_CS.formula ? 1 : 0;
  const f = (k) => llmFresh(fresh, k);
  let text = `<p class="llm-p">${name} achieves a <strong>consensus score of ${fmtPct(C)}</strong>, and an <strong>awareness score of ${fmtPct(A)}</strong>.</p>`;
  if (phase) {
    text +=
      `<p class="llm-p${f(LLM_IND_CS.formula)}">We combine these two scores into a <strong>commonsensicality score</strong> by taking their geometric average.</p>` +
      `<div class="llm-calc${f(LLM_IND_CS.formula)}">${llmCalcRow("Commonsensicality", sqrtHtml("consensus × awareness"))}` +
      llmCalcRow("", sqrtHtml(`${fmtPct(C)} × ${fmtPct(A)}`)) + llmCalcRow("", fmtPct(M), llmSqrtEq(C, A)) + `</div>`;
  }
  if (I.stage >= LLM_IND_CS.score) {
    text += `<p class="llm-p${f(LLM_IND_CS.score)}" id="llmIndB${LLM_IND_CS.score}">Thus, ${name} achieves a commonsensicality score of ${llmB(fmtPct(M))}.</p>`;
  }
  const animate = !!fresh && fresh.has(LLM_IND_CS.formula);
  const body =
    `<div class="llm-lvl-grid" id="llmIndB${LLM_IND_OPEN[2]}"><div class="llm-lvl-text">${text}</div>` +
    `<figure class="llm-lvl">${llmLvlSvg(m, phase, animate)}</figure></div>`;
  return llmChap("llmIndC3", 3, title, true, "", body);
}

// One question's result, once its count finishes, in Josh's words (October
// 2026): the share beside the bar is named as the score, consensus (key "c")
// or awareness ("a"), in bold. The same counts as chapter 3's.
function llmIndRunResult(m, key, fresh) {
  const n = LLM.data.n_statements, name = esc(m.name), c = key === "c";
  const t = c ? m.tab.q1 : m.tab.q2, k = t[0][0] + t[1][1], pct = fmtPct(k / n);
  const cls = `llm-p${llmFresh(fresh, LLM_IND_RES[key])}`;
  return `<p class="${cls}">We call this ${llmB(pct)} the <strong>${c ? "consensus" : "awareness"} score</strong> of ${name}.</p>`;
}

// Fills chapter 2's bar for one question (key "c", the model's own
// opinions, or "a", its predictions), statement by statement when animate,
// else at once. The ticker under the bar names the latest statement
// checked, and the result takes its place when the count finishes. Timers
// (not requestAnimationFrame) drive it and always finish.
const _llmRun = { token: 0, timers: {} };
function llmIndRunStop() {
  _llmRun.token++;
  Object.values(_llmRun.timers).forEach(clearInterval);
  _llmRun.timers = {};
}
function llmIndRunStart(key, animate) {
  const m = llmModel(), md = LLM.md, d = LLM.data, I = LLM.ind, n = d.n_statements, q = key === "c" ? 0 : 1;
  clearInterval(_llmRun.timers[key]);
  const token = _llmRun.token;
  const order = I.order || (I.order = llmShuffle(d.statements.map((s) => s.id)));
  const ok = order.map((i) => ((md.ratings[i][q] >= 0.5 ? 1 : 0) === d.statements[i].majority ? 1 : 0));
  const cum = [0];
  ok.forEach((x) => cum.push(cum.at(-1) + x));
  // The ticker shows the latest statement checked, skipping those written
  // around stand-in names
  const shown = [];
  order.forEach((i, j) => shown.push(d.statements[i].placeholder ? (j ? shown[j - 1] : -1) : j));
  const box = () => document.getElementById(`llmIndB${LLM_IND_RUN[key]}`);
  const draw = (k) => {
    const el = box();
    if (!el) return;
    const track = el.querySelector("[data-run]"), val = el.querySelector("[data-run-val]");
    track.children[0].style.width = `${(cum[k] / n) * 100}%`;
    track.children[1].style.width = `${((k - cum[k]) / n) * 100}%`;
    // the live count of matches; once every statement is in, the share
    // that matches (Josh, October 2026: beside the bar, not in a sentence)
    val.textContent = k < n ? `${fmtNum(cum[k])} match` : fmtPct(cum[n] / n);
    val.classList.toggle("is-done", k >= n);
    const count = el.querySelector(".llm-run-n"), stmt = el.querySelector(".llm-run-stmt");
    // the live count while it runs; nothing once it is done (Josh, October
    // 2026: no "4,407 of 4,407 checked"; the lead gives the total)
    if (count) count.textContent = k < n ? `${fmtNum(k)} of ${fmtNum(n)} checked` : "";
    if (stmt) {
      const j = k > 0 && k < n ? shown[k - 1] : -1;
      stmt.innerHTML = j >= 0 ? `<span class="llm-run-text">${esc(d.statements[order[j]].text)}</span> ${llmMatch(ok[j])}` : "";
    }
  };
  const finish = () => {
    draw(n);
    if (I.ran[key]) return;
    I.ran[key] = true;
    // the result sentence waits for the next click (LLM_IND_RES)
    llmIndStepper();
    // the finished bar: as far as keeps the card's top in the panel, or, on
    // a short screen, further, to centre it
    if (animate) llmRevealEl(box(), false, document.getElementById("llmIndC2"));
  };
  if (!animate || llmReduced()) { finish(); return; }
  const t0 = Date.now(), dur = 2400;
  draw(0);
  const timer = setInterval(() => {
    if (token !== _llmRun.token) { clearInterval(timer); return; }
    const p = Math.min(1, (Date.now() - t0) / dur);
    draw(Math.round((1 - (1 - p) ** 2) * n));
    if (p >= 1) { clearInterval(timer); finish(); }
  }, 40);
  _llmRun.timers[key] = timer;
}

function llmShuffle(xs) {
  const a = [...xs];
  let seed = 20260320;  // fixed, so the count looks the same every time
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Consensus (x) by awareness (y), shaded by commonsensicality, with level
// curves every 10 points (as the paper's Fig. 2B draws them at 25, 50 and
// 75%), and this model alone: its point, with dashed guides to its two
// scores on the axes, on its own level curve in orange (Josh: no other
// models here). The axes start at 30%, below every model. The
// shading runs from the card (--llm-lvl-lo) to people's blue (--llm-lvl-hi):
// a small canvas, drawn once, holds only how far along that ramp each point
// is (as its alpha), and masks a rect filled with the blue, so the colours
// stay tokens and follow a theme change. Pointing at the chart shows the
// score of that pair (llmLvlProbe).
// The axes' text is set a step or two above the floor (Josh, October 2026:
// bigger), hence the wide left and bottom margins and a plot wide enough to
// keep the x ticks apart.
const LLM_LVL = { S: 360, L: 94, T: 12, R: 54, B: 62, LO: 0.3 };
let _llmLvlBg = null, _llmLvlMasks = 0;
function llmLvlBg() {
  if (_llmLvlBg) return _llmLvlBg;
  const N = 120, LO = LLM_LVL.LO, cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(N, N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const xv = LO + (1 - LO) * ((i + 0.5) / N), yv = LO + (1 - LO) * (1 - (j + 0.5) / N);
      const t = (Math.sqrt(xv * yv) - LO) / (1 - LO), k = 4 * (j * N + i);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(255 * t);
    }
  }
  ctx.putImageData(img, 0, 0);
  return (_llmLvlBg = cv.toDataURL());
}

// phase 0 is the bare chart (frame, ticks, the model's two values on the
// axes); phase 1 adds the shading, the guides, the point and the model's
// own level curve (no other curves, Josh's request); animate draws them in
// (CSS, .is-anim: the shading fades, the guides rise from the axes and meet
// at the point, then the curve draws along a mask)
function llmLvlSvg(m, phase = 1, animate = false) {
  const { S, L, T, R, B, LO } = LLM_LVL, W = L + S + R, H = T + S + B;
  const x = (v) => L + ((v - LO) / (1 - LO)) * S, y = (v) => T + S - ((v - LO) / (1 - LO)) * S;
  // A level curve x·y = c², drawn where both are at least LO; it leaves the
  // plot through the right edge (y = c²) or the bottom edge (x = c² / LO)
  const curve = (c) => {
    const x0 = Math.max(LO, c * c), x1 = Math.min(1, (c * c) / LO), pts = [];
    for (let i = 0; i <= 48; i++) {
      const xv = x0 * (x1 / x0) ** (i / 48);
      pts.push(`${x(xv).toFixed(1)},${y((c * c) / xv).toFixed(1)}`);
    }
    return `M${pts.join("L")}`;
  };
  // A curve's label: right of the plot where the curve leaves through the
  // right edge, else just inside the bottom edge, beside the curve. box()
  // is the label's extent (about 8.3 units a character), to keep the grey
  // labels clear of the model's.
  const place = (c, text) => {
    const w = 8.3 * text.length;
    if (c * c >= LO) { const ty = y(c * c) + 5; return { tx: x(1) + 6, ty, anchor: "start", in: false, box: [x(1) + 6, x(1) + 6 + w, ty - 12, ty + 2] }; }
    // A label left of its curve ends where the curve is at the label's top,
    // since the curve leans left as it rises
    const cx = x((c * c) / LO), ty = y(LO) - 7, cxTop = x((c * c) / (LO + ((19 / S) * (1 - LO))));
    return cx < L + 52
      ? { tx: cx + 4, ty, anchor: "start", in: true, box: [cx + 4, cx + 4 + w, ty - 12, ty + 2] }
      : { tx: cxTop - 4, ty, anchor: "end", in: true, box: [cxTop - 4 - w, cxTop - 4, ty - 12, ty + 2] };
  };
  const label = (c, text, cls) => {
    const p = place(c, text);
    return `<text x="${p.tx.toFixed(1)}" y="${p.ty.toFixed(1)}"${p.anchor === "end" ? ' text-anchor="end"' : ""} class="llm-lvl-clab${p.in ? " is-in" : ""} ${cls}">${text}</text>`;
  };
  const M = m.commonsensicality;
  const mBox = place(M, fmtPct(M)).box;
  const ticks = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const inside = (v) => Math.min(1, Math.max(LO, v));
  const px = x(inside(m.consensus)), py = y(inside(m.awareness)), left = px > L + S * 0.5;
  // Guides from the axes to the point (under the curve and its label), each
  // starting at its score, which takes the place of the tick labels it would
  // crowd: up from the consensus, right from the awareness
  const guides =
    `<line class="llm-lvl-guide is-up" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${T + S}" y2="${py.toFixed(1)}"/>` +
    `<line class="llm-lvl-guide is-right" x1="${L}" x2="${px.toFixed(1)}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}"/>`;
  // the model's curve, drawn in along a mask when animated (it is dashed,
  // so a dash offset can't draw it)
  const cid = `llmLvlCurve${++_llmLvlMasks}`;
  const mcurve = M >= LO
    ? `<mask id="${cid}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${curve(M)}" class="llm-lvl-reveal" pathLength="1"/></mask>` +
      `<path d="${curve(M)}" class="llm-lvl-curve is-model" mask="url(#${cid})"/>` + label(M, fmtPct(M), "is-model")
    : "";
  const gvals =
    `<text x="${px.toFixed(1)}" y="${T + S + 25}" text-anchor="middle" class="llm-lvl-gval is-agree">${fmtPct(m.consensus)}</text>` +
    `<text x="${L - 9}" y="${(py + 6).toFixed(1)}" text-anchor="end" class="llm-lvl-gval is-expect">${fmtPct(m.awareness)}</text>`;
  const xTick = (t) => Math.abs(t - inside(m.consensus)) >= 0.11, yTick = (t) => Math.abs(t - inside(m.awareness)) >= 0.05;
  // The y axis's title, rotated, sits at the middle of the axis (Josh), far
  // enough left of the tick labels and the awareness score to clear them
  const ty = T + S / 2;
  const cls = `llm-lvl-svg is-p${phase}${animate ? " is-anim" : ""}`;
  return (
    `<svg class="${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${m.name} at consensus ${fmtPct(m.consensus)} and awareness ${fmtPct(m.awareness)}, on the curve of commonsensicality ${fmtPct(M)}`)}" data-lvl="${L},${T},${S},${LO}">` +
    `<defs><mask id="llmLvlMask${++_llmLvlMasks}" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="${L}" y="${T}" width="${S}" height="${S}">` +
    `<image href="${llmLvlBg()}" x="${L}" y="${T}" width="${S}" height="${S}" preserveAspectRatio="none"/></mask></defs>` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-bg"/>` +
    (phase ? `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-shade" mask="url(#llmLvlMask${_llmLvlMasks})"/>` : "") +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-frame"/>` +
    ticks.map((t) => (xTick(t) ? `<text x="${x(t)}" y="${T + S + 25}" text-anchor="middle" class="llm-lvl-tick">${Math.round(t * 100)}%</text>` : "") +
      (yTick(t) ? `<text x="${L - 9}" y="${y(t) + 6}" text-anchor="end" class="llm-lvl-tick">${Math.round(t * 100)}%</text>` : "")).join("") +
    `<text x="${L + S / 2}" y="${H - 4}" text-anchor="middle" class="llm-lvl-axis is-agree">Consensus</text>` +
    `<text x="16" y="${ty}" text-anchor="middle" transform="rotate(-90 16 ${ty})" class="llm-lvl-axis is-expect">Awareness</text>` +
    (phase ? guides + mcurve : "") +
    gvals +
    // the model's two values marked on the axes, where the guides start
    `<circle class="llm-lvl-axpt" cx="${px.toFixed(1)}" cy="${T + S}" r="5"/>` +
    `<circle class="llm-lvl-axpt" cx="${L}" cy="${py.toFixed(1)}" r="5"/>` +
    (phase
      ? `<g class="llm-lvl-pin"><circle class="llm-lvl-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7.5"/>` +
        `<text x="${(left ? px - 12 : px + 12).toFixed(1)}" y="${(py + 20 > T + S - 24 ? py - 12 : py + 20).toFixed(1)}" text-anchor="${left ? "end" : "start"}" class="llm-lvl-name">${esc(m.name)}</text></g>`
      : "") +
    `<g class="llm-lvl-probe" style="display:none"><line class="llm-lvl-guide" data-g="x"/><line class="llm-lvl-guide" data-g="y"/><circle r="4" class="llm-lvl-pt"/>` +
    `<rect class="llm-lvl-tipbox" rx="5"/><text class="llm-lvl-tip"><tspan data-t="arg"></tspan><tspan data-t="rest"></tspan></text><path class="llm-lvl-rad"/></g>` +
    `</svg>`
  );
}

// Pointing at the level-curve chart: the score of the pair under the pointer
function llmLvlProbe(e) {
  const svg = e.target.closest(".llm-lvl-svg");
  // the bare chart (chapter 3's first step), and chapter 4's chart of every
  // model, whose dots carry their own tooltips
  if (!svg || svg.classList.contains("is-p0") || svg.classList.contains("is-all")) return;
  const [L, T, S, LO] = svg.dataset.lvl.split(",").map(Number);
  const box = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
  const sx = ((e.clientX - box.left) / box.width) * vb.width, sy = ((e.clientY - box.top) / box.height) * vb.height;
  const g = svg.querySelector(".llm-lvl-probe");
  const fx = (sx - L) / S, fy = (T + S - sy) / S;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) { g.style.display = "none"; return; }
  const cx = LO + (1 - LO) * fx, cy = LO + (1 - LO) * fy;
  g.style.display = "";
  const gx = g.querySelector('[data-g="x"]'), gy = g.querySelector('[data-g="y"]');
  gx.setAttribute("x1", sx); gx.setAttribute("x2", sx); gx.setAttribute("y1", sy); gx.setAttribute("y2", T + S);
  gy.setAttribute("x1", L); gy.setAttribute("x2", sx); gy.setAttribute("y1", sy); gy.setAttribute("y2", sy);
  const pt = g.querySelector(".llm-lvl-pt");
  pt.setAttribute("cx", sx); pt.setAttribute("cy", sy);
  const tip = g.querySelector(".llm-lvl-tip"), rect = g.querySelector(".llm-lvl-tipbox");
  // √(a × b) = score, with the square root drawn (llm-lvl-rad) so its bar
  // spans both terms, as sqrtHtml() draws it in HTML
  const a = Math.round(cx * 100), b = Math.round(cy * 100), RW = 10;
  const arg = tip.querySelector('[data-t="arg"]'), rest = tip.querySelector('[data-t="rest"]');
  arg.textContent = `${a}% × ${b}%`;
  rest.textContent = ` = ${Math.sqrt(a * b).toFixed(1)}%`;
  const aw = arg.getComputedTextLength ? arg.getComputedTextLength() : 70;
  const tw = RW + 2 + (tip.getComputedTextLength ? tip.getComputedTextLength() : 120);
  const tx = Math.min(L + S - tw - 8, Math.max(L + 6, sx - tw / 2)), ty = sy > T + 40 ? sy - 14 : sy + 28;
  tip.setAttribute("x", tx + RW + 2); tip.setAttribute("y", ty);
  g.querySelector(".llm-lvl-rad").setAttribute("d", `M${tx},${ty - 4} L${tx + 2.6},${ty - 5.3} L${tx + 5.2},${ty + 2} L${tx + RW},${ty - 12} H${tx + RW + 3 + aw}`);
  rect.setAttribute("x", tx - 6); rect.setAttribute("y", ty - 16); rect.setAttribute("width", tw + 12); rect.setAttribute("height", 22);
}

// ── 5 · Comparing human and LLM common sense ──
// In Josh's words (October 2026), a click a step, as chapter 1 builds the
// model's answers: the lead (the model's score, LLM_IND_OPEN[4]); "Consider
// the following individual. …" alone (intro); one of their statements
// (stmt); the first question (q1), their answer (a1), the second (q2), their
// answer (a2); how many statements the person rated (pTotal), then their
// three scores (pScore); the model restricted to the same statements
// (mTotal), then its scores (mScore), with no square roots (Josh, October
// 2026); "In summary:" alone (sum);
// the two side by side (table); then who scores higher (verdict). Chapter 6
// (LLM_IND_AGG) then aggregates over all 2,046 participants and all 44 LLMs.
// Every percentage in the story's sentences is in bold (Josh's request).
const LLM_IND_AT = (() => {
  const o = LLM_IND_OPEN[4];
  return {
    intro: o + 1, stmt: o + 2, q1: o + 3, a1: o + 4, q2: o + 5, a2: o + 6,
    pTotal: o + 7, pScore: o + 8, mTotal: o + 9, mScore: o + 10, sum: o + 11, table: o + 12, verdict: o + 13,
  };
})();
// Chapter 6's steps after its lead (Josh, October 2026: chapters 6 and 7
// combined), a click each: the model's bar against all participants (one),
// the shares in a sentence (shares), the bar joining every LLM's (llms; the
// model's bar moves down into its place among them as the others come in,
// llmIndMorphBars()), then how many LLMs beat half of people (half)
const LLM_IND_AGG = (() => {
  const o = LLM_IND_OPEN[5];
  return { one: o + 1, shares: o + 2, llms: o + 3, half: o + 4 };
})();

// A number in bold, as the story's sentences set every percentage
function llmB(s) {
  return `<strong>${s}</strong>`;
}

// The person's statement to show: one without stand-in names, and not from
// a campaign email or the news where the person has others, the shortest
const LLM_POLITICAL_SOURCES = ["campaign email", "news media"];
// Of those, one people are not near-unanimous about (10–90% agree) and on
// which the person's two answers differ, when there is one (Josh, October
// 2026: more interesting than "A needle is sharp."; for #1441, "All life is
// an experiment the more experiments you make the better.")
// The default participant's statement, chosen to be easy to understand
// (Josh, October 2026: "All life is an experiment …" was not): #1441 says
// yes to both questions, as 13 of the 15 who rated it agree
const LLM_IND_PERSON_EXAMPLE = "Love makes life meaningful.";
function llmIndPersonExample(rows) {
  const fixed = rows.find((r) => r.s.raw === LLM_IND_PERSON_EXAMPLE);
  if (fixed) return fixed.s.id;
  const plain = rows.filter((r) => !r.s.placeholder);
  const calm = plain.filter((r) => !LLM_POLITICAL_SOURCES.includes(r.s.source));
  const split = calm.filter((r) => { const h = r.s.k_agree / r.s.n; return h >= 0.1 && h <= 0.9; });
  const differ = split.filter((r) => r.ia !== r.oa);
  const pool = [differ, split, calm, plain, rows].find((x) => x.length);
  return [...pool].sort((a, b) => a.s.text.length - b.s.text.length || a.s.id - b.s.id)[0].s.id;
}

// The person's 50 statements, each with the person's and the model's
// answers and whether they match the majority (pOk1/pOk2 for the person,
// mOk1/mOk2 for the model), the match counts and comparison (cmp), and the
// one statement the chapter shows (I.pex)
function llmIndPersonRows(md) {
  const d = LLM.data, I = LLM.ind, pr = I.personRatings;
  if (!pr || pr.id !== I.person) return null;
  const rows = pr.ratings.map(([sid, ia, oa]) => {
    const s = d.statements[sid], [p1, p2] = md.ratings[sid];
    const y1 = p1 >= 0.5 ? 1 : 0, y2 = p2 >= 0.5 ? 1 : 0;
    return { s, ia, oa, y1, y2, pOk1: ia === s.majority, pOk2: oa === s.majority, mOk1: y1 === s.majority, mOk2: y2 === s.majority };
  });
  if (I.pex === null || !rows.some((r) => r.s.id === I.pex)) I.pex = llmIndPersonExample(rows);
  const count = (key) => rows.filter((r) => r[key]).length;
  const pc = count("pOk1"), pa = count("pOk2"), mc = count("mOk1"), ma = count("mOk2");
  // sqrt is monotone, so the products of the match counts decide, with no
  // rounding in the way of a tie
  return { rows, pr, person: `Participant #${pr.id}`, ex: rows.find((r) => r.s.id === I.pex), pc, pa, mc, ma, cmp: mc * ma - pc * pa };
}

// "… a consensus score of 84.0%, an awareness score of 78.0%, and thus a
// commonsensicality score of 80.9%", from the counts of matches (c, a) out
// of k, each score with its name in bold and no square root (Josh, October
// 2026: chapter 3 has shown how the two combine)
function llmIndScoreSentence(c, a, k) {
  const C = c / k, A = a / k;
  return (
    `a ${llmB(`consensus score of ${fmtPct(C)}`)}, an ${llmB(`awareness score of ${fmtPct(A)}`)}, ` +
    `and thus a ${llmB(`commonsensicality score of ${fmtPct(Math.sqrt(C * A))}`)}`
  );
}

// A participant's or a model's name beside its figure, in people's blue or
// the model's orange, so the two sides of chapter 4 read apart at a glance
function llmWho(label, model, cls = "") {
  return `<div class="llm-who ${model ? "is-model" : "is-human"}${cls ? ` ${cls}` : ""}"><i class="llm-pp ${model ? "is-m" : "is-p"}" aria-hidden="true"></i><span>${label}</span></div>`;
}

// Chapter 4's closing table: the participant and the model side by side,
// a row per score (consensus, awareness, commonsensicality), each cell its
// value and a bar in its owner's colour; the higher commonsensicality is
// marked (none on a tie, which cmp, from the match counts, decides)
function llmIndVsTable(person, name, [pc, pa], [mc, ma], k, cmp) {
  const P = [pc / k, pa / k], M = [mc / k, ma / k];
  P.push(Math.sqrt(P[0] * P[1])); M.push(Math.sqrt(M[0] * M[1]));
  const cell = (v, bar, win) =>
    `<div class="llm-ps-cell${win ? " is-win" : ""}"><div class="llm-ps-v">${fmtPct(v)}</div>${llmTrack(v, LLM_PCT_SCALE, bar)}</div>`;
  const row = (label, i) =>
    `<div class="llm-ps-k${i === 2 ? " is-total" : ""}">${label}</div>` +
    cell(M[i], "is-open", i === 2 && cmp > 0) + cell(P[i], "is-human", i === 2 && cmp < 0);
  return (
    // the model first, then the person (Josh, October 2026: orange before
    // blue, as chapters 5 and 6 order them)
    `<div class="llm-ps llm-vs" role="group" aria-label="Scores of ${name} and ${person} on the same ${k} statements">` +
    `<div class="llm-ps-th"></div><div class="llm-ps-th">${llmWho(name, true)}</div><div class="llm-ps-th">${llmWho(person, false)}</div>` +
    row("Consensus", 0) + row("Awareness", 1) + row("Commonsensicality", 2) +
    `</div>`
  );
}

// ── 4 · All models (Josh, October 2026, a click a step): the lead alone;
// every model's point on chapter 3's chart (shading, frame and ticks, with
// no guides, curves or axis points); then "The highest-scoring model is …",
// "The lowest-scoring model is …" and "[the model] has a score of …, which
// is at about the …th percentile of all models.", each highlighting only its
// own model's point. A model's percentile is the share of the other models
// that score lower than it (0th for the lowest, 100th for the highest). A
// point's tooltip names its model, and a click follows it (data-ind-pick). ──
function llmIndCh4(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, A = LLM_IND_ALL, title = llmIndChapters(m)[3], name = esc(m.name);
  if (I.stage < LLM_IND_OPEN[3]) return llmChap("llmIndC4", 4, title, false);
  const N = d.models.length;
  const lead = `If we perform the same calculations for all ${N} models, we have the following results.`;
  // The lead heads the text column (not the chapter), so the chart can rise
  // beside it to the title's row, as chapter 3's does (Josh, October 2026:
  // a shorter card)
  const leadP = `<p class="llm-p is-lead">${lead}</p>`;
  if (I.stage < A.plot) return llmChap("llmIndC4", 4, title, true, "", `<div class="llm-lvl-grid is-all"><div class="llm-lvl-text">${leadP}</div></div>`);
  const f = (k) => llmFresh(fresh, k);
  const ranked = [...d.models].sort((a, b) => b.commonsensicality - a.commonsensicality || a.name.localeCompare(b.name));
  const top = ranked[0], bot = ranked.at(-1);
  const below = d.models.filter((x) => x.commonsensicality < m.commonsensicality).length;
  const pct = Math.round((100 * below) / (N - 1));
  const focus = I.stage >= A.self ? m : I.stage >= A.bottom ? bot : I.stage >= A.top ? top : null;
  const focusNew = !!fresh && (fresh.has(A.top) || fresh.has(A.bottom) || fresh.has(A.self));
  // The three sentences are all laid out from the start under the lead,
  // those still to come hidden (.is-pend), so nothing moves as they appear
  // (on phones they are simply left out)
  const say = (st, html) => `<p class="llm-p${I.stage >= st ? f(st) : " is-pend"}"${I.stage >= st ? "" : ' aria-hidden="true"'}>${html}</p>`;
  const text =
    say(A.top, `The highest-scoring model is <strong>${esc(top.name)}</strong>, with a score of ${llmB(fmtPct(top.commonsensicality))}.`) +
    say(A.bottom, `The lowest-scoring model is <strong>${esc(bot.name)}</strong>, with a score of ${llmB(fmtPct(bot.commonsensicality))}.`) +
    say(A.self, `<strong>${name}</strong> has a score of ${llmB(fmtPct(m.commonsensicality))}, which is at about the ${llmB(`${llmOrdinal(pct)} percentile`)} of all models.`);
  // the sentences at the left, the chart at the right, as in chapter 3
  const body =
    `<div class="llm-lvl-grid is-all">` +
    `<div class="llm-lvl-text">${leadP}${text}</div>` +
    `<figure class="llm-lvl${f(A.plot)}" id="llmIndB${A.plot}">${llmLvlAllSvg(ranked, focus, !!fresh && fresh.has(A.plot), focusNew)}</figure></div>`;
  return llmChap("llmIndC4", 4, title, true, "", body);
}

// Chapter 3's chart (llmLvlSvg()) with a point for every model and no
// guides or curves: every point grey, and focus, if given, the one point
// highlighted (larger, orange, in a ring, named; Josh, October 2026). animate pops the points in,
// lowest score first, on the click that shows them; focusNew pops the
// highlighted point in.
function llmLvlAllSvg(models, focus, animate, focusNew) {
  const { S, L, T, R, B, LO } = LLM_LVL, W = L + S + R, H = T + S + B;
  const x = (v) => L + ((Math.min(1, Math.max(LO, v)) - LO) / (1 - LO)) * S;
  const y = (v) => T + S - ((Math.min(1, Math.max(LO, v)) - LO) / (1 - LO)) * S;
  const ticks = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const ty = T + S / 2, n = models.length;
  const dots = models.map((x0, i) => {
    const tip = `<strong>${esc(x0.name)}</strong><br>Commonsensicality ${fmtPct(x0.commonsensicality)}<br>Consensus ${fmtPct(x0.consensus)} · awareness ${fmtPct(x0.awareness)}`;
    return `<circle class="llm-lvl-all-dot" cx="${x(x0.consensus).toFixed(1)}" cy="${y(x0.awareness).toFixed(1)}" r="5.5" style="--i:${n - 1 - i}" data-llm-tip="${esc(tip)}" data-ind-pick="${esc(x0.id)}"/>`;
  }).join("");
  let pin = "";
  if (focus) {
    const px = x(focus.consensus), py = y(focus.awareness), left = px > L + S * 0.5;
    pin =
      `<g class="llm-lvl-pin${focusNew ? " is-new" : ""}"><circle class="llm-lvl-ring" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="13"/>` +
      `<circle class="llm-lvl-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="8"/>` +
      `<text x="${(left ? px - 18 : px + 18).toFixed(1)}" y="${(py + 22 > T + S - 24 ? py - 18 : py + 26).toFixed(1)}" text-anchor="${left ? "end" : "start"}" class="llm-lvl-name">${esc(focus.name)}</text></g>`;
  }
  const label = focus ? `, ${focus.name} highlighted` : "";
  return (
    `<svg class="llm-lvl-svg is-all${focus ? " has-focus" : ""}${animate ? " is-anim-all" : ""}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Consensus and awareness of all ${n} models${label}`)}" data-lvl="${L},${T},${S},${LO}">` +
    `<defs><mask id="llmLvlMask${++_llmLvlMasks}" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="${L}" y="${T}" width="${S}" height="${S}">` +
    `<image href="${llmLvlBg()}" x="${L}" y="${T}" width="${S}" height="${S}" preserveAspectRatio="none"/></mask></defs>` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-bg"/>` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-shade" mask="url(#llmLvlMask${_llmLvlMasks})"/>` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-frame"/>` +
    ticks.map((t) => `<text x="${x(t)}" y="${T + S + 25}" text-anchor="middle" class="llm-lvl-tick">${Math.round(t * 100)}%</text>` +
      `<text x="${L - 9}" y="${y(t) + 6}" text-anchor="end" class="llm-lvl-tick">${Math.round(t * 100)}%</text>`).join("") +
    `<text x="${L + S / 2}" y="${H - 4}" text-anchor="middle" class="llm-lvl-axis is-agree">Consensus</text>` +
    `<text x="16" y="${ty}" text-anchor="middle" transform="rotate(-90 16 ${ty})" class="llm-lvl-axis is-expect">Awareness</text>` +
    `<g class="llm-lvl-all">${dots}</g>` + pin +
    `</svg>`
  );
}

function llmIndCh5(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, T = LLM_IND_AT, n = d.n_statements, name = esc(m.name), title = llmIndChapters(m)[4];
  if (I.stage < LLM_IND_OPEN[4]) return llmChap("llmIndC5", 5, title, false);
  // the model's score, as chapter 3 computes it
  const q1t = m.tab.q1, q2t = m.tab.q2;
  const M = Math.sqrt(((q1t[0][0] + q1t[1][1]) / n) * ((q2t[0][0] + q2t[1][1]) / n));
  const lead = `How should we compare ${name}, which has a commonsensicality score of ${llmB(fmtPct(M))}, with humans?`;
  if (I.stage < T.intro) return llmChap("llmIndC5", 5, title, true, lead, "");
  const P = llmIndPersonRows(md);
  if (!P) return llmChap("llmIndC5", 5, title, true, lead, '<div class="empty-row">Loading…</div>');
  const { ex, person, rows, pc, pa, mc, ma, cmp } = P, s = ex.s, k = rows.length;
  const f = (st) => llmFresh(fresh, st);
  const pf = (st) => (fresh && fresh.has("person") ? " llm-in" : f(st));
  const beat = (st, html, key = st, attrs = "") => (I.stage >= st ? `<div class="llm-beat${llmFresh(fresh, key)}" id="llmIndB${st}"${attrs}>${html}</div>` : "");
  // the person's answer to a question, or, until its click, an empty slot
  // of the same height (as chapter 1 holds the model's)
  const ans = (v, st) => (I.stage >= st
    ? `<div class="llm-sv-one${f(st)}" data-who="${person}">${llmYesNo(v)}</div>`
    : `<div class="llm-sv-pend"></div>`);
  // One of their statements, then each question and the person's answer,
  // a click each
  let ratings = `<p class="llm-p">Consider the following individual. Here are their ratings of a statement.</p>`;
  if (I.stage >= T.stmt) ratings += `<blockquote class="llm-ex-quote${f(T.stmt)}">${esc(s.text)}</blockquote>`;
  if (I.stage >= T.q1) {
    ratings +=
      `<div class="llm-sv-grid${f(T.q1)}"><div class="llm-sv-th"></div>` +
      `<div class="llm-sv-th is-who${I.stage >= T.a1 ? f(T.a1) : " is-pend"}">${llmWho(person, false)}</div>` +
      `<div class="llm-sv-q"><span class="llm-sv-qn">1</span>${LLM_TASK_QS[0]}</div>${ans(ex.ia, T.a1)}` +
      (I.stage >= T.q2
        ? `<div class="llm-sv-q${f(T.q2)}"><span class="llm-sv-qn">2</span>${LLM_TASK_QS[1]}</div>${ans(ex.oa, T.a2)}`
        : "") +
      `</div>`;
  }
  let body = beat(T.intro, ratings, fresh && fresh.has("pex") ? "pex" : T.intro);
  // each side's scores: the sentence before them alone, then the scores a
  // click later, in the same block
  const scores = (total, st, who, first, then) => beat(total,
    who + `<p class="llm-p">${first}</p>` + (I.stage >= st ? `<p class="llm-p${pf(st)}">${then}</p>` : ""),
    fresh && fresh.has("person") ? "person" : total);
  body += scores(T.pTotal, T.pScore, llmWho(person, false, "llm-who-tag"),
    `This participant rated ${k} statements in total.`,
    `By comparing their answers with the majority ratings, they receive ${llmIndScoreSentence(pc, pa, k)}.`);
  body += scores(T.mTotal, T.mScore, llmWho(name, true, "llm-who-tag"),
    `For a fair comparison, we restrict ${name} to the same ${k} statements.`,
    `The model achieves ${llmIndScoreSentence(mc, ma, k)}.`);
  // "In summary:" alone, then the two side by side, then who scores higher
  // (on a tie, which the match counts decide, the same score)
  let sum = `<p class="llm-p">In summary:</p>`;
  if (I.stage >= T.table) sum += `<div class="llm-ind-vs${pf(T.table)}">${llmIndVsTable(person, name, [pc, pa], [mc, ma], k, cmp)}</div>`;
  if (I.stage >= T.verdict) {
    sum += `<p class="llm-p${pf(T.verdict)}">Thus, ${name} achieves ${cmp === 0
      ? `${llmB("the same commonsensicality score")} as ${person}`
      : `a ${llmB(`${cmp > 0 ? "higher" : "lower"} commonsensicality score`)} than ${person}`}.</p>`;
  }
  // from "In summary:" on, the panel keeps it at the top (data-llm-top;
  // Josh, October 2026), so the table and the verdict come in under it
  body += beat(T.sum, sum, fresh && fresh.has("person") ? "person" : T.sum, " data-llm-top");
  // one participant and one of their statements, with no links to others
  // (Josh, October 2026)
  return llmChap("llmIndC5", 5, title, true, lead, body);
}

// ── 6 · Aggregating over all participants and LLMs ──
// Chapters 6 and 7 combined (Josh, October 2026). The lead recaps the
// comparison with chapter 5's participant; then, a click each: "If we
// perform this comparison for all 2,046 people:" and the model's bar of the
// participants it scores higher than (orange), ties with (grey) and scores
// lower than (blue), each person on their own 50 statements (one); the
// three shares in a sentence (shares), rounded by largest remainder so they
// add up to 100.0% (llmIndShares()); every LLM's bar, sorted by the share it
// beats (rankInd), with a dashed line at half of participants, the model's
// bar moving from where it stood down into its place among them (llms,
// llmIndMorphBars()); then how many LLMs beat half of people (half). The
// followed model is highlighted; a click on another follows it in place
// (data-ind-pick).
function llmIndCh6(m, md, fresh) {
  const I = LLM.ind, d = LLM.data, A = LLM_IND_AGG, P = d.n_participants, name = esc(m.name), title = llmIndChapters(m)[5];
  if (I.stage < LLM_IND_OPEN[5]) return llmChap("llmIndC6", 6, title, false);
  const R = llmIndPersonRows(md);
  const cmp = R ? R.cmp : 1, pid = R ? R.pr.id : I.person;
  const how = cmp === 0 ? "the same commonsensicality score as" : `a ${cmp > 0 ? "higher" : "lower"} commonsensicality score than`;
  const lead = `We just saw that ${name} achieves ${how} participant #${pid}.`;
  if (I.stage < A.one) return llmChap("llmIndC6", 6, title, true, lead, "");
  const f = (k) => llmFresh(fresh, k);
  const models = [...d.models].sort((a, b) => a.rankInd - b.rankInd), N = models.length;
  const legend =
    `<div class="llm-legend llm-h2h-legend" aria-hidden="true">` +
    `<span><i class="llm-key llm-key-open"></i>LLM scores higher</span>` +
    `<span><i class="llm-key llm-key-tie"></i>Tie</span>` +
    `<span><i class="llm-key llm-key-people"></i>Participant scores higher</span></div>`;
  const head = `<div class="llm-bar-row is-head"><span class="lb-rank">${I.stage >= A.llms ? "#" : ""}</span><span class="lb-name">LLM</span>${llmAxis(LLM_PCT_SCALE)}<span class="lb-val">Higher</span></div>`;
  const [sw, st, sl] = llmIndShares(m.head, P);
  let body =
    `<div class="llm-beat${f(A.one)}" id="llmIndB${A.one}">` +
    `<p class="llm-p">If we perform this comparison for all ${fmtNum(P)} people:</p>`;
  // until every LLM comes in, the model's bar alone; from then on it is one
  // of the 44, below
  // (no legend here: the next sentence names each colour, Josh, October 2026)
  if (I.stage < A.llms) body += `<div class="llm-bars llm-board llm-h2h" id="llmIndOne">${head}${llmIndH2hRow(m, m, "")}</div>`;
  if (I.stage >= A.shares) {
    // each share in its part's colour: higher orange, ties grey, lower blue
    const part = (cls, html) => `<span class="llm-share ${cls}">${html}</span>`;
    body += `<p class="llm-p${f(A.shares)}">${name} ${part("is-open", `scores higher than ${llmB(sw)}`)}, ` +
      `${part("is-tie", `ties with ${llmB(st)}`)}, and ${part("is-human", `scores lower than ${llmB(sl)}`)} of them.</p>`;
  }
  body += `</div>`;
  if (I.stage >= A.llms) {
    const half = models.filter((x) => 2 * x.head.wins > P).length;
    // the board itself is not faded in (.is-morph): its rows come in one by
    // one, and the model's moves down from where its bar stood
    // (the beat itself isn't faded, or the moving bar would fade with it)
    const morph = fresh && fresh.has(A.llms);
    body +=
      `<div class="llm-beat" id="llmIndB${A.llms}">` +
      `<p class="llm-p${f(A.llms)}">If we do the same for all ${N} LLMs, we have the following results.</p>` +
      (morph ? legend.replace('class="llm-legend', 'class="llm-in llm-legend') : legend) +
      `<div class="llm-bars llm-board llm-h2h${morph ? " is-morph llm-in" : ""}" id="llmIndAll">${head}` +
      models.map((x, i) => llmIndH2hRow(x, m, i + 1, morph)).join("") + `</div>` +
      (I.stage >= A.half
        ? `<p class="llm-p${f(A.half)}">Thus, ${2 * half < N ? "only " : ""}${llmB(`${half} out of ${N}`)} LLMs are rated more commonsensical than half of the human population.</p>` +
          `<p class="llm-note${f(A.half)}">Point at a bar for its counts, or click it to follow that LLM.</p>`
        : "") +
      `</div>`;
  }
  return llmChap("llmIndC6", 6, title, true, lead, body);
}

// The shares of participants a model scores higher than, ties with and
// scores lower than, each to one decimal and rounded by largest remainder,
// so the three add up to 100.0% (rounded one by one, GPT-4o's 652, 22 and
// 1,372 of 2,046 read 31.9%, 1.1% and 67.1%)
function llmIndShares(h, P) {
  return llmRoundTo([h.wins, h.ties, h.losses], 1000).map((v) => `${(v / 10).toFixed(1)}%`);
}

// One model's row of chapter 6's board: its rank (empty for the model's bar
// alone), name, bar and the share it beats; the followed model (m)
// highlighted
function llmIndH2hRow(x, m, rank, keep = false) {
  const h = x.head, P = LLM.data.n_participants;
  const [w, t, l] = llmIndShares(h, P);
  const tip = `<strong>${esc(x.name)}</strong><br>Scores higher than ${fmtNum(h.wins)} participants (${w})` +
    `<br>Ties with ${fmtNum(h.ties)} (${t})<br>Scores lower than ${fmtNum(h.losses)} (${l})`;
  return (
    `<div class="llm-bar-row${x.id === m.id ? " is-selected" : ""}"${keep && x.id === m.id ? " data-llm-keep" : ""} data-ind-pick="${esc(x.id)}" data-llm-tip="${esc(tip)}" role="button" tabindex="0"` +
    ` aria-label="${esc(`${x.name}: scores higher than ${w}, ties with ${t} and scores lower than ${l} of participants. Follow this model.`)}">` +
    `<span class="lb-rank">${rank}</span><span class="lb-name">${llmName(x)} <span class="lb-org">${esc(x.organization || "")}</span></span>` +
    llmStackTrack([[h.wins / P, "is-open"], [h.ties / P, "is-tie"], [h.losses / P, "is-human"]], [{ x: 0.5, cls: "is-half" }]) +
    `<span class="lb-val">${w}</span></div>`
  );
}

// Chapter 6's move from the model's bar to every LLM's: from (the bar's
// place before the click, in the panel's scrolled coordinates) to the
// model's row among the 44, which starts there and slides down into place
// while the other rows come in, nearest first (CSS animations, so they
// always finish, and none under reduced motion)
function llmIndMorphBars(from) {
  const wrap = document.getElementById("llmWrap"), board = document.getElementById("llmIndAll");
  if (!wrap || !board) return;
  const rows = [...board.querySelectorAll(".llm-bar-row:not(.is-head)")];
  const k = rows.findIndex((r) => r.classList.contains("is-selected"));
  if (k < 0) return;
  const to = rows[k].getBoundingClientRect().top + wrap.scrollTop;
  const dy = from === null ? 0 : from - to;
  rows.forEach((r, i) => {
    if (i === k) {
      r.style.setProperty("--dy", `${dy.toFixed(1)}px`);
      r.classList.add("is-fly");
    } else {
      r.style.setProperty("--d", `${450 + 28 * Math.abs(i - k)}ms`);
      r.classList.add("is-rise");
    }
  });
}

// A bar of parts ([share, fill class]) laid end to end, with reference lines
function llmStackTrack(parts, refs = []) {
  let left = 0;
  return (
    `<div class="llm-track is-stack">` +
    refs.map((r) => `<span class="llm-ref ${r.cls || ""}" style="left:${llmPos(r.x, LLM_PCT_SCALE).toFixed(2)}%"></span>`).join("") +
    parts.map(([v, cls]) => {
      const html = `<span class="llm-fill ${cls}" style="left:${(left * 100).toFixed(2)}%;width:${(v * 100).toFixed(2)}%"></span>`;
      left += v;
      return html;
    }).join("") + `</div>`
  );
}

// The tooltip of anything in the panel with data-llm-tip (HTML, escaped in
// the attribute)
function llmHoverTip(e) {
  let tip = document.getElementById("llmHoverTip");
  const el = e && e.type !== "pointerleave" && e.target.closest && e.target.closest("[data-llm-tip]");
  if (!el) { if (tip) tip.hidden = true; return; }
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "llmHoverTip";
    tip.className = "llm-tip";
    tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tip);
  }
  if (tip.dataset.for !== el.dataset.llmTip) {
    tip.dataset.for = el.dataset.llmTip;
    tip.innerHTML = el.dataset.llmTip;
  }
  tip.hidden = false;
  _positionTooltip(tip, e.clientX, e.clientY);
}

// ── Story controls ──

function llmIndNext() {
  const I = LLM.ind, m = llmModel();
  if (!LLM.md || !m) return;
  if (llmIndCounting()) return;  // still counting
  if (I.stage >= LLM_IND_LAST) { llmShowView("population"); return; }
  I.stage++;
  const fresh = new Set([I.stage]);
  for (const key of ["c", "a"]) if (I.stage === LLM_IND_RUN[key]) fresh.add(`run-${key}`);
  const ch = LLM_IND_OPEN.filter((s) => I.stage >= s).length;
  llmIndPaint(fresh, [ch]);
  if (LLM_IND_OPEN.includes(I.stage)) document.getElementById(`llmIndC${ch}`)?.classList.add("llm-in");
}

function llmIndAction(action) {
  const d = LLM.data, I = LLM.ind;
  if (!LLM.md) return;
  if (action === "ind-another") {
    I.ex = llmRandomStatement(I.ex, llmIndTelling);
    llmIndPaint(new Set(["ex"]), [1]);
  } else if (action === "ind-person") {
    I.person = llmIndRandomPerson(I.person);
    I.pex = null;
    llmIndLoadPerson().then(() => llmIndPaint(new Set(["pex", "person"]), [5, 6]))
      .catch((err) => console.error("LLM participant load failed:", err));
  } else if (action === "ind-pstmt" && I.personRatings) {
    const pool = I.personRatings.ratings.map((r) => r[0]).filter((id) => id !== I.pex && !d.statements[id].placeholder);
    if (pool.length) I.pex = pool[Math.floor(Math.random() * pool.length)];
    llmIndPaint(new Set(["pex"]), [5]);
  }
}

// Previous: the latest step taken away. A count stepped back before is
// forgotten, so it runs again on the way forward.
function llmIndPrev() {
  const I = LLM.ind;
  if (!LLM.md || I.stage <= 0) return;
  llmIndRunStop();
  I.stage--;
  for (const key of ["c", "a"]) if (I.stage < LLM_IND_RUN[key]) I.ran[key] = false;
  llmIndPaint(null);
}

// Opens the story up to stage (the chapter links and "Show all steps")
function llmIndOpenTo(stage) {
  const I = LLM.ind;
  if (stage <= I.stage) return;
  I.stage = stage;
  const fresh = new Set();
  for (const key of ["c", "a"]) {
    if (stage > LLM_IND_RUN[key]) I.ran[key] = true;
    else if (stage === LLM_IND_RUN[key]) fresh.add(`run-${key}`);
  }
  llmIndPaint(fresh);
}

// Start over: the story as it first opens, with its first statement and
// person, for the model in the picker
function llmIndRestart() {
  const I = LLM.ind;
  if (!LLM.md || I.stage === 0) return;
  llmIndRunStop();
  Object.assign(I, { stage: 0, ex: llmIndDefaultEx(), person: llmIndDefaultPerson(), pex: null, ran: { c: false, a: false } });
  llmIndPaint(null);
  llmStoryTop();
  // the first person's statements, ready before chapter 4 opens again
  llmIndLoadPerson().then(() => { if (I.stage >= LLM_IND_OPEN[4]) llmIndPaint(null, [5, 6]); })
    .catch((err) => console.error("LLM participant load failed:", err));
}

// Scrolls the panel back to the top of the story
function llmStoryTop() {
  document.getElementById("llmWrap")?.scrollTo({ top: 0, behavior: llmReduced() ? "auto" : "smooth" });
}

// ══ LLMs as populations ════════════════════════════════════════════════════
// Stages, one per click of Next, as in the individual story (Josh, October
// 2026: a click per sentence or element, wherever a step can be broken
// down). Stage 0 is the header alone; a click opens chapter 1. Chapters 1
// and 2 show how a crowd scores a statement: two statements and their
// raters, a share a click (1); statement 1 scored, each question alone,
// then people's answers, then the score it defines, then the two combined
// and the score as a sentence (2); both statements' three scores side by
// side, a row a click, and which is more commonsensical (3). Then the
// model's population, following statement 2 from here on: the lead
// alone, the statement, real people, then the population's two answers a
// click each (4); the statement scored in each population, a row of the
// table a click (5); the scatter plot of the two scores over every
// statement, opening, as the individual story's chapter 3 does, on the
// statement's two values marked on the axes, then its point, every point,
// the line and r (6); the baseline, two random halves of people, each
// half a click, then their scatter plot built the same way (7); r over
// many splits, its average and its spread each a click and marked on the
// plot as they are named (8); every LLM's r (9). What a later click shows
// in a row or a column holds its place, hidden (.is-pend), so nothing
// moves when it appears. The plots animate when they open (on a timer),
// and the next step waits for them to finish. Chapters 1–7 are narrated as
// the individual story's chapters 1–3 are ("Consider …", "Thus, …", the
// key word in bold, sentences in place of labels).

// The chapters' names in the story's header (chapter 2's card is titled
// with its question)
function llmPopChapters(m) {
  return ["Statement ratings", "Measuring a statement's common sense", "Comparing the two statements", `${llmName(m)}'s population`, "One statement, two scores", "Across all statements", "Setting up a baseline", "Many random splits", "Aggregating over all LLMs"];
}
// (the chapter that counted each population's scores, "Aggregating over all
// statements", was removed at Josh's request, October 2026: chapter 4 leads
// straight to the scatter plot)
// (the verdict for the followed model alone was removed too, at Josh's
// request: the baseline leads straight to every LLM, as the individual
// story ends)
const LLM_POP_OPEN = [1, 7, 16, 21, 26, 31, 35, 44, 50];   // the stage that opens each chapter
const LLM_POP_LAST = 52;
// The steps inside chapters, by name, so no stage number is written twice
const LLM_POP_AT = (() => {
  const O = LLM_POP_OPEN;
  return {
    // chapter 2 opens on statement 2 alone; then, a click each, question 1
    // alone (q1), people's answers and the sentence that counts them (r1),
    // the consensus defined (cDef); the same for question 2 (q2, r2, aDef);
    // the two combined (comb) and the score as a sentence (score)
    q1: O[1] + 1, r1: O[1] + 2, cDef: O[1] + 3, q2: O[1] + 4, r2: O[1] + 5, aDef: O[1] + 6, comb: O[1] + 7, score: O[1] + 8,
    // chapter 3 (Josh, October 2026): the lead alone (cmp), then the table
    // comparing the two statements a row a click (cmpC, cmpA, cmpS), then
    // which is more commonsensical (cmpThus)
    cmp: O[2], cmpC: O[2] + 1, cmpA: O[2] + 2, cmpS: O[2] + 3, cmpThus: O[2] + 4,
    // chapter 4: the lead alone (pop), "Coming back to statement 2." and the
    // statement (stmt), real people (people), then the population's share
    // that agrees (popAgree) and the share that predicts most would (popPred)
    pop: O[3], stmt: O[3] + 1, people: O[3] + 2, popAgree: O[3] + 3, popPred: O[3] + 4,
    // chapter 5: the lead and the statement (two), then the table a row a
    // click (cons, aware, css), then the conclusion (thus)
    two: O[4], cons: O[4] + 1, aware: O[4] + 2, css: O[4] + 3, thus: O[4] + 4,
    // chapter 6: the sentence beside the plot with the statement's two
    // values on the axes (sctOne), its point (sctPt), every statement
    // (sctAll), the line and r (sctFit)
    sctOne: O[5], sctPt: O[5] + 1, sctAll: O[5] + 2, sctFit: O[5] + 3,
    // chapter 7: the question alone (split), the two halves (imagine; the
    // split loads on this click), "Here are what their ratings look like."
    // and the statement (crowds), half A (halfA), half B (halfB), the
    // statement's score in each half beside the plot with its values on
    // the axes (one), its point (onePt), every statement (halves), the line
    // and r (halvesFit)
    split: O[6], imagine: O[6] + 1, crowds: O[6] + 2, halfA: O[6] + 3, halfB: O[6] + 4,
    one: O[6] + 5, onePt: O[6] + 6, halves: O[6] + 7, halvesFit: O[6] + 8,
    // chapter 8: the lead alone, this split's r (splits); the dot plot with
    // only this split's dot, falling onto the axis (splitsOne); every other
    // split's dot falling onto it (splitsHist); its average, marked on the
    // plot (splitsAvg), the range of 95% of splits, shaded (splitsRange), the
    // split-half reliability (splitsThus)
    splits: O[7], splitsOne: O[7] + 1, splitsHist: O[7] + 2, splitsAvg: O[7] + 3, splitsRange: O[7] + 4, splitsThus: O[7] + 5,
    // chapter 9: the followed model against the baseline (allLlms), every
    // LLM's bar (allBars), then the best model, in the room kept for it
    // over the bars (allBest)
    allLlms: O[8], allBars: O[8] + 1, allBest: O[8] + 2,
  };
})();
// Chapter 1's two statements (Josh, October 2026: something more interesting
// than "Oranges grow on trees", and plainer than "A person doesn't want a fly
// in their soup", and not quite unanimous, Josh): statement 1, which 27 of
// its 28 raters agree with and 25 expect most to agree with
// (commonsensicality 91.1%), and statement 2, lower on both, with two different shares (Josh):
// 15 of its 28 raters agree but 19 expect most to agree (22.0%); picked to
// read cleanly, with no stand-in names (statement 2 is also the Overview's
// second task example, LLM_TASK_EXAMPLES)
const LLM_POP_INTRO = ["The first thing you do when you cook is wash your hands.", "An apple a day keeps the doctor away."];
// Chapter 1's steps: the two statements (open), the share who agree with
// statement 1, then statement 2 (agree), the share who predict most others
// would agree, statement 1's then 2's (predict), and which is more
// commonsensical (verdict)
const LLM_POP_INTRO_AT = { open: LLM_POP_OPEN[0], agree: [2, 3], predict: [4, 5], verdict: 6 };
// The next step waits while a split loads and while a plot draws
function llmPopBusy() {
  const Q = LLM.pop;
  return Q.busy || Q.anim !== null;
}

function llmPopNextLabel(m) {
  const Q = LLM.pop, n = fmtNum(LLM.data.n_statements);
  if (Q.anim !== null) return "Plotting…";
  if (Q.busy) return "Splitting the people…";
  const K = fmtNum(LLM.data.models.length);
  // the label for the step Next takes (stage + 1)
  return [
    "Start with two statements",
    "How many agree with statement 1?",
    "How many agree with statement 2?",
    "What do statement 1's raters predict?",
    "What do statement 2's raters predict?",
    "Compare the two statements",
    "Measure statement 1's common sense",
    "Ask the first question",
    "Show how people answered",
    "Define its consensus",
    "Ask the second question",
    "Show their predictions",
    "Define its awareness",
    "Combine them into one score",
    "Show its commonsensicality",
    "Compare the two statements",
    "Compare their consensus",
    "Compare their awareness",
    "Compare their commonsensicality",
    "Which is more commonsensical?",
    `Meet ${m.name}'s population`,
    "Come back to statement 2",
    "Show how real people rated it",
    "How many in the population agree?",
    "What does the population predict?",
    "Score the statement in each population",
    "Compare their consensus",
    "Compare their awareness",
    "Compare their commonsensicality",
    "Sum up",
    "Compare across all statements",
    "Plot statement 2",
    `Plot all ${n} statements`,
    "Show the correlation",
    "Set up a baseline",
    "Split the people in two",
    "Show their ratings",
    "Show half A",
    "Show half B",
    "Score statement 2 in each half",
    "Plot statement 2",
    `Plot all ${n} statements`,
    "Show the correlation",
    "Try many random splits",
    "Plot this split",
    `Split ${fmtNum(LLM.data.split_half.n_splits)} times`,
    "Average them",
    "Show their spread",
    "Set the baseline",
    `Compare all ${K} LLMs`,
    `Show all ${K} LLMs`,
    "Find the best LLM",
  ][Q.stage] ?? "Next: the overview";
}

function llmPopStepper() {
  const Q = LLM.pop, m = llmModel();
  if (!m) return;
  llmStepper("population", { stage: Q.stage, total: LLM_POP_LAST, label: llmPopNextLabel(m), busy: llmPopBusy(), end: Q.stage >= LLM_POP_LAST });
}

async function llmRenderPopulation() {
  const seq = ++LLM.renderSeq;
  const m = llmModel();
  const d = LLM.data, Q = LLM.pop;
  const story = document.getElementById("llmPopStory");
  story.classList.add("llm-loading");
  if (Q.ex === null) Q.ex = llmPopDefaultEx();
  let md;
  try {
    md = await llmGet(`/llm-evals/model?id=${encodeURIComponent(m.id)}`);
    if (Q.stage >= LLM_POP_AT.split && !llmPopSplitReady()) await llmPopLoadSplit();
  } catch (err) {
    console.error("LLM model load failed:", err);
    if (seq === LLM.renderSeq) story.innerHTML = '<div class="chart-card empty-row">The model\'s scores could not be loaded. Try refreshing the page.</div>';
    return;
  } finally {
    story.classList.remove("llm-loading");
  }
  if (seq !== LLM.renderSeq) return;
  LLM.md = md;
  LLM.popRows = d.statements.map((s, i) => ({ ...s, model: md.scores[i], diff: md.scores[i] - s.humans }));
  llmPopPaint(null);
  llmRevealPending();
}

// The order chapter 5 scores and plots the statements in (fixed, as in the
// individual story's count)
function llmPopOrder() {
  const Q = LLM.pop;
  return Q.order || (Q.order = llmShuffle(LLM.data.statements.map((s) => s.id)));
}

function llmPopSplitReady() {
  const Q = LLM.pop;
  return !!Q.split && Q.split.seed === Q.seed && Q.split.example.id === Q.ex;
}

async function llmPopLoadSplit() {
  const Q = LLM.pop;
  Q.split = await llmGet(`/llm-evals/split?seed=${Q.seed}&statement=${Q.ex}`);
  if (!Q.splits.some((x) => x.seed === Q.seed)) Q.splits.push({ seed: Q.seed, r: Q.split.r });
}

// Chapter 3's lead (Josh's wording, shortened at his request for less
// text), with the model's answer to the chapters' statement, which is quoted
// under it
function llmPopLead(m) {
  return `Here, we consider ${esc(m.name)} not as an individual but as a <strong>human-like population</strong>.`;
}
// The statement chapters 3 on follow: chapter 1's statement 2, which chapter
// 2 scores among people (Josh, October 2026), or the paper's example
function llmPopDefaultEx() {
  const d = LLM.data;
  return d.statements.find((x) => x.raw === LLM_POP_INTRO[1])?.id ?? d.examples.population ?? llmRandomStatement();
}

// Redraws the header, the chapters (all, or those in only) and the stepper;
// fresh holds what the latest click revealed: stage numbers, "ex" for a new
// statement and "split" for a new split
function llmPopPaint(fresh, only = null) {
  const m = llmModel(), md = LLM.md, Q = LLM.pop;
  if (!m || !md || md.id !== m.id || !LLM.popRows) return;
  llmPopAnimStop();
  const opened = LLM_POP_OPEN.filter((s) => Q.stage >= s).length;
  document.getElementById("llmPopHead").innerHTML = llmStoryHead("population", m, llmPopChapters(m), opened, { stage: Q.stage, end: Q.stage >= LLM_POP_LAST });
  const chapters = [llmPopCh1, llmPopCh2, llmPopCh3, llmPopCh4, llmPopCh5, llmPopCh6, llmPopCh7, llmPopCh8, llmPopCh9];
  const story = document.getElementById("llmPopStory");
  const all = only === null || !story.children.length;
  const which = all ? chapters.map((_, i) => i + 1) : only;
  if (all) story.innerHTML = chapters.map((f) => f(m, md, fresh)).join("");
  else for (const k of only) {
    const el = document.getElementById(`llmPopC${k}`);
    if (el) el.outerHTML = chapters[k - 1](m, md, fresh);
  }
  const has = (k) => !!fresh && fresh.has(k);
  const A = LLM_POP_AT;
  if (which.includes(6) && Q.stage >= A.sctAll && has(A.sctAll)) llmSctAnimate("llmPopSctSvg", A.sctAll);
  if (which.includes(7) && Q.stage >= A.halves && has(A.halves) && llmPopSplitReady()) llmSctAnimate("llmPopHalvesSvg", A.halves);
  llmPopStepper();
}

// The story's running animation, if any: its timer, and finish(), which
// draws its last frame at once (when the story is redrawn mid-animation)
const _llmPopAnim = { token: 0, timer: null, finish: null };
function llmPopAnimStop() {
  clearInterval(_llmPopAnim.timer);
  _llmPopAnim.token++;
  const f = _llmPopAnim.finish;
  _llmPopAnim.finish = null;
  if (f) f(false);
}

// Calls frame(p) with p eased from 0 to 1 over dur ms, then done(natural),
// natural false when the animation was cut short
function llmPopAnimate(dur, frame, done) {
  llmPopAnimStop();
  const token = _llmPopAnim.token, t0 = Date.now();
  let over = false;
  const finish = (natural) => {
    if (over) return;
    over = true;
    clearInterval(_llmPopAnim.timer);
    _llmPopAnim.finish = null;
    frame(1);
    done(natural);
  };
  if (llmReduced()) { finish(true); return; }
  _llmPopAnim.finish = finish;
  frame(0);
  _llmPopAnim.timer = setInterval(() => {
    if (token !== _llmPopAnim.token) { clearInterval(_llmPopAnim.timer); return; }
    const p = Math.min(1, (Date.now() - t0) / dur);
    if (p >= 1) finish(true);
    else frame(1 - (1 - p) ** 2);
  }, 40);
}

// ── 1 · Statement ratings (stages 1–6). Stage 0 is the header alone and a
// click opens the chapter, as in the individual story (Josh, October 2026);
// then a click each: the two statements side by side (open), the share of
// statement 1's raters who agree, then statement 2's (agree), the share
// who predict most others would agree, statement 1's then 2's (predict),
// and which is more commonsensical (verdict). Each share is a sentence
// over 20 figures (people's blue, question 2's teal), percentages only. A
// row's second cell holds its place, hidden, until its click. ──

function llmPopCh1(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, A = LLM_POP_INTRO_AT, title = llmPopChapters(m)[0];
  if (Q.stage < A.open) return llmChap("llmPopC1", 1, title, false);
  const shown = LLM_POP_INTRO.map((t) => d.statements.find((x) => x.raw === t)).filter(Boolean);
  const FIGS = 20;
  const figs = (share, cls) => llmFigureRow(Math.round(share * FIGS), FIGS, cls, "is-grid");
  // the two columns; with sts (a stage per column), each column shows from
  // its own click, held in place and hidden until then (.is-pend)
  const cols = (f, sts = null) => `<div class="llm-crowd-cols">${shown.map((s, i) => {
    const cls = !sts ? "" : Q.stage < sts[i] ? " is-pend" : i ? llmFresh(fresh, sts[i]) : "";
    return `<div class="llm-crowd-col${cls}">${f(s, i + 1)}</div>`;
  }).join("")}</div>`;
  const row = (sts, f) => (Q.stage >= sts[0] ? `<div class="llm-beat${llmFresh(fresh, sts[0])}" id="llmPopB${sts[0]}">${cols(f, sts)}</div>` : "");
  let body = cols((s, k) =>
    `<div class="llm-stmt-label">Statement ${k}</div><blockquote class="llm-ex-quote is-sm">${esc(s.text)}</blockquote>`);
  body += row(A.agree, (s, k) =>
    `<p class="llm-p">${llmB(llmPctEx(s.k_agree / s.n))} of people agreed with statement ${k}.</p>${figs(s.k_agree / s.n, "is-p")}`);
  body += row(A.predict, (s, k) =>
    `<p class="llm-p">${llmB(llmPctEx(s.k_others / s.n))} of people predicted that most others would agree <span class="llm-nowrap">with statement ${k}.</span></p>${figs(s.k_others / s.n, "is-q2")}`);
  if (Q.stage >= A.verdict && shown.length === 2) {
    const [a, b] = shown, more = a.humans >= b.humans;
    body += `<div class="llm-beat${llmFresh(fresh, A.verdict)}" id="llmPopB${A.verdict}"><p class="llm-p">Intuitively, ` +
      `<strong>statement ${more ? 1 : 2}</strong> should be <strong>much more commonsensical</strong> than <strong>statement ${more ? 2 : 1}</strong>.</p></div>`;
  }
  return llmChap("llmPopC1", 1, title, true, "Consider the following two statements:", body);
}

// ── 2 · Measuring a statement's common sense (stages 7–15; Josh, October
// 2026): chapter 1's statement 1 again (the one people agree on, so the
// score it gets is high; statement 2's follows in chapter 3), with chapter 1's percentages and
// colours (people's agreement in blue, their predictions in teal, 20
// figures), opening on the statement alone, then a click each, as the
// individual story's chapter 1 asks its questions: question 1 alone (q1),
// people's answers as figures and the sentence that counts them (r1), the
// consensus defined (cDef); the same for question 2 (q2, r2, aDef); then
// the two combined, in the individual story's chapter 3's words and display
// (comb), and, as that chapter ends, the score as a sentence (score). Every
// percentage to one decimal (Josh). ──

function llmPopCh2(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, A = LLM_POP_AT, title = llmPopChapters(m)[1];
  if (Q.stage < LLM_POP_OPEN[1]) return llmChap("llmPopC2", 2, title, false);
  const s = d.statements.find((x) => x.raw === LLM_POP_INTRO[0]);
  if (!s) return llmChap("llmPopC2", 2, title, true, "", "");
  const pa = s.k_agree / s.n, po = s.k_others / s.n, sc = llmCrowdScore(pa, po);
  const pPred = sc.maj ? po : 1 - po;   // those who predict the majority
  const FIGS = 20, f = (st) => llmFresh(fresh, st);
  const figs = (share, cls, st) => llmFigureRow(Math.round(share * FIGS), FIGS, cls, `is-grid${f(st)}`);
  const p = (st, html) => (Q.stage >= st ? `<p class="llm-p${f(st)}" id="llmPopB${st}">${html}</p>` : "");
  // a question alone; a click later, people's answers as figures and the
  // sentence that counts them; another click, the score that defines (each
  // definition indented as the result above it, with no rule above it)
  const step = (q, num, text, r, share, cls, said, def, defHtml) => (Q.stage < q ? "" :
    `<div class="llm-beat llm-irun llm-crowd-beat${f(q)}" id="llmPopB${q}">` +
    llmQuestion(num, text) + (Q.stage >= r ? figs(share, cls, r) : "") + p(r, said) + p(def, defHtml) + `</div>`);
  // Every percentage to one decimal, even where 2 × |53.6% − 50%| reads 7.1%
  // (Josh: fine)
  let body = `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote>`;
  body += step(A.q1, 1, "How close are people to a unanimous judgment?", A.r1, pa, "is-p",
    sc.c < 0.3 ? `People are split: only ${llmB(fmtPct(pa))} of them agreed with this statement.` : `${llmB(fmtPct(pa))} of people agreed with this statement.`,
    A.cDef, `Define the statement's <strong>consensus</strong> score to be how far this percentage is from a 50-50 split:<span class="llm-formula-line">2 × |${fmtPct(pa)} − 50%| = ${llmB(fmtPct(sc.c))}.</span>`);
  body += step(A.q2, 2, "How many accurately predict the opinion of most other people?", A.r2, po, "is-q2",
    `${llmB(fmtPct(pPred))} of people accurately predicted that most others ${sc.maj ? "would agree" : "would not agree"} with this statement.`,
    A.aDef, `Define the statement's <strong>awareness</strong> score as the share of correct predictions, ${llmB(fmtPct(pPred))}.`);
  if (Q.stage >= A.comb) {
    body +=
      `<div class="llm-beat llm-calc-box${f(A.comb)}" id="llmPopB${A.comb}">` +
      `<p class="llm-p">We combine these two scores into a <strong>commonsensicality score</strong> by taking their geometric average.</p>` +
      `<div class="llm-calc">${llmCalcRow("Commonsensicality", sqrtHtml("consensus × awareness"))}` +
      llmCalcRow("", sqrtHtml(`${fmtPct(sc.c)} × ${fmtPct(sc.a)}`)) + llmCalcRow("", fmtPct(sc.s), llmSqrtEq(sc.c, sc.a)) + `</div>` +
      p(A.score, `Thus, statement 1 receives a commonsensicality score of ${llmB(fmtPct(sc.s))}.`) + `</div>`;
  }
  return llmChap("llmPopC2", 2, title, true, "Consider statement 1 again.", body);
}

// ── 3 · Comparing the two statements (stages 16–20; Josh, October 2026):
// chapter 2's three scores for statement 1 beside statement 2's, laid out as
// chapter 5's table, a row per score and a column per statement, each cell
// its value and a bar (people's blue, both columns being people's), with
// no working under it; the lead alone (cmp),
// then a row a click (cmpC, cmpA, cmpS; the higher commonsensicality
// marked), then which is more commonsensical (cmpThus), paying off chapter
// 1's "Intuitively, …" ──

function llmPopCh3(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, A = LLM_POP_AT, title = llmPopChapters(m)[2];
  if (Q.stage < A.cmp) return llmChap("llmPopC3", 3, title, false);
  const lead = "If we score both statements in the same way, we have the following results.";
  const shown = LLM_POP_INTRO.map((t) => d.statements.find((x) => x.raw === t)).filter(Boolean);
  if (Q.stage < A.cmpC || shown.length < 2) return llmChap("llmPopC3", 3, title, true, lead, "");
  const f = (st) => llmFresh(fresh, st);
  const cols = shown.map((s) => {
    return { s, sc: llmCrowdScore(s.k_agree / s.n, s.k_others / s.n) };
  });
  const win = cols[0].sc.s === cols[1].sc.s ? -1 : cols[0].sc.s > cols[1].sc.s ? 0 : 1;
  // each cell its value and a bar, with no working under it (Josh, October
  // 2026: chapter 2 has just shown it)
  const cell = (v, mark, fx) =>
    `<div class="llm-ps-cell${mark ? " is-win" : ""}${fx}"><div class="llm-ps-v">${fmtPct(v)}</div>${llmTrack(v, LLM_PCT_SCALE, "is-human")}</div>`;
  // each row fades in on its click (the first with the table)
  const row = (st, label, fn, total = false) => {
    if (Q.stage < st) return "";
    const fx = st === A.cmpC ? "" : f(st);
    return `<div class="llm-ps-k${total ? " is-total" : ""}${fx}">${label}</div>` + cols.map((c, i) => fn(c, fx, total && i === win)).join("");
  };
  const th = (i) => `<div class="llm-ps-th">Statement ${i + 1}<span>“${esc(cols[i].s.text.replace(/\.$/, ""))}”</span></div>`;
  const table =
    `<div class="llm-ps llm-vs${f(A.cmpC)}" id="llmPopB${A.cmpC}"><div class="llm-ps-th"></div>${th(0)}${th(1)}` +
    row(A.cmpC, "Consensus", (c, fx) => cell(c.sc.c, false, fx)) +
    row(A.cmpA, "Awareness", (c, fx) => cell(c.sc.a, false, fx)) +
    row(A.cmpS, "Commonsensicality", (c, fx, mark) => cell(c.sc.s, mark, fx), true) +
    `</div>`;
  let after = "";
  if (Q.stage >= A.cmpThus) {
    const [a, b] = cols, more = a.sc.s >= b.sc.s, hi = more ? a : b, lo = more ? b : a;
    const much = Math.abs(a.sc.s - b.sc.s) >= 0.2 ? "much " : "";
    after =
      `<div class="llm-ps-text${f(A.cmpThus)}" id="llmPopB${A.cmpThus}"><p class="llm-p">According to humans, statement ${more ? 1 : 2} is ` +
      `${llmB(`${much}more commonsensical`)} than statement ${more ? 2 : 1} (${llmB(`${fmtPct(hi.sc.s)} vs. ${fmtPct(lo.sc.s)}`)}).</p></div>`;
  }
  return llmChap("llmPopC3", 3, title, true, lead, table + after);
}

// ── 4 · The model's population, beside the real raters of one statement
// (stages 16–20): Josh's lead alone; then "Coming back to statement 2." and
// the statement; real people; the population's share that agrees; the
// share that predicts most would agree. The population's column holds its
// place, hidden, until its clicks. ──

function llmPopCh4(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, A = LLM_POP_AT, s = d.statements[Q.ex], name = esc(m.name), title = `${name}'s population`;
  if (Q.stage < A.pop) return llmChap("llmPopC4", 4, title, false);
  if (Q.stage < A.stmt) return llmChap("llmPopC4", 4, title, true, llmPopLead(m), "");
  const [p1, p2] = md.ratings[s.id];
  // The real raters (blue) beside the model's population (orange), each
  // answering the two questions, as shares only and the same 20 figures on
  // every row, as in chapters 1 and 2 (Josh, October 2026: the percentage
  // matters, not how many rated it). The two crowds sit side by side, each
  // only as wide as it needs (.llm-crowd-pair).
  const FIGS = 20, f = (st) => llmFresh(fresh, st);
  const pend = (st) => (Q.stage >= st ? f(st) : " is-pend");
  const figs = (share, cls, more = "") => llmFigureRow(Math.round(share * FIGS), FIGS, cls, `is-grid${more}`);
  const pa = s.k_agree / s.n, po = s.k_others / s.n;
  const people =
    `<div class="llm-crowd-col">${llmWho("Real people", false, "llm-who-tag")}` +
    `<p class="llm-p">${llmB(fmtPct(pa))} agree with the statement.</p>${figs(pa, "is-p")}` +
    `<p class="llm-p">${llmB(fmtPct(po))} think most people would agree with it.</p>${figs(po, "is-q2")}</div>`;
  const pop =
    `<div class="llm-crowd-col${pend(A.popAgree)}">${llmWho(`${name}'s population`, true, "llm-who-tag")}` +
    `<p class="llm-p">${llmB(llmProbFine(p1))} agree with the statement.</p>${figs(p1, "is-m")}` +
    `<p class="llm-p${pend(A.popPred)}">${llmB(llmProbFine(p2))} think most people would agree with it.</p>${figs(p2, "is-m", pend(A.popPred))}</div>`;
  const body = `<div class="${(f(A.stmt) || llmFresh(fresh, "ex")).trim()}" id="llmPopB${A.stmt}">` +
    `<p class="llm-p">Coming back to statement 2.</p><blockquote class="llm-ex-quote">${esc(s.text)}</blockquote>` +
    (Q.stage >= A.people ? `<div class="llm-crowd-cols llm-crowd-pair${f(A.people)}" id="llmPopB${A.people}">${people}${pop}</div>` : "") +
    `</div>`;
  return llmChap("llmPopC4", 4, title, true, llmPopLead(m), body);
}

// ── 5 · One statement, two scores (stages 21–25): the lead and the
// statement; then the table a row a click, consensus, awareness and
// commonsensicality, each against its own population's majority; then Josh's
// closing sentence, "Thus, …" with its key word in bold, as the individual
// story's are ──

// The statement's score among its raters (h) and in the model's population (c)
function llmPopExScores(md) {
  const s = LLM.data.statements[LLM.pop.ex], [p1, p2] = md.ratings[s.id];
  return { s, p1, p2, h: llmCrowdScore(s.k_agree / s.n, s.k_others / s.n), c: llmCrowdScore(p1, p2) };
}

function llmPopCh5(m, md, fresh) {
  const Q = LLM.pop, A = LLM_POP_AT, name = esc(m.name), title = llmPopChapters(m)[4];
  if (Q.stage < A.two) return llmChap("llmPopC5", 5, title, false);
  const { s, p1, p2, h, c } = llmPopExScores(md);
  const lead = "If we score statement 2 in both populations, we have the following results.";
  const quote = `<blockquote class="llm-ex-quote${llmFresh(fresh, "ex")}">${esc(s.text)}</blockquote>`;
  if (Q.stage < A.cons) return llmChap("llmPopC5", 5, title, true, lead, quote);
  const pa = s.k_agree / s.n, f = (st) => llmFresh(fresh, st);
  // One table: a row per score, a column per population; each cell its
  // value, a bar and, under them, how it is worked out
  const cell = (calc, v, bar, total, fx) =>
    `<div class="llm-ps-cell${total ? " is-win" : ""}${fx}"><div class="llm-ps-v">${llmPctFine(v)}</div>${llmTrack(v, LLM_PCT_SCALE, bar)}<div class="llm-sc-calc">${calc}</div></div>`;
  // how many predict the majority, which way it points, and a tie (half
  // agree), which counts as a majority that agrees
  const pred = (x, share, predicted) =>
    (share === 0.5 ? "Exactly half agree, which counts as a majority that agrees; " : "") +
    `${predicted} correctly predict that most would ${x.maj ? "" : "not "}agree`;
  const kPred = h.maj ? s.k_others : s.n - s.k_others;
  // each row fades in on its click (the first with the table)
  const row = (st, label, fn) => {
    if (Q.stage < st) return "";
    const fx = st === A.cons ? "" : f(st);
    return `<div class="llm-ps-k${label === "Commonsensicality" ? " is-total" : ""}${fx}">${label}</div>` +
      fn(h, pa, `${fmtNum(kPred)} out of ${fmtNum(s.n)}`, "is-human", fx) + fn(c, p1, llmProbFine(c.maj ? p2 : 1 - p2), "is-open", fx);
  };
  const table =
    `<div class="llm-ps llm-vs${f(A.cons)}" id="llmPopB${A.cons}">` +
    `<div class="llm-ps-th"></div><div class="llm-ps-th">${llmWho("Real people", false)}</div><div class="llm-ps-th">${llmWho(`${name}'s population`, true)}</div>` +
    row(A.cons, "Consensus", (x, share, _, bar, fx) => cell(`2 × |${llmPct2(share)} − 50%|`, x.c, bar, false, fx)) +
    row(A.aware, "Awareness", (x, share, predicted, bar, fx) => cell(pred(x, share, predicted), x.a, bar, false, fx)) +
    // two decimals inside the square root, as in the consensus line, so the
    // result above can be checked from them
    row(A.css, "Commonsensicality", (x, share, _, bar, fx) => cell(sqrtHtml(`${llmPctCalc(x.c)} × ${llmPctCalc(x.a)}`), x.s, bar, true, fx)) +
    `</div>`;
  let after = "";
  if (Q.stage >= A.thus) {
    // only the two scores (Josh, October 2026: no notes on split or
    // opposite majorities, no "Thus")
    after =
      `<div class="llm-ps-text${f(A.thus)}" id="llmPopB${A.thus}">` +
      `<p class="llm-p">This statement receives a commonsensicality score of ${llmB(`${llmPctFine(h.s)} according to humans`)}, and ${llmB(`${llmPctFine(c.s)} according to the ${name}-generated population`)}.</p></div>`;
  }
  return llmChap("llmPopC5", 5, title, true, lead, quote + table + after);
}

// ── 6 · Across all statements (stages 26–29; Josh, October 2026): built as
// the individual story's chapter 3 builds its chart. Statement 2's two
// scores as a sentence beside the plot, with only their values marked on
// the axes (sctOne); its point, the guides running to it (sctPt); every
// statement (sctAll); the best-fit line and r (sctFit) ──

function llmPopCh6(m, md, fresh) {
  const Q = LLM.pop, title = llmPopChapters(m)[5];
  if (Q.stage < LLM_POP_AT.sctOne) return llmChap("llmPopC6", 6, title, false);
  return llmChap("llmPopC6", 6, title, true, "", llmPopScatter(m, md, fresh));
}

// The scatter plot's steps, in Josh's words (October 2026): statement 2's
// two scores; "Repeating this for all … statements, we get a scatter
// plot."; then the line and "The correlation between human and [the model]
// scores is r = …" (nothing about the line itself, and no key over the
// plot). No "Point at a dot" note (the probe still works).
function llmPopScatter(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, A = LLM_POP_AT, n = d.n_statements, name = esc(m.name);
  const { s, h, c } = llmPopExScores(md);
  const fit = Q.stage >= A.sctFit ? llmFit(d.statements.map((x) => x.humans), md.scores) : null;
  if (fit) fit.r = m.r ?? fit.r;   // the server's r, from the same scores
  const svg = llmSctSvg({
    id: "llmPopSctSvg", xs: d.statements.map((x) => x.humans), ys: md.scores, order: llmPopOrder(),
    xName: "People", yName: m.name, xLabel: "Score among humans", yLabel: `Score in ${m.name}'s population`,
    xCls: "is-people", yCls: "is-model", dot: "is-model",
    hi: s.id, hiLabel: s.text, axes: Q.stage <= A.sctPt, guides: Q.stage === A.sctPt, pin: Q.stage >= A.sctPt, pinNew: !!fresh && fresh.has(A.sctPt),
    points: Q.stage >= A.sctAll, fit, fitNew: !!fresh && fresh.has(A.sctFit), fitKey: false,
    aria: `Scatter plot of the ${fmtNum(n)} statements' commonsensicality among humans (across) and in ${m.name}'s population (up)` +
      (fit ? `, with a best-fit line; r = ${llmR(m.r)}` : ""),
  });
  const quote = s.text.replace(/\.$/, "");
  let text =
    `<p class="llm-p${llmFresh(fresh, A.sctOne)}${llmFresh(fresh, "ex")}" id="llmPopB${A.sctOne}">The statement “${esc(quote)}” receives a commonsensicality score of <strong>${fmtPct(h.s)} among humans</strong>, and <strong>${fmtPct(c.s)} among <span class="llm-nowrap">${name}'s</span> generated population</strong>.</p>`;
  if (Q.stage >= A.sctAll) {
    text += `<div class="llm-beat${llmFresh(fresh, A.sctAll)}" id="llmPopB${A.sctAll}"><p class="llm-p">Repeating this for all ${fmtNum(n)} statements, we get a scatter plot.</p></div>`;
  }
  if (Q.stage >= A.sctFit) {
    text +=
      `<div class="llm-beat${llmFresh(fresh, A.sctFit)}" id="llmPopB${A.sctFit}">` +
      `<p class="llm-p">The correlation between <strong>human</strong> and <strong>${name}</strong> scores is ${llmB(`r = ${llmR(m.r)}`)}.</p></div>`;
  }
  return `<div class="llm-sct-grid" id="llmPopSct"><div class="llm-sct-text">${text}</div><figure class="llm-sct${llmFresh(fresh, A.sctOne)}">${svg}</figure></div>`;
}

// Least squares y = a + b·x and Pearson r over the pairs with both values
function llmFit(xs, ys) {
  let n = 0, sx = 0, sy = 0;
  xs.forEach((x, i) => { const y = ys[i]; if (x !== null && y !== null) { n++; sx += x; sy += y; } });
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  xs.forEach((x, i) => {
    const y = ys[i];
    if (x === null || y === null) return;
    sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my);
  });
  if (!n || !sxx || !syy) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, r: sxy / Math.sqrt(sxx * syy), n };
}

// A scatter plot of statements' scores in two populations, one point a
// statement (0-1; a null is left out), drawn as one path of round dots so
// 4,407 points stay cheap to draw and to animate (llmSctAnimate(), in the
// order given). hi marks one statement; guides draws its coordinates; fit
// ({a, b, r}) adds the best-fit line and r, faded in when fitNew, hidden
// until the points are drawn when fitWait. For hi: axes marks its two
// values on the axes, guides draws dashed lines from them to its point,
// pin (default true) draws the point and its label, and pinNew fades the
// guides and point in (the population story's chapters 5 and 6 build the
// plot so, as the individual story's chapter 3 builds its chart). Pointing at the plot names the
// nearest statement (llmSctProbe()); a click opens it.
// Its text is set as the level-curve chart's (Josh, October 2026: ticks and
// the guides' values --fs-3, axis titles --fs-4), hence its margins
// (no key over the plots any more, so little room above them: Josh,
// October 2026, the plot sits higher, level with the text)
const LLM_SCT = { S: 360, L: 94, T: 12, R: 16, B: 62 };
const LLM_SCT_DATA = {};   // each plot's points, by svg id
function llmSctSvg(o) {
  const { S, L, T, R, B } = LLM_SCT, W = L + S + R, H = T + S + B;
  const x = (v) => L + v * S, y = (v) => T + S - v * S;
  const pts = new Map();
  o.xs.forEach((xv, i) => {
    const yv = o.ys[i];
    if (xv !== null && xv !== undefined && yv !== null && yv !== undefined) pts.set(i, [i, x(xv), y(yv), xv, yv]);
  });
  const ordered = (o.order || [...pts.keys()]).map((i) => pts.get(i)).filter(Boolean);
  const segs = ordered.map((p) => `M${p[1].toFixed(1)} ${p[2].toFixed(1)}h0`);
  LLM_SCT_DATA[o.id] = { pts: ordered, segs, xName: o.xName, yName: o.yName };
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // with guides, a tick label the guide's value would crowd is left out
  const hv = o.axes && o.hi !== null && o.hi !== undefined && pts.get(o.hi);
  const xTick = (t) => !hv || Math.abs(t - hv[3]) >= 0.12, yTick = (t) => !hv || Math.abs(t - hv[4]) >= 0.06;
  let out =
    `<svg class="llm-sct-svg" id="${o.id}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria)}">` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-sct-frame"/>` +
    ticks.map((t) =>
      (t > 0 && t < 1 ? `<line class="llm-sct-gl" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T + S}"/><line class="llm-sct-gl" x1="${L}" x2="${L + S}" y1="${y(t)}" y2="${y(t)}"/>` : "") +
      (xTick(t) ? `<text x="${x(t)}" y="${T + S + 25}" text-anchor="middle" class="llm-sct-tick">${Math.round(t * 100)}%</text>` : "") +
      (yTick(t) ? `<text x="${L - 9}" y="${y(t) + 6}" text-anchor="end" class="llm-sct-tick">${Math.round(t * 100)}%</text>` : "")).join("") +
    `<text x="${L + S / 2}" y="${H - 4}" text-anchor="middle" class="llm-sct-axis ${o.xCls}">${esc(o.xLabel)}</text>` +
    `<text x="16" y="${T + S / 2}" text-anchor="middle" transform="rotate(-90 16 ${T + S / 2})" class="llm-sct-axis ${o.yCls}">${esc(o.yLabel)}</text>` +
    `<path class="llm-sct-dots ${o.dot}" d="${o.points ? segs.join("") : ""}"/>`;
  if (o.fit) {
    const { a, b } = o.fit;
    let x0 = 0, x1 = 1;
    if (b > 0) { x0 = Math.max(x0, -a / b); x1 = Math.min(x1, (1 - a) / b); }
    else if (b < 0) { x0 = Math.max(x0, (1 - a) / b); x1 = Math.min(x1, -a / b); }
    const cls = o.fitWait ? " is-wait" : o.fitNew ? " is-new" : "";
    if (x0 < x1) out += `<line class="llm-sct-fit${cls}" pathLength="1" x1="${x(x0).toFixed(1)}" y1="${y(a + b * x0).toFixed(1)}" x2="${x(x1).toFixed(1)}" y2="${y(a + b * x1).toFixed(1)}"/>`;
    if (o.fitKey !== false) {
      out += `<g class="llm-sct-key${cls}"><line class="llm-sct-fit" x1="${L}" x2="${L + 22}" y1="${T - 15}" y2="${T - 15}"/>` +
        `<text x="${L + 30}" y="${T - 10}" class="llm-sct-r">Best-fit line · r\u00a0=\u00a0${llmR(o.fit.r)}</text></g>`;
    }
  }
  const hp = o.hi !== null && o.hi !== undefined ? pts.get(o.hi) : null;
  if (hp) {
    const [, px, py, xv, yv] = hp;
    const pinCls = `llm-sct-pin${o.pinNew ? " is-new" : ""}`;
    if (o.guides) {
      out += `<g class="${pinCls}"><line class="llm-sct-guide" x1="${px}" x2="${px}" y1="${py}" y2="${T + S}"/><line class="llm-sct-guide" x1="${L}" x2="${px}" y1="${py}" y2="${py}"/></g>`;
    }
    if (o.axes) {
      out +=
        `<text x="${Math.min(px, L + S + 4)}" y="${T + S + 25}" text-anchor="middle" class="llm-sct-gval ${o.xCls}">${fmtPct(xv)}</text>` +
        `<text x="${L - 9}" y="${py + 6}" text-anchor="end" class="llm-sct-gval ${o.yCls}">${fmtPct(yv)}</text>` +
        // its two values marked on the axes with a round point, as the
        // level-curve chart marks a model's
        `<circle class="llm-sct-axpt" cx="${px.toFixed(1)}" cy="${T + S}" r="5"/><circle class="llm-sct-axpt" cx="${L}" cy="${py.toFixed(1)}" r="5"/>`;
    }
    if (o.pin !== false) {
      // the label as long as fits beside the point (llm.css sets the plots'
      // text larger on phones)
      const left = px > L + S * 0.55, ly = py < T + 28 ? py + 22 : py - 12;
      const room = left ? px - 11 - L : L + S - px - 11;
      const fit = Math.max(12, Math.floor(room / (window.matchMedia("(max-width: 700px)").matches ? 10.4 : 8.6)) - 2);
      const label = o.hiLabel.length > fit ? `${o.hiLabel.slice(0, fit - 1).replace(/\s+\S*$/, "")}…` : o.hiLabel;
      out +=
        `<g class="${pinCls}"><circle class="llm-sct-hi" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6.5"/>` +
        `<text x="${(left ? px - 11 : px + 11).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${left ? "end" : "start"}" class="llm-sct-hilab">“${esc(label)}”</text></g>`;
    }
  }
  out +=
    `<g class="llm-sct-probe" style="display:none"><circle r="7" class="llm-sct-ring"/><rect class="llm-sct-tipbox" rx="5"/>` +
    `<text class="llm-sct-tip" data-l="1"></text><text class="llm-sct-tip" data-l="2"></text></g></svg>`;
  return out;
}

// Adds a plot's points in order, then shows its best-fit line
function llmSctAnimate(svgId, stage) {
  const Q = LLM.pop, data = LLM_SCT_DATA[svgId], svg = document.getElementById(svgId);
  if (!data || !svg) return;
  const path = svg.querySelector(".llm-sct-dots"), n = data.segs.length;
  let k = 0, dPath = "";
  llmPopAnimStop();
  Q.anim = stage;
  llmPopAnimate(1800, (p) => {
    const to = Math.round(p * n);
    if (to < k) { k = 0; dPath = ""; }
    if (to > k) { dPath += data.segs.slice(k, to).join(""); k = to; }
    path.setAttribute("d", dPath);
  }, (natural) => {
    Q.anim = null;
    svg.querySelectorAll(".is-wait").forEach((el) => { el.classList.remove("is-wait"); if (natural) el.classList.add("is-new"); });
    llmPopStepper();
  });
  llmPopStepper();
}

// The nearest statement to the pointer within 12 units, as its plot point
function llmSctNearest(svg, e) {
  const data = LLM_SCT_DATA[svg.id];
  if (!data || !svg.querySelector(".llm-sct-dots").getAttribute("d")) return null;
  const box = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
  const sx = ((e.clientX - box.left) / box.width) * vb.width, sy = ((e.clientY - box.top) / box.height) * vb.height;
  let best = null, bd = 144;
  for (const p of data.pts) {
    const dd = (p[1] - sx) ** 2 + (p[2] - sy) ** 2;
    if (dd < bd) { bd = dd; best = p; }
  }
  return best;
}

function llmSctProbe(e) {
  const svg = e.target.closest(".llm-sct-svg");
  if (!svg) return;
  const g = svg.querySelector(".llm-sct-probe"), p = llmSctNearest(svg, e), data = LLM_SCT_DATA[svg.id];
  if (!p) { g.style.display = "none"; svg.classList.remove("is-on"); return; }
  const { S, L, T, R } = LLM_SCT, s = LLM.data.statements[p[0]];
  g.style.display = "";
  svg.classList.add("is-on");
  const ring = g.querySelector(".llm-sct-ring");
  ring.setAttribute("cx", p[1]); ring.setAttribute("cy", p[2]);
  const t1 = g.querySelector('[data-l="1"]'), t2 = g.querySelector('[data-l="2"]'), rect = g.querySelector(".llm-sct-tipbox");
  t1.textContent = s.text.length > 46 ? `${s.text.slice(0, 44).replace(/\s+\S*$/, "")}…` : s.text;
  t2.textContent = `${data.xName} ${fmtPct(p[3])} · ${data.yName} ${fmtPct(p[4])}`;
  // sized from the text as drawn, which is larger on phones
  const tw = Math.max(t1.getComputedTextLength(), t2.getComputedTextLength());
  const lh = Math.max(14, t1.getBBox().height || 16), boxH = 2 * lh + 10;
  const tx = Math.max(8, Math.min(L + S + R - tw - 8, p[1] - tw / 2));
  const top = p[2] - 12 - boxH > T - 20 ? p[2] - 12 - boxH : p[2] + 12;
  const ty = top + 5 + lh * 0.8;
  t1.setAttribute("x", tx); t1.setAttribute("y", ty);
  t2.setAttribute("x", tx); t2.setAttribute("y", ty + lh);
  rect.setAttribute("x", tx - 7); rect.setAttribute("y", top); rect.setAttribute("width", tw + 14); rect.setAttribute("height", boxH);
}

// ── 7 · Setting up a baseline (stages 35–43; Josh, October 2026, a click a
// step): the question alone (split); the two halves (imagine); "Here are
// what their ratings look like." and statement 2 (crowds); half A (halfA)
// and half B (halfB), side by side as chapter 3's crowds (shares only, 20
// figures a row), B held in place, hidden, until its click; then its score
// in each half beside the scatter plot, built as chapter 5's: its values
// on the axes (one), its point (onePt), every statement (halves), the line
// and r (halvesFit) ──

function llmPopCh7(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, n = d.n_statements, name = esc(m.name);
  const title = llmPopChapters(m)[6];
  const AT = LLM_POP_AT;
  if (Q.stage < AT.split) return llmChap("llmPopC7", 7, title, false);
  const lead = `How should we evaluate ${llmB(`r = ${llmR(m.r)}`)}, the correlation between the <strong>${name}-generated population</strong> and <strong>humans</strong>?`;
  const tools = `<button type="button" class="llm-btn" data-story="pop-resplit">Split again</button>`;
  if (Q.stage < AT.imagine) return llmChap("llmPopC7", 7, title, true, lead, "");
  if (!llmPopSplitReady()) return llmChap("llmPopC7", 7, title, true, lead, '<div class="empty-row">Splitting…</div>');
  const sp = Q.split, s = d.statements[Q.ex];
  const FIGS = 20;
  const figs = (share, cls) => llmFigureRow(Math.round(share * FIGS), FIGS, cls, "is-grid");
  const fx = (k) => llmFresh(fresh, k);
  const half = (label, raters, st) => {
    const nr = raters.length, k = raters.filter((x) => x[0]).length, ko = raters.filter((x) => x[1]).length;
    const sc = nr ? llmCrowdScore(k / nr, ko / nr) : null;
    return {
      sc,
      html: `<div class="llm-crowd-col${Q.stage >= st ? fx(st) : " is-pend"}">${llmWho(label, false, "llm-who-tag")}` +
        (nr
          ? `<p class="llm-p">${llmB(fmtPct(k / nr))} agree with the statement.</p>${figs(k / nr, "is-p")}` +
            `<p class="llm-p">${llmB(fmtPct(ko / nr))} think most people would agree with it.</p>${figs(ko / nr, "is-q2")}`
          : `<p class="llm-p">No one in this half rated the statement.</p>`) + `</div>`,
    };
  };
  // each half named with its size (Josh, October 2026: "Half A (1,023 people)")
  const nh = d.split_half.n_half ? ` (${fmtNum(d.split_half.n_half)} people)` : "";
  const A = half(`Half A${nh}`, sp.example.a, AT.halfA), B = half(`Half B${nh}`, sp.example.b, AT.halfB);
  let body = `<p class="llm-p${fx(AT.imagine)}" id="llmPopB${AT.imagine}">Imagine if we split the human population into <strong>two random halves, A and B</strong>. Each half is now a separate population and rates statements as usual.</p>`;
  if (Q.stage >= AT.crowds) {
    body +=
      `<div class="llm-beat${fx(AT.crowds)}${fx("split")}" id="llmPopB${AT.crowds}">` +
      `<p class="llm-p">Here are what their ratings look like.</p><blockquote class="llm-ex-quote">${esc(s.text)}</blockquote>` +
      (Q.stage >= AT.halfA ? `<div class="llm-crowd-cols llm-crowd-pair" id="llmPopB${AT.halfA}">${A.html}${B.html}</div>` : "") + `</div>`;
  }
  if (Q.stage >= AT.one) {
    const fit = Q.stage >= AT.halvesFit ? llmFit(sp.scores.a, sp.scores.b) : null;
    if (fit) fit.r = sp.r;   // the server's r, over the same statements
    const svg = llmSctSvg({
      id: "llmPopHalvesSvg", xs: sp.scores.a, ys: sp.scores.b, order: llmPopOrder(),
      xName: "Half A", yName: "Half B", xLabel: "Score in half A", yLabel: "Score in half B",
      xCls: "is-people", yCls: "is-people", dot: "is-people",
      hi: s.id, hiLabel: s.text, axes: Q.stage <= AT.onePt, guides: Q.stage === AT.onePt, pin: Q.stage >= AT.onePt, pinNew: !!fresh && fresh.has(AT.onePt),
      points: Q.stage >= AT.halves, fit, fitNew: !!fresh && fresh.has(AT.halvesFit), fitKey: false,
      aria: `Scatter plot of the statements' commonsensicality in half A (across) and half B (up) of random split ${Q.seed + 1}` +
        (fit ? `, with a best-fit line; r = ${llmR(sp.r)}` : ""),
    });
    let text = A.sc && B.sc
      ? `<p class="llm-p">By the same calculations, statement 2 receives a commonsensicality score of <strong>${fmtPct(A.sc.s)} in half A</strong>, and <strong>${fmtPct(B.sc.s)} in half B</strong>.</p>`
      : `<p class="llm-p">One half has no rater of this statement this time; split again to see it scored in both.</p>`;
    if (Q.stage >= AT.halves) {
      text += `<div class="llm-beat${fx(AT.halves)}" id="llmPopB${AT.halves}"><p class="llm-p">Repeating this for all ${fmtNum(sp.n_used)} statements${sp.n_used < n ? " both halves rated" : ""}, we get a scatter plot.</p></div>`;
    }
    if (Q.stage >= AT.halvesFit) {
      text += `<div class="llm-beat${fx(AT.halvesFit)}" id="llmPopB${AT.halvesFit}">` +
        `<p class="llm-p">The correlation between half A and half B scores is ${llmB(`r = ${llmR(sp.r)}`)}.</p></div>`;
    }
    body +=
      // each step set off by a short rule, as in the rest of the story
      // (Josh); the grid sits inside the beat, so the rule isn't a grid item
      // the panel scrolls once, when this step opens: it goes to the top in
      // the card's place (data-llm-top) and stays there while the plot's
      // later steps (its point, every statement, the line) come in beside it
      // (Josh, October 2026)
      `<div class="llm-beat${fx(AT.one)}" id="llmPopB${AT.one}" data-llm-top><div class="llm-sct-grid">` +
      `<div class="llm-sct-text">${text}</div><figure class="llm-sct${fx("split")}">${svg}</figure></div></div>`;
  }
  // "Split again" once there is a split to see
  return llmChap("llmPopC7", 7, title, true, lead, body, Q.stage >= AT.crowds ? tools : "");
}

// ── 8 · Many random splits (stages 44–49; Josh, October 30, 2026): the
// lead alone, this split's r; the dot plot with only this split's dot,
// which falls onto the axis; the other 999 falling onto it; their average,
// marked on the plot as it is named; the range of 95% of splits, shaded on
// the plot; the split-half reliability ──

function llmPopCh8(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, sh = d.split_half, AT = LLM_POP_AT;
  const title = llmPopChapters(m)[7];
  if (Q.stage < AT.splits) return llmChap("llmPopC8", 8, title, false);
  const fx = (k) => llmFresh(fresh, k);
  // Josh's wording (October 30, 2026)
  const lead = `The current split gives us a correlation score of ${llmB(`r = ${llmR(Q.split ? Q.split.r : sh.mean)}`)}.`;
  const tools = `<button type="button" class="llm-btn" data-story="pop-resplit">Split again</button>`;
  if (Q.stage < AT.splitsOne) return llmChap("llmPopC8", 8, title, true, lead, "", tools);
  // the text in a column beside the dot plot, as chapters 6 and 7 set
  // theirs beside the scatter plot; while the plot holds only this split's
  // dot, the column's first sentence keeps its place, hidden, so nothing
  // moves when it comes in. The spread joins the average's step, a click
  // later, with no rule between
  const all = Q.stage >= AT.splitsHist;
  let text = `<p class="llm-p${all ? fx(AT.splitsHist) : " is-pend"}" id="llmPopB${AT.splitsHist}">Repeating this split ${fmtNum(sh.n_splits)} times, we get the following distribution.</p>`;
  if (Q.stage >= AT.splitsAvg) {
    text += `<div class="llm-beat${fx(AT.splitsAvg)}" id="llmPopB${AT.splitsAvg}"><p class="llm-p">On average, the two halves correlate at ${llmB(`r = ${llmR(sh.mean)}`)}.</p>` +
      (Q.stage >= AT.splitsRange ? `<p class="llm-p${fx(AT.splitsRange)}" id="llmPopB${AT.splitsRange}">95% of splits fall between ${llmB(llmR(sh.lo))} and ${llmB(llmR(sh.hi))}.</p>` : "") + `</div>`;
  }
  if (Q.stage >= AT.splitsThus) {
    text += `<div class="llm-beat${fx(AT.splitsThus)}" id="llmPopB${AT.splitsThus}"><p class="llm-p">The correlation ${llmB(`r = ${llmR(sh.mean)}`)} is called the <strong>split-half reliability</strong> of the human population.</p>` +
      `<p class="llm-p">It sets a baseline for what we should expect from another population that claims to be similar to humans.</p></div>`;
  }
  // which dots fall on this click: this split's alone (splitsOne), or every
  // other split's onto it (splitsHist)
  const anim = fresh && fresh.has(AT.splitsOne) ? "one" : fresh && fresh.has(AT.splitsHist) ? "rest" : false;
  const marks = {
    all,
    avg: Q.stage >= AT.splitsAvg, avgNew: !!fresh && fresh.has(AT.splitsAvg),
    range: Q.stage >= AT.splitsRange, rangeNew: !!fresh && fresh.has(AT.splitsRange),
  };
  const body =
    `<div class="llm-sct-grid${fx(AT.splitsOne)}" id="llmPopB${AT.splitsOne}"><div class="llm-sct-text">${text}</div>` +
    `<figure class="llm-rh-fig${fx("split")}">${llmSplitDotsSvg(anim, marks)}</figure></div>`;
  return llmChap("llmPopC8", 8, title, true, lead, body, tools);
}

// The 1,000 splits' r as a dot plot (Josh, October 2026: a dot per split
// rather than bars): each split one dot, stacked in its bin from the
// bottom, a few dots a row, so the columns read as a histogram; this
// split's dot darkest, the splits seen darker. Until marks.all, only this
// split's dot is drawn (the plot keeps its full size, so nothing moves when
// the rest come). marks adds the average line (avg) and the band 95% of
// splits fall in (range) once the text names them, each faded in on its
// click (avgNew, rangeNew).
// This split's dot sits at the foot of its bin, so it stays put while the
// others stack on it. Drawn in SVG; anim "one" drops this split's dot onto
// the axis; anim "rest" drops every other split's dot from above the plot
// into its slot, one split after another in split order (spaced out at
// first, then quickening), each landing on the dots of earlier splits in
// its bin. Gravity-like: a dot's fall time grows with the square root of
// its drop (CSS .llm-rd.is-fall, --d its drop).
function llmSplitDotsSvg(anim = false, marks = {}) {
  const d = LLM.data, sh = d.split_half, Q = LLM.pop, rs = sh.rs || [];
  if (!rs.length) return "";
  const w = 0.0025, lo = Math.floor(Math.min(...rs) / w + 1e-9) * w, hi = Math.ceil(Math.max(...rs) / w - 1e-9) * w;
  const nb = Math.max(1, Math.round((hi - lo) / w));
  const bin = (r) => Math.min(nb - 1, Math.max(0, Math.floor((r - lo) / w + 1e-9)));
  const L = 10, R = 10, T = 30, B = 44, PW = 500, bw = PW / nb;
  const gap = 4, cols = Math.max(1, Math.floor((bw - gap) / 5.4)), step = (bw - gap) / cols, dot = Math.min(4.6, step - 0.8);
  const bins = Array.from({ length: nb }, () => []);
  rs.forEach((r, seed) => bins[bin(r)].push(seed));
  const seen = new Set(Q.splits.map((x) => x.seed)), cur = Q.split ? Q.seed : -1;
  // this split's dot first in its bin, at the foot of its column
  if (cur >= 0) { const b = bins[bin(rs[cur])]; b.splice(b.indexOf(cur), 1); b.unshift(cur); }
  const all = marks.all !== false;
  const rows = Math.ceil(Math.max(...bins.map((b) => b.length)) / cols), PH = rows * step;
  const W = L + PW + R, H = T + PH + B, x = (r) => L + ((r - lo) / (hi - lo)) * PW;
  let dots = "", curDot = "";
  // the order the other dots fall: split order; the k-th of the N others
  // starts at 3.2·sqrt(k/N) s, so the first few fall one by one
  const N = cur < 0 ? rs.length : rs.length - 1, nth = (seed) => (cur >= 0 && seed > cur ? seed - 1 : seed);
  bins.forEach((b, i) => b.forEach((seed, k) => {
    if (!all && seed !== cur) return;
    const row = Math.floor(k / cols), cx = L + i * bw + gap / 2 + (k % cols + 0.5) * step, cy = T + PH - (row + 0.5) * step;
    const drop = cy + 6;   // from just above the plot's top edge
    const falls = seed === cur ? anim === "one" : anim === "rest";
    const delay = falls
      ? ` style="--d:${drop.toFixed(0)};animation-delay:${(seed === cur ? 0.2 : 3.2 * Math.sqrt(nth(seed) / Math.max(1, N - 1))).toFixed(3)}s;animation-duration:${(0.12 + 0.032 * Math.sqrt(drop)).toFixed(2)}s"`
      : "";
    const c = `<circle class="llm-rd${seed === cur ? " is-current" : seen.has(seed) ? " is-seen" : ""}${falls ? " is-fall" : ""}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(seed === cur ? dot : dot / 2).toFixed(2)}"${delay}><title>Split ${seed + 1}: r = ${llmR(rs[seed], 3)}</title></circle>`;
    // this split's dot, larger, drawn last so nothing covers it
    if (seed === cur) curDot = c; else dots += c;
  }));
  const ticks = [];
  for (let t = Math.ceil(lo * 100 - 1e-9); t <= Math.floor(hi * 100 + 1e-9); t++) ticks.push(t / 100);
  const mx = x(sh.mean);
  // the band 95% of splits fall in, behind the dots
  const band = marks.range
    ? `<rect class="llm-rd-band${marks.rangeNew ? " is-new" : ""}" x="${x(sh.lo).toFixed(1)}" y="${T - 4}" width="${(x(sh.hi) - x(sh.lo)).toFixed(1)}" height="${(PH + 6).toFixed(1)}"/>`
    : "";
  const avg = marks.avg
    ? `<g class="llm-rd-mark${marks.avgNew ? " is-new" : ""}"><line class="llm-rd-avg" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${T - 8}" y2="${T + PH + 2}"/>` +
      `<text class="llm-rd-avgl" x="${mx.toFixed(1)}" y="${T - 14}" text-anchor="middle">Average ${llmR(sh.mean, 3)}</text></g>`
    : "";
  return (
    `<svg class="llm-dots-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc((all ? `Dot plot of r between the two halves over ${fmtNum(sh.n_splits)} random splits, one dot a split` : `Dot plot of r between the two halves: this split, r = ${llmR(rs[cur])}`) + (marks.avg ? `: average ${llmR(sh.mean)}` : "") + (marks.range ? `, 95% between ${llmR(sh.lo)} and ${llmR(sh.hi)}` : ""))}">` +
    band +
    `<line class="llm-rd-base" x1="${L}" x2="${L + PW}" y1="${T + PH + 2}" y2="${T + PH + 2}"/>` +
    ticks.map((t) => `<text class="llm-rd-tick" x="${x(t).toFixed(1)}" y="${T + PH + 26}" text-anchor="middle">${llmR(t)}</text>`).join("") +
    dots + curDot + avg + `</svg>`
  );
}


// ── 9 · Aggregating over all LLMs (stages 50–52), as the individual
// story's chapter 7: the followed model against the baseline as the lead,
// alone; then every model's population as one bar of its r with people,
// sorted by r (rankR), with a dashed line at the split-half human
// reliability, bars not significantly different from 0 faint; then the best
// model, in the room kept for it over the bars (so nothing moves). The
// followed model is highlighted; a click on another follows it in place
// (data-ind-pick, which both stories share). ──

function llmPopCh9(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, sh = d.split_half, title = llmPopChapters(m)[8], AT = LLM_POP_AT;
  if (Q.stage < AT.allLlms) return llmChap("llmPopC9", 9, title, false);
  const models = [...d.models].sort((a, b) => a.rankR - b.rankR), N = models.length, bench = sh.mean;
  const above = models.filter((x) => (x.r ?? -2) >= bench).length, best = models[0];
  const refs = [{ x: bench, cls: "is-half" }];
  // In Josh's words (October 2026): the followed model against the baseline
  const r = m.r ?? 0, rr = llmB(`r = ${llmR(m.r)}`);
  const gap = r < bench - 0.1 ? "substantially below" : r < bench ? "below" : "at or above";
  const lead = `${esc(m.name)}'s correlation of ${rr} is <strong>${gap}</strong> the human <strong>split-half reliability of r = ${llmR(bench)}</strong>.`;
  if (Q.stage < AT.allBars) return llmChap("llmPopC9", 9, title, true, lead, "");
  const rows = models.map((x, i) => {
    const ns = !x.r_sig;
    const tip = `<strong>${esc(x.name)}</strong><br>r = ${llmR(x.r)}${x.ci && x.ci.r ? ` (95% interval ${llmR(x.ci.r[0])} to ${llmR(x.ci.r[1])})` : ""}` +
      (ns ? "<br>Not significantly different from 0" : "");
    return (
      `<div class="llm-bar-row${x.id === m.id ? " is-selected" : ""}" data-ind-pick="${esc(x.id)}" data-llm-tip="${esc(tip)}" role="button" tabindex="0"` +
      ` aria-label="${esc(`${x.name}: r = ${llmR(x.r)}${ns ? ", not significantly different from 0" : ""}. Follow this model.`)}">` +
      `<span class="lb-rank">${i + 1}</span><span class="lb-name">${llmName(x)} <span class="lb-org">${esc(x.organization || "")}</span></span>` +
      llmTrack(x.r ?? 0, LLM_R_SCALE, `is-open${ns ? " is-faint" : ""}`, refs) +
      `<span class="lb-val">${llmR(x.r)}</span></div>`
    );
  }).join("");
  const bestName = `<strong>${esc(best.name)}</strong>`, bestR = llmB(`r = ${llmR(best.r)}`);
  const inFact = above === 0
    ? `In fact, no model can achieve this consistency level. The best model, ${bestName}, achieves the highest correlation of ${bestR}.`
    : `In fact, ${2 * above < N ? "only " : ""}${above} out of ${N} models achieve this consistency level. The best model, ${bestName}, achieves the highest correlation of ${bestR}.`;
  const on = Q.stage >= AT.allBest;
  const body =
    // the bars fade in without asking the panel to scroll to them (they run
    // past the window), so the lead stays at the top with them
    `<div class="${fresh && fresh.has(AT.allBars) ? "llm-in-quiet" : ""}" id="llmPopB${AT.allBars}">` +
    `<p class="llm-p${on ? llmFresh(fresh, AT.allBest) : " is-pend"}" id="llmPopB${AT.allBest}">${inFact}</p>` +
    `<div class="llm-legend llm-h2h-legend" aria-hidden="true">` +
    `<span><i class="llm-key llm-key-open"></i>Correlation with humans (r)</span>` +
    `<span><i class="llm-key llm-key-faint"></i>Not significantly different from 0</span>` +
    `<span><i class="llm-key llm-key-line"></i>Split-half human reliability</span></div>` +
    `<div class="llm-bars llm-board llm-h2h">` +
    `<div class="llm-bar-row is-head"><span class="lb-rank">#</span><span class="lb-name">LLM</span>${llmAxis(LLM_R_SCALE)}<span class="lb-val">r</span></div>` +
    rows + `</div>` +
    // as the individual story's chapter 7 ends
    `<p class="llm-note">Point at a bar for its 95% interval, or click it to follow that LLM.</p></div>`;
  return llmChap("llmPopC9", 9, title, true, lead, body);
}

// Next in the population story; chapter 7 waits for its split
async function llmPopNext() {
  const Q = LLM.pop;
  if (!LLM.md || llmPopBusy()) return;
  if (Q.stage >= LLM_POP_LAST) { llmShowView("overview"); return; }
  const from = Q.stage, to = from + 1;
  if (to === LLM_POP_AT.imagine && !llmPopSplitReady()) {
    Q.busy = true;
    llmPopStepper();
    try { await llmPopLoadSplit(); } catch (err) { console.error("LLM split failed:", err); Q.busy = false; llmPopStepper(); return; }
    Q.busy = false;
  }
  Q.stage = to;
  const fresh = new Set([to]);
  const chFrom = LLM_POP_OPEN.filter((s) => from >= s).length, ch = LLM_POP_OPEN.filter((s) => to >= s).length;
  llmPopPaint(fresh, [...new Set([chFrom, ch])]);
  if (LLM_POP_OPEN.includes(to)) document.getElementById(`llmPopC${ch}`)?.classList.add("llm-in");
}

function llmPopAction(action) {
  const d = LLM.data, Q = LLM.pop, md = LLM.md;
  if (!md) return;
  const fail = (err) => console.error("LLM split failed:", err);
  if (action === "pop-another" || action === "pop-paper") {
    Q.ex = action === "pop-paper" ? d.examples.population : llmRandomStatement(Q.ex);
    const repaint = () => llmPopPaint(new Set(["ex"]), [4, 5, 6, 7]);
    if (Q.stage >= LLM_POP_AT.split) llmPopLoadSplit().then(repaint).catch(fail);
    else repaint();
  } else if (action === "pop-resplit") {
    const used = new Set(Q.splits.map((x) => x.seed));
    const free = Array.from({ length: d.split_half.n_splits }, (_, i) => i).filter((i) => !used.has(i));
    Q.seed = free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * d.split_half.n_splits);
    llmPopLoadSplit().then(() => llmPopPaint(new Set(["split"]), [7, 8])).catch(fail);
  }
}

// Previous: the latest step taken away (a running count or plot finishes
// first). A count stepped back before is forgotten, so it runs again on the
// way forward. Not while a split loads.
function llmPopPrev() {
  const Q = LLM.pop;
  if (!LLM.md || Q.stage <= 0 || Q.busy) return;
  llmPopAnimStop();
  Q.stage--;
  llmPopPaint(null);
}

// Opens the population story up to stage
async function llmPopOpenTo(stage) {
  const Q = LLM.pop;
  if (stage <= Q.stage) return;
  if (stage >= LLM_POP_AT.imagine && !llmPopSplitReady()) {
    try { await llmPopLoadSplit(); } catch (err) { console.error("LLM split failed:", err); return; }
  }
  Q.stage = stage;
  llmPopPaint(new Set());
}

// Start over: the story as it first opens, with the paper's statement and
// the first split, for the model in the picker
function llmPopRestart() {
  const d = LLM.data, Q = LLM.pop;
  if (!LLM.md || Q.stage === 0 || Q.busy) return;
  llmPopAnimStop();
  Object.assign(Q, { stage: 0, ex: llmPopDefaultEx(), seed: 0, split: null, splits: [], ran: { h: false, m: false }, anim: null });
  llmPopPaint(null);
  llmStoryTop();
}

function llmSd(x) {
  const n = x.length, m = x.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

// ══ Modals ═════════════════════════════════════════════════════════════════

function llmShowModal(id, show) {
  document.getElementById(id).classList.toggle("hidden", !show);
}

async function llmOpenStatement(id) {
  const d = LLM.data;
  const s = d.statements[id];
  document.getElementById("llmStmtModalText").textContent = s.text;
  document.getElementById("llmStmtModalMeta").innerHTML =
    `<span><span class="stmt-meta-label">Source</span> <span class="stmt-meta-value">${esc(llmSourceName(s.source))}</span></span>` +
    `<span><span class="stmt-meta-label">Category</span> <span class="stmt-meta-value">${esc(s.category)}</span></span>` +
    `<span><span class="stmt-meta-label">People agree</span> <span class="stmt-meta-value">${fmtNum(s.k_agree)} of ${fmtNum(s.n)} (${fmtPct(s.I_agree)})</span></span>` +
    `<span><span class="stmt-meta-label">Think most agree</span> <span class="stmt-meta-value">${fmtNum(s.k_others)} of ${fmtNum(s.n)} (${fmtPct(s.others_agree)})</span></span>`;
  // its six features as one plain line, each with its definition on hover
  const props = PROP_DEFS.map((p) => {
    const v = s[p.key];
    return `<span title="${esc(v ? p.def1 : p.def0)}">${esc(v ? p.v1 : p.v0)}</span>`;
  }).join(" · ");
  const body = document.getElementById("llmStmtModalBody");
  body.innerHTML = `<div class="modal-explanation"><div class="llm-prop-chips">${props}</div></div><div class="empty-row">Loading…</div>`;
  llmShowModal("llmStmtModal", true);
  let sc;
  try {
    sc = await llmGet(`/llm-evals/statement?id=${id}`);
  } catch (err) {
    console.error("LLM statement load failed:", err);
    body.querySelector(".empty-row").textContent = "Scores could not be loaded.";
    return;
  }
  const rows = d.models.map((m, i) => ({ m, v: sc.scores[i], p: sc.ratings[i] })).sort((a, b) => b.v - a.v);
  const agree = rows.filter((r) => r.p[0] >= 0.5).length;
  const row = (name, ans1, ans2, v, kind, extra = "") =>
    `<div class="llm-pop-row ${kind}"${extra}><span class="llm-pop-name">${name}</span><span class="llm-pop-ans">${ans1}</span><span class="llm-pop-ans">${ans2}</span>` +
    `<span class="llm-pop-track"><span class="llm-pop-fill" style="width:${(v * 100).toFixed(1)}%"></span></span>` +
    `<span class="llm-pop-val">${fmtPct(v)}</span></div>`;
  const cta = LLM.view === "individual" ? "Click a model to follow it." : "Click a model to follow its crowd.";
  body.innerHTML =
    `<div class="modal-explanation"><div class="llm-prop-chips">${props}</div>` +
    `<p>Most people say ${s.majority ? "Yes" : "No"} (${fmtPct(s.I_agree)} agree), and ${agree} of the ${d.models.length} models say Yes. ` +
    `The bars are the statement's commonsensicality among people and in each model's simulated crowd. ${cta}</p></div>` +
    `<div class="llm-pop-list"><div class="llm-pop-row is-head"><span>Who</span><span>Agrees?</span><span>Most agree?</span><span>Commonsensicality</span><span></span></div>` +
    row("People", `${llmYesNo(s.majority)} <span class="llm-maj-word">${fmtPct(s.I_agree)}</span>`, `<span class="llm-maj-word">${fmtPct(s.others_agree)}</span>`, sc.humans, "is-human") +
    rows.map(({ m, v, p }) => row(
      llmName(m),
      llmAnswer(p[0] >= 0.5 ? 1 : 0, s.majority),
      llmAnswer(p[1] >= 0.5 ? 1 : 0, s.majority),
      v,
      m.id === LLM.model ? "is-model is-selected" : "is-model",
      ` role="button" tabindex="0" data-model="${esc(m.id)}" title="${esc(`${m.name}: agrees ${llmProbFine(p[0])}, thinks most agree ${llmProbFine(p[1])} → crowd commonsensicality ${fmtPct(v)}`)}"`,
    )).join("") +
    `</div>`;
}

async function llmOpenParticipant(id) {
  const d = LLM.data;
  const p = d.participantById.get(id);
  document.getElementById("llmPartModalTitle").textContent = `Participant #${id}`;
  document.getElementById("llmPartModalScores").innerHTML =
    `Consensus ${fmtPct(p.scores[0])} · Awareness ${fmtPct(p.scores[1])} · Commonsensicality ${fmtPct(p.scores[2])}`;
  const tbody = document.getElementById("llmPartModalBody");
  tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Loading…</td></tr>';
  llmShowModal("llmPartModal", true);
  let pr;
  try {
    pr = await llmGet(`/llm-evals/participant?id=${id}`);
  } catch (err) {
    console.error("LLM participant load failed:", err);
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Answers could not be loaded.</td></tr>';
    return;
  }
  tbody.innerHTML = pr.ratings
    .map(([sid, ia, oa]) => ({ s: d.statements[sid], ia, oa }))
    .sort((a, b) => a.s.text.localeCompare(b.s.text))
    .map(({ s, ia, oa }) =>
      `<tr><td class="td-statement">${esc(s.text)}</td><td class="td-modal-right">${llmYesNo(s.majority)} <span class="llm-maj-word">· ${fmtPct(s.I_agree)} agree</span></td>` +
      `<td class="td-modal-right">${llmAnswer(ia, s.majority)}</td><td class="td-modal-right">${llmAnswer(oa, s.majority)}</td></tr>`,
    )
    .join("");
}

// ══ Navigation ═════════════════════════════════════════════════════════════

// Segmented controls: buttons with data-value inside the group element
function llmSyncSeg(groupId, value) {
  document.querySelectorAll(`#${groupId} [data-value]`).forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.value === String(value))),
  );
}

function llmOnSeg(groupId, handler) {
  document.querySelectorAll(`#${groupId} [data-value]`).forEach((b) =>
    b.addEventListener("click", () => handler(b.dataset.value)),
  );
}

function llmSyncControls() {
  llmSyncSeg("llmViews", LLM.view);
  document.querySelectorAll("#panelLlm .llm-view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== LLM.view));
  // the Overview's bands run edge to edge (llm.css)
  document.getElementById("llmWrap").classList.toggle("is-land", LLM.view === "overview");
  const pick = LLM.view === "individual" || LLM.view === "population";
  document.getElementById("llmModelPick").classList.toggle("hidden", !pick);
  document.querySelector("#panelLlm .llm-toolbar").classList.toggle("is-story", pick);
  const select = document.getElementById("llmModelSelect");
  if (LLM.model && select.value !== LLM.model) select.value = LLM.model;
  const m = llmModel();
  if (pick && m && LLM.data) {
    const list = llmRankList(LLM.view);
    const i = list.findIndex((x) => x.id === m.id);
    // a plain invitation rather than the model's rank, in both stories
    // (Josh, October 2026)
    document.getElementById("llmModelRank").textContent = "Select another model here";
    document.getElementById("llmModelPrev").disabled = i <= 0;
    document.getElementById("llmModelNext").disabled = i >= list.length - 1;
  }
}

function llmVisible() {
  return !document.getElementById("panelLlm").classList.contains("hidden");
}

function llmReadUrl() {
  const q = new URLSearchParams(window.location.search);
  if (LLM_VIEWS.includes(q.get("view"))) LLM.view = q.get("view");
  if (q.get("model")) LLM.model = q.get("model");
}

function llmWriteUrl() {
  if (!llmVisible()) return;
  const q = new URLSearchParams();
  if (LLM.view !== "overview") q.set("view", LLM.view);
  if (LLM.view === "individual" || LLM.view === "population") q.set("model", LLM.model);
  const url = MOUNT_PATH + TAB_SLUGS.llm + (q.toString() ? `?${q}` : "");
  if (url !== window.location.pathname + window.location.search) history.replaceState(history.state, "", url);
}

function llmRender() {
  if (!LLM.data) return;
  llmSyncControls();
  llmWriteUrl();
  const render = {
    overview: llmRenderLanding,
    individual: llmRenderIndividual,
    population: llmRenderPopulation,
  }[LLM.view];
  try {
    const out = render();
    if (out && out.catch) out.catch((err) => console.error(`LLM ${LLM.view} view failed:`, err));
  } catch (err) {
    console.error(`LLM ${LLM.view} view failed:`, err);
  }
}

// at: the id of a card to scroll to once the view has drawn (the landing
// page's links to the rankings), via llmRevealPending()
function llmShowView(view, at = null) {
  if (!LLM_VIEWS.includes(view)) return;
  LLM.view = view;
  LLM.pendingAt = at;
  if (llmVisible()) {
    document.getElementById("llmWrap").scrollTop = 0;
    llmRender();
  }
}

function llmRevealPending() {
  const el = LLM.pendingAt && document.getElementById(LLM.pendingAt);
  LLM.pendingAt = null;
  el?.closest("details:not([open])")?.setAttribute("open", "");
  if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
}

// keep: stay where the reader is (the toolbar's picker), so a story's
// chapter shows the next model's numbers in place
function llmSetModel(id, keep = false) {
  const m = llmModel(id);
  if (!m || id === LLM.model) return;
  LLM.model = id;
  if (m.features) LLM.featModel = m.id;
  llmIndRunStop();
  for (const key of ["c", "a"]) if (LLM.ind.stage >= LLM_IND_RUN[key]) LLM.ind.ran[key] = true;
  llmPopAnimStop();
  LLM.pop.anim = null;
  if (!keep) document.getElementById("llmWrap").scrollTop = 0;
  llmRender();
}

function llmOpenModel(id, view) {
  const m = llmModel(id);
  if (!m) return;
  LLM.model = id;
  if (m.features) LLM.featModel = m.id;
  llmShowView(view);
}

// Called by switchToTab() each time the panel is shown
async function llmOpen() {
  llmReadUrl();
  if (!LLM.data) {
    llmSyncControls();
    const spinner = document.getElementById("llmSpinner");
    spinner.classList.remove("hidden");
    try {
      const [summary, stmts] = await Promise.all([llmGet("/llm-evals"), llmGet("/llm-evals/statements")]);
      if (summary.missing) throw new Error(`No data in ${summary.missing}`);
      if (!LLM.data) {
        LLM.data = llmPrepare(summary, stmts);
        llmFillCounts();
        document.getElementById("llmModelSelect").innerHTML =
          LLM.data.byName.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
      }
    } catch (err) {
      console.error("LLM evaluations failed to load:", err);
      document.getElementById("llmError").classList.remove("hidden");
      return;
    } finally {
      spinner.classList.add("hidden");
    }
    document.getElementById("llmError").classList.add("hidden");
  }
  if (!llmModel()) LLM.model = llmDefaultModel().id;
  if (!llmModel(LLM.featModel)) LLM.featModel = (llmModel()?.features ? llmModel() : LLM.data.models.find((m) => m.features))?.id ?? null;
  if (llmVisible()) llmRender();
}

function llmInit() {
  llmOnSeg("llmViews", llmShowView);
  const panel = document.getElementById("panelLlm");
  // Buttons that switch view, links that scroll to a chapter or step, rows
  // that open a model, and the walkthroughs' example controls
  panel.addEventListener("click", (e) => {
    const go = e.target.closest("[data-llm-go]");
    if (go) {
      const gm = go.dataset.llmModel && llmModel(go.dataset.llmModel);
      if (gm) { LLM.model = gm.id; if (gm.features) LLM.featModel = gm.id; }
      llmShowView(go.dataset.llmGo, go.dataset.llmAt || null);
      return;
    }
    if (e.target.closest("[data-llm-task-more]") && LLM.data) { LLM.taskEx = ((LLM.taskEx || 0) + 1) % LLM_TASK_EXAMPLES.length; llmRenderTask(); return; }
    const scroll = e.target.closest("a[data-llm-scroll]");
    if (scroll) { e.preventDefault(); llmScrollTo(scroll.getAttribute("href").slice(1)); return; }
    const open = e.target.closest("[data-open][data-model]");
    if (open) { llmOpenModel(open.dataset.model, open.dataset.open); return; }
    const pick = e.target.closest("[data-ind-pick]");
    if (pick && LLM.data) { llmSetModel(pick.dataset.indPick, true); return; }
    const story = e.target.closest("[data-story]");
    if (story && LLM.data) {
      const action = story.dataset.story;
      if (action.startsWith("ind-")) llmIndAction(action);
      else llmPopAction(action);
      return;
    }
    const next = e.target.closest("[data-story-next]");
    if (next && LLM.data) { if (next.getAttribute("aria-disabled") !== "true") llmStoryStep(next.dataset.storyNext, 1); return; }
    const prev = e.target.closest("[data-story-prev]");
    if (prev && LLM.data) { if (prev.getAttribute("aria-disabled") !== "true") llmStoryStep(prev.dataset.storyPrev, -1); return; }
    const restart = e.target.closest("[data-story-restart]");
    if (restart && LLM.data) {
      if (restart.getAttribute("aria-disabled") === "true") return;
      if (restart.dataset.storyRestart === "individual") llmIndRestart();
      else llmPopRestart();
      return;
    }
    const all = e.target.closest("[data-story-all]");
    if (all && LLM.data) {
      if (all.dataset.storyAll === "individual") llmIndOpenTo(LLM_IND_LAST);
      else llmPopOpenTo(LLM_POP_LAST);
      return;
    }
    const goChap = e.target.closest("[data-story-go]");
    if (goChap && LLM.data) { e.preventDefault(); llmStoryGo(goChap.dataset.storyGo); return; }
    const sct = e.target.closest(".llm-sct-svg");
    if (sct && LLM.data) {
      const p = llmSctNearest(sct, e);
      if (p) llmOpenStatement(p[0]);
      return;
    }
    const stmt = e.target.closest("[data-stmt]");
    if (stmt && LLM.data) { llmOpenStatement(Number(stmt.dataset.stmt)); return; }
    const partOpen = e.target.closest("[data-part-open]");
    if (partOpen) { llmOpenParticipant(Number(partOpen.dataset.partOpen)); return; }
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const open = e.target.closest("[data-open][data-model]");
    if (open) { e.preventDefault(); llmOpenModel(open.dataset.model, open.dataset.open); return; }
    const pick = e.target.closest("[data-ind-pick]");
    if (pick && LLM.data) { e.preventDefault(); llmSetModel(pick.dataset.indPick, true); return; }
    const stmt = e.target.closest("[data-stmt]");
    if (stmt && LLM.data) { e.preventDefault(); llmOpenStatement(Number(stmt.dataset.stmt)); }
  });
  // The level-curve chart in chapter 3 of the individual story, and the
  // population story's scatter plots
  for (const type of ["pointermove", "pointerdown"]) {   // pointerdown: a tap on a touch screen
    panel.addEventListener(type, (e) => {
      if (!e.target.closest) return;
      if (e.target.closest(".llm-lvl-svg")) llmLvlProbe(e);
      else if (e.target.closest(".llm-sct-svg") && LLM.data) llmSctProbe(e);
      llmHoverTip(e);   // the parts of chapter 4's bar in the individual story
    });
  }
  panel.addEventListener("pointerleave", () => llmHoverTip(null));
  panel.addEventListener("pointerout", (e) => {
    const svg = e.target.closest && e.target.closest(".llm-lvl-svg, .llm-sct-svg");
    if (!svg || (e.relatedTarget && svg.contains(e.relatedTarget))) return;
    const probe = svg.querySelector(".llm-lvl-probe, .llm-sct-probe");   // none on chapter 4's chart
    if (probe) probe.style.display = "none";
    svg.classList.remove("is-on");
  });
  panel.addEventListener("change", (e) => {
  });
  document.getElementById("llmModelSelect").addEventListener("change", (e) => llmSetModel(e.target.value, true));
  const stepModel = (dir) => {
    if (!LLM.data) return;
    const list = llmRankList(LLM.view);
    const i = list.findIndex((m) => m.id === LLM.model);
    const next = list[i + dir];
    if (next) llmSetModel(next.id, true);
  };
  document.getElementById("llmModelPrev").addEventListener("click", () => stepModel(-1));
  document.getElementById("llmModelNext").addEventListener("click", () => stepModel(1));
  // Scrolling the panel hides the tooltips
  const wrap = document.getElementById("llmWrap");
  wrap.addEventListener("scroll", () => {
    for (const id of ["llmHoverTip"]) {
      const tip = document.getElementById(id);
      if (tip) tip.hidden = true;
    }
  }, { passive: true });
  // Statement modal: a model row opens that model's walkthrough in the current view
  const stmtBody = document.getElementById("llmStmtModalBody");
  const pickModel = (e) => {
    const row = e.target.closest("[data-model]");
    if (!row) return;
    llmShowModal("llmStmtModal", false);
    llmOpenModel(row.dataset.model, LLM.view === "individual" ? "individual" : "population");
  };
  stmtBody.addEventListener("click", pickModel);
  stmtBody.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickModel(e); } });
  for (const id of ["llmStmtModal", "llmPartModal"]) {
    const modal = document.getElementById(id);
    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.closest(".modal-close")) llmShowModal(id, false);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { llmShowModal("llmStmtModal", false); llmShowModal("llmPartModal", false); }
  });
  if (llmVisible()) llmOpen();
}

// A chapter link in a story's header: scroll to the chapter, opening the
// story up to it first if it is still locked
async function llmStoryGo(target) {
  const [mode, k] = target.split(":");
  const i = Number(k) - 1;
  if (!LLM.md) return;
  if (mode === "individual") {
    llmIndOpenTo(LLM_IND_OPEN[i]);
    llmScrollTo(`llmIndC${i + 1}`);
  } else {
    await llmPopOpenTo(LLM_POP_OPEN[i]);
    llmScrollTo(`llmPopC${i + 1}`);
  }
}

llmInit();
