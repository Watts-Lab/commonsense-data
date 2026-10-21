"use strict";

// ══ LLM Evaluations panel ══════════════════════════════════════════════════
// Results of Nguyen, Watts & Whiting (2026), PNAS Nexus, from a fixed snapshot
// that llm_evals.py serves at /api/llm-evals*. Loaded after app.js and uses
// its globals: API, MOUNT_PATH, TAB_SLUGS, PAGE_SIZE, PROP_DEFS, esc, fmtNum,
// fmtPct, answerPill, fixStatement, applyPropFilters, mirrorPager. home.js
// reads the summary through llmGet() and llmSummaryStats() and links into a
// view with llmShowView().
//
// Three views share one model selection, kept in the URL (?view=…&model=…):
// - Overview: laid out like Home, a hero and bands that each make one point:
//   the core task (a diagram), the two main findings as Home
//   section 5 draws them, and why it matters (llmRenderLanding).
// - LLMs as individuals: one model's score told as a story in four chapters
//   that open one click at a time: one statement and its two questions, the
//   model's answers checked against the people's majority, all statements,
//   the geometric mean, and the model head to head with each person on that
//   person's own 50 statements (llmRenderIndividual).
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

const LLM_HUMAN = UI.agree;    // people (the app's blue; UI in app.js)
const LLM_MODEL = UI.expect;   // models
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
  board: "all",         // leaderboard filter: all, paper, open, proprietary
  featModel: "gemini-pro",
  // The individual story: how far it has got (stage, see LLM_IND_OPEN), its
  // statement (ex) and chapter 1's reveal while a new statement replays
  // (sub), the statements checked so far (seen), the person in chapter 4 and
  // the one of their statements it shows (pex), and whether chapter 2 has
  // finished counting (ran)
  ind: { stage: 0, sub: 3, ex: null, seen: [], person: null, personRatings: null, pex: null, ran: false, order: null },
  // The population story: its stage (see LLM_POP_OPEN), statement, chapter
  // 4's split (seed) and the splits seen so far, busy while a split loads,
  // whether chapter 3 has finished counting (ran), the stage whose animation
  // is running (anim), and the order statements are counted and plotted in
  pop: { stage: 0, ex: null, seed: 0, split: null, splits: [], busy: false, ran: false, anim: null, order: null },
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
  [...models].sort((a, b) => b.commonsensicality - a.commonsensicality).forEach((m, i) => { m.rankCs = i + 1; });
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

// A 0-1 share as a percentage that never reads 100.0% or 0.0% unless it is
function llmPctFine(v) {
  return (v > 0.9995 && v < 1) || (v > 0 && v < 0.0005) ? `${(v * 100).toFixed(2)}%` : fmtPct(v);
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

function llmSize(b) {
  return b >= 1 ? `${fmtNum(b)}B` : `${Math.round(b * 1000)}M`;
}

// "agrees" / "disagrees" for a 1 / 0 answer
function llmAgrees(v) {
  return v ? "agrees" : "disagrees";
}

// Yes or No in neutral ink: whether it matches the majority is shown apart
function llmYesNo(v) {
  return `<span class="llm-yn ${v ? "is-yes" : "is-no"}">${v ? "Yes" : "No"}</span>`;
}

function llmMatch(ok) {
  return ok
    ? '<span class="llm-match ok" title="Matches the majority">✓</span>'
    : '<span class="llm-match no" title="Differs from the majority">✗</span>';
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

// A small SVG histogram (10 bars, shares of a total) for the small multiples
// The SVG stretches to its card's width; the tick labels are HTML below it,
// so they stay at the page's --fs-1 at every width.
function llmMiniHist(counts, total, color, top) {
  const W = 220, H = 76, bw = W / counts.length;
  const bars = counts.map((c, i) => {
    const h = ((c / total) / top) * (H - 4);
    return `<rect x="${(i * bw + 1.5).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>${i * 10}–${(i + 1) * 10}%: ${((c / total) * 100).toFixed(1)}% of statements</title></rect>`;
  }).join("");
  return (
    `<svg class="llm-mini-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-hidden="true">` +
    `${bars}<line x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}" class="llm-mini-axis" vector-effect="non-scaling-stroke"/></svg>` +
    `<div class="llm-mini-ticks" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div>`
  );
}

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
    const noun = cfg.noun || "rows";
    $('[data-role="label"]').textContent = t.extra
      ? `${t.extra.label} · ${fmtNum(rows.length)} ${noun} · click the bar again to clear`
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
// Laid out like Home: a hero, then bands that each make one point. Band 1 is
// a diagram of the core task; bands 2 and 3 are the paper's two
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

// Band 1: the core task, as three cards in a row that scroll sideways, one
// in focus at a time (llmCarousel): a statement and its two questions; a
// person's answers to them; an LLM's answers, with the probability of yes
// behind each. All real: a statement people split on (LLM_TASK_EXAMPLE, Josh's
// pick: 14 of its 28 raters agree), one of the people who rated it
// (LLM_TASK_PERSON, who answers no to both) and the top individual model,
// which answers yes to both.
const LLM_ICON_LLM =
  '<svg class="llm-chip-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/>' +
  '<path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>';
const LLM_TASK_EXAMPLE = "As society advances the standard of poverty rises.";
const LLM_TASK_PERSON = 1300;   // rated LLM_TASK_EXAMPLE (the data is a fixed snapshot)
const LLM_TASK_QS = ["Do you agree with this statement?", "Do you think most people would agree with this statement?"];

function llmTaskHtml(s, m, pa, pm) {
  const d = LLM.data, n = 3;
  const qn = (i) => `<span class="llm-sv-qn">${i}</span>`;
  // Yes and No, the one given filled
  const opts = (y) => `<span class="llm-car-opts"><span class="${y ? "is-on" : ""}">Yes</span><span class="${y ? "" : "is-on"}">No</span></span>`;
  const row = (i, ans) => `<div class="llm-car-row">${qn(i + 1)}<span class="llm-car-qt">${LLM_TASK_QS[i]}</span><span class="llm-car-ans">${ans}</span></div>`;
  const card = (k, cls, label, body) =>
    `<article class="llm-car-card ${cls}" aria-roledescription="slide" aria-label="${k} of ${n}: ${label}">${body}</article>`;
  const quote = `<blockquote class="llm-car-quote">${esc(s.text)}</blockquote>`;
  const prob = (p) => `<span class="llm-car-p">${llmProbBar(p)}</span>`;
  return (
    `<div class="llm-car-track" tabindex="0">` +
    card(1, "is-stmt", "the statement",
      `<div class="llm-task-k">A statement</div><blockquote class="llm-task-quote">${esc(s.text)}</blockquote>` +
      `<ol class="llm-task-qs">${LLM_TASK_QS.map((t, i) => `<li>${qn(i + 1)}${t}</li>`).join("")}</ol>`) +
    card(2, "is-person", "a person's answers",
      `<div class="llm-task-k"><i class="llm-pp is-p"></i>A person's answers</div>` +
      `<div class="llm-car-who"><strong>Person #${pa.id}</strong> one of ${fmtNum(d.n_participants)} people, who each rated 50 statements</div>` +
      quote + row(0, opts(pa.a)) + row(1, opts(pa.o)) +
      `<p class="llm-car-note">People disagree: ${fmtNum(s.k_agree)} of the ${fmtNum(s.n)} who rated this statement agree, and ${fmtNum(s.n - s.k_agree)} don't.</p>`) +
    card(3, "is-llm", "an LLM's answers",
      `<div class="llm-task-k">${LLM_ICON_LLM}An LLM's answers</div>` +
      `<div class="llm-car-who"><strong>${esc(m.name)}</strong> one of ${fmtNum(d.models.length)} LLMs, which each rated all ${fmtNum(d.n_statements)} statements</div>` +
      quote + row(0, prob(pm[0]) + opts(pm[0] >= 0.5)) + row(1, prob(pm[1]) + opts(pm[1] >= 0.5)) +
      `<p class="llm-car-note">Each bar is its probability of answering “yes”; 50% or more counts as yes.</p>`) +
    `</div>` +
    `<div class="llm-car-nav"><button type="button" class="llm-car-btn" data-car="-1" aria-label="Previous card">‹</button>` +
    `<span class="llm-car-dots">${Array.from({ length: n }, (_, i) => `<button type="button" data-car-to="${i}" aria-label="Card ${i + 1} of ${n}"></button>`).join("")}</span>` +
    `<button type="button" class="llm-car-btn" data-car="1" aria-label="Next card">›</button></div>`
  );
}

// A row of cards that scrolls sideways (scroll snap), with previous / next
// buttons, dots, the arrow keys and a click on a card out of focus. The card
// in focus sits in the middle; it is the one whose centred position is
// nearest the scroll position, and the others are dimmed.
function llmCarousel(root) {
  const track = root.querySelector(".llm-car-track"), cards = [...track.children];
  const dots = [...root.querySelectorAll("[data-car-to]")], btns = [...root.querySelectorAll("[data-car]")];
  const max = () => track.scrollWidth - track.clientWidth;
  // the scroll position that puts card c in the middle
  const pos = (c) => Math.max(0, Math.min(c.offsetLeft + c.offsetWidth / 2 - track.clientWidth / 2, max()));
  let cur = 0;
  const mark = () => {
    const x = track.scrollLeft;
    cur = cards.reduce((best, c, i) => (Math.abs(pos(c) - x) < Math.abs(pos(cards[best]) - x) ? i : best), 0);
    cards.forEach((c, i) => c.classList.toggle("is-on", i === cur));
    dots.forEach((b, i) => b.setAttribute("aria-current", i === cur ? "true" : "false"));
    btns.forEach((b) => { b.disabled = Number(b.dataset.car) < 0 ? cur === 0 : cur === cards.length - 1; });
  };
  const go = (i) => {
    const k = Math.max(0, Math.min(cards.length - 1, i));
    track.scrollTo({ left: pos(cards[k]), behavior: llmReduced() ? "auto" : "smooth" });
    cur = k;
  };
  track.addEventListener("scroll", mark, { passive: true });
  window.addEventListener("resize", mark);
  btns.forEach((b) => b.addEventListener("click", () => go(cur + Number(b.dataset.car))));
  dots.forEach((b, i) => b.addEventListener("click", () => go(i)));
  cards.forEach((c, i) => c.addEventListener("click", () => { if (i !== cur) go(i); }));
  track.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    go(cur + (e.key === "ArrowRight" ? 1 : -1));
  });
  mark();
}

async function llmRenderTask(m) {
  const d = LLM.data, el = document.getElementById("llmTask");
  const s = d.statements.find((x) => x.raw === LLM_TASK_EXAMPLE) ?? d.statements.find((x) => x.raw === LLM_IND_EXAMPLE) ?? d.statements[0];
  const key = `${m.id}:${s.id}`;
  if (el.dataset.key === key) return;
  try {
    const [person, sc] = await Promise.all([llmGet(`/llm-evals/participant?id=${LLM_TASK_PERSON}`), llmGet(`/llm-evals/statement?id=${s.id}`)]);
    const r = person.ratings.find((x) => x[0] === s.id);
    if (!r) throw new Error(`Person #${LLM_TASK_PERSON} did not rate statement ${s.id}`);
    el.innerHTML = llmTaskHtml(s, m, { id: person.id, a: r[1], o: r[2] }, sc.ratings[d.models.indexOf(m)]);
    el.dataset.key = key;
    llmCarousel(el);
  } catch (err) {
    console.error("LLM example load failed:", err);
    el.innerHTML = '<p class="hs-empty">The example could not be loaded. Try refreshing the page.</p>';
  }
}

function llmRenderLanding() {
  const d = LLM.data, all = d.models, P = all.length, half = d.paper.split_half_r;
  const best = [...all].sort((a, b) => a.rankCs - b.rankCs)[0];
  llmRenderTask(best);

  // 2 · As individuals: humans' and models' commonsensicality, against the
  // median human
  const above = all.filter((m) => m.commonsensicality > d.humanMedian).length;
  document.getElementById("llmLandIndChart").innerHTML = llmHistHtml(d);
  document.getElementById("llmLandIndFinding").innerHTML = above * 2 < P
    ? `We found a modest result: only <strong>${above} out of ${P}</strong> LLMs score above the median human.`
    : `<strong>${above} out of ${P}</strong> LLMs score above the median human.`;
  document.getElementById("llmLandIndGo").dataset.llmModel = best.id;

  // 3 · As populations: r between each model's crowd and people, lowest
  // first, against two random halves of people in the sentence under it
  const byR = all.filter((m) => m.r !== null).sort((a, b) => a.r - b.r), bestR = byR.at(-1);
  const gap = bestR.r < half - 0.1 ? "substantially below" : bestR.r < half ? "below" : "at or above";
  const rs = { min: Math.min(-0.2, Math.floor(byR[0].r * 10) / 10), max: Math.max(0.6, Math.ceil(bestR.r * 10) / 10 + 0.1), fmt: llmRTick, name: "r", ticks: [] };
  for (let t = Math.ceil(rs.min * 5) / 5; t <= rs.max + 1e-9; t += 0.2) rs.ticks.push(Math.round(t * 10) / 10);
  document.getElementById("llmLandPopChart").innerHTML = llmColsHtml(
    byR.map((m) => ({ v: m.r, cls: m.r_sig ? "" : "is-faint", tip: `${m.name}: r = ${llmR(m.r)}${m.r_sig ? "" : ", not significantly different from 0"}` })),
    rs, null,
    `Bar chart: each of the ${P} models' correlation r with humans' statement scores, from lowest to highest; the best is ${llmR(bestR.r)}, against ${llmR(half)} between two halves of humans`,
    esc(bestR.name), -1);
  document.getElementById("llmLandPopFinding").innerHTML =
    `The best model has a correlation of <strong>r&nbsp;=&nbsp;${llmR(bestR.r)}</strong>, ${gap} the human split-half reliability of <strong>r&nbsp;=&nbsp;${llmR(half)}</strong>.`;
  document.getElementById("llmLandPopGo").dataset.llmModel = bestR.id;
}

// ── Every model as an individual (the individual view's Explore further) ──

const LLM_PEOPLE_ROWS = {
  75: ["75th-percentile person", "scores higher than 75% of people"],
  50: ["Median person", "half of people score higher, half lower"],
  25: ["25th-percentile person", "scores higher than 25% of people"],
};

function llmBoardModels() {
  const d = LLM.data, f = LLM.board;
  return d.models.filter((m) => f === "all" || m.access === f);
}

function llmModelTitle(m) {
  const ci = m.ci && m.ci.cs ? ` · 95% interval ${fmtPct(m.ci.cs[0])}–${fmtPct(m.ci.cs[1])}` : "";
  return `${m.name}: consensus ${fmtPct(m.consensus)} × awareness ${fmtPct(m.awareness)} → commonsensicality ${fmtPct(m.commonsensicality)}${ci}. ${[m.organization, llmAccessLabel(m), llmMonth(m.released)].filter(Boolean).join(", ")}.`;
}

function llmRenderBoard() {
  const d = LLM.data;
  llmSyncSeg("llmBoardFilter", LLM.board);
  const models = llmBoardModels().sort((a, b) => b.commonsensicality - a.commonsensicality);
  const refs = [{ x: d.humanMedian, cls: "is-human", label: `Median person ${fmtPct(d.humanMedian)}` }];
  const people = (d.human_reference || []).filter((h) => LLM_PEOPLE_ROWS[h.percentile]);
  const rows = [
    ...models.map((m) => ({ v: m.commonsensicality, m })),
    ...people.map((h) => ({ v: h.commonsensicality, h })),
  ].sort((a, b) => b.v - a.v || (a.h ? -1 : 1));
  let rank = 0;
  const html = rows.map((row) => {
    if (row.h) {
      const [name, sub] = LLM_PEOPLE_ROWS[row.h.percentile];
      return (
        `<div class="llm-bar-row is-people" title="${esc(`${name} among the ${fmtNum(d.n_participants)} people: ${sub}`)}"><span class="lb-rank"></span>` +
        `<span class="lb-name">${name}</span>${llmTrack(row.v, LLM_PCT_SCALE, "is-human", refs)}` +
        `<span class="lb-val">${fmtPct(row.v)}</span><span class="lb-extra"></span></div>`
      );
    }
    const m = row.m;
    rank++;
    return (
      `<div class="llm-bar-row${m.id === LLM.model ? " is-selected" : ""}"${llmRowOpen(m, "individual")} title="${esc(llmModelTitle(m))}">` +
      `<span class="lb-rank">${rank}</span><span class="lb-name">${llmName(m)} <span class="lb-org">${esc(m.organization || "")}</span></span>` +
      `${llmTrack(row.v, LLM_PCT_SCALE, llmModelCls(m), refs)}<span class="lb-val">${fmtPct(row.v)}</span>` +
      `<span class="lb-extra">${fmtPct(m.human_percentile)}</span></div>`
    );
  }).join("");
  document.getElementById("llmBoard").innerHTML =
    `<div class="llm-bar-row is-head"><span class="lb-rank">#</span><span class="lb-name">Model</span>${llmAxis(LLM_PCT_SCALE, refs)}` +
    `<span class="lb-val">Score</span><span class="lb-extra">Beats</span></div>` + html;

  // Takeaways, computed on all the models
  const all = d.models;
  const below = all.filter((m) => m.commonsensicality < d.humanMedian);
  const best = [...all].sort((a, b) => b.commonsensicality - a.commonsensicality)[0];
  const p75 = people.find((h) => h.percentile === 75);
  const mean = all.reduce((s, m) => s + m.commonsensicality, 0) / all.length;
  const sd = Math.sqrt(all.reduce((s, m) => s + (m.commonsensicality - mean) ** 2, 0) / (all.length - 1));
  const byName = (n) => all.find((m) => m.name === n);
  const t5 = byName("Flan-T5-XXL"), gpt4 = byName("GPT-4-0409"), falcon = byName("Falcon-180B");
  const parts = [
    `<strong>${below.length} of the ${all.length} models score below the median person</strong> (${fmtPct(d.humanMedian)}), and ` +
    (p75 && !all.some((m) => m.commonsensicality >= p75.commonsensicality) ? `none reaches the top quarter of people (${fmtPct(p75.commonsensicality)}). ` : "some reach the top quarter of people. ") +
    `The best, ${esc(best.name)} (${fmtPct(best.commonsensicality)}), outscores ${fmtPct(best.human_percentile)} of people.`,
  ];
  if (t5 && gpt4 && falcon && t5.params_b && falcon.params_b) {
    parts.push(
      `Smaller open-weight models hold their own: ${esc(t5.name)}, with ${llmSize(t5.params_b)} parameters, scores ${fmtPct(t5.commonsensicality)}, ` +
      `level with ${esc(gpt4.name)} (${fmtPct(gpt4.commonsensicality)}) and with ${esc(falcon.name)} (${fmtPct(falcon.commonsensicality)}), ${Math.round(falcon.params_b / t5.params_b)} times its size.`,
    );
  }
  document.getElementById("llmBoardTakeaway").innerHTML = parts.join(" ");
  const tied = d.models.filter((m) => m.n_tie && m.n_tie[0] >= 0.1 * d.n_statements);
  const tieNote = tied.length
    ? ` ${tied.map((m) => `${esc(m.name)} answers exactly 50% to “Do you agree?” on ${fmtPct(m.n_tie[0] / d.n_statements)} of statements`).join(" and ")}; a tie counts as yes, so read ${tied.length > 1 ? "their" : "its"} score with care.`
    : "";
  document.getElementById("llmBoardNote").innerHTML =
    `The ${all.length} models average ${fmtPct(mean)} (SD ${(sd * 100).toFixed(1)} points). ` +
    `Hover a model for its consensus, awareness and 95% interval (1,000 bootstrap resamples of the statements). ` +
    `People's rows are percentiles of the ${fmtNum(d.n_participants)} participants' own scores.${tieNote}`;
}

// ── Model size (the individual view's Explore further) ──

const LLM_FAMILY_ORDER = ["Flan-T5", "Qwen2", "Gemma", "LLaMA-2/3", "Mistral", "Falcon"];

function llmRenderSize() {
  const d = LLM.data, p = d.paper;
  const sized = d.models.filter((m) => m.size_family && m.params_b);
  const card = document.getElementById("llmIndSize");
  card.classList.toggle("hidden", !sized.length);
  if (!sized.length) return;
  const fams = LLM_FAMILY_ORDER.filter((f) => sized.some((m) => m.size_family === f));
  const refs = [{ x: d.humanMedian, cls: "is-human", label: `Median person ${fmtPct(d.humanMedian)}` }];
  let html = `<div class="llm-bar-row is-head"><span class="lb-name">Model</span><span class="lb-size">Size</span>${llmAxis(LLM_PCT_SCALE, refs)}<span class="lb-val">Score</span></div>`;
  for (const fam of fams) {
    const ms = sized.filter((m) => m.size_family === fam).sort((a, b) => a.params_b - b.params_b || a.name.localeCompare(b.name));
    html += `<div class="llm-bar-group">${esc(fam)}</div>`;
    html += ms.map((m) =>
      `<div class="llm-bar-row${m.id === LLM.model ? " is-selected" : ""}"${llmRowOpen(m, "individual")} title="${esc(llmModelTitle(m))}">` +
      `<span class="lb-name">${llmName(m)}</span><span class="lb-size">${llmSize(m.params_b)}</span>` +
      `${llmTrack(m.commonsensicality, LLM_PCT_SCALE, llmModelCls(m), refs)}<span class="lb-val">${fmtPct(m.commonsensicality)}</span></div>`,
    ).join("");
  }
  document.getElementById("llmSize").innerHTML = html;
  const l7 = d.models.find((m) => m.name === "LLaMA-2-7B"), l13 = d.models.find((m) => m.name === "LLaMA-2-13B");
  document.getElementById("llmSizeLead").innerHTML =
    `Six families in the paper come in several sizes. Across these ${p.size_n} models, the paper fits a mixed-effects regression with family as a random effect: ` +
    `<strong>each tenfold increase in parameters goes with ${p.size_beta} more points</strong> of commonsensicality (95% CI ${p.size_lo} to ${p.size_hi}; p = ${llmP(p.size_p)}). ` +
    (l7 && l13 ? `Size is not the whole story: ${esc(l13.name)} scores ${fmtPct(l13.commonsensicality)}, far below ${esc(l7.name)} (${fmtPct(l7.commonsensicality)}), and the best LLaMA model outscores only ${fmtPct(Math.max(...d.models.filter((m) => m.size_family === "LLaMA-2/3").map((m) => m.human_percentile)))} of people, so the paper points to training data as well.` : "");
  document.getElementById("llmSizeNote").textContent =
    "Parameters in billions (B) or millions (M), as in the paper; mixture-of-experts models count all their parameters (Mixtral-8x22B: 141B). Click a model to work through its score.";
}

// ── Every model's crowd (the population view's Explore further) ──

const LLM_R_SCALE = { min: -0.15, max: 0.7, ticks: [0, 0.2, 0.4, 0.6], fmt: llmRTick };

// Every model's r, people's split-half r on top; the selected model is
// highlighted
function llmRBarsHtml(selected) {
  const d = LLM.data, p = d.paper;
  const refs = [{ x: p.split_half_r, cls: "is-human", label: `Two halves of people ${llmR(p.split_half_r)}` }];
  const models = [...d.models].sort((a, b) => (b.r ?? -2) - (a.r ?? -2));
  return (
    `<div class="llm-bar-row is-head"><span class="lb-rank">#</span><span class="lb-name">Model</span>${llmAxis(LLM_R_SCALE, refs)}<span class="lb-val lb-stat">r</span></div>` +
    `<div class="llm-bar-row is-people" title="${esc(`People: the average correlation between two random halves of the ${fmtNum(d.n_participants)} participants over 1,000 splits (95% CI ${llmR(p.split_half_lo)} to ${llmR(p.split_half_hi)}), from the paper`)}">` +
    `<span class="lb-rank"></span><span class="lb-name">People: one half vs the other</span>${llmTrack(p.split_half_r, LLM_R_SCALE, "is-human", refs)}<span class="lb-val">${llmR(p.split_half_r)}</span></div>` +
    models.map((m, i) => {
      const ns = !m.r_sig;
      const tip = `${m.name}: r = ${llmR(m.r)}${m.ci && m.ci.r ? ` (95% interval ${llmR(m.ci.r[0])} to ${llmR(m.ci.r[1])})` : ""}${ns ? ", not significantly different from 0 after a Bonferroni correction" : ""}. Its crowd's scores are on average ${(m.mae * 100).toFixed(1)} points from people's.`;
      return (
        `<div class="llm-bar-row${m.id === selected ? " is-selected" : ""}"${llmRowOpen(m, "population")} title="${esc(tip)}">` +
        `<span class="lb-rank">${i + 1}</span><span class="lb-name">${llmName(m)}</span>` +
        `${llmTrack(m.r ?? 0, LLM_R_SCALE, `${llmModelCls(m)}${ns ? " is-faint" : ""}`, refs)}` +
        `<span class="lb-val">${llmR(m.r)}${ns ? ' <span class="lb-ns">n.s.</span>' : ""}</span></div>`
      );
    }).join("")
  );
}

// Models whose P(yes) to Q1 is exactly 50% on at least a tenth of statements
function llmTieNote(d, effect) {
  const tied = d.models.filter((m) => m.n_tie && m.n_tie[0] >= 0.1 * d.n_statements);
  if (!tied.length) return "";
  return ` ${tied.map((m) => `${m.name} answers exactly 50% to “Do you agree?” on ${fmtPct(m.n_tie[0] / d.n_statements)} of statements`).join(" and ")}: ${effect}, so read ${tied.length > 1 ? "these models" : "this model"} with care.`;
}

function llmRenderRBars() {
  const d = LLM.data, p = d.paper;
  document.getElementById("llmRBars").innerHTML = llmRBarsHtml(LLM.model);
  const all = [...d.models].filter((m) => m.r !== null).sort((a, b) => b.r - a.r);
  const top3 = all.slice(0, 3);
  const byName = (n) => d.models.find((m) => m.name === n);
  const g35 = byName("GPT-3.5"), g4o = byName("GPT-4o");
  const neg = all.filter((m) => m.r < 0 && m.r_sig);
  const falcons = d.models.filter((m) => m.size_family === "Falcon").sort((a, b) => a.params_b - b.params_b);
  const ns = all.filter((m) => !m.r_sig);
  const bestInd = [...all].sort((a, b) => b.commonsensicality - a.commonsensicality)[0];
  document.getElementById("llmRTakeaway").innerHTML =
    `Every model's crowd matches people less closely than one half of people matches the other. The closest, ${top3.map((m) => `${esc(m.name)} (${llmR(m.r)})`).join(", ").replace(/, ([^,]*)$/, " and $1")}, ` +
    `stay below the <strong>${llmR(p.split_half_r)}</strong> at which two random halves of the ${fmtNum(d.n_participants)} people agree. ` +
    (g35 && g4o ? `Newer is not better: ${esc(g35.name)} reaches ${llmR(g35.r)}, ${esc(g4o.name)} ${llmR(g4o.r)}. ` : "") +
    (falcons.length === 3 ? `Bigger can be: Falcon's crowd tracks people better with size (${falcons.map((m) => `${llmSize(m.params_b)} ${llmR(m.r)}`).join(", ")}). ` : "") +
    (neg.length ? `${neg.map((m) => `${esc(m.name)}'s`).join(" and ")} ${neg.length > 1 ? "crowds run" : "crowd runs"} slightly against people (${neg.map((m) => llmR(m.r)).join(", ")}), and ` : "") +
    `${ns.length} of the ${d.models.length} models have crowds with no detectable relation to people's (faint bars). ` +
    `Which model looks best depends on the test: ${esc(bestInd.name)} is 1st as an individual but ${llmOrdinal(bestInd.rankR)} of ${d.models.length} as a crowd.`;
  const e = d.ensemble;
  const oos = e.single.map(([n, v]) => `${n} ${Math.round(v * 100)}%`).join(", ");
  document.getElementById("llmRNote").textContent =
    `Together, the ${e.n_models} models' crowds explain ${Math.round(e.r2 * 100)}% of the variance in people's statement scores (out-of-sample R², ${e.folds}-fold cross-validation, as the paper computes it); ` +
    `a single model explains far less (${oos}). Faint bars: p ≥ .05 after a Bonferroni correction for ${d.n_tests} tests, one per model. ` +
    `People: the paper's split-half reliability, the average correlation between two random halves of the participants over 1,000 splits (95% CI ${llmR(p.split_half_lo)} to ${llmR(p.split_half_hi)}).` +
    llmTieNote(d, "a crowd counts a 50% statement as evenly split, which gives it a score of 0");
}

// ── Certainty (the population view's Explore further; the story's model first) ──

function llmSureShare(m) {
  return m.n_sure / LLM.data.n_statements;
}

function llmRenderCertainty() {
  const d = LLM.data, h = d.humans;
  const total = d.n_statements;
  const panels = [
    { name: "People", sub: "share of raters who agree", counts: h.hist[0], sure: h.n_sure / total, color: LLM_HUMAN, people: true },
    ...[...new Set([LLM.model, ...LLM_CERTAINTY_MODELS])].slice(0, LLM_CERTAINTY_MODELS.length).map((id) => d.modelById.get(id)).filter(Boolean).map((m) => ({
      name: m.name, sub: "probability of agreeing", counts: m.hist[0], sure: llmSureShare(m), color: LLM_MODEL, m,
    })),
  ];
  // One scale for every panel, so their bars compare directly
  const top = Math.max(0.1, Math.ceil(Math.max(...panels.flatMap((pn) => pn.counts)) / total * 10) / 10);
  document.getElementById("llmCertainty").innerHTML = panels.map((pn) =>
    `<div class="llm-multiple${pn.people ? " is-people" : ""}"${pn.m ? llmRowOpen(pn.m, "population") : ""}>` +
    `<div class="llm-multiple-name">${pn.m ? llmName(pn.m) : esc(pn.name)}</div><div class="llm-multiple-sub">${pn.sub}</div>` +
    llmMiniHist(pn.counts, total, pn.color, top) +
    `<div class="llm-multiple-foot"><strong>${fmtPct(pn.sure)}</strong> of statements ${pn.people ? "near-unanimous" : "near-certain"}</div></div>`,
  ).join("");
  const sureModels = d.models.filter((m) => llmSureShare(m) > 0.5);
  document.getElementById("llmCertaintyNote").innerHTML =
    `Near-certain: a probability of agreeing at most 5% or at least 95%; for people, at least 95% of a statement's raters agreeing, or at least 95% disagreeing. ` +
    `${sureModels.length} of the ${d.models.length} models are near-certain on more than half of the statements; people are near-unanimous on ${fmtPct(h.n_sure / total)}. ` +
    `Probabilities huddled near 50%, like Flan-T5-XXL's and Falcon's, mostly come from first words other than yes or no, which the study's code splits evenly between the two. Click a model to work through it as a crowd.`;
}

// ── Kinds of statements (the population view's Explore further) ──

function llmFeatureSides(j) {
  const def = PROP_DEFS.find((p) => p.key === LLM.data.properties[j]);
  return [def.v1, def.v0];
}

function llmRenderFeatChips() {
  const d = LLM.data;
  const chips = LLM_FEATURE_MODELS.map((id) => d.modelById.get(id)).filter(Boolean);
  const others = d.byName.filter((m) => !LLM_FEATURE_MODELS.includes(m.id) && m.features);
  document.getElementById("llmFeatChips").innerHTML =
    `<span class="llm-chips-label">The paper's examples:</span>` +
    chips.map((m) => `<button type="button" class="llm-chip" data-feat="${esc(m.id)}" aria-pressed="${m.id === LLM.featModel}">${esc(m.name)}</button>`).join("") +
    `<select class="select llm-chip-select" id="llmFeatSelect" aria-label="Any other model"><option value="">Any other model…</option>` +
    others.map((m) => `<option value="${esc(m.id)}"${m.id === LLM.featModel ? " selected" : ""}>${esc(m.name)}</option>`).join("") + `</select>`;
}

function llmRenderFeatures() {
  const d = LLM.data, h = d.humans;
  const m = d.modelById.get(LLM.featModel);
  const card = document.getElementById("llmPopFeat");
  card.classList.toggle("hidden", !h.features || !m || !m.features);
  if (!h.features || !m || !m.features) return;
  llmRenderFeatChips();
  document.getElementById("llmFeatLegend").textContent = `${m.name}'s crowd`;
  const all = [...h.features, ...m.features].flatMap((f) => [f[0], f[1], f[2]]);
  const lim = Math.max(0.1, Math.ceil(Math.max(...all.map(Math.abs)) * 50) / 50);
  const s = { min: -lim, max: lim, ticks: [-lim, -lim / 2, 0, lim / 2, lim], minor: [-lim / 2, lim / 2], fmt: (v) => (Math.abs(v) < 1e-9 ? "0" : `${llmPts(v, 0)}`) };
  const bar = (f, cls, who, sides) => {
    const tip = `${who}: ${sides[0]} ${f[0] >= 0 ? "more" : "less"} commonsensical than ${sides[1].toLowerCase()} by ${Math.abs(f[0] * 100).toFixed(1)} points (95% interval ${llmPts(f[1])} to ${llmPts(f[2])})`;
    return `<div class="llm-feat-bar" title="${esc(tip)}"><span class="llm-feat-who">${esc(who)}</span>${llmTrack(f[0], s, cls)}<span class="llm-feat-val">${llmPts(f[0])}</span></div>`;
  };
  document.getElementById("llmFeat").innerHTML =
    `<div class="llm-feat-axis"><span></span>${llmAxis(s)}<span></span></div>` +
    d.properties.map((_, j) => {
      const sides = llmFeatureSides(j);
      return (
        `<div class="llm-feat-row"><div class="llm-feat-sides"><span>← ${esc(sides[1])}</span><span>${esc(sides[0])} →</span></div>` +
        bar(h.features[j], "is-human", "People", sides) + bar(m.features[j], llmModelCls(m), m.name, sides) + `</div>`
      );
    }).join("");
  // Which features the crowd favours like people (95% interval on people's
  // side of 0), makes no clear distinction on (interval spans 0), or reverses
  const like = [], none = [], rev = [];
  d.properties.forEach((_, j) => {
    const [v, lo, hi] = m.features[j];
    const sides = llmFeatureSides(j);
    const label = `${sides[0].toLowerCase()} over ${sides[1].toLowerCase()}`;
    if (lo > 0) like.push(label);
    else if (hi < 0) rev.push(`${sides[1].toLowerCase()} over ${sides[0].toLowerCase()} (${llmPts(-v)} points)`);
    else none.push(`${sides[0].toLowerCase()} and ${sides[1].toLowerCase()}`);
  });
  const list = (xs) => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0];
  const fact = h.features[0][0];
  document.getElementById("llmFeatTakeaway").innerHTML =
    `People find facts ${(fact * 100).toFixed(1)} points more commonsensical than opinions, the largest gap. ` +
    `${esc(m.name)}'s crowd ${like.length ? `favours ${list(like)}, as people do` : "favours none of people's sides clearly"}` +
    (none.length ? `; it makes no clear distinction between ${list(none)}` : "") +
    (rev.length ? `; and it reverses people, favouring ${list(rev)}` : "") + `.` +
    (like.length === 6 ? " It matches people on all six." : "");
}

// ══ Stories: shared pieces ═════════════════════════════════════════════════
// "LLMs as individuals" and "LLMs as populations" each tell one model's score
// as a story of short steps. One "Next" button, in a bar that sticks to the
// bottom of the window (the stepper), reveals the next step and scrolls its
// chapter card to the top of the panel, so the reader always sees the top
// of the card being added to and keeps clicking in the same place; its label says
// what the click will show. The chapter links in the header jump ahead, and
// "Show all steps" opens everything. How far a story has got (LLM.ind.stage,
// LLM.pop.stage) survives picking another model, so the same steps then show
// that model's numbers. What a click has just revealed gets .llm-in, which
// fades it in. Nothing waits on requestAnimationFrame, which an embedded or
// hidden browser pane may never run: the counts and the population story's
// scatter plots fill on timers, and the bar charts draw without animation.

function llmReduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Scrolls the panel so el shows: its top just under the toolbar (start), or
// just enough to show it whole above the stepper bar, but never so far that
// card's top (when given) leaves the panel. Measured here rather than left
// to scrollIntoView({block: "nearest"}), which Chrome sometimes declines to
// scroll inside #llmWrap, and which can't know the bar's height.
function llmRevealEl(el, start = false, card = null) {
  const wrap = document.getElementById("llmWrap");
  if (!el || !wrap) return;
  const w = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
  const bar = el.closest(".llm-story")?.querySelector(".llm-stepper:not(.is-end) .llm-stepper-in");
  const top = w.top + 14, bottom = w.bottom - (bar ? bar.offsetHeight + 28 : 14);
  let dy = 0;
  if (start || r.top < top || r.height > bottom - top) dy = r.top - top;
  else if (r.bottom > bottom) dy = r.bottom - bottom;
  if (card) dy = Math.min(dy, card.getBoundingClientRect().top - top);
  if (Math.abs(dy) >= 1) wrap.scrollBy({ top: dy, behavior: llmReduced() ? "auto" : "smooth" });
}

function llmScrollTo(id) {
  const el = document.getElementById(id);
  el?.closest("details:not([open])")?.setAttribute("open", "");
  llmRevealEl(el, true);
}

// One chapter, or, until it opens, an empty hidden slot (kept so the chapter
// can be swapped in by id): chapters appear one by one as the reader clicks
function llmChap(id, num, title, open, lead, body) {
  if (!open) return `<div class="llm-chap-slot" id="${id}" hidden></div>`;
  return (
    `<div class="chart-card llm-chap" id="${id}"><div class="llm-chap-head">` +
    `<span class="llm-chap-num">${num}</span><div><h3 class="llm-chap-title">${title}</h3>` +
    (open && lead ? `<p class="llm-chap-lead">${lead}</p>` : "") + `</div></div>` +
    (open ? `<div class="llm-chap-body">${body}</div>` : "") + `</div>`
  );
}

// " llm-in" when what shows at k was revealed by the latest click
function llmFresh(fresh, k) {
  return fresh && fresh.has(k) ? " llm-in" : "";
}

// The story's header: its question, its lead (the population story passes
// its own, which quotes the chapters' statement), and, once a second chapter
// has opened, the open chapters as links
function llmStoryHead(mode, m, chapters, opened, lead = null) {
  const d = LLM.data, ind = mode === "individual";
  const title = ind ? `What if ${llmName(m)} took the survey?` : `What if ${llmName(m)} stood for a whole crowd?`;
  if (lead === null) lead = ind
    ? `${esc(m.name)} answers the same two questions as the ${fmtNum(d.n_participants)} people did, about all ${fmtNum(d.n_statements)} statements, and is scored exactly like a person.`
    : `Now read ${esc(m.name)}'s answers as the shares of a population answering yes.`;
  const prefix = ind ? "llmIndC" : "llmPopC";
  return (
    `<h2 class="llm-story-title">${title}</h2>` +
    `<p class="llm-story-lead">${lead}</p>` +
    (opened > 1
      ? `<nav class="llm-toc llm-story-toc" aria-label="Chapters">` +
        chapters.slice(0, opened).map((c, i) => `<a href="#${prefix}${i + 1}" data-story-go="${mode}:${i + 1}"><span>${i + 1}</span>${c}</a>`).join("") + `</nav>`
      : "")
  );
}

// The stepper: progress dots, the Next button and "Show all steps". It is
// built once and then only relabelled, so the button keeps keyboard focus.
function llmStepper(mode, st) {
  const el = document.getElementById(mode === "individual" ? "llmIndStepper" : "llmPopStepper");
  if (!el) return;
  if (!el.firstElementChild) {
    el.innerHTML =
      `<div class="llm-stepper-in"><span class="llm-dots" role="img"></span>` +
      `<button type="button" class="llm-next" data-story-next="${mode}"><span class="llm-next-label"></span><span class="llm-cta-arrow" aria-hidden="true">→</span></button>` +
      `<button type="button" class="llm-stepper-all" data-story-all="${mode}"><span class="llm-wide-only">Show </span>all steps</button></div>`;
  }
  const dots = el.querySelector(".llm-dots");
  dots.innerHTML = Array.from({ length: st.total }, (_, i) => `<i${i < st.stage ? ' class="is-done"' : ""}></i>`).join("");
  dots.setAttribute("aria-label", `${Math.min(st.stage, st.total)} of ${st.total} steps shown`);
  const btn = el.querySelector(".llm-next");
  btn.querySelector(".llm-next-label").textContent = st.label;
  btn.classList.toggle("is-busy", !!st.busy);
  btn.classList.toggle("is-end", !!st.end);
  btn.setAttribute("aria-disabled", st.busy ? "true" : "false");
  el.querySelector(".llm-stepper-all").classList.toggle("is-hidden", !!st.end);
  el.classList.toggle("is-end", !!st.end);   // at the end it stops floating over the content
  // Until the end, room under the story's last step, so a step scrolled to
  // the top of the panel still leaves the bar at the bottom of the window
  el.closest(".llm-story")?.classList.toggle("is-going", !st.end);
  // Until the first click the bar hops as it arrives and its button pulses,
  // so a reader new to the story sees where to click (CSS only: nothing
  // depends on the animation running)
  el.classList.toggle("is-hint", st.stage === 0 && !st.end);
}

// A statement's header in a story, with buttons to change the statement
function llmExHead(kicker, isPaper, prefix) {
  return (
    `<div class="llm-ex-head"><span class="llm-ex-kicker">${kicker}</span><span class="llm-ex-btns">` +
    (isPaper ? "" : `<button type="button" class="llm-btn" data-story="${prefix}-paper">The paper's example</button>`) +
    `<button type="button" class="llm-btn" data-story="${prefix}-another">Another statement ↻</button></span></div>`
  );
}

// Person figures: cls per figure (is-p people blue, is-m model orange,
// is-tie grey; none = an empty, light figure)
function llmFigures(classes, cls = "") {
  return `<div class="llm-figs ${cls}" aria-hidden="true">${classes.map((c) => `<i class="llm-pp${c ? ` ${c}` : ""}"></i>`).join("")}</div>`;
}

// k of n figures filled
function llmFigureRow(k, n, on, cls = "") {
  return llmFigures(Array.from({ length: n }, (_, i) => (i < k ? on : "")), cls);
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

function llmPromptHtml(text) {
  const st = esc(text);
  return (
    `<div class="llm-prompts">` +
    `<div class="llm-prompt"><span class="llm-prompt-tag">1</span><span>Consider the statement, “${st}” Do you agree with this statement? Start your answer with a “yes” or “no”.</span></div>` +
    `<div class="llm-prompt"><span class="llm-prompt-tag">2</span><span>Consider the statement, “${st}” Do you think most people would agree with this statement? Start your answer with a “yes” or “no”.</span></div></div>`
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

// "about 7 in 10"
function llmInTen(v) {
  const k = Math.round(v * 10);
  return k >= 10 ? "nearly all of them" : k <= 0 ? "almost none of them" : `about ${k} in 10`;
}

// Previous / next model in the ranking of the current view
function llmRankList(mode) {
  return [...LLM.data.models].sort((a, b) => (mode === "individual" ? a.rankCs - b.rankCs : a.rankR - b.rankR));
}

// ══ LLMs as individuals ════════════════════════════════════════════════════
// Stages, one per click of Next: 1 the model's answers to one statement;
// 2 the people who rated it; 3 both answers checked against their majority
// (chapter 1); 4 every statement checked (2); 5 the two shares combined (3);
// 6 one person and the model on one of that person's statements; 7 both
// scored on all 50 of them; 8 who scores higher; 9 every person (4).

const LLM_IND_CHAPTERS = ["One statement", "All statements", "One score", "Versus each person"];
const LLM_IND_OPEN = [0, 4, 5, 6];   // the stage that opens each chapter
const LLM_IND_LAST = 9;
// The story's first statement, chosen for the default model, Mixtral-8x22B:
// its answers are far from certain (18% and 78%) and only one of them misses
// the majority (20 of 25 people agree). The paper's example is a click away.
const LLM_IND_EXAMPLE = "One of the things you do when you sleep at night is snore.";

function llmIndNextLabel(m) {
  const d = LLM.data, I = LLM.ind;
  if (I.stage === 4 && !I.ran) return `Checking ${fmtNum(d.n_statements)} statements…`;
  return [
    `Ask ${m.name}`,
    "Show what people said",
    "Check its two answers",
    `Check all ${fmtNum(d.n_statements)} statements`,
    "Combine them into one score",
    "Compare with one person",
    "Score all 50 of their statements",
    "Who scores higher?",
    `Compare with all ${fmtNum(d.n_participants)} people`,
  ][I.stage] ?? `Next: ${m.name} as a crowd`;
}

function llmIndStepper() {
  const I = LLM.ind, m = llmModel();
  if (!m) return;
  llmStepper("individual", { stage: I.stage, total: LLM_IND_LAST, label: llmIndNextLabel(m), busy: I.stage === 4 && !I.ran, end: I.stage >= LLM_IND_LAST });
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
  if (I.ex === null) I.ex = d.statements.find((x) => x.raw === LLM_IND_EXAMPLE)?.id ?? d.examples.individual ?? llmRandomStatement();
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
  document.getElementById("llmIndFeat").innerHTML = llmIndFeaturesStep(m);
  llmIndTable(m, md);
  llmRenderBoard();
  llmRenderSize();
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
  document.getElementById("llmIndHead").innerHTML = llmStoryHead("individual", m, LLM_IND_CHAPTERS, opened);
  const chapters = [llmIndCh1, llmIndCh2, llmIndCh3, llmIndCh4];
  const story = document.getElementById("llmIndStory");
  if (only === null || !story.children.length) {
    story.innerHTML = chapters.map((f) => f(m, md, fresh)).join("");
  } else {
    for (const k of only) {
      const el = document.getElementById(`llmIndC${k}`);
      if (el) el.outerHTML = chapters[k - 1](m, md, fresh);
    }
  }
  // Chapter 2's bars: counted afresh when that click opened it, else full
  if (I.stage >= 4 && (only === null || only.includes(2))) llmIndRunStart(!I.ran && !!fresh && fresh.has("run"));
  llmIndStepper();
}

// ── 1 · One statement ──

function llmIndCh1(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, s = d.statements[I.ex], name = esc(m.name);
  const lvl = I.stage >= 3 ? I.sub : I.stage;
  const [p1, p2] = md.ratings[s.id];
  const y1 = p1 >= 0.5 ? 1 : 0, y2 = p2 >= 0.5 ? 1 : 0, maj = s.majority;
  const k = s.k_agree, half = 2 * k === s.n;
  const ans = (p, y) => lvl >= 1
    ? `<div class="llm-sv-ans${llmFresh(fresh, 1)}" data-who="${name}">${llmProbBar(p)}${llmYesNo(y)}</div>`
    : `<div class="llm-sv-ans is-blank"><span class="llm-sv-wait">?</span></div>`;
  const key = lvl >= 2 ? `<div class="llm-sv-maj${llmFresh(fresh, 2)}">${maj ? "Agree" : "Disagree"}</div>` : `<div class="llm-sv-maj is-blank"></div>`;
  const mark = (y) => lvl >= 3 ? `<div class="llm-sv-mark${llmFresh(fresh, 3)}">${llmMatch(y === maj)}</div>` : `<div class="llm-sv-mark is-blank"></div>`;
  const survey =
    `<div class="llm-survey">` +
    llmExHead(`${s.id === d.examples.individual ? "The paper's example" : "A statement"} · rated by ${fmtNum(s.n)} people`, s.id === d.examples.individual, "ind") +
    `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote>` +
    `<div class="llm-sv-grid"><div class="llm-sv-th"></div><div class="llm-sv-th">${name}</div><div class="llm-sv-th">Most people</div><div class="llm-sv-th"></div>` +
    `<div class="llm-sv-q"><span class="llm-sv-qn">1</span>Do you agree with this statement?</div>${ans(p1, y1)}${key}${mark(y1)}` +
    `<div class="llm-sv-q"><span class="llm-sv-qn">2</span>Do you think most people would agree with this statement?</div>${ans(p2, y2)}${key}${mark(y2)}` +
    `</div></div>`;

  let beats = "";
  if (lvl >= 1) {
    beats +=
      `<div class="llm-beat${llmFresh(fresh, 1)}" id="llmIndB1"><p class="llm-note">Each bar is ${name}'s probability of answering “yes”; 50% or more counts as yes.</p>` +
      `<details class="llm-details"><summary>The exact prompts</summary>${llmPromptHtml(s.raw)}</details></div>`;
  }
  if (lvl >= 2) {
    const who = k === s.n ? `All ${fmtNum(s.n)} people` : k === 0 ? `None of the ${fmtNum(s.n)} people` : `${fmtNum(k)} of the ${fmtNum(s.n)} people`;
    beats +=
      `<div class="llm-beat${llmFresh(fresh, 2)}" id="llmIndB2"><div class="llm-raters">${llmFigureRow(k, s.n, "is-p")}` +
      `<div class="llm-raters-key"><span><i class="llm-pp is-p"></i>agree</span><span><i class="llm-pp"></i>disagree</span></div></div>` +
      `<p class="llm-p">${who} who rated it agree, so <strong>most people ${maj ? "agree" : "disagree"}</strong>${half ? " (exactly half counts as most)" : ""}: the answer key for both questions.</p></div>`;
  }
  if (lvl >= 3) {
    // Each check in three sentences: the model's answer, the majority, and
    // whether they match (the scores come in chapter 2)
    const ok1 = y1 === maj, ok2 = y2 === maj;
    const most = half
      ? "Exactly half of people agree with this statement, which counts as most people agreeing."
      : `Most people ${maj ? "agree" : "disagree"} with this statement.`;
    const thus = (ok) => `Thus, there is a <strong>${ok ? "match" : "mismatch"}</strong>.`;
    beats +=
      `<div class="llm-beat${llmFresh(fresh, 3)}" id="llmIndB3"><div class="llm-checks">` +
      `<div class="llm-check ${ok1 ? "is-ok" : "is-miss"}"><div class="llm-check-q">Question 1 · its own view ${llmMatch(ok1)}</div>` +
      `<p>${name} ${y1 ? "agrees" : "disagrees"} with this statement. ${most} ${thus(ok1)}</p></div>` +
      `<div class="llm-check ${ok2 ? "is-ok" : "is-miss"}"><div class="llm-check-q">Question 2 · its prediction ${llmMatch(ok2)}</div>` +
      `<p>${name} predicts that most people would ${y2 ? "" : "not "}agree with this statement. ${most} ${thus(ok2)}</p></div></div>` +
      (I.seen.length > 1 ? llmIndTally(m, md) : "") + `</div>`;
  }
  return llmChap("llmIndC1", 1, "One statement", true, "", survey + beats);
}

// The running tally of the statements the reader has checked
function llmIndTally(m, md) {
  const d = LLM.data, seen = LLM.ind.seen;
  const rows = seen.map((id) => {
    const s = d.statements[id], [p1, p2] = md.ratings[id];
    return { s, ok1: (p1 >= 0.5 ? 1 : 0) === s.majority, ok2: (p2 >= 0.5 ? 1 : 0) === s.majority };
  });
  const c = rows.filter((r) => r.ok1).length, a = rows.filter((r) => r.ok2).length, k = rows.length;
  const shown = rows.slice(-4).reverse();
  return (
    `<div class="llm-tally"><div class="llm-tally-title">${esc(m.name)}'s scorecard so far</div>` +
    `<table class="llm-tally-table"><thead><tr><th>Statement</th><th>Own view</th><th>Prediction</th></tr></thead><tbody>` +
    shown.map((r) => `<tr><td>${esc(r.s.text)}</td><td>${llmMatch(r.ok1)}</td><td>${llmMatch(r.ok2)}</td></tr>`).join("") +
    (k > shown.length ? `<tr class="llm-tally-more"><td colspan="3">and ${llmCount(k - shown.length, "earlier statement")}</td></tr>` : "") +
    `</tbody><tfoot><tr><th>${llmCount(k, "statement")}</th><td>${c} of ${k}</td><td>${a} of ${k}</td></tr></tfoot></table></div>`
  );
}

// ── 2 · All statements ──

function llmIndCh2(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, n = d.n_statements, title = `All ${fmtNum(n)} statements`;
  if (I.stage < 4) return llmChap("llmIndC2", 2, title, false);
  const row = (label, sub, key) =>
    `<div class="llm-run-row"><div class="llm-run-label">${label}<span>${sub}</span></div>` +
    `<div class="llm-run-track" data-run="${key}"><span class="llm-run-ok"></span><span class="llm-run-miss"></span></div>` +
    `<div class="llm-run-val" data-run-val="${key}"></div></div>`;
  const body =
    `<div class="llm-run" id="llmIndRun"><div class="llm-run-ticker"><span class="llm-run-n" id="llmIndRunN"></span><span class="llm-run-stmt" id="llmIndRunStmt"></span></div>` +
    row("Question 1", "its own view", "c") + row("Question 2", "its prediction", "a") + `</div>` +
    `<div id="llmIndRunRes">${I.ran ? llmIndRunResults(m, fresh) : ""}</div>`;
  return llmChap("llmIndC2", 2, title, true, `The same two checks for every statement ${esc(m.name)} answered:`, body);
}

function llmIndRunResults(m, fresh) {
  const d = LLM.data, n = d.n_statements, name = esc(m.name);
  const q1 = m.tab.q1, q2 = m.tab.q2;
  const con = q1[0][0] + q1[1][1], awa = q2[0][0] + q2[1][1];
  const C = con / n, A = awa / n;
  return (
    `<div class="llm-beat${llmFresh(fresh, "run")}" id="llmIndB4"><div class="llm-res2">` +
    `<div class="llm-res is-agree"><div class="llm-res-k">Consensus</div><div class="llm-res-v">${fmtPct(C)}</div>` +
    `<p>The matches in question 1 for all statements give us ${name}'s consensus score: ${fmtNum(con)} of ${fmtNum(n)} match, ${llmInTen(C)}.</p></div>` +
    `<div class="llm-res is-expect"><div class="llm-res-k">Awareness</div><div class="llm-res-v">${fmtPct(A)}</div>` +
    `<p>The matches in question 2 for all statements give us ${name}'s awareness score: ${fmtNum(awa)} of ${fmtNum(n)} match, ${llmInTen(A)}.</p></div></div></div>`
  );
}

// Fills chapter 2's bars, statement by statement when animate, else at
// once. A timer (not requestAnimationFrame) drives it and always finishes.
const _llmRun = { token: 0, timer: null };
function llmIndRunStart(animate) {
  const m = llmModel(), md = LLM.md, d = LLM.data, I = LLM.ind, n = d.n_statements;
  clearInterval(_llmRun.timer);
  const token = ++_llmRun.token;
  const order = I.order || (I.order = llmShuffle(d.statements.map((s) => s.id)));
  const okC = order.map((i) => ((md.ratings[i][0] >= 0.5 ? 1 : 0) === d.statements[i].majority ? 1 : 0));
  const okA = order.map((i) => ((md.ratings[i][1] >= 0.5 ? 1 : 0) === d.statements[i].majority ? 1 : 0));
  const cum = (xs) => { const out = [0]; xs.forEach((x) => out.push(out.at(-1) + x)); return out; };
  const cc = cum(okC), ca = cum(okA);
  // The ticker shows the latest statement checked, skipping those written
  // around stand-in names
  const shown = [];
  order.forEach((i, j) => shown.push(d.statements[i].placeholder ? (j ? shown[j - 1] : -1) : j));
  const draw = (k) => {
    for (const [key, c] of [["c", cc], ["a", ca]]) {
      const track = document.querySelector(`#llmIndRun [data-run="${key}"]`);
      const val = document.querySelector(`#llmIndRun [data-run-val="${key}"]`);
      if (!track || !val) continue;
      const ok = c[k], miss = k - c[k];
      track.children[0].style.width = `${(ok / n) * 100}%`;
      track.children[1].style.width = `${(miss / n) * 100}%`;
      val.innerHTML = `<span class="is-ok">✓ ${fmtNum(ok)}</span><span class="is-miss">✗ ${fmtNum(miss)}</span>`;
    }
    const count = document.getElementById("llmIndRunN"), stmt = document.getElementById("llmIndRunStmt");
    if (count) count.textContent = `${fmtNum(k)} of ${fmtNum(n)} checked`;
    if (stmt) {
      const j = k > 0 && k < n ? shown[k - 1] : -1;
      stmt.innerHTML = j >= 0
        ? `<span class="llm-run-text">${esc(d.statements[order[j]].text)}</span> ${llmMatch(okC[j])}${llmMatch(okA[j])}`
        : "";
    }
  };
  const finish = () => {
    draw(n);
    if (I.ran) return;
    I.ran = true;
    const res = document.getElementById("llmIndRunRes");
    if (res) res.innerHTML = llmIndRunResults(m, new Set(["run"]));
    llmIndStepper();
    if (animate) llmRevealEl(document.getElementById("llmIndB4"), false, document.getElementById("llmIndC2"));
  };
  if (!animate || llmReduced()) { finish(); return; }
  const t0 = Date.now(), dur = 2400;
  draw(0);
  _llmRun.timer = setInterval(() => {
    if (token !== _llmRun.token) { clearInterval(_llmRun.timer); return; }
    const p = Math.min(1, (Date.now() - t0) / dur);
    draw(Math.round((1 - (1 - p) ** 2) * n));
    if (p >= 1) { clearInterval(_llmRun.timer); finish(); }
  }, 40);
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

// ── 3 · One score ──

function llmIndCh3(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, n = d.n_statements, name = esc(m.name), title = "One score";
  if (I.stage < 5) return llmChap("llmIndC3", 3, title, false);
  const q1 = m.tab.q1, q2 = m.tab.q2;
  const C = (q1[0][0] + q1[1][1]) / n, A = (q2[0][0] + q2[1][1]) / n, M = Math.sqrt(C * A);
  const body =
    `<div class="llm-lvl-grid${llmFresh(fresh, 5)}" id="llmIndB5"><div>` +
    `<div class="llm-calc"><div class="llm-calc-line">Commonsensicality = ${sqrtHtml("consensus × awareness")}</div>` +
    `<div class="llm-calc-line">= ${sqrtHtml(`${fmtPct(C)} × ${fmtPct(A)}`)}</div>` +
    `<div class="llm-calc-line is-big">= <strong class="llm-calc-res">${fmtPct(M)}</strong></div></div>` +
    `<p class="llm-p">Each curve joins the pairs with the same score; ${name} sits on the orange one.</p>` +
    `<p class="llm-note">Point at the chart to score any pair; click a grey dot to switch models.</p>` +
    `<div class="llm-result">For comparison, the median person scores <strong>${fmtPct(d.humanMedian)}</strong> on the 50 statements they rated.</div></div>` +
    `<figure class="llm-lvl">${llmLvlSvg(m)}</figure></div>`;
  return llmChap("llmIndC3", 3, title, true, "", body);
}

// Consensus (x) by awareness (y), shaded by commonsensicality, with level
// curves every 10 points (as the paper's Fig. 2B draws them at 25, 50 and
// 75%), this model's own level curve in orange, and every model as a dot.
// The axes start at 30%, below every model, so the dots spread out. The
// shading is a small canvas drawn once; pointing at the chart shows the
// score of that pair (llmLvlProbe).
const LLM_LVL = { S: 320, L: 58, T: 12, R: 44, B: 48, LO: 0.3 };
let _llmLvlBg = null;
function llmLvlBg() {
  if (_llmLvlBg) return _llmLvlBg;
  const N = 120, LO = LLM_LVL.LO, cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(N, N);
  const lo = [255, 253, 249], hi = [140, 175, 224];   // the card surface to people's blue
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const xv = LO + (1 - LO) * ((i + 0.5) / N), yv = LO + (1 - LO) * (1 - (j + 0.5) / N);
      const t = (Math.sqrt(xv * yv) - LO) / (1 - LO), k = 4 * (j * N + i);
      for (let ch = 0; ch < 3; ch++) img.data[k + ch] = Math.round(lo[ch] + (hi[ch] - lo[ch]) * t);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return (_llmLvlBg = cv.toDataURL());
}

function llmLvlSvg(m) {
  const d = LLM.data, { S, L, T, R, B, LO } = LLM_LVL, W = L + S + R, H = T + S + B;
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
  // is the label's extent (about 7.5 units a character), to keep the grey
  // labels clear of the model's.
  const place = (c, text) => {
    const w = 7.5 * text.length;
    if (c * c >= LO) { const ty = y(c * c) + 4; return { tx: x(1) + 5, ty, anchor: "start", in: false, box: [x(1) + 5, x(1) + 5 + w, ty - 11, ty + 2] }; }
    const cx = x((c * c) / LO), ty = y(LO) - 6;
    return cx < L + 48
      ? { tx: cx + 4, ty, anchor: "start", in: true, box: [cx + 4, cx + 4 + w, ty - 11, ty + 2] }
      : { tx: cx - 4, ty, anchor: "end", in: true, box: [cx - 4 - w, cx - 4, ty - 11, ty + 2] };
  };
  const label = (c, text, cls) => {
    const p = place(c, text);
    return `<text x="${p.tx.toFixed(1)}" y="${p.ty.toFixed(1)}"${p.anchor === "end" ? ' text-anchor="end"' : ""} class="llm-lvl-clab${p.in ? " is-in" : ""} ${cls}">${text}</text>`;
  };
  const M = m.commonsensicality;
  const mBox = place(M, fmtPct(M)).box;
  const levels = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const clear = (c) => {  // its label clear of the model's
    const b = place(c, `${Math.round(c * 100)}%`).box;
    return M < LO || b[1] + 3 < mBox[0] || mBox[1] + 3 < b[0] || b[3] + 1 < mBox[2] || mBox[3] + 1 < b[2];
  };
  const ticks = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const inside = (v) => Math.min(1, Math.max(LO, v));
  const others = d.models.filter((o) => o.id !== m.id);
  const dot = (o) => `<circle class="llm-lvl-dot" cx="${x(inside(o.consensus)).toFixed(1)}" cy="${y(inside(o.awareness)).toFixed(1)}" r="4" data-lvl-model="${esc(o.id)}"><title>${esc(o.name)}: consensus ${fmtPct(o.consensus)}, awareness ${fmtPct(o.awareness)} → ${fmtPct(o.commonsensicality)}</title></circle>`;
  const px = x(inside(m.consensus)), py = y(inside(m.awareness)), left = px > L + S * 0.5;
  return (
    `<svg class="llm-lvl-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${m.name} at consensus ${fmtPct(m.consensus)} and awareness ${fmtPct(m.awareness)}, on the curve of commonsensicality ${fmtPct(M)}`)}" data-lvl="${L},${T},${S},${LO}">` +
    `<image href="${llmLvlBg()}" x="${L}" y="${T}" width="${S}" height="${S}" preserveAspectRatio="none"/>` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-lvl-frame"/>` +
    ticks.map((t) => `<text x="${x(t)}" y="${T + S + 18}" text-anchor="middle" class="llm-lvl-tick">${Math.round(t * 100)}%</text>` +
      `<text x="${L - 7}" y="${y(t) + 4}" text-anchor="end" class="llm-lvl-tick">${Math.round(t * 100)}%</text>`).join("") +
    `<text x="${L + S / 2}" y="${H - 4}" text-anchor="middle" class="llm-lvl-axis is-agree">Consensus</text>` +
    `<text x="13" y="${T + S / 2}" text-anchor="middle" transform="rotate(-90 13 ${T + S / 2})" class="llm-lvl-axis is-expect">Awareness</text>` +
    levels.map((c) => `<path d="${curve(c)}" class="llm-lvl-curve"/>` + (clear(c) ? label(c, `${Math.round(c * 100)}%`, "") : "")).join("") +
    (M >= LO ? `<path d="${curve(M)}" class="llm-lvl-curve is-model"/>` + label(M, fmtPct(M), "is-model") : "") +
    others.map(dot).join("") +
    `<circle class="llm-lvl-dot is-sel" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7.5"/>` +
    `<text x="${(left ? px - 12 : px + 12).toFixed(1)}" y="${(py + 20 > T + S - 24 ? py - 12 : py + 20).toFixed(1)}" text-anchor="${left ? "end" : "start"}" class="llm-lvl-name">${esc(m.name)}</text>` +
    `<g class="llm-lvl-probe" style="display:none"><line class="llm-lvl-guide" data-g="x"/><line class="llm-lvl-guide" data-g="y"/><circle r="4" class="llm-lvl-pt"/>` +
    `<rect class="llm-lvl-tipbox" rx="5"/><text class="llm-lvl-tip"><tspan data-t="arg"></tspan><tspan data-t="rest"></tspan></text><path class="llm-lvl-rad"/></g>` +
    `</svg>`
  );
}

// Pointing at the level-curve chart: the score of the pair under the pointer
function llmLvlProbe(e) {
  const svg = e.target.closest(".llm-lvl-svg");
  if (!svg) return;
  const [L, T, S, LO] = svg.dataset.lvl.split(",").map(Number);
  const box = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
  const sx = ((e.clientX - box.left) / box.width) * vb.width, sy = ((e.clientY - box.top) / box.height) * vb.height;
  const g = svg.querySelector(".llm-lvl-probe");
  const fx = (sx - L) / S, fy = (T + S - sy) / S;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1 || e.target.closest(".llm-lvl-dot")) { g.style.display = "none"; return; }
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

// ── 4 · Versus each person ──
// Four clicks: one of the person's statements, answered by both (6); both
// scored on all 50 of the person's statements (7); who scores higher (8);
// the same comparison with every person (9)

// The person's statement to show first: one without stand-in names, and
// not from a campaign email or the news where the person has others, on
// which the person and the model differ on exactly one of the two checks,
// the shortest such; else the shortest of those
const LLM_POLITICAL_SOURCES = ["campaign email", "news media"];
function llmIndPersonExample(rows) {
  const plain = rows.filter((r) => !r.s.placeholder);
  const calm = plain.filter((r) => !LLM_POLITICAL_SOURCES.includes(r.s.source));
  const ok = calm.length ? calm : plain;
  const pool = ok.filter((r) => (r.pOk1 !== r.mOk1) + (r.pOk2 !== r.mOk2) === 1);
  return [...(pool.length ? pool : ok.length ? ok : rows)].sort((a, b) => a.s.text.length - b.s.text.length || a.s.id - b.s.id)[0].s.id;
}

function llmIndCh4(m, md, fresh) {
  const d = LLM.data, I = LLM.ind, P = d.n_participants, name = esc(m.name), title = "Versus each person";
  if (I.stage < 6) return llmChap("llmIndC4", 4, title, false);
  const lead = `Here we compare ${name} with every human individual, side by side. Since each person rated only 50 statements, chosen at random, we also limit ${name}'s ratings to these 50 statements.`;
  const pr = I.personRatings;
  if (!pr || pr.id !== I.person) return llmChap("llmIndC4", 4, title, true, lead, '<div class="empty-row">Loading…</div>');
  const rows = pr.ratings.map(([sid, ia, oa]) => {
    const s = d.statements[sid], [p1, p2] = md.ratings[sid];
    const y1 = p1 >= 0.5 ? 1 : 0, y2 = p2 >= 0.5 ? 1 : 0;
    return { s, ia, oa, p1, p2, y1, y2, pOk1: ia === s.majority, pOk2: oa === s.majority, mOk1: y1 === s.majority, mOk2: y2 === s.majority };
  });
  if (I.pex === null || !rows.some((r) => r.s.id === I.pex)) I.pex = llmIndPersonExample(rows);
  const ex = rows.find((r) => r.s.id === I.pex), k = rows.length, person = `Person #${pr.id}`;

  // 6 · one statement: what the person said, what the model said, and the majority
  const s = ex.s, kAgree = s.k_agree;
  const cell = (y, maj, p) => `<div class="llm-vs-ans">${answerPill(y, maj)}${p === undefined ? "" : `<span class="llm-ans-p">${llmProbFine(p)}</span>`}</div>`;
  const majCell = `<div class="llm-vs-maj">${s.majority ? "Agree" : "Disagree"}<span>${fmtNum(s.majority ? kAgree : s.n - kAgree)} of ${fmtNum(s.n)}</span></div>`;
  const nOk = (a, b) => (a && b ? "both questions" : a || b ? "one question" : "neither question");
  const sameP = ex.pOk1 + ex.pOk2 === ex.mOk1 + ex.mOk2;
  let body =
    `<div class="llm-survey${llmFresh(fresh, 6)}" id="llmIndB6">` +
    `<div class="llm-ex-head"><span class="llm-ex-kicker">${person} · one of their ${k} statements</span><span class="llm-ex-btns">` +
    `<button type="button" class="llm-btn" data-story="ind-pstmt">Another of their statements ↻</button>` +
    `<button type="button" class="llm-btn" data-story="ind-person">Another person ↻</button></span></div>` +
    `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote>` +
    `<div class="llm-vs-grid"><div class="llm-sv-th"></div><div class="llm-sv-th is-people">${person}</div><div class="llm-sv-th is-model">${name}</div><div class="llm-sv-th">Most people</div>` +
    `<div class="llm-sv-q"><span class="llm-sv-qn">1</span>Do you agree with this statement?</div>` +
    `<div class="llm-vs-who" data-who="${person}">${cell(ex.ia, s.majority)}</div><div class="llm-vs-who" data-who="${name}">${cell(ex.y1, s.majority, ex.p1)}</div>${majCell}` +
    `<div class="llm-sv-q"><span class="llm-sv-qn">2</span>Do you think most people would agree with this statement?</div>` +
    `<div class="llm-vs-who" data-who="${person}">${cell(ex.oa, s.majority)}</div><div class="llm-vs-who" data-who="${name}">${cell(ex.y2, s.majority, ex.p2)}</div>${majCell}` +
    `</div>` +
    `<p class="llm-p">On this statement, ${person} matches the majority on <strong>${nOk(ex.pOk1, ex.pOk2)}</strong> and ${name} on <strong>${nOk(ex.mOk1, ex.mOk2)}</strong>` +
    `${sameP ? "." : `, so ${ex.pOk1 + ex.pOk2 > ex.mOk1 + ex.mOk2 ? "the person" : name} is ahead here.`}</p></div>`;

  // 7 · all 50: the same checks, as strips of squares, and the two scores
  const count = (key) => rows.filter((r) => r[key]).length;
  const pc = count("pOk1"), pa = count("pOk2"), mc = count("mOk1"), ma = count("mOk2");
  const ps = Math.sqrt((pc / k) * (pa / k)), ms = Math.sqrt((mc / k) * (ma / k));
  if (I.stage >= 7) {
    const yn = (v) => (v ? "yes" : "no");
    const strip = (key, w, q) =>
      `<div class="llm-strip">${rows.map((r) => {
        const said = w === "p" ? (q === 1 ? r.ia : r.oa) : (q === 1 ? r.y1 : r.y2);
        return `<span class="${r[key] ? "is-ok" : "is-miss"}${r.s.id === I.pex ? " is-ex" : ""}" title="${esc(`${r.s.text}\n${w === "p" ? person : m.name} said ${yn(said)}; most people ${r.s.majority ? "agree" : "disagree"}`)}"></span>`;
      }).join("")}</div>`;
    const who = (label, cls, c, a, sc, w) =>
      `<div class="llm-h2h-who ${cls}">${label}</div>` +
      `<div class="llm-h2h-q">Own view</div>${strip(`${w}Ok1`, w, 1)}<div class="llm-h2h-n">${c} ✓</div>` +
      `<div class="llm-h2h-q">Prediction</div>${strip(`${w}Ok2`, w, 2)}<div class="llm-h2h-n">${a} ✓</div>` +
      `<div class="llm-h2h-score">Consensus ${c}/${k} = ${fmtPct(c / k)} · awareness ${a}/${k} = ${fmtPct(a / k)} · commonsensicality ${sqrtHtml(`${fmtPct(c / k)} × ${fmtPct(a / k)}`)} = <strong>${fmtPct(sc)}</strong></div>`;
    body +=
      `<div class="llm-beat${llmFresh(fresh, 7)}" id="llmIndB7"><div class="llm-h2h">` +
      `<div class="llm-h2h-axis">Each square is one of the ${k} statements: green matches most people, red doesn't. The outlined one is the statement above.</div>` +
      `<div class="llm-h2h-grid">${who(person, "is-people", pc, pa, ps, "p")}${who(name, "is-model", mc, ma, ms, "m")}</div>` +
      `<div class="llm-inline-btns"><button type="button" class="llm-btn" data-part-open="${pr.id}">See all of ${person}'s answers</button></div></div></div>`;
  }

  // 8 · who scores higher on these 50 statements
  if (I.stage >= 8) {
    const verdict = mc * ma > pc * pa
      ? `<strong>${name} scores higher</strong> on ${person}'s ${k} statements, ${fmtPct(ms)} to ${fmtPct(ps)}.`
      : mc * ma === pc * pa
        ? `<strong>A tie:</strong> both score ${fmtPct(ps)} on ${person}'s ${k} statements.`
        : `<strong>${person} scores higher</strong> on their own ${k} statements, ${fmtPct(ps)} to ${fmtPct(ms)}.`;
    body +=
      `<div class="llm-beat${llmFresh(fresh, 8)}" id="llmIndB8"><div class="llm-verdict">` +
      `<div class="llm-verdict-row is-people"><span>${person}</span>${llmTrack(ps, LLM_PCT_SCALE, "is-human")}<strong>${fmtPct(ps)}</strong></div>` +
      `<div class="llm-verdict-row"><span>${name}</span>${llmTrack(ms, LLM_PCT_SCALE, llmModelCls(m))}<strong>${fmtPct(ms)}</strong></div>` +
      `<div class="llm-verdict-axis"><span></span>${llmAxis(LLM_PCT_SCALE)}<span></span></div></div>` +
      `<div class="llm-result">${verdict}</div></div>`;
  }

  // 9 · every person, each on their own 50 statements
  if (I.stage >= 9) {
    const h = md.head;
    const [w, t, l] = llmRoundTo([h.wins, h.ties, h.losses]);
    const figs = [...Array(w).fill("is-m"), ...Array(t).fill("is-tie"), ...Array(l).fill("is-p")];
    body +=
      `<div class="llm-beat${llmFresh(fresh, 9)}" id="llmIndB9">` +
      `<p class="llm-p">Now the same comparison with each of the ${fmtNum(P)} people, every time on that person's own 50 statements.</p>` +
      `<div class="llm-hundred-wrap llm-gap-top">` +
      `<div><div class="llm-mini-title">Every person, as 100 figures (each about ${Math.round(P / 100)} people)</div>${llmFigures(figs, "is-hundred")}` +
      `<div class="llm-raters-key">${w ? `<span><i class="llm-pp is-m"></i>${name} scores higher: ${w}</span>` : ""}${t ? `<span><i class="llm-pp is-tie"></i>tie: ${t}</span>` : ""}${l ? `<span><i class="llm-pp is-p"></i>the person scores higher: ${l}</span>` : ""}</div></div>` +
      `<p class="llm-p">${name} scores higher than <strong>${fmtNum(h.wins)} of the ${fmtNum(P)} people (${llmPctFine(h.wins / P)})</strong>, ties with ${fmtNum(h.ties)} and scores lower than ${fmtNum(h.losses)}.</p></div></div>`;
  }
  return llmChap("llmIndC4", 4, title, true, lead, body);
}

// ── Story controls ──

const _llmSub = { timers: [] };
function llmIndCancelReplay() {
  const I = LLM.ind;
  _llmSub.timers.forEach(clearTimeout);
  _llmSub.timers = [];
  if (I.sub < 3) { I.sub = 3; if (I.stage >= 3) llmIndSeen(I.ex); }
}

function llmIndNext() {
  const I = LLM.ind, m = llmModel();
  if (!LLM.md || !m) return;
  if (I.stage === 4 && !I.ran) return;            // still counting
  if (I.stage >= LLM_IND_LAST) { llmShowView("population"); return; }
  const wasReplaying = I.sub < 3;
  llmIndCancelReplay();
  I.stage++;
  if (I.stage === 3) llmIndSeen(I.ex);
  const fresh = new Set([I.stage]);
  if (I.stage === 4) fresh.add("run");
  const ch = LLM_IND_OPEN.filter((s) => I.stage >= s).length;
  llmIndPaint(fresh, [...new Set([ch, ...(wasReplaying ? [1] : [])])]);
  if (LLM_IND_OPEN.includes(I.stage)) document.getElementById(`llmIndC${ch}`)?.classList.add("llm-in");
  // The chapter card the click added to goes to the top of the panel, and
  // stays there for the chapter's later steps
  llmRevealEl(document.getElementById(`llmIndC${ch}`), true);
}

function llmIndAction(action) {
  const d = LLM.data, I = LLM.ind;
  if (!LLM.md) return;
  if (action === "ind-another" || action === "ind-paper") {
    I.ex = action === "ind-paper" ? d.examples.individual : llmRandomStatement(I.ex);
    llmIndReplay();
  } else if (action === "ind-person") {
    I.person = llmIndRandomPerson(I.person);
    I.pex = null;
    llmIndLoadPerson().then(() => llmIndPaint(new Set([6]), [4]))
      .catch((err) => console.error("LLM participant load failed:", err));
  } else if (action === "ind-pstmt" && I.personRatings) {
    const pool = I.personRatings.ratings.map((r) => r[0]).filter((id) => id !== I.pex && !d.statements[id].placeholder);
    if (pool.length) I.pex = pool[Math.floor(Math.random() * pool.length)];
    llmIndPaint(new Set([6]), [4]);
  }
}

// After the answers have been checked once, a new statement replays chapter
// 1's three reveals, a moment apart
function llmIndReplay() {
  const I = LLM.ind;
  llmIndCancelReplay();
  if (I.stage < 3) { llmIndPaint(null, [1]); return; }
  if (llmReduced()) { llmIndSeen(I.ex); llmIndPaint(new Set([3]), [1]); return; }
  I.sub = 0;
  llmIndPaint(null, [1]);
  [1, 2, 3].forEach((lvl) => _llmSub.timers.push(setTimeout(() => {
    I.sub = lvl;
    if (lvl === 3) llmIndSeen(I.ex);
    llmIndPaint(new Set([lvl]), [1]);
  }, lvl * 650)));
}

function llmIndSeen(id) {
  const seen = LLM.ind.seen;
  if (seen.at(-1) !== id) seen.push(id);
}

// Opens the story up to stage (the chapter links and "Show all steps")
function llmIndOpenTo(stage) {
  const I = LLM.ind;
  llmIndCancelReplay();
  if (stage <= I.stage) return;
  I.stage = stage;
  if (stage >= 3) llmIndSeen(I.ex);
  if (stage > 4) I.ran = true;
  llmIndPaint(new Set(stage === 4 ? ["run"] : []));
}

// Where the model does better: its score on each side of each feature
function llmIndFeaturesStep(m) {
  const d = LLM.data;
  if (!m.by_feature) return "";
  const rows = d.properties.map((key, j) => {
    const sides = llmFeatureSides(j);
    const [a, b] = m.by_feature[key];
    const def = PROP_DEFS.find((p) => p.key === key);
    return (
      `<div class="llm-bf-pair"><div class="llm-bf-row" title="${esc(def.def1)}"><span>${esc(sides[0])}</span>${llmTrack(a, LLM_PCT_SCALE, llmModelCls(m), [{ x: m.commonsensicality }])}<strong>${fmtPct(a)}</strong></div>` +
      `<div class="llm-bf-row" title="${esc(def.def0)}"><span>${esc(sides[1])}</span>${llmTrack(b, LLM_PCT_SCALE, llmModelCls(m), [{ x: m.commonsensicality }])}<strong>${fmtPct(b)}</strong></div></div>`
    );
  }).join("");
  const gaps = d.properties.map((key, j) => ({ j, g: m.by_feature[key][0] - m.by_feature[key][1] }));
  const big = [...gaps].sort((a, b) => Math.abs(b.g) - Math.abs(a.g))[0];
  const sides = llmFeatureSides(big.j);
  const better = (x, key) => x.by_feature[key][0] > x.by_feature[key][1];
  const factOk = better(m, "fact"), physOk = better(m, "physical");
  const nBoth = d.models.filter((x) => better(x, "fact") && better(x, "physical")).length;
  return (
    `<div class="llm-step-head"><span class="llm-step-num is-feat">+</span><div><h3 class="llm-step-title">Which kinds of statements ${esc(m.name)} gets right</h3>` +
    `<p class="llm-step-lead">Its commonsensicality on the statements on each side of each feature. The thin line marks its overall ${fmtPct(m.commonsensicality)}.</p></div></div>` +
    `<div class="llm-step-body"><div class="llm-bf">${rows}</div>` +
    `<p class="llm-p">${esc(m.name)}'s biggest gap is between ${esc(sides[0].toLowerCase())} (${fmtPct(m.by_feature[d.properties[big.j]][0])}) and ${esc(sides[1].toLowerCase())} statements (${fmtPct(m.by_feature[d.properties[big.j]][1])}). ` +
    `${factOk && physOk ? `Like ${nBoth} of the ${d.models.length} models, it does better on facts and on statements about the physical world.` : `${nBoth} of the ${d.models.length} models do better on facts and on statements about the physical world${factOk || physOk ? `; ${esc(m.name)} does on ${factOk ? "facts" : "physical-world statements"} only` : `, but ${esc(m.name)} does not`}.`}</p></div>`
  );
}

const LLM_IND_SHOW = [
  ["", "All statements", () => true],
  ["miss", "Misses the majority on either question", (r) => !r.ownOk || !r.othersOk],
  ["own", "Own answer differs from the majority", (r) => !r.ownOk],
  ["others", "Misjudges what most people think", (r) => !r.othersOk],
  ["both", "Matches the majority on both", (r) => r.ownOk && r.othersOk],
];

function llmIndTable(m, md) {
  const d = LLM.data;
  document.getElementById("llmIndTableTitle").textContent = `Every answer ${m.name} gave`;
  LLM.indRows = d.statements.map((s, i) => {
    const [ia, oa] = md.ratings[i];
    const y1 = ia >= 0.5 ? 1 : 0, y2 = oa >= 0.5 ? 1 : 0;
    return { ...s, ia, oa, y1, y2, ownOk: y1 === s.majority, othersOk: y2 === s.majority, strength: Math.abs(s.I_agree - 0.5) };
  });
  if (!LLM.tables.ind) {
    LLM.tables.ind = llmTable(document.getElementById("llmIndTable"), {
      noun: "statements",
      rows: () => LLM.indRows,
      search: llmStatementSearch,
      selects: llmStatementSelects(LLM_IND_SHOW),
      props: true,
      sort: { key: "strength", dir: "desc" },
      onRow: (r) => llmOpenStatement(r.id),
      columns: [
        { key: "text", label: "Statement", cls: "col-statement", tdCls: "td-statement", value: (r) => r.text, html: (r) => esc(r.text) },
        { key: "strength", label: "People agree", cls: "llm-col-people", value: (r) => r.strength,
          html: (r) => `<span class="llm-maj"><span class="llm-maj-share">${fmtPct(r.I_agree)}</span> <span class="llm-maj-word">majority ${r.majority ? "agrees" : "disagrees"}</span></span>`,
          helpLabel: "People agree", help: "The share of the people who rated the statement and agreed with it. The majority answer is what the model is scored against. Sorting puts the clearest majorities first." },
        { key: "ia", label: () => `${esc(llmModel().name)}: agrees?`, cls: "llm-col-ans", value: (r) => r.ia,
          html: (r) => `${answerPill(r.y1, r.majority)}<span class="llm-ans-p">${llmProbFine(r.ia)}</span>`,
          helpLabel: "Agrees?", help: "The model's answer to “Do you agree with this statement?”: yes at 50% or more. Green when it matches the people's majority, which is what consensus counts." },
        { key: "oa", label: () => `${esc(llmModel().name)}: most would agree?`, cls: "llm-col-ans", value: (r) => r.oa,
          html: (r) => `${answerPill(r.y2, r.majority)}<span class="llm-ans-p">${llmProbFine(r.oa)}</span>`,
          helpLabel: "Most would agree?", help: "The model's answer to “Do you think most people would agree with this statement?”. Green when it matches the people's majority, which is what awareness counts." },
      ],
    });
  }
  if (!LLM.tables.ind.started) {
    LLM.tables.ind.started = true;
    LLM.tables.ind.setSelect("show", "miss");  // open on the clearest misses
  } else {
    LLM.tables.ind.refresh(true);
  }
}

// ══ LLMs as populations ════════════════════════════════════════════════════
// Stages, one per click of Next: 1 the model's population next to the real
// raters of one statement (chapter 1); 2 the statement scored in each
// population (2); 3 every statement scored in both, counted statement by
// statement; 4 one statement as a point on a scatter plot of the two scores;
// 5 every statement; 6 the best-fit line and r (3); 7 one statement in two
// random halves of people; 8 every statement in each half, plotted, and the
// halves' r; 9 r over many random splits, the split-half reliability (4);
// 10 the verdict (5). Stages 3, 5 and 8 animate when a click reveals them
// (on a timer, as chapter 2 of the individual story does), and Next waits
// for them to finish.

const LLM_POP_CHAPTERS = ["A crowd", "One statement, two scores", "All statements", "Setting up a baseline for correlation", "The verdict"];
const LLM_POP_OPEN = [0, 2, 3, 7, 10];   // the stage that opens each chapter
const LLM_POP_LAST = 10;
// Chapter 3's count sorts each population's statements into these score bands
const LLM_POP_BAND_LABELS = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];

function llmPopBand(v) {
  return Math.min(4, Math.max(0, Math.floor(v * 5 + 1e-9)));
}

// Next waits while a split loads and while an animation runs
function llmPopBusy() {
  const Q = LLM.pop;
  return Q.busy || Q.anim !== null || (Q.stage === 3 && !Q.ran);
}

function llmPopNextLabel(m) {
  const Q = LLM.pop, n = fmtNum(LLM.data.n_statements);
  if (Q.stage === 3 && !Q.ran) return `Scoring ${n} statements…`;
  if (Q.anim !== null) return "Plotting…";
  return [
    `Meet ${m.name}'s population`,
    "Score the statement in each population",
    `Score all ${n} statements`,
    "Plot one statement",
    `Plot all ${n} statements`,
    "Draw the best-fit line",
    "Set up a baseline",
    "Score every statement in each half",
    "Try many random splits",
    "See the verdict",
  ][Q.stage] ?? "Back to the overview";
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
  if (Q.ex === null) Q.ex = d.examples.population ?? llmRandomStatement();
  let md;
  try {
    md = await llmGet(`/llm-evals/model?id=${encodeURIComponent(m.id)}`);
    if (Q.stage >= 7 && !llmPopSplitReady()) await llmPopLoadSplit();
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
  llmPopTable(m);
  llmRenderRBars();
  llmRenderCertainty();
  if (m.features) LLM.featModel = m.id;   // the features card follows the story's model
  llmRenderFeatures();
  llmRevealPending();
}

// The order chapter 3 scores and plots the statements in (fixed, as in the
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

// The story's header lead, with the model's answer to the chapters' statement
function llmPopLead(m, md) {
  const s = LLM.data.statements[LLM.pop.ex], p = llmProbFine(md.ratings[s.id][0]), name = esc(m.name);
  return (
    `${name} outputs a probability for each of its answers. For example, it agrees with the statement “${esc(s.text)}” with probability <strong>${p}</strong>. ` +
    `Here, we consider this model not as an individual but as a generator of a human-like population. In this population, <strong>${p}</strong> agree with the statement. ` +
    `How should we compare this LLM-generated population with real humans?`
  );
}

// Redraws the header, the chapters (all, or those in only) and the stepper;
// fresh holds what the latest click revealed: stage numbers, "ex" for a new
// statement and "split" for a new split
function llmPopPaint(fresh, only = null) {
  const m = llmModel(), md = LLM.md, Q = LLM.pop;
  if (!m || !md || md.id !== m.id || !LLM.popRows) return;
  llmPopAnimStop();
  const opened = LLM_POP_OPEN.filter((s) => Q.stage >= s).length;
  document.getElementById("llmPopHead").innerHTML = llmStoryHead("population", m, LLM_POP_CHAPTERS, opened, llmPopLead(m, md));
  const chapters = [llmPopCh1, llmPopCh2, llmPopCh3, llmPopCh4, llmPopCh5];
  const story = document.getElementById("llmPopStory");
  const all = only === null || !story.children.length;
  const which = all ? [1, 2, 3, 4, 5] : only;
  if (all) story.innerHTML = chapters.map((f) => f(m, md, fresh)).join("");
  else for (const k of only) {
    const el = document.getElementById(`llmPopC${k}`);
    if (el) el.outerHTML = chapters[k - 1](m, md, fresh);
  }
  const has = (k) => !!fresh && fresh.has(k);
  // Chapter 3's count: run when that click opened it, else drawn full
  if (which.includes(3) && Q.stage >= 3) llmPopRunStart(!Q.ran && has(3));
  if (which.includes(3) && Q.stage >= 5 && has(5)) llmSctAnimate("llmPopSctSvg", 5);
  if (which.includes(4) && Q.stage >= 8 && has(8) && llmPopSplitReady()) llmSctAnimate("llmPopHalvesSvg", 8);
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

// ── 1 · A crowd ──

function llmPopCh1(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, s = d.statements[Q.ex], name = esc(m.name);
  const [p1, p2] = md.ratings[s.id];
  const ofN = (k, did) => `Of the ${fmtNum(s.n)} who rated this statement, ${fmtNum(k)}, or <strong>${fmtPct(k / s.n)}</strong>, ${did}.`;
  const per100 = (p, does) => {
    const k = Math.round(p * 100), about = Math.abs(p * 100 - k) >= 0.05 ? "about " : "";
    return `In ${name}'s population, for every 100 members, ${about}${k}, or <strong>${llmProbFine(p)}</strong>, ${does}.`;
  };
  const people =
    `<div class="llm-crowd-col is-people"><div class="llm-crowd-who">Real people<span>the ${fmtNum(s.n)} who rated it</span></div>` +
    `<div class="llm-crowd-q">Agree</div>${llmFigureRow(s.k_agree, s.n, "is-p", "is-grid")}<div class="llm-crowd-share">${ofN(s.k_agree, "agreed with it")}</div>` +
    `<div class="llm-crowd-q">Think most people would agree</div>${llmFigureRow(s.k_others, s.n, "is-p", "is-grid")}<div class="llm-crowd-share">${ofN(s.k_others, "thought most people would agree with it")}</div></div>`;
  const pop = Q.stage >= 1
    ? `<div class="llm-crowd-col is-model${llmFresh(fresh, 1)}" id="llmPopB1"><div class="llm-crowd-who">${name}'s population<span>per 100 members</span></div>` +
      `<div class="llm-crowd-q">Agree</div>${llmFigureRow(Math.round(p1 * 100), 100, "is-m", "is-grid")}<div class="llm-crowd-share">${per100(p1, "agree with this statement")}</div>` +
      `<div class="llm-crowd-q">Think most people would agree</div>${llmFigureRow(Math.round(p2 * 100), 100, "is-m", "is-grid")}<div class="llm-crowd-share">${per100(p2, "think most people would agree with this statement")}</div></div>`
    : `<div class="llm-crowd-col is-model is-blank"><div class="llm-crowd-who">${name}'s population</div><div class="llm-sv-wait">?</div></div>`;
  const body =
    `<div class="llm-survey">${llmExHead(`${s.id === d.examples.population ? "The paper's example" : "A statement"} · rated by ${fmtNum(s.n)} people`, s.id === d.examples.population, "pop")}` +
    `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote><div class="llm-crowd-cols">${people}${pop}</div></div>`;
  return llmChap("llmPopC1", 1, "A crowd", true, "", body);
}

// ── 2 · One statement, two scores ──

// The statement's score among its raters (h) and in the model's population (c)
function llmPopExScores(md) {
  const s = LLM.data.statements[LLM.pop.ex], [p1, p2] = md.ratings[s.id];
  return { s, p1, p2, h: llmCrowdScore(s.k_agree / s.n, s.k_others / s.n), c: llmCrowdScore(p1, p2) };
}

function llmPopCh2(m, md, fresh) {
  const Q = LLM.pop, name = esc(m.name), title = "One statement, two scores";
  if (Q.stage < 2) return llmChap("llmPopC2", 2, title, false);
  const { s, p1, p2, h, c } = llmPopExScores(md);
  const pa = s.k_agree / s.n;
  const step = (label, cls, calc, v, bar) =>
    `<div class="llm-ps-step"><div class="llm-ps-k${cls ? ` ${cls}` : ""}">${label}</div>` +
    `<div class="llm-sc-calc">${calc} = <strong>${llmPctFine(v)}</strong></div>${llmTrack(v, LLM_PCT_SCALE, bar)}</div>`;
  const most = (x, share) => (share === 0.5 ? "Exactly half agree, which counts as most" : x.maj ? "Most agree" : "Most disagree");
  const pred = (x) => (x.maj ? "that most would agree" : "that most would not agree");
  const col = (cls, who, sub, x, share, predicted, bar) =>
    `<div class="llm-crowd-col ${cls}"><div class="llm-crowd-who">${who}<span>${sub}</span></div>` +
    step("Consensus", "is-agree", `2 × |${llmPct2(share)} − 50%|`, x.c, bar) +
    step("Awareness", "is-expect", `${most(x, share)}, and ${predicted} predicted ${pred(x)}`, x.a, bar) +
    step("Commonsensicality", "", sqrtHtml(`${fmtPct(x.c)} × ${fmtPct(x.a)}`), x.s, bar) + `</div>`;
  const kPred = h.maj ? s.k_others : s.n - s.k_others;
  const cols =
    `<div class="llm-survey${llmFresh(fresh, 2)}${llmFresh(fresh, "ex")}" id="llmPopB2"><div class="llm-ex-head"><span class="llm-ex-kicker">The same statement</span></div>` +
    `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote><div class="llm-crowd-cols">` +
    col("is-people", "Real people", `the ${fmtNum(s.n)} who rated it`, h, pa, `${fmtNum(kPred)} of ${fmtNum(s.n)}`, "is-human") +
    col("is-model", `${name}'s population`, "per 100 members", c, p1, llmProbFine(c.maj ? p2 : 1 - p2), "is-open") +
    `</div></div>`;
  const zero = [h.c === 0 ? "real people" : "", c.c === 0 ? `${name}'s population` : ""].filter(Boolean);
  const notes = [
    zero.length ? `An even split is no common view, so ${zero.join(" and ")} ${zero.length > 1 ? "give" : "gives"} it 0.` : "",
    h.maj !== c.maj ? "The two majorities point opposite ways, but each population is scored against its own majority." : "",
  ].filter(Boolean).join(" ");
  return llmChap("llmPopC2", 2, title, true,
    "Each population is scored as usual: consensus is how one-sided it is, awareness the share who predicted its majority.",
    cols +
    `<div class="llm-result${llmFresh(fresh, 2)}${llmFresh(fresh, "ex")}">This statement receives a commonsensicality score of <strong>${llmPctFine(h.s)}</strong> according to humans, and <strong>${llmPctFine(c.s)}</strong> according to the ${name}-generated population.</div>` +
    (notes ? `<p class="llm-note">${notes}</p>` : ""));
}

// ── 3 · All statements ──

function llmPopCh3(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, n = d.n_statements, name = esc(m.name), title = "All statements";
  if (Q.stage < 3) return llmChap("llmPopC3", 3, title, false);
  const row = (label, sub, key, cls) =>
    `<div class="llm-run-row"><div class="llm-run-label">${label}<span>${sub}</span></div>` +
    `<div class="llm-run-track" data-run="${key}">${LLM_POP_BAND_LABELS.map((_, i) => `<span class="llm-band ${cls} b${i}"></span>`).join("")}</div>` +
    `<div class="llm-run-val llm-prun-avg" data-run-val="${key}"></div></div>`;
  const run =
    `<div class="llm-run" id="llmPopRun"><div class="llm-run-ticker"><span class="llm-run-n" id="llmPopRunN"></span><span class="llm-run-stmt" id="llmPopRunStmt"></span></div>` +
    row("Real people", "the people who rated each", "h", "is-human") + row(`${name}'s population`, "per 100 members", "m", "is-model") +
    `<div class="llm-band-key" aria-hidden="true"><span>Statements by score:</span>${LLM_POP_BAND_LABELS.map((l, i) => `<span><i class="llm-band-sw b${i}"></i>${l}</span>`).join("")}</div></div>` +
    `<div id="llmPopRunRes">${Q.ran ? llmPopRunResults(m, md, null) : ""}</div>`;
  // From stage 4 the count and the steps' text share a column beside the
  // scatter plot, so the plot sits under the chapter's top, which each Next
  // keeps at the top of the panel
  const body = Q.stage >= 4 ? llmPopScatter(m, md, fresh, run) : run;
  return llmChap("llmPopC3", 3, title, true,
    `Now every statement is scored twice: among the people who rated it, and in ${name}'s population.`, body);
}

function llmPopRunResults(m, md, fresh) {
  const d = LLM.data, name = esc(m.name);
  const hs = d.statements.map((s) => s.humans), ms = md.scores;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return (
    `<div class="llm-beat${llmFresh(fresh, 3)}" id="llmPopB3"><p class="llm-p">On average, people give a statement <strong>${fmtPct(mean(hs))}</strong>, and ${name}'s population <strong>${fmtPct(mean(ms))}</strong>.</p></div>`
  );
}

// Chapter 3's count: two bars fill statement by statement, each split into
// score bands, with each population's running average
function llmPopRunStart(animate) {
  const d = LLM.data, Q = LLM.pop, md = LLM.md, m = llmModel(), n = d.n_statements;
  const order = llmPopOrder();
  const tallies = [["h", order.map((i) => d.statements[i].humans)], ["m", order.map((i) => md.scores[i])]].map(([key, xs]) => {
    const bands = LLM_POP_BAND_LABELS.map(() => [0]), sums = [0];
    for (const v of xs) {
      const b = llmPopBand(v);
      bands.forEach((c, i) => c.push(c[c.length - 1] + (i === b ? 1 : 0)));
      sums.push(sums[sums.length - 1] + v);
    }
    return { key, xs, bands, sums };
  });
  // The ticker shows the latest statement scored, skipping those written
  // around stand-in names
  const shown = [];
  order.forEach((i, j) => shown.push(d.statements[i].placeholder ? (j ? shown[j - 1] : -1) : j));
  const draw = (k) => {
    for (const t of tallies) {
      const track = document.querySelector(`#llmPopRun [data-run="${t.key}"]`);
      const val = document.querySelector(`#llmPopRun [data-run-val="${t.key}"]`);
      if (!track || !val) continue;
      t.bands.forEach((c, i) => {
        const seg = track.children[i];
        seg.style.width = `${(c[k] / n) * 100}%`;
        seg.title = `${LLM_POP_BAND_LABELS[i]}: ${fmtNum(c[k])} statements`;
      });
      val.innerHTML = k ? `average <strong>${fmtPct(t.sums[k] / k)}</strong>` : "";
    }
    const count = document.getElementById("llmPopRunN"), stmt = document.getElementById("llmPopRunStmt");
    if (count) count.textContent = `${fmtNum(k)} of ${fmtNum(n)} scored`;
    if (stmt) {
      const j = k > 0 && k < n ? shown[k - 1] : -1;
      stmt.innerHTML = j >= 0
        ? `<span class="llm-run-text">${esc(d.statements[order[j]].text)}</span>` +
          `<span class="llm-prun-sc is-human" title="Among people">${fmtPct(tallies[0].xs[j])}</span><span class="llm-prun-sc is-model" title="${esc(`In ${m.name}'s population`)}">${fmtPct(tallies[1].xs[j])}</span>`
        : "";
    }
  };
  if (!animate) {   // drawn full; no animation to stop
    draw(n);
    if (!Q.ran) {
      Q.ran = true;
      const res = document.getElementById("llmPopRunRes");
      if (res) res.innerHTML = llmPopRunResults(m, md, null);
    }
    return;
  }
  llmPopAnimate(2400, (p) => draw(Math.round(p * n)), (natural) => {
    if (Q.ran) return;
    Q.ran = true;
    const res = document.getElementById("llmPopRunRes");
    if (res) res.innerHTML = llmPopRunResults(m, md, natural ? new Set([3]) : null);
    llmPopStepper();
    if (natural) llmRevealEl(document.getElementById("llmPopB3"), false, document.getElementById("llmPopC3"));
  });
}

// Stages 4 to 6: one statement on the scatter plot, then every statement,
// then the best-fit line and r
function llmPopScatter(m, md, fresh, before) {
  const d = LLM.data, Q = LLM.pop, n = d.n_statements, name = esc(m.name);
  const { s, h, c } = llmPopExScores(md);
  const fit = Q.stage >= 6 ? llmFit(d.statements.map((x) => x.humans), md.scores) : null;
  if (fit) fit.r = m.r ?? fit.r;   // the server's r, from the same scores
  const svg = llmSctSvg({
    id: "llmPopSctSvg", xs: d.statements.map((x) => x.humans), ys: md.scores, order: llmPopOrder(),
    xName: "People", yName: m.name, xLabel: "Score among people", yLabel: `Score in ${m.name}'s population`,
    xCls: "is-people", yCls: "is-model", dot: "is-model",
    hi: s.id, hiLabel: s.text, guides: Q.stage === 4, points: Q.stage >= 5, fit, fitNew: !!fresh && fresh.has(6),
    aria: `Scatter plot of the ${fmtNum(n)} statements' commonsensicality among people (across) and in ${m.name}'s population (up)` +
      (fit ? `, with a best-fit line; r = ${llmR(m.r)}` : ""),
  });
  let text = before +
    `<p class="llm-p${llmFresh(fresh, 4)}${llmFresh(fresh, "ex")}" id="llmPopB4">Each statement is now a point. The one from before scores <strong>${llmPctFine(h.s)}</strong> among people (across) and <strong>${llmPctFine(c.s)}</strong> in ${name}'s population (up).</p>`;
  if (Q.stage >= 5) {
    text +=
      `<p class="llm-p${llmFresh(fresh, 5)}" id="llmPopB5">And here are all ${fmtNum(n)} statements.</p>` +
      `<p class="llm-note${llmFresh(fresh, 5)}">Point at a dot to see its statement.</p>`;
  }
  if (Q.stage >= 6) {
    const flat = !m.r_sig || !fit ? "The best-fit line is almost flat. " : "";
    text +=
      `<div class="llm-beat${llmFresh(fresh, 6)}" id="llmPopB6"><p class="llm-p">${flat}The correlation r measures how closely the points follow a straight line: 0 if the two scores are unrelated, 1 if they line up perfectly.</p>` +
      `<div class="llm-result">Judging over all ${fmtNum(n)} statements, the ${name}-generated population correlates with the human population at <strong>r = ${llmR(m.r)}</strong>.` +
      `${m.r_sig ? "" : " That is not significantly different from 0."}</div></div>`;
  }
  return `<div class="llm-sct-grid" id="llmPopSct"><div class="llm-sct-text">${text}</div><figure class="llm-sct${llmFresh(fresh, 4)}">${svg}</figure></div>`;
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
// until the points are drawn when fitWait. Pointing at the plot names the
// nearest statement (llmSctProbe()); a click opens it.
const LLM_SCT = { S: 340, L: 72, T: 36, R: 16, B: 50 };
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
  let out =
    `<svg class="llm-sct-svg" id="${o.id}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria)}">` +
    `<rect x="${L}" y="${T}" width="${S}" height="${S}" class="llm-sct-frame"/>` +
    ticks.map((t) =>
      (t > 0 && t < 1 ? `<line class="llm-sct-gl" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T + S}"/><line class="llm-sct-gl" x1="${L}" x2="${L + S}" y1="${y(t)}" y2="${y(t)}"/>` : "") +
      `<text x="${x(t)}" y="${T + S + 18}" text-anchor="middle" class="llm-sct-tick">${Math.round(t * 100)}%</text>` +
      `<text x="${L - 7}" y="${y(t) + 4}" text-anchor="end" class="llm-sct-tick">${Math.round(t * 100)}%</text>`).join("") +
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
    out += `<g class="llm-sct-key${cls}"><line class="llm-sct-fit" x1="${L}" x2="${L + 22}" y1="${T - 15}" y2="${T - 15}"/>` +
      `<text x="${L + 30}" y="${T - 10}" class="llm-sct-r">Best-fit line · r = ${llmR(o.fit.r)}</text></g>`;
  }
  const hp = o.hi !== null && o.hi !== undefined ? pts.get(o.hi) : null;
  if (hp) {
    const [, px, py, xv, yv] = hp;
    if (o.guides) {
      out +=
        `<line class="llm-sct-guide" x1="${px}" x2="${px}" y1="${py}" y2="${T + S}"/><line class="llm-sct-guide" x1="${L}" x2="${px}" y1="${py}" y2="${py}"/>` +
        `<text x="${Math.min(px, L + S + 4)}" y="${T + S + 18}" text-anchor="middle" class="llm-sct-gval ${o.xCls}">${fmtPct(xv)}</text>` +
        `<text x="${L - 7}" y="${py + 4}" text-anchor="end" class="llm-sct-gval ${o.yCls}">${fmtPct(yv)}</text>`;
    }
    // the label as long as fits beside the point (llm.css sets the plots'
    // text larger on phones)
    const left = px > L + S * 0.55, ly = py < T + 28 ? py + 22 : py - 12;
    const room = left ? px - 11 - L : L + S - px - 11;
    const fit = Math.max(12, Math.floor(room / (window.matchMedia("(max-width: 700px)").matches ? 10.4 : 8.6)) - 2);
    const label = o.hiLabel.length > fit ? `${o.hiLabel.slice(0, fit - 1).replace(/\s+\S*$/, "")}…` : o.hiLabel;
    out +=
      `<circle class="llm-sct-hi" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6.5"/>` +
      `<text x="${(left ? px - 11 : px + 11).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${left ? "end" : "start"}" class="llm-sct-hilab">“${esc(label)}”</text>`;
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

// ── 4 · Setting up a baseline for correlation ──

function llmPopCh4(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, sh = d.split_half, n = d.n_statements, name = esc(m.name);
  const title = "Setting up a baseline for correlation";
  if (Q.stage < 7) return llmChap("llmPopC4", 4, title, false);
  const lead = `How should we interpret r = ${llmR(m.r)}, the correlation between the ${name}-generated population and humans?`;
  if (!llmPopSplitReady()) return llmChap("llmPopC4", 4, title, true, lead, '<div class="empty-row">Splitting…</div>');
  const sp = Q.split, s = d.statements[Q.ex];
  const half = (label, raters) => {
    const k = raters.filter((x) => x[0]).length, ko = raters.filter((x) => x[1]).length, nr = raters.length;
    const sc = nr ? llmCrowdScore(k / nr, ko / nr) : null;
    return {
      sc,
      html: `<div class="llm-half"><div class="llm-crowd-who">${label}<span>${llmCount(nr, "rater")}</span></div>` +
        llmFigureRow(k, nr, "is-p", "is-grid") +
        `<div class="llm-crowd-share">${fmtNum(k)} of ${fmtNum(nr)} agree${sc ? `: commonsensicality <strong>${fmtPct(sc.s)}</strong>` : ""}</div></div>`,
    };
  };
  const A = half("Half A", sp.example.a), B = half("Half B", sp.example.b);
  const exNote = A.sc && B.sc
    ? Math.abs(A.sc.s - B.sc.s) >= 0.0005
      ? `Same statement, ${fmtPct(A.sc.s)} in one half and ${fmtPct(B.sc.s)} in the other, just because different people rated it.`
      : `This time both halves give it ${fmtPct(A.sc.s)}; split again to see it change.`
    : "One half has no rater of this statement this time.";
  const fx = (k) => llmFresh(fresh, k);
  let body =
    `<p class="llm-p">Imagine if we split the human population into two halves, A and B. Each half rates statements as usual, so every statement has two commonsensicality scores, one for each half.</p>` +
    `<div class="llm-survey llm-split-ex${fx(7)}${fx("ex")}${fx("split")}" id="llmPopB7"><div class="llm-ex-head"><span class="llm-ex-kicker">Random split ${Q.seed + 1} of ${fmtNum(sh.n_splits)} · two halves of ${fmtNum(sh.n_half)} people</span>` +
    `<span class="llm-ex-btns"><button type="button" class="llm-btn" data-story="pop-resplit">Split again ↻</button></span></div>` +
    `<blockquote class="llm-ex-quote">${esc(s.text)}</blockquote><div class="llm-crowd-cols">${A.html}${B.html}</div>` +
    `<p class="llm-note">${exNote}</p></div>`;
  if (Q.stage >= 8) {
    const animating = !!fresh && fresh.has(8);
    const fit = llmFit(sp.scores.a, sp.scores.b);
    if (fit) fit.r = sp.r;   // the server's r, over the same statements
    const svg = llmSctSvg({
      id: "llmPopHalvesSvg", xs: sp.scores.a, ys: sp.scores.b, order: llmPopOrder(),
      xName: "Half A", yName: "Half B", xLabel: "Score in half A", yLabel: "Score in half B",
      xCls: "is-people", yCls: "is-people", dot: "is-people",
      hi: s.id, hiLabel: s.text, guides: false, points: true, fit, fitWait: animating,
      aria: `Scatter plot of the statements' commonsensicality in half A (across) and half B (up) of random split ${Q.seed + 1}, with a best-fit line; r = ${llmR(sp.r)}`,
    });
    // the example and the text in a column beside the plot, so the plot
    // sits under the chapter's top
    body =
      `<div class="llm-sct-grid" id="llmPopHalves"><div class="llm-sct-text">${body}` +
      `<p class="llm-p${fx(8)}" id="llmPopB8">If we do the same for all statements, we arrive at a correlation of <strong>r = ${llmR(sp.r)}</strong>.</p>` +
      (sp.n_used < n ? `<p class="llm-note${fx(8)}">The ${fmtNum(sp.n_used)} statements both halves rated.</p>` : "") +
      `</div><figure class="llm-sct${fx(8)}${fx("split")}">${svg}</figure></div>`;
  }
  if (Q.stage >= 9) {
    const runs = Q.splits.slice(-6).map((x) => `<span class="llm-r-chip${x.seed === Q.seed ? " is-current" : ""}">r = ${llmR(x.r, 3)}</span>`).join("");
    body +=
      `<div class="llm-beat${fx(9)}" id="llmPopB9">` +
      `<p class="llm-p">Each split gives a slightly different r. Over ${fmtNum(sh.n_splits)} random splits, r averages <strong>${llmR(sh.mean)}</strong>; 95% fall between ${llmR(sh.lo)} and ${llmR(sh.hi)}.</p>` +
      llmSplitHistHtml() +
      `<div class="llm-r-chips"><span class="llm-r-chips-k">Your splits</span>${runs}<button type="button" class="llm-btn" data-story="pop-resplit">Split again ↻</button></div>` +
      `<div class="llm-result">Thus, the correlation r = ${llmR(sh.mean)} is the <strong>split-half reliability</strong> of the human population. It sets a baseline for what we should expect from another population that claims to be similar to humans.</div>` +
      `<p class="llm-note">Why not 1? Each half has only about ${Math.round(d.ratersMean / 2)} raters per statement, so its scores are noisy. ` +
      `A model's population is compared with all of a statement's raters (${Math.round(d.ratersMean)} on average), so a population that simulated these people perfectly would be expected to beat ${llmR(sh.mean)}.</p></div>`;
  }
  return llmChap("llmPopC4", 4, title, true, lead, body);
}

// The 1,000 splits' r as a histogram, the current split's bar darkest and
// the splits seen so far darker
function llmSplitHistHtml() {
  const d = LLM.data, sh = d.split_half, Q = LLM.pop, rs = sh.rs || [];
  if (!rs.length) return "";
  const w = 0.0025, lo = Math.floor(Math.min(...rs) / w + 1e-9) * w, hi = Math.ceil(Math.max(...rs) / w - 1e-9) * w;
  const nb = Math.max(1, Math.round((hi - lo) / w)), bw = 100 / nb;
  const bin = (r) => Math.min(nb - 1, Math.max(0, Math.floor((r - lo) / w + 1e-9)));
  const counts = Array(nb).fill(0);
  rs.forEach((r) => counts[bin(r)]++);
  const seen = new Set(Q.splits.map((x) => bin(x.r))), cur = Q.split ? bin(Q.split.r) : -1;
  const top = Math.max(...counts), ystep = top > 100 ? 50 : 25, ymax = Math.max(ystep, Math.ceil(top / ystep) * ystep);
  const yp = (v) => (v / ymax) * 100, xp = (r) => ((r - lo) / (hi - lo)) * 100;
  const yt = Array.from({ length: Math.round(ymax / ystep) + 1 }, (_, k) => k * ystep);
  const bars = counts.map((c, i) => {
    if (!c) return "";
    const a = lo + i * w, tip = `r from ${llmR(a, 4)} to ${llmR(a + w, 4)}: ${llmCount(c, "split")}${i === cur ? " (this split)" : ""}`;
    return `<span class="llm-rh-bar${i === cur ? " is-current" : seen.has(i) ? " is-seen" : ""}" style="left:${(i * bw + bw * 0.08).toFixed(3)}%;width:${(bw * 0.84).toFixed(3)}%;height:${yp(c).toFixed(2)}%" title="${esc(tip)}"></span>`;
  }).join("");
  const xt = [];
  for (let t = Math.ceil(lo * 100 - 1e-9); t <= Math.floor(hi * 100 + 1e-9); t++) xt.push(`<span style="left:${xp(t / 100).toFixed(2)}%">${llmR(t / 100)}</span>`);
  return (
    `<div class="llm-cols llm-lhist llm-rhist" role="img" aria-label="${esc(`Histogram of r between the two halves over ${fmtNum(sh.n_splits)} random splits: average ${llmR(sh.mean)}, 95% between ${llmR(sh.lo)} and ${llmR(sh.hi)}`)}">` +
    `<div class="llm-cols-y" aria-hidden="true">${yt.map((t) => `<span style="bottom:${yp(t).toFixed(2)}%">${t}</span>`).join("")}</div>` +
    `<div class="llm-cols-plot">${yt.map((t) => `<i class="llm-cols-grid${t ? "" : " is-zero"}" style="bottom:${yp(t).toFixed(2)}%"></i>`).join("")}${bars}` +
    `<i class="llm-lhist-med" style="left:${xp(sh.mean).toFixed(2)}%"><span>Average ${llmR(sh.mean, 3)}</span></i></div></div>` +
    `<div class="llm-lhist-x" aria-hidden="true">${xt.join("")}</div>`
  );
}

// ── 5 · The verdict ──

function llmPopCh5(m, md, fresh) {
  const d = LLM.data, Q = LLM.pop, sh = d.split_half, h = d.humans, n = d.n_statements, name = esc(m.name);
  const title = "The verdict";
  if (Q.stage < 10) return llmChap("llmPopC5", 5, title, false);
  const r = m.r ?? 0, bench = sh.mean;
  const bars =
    `<div class="llm-verdict${llmFresh(fresh, 10)}" id="llmPopB10">` +
    `<div class="llm-verdict-row is-people"><span>Half of people vs the other half</span>${llmTrack(bench, LLM_R_SCALE, "is-human")}<strong>${llmR(bench)}</strong></div>` +
    `<div class="llm-verdict-row"><span>${name}'s population vs people</span>${llmTrack(r, LLM_R_SCALE, llmModelCls(m))}<strong>${llmR(m.r)}</strong></div>` +
    `<div class="llm-verdict-axis"><span></span>${llmAxis(LLM_R_SCALE)}<span></span></div></div>`;
  // Below the baseline when even the top of its 95% interval is
  const sig = m.ci && m.ci.r ? m.ci.r[1] < sh.lo : r < sh.lo;
  const best = [...d.models].sort((a, b) => (b.r ?? -2) - (a.r ?? -2))[0];
  const bestLink = `<button type="button" class="llm-link" data-llm-go="population" data-llm-model="${esc(best.id)}" title="${esc(`Follow ${best.name}'s population through this story`)}">${esc(best.name)}</button>`;
  const verdict = r < bench
    ? `Since the ${name} population only achieves a correlation of r = ${llmR(m.r)}, this is ${sig ? "significantly " : ""}below the split-half human reliability.`
    : `The ${name} population achieves a correlation of r = ${llmR(m.r)}, at least the split-half human reliability.`;
  const others = (best.r ?? -2) < bench
    ? ` In fact, no model is able to achieve this baseline level. ${best.id === m.id ? `${name} is the best of all ${fmtNum(d.models.length)}.` : `The best is ${bestLink}, which achieves r = ${llmR(best.r)}.`}`
    : "";
  // Why its population differs, from what its answers to question 1 look like
  const py = md.ratings.map((x) => x[0]), shareAgree = d.statements.map((x) => x.I_agree);
  const sure = m.n_sure / n, hSure = h.n_sure / n, ties = m.n_tie ? m.n_tie[0] / n : 0;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const popMean = mean(md.scores), peopleMean = mean(d.statements.map((x) => x.humans));
  const sortedP = [...py].sort((a, b) => a - b), sortedH = [...shareAgree].sort((a, b) => a - b);
  const why = ties >= 0.1
    ? `On ${fmtPct(ties)} of statements its population is split exactly 50–50, which scores 0 whatever people think.`
    : sure >= 0.5 && sure >= 1.5 * hSure
      ? `Its population is near-unanimous (95% or more on one side) on ${fmtPct(sure)} of statements, real people on ${fmtPct(hSure)}` +
        (popMean > peopleMean + 0.05 ? `, so it scores most statements high (${fmtPct(popMean)} on average, against ${fmtPct(peopleMean)} for people), whatever people think.` : `: it is sure about many statements on which people are divided.`)
      : llmSd(py) < 0.7 * llmSd(shareAgree)
        ? `The share of its population that agrees varies little: on 80% of statements it is between ${fmtPct(llmQuantile(sortedP, 0.1))} and ${fmtPct(llmQuantile(sortedP, 0.9))}, against ${fmtPct(llmQuantile(sortedH, 0.1))} and ${fmtPct(llmQuantile(sortedH, 0.9))} among real people. So its population leans much the same way on statements people see very differently.`
        : sure < 0.6 * hSure
          ? `Its population is near-unanimous on only ${fmtPct(sure)} of statements, real people on ${fmtPct(hSure)}: it is rarely of one mind, even where people are.`
          : `Its population is near-unanimous about as often as real people (${fmtPct(sure)} of statements against ${fmtPct(hSure)}), but on different statements.`;
  return llmChap("llmPopC5", 5, title, true, "",
    bars + `<p class="llm-p${llmFresh(fresh, 10)}">${verdict}${others}</p>` +
    `<p class="llm-note">Why the gap? ${why}</p>` +
    `<p class="llm-note">As a population, ${name} ranks ${llmOrdinal(m.rankR)} of ${fmtNum(d.models.length)}. <a href="#llmPopRank" class="llm-link" data-llm-scroll>See every model's crowd ↓</a></p>`);
}

// Next in the population story; stage 7 waits for its split
async function llmPopNext() {
  const Q = LLM.pop;
  if (!LLM.md || llmPopBusy()) return;
  if (Q.stage >= LLM_POP_LAST) { llmShowView("overview"); return; }
  const from = Q.stage, to = from + 1;
  if (to === 7 && !llmPopSplitReady()) {
    Q.busy = true;
    llmPopStepper();
    try { await llmPopLoadSplit(); } catch (err) { console.error("LLM split failed:", err); Q.busy = false; llmPopStepper(); return; }
    Q.busy = false;
  }
  Q.stage = to;
  const chFrom = LLM_POP_OPEN.filter((s) => from >= s).length, ch = LLM_POP_OPEN.filter((s) => to >= s).length;
  llmPopPaint(new Set([to]), [...new Set([chFrom, ch])]);
  if (LLM_POP_OPEN.includes(to)) document.getElementById(`llmPopC${ch}`)?.classList.add("llm-in");
  // The chapter card the click added to goes to the top of the panel, and
  // stays there for the chapter's later steps
  llmRevealEl(document.getElementById(`llmPopC${ch}`), true);
}

function llmPopAction(action) {
  const d = LLM.data, Q = LLM.pop, md = LLM.md;
  if (!md) return;
  const fail = (err) => console.error("LLM split failed:", err);
  if (action === "pop-another" || action === "pop-paper") {
    // a statement whose population score, worked out from the model's
    // answers as shown (rounded to 4 decimals), matches its listed score
    Q.ex = action === "pop-paper" ? d.examples.population
      : llmRandomStatement(Q.ex, (s) => Math.abs(llmCrowdScore(md.ratings[s.id][0], md.ratings[s.id][1]).s - md.scores[s.id]) < 0.0005);
    const repaint = () => llmPopPaint(new Set([1, "ex"]), [1, 2, 3, 4]);
    if (Q.stage >= 7) llmPopLoadSplit().then(repaint).catch(fail);
    else repaint();
  } else if (action === "pop-resplit") {
    const used = new Set(Q.splits.map((x) => x.seed));
    const free = Array.from({ length: d.split_half.n_splits }, (_, i) => i).filter((i) => !used.has(i));
    Q.seed = free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * d.split_half.n_splits);
    llmPopLoadSplit().then(() => llmPopPaint(new Set(["split"]), [4])).catch(fail);
  }
}

// Opens the population story up to stage
async function llmPopOpenTo(stage) {
  const Q = LLM.pop;
  if (stage <= Q.stage) return;
  if (stage >= 7 && !llmPopSplitReady()) {
    try { await llmPopLoadSplit(); } catch (err) { console.error("LLM split failed:", err); return; }
  }
  Q.stage = stage;
  llmPopPaint(null);
}

function llmSd(x) {
  const n = x.length, m = x.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

const LLM_POP_SHOW = [
  ["", "All statements", () => true],
  ["model", "Model's crowd 20+ points higher", (r) => r.diff >= 0.2],
  ["people", "People 20+ points higher", (r) => r.diff <= -0.2],
  ["close", "Within 10 points", (r) => Math.abs(r.diff) < 0.1],
];

function llmPopTable(m) {
  document.getElementById("llmPopTableTitle").textContent = `Where ${m.name}'s crowd and people disagree most`;
  if (!LLM.tables.pop) {
    LLM.tables.pop = llmTable(document.getElementById("llmPopTable"), {
      noun: "statements",
      rows: () => LLM.popRows,
      search: llmStatementSearch,
      selects: llmStatementSelects(LLM_POP_SHOW),
      props: true,
      sort: { key: "gap", dir: "desc" },
      onRow: (r) => llmOpenStatement(r.id),
      columns: [
        { key: "text", label: "Statement", cls: "col-statement", tdCls: "td-statement", value: (r) => r.text, html: (r) => esc(r.text) },
        { key: "model", label: () => `${esc(llmModel().name)}'s crowd`, cls: "llm-col-score", value: (r) => r.model, html: (r) => llmBar(r.model, "model"),
          helpLabel: () => `${llmModel().name}'s crowd`, help: "The statement's commonsensicality in the model's simulated crowd: its answers to the two questions read as the shares of the crowd answering yes." },
        { key: "humans", label: "People", cls: "llm-col-score", value: (r) => r.humans, html: (r) => llmBar(r.humans, "human"),
          helpLabel: "People", help: "The statement's commonsensicality among the people who rated it." },
        { key: "gap", label: "Gap", cls: "llm-col-num", tdCls: "td-num", value: (r) => Math.abs(r.diff), html: (r) => `${llmPts(r.diff)} <span class="llm-unit">pts</span>`,
          helpLabel: "Gap", help: "The model crowd's score minus people's, in percentage points. Sorting uses its size, ignoring the sign." },
      ],
    });
  }
  LLM.tables.pop.refresh(true);
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
  const props = PROP_DEFS.map((p) => {
    const v = s[p.key];
    return `<span class="llm-prop-chip k${v}" title="${esc(v ? p.def1 : p.def0)}">${esc(v ? p.v1 : p.v0)}</span>`;
  }).join("");
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
  const above = rows.filter((r) => r.v >= sc.humans).length;
  const row = (name, ans, v, kind, extra = "") =>
    `<div class="llm-pop-row ${kind}"${extra}><span class="llm-pop-name">${name}</span><span class="llm-pop-ans">${ans}</span>` +
    `<span class="llm-pop-track"><span class="llm-pop-fill" style="width:${(v * 100).toFixed(1)}%"></span></span>` +
    `<span class="llm-pop-val">${fmtPct(v)}</span></div>`;
  body.innerHTML =
    `<div class="modal-explanation"><div class="llm-prop-chips">${props}</div>` +
    `<p>People's majority <strong>${s.majority ? "agrees" : "disagrees"}</strong> (${fmtPct(s.I_agree)} agree). As respondents, <strong>${agree} of ${d.models.length} models agree</strong>; ` +
    `the pill shows each model's own answer, green when it matches the people's majority. The bars are the statement's commonsensicality among people and in each model's simulated crowd: ` +
    `${fmtNum(above)} of ${d.models.length} crowds score it at least as high as people. A crowd's score doesn't say which way it leans: a crowd that unanimously disagrees, and knows it, scores 100% too. Click a model to work through its crowd.</p></div>` +
    `<div class="llm-pop-list"><div class="llm-pop-row is-head"><span>Who</span><span>Agrees?</span><span>Commonsensicality</span><span></span></div>` +
    row("People", `<span class="llm-maj-word">${fmtPct(s.I_agree)}</span>`, sc.humans, "is-human") +
    rows.map(({ m, v, p }) => row(llmName(m), answerPill(p[0] >= 0.5 ? 1 : 0, s.majority), v, m.id === LLM.model ? "is-model is-selected" : "is-model",
      ` role="button" tabindex="0" data-model="${esc(m.id)}"`)).join("") +
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
      `<tr><td class="td-statement">${esc(s.text)}</td><td class="td-modal-right">${fmtPct(s.I_agree)} <span class="llm-maj-word">· majority ${s.majority ? "agrees" : "disagrees"}</span></td>` +
      `<td class="td-modal-right">${answerPill(ia, s.majority)}</td><td class="td-modal-right">${answerPill(oa, s.majority)}</td></tr>`,
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
  const select = document.getElementById("llmModelSelect");
  if (LLM.model && select.value !== LLM.model) select.value = LLM.model;
  const m = llmModel();
  if (pick && m && LLM.data) {
    const ind = LLM.view === "individual";
    const list = llmRankList(LLM.view);
    const i = list.findIndex((x) => x.id === m.id);
    document.getElementById("llmModelRank").textContent = `${llmOrdinal(i + 1)} of ${list.length} ${ind ? "as an individual" : "as a crowd"}`;
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
  if (!llmModel(id) || id === LLM.model) return;
  LLM.model = id;
  if (!keep) document.getElementById("llmWrap").scrollTop = 0;
  llmRender();
}

function llmOpenModel(id, view) {
  if (!llmModel(id)) return;
  LLM.model = id;
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
  if (!llmModel()) LLM.model = [...LLM.data.models].sort((a, b) => a.rankCs - b.rankCs)[0].id;
  if (!llmModel(LLM.featModel)) LLM.featModel = LLM.data.models[0].id;
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
      if (go.dataset.llmModel && llmModel(go.dataset.llmModel)) LLM.model = go.dataset.llmModel;
      if (go.dataset.llmBoard) LLM.board = go.dataset.llmBoard;
      llmShowView(go.dataset.llmGo, go.dataset.llmAt || null);
      return;
    }
    const scroll = e.target.closest("a[data-llm-scroll]");
    if (scroll) { e.preventDefault(); llmScrollTo(scroll.getAttribute("href").slice(1)); return; }
    const open = e.target.closest("[data-open][data-model]");
    if (open) { llmOpenModel(open.dataset.model, open.dataset.open); return; }
    const chip = e.target.closest("[data-feat]");
    if (chip && LLM.data) { LLM.featModel = chip.dataset.feat; llmRenderFeatures(); return; }
    const story = e.target.closest("[data-story]");
    if (story && LLM.data) {
      const action = story.dataset.story;
      if (action.startsWith("ind-")) llmIndAction(action);
      else llmPopAction(action);
      return;
    }
    const next = e.target.closest("[data-story-next]");
    if (next && LLM.data) {
      if (next.dataset.storyNext === "individual") llmIndNext();
      else llmPopNext();
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
    const lvl = e.target.closest("[data-lvl-model]");
    if (lvl && LLM.data) { llmSetModel(lvl.dataset.lvlModel, true); return; }
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
    });
  }
  panel.addEventListener("pointerout", (e) => {
    const svg = e.target.closest && e.target.closest(".llm-lvl-svg, .llm-sct-svg");
    if (!svg || (e.relatedTarget && svg.contains(e.relatedTarget))) return;
    svg.querySelector(".llm-lvl-probe, .llm-sct-probe").style.display = "none";
    svg.classList.remove("is-on");
  });
  panel.addEventListener("change", (e) => {
    if (e.target.id === "llmFeatSelect" && e.target.value) { LLM.featModel = e.target.value; llmRenderFeatures(); }
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
  llmOnSeg("llmBoardFilter", (v) => { LLM.board = v; if (LLM.data) llmRenderBoard(); });
  // Statement modal: a model row opens that model's population walkthrough
  const stmtBody = document.getElementById("llmStmtModalBody");
  const pickModel = (e) => {
    const row = e.target.closest("[data-model]");
    if (!row) return;
    llmShowModal("llmStmtModal", false);
    llmOpenModel(row.dataset.model, "population");
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
