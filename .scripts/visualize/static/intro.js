"use strict";

// ══ Panel intro cards: a worked example, one click at a time ═══════════════
// Individual Scores, Statement Scores, Design Points, Group Comparison and
// Countries each open with a card that works one real example through, step
// by step, as the LLM stories do (Josh, November 2026). On the panel (the
// data page) the card is only its question, its lead and a row with "Follow
// an example →" and "Show all steps"; either opens the example as a page of
// its own, the same panel at ?view=example (app.js, exampleFromUrl()), where
// the rest of the panel is hidden and "← Back to the data" (in the header)
// or the last step's button returns to it. The example page is laid out as
// the LLM stories are (llm.js): a header card (the question, its lead, the
// open chapters as links and "Show all steps"), then numbered chapter cards
// that open one at a time, one idea each, with "Another …" at the right of
// chapter 1's title, and a bar floating at the bottom of the window with
// Previous, Next (the one filled button) and Start again. Each click puts
// the chapter it changed at the top of the panel (istRevealStep()). Every number in
// a step is computed from counts the server sends, so the reader can check
// each line by hand; a worked square root ends in "≈" when its rounded inputs
// don't give its rounded result.
//
// index.html holds each card's title and lead (.intro[data-intro]); this
// file fills the story (#intro…Story) and its bar (#intro…Bar). app.js calls
// introOnData(panel, data, ctx) through notifyIntro() after each panel load,
// so the example follows the panel's selects and the date filter; the only
// extra requests are for the example itself (/api/user-detail,
// /api/dp-statements, /api/country-cell).
//
// Loaded after app.js (API, esc, fmtNum, fmtPct, fmtShare, roundPct, fmtR,
// fixStatement, dateParams, sqrtHtml, DP_PROPS, PROP_DEFS, openUserDetail,
// compareGroupAEl, compareGroupBEl, loadGroupCompare, cmpSD, …) and home.js
// (HS_FEATURES, the one-line feature glosses).
//
// The formulas are those of utils.py, restated: a statement's consensus is
// |agree − disagree| / raters and its awareness the share who predicted the
// majority's answer (a 50/50 tie counts as agree); a person's consensus and
// awareness are the shares of their counted statements (≥ 10 ratings in the
// reference group) where their answer, or their prediction, matches the
// majority; commonsensicality = √(consensus × awareness). A formula change
// must update these too.

const INTRO_MIN_REF_RATINGS = 10; // utils.py min_ratings_per_statement
const INTRO_MIN_STATEMENTS = 5;   // utils.py min_statements_per_user

// ── Small helpers ───────────────────────────────────────────────────────────

const iB = (x) => `<strong>${x}</strong>`;
const iN = (n) => fmtNum(n);
// A share in a sentence: a whole percent only when it is exact (18 of 30 is
// 60%), else one decimal (or more, rather than call it 0% or 100%)
function iP(v) {
  const w = v * 100;
  return Math.abs(w - Math.round(w)) < 1e-9 ? `${Math.round(w)}%` : fmtShare(v);
}
function inStoreGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function inStoreSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
// "the United States", "all countries" (theCountry() and groupIn() in app.js)
const inThe = (c) => theCountry(c);
const inGroupIn = (g) => groupIn(g);
function inQuote(text) { return `<blockquote class="ist-quote">${esc(fixStatement(text))}</blockquote>`; }
function inOrdinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
// Share of values strictly below x in an ascending array
function inShareBelow(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x - 1e-12) lo = mid + 1; else hi = mid; }
  return sorted.length ? lo / sorted.length : 0;
}
function inMedian(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
// A share of a whole as a whole percent for "higher than 62% of …": never 0%
// or 100% unless it is
function inWholePct(v) {
  if (v > 0 && v < 0.005) return "less than 1%";
  if (v < 1 && v > 0.995) return "more than 99%";
  return `${Math.round(v * 100)}%`;
}

// The worked formula, as a display: its name, the equals signs in one
// column, a line each (as the LLM stories' .llm-calc). lines: [[name, rhs, sign]]
function inCalc(lines) {
  return (
    `<div class="ist-calc">` +
    lines.map(([k, v, sign = "="]) => `<span class="ist-calc-k">${k}</span><span class="ist-calc-eq">${sign}</span><span class="ist-calc-v">${v}</span>`).join("") +
    `</div>`
  );
}
// √(a × b) worked from two percentages: "=" when the rounded inputs give the
// rounded result, else "≈"
function inSqrtLines(a, b, result) {
  const ra = roundPct(a) / 100, rb = roundPct(b) / 100;
  const sign = fmtPct(Math.sqrt(ra * rb)) === fmtPct(result) ? "=" : "≈";
  return [
    ["Commonsensicality", sqrtHtml("consensus × awareness")],
    ["", sqrtHtml(`${fmtPct(a)} × ${fmtPct(b)}`)],
    ["", iB(fmtPct(result)), sign],
  ];
}

// Yes or No, with a ✓ or ✗ against the majority (green and red, --c-yes and
// --c-no, as every ✓ and ✗ on the site)
function inYesNo(v) { return `<span class="ist-yn">${v ? "Yes" : "No"}</span>`; }
function inMark(ok) {
  return `<span class="ist-mark ${ok ? "is-ok" : "is-no"}" aria-label="${ok ? "matches the majority" : "misses the majority"}">${ok ? "✓" : "✗"}</span>`;
}

// One bar, agree from the left and disagree from the right, the majority blue
// and the minority grey (Home's demo bar, .hs-split in home.css), with a tick
// at 50%. The two printed shares add up to 100%.
function inSplitBar(k, n) {
  const p = k / n;
  const a = iP(p);
  const dec = (a.match(/\.(\d+)%/) || ["", ""])[1].length;
  const d = `${(100 - parseFloat(a)).toFixed(dec)}%`;
  const fill = (cls, v) => (v > 0 ? `<span class="hs-split-fill ${cls}" style="flex-grow:${v.toFixed(6)}"></span>` : "");
  return (
    `<div class="hs-split ist-split${p < 0.5 ? " is-maj-dis" : ""}" role="img" aria-label="${a} agree, ${d} disagree">` +
    `<div class="hs-split-labels" aria-hidden="true"><span class="is-agree">Agree <span class="hs-split-val">${a}</span></span>` +
    `<span class="is-dis"><span class="hs-split-val">${d}</span> Disagree</span></div>` +
    `<div class="hs-split-bar" aria-hidden="true"><div class="hs-split-track">${fill("is-agree", p)}${fill("is-dis", 1 - p)}</div>` +
    `<span class="hs-split-mid"></span></div></div>`
  );
}
// The share who said yes to question 2, as one bar from the left
function inYesBar(k2, n) {
  const q = k2 / n;
  return (
    `<div class="ist-qbar" role="img" aria-label="${iP(q)} said yes">` +
    `<div class="ist-qbar-labels" aria-hidden="true"><span>Yes <span class="hs-split-val">${iP(q)}</span></span>` +
    `<span><span class="hs-split-val">${iP(1 - q)}</span> No</span></div>` +
    `<div class="hs-split-bar" aria-hidden="true"><div class="hs-split-track"><span class="hs-split-fill is-q2" style="flex-grow:${q.toFixed(6)}"></span><span class="hs-split-fill is-q2no" style="flex-grow:${(1 - q).toFixed(6)}"></span></div>` +
    `<span class="hs-split-mid"></span></div></div>`
  );
}
// A step's question, numbered as in the survey
function inQuestion(num, text) {
  return `<div class="ist-q"><span class="ist-qn">${num}</span><span>${text}</span></div>`;
}
const IN_Q1 = "Do you agree with this statement?";
const IN_Q2 = "Do you think most other people would agree with it?";

// A sentence on how the vote went, from its counts: "The majority (60.0%) of
// them agreed with it."; a tie counts as a majority that agrees
function inMajoritySentence(k, n, who = "them") {
  const p = k / n;
  if (k === n || k === 0) return `${iB(`Everyone (100%)`)} ${k ? iB("agreed") : iB("disagreed")} with it.`;
  if (2 * k === n) return `${iB("Exactly half (50%)")} of ${who} ${iB("agreed")} with it, which counts as a majority that agreed.`;
  return p > 0.5
    ? `The ${iB(`majority (${iP(p)})`)} of ${who} ${iB("agreed")} with it.`
    : `The ${iB(`majority (${iP(1 - p)})`)} of ${who} ${iB("disagreed")} with it.`;
}

// ══ The stepper ═════════════════════════════════════════════════════════════
// A story is the HTML of every step at once, each element marked with the
// stage it appears at (data-st); paint() shows the elements up to the current
// stage. data-hold keeps a hidden element's room (visibility, not display),
// so nothing moves when it appears; data-hl="a-b" highlights an element
// (.is-hl) only at stages a to b.

const IST = {};

function istMount(key, { storyId, barId, actsId, endLabel, endTarget, another }) {
  const story = document.getElementById(storyId);
  const bar = document.getElementById(barId);
  const acts = document.getElementById(actsId);
  if (!story || !bar) return null;
  const card = story.closest(".intro");
  const S = IST[key] = {
    key, story, bar, acts, card, panel: card.closest(".panel"), stage: 0, last: 0,
    endLabel, endTarget, another, ready: false, example: false, wantAll: false, dataScroll: 0,
  };
  // The header card (example page): the head and the lead, then the open
  // chapters as links and "Show all steps" (.ist-nav). On the data page it
  // is just the top of the card.
  const head = card.querySelector(".intro-head");
  const lede = card.querySelector(".intro-lede");
  if (head) {
    const hc = document.createElement("div");
    hc.className = "ist-headcard";
    head.before(hc);
    hc.append(head);
    if (lede) hc.append(lede);
    S.nav = document.createElement("div");
    S.nav.className = "ist-nav";
    S.nav.innerHTML = `<nav class="ist-toc" aria-label="Chapters"></nav><button type="button" class="ist-link" data-ist-act="all">Show all steps</button>`;
    hc.append(S.nav);
    S.nav.addEventListener("click", (e) => {
      const a = e.target.closest("[data-ist-chap]");
      if (a) { e.preventDefault(); istToChapter(S, Number(a.dataset.istChap)); return; }
      if (e.target.closest('[data-ist-act="all"]')) istGo(key, S.last, { reveal: false });
    });
  }
  // "← Back to the data", above the title, on the example page only. A
  // relative href (no leading /), so it resolves under /report/ too.
  if (head) {
    const back = document.createElement("a");
    back.className = "ist-backlink";
    back.href = TAB_SLUGS[key] || "./";
    back.innerHTML = `<span aria-hidden="true">←</span> Back to the data`;
    back.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      introBackToData(key, false);
    });
    head.prepend(back);
  }
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Worked example");
  bar.innerHTML =
    `<div class="ist-steps">` +
    `<button type="button" class="ist-back" data-ist="prev" aria-label="Previous step"><span aria-hidden="true">←</span> <span class="ist-back-word">Previous</span></button>` +
    `<button type="button" class="ist-next" data-ist="next"><span class="ist-next-label">Follow an example</span> <span aria-hidden="true" class="ist-next-arrow">→</span></button>` +
    `<button type="button" class="ist-back" data-ist="restart" aria-label="Start again"><span aria-hidden="true">↺</span> <span class="ist-back-word">Start again</span></button>` +
    `</div>` +
    `<div class="ist-alt"><button type="button" class="ist-link" data-ist="all">Show all steps</button></div>`;
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ist]");
    if (!b || b.getAttribute("aria-disabled") === "true") return;
    const act = b.dataset.ist;
    if (!S.example) { introOpenExample(key, act === "all"); return; }
    if (act === "next") istNext(key);
    else if (act === "prev") istGo(key, S.stage - 1);
    else if (act === "restart") istGo(key, 1, { top: true });
    // a link that the step hid hands the keyboard focus to Next
    if (b.hidden || b.closest("[hidden]")) S.bar.querySelector(".ist-next").focus({ preventScroll: true });
  });
  // "Another …" sits at the right of chapter 1's title (istSet())
  if (acts) acts.remove();
  story.addEventListener("click", (e) => {
    if (e.target.closest('[data-ist-act="another"]') && another) another.fn();
  });
  istSyncBar(S);
  return S;
}

// New content for a story: the stage is kept (clamped), so a new example or
// a new group shows the same step. On the example page the story starts at
// step 1 (or every step, after "Show all steps") once its data is in.
// chapters: [[first stage, title], …]; each step (a top-level element of
// html) goes into the chapter its stage falls in, one card per chapter
// (.ist-chap, as the LLM stories' llmChap()), which opens at its first stage.
function istSet(key, html, last, chapters = [[1, ""]]) {
  const S = IST[key];
  if (!S) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const stageOf = (el) => {
    if (el.dataset.st) return Number(el.dataset.st);
    const ns = [...el.querySelectorAll("[data-st]")].map((x) => Number(x.dataset.st));
    return ns.length ? Math.min(...ns) : 1;
  };
  const tools = S.another ? `<span class="ist-tools"><button type="button" class="ist-link" data-ist-act="another">${esc(S.another.label)}</button></span>` : "";
  S.story.innerHTML = chapters.map(([from, title], i) =>
    `<section class="ist-chap" data-st="${from}" data-chap="${i + 1}" aria-labelledby="${key}Chap${i + 1}">` +
    `<div class="ist-chap-head"><h3 class="ist-chap-title" id="${key}Chap${i + 1}"><span class="ist-chap-num">${i + 1}</span>${title}</h3>${i === 0 ? tools : ""}</div>` +
    `<div class="ist-chap-body"></div></section>`).join("");
  const bodies = [...S.story.querySelectorAll(".ist-chap-body")];
  [...tmp.children].forEach((el) => {
    const st = stageOf(el);
    let c = 0;
    chapters.forEach(([from], i) => { if (st >= from) c = i; });
    bodies[c].append(el);
  });
  S.chapters = chapters;
  S.last = last;
  S.ready = last > 0;
  S.stage = Math.min(S.stage, last);
  if (S.example && S.ready && (S.wantAll || S.stage < 1)) {
    S.stage = S.wantAll ? last : 1;
    S.wantAll = false;
  }
  istPaint(S, false);
}

function istEmpty(key, message) {
  const S = IST[key];
  if (!S) return;
  S.story.innerHTML = `<p class="ist-empty">${message}</p>`;
  S.chapters = [];
  S.last = 0;
  S.ready = false;
  S.stage = 0;
  istPaint(S, false);
}

function istNext(key) {
  const S = IST[key];
  if (S.stage < S.last) { istGo(key, S.stage + 1); return; }
  introBackToData(key, true);
}

function istGo(key, stage, { top = false, reveal = true } = {}) {
  const S = IST[key];
  const from = S.stage;
  S.stage = Math.max(S.example ? 1 : 0, Math.min(S.last, stage));
  istPaint(S, reveal && S.stage > from);
  if (top) { const sc = S.card.closest(".scores-wrap"); if (sc) sc.scrollTo({ top: 0, behavior: istSmooth() }); }
  else if (!reveal) return;
  else if (S.stage !== from) istRevealStep(S);
}

// ── The example page and the data page ─────────────────────────────────────

const INTRO_TABS = ["scores", "stmtScores", "dp", "compare", "countries"]; // IST keys = app.js tab names

// Called by switchToTab() in app.js on every route: the panel shows its
// worked example as a page (example) or its data with the card folded to its
// question, lead and two ways in
function introSetMode(tab, example) {
  INTRO_TABS.forEach((key) => {
    const S = IST[key];
    if (!S) return;
    const on = key === tab && Boolean(example);
    const was = S.example;
    S.example = on;
    if (S.panel) S.panel.classList.toggle("is-example", on);
    S.card.classList.toggle("is-example", on);
    introApplyCollapsed(S.card);
    if (on && S.ready && (S.wantAll || S.stage < 1)) {
      S.stage = S.wantAll ? S.last : 1;
      S.wantAll = false;
    }
    istPaint(S, false);
    if (on !== was) {
      const sc = S.card.closest(".scores-wrap");
      if (sc) sc.scrollTop = on ? 0 : S.dataScroll;
    }
  });
}

// "Follow an example" (from step 1) or "Show all steps" (every step at once)
function introOpenExample(key, all) {
  const S = IST[key];
  const sc = S.card.closest(".scores-wrap");
  S.dataScroll = sc ? sc.scrollTop : 0;
  S.wantAll = Boolean(all);
  S.stage = 0;
  switchToTab(key, true, true);
  S.bar.querySelector(".ist-next").focus({ preventScroll: true });
}

// "← Back to the data", or the last step's button, which goes on to the
// panel's chart
function introBackToData(key, toChart) {
  const S = IST[key];
  switchToTab(key, true, false);
  if (toChart) {
    const target = S.endTarget && document.querySelector(S.endTarget);
    if (target) istScrollTo(S, target, "start");
  }
}

function istPaint(S, forward) {
  const st = S.stage;
  S.story.querySelectorAll("[data-st]").forEach((el) => {
    const n = Number(el.dataset.st);
    const on = n <= st;
    if (el.hasAttribute("data-hold")) {
      el.classList.toggle("is-pend", !on);
      el.hidden = false;
    } else {
      el.hidden = !on;
    }
    el.classList.toggle("ist-in", forward && n === st && on);
  });
  S.story.querySelectorAll("[data-hl]").forEach((el) => {
    const [a, b] = el.dataset.hl.split("-").map(Number);
    el.classList.toggle("is-hl", st >= a && st <= (b || a));
  });
  S.story.querySelectorAll("[data-latest]").forEach((el) => {
    el.classList.toggle("is-latest", Number(el.dataset.latest) === st);
  });
  S.card.classList.toggle("is-started", st > 0);
  S.card.classList.toggle("is-going", S.example && S.ready && st < S.last);
  istSyncNav(S);
  istSyncBar(S);
}

// The header's links: the open chapters (from the second one on, as in the
// LLM stories) and "Show all steps" (until the end)
function istSyncNav(S) {
  if (!S.nav) return;
  const open = (S.chapters || []).filter(([from]) => S.ready && S.stage >= from);
  S.nav.querySelector(".ist-toc").innerHTML = open.length > 1
    ? open.map(([, title], i) => `<a href="#${S.key}Chap${i + 1}" data-ist-chap="${i + 1}"><span>${i + 1}</span>${title}</a>`).join("")
    : "";
  S.nav.querySelector('[data-ist-act="all"]').hidden = !S.ready || S.stage >= S.last;
}

// The chapter a stage falls in
function istChapterAt(S, stage) {
  let c = 1;
  (S.chapters || []).forEach(([from], i) => { if (stage >= from) c = i + 1; });
  return S.story.querySelector(`.ist-chap[data-chap="${c}"]`);
}

function istSyncBar(S) {
  const q = (sel) => S.bar.querySelector(sel);
  const prev = q('[data-ist="prev"]'), next = q('[data-ist="next"]'), restart = q('[data-ist="restart"]');
  const all = q('[data-ist="all"]');
  const label = next.querySelector(".ist-next-label"), arrow = next.querySelector(".ist-next-arrow");
  // The data page: two ways into the example page
  if (!S.example) {
    prev.hidden = restart.hidden = true;
    all.hidden = false;
    next.setAttribute("aria-disabled", "false");
    label.textContent = "Follow an example";
    arrow.textContent = "→";
    next.setAttribute("aria-label", "Follow a worked example step by step");
    return;
  }
  // The example page: Previous and Start again greyed at step 1; at the end
  // Next goes back to the data, at the panel's chart
  const atStart = S.stage <= 1, atEnd = S.stage >= S.last;
  prev.hidden = restart.hidden = false;
  prev.setAttribute("aria-disabled", String(atStart || !S.ready));
  restart.setAttribute("aria-disabled", String(atStart || !S.ready));
  next.setAttribute("aria-disabled", String(!S.ready));
  label.textContent = !S.ready ? "Loading…" : atEnd ? S.endLabel : "Next";
  arrow.textContent = "→";
  next.setAttribute("aria-label", !S.ready ? "Loading" : atEnd ? `${S.endLabel}: back to the data` : `Next step (${S.stage + 1} of ${S.last})`);
  all.hidden = true;   // in the header on the example page
}

// Where a step may sit: under the toolbar, and above the floating bar and
// 85% of the window's height (the LLM stories' llmBand(), LLM_FOCUS_LINE)
function istBand(S) {
  const sc = S.card.closest(".scores-wrap");
  const w = sc.getBoundingClientRect();
  const bar = S.bar.querySelector(".ist-steps");
  const low = w.bottom - (bar ? bar.offsetHeight + 28 : 14);
  return { top: w.top + 14, bottom: Math.min(low, window.innerHeight * 0.85) };
}

// After Next or Previous, as the LLM stories do (llmRevealStep()): the
// chapter the click changed goes to the top of the panel and stays there for
// its later steps; if what the click revealed would then sit under the bar
// or below the window, the panel scrolls on to centre it above the bar (or to
// put its top at the top, when it is taller than the room)
function istRevealStep(S) {
  const sc = S.card.closest(".scores-wrap");
  const chap = istChapterAt(S, S.stage);
  if (!sc || !chap) return;
  const band = istBand(S);
  let dy = chap.getBoundingClientRect().top - band.top;
  const fresh = [...chap.querySelectorAll("[data-st]")].filter((el) => Number(el.dataset.st) === S.stage && !el.hidden);
  const rects = fresh.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
  if (rects.length) {
    const top = Math.min(...rects.map((r) => r.top)) - dy, bottom = Math.max(...rects.map((r) => r.bottom)) + 6 - dy;
    if (bottom > band.bottom) {
      const centre = (top + bottom) / 2 - (band.top + band.bottom) / 2;
      dy += Math.max(0, Math.min(centre, top - band.top));
    }
  }
  if (Math.abs(dy) >= 1) sc.scrollBy({ top: dy, behavior: istSmooth() });
}

// A chapter link in the header: that chapter to the top
function istToChapter(S, n) {
  const sc = S.card.closest(".scores-wrap");
  const chap = S.story.querySelector(`.ist-chap[data-chap="${n}"]`);
  if (!sc || !chap) return;
  sc.scrollBy({ top: chap.getBoundingClientRect().top - istBand(S).top, behavior: istSmooth() });
}

function istScrollTo(S, el, where) {
  const sc = S.card.closest(".scores-wrap");
  if (!sc || !el) return;
  const dy = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - (where === "start" ? 12 : 0);
  sc.scrollBy({ top: dy, behavior: istSmooth() });
}
function istSmooth() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

// ── Collapse / expand (remembered per panel in this browser) ──────────────

// On the example page the card is never folded; back on the data page it
// takes the reader's last choice again
function introApplyCollapsed(card) {
  const btn = card.querySelector(".intro-toggle");
  const collapsed = !card.classList.contains("is-example") && inStoreGet(`cs-intro-collapsed:${card.dataset.intro}`) === "1";
  card.classList.toggle("is-collapsed", collapsed);
  if (btn) {
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.textContent = collapsed ? "Show" : "Hide";
  }
}

function introInitToggles() {
  document.querySelectorAll(".intro[data-intro]").forEach((card) => {
    const btn = card.querySelector(".intro-toggle");
    if (!btn) return;
    introApplyCollapsed(card);
    btn.addEventListener("click", () => {
      inStoreSet(`cs-intro-collapsed:${card.dataset.intro}`, card.classList.contains("is-collapsed") ? "0" : "1");
      introApplyCollapsed(card);
    });
  });
}

// ── Entry point from app.js ─────────────────────────────────────────────────

function introOnData(panel, data, ctx = {}) {
  try {
    if (panel === "scores") introScoresLoad(data, ctx);
    else if (panel === "stmtScores") introStmtLoad(data, ctx);
    else if (panel === "dp") introDpLoad(data, ctx);
    else if (panel === "compare") introCompareLoad(data, ctx);
    else if (panel === "countries") introCountriesLoad(data);
  } catch (err) {
    console.error("Intro card error:", err);
  }
}

// ══ Individual Scores: one participant, worked through ═════════════════════

const INTRO = {
  scores: { data: null, ctx: null, cands: [], i: 0, req: 0, sorted: [] },
  stmt: { rows: [], ctx: null, kinds: [], i: 0, sorted: [] },
  dp: { data: null, ctx: null, order: [], i: 0, req: 0 },
  compare: { data: null, ctx: null, ex: 0 },
  countries: { data: null, list: [], i: 0, req: 0 },
};

function introScoresLoad(data, ctx) {
  const S = INTRO.scores;
  S.data = data;
  S.ctx = ctx;
  const users = (data && data.users) || [];
  S.sorted = users.map((u) => u.commonsensicality).sort((a, b) => a - b);
  const med = inMedian(S.sorted);
  // A typical participant: about the usual 15 statements, a score near the
  // median, and at least one answer and one prediction that miss the
  // majority, so both marks appear; the closest to those first
  const typical = (u) => u.consensus < 1 && u.awareness < 1 && u.consensus !== u.awareness;
  let pool = users.filter((u) => typical(u) && u.n_statements >= 12 && u.n_statements <= 18);
  if (pool.length < 5) pool = users.filter((u) => typical(u) && u.n_statements >= 5 && u.n_statements <= 40);
  if (!pool.length) pool = users.slice();
  S.cands = pool
    .map((u) => ({ u, k: Math.abs(u.n_statements - 15) * 0.01 + Math.abs(u.commonsensicality - med) }))
    .sort((a, b) => a.k - b.k || (a.u.sessionId < b.u.sessionId ? -1 : 1))
    .slice(0, 40)
    .map((x) => x.u);
  S.i = 0;
  introScoresFetch();
}

async function introScoresFetch() {
  const S = INTRO.scores;
  if (!S.cands.length) {
    istEmpty("scores", "No participants can be scored with these settings, so there is no example to show.");
    return;
  }
  const user = S.cands[S.i % S.cands.length];
  const reference = (S.ctx && S.ctx.reference) || "all";
  const req = ++S.req;
  let d;
  try {
    d = await fetch(`${API}/user-detail?userId=${encodeURIComponent(user.sessionId)}&reference=${encodeURIComponent(reference)}${dateParams()}`).then((r) => r.json());
  } catch {
    if (req === S.req) istEmpty("scores", "The example could not be loaded.");
    return;
  }
  if (req !== S.req) return;
  introScoresRender(user, d);
}

function introScoresRender(user, d) {
  const S = INTRO.scores;
  const ref = (S.ctx && S.ctx.reference) || "all";
  const target = (S.ctx && S.ctx.target) || "all";
  const rows = (d.rows || []).map((r) => {
    const counted = r.counted === true && r.ref_majority != null;
    const maj = counted ? Number(r.ref_majority) : null;
    return {
      text: r.statement, agree: r.I_agree, others: r.others_agree, counted, maj,
      n: r.ref_n_ratings, k: r.ref_k_agree,
      ok1: counted ? r.I_agree === maj : null, ok2: counted ? r.others_agree === maj : null,
    };
  });
  const counted = rows.filter((r) => r.counted);
  const N = counted.length, A = counted.filter((r) => r.ok1).length, B = counted.filter((r) => r.ok2).length;
  if (N !== d.n_scoring || (!d.disqualified && (A !== d.A || B !== d.B))) console.warn("Intro example disagrees with /api/user-detail", { N, A, B, d });
  if (!N || N < INTRO_MIN_STATEMENTS) { S.i++; if (S.i < S.cands.length) introScoresFetch(); return; }
  // The statement to work through: one whose answer and prediction fare
  // differently (both verdicts then show), with a clear majority, the shortest
  const ex = counted.slice().sort((a, b) =>
    (a.ok1 !== a.ok2 ? 0 : 1) - (b.ok1 !== b.ok2 ? 0 : 1) ||
    (a.k / a.n >= 0.55 && a.k / a.n <= 0.95 ? 0 : 1) - (b.k / b.n >= 0.55 && b.k / b.n <= 0.95 ? 0 : 1) ||
    a.text.length - b.text.length)[0];
  const cons = A / N, aw = B / N, m = Math.sqrt(A * B) / N;
  const refIn = inGroupIn(ref);
  const country = user.country && user.country !== "Not stated" ? user.country : null;
  const dateOn = Boolean(globalDateFrom || globalDateTo);
  const nAll = S.sorted.length;
  const below = inShareBelow(S.sorted, m - 1e-12);
  const did = (v) => (v ? "agreed" : "disagreed");
  const pred = (v) => (v ? "would agree" : "would not agree");
  const exMaj = 2 * ex.k >= ex.n ? 1 : 0;
  // the participant's two answers, pointed at by the verdict that rests on them
  const qa =
    `<div class="ist-qa" data-st="3">` +
      `<span class="ist-qa-th"></span><span class="ist-qa-th" data-st="4" data-hold>Their answer</span>` +
      `${inQuestion(1, IN_Q1)}<span class="ist-qa-a ist-point" data-st="4" data-hold data-latest="8">${inYesNo(ex.agree)}</span>` +
      `<div data-st="5" data-hold>${inQuestion(2, IN_Q2)}</div><span class="ist-qa-a ist-point" data-st="6" data-hold data-latest="9">${inYesNo(ex.others)}</span>` +
    `</div>`;
  const verdict1 = ex.ok1
    ? `This participant ${iB("sided with the majority")}, since they also ${iB(did(ex.agree))} with it.`
    : `This participant ${iB("went against the majority")}, since they ${iB(did(ex.agree))} with it.`;
  const verdict2 = `${ex.ok1 === ex.ok2 ? "They also" : "However, they"} ${iB(ex.ok2 ? "correctly predicted" : "incorrectly predicted")} that most people ${iB(pred(ex.others))} with it.`;
  // every statement they rated, ✓ or ✗ against the majority
  const body = rows
    .slice().sort((a, b) => Number(b.counted) - Number(a.counted))
    .map((r) => {
      const majCell = r.counted
        ? `${r.maj ? "Agree" : "Disagree"} <span class="ist-muted">${iP(r.maj ? r.k / r.n : 1 - r.k / r.n)}</span>`
        : `<span class="ist-muted" title="Fewer than ${INTRO_MIN_REF_RATINGS} ratings in ${esc(refIn)}">not counted</span>`;
      const cell = (v, ok) => `${inYesNo(v)}${r.counted ? inMark(ok) : ""}`;
      return (
        `<tr class="${r.counted ? "" : "is-off"}${r === ex ? " is-ex" : ""}">` +
        `<td class="ist-t-stmt">${esc(fixStatement(r.text))}</td>` +
        `<td class="ist-t-maj">${majCell}</td>` +
        `<td class="ist-t-ans" data-hl="11">${cell(r.agree, r.ok1)}</td>` +
        `<td class="ist-t-ans" data-hl="12">${cell(r.others, r.ok2)}</td></tr>`
      );
    }).join("");
  const nOff = rows.length - N;
  const html =
    `<div class="ist-step" data-st="1"><p class="ist-p">Consider this participant${country ? ` from ${iB(esc(inThe(country)))}${inFlagAfter(country)}` : ""}. Here is one of the ${iN(rows.length)} statements they rated:</p>${inQuote(ex.text)}</div>` +
    `<div class="ist-step" data-st="2"><p class="ist-p">We ask them two questions:</p>${qa}</div>` +
    `<div class="ist-step" data-st="7"><p class="ist-p">${iB(iN(ex.n))} people in ${esc(refIn)} rated this statement${dateOn ? ", at any date" : ""}.</p>${inSplitBar(ex.k, ex.n)}<p class="ist-p">${inMajoritySentence(ex.k, ex.n)}</p></div>` +
    `<div class="ist-step ist-verdicts"><p class="ist-p ist-mk" data-st="8">${inMark(ex.ok1)}<span>${verdict1}</span></p><p class="ist-p ist-mk" data-st="9">${inMark(ex.ok2)}<span>${verdict2}</span></p></div>` +
    `<div class="ist-step" data-st="10"><p class="ist-p">If we do the same for all ${iN(rows.length)} statements they rated, we have the following results${nOff ? ` (${iN(nOff)} of them don't count: they have fewer than ${INTRO_MIN_REF_RATINGS} ratings in ${esc(refIn)})` : ""}.</p>` +
      `<div class="ist-table-wrap"><table class="ist-table"><thead><tr><th>Statement</th><th>Majority</th><th class="ist-t-ans" data-hl="11">Agrees?</th><th class="ist-t-ans" data-hl="12">Thinks most agree?</th></tr></thead><tbody>${body}</tbody></table></div></div>` +
    `<div class="ist-step" data-st="11">${inQuestion(1, "How often does their own answer match the majority?")}<p class="ist-p ist-indent">${iB(`${A} out of ${N}`)} (or ${iB(fmtPct(cons))}). We call this their ${iB("consensus score")}.</p></div>` +
    `<div class="ist-step" data-st="12">${inQuestion(2, "How often do they correctly predict the majority?")}<p class="ist-p ist-indent">${iB(`${B} out of ${N}`)} (or ${iB(fmtPct(aw))}). We call this their ${iB("awareness score")}.</p></div>` +
    `<div class="ist-step" data-st="13"><p class="ist-p">We combine these two scores into a ${iB("commonsensicality score")} by taking their geometric average.</p>${inCalc(inSqrtLines(cons, aw, m))}</div>` +
    `<div class="ist-step" data-st="14"><p class="ist-p">Thus, this participant achieves a commonsensicality score of ${iB(fmtPct(m))}, higher than ${iB(inWholePct(below))} of the ${iN(nAll)} participants scored${target === "all" ? "" : ` in ${esc(inThe(target))}`}.</p></div>`;
  istSet("scores", html, 14, [[1, "Their answers"], [10, "Aggregating over all statements"], [13, "Their score"]]);
}

// ══ Statement Scores: one statement, worked through ═══════════════════════

// The examples "Another statement" steps through, each the most-rated
// statement of its kind: a clear majority first, then a rejection that is
// common sense too, an even split, a misjudged majority and a near-universal
// view
const INTRO_STMT_KINDS = [
  (r) => r.I_agree_mean >= 0.75 && r.I_agree_mean <= 0.92 && r.others_agree_mean >= 0.6,
  (r) => r.I_agree_mean <= 0.3 && r.others_agree_mean <= 0.5,
  (r) => Math.abs(r.I_agree_mean - 0.5) <= 0.03,
  (r) => r.I_agree_mean <= 0.35 && r.others_agree_mean >= 0.55,
  (r) => r.I_agree_mean >= 0.95 && r.others_agree_mean >= 0.9,
];

function introStmtLoad(data, ctx) {
  const T = INTRO.stmt;
  T.rows = (data && data.rows) || [];
  T.ctx = ctx;
  T.sorted = T.rows.map((r) => r.commonsensicality).sort((a, b) => a - b);
  const byN = (a, b) => b.n_ratings - a.n_ratings || a.statementId - b.statementId;
  const used = new Set();
  T.kinds = INTRO_STMT_KINDS.map((test) => {
    let c = T.rows.filter((r) => r.n_ratings >= 100 && test(r) && !used.has(r.statementId));
    if (!c.length) c = T.rows.filter((r) => r.n_ratings >= 20 && test(r) && !used.has(r.statementId));
    const row = c.sort(byN)[0];
    if (row) used.add(row.statementId);
    return row;
  }).filter(Boolean);
  if (!T.kinds.length && T.rows.length) T.kinds = [T.rows.slice().sort(byN)[0]];
  T.i = 0;
  introStmtRender();
}

function introStmtRender() {
  const T = INTRO.stmt;
  if (!T.kinds.length) {
    istEmpty("stmtScores", "No statements can be scored with these settings, so there is no example to show.");
    return;
  }
  const r = T.kinds[T.i % T.kinds.length];
  const group = (T.ctx && T.ctx.country) || "all";
  const n = r.n_ratings, k = r.k_agree, k2 = r.k_others;
  const agrees = 2 * k >= n;
  const cons = Math.abs(2 * k - n) / n;
  const aw = agrees ? k2 / n : (n - k2) / n;
  const m = Math.sqrt(cons * aw);
  const below = inShareBelow(T.sorted, m - 1e-12);
  const consLines = agrees
    ? [["Consensus", "(agreed − disagreed) / raters"], ["", `(${iN(k)} − ${iN(n - k)}) / ${iN(n)}`], ["", iB(fmtPct(cons))]]
    : [["Consensus", "(disagreed − agreed) / raters"], ["", `(${iN(n - k)} − ${iN(k)}) / ${iN(n)}`], ["", iB(fmtPct(cons))]];
  const awLines = agrees
    ? [["Awareness", "predicted agree / raters"], ["", `${iN(k2)} / ${iN(n)}`], ["", iB(fmtPct(aw))]]
    : [["Awareness", "predicted disagree / raters"], ["", `${iN(n - k2)} / ${iN(n)}`], ["", iB(fmtPct(aw))]];
  const html =
    `<div class="ist-step" data-st="1"><p class="ist-p">Consider the following statement:</p>${inQuote(r.statement)}</div>` +
    `<p class="ist-p ist-step" data-st="2">It was rated by ${iB(iN(n))} people in ${esc(inGroupIn(group))}, who answered two questions about it.</p>` +
    `<div class="ist-step" data-st="3">${inQuestion(1, IN_Q1)}<div class="ist-indent">${inSplitBar(k, n)}` +
      `<p class="ist-p">${iB(`${iN(k)} agreed`)} and ${iB(`${iN(n - k)} disagreed`)}. ${inMajoritySentence(k, n)}</p></div></div>` +
    `<div class="ist-step ist-indent" data-st="4"><p class="ist-p">The statement's ${iB("consensus score")} is how far this vote is from a 50-50 split: 0% at an even split, 100% when everyone gives the same answer.</p>${inCalc(consLines)}</div>` +
    `<div class="ist-step" data-st="5">${inQuestion(2, IN_Q2)}<div class="ist-indent">${inYesBar(k2, n)}` +
      `<p class="ist-p">${iB(iN(k2))} of them (${iB(iP(k2 / n))}) said yes, most people would agree, and ${iB(iN(n - k2))} (${iB(iP(1 - k2 / n))}) said no.</p></div></div>` +
    `<div class="ist-step ist-indent" data-st="6"><p class="ist-p">Since the majority ${iB(agrees ? "agreed" : "disagreed")}, the statement's ${iB("awareness score")} is the share who correctly predicted that most people ${iB(agrees ? "would agree" : "would not agree")}.</p>${inCalc(awLines)}</div>` +
    `<div class="ist-step" data-st="7"><p class="ist-p">We combine these two scores into a ${iB("commonsensicality score")} by taking their geometric average.</p>${inCalc(inSqrtLines(cons, aw, m))}</div>` +
    `<p class="ist-p ist-step" data-st="8">Thus, this statement receives a commonsensicality score of ${iB(fmtPct(m))}, higher than ${iB(inWholePct(below))} of the ${iN(T.sorted.length)} statements scored in ${esc(inGroupIn(group))}.</p>`;
  istSet("stmtScores", html, 8, [[1, "The statement"], [3, "Consensus"], [5, "Awareness"], [7, "The statement's score"]]);
}

// ══ Design Points: one design point, worked through ═══════════════════════

// The six features' names in a question, as the Statement Scores filter
// names them
const INTRO_FEATURE_Q = {
  fact: "Fact or opinion", physical: "Physical or social", literal_language: "Literal or figure of speech",
  positive: "Positive or normative", knowledge: "Knowledge or reasoning", everyday: "Everyday or abstract",
};

function introDpLoad(data, ctx) {
  const D = INTRO.dp;
  D.data = data;
  D.ctx = ctx;
  const ranked = (data && data.rows) || [];
  // the top-ranked design point, then the lowest-ranked, then the middle one
  const idx = [0, ranked.length - 1, Math.floor((ranked.length - 1) / 2)];
  D.order = [...new Set(idx)].filter((i) => i >= 0 && i < ranked.length).map((i) => ranked[i]);
  D.i = 0;
  introDpFetch();
}

async function introDpFetch() {
  const D = INTRO.dp;
  if (!D.order.length) {
    istEmpty("dp", "No design point has enough scored statements with these settings, so there is no example to show.");
    return;
  }
  const row = D.order[D.i % D.order.length];
  const country = (D.ctx && D.ctx.country) || "all";
  const qs = DP_PROPS.map((p) => `&${p.key}=${row[p.key]}`).join("");
  const req = ++D.req;
  let d;
  try {
    d = await fetch(`${API}/dp-statements?country=${encodeURIComponent(country)}${qs}${dateParams()}`).then((r) => r.json());
  } catch {
    if (req === D.req) istEmpty("dp", "The example could not be loaded.");
    return;
  }
  if (req !== D.req) return;
  introDpRender(row, (d.rows || []).filter((r) => r.qualified));
}

// Every statement's score as a dot on a 0-100% line, the mean marked
function inStripSvg(scores, mean) {
  const W = 1000, H = 54, L = 10, R = 10, y = 22;
  const x = (v) => L + v * (W - L - R);
  const dots = scores.map((v) => `<circle cx="${x(v).toFixed(1)}" cy="${y}" r="5"/>`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) =>
    `<line class="ist-strip-tick" x1="${x(t)}" x2="${x(t)}" y1="${y + 10}" y2="${y + 15}"/><text x="${x(t)}" y="${H - 2}" text-anchor="${t === 0 ? "start" : t === 1 ? "end" : "middle"}">${t * 100}%</text>`).join("");
  return (
    `<svg class="ist-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${scores.length} scores; their mean is ${fmtPct(mean)}">` +
    `<line class="ist-strip-axis" x1="${L}" x2="${W - R}" y1="${y + 10}" y2="${y + 10}"/>${ticks}` +
    `<g class="ist-strip-dots">${dots}</g>` +
    `<line class="ist-strip-mean" x1="${x(mean)}" x2="${x(mean)}" y1="4" y2="${y + 10}"/>` +
    `</svg>`
  );
}

function introDpRender(row, stmts) {
  const D = INTRO.dp;
  const ranked = D.data.rows || [];
  const rank = ranked.indexOf(row) + 1;
  const group = (D.ctx && D.ctx.country) || "all";
  const ex = stmts[0];
  if (!ex) { istEmpty("dp", "The example could not be loaded."); return; }
  const n = row.n, mean = row.mean;
  const code = DP_PROPS.map((p) => (row[p.key] ? "●" : "○")).join("");
  const names = PROP_DEFS.map((p) => (row[p.key] ? p.v1 : p.v0));
  const feats = PROP_DEFS.map((p) => {
    const g = (typeof HS_FEATURES !== "undefined" && HS_FEATURES[p.key]) || {};
    const v = row[p.key];
    return `<span class="ist-f-q">${esc(INTRO_FEATURE_Q[p.key])}</span><span class="ist-f-a">${iB(esc(v ? p.v1 : p.v0))} <span class="ist-muted">${esc(v ? g.d1 || "" : g.d0 || "")}</span></span>`;
  }).join("");
  const top3 = stmts.slice(0, 3).map((s) =>
    `<li><span>${esc(fixStatement(s.statement))}</span><span class="ist-ex-score">${fmtPct(s.commonsensicality)}</span></li>`).join("");
  const scores = stmts.map((s) => s.commonsensicality);
  // the worked interval: mean ± t × SD / √N, from the values as printed
  const sd = row.sd, t = row.t;
  const margin = t * sd / Math.sqrt(n);
  const mShown = roundPct(margin) / 100;
  const marginSign = fmtPct(Number(t.toFixed(3)) * (roundPct(sd) / 100) / Math.sqrt(n)) === fmtPct(margin) ? "=" : "≈";
  const lo = row.ci_lo, hi = row.ci_hi;
  const clipped = mean - margin < 0 || mean + margin > 1;
  const ivSign = !clipped && fmtPct(roundPct(mean) / 100 - mShown) === fmtPct(lo) && fmtPct(roundPct(mean) / 100 + mShown) === fmtPct(hi) ? "=" : "≈";
  const html =
    `<div class="ist-step" data-st="1"><p class="ist-p">Consider the following statement:</p>${inQuote(ex.statement)}</div>` +
    `<div class="ist-step" data-st="2"><p class="ist-p">Like every statement, it is labelled on six features:</p><div class="ist-feats">${feats}</div></div>` +
    `<p class="ist-p ist-step" data-st="3">Its six labels, <span class="ist-code" aria-hidden="true">${code}</span> ${esc(names.join(" · "))}, form its ${iB("design point")}. With two labels for each of six features, there are 2<sup>6</sup> = ${iB("64")} design points.</p>` +
    `<div class="ist-step" data-st="4"><p class="ist-p">In ${esc(inGroupIn(group))}, ${iB(iN(n))} statements in this design point have a score (at least ${INTRO_MIN_REF_RATINGS} ratings). The three most rated:</p><ul class="ist-ex-list">${top3}</ul></div>` +
    `<div class="ist-step" data-st="5"><p class="ist-p">The design point's score is the ${iB("average")} of these ${iN(n)} scores, each a dot here:</p>${inStripSvg(scores, mean)}` +
      inCalc([["Score", `(${scores.slice(0, 3).map((v) => fmtPct(v)).join(" + ")}${n > 3 ? " + …" : ""}) / ${iN(n)}`], ["", iB(fmtPct(mean))]]) + `</div>` +
    `<div class="ist-step" data-st="6"><p class="ist-p">How precise is this average? Its ${iB("95% confidence interval")} is the average plus or minus t × SD / √N, where SD is the standard deviation of the ${iN(n)} scores and t = ${t.toFixed(3)} is Student's t for ${iN(n - 1)} degrees of freedom.</p>` +
      inCalc([["Margin", `${t.toFixed(3)} × ${fmtPct(sd)} / √${iN(n)}`], ["", iB(fmtPct(margin)), marginSign],
              ["Interval", `${fmtPct(mean)} ± ${fmtPct(margin)}`], ["", iB(`${fmtPct(lo)} to ${fmtPct(hi)}`), ivSign]]) +
      (clipped ? `<p class="ist-note">An interval can't go below 0% or above 100%, so it stops there.</p>` : "") + `</div>` +
    `<p class="ist-p ist-step" data-st="7">Ranked by this average against the ${iB(iN(ranked.length))} design points with at least 5 scored statements, it comes ${iB(inOrdinal(rank))}.</p>`;
  istSet("dp", html, 7, [[1, "A statement's design point"], [4, "The design point's score"], [6, "How precise is the score?"]]);
}

// ══ Group Comparison: two groups, worked through ═══════════════════════════

const INTRO_PAIRS = [
  ["United States", "India"],
  ["United Kingdom", "United States"],
  ["United Kingdom", "Nigeria"],
  ["Australia", "New Zealand"],
  ["all", "Canada"],
];
let introPairIdx = 0;

function introAnotherPair() {
  const has = (v) => v === "all" || [...compareGroupAEl.options].some((o) => o.value === v);
  const pairs = INTRO_PAIRS.filter(([a, b]) => has(a) && has(b));
  if (!pairs.length) return;
  const cur = pairs.findIndex(([a, b]) => a === compareGroupAEl.value && b === compareGroupBEl.value);
  introPairIdx = (cur >= 0 ? cur + 1 : introPairIdx) % pairs.length;
  [compareGroupAEl.value, compareGroupBEl.value] = pairs[introPairIdx];
  loadGroupCompare();
}

function introCompareLoad(data, ctx) {
  if (!data) { // the groups changed and are loading
    const S = IST.compare;
    if (S) { S.ready = false; istSyncBar(S); }
    return;
  }
  const C = INTRO.compare;
  C.data = data;
  C.ctx = ctx;
  introCompareRender();
}

function introCompareRender() {
  const C = INTRO.compare;
  const d = C.data, { groupA, groupB } = C.ctx;
  if (groupA === groupB) {
    istEmpty("compare", "Choose two different groups above to compare them.");
    return;
  }
  const A = inGroupIn(groupA), B = inGroupIn(groupB);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const ia = d.individuals.a.map((x) => x.score), ib = d.individuals.b.map((x) => x.score);
  const rawA = d.individuals.raw_n_a, rawB = d.individuals.raw_n_b;
  if (ia.length < 2 || ib.length < 2) {
    istEmpty("compare", "One of these groups has too few scored participants to compare.");
    return;
  }
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ia), mb = mean(ib);
  const sa = cmpSD(ia), sb = cmpSD(ib);
  const pooled = Math.sqrt(((ia.length - 1) * sa * sa + (ib.length - 1) * sb * sb) / (ia.length + ib.length - 2));
  const hiB = mb > ma;
  const [mHi, mLo, gHi] = hiB ? [mb, ma, B] : [ma, mb, A];
  const dval = Math.abs(ma - mb) / pooled;
  const dShown = Number(((roundPct(mHi) - roundPct(mLo)) / roundPct(pooled)).toFixed(2));
  const dSign = dShown.toFixed(2) === dval.toFixed(2) ? "=" : "≈";
  const size = dval < 0.2 ? "negligible" : dval < 0.5 ? "small" : dval < 0.8 ? "medium" : "large";
  const out = [[rawA - ia.length, A], [rawB - ib.length, B]].filter(([k]) => k > 0);
  const scoredLine = out.length
    ? `${out.map(([k, g]) => `in ${esc(g)}, ${iB(iN(k))}`).join(" and ")} rated fewer than ${INTRO_MIN_STATEMENTS} statements with at least ${INTRO_MIN_REF_RATINGS} ratings in their own group, so they have no score.`
    : `Everyone in both groups has a score.`;
  const paired = d.statements.paired;
  const nA = d.statements.a.length, nB = d.statements.b.length;
  // an example statement scored in both: the one most rated in the smaller group
  const byId = (arr) => new Map(arr.map((s) => [s.statementId, s]));
  const sAm = byId(d.statements.a), sBm = byId(d.statements.b);
  const exPair = paired.slice().sort((x, y) =>
    Math.min(sAm.get(y.statementId).n_ratings, sBm.get(y.statementId).n_ratings) - Math.min(sAm.get(x.statementId).n_ratings, sBm.get(x.statementId).n_ratings) || x.statementId - y.statementId)[0];
  const r = paired.length >= 3 ? pearsonR(paired.map((p) => p.score_a), paired.map((p) => p.score_b)) : null;
  const opp = paired.filter((p) => p.maj_a !== p.maj_b).sort((x, y) => Math.abs(y.p_a - y.p_b) - Math.abs(x.p_a - x.p_b));
  const overlap = (groupA === "all") !== (groupB === "all")
    ? ` All countries includes everyone in ${esc(groupA === "all" ? B : A)}, so the two groups overlap.` : "";
  let html =
    `<p class="ist-p ist-step" data-st="1">Consider the participants in ${iB(esc(A))} and in ${iB(esc(B))}: ${iB(iN(rawA))} and ${iB(iN(rawB))} people.${overlap}</p>` +
    `<p class="ist-p ist-step" data-st="2">Each participant is scored against the majority of their own group, as in Individual Scores. ${cap(scoredLine)}</p>` +
    `<p class="ist-p ist-step" data-st="3">The average commonsensicality is ${iB(fmtPct(ma))} across the ${iN(ia.length)} scored participants in ${esc(A)}, and ${iB(fmtPct(mb))} across the ${iN(ib.length)} in ${esc(B)}.</p>` +
    `<div class="ist-step" data-st="4"><p class="ist-p">How large is this gap? ${iB("Cohen's d")} divides it by the two groups' pooled standard deviation, ${fmtPct(pooled)}.</p>` +
      inCalc([["d", `(${fmtPct(mHi)} − ${fmtPct(mLo)}) / ${fmtPct(pooled)}`], ["", iB(dval.toFixed(2)), dSign]]) +
      `<p class="ist-p">By the usual conventions (0.2 small, 0.5 medium, 0.8 large), that is a ${iB(size)} gap${size === "negligible" ? "" : `, with ${esc(gHi)} scoring higher`}.</p></div>` +
    `<p class="ist-p ist-step" data-st="5">Statements are scored within each group too, from at least ${INTRO_MIN_REF_RATINGS} ratings there: ${iB(iN(nA))} in ${esc(A)} and ${iB(iN(nB))} in ${esc(B)}. ${iB(iN(paired.length))} of them are scored in both.</p>`;
  let last = 5;
  if (exPair) {
    const xa = sAm.get(exPair.statementId), xb = sBm.get(exPair.statementId);
    html += `<div class="ist-step" data-st="6"><p class="ist-p">For example, this statement scores ${iB(fmtPct(xa.score))} in ${esc(A)} (${iN(xa.n_ratings)} ratings) and ${iB(fmtPct(xb.score))} in ${esc(B)} (${iN(xb.n_ratings)} ratings):</p>${inQuote(exPair.statement)}</div>`;
    last = 6;
  }
  if (r !== null) {
    last++;
    html += `<p class="ist-p ist-step" data-st="${last}">Across the ${iN(paired.length)} statements scored in both, the two groups' scores correlate at ${iB(`r&nbsp;=&nbsp;${fmtR(r)}`)}: each is a dot in the panel's scatter plot.</p>`;
  }
  if (paired.length) {
    last++;
    if (opp.length) {
      const o = opp[0];
      html += `<div class="ist-step" data-st="${last}"><p class="ist-p">A score doesn't say which way a majority points. On ${iB(iN(opp.length))} of these statements (${iB(fmtPct(opp.length / paired.length))}), the two majorities point opposite ways, such as this one: ${iB(iP(o.p_a))} agree in ${esc(A)}, but ${iB(iP(o.p_b))} in ${esc(B)}.</p>${inQuote(o.statement)}</div>`;
    } else {
      html += `<p class="ist-p ist-step" data-st="${last}">On none of these statements do the two majorities point opposite ways.</p>`;
    }
  }
  istSet("compare", html, last, [[1, "Participants"], [5, "Statements"]]);
}

// ══ Countries: one statement in two countries, worked through ═════════════

// An intuitive first example when the date filter leaves it enough ratings;
// after it, the statements with the widest gap between well-rated countries
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
    list.push({ row: r, hi: hi[0], lo: lo[0], gap: hi[1].s - lo[1].s });
  });
  list.sort((a, b) => b.gap - a.gap);
  const first = list.findIndex((x) => x.row.statementId === INTRO_COUNTRY_FIRST && x.gap >= 15);
  if (first > 0) list.unshift(list.splice(first, 1)[0]);
  C.list = list.slice(0, 15);
  C.i = 0;
  introCountriesFetch();
}

async function introCountriesFetch() {
  const C = INTRO.countries;
  if (!C.list.length) {
    istEmpty("countries", `No statement has ${INTRO_COUNTRY_MIN_N} or more ratings in two countries with these settings, so there is no example to show.`);
    return;
  }
  const ex = C.list[C.i % C.list.length];
  const req = ++C.req;
  let cells;
  try {
    cells = await Promise.all([ex.hi, ex.lo].map((c) =>
      fetch(`${API}/country-cell?statementId=${encodeURIComponent(ex.row.statementId)}&country=${encodeURIComponent(c)}${dateParams()}`).then((r) => r.json())));
  } catch {
    if (req === C.req) istEmpty("countries", "The example could not be loaded.");
    return;
  }
  if (req !== C.req) return;
  if (cells.some((c) => c.error)) { istEmpty("countries", "The example could not be loaded."); return; }
  introCountriesRender(ex, cells);
}

// One country's score from its counts: the counts, then the three lines
function inCountryCalc(c) {
  const n = c.n_ratings, k = c.k_agree, k2 = c.k_others;
  const agrees = 2 * k >= n;
  const cons = Math.abs(2 * k - n) / n, aw = agrees ? k2 / n : (n - k2) / n;
  const m = Math.sqrt(cons * aw);
  const lines = [
    ["Consensus", `(${iN(agrees ? k : n - k)} − ${iN(agrees ? n - k : k)}) / ${iN(n)} = ${fmtPct(cons)}`],
    ["Awareness", `${iN(agrees ? k2 : n - k2)} / ${iN(n)} = ${fmtPct(aw)}`],
    ...inSqrtLines(cons, aw, m).slice(1).map((l, i) => (i ? l : ["Commonsensicality", l[1], l[2]])),
  ];
  return { n, k, k2, agrees, cons, aw, m, calc: inCalc(lines) };
}

// A country's flag after its name in a sentence or chapter title ("from the
// United States 🇺🇸"), where a flag before it would split "the" from the name;
// "" when there is none (flagHtml() in app.js).
function inFlagAfter(country) {
  return flagHtml(country).replace('class="flag"', 'class="flag is-after"');
}

function introCountriesRender(ex, [ca, cb]) {
  const a = inCountryCalc(ca), b = inCountryCalc(cb);
  const A = inThe(ex.hi), B = inThe(ex.lo);
  const people = (c, x) =>
    `In ${iB(esc(c))}, ${iB(iN(x.n))} people rated it: ${iB(iN(x.k))} agreed (${iB(iP(x.k / x.n))}), and ${iB(iN(x.k2))} predicted that most people would agree (${iB(iP(x.k2 / x.n))}).` +
    ` Since the majority ${x.agrees ? "agreed" : "disagreed"}, awareness counts those who predicted that most ${x.agrees ? "would" : "would not"} agree.`;
  let compare;
  if (a.agrees !== b.agrees) {
    compare = `Here the two majorities point opposite ways: most people ${a.agrees ? "agree" : "disagree"} in ${esc(A)}, and most ${b.agrees ? "agree" : "disagree"} in ${esc(B)}. Each score only says how widely its own country's majority view is shared, and how well it is predicted.`;
  } else {
    const view = a.agrees ? "agree" : "disagree";
    // Compared as shown (one decimal), so the words never contradict the
    // figures beside them; an equal pair reads "as …" (both unanimous, say)
    const cmp = (x, y) => Math.sign(roundPct(x) - roundPct(y));
    const consTxt = `consensus ${fmtPct(a.cons)} against ${fmtPct(b.cons)}`;
    const awTxt = `awareness ${fmtPct(a.aw)} against ${fmtPct(b.aw)}`;
    const up = [], down = [];
    const c = cmp(a.cons, b.cons), w = cmp(a.aw, b.aw);
    (c >= 0 ? up : down).push(`${c > 0 ? "more" : c < 0 ? "less" : "as"} widely shared (${consTxt})`);
    (w >= 0 ? up : down).push(`${w > 0 ? "better" : w < 0 ? "less well" : "as well"} predicted (${awTxt})`);
    compare = `Both majorities ${view}, but in ${esc(A)} that view is ${up.join(", and ")}` +
      (down.length ? `, though ${down[0]}` : "") + ".";
  }
  const row = ex.row;
  const nC = Object.values(row.scores).filter((v) => v.s != null).length;
  const html =
    `<div class="ist-step" data-st="1"><p class="ist-p">Consider the following statement:</p>${inQuote(row.statement)}</div>` +
    `<p class="ist-p ist-step" data-st="2">${people(A, a)}</p>` +
    `<div class="ist-step ist-indent" data-st="3">${a.calc}</div>` +
    `<p class="ist-p ist-step" data-st="4">${people(B, b)}</p>` +
    `<div class="ist-step ist-indent" data-st="5">${b.calc}</div>` +
    `<p class="ist-p ist-step" data-st="6">So the statement scores ${iB(fmtPct(a.m))} in ${esc(A)} and ${iB(fmtPct(b.m))} in ${esc(B)}. ${compare}</p>` +
    `<p class="ist-p ist-step" data-st="7">Across the ${iB(iN(nC))} countries where it has at least ${INTRO_MIN_REF_RATINGS} ratings, its scores average ${iB(fmtPts(row.mean))}` +
      (nC > 1 && row.sd != null ? `, with a standard deviation of ${iB(fmtPts(row.sd))}` : "") + `: its Mean and SD in the Countries table, where every score is out of 100.</p>` +
    `<p class="ist-p ist-step" data-st="8">Scores from few ratings are noisy: with only 10 ratings, a country's score is typically off by about ${iB("16 points")}, so compare countries where a statement has many ratings.</p>`;
  istSet("countries", html, 8, [[1, `In ${esc(A)}${inFlagAfter(ex.hi)}`], [4, `In ${esc(B)}${inFlagAfter(ex.lo)}`], [6, "Comparing countries"]]);
}

// ── Init ────────────────────────────────────────────────────────────────────

function introInit() {
  introInitToggles();
  istMount("scores", {
    storyId: "introScoresStory", barId: "introScoresBar", actsId: "introScoresActs",
    endLabel: "See every participant", endTarget: "#panelScores .chart-card",
    another: { label: "Another participant", fn: () => { INTRO.scores.i++; introScoresFetch(); } },
  });
  istMount("stmtScores", {
    storyId: "introStmtStory", barId: "introStmtBar", actsId: "introStmtActs",
    endLabel: "See every statement", endTarget: "#panelStmtScores .chart-card",
    another: { label: "Another statement", fn: () => { INTRO.stmt.i++; introStmtRender(); } },
  });
  istMount("dp", {
    storyId: "introDpStory", barId: "introDpBar", actsId: "introDpActs",
    endLabel: "See every design point", endTarget: "#panelDP .chart-card",
    another: { label: "Another design point", fn: () => { INTRO.dp.i++; introDpFetch(); } },
  });
  istMount("compare", {
    storyId: "introCompareStory", barId: "introCompareBar", actsId: "introCompareActs",
    endLabel: "See the charts", endTarget: "#panelCompare .compare-layout",
    another: { label: "Another pair", fn: introAnotherPair },
  });
  istMount("countries", {
    storyId: "introCountriesStory", barId: "introCountriesBar", actsId: "introCountriesActs",
    endLabel: "See every country", endTarget: "#panelCountries .search-filter-row",
    another: { label: "Another statement", fn: () => { INTRO.countries.i++; introCountriesFetch(); } },
  });
  // Data that arrived before this file loaded (app.js starts its requests first)
  if (typeof stmtScoresAllRows !== "undefined" && stmtScoresAllRows.length && !INTRO.stmt.rows.length) {
    introStmtLoad({ rows: stmtScoresAllRows }, { country: stmtScoresCountrySelect.value });
  }
  if (typeof cmpData !== "undefined" && cmpData && !INTRO.compare.data) {
    introCompareLoad(cmpData, { groupA: cmpGroupA, groupB: cmpGroupB });
  }
  // app.js routed before this file loaded: show the example page if the URL asks
  introSetMode(_currentTab, exampleFromUrl());
}

introInit();
