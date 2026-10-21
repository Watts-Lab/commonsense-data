"use strict";

// ══ Home / landing page ════════════════════════════════════════════════════
// Loaded after app.js and uses its globals: API, esc, fmtNum, dateParams,
// fixStatement, PROP_DEFS, switchToTab, renderWorldMap, _homeCountryData,
// _homeMapMode, _positionTooltip. Every live number comes from one request,
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

const HS_AGREE = UI.agree;   // share who agree (UI in app.js)
const HS_EXPECT = UI.expect; // share who think most others agree

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

// The hero card's reading of the bars: which way the majority went
function hsMajoritySentence(p) {
  if (Math.abs(p - 0.5) < 0.0005) return "Exactly half of people agree with this statement.";
  if (p === 1 || p === 0) return `Everyone (100%) ${p ? "agrees" : "disagrees"} with this statement.`;
  return p > 0.5
    ? `The majority of people (${hsMajPct(p)}) agree with this statement.`
    : `The majority of people (${hsMajPct(1 - p)}) disagree with this statement.`;
}

// Score pill colour: one blue ramp, light (low) to dark (high). Its text is
// white on the two darkest steps and ink on the rest, so it clears 4.5:1.
const HS_SCORE_STOPS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
function hsScoreStep(m) {
  return Math.min(HS_SCORE_STOPS.length - 1, Math.max(0, Math.floor(m * HS_SCORE_STOPS.length)));
}
function hsScoreColor(m) {
  return HS_SCORE_STOPS[hsScoreStep(m)];
}
function hsScoreInk(m) {
  return hsScoreStep(m) >= 4 ? "#fff" : UI.ink;
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
  stamp.innerHTML = d.date_from || d.date_to
    ? `<span class="hs-dot hs-dot-warn"></span>Date filter on: ratings from ${hsDate(t.first_date)} to ${hsDate(t.last_date)}.`
    : `<span class="hs-dot"></span>Live data: ratings from ${hsDate(t.first_date)} to ${hsDate(t.last_date)}.`;
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
  count.textContent = `Of ${fmtNum(s.n)} people who have rated the statement`;
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
    `<div class="hs-demo-head"><span class="hs-demo-label">A statement from the survey</span>` +
    `<button type="button" class="hs-link-btn" id="hsDemoNext">Try another ↻</button></div>` +
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

// How everyone answered, then the majority rating and how the visitor's two
// answers compare with it. The majority rule (ties count as agree) is
// utils.py's, through hsScore(); an exact tie is described as no majority.
function hsDemoResultHtml(s, agree, others) {
  const sc = hsScore(s.p, s.q);
  const maj = sc.majAgree ? "agree" : "disagree";
  const verdict = (ok, text) => `<strong class="hs-verdict-text ${ok ? "ok" : "no"}">${text}</strong>`;
  let explain;
  if (Math.abs(s.p - 0.5) < 0.0005) {
    explain = `<p>Exactly half of people agreed with this statement, so it has no majority rating: there is no majority to side with, or to predict.</p>`;
  } else {
    const ok1 = agree === sc.majAgree, ok2 = others === sc.majAgree;
    const own =
      `You ${verdict(ok1, ok1 ? "sided with the majority" : "went against the majority")} ` +
      `because you ${agree ? "agreed" : "disagreed"} with the statement`;
    // The second question asks whether most others would agree, so the
    // prediction is "would agree" or "would not agree"
    const would = others ? "would agree" : "would not agree";
    const pred = ok2
      ? `you ${verdict(true, "correctly predicted")} that most people ${would}`
      : `you ${verdict(false, "incorrectly predicted")} that most people ${would}, when they actually ${others ? "did not" : "did"}`;
    explain =
      `<p>Since ${sc.majAgree ? "" : "only "}<strong>${hsMajPct(s.p)}</strong> of people agreed with this statement, ` +
      `its majority rating is <strong>${maj}</strong>. ${own}${ok1 === ok2 ? ", and " : ", but "}${pred}.</p>`;
  }
  return (
    `<div class="hs-demo-reveal">` +
    `<div class="hs-reveal-head">How ${fmtNum(s.n)} participants answered</div>` +
    hsDualBars(s.p, s.q) +
    `<div class="hs-explain">${explain}</div>` +
    `<p class="hs-reveal-note">Based on these ratings, this statement receives a score of <strong>${hsPct(s.m)}</strong>. <a href="#hs-measure" data-scroll>See what this means</a></p>` +
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

function hsInitMapToggle() {
  document.querySelectorAll("[data-map-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      _homeMapMode = b.dataset.mapMode;
      document.querySelectorAll("[data-map-mode]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      if (_homeCountryData) renderWorldMap(_homeCountryData);
    });
  });
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
    ? `Median <strong>${hsPct(st.median)}</strong> across ${fmtNum(st.n)} statements`
    : "";
}

function hsRenderIndivHist(d) {
  const el = document.getElementById("hsIndivHist");
  el.innerHTML = "";
  const ind = d.individual;
  document.getElementById("hsIndivFoot").innerHTML = ind.n
    ? `Median <strong>${hsPct(ind.median)}</strong> across ${fmtNum(ind.n)} people`
    : "";
  if (!ind.n) { el.innerHTML = `<span class="hs-empty">No participants can be scored in this date range.</span>`; return; }
  const { counts, bin_edges: edges } = ind.histogram;
  // Drawn at the container's pixel width so text stays legible on phones
  const W = Math.max(260, Math.round(el.clientWidth || 480)), H = 166, L = 8, R = 8, T = 26, B = 26;
  const PW = W - L - R, PH = H - T - B;
  const max = Math.max(...counts, 1);
  const svg = hsSvg("svg", { viewBox: `0 0 ${W} ${H}`, class: "hs-hist-svg", role: "img", "aria-label": `Histogram of participant scores; median ${hsPct(ind.median)}` });
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
  const mx = xS(ind.median);
  svg.appendChild(hsSvg("line", { x1: mx, x2: mx, y1: T - 6, y2: T + PH, class: "hs-marker" }));
  svg.appendChild(hsSvg("text", { x: mx - 5, y: T - 10, class: "hs-marker-label hs-marker-label-lg", "text-anchor": "end" }, `Median ${hsPct(ind.median)}`));
  el.appendChild(svg);
}

// ── 4 Design points ────────────────────────────────────────────────────────

function hsRenderFeatures(d) {
  const el = document.getElementById("hsFeatures");
  const rows = d.properties
    .filter((r) => r.v1.mean !== null && r.v0.mean !== null)
    .map((r) => ({ ...r, gap: r.v1.mean - r.v0.mean }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
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
        `<div class="hs-feat-gap">${Math.round(Math.abs(r.gap) * 100)}<span> pts</span></div>` +
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
    const chips = PROP_DEFS.map((p) => {
      const v = c.features[p.key] ? 1 : 0;
      return `<span class="hs-chip k${v}">${esc(v ? p.v1 : p.v0)}</span>`;
    }).join("");
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
// through llm.js's llmGet() and llmSummaryStats(). The two cards aren't
// links: the reader carries on to the takeaways and the button under them.
// Their numbers are computed; the wording follows the data's shape where it
// could change (how many models beat the median human, how far the best
// crowd falls short of two halves of people).

async function hsLoadLlm() {
  if (HS.llm || HS.llmLoading || typeof llmGet !== "function") return;
  HS.llmLoading = true;
  try {
    HS.llm = llmSummaryStats(await llmGet("/llm-evals"));
    if (HS.llm.missing || !HS.llm.models.length) throw new Error("no LLM evaluation data");
  } catch (err) {
    console.error("Home: LLM evaluations failed to load:", err);
    HS.llm = null;
    document.getElementById("hsLlmReveals").innerHTML = `<p class="hs-empty">The LLM results could not be loaded. Try refreshing the page.</p>`;
    return;
  } finally {
    HS.llmLoading = false;
  }
  for (const fn of [hsFillLlmFields, hsRenderLlmIndiv, hsRenderLlmPop, hsRenderLlmReveals]) {
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

// Humans and LLMs as two histograms on one grid of 5-point bins, each bar the
// share of its own group (2,046 people, 44 LLMs), with the median human marked
function hsRenderLlmIndiv(d) {
  const el = document.getElementById("hsLlmIndiv");
  el.innerHTML = "";
  const n = d.models.length;
  const above = d.models.filter((m) => m.commonsensicality > d.humanMedian).length;
  document.getElementById("hsLlmIndivFoot").innerHTML = above * 2 < n
    ? `We found a modest result: only <strong>${above} out of ${n}</strong> LLMs score above the median human.`
    : `<strong>${above} out of ${n}</strong> LLMs score above the median human.`;
  const people = d.participants.map((p) => p.scores[2]);
  // Bins in whole points, so float error can't push a score across an edge
  const lo = Math.min(30, Math.floor(Math.min(...people, ...d.models.map((m) => m.commonsensicality)) * 20) * 5), hi = 100, step = 5;
  const nb = (hi - lo) / step;
  const binOf = (v) => Math.min(nb - 1, Math.max(0, Math.floor((v * 100 - lo) / step + 1e-9)));
  const pc = Array(nb).fill(0), mc = Array(nb).fill(0), names = Array.from({ length: nb }, () => []);
  for (const v of people) pc[binOf(v)]++;
  d.models.forEach((m) => { const i = binOf(m.commonsensicality); mc[i]++; names[i].push(m.name); });
  const pShare = pc.map((c) => c / people.length), mShare = mc.map((c) => c / n);
  const ystep = 0.05, ymax = Math.max(ystep, Math.ceil(Math.max(...pShare, ...mShare) / ystep - 1e-9) * ystep);

  const W = Math.max(260, Math.round(el.clientWidth || 480)), L = 34, R = 6, T = 26, PH = 132, B = 22;
  const PW = W - L - R, base = T + PH, H = base + B;
  const xS = (pts) => L + ((pts - lo) / (hi - lo)) * PW;
  const yS = (share) => base - (share / ymax) * PH;
  const svg = hsSvg("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "hs-hist-svg", role: "img",
    "aria-label": `Histograms of commonsensicality for the study's ${fmtNum(people.length)} humans and ${n} LLMs, as a share of each group; ${above} of ${n} LLMs score above the median human`,
  });
  // y axis: gridlines and % labels
  for (let k = 0; k * ystep <= ymax + 1e-9; k++) {
    const y = yS(k * ystep);
    if (k) svg.appendChild(hsSvg("line", { x1: L, x2: L + PW, y1: y, y2: y, class: "hs-grid-line" }));
    svg.appendChild(hsSvg("text", { x: L - 6, y: y + 3.5, class: "hs-axis-tick", "text-anchor": "end" }, `${Math.round(k * ystep * 100)}%`));
  }
  // bars: humans (blue) and LLMs (orange) side by side in each bin
  const bw = PW / nb, gap = Math.min(3, bw * 0.12), barW = Math.max(2, (bw - 2 * gap) / 2);
  const bar = (x, share, cls) => {
    const h = base - yS(share);
    if (h <= 0) return;
    const y = base - h, rr = Math.min(2.5, h / 2, barW / 2);
    svg.appendChild(hsSvg("path", { d: `M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + barW - rr}Q${x + barW},${y} ${x + barW},${y + rr}V${base}Z`, class: cls }));
  };
  for (let i = 0; i < nb; i++) {
    const x0 = L + i * bw + gap;
    bar(x0, pShare[i], "hs-hist-bar");
    bar(x0 + barW, mShare[i], "hs-hist-bar-llm");
    const a = lo + i * step;
    const listed = names[i].length > 4 ? `${names[i].slice(0, 4).join(", ")} and ${names[i].length - 4} more` : names[i].join(", ");
    const hit = hsSvg("rect", { x: L + i * bw, y: T, width: bw, height: PH, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => hsTipShow(
      `<strong>Commonsensicality ${a}–${a + step}%</strong><br>` +
      `Humans: ${hsPct(pShare[i], 1)} (${fmtNum(pc[i])})<br>LLMs: ${hsPct(mShare[i], 1)} (${mc[i]} of ${n})` +
      (listed ? `<br><span style="opacity:.8">${esc(listed)}</span>` : ""), e));
    hit.addEventListener("mouseleave", hsTipHide);
    svg.appendChild(hit);
  }
  svg.appendChild(hsSvg("line", { x1: L, x2: L + PW, y1: base, y2: base, class: "hs-axis-line" }));
  const mx = xS(d.humanMedian * 100);
  svg.appendChild(hsSvg("line", { x1: mx, x2: mx, y1: T - 6, y2: base, class: "hs-marker" }));
  svg.appendChild(hsSvg("text", { x: mx - 5, y: T - 10, class: "hs-marker-label", "text-anchor": "end" }, `Median human ${hsPct(d.humanMedian)}`));
  const every = W < 400 ? 20 : 10;
  for (let t = Math.ceil(lo / every) * every; t <= hi; t += every) {
    svg.appendChild(hsSvg("text", { x: xS(t), y: H - 5, class: "hs-axis-tick", "text-anchor": t >= hi ? "end" : "middle" }, `${t}%`));
  }
  el.appendChild(svg);
}

// Every model's correlation with people as a column, from lowest to highest
// r; the sentence under the chart sets the best against the paper's
// split-half reliability (two random halves of the people)
function hsRenderLlmPop(d) {
  const el = document.getElementById("hsLlmPop");
  el.innerHTML = "";
  const models = d.models.filter((m) => m.r !== null).sort((a, b) => a.r - b.r);
  const best = models.at(-1);
  const half = d.paper ? d.paper.split_half_r : null;
  const gap = !best || half === null ? "" : best.r < half - 0.1 ? "substantially below" : best.r < half ? "below" : "at or above";
  document.getElementById("hsLlmPopFoot").innerHTML = !best ? ""
    : half !== null
      ? `The best model has a correlation of <strong>r&nbsp;=&nbsp;${llmR(best.r)}</strong>, ${gap} the human split-half reliability of <strong>r&nbsp;=&nbsp;${llmR(half)}</strong>.`
      : `The best model has a correlation of <strong>r&nbsp;=&nbsp;${llmR(best.r)}</strong>.`;
  if (!best) return;
  const lo = Math.min(-0.2, Math.floor(models[0].r * 10) / 10), hi = Math.max(0.6, Math.ceil(best.r * 10) / 10 + 0.1);
  const W = Math.max(260, Math.round(el.clientWidth || 480)), L = 30, R = 6, T = 22, PH = 140, B = 22;
  const PW = W - L - R, H = T + PH + B;
  const yS = (v) => T + ((hi - v) / (hi - lo)) * PH;
  const svg = hsSvg("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "hs-hist-svg", role: "img",
    "aria-label": `Bar chart of each LLM's correlation with humans, from lowest to highest; the best is ${llmR(best.r)}` + (half !== null ? `, against ${llmR(half)} between two random halves of humans` : ""),
  });
  for (let t = Math.ceil(lo * 5) / 5; t <= hi + 1e-9; t += 0.2) {
    const y = yS(t);
    if (Math.abs(t) > 1e-9) svg.appendChild(hsSvg("line", { x1: L, x2: L + PW, y1: y, y2: y, class: "hs-grid-line" }));
    svg.appendChild(hsSvg("text", { x: L - 6, y: y + 3.5, class: "hs-axis-tick", "text-anchor": "end" }, llmRTick(Math.round(t * 10) / 10)));
  }
  const bw = PW / models.length, gap2 = Math.min(2, bw * 0.18), y0 = yS(0);
  models.forEach((m, i) => {
    const x = L + i * bw + gap2 / 2, y = yS(Math.max(0, m.r)), h = Math.abs(yS(m.r) - y0);
    svg.appendChild(hsSvg("rect", { x, y: m.r >= 0 ? y : y0, width: Math.max(1, bw - gap2), height: Math.max(0.5, h), rx: Math.min(2, (bw - gap2) / 2), class: `hs-hist-bar-llm${m.r_sig === false ? " is-faint" : ""}` }));
    const hit = hsSvg("rect", { x: L + i * bw, y: T, width: bw, height: PH, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => hsTipShow(`<strong>${esc(m.name)}</strong><br>r = ${llmR(m.r)} (${llmOrdinal(m.rankR)} of ${d.models.length})${m.r_sig === false ? "<br>Not significantly different from 0" : ""}`, e));
    hit.addEventListener("mouseleave", hsTipHide);
    svg.appendChild(hit);
  });
  svg.appendChild(hsSvg("line", { x1: L, x2: L + PW, y1: y0, y2: y0, class: "hs-axis-line" }));
  svg.appendChild(hsSvg("text", { x: L, y: H - 5, class: "hs-axis-tick" }, "← Lowest r"));
  svg.appendChild(hsSvg("text", { x: L + PW, y: H - 5, class: "hs-axis-tick", "text-anchor": "end" }, "Highest r →"));
  el.appendChild(svg);
}

function hsRenderLlmReveals(d) {
  const n = d.models.length;
  const above = d.models.filter((m) => m.commonsensicality > d.humanMedian).length;
  const share = above / n;
  const few = share < 0.25 ? "Fewer than a quarter of models" : share < 1 / 3 ? "Fewer than a third of models" : share < 0.5 ? "Fewer than half of the models" : "Only some models";
  const parts = [
    `<p><strong>There is no need for a predefined “correct” answer.</strong> Consensus and awareness arise from the independent judgments of humans and LLMs. These signals can be used to measure their commonsensicality, or “performance,” directly.</p>`,
    above * 2 < n
      ? `<p><strong>Most LLMs fall short of the typical person.</strong> The median human participant received a commonsensicality score of ${hsPct(d.humanMedian)}. ${few} (${above}&nbsp;/&nbsp;${n}) managed to surpass this.</p>`
      : `<p><strong>${above} of ${n} LLMs surpass the typical person.</strong> The median human participant received a commonsensicality score of ${hsPct(d.humanMedian)}.</p>`,
    `<p><strong>LLM-simulated crowds are very different from humans.</strong> Judging by the way they rate statements, there are substantial differences in how human and LLM-generated populations determine what common sense is.</p>`,
  ];
  document.getElementById("hsLlmReveals").innerHTML = `<div class="hs-reveals-kicker">What this means for evaluating LLMs</div>${parts.join("")}`;
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
    if (HS.llm) {
      try { hsRenderLlmIndiv(HS.llm); hsRenderLlmPop(HS.llm); } catch (err) { console.error("Home: LLM chart resize failed:", err); }
    }
  }, 200);
}

function hsInit() {
  const panel = document.getElementById("panelHome");
  hsBindScrollLinks(panel);
  hsBindTabLinks(panel);
  hsInitMapToggle();
  hsInitTicker();
  hsInitCompositionFit();
  hsInitObservers();
  window.addEventListener("resize", hsOnResize);
  if (!panel.classList.contains("hidden")) loadHomeSummary();
}

hsInit();
