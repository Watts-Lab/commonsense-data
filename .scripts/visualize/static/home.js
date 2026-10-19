"use strict";

// ══ Home / landing page ════════════════════════════════════════════════════
// Loaded after app.js and uses its globals: API, esc, fmtNum, dateParams,
// fixStatement, PROP_DEFS, switchToTab, renderWorldMap, _homeCountryData,
// _homeMapMode, _positionTooltip. Every live number comes from one request,
// /api/home-summary (get_home_summary() in server.py), which reads its scores
// back from the Individual Scores, Statement Scores and Design Points
// endpoints so the numbers here match those panels.
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
};

const HS_REDUCED =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const HS_AGREE = "#2a78d6";  // share who agree
const HS_EXPECT = "#eb6834"; // share who think most others agree

const HS_CATS = {
  universal: "Nearly universal",
  rejected: "Shared rejection",
  divisive: "Split down the middle",
  underestimated: "Underestimated agreement",
  overestimated: "Overestimated agreement",
};

// One-line glosses of the six features (full definitions: PROP_DEFS in app.js)
// and the words used to summarise what the gaps show.
const HS_FEATURES = {
  fact:             { d1: "can be shown true or false",  d0: "a matter of opinion",             hi: "factual",       lo: "opinions" },
  physical:         { d1: "about the natural world",     d0: "about people and society",        hi: "physical",      lo: "social claims" },
  literal_language: { d1: "means exactly what it says",  d0: "metaphor, aphorism, hyperbole",   hi: "literal",       lo: "figures of speech" },
  positive:         { d1: "says how things are",         d0: "says how things should be",       hi: "descriptive",   lo: "value judgements" },
  knowledge:        { d1: "an observation",              d0: "a conclusion drawn by reasoning", hi: "observational", lo: "conclusions" },
  everyday:         { d1: "part of ordinary experience", d0: "beyond what one person can see",  hi: "everyday",      lo: "abstractions" },
};

// ── Small helpers ───────────────────────────────────────────────────────────

function hsScore(p, q) {
  const majAgree = p >= 0.5; // ties count as agree, as in utils.py
  return { majAgree, a: majAgree ? q : 1 - q };
}

function hsPct(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  // Never round a non-unanimous share up to 100% (or a non-zero one down to 0%)
  if (digits === 0 && ((v < 1 && Math.round(v * 100) === 100) || (v > 0 && Math.round(v * 100) === 0))) digits = 1;
  return `${(v * 100).toFixed(digits)}%`;
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

function hsList(arr) {
  if (arr.length <= 1) return arr.join("");
  return `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`;
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
    `<span class="hs-dbar-val">${hsPct(v)}</span></div>`;
  return row("Agree", p, HS_AGREE) + row("Think most others agree", q, HS_EXPECT);
}

function hsMajorityLine(p, q) {
  if (Math.abs(p - 0.5) < 0.0005) return "An exact 50/50 split: no consensus at all";
  const s = hsScore(p, q);
  return `Majority ${s.majAgree ? "agrees" : "disagrees"} (${hsPct(s.majAgree ? p : 1 - p)}) · ${hsPct(s.a)} of raters predicted that`;
}

// Score pill colour: one blue ramp, light (low) to dark (high)
function hsScoreColor(m) {
  const stops = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
  return stops[Math.min(stops.length - 1, Math.max(0, Math.floor(m * stops.length)))];
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadHomeSummary() {
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
    for (const cat of ["universal", "divisive", "underestimated", "rejected", "overestimated"]) {
      const s = (ex[cat] || [])[i];
      if (s && !items.some((x) => x.id === s.id)) items.push({ ...s, cat });
    }
  }
  HS.ticker.items = items;
  HS.ticker.i = 0;
  hsShowTicker(false);
  clearInterval(HS.ticker.timer);
  if (!HS_REDUCED && items.length > 1) {
    HS.ticker.timer = setInterval(() => {
      if (HS.ticker.paused || document.getElementById("panelHome").classList.contains("hidden")) return;
      HS.ticker.i = (HS.ticker.i + 1) % HS.ticker.items.length;
      hsShowTicker(true);
    }, 6500);
  }
}

function hsShowTicker(animate) {
  const s = HS.ticker.items[HS.ticker.i];
  const quote = document.getElementById("hsTickerQuote");
  const bars = document.getElementById("hsTickerBars");
  const tag = document.getElementById("hsTickerTag");
  const meta = document.getElementById("hsTickerMeta");
  if (!s) {
    quote.textContent = "Not enough ratings in this date range.";
    bars.innerHTML = tag.textContent = meta.textContent = "";
    return;
  }
  const apply = () => {
    tag.textContent = HS_CATS[s.cat];
    quote.textContent = fixStatement(s.text);
    bars.innerHTML = hsDualBars(s.p, s.q) + `<div class="hs-majority">${hsMajorityLine(s.p, s.q)}</div>`;
    meta.innerHTML = `Score <strong>${hsPct(s.m)}</strong> · ${fmtNum(s.n)} ratings`;
  };
  if (!animate) { apply(); return; }
  const card = document.getElementById("hsTicker");
  card.classList.add("hs-fading");
  setTimeout(() => { apply(); card.classList.remove("hs-fading"); }, 220);
}

// ── 01 The survey: try the two questions on one statement ──────────────────

function hsRenderDemoPool(d) {
  const ex = d.examples || {};
  const seen = new Set();
  HS.demo.pool = [];
  for (const cat of Object.keys(HS_CATS)) {
    // skip the two most obvious statements; keep the texts short
    for (const s of (ex[cat] || []).slice(cat === "universal" ? 2 : 0)) {
      if (!seen.has(s.id) && s.text.length <= 110) { seen.add(s.id); HS.demo.pool.push(s); }
    }
  }
  HS.demo.item = null;
  hsNewDemo();
}

function hsNewDemo() {
  const pool = HS.demo.pool.filter((s) => !HS.demo.item || s.id !== HS.demo.item.id);
  HS.demo.item = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  HS.demo.agree = HS.demo.others = null;
  hsRenderDemo();
}

function hsRenderDemo() {
  const el = document.getElementById("hsDemo");
  const s = HS.demo.item;
  if (!s) { el.innerHTML = `<p class="hs-empty">Not enough rated statements in this date range.</p>`; return; }
  const { agree, others } = HS.demo;
  const done = agree !== null && others !== null;
  const btn = (q, v, label) =>
    `<button type="button" class="hs-choice-btn" data-q="${q}" data-v="${v}" aria-pressed="${HS.demo[q] === v}"${done ? " disabled" : ""}>${label}</button>`;
  let reveal = "";
  if (done) {
    const sc = hsScore(s.p, s.q);
    const tie = Math.abs(s.p - 0.5) < 0.0005;
    const chip = (ok, yes, no) =>
      `<span class="hs-verdict ${ok ? "ok" : "no"}"><span aria-hidden="true">${ok ? "✓" : "✗"}</span> ${ok ? yes : no}</span>`;
    reveal =
      `<div class="hs-demo-reveal" aria-live="polite">` +
      `<div class="hs-reveal-head">How ${fmtNum(s.n)} participants answered</div>` +
      hsDualBars(s.p, s.q) +
      `<div class="hs-majority">${hsMajorityLine(s.p, s.q)}</div>` +
      (tie ? "" :
        `<div class="hs-verdicts">` +
        chip(agree === sc.majAgree, "You sided with the majority", "You went against the majority") +
        chip(others === sc.majAgree, "You read the majority right", "You misread the majority") +
        `</div>`) +
      `<p class="hs-reveal-note">This statement scores <strong>${hsPct(s.m)}</strong>. <a href="#hs-measure" data-scroll>What the scores mean ↓</a></p>` +
      `</div>`;
  }
  el.innerHTML =
    `<div class="hs-demo-head"><span class="hs-demo-label">A statement from the survey</span>` +
    `<button type="button" class="hs-link-btn" id="hsDemoNext">Try another ↻</button></div>` +
    `<blockquote class="hs-quote hs-demo-quote">${esc(fixStatement(s.text))}</blockquote>` +
    `<div class="hs-q"><span class="hs-q-num" aria-hidden="true">1</span><div><div class="hs-q-text" id="hsQ1">Do you agree with this statement?</div>` +
    `<div class="hs-choice" role="group" aria-labelledby="hsQ1">${btn("agree", true, "Agree")}${btn("agree", false, "Disagree")}</div></div></div>` +
    `<div class="hs-q"><span class="hs-q-num" aria-hidden="true">2</span><div><div class="hs-q-text" id="hsQ2">Do you think most other people would agree with it?</div>` +
    `<div class="hs-choice" role="group" aria-labelledby="hsQ2">${btn("others", true, "Yes, most would")}${btn("others", false, "No, most would not")}</div></div></div>` +
    reveal;
  el.querySelectorAll(".hs-choice-btn").forEach((b) =>
    b.addEventListener("click", () => {
      HS.demo[b.dataset.q] = b.dataset.v === "true";
      hsRenderDemo();
    }),
  );
  document.getElementById("hsDemoNext").addEventListener("click", hsNewDemo);
  hsBindScrollLinks(el);
}

// ── 02 Who took part ────────────────────────────────────────────────────────

function hsRenderComposition(d) {
  const el = document.getElementById("hsComposition");
  const total = d.composition.reduce((s, r) => s + r.n, 0);
  if (!total) {
    el.innerHTML = `<p class="hs-empty">No participants in this range.</p>`;
    document.getElementById("hsCompositionNote").textContent = "";
    return;
  }
  const top = Math.max(...d.composition.map((r) => r.n));
  el.innerHTML = d.composition
    .map(
      (r) =>
        `<div class="hs-bl-row" title="${esc(r.country)}: ${fmtNum(r.n)} participants">` +
        `<span class="hs-bl-label">${esc(r.country === "Other" ? "All other countries" : r.country)}</span>` +
        `<span class="hs-bl-track"><span class="hs-bl-fill${r.country === "Other" ? " muted" : ""}" style="width:${((r.n / top) * 100).toFixed(1)}%"></span></span>` +
        `<span class="hs-bl-val">${hsPct(r.n / total)}</span></div>`,
    )
    .join("");
  const top3 = d.composition.filter((r) => r.country !== "Other").slice(0, 3);
  const share = top3.reduce((s, r) => s + r.n, 0) / total;
  document.getElementById("hsCompositionNote").innerHTML =
    `${hsList(top3.map((r) => esc(r.country)))} make up <strong>${hsPct(share)}</strong> of participants. Every panel can be filtered to one country.`;
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

// ── 03 The scores ───────────────────────────────────────────────────────────

function hsRenderLadder(d) {
  const el = document.getElementById("hsLadder");
  const rows = (d.scale || []).slice().sort((a, b) => b.m - a.m);
  el.innerHTML = rows.length
    ? rows
        .map(
          (s) =>
            `<span class="hs-rung"><span class="hs-rung-score" style="background:${hsScoreColor(s.m)};color:${s.m >= 0.5 ? "#fff" : "#0d366b"}">${hsPct(s.m)}</span>` +
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
  const W = Math.max(260, Math.round(el.clientWidth || 480)), H = 160, L = 6, R = 6, T = 24, B = 22;
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
    svg.appendChild(hsSvg("text", { x: xS(t), y: H - 5, class: "hs-axis-tick", "text-anchor": t === 0 ? "start" : t === 1 ? "end" : "middle" }, `${t * 100}%`));
  }
  const mx = xS(ind.median);
  svg.appendChild(hsSvg("line", { x1: mx, x2: mx, y1: T - 6, y2: T + PH, class: "hs-marker" }));
  svg.appendChild(hsSvg("text", { x: mx - 5, y: T - 9, class: "hs-marker-label", "text-anchor": "end" }, `Median ${hsPct(ind.median)}`));
  el.appendChild(svg);
}

// ── 04 Design points ────────────────────────────────────────────────────────

function hsRenderFeatures(d) {
  const el = document.getElementById("hsFeatures");
  const rows = d.properties
    .filter((r) => r.v1.mean !== null && r.v0.mean !== null)
    .map((r) => ({ ...r, gap: r.v1.mean - r.v0.mean }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  if (!rows.length) {
    el.innerHTML = `<p class="hs-empty">No statements can be scored in this date range.</p>`;
    document.getElementById("hsFeatAxis").innerHTML = "";
    document.getElementById("hsReveals").innerHTML = "";
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
  hsRenderReveals(rows);
}

// What the gaps say, in words. The interpretive paragraph is shown only when
// the data have the shape it describes.
function hsRenderReveals(rows) {
  const el = document.getElementById("hsReveals");
  const pts = (r) => Math.round(Math.abs(r.gap) * 100);
  const big = rows.filter((r) => r.gap >= 0.08);
  const small = rows.filter((r) => Math.abs(r.gap) < 0.06);
  const f = (r) => HS_FEATURES[r.key] || { hi: hsPropLabel(r.key, 1).toLowerCase(), lo: hsPropLabel(r.key, 0).toLowerCase() };
  let html;
  if (big.length >= 2) {
    html =
      `<p><strong>Common sense is strongest for statements that are ${hsList(big.map((r) => f(r).hi))}</strong>, ` +
      `and weakest for ${hsList(big.map((r) => f(r).lo))}.`;
    if (small.length) {
      const names = small.map((r) => `${hsPropLabel(r.key, 1).toLowerCase()} vs ${hsPropLabel(r.key, 0).toLowerCase()}`);
      names[0] = names[0][0].toUpperCase() + names[0].slice(1);
      const ptsList = small.map(pts);
      const ptsTxt = ptsList.every((x) => x === ptsList[0])
        ? `${ptsList[0]} point${ptsList[0] === 1 ? "" : "s"}${small.length > 1 ? " each" : ""}`
        : `${hsList(ptsList.map(String))} points`;
      html += ` ${names.length > 1 ? `${hsList(names)} matter` : `${names[0]} matters`} much less (${ptsTxt}).`;
    }
    html += `</p>`;
    if (big.some((r) => r.key === "fact") && small.some((r) => r.key === "physical")) {
      html +=
        `<p>So human common sense looks less like expertise about one domain than a shared, plain way of describing ordinary life. ` +
        `People converge on checkable, literally worded claims about how things are, whether about objects or about people, ` +
        `and part ways once a claim becomes a judgement, an abstraction or a metaphor.</p>`;
    }
  } else {
    const r = rows[0], hiIs1 = r.gap >= 0;
    html = `<p>In this date range the largest gap is ${hsPropLabel(r.key, hiIs1 ? 1 : 0).toLowerCase()} over ${hsPropLabel(r.key, hiIs1 ? 0 : 1).toLowerCase()} statements (${pts(r)} points).</p>`;
  }
  el.innerHTML = `<div class="hs-reveals-kicker">What this reveals</div>${html}`;
}

function hsRenderCorners(d) {
  const el = document.getElementById("hsCorners");
  const dp = d.design_points || {};
  const card = (c, val, title) => {
    if (!c || c.mean === null) return "";
    const chips = PROP_DEFS.map((p) => `<span class="hs-chip k${val}">${esc(val ? p.v1 : p.v0)}</span>`).join("");
    const ex = (c.examples || []).slice(0, 2)
      .map((s) => `<li><span class="hs-quote">${esc(fixStatement(s.text))}</span><span class="hs-corner-ex-score">${hsPct(s.m)}</span></li>`)
      .join("");
    return (
      `<div class="hs-card hs-corner">` +
      `<div class="hs-corner-head"><span class="hs-corner-title">${title}</span><span class="hs-corner-score">${hsPct(c.mean)}</span></div>` +
      `<div class="hs-chips">${chips}</div>` +
      `<div class="hs-corner-meta">Average of ${fmtNum(c.n)} statement${c.n === 1 ? "" : "s"} of this kind, such as:</div>` +
      `<ul class="hs-corner-ex">${ex}</ul></div>`
    );
  };
  el.innerHTML =
    card(dp.concrete, 1, dp.concrete && dp.concrete.rank === 1 ? "The highest-scoring kind" : "Every feature on its first side") +
    card(dp.abstract, 0, "Its exact opposite");
}

function hsRenderDataNote(d) {
  const t = d.totals;
  document.getElementById("hsDataNote").textContent = t.ratings
    ? `Showing ${fmtNum(t.ratings)} ratings, ${hsDate(t.first_date)} to ${hsDate(t.last_date)}. New ratings are added every other day.`
    : "No ratings in the selected date range.";
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
    hsShowTicker(true);
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
  hsInitMapToggle();
  hsInitTicker();
  hsInitObservers();
  window.addEventListener("resize", hsOnResize);
  if (!panel.classList.contains("hidden")) loadHomeSummary();
}

hsInit();
