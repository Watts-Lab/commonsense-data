"use strict";

// ══ Home / landing page ════════════════════════════════════════════════════
// Loaded after app.js and uses its globals: API, esc, fmtNum, dateParams,
// fixStatement, PROP_DEFS, switchToTab, renderWorldMap, _homeCountryData,
// _positionTooltip. Every live number comes from one request,
// /api/home-summary (get_home_summary() in server.py), which reads its scores
// back from the Individual Scores, Statement Scores and Design Points
// endpoints so the numbers here match those panels. The exception is section
// 5, on LLM evaluations: a separate study with fixed data, read once through
// llm.js (llmGet, llmSummaryStats, llmR, llmOrdinal, llmShowView).
//
// hsScore() restates the statement-level majority rule (utils.py) only to
// phrase the survey demo's feedback; scores shown on the page come from the
// server.

const HS = {
  data: null,   // last /api/home-summary payload
  key: null,    // dateParams() the payload belongs to
  req: 0,       // request counter, so a stale response is dropped
  ticker: { items: [], i: 0, timer: null, paused: false },
  demo: { pool: [], item: null, agree: null, others: null },
  lastWidth: 0,
  llm: null,        // /api/llm-evals summary via llmSummaryStats() (llm.js)
  llmLoading: false,
};

const HS_REDUCED =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Tokens, not resolved colours, so the bars follow a theme change
const HS_AGREE = "var(--c-agree)";   // share who agree
const HS_EXPECT = "var(--c-expect)"; // share who think most others agree

// The kinds of example statement /api/home-summary returns (its "examples"),
// used to vary the hero card and the survey demo. They are not shown as labels.
const HS_EXAMPLE_KINDS = ["universal", "divisive", "underestimated", "rejected", "overestimated"];

// One-line glosses of the six features (full definitions: PROP_DEFS in app.js);
// intro.js reads them too.
const HS_FEATURES = {
  fact:             { d1: "can be shown true or false",  d0: "a matter of opinion" },
  physical:         { d1: "about the natural world",     d0: "about people and society" },
  literal_language: { d1: "means exactly what it says",  d0: "metaphor, aphorism, hyperbole" },
  positive:         { d1: "says how things are",         d0: "says how things should be" },
  knowledge:        { d1: "an observation",              d0: "a conclusion drawn by reasoning" },
  everyday:         { d1: "part of ordinary experience", d0: "beyond what one person can see" },
};

// ── Small helpers ───────────────────────────────────────────────────────────

function hsScore(p, q) {
  const majAgree = p >= 0.5; // ties count as agree, as in utils.py
  return { majAgree, a: majAgree ? q : 1 - q };
}

function hsPct(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  // Never round a non-unanimous share up to 100% (or a non-zero one down to
  // 0%): show one decimal, truncated towards 50% so 99.96% reads 99.9%
  if (digits === 0 && v < 1 && Math.round(v * 100) === 100) return `${(Math.floor(v * 1000) / 10).toFixed(1)}%`;
  if (digits === 0 && v > 0 && Math.round(v * 100) === 0) return `${(Math.ceil(v * 1000) / 10).toFixed(1)}%`;
  return `${(v * 100).toFixed(digits)}%`;
}

// A share read against the 50% majority line: one decimal, rounded away from
// 50%, when whole percents would show 50% (so a 49.5% share that makes
// "disagree" the majority never reads as 50%)
function hsMajPct(v) {
  if (v !== 0.5 && Math.round(v * 100) === 50) {
    return `${((v < 0.5 ? Math.floor(v * 1000) : Math.ceil(v * 1000)) / 10).toFixed(1)}%`;
  }
  return hsPct(v);
}

function hsGet(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function hsDate(s) {
  if (!s) return "";
  return new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function hsSvg(tag, attrs = {}, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

function hsPropLabel(key, val) {
  const d = PROP_DEFS.find((x) => x.key === key);
  return d ? (val ? d.v1 : d.v0) : key;
}

const hsTipEl = document.getElementById("hsTip");
function hsTipShow(html, e) {
  hsTipEl.innerHTML = html;
  hsTipEl.hidden = false;
  requestAnimationFrame(() => _positionTooltip(hsTipEl, e.clientX, e.clientY));
}
function hsTipHide() { hsTipEl.hidden = true; }

function hsCountUp(el, target) {
  const fmt = (x) => fmtNum(Math.round(x));
  if (HS_REDUCED || !Number.isFinite(target)) { el.textContent = fmt(target); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = fmt(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Two bars: share who agree and share who think most others agree, with a
// tick at 50% (the majority line).
function hsDualBars(p, q) {
  const row = (label, v, color) =>
    `<div class="hs-dbar"><span class="hs-dbar-label">${label}</span>` +
    `<span class="hs-dbar-track"><span class="hs-dbar-fill" style="width:${(v * 100).toFixed(1)}%;background:${color}"></span><span class="hs-dbar-mid" aria-hidden="true"></span></span>` +
    `<span class="hs-dbar-val">${hsMajPct(v)}</span></div>`;
  return row("Agree", p, HS_AGREE) + row("Think most others agree", q, HS_EXPECT);
}

// Redraws the two bars in place when they are already drawn: the fills slide
// to their new lengths (CSS transition, HS_BAR_MS) and the numbers count to
// their new values, so the hero card changes statement without blinking
const HS_BAR_MS = 450;
function hsSetDualBars(el, p, q) {
  const fills = el.querySelectorAll(".hs-dbar-fill"), vals = el.querySelectorAll(".hs-dbar-val");
  if (fills.length !== 2 || vals.length !== 2) {
    el.innerHTML = hsDualBars(p, q);
    el.querySelectorAll(".hs-dbar-val").forEach((v, i) => { v._hsV = i ? q : p; });
    return;
  }
  [p, q].forEach((v, i) => {
    fills[i].style.width = `${(v * 100).toFixed(1)}%`;
    hsTweenPct(vals[i], v);
  });
}

function hsTweenPct(el, to) {
  const from = el._hsV;
  el._hsV = to;
  cancelAnimationFrame(el._hsRaf);
  if (HS_REDUCED || from === undefined || from === to) { el.textContent = hsMajPct(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / HS_BAR_MS);
    el.textContent = hsMajPct(k < 1 ? from + (to - from) * (1 - Math.pow(1 - k, 3)) : to);
    if (k < 1) el._hsRaf = requestAnimationFrame(step);
  };
  el._hsRaf = requestAnimationFrame(step);
}

// The hero card's reading of the bars: which way the majority went. Within
// 3 points of 50% it says the vote is split rather than calling 50.3% "the
// majority of people".
function hsMajoritySentence(p) {
  if (Math.abs(p - 0.5) < 0.0005) return "Exactly half of people agree with this statement.";
  if (p === 1 || p === 0) return `Everyone (100%) ${p ? "agrees" : "disagrees"} with this statement.`;
  if (Math.abs(p - 0.5) < 0.03) return `People are split almost evenly: ${hsMajPct(p > 0.5 ? p : 1 - p)} ${p > 0.5 ? "agree" : "disagree"}.`;
  return p > 0.5
    ? `The majority of people (${hsMajPct(p)}) agree with this statement.`
    : `The majority of people (${hsMajPct(1 - p)}) disagree with this statement.`;
}

// Score pill colour: one blue ramp (--c-ramp-0 … 5 in style.css), light (low)
// to deep (high) on the light theme and dim to bright on the dark one. Its
// text is --c-ramp-ink-hi on the two strongest steps and --c-ramp-ink-lo on
// the rest, so it clears 4.5:1 in both themes.
const HS_SCORE_STOPS = [0, 1, 2, 3, 4, 5].map((i) => `var(--c-ramp-${i})`);
function hsScoreStep(m) {
  return Math.min(HS_SCORE_STOPS.length - 1, Math.max(0, Math.floor(m * HS_SCORE_STOPS.length)));
}
function hsScoreColor(m) {
  return HS_SCORE_STOPS[hsScoreStep(m)];
}
function hsScoreInk(m) {
  return hsScoreStep(m) >= 4 ? "var(--c-ramp-ink-hi)" : "var(--c-ramp-ink-lo)";
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadHomeSummary() {
  hsLoadLlm(); // its own fixed data: loaded once, whatever the date filter
  const key = dateParams();
  // Same data: only redraw the width-dependent chart if the panel was hidden or resized
  if (HS.key === key && HS.data) { hsOnResize(); return; }
  HS.key = key;
  const req = ++HS.req;
  const stamp = document.getElementById("hsStamp");
  if (!HS.data) stamp.textContent = "Loading live data…";
  let d;
  try {
    const r = await fetch(`${API}/home-summary${key.replace(/^&/, "?")}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (err) {
    if (req !== HS.req) return;
    console.error("loadHomeSummary failed:", err);
    HS.key = null;
    stamp.textContent = "Live numbers could not be loaded. Try refreshing the page.";
    return;
  }
  if (req !== HS.req) return; // superseded by a newer date filter
  HS.data = d;
  HS.lastWidth = document.getElementById("homeScroll").clientWidth;
  const steps = [
    hsFillFields, hsRenderStamp, hsRenderTicker, hsRenderDemoPool, hsRenderComposition,
    hsRenderLadder, hsRenderIndivHist, hsRenderFeatures, hsRenderCorners, hsRenderDataNote,
  ];
  for (const fn of steps) {
    try { fn(d); } catch (err) { console.error(`Home: ${fn.name} failed:`, err); }
  }
}

// ── Hero ────────────────────────────────────────────────────────────────────

function hsFillFields(d) {
  document.querySelectorAll("#panelHome [data-h]").forEach((el) => {
    const v = hsGet(d, el.dataset.h);
    if (v === undefined || v === null) { el.textContent = "—"; return; }
    if (el.classList.contains("hs-counter-num")) hsCountUp(el, v);
    else el.textContent = typeof v === "number" ? fmtNum(Math.round(v)) : v;
  });
}

function hsRenderStamp(d) {
  const t = d.totals;
  const stamp = document.getElementById("hsStamp");
  if (!t.ratings) { stamp.textContent = "No ratings in the selected date range."; return; }
  stamp.textContent = d.date_from || d.date_to
    ? `Date filter on: ratings from ${hsDate(t.first_date)} to ${hsDate(t.last_date)}.`
    : `Ratings from ${hsDate(t.first_date)} to ${hsDate(t.last_date)}, updated every other day.`;
}

function hsRenderTicker(d) {
  const ex = d.examples || {};
  const items = [];
  for (let i = 0; i < 3; i++) {
    for (const cat of HS_EXAMPLE_KINDS) {
      const s = (ex[cat] || [])[i];
      if (s && !items.some((x) => x.id === s.id)) items.push({ ...s, cat });
    }
  }
  HS.ticker.items = items;
  HS.ticker.i = 0;
  hsShowTicker();
  clearInterval(HS.ticker.timer);
  if (!HS_REDUCED && items.length > 1) {
    HS.ticker.timer = setInterval(() => {
      if (HS.ticker.paused || document.getElementById("panelHome").classList.contains("hidden")) return;
      HS.ticker.i = (HS.ticker.i + 1) % HS.ticker.items.length;
      hsShowTicker();
    }, 6500);
  }
}

// The card has a fixed size, so the arrows never move. The statement is
// centred vertically in the space above the bars (smaller type for longer
// statements), then come how many people rated it, the two bars and one
// sentence on the majority. A new statement swaps the text and slides the
// bars and their numbers (hsSetDualBars()) rather than fading the card. The
// statement score isn't shown: the page defines it only in section 3.
function hsShowTicker() {
  const s = HS.ticker.items[HS.ticker.i];
  const quote = document.getElementById("hsTickerQuote");
  const count = document.getElementById("hsTickerCount");
  const bars = document.getElementById("hsTickerBars");
  const maj = document.getElementById("hsTickerMajority");
  if (!s) {
    quote.textContent = "Not enough ratings in this date range.";
    quote.title = "";
    quote.classList.remove("is-long", "is-longer");
    bars.innerHTML = count.textContent = maj.textContent = "";
    return;
  }
  const text = fixStatement(s.text);
  quote.textContent = text;
  quote.title = text;
  quote.classList.toggle("is-long", text.length > 80 && text.length <= 120);
  quote.classList.toggle("is-longer", text.length > 120);
  count.textContent = `Rated by ${fmtNum(s.n)} people`;
  hsSetDualBars(bars, s.p, s.q);
  maj.textContent = hsMajoritySentence(s.p);
}

// ── 1 The survey: try the two questions on one statement ──────────────────

function hsRenderDemoPool(d) {
  const ex = d.examples || {};
  // Statements other than the hero card's (hsRenderTicker() runs first), the
  // two most obvious ones skipped and the texts kept short
  const inHero = new Set(HS.ticker.items.map((s) => s.id));
  const seen = new Set(), pool = [], spare = [];
  for (const cat of HS_EXAMPLE_KINDS) {
    for (const s of (ex[cat] || []).slice(cat === "universal" ? 2 : 0)) {
      if (seen.has(s.id) || s.text.length > 110) continue;
      seen.add(s.id);
      (inHero.has(s.id) ? spare : pool).push(s);
    }
  }
  // Short date ranges have few examples: fall back to the hero's statements
  HS.demo.pool = pool.length >= 2 ? pool : pool.concat(spare);
  HS.demo.item = null;
  hsNewDemo();
}

function hsNewDemo() {
  const pool = HS.demo.pool.filter((s) => !HS.demo.item || s.id !== HS.demo.item.id);
  HS.demo.item = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  HS.demo.agree = HS.demo.others = null;
  hsRenderDemo();
}

// The statement and its two questions on the left, the results on the right
// (below on phones). Drawn once per statement; answering only updates the
// buttons and the results (hsUpdateDemo()).
function hsRenderDemo() {
  const el = document.getElementById("hsDemo");
  const s = HS.demo.item;
  if (!s) { el.innerHTML = `<p class="hs-empty">Not enough rated statements in this date range.</p>`; return; }
  const btn = (q, v, label) =>
    `<button type="button" class="hs-choice-btn" data-q="${q}" data-v="${v}" aria-pressed="false">${label}</button>`;
  el.innerHTML =
    `<div class="hs-demo-head"><button type="button" class="hs-link-btn" id="hsDemoNext">Try another statement</button></div>` +
    `<div class="hs-demo-grid">` +
    `<div class="hs-demo-ask">` +
    `<blockquote class="hs-quote hs-demo-quote">${esc(fixStatement(s.text))}</blockquote>` +
    `<div class="hs-q"><span class="hs-q-num" aria-hidden="true">1</span><div><div class="hs-q-text" id="hsQ1">Do you agree with this statement?</div>` +
    `<div class="hs-choice" role="group" aria-labelledby="hsQ1">${btn("agree", true, "Agree")}${btn("agree", false, "Disagree")}</div></div></div>` +
    `<div class="hs-q"><span class="hs-q-num" aria-hidden="true">2</span><div><div class="hs-q-text" id="hsQ2">Do you think most other people would agree with it?</div>` +
    `<div class="hs-choice" role="group" aria-labelledby="hsQ2">${btn("others", true, "Yes, most would")}${btn("others", false, "No, most would not")}</div></div></div>` +
    `</div>` +
    `<div class="hs-demo-result" id="hsDemoResult" aria-live="polite"></div>` +
    `</div>`;
  el.querySelectorAll(".hs-choice-btn").forEach((b) =>
    b.addEventListener("click", () => {
      HS.demo[b.dataset.q] = b.dataset.v === "true";
      hsUpdateDemo();
    }),
  );
  document.getElementById("hsDemoNext").addEventListener("click", hsNewDemo);
  hsUpdateDemo();
}

function hsUpdateDemo() {
  const s = HS.demo.item;
  const { agree, others } = HS.demo;
  const done = agree !== null && others !== null;
  document.querySelectorAll("#hsDemo .hs-choice-btn").forEach((b) => {
    b.setAttribute("aria-pressed", String(HS.demo[b.dataset.q] === (b.dataset.v === "true")));
    b.disabled = done;
  });
  const res = document.getElementById("hsDemoResult");
  res.classList.toggle("is-done", done);
  res.innerHTML = done
    ? hsDemoResultHtml(s, agree, others)
    : `<p class="hs-demo-wait">Answer both questions to see how ${fmtNum(s.n)} participants answered, and how your answers compare.</p>`;
  hsBindScrollLinks(res);
}

// The demo card's one bar: the share who agree from the left and the share
// who disagree from the right, the majority blue and the minority grey
// (a tie counts as agree), with a tick at 50% (the majority line). The
// disagree share is 100 minus the agree share as shown, so the two printed
// numbers always add up to 100%.
function hsSplitPcts(p) {
  const a = hsMajPct(p);
  const m = /^([\d.]+)%$/.exec(a);
  if (!m) return [a, hsMajPct(1 - p)];
  const dec = (m[1].split(".")[1] || "").length;
  return [a, `${(100 - parseFloat(m[1])).toFixed(dec)}%`];
}
function hsSplitBar(p) {
  const [a, d] = hsSplitPcts(p);
  const fill = (cls, v) => (v > 0 ? `<span class="hs-split-fill ${cls}" style="flex-grow:${v.toFixed(5)}"></span>` : "");
  return (
    `<div class="hs-split${p < 0.5 ? " is-maj-dis" : ""}" role="img" aria-label="${a} agree, ${d} disagree">` +
    `<div class="hs-split-labels" aria-hidden="true"><span class="is-agree">Agree <span class="hs-split-val">${a}</span></span>` +
    `<span class="is-dis"><span class="hs-split-val">${d}</span> Disagree</span></div>` +
    `<div class="hs-split-bar" aria-hidden="true"><div class="hs-split-track">${fill("is-agree", p)}${fill("is-dis", 1 - p)}</div>` +
    `<span class="hs-split-mid"></span></div></div>`
  );
}

// How everyone answered, then how the visitor's two answers compare with the
// majority. The majority rule (ties count as agree) is utils.py's, through
// hsScore(); an exact tie is described as no majority. One sentence a line;
// the verdicts are bold at Josh's request; the prediction sentence opens "You also" when both
// answers fare alike and "However, you" when they differ.
function hsDemoResultHtml(s, agree, others) {
  const sc = hsScore(s.p, s.q);
  const did = (v) => (v ? "agreed" : "disagreed");
  let explain;
  if (Math.abs(s.p - 0.5) < 0.0005) {
    explain = `<p>Exactly half of people agreed with this statement, so it has no majority rating: there is no majority to side with, or to predict.</p>`;
  } else {
    const ok1 = agree === sc.majAgree, ok2 = others === sc.majAgree;
    const [a, d] = hsSplitPcts(s.p);
    const unanimous = s.p === 1 || s.p === 0;
    const lead = `${unanimous ? "Everyone" : "Most people"} (${sc.majAgree ? a : d}) ${did(sc.majAgree)} with this statement.`;
    const own = ok1
      ? `<strong>You sided with the majority</strong> because you also ${did(agree)} with it.`
      : `<strong>You went against the majority</strong> because you ${did(agree)} with it.`;
    // The second question asks whether most others would agree, so the
    // prediction is "would agree" or "would not agree"
    const pred =
      `<strong>${ok1 === ok2 ? "You also" : "However, you"} ${ok2 ? "correctly" : "incorrectly"} predicted</strong> ` +
      `that most people ${others ? "would agree" : "would not agree"} with the statement.`;
    explain = `<p>${lead}</p><p>${own}</p><p>${pred}</p>`;
  }
  return (
    `<div class="hs-demo-reveal">` +
    `<div class="hs-reveal-head">How ${fmtNum(s.n)} participants answered</div>` +
    hsSplitBar(s.p) +
    `<div class="hs-explain">${explain}</div>` +
    `</div>`
  );
}

// ── 2 Who took part ────────────────────────────────────────────────────────

// Beside the map (two-column layout), the card takes the map card's height and
// lists as many countries as fit, the rest folded into "All other countries";
// stacked (phones), it lists HS_COMPOSITION_STACKED rows. The server sends up
// to _HOME_COMPOSITION_MAX countries (server.py). Redrawn whenever the map
// card's height changes (hsInitCompositionFit()).
const HS_COMPOSITION_STACKED = 10;
function hsRenderComposition(d) {
  const el = document.getElementById("hsComposition");
  const card = el.closest(".hs-composition");
  const map = document.getElementById("worldMapCard");
  const total = d.composition.reduce((s, r) => s + r.n, 0);
  if (!total) {
    card.style.height = "";
    el.innerHTML = `<p class="hs-empty">No participants in this range.</p>`;
    return;
  }
  const countries = d.composition.filter((r) => r.country !== "Other");
  const draw = (k) => {
    const shown = countries.slice(0, k);
    const rest = total - shown.reduce((s, r) => s + r.n, 0);
    const rows = rest > 0 ? [...shown, { country: "Other", n: rest }] : shown;
    const top = Math.max(...rows.map((r) => r.n));
    el.innerHTML = rows
      .map(
        (r) =>
          `<div class="hs-bl-row" title="${esc(r.country === "Other" ? "All other countries" : r.country)}: ${fmtNum(r.n)} participants">` +
          `<span class="hs-bl-label">${esc(r.country === "Other" ? "All other countries" : r.country)}</span>` +
          `<span class="hs-bl-track"><span class="hs-bl-fill${r.country === "Other" ? " muted" : ""}" style="width:${((r.n / top) * 100).toFixed(1)}%"></span></span>` +
          `<span class="hs-bl-val">${hsPct(r.n / total)}</span></div>`,
      )
      .join("");
  };
  const besideMap = getComputedStyle(card.parentElement).gridTemplateColumns.trim().split(/\s+/).length > 1;
  if (!besideMap || !map.offsetHeight) {
    card.style.height = "";
    draw(HS_COMPOSITION_STACKED - 1);
    return;
  }
  // Draw every country to measure a row, then keep the rows that fit
  card.style.height = `${map.offsetHeight}px`;
  draw(countries.length);
  const items = el.children;
  const rowH = items[0].offsetHeight;
  const pitch = items.length > 1 ? items[1].offsetTop - items[0].offsetTop : rowH;
  const fit = Math.floor((el.clientHeight + pitch - rowH) / pitch); // rows, "All other countries" included
  draw(Math.max(3, Math.min(countries.length, fit - 1)));
}

function hsInitCompositionFit() {
  const map = document.getElementById("worldMapCard");
  if (!("ResizeObserver" in window)) return;
  let lastH = 0, raf = 0;
  new ResizeObserver(() => {
    const h = map.offsetHeight;
    if (!h || h === lastH || !HS.data) return; // hidden panel, or no change
    lastH = h;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      try { hsRenderComposition(HS.data); } catch (err) { console.error("Home: composition resize failed:", err); }
    });
  }).observe(map);
}

// ── 3 The scores ───────────────────────────────────────────────────────────

function hsRenderLadder(d) {
  const el = document.getElementById("hsLadder");
  const rows = (d.scale || []).slice().sort((a, b) => b.m - a.m);
  el.innerHTML = rows.length
    ? rows
        .map(
          (s) =>
            `<span class="hs-rung"><span class="hs-rung-score" style="background:${hsScoreColor(s.m)};color:${hsScoreInk(s.m)}">${hsPct(s.m)}</span>` +
            `<span class="hs-quote">${esc(fixStatement(s.text))}</span></span>`,
        )
        .join("")
    : `<span class="hs-empty">No statements can be scored in this date range.</span>`;
  const st = d.statement;
  document.getElementById("hsStmtFoot").innerHTML = st.n
    ? `Total ${fmtNum(st.n)} statements scored`
    : "";
}

function hsRenderIndivHist(d) {
  const el = document.getElementById("hsIndivHist");
  el.innerHTML = "";
  const ind = d.individual;
  document.getElementById("hsIndivFoot").innerHTML = ind.n
    ? `Total ${fmtNum(ind.n)} people scored`
    : "";
  if (!ind.n) { el.innerHTML = `<span class="hs-empty">No participants can be scored in this date range.</span>`; return; }
  const { counts, bin_edges: edges } = ind.histogram;
  // Drawn at the container's pixel size so text stays legible on phones and
  // the bars fill the card: the empty container stretches (flex: 1) to the
  // height the statement card beside it gives the row
  const W = Math.max(260, Math.round(el.clientWidth || 480));
  const H = Math.max(166, Math.floor(el.clientHeight || 0)), L = 8, R = 8, T = 8, B = 26;
  const PW = W - L - R, PH = H - T - B;
  const max = Math.max(...counts, 1);
  const svg = hsSvg("svg", { viewBox: `0 0 ${W} ${H}`, class: "hs-hist-svg", role: "img", "aria-label": `Histogram of ${fmtNum(ind.n)} participant scores` });
  const xS = (v) => L + v * PW;
  const bw = PW / counts.length, barW = Math.min(24, bw - 2);
  counts.forEach((c, i) => {
    const h = (c / max) * PH, x = xS(edges[i]) + (bw - barW) / 2, y = T + PH - h, r = Math.min(4, h / 2, barW / 2);
    if (h > 0) {
      svg.appendChild(hsSvg("path", {
        d: `M${x},${T + PH}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${T + PH}Z`,
        class: "hs-hist-bar",
      }));
    }
    const hit = hsSvg("rect", { x: xS(edges[i]), y: T, width: bw, height: PH, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => hsTipShow(`<strong>${hsPct(edges[i])}–${hsPct(edges[i + 1])}</strong><br>${fmtNum(c)} participants`, e));
    hit.addEventListener("mouseleave", hsTipHide);
    svg.appendChild(hit);
  });
  svg.appendChild(hsSvg("line", { x1: L, x2: L + PW, y1: T + PH, y2: T + PH, class: "hs-axis-line" }));
  for (const t of [0, 0.5, 1]) {
    svg.appendChild(hsSvg("text", { x: xS(t), y: H - 6, class: "hs-axis-tick hs-axis-tick-lg", "text-anchor": t === 0 ? "start" : t === 1 ? "end" : "middle" }, `${t * 100}%`));
  }
  el.appendChild(svg);
}

// ── 4 Design points ────────────────────────────────────────────────────────

function hsRenderFeatures(d) {
  const el = document.getElementById("hsFeatures");
  // The gap is the difference of the two whole percents shown beside the
  // dots (72% vs 59% reads 13 pts, never 14), largest first; the dots'
  // tooltips give the means to one decimal
  const pts = (v) => Number((v * 100).toFixed(0)); // as hsPct() prints it
  const rows = d.properties
    .filter((r) => r.v1.mean !== null && r.v0.mean !== null)
    .map((r) => ({ ...r, gap: r.v1.mean - r.v0.mean, gapPts: pts(r.v1.mean) - pts(r.v0.mean) }))
    .sort((a, b) => Math.abs(b.gapPts) - Math.abs(a.gapPts) || Math.abs(b.gap) - Math.abs(a.gap));
  if (!rows.length) {
    el.innerHTML = `<p class="hs-empty">No statements can be scored in this date range.</p>`;
    document.getElementById("hsFeatAxis").innerHTML = "";
    return;
  }
  // Shared axis, rounded out to 10-point steps
  const lo = Math.min(...rows.flatMap((r) => [r.v1.mean, r.v0.mean]));
  const hi = Math.max(...rows.flatMap((r) => [r.v1.mean, r.v0.mean]));
  const x0 = Math.floor((lo - 0.03) * 10) / 10, x1 = Math.ceil((hi + 0.03) * 10) / 10;
  const pos = (v) => ((v - x0) / (x1 - x0)) * 100;
  const ticks = [];
  for (let t = x0; t <= x1 + 1e-9; t += 0.1) ticks.push(t);
  document.getElementById("hsFeatAxis").innerHTML = ticks
    .map((t) => `<span style="left:${pos(t).toFixed(2)}%">${Math.round(t * 100)}%</span>`)
    .join("");
  el.innerHTML = rows
    .map((r) => {
      const f = HS_FEATURES[r.key] || {};
      const l1 = hsPropLabel(r.key, 1), l0 = hsPropLabel(r.key, 0);
      const a = pos(r.v1.mean), b = pos(r.v0.mean);
      const hiIs1 = r.gap >= 0;
      const dot = (v, label, cls, side) =>
        `<span class="hs-fdot ${cls}" style="left:${pos(v.mean).toFixed(2)}%" tabindex="0" data-tip="${esc(`<strong>${esc(label)}</strong><br>${fmtNum(v.n)} statements · mean ${hsPct(v.mean, 1)}` + (v.lo !== null ? `<br>95% CI ${hsPct(v.lo, 1)}–${hsPct(v.hi, 1)}` : ""))}" aria-label="${esc(label)}: ${hsPct(v.mean)}"></span>` +
        `<span class="hs-fval ${side}" style="left:${pos(v.mean).toFixed(2)}%">${hsPct(v.mean)}</span>`;
      return (
        `<div class="hs-feat">` +
        `<div class="hs-feat-name"><span class="hs-feat-pair"><span class="hs-key k1"></span>${esc(l1)} <span class="hs-feat-vs">vs</span> <span class="hs-key k0"></span>${esc(l0)}</span>` +
        `<span class="hs-feat-def">${esc(f.d1 || "")} <span class="hs-feat-vs">vs</span> ${esc(f.d0 || "")}</span></div>` +
        `<div class="hs-feat-track">${ticks.map((t) => `<span class="hs-feat-grid" style="left:${pos(t).toFixed(2)}%"></span>`).join("")}` +
        `<span class="hs-feat-link" style="left:${Math.min(a, b).toFixed(2)}%;width:${Math.abs(a - b).toFixed(2)}%"></span>` +
        dot(r.v1, l1, "k1", hiIs1 ? "right" : "left") + dot(r.v0, l0, "k0", hiIs1 ? "left" : "right") +
        `</div>` +
        `<div class="hs-feat-gap">${Math.abs(r.gapPts)}<span> pts</span></div>` +
        `</div>`
      );
    })
    .join("");
  el.querySelectorAll(".hs-fdot").forEach((dot) => {
    dot.addEventListener("mousemove", (e) => hsTipShow(dot.dataset.tip, e));
    dot.addEventListener("mouseleave", hsTipHide);
  });
}

// The highest- and lowest-scoring design points (ranked as on the Design
// Points panel), each with its six feature values as chips
function hsRenderCorners(d) {
  const el = document.getElementById("hsCorners");
  const dp = d.design_points || {};
  const card = (c, title) => {
    if (!c || c.mean === null) return "";
    // its six features as one plain line: fact · physical · …
    const chips = PROP_DEFS.map((p) => esc(c.features[p.key] ? p.v1 : p.v0)).join(" · ");
    const ex = (c.examples || []).slice(0, 2)
      .map((s) => `<li><span class="hs-quote">${esc(fixStatement(s.text))}</span><span class="hs-corner-ex-score">${hsPct(s.m)}</span></li>`)
      .join("");
    return (
      `<div class="hs-card hs-corner">` +
      `<div class="hs-corner-head"><span class="hs-corner-title">${title}</span><span class="hs-corner-score">${hsPct(c.mean)}</span></div>` +
      `<div class="hs-chips">${chips}</div>` +
      `<div class="hs-corner-meta">Average of ${fmtNum(c.n)} scored statement${c.n === 1 ? "" : "s"} in this design point, such as:</div>` +
      `<ul class="hs-corner-ex">${ex}</ul></div>`
    );
  };
  el.innerHTML =
    card(dp.top, "The highest-scoring design point") +
    card(dp.bottom, "The lowest-scoring design point");
}

function hsRenderDataNote(d) {
  const t = d.totals;
  document.getElementById("hsDataNote").textContent = t.ratings
    ? `Showing ${fmtNum(t.ratings)} ratings, ${hsDate(t.first_date)} to ${hsDate(t.last_date)}. New ratings are added every other day.`
    : "No ratings in the selected date range.";
}

// ── 5 LLM evaluations ──────────────────────────────────────────────────────
// Nguyen, Watts & Whiting (2026): a separate study with fixed data, read
// through llm.js's llmGet() and llmSummaryStats(). Teased here with headline
// numbers and direct links into the individual and population stories; the
// full summary charts live in the LLM Evaluations panel's Overview.

async function hsLoadLlm() {
  if (HS.llm || HS.llmLoading || typeof llmGet !== "function") return;
  HS.llmLoading = true;
  try {
    HS.llm = llmSummaryStats(await llmGet("/llm-evals"));
    if (HS.llm.missing || !HS.llm.models.length) throw new Error("no LLM evaluation data");
  } catch (err) {
    console.error("Home: LLM evaluations failed to load:", err);
    HS.llm = null;
    for (const id of ["hsLlmIndivStat", "hsLlmPopStat"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<span class="hs-empty">The LLM results could not be loaded. Try refreshing the page.</span>`;
    }
    return;
  } finally {
    HS.llmLoading = false;
  }
  for (const fn of [hsFillLlmFields, hsRenderLlmIndiv, hsRenderLlmPop]) {
    try { fn(HS.llm); } catch (err) { console.error(`Home: ${fn.name} failed:`, err); }
  }
}

function hsFillLlmFields(d) {
  const values = { n_participants: d.n_participants, n_models: d.models.length, n_statements: d.n_statements };
  document.querySelectorAll("#panelHome [data-hl]").forEach((el) => {
    const v = values[el.dataset.hl];
    el.textContent = v === undefined ? "—" : fmtNum(v);
  });
}

function hsRenderLlmIndiv(d) {
  const n = d.models.length;
  const above = d.models.filter((m) => m.commonsensicality > d.humanMedian).length;
  const share = above / n;
  const few = share < 0.25 ? "fewer than a quarter of models" : share < 1 / 3 ? "fewer than a third of models" : share < 0.5 ? "fewer than half of the models" : "only some models";
  const topInd = [...d.models].sort((a, b) => b.commonsensicality - a.commonsensicality)[0];
  const defInd = (typeof LLM_DEFAULT_MODEL === "string" && d.models.find((m) => m.id === LLM_DEFAULT_MODEL))
    || [...d.models].sort((a, b) => a.rankInd - b.rankInd)[0];

  document.getElementById("hsLlmIndivStat").innerHTML =
    `<span class="hs-llm-num">${above} <span class="hs-llm-of">of ${n}</span></span>` +
    `<span class="hs-llm-sub">models score above the median human (${hsPct(d.humanMedian)})</span>`;
  document.getElementById("hsLlmIndivText").textContent =
    `Scored as individual test-takers across all ${fmtNum(d.n_statements)} statements, ` +
    (above * 2 < n ? `${few} surpass the typical human participant.` : `${above} of ${n} models surpass the typical human participant.`);
  document.getElementById("hsLlmIndivFoot").textContent = topInd
    ? `Highest model: ${topInd.name} (${hsPct(topInd.commonsensicality)})`
    : "";
  const go = document.getElementById("hsLlmIndivGo");
  if (go && defInd) {
    go.dataset.llmModel = defInd.id;
    go.setAttribute("href", `llm_evaluations?view=individual&model=${encodeURIComponent(defInd.id)}`);
  }
}

function hsRenderLlmPop(d) {
  const models = d.models.filter((m) => m.r !== null).sort((a, b) => a.r - b.r);
  const best = models.at(-1);
  const half = d.split_half ? d.split_half.mean : (d.paper ? d.paper.split_half_r : null);
  const gap = !best || half === null ? "" : best.r < half - 0.1 ? "substantially below" : best.r < half ? "below" : "at or above";

  document.getElementById("hsLlmPopStat").innerHTML =
    `<span class="hs-llm-num">r&nbsp;=&nbsp;${best ? llmR(best.r) : "—"}</span>` +
    `<span class="hs-llm-sub">${best && half !== null
      ? `best model correlation with human scores, ${gap} human split-half reliability (r&nbsp;=&nbsp;${llmR(half)})`
      : "best model correlation with human statement scores"}</span>`;
  document.getElementById("hsLlmPopText").textContent = best && half !== null && best.r < half
    ? "Viewed as generators of synthetic populations via their answer probabilities, even the closest model falls short of how well two groups of people agree with each other."
    : "Viewed as generators of synthetic populations via their answer probabilities, each model's statement scores can be compared directly with those of human raters.";
  document.getElementById("hsLlmPopFoot").innerHTML = best
    ? `Best crowd: ${esc(best.name)}${d.medianR !== null ? ` · Median: r&nbsp;=&nbsp;${llmR(d.medianR)}` : ""}`
    : "";
  const go = document.getElementById("hsLlmPopGo");
  if (go && best) {
    go.dataset.llmModel = best.id;
    go.setAttribute("href", `llm_evaluations?view=population&model=${encodeURIComponent(best.id)}`);
  }
}

// ── Navigation, scrolling, reveal, resize ───────────────────────────────────

function hsBindScrollLinks(root) {
  root.querySelectorAll("a[data-scroll]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault(); // keep the URL (panel routing) unchanged
      target.scrollIntoView({ behavior: HS_REDUCED ? "auto" : "smooth", block: "start" });
    });
  });
}

function hsBindTabLinks(root) {
  root.querySelectorAll("a[data-tab-link]").forEach((a) => {
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new tab: let the href work
      e.preventDefault();
      if (a.dataset.llmModel && typeof LLM === "object") {
        LLM.model = a.dataset.llmModel;
        const gm = typeof llmModel === "function" && llmModel(a.dataset.llmModel);
        if (gm && gm.features) LLM.featModel = gm.id;
      }
      // Set the LLM panel's view first, so the panel opens on it
      if (a.dataset.llmView && typeof llmShowView === "function") llmShowView(a.dataset.llmView);
      switchToTab(a.dataset.tabLink, true);
    });
  });
}

function hsInitObservers() {
  const root = document.getElementById("homeScroll");
  if (!("IntersectionObserver" in window)) return;
  const links = new Map([...document.querySelectorAll(".hs-subnav a")].map((a) => [a.getAttribute("href").slice(1), a]));
  const navObs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) links.forEach((a, id) => a.classList.toggle("active", id === en.target.id));
      }
    },
    { root, rootMargin: "-40% 0px -55% 0px" },
  );
  links.forEach((_, id) => { const s = document.getElementById(id); if (s) navObs.observe(s); });
  if (HS_REDUCED) return;
  root.classList.add("hs-js-reveal");
  const revObs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add("in"); revObs.unobserve(en.target); }
      }
    },
    { root, threshold: 0.12 },
  );
  root.querySelectorAll(".hs-reveal").forEach((el) => revObs.observe(el));
}

function hsInitTicker() {
  const card = document.getElementById("hsTicker");
  const step = (k) => {
    if (!HS.ticker.items.length) return;
    HS.ticker.i = (HS.ticker.i + k + HS.ticker.items.length) % HS.ticker.items.length;
    hsShowTicker();
  };
  document.getElementById("hsTickerPrev").addEventListener("click", () => step(-1));
  document.getElementById("hsTickerNext").addEventListener("click", () => step(1));
  card.addEventListener("mouseenter", () => { HS.ticker.paused = true; });
  card.addEventListener("mouseleave", () => { HS.ticker.paused = false; });
  card.addEventListener("focusin", () => { HS.ticker.paused = true; });
  card.addEventListener("focusout", () => { HS.ticker.paused = false; });
}

let _hsResizeTimer = null;
function hsOnResize() {
  clearTimeout(_hsResizeTimer);
  _hsResizeTimer = setTimeout(() => {
    const w = document.getElementById("homeScroll").clientWidth;
    if (!HS.data || !w || Math.abs(w - HS.lastWidth) < 24) return;
    HS.lastWidth = w;
    try { hsRenderIndivHist(HS.data); } catch (err) { console.error("Home: histogram resize failed:", err); }
  }, 200);
}

function hsInit() {
  const panel = document.getElementById("panelHome");
  hsBindScrollLinks(panel);
  hsBindTabLinks(panel);
  hsInitTicker();
  hsInitCompositionFit();
  hsInitObservers();
  window.addEventListener("resize", hsOnResize);
  if (!panel.classList.contains("hidden")) loadHomeSummary();
}

hsInit();
