// ── Evenly spaced table columns (Josh, November 2026) ──────────────────────
// In every table on the site the space between any two neighbouring columns'
// contents is the same. fitTable() measures each column's natural width (the
// widest of its cells, header included) with the table laid out at its
// max-content and its min-content width (.fit-measure, .fit-min in
// style.css), then sets each column, through a <colgroup>, to a content
// width plus one shared gap G, with G/2 of padding on either side of every
// cell (.is-fit, --fit-half). The space between two columns' contents is
// then G whatever their alignment.
//
// When every column fits at its natural width, a table that fills its
// container spreads the spare room into G; a table that shrinks to its
// content keeps G = FIT_GAP. When they don't fit, G = FIT_GAP and the
// columns that can wrap give up width, widest first: a heading down to its
// column's body, a statement down to FIT_TEXT_FLOOR (or half the room); then the gap narrows,
// then the floor goes. A table whose container scrolls sideways (the
// Countries matrix) scrolls rather than lose the floor; one that still
// doesn't fit keeps its stylesheet layout (phones).
//
// Elements with no text (bar tracks, icons) are held at their rendered width
// while measuring, or a flex: 1 track would measure 0. A table's
// data-fit-rank (set by the paged tables' renderers) is measured in place of
// the first rank, so paging doesn't move the columns. Sort arrows are out of
// the flow (style.css), so sorting doesn't either. Tables refit when their
// rows or classes change (a MutationObserver) and when their container's
// width changes (a ResizeObserver, which also catches a panel or modal being
// shown). The Design Points table is a forest plot laid out by DP_FIXED_W and
// dpFitWidth() in app.js, so it is left alone, as is anything inside
// [data-fit-off]. A table's data-fit-text-max (rem) caps its widest columns,
// so a long statement wraps and the other columns spread out.
const FIT_GAP = 28;
const FIT_GAP_MIN = 12;
const FIT_TEXT_FLOOR = 17; // rem: a statement column keeps at least this (or half the width)
const fitSaved = new WeakMap(); // table → inline styles before fitting
const fitLastW = new WeakMap(); // table → container width at the last fit
const fitWatched = new WeakSet(); // containers under the ResizeObserver

function fitSkip(t) {
  return t.classList.contains("dp-table") || !!t.closest("[data-fit-off]");
}

function fitContainerWidth(t) {
  const p = t.parentElement;
  if (!p) return 0;
  const cs = getComputedStyle(p);
  return p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

// A row's cells as drawn: a cell hidden by the stylesheet (a column dropped
// on phones) is not a column
function fitCells(r) {
  return [...r.cells].filter((c) => c.getClientRects().length);
}

function fitColumns(t) {
  const rows = [...t.rows].filter((r) => r.getClientRects().length);
  let n = 0;
  rows.forEach((r) => {
    let k = 0;
    for (const c of fitCells(r)) k += c.colSpan || 1;
    n = Math.max(n, k);
  });
  // a row with one cell per column: the header's last row, else a body row
  const head = t.tHead ? rows.filter((r) => r.parentElement === t.tHead).reverse() : [];
  const ref = [...head, ...rows].find((r) => fitCells(r).length === n);
  return { n, ref: ref && fitCells(ref) };
}

function fitReset(t) {
  const s = fitSaved.get(t);
  if (!s) return;
  t.style.tableLayout = s.layout;
  t.style.width = s.width;
  t.style.minWidth = s.minWidth;
  t.style.maxWidth = s.maxWidth;
  t.style.removeProperty("--fit-half");
  s.cols.forEach(([col, w]) => { col.style.width = w; });
  if (s.made && s.made.parentNode) s.made.remove();
  t.classList.remove("is-fit");
  fitSaved.delete(t);
}

// Holds every textless element in the cells at its rendered width while
// the table is measured; returns the undo
function fitFreeze(t) {
  const found = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.textContent.trim() === "") found.push(c);
      else walk(c);
    }
  };
  for (const r of t.rows) for (const cell of r.cells) walk(cell);
  const sized = found
    .map((el) => [el, el.getBoundingClientRect().width])
    .filter(([, w]) => w > 0);
  const undo = sized.map(([el]) => [el, el.style.cssText]);
  sized.forEach(([el, w]) => {
    el.style.width = `${w}px`;
    el.style.minWidth = `${w}px`;
    el.style.flex = "0 0 auto";
  });
  return () => undo.forEach(([el, css]) => { el.style.cssText = css; });
}

// Widths for the columns in `avail`: each column at its max-content width
// at most and at its min-content width (or the floor, for long text) at
// least; the widest columns give way first. Null if even that doesn't fit.
function fitWater(maxW, minW, avail, floor) {
  const lo = maxW.map((m, i) => Math.max(minW[i], Math.min(m, floor[i])));
  if (lo.reduce((a, b) => a + b, 0) > avail + 0.5) return null;
  const at = (T) => maxW.map((m, i) => Math.min(m, Math.max(lo[i], T)));
  const sum = (T) => at(T).reduce((a, b) => a + b, 0);
  let a = 0, b = Math.max(...maxW);
  for (let k = 0; k < 40; k++) {
    const mid = (a + b) / 2;
    if (sum(mid) > avail) b = mid; else a = mid;
  }
  return at(a);
}

function fitTable(t) {
  if (!t || !t.isConnected || fitSkip(t)) return;
  const p = t.parentElement;
  if (p && !fitWatched.has(p)) { fitWatched.add(p); fitRO.observe(p); }
  const W = fitContainerWidth(t);
  if (W <= 0 || !t.getClientRects().length) return; // hidden: fit when shown
  fitLastW.set(t, W);
  try {
    fitApply(t, W);
  } finally {
    fitMO.takeRecords(); // this fit's own changes
  }
}

function fitApply(t, W) {
  const p = t.parentElement;
  fitReset(t);
  const { n, ref } = fitColumns(t);
  if (!n || !ref) return;
  const origW = t.getBoundingClientRect().width;
  // scroll sideways only where the table already did (the Countries matrix,
  // the wide audit tables), not where it was squeezed into a modal or phone
  const scroll = /auto|scroll/.test(getComputedStyle(p).overflowX) && origW > W + 1;

  const thaw = fitFreeze(t);
  // hold the table's height while it is measured, or a panel scrolled near
  // its foot would lose its place when the rows briefly stop wrapping
  const keepH = t.style.height;
  t.style.height = `${t.getBoundingClientRect().height}px`;
  const rk = t.dataset.fitRank && t.querySelector("td.td-rank");
  const rkText = rk && rk.textContent;
  if (rk) rk.textContent = t.dataset.fitRank;
  t.classList.add("fit-measure");
  const maxW = ref.map((c) => c.getBoundingClientRect().width);
  // the body's own widths, without the header: a column whose body is short
  // (numbers under a long heading) can wrap its heading down to them
  let bodyW = maxW;
  const body = [...t.tBodies].flatMap((b) => [...b.rows])
    .find((r) => r.getClientRects().length && fitCells(r).length === n);
  if (body && t.tHead) {
    const cells = fitCells(body);
    t.classList.add("fit-nohead");
    bodyW = cells.map((c) => c.getBoundingClientRect().width);
    t.classList.remove("fit-nohead");
  }
  t.classList.add("fit-min");
  const minW = ref.map((c, i) => Math.min(maxW[i], c.getBoundingClientRect().width));
  t.classList.remove("fit-measure", "fit-min");
  if (rk) rk.textContent = rkText;
  t.style.height = keepH;
  thaw();

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  // data-fit-text-max (rem) caps any column's width, so long text wraps
  // there and the room it leaves goes into the gap between every column
  // (the statements of the participant modal, Statement Scores and the
  // Design Points detail list, 22rem; Josh, November 18, 2026)
  const capRem = parseFloat(t.dataset.fitTextMax);
  if (capRem > 0) {
    const cap = capRem * rem;
    maxW.forEach((m, i) => { if (m > cap) maxW[i] = Math.max(minW[i], cap); });
  }
  const sumMax = maxW.reduce((a, b) => a + b, 0);
  const fill = origW >= W - 1;
  const floor = bodyW.map((w) => Math.min(w, FIT_TEXT_FLOOR * rem, W / 2));
  const none = floor.map(() => 0);
  let G = FIT_GAP, widths = null;
  if (sumMax + n * FIT_GAP <= W) {
    widths = maxW;
    if (fill) G = Math.floor(((W - sumMax) / n) * 10) / 10;
  } else {
    const stages = scroll
      ? [[FIT_GAP, floor], [20, floor]]
      : [[FIT_GAP, floor], [20, floor], [20, none], [FIT_GAP_MIN, none]];
    for (const [g, f] of stages) {
      widths = fitWater(maxW, minW, W - n * g, f);
      if (widths) { G = g; break; }
    }
    if (!widths && scroll) {
      G = FIT_GAP;
      widths = maxW.map((m, i) => Math.max(minW[i], Math.min(m, floor[i])));
    }
  }
  if (!widths) return; // too narrow: the stylesheet's layout stays

  let cg = t.querySelector(":scope > colgroup");
  const saved = {
    layout: t.style.tableLayout, width: t.style.width,
    minWidth: t.style.minWidth, maxWidth: t.style.maxWidth,
    cols: [], made: null,
  };
  if (!cg || cg.children.length !== n) {
    if (cg) cg.remove(); // a colgroup that doesn't match the columns
    cg = document.createElement("colgroup");
    for (let i = 0; i < n; i++) cg.appendChild(document.createElement("col"));
    t.insertBefore(cg, t.firstChild);
    saved.made = cg;
  } else {
    saved.cols = [...cg.children].map((col) => [col, col.style.width]);
  }
  fitSaved.set(t, saved);
  [...cg.children].forEach((col, i) => { col.style.width = `${widths[i] + G}px`; });
  t.style.setProperty("--fit-half", `${G / 2}px`);
  t.style.tableLayout = "fixed";
  t.style.width = `${widths.reduce((a, b) => a + b + G, 0)}px`;
  t.style.minWidth = "0";
  t.style.maxWidth = "none";
  t.classList.add("is-fit");

  // Tighten: a wrapped heading or statement, or centred content, can fall
  // short of its column. Each column then shrinks to what its cells use, and
  // the room it frees joins the gap (in a table that fills its container).
  const used = fitExtents(t, n);
  if (used) {
    const tight = used.map((u, i) => Math.min(widths[i], u + 1));
    const total = widths.reduce((a, b) => a + b + G, 0);
    const G2 = fill && total <= W + 0.5
      ? Math.floor(((total - tight.reduce((a, b) => a + b, 0)) / n) * 10) / 10
      : G;
    [...cg.children].forEach((col, i) => { col.style.width = `${tight[i] + G2}px`; });
    t.style.setProperty("--fit-half", `${G2 / 2}px`);
    t.style.width = `${tight.reduce((a, b) => a + b + G2, 0)}px`;
  }

  if (t.classList.contains("cm-table") && typeof cmFixStickyLefts === "function") {
    cmFixStickyLefts();
    cmSyncHScroll();
  }
}

// How wide each column's content is as laid out: the span from the leftmost
// to the rightmost text or textless box in its cells (sort arrows and
// screen-reader text left out)
function fitExtents(t, n) {
  const L = new Array(n).fill(Infinity), R = new Array(n).fill(-Infinity);
  const range = document.createRange();
  const add = (i, r) => {
    if (r.width > 0 && r.height > 0) { L[i] = Math.min(L[i], r.left); R[i] = Math.max(R[i], r.right); }
  };
  const walk = (el, i) => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) {
        if (!c.textContent.trim()) continue;
        range.selectNodeContents(c);
        for (const r of range.getClientRects()) add(i, r);
      } else if (c.nodeType === 1) {
        if (c.matches(".sort-icon, .cm-sort-icon, .sr-only")) continue;
        if (c.textContent.trim() === "") add(i, c.getBoundingClientRect());
        else walk(c, i);
      }
    }
  };
  for (const r of t.rows) {
    if (!r.getClientRects().length) continue;
    const cells = fitCells(r);
    if (cells.length === n) cells.forEach((cell, i) => walk(cell, i));
  }
  const used = L.map((l, i) => R[i] - l);
  return used.every((u) => u > 0 && isFinite(u)) ? used : null;
}

function fitAll() {
  document.querySelectorAll("table").forEach(fitTable);
}

const fitRO = new ResizeObserver((entries) => {
  for (const e of entries) {
    for (const t of e.target.querySelectorAll(":scope > table")) {
      if (fitContainerWidth(t) !== fitLastW.get(t)) fitTable(t);
    }
  }
});

// A table refits when its rows, text, classes or hidden flags change
const fitMO = new MutationObserver((records) => {
  const tables = new Set();
  for (const r of records) {
    const node = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const t = node && node.closest("table");
    if (t) tables.add(t);
    for (const a of r.addedNodes || []) {
      if (a.nodeType !== 1) continue;
      if (a.tagName === "TABLE") tables.add(a);
      else a.querySelectorAll("table").forEach((x) => tables.add(x));
    }
  }
  tables.forEach(fitTable);
});
fitMO.observe(document.body, {
  childList: true, subtree: true, characterData: true,
  attributes: true, attributeFilter: ["class", "hidden"],
});
fitAll();
