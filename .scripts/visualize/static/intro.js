"use strict";

// ══ Panel intro cards ═══════════════════════════════════════════════════════
// One collapsible "About this …" card per panel: Individual Scores, Statement
// Scores, Design Points, Group Comparison and Countries. index.html holds the
// static copy (.intro[data-intro]); this file fills each card's worked example
// from the data its panel has just loaded. app.js calls
// introOnData(panel, data, ctx) through notifyIntro() after each load, so the
// examples follow the panel's selects and the date filter, and no extra
// request is made except for the example itself (/api/user-detail,
// /api/dp-statements, /api/country-cell).
//
// Loaded after app.js and home.js. Uses app.js globals (API, esc, fmtNum,
// capFirst, fixStatement, dateParams, DP_PROPS, dpCiSvg, countryFlag,
// openUserDetail, openStmtCombined, compareGroupAEl, compareGroupBEl,
// loadGroupCompare, stmtScoresAllRows, stmtScoresCountrySelect) and
// HS_FEATURES from home.js for the one-line feature glosses.
//
// The try-it controls recompute scores in the browser, so the formulas in
// utils.py are restated here (introStmtCalc, introIndivCalc): statement
// consensus = 2|p − ½| and awareness = q if p ≥ ½ else 1 − q; a person's
// consensus and awareness are the shares of counted statements (≥ 10
// reference ratings) where their answer, or their guess about most others,
// matches the reference majority (agree when ≥ ½ agree); commonsensicality =
// √(consensus × awareness). A formula change must update these too.

const INTRO_MIN_REF_RATINGS = 10; // utils.py min_ratings_per_statement

const INTRO = {
  scores: { data: null, ctx: null, sorted: [], persona: -1, req: 0, rows: null, user: null },
  stmt: { rows: [], ctx: null, sorted: [], type: -1, ex: null },
  dp: { data: null, ctx: null, sel: null, req: 0, timer: null },
  countries: { data: null, list: [], i: -1, req: 0 },
};

// ── Small helpers ───────────────────────────────────────────────────────────

function inPct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  let d = digits;
  // Never print a non-unanimous share as 100% (or a non-zero one as 0%)
  while (d < 3 && ((v < 1 && (v * 100).toFixed(d) === (100).toFixed(d)) || (v > 0 && (v * 100).toFixed(d) === (0).toFixed(d)))) d++;
  return `${(v * 100).toFixed(d)}%`;
}

// The statement card shows two decimals so its arithmetic checks out on screen:
// at one decimal, a share of 19.96% would read 2 × |20.0% − 50%| = 60.1%.
function inPct2(v) { return inPct(v, 2); }

function inStoreGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function inStoreSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

// Share of values strictly below x in an ascending array
function inShareBelow(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x - 1e-9) lo = mid + 1; else hi = mid; }
  return sorted.length ? lo / sorted.length : 0;
}

function inMedian(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function inQuantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

function inPick(arr, k = 6) {
  const top = arr.slice(0, k);
  return top[Math.floor(Math.random() * top.length)];
}

function inGroupLabel(g) { return !g || g === "all" ? "All countries" : g; }

// "the United States", "the Netherlands", "France"
const IN_THE_COUNTRIES = new Set(["Netherlands", "Philippines", "Czech Republic", "Dominican Republic", "Bahamas", "Gambia", "Maldives", "Central African Republic", "Democratic Republic of the Congo", "Republic of the Congo", "Comoros", "Seychelles", "Solomon Islands", "Marshall Islands"]);
function inTheCountry(c) { return /^United /.test(c) || IN_THE_COUNTRIES.has(c) ? `the ${c}` : c; }

function inCalcRow(name, cls, value, mathHtml) {
  const w = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    `<span class="intro-calc-name">${name}</span>` +
    `<span class="intro-calc-bar" aria-hidden="true"><span class="intro-calc-fill ${cls}" style="width:${w.toFixed(1)}%"></span></span>` +
    `<span class="intro-calc-math">${mathHtml}</span>`
  );
}

// A share that rounds to 50% gets a decimal, so its side of the majority line shows
function inPctSide(v) {
  return Math.round(v * 100) === 50 && v !== 0.5 ? inPct(v, 1) : inPct(v, 0);
}

function inDualBar(label, v, color) {
  return (
    `<div class="intro-dbar"><span class="intro-dbar-label">${label}</span>` +
    `<span class="intro-dbar-track"><span class="intro-dbar-fill" style="width:${(v * 100).toFixed(1)}%;background:${color}"></span><span class="intro-dbar-mid" aria-hidden="true"></span></span>` +
    `<span class="intro-dbar-val">${inPctSide(v)}</span></div>`
  );
}

const IN_AGREE = UI.agree;
const IN_EXPECT = UI.expect;

// ── Collapse / expand (remembered per panel in this browser) ──────────────

function introInitToggles() {
  document.querySelectorAll(".intro[data-intro]").forEach((card) => {
    const key = `cs-intro-collapsed:${card.dataset.intro}`;
    const btn = card.querySelector(".intro-toggle");
    if (!btn) return;
    const set = (collapsed) => {
      card.classList.toggle("is-collapsed", collapsed);
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.textContent = collapsed ? "Show guide ▾" : "Hide ▴";
    };
    set(inStoreGet(key) === "1");
    btn.addEventListener("click", () => {
      const collapsed = !card.classList.contains("is-collapsed");
      set(collapsed);
      inStoreSet(key, collapsed ? "1" : "0");
    });
  });
}

// ── Entry point from app.js ─────────────────────────────────────────────────

function introOnData(panel, data, ctx = {}) {
  try {
    if (panel === "scores") introScoresLoad(data, ctx);
    else if (panel === "stmtScores") introStmtLoad(data, ctx);
    else if (panel === "dp") introDpLoad(data, ctx);
    else if (panel === "compare") introCompareSync(ctx);
    else if (panel === "countries") introCountriesLoad(data);
  } catch (err) {
    console.error("Intro card error:", err);
  }
}

// ══ Individual Scores: a real participant, worked through ══════════════════

const INTRO_PERSONAS = [
  { label: "A typical participant", test: (u, s) => Math.abs(u.commonsensicality - s.median) <= 0.03 && u.consensus !== u.awareness },
  { label: "A low scorer", test: (u, s) => u.commonsensicality <= s.p10 },
  { label: "A high scorer", test: (u, s) => u.commonsensicality >= s.p90 && u.commonsensicality < 1 },
];

function introScoresLoad(data, ctx) {
  const S = INTRO.scores;
  S.data = data;
  S.ctx = ctx;
  S.sorted = (data.users || []).map((u) => u.commonsensicality).sort((a, b) => a - b);
  S.persona = -1;
  introScoresNext();
}

function introScoresNext() {
  const S = INTRO.scores;
  const el = document.getElementById("introScoresEx");
  if (!el) return;
  const users = (S.data && S.data.users) || [];
  if (!users.length) {
    el.innerHTML = `<p class="intro-empty">No participants can be scored with these settings, so there is no example to show.</p>`;
    return;
  }
  const stats = { median: inMedian(S.sorted), p10: inQuantile(S.sorted, 0.1), p90: inQuantile(S.sorted, 0.9) };
  // A compact example: about the median number of statements, with at least
  // one answer that misses the majority so both marks appear.
  const base = (lo, hi) => users.filter((u) => u.n_statements >= lo && u.n_statements <= hi && (u.consensus < 1 || u.awareness < 1));
  let pool = base(12, 18);
  if (pool.length < 20) pool = base(5, 40);
  if (!pool.length) pool = users;
  let user = null, persona = null;
  for (let k = 0; k < INTRO_PERSONAS.length && !user; k++) {
    S.persona = (S.persona + 1) % INTRO_PERSONAS.length;
    persona = INTRO_PERSONAS[S.persona];
    const cands = pool.filter((u) => persona.test(u, stats));
    if (cands.length) user = cands[Math.floor(Math.random() * cands.length)];
  }
  if (!user) { persona = { label: "A participant" }; user = pool[Math.floor(Math.random() * pool.length)]; }
  introScoresFetch(user, persona);
}

async function introScoresFetch(user, persona) {
  const S = INTRO.scores;
  const el = document.getElementById("introScoresEx");
  const req = ++S.req;
  const reference = (S.ctx && S.ctx.reference) || "all";
  let d;
  try {
    d = await fetch(`${API}/user-detail?userId=${encodeURIComponent(user.sessionId)}&reference=${encodeURIComponent(reference)}${dateParams()}`).then((r) => r.json());
  } catch {
    if (req === S.req) el.innerHTML = `<p class="intro-empty">The example could not be loaded.</p>`;
    return;
  }
  if (req !== S.req) return;
  const rows = (d.rows || []).map((r) => {
    const counted = r.ref_n_ratings != null && r.ref_n_ratings >= INTRO_MIN_REF_RATINGS && r.ref_i_agree_mean != null;
    return {
      text: fixStatement(r.statement),
      agree: r.I_agree, others: r.others_agree,
      agree0: r.I_agree, others0: r.others_agree,
      p: r.ref_i_agree_mean, n: r.ref_n_ratings,
      counted,
      maj: counted ? (r.ref_i_agree_mean >= 0.5 ? 1 : 0) : null,
    };
  });
  rows.sort((a, b) => Number(b.counted) - Number(a.counted));
  const calc = introIndivCalc(rows);
  if (calc.N !== d.n_scoring || (!d.disqualified && (calc.A !== d.A || calc.B !== d.B))) {
    console.warn("Intro example disagrees with /api/user-detail", { calc, server: d });
  }
  S.rows = rows;
  S.user = user;
  S.persona_obj = persona;
  introScoresRender();
}

function introIndivCalc(rows) {
  const c = rows.filter((r) => r.counted);
  const N = c.length;
  const A = c.filter((r) => r.agree === r.maj).length;
  const B = c.filter((r) => r.others === r.maj).length;
  const cons = N ? A / N : 0, aw = N ? B / N : 0;
  return { N, A, B, cons, aw, m: Math.sqrt(cons * aw) };
}

function introScoresRender() {
  const S = INTRO.scores;
  const el = document.getElementById("introScoresEx");
  const { rows, user } = S;
  const persona = S.persona_obj;
  const refLabel = inGroupLabel(S.ctx && S.ctx.reference);
  const flag = user.country ? countryFlag(user.country) : "";
  const pill = (r, i, q) => {
    const v = q === "agree" ? r.agree : r.others;
    const word = v ? "Yes" : "No";
    if (!r.counted) return `<span class="intro-pill is-off">${word}</span>`;
    const ok = v === r.maj;
    const flipped = q === "agree" ? r.agree !== r.agree0 : r.others !== r.others0;
    const qText = q === "agree" ? "agrees" : "thinks most others agree";
    return (
      `<button type="button" class="intro-pill ${ok ? "is-match" : "is-miss"}${flipped ? " is-flipped" : ""}" data-i="${i}" data-q="${q}" ` +
      `aria-label="${word}: ${ok ? "matches" : "misses"} the majority. Click to flip whether this participant ${qText}.">` +
      `<span aria-hidden="true">${ok ? "✓" : "✗"}</span>${word}</button>`
    );
  };
  const body = rows
    .map((r, i) => {
      const maj = r.counted
        ? `<span class="intro-maj">${r.maj ? "Agree" : "Disagree"}</span> <span class="intro-maj-share">${inPctSide(r.maj ? r.p : 1 - r.p)}</span>`
        : `<span title="Fewer than ${INTRO_MIN_REF_RATINGS} ratings in the reference group">not counted</span>`;
      const title = r.counted ? ` title="${fmtNum(r.n)} ratings in ${esc(refLabel)}; ${inPct(r.p)} agree"` : "";
      return (
        `<tr class="${r.counted ? "" : "is-uncounted"}">` +
        `<td><span class="intro-ans-stmt" title="${esc(r.text)}">${esc(r.text)}</span></td>` +
        `<td class="intro-col-maj"${title}>${maj}</td>` +
        `<td class="intro-col-ans">${pill(r, i, "agree")}</td>` +
        `<td class="intro-col-ans">${pill(r, i, "others")}</td>` +
        `</tr>`
      );
    })
    .join("");
  const nUncounted = rows.filter((r) => !r.counted).length;
  el.innerHTML =
    `<div class="intro-ex-head">` +
      `<span class="intro-ex-kicker">Worked example <span class="intro-tag" id="introScoresTag">${esc(persona.label)}</span></span>` +
      `<button type="button" class="intro-btn" data-act="another">Another participant ↻</button>` +
    `</div>` +
    `<div class="intro-ex-meta">${flag ? flag + " " : ""}${esc(user.country || "Country unknown")} · rated ${fmtNum(rows.length)} statements` +
      (nUncounted ? ` (${nUncounted} not counted)` : "") +
      ` · majority from ${esc(refLabel)} · <button type="button" class="intro-link" data-act="open">see this participant in full</button></div>` +
    `<div class="intro-ans-wrap"><table class="intro-ans">` +
      `<thead><tr><th>Statement</th><th class="intro-col-maj" title="The reference group's majority answer, and the share who gave it">Majority</th>` +
      `<th class="intro-col-ans">Agrees?</th><th class="intro-col-ans">Thinks most<br>others agree?</th></tr></thead>` +
      `<tbody>${body}</tbody></table></div>` +
    `<div class="intro-calc" id="introScoresCalc"></div>` +
    `<div class="intro-ex-foot"><span class="intro-hint" id="introScoresPctl"></span>` +
      `<span class="intro-hint"><strong>Try it:</strong> click a Yes or No to flip that answer. <button type="button" class="intro-link" data-act="reset" hidden>Reset</button></span></div>`;
  introScoresCalcRender();
}

function introScoresCalcRender() {
  const S = INTRO.scores;
  const c = introIndivCalc(S.rows);
  const modified = S.rows.some((r) => r.agree !== r.agree0 || r.others !== r.others0);
  document.getElementById("introScoresCalc").innerHTML =
    inCalcRow("Consensus", "is-agree", c.cons, `${c.A} of ${c.N} answers match the majority = <strong>${inPct(c.cons)}</strong>`) +
    inCalcRow("Awareness", "is-expect", c.aw, `${c.B} of ${c.N} guesses match the majority = <strong>${inPct(c.aw)}</strong>`) +
    inCalcRow("Commonsensicality", "is-score", c.m, `${sqrtHtml(`${inPct(c.cons)} × ${inPct(c.aw)}`)} = <strong>${inPct(c.m)}</strong>`);
  const n = S.sorted.length;
  const below = inShareBelow(S.sorted, c.m);
  document.getElementById("introScoresPctl").innerHTML =
    (modified ? "With your changes, would score" : "Scores") +
    ` higher than <strong>${inPct(below, 0)}</strong> of the ${fmtNum(n)} participants in this view.`;
  const tag = document.getElementById("introScoresTag");
  tag.textContent = modified ? "What if…" : S.persona_obj.label;
  tag.classList.toggle("is-whatif", modified);
  const reset = document.querySelector('#introScoresEx [data-act="reset"]');
  if (reset) reset.hidden = !modified;
}

function introScoresInit() {
  const el = document.getElementById("introScoresEx");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const S = INTRO.scores;
    const pill = e.target.closest("button.intro-pill");
    if (pill && S.rows) {
      const r = S.rows[Number(pill.dataset.i)];
      if (pill.dataset.q === "agree") r.agree = 1 - r.agree; else r.others = 1 - r.others;
      // Update the pill in place so keyboard focus stays on it
      const v = pill.dataset.q === "agree" ? r.agree : r.others;
      const ok = v === r.maj;
      const flipped = pill.dataset.q === "agree" ? r.agree !== r.agree0 : r.others !== r.others0;
      pill.className = `intro-pill ${ok ? "is-match" : "is-miss"}${flipped ? " is-flipped" : ""}`;
      pill.innerHTML = `<span aria-hidden="true">${ok ? "✓" : "✗"}</span>${v ? "Yes" : "No"}`;
      pill.setAttribute("aria-label", `${v ? "Yes" : "No"}: ${ok ? "matches" : "misses"} the majority. Click to flip it.`);
      introScoresCalcRender();
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "another") introScoresNext();
    else if (act.dataset.act === "reset" && S.rows) {
      S.rows.forEach((r) => { r.agree = r.agree0; r.others = r.others0; });
      introScoresRender();
    } else if (act.dataset.act === "open" && S.user) {
      openUserDetail(S.user, { reference: (S.ctx && S.ctx.reference) || "all", target: (S.ctx && S.ctx.target) || "all" });
    }
  });
}

// ══ Statement Scores: a real statement, with sliders ═══════════════════════

const INTRO_STMT_TYPES = [
  {
    label: "Nearly universal",
    test: (r) => r.I_agree_mean >= 0.9 && r.others_agree_mean >= 0.9,
    lesson: "Almost everyone agrees, and almost everyone expects others to, so both parts are high.",
  },
  {
    label: "Mostly rejected",
    test: (r) => r.I_agree_mean <= 0.3 && r.others_agree_mean <= 0.5,
    // the best-known rejections make the point that rejection can be common sense
    sortBy: (a, b) => b.commonsensicality - a.commonsensicality,
    lesson: "Most people disagree, so awareness counts the raters who expected most others to disagree too.",
  },
  {
    label: "Split down the middle",
    test: (r) => Math.abs(r.I_agree_mean - 0.5) <= 0.05,
    lesson: "An even split leaves almost no consensus, so the score stays low however well people predict the vote.",
  },
  {
    label: "Misjudged majority",
    test: (r) => r.I_agree_mean <= 0.35 && r.others_agree_mean >= 0.55,
    lesson: "Most people disagree, yet most expected others to agree, so awareness is low.",
  },
  {
    label: "A typical statement",
    test: (r, med) => Math.abs(r.commonsensicality - med) <= 0.02,
    lesson: "Its score is close to the median of all statements in this group.",
  },
];

function introStmtLoad(data, ctx) {
  const T = INTRO.stmt;
  T.rows = data.rows || [];
  T.ctx = ctx;
  T.sorted = T.rows.map((r) => r.commonsensicality).sort((a, b) => a - b);
  T.type = -1;
  introStmtNext();
}

function introStmtNext() {
  const T = INTRO.stmt;
  const el = document.getElementById("introStmtEx");
  if (!el) return;
  if (!T.rows.length) {
    el.innerHTML = `<p class="intro-empty">No statements can be scored with these settings, so there is no example to show.</p>`;
    return;
  }
  const med = inMedian(T.sorted);
  // Prefer well-rated statements (most-rated first, unless the type says
  // otherwise), then pick at random among the top few
  const byN = (a, b) => b.n_ratings - a.n_ratings;
  let row = null, type = null;
  for (let k = 0; k < INTRO_STMT_TYPES.length && !row; k++) {
    T.type = (T.type + 1) % INTRO_STMT_TYPES.length;
    type = INTRO_STMT_TYPES[T.type];
    // Skip a type whose examples all rest on fewer than 20 ratings
    let cands = T.rows.filter((r) => r.n_ratings >= 20 && type.test(r, med));
    const well = cands.filter((r) => r.n_ratings >= 100);
    if (well.length >= 3) cands = well;
    else if (cands.some((r) => r.n_ratings >= 30)) cands = cands.filter((r) => r.n_ratings >= 30);
    cands.sort(type.sortBy || byN);
    if (cands.length) row = inPick(cands);
  }
  if (!row) { row = inPick(T.rows.slice().sort(byN)); type = { label: "A statement", lesson: "" }; }
  T.ex = { row, type, p: row.I_agree_mean, q: row.others_agree_mean };
  introStmtRender();
}

function introStmtCalc(p, q) {
  const majAgree = p >= 0.5; // ties count as agree, as in utils.py
  const cons = 2 * Math.abs(p - 0.5);
  const aw = majAgree ? q : 1 - q;
  return { majAgree, cons, aw, m: Math.sqrt(cons * aw) };
}

function introStmtRender() {
  const T = INTRO.stmt;
  const el = document.getElementById("introStmtEx");
  const { row, type } = T.ex;
  const groupLabel = inGroupLabel(T.ctx && T.ctx.country);
  const slider = (key, label, cls, v) =>
    `<label class="intro-slider"><span class="intro-slider-label"><i class="intro-key ${cls}" aria-hidden="true"></i>${label}</span>` +
    `<input type="range" class="intro-range ${cls}" min="0" max="1000" step="1" value="${Math.round(v * 1000)}" data-k="${key}" aria-label="${label}" style="--pct:${(v * 100).toFixed(1)}%">` +
    `<output id="introStmtOut_${key}">${inPct2(v)}</output></label>`;
  el.innerHTML =
    `<div class="intro-ex-head">` +
      `<span class="intro-ex-kicker">Worked example <span class="intro-tag" id="introStmtTag">${esc(type.label)}</span></span>` +
      `<button type="button" class="intro-btn" data-act="another">Another statement ↻</button>` +
    `</div>` +
    `<blockquote class="intro-quote">${esc(fixStatement(row.statement))}</blockquote>` +
    `<div class="intro-ex-meta">${fmtNum(row.n_ratings)} ratings in ${esc(groupLabel)} · <button type="button" class="intro-link" data-act="open">see it in full</button></div>` +
    `<div class="intro-sliders">` +
      slider("p", "Agree", "is-agree", T.ex.p) +
      slider("q", "Think most others agree", "is-expect", T.ex.q) +
    `</div>` +
    `<div class="intro-calc" id="introStmtCalc"></div>` +
    `<p class="intro-lesson" id="introStmtLesson">${esc(type.lesson)}</p>` +
    `<div class="intro-ex-foot"><span class="intro-hint" id="introStmtPctl"></span>` +
      `<span class="intro-hint"><strong>Try it:</strong> drag the sliders. <button type="button" class="intro-link" data-act="reset" hidden>Back to the real numbers</button></span></div>`;
  introStmtCalcRender();
}

function introStmtCalcRender() {
  const T = INTRO.stmt;
  const { p, q, row, type } = T.ex;
  const modified = Math.abs(p - row.I_agree_mean) > 1e-9 || Math.abs(q - row.others_agree_mean) > 1e-9;
  // Computed from the 4-decimal shares the server sends, so the arithmetic on
  // screen checks out; it can differ from the table's value (computed before
  // rounding) by at most about 0.05 points.
  const c = introStmtCalc(p, q);
  const majWord = c.majAgree ? "agree" : "disagree";
  const awMath = c.majAgree
    ? `expected most to agree: <strong>${inPct2(c.aw)}</strong>`
    : `expected most to disagree: 100% − ${inPct2(q)} = <strong>${inPct2(c.aw)}</strong>`;
  document.getElementById("introStmtCalc").innerHTML =
    `<span class="intro-calc-majority">Majority: <strong>${majWord}</strong>, since ${inPct2(p)} ${c.majAgree ? "≥" : "<"} 50% agree${p === 0.5 ? " (a tie counts as agree)" : ""}.</span>` +
    inCalcRow("Consensus", "is-agree", c.cons, `2 × |${inPct2(p)} − 50%| = <strong>${inPct2(c.cons)}</strong>`) +
    inCalcRow("Awareness", "is-expect", c.aw, awMath) +
    inCalcRow("Commonsensicality", "is-score", c.m, `${sqrtHtml(`${inPct2(c.cons)} × ${inPct2(c.aw)}`)} = <strong>${inPct2(c.m)}</strong>`);
  document.getElementById("introStmtPctl").innerHTML =
    (modified ? "These numbers would score" : "Scores") +
    ` higher than <strong>${inPct(inShareBelow(T.sorted, c.m), 0)}</strong> of the ${fmtNum(T.sorted.length)} statements in this group.`;
  const tag = document.getElementById("introStmtTag");
  tag.textContent = modified ? "What if…" : type.label;
  tag.classList.toggle("is-whatif", modified);
  document.getElementById("introStmtLesson").hidden = modified || !type.lesson;
  document.getElementById("introStmtOut_p").textContent = inPct2(p);
  document.getElementById("introStmtOut_q").textContent = inPct2(q);
  const reset = document.querySelector('#introStmtEx [data-act="reset"]');
  if (reset) reset.hidden = !modified;
}

function introStmtInit() {
  const el = document.getElementById("introStmtEx");
  if (!el) return;
  el.addEventListener("input", (e) => {
    const r = e.target.closest(".intro-range");
    if (!r || !INTRO.stmt.ex) return;
    INTRO.stmt.ex[r.dataset.k] = Number(r.value) / 1000;
    r.style.setProperty("--pct", `${(Number(r.value) / 10).toFixed(1)}%`);
    introStmtCalcRender();
  });
  el.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    const T = INTRO.stmt;
    if (!act || !T.ex) return;
    if (act.dataset.act === "another") introStmtNext();
    else if (act.dataset.act === "reset") {
      T.ex.p = T.ex.row.I_agree_mean;
      T.ex.q = T.ex.row.others_agree_mean;
      introStmtRender();
    } else if (act.dataset.act === "open") openStmtCombined(T.ex.row);
  });
}

// ══ Design Points: build a design point ════════════════════════════════════

// Short names for the two sides of each feature (full definitions: PROP_DEFS)
const INTRO_DP_NAMES = {
  fact: ["Fact", "Opinion"],
  physical: ["Physical", "Social"],
  literal_language: ["Literal", "Figurative"],
  positive: ["Positive", "Normative"],
  knowledge: ["Knowledge", "Reasoning"],
  everyday: ["Everyday", "Abstract"],
};

function introDpLoad(data, ctx) {
  const D = INTRO.dp;
  D.data = data;
  D.ctx = ctx;
  introDpSelectTop();
  introDpRenderBuilder();
}

// Start from the top-ranked design point of the current group and dates
// (or the one with the most statements if none can be ranked)
function introDpSelectTop() {
  const D = INTRO.dp;
  const top = ((D.data && D.data.rows) || [])[0] || ((D.data && D.data.rows_excluded) || [])[0];
  D.sel = Object.fromEntries(DP_PROPS.map((p) => [p.key, top ? top[p.key] : 1]));
}

function introDpRenderBuilder() {
  const D = INTRO.dp;
  const el = document.getElementById("introDpEx");
  if (!el) return;
  const gloss = (key, v) => {
    const f = typeof HS_FEATURES !== "undefined" ? HS_FEATURES[key] : null;
    return f ? (v ? f.d1 : f.d0) : "";
  };
  el.innerHTML =
    `<div class="intro-ex-head"><span class="intro-ex-kicker">Try it <span class="intro-tag">Build a design point</span></span>` +
      `<button type="button" class="intro-btn" data-act="top">Top-ranked ↺</button></div>` +
    `<div class="intro-feats">` +
    DP_PROPS.map((p) => {
      const [n1, n0] = INTRO_DP_NAMES[p.key];
      const v = D.sel[p.key];
      return (
        `<div class="intro-feat"><div class="intro-seg" role="group" aria-label="${esc(n1)} or ${esc(n0)}">` +
        `<button type="button" class="intro-seg-btn" data-k="${p.key}" data-v="1" aria-pressed="${v === 1}">${esc(n1)}</button>` +
        `<button type="button" class="intro-seg-btn" data-k="${p.key}" data-v="0" aria-pressed="${v === 0}">${esc(n0)}</button>` +
        `</div><div class="intro-feat-gloss" data-gloss="${p.key}">${esc(capFirst(gloss(p.key, v)))}</div></div>`
      );
    }).join("") +
    `</div>` +
    `<div class="intro-dp-result" id="introDpResult" aria-live="polite"></div>`;
  introDpRenderResult();
}

function introDpFind() {
  const D = INTRO.dp;
  const match = (r) => DP_PROPS.every((p) => r[p.key] === D.sel[p.key]);
  const ranked = (D.data && D.data.rows) || [];
  const i = ranked.findIndex(match);
  if (i >= 0) return { row: ranked[i], rank: i + 1, of: ranked.length };
  const ex = ((D.data && D.data.rows_excluded) || []).find(match);
  return { row: ex || null, rank: null, of: ranked.length };
}

function introDpRenderResult() {
  const D = INTRO.dp;
  const out = document.getElementById("introDpResult");
  if (!out) return;
  const { row, rank, of } = introDpFind();
  const code = DP_PROPS.map((p) => (D.sel[p.key] ? "●" : "○")).join("");
  const names = DP_PROPS.map((p) => INTRO_DP_NAMES[p.key][D.sel[p.key] ? 0 : 1]).join(" · ");
  let html =
    `<div class="intro-dp-top"><span class="intro-dp-code" aria-hidden="true">${code}</span><strong>${esc(names)}</strong></div>`;
  if (rank) {
    const ci = row.ci_lo != null && row.ci_hi != null ? `95% CI ${inPct(row.ci_lo)} – ${inPct(row.ci_hi)}` : "no CI";
    html +=
      `<div class="intro-dp-top" style="margin-top:4px"><span class="intro-dp-score">${inPct(row.mean)}</span>` +
      `<span class="intro-dp-rank">average score · rank <strong>${rank}</strong> of ${of} · ${fmtNum(row.n)} statements · ${ci}</span></div>` +
      `<div class="intro-dp-ci" aria-hidden="true"><span>0%</span>${dpCiSvg(row.mean, row.ci_lo, row.ci_hi)}<span>100%</span></div>` +
      `<div class="intro-dp-ex" id="introDpExample"></div>` +
      `<div class="intro-dp-actions"><button type="button" class="intro-link" data-act="show">Show all ${fmtNum(row.n)} statements in the table ↓</button></div>`;
  } else if (row && row.n > 0) {
    html += `<p class="intro-dp-ex">Only ${fmtNum(row.n)} scored statement${row.n === 1 ? "" : "s"} of this kind, fewer than the 5 needed to rank it.</p><div class="intro-dp-ex" id="introDpExample"></div>`;
  } else {
    html += `<p class="intro-dp-ex">No scored statements of this kind yet${D.ctx && D.ctx.country && D.ctx.country !== "all" ? ` in ${esc(D.ctx.country)}` : ""}.</p>`;
  }
  out.innerHTML = html;
  if (row && row.n > 0) {
    clearTimeout(D.timer);
    D.timer = setTimeout(introDpFetchExample, 150);
  }
}

async function introDpFetchExample() {
  const D = INTRO.dp;
  const req = ++D.req;
  const country = (D.ctx && D.ctx.country) || "all";
  const qs = DP_PROPS.map((p) => `&${p.key}=${D.sel[p.key]}`).join("");
  let d;
  try {
    d = await fetch(`${API}/dp-statements?country=${encodeURIComponent(country)}${qs}${dateParams()}`).then((r) => r.json());
  } catch { return; }
  if (req !== D.req) return;
  const target = document.getElementById("introDpExample");
  if (!target) return;
  const best = (d.rows || []).find((r) => r.qualified);
  target.innerHTML = best
    ? `Most-rated example: <span class="intro-quote">“${esc(fixStatement(best.statement))}”</span> scores <strong>${inPct(best.commonsensicality)}</strong> from ${fmtNum(best.n_ratings)} ratings.`
    : "";
}

function introDpInit() {
  const el = document.getElementById("introDpEx");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const D = INTRO.dp;
    if (!D.data) return;
    const seg = e.target.closest(".intro-seg-btn");
    if (seg) {
      D.sel[seg.dataset.k] = Number(seg.dataset.v);
      seg.parentElement.querySelectorAll(".intro-seg-btn").forEach((b) => b.setAttribute("aria-pressed", String(b === seg)));
      const f = typeof HS_FEATURES !== "undefined" ? HS_FEATURES[seg.dataset.k] : null;
      const g = el.querySelector(`[data-gloss="${seg.dataset.k}"]`);
      if (g && f) g.textContent = capFirst(Number(seg.dataset.v) ? f.d1 : f.d0);
      introDpRenderResult();
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "top") {
      introDpSelectTop();
      introDpRenderBuilder();
    } else if (act.dataset.act === "show") {
      // app.js writes these as data-<key> with the key's underscores kept
      const sel = DP_PROPS.map((p) => `[data-${p.key}="${D.sel[p.key]}"]`).join("");
      const tr = document.querySelector(`#dpTableContainer tr.dp-clickable${sel}`);
      if (!tr) return;
      if (!tr.classList.contains("dp-selected")) tr.click();
      tr.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

// ══ Group Comparison: quick picks ══════════════════════════════════════════

const INTRO_PAIRS = [
  ["United Kingdom", "United States"],
  ["United States", "India"],
  ["United Kingdom", "Nigeria"],
  ["Australia", "New Zealand"],
  ["all", "Canada"],
];

function introCompareRender() {
  const el = document.getElementById("introCompareChips");
  if (!el || typeof compareGroupAEl === "undefined") return;
  const has = (v) => v === "all" || [...compareGroupAEl.options].some((o) => o.value === v);
  const pairs = INTRO_PAIRS.filter(([a, b]) => has(a) && has(b));
  el.innerHTML = pairs.length
    ? `<span class="intro-chips-label">Try:</span>` +
      pairs
        .map(([a, b]) => `<button type="button" class="intro-chip" data-a="${esc(a)}" data-b="${esc(b)}" aria-pressed="false">${esc(inGroupLabel(a))} vs ${esc(inGroupLabel(b))}</button>`)
        .join("")
    : "";
  introCompareSync({ groupA: compareGroupAEl.value, groupB: compareGroupBEl.value });
}

function introCompareSync(ctx) {
  const el = document.getElementById("introCompareChips");
  if (!el) return;
  if (!el.children.length && compareGroupAEl.options.length > 1) { introCompareRender(); return; }
  el.querySelectorAll(".intro-chip").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.a === ctx.groupA && b.dataset.b === ctx.groupB)),
  );
}

function introCompareInit() {
  const el = document.getElementById("introCompareChips");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".intro-chip");
    if (!b) return;
    compareGroupAEl.value = b.dataset.a;
    compareGroupBEl.value = b.dataset.b;
    loadGroupCompare();
  });
}

// ══ Countries: one statement, two countries ════════════════════════════════

// An intuitive first example when the date filter leaves it enough ratings;
// after it, the statements with the widest gap between well-rated countries.
const INTRO_COUNTRY_FIRST = 8863; // "Birds fly south for the winter."
const INTRO_COUNTRY_MIN_N = 30;

function introCountriesLoad(data) {
  const C = INTRO.countries;
  C.data = data;
  const list = [];
  (data.rows || []).forEach((r) => {
    const cells = Object.entries(r.scores || {}).filter(([, v]) => v && v.s != null && v.n >= INTRO_COUNTRY_MIN_N);
    if (cells.length < 2) return;
    cells.sort((a, b) => b[1].s - a[1].s);
    const [hi, lo] = [cells[0], cells[cells.length - 1]];
    list.push({ id: r.statementId, text: r.statement, hi: hi[0], lo: lo[0], gap: hi[1].s - lo[1].s });
  });
  list.sort((a, b) => b.gap - a.gap);
  const first = list.findIndex((x) => x.id === INTRO_COUNTRY_FIRST && x.gap >= 15);
  if (first > 0) list.unshift(list.splice(first, 1)[0]);
  C.list = list.slice(0, 15);
  C.i = -1;
  introCountriesNext();
}

async function introCountriesNext() {
  const C = INTRO.countries;
  const el = document.getElementById("introCountriesEx");
  if (!el) return;
  if (!C.list.length) {
    el.innerHTML = `<p class="intro-empty">No statement has ${INTRO_COUNTRY_MIN_N}+ ratings in two countries with these settings, so there is no example to show.</p>`;
    return;
  }
  C.i = (C.i + 1) % C.list.length;
  const ex = C.list[C.i];
  const req = ++C.req;
  let cells;
  try {
    cells = await Promise.all(
      [ex.hi, ex.lo].map((c) =>
        fetch(`${API}/country-cell?statementId=${encodeURIComponent(ex.id)}&country=${encodeURIComponent(c)}${dateParams()}`).then((r) => r.json()),
      ),
    );
  } catch {
    if (req === C.req) el.innerHTML = `<p class="intro-empty">The example could not be loaded.</p>`;
    return;
  }
  if (req !== C.req || cells.some((c) => c.error)) return;
  const tile = (country, c) => {
    const s = introStmtCalc(c.I_agree_mean, c.others_agree_mean);
    return (
      `<div class="intro-country">` +
      `<div class="intro-country-head"><span class="intro-country-name">${countryFlag(country)} ${esc(country)}</span><span class="intro-country-score">${(s.m * 100).toFixed(1)}</span></div>` +
      inDualBar("Agree", c.I_agree_mean, IN_AGREE) +
      inDualBar("Think most agree", c.others_agree_mean, IN_EXPECT) +
      `<div class="intro-country-n">${fmtNum(c.n_ratings)} ratings · majority ${s.majAgree ? "agrees" : "disagrees"}</div>` +
      `</div>`
    );
  };
  const [a, b] = cells;
  const flip = (a.I_agree_mean >= 0.5) !== (b.I_agree_mean >= 0.5);
  el.innerHTML =
    `<div class="intro-ex-head"><span class="intro-ex-kicker">Example <span class="intro-tag">Same statement, two countries</span></span>` +
      `<button type="button" class="intro-btn" data-act="another">Another statement ↻</button></div>` +
    `<blockquote class="intro-quote">${esc(fixStatement(a.statement || ex.text))}</blockquote>` +
    `<div class="intro-pair">${tile(ex.hi, a)}${tile(ex.lo, b)}</div>` +
    `<p class="intro-pair-note">` +
      (flip
        ? `Here the two majorities point opposite ways. Each score only says how widely the country's own majority view is shared and expected.`
        : `Both majorities ${a.I_agree_mean >= 0.5 ? "agree" : "disagree"}, but that view is more widely shared, and more widely expected, in ${esc(inTheCountry(ex.hi))}.`) +
      ` Among countries with ${INTRO_COUNTRY_MIN_N}+ ratings of this statement, these are the highest and lowest scores.</p>`;
}

function introCountriesInit() {
  const el = document.getElementById("introCountriesEx");
  if (!el) return;
  el.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="another"]')) introCountriesNext();
  });
}

// ── Init ────────────────────────────────────────────────────────────────────

function introInit() {
  introInitToggles();
  introScoresInit();
  introStmtInit();
  introDpInit();
  introCompareInit();
  introCountriesInit();
  // Data that arrived before this file loaded (app.js starts its requests first)
  if (typeof stmtScoresAllRows !== "undefined" && stmtScoresAllRows.length && !INTRO.stmt.rows.length) {
    introStmtLoad({ rows: stmtScoresAllRows }, { country: stmtScoresCountrySelect.value });
  }
}

introInit();
