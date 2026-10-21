"use strict";

const PAGE_SIZE = 25;

// ── API base + mount path ──────────────────────────────────────────────────
// Derive the API root and mount path from this script's own URL so the app
// works both at the site root (local dev: http://localhost:8080/) and when
// mounted under a sub-path in production (e.g. /report/).
// app.js is served from "<mount>/static/app.js", so the mount root is two
// levels up.
const { API, MOUNT_PATH } = (() => {
  const sc =
    document.currentScript || document.querySelector('script[src*="app.js"]');
  const mountRoot = new URL("../", new URL(sc.src)); // parent of static/
  return {
    API: new URL("api", mountRoot).href.replace(/\/$/, ""),
    MOUNT_PATH: mountRoot.pathname, // "/" locally, "/report/" in production
  };
})();

// ── Shared chart styling ───────────────────────────────────────────────────
// Canvas charts can't use CSS variables, so UI reads the colour tokens from
// style.css (for the current theme), and CHART_FONT turns its type scale into
// pixel sizes. Every chart (Chart.js or a plugin drawing on its canvas) uses
// these, so chart text is the page's font, never smaller than --fs-1, and in
// the page's greys. HTML and SVG drawn from JS use the tokens themselves
// ("var(--c-agree)"), so they follow a theme change without a redraw; only
// the canvas charts are recoloured, by applyThemeToCharts() below.
function readUiTokens() {
  const root = getComputedStyle(document.documentElement);
  const v = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
  return {
    dark: document.documentElement.dataset.theme === "dark",
    font: getComputedStyle(document.body).fontFamily,
    rootPx: parseFloat(root.fontSize) || 19,
    ink: v("--c-ink", "#1C1914"),
    text: v("--c-text", "#2A251F"),
    body: v("--c-body", "#463E35"),
    muted: v("--c-muted", "#6A5F51"),
    faint: v("--c-faint", "#ADA290"),
    line: v("--c-line-2", "#D8CEBD"),
    lineLight: v("--c-line", "#E8E1D4"),
    grid: v("--c-line-soft", "#F1ECE2"),
    surface: v("--c-surface", "#FFFDF9"),
    accentBg: v("--c-accent-bg", "#EEF3FC"),
    tooltip: v("--c-tooltip", "rgba(28, 25, 20, 0.94)"),
    tooltipLine: v("--c-tooltip-line", "transparent"),
    agree: v("--c-agree", "#2A78D6"),
    agreeInk: v("--c-agree-ink", "#1C5CAB"),
    agreeSoft: v("--c-agree-soft", "#BFD3EE"),
    agreeDot: v("--c-agree-dot", "rgba(42, 120, 214, 0.22)"),
    agreeBand: v("--c-agree-band", "rgba(42, 120, 214, 0.10)"),
    expect: v("--c-expect", "#EB6834"),
    expectInk: v("--c-expect-ink", "#A8461D"),
    split: v("--c-split", "#C3C2B7"),
    bad: v("--c-bad", "#C03030"),
    chrome: v("--c-chrome", "#2E2924"),
  };
}
const UI = readUiTokens();
const CHART_FONT = {
  tick: { size: Math.round(UI.rootPx * 0.72 * 10) / 10 },   // --fs-1
  title: { size: Math.round(UI.rootPx * 0.8 * 10) / 10 },   // --fs-2
  legend: { size: Math.round(UI.rootPx * 0.8 * 10) / 10 },  // --fs-2
};
// A canvas font string for plugin labels, e.g. chartCanvasFont(600)
function chartCanvasFont(weight = 600, size = CHART_FONT.tick.size) {
  return `${weight} ${size}px ${UI.font}`;
}
// The colours of Chart.defaults follow the theme (applyThemeToCharts())
function setChartDefaultColors() {
  Chart.defaults.color = UI.muted;
  Chart.defaults.borderColor = UI.grid;
  // Tooltips in the warm ink of the page's own tooltips (--c-tooltip); on
  // the dark theme they are a lighter step than the page, with a hairline
  Chart.defaults.plugins.tooltip.backgroundColor = UI.tooltip;
  Chart.defaults.plugins.tooltip.borderColor = UI.tooltipLine;
  Chart.defaults.plugins.tooltip.borderWidth = UI.dark ? 1 : 0;
}
if (window.Chart) {
  Chart.defaults.font.family = UI.font;
  Chart.defaults.font.size = CHART_FONT.tick.size;
  Chart.defaults.plugins.tooltip.titleFont = { size: CHART_FONT.legend.size, weight: "600" };
  Chart.defaults.plugins.tooltip.bodyFont = { size: CHART_FONT.legend.size };
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
  setChartDefaultColors();
}

// ── Theme: light, dark, or the system's (menu in the top bar) ─────────────
// The inline script in index.html's <head> sets data-theme on <html> before
// the page draws, from the same localStorage key and media query, so the
// page never flashes the wrong theme. Every colour is a CSS token (style.css
// redefines them under :root[data-theme="dark"]), so switching is a matter
// of setting the attribute; the canvas charts, which hold resolved colours,
// are recoloured in place. Other scripts can listen for "cs-themechange" on
// document.
const THEME_KEY = "cs-theme";
const THEME_PREFS = ["system", "light", "dark"];
const themeMql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function themePref() {
  let v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch (e) { /* storage blocked */ }
  return v === "light" || v === "dark" ? v : "system";
}
function systemTheme() {
  return themeMql && themeMql.matches ? "dark" : "light";
}
function resolvedTheme(pref = themePref()) {
  return pref === "system" ? systemTheme() : pref;
}

// Swap every colour a chart holds that was one of the old theme's tokens for
// the new theme's, then redraw it. Chart colours all come from UI, so an
// exact match on the old values finds them (scriptable options are
// functions that read UI when drawn, so they need nothing).
function applyThemeToCharts(oldUi) {
  if (!window.Chart) return;
  setChartDefaultColors();
  const swaps = new Map();
  for (const [k, v] of Object.entries(oldUi)) {
    if (typeof v === "string" && k !== "font" && UI[k] !== v) swaps.set(v, UI[k]);
  }
  if (!swaps.size) return;
  const seen = new Set();
  const swap = (obj) => {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    seen.add(obj);
    for (const key of Object.keys(obj)) {
      if (key === "data" || key.startsWith("_")) continue; // points, internals
      const val = obj[key];
      if (typeof val === "string") {
        if (swaps.has(val)) obj[key] = swaps.get(val);
      } else if (val && typeof val === "object") swap(val);
    }
  };
  Object.values(Chart.instances).forEach((chart) => {
    chart.data.datasets.forEach(swap);
    swap(chart.config.options);
    // Chart.js shares one resolved options object among a dataset's
    // elements, and update("none") leaves it as it was; a full update
    // renews it, here with animation off so the new colours show at once,
    // as the CSS ones do. The chart's own animation setting comes back on
    // its next update.
    const raw = chart.config.options;
    const had = Object.prototype.hasOwnProperty.call(raw, "animation"), prev = raw.animation;
    raw.animation = false;
    chart.update();
    if (had) raw.animation = prev;
    else delete raw.animation;
  });
}

// Draw the page in a theme ("light" or "dark"). Transitions are held off
// while the tokens change, so every colour switches in the same frame
// rather than buttons fading after the rest.
function renderTheme(theme) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const oldUi = { ...UI };
  root.classList.add("theme-switching");
  root.dataset.theme = theme;
  Object.assign(UI, readUiTokens()); // reading the tokens applies the new styles
  root.classList.remove("theme-switching");
  applyThemeToCharts(oldUi);
  // The browser's own toolbar (mobile) matches the top bar
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", UI.chrome);
  document.dispatchEvent(new CustomEvent("cs-themechange", { detail: { theme } }));
}

function applyTheme() {
  renderTheme(resolvedTheme(themeChoice));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", UI.chrome);
  renderThemeMenu();
}

// Paper is white: print in the light theme, then return to the reader's
window.addEventListener("beforeprint", () => renderTheme("light"));
window.addEventListener("afterprint", () => renderTheme(resolvedTheme(themeChoice)));

// The reader's choice: "system", "light" or "dark" (kept here as well as in
// localStorage, so it holds for the visit when storage is blocked)
let themeChoice = themePref();
function setThemePref(pref) {
  themeChoice = THEME_PREFS.includes(pref) ? pref : "system";
  try {
    if (themeChoice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, themeChoice);
  } catch (e) { /* storage blocked */ }
  applyTheme();
}

const themeMenuEl = document.getElementById("themeMenu");
const themeBtn = document.getElementById("themeBtn");
const themePop = document.getElementById("themePop");
const THEME_NAMES = { system: "System", light: "Light", dark: "Dark" };

function renderThemeMenu() {
  if (!themeBtn) return;
  const pref = themeChoice, theme = document.documentElement.dataset.theme;
  const label = pref === "system"
    ? `Theme: match the system (now ${theme})`
    : `Theme: ${THEME_NAMES[pref].toLowerCase()}`;
  themeBtn.title = label;
  themeBtn.setAttribute("aria-label", label);
  themeBtn.dataset.pref = pref;
  themePop.querySelectorAll("[data-theme-pref]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.themePref === pref));
  });
  const note = document.getElementById("themeSystemNote");
  if (note) note.textContent = systemTheme() === "dark" ? "Dark now" : "Light now";
}

function setThemePopOpen(open, focusItem = false) {
  if (!themePop) return;
  themePop.hidden = !open;
  themeBtn.setAttribute("aria-expanded", String(open));
  if (open && focusItem) {
    const items = [...themePop.querySelectorAll("[data-theme-pref]")];
    (items.find((b) => b.getAttribute("aria-checked") === "true") || items[0]).focus();
  }
}

if (themeBtn && themePop) {
  themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setDatePopOpen(false); // one top-bar popover at a time
    // opened from the keyboard, focus goes into the menu
    setThemePopOpen(themePop.hidden, e.detail === 0);
  });
  themeBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setDatePopOpen(false);
      setThemePopOpen(true, true);
    } else if (e.key === "Escape") {
      setThemePopOpen(false);
    }
  });
  themePop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-pref]");
    if (!b) return;
    setThemePref(b.dataset.themePref);
    setThemePopOpen(false);
    themeBtn.focus();
  });
  themePop.addEventListener("keydown", (e) => {
    const items = [...themePop.querySelectorAll("[data-theme-pref]")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Escape") {
      setThemePopOpen(false);
      themeBtn.focus();
    } else if (e.key === "Tab") {
      setThemePopOpen(false);
    }
  });
  document.addEventListener("click", (e) => {
    if (!themePop.hidden && !themeMenuEl.contains(e.target)) setThemePopOpen(false);
  });
}
// Follow the system while the reader hasn't picked a theme, and a choice
// made in another tab
if (themeMql) {
  const onSystemChange = () => { if (themeChoice === "system") applyTheme(); else renderThemeMenu(); };
  if (themeMql.addEventListener) themeMql.addEventListener("change", onSystemChange);
  else if (themeMql.addListener) themeMql.addListener(onSystemChange);
}
window.addEventListener("storage", (e) => {
  if (e.key === THEME_KEY) { themeChoice = themePref(); applyTheme(); }
});
applyTheme();

// ── Panel URL routing ──────────────────────────────────────────────────────
const TAB_SLUGS = {
  home:       "",
  scores:     "individual_scores",
  stmtScores: "statement_scores",
  dp:         "design_points",
  compare:    "group_comparison",
  countries:  "countries",
  stmtGen:    "statement_generation",
  stmtAudit:  "statement_audit",
  tsAudit:    "typesafe_audit",
  llm:        "llm_evaluations",
};
const SLUG_TABS = Object.fromEntries(
  Object.entries(TAB_SLUGS).map(([k, v]) => [v, k])
);

// ── DOM refs ───────────────────────────────────────────────────────────────

// Modal
const userModal = document.getElementById("userModal");
const modalExplanation = document.getElementById("modalExplanation");
const stmtModal = document.getElementById("stmtModal");
const stmtModalClose = document.getElementById("stmtModalClose");
const stmtPropsModal = document.getElementById("stmtPropsModal");
const stmtPropsClose = document.getElementById("stmtPropsClose");
const modalUserId = document.getElementById("modalUserId");
const modalUserScores = document.getElementById("modalUserScores");
const modalBody = document.getElementById("modalBody");
const modalClose = document.getElementById("modalClose");

// Statement Scores tab
const stmtScoresCountrySelect = document.getElementById(
  "stmtScoresCountrySelect",
);
const dpCountrySelect = document.getElementById("dpCountrySelect");
const stmtScoresSummaryEl = document.getElementById("stmtScoresSummary");
const stmtScoresSpinnerEl = document.getElementById("stmtScoresSpinner");
const stmtScoresBody = document.getElementById("stmtScoresBody");
const btnStmtScoresPrev = document.getElementById("btnStmtScoresPrev");
const btnStmtScoresNext = document.getElementById("btnStmtScoresNext");
const stmtScoresPageInfoEl = document.getElementById("stmtScoresPageInfo");
const stmtScoresFilterLabel = document.getElementById("stmtScoresFilterLabel");

// Scores tab
const targetSelect = document.getElementById("targetSelect");
const referenceSelect = document.getElementById("referenceSelect");
const scoresSpinnerEl = document.getElementById("scoresSpinner");
const scoresBody = document.getElementById("scoresBody");
const btnScoresPrev = document.getElementById("btnScoresPrev");
const btnScoresNext = document.getElementById("btnScoresNext");
const scoresPageInfoEl = document.getElementById("scoresPageInfo");
const scoresFilterLabel = document.getElementById("scoresFilterLabel");

// ── State ──────────────────────────────────────────────────────────────────

// Scores
let allScoresRows = []; // raw from API, never mutated
let allScoresExcluded = []; // users below threshold, shown grayed out
let scoresRows = []; // current view: filtered + sorted slice of allScoresRows
let scoresPage = 1;
let scoresLoaded = false;

// Scores: sort
let sortKey = "commonsensicality";
let sortDir = "desc";

// Scores: histogram bin filter
let activeBinIdx = null; // null = no filter

// Histogram
let histChart = null;
let histBinEdges = [];

// World map
let _worldMapGeo = null; // cached GeoJSON paths
let _homeMapLoaded = false;
let _homeCountryData = null; // {data: {country: n}, insuff: {country: n}}
let _selectedHomeCountry = null; // currently selected server country name
let _homeMapMode = "count"; // "count" (participants, log bins) | "continent"; toggled in home.js

// Statement Scores
let stmtScoresAllRows = [],
  stmtScoresAllExcluded = [], // statements below threshold, shown grayed out
  stmtScoresRows = [],
  stmtScoresPage = 1;
let stmtScoresLoaded = false;
let dpPanelLoaded = false;

// Design Point Coverage (statement-generation) — declared here (not with the
// rest of that section, appended near the end of this file) because
// switchToTab() below reads it on the very first page load, before a `let`
// declared later in the file would be initialized.
let sgLoaded = false;

// The panel on screen (set by switchToTab), for code that can't read it from
// the tab bar: Home and the statement-generation pages have no tab button
let _currentTab = "home";

// Country matrix
let countryMatrixLoaded = false;
let countryMatrixData   = null;
let cmPage              = 1;
const CM_PAGE_SIZE      = 25;
let cmSortKey           = 'n';    // 'n' | 'stmt' | country-name
let cmView              = 'score'; // cells show 'score' or 'agree' (share who agree)
let cmOnlyFlips         = false;   // only statements whose countries' majorities differ
let cmSortDir           = 'desc'; // 'asc' | 'desc'
let stmtScoresSortKey = "commonsensicality",
  stmtScoresSortDir = "desc";
let stmtScoresActiveBinIdx = null;
let stmtScoresLens = ""; // a key of STMT_LENSES, or "" for every statement
let stmtScoresHistChart = null,
  stmtScoresHistBinEdges = [];

// ── Design-point constants ─────────────────────────────────────────────────
const DP_PROPS = [
  { key: "fact", label: "Fact" },
  { key: "physical", label: "Physical" },
  {
    key: "literal_language",
    label: "Literal language",
    labelHtml: "Literal<br>language",
  },
  { key: "positive", label: "Positive" },
  { key: "knowledge", label: "Knowledge" },
  { key: "everyday", label: "Everyday" },
];
// The forest plot's width: dpFitWidth() stretches it over the table's free
// space (DP_W_MIN–DP_W_MAX) each time the table is drawn or resized
const DP_W_MIN = 240, DP_W_MAX = 560;
let DP_W = 280;
const DP_H = 18,
  DP_PAD = 12;
let DP_PW = DP_W - DP_PAD * 2; // inner plot width
// Fixed columns beside the plot (.dp-col-* in style.css): N, six features,
// mean score and 95% CI, plus a little slack
const DP_FIXED_W = 70 + 6 * 64 + 68 + 120 + 16;

// ── Country -> ISO 3166-1 alpha-2, for rendering flag emoji ─────────────────
// Keys match the country_reside naming convention used throughout data/*.csv
// (see .scripts/visualize/data/crt_rme_demo.csv).
const COUNTRY_TO_ISO2 = {
  "Afghanistan": "AF", "Albania": "AL", "Algeria": "DZ", "Andorra": "AD",
  "Angola": "AO", "Antigua and Barbuda": "AG", "Argentina": "AR",
  "Armenia": "AM", "Australia": "AU", "Austria": "AT", "Azerbaijan": "AZ",
  "Bahamas": "BS", "Bahrain": "BH", "Bangladesh": "BD", "Barbados": "BB",
  "Belarus": "BY", "Belgium": "BE", "Belize": "BZ", "Benin": "BJ",
  "Bolivia": "BO", "Bosnia and Herzegovina": "BA", "Botswana": "BW",
  "Brazil": "BR", "Brunei": "BN", "Bulgaria": "BG", "Burundi": "BI",
  "Cambodia": "KH", "Cameroon": "CM", "Canada": "CA",
  "Central African Republic": "CF", "Chad": "TD", "Chile": "CL",
  "China": "CN", "Colombia": "CO", "Congo": "CG", "Costa Rica": "CR",
  "Croatia": "HR", "Cyprus": "CY", "Czechia": "CZ", "Denmark": "DK",
  "Dominica": "DM", "Dominican Republic": "DO", "Ecuador": "EC",
  "Egypt": "EG", "El Salvador": "SV", "Eritrea": "ER", "Estonia": "EE",
  "Eswatini": "SZ", "Ethiopia": "ET", "Fiji": "FJ", "Finland": "FI",
  "France": "FR", "Gabon": "GA", "Gambia": "GM", "Georgia": "GE",
  "Germany": "DE", "Ghana": "GH", "Greece": "GR", "Grenada": "GD",
  "Guatemala": "GT", "Guyana": "GY", "Haiti": "HT", "Honduras": "HN",
  "Hungary": "HU", "Iceland": "IS", "India": "IN", "Indonesia": "ID",
  "Iran": "IR", "Iraq": "IQ", "Ireland": "IE", "Israel": "IL",
  "Italy": "IT", "Jamaica": "JM", "Japan": "JP", "Jordan": "JO",
  "Kazakhstan": "KZ", "Kenya": "KE", "Korea, North": "KP",
  "Korea, South": "KR", "Kosovo": "XK", "Kyrgyzstan": "KG", "Laos": "LA",
  "Latvia": "LV", "Lebanon": "LB", "Liberia": "LR", "Lithuania": "LT",
  "Luxembourg": "LU", "Malawi": "MW", "Malaysia": "MY", "Malta": "MT",
  "Mauritius": "MU", "Mexico": "MX", "Micronesia": "FM", "Moldova": "MD",
  "Monaco": "MC", "Morocco": "MA", "Mozambique": "MZ",
  "Myanmar (Burma)": "MM", "Namibia": "NA", "Nepal": "NP",
  "Netherlands": "NL", "New Zealand": "NZ", "Nicaragua": "NI",
  "Nigeria": "NG", "North Macedonia (formerly Macedonia)": "MK",
  "Norway": "NO", "Oman": "OM", "Pakistan": "PK", "Panama": "PA",
  "Peru": "PE", "Philippines": "PH", "Poland": "PL", "Portugal": "PT",
  "Qatar": "QA", "Romania": "RO", "Russia": "RU", "Saint Lucia": "LC",
  "Saint Vincent and the Grenadines": "VC", "Saudi Arabia": "SA",
  "Serbia": "RS", "Singapore": "SG", "Slovakia": "SK", "Slovenia": "SI",
  "Somalia": "SO", "South Africa": "ZA", "Spain": "ES", "Sri Lanka": "LK",
  "Sudan": "SD", "Suriname": "SR", "Sweden": "SE", "Switzerland": "CH",
  "Taiwan": "TW", "Tanzania": "TZ", "Thailand": "TH", "Togo": "TG",
  "Trinidad and Tobago": "TT", "Turkey": "TR", "Uganda": "UG",
  "Ukraine": "UA", "United Arab Emirates": "AE", "United Kingdom": "GB",
  "United States": "US", "Uruguay": "UY", "Vatican City": "VA",
  "Venezuela": "VE", "Vietnam": "VN", "Zambia": "ZM", "Zimbabwe": "ZW",
};

function countryFlagEmoji(iso2) {
  return String.fromCodePoint(
    ...[...iso2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)),
  );
}

// Builds the "Country" cell markup for a scores-table row. Hovering or
// clicking the flag shows the full country name (see the flag-popup handling
// further down this file).
function flagCellHtml(country) {
  const iso2 = country ? COUNTRY_TO_ISO2[country] : null;
  if (!iso2) {
    return `<span class="flag-icon flag-unknown" data-country="${esc(country || "Unknown")}">?</span>`;
  }
  return `<span class="flag-icon" data-country="${esc(country)}">${countryFlagEmoji(iso2)}</span>`;
}

// Attaches hover/click handlers to every .flag-icon inside `root` so the
// country name is revealed without also triggering the row's own click
// handler (e.g. openUserDetail). Must stop propagation directly on the flag
// element itself -- by the time a document-level delegated listener runs,
// the row's click handler has already fired.
let flagPopupPinned = false;
let flagPopupActiveEl = null;
const flagPopupEl = document.getElementById("flagPopup");

function showFlagPopup(el) {
  flagPopupEl.textContent = el.dataset.country;
  const rect = el.getBoundingClientRect();
  flagPopupEl.style.left = `${Math.round(rect.left)}px`;
  flagPopupEl.style.top = `${Math.round(rect.bottom + 6)}px`;
  flagPopupEl.classList.add("visible");
}

function hideFlagPopup() {
  flagPopupEl.classList.remove("visible");
  flagPopupPinned = false;
  flagPopupActiveEl = null;
}

function attachFlagHandlers(root) {
  root.querySelectorAll(".flag-icon").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      if (!flagPopupPinned) showFlagPopup(el);
    });
    el.addEventListener("mouseleave", () => {
      if (!flagPopupPinned) hideFlagPopup();
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (flagPopupPinned && flagPopupActiveEl === el) {
        hideFlagPopup();
      } else {
        flagPopupPinned = true;
        flagPopupActiveEl = el;
        showFlagPopup(el);
      }
    });
  });
}

document.addEventListener("click", (e) => {
  if (flagPopupPinned && !e.target.closest(".flag-icon")) hideFlagPopup();
});

// Property filter definitions (value 1 = first label, 0 = second label)
const PROP_DEFS = [
  {
    key: "fact",
    v1: "Fact",
    v0: "Opinion",
    def1: "Something that can be demonstrated to be correct or incorrect, independently of anyone's opinion.",
    def0: "Something that someone might think is true, or wants others to think is true, but can't be demonstrated to be objectively correct or incorrect. That is, it is inherently subjective.",
  },
  {
    key: "physical",
    v1: "Physical",
    v0: "Social",
    def1: "It refers to objective features of the world as described by, say, physics, biology, engineering, mathematics or other natural rules. It can be measured empirically, or derived logically.",
    def0: 'It refers to beliefs, perceptions, preferences, and socially constructed rules that govern human experience. It can be "real" or opinion, but is intrinsically of human origins.',
  },
  {
    key: "literal_language",
    v1: "Literal language",
    v0: "Figure of speech",
    def1: "It is plain and ordinary language that means exactly what it says.",
    def0: "It contains an aphorism, metaphor, hyperbole, etc.",
  },
  {
    key: "positive",
    v1: "Positive",
    v0: "Normative",
    def1: "It refers to something in the world such as an empirical regularity or scientific law.",
    def0: "It refers to a judgment, belief, value, social norm or convention.",
  },
  {
    key: "knowledge",
    v1: "Knowledge",
    v0: "Reasoning",
    def1: "It refers to some observation about the world; it may be true or false, opinion or fact, subjective or objective.",
    def0: "It presents a conclusion that is arrived at by combining knowledge and logic.",
  },
  {
    key: "everyday",
    v1: "Everyday",
    v0: "Abstract",
    def1: "It is about something people encounter, or could encounter, situations like this in the course of their ordinary, everyday experiences.",
    def0: "It refers to regularities or conclusions that cannot be observed or arrived at solely through individual experience.",
  },
];
// ── Country flag / abbreviation lookup ────────────────────────────────────
const COUNTRY_FLAGS = {
  'Afghanistan':'🇦🇫','Albania':'🇦🇱','Algeria':'🇩🇿','Andorra':'🇦🇩',
  'Angola':'🇦🇴','Antigua and Barbuda':'🇦🇬','Argentina':'🇦🇷','Armenia':'🇦🇲',
  'Australia':'🇦🇺','Austria':'🇦🇹','Azerbaijan':'🇦🇿','Bahamas':'🇧🇸',
  'Bahrain':'🇧🇭','Bangladesh':'🇧🇩','Barbados':'🇧🇧','Belarus':'🇧🇾',
  'Belgium':'🇧🇪','Belize':'🇧🇿','Benin':'🇧🇯','Bolivia':'🇧🇴',
  'Bosnia and Herzegovina':'🇧🇦','Botswana':'🇧🇼','Brazil':'🇧🇷','Brunei':'🇧🇳',
  'Bulgaria':'🇧🇬','Burundi':'🇧🇮','Cambodia':'🇰🇭','Cameroon':'🇨🇲',
  'Canada':'🇨🇦','Central African Republic':'🇨🇫','Chad':'🇹🇩','Chile':'🇨🇱',
  'China':'🇨🇳','Colombia':'🇨🇴','Congo':'🇨🇬','Costa Rica':'🇨🇷',
  'Croatia':'🇭🇷','Cuba':'🇨🇺','Cyprus':'🇨🇾','Czechia':'🇨🇿',
  'Denmark':'🇩🇰','Dominica':'🇩🇲','Dominican Republic':'🇩🇴','Ecuador':'🇪🇨',
  'Egypt':'🇪🇬','El Salvador':'🇸🇻','Eritrea':'🇪🇷','Estonia':'🇪🇪',
  'Eswatini':'🇸🇿','Ethiopia':'🇪🇹','Fiji':'🇫🇯','Finland':'🇫🇮',
  'France':'🇫🇷','Gabon':'🇬🇦','Gambia':'🇬🇲','Georgia':'🇬🇪',
  'Germany':'🇩🇪','Ghana':'🇬🇭','Greece':'🇬🇷','Grenada':'🇬🇩',
  'Guatemala':'🇬🇹','Guyana':'🇬🇾','Haiti':'🇭🇹','Honduras':'🇭🇳',
  'Hungary':'🇭🇺','Iceland':'🇮🇸','India':'🇮🇳','Indonesia':'🇮🇩',
  'Iran':'🇮🇷','Iraq':'🇮🇶','Ireland':'🇮🇪','Israel':'🇮🇱',
  'Italy':'🇮🇹','Jamaica':'🇯🇲','Japan':'🇯🇵','Jordan':'🇯🇴',
  'Kazakhstan':'🇰🇿','Kenya':'🇰🇪','Korea, North':'🇰🇵','Korea, South':'🇰🇷',
  'Kosovo':'🇽🇰','Kuwait':'🇰🇼','Kyrgyzstan':'🇰🇬','Laos':'🇱🇦',
  'Latvia':'🇱🇻','Lebanon':'🇱🇧','Liberia':'🇱🇷','Libya':'🇱🇾',
  'Lithuania':'🇱🇹','Luxembourg':'🇱🇺','Malawi':'🇲🇼','Malaysia':'🇲🇾',
  'Malta':'🇲🇹','Mauritius':'🇲🇺','Mexico':'🇲🇽','Micronesia':'🇫🇲',
  'Moldova':'🇲🇩','Monaco':'🇲🇨','Morocco':'🇲🇦','Mozambique':'🇲🇿',
  'Myanmar (Burma)':'🇲🇲','Namibia':'🇳🇦','Nepal':'🇳🇵','Netherlands':'🇳🇱',
  'New Zealand':'🇳🇿','Nicaragua':'🇳🇮','Nigeria':'🇳🇬',
  'North Macedonia (formerly Macedonia)':'🇲🇰','Norway':'🇳🇴','Oman':'🇴🇲',
  'Pakistan':'🇵🇰','Panama':'🇵🇦','Paraguay':'🇵🇾','Peru':'🇵🇪',
  'Philippines':'🇵🇭','Poland':'🇵🇱','Portugal':'🇵🇹','Qatar':'🇶🇦',
  'Romania':'🇷🇴','Russia':'🇷🇺','Saint Lucia':'🇱🇨',
  'Saint Vincent and the Grenadines':'🇻🇨','Saudi Arabia':'🇸🇦',
  'Senegal':'🇸🇳','Serbia':'🇷🇸','Singapore':'🇸🇬','Slovakia':'🇸🇰',
  'Slovenia':'🇸🇮','Somalia':'🇸🇴','South Africa':'🇿🇦','Spain':'🇪🇸',
  'Sri Lanka':'🇱🇰','Sudan':'🇸🇩','Suriname':'🇸🇷','Sweden':'🇸🇪',
  'Switzerland':'🇨🇭','Syria':'🇸🇾','Taiwan':'🇹🇼','Tanzania':'🇹🇿',
  'Thailand':'🇹🇭','Togo':'🇹🇬','Trinidad and Tobago':'🇹🇹','Tunisia':'🇹🇳',
  'Turkey':'🇹🇷','Uganda':'🇺🇬','Ukraine':'🇺🇦','United Arab Emirates':'🇦🇪',
  'United Kingdom':'🇬🇧','United States':'🇺🇸','Uruguay':'🇺🇾',
  'Uzbekistan':'🇺🇿','Vatican City':'🇻🇦','Venezuela':'🇻🇪','Vietnam':'🇻🇳',
  'Yemen':'🇾🇪','Zambia':'🇿🇲','Zimbabwe':'🇿🇼',
};
const COUNTRY_CODE = {
  'Afghanistan':'AF','Albania':'AL','Algeria':'DZ','Andorra':'AD',
  'Angola':'AO','Antigua and Barbuda':'AG','Argentina':'AR','Armenia':'AM',
  'Australia':'AU','Austria':'AT','Azerbaijan':'AZ','Bahamas':'BS',
  'Bahrain':'BH','Bangladesh':'BD','Barbados':'BB','Belarus':'BY',
  'Belgium':'BE','Belize':'BZ','Benin':'BJ','Bolivia':'BO',
  'Bosnia and Herzegovina':'BA','Botswana':'BW','Brazil':'BR','Brunei':'BN',
  'Bulgaria':'BG','Burundi':'BI','Cambodia':'KH','Cameroon':'CM',
  'Canada':'CA','Central African Republic':'CF','Chad':'TD','Chile':'CL',
  'China':'CN','Colombia':'CO','Congo':'CG','Costa Rica':'CR',
  'Croatia':'HR','Cuba':'CU','Cyprus':'CY','Czechia':'CZ',
  'Denmark':'DK','Dominica':'DM','Dominican Republic':'DO','Ecuador':'EC',
  'Egypt':'EG','El Salvador':'SV','Eritrea':'ER','Estonia':'EE',
  'Eswatini':'SZ','Ethiopia':'ET','Fiji':'FJ','Finland':'FI',
  'France':'FR','Gabon':'GA','Gambia':'GM','Georgia':'GE',
  'Germany':'DE','Ghana':'GH','Greece':'GR','Grenada':'GD',
  'Guatemala':'GT','Guyana':'GY','Haiti':'HT','Honduras':'HN',
  'Hungary':'HU','Iceland':'IS','India':'IN','Indonesia':'ID',
  'Iran':'IR','Iraq':'IQ','Ireland':'IE','Israel':'IL',
  'Italy':'IT','Jamaica':'JM','Japan':'JP','Jordan':'JO',
  'Kazakhstan':'KZ','Kenya':'KE','Korea, North':'KP','Korea, South':'KR',
  'Kosovo':'XK','Kuwait':'KW','Kyrgyzstan':'KG','Laos':'LA',
  'Latvia':'LV','Lebanon':'LB','Liberia':'LR','Libya':'LY',
  'Lithuania':'LT','Luxembourg':'LU','Malawi':'MW','Malaysia':'MY',
  'Malta':'MT','Mauritius':'MU','Mexico':'MX','Micronesia':'FM',
  'Moldova':'MD','Monaco':'MC','Morocco':'MA','Mozambique':'MZ',
  'Myanmar (Burma)':'MM','Namibia':'NA','Nepal':'NP','Netherlands':'NL',
  'New Zealand':'NZ','Nicaragua':'NI','Nigeria':'NG',
  'North Macedonia (formerly Macedonia)':'MK','Norway':'NO','Oman':'OM',
  'Pakistan':'PK','Panama':'PA','Paraguay':'PY','Peru':'PE',
  'Philippines':'PH','Poland':'PL','Portugal':'PT','Qatar':'QA',
  'Romania':'RO','Russia':'RU','Saint Lucia':'LC',
  'Saint Vincent and the Grenadines':'VC','Saudi Arabia':'SA',
  'Senegal':'SN','Serbia':'RS','Singapore':'SG','Slovakia':'SK',
  'Slovenia':'SI','Somalia':'SO','South Africa':'ZA','Spain':'ES',
  'Sri Lanka':'LK','Sudan':'SD','Suriname':'SR','Sweden':'SE',
  'Switzerland':'CH','Syria':'SY','Taiwan':'TW','Tanzania':'TZ',
  'Thailand':'TH','Togo':'TG','Trinidad and Tobago':'TT','Tunisia':'TN',
  'Turkey':'TR','Uganda':'UG','Ukraine':'UA','United Arab Emirates':'AE',
  'United Kingdom':'GB','United States':'US','Uruguay':'UY',
  'Uzbekistan':'UZ','Vatican City':'VA','Venezuela':'VE','Vietnam':'VN',
  'Yemen':'YE','Zambia':'ZM','Zimbabwe':'ZW',
};
function countryFlag(name) { return COUNTRY_FLAGS[name] || ''; }
function countryCode(name) { return COUNTRY_CODE[name] || name; }

// State: { v1: bool, v0: bool }. Both false OR both true = no filter.
const ssPropFilters = Object.fromEntries(
  PROP_DEFS.map((d) => [d.key, { v1: false, v0: false }]),
);
const cmPropFilters = Object.fromEntries(
  PROP_DEFS.map((d) => [d.key, { v1: false, v0: false }]),
);

// Individual Scores search
let scoresSearchQuery = "";

// Global date filter (applies to all panels)
let globalDateFrom = "";
let globalDateTo = "";

function dateParams() {
  const parts = [];
  if (globalDateFrom) parts.push(`date_from=${encodeURIComponent(globalDateFrom)}`);
  if (globalDateTo) parts.push(`date_to=${encodeURIComponent(globalDateTo)}`);
  return parts.length ? "&" + parts.join("&") : "";
}

// Statement search queries
let stmtScoresSearchQuery = "";
let dpDetailSearchQuery   = "";
let cmSearchQuery         = "";

// ── Utilities ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pctBar(value) {
  const pct = (value * 100).toFixed(1);
  const cls = value >= 0.5 ? "pct-fill-high" : "pct-fill-low";
  return (
    `<div class="pct-wrap">` +
    `<div class="pct-track"><div class="${cls}" style="width:${pct}%"></div></div>` +
    `<span class="pct-label">${pct}%</span></div>`
  );
}

function pctBarScore(value) {
  const pct = (value * 100).toFixed(1);
  return (
    `<div class="pct-wrap">` +
    `<div class="pct-track"><div class="pct-fill-score" style="width:${pct}%"></div></div>` +
    `<span class="pct-label">${pct}%</span></div>`
  );
}

function fmtNum(n) {
  return n.toLocaleString();
}
// A square root whose bar spans everything under it. The sign is drawn (an
// SVG stretched to the terms' height), so its top meets the bar over the
// terms (.sqrt-arg's top border) in any font; screen readers hear "the square
// root of". Used for every √ in the explorer's HTML; the LLM level-curve
// chart draws its own in SVG (llmLvlProbe).
function sqrtHtml(inner) {
  return `<span class="sqrt"><span class="sr-only">the square root of </span><svg class="sqrt-sign" viewBox="0 0 10 20" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0.6 11.6 L2.7 10.5 L5.3 19.3 L9.7 0.75 H10"/></svg><span class="sqrt-arg">${inner}</span></span>`;
}

function fmtPct(v) {
  return (v * 100).toFixed(1) + "%";
}

// A correlation as the LLM panel writes it (llmR() in llm.js): two decimals,
// no leading zero, a true minus sign: .63, −.13
function fmtR(r) {
  return r.toFixed(2).replace(/^(-?)0\./, "$1.").replace("-", "−");
}

function badge(value) {
  return value === 1
    ? '<span class="badge-yes">Yes</span>'
    : '<span class="badge-no">No</span>';
}

// A participant's Yes / No, marked against the majority (maj 1 = agrees,
// 0 = disagrees, null = the statement doesn't count): green ✓ when it matches,
// red ✗ when it doesn't. Colour alone never says yes or no.
function answerPill(value, maj) {
  const word = value === 1 ? "Yes" : "No";
  if (maj === null || maj === undefined) return `<span class="ans-pill is-off">${word}</span>`;
  const ok = value === maj;
  return `<span class="ans-pill ${ok ? "is-match" : "is-miss"}" title="${ok ? "Matches" : "Misses"} the majority"><span aria-hidden="true">${ok ? "✓" : "✗"}</span>${word}</span>`;
}

// The reference group's majority on a statement and the share who gave it,
// as in the Individual Scores intro card ("Agree 94%", "Disagree 79%")
function refAvgAgree(mean) {
  if (mean === null || mean === undefined) return "—";
  return mean >= 0.5
    ? `Agree <span class="td-muted">${fmtPct(mean)}</span>`
    : `Disagree <span class="td-muted">${fmtPct(1 - mean)}</span>`;
}

function refAvgOthers(mean) {
  return mean === null || mean === undefined ? "—" : fmtPct(mean);
}

// Source and category (from statements/statements_1.csv) appear only in the
// statement modals, fetched when one opens rather than carried in every table
const stmtMetaCache = {};
let stmtMetaRequestId = 0;

function capFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

async function showStmtMeta(el, statementId) {
  el.innerHTML = "";
  if (statementId === undefined || statementId === null) return;
  const requestId = ++stmtMetaRequestId;
  try {
    if (!(statementId in stmtMetaCache)) {
      const r = await fetch(`${API}/statement-meta?statementId=${encodeURIComponent(statementId)}`);
      if (!r.ok) return;
      stmtMetaCache[statementId] = await r.json();
    }
  } catch {
    return;
  }
  // Another statement may have been opened while this one was loading
  if (requestId !== stmtMetaRequestId) return;
  const { source, category } = stmtMetaCache[statementId];
  el.innerHTML = [["Source", source], ["Category", category]]
    .filter(([, v]) => v)
    .map(([label, v]) => `<span class="stmt-meta-item"><span class="stmt-meta-label">${label}</span> <span class="stmt-meta-value">${esc(capFirst(v))}</span></span>`)
    .join("");
}

// Statement modal with only the text, source and category, plus an optional
// note in place of the score breakdown — for lists with nothing to explain
// (Design Point Coverage) or statements with too few ratings to score
function openStmtInfo(statement, statementId, noteHtml = "") {
  document.getElementById("stmtModalText").textContent = fixStatement(statement);
  const explanation = document.getElementById("stmtModalExplanation");
  explanation.innerHTML = noteHtml ? `<p class="expl-context">${noteHtml}</p>` : "";
  explanation.classList.toggle("hidden", !noteHtml);
  showStmtMeta(document.getElementById("stmtModalMeta"), statementId);
  stmtModal.classList.remove("hidden");
}

// Shown instead of a score for statements under the 10-rating minimum
function notEnoughRatingsHtml(n, groupLabel) {
  return `There are not enough ratings to calculate a commonsensicality score for this statement. ` +
    `Within <strong>${esc(groupLabel)}</strong>, it has received <strong>${fmtNum(n)}</strong> rating${n !== 1 ? "s" : ""}; ` +
    `at least <strong>10</strong> are required.`;
}

// The worked calculation of one statement's score, shared by every statement
// modal: N ratings, A = share who agree, B = share who think most others agree.
// Same rule as utils.statement_commonsensicality (a 50/50 tie counts as agree).
function stmtCalcHtml(row, groupLabel) {
  const N = row.n_ratings;
  const A = row.I_agree_mean;
  const B = row.others_agree_mean;
  const agrees = A >= 0.5;
  const fp = (v) => (v * 100).toFixed(1) + "%";
  const consensus = 2 * Math.abs(A - 0.5);
  const awareness = agrees ? B : 1 - B;
  const score = Math.sqrt(consensus * awareness);
  return (
    `<p class="expl-context">Computed from the <strong>${fmtNum(N)}</strong> rating${N !== 1 ? "s" : ""} ` +
    `by participants in <strong>${esc(groupLabel)}</strong>.</p>` +
    `<ul class="expl-list">` +
    `<li><strong>Majority:</strong> ${fp(A)} agree, so the majority <strong>${agrees ? "agrees" : "disagrees"}</strong> ` +
    `(${agrees ? "at least" : "under"} 50%).</li>` +
    `<li><strong>Consensus</strong> = 2 × |${fp(A)} − 50%| = <strong>${fp(consensus)}</strong>: how one-sided the vote is.</li>` +
    `<li><strong>Awareness</strong> = <strong>${fp(awareness)}</strong>: the share who correctly expected most people to ` +
    `${agrees ? "agree" : "disagree"}` +
    (agrees ? "." : ` (${fp(B)} thought most would agree, so 100% − ${fp(B)}).`) + `</li>` +
    `<li><strong>Commonsensicality</strong> = ${sqrtHtml(`${fp(consensus)} × ${fp(awareness)}`)} = <strong>${fp(score)}</strong>.</li>` +
    `</ul>`
  );
}

function openStmtDetail(row, country) {
  document.getElementById("stmtModalText").textContent = fixStatement(
    row.statement,
  );
  document.getElementById("stmtModalExplanation").classList.remove("hidden");
  showStmtMeta(document.getElementById("stmtModalMeta"), row.statementId);
  const c = country !== undefined ? country : stmtScoresCountrySelect.value;
  document.getElementById("stmtModalExplanation").innerHTML =
    stmtCalcHtml(row, c === "all" ? "all countries" : c);
  stmtModal.classList.remove("hidden");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function applyPropFilters(rows, propFilters) {
  return rows.filter((row) => {
    for (const { key } of PROP_DEFS) {
      const { v1, v0 } = propFilters[key];
      if ((!v1 && !v0) || (v1 && v0)) continue; // no filter
      const v = row[key];
      if (v === null || v === undefined) return false;
      if (v1 && v !== 1) return false;
      if (v0 && v !== 0) return false;
    }
    return true;
  });
}

function fixStatement(s) {
  if (!s) return s;
  // Capitalise first letter if it is a lowercase letter
  if (s[0] >= "a" && s[0] <= "z") s = s[0].toUpperCase() + s.slice(1);
  // Add period if the statement doesn't already end with sentence punctuation
  if (!/[.!?]$/.test(s)) s += ".";
  return s;
}

// ── Tab switching ──────────────────────────────────────────────────────────

function tabFromPathname() {
  const slug = window.location.pathname
    .slice(MOUNT_PATH.length)   // strip mount prefix ("" locally, "report/" in prod)
    .replace(/^\/|\/$/g, "");   // strip leading/trailing slashes
  return SLUG_TABS[slug] !== undefined ? SLUG_TABS[slug] : "home";
}

function switchToTab(tab, pushUrl) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    if (on) {
      b.setAttribute("aria-current", "page");
      // narrow windows scroll the tab row sideways: keep the active tab in view
      const bar = b.parentElement;
      if (bar.scrollWidth > bar.clientWidth) {
        const br = b.getBoundingClientRect(), pr = bar.getBoundingClientRect();
        bar.scrollLeft += (br.left + br.width / 2) - (pr.left + pr.width / 2);
      }
    } else {
      b.removeAttribute("aria-current");
    }
  });
  document.getElementById("panelHome").classList.toggle("hidden", tab !== "home");
  _currentTab = tab;
  document.getElementById("panelScores").classList.toggle("hidden", tab !== "scores");
  document.getElementById("panelStmtScores").classList.toggle("hidden", tab !== "stmtScores");
  document.getElementById("panelDP").classList.toggle("hidden", tab !== "dp");
  document.getElementById("panelCompare").classList.toggle("hidden", tab !== "compare");
  document.getElementById("panelCountries").classList.toggle("hidden", tab !== "countries");
  document.getElementById("panelStmtGen").classList.toggle("hidden", tab !== "stmtGen");
  document.getElementById("panelStmtAudit").classList.toggle("hidden", tab !== "stmtAudit");
  document.getElementById("panelTsAudit").classList.toggle("hidden", tab !== "tsAudit");
  document.getElementById("panelLlm").classList.toggle("hidden", tab !== "llm");
  if (tab === "home" && !_homeMapLoaded) { _homeMapLoaded = true; loadHomeMap(); }
  // home.js loads after this file, so it is undefined on the first call
  if (tab === "home" && typeof loadHomeSummary === "function") loadHomeSummary();
  if (tab === "scores" && !scoresLoaded) { scoresLoaded = true; loadScores("all", "all"); }
  if (tab === "dp" && !dpPanelLoaded) { dpPanelLoaded = true; loadDesignPoints("all"); }
  if (tab === "countries" && !countryMatrixLoaded) { countryMatrixLoaded = true; loadCountryMatrix(); }
  // the window may have been resized while the matrix was hidden
  if (tab === "countries" && typeof cmSyncHScroll === "function") requestAnimationFrame(() => { cmFixStickyLefts(); cmSyncHScroll(); cmPinHeader(); });
  if (tab === "stmtGen" && !sgLoaded) { sgLoaded = true; sgBuildHeader(); sgLoadCoverage(); }
  if (tab === "stmtAudit" && !auLoaded) { auLoaded = true; auLoad(); }
  if (tab === "tsAudit" && !tsLoaded) { tsLoaded = true; tsLoad(); }
  if (pushUrl) {
    const slug = TAB_SLUGS[tab];
    history.pushState({ tab }, "", MOUNT_PATH + (slug || ""));
  }
  // llm.js loads after this file and keeps its view in the query string, so
  // it runs after the URL is set (and is undefined on the first call)
  if (tab === "llm" && typeof llmOpen === "function") llmOpen();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    try {
      switchToTab(btn.dataset.tab, true);
    } catch (err) {
      console.error("Tab switch error:", err);
      alert(
        "Page is outdated — please hard-refresh (Cmd+Shift+R / Ctrl+Shift+R) and try again.\n\n" +
          err.message,
      );
    }
  });
});

document.getElementById("topbarTitle").addEventListener("click", () => {
  switchToTab("home", true);
});

// ── Panel-to-panel guide ───────────────────────────────────────────────────
// Each main panel ends with links to the previous and next panel, in tab
// order, so a first-time visitor can walk through the whole explorer. The
// questions match the tab tooltips (index.html) and Home's Explore cards.
const PANEL_TOUR = [
  { tab: "home",       name: "Home",              q: "What the survey asks, and what it shows" },
  { tab: "scores",     name: "Individual Scores", q: "How commonsensical is each person?",                 wrap: "#panelScores .scores-wrap" },
  { tab: "stmtScores", name: "Statement Scores",  q: "How commonsensical is each statement?",              wrap: "#panelStmtScores .scores-wrap" },
  { tab: "dp",         name: "Design Points",     q: "Which kinds of statements are most commonsensical?", wrap: "#panelDP .scores-wrap" },
  { tab: "compare",    name: "Group Comparison",  q: "Do two countries share the same common sense?",      wrap: "#compareWrap" },
  { tab: "countries",  name: "Countries",         q: "Is a statement equally commonsensical everywhere?",  wrap: "#panelCountries .scores-wrap" },
  { tab: "llm",        name: "LLM Evaluations",   q: "How commonsensical are language models?",            wrap: "#llmWrap" },
];

function panelTourLink(step, dir) {
  const label = dir === "prev" ? "← Previous" : step.tab === "home" ? "Back to the start" : "Next →";
  return (
    `<a class="panel-tour-link panel-tour-${dir}" href="${TAB_SLUGS[step.tab] || "./"}" data-tour-tab="${step.tab}">` +
    `<span class="panel-tour-dir">${label}</span>` +
    `<span class="panel-tour-name">${esc(step.name)}</span>` +
    `<span class="panel-tour-q">${esc(step.q)}</span></a>`
  );
}

PANEL_TOUR.forEach((step, i) => {
  if (!step.wrap) return;
  const wrap = document.querySelector(step.wrap);
  if (!wrap) return;
  const nav = document.createElement("nav");
  nav.className = "panel-tour";
  nav.setAttribute("aria-label", "Other panels");
  nav.innerHTML =
    panelTourLink(PANEL_TOUR[i - 1], "prev") +
    panelTourLink(PANEL_TOUR[(i + 1) % PANEL_TOUR.length], "next");
  wrap.appendChild(nav);
});

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-tour-tab]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
  e.preventDefault();
  const tab = a.dataset.tourTab;
  switchToTab(tab, true);
  // open the next panel at its top, not wherever it was last left
  const step = PANEL_TOUR.find((s) => s.tab === tab);
  const sc = document.querySelector(step && step.wrap ? step.wrap : "#homeScroll");
  if (sc) sc.scrollTop = 0;
});

// Tell the panel's intro card (static/intro.js, loaded after this file) that
// its panel has new data, so the worked example follows the selects and dates.
function notifyIntro(panel, data, ctx) {
  if (typeof introOnData === "function") introOnData(panel, data, ctx);
}

// ── Paginated tables in a scrolling page ──────────────────────────────────
// The 25-row tables are not height-capped (style.css), so the panel scrolls
// past them. revealTableTop() scrolls the panel back up to a table's controls
// when they are above the visible area; mirrorPager() repeats a pager under
// its table, forwarding clicks to the original buttons and following their
// state, so the next page is one click away from the bottom of this one.
function revealTableTop(el) {
  const sc = el && el.closest(".scores-wrap");
  if (!sc) return;
  const dy = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  if (dy < 0) sc.scrollTop += dy - 8;
}

function mirrorPager(pager, after) {
  if (!pager || !after) return;
  const copy = pager.cloneNode(true);
  copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  const row = document.createElement("div");
  row.className = "table-nav-row table-nav-bottom";
  row.appendChild(copy);
  const src = [...pager.querySelectorAll("button")];
  const dst = [...copy.querySelectorAll("button")];
  const srcInfo = pager.querySelector(".page-info");
  const dstInfo = copy.querySelector(".page-info");
  const sync = () => {
    src.forEach((b, i) => { if (dst[i]) dst[i].disabled = b.disabled; });
    if (srcInfo && dstInfo) dstInfo.textContent = srcInfo.textContent;
    row.hidden = src.every((b) => b.disabled); // a single page needs no second pager
  };
  dst.forEach((b, i) =>
    b.addEventListener("click", () => {
      src[i].click();
      if (after.scrollHeight > after.clientHeight) after.scrollTop = 0; // a table with its own scroller
      revealTableTop(pager.closest(".table-nav-row") || pager);
    }),
  );
  after.after(row);
  new MutationObserver(sync).observe(pager, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["disabled"],
  });
  sync();
}

// ══ Design Point Coverage (statement-generation) ═══════════════════════════
// Ported from .scripts/statement-generation/'s standalone Statement Explorer,
// which generates and judges candidate statements for under-filled design
// points. Everything here is "sg" / "sg-" prefixed to avoid colliding with
// this app's own similarly-named Design Points table (dp-th-prop, dp-val-1,
// col-num, sortable, …). (sgLoaded itself is declared near the top of the
// file, alongside the other panel-loaded flags — see the comment there.)
let sgRows = [];
const sgStatementsCache = {};
let sgSelectedCombo = null;
let sgSelectedMetric = null;

const SG_FEAT_DEFS = [
  { key: 'fact', v1: 'Fact', v0: 'Opinion',
    def1: "Something that can be demonstrated to be correct or incorrect, independently of anyone's opinion.",
    def0: 'Something that someone might think is true, but that cannot be demonstrated to be objectively correct or incorrect.' },
  { key: 'physical', v1: 'Physical', v0: 'Social',
    def1: 'Refers to objective features of the world described by natural rules and measurable empirically or derived logically.',
    def0: 'Refers to beliefs, preferences, institutions, and socially constructed rules of human origin.' },
  { key: 'literal language', v1: 'Literal Language', v0: 'Figure of Speech',
    def1: 'Plain and ordinary language that means exactly what it says.',
    def0: 'Contains an aphorism, metaphor, hyperbole, or another nonliteral expression.' },
  { key: 'positive', v1: 'Positive', v0: 'Normative',
    def1: 'Describes something in the world, such as an empirical regularity or scientific law.',
    def0: 'Expresses a judgment, belief, value, social norm, or convention.' },
  { key: 'knowledge', v1: 'Knowledge', v0: 'Reasoning',
    def1: 'States an observation about the world; it may be true or false, subjective or objective.',
    def0: 'Presents a conclusion reached by combining knowledge and logic.' },
  { key: 'everyday', v1: 'Everyday', v0: 'Abstract',
    def1: 'Concerns something people encounter, or could encounter, in ordinary experience.',
    def0: 'Concerns regularities or conclusions that cannot be observed or reached solely through individual experience.' },
];

const sgFeatFilter = Object.fromEntries(SG_FEAT_DEFS.map(({ key }) => [key, '']));
// Clicking a feature header cycles its filter: both poles → 1 only → 0 only
const SG_FILTER_CYCLE = { '': '1', '1': '0', '0': '' };
const SG_SORT_LABELS = { existing: 'Existing', published: 'Published', calculated: 'Calculated', supplementable: 'New' };
const SG_METRIC_HELP = {
  existing: 'Total number of statements already in a design point.',
  published: 'Number of statements that are currently being sampled.',
  calculated: 'Number of statements that have at least 10 ratings each, regardless of being published or not.',
  supplementable: 'Number of statements generated by some LLM according to this design point. Of these, a statement qualifies when, for every feature, at least half of the judge LLMs that rated it give the label in this design point. No single judge has to agree on all six features, and common sense is not required.',
};
let sgSortKey = 'existing';
let sgSortDir = 'asc';
const SG_METRIC_LABELS = { existing: 'existing', published: 'published', calculated: 'calculated', supplementable: 'new' };
const SG_METRIC_COLS = { existing: 3, published: 2, calculated: 5, supplementable: SG_FEAT_DEFS.length + 4 };

function sgComboKey(row) {
  return SG_FEAT_DEFS.map(def => row[def.key]).join(',');
}

function sgStatusClass(n) {
  if (n === 0) return 'sg-status-none';
  if (n < 5) return 'sg-status-low';
  return 'sg-status-good';
}

function sgMetricCacheKey(key, metric) {
  return `${key}::${metric}`;
}

function sgSortHeaderHtml(key) {
  const arrow = key === sgSortKey ? (sgSortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const active = key === sgSortKey ? ' sg-sort-active' : '';
  const help = `<button type="button" class="sg-help-btn sg-metric-help-btn" data-metric="${key}" aria-label="Definition of ${esc(SG_SORT_LABELS[key])}">?</button>`;
  const extra = key === 'supplementable' ? ' sg-col-new' : '';
  return `<th class="sg-col-meta${extra} sg-sortable${active}" data-sort-key="${key}">` +
    `<span class="sg-metric-th-label">${SG_SORT_LABELS[key]}${arrow}</span>${help}</th>`;
}

function sgBuildHeader() {
  const head = document.getElementById('sgHead');
  head.innerHTML = '<th class="sg-col-num">#</th>' + sgFeatureHeaderCells() +
    sgSortHeaderHtml('existing') + sgSortHeaderHtml('published') +
    sgSortHeaderHtml('calculated') + sgSortHeaderHtml('supplementable');
  sgUpdateFilterHeaders();
}

// Click-to-cycle feature headers, shared with the Published Statement Audit
function sgFeatureHeaderCells() {
  return SG_FEAT_DEFS.map((def, i) =>
      `<th class="sg-th-prop${i % 2 === 0 ? ' sg-th-alt' : ''}" data-key="${esc(def.key)}" ` +
      `title="Click to filter by ${esc(def.v1)} / ${esc(def.v0)}">` +
      // All three filter states' labels are rendered; only the active one is
      // shown, but the hidden ones still set the column width (see style.css)
      `<span class="sg-prop-label">` +
      `<span class="sg-label-variant" data-value="">${sgPoleHtml(def.v1, '1')}<span class="sg-pole-amp">&amp;</span>${sgPoleHtml(def.v0, '0')}</span>` +
      `<span class="sg-label-variant" data-value="1">${sgPoleHtml(def.v1, '1')}</span>` +
      `<span class="sg-label-variant" data-value="0">${sgPoleHtml(def.v0, '0')}</span>` +
      `</span>` +
      `<button type="button" class="sg-help-btn sg-prop-help-btn" data-key="${esc(def.key)}" ` +
      `aria-label="Definitions of ${esc(def.v1)} and ${esc(def.v0)}">?</button></th>`
    ).join('');
}

function sgPoleHtml(label, value) {
  const dot = value === '1'
    ? '<span class="sg-option-dot sg-val-1">●</span>'
    : '<span class="sg-option-dot sg-val-0">○</span>';
  return `<span class="sg-pole">${esc(label)}&nbsp;${dot}</span>`;
}

function sgUpdateFilterHeaders() {
  sgApplyFilterHeaders(document.getElementById('sgHead'), sgFeatFilter);
}

function sgApplyFilterHeaders(head, filter) {
  head.querySelectorAll('th.sg-th-prop[data-key]').forEach(th => {
    const value = filter[th.dataset.key];
    th.querySelectorAll('.sg-label-variant').forEach(variant => {
      variant.classList.toggle('sg-label-active', variant.dataset.value === value);
    });
    th.classList.toggle('sg-filter-v1', value === '1');
    th.classList.toggle('sg-filter-v0', value === '0');
  });
}

function sgRenderTable() {
  const tbody = document.getElementById('sgBody');
  if (!sgRows.length) {
    tbody.innerHTML = '<tr class="sg-empty-row"><td colspan="11">No data.</td></tr>';
    return;
  }
  const filtered = sgRows.filter(row =>
    SG_FEAT_DEFS.every(def => !sgFeatFilter[def.key] || String(row[def.key]) === sgFeatFilter[def.key])
  );
  if (!filtered.length) {
    tbody.innerHTML = '<tr class="sg-empty-row"><td colspan="11">No design points match the current filters.</td></tr>';
    return;
  }
  const dir = sgSortDir === 'asc' ? 1 : -1;
  const sorted = [...filtered].sort((a, b) => (a[sgSortKey] - b[sgSortKey]) * dir);
  const countButton = (key, metric, value, statusClass) => {
    const active = sgSelectedCombo === key && sgSelectedMetric === metric ? ' sg-active-metric' : '';
    const extra = metric === 'supplementable' ? ' sg-col-new' : '';
    return `<td class="sg-col-meta${extra}"><button type="button" class="sg-count ${statusClass}${active}" ` +
      `data-combo="${esc(key)}" data-metric="${metric}">${value}</button></td>`;
  };
  tbody.innerHTML = sorted.map((row, index) => {
    const key = sgComboKey(row);
    const supplementClass = row.supplementable > 0 ? 'sg-status-help' : 'sg-status-none-help';
    return `<tr data-combo="${esc(key)}"${key === sgSelectedCombo ? ' class="sg-selected"' : ''}>` +
      `<td class="sg-col-num">${index + 1}</td>` +
      SG_FEAT_DEFS.map((def, i) => {
        const isOne = row[def.key] === 1;
        const alt = i % 2 === 0 ? ' sg-prop-alt' : '';
        return `<td class="sg-prop-val ${isOne ? 'sg-val-1' : 'sg-val-0'}${alt}" title="${esc(isOne ? def.v1 : def.v0)}">${isOne ? '●' : '○'}</td>`;
      }).join('') +
      countButton(key, 'existing', row.existing, sgStatusClass(row.existing)) +
      countButton(key, 'published', row.published, sgStatusClass(row.published)) +
      countButton(key, 'calculated', row.calculated, sgStatusClass(row.calculated)) +
      countButton(key, 'supplementable',
        `<span class="sg-frac-num">${row.supplementable}</span> / <span class="sg-frac-den">${row.supplementable_total}</span>`,
        supplementClass) +
      '</tr>';
  }).join('');
}

async function sgLoadCoverage() {
  try {
    const response = await fetch(`${API}/statement-coverage`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    sgRows = data.rows;
    sgRenderTable();
  } catch (error) {
    document.getElementById('sgBody').innerHTML =
      `<tr class="sg-empty-row"><td colspan="11">Could not load coverage: ${esc(error.message)}</td></tr>`;
  }
}

function sgDetailHeader(metric, row) {
  if (metric === 'existing') {
    return '<th class="sg-col-num">#</th><th class="sg-col-published">Published</th><th class="sg-col-statement">Statement</th>';
  }
  if (metric === 'published') {
    return '<th class="sg-col-num">#</th><th class="sg-col-statement">Statement</th>';
  }
  if (metric === 'calculated') {
    return '<th class="sg-col-num">#</th><th class="sg-col-published">Published</th><th class="sg-col-statement">Statement</th>' +
      '<th class="sg-col-generator">N Ratings</th><th class="sg-col-num-judges">Commonsensicality</th>';
  }
  // One column per feature, titled with this design point's label (every
  // listed statement claims it), then common sense
  return '<th class="sg-col-num">#</th><th class="sg-col-statement">Statement</th><th class="sg-col-generator">Generator</th>' +
    SG_FEAT_DEFS.map(def => `<th class="sg-col-num-judges">${esc(row[def.key] ? def.v1 : def.v0)}</th>`).join('') +
    '<th class="sg-col-num-judges">Common Sense</th>';
}

function sgPublishedChip(published) {
  return published ? '<span class="sg-status-chip sg-yes">Yes</span>' : '<span class="sg-status-chip sg-no">No</span>';
}

let sgDetailRequestId = 0;
// Rows currently in the detail table, in display order (existing/calculated
// are re-sorted by published before rendering)
let sgDetailStatements = [];
async function sgSelectMetric(key, metric) {
  sgSelectedCombo = key;
  sgSelectedMetric = metric;
  sgRenderTable();
  const row = sgRows.find(r => sgComboKey(r) === key);
  if (!row) return;
  const requestId = ++sgDetailRequestId;
  const detail = document.getElementById('sgDetailCard');
  const title = document.getElementById('sgDetailTitle');
  const sub = document.getElementById('sgDetailSub');
  const head = document.getElementById('sgDetailHead');
  const body = document.getElementById('sgDetailBody');
  const label = SG_FEAT_DEFS.map(def => row[def.key] ? def.v1 : def.v0).join(' · ');
  const count = row[metric];
  const colCount = SG_METRIC_COLS[metric];
  title.textContent = label;
  sub.textContent = metric === 'supplementable'
    ? `There are ${row.supplementable_total} statements that have been generated by an LLM for this design point. ` +
      `Of these, ${count} statements qualify: for each of the 6 features, at least half of the judge LLMs that ` +
      `rated the statement give it the label in this design point. No single judge has to agree on all 6, and ` +
      `common sense is not required.`
    : `${count} ${SG_METRIC_LABELS[metric]} statement${count === 1 ? '' : 's'}`;
  detail.classList.remove("hidden");
  head.innerHTML = sgDetailHeader(metric, row);
  head.closest('table').dataset.metric = metric;
  const cacheKey = sgMetricCacheKey(key, metric);
  body.innerHTML = `<tr class="sg-empty-row"><td colspan="${colCount}">Loading…</td></tr>`;
  try {
    if (!(cacheKey in sgStatementsCache)) {
      const params = new URLSearchParams({ metric });
      SG_FEAT_DEFS.forEach(def => params.set(def.key, row[def.key]));
      const response = await fetch(`${API}/statement-coverage-statements?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      sgStatementsCache[cacheKey] = data.statements;
    }
    // A newer click may have started (and possibly already finished) a different
    // request while this one was in flight; only the latest should touch the DOM.
    if (requestId !== sgDetailRequestId) return;
    sgRenderDetailList(cacheKey, metric);
  } catch (error) {
    if (requestId !== sgDetailRequestId) return;
    body.innerHTML = `<tr class="sg-empty-row"><td colspan="${colCount}">Could not load statements: ${esc(error.message)}</td></tr>`;
  }
}

function sgRenderDetailList(cacheKey, metric) {
  const body = document.getElementById('sgDetailBody');
  let statements = sgStatementsCache[cacheKey] || [];
  const colCount = SG_METRIC_COLS[metric];
  if (!statements.length) {
    body.innerHTML = `<tr class="sg-empty-row"><td colspan="${colCount}">No ${SG_METRIC_LABELS[metric]} statements for this design point.</td></tr>`;
    return;
  }
  if (metric === 'existing' || metric === 'calculated') {
    const publishedCount = statements.filter(s => s.published).length;
    const sub = document.getElementById('sgDetailSub');
    sub.textContent += ` · ${publishedCount} of ${statements.length} still published`;
    statements = [...statements].sort((a, b) => b.published - a.published);
  }
  sgDetailStatements = statements;
  if (metric === 'existing') {
    body.innerHTML = statements.map((entry, index) =>
      `<tr data-index="${index}"><td class="sg-col-num">${index + 1}</td>` +
      `<td class="sg-col-published">${sgPublishedChip(entry.published)}</td>` +
      `<td class="sg-col-statement"><span class="sg-statement-text">${esc(entry.statement)}</span></td></tr>`
    ).join('');
    return;
  }
  if (metric === 'published') {
    body.innerHTML = statements.map((entry, index) =>
      `<tr data-index="${index}"><td class="sg-col-num">${index + 1}</td><td class="sg-col-statement"><span class="sg-statement-text">${esc(entry.statement)}</span></td></tr>`
    ).join('');
    return;
  }
  if (metric === 'calculated') {
    body.innerHTML = statements.map((entry, index) =>
      `<tr data-index="${index}"><td class="sg-col-num">${index + 1}</td>` +
      `<td class="sg-col-published">${sgPublishedChip(entry.published)}</td>` +
      `<td class="sg-col-statement"><span class="sg-statement-text">${esc(entry.statement)}</span></td>` +
      `<td class="sg-col-generator">${entry.n_ratings}</td>` +
      `<td class="sg-col-num-judges">${(entry.commonsensicality * 100).toFixed(1)}%</td></tr>`
    ).join('');
    return;
  }
  body.innerHTML = statements.map((entry, index) => {
    const genLabel = entry.generations.length === 1
      ? `<span title="${esc(entry.generations[0].gen_model)}">${esc(entry.generations[0].gen_model.split('/').pop())}</span>`
      : `<span title="${esc(entry.generations.map(g => g.gen_model).join(', '))}">${entry.generations.length} generators</span>`;
    const rowClass = entry.qualifies ? '' : ' class="sg-row-dim"';
    return `<tr data-index="${index}"${rowClass}>` +
      `<td class="sg-col-num">${index + 1}</td>` +
      `<td class="sg-col-statement"><span class="sg-statement-text">${esc(entry.statement)}</span></td>` +
      `<td class="sg-col-generator">${genLabel}</td>` +
      SG_FEAT_DEFS.map(def => `<td class="sg-col-num-judges">` +
        `${sgVoteCell(...entry.feature_votes[def.key], def.key, !entry.feature_majority[def.key])}</td>`).join('') +
      `<td class="sg-col-num-judges">${sgVoteCell(...entry.commonsense_votes, 'commonsense')}</td>` +
      '</tr>';
  }).join('');
}

// An "agree / rated" pill in a statement list (Coverage and Audit). Clicking it
// opens the statement dialog on just that section: a feature key or
// "commonsense". fails marks a feature where fewer than half of the judges
// agree, so the statement doesn't qualify.
function sgVoteCell(agree, total, key, fails = false) {
  if (!total) return '<span class="au-none">—</span>';
  return `<span class="sg-judge-count au-feature-cell${fails ? ' au-no-majority' : ''}" ` +
    `data-feature-key="${esc(key)}">${agree} / ${total}</span>`;
}

// In the statement dialog, show only the section for key (a feature key or
// "commonsense"); with no key, or an unknown one, show every section
function sgFocusSection(container, key) {
  const sections = container.querySelectorAll('.sg-statement-feature[data-feature-key]');
  if (!key || ![...sections].some(s => s.dataset.featureKey === key)) return;
  sections.forEach(s => s.classList.toggle('sg-feature-hidden', s.dataset.featureKey !== key));
}

function sgAssessmentPanel(title, assessment, role, agree) {
  const roleClass = role ? ` sg-assessment-panel--${role}` : '';
  const agreeChip = agree === true ? ' <span class="sg-status-chip sg-yes">Agree</span>'
    : agree === false ? ' <span class="sg-status-chip sg-no">Disagree</span>' : '';
  if (!assessment) {
    return `<article class="sg-assessment-panel${roleClass}"><h4>${esc(title)}${agreeChip}</h4><p class="sg-pending-label">Evaluation pending</p></article>`;
  }
  const confidence = assessment.confidence ?
    `<p class="sg-feature-confidence">Confidence: ${esc(assessment.confidence)} / 4</p>` : '';
  return `<article class="sg-assessment-panel${roleClass}"><h4>${esc(title)}${agreeChip}</h4>` +
    `<strong>${esc(assessment.classification || 'Not provided')}</strong>` +
    confidence +
    `<p>${esc(assessment.explanation || 'No explanation provided.')}</p></article>`;
}

// Status line for the qualification rule (statement_coverage.feature_majority):
// every feature needs at least half of the judges who rated the statement to
// give its label. labels maps feature key -> 0/1.
function sgMajorityStatus(majority, labels, nJudges) {
  if (!nJudges) return 'Not rated by any judge yet';
  const failing = SG_FEAT_DEFS.filter(def => !majority[def.key]).map(def => (labels[def.key] ? def.v1 : def.v0));
  return failing.length
    ? `Doesn't qualify: fewer than half of the judges agree on ${failing.join(', ')}`
    : 'Qualifies: at least half of the judges agree on every feature';
}

function sgFeatureLabel(def, classification) {
  return String(classification).trim().toLowerCase() === def.key ? def.v1 : def.v0;
}

const sgStatementDialog = document.getElementById('sgStatementDialog');
// opts.sourceTitle names the label being checked ("Generator" by default);
// opts.showRationale = false drops the generator's common-sense rationale.
// gen.sources lists one label panel per generator ({name, features,
// rationale}) when several submitted the same text; otherwise the single
// panel comes from gen.gen_features and gen.gen_commonsense_explanation.
// gen.majority (feature key -> at least half of the judges agree) is set on
// the Coverage and Audit pages, which apply the qualification rule.
function sgRenderGeneration(gen, row, opts = {}) {
  const sourceTitle = opts.sourceTitle || 'Generator';
  const sources = gen.sources ||
    [{ name: null, features: gen.gen_features, rationale: gen.gen_commonsense_explanation }];
  const titled = (base, source) => (source.name ? `${base}: ${source.name}` : base);

  const commonsensePanels = (opts.showRationale === false ? '' : sources.map(source =>
    sgAssessmentPanel(titled('Generator rationale', source), {
      classification: 'Provided', confidence: '', explanation: source.rationale,
    }, 'generator')).join('')) + gen.judges.map(judge => sgAssessmentPanel(`Judge: ${judge.judge_model}`, {
    classification: judge.commonsense === 1 ? 'Yes' : 'No', confidence: '', explanation: judge.commonsense_explanation,
  }, 'judge', judge.commonsense === 1)).join('');
  // Keyed "commonsense" so the audit list's Common Sense cell can focus it
  const commonsenseSection = `<section class="sg-statement-feature" data-feature-key="commonsense">` +
    `<h3>Human common sense` +
    (gen.majority ? ' <span class="sg-agreement-badge sg-agreement-badge--muted">Not required to qualify</span>' : '') +
    '</h3>' +
    `<div class="sg-comparison-grid">${commonsensePanels}</div></section>`;

  const featureSections = SG_FEAT_DEFS.map(def => {
    const label = row[def.key] ? def.v1 : def.v0;
    const genPanel = sources.map(source => sgAssessmentPanel(titled(sourceTitle, source), {
      classification: label,
      confidence: source.features[def.key].confidence,
      explanation: source.features[def.key].explanation,
    }, 'generator')).join('');
    const judgeAgreeCount = gen.judges.filter(j => sgFeatureLabel(def, j.features[def.key].classification) === label).length;
    const judgePanels = gen.judges.map(judge => {
      const judgeLabel = sgFeatureLabel(def, judge.features[def.key].classification);
      return sgAssessmentPanel(`Judge: ${judge.judge_model}`, {
        classification: judgeLabel, confidence: judge.features[def.key].confidence, explanation: judge.features[def.key].explanation,
      }, 'judge', judgeLabel === label);
    }).join('');
    const allAgree = judgeAgreeCount === gen.judges.length;
    const badgeText = allAgree ? 'All agree' : `${judgeAgreeCount} / ${gen.judges.length} agree`;
    // Under the qualification rule a feature is green once at least half agree
    const passes = gen.majority ? gen.majority[def.key] : allAgree;
    const badgeClass = passes ? 'sg-agreement-badge' : 'sg-agreement-badge sg-agreement-badge--partial';
    return `<section class="sg-statement-feature" data-feature-key="${esc(def.key)}">` +
      `<h3>${esc(label)} ` +
      `<span class="${badgeClass}">${esc(badgeText)}</span></h3>` +
      `<div class="sg-comparison-grid">${genPanel}${judgePanels}</div></section>`;
  }).join('');

  return `<div class="sg-generation-block">${commonsenseSection}${featureSections}</div>`;
}

// focusFeature (a feature key or "commonsense", from a clicked count) shows
// just that section, with every judge's explanation
function sgShowStatement(entry, focusFeature = null) {
  const row = sgRows.find(r => sgComboKey(r) === sgSelectedCombo);
  if (!row) return;
  document.getElementById('sgStatementText').textContent = entry.statement;
  const generations = entry.generations;
  const multi = generations.length > 1;
  const genSummary = multi
    ? `Independently generated by ${generations.length} models`
    : `Generated by ${generations[0].gen_model}`;
  const labels = Object.fromEntries(SG_FEAT_DEFS.map(def => [def.key, row[def.key]]));
  const nJudges = generations.reduce((sum, g) => sum + g.judges.length, 0);
  document.getElementById('sgStatementModel').textContent =
    `${genSummary} · ${sgMajorityStatus(entry.feature_majority, labels, nJudges)}`;
  // One block for the whole text: the rule counts every rating of it, so each
  // generator's labels sit beside every judge, named by the submission it rated
  const pooled = {
    sources: generations.map(g => ({
      name: multi ? g.gen_model : null, features: g.gen_features, rationale: g.gen_commonsense_explanation,
    })),
    judges: generations.flatMap(g => g.judges.map(j => (multi
      ? { ...j, judge_model: `${j.judge_model} · on ${g.gen_model.split('/').pop()}'s submission` }
      : j))),
    majority: entry.feature_majority,
  };
  const container = document.getElementById('sgStatementGenerations');
  container.innerHTML = sgRenderGeneration(pooled, row);
  sgFocusSection(container, focusFeature);

  sgHideFeatureHelp();
  sgStatementDialog.showModal();
  sgStatementDialog.scrollTop = 0;
}

const sgFeatPopup = document.getElementById('sgFeatPopup');
let sgActiveHelpButton = null;
function sgShowFeatureHelp(button) {
  sgActiveHelpButton = button;
  if (button.dataset.helpLabel) {
    sgFeatPopup.innerHTML = `<div class="sg-popup-entry"><div class="sg-popup-label">${esc(button.dataset.helpLabel)}</div>` +
      `<div class="sg-popup-def">${esc(button.dataset.helpText)}</div></div>`;
    sgFeatPopup.classList.add('visible');
  } else if (button.dataset.metric) {
    const metric = button.dataset.metric;
    sgFeatPopup.innerHTML = `<div class="sg-popup-entry"><div class="sg-popup-label">${esc(SG_SORT_LABELS[metric])}</div>` +
      `<div class="sg-popup-def">${esc(SG_METRIC_HELP[metric])}</div></div>`;
    sgFeatPopup.classList.add('visible');
  } else {
    const def = SG_FEAT_DEFS.find(item => item.key === button.dataset.key);
    if (!def) { sgActiveHelpButton = null; return; }
    sgFeatPopup.innerHTML = [[def.v1, def.def1], [def.v0, def.def0]].map(([label, text]) =>
      `<div class="sg-popup-entry"><div class="sg-popup-label">${esc(label)}</div>` +
      `<div class="sg-popup-def">${esc(text)}</div></div>`).join('');
    sgFeatPopup.classList.add('visible');
  }
  const rect = button.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - 160;
  let top = rect.bottom + 8;
  if (left + 320 > window.innerWidth - 8) left = window.innerWidth - 328;
  if (left < 8) left = 8;
  if (top + sgFeatPopup.offsetHeight > window.innerHeight - 8) top = rect.top - sgFeatPopup.offsetHeight - 8;
  sgFeatPopup.style.left = `${left}px`;
  sgFeatPopup.style.top = `${Math.max(8, top)}px`;
}

function sgHideFeatureHelp() {
  sgFeatPopup.classList.remove('visible');
  sgActiveHelpButton = null;
}

document.getElementById('sgBody').addEventListener('click', event => {
  const button = event.target.closest('.sg-count');
  if (!button) return;
  sgSelectMetric(button.dataset.combo, button.dataset.metric);
});

document.getElementById('sgHead').addEventListener('click', event => {
  const help = event.target.closest('.sg-help-btn');
  if (help) {
    event.stopPropagation();
    sgShowFeatureHelp(help);
    return;
  }
  const sortTh = event.target.closest('th.sg-sortable');
  if (sortTh) {
    const key = sortTh.dataset.sortKey;
    if (sgSortKey === key) {
      sgSortDir = sgSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sgSortKey = key;
      sgSortDir = 'asc';
    }
    sgBuildHeader();
    sgRenderTable();
    return;
  }
  const th = event.target.closest('th.sg-th-prop');
  if (!th) return;
  sgFeatFilter[th.dataset.key] = SG_FILTER_CYCLE[sgFeatFilter[th.dataset.key]];
  sgUpdateFilterHeaders();
  sgRenderTable();
});
document.getElementById('sgHead').addEventListener('mouseover', event => {
  const help = event.target.closest('.sg-help-btn');
  if (help && help !== sgActiveHelpButton) sgShowFeatureHelp(help);
});
document.getElementById('sgHead').addEventListener('mouseout', event => {
  if (event.target.closest('.sg-help-btn') && !sgFeatPopup.contains(event.relatedTarget)) sgHideFeatureHelp();
});

document.getElementById('sgDetailBody').addEventListener('click', event => {
  const tr = event.target.closest('tr[data-index]');
  if (!tr) return;
  const entry = sgDetailStatements[Number(tr.dataset.index)];
  if (!entry) return;
  // Generated (New) statements aren't in statements_1.csv, so they keep their
  // own judge-detail dialog; existing ones show source and category
  if (sgSelectedMetric === 'supplementable') {
    const cell = event.target.closest('.au-feature-cell');
    sgShowStatement(entry, cell ? cell.dataset.featureKey : null);
  } else openStmtInfo(entry.statement, entry.id);
});

document.getElementById('sgCloseStatement').addEventListener('click', () => sgStatementDialog.close());
sgStatementDialog.addEventListener('click', event => {
  const rect = sgStatementDialog.getBoundingClientRect();
  if (event.target === sgStatementDialog &&
      (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) {
    sgStatementDialog.close();
  }
});
document.querySelector('#sgTable').closest('.sg-table-wrap').addEventListener('scroll', sgHideFeatureHelp);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') sgHideFeatureHelp();
});

// ══ Published Statement Audit ══════════════════════════════════════════════
// Compares LLM judges' answers with the stored labels of the published
// statements (judge_published.py writes the data, statement_audit.py serves
// it). Reuses the Coverage page's feature headers, count pills, statement
// table styles and statement dialog.
let auLoaded = false;
let auData = null;
const auFeatFilter = Object.fromEntries(SG_FEAT_DEFS.map(({ key }) => [key, '']));
let auSelectedCombo = null;
let auSelectedMetric = null;
let auDetailStatements = [];
let auDetailRequestId = 0;
const AU_METRIC_HELP = {
  published: ['Published', 'Published statements whose stored labels put them in this design point.'],
  majority: ['Majority', 'Statements where, for every feature, at least half of the judges who rated the statement give the stored label, out of the statements rated by at least one judge. No single judge has to agree on all six features, and common sense is not required.'],
  commonsense: ['Common sense', 'Statements that at least one judge considers common sense, out of the statements rated by at least one judge.'],
};

// Batch and direct runs of a model are merged server-side under the plain id
function auJudgeLabel(model) {
  return model.split('/').pop();
}

function auMetricHeader(label, helpLabel, helpText) {
  return `<th class="sg-col-meta"><span class="sg-metric-th-label">${esc(label)}</span>` +
    `<button type="button" class="sg-help-btn sg-metric-help-btn" data-help-label="${esc(helpLabel)}" ` +
    `data-help-text="${esc(helpText)}" aria-label="Definition of ${esc(helpLabel)}">?</button></th>`;
}

// Share of statements a judge agrees with: green from half, amber from a fifth
function auShareClass(num, den) {
  if (!den) return 'sg-status-none-help';
  if (num / den >= 0.5) return 'sg-status-good';
  if (num / den >= 0.2) return 'sg-status-low';
  return 'sg-status-none';
}

function auBuildHeader() {
  const judges = auData.judges;
  const head = document.getElementById('auHead');
  head.innerHTML = '<th class="sg-col-num">#</th>' + sgFeatureHeaderCells() +
    auMetricHeader('Published', ...AU_METRIC_HELP.published) +
    judges.map(j => auMetricHeader(auJudgeLabel(j), j,
      `Statements ${j} labels the same way as the stored labels on all six features, out of the statements it has rated in this design point.`)).join('') +
    auMetricHeader('Majority', ...AU_METRIC_HELP.majority) +
    auMetricHeader('Common sense', ...AU_METRIC_HELP.commonsense);
  sgApplyFilterHeaders(head, auFeatFilter);
}

function auRenderAgreement() {
  const el = document.getElementById('auAgreement');
  document.getElementById('auAgreementCaption').textContent =
    `${fmtNum(auData.n_statements)} published statements. Each cell is the percentage of statements a judge rated ` +
    `where its label matches the stored label; "Common sense" is the percentage it rates as common sense. In the ` +
    `"Majority of judges" row, a statement counts when at least half of the judges who rated it agree; "All six ` +
    `features" is then the share that passes, with each feature judged separately.`;
  if (!auData.agreement.length) {
    el.innerHTML = '<p class="sg-caption">No judge results yet. Run <code>judge_published.py judge</code>, then restart the server.</p>';
    return;
  }
  const cell = v => v === null ? '<td>—</td>' : `<td class="${v < 70 ? 'au-low' : ''}">${v.toFixed(1)}%</td>`;
  el.innerHTML = `<div class="au-agreement-wrap"><table class="au-agreement-table"><thead><tr>` +
    `<th>Judge</th><th>Rated</th><th>Common sense</th>` +
    SG_FEAT_DEFS.map(d => `<th>${esc(d.v1)} / ${esc(d.v0)}</th>`).join('') +
    `<th>All six features</th></tr></thead><tbody>` +
    auData.agreement.map(a => `<tr${a.judge === 'Majority of judges' ? ' class="au-any-row"' : ''}>` +
      `<td class="au-judge">${esc(a.judge)}</td><td>${fmtNum(a.n)}</td>` + cell(a.commonsense) +
      SG_FEAT_DEFS.map(d => cell(a.features[d.key])).join('') + cell(a.all_features) + '</tr>').join('') +
    '</tbody></table></div>';
}

function auRenderTable() {
  const tbody = document.getElementById('auBody');
  const judges = auData.judges;
  const cols = 4 + SG_FEAT_DEFS.length + judges.length;
  if (!auData.rows.length) {
    const msg = auData.missing ? 'No snapshot yet: run judge_published.py prepare.' : 'No data.';
    tbody.innerHTML = `<tr class="sg-empty-row"><td colspan="${cols}">${esc(msg)}</td></tr>`;
    return;
  }
  const rows = auData.rows
    .filter(row => SG_FEAT_DEFS.every(def => !auFeatFilter[def.key] || String(row[def.key]) === auFeatFilter[def.key]))
    .sort((a, b) => b.published - a.published);
  if (!rows.length) {
    tbody.innerHTML = `<tr class="sg-empty-row"><td colspan="${cols}">No design points with published statements match the current filters.</td></tr>`;
    return;
  }
  const frac = (num, den) => `<span class="sg-frac-num">${num}</span> / <span class="sg-frac-den">${den}</span>`;
  // Counts only: clicking anywhere on the row opens the same statement list,
  // which always shows every judge
  const pill = (key, metric, html, cls) =>
    `<td class="sg-col-meta"><span class="sg-count ${cls}">${html}</span></td>`;
  tbody.innerHTML = rows.map((row, index) => {
    const key = sgComboKey(row);
    return `<tr data-combo="${esc(key)}"${key === auSelectedCombo ? ' class="sg-selected"' : ''}>` +
      `<td class="sg-col-num">${index + 1}</td>` +
      SG_FEAT_DEFS.map((def, i) => {
        const isOne = row[def.key] === 1;
        const alt = i % 2 === 0 ? ' sg-prop-alt' : '';
        return `<td class="sg-prop-val ${isOne ? 'sg-val-1' : 'sg-val-0'}${alt}" title="${esc(isOne ? def.v1 : def.v0)}">${isOne ? '●' : '○'}</td>`;
      }).join('') +
      pill(key, 'published', row.published, 'sg-status-help') +
      judges.map(j => {
        const r = row.judges[j];
        return r.rated ? pill(key, `judge:${j}`, frac(r.agree, r.rated), auShareClass(r.agree, r.rated))
          : '<td class="sg-col-meta"><span class="au-none">—</span></td>';
      }).join('') +
      pill(key, 'majority', frac(row.majority, row.rated), auShareClass(row.majority, row.rated)) +
      pill(key, 'commonsense', frac(row.commonsense, row.rated), auShareClass(row.commonsense, row.rated)) +
      '</tr>';
  }).join('');
}

async function auLoad() {
  try {
    const response = await fetch(`${API}/statement-audit`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    auData = await response.json();
    auBuildHeader();
    auRenderAgreement();
    auRenderTable();
  } catch (error) {
    document.getElementById('auBody').innerHTML =
      `<tr class="sg-empty-row"><td colspan="12">Could not load the audit: ${esc(error.message)}</td></tr>`;
  }
}

function auMetricDescription(metric, statements) {
  const total = statements.length;
  const n = statements.filter(s => s.qualifies).length;
  if (metric === 'published') return `${total} published statement${total === 1 ? '' : 's'}`;
  if (metric === 'majority') return `${n} of ${total} statements have at least half of their judges agreeing on every feature`;
  if (metric === 'commonsense') return `${n} of ${total} statements are rated common sense by at least one judge`;
  return `${n} of ${total} statements ${metric.slice(6)} agrees with`;
}

async function auSelectMetric(key, metric) {
  auSelectedCombo = key;
  auSelectedMetric = metric;
  auRenderTable();
  const row = auData.rows.find(r => sgComboKey(r) === key);
  if (!row) return;
  const requestId = ++auDetailRequestId;
  const head = document.getElementById('auDetailHead');
  const body = document.getElementById('auDetailBody');
  document.getElementById('auDetailCard').classList.remove('hidden');
  document.getElementById('auDetailTitle').textContent =
    SG_FEAT_DEFS.map(def => row[def.key] ? def.v1 : def.v0).join(' · ');
  document.getElementById('auDetailSub').textContent = 'Loading…';
  // One column per feature, titled with this design point's stored label
  // (every statement in the list shares it), then common sense
  const colCount = 3 + SG_FEAT_DEFS.length;
  head.innerHTML = '<th class="sg-col-num">#</th><th class="sg-col-statement">Statement</th>' +
    SG_FEAT_DEFS.map(def => `<th class="sg-col-num-judges">${esc(row[def.key] ? def.v1 : def.v0)}</th>`).join('') +
    '<th class="sg-col-num-judges">Common Sense</th>';
  head.closest('table').dataset.metric = 'audit';
  body.innerHTML = `<tr class="sg-empty-row"><td colspan="${colCount}">Loading…</td></tr>`;
  try {
    const params = new URLSearchParams({ metric });
    SG_FEAT_DEFS.forEach(def => params.set(def.key, row[def.key]));
    const response = await fetch(`${API}/statement-audit-statements?${params}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (requestId !== auDetailRequestId) return;
    auDetailStatements = data.statements;
  } catch (error) {
    if (requestId !== auDetailRequestId) return;
    body.innerHTML = `<tr class="sg-empty-row"><td colspan="${colCount}">Could not load statements: ${esc(error.message)}</td></tr>`;
    return;
  }
  document.getElementById('auDetailSub').textContent = auMetricDescription(metric, auDetailStatements);
  if (!auDetailStatements.length) {
    body.innerHTML = `<tr class="sg-empty-row"><td colspan="${colCount}">No statements.</td></tr>`;
    return;
  }
  // Each cell: judges who give that feature the stored label / judges who rated the statement.
  // Feature and Common Sense cells are clickable: they open the statement dialog focused
  // on just that section, across all judges, regardless of which judge/metric column got us here.
  body.innerHTML = auDetailStatements.map((entry, index) =>
    `<tr data-index="${index}"${entry.qualifies ? '' : ' class="sg-row-dim"'}>` +
    `<td class="sg-col-num">${index + 1}</td>` +
    `<td class="sg-col-statement"><span class="sg-statement-text">${esc(entry.statement)}</span></td>` +
    SG_FEAT_DEFS.map(def => `<td class="sg-col-num-judges">` +
      `${sgVoteCell(entry.judges.filter(j => j.matches[def.key]).length, entry.n_judges, def.key, !entry.feature_majority[def.key])}</td>`).join('') +
    `<td class="sg-col-num-judges">${sgVoteCell(entry.n_commonsense, entry.n_judges, 'commonsense')}</td></tr>`
  ).join('');
}

function auShowStatement(entry, opts = {}) {
  document.getElementById('sgStatementText').textContent = entry.statement;
  // opts.focusFeature (a feature key or "commonsense", from a clicked cell)
  // shows just that section; otherwise every section. Always every judge.
  document.getElementById('sgStatementModel').textContent =
    `Published statement #${entry.statementId} · ${sgMajorityStatus(entry.feature_majority, entry.labels, entry.n_judges)}`;
  const stored = {
    gen_model: 'Stored labels', gen_commonsense_explanation: '', judges: entry.judges, majority: entry.feature_majority,
    gen_features: Object.fromEntries(SG_FEAT_DEFS.map(def => [def.key, {
      confidence: '', explanation: "Label stored in the platform's statement properties.",
    }])),
  };
  document.getElementById('sgStatementGenerations').innerHTML = entry.judges.length
    ? sgRenderGeneration(stored, entry.labels, { sourceTitle: 'Stored label', showRationale: false })
    : '<p class="sg-pending-label">No judge has rated this statement yet.</p>';
  sgFocusSection(document.getElementById('sgStatementGenerations'), opts.focusFeature);
  sgHideFeatureHelp();
  sgStatementDialog.showModal();
  sgStatementDialog.scrollTop = 0;
}

document.getElementById('auBody').addEventListener('click', event => {
  const tr = event.target.closest('tr[data-combo]');
  if (tr) auSelectMetric(tr.dataset.combo, 'published');
});
document.getElementById('auHead').addEventListener('click', event => {
  const help = event.target.closest('.sg-help-btn');
  if (help) {
    event.stopPropagation();
    sgShowFeatureHelp(help);
    return;
  }
  const th = event.target.closest('th.sg-th-prop');
  if (!th) return;
  auFeatFilter[th.dataset.key] = SG_FILTER_CYCLE[auFeatFilter[th.dataset.key]];
  sgApplyFilterHeaders(document.getElementById('auHead'), auFeatFilter);
  auRenderTable();
});
document.getElementById('auHead').addEventListener('mouseover', event => {
  const help = event.target.closest('.sg-help-btn');
  if (help && help !== sgActiveHelpButton) sgShowFeatureHelp(help);
});
document.getElementById('auHead').addEventListener('mouseout', event => {
  if (event.target.closest('.sg-help-btn') && !sgFeatPopup.contains(event.relatedTarget)) sgHideFeatureHelp();
});
document.getElementById('auDetailBody').addEventListener('click', event => {
  const tr = event.target.closest('tr[data-index]');
  const entry = tr && auDetailStatements[Number(tr.dataset.index)];
  if (!entry) return;
  const featureCell = event.target.closest('.au-feature-cell');
  auShowStatement(entry, featureCell ? { focusFeature: featureCell.dataset.featureKey } : {});
});
document.querySelector('#auTable').closest('.sg-table-wrap').addEventListener('scroll', sgHideFeatureHelp);

// ══ TypeSafe Judgments ═════════════════════════════════════════════════════
// Jev's (TypeSafe's System One model) answers for the published statements,
// next to the stored labels and the LLM judges (judge_published_typesafe.py
// writes them, typesafe_audit.py serves them). Jev returns probabilities, not
// text, so every rate on this page is computed here from the per-statement
// rows. Reuses the audit page's feature headers, tables and statement dialog.
let tsLoaded = false;
let tsData = null;
let tsModel = '';
let tsRef = 'stored';
const tsFeatFilter = Object.fromEntries(SG_FEAT_DEFS.map(({ key }) => [key, '']));
let tsDistCharts = [];
let tsCsChart = null;
let tsTableRows = [];
let tsDetailRequestId = 0;
// Blue (UI.agree) for a feature's 1-valued label (like the ● dots) and for
// "yes", orange (UI.expect) for the 0-valued label and "no", neutral gray
// (UI.split) for a split. Blue and orange pass the dataviz palette checks on
// the card in both themes; the gray is below 3:1, so the chart keeps its
// legend and tooltips and the statement list has the values. They are read
// from UI when a chart is drawn, so a theme change is picked up.
// Jev's confidence sits mostly near 1, so the bands are finer at the top
const TS_CONF_BANDS = [
  { label: 'Below 0.5', lo: 0, hi: 0.5 },
  { label: '0.5 – 0.8', lo: 0.5, hi: 0.8 },
  { label: '0.8 – 0.95', lo: 0.8, hi: 0.95 },
  { label: '0.95 and up', lo: 0.95, hi: Infinity },
];
const TS_SHOW = [
  ['all', 'All statements'],
  ['disagree', 'Disagrees on any feature'],
  ...SG_FEAT_DEFS.map(def => [`disagree:${def.key}`, `Disagrees on ${def.v1} / ${def.v0}`]),
  ['low-cs', 'P(common sense) below 50%'],
  ['low-conf', 'Confidence below 0.5 on any feature'],
];
const TS_SORT = [
  ['row', 'Snapshot order'],
  ['cs', 'Lowest P(common sense) first'],
  ['disagree', 'Most disagreements first'],
  ['conf', 'Least confident first'],
];

function tsFi(key) {
  return tsData.feature_keys.indexOf(key);
}

function tsPct(v, digits = 1) {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

function tsMean(values) {
  const valid = values.filter(v => v !== null && v !== undefined);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

// Majority of 0/1 votes, or null on a tie or no votes
function tsMajority(votes) {
  const valid = votes.filter(v => v === 0 || v === 1);
  const ones = valid.filter(v => v === 1).length;
  if (!valid.length || ones * 2 === valid.length) return null;
  return ones * 2 > valid.length ? 1 : 0;
}

function tsReferences() {
  const refs = [{ id: 'stored', label: 'Stored labels', short: 'Stored' }];
  tsData.judges.forEach((judge, index) => {
    const label = auJudgeLabel(judge);
    refs.push({ id: `judge:${index}`, label, short: label });
  });
  if (tsData.judges.length > 1) refs.push({ id: 'majority', label: 'LLM majority', short: 'LLM majority' });
  return refs;
}

function tsRefInfo(ref = tsRef) {
  return tsReferences().find(r => r.id === ref);
}

// A reference's label for feature i: 1, 0, or null when it has none
function tsRefLabel(s, i, ref = tsRef) {
  if (ref === 'stored') return s.stored[i];
  if (ref === 'majority') return tsMajority(s.llm.map(v => v && v.f[i]));
  const v = s.llm[Number(ref.slice(6))];
  return v ? v.f[i] : null;
}

function tsRefCommonsense(s, ref) {
  if (ref === 'stored') return null;
  if (ref === 'majority') return tsMajority(s.llm.map(v => v && v.cs));
  const v = s.llm[Number(ref.slice(6))];
  return v ? v.cs : null;
}

// Chance that a statement the reference labels 1 gets a higher P(1-valued
// label) from Jev than one it labels 0, ties counting half: 0.5 is chance,
// 1 separates them perfectly
function tsAuc(pairs) {
  const pos = pairs.filter(d => d.y === 1).length;
  const neg = pairs.length - pos;
  if (!pos || !neg) return null;
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].p === sorted[i].p) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k].y === 1) rankSum += rank;
    i = j;
  }
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}

function tsRenderIntro() {
  const d = tsData;
  document.getElementById('tsIntro').textContent =
    `${d.model} (${d.response_models.join(', ')}) judged ${fmtNum(d.statements.length)} of ` +
    `${fmtNum(d.n_statements)} published statements (${fmtNum(d.input_tokens)} input tokens). For each ` +
    'statement it answered seven questions at once: a two-option Choice per feature pair, given both labels\' ' +
    'definitions and examples, and a yes/no Noul, "Is the statement an example of human common sense?". ' +
    'Jev returns probabilities rather than explanations: its label is the more probable option, and it counts as ' +
    'rating a statement common sense at 50% or more. The first column group is the share of statements given each ' +
    'pair\'s first label, by source; the second is how often Jev\'s label matches each source\'s, out of the ' +
    'statements that source rated (below 70% in red).';
}

function tsRenderAgreement() {
  const d = tsData;
  const judges = tsReferences().filter(r => r.id.startsWith('judge:'));
  const agreeRefs = tsReferences();
  const share = v => `<td>${tsPct(v)}</td>`;
  const agree = (v, first) => {
    const cls = [first ? 'ts-group-start' : '', v !== null && v < 0.7 ? 'au-low' : ''].filter(Boolean).join(' ');
    return `<td${cls ? ` class="${cls}"` : ''}>${tsPct(v)}</td>`;
  };
  const rows = SG_FEAT_DEFS.map(def => {
    const i = tsFi(def.key);
    const shares = [
      tsMean(d.statements.map(s => s.stored[i])),
      tsMean(d.statements.map(s => s.choice[i])),
      ...judges.map(j => tsMean(d.statements.map(s => tsRefLabel(s, i, j.id)))),
    ];
    const agreements = agreeRefs.map(r => tsMean(d.statements.map(s => {
      const y = tsRefLabel(s, i, r.id);
      return y === null ? null : Number(s.choice[i] === y);
    })));
    return `<tr><td class="au-judge">${esc(def.v1)} / ${esc(def.v0)}</td>` +
      shares.map(share).join('') + agreements.map((v, k) => agree(v, k === 0)).join('') + '</tr>';
  });
  // Common sense has no stored label; Jev counts as yes at P >= 50%
  const jevCs = s => Number(s.cs >= 0.5);
  const csShares = [null, tsMean(d.statements.map(jevCs)),
    ...judges.map(j => tsMean(d.statements.map(s => tsRefCommonsense(s, j.id))))];
  const csAgree = agreeRefs.map(r => r.id === 'stored' ? null : tsMean(d.statements.map(s => {
    const y = tsRefCommonsense(s, r.id);
    return y === null ? null : Number(jevCs(s) === y);
  })));
  rows.push('<tr class="au-any-row"><td class="au-judge">Common sense</td>' +
    csShares.map(share).join('') + csAgree.map((v, k) => agree(v, k === 0)).join('') + '</tr>');
  document.getElementById('tsAgreement').innerHTML =
    '<div class="au-agreement-wrap"><table class="au-agreement-table ts-agreement-table"><thead>' +
    `<tr><th rowspan="2">Feature</th><th colspan="${2 + judges.length}">Share given the first label</th>` +
    `<th colspan="${agreeRefs.length}" class="ts-group-start">Jev agrees with</th></tr>` +
    '<tr><th>Stored</th><th>Jev</th>' + judges.map(j => `<th>${esc(j.short)}</th>`).join('') +
    agreeRefs.map((r, k) => `<th${k === 0 ? ' class="ts-group-start"' : ''}>${esc(r.short)}</th>`).join('') +
    `</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function tsRenderCommonsense() {
  const N = 20;
  const groups = [
    { label: 'Every LLM judge: common sense', color: UI.agree, counts: Array(N).fill(0), probs: [] },
    { label: 'LLM judges split', color: UI.split, counts: Array(N).fill(0), probs: [] },
    { label: 'No LLM judge: common sense', color: UI.expect, counts: Array(N).fill(0), probs: [] },
  ];
  let unrated = 0;
  tsData.statements.forEach(s => {
    const votes = s.llm.filter(Boolean).map(v => v.cs);
    if (!votes.length) { unrated++; return; }
    const g = groups[votes.every(v => v === 1) ? 0 : votes.every(v => v === 0) ? 2 : 1];
    g.counts[Math.min(N - 1, Math.floor(s.cs * N))]++;
    g.probs.push(s.cs);
  });
  const [allYes, , allNo] = groups;
  document.getElementById('tsCsCaption').textContent =
    'Statements by Jev\'s probability that they are common sense, stacked by how the LLM judges who rated each ' +
    `one voted. Jev gives ${tsPct(tsMean(tsData.statements.map(s => Number(s.cs >= 0.5))))} of statements 50% or ` +
    `more. Of the ${fmtNum(allYes.probs.length)} statements every LLM judge calls common sense, Jev agrees on ` +
    `${tsPct(tsMean(allYes.probs.map(p => Number(p >= 0.5))))}; of the ${fmtNum(allNo.probs.length)} none does, ` +
    `Jev agrees on ${tsPct(tsMean(allNo.probs.map(p => Number(p < 0.5))))}.` +
    (unrated ? ` ${fmtNum(unrated)} statements no LLM judge has rated are left out.` : '');
  const labels = Array.from({ length: N }, (_, k) => `${k * 5}%`);
  if (tsCsChart) tsCsChart.destroy();
  tsCsChart = new Chart(document.getElementById('tsCsChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: groups.map(g => ({
        label: g.label, data: g.counts, backgroundColor: g.color,
        // A 2px white gap between stacked segments instead of an outline
        borderColor: UI.surface, borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
        maxBarThickness: 24,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { boxWidth: 12, boxHeight: 12, font: CHART_FONT.legend, padding: 14 } },
        tooltip: {
          callbacks: {
            title: items => `P(common sense) ${items[0].dataIndex * 5}–${items[0].dataIndex * 5 + 5}%`,
            label: item => `${item.dataset.label}: ${fmtNum(item.raw)}`,
            footer: items => `${fmtNum(items.reduce((sum, item) => sum + item.raw, 0))} statements`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          title: { display: true, text: "Jev's P(common sense)", font: CHART_FONT.title },
          ticks: { font: CHART_FONT.tick, callback: (_, idx) => (idx % 4 === 0 ? labels[idx] : '') },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: UI.grid },
          border: { display: false },
          title: { display: true, text: 'Statements', font: CHART_FONT.title },
          ticks: { font: CHART_FONT.tick, precision: 0 },
        },
      },
    },
  });
}

function tsRenderDistributions() {
  tsDistCharts.forEach(chart => chart.destroy());
  tsDistCharts = [];
  const ref = tsRefInfo();
  document.getElementById('tsDistCaption').textContent =
    `For each feature, Jev's probability for the pair's first label, split by ${ref.id === 'stored' ? 'the stored label' : `${ref.label}'s label`}. ` +
    'Bars are the share of each group in each 10-point band, so groups of different sizes compare directly. ' +
    'Well-separated groups mean Jev orders statements the way the reference does, even where its 50% cut-off ' +
    'lands differently. AUC is the chance that a statement the reference gives the first label gets a higher ' +
    'probability than one it gives the second (0.5 = chance, 1 = perfect separation).';
  document.getElementById('tsDistGrid').innerHTML = SG_FEAT_DEFS.map((def, k) =>
    `<div class="ts-dist-cell"><div class="ts-dist-title">${esc(def.v1)} / ${esc(def.v0)}</div>` +
    `<div class="ts-dist-sub" id="tsDistSub${k}"></div>` +
    `<div class="ts-chart-box"><canvas id="tsDist${k}" role="img" ` +
    `aria-label="Histogram of Jev's probability of ${esc(def.v1)}, split by the reference label"></canvas></div></div>`
  ).join('');
  const N = 10;
  const labels = Array.from({ length: N }, (_, b) => `${b * 10}%`);
  SG_FEAT_DEFS.forEach((def, k) => {
    const i = tsFi(def.key);
    const pairs = tsData.statements
      .map(s => ({ p: s.p[i], y: tsRefLabel(s, i), choice: s.choice[i] }))
      .filter(d => d.y !== null);
    const groups = [1, 0].map(y => {
      const counts = Array(N).fill(0);
      const members = pairs.filter(d => d.y === y);
      members.forEach(d => counts[Math.min(N - 1, Math.floor(d.p * N))]++);
      return { y, n: members.length, counts };
    });
    const auc = tsAuc(pairs);
    document.getElementById(`tsDistSub${k}`).textContent =
      `AUC ${auc === null ? '—' : auc.toFixed(2)} · agrees ${tsPct(tsMean(pairs.map(d => Number(d.choice === d.y))))}`;
    tsDistCharts.push(new Chart(document.getElementById(`tsDist${k}`), {
      type: 'bar',
      data: {
        labels,
        datasets: groups.map(g => ({
          // The filter row names the reference, so the legend stays one line
          label: `${g.y ? def.v1 : def.v0} (${fmtNum(g.n)})`,
          pole: g.y ? def.v1 : def.v0,
          data: g.counts.map(c => (g.n ? +((100 * c) / g.n).toFixed(1) : 0)),
          counts: g.counts,
          backgroundColor: g.y ? UI.agree : UI.expect,
          borderWidth: 0,
          borderRadius: 4,
          maxBarThickness: 24,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        categoryPercentage: 0.8,
        barPercentage: 0.9,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 10, font: CHART_FONT.legend, padding: 8 } },
          tooltip: {
            callbacks: {
              title: items => `P(${def.v1}) ${items[0].dataIndex * 10}–${items[0].dataIndex * 10 + 10}%`,
              label: item => `${ref.short}: ${item.dataset.pole} · ${item.raw}% (${fmtNum(item.dataset.counts[item.dataIndex])})`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            title: { display: true, text: `Jev's P(${def.v1})`, font: CHART_FONT.title },
            ticks: { font: CHART_FONT.tick, callback: (_, idx) => (idx % 2 === 0 ? labels[idx] : '') },
          },
          y: {
            beginAtZero: true,
            grid: { color: UI.grid },
            border: { display: false },
            title: { display: true, text: 'Share of group', font: CHART_FONT.title },
            ticks: { font: CHART_FONT.tick, callback: v => `${v}%` },
          },
        },
      },
    }));
  });
}

function tsRenderConfidence() {
  const ref = tsRefInfo();
  document.getElementById('tsConfCaption').textContent =
    'Jev\'s confidence summarizes how concentrated its two probabilities are: 0 is a 50/50 split and 1 is ' +
    `certain (for two options, |2 × P − 1|). Each cell is how often Jev's label matches ` +
    `${ref.id === 'stored' ? 'the stored label' : `${ref.label}'s label`} among the statements in that confidence ` +
    'band, with the number of statements in brackets; below 70% in red. Where confidence is useful for routing, ' +
    'agreement rises from left to right.';
  const rows = SG_FEAT_DEFS.map(def => {
    const i = tsFi(def.key);
    const rated = tsData.statements.filter(s => tsRefLabel(s, i) !== null);
    const cell = (members, extra = '') => {
      if (!members.length) return `<td class="au-none${extra}">—</td>`;
      const rate = tsMean(members.map(s => Number(s.choice[i] === tsRefLabel(s, i))));
      return `<td class="${rate < 0.7 ? 'au-low' : ''}${extra}">${tsPct(rate)} ` +
        `<span class="ts-n">(${fmtNum(members.length)})</span></td>`;
    };
    return `<tr><td class="au-judge">${esc(def.v1)} / ${esc(def.v0)}</td>` +
      TS_CONF_BANDS.map(b => cell(rated.filter(s => s.conf[i] >= b.lo && s.conf[i] < b.hi))).join('') +
      cell(rated, ' ts-group-start') + '</tr>';
  });
  document.getElementById('tsConfidence').innerHTML =
    '<div class="au-agreement-wrap"><table class="au-agreement-table ts-agreement-table"><thead><tr>' +
    '<th>Feature</th>' + TS_CONF_BANDS.map(b => `<th>Confidence ${esc(b.label)}</th>`).join('') +
    `<th class="ts-group-start">All</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function tsDisagreements(s) {
  return SG_FEAT_DEFS.reduce((n, def) => {
    const i = tsFi(def.key);
    const y = tsRefLabel(s, i);
    return n + (y !== null && s.choice[i] !== y ? 1 : 0);
  }, 0);
}

function tsRenderTable() {
  const ref = tsRefInfo();
  const refPhrase = ref.id === 'stored' ? 'the stored label' : `${ref.label}'s label`;
  document.getElementById('tsTableCaption').textContent =
    `Each feature cell shows Jev's label (● for the pair's first label, ○ for the second, as in the column ` +
    `headers) and its probability for that label; cells marked ≠ in red disagree with ${refPhrase}. Click a ` +
    `column header to filter by ${refPhrase}, or a row to compare Jev with the stored labels and every LLM judge, ` +
    'with their explanations.';
  const tbody = document.getElementById('tsBody');
  const query = document.getElementById('tsSearch').value.trim().toLowerCase();
  const show = document.getElementById('tsShow').value;
  const rows = tsData.statements
    .map(s => ({ s, dis: tsDisagreements(s), minConf: Math.min(...s.conf) }))
    .filter(({ s, dis, minConf }) => {
      if (query && !s.statement.toLowerCase().includes(query)) return false;
      if (!SG_FEAT_DEFS.every(def => !tsFeatFilter[def.key] ||
          String(tsRefLabel(s, tsFi(def.key))) === tsFeatFilter[def.key])) return false;
      if (show === 'disagree') return dis > 0;
      if (show.startsWith('disagree:')) {
        const i = tsFi(show.slice(9));
        const y = tsRefLabel(s, i);
        return y !== null && s.choice[i] !== y;
      }
      if (show === 'low-cs') return s.cs < 0.5;
      if (show === 'low-conf') return minConf < 0.5;
      return true;
    });
  const byRow = (a, b) => a.s.row - b.s.row;
  const order = {
    row: byRow,
    cs: (a, b) => a.s.cs - b.s.cs || byRow(a, b),
    disagree: (a, b) => b.dis - a.dis || byRow(a, b),
    conf: (a, b) => a.minConf - b.minConf || byRow(a, b),
  };
  rows.sort(order[document.getElementById('tsSort').value]);
  tsTableRows = rows.map(r => r.s);
  document.getElementById('tsCount').textContent =
    `${fmtNum(rows.length)} of ${fmtNum(tsData.statements.length)} statements`;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="sg-empty-row"><td colspan="${3 + SG_FEAT_DEFS.length}">No statements match the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(({ s }, index) => `<tr data-index="${index}">` +
    `<td class="sg-col-num">${index + 1}</td>` +
    `<td class="ts-col-statement">${esc(s.statement)}</td>` +
    SG_FEAT_DEFS.map((def, k) => {
      const i = tsFi(def.key);
      const c = s.choice[i];
      const y = tsRefLabel(s, i);
      const pChosen = c ? s.p[i] : 1 - s.p[i];
      const disagree = y !== null && c !== y;
      const title = `Jev: ${c ? def.v1 : def.v0} (${tsPct(pChosen, 0)}, confidence ${s.conf[i].toFixed(2)}) · ` +
        `${ref.label}: ${y === null ? 'no label' : y ? def.v1 : def.v0}`;
      const cls = `ts-cell${k % 2 === 0 ? ' sg-prop-alt' : ''}${disagree ? ' ts-disagree' : ''}`;
      return `<td class="${cls}" data-feature-key="${esc(def.key)}" title="${esc(title)}">` +
        (disagree ? '<span class="ts-ne">≠</span>' : '') +
        `<span class="sg-option-dot ${c ? 'sg-val-1' : 'sg-val-0'}">${c ? '●' : '○'}</span>${tsPct(pChosen, 0)}</td>`;
    }).join('') +
    `<td class="ts-cs" data-feature-key="commonsense">${tsPct(s.cs, 0)}</td></tr>`
  ).join('');
}

function tsRenderScoped() {
  tsRenderDistributions();
  tsRenderConfidence();
  tsRenderTable();
}

async function tsLoad() {
  const intro = document.getElementById('tsIntro');
  try {
    const query = tsModel ? `?model=${encodeURIComponent(tsModel)}` : '';
    const response = await fetch(`${API}/typesafe-audit${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tsData = await response.json();
  } catch (error) {
    intro.textContent = `Could not load the TypeSafe judgments: ${error.message}`;
    return;
  }
  if (!tsData.statements.length) {
    intro.innerHTML = tsData.models.length
      ? 'No judged statements match the current snapshot of published statements.'
      : 'No TypeSafe results yet. Run <code>judge_published_typesafe.py</code>, then restart the server.';
    document.getElementById('tsBody').innerHTML =
      `<tr class="sg-empty-row"><td colspan="${3 + SG_FEAT_DEFS.length}">No data.</td></tr>`;
    return;
  }
  tsModel = tsData.model;
  const modelSelect = document.getElementById('tsModelSelect');
  modelSelect.innerHTML = tsData.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  modelSelect.value = tsModel;
  modelSelect.classList.toggle('hidden', tsData.models.length < 2);
  const refs = tsReferences();
  if (!refs.some(r => r.id === tsRef)) tsRef = 'stored';
  const refSelect = document.getElementById('tsRefSelect');
  refSelect.innerHTML = refs.map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
  refSelect.value = tsRef;
  tsRenderIntro();
  tsRenderAgreement();
  tsRenderCommonsense();
  tsRenderScoped();
}

async function tsShowStatement(s, focusFeature) {
  const requestId = ++tsDetailRequestId;
  let judges = [];
  try {
    const response = await fetch(`${API}/typesafe-audit-statement?row=${s.row}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    judges = (await response.json()).judges;
  } catch (error) {
    console.error('Could not load the LLM judges\' answers:', error);  // show Jev alone
  }
  if (requestId !== tsDetailRequestId) return;
  // Jev as one more judge; its probabilities stand in for an explanation
  const jev = {
    judge_model: tsData.model,
    commonsense: s.cs >= 0.5 ? 1 : 0,
    commonsense_explanation: `P(common sense) = ${tsPct(s.cs, 0)}. Jev returns probabilities, not explanations.`,
    features: Object.fromEntries(SG_FEAT_DEFS.map(def => {
      const i = tsFi(def.key);
      return [def.key, {
        classification: s.choice[i] ? def.key : def.v0.toLowerCase(),
        confidence: '',
        explanation: `P(${def.v1}) = ${tsPct(s.p[i], 0)}, P(${def.v0}) = ${tsPct(1 - s.p[i], 0)} · ` +
          `confidence ${s.conf[i].toFixed(2)}`,
      }];
    })),
  };
  const stored = {
    gen_model: 'Stored labels', gen_commonsense_explanation: '', judges: [jev, ...judges],
    gen_features: Object.fromEntries(SG_FEAT_DEFS.map(def => [def.key, {
      confidence: '', explanation: "Label stored in the platform's statement properties.",
    }])),
  };
  const labels = Object.fromEntries(SG_FEAT_DEFS.map(def => [def.key, s.stored[tsFi(def.key)]]));
  document.getElementById('sgStatementText').textContent = s.statement;
  document.getElementById('sgStatementModel').textContent =
    `Published statement #${s.id} · Jev and ${judges.length} LLM judge${judges.length === 1 ? '' : 's'}, ` +
    'compared with the stored labels';
  const container = document.getElementById('sgStatementGenerations');
  container.innerHTML = sgRenderGeneration(stored, labels, { sourceTitle: 'Stored label', showRationale: false });
  sgFocusSection(container, focusFeature);
  sgHideFeatureHelp();
  if (!sgStatementDialog.open) sgStatementDialog.showModal();
  sgStatementDialog.scrollTop = 0;
}

document.getElementById('tsShow').innerHTML =
  TS_SHOW.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
document.getElementById('tsSort').innerHTML =
  TS_SORT.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
document.getElementById('tsHead').innerHTML = '<th class="sg-col-num">#</th>' +
  '<th class="ts-col-statement">Statement</th>' + sgFeatureHeaderCells() + '<th class="ts-col-cs">Common sense</th>';
sgApplyFilterHeaders(document.getElementById('tsHead'), tsFeatFilter);

document.getElementById('tsModelSelect').addEventListener('change', event => {
  tsModel = event.target.value;
  tsLoad();
});
document.getElementById('tsRefSelect').addEventListener('change', event => {
  tsRef = event.target.value;
  tsRenderScoped();
});
document.getElementById('tsSearch').addEventListener('input', () => tsData && tsRenderTable());
document.getElementById('tsShow').addEventListener('change', () => tsData && tsRenderTable());
document.getElementById('tsSort').addEventListener('change', () => tsData && tsRenderTable());
document.getElementById('tsHead').addEventListener('click', event => {
  const help = event.target.closest('.sg-help-btn');
  if (help) {
    event.stopPropagation();
    sgShowFeatureHelp(help);
    return;
  }
  const th = event.target.closest('th.sg-th-prop');
  if (!th || !tsData) return;
  tsFeatFilter[th.dataset.key] = SG_FILTER_CYCLE[tsFeatFilter[th.dataset.key]];
  sgApplyFilterHeaders(document.getElementById('tsHead'), tsFeatFilter);
  tsRenderTable();
});
document.getElementById('tsHead').addEventListener('mouseover', event => {
  const help = event.target.closest('.sg-help-btn');
  if (help && help !== sgActiveHelpButton) sgShowFeatureHelp(help);
});
document.getElementById('tsHead').addEventListener('mouseout', event => {
  if (event.target.closest('.sg-help-btn') && !sgFeatPopup.contains(event.relatedTarget)) sgHideFeatureHelp();
});
document.getElementById('tsBody').addEventListener('click', event => {
  const tr = event.target.closest('tr[data-index]');
  const entry = tr && tsTableRows[Number(tr.dataset.index)];
  if (!entry) return;
  const cell = event.target.closest('[data-feature-key]');
  tsShowStatement(entry, cell ? cell.dataset.featureKey : null);
});
document.querySelector('#tsTable').closest('.sg-table-wrap').addEventListener('scroll', sgHideFeatureHelp);

// Set initial state so back/forward work, then route to the correct panel
const _initialTab = tabFromPathname();
// Keep the query string: the LLM Evaluations panel reads its view from it
history.replaceState({ tab: _initialTab }, "", window.location.pathname + window.location.search);
switchToTab(_initialTab, false);

window.addEventListener("popstate", (e) => {
  const tab = (e.state && e.state.tab) || tabFromPathname();
  switchToTab(tab, false);
});

// ── Country dropdowns ──────────────────────────────────────────────────────

async function populateSelects() {
  const countries = await fetch(`${API}/countries`).then((r) => r.json());
  countries.sort((a, b) => b.n_users - a.n_users);
  [
    targetSelect,
    referenceSelect,
    stmtScoresCountrySelect,
    dpCountrySelect,
    compareGroupAEl,
    compareGroupBEl,
  ].forEach((sel) => {
    countries.forEach(({ country, n_users }) => {
      const opt = document.createElement("option");
      opt.value = country;
      opt.textContent = `${country} (${fmtNum(n_users)})`;
      sel.appendChild(opt);
    });
  });
  compareGroupAEl.value = "United States";
  compareGroupBEl.value = "India";
}

// ── User detail modal ──────────────────────────────────────────────────────

async function openUserDetail(userRow, opts = {}) {
  const countryLabel = userRow.country ? ` · ${userRow.country}` : "";
  modalUserId.textContent = userRow.sessionId + countryLabel;
  // Excluded users (grayed-out rows) have no scores to show
  modalUserScores.textContent =
    userRow.commonsensicality == null
      ? "No score: fewer than 5 statements count"
      : `Consensus: ${fmtPct(userRow.consensus)} · ` +
        `Awareness: ${fmtPct(userRow.awareness)} · ` +
        `Commonsensicality: ${fmtPct(userRow.commonsensicality)}`;
  modalBody.innerHTML =
    '<tr><td colspan="5" class="empty-row">Loading…</td></tr>';
  modalExplanation.classList.add("hidden");
  userModal.classList.remove("hidden");

  const reference =
    opts.reference !== undefined ? opts.reference : referenceSelect.value;
  const target = opts.target !== undefined ? opts.target : targetSelect.value;
  const url = `${API}/user-detail?userId=${encodeURIComponent(userRow.sessionId)}&reference=${encodeURIComponent(reference)}&target=${encodeURIComponent(target)}${dateParams()}`;
  let data;
  try {
    data = await fetch(url).then((r) => r.json());
  } catch {
    modalBody.innerHTML =
      '<tr><td colspan="5" class="empty-row">Failed to load.</td></tr>';
    return;
  }

  if (!data.rows.length) {
    modalBody.innerHTML =
      '<tr><td colspan="5" class="empty-row">No ratings found.</td></tr>';
    modalExplanation.classList.add("hidden");
    return;
  }

  // ── Score explanation — use server-computed values that match the scoring algorithm
  const refLabel = reference === "all" ? "all countries" : reference;
  const targetLabel = target === "all" ? "all countries" : target;
  const N_total = data.rows.length; // all statements the user rated
  const N = data.n_scoring; // qualifying statements used in calculation
  const A = data.A;
  const B = data.B;
  const consFrac = N > 0 ? A / N : 0;
  const awareFrac = N > 0 ? B / N : 0;
  const commsFrac = Math.sqrt(consFrac * awareFrac);
  const fp = (v) => (v * 100).toFixed(1) + "%";

  // Which statements count, then the three steps, as in the intro card
  const countNote =
    N_total > N
      ? ` <strong>${N}</strong> of them count, having at least 10 ratings ` +
        `${reference === "all" ? "overall" : `from ${esc(refLabel)}`}.`
      : "";
  modalExplanation.innerHTML =
    `<p class="expl-context">Scored against the majority in <strong>${esc(refLabel)}</strong>, using its ratings from all dates.</p>` +
    `<ul class="expl-list">` +
    `<li>Rated <strong>${N_total}</strong> statement${N_total !== 1 ? "s" : ""}.${countNote}` +
    (data.disqualified ? ` Fewer than 5 count, so this participant has <strong>no score</strong>.` : "") +
    `</li>` +
    (data.disqualified ? "" :
    `<li><strong>Consensus</strong>: ${A} of ${N} answers match the majority = <strong>${fp(consFrac)}</strong>.</li>` +
    `<li><strong>Awareness</strong>: ${B} of ${N} guesses about most others match the majority = <strong>${fp(awareFrac)}</strong>.</li>` +
    `<li><strong>Commonsensicality</strong> = ${sqrtHtml(`${fp(consFrac)} × ${fp(awareFrac)}`)} = <strong>${fp(commsFrac)}</strong>.</li>`) +
    `</ul>` +
    (data.disqualified ? "" : `<p class="expl-context">✓ marks an answer that matches the majority: consensus is the share of ✓ under <em>Agrees?</em>, awareness the share under <em>Thinks most agree?</em></p>`);
  modalExplanation.classList.remove("hidden");

  // ✓ / ✗ against the majority, as in the intro card's worked example; the
  // server says which statements count (10+ reference ratings) and their
  // majority, by the same rule as the score; the others are grey
  const fragment = document.createDocumentFragment();
  data.rows.forEach((row) => {
    const counted = row.counted === true && row.ref_majority != null;
    const maj = counted ? Number(row.ref_majority) : null;
    const tr = document.createElement("tr");
    if (!counted) tr.classList.add("row-uncounted");
    tr.innerHTML =
      `<td class="td-statement">${esc(fixStatement(row.statement))}</td>` +
      `<td class="td-modal-right">${counted ? refAvgAgree(row.ref_i_agree_mean) : `<span class="td-muted" title="Fewer than 10 ratings in ${esc(refLabel)}">not counted</span>`}</td>` +
      `<td class="td-modal-right">${answerPill(row.I_agree, maj)}</td>` +
      `<td class="td-modal-right">${answerPill(row.others_agree, maj)}</td>` +
      `<td class="td-modal-right">${row.ref_n_ratings != null ? fmtNum(row.ref_n_ratings) : "—"}</td>`;
    fragment.appendChild(tr);
  });
  modalBody.innerHTML = "";
  modalBody.appendChild(fragment);
}

function closeModal() {
  userModal.classList.add("hidden");
}
function closeStmtModal() {
  stmtModal.classList.add("hidden");
}
function closeStmtProps() {
  stmtPropsModal.classList.add("hidden");
}

modalClose.addEventListener("click", closeModal);
userModal.addEventListener("click", (e) => {
  if (e.target === userModal) closeModal();
});
stmtModalClose.addEventListener("click", closeStmtModal);
stmtModal.addEventListener("click", (e) => {
  if (e.target === stmtModal) closeStmtModal();
});
stmtPropsClose.addEventListener("click", closeStmtProps);
stmtPropsModal.addEventListener("click", (e) => {
  if (e.target === stmtPropsModal) closeStmtProps();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
    closeStmtModal();
    closeStmtProps();
  }
});

// ── Scores: sort & filter ──────────────────────────────────────────────────

function buildScoresRows() {
  const nBins = histBinEdges.length - 1;
  const q = scoresSearchQuery.trim().toLowerCase();

  let rows =
    activeBinIdx === null
      ? [...allScoresRows]
      : allScoresRows.filter((r) => {
          const lo = histBinEdges[activeBinIdx];
          const hi = histBinEdges[activeBinIdx + 1];
          const isLast = activeBinIdx === nBins - 1;
          return (
            r.commonsensicality >= lo &&
            (isLast ? r.commonsensicality <= hi : r.commonsensicality < hi)
          );
        });

  if (q) {
    rows = rows.filter((r) => r.sessionId.toLowerCase().includes(q));
  }

  if (globalDateFrom) {
    rows = rows.filter((r) => r.last_answer && r.last_answer >= globalDateFrom);
  }
  if (globalDateTo) {
    rows = rows.filter((r) => r.first_answer && r.first_answer <= globalDateTo);
  }

  if (sortKey !== null) {
    rows.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const d = typeof av === "string"
        ? (av ?? "").localeCompare(bv ?? "")
        : av - bv;
      return sortDir === "asc" ? d : -d;
    });
  }

  // Append excluded users (only when no histogram bin is selected)
  let excluded = [];
  if (activeBinIdx === null) {
    excluded = allScoresExcluded.map(r => ({ ...r, _excluded: true }));
    if (q) excluded = excluded.filter(r => r.sessionId.toLowerCase().includes(q));
    excluded.sort((a, b) => b.n_statements - a.n_statements);
  }

  scoresRows = [...rows, ...excluded];
  scoresPage = 1;
}

function updateSortHeaders() {
  document.querySelectorAll("#scoresTable thead th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    const isActive = sortKey !== null && th.dataset.sort === sortKey;
    th.classList.toggle("sort-active", isActive);
    icon.textContent = isActive ? (sortDir === "asc" ? "▲" : "▼") : "";
  });
}

// ── Scores: bar colors ─────────────────────────────────────────────────────

function getBarColors() {
  const n = Math.max(histBinEdges.length - 1, 20);
  return Array.from({ length: n }, (_, i) => {
    if (activeBinIdx === null) return UI.agree;
    return i === activeBinIdx ? UI.agreeInk : UI.agreeSoft;
  });
}

function updateBarColors() {
  if (!histChart) return;
  histChart.data.datasets[0].backgroundColor = getBarColors();
  histChart.update("none");
}

// ── Scores: table page ─────────────────────────────────────────────────────

function fmtLastDate(iso) {
  return iso || "—";
}

function scoresTotalPages() {
  return Math.max(1, Math.ceil(scoresRows.length / PAGE_SIZE));
}

function renderScoresPage() {
  const start = (scoresPage - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  const qualifyingBefore = scoresRows.slice(0, start).filter(r => !r._excluded).length;
  let qualRank = qualifyingBefore + 1;

  scoresRows.slice(start, start + PAGE_SIZE).forEach((row) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    const userId = row.sessionId;
    if (row._excluded) {
      tr.classList.add("row-excluded");
      tr.innerHTML =
        `<td class="td-rank td-dim">—</td>` +
        `<td class="td-user" title="${esc(userId)}">${esc(userId.slice(0, 14))}…</td>` +
        `<td class="td-flag">${flagCellHtml(row.country)}</td>` +
        `<td class="td-num">${fmtNum(row.n_statements)}</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-last">${fmtLastDate(row.last_answer)}</td>`;
    } else {
      tr.innerHTML =
        `<td class="td-rank">${fmtNum(qualRank++)}</td>` +
        `<td class="td-user" title="${esc(userId)}">${esc(userId.slice(0, 14))}…</td>` +
        `<td class="td-flag">${flagCellHtml(row.country)}</td>` +
        `<td class="td-num">${fmtNum(row.n_statements)}</td>` +
        `<td>${pctBarScore(row.consensus)}</td>` +
        `<td>${pctBarScore(row.awareness)}</td>` +
        `<td>${pctBarScore(row.commonsensicality)}</td>` +
        `<td class="td-last">${fmtLastDate(row.last_answer)}</td>`;
    }
    tr.addEventListener("click", () => openUserDetail(row));
    attachFlagHandlers(tr);
    fragment.appendChild(tr);
  });

  scoresBody.innerHTML = "";
  scoresBody.appendChild(fragment);

  // Update filter label
  if (activeBinIdx === null) {
    const noteVisible = !document
      .getElementById("scoresMinRatingsNote")
      .classList.contains("hidden");
    scoresFilterLabel.textContent =
      scoresRows.length && !noteVisible
        ? `${fmtNum(scoresRows.length)} participants`
        : "";
  } else {
    const lo = fmtPct(histBinEdges[activeBinIdx]);
    const hi = fmtPct(histBinEdges[activeBinIdx + 1]);
    scoresFilterLabel.textContent = `Showing scores ${lo} – ${hi}: ${fmtNum(scoresRows.length)} participants · click the bar again to show everyone`;
  }

  const tp = scoresTotalPages();
  scoresPageInfoEl.textContent = `Page ${fmtNum(scoresPage)} of ${fmtNum(tp)}`;
  btnScoresPrev.disabled = scoresPage <= 1;
  btnScoresNext.disabled = scoresPage >= tp;
}

// ── Histogram ──────────────────────────────────────────────────────────────

// ── World map choropleth ───────────────────────────────────────────────────

// Server country name → naturalearth name
const _countryNameMap = {
  "United States": "United States of America",
  "Korea, South": "South Korea",
  "Korea, North": "North Korea",
  "Myanmar (Burma)": "Myanmar",
  "Republic of the Congo": "Congo",
  "Ivory Coast": "Côte d'Ivoire",
  "Czech Republic": "Czechia",
  "Macedonia": "North Macedonia",
};
// naturalearth name → server country name (reverse)
const _countryNameMapRev = Object.fromEntries(
  Object.entries(_countryNameMap).map(([k, v]) => [v, k])
);
function _normCountry(name) { return _countryNameMap[name] || name; }
function _serverCountry(neName) { return _countryNameMapRev[neName] || neName; }



const _FLAG_EMOJI = {
  AD:"🇦🇩",AE:"🇦🇪",AF:"🇦🇫",AG:"🇦🇬",AL:"🇦🇱",AM:"🇦🇲",AO:"🇦🇴",AR:"🇦🇷",AT:"🇦🇹",AU:"🇦🇺",
  AZ:"🇦🇿",BA:"🇧🇦",BB:"🇧🇧",BD:"🇧🇩",BE:"🇧🇪",BF:"🇧🇫",BG:"🇧🇬",BH:"🇧🇭",BI:"🇧🇮",BJ:"🇧🇯",
  BN:"🇧🇳",BO:"🇧🇴",BR:"🇧🇷",BS:"🇧🇸",BT:"🇧🇹",BW:"🇧🇼",BY:"🇧🇾",BZ:"🇧🇿",CA:"🇨🇦",CD:"🇨🇩",
  CF:"🇨🇫",CG:"🇨🇬",CH:"🇨🇭",CI:"🇨🇮",CL:"🇨🇱",CM:"🇨🇲",CN:"🇨🇳",CO:"🇨🇴",CR:"🇨🇷",CU:"🇨🇺",
  CV:"🇨🇻",CY:"🇨🇾",CZ:"🇨🇿",DE:"🇩🇪",DJ:"🇩🇯",DK:"🇩🇰",DM:"🇩🇲",DO:"🇩🇴",DZ:"🇩🇿",EC:"🇪🇨",
  EE:"🇪🇪",EG:"🇪🇬",EH:"🇪🇭",ER:"🇪🇷",ES:"🇪🇸",ET:"🇪🇹",FI:"🇫🇮",FJ:"🇫🇯",FR:"🇫🇷",GA:"🇬🇦",
  GB:"🇬🇧",GD:"🇬🇩",GE:"🇬🇪",GH:"🇬🇭",GM:"🇬🇲",GN:"🇬🇳",GQ:"🇬🇶",GR:"🇬🇷",GT:"🇬🇹",GW:"🇬🇼",
  GY:"🇬🇾",HN:"🇭🇳",HR:"🇭🇷",HT:"🇭🇹",HU:"🇭🇺",ID:"🇮🇩",IE:"🇮🇪",IL:"🇮🇱",IN:"🇮🇳",IQ:"🇮🇶",
  IR:"🇮🇷",IS:"🇮🇸",IT:"🇮🇹",JM:"🇯🇲",JO:"🇯🇴",JP:"🇯🇵",KE:"🇰🇪",KG:"🇰🇬",KH:"🇰🇭",KI:"🇰🇮",
  KM:"🇰🇲",KN:"🇰🇳",KP:"🇰🇵",KR:"🇰🇷",KW:"🇰🇼",KZ:"🇰🇿",LA:"🇱🇦",LB:"🇱🇧",LC:"🇱🇨",LI:"🇱🇮",
  LK:"🇱🇰",LR:"🇱🇷",LS:"🇱🇸",LT:"🇱🇹",LU:"🇱🇺",LV:"🇱🇻",LY:"🇱🇾",MA:"🇲🇦",MC:"🇲🇨",MD:"🇲🇩",
  ME:"🇲🇪",MG:"🇲🇬",MH:"🇲🇭",MK:"🇲🇰",ML:"🇲🇱",MM:"🇲🇲",MN:"🇲🇳",MR:"🇲🇷",MT:"🇲🇹",MU:"🇲🇺",
  MV:"🇲🇻",MW:"🇲🇼",MX:"🇲🇽",MY:"🇲🇾",MZ:"🇲🇿",NA:"🇳🇦",NE:"🇳🇪",NG:"🇳🇬",NI:"🇳🇮",NL:"🇳🇱",
  NO:"🇳🇴",NP:"🇳🇵",NR:"🇳🇷",NZ:"🇳🇿",OM:"🇴🇲",PA:"🇵🇦",PE:"🇵🇪",PG:"🇵🇬",PH:"🇵🇭",PK:"🇵🇰",
  PL:"🇵🇱",PT:"🇵🇹",PW:"🇵🇼",PY:"🇵🇾",QA:"🇶🇦",RO:"🇷🇴",RS:"🇷🇸",RU:"🇷🇺",RW:"🇷🇼",SA:"🇸🇦",
  SB:"🇸🇧",SC:"🇸🇨",SD:"🇸🇩",SE:"🇸🇪",SG:"🇸🇬",SI:"🇸🇮",SK:"🇸🇰",SL:"🇸🇱",SM:"🇸🇲",SN:"🇸🇳",
  SO:"🇸🇴",SR:"🇸🇷",SS:"🇸🇸",ST:"🇸🇹",SV:"🇸🇻",SY:"🇸🇾",SZ:"🇸🇿",TD:"🇹🇩",TG:"🇹🇬",TH:"🇹🇭",
  TJ:"🇹🇯",TL:"🇹🇱",TM:"🇹🇲",TN:"🇹🇳",TO:"🇹🇴",TR:"🇹🇷",TT:"🇹🇹",TV:"🇹🇻",TW:"🇹🇼",TZ:"🇹🇿",
  UA:"🇺🇦",UG:"🇺🇬",US:"🇺🇸",UY:"🇺🇾",UZ:"🇺🇿",VC:"🇻🇨",VE:"🇻🇪",VN:"🇻🇳",VU:"🇻🇺",WS:"🇼🇸",
  YE:"🇾🇪",ZA:"🇿🇦",ZM:"🇿🇲",ZW:"🇿🇼",
};
function _flagEmoji(iso) {
  return _FLAG_EMOJI[(iso || "").toUpperCase()] || "";
}

async function showCountryCard(serverName, iso_a2) {
  const card = document.getElementById("homeCountryCard");
  card.classList.remove("hidden");
  card.innerHTML = `<div class="hcc-header"><span class="hcc-flag">${_flagEmoji(iso_a2)}</span><span class="hcc-name">${serverName}</span></div><div style="color:var(--c-muted);font-size:var(--fs-3)">Loading…</div>`;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });

  let data;
  try {
    data = await fetch(`${API}/country-summary?country=${encodeURIComponent(serverName)}${dateParams()}`).then(r => r.json());
  } catch {
    card.innerHTML += `<div style="color:var(--c-bad);font-size:var(--fs-3)">Failed to load country data.</div>`;
    return;
  }
  renderCountryCard(card, serverName, iso_a2, data);
}

function renderCountryCard(card, serverName, iso_a2, data) {
  const flag = _flagEmoji(iso_a2);

  card.innerHTML = `
    <div class="hcc-header">
      <span class="hcc-flag">${flag}</span>
      <span class="hcc-name">${serverName}</span>
    </div>
    <div class="hcc-stats">
      <div class="hcc-stat">
        <span class="hcc-stat-value">${fmtNum(data.n_users)}</span>
        <span class="hcc-stat-label">Participants</span>
      </div>
      <div class="hcc-stat">
        <span class="hcc-stat-value">${fmtNum(data.n_statements_total)}</span>
        <span class="hcc-stat-label">Statements rated</span>
      </div>
      <div class="hcc-stat">
        <span class="hcc-stat-value">${fmtNum(data.n_statements_qualified)}</span>
        <span class="hcc-stat-label">Statements rated ≥10×</span>
      </div>
    </div>
    <div class="hcc-links">
      <button class="hcc-link-btn" id="hccGoScores">Individual Scores &rarr;</button>
      <button class="hcc-link-btn" id="hccGoStmts">Statement Scores &rarr;</button>
    </div>`;

  document.getElementById("hccGoScores").addEventListener("click", () => {
    targetSelect.value = serverName;
    referenceSelect.value = serverName;
    scoresLoaded = true;
    switchToTab("scores", true);
    loadScores(serverName, serverName);
  });
  document.getElementById("hccGoStmts").addEventListener("click", () => {
    stmtScoresCountrySelect.value = serverName;
    switchToTab("stmtScores", true);
    loadStmtScores(serverName);
  });
}

function _positionTooltip(tooltip, clientX, clientY) {
  const W = window.innerWidth, H = window.innerHeight;
  const tw = tooltip.offsetWidth || 200;
  const th = tooltip.offsetHeight || 32;
  const x = clientX + 14 + tw > W ? clientX - tw - 10 : clientX + 14;
  const y = clientY - 28 < 0 ? clientY + 14 : clientY - 28 + th > H ? H - th - 4 : clientY - 28;
  tooltip.style.left = x + "px";
  tooltip.style.top  = y + "px";
}

async function loadHomeMap() {
  if (_homeCountryData) { await renderWorldMap(_homeCountryData); return; }
  try {
    // Counts within the global date filter (the dropdowns keep all-time counts)
    const countries = await fetch(`${API}/countries${dateParams().replace(/^&/, "?")}`).then(r => r.json());
    const data = {}, insuff = {};
    for (const { country, n_users } of countries) {
      if (n_users >= 10) data[country] = n_users;
      else insuff[country] = n_users;
    }
    _homeCountryData = { data, insuff };
    await renderWorldMap(_homeCountryData);
  } catch (err) {
    console.error("loadHomeMap failed:", err);
  }
}

// Participant-count shading for the Home map: one blue ramp over log-spaced
// bins (countries below the 10-participant threshold stay grey). The colours
// are the --c-ramp-* tokens, deeper with more people on the light theme and
// brighter on the dark one, so the map follows a theme change as it is.
const MAP_COUNT_BINS = [
  { min: 10,   color: "var(--c-ramp-1)" },
  { min: 30,   color: "var(--c-ramp-2)" },
  { min: 100,  color: "var(--c-ramp-3)" },
  { min: 300,  color: "var(--c-ramp-4)" },
  { min: 1000, color: "var(--c-ramp-5)" },
  { min: 3000, color: "var(--c-ramp-6)" },
];
function _mapCountColor(n) {
  let color = MAP_COUNT_BINS[0].color;
  for (const b of MAP_COUNT_BINS) if (n >= b.min) color = b.color;
  return color;
}

// Olympic-ring-inspired continent colors (pastel via rgba; --c-cont-*)
const CONTINENT_COLORS = {
  "Africa":        "var(--c-cont-africa)",    // gold/yellow
  "Asia":          "var(--c-cont-asia)",      // red
  "Europe":        "var(--c-cont-europe)",    // blue
  "North America": "var(--c-cont-namerica)",  // green
  "South America": "var(--c-cont-samerica)",  // orange
  "Oceania":       "var(--c-cont-oceania)",   // purple
};

const MAP_CROP_H = 412; // world-countries.json is 960 × 484

async function renderWorldMap({ data, insuff } = {}) {
  data   = data   || {};
  insuff = insuff || {};

  const svg     = document.getElementById("worldMapSvg");
  const tooltip = document.getElementById("worldMapTooltip");
  const countEl = document.getElementById("worldMapCount");

  if (!_worldMapGeo) {
    try {
      _worldMapGeo = await fetch(`${MOUNT_PATH}static/world-countries.json`).then(r => r.json());
      // Antarctica has no participants and fills the bottom eighth of the
      // map, so it is left out and the frame cropped just below the southern
      // tip of South America (every other country lies above y = 407)
      _worldMapGeo.countries = _worldMapGeo.countries.filter((c) => c.name !== "Antarctica");
      svg.setAttribute("viewBox", `0 0 ${_worldMapGeo.width} ${Math.min(_worldMapGeo.height, MAP_CROP_H)}`);
    } catch (err) {
      console.error("renderWorldMap: geo JSON fetch failed:", err);
      throw err;
    }
  }

  // Build lookups: naturalearth name -> {n, serverName}
  const lookup = {}, insuffLookup = {};
  for (const [serverName, n] of Object.entries(data)) {
    lookup[_normCountry(serverName)] = { n, serverName };
  }
  for (const [serverName, n] of Object.entries(insuff)) {
    insuffLookup[_normCountry(serverName)] = { n, serverName };
  }

  svg.innerHTML = "";
  const pathByServerName = {};
  const fillByServerName = {};

  // Separate qualifying from non-qualifying so qualifying paths are appended last
  // (SVG z-order = document order: last = on top). Without this, grey paths drawn
  // after a colored country would intercept clicks intended for it.
  const nonQualifying = [];
  const qualifying    = [];
  for (const c of _worldMapGeo.countries) {
    const entry = lookup[c.name]       || lookup[c.name_en];
    const ins   = insuffLookup[c.name] || insuffLookup[c.name_en];
    if (entry) qualifying.push({ c, entry });
    else       nonQualifying.push({ c, ins });
  }

  function _mkPath(d, fill, cursor) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", fill);
    p.style.cursor = cursor;
    return p;
  }

  const byCount = _homeMapMode === "count";
  // Grey (non-qualifying) layer — drawn first, behind qualifying paths
  for (const { c, ins } of nonQualifying) {
    const path = _mkPath(c.d, byCount ? "var(--c-line)" : "var(--c-line-2)", "default");
    path.addEventListener("mousemove", (e) => {
      tooltip.hidden = false;
      const name = ins ? ins.serverName : c.name;
      tooltip.innerHTML = ins
        ? `<strong>${name}</strong><br>${fmtNum(ins.n)} participant${ins.n !== 1 ? "s" : ""} (need ≥ 10)`
        : `<strong>${name}</strong><br>No participants`;
      requestAnimationFrame(() => _positionTooltip(tooltip, e.clientX, e.clientY));
    });
    path.addEventListener("mouseleave", () => { tooltip.hidden = true; });
    svg.appendChild(path);
  }

  // Colored (qualifying) layer — drawn on top so clicks always land here
  for (const { c, entry } of qualifying) {
    const color = byCount ? _mapCountColor(entry.n) : (CONTINENT_COLORS[c.continent] || "var(--c-line-2)");
    const path = _mkPath(c.d, color, "pointer");
    pathByServerName[entry.serverName] = path;
    fillByServerName[entry.serverName] = color;

    path.addEventListener("click", () => {
      if (_selectedHomeCountry && pathByServerName[_selectedHomeCountry]) {
        pathByServerName[_selectedHomeCountry].setAttribute("fill", fillByServerName[_selectedHomeCountry]);
        pathByServerName[_selectedHomeCountry].removeAttribute("stroke");
        pathByServerName[_selectedHomeCountry].removeAttribute("stroke-width");
      }
      _selectedHomeCountry = entry.serverName;
      path.setAttribute("stroke", "var(--c-text)");
      path.setAttribute("stroke-width", "1.5");
      tooltip.hidden = true;
      showCountryCard(entry.serverName, c.iso_a2 || "");
    });
    path.addEventListener("mousemove", (e) => {
      tooltip.hidden = false;
      tooltip.innerHTML = `<strong>${entry.serverName}</strong><br>${fmtNum(entry.n)} participants · click for details`;
      requestAnimationFrame(() => _positionTooltip(tooltip, e.clientX, e.clientY));
    });
    path.addEventListener("mouseleave", () => { tooltip.hidden = true; });
    svg.appendChild(path);
  }

  if (countEl) countEl.textContent = `${fmtNum(Object.keys(lookup).length)} countries`;

  // Keep the selected country outlined when the map is redrawn (mode toggle)
  if (_selectedHomeCountry && pathByServerName[_selectedHomeCountry]) {
    pathByServerName[_selectedHomeCountry].setAttribute("stroke", "var(--c-text)");
    pathByServerName[_selectedHomeCountry].setAttribute("stroke-width", "1.5");
  }

  // Render legend: participant bins as one stepped ramp, each step labelled
  // with its lower bound (it fits one line, on phones too), or continents
  const legend = document.getElementById("worldMapLegend");
  if (legend) {
    if (byCount) {
      legend.innerHTML =
        `<span class="world-map-legend-item">Participants</span>` +
        `<span class="wm-steps">` +
        MAP_COUNT_BINS.map((b, i) => {
          const next = MAP_COUNT_BINS[i + 1];
          const range = next ? `${fmtNum(b.min)}–${fmtNum(next.min - 1)}` : `${fmtNum(b.min)} or more`;
          return `<span class="wm-step" title="${range} participants"><i style="background:${b.color}"></i>${fmtNum(b.min)}${next ? "" : "+"}</span>`;
        }).join("") +
        `</span>`;
    } else {
      legend.innerHTML = Object.entries(CONTINENT_COLORS)
        .map(([cont, color]) => `<span class="world-map-legend-item"><span class="world-map-legend-swatch" style="background:${color}"></span>${cont}</span>`)
        .join("");
    }
  }
}


// Score histograms use a 0–100 linear x axis, so the 0%, 20%, … 100% labels
// sit on bin edges (not under a bar's centre) and every bar is drawn at its
// bin's centre. Click handlers map a click's x position to a bin, which the
// 0–100 axis keeps exact.
function histPoints(counts, edges) {
  return counts.map((c, i) => ({ x: ((edges[i] + edges[i + 1]) / 2) * 100, y: c }));
}
function histXScale(title) {
  return {
    type: "linear",
    min: 0,
    max: 100,
    offset: false,
    title: { display: true, text: title, font: CHART_FONT.title },
    grid: { display: false },
    ticks: { font: CHART_FONT.tick, stepSize: 20, maxRotation: 0, callback: (v) => `${v}%` },
  };
}

// A vertical marker on the Individual Scores histogram: the median of the
// participants shown (set by loadScores())
let histMedian = null; // 0–1 share, or null
const histMarkerPlugin = {
  id: "histMedian",
  afterDatasetsDraw(chart) {
    if (histMedian == null) return;
    const { ctx, chartArea: { top, bottom, left, right }, scales: { x } } = chart;
    const px = x.getPixelForValue(histMedian * 100);
    const label = `Median ${fmtPct(histMedian)}`;
    ctx.save();
    ctx.strokeStyle = UI.muted;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, top - 14);
    ctx.lineTo(px, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = UI.body;
    ctx.font = chartCanvasFont(600);
    ctx.textBaseline = "bottom";
    const w = ctx.measureText(label).width;
    ctx.fillText(label, Math.max(left, Math.min(right - w, px + 5)), top - 4);
    ctx.restore();
  },
};

function renderHistogram({ counts, bin_edges }) {
  histBinEdges = bin_edges;
  const histData = histPoints(counts, bin_edges);
  const colors = getBarColors();

  if (histChart) {
    histChart.data.datasets[0].data = histData;
    histChart.data.datasets[0].backgroundColor = colors;
    histChart.update();
    return;
  }

  const ctx = document.getElementById("histChart").getContext("2d");
  histChart = new Chart(ctx, {
    type: "bar",
    plugins: [histMarkerPlugin],
    data: {
      datasets: [
        {
          data: histData,
          backgroundColor: colors,
          borderWidth: 0,
          borderRadius: 3,
          minBarLength: 4,
        },
      ],
    },
    options: {
      layout: { padding: { top: 18 } }, // room for the median label
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: 1.0,
      barPercentage: 0.9,
      onClick: (evt, _elements, chart) => {
        const { left, right } = chart.scales.x;
        const { top, bottom } = chart.chartArea;
        if (evt.x < left || evt.x > right || evt.y < top || evt.y > bottom)
          return;
        const nBins = histBinEdges.length - 1;
        if (!nBins) return;
        const idx = Math.min(
          nBins - 1,
          Math.floor(((evt.x - left) / (right - left)) * nBins),
        );
        activeBinIdx = idx !== activeBinIdx ? idx : null;
        updateBarColors();
        buildScoresRows();
        renderScoresPage();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              return `Score: ${fmtPct(histBinEdges[i])} – ${fmtPct(histBinEdges[i + 1])}`;
            },
            label: (item) =>
              `${fmtNum(item.raw.y)} participant${item.raw.y !== 1 ? "s" : ""}`,
          },
        },
      },
      scales: {
        x: histXScale("Commonsensicality score"),
        y: {
          title: { display: true, text: "Participants", font: CHART_FONT.title },
          beginAtZero: true,
          grid: { color: UI.grid },
          ticks: { precision: 0, font: CHART_FONT.tick },
        },
      },
    },
  });
}

// ── Scores: load ───────────────────────────────────────────────────────────

async function loadScores(target, reference) {
  scoresSpinnerEl.classList.remove("hidden");
  scoresFilterLabel.textContent = "";
  scoresPageInfoEl.textContent = "";
  btnScoresPrev.disabled = true;
  btnScoresNext.disabled = true;
  scoresBody.innerHTML =
    '<tr><td colspan="8" class="empty-row">Computing scores…</td></tr>';

  // Reset view state
  activeBinIdx = null;
  scoresSearchQuery = "";
  document.getElementById("scoresSearch").value = "";
  sortKey = "n_statements";
  sortDir = "desc";
  updateSortHeaders();

  let data;
  try {
    const url = `${API}/scores?target=${encodeURIComponent(target)}&reference=${encodeURIComponent(reference)}${dateParams()}`;
    data = await fetch(url).then((r) => r.json());
  } catch {
    scoresBody.innerHTML =
      '<tr><td colspan="8" class="empty-row">Failed to compute scores.</td></tr>';
    scoresSpinnerEl.classList.add("hidden");
    return;
  }

  scoresSpinnerEl.classList.add("hidden");

  if (!data.users) {
    scoresBody.innerHTML = `<tr><td colspan="8" class="empty-row">Server error: ${esc(data.error || "unexpected response")}. Restart the server and try again.</td></tr>`;
    return;
  }

  allScoresRows = data.users;
  allScoresExcluded = data.users_excluded || [];
  notifyIntro("scores", data, { target, reference });

  const tLabel = target === "all" ? "all countries" : target;
  const rLabel = reference === "all" ? "all countries" : reference;

  // Who has no score, and why; the majority ignores the date filter
  const noteEl = document.getElementById("scoresMinRatingsNote");
  const dateNote = globalDateFrom || globalDateTo
    ? ` Majorities use ratings from all dates; the date filter only picks which participants are shown.`
    : "";
  if (data.raw_n_users != null && data.n_users < data.raw_n_users) {
    const nOut = data.raw_n_users - data.n_users;
    noteEl.innerHTML =
      `<strong>${fmtNum(data.n_users)}</strong> of ${fmtNum(data.raw_n_users)} participants` +
      `${target === "all" ? "" : ` from ${esc(target)}`} have a score. ` +
      `The other ${fmtNum(nOut)} rated fewer than 5 statements that count (10+ ratings ` +
      `${reference === "all" ? "overall" : `in ${esc(reference)}`}) and are listed last, unscored.` + dateNote;
    noteEl.classList.remove("hidden");
  } else if (dateNote) {
    noteEl.innerHTML = dateNote.trim();
    noteEl.classList.remove("hidden");
  } else {
    noteEl.classList.add("hidden");
  }

  if (allScoresRows.length === 0) {
    scoresBody.innerHTML =
      '<tr><td colspan="8" class="empty-row">No participants have a score here: none rated at least 5 statements with 10 or more ratings in the chosen majority group.</td></tr>';
    return;
  }

  const sortedScores = allScoresRows.map((u) => u.commonsensicality).sort((a, b) => a - b);
  const nS = sortedScores.length;
  histMedian = nS ? (nS % 2 ? sortedScores[(nS - 1) / 2] : (sortedScores[nS / 2 - 1] + sortedScores[nS / 2]) / 2) : null;
  buildScoresRows();
  renderHistogram(data.histogram);
  renderScoresPage();
}

// ── Statement Scores tab ───────────────────────────────────────────────────

function stmtScoresTotalPages() {
  return Math.max(1, Math.ceil(stmtScoresRows.length / PAGE_SIZE));
}

// Quick views on Statement Scores: each sets the table's sort (and, for
// "rejected", keeps only statements most raters disagree with) among
// statements with enough ratings that their shares are stable. Clicking a
// column header returns to every statement with that sort.
const STMT_LENSES = {
  shared: {
    sort: ["commonsensicality", "desc"],
    note: "Highest scores first: nearly everyone gives the same answer and expects others to.",
  },
  divisive: {
    sort: ["consensus", "asc"],
    note: "Closest to an even split first, so consensus is near 0. Whichever way people answer, about half disagree with them.",
  },
  misjudged: {
    sort: ["awareness", "asc"],
    // a clear majority (at least 60–40), so there is a majority to misjudge
    keep: (r) => r.consensus >= 0.2,
    note: "Lowest awareness first, among statements with a clear majority (at least 60–40). Below 50% awareness, more raters expected the opposite of the majority's answer than expected that answer.",
  },
  rejected: {
    sort: ["commonsensicality", "desc"],
    keep: (r) => r.I_agree_mean < 0.5,
    note: "Statements most raters disagree with, highest scores first: a shared rejection that people expect is common sense too.",
  },
};

// The lens's minimum number of ratings: 100 when that leaves at least 50
// statements in the current group and dates, else 30, else the scoring
// minimum of 10
function stmtLensMinRatings() {
  for (const n of [100, 30]) {
    if (stmtScoresAllRows.filter((r) => r.n_ratings >= n).length >= 50) return n;
  }
  return 10;
}

function setStmtLens(lens) {
  stmtScoresLens = lens && STMT_LENSES[lens] ? lens : "";
  if (stmtScoresLens) [stmtScoresSortKey, stmtScoresSortDir] = STMT_LENSES[stmtScoresLens].sort;
  document.querySelectorAll("#ssLenses .lens-btn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.lens === stmtScoresLens)),
  );
  const note = document.getElementById("ssLensNote");
  if (stmtScoresLens) {
    const min = stmtLensMinRatings();
    note.innerHTML = `${esc(STMT_LENSES[stmtScoresLens].note)} ` + (min >= 30
      ? `Only statements with at least <strong>${min}</strong> ratings, so a share isn't swayed by a few raters.`
      : `Statements with at least <strong>${min}</strong> ratings: too few have more in this group, so shares from few raters can be noisy.`);
  }
  note.hidden = !stmtScoresLens;
}

document.getElementById("ssLenses").addEventListener("click", (e) => {
  const b = e.target.closest(".lens-btn");
  if (!b) return;
  setStmtLens(b.dataset.lens);
  buildStmtScoresRows();
  updateStmtScoresSortHeaders();
  renderStmtScoresPage();
});

function buildStmtScoresRows() {
  const nBins = stmtScoresHistBinEdges.length - 1;
  let rows =
    stmtScoresActiveBinIdx === null
      ? [...stmtScoresAllRows]
      : stmtScoresAllRows.filter((r) => {
          const lo = stmtScoresHistBinEdges[stmtScoresActiveBinIdx];
          const hi = stmtScoresHistBinEdges[stmtScoresActiveBinIdx + 1];
          const isLast = stmtScoresActiveBinIdx === nBins - 1;
          return (
            r.commonsensicality >= lo &&
            (isLast ? r.commonsensicality <= hi : r.commonsensicality < hi)
          );
        });

  const lens = STMT_LENSES[stmtScoresLens];
  if (lens) {
    const min = stmtLensMinRatings();
    rows = rows.filter((r) => r.n_ratings >= min && (!lens.keep || lens.keep(r)));
  }

  if (stmtScoresSortKey !== null) {
    rows.sort((a, b) => {
      const d = a[stmtScoresSortKey] - b[stmtScoresSortKey];
      // ties: most-rated first
      return (stmtScoresSortDir === "asc" ? d : -d) || b.n_ratings - a.n_ratings;
    });
  }
  let ssFiltered = applyPropFilters(rows, ssPropFilters);
  const ssq = stmtScoresSearchQuery.trim().toLowerCase();
  if (ssq)
    ssFiltered = ssFiltered.filter((r) =>
      r.statement.toLowerCase().includes(ssq),
    );

  // Append excluded statements (only when no histogram bin or quick view is selected)
  let ssExcluded = [];
  if (stmtScoresActiveBinIdx === null && !lens) {
    ssExcluded = stmtScoresAllExcluded.map(r => ({ ...r, _excluded: true }));
    ssExcluded = applyPropFilters(ssExcluded, ssPropFilters);
    if (ssq) ssExcluded = ssExcluded.filter(r => r.statement.toLowerCase().includes(ssq));
    ssExcluded.sort((a, b) => b.n_ratings - a.n_ratings);
  }

  stmtScoresRows = [...ssFiltered, ...ssExcluded];
  stmtScoresPage = 1;
}

function updateStmtScoresSortHeaders() {
  document
    .querySelectorAll("#stmtScoresTable thead th.sortable")
    .forEach((th) => {
      const icon = th.querySelector(".sort-icon");
      const isActive =
        stmtScoresSortKey !== null && th.dataset.sort === stmtScoresSortKey;
      th.classList.toggle("sort-active", isActive);
      icon.textContent = isActive
        ? stmtScoresSortDir === "asc"
          ? "▲"
          : "▼"
        : "";
    });
}

function getStmtScoresBarColors() {
  const n = Math.max(stmtScoresHistBinEdges.length - 1, 20);
  return Array.from({ length: n }, (_, i) => {
    if (stmtScoresActiveBinIdx === null) return UI.agree;
    return i === stmtScoresActiveBinIdx ? UI.agreeInk : UI.agreeSoft;
  });
}

function updateStmtScoresBarColors() {
  if (!stmtScoresHistChart) return;
  stmtScoresHistChart.data.datasets[0].backgroundColor =
    getStmtScoresBarColors();
  stmtScoresHistChart.update("none");
}

function renderStmtScoresPage(preserveScroll = false) {
  const start = (stmtScoresPage - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();

  const qualifyingBeforeStmt = stmtScoresRows.slice(0, start).filter(r => !r._excluded).length;
  let qualRankStmt = qualifyingBeforeStmt + 1;

  stmtScoresRows.slice(start, start + PAGE_SIZE).forEach((row) => {
    const tr = document.createElement("tr");
    const stmt = fixStatement(row.statement);
    if (row._excluded) {
      tr.classList.add("row-excluded");
      tr.innerHTML =
        `<td class="td-rank td-dim">—</td>` +
        `<td class="td-statement" title="${esc(stmt)}">${esc(stmt)}</td>` +
        `<td class="td-num">${fmtNum(row.n_ratings)}</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-dim">—</td>` +
        `<td class="td-dim">—</td>`;
    } else {
      tr.innerHTML =
        `<td class="td-rank">${fmtNum(qualRankStmt++)}</td>` +
        `<td class="td-statement" title="${esc(stmt)}">${esc(stmt)}</td>` +
        `<td class="td-num">${fmtNum(row.n_ratings)}</td>` +
        `<td>${pctBar(row.I_agree_mean)}</td>` +
        `<td>${pctBar(row.others_agree_mean)}</td>` +
        `<td>${pctBarScore(row.consensus)}</td>` +
        `<td>${pctBarScore(row.awareness)}</td>` +
        `<td>${pctBarScore(row.commonsensicality)}</td>`;
    }
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openStmtCombined(row));
    fragment.appendChild(tr);
  });

  stmtScoresBody.innerHTML = "";
  stmtScoresBody.appendChild(fragment);
  if (!preserveScroll) revealTableTop(stmtScoresPageInfoEl.closest(".table-nav-row"));

  if (stmtScoresLens && stmtScoresActiveBinIdx === null) {
    const label = document.querySelector(`#ssLenses .lens-btn[data-lens="${stmtScoresLens}"]`).textContent;
    stmtScoresFilterLabel.textContent = stmtScoresRows.length
      ? `${label}: ${fmtNum(stmtScoresRows.length)} statement${stmtScoresRows.length !== 1 ? "s" : ""}`
      : "No statements match.";
  } else if (stmtScoresActiveBinIdx === null) {
    const nUnscored = stmtScoresRows.filter((r) => r._excluded).length;
    const nScored = stmtScoresRows.length - nUnscored;
    stmtScoresFilterLabel.textContent = !stmtScoresRows.length
      ? "No statements match."
      : `${fmtNum(nScored)} scored statement${nScored !== 1 ? "s" : ""}` +
        (nUnscored ? `, then ${fmtNum(nUnscored)} not yet scored (fewer than 10 ratings)` : "");
  } else {
    const lo = fmtPct(stmtScoresHistBinEdges[stmtScoresActiveBinIdx]);
    const hi = fmtPct(stmtScoresHistBinEdges[stmtScoresActiveBinIdx + 1]);
    stmtScoresFilterLabel.textContent = `Showing scores ${lo} – ${hi}: ${fmtNum(stmtScoresRows.length)} statements · click the bar again to show all`;
  }

  const tp = stmtScoresTotalPages();
  stmtScoresPageInfoEl.textContent = `Page ${fmtNum(stmtScoresPage)} of ${fmtNum(tp)}`;
  btnStmtScoresPrev.disabled = stmtScoresPage <= 1;
  btnStmtScoresNext.disabled = stmtScoresPage >= tp;
}

function renderStmtScoresHistogram({ counts, bin_edges }) {
  stmtScoresHistBinEdges = bin_edges;
  const histData = histPoints(counts, bin_edges);
  const colors = getStmtScoresBarColors();

  if (stmtScoresHistChart) {
    stmtScoresHistChart.data.datasets[0].data = histData;
    stmtScoresHistChart.data.datasets[0].backgroundColor = colors;
    stmtScoresHistChart.update();
    return;
  }

  const ctx = document.getElementById("stmtScoresHistChart").getContext("2d");
  stmtScoresHistChart = new Chart(ctx, {
    type: "bar",
    data: {
      datasets: [
        {
          data: histData,
          backgroundColor: colors,
          borderWidth: 0,
          borderRadius: 3,
          minBarLength: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: 1.0,
      barPercentage: 0.9,
      onClick: (evt, _elements, chart) => {
        const { left, right } = chart.scales.x;
        const { top, bottom } = chart.chartArea;
        if (evt.x < left || evt.x > right || evt.y < top || evt.y > bottom)
          return;
        const nBins = stmtScoresHistBinEdges.length - 1;
        if (!nBins) return;
        const idx = Math.min(
          nBins - 1,
          Math.floor(((evt.x - left) / (right - left)) * nBins),
        );
        stmtScoresActiveBinIdx = idx !== stmtScoresActiveBinIdx ? idx : null;
        updateStmtScoresBarColors();
        buildStmtScoresRows();
        renderStmtScoresPage();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              return `Score: ${fmtPct(stmtScoresHistBinEdges[i])} – ${fmtPct(stmtScoresHistBinEdges[i + 1])}`;
            },
            label: (item) =>
              `${fmtNum(item.raw.y)} statement${item.raw.y !== 1 ? "s" : ""}`,
          },
        },
      },
      scales: {
        x: histXScale("Commonsensicality score"),
        y: {
          title: { display: true, text: "Statements", font: CHART_FONT.title },
          beginAtZero: true,
          grid: { color: UI.grid },
          ticks: { precision: 0, font: CHART_FONT.tick },
        },
      },
    },
  });
}

// The statement modal: its score in the group chosen in Statement Scores,
// how each country answered, and its six features
async function openStmtCombined(row) {
  const country = stmtScoresCountrySelect.value;
  const groupLabel = country === "all" ? "all countries" : country;
  document.getElementById("stmtPropsText").textContent = fixStatement(
    row.statement,
  );
  document.getElementById("stmtPropsBody").innerHTML =
    '<p style="color:var(--c-muted);padding:12px 0">Loading…</p>';
  showStmtMeta(document.getElementById("stmtPropsMeta"), row.statementId);
  stmtPropsModal.classList.remove("hidden");
  const reqId = ++stmtCountriesReq;

  let countriesHtml = "";
  try {
    const countries = await fetch(
      `${API}/statement-countries?statementId=${encodeURIComponent(row.statementId)}${dateParams()}`,
    ).then((r) => r.json());
    if (Array.isArray(countries) && countries.length) countriesHtml = stmtCountriesHtml(countries, country);
  } catch (_) {}
  if (reqId !== stmtCountriesReq) return; // another statement was opened meanwhile

  // Score first, then how each country answered, then the six features
  const scoreHtml = row._excluded
    ? `<p class="expl-context">${notEnoughRatingsHtml(row.n_ratings, groupLabel)}</p>`
    : stmtCalcHtml(row, groupLabel);
  const body = document.getElementById("stmtPropsBody");
  body.innerHTML =
    `<div class="stmt-combined-section"><div class="stmt-combined-section-title">Commonsensicality score</div>${scoreHtml}</div>` +
    countriesHtml +
    `<div class="stmt-combined-section"><div class="stmt-combined-section-title">Statement features</div><ul class="prop-detail-list">${stmtPropItemsHtml(row)}</ul></div>`;
  const more = body.querySelector(".sc-more");
  if (more) more.addEventListener("click", () => {
    body.querySelectorAll(".sc-row.is-extra").forEach((tr) => tr.classList.remove("is-extra"));
    more.remove();
  });
}
let stmtCountriesReq = 0;

// How each country's participants answered one statement (from
// /api/statement-countries): the share who agree, with a tick at 50%, and the
// country's own score once it has at least 10 ratings. A sentence on top says
// whether the majorities point the same way, which the scores alone don't.
const SC_SHOW = 8;
function stmtCountriesHtml(countries, current) {
  const scored = countries.filter((c) => c.score !== undefined && c.score !== null);
  const nAgree = scored.filter((c) => c.maj === 1).length;
  const nDis = scored.length - nAgree;
  const nCountries = (n) => `${fmtNum(n)} ${n === 1 ? "country" : "countries"}`;
  let summary;
  if (!scored.length) {
    summary = `No country has rated it 10 times yet, so there are no country scores. Shares from fewer than 10 ratings are shown in grey.`;
  } else if (scored.length === 1) {
    summary = `Only <strong>${esc(scored[0].country)}</strong> has rated it at least 10 times; its majority ${scored[0].maj ? "agrees" : "disagrees"}.`;
  } else if (!nAgree || !nDis) {
    summary = `The majority ${nAgree ? "agrees" : "disagrees"} in all <strong>${fmtNum(scored.length)}</strong> countries with at least 10 ratings.`;
  } else {
    summary = `<strong>Majorities differ:</strong> the majority agrees in ${nCountries(nAgree)} and disagrees in ${nCountries(nDis)}, of the ${fmtNum(scored.length)} with at least 10 ratings. A small country's share can be noisy.`;
  }
  // Countries with 10+ ratings first (most ratings first), then the rest
  const order = [...scored, ...countries.filter((c) => c.score === undefined || c.score === null)];
  const rows = order.map((c, i) => {
    const ok = c.score !== undefined && c.score !== null;
    const p = c.I_agree_mean;
    const cls = `sc-row${ok ? "" : " is-thin"}${c.country === current ? " is-current" : ""}${i >= SC_SHOW ? " is-extra" : ""}`;
    return (
      `<tr class="${cls}">` +
      `<td class="sc-country">${countryFlag(c.country) ? countryFlag(c.country) + " " : ""}${esc(c.country)}</td>` +
      `<td class="sc-n">${fmtNum(c.n_ratings)}</td>` +
      `<td class="sc-agree"><span class="sc-bar"><span class="sc-fill${p < 0.5 ? " is-low" : ""}" style="width:${(p * 100).toFixed(1)}%"></span></span>` +
        `<span class="sc-val">${(p * 100).toFixed(0)}%</span></td>` +
      `<td class="sc-maj">${ok ? (c.maj ? "Agrees" : "Disagrees") : "—"}</td>` +
      `<td class="sc-score">${ok ? (c.score * 100).toFixed(1) : "—"}</td>` +
      `</tr>`
    );
  }).join("");
  const extra = order.length - SC_SHOW;
  return (
    `<div class="stmt-combined-section"><div class="stmt-combined-section-title">How each country answered</div>` +
    `<p class="sc-summary">${summary}</p>` +
    `<div class="sc-wrap"><table class="sc-table"><thead><tr><th>Country</th><th class="sc-n">Ratings</th><th class="sc-agree">Share who agree</th><th class="sc-maj">Majority</th><th class="sc-score" title="The statement's commonsensicality among that country's participants (10+ ratings)">Score</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>` +
    (extra > 0 ? `<button type="button" class="sc-more">Show all ${fmtNum(order.length)} countries</button>` : "") +
    `</div>`
  );
}

// Property definitions section of the Statement Scores modal
function stmtPropItemsHtml(row) {
  return PROP_DEFS.map(({ key, v1, v0, def1, def0 }) => {
    const val = row[key];
    if (val === null || val === undefined)
      return `<li class="prop-detail-item prop-detail-unknown"><span class="prop-detail-category">${esc(v1)} / ${esc(v0)}</span><span class="prop-detail-desc">—</span></li>`;
    const label = val === 1 ? v1 : v0;
    const def = val === 1 ? def1 : def0;
    const contrastLabel = val === 1 ? v0 : v1;
    const contrastDef = val === 1 ? def0 : def1;
    return (
      `<li class="prop-detail-item">` +
      `<span class="prop-detail-category">${esc(v1)} / ${esc(v0)}</span>` +
      `<span class="prop-detail-desc">This statement is an example of <strong>${esc(label)}</strong>: ${esc(def)}</span>` +
      `<span class="prop-detail-contrast">(This is in contrast to <strong>${esc(contrastLabel)}</strong>: ${esc(contrastDef)})</span>` +
      `</li>`
    );
  }).join("");
}

async function loadStmtScores(country) {
  stmtScoresSpinnerEl.classList.remove("hidden");
  stmtScoresSummaryEl.textContent = "Computing…";
  stmtScoresFilterLabel.textContent = "";
  stmtScoresPageInfoEl.textContent = "";
  btnStmtScoresPrev.disabled = true;
  btnStmtScoresNext.disabled = true;
  stmtScoresBody.innerHTML =
    '<tr><td colspan="6" class="empty-row">Computing scores…</td></tr>';

  stmtScoresActiveBinIdx = null;
  stmtScoresSortKey = "n_ratings";
  stmtScoresSortDir = "desc";
  setStmtLens("");
  updateStmtScoresSortHeaders();

  let data;
  try {
    data = await fetch(
      `${API}/statement-scores?country=${encodeURIComponent(country)}${dateParams()}`,
    ).then((r) => r.json());
  } catch {
    stmtScoresBody.innerHTML =
      '<tr><td colspan="6" class="empty-row">Failed to compute scores.</td></tr>';
    stmtScoresSummaryEl.textContent = "";
    stmtScoresSpinnerEl.classList.add("hidden");
    return;
  }

  stmtScoresSpinnerEl.classList.add("hidden");

  if (!data.rows) {
    stmtScoresBody.innerHTML = `<tr><td colspan="6" class="empty-row">Server error: ${esc(data.error || "unexpected response")}. Restart the server and try again.</td></tr>`;
    stmtScoresSummaryEl.textContent = "";
    return;
  }

  stmtScoresAllRows = data.rows;
  stmtScoresAllExcluded = data.rows_excluded || [];
  notifyIntro("stmtScores", data, { country });

  stmtScoresSummaryEl.textContent = `${fmtNum(data.n_statements)} statements scored from ${fmtNum(data.n_users)} participants`;

  if (!stmtScoresAllRows.length) {
    stmtScoresBody.innerHTML =
      '<tr><td colspan="6" class="empty-row">No statements met the minimum criteria.</td></tr>';
    return;
  }

  buildStmtScoresRows();
  renderStmtScoresHistogram(data.histogram);
  renderStmtScoresPage();
}

// ── Init ───────────────────────────────────────────────────────────────────


btnScoresPrev.addEventListener("click", () => {
  if (scoresPage > 1) {
    scoresPage--;
    renderScoresPage();
  }
});
btnScoresNext.addEventListener("click", () => {
  if (scoresPage < scoresTotalPages()) {
    scoresPage++;
    renderScoresPage();
  }
});

document.querySelectorAll("#scoresTable thead th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "desc";
    }
    buildScoresRows();
    updateSortHeaders();
    renderScoresPage();
  });
});

targetSelect.addEventListener("change", () => {
  referenceSelect.value = targetSelect.value;
  loadScores(targetSelect.value, referenceSelect.value);
});
referenceSelect.addEventListener("change", () => {
  loadScores(targetSelect.value, referenceSelect.value);
});
stmtScoresCountrySelect.addEventListener("change", (e) =>
  loadStmtScores(e.target.value),
);
dpCountrySelect.addEventListener("change", (e) => {
  document.getElementById("dpDetailCard").classList.add("hidden");
  document
    .querySelectorAll("#dpTableContainer .dp-selected")
    .forEach((r) => r.classList.remove("dp-selected"));
  loadDesignPoints(e.target.value);
});

btnStmtScoresPrev.addEventListener("click", () => {
  if (stmtScoresPage > 1) {
    stmtScoresPage--;
    renderStmtScoresPage();
  }
});
btnStmtScoresNext.addEventListener("click", () => {
  if (stmtScoresPage < stmtScoresTotalPages()) {
    stmtScoresPage++;
    renderStmtScoresPage();
  }
});

document
  .querySelectorAll("#stmtScoresTable thead th.sortable")
  .forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (stmtScoresSortKey === key) {
        stmtScoresSortDir = stmtScoresSortDir === "asc" ? "desc" : "asc";
      } else {
        stmtScoresSortKey = key;
        stmtScoresSortDir = "desc";
      }
      if (stmtScoresLens) setStmtLens(""); // a header sort shows every statement again
      buildStmtScoresRows();
      updateStmtScoresSortHeaders();
      renderStmtScoresPage();
    });
  });

// ── Design-point forest plot ───────────────────────────────────────────────

function dpX(v) {
  return (DP_PAD + v * DP_PW).toFixed(1);
}

// Sets DP_W from the table container's width; true when it changed
function dpFitWidth() {
  const box = document.getElementById("dpTableContainer");
  const avail = box ? box.clientWidth : 0;
  if (!avail) return false; // hidden panel: keep the last width
  const w = Math.round(Math.max(DP_W_MIN, Math.min(DP_W_MAX, avail - DP_FIXED_W)));
  if (Math.abs(w - DP_W) < 2) return false;
  DP_W = w;
  DP_PW = DP_W - DP_PAD * 2;
  return true;
}

// Redraws the forest plot when its container's width changes (a resize, or
// the panel becoming visible after drawing while hidden), keeping the row
// that is selected
let _dpLastRows = null;
if ("ResizeObserver" in window) {
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!_dpLastRows || !dpFitWidth()) return;
      const sel = document.querySelector("#dpTableContainer tr.dp-selected");
      const key = sel ? DP_PROPS.map((p) => sel.dataset[p.key]).join("") : null;
      renderDesignPoints(_dpLastRows[0], _dpLastRows[1]);
      if (key === null) return;
      document.querySelectorAll("#dpTableContainer tr.dp-clickable").forEach((tr) => {
        if (DP_PROPS.map((p) => tr.dataset[p.key]).join("") === key) tr.classList.add("dp-selected");
      });
    });
  }).observe(document.getElementById("dpTableContainer"));
}

function dpCiSvg(mean, ci_lo, ci_hi) {
  if (mean === null) return "";
  const cy = (DP_H / 2).toFixed(1);
  const lo = ci_lo !== null ? ci_lo : mean;
  const hi = ci_hi !== null ? ci_hi : mean;
  const grids = [0, 0.2, 0.4, 0.6, 0.8, 1.0]
    .map(
      (v) =>
        `<line x1="${dpX(v)}" y1="2" x2="${dpX(v)}" y2="${DP_H - 2}" stroke="var(--c-line-2)" stroke-width="1"/>`,
    )
    .join("");
  return (
    `<svg width="${DP_W}" height="${DP_H}" style="display:block">` +
    grids +
    `<line x1="${dpX(lo)}" y1="${cy}" x2="${dpX(hi)}" y2="${cy}" stroke="var(--c-body)" stroke-width="2.5" stroke-linecap="round"/>` +
    `<circle cx="${dpX(mean)}" cy="${cy}" r="5" fill="var(--c-text)"/>` +
    `</svg>`
  );
}

function dpAxisSvg() {
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const lbls = ["0%", "20%", "40%", "60%", "80%", "100%"];
  const lines = ticks
    .map(
      (v) =>
        `<line x1="${dpX(v)}" y1="0" x2="${dpX(v)}" y2="6" stroke="var(--c-muted)" stroke-width="1"/>`,
    )
    .join("");
  const texts = ticks
    .map(
      (v, i) =>
        `<text x="${dpX(v)}" y="22" text-anchor="middle" font-size="${CHART_FONT.tick.size}" font-weight="600" fill="var(--c-muted)">${lbls[i]}</text>`,
    )
    .join("");
  return (
    `<svg width="${DP_W}" height="30" overflow="visible" style="display:block">` +
    `<line x1="${dpX(0)}" y1="0" x2="${dpX(1)}" y2="0" stroke="var(--c-muted)" stroke-width="1"/>` +
    lines +
    texts +
    "</svg>"
  );
}

function dpAxisSvgTop() {
  // Uses dpX — same coordinate system as data rows so ticks align with gridlines
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const lbls = ["0%", "20%", "40%", "60%", "80%", "100%"];
  const axisY = 19;
  const lines = ticks
    .map(
      (v) =>
        `<line x1="${dpX(v)}" y1="${axisY}" x2="${dpX(v)}" y2="${axisY - 5}" stroke="var(--c-muted)" stroke-width="1"/>`,
    )
    .join("");
  const texts = ticks
    .map(
      (v, i) =>
        `<text x="${dpX(v)}" y="${axisY - 9}" text-anchor="middle" font-size="${CHART_FONT.tick.size}" font-weight="600" fill="var(--c-muted)">${lbls[i]}</text>`,
    )
    .join("");
  return (
    `<svg width="${DP_W}" height="20" overflow="visible" style="display:block">` +
    `<line x1="${dpX(0)}" y1="${axisY}" x2="${dpX(1)}" y2="${axisY}" stroke="var(--c-muted)" stroke-width="1"/>` +
    lines +
    texts +
    "</svg>"
  );
}

function renderDesignPoints(rows, rowsExcluded) {
  _dpLastRows = [rows, rowsExcluded];
  dpFitWidth();
  const propCols = DP_PROPS.map(() => `<col class="dp-col-prop"/>`).join("");
  const propThs = DP_PROPS.map(
    (p, i) =>
      `<th class="dp-th-prop${i % 2 === 0 ? " dp-th-alt" : ""}">` +
      `<span class="dp-prop-label">${p.labelHtml || esc(p.label)}</span>` +
      `<button class="prop-help-btn dp-prop-help-btn" type="button" data-prop-key="${p.key}">?</button>` +
      `</th>`,
  ).join("");

  const makePropCells = (row, extraClass) =>
    DP_PROPS.map((p, i) => {
      const v = row[p.key];
      const alt = i % 2 === 0 ? " dp-prop-alt" : "";
      return `<td class="dp-prop-val ${v === 1 ? "dp-val-1" : "dp-val-0"}${alt} dp-prop-cell${extraClass}" data-prop-key="${p.key}" data-prop-val="${v}">${v === 1 ? "●" : "○"}</td>`;
    }).join("");

  const bodyRows = rows
    .map((row) => {
      const dataAttrs = DP_PROPS.map(
        (p) => `data-${p.key}="${row[p.key]}"`,
      ).join(" ");
      return (
        `<tr class="dp-clickable" ${dataAttrs}>` +
        `<td class="dp-n-cell">${fmtNum(row.n)}</td>` +
        makePropCells(row, "") +
        `<td class="dp-ci-cell">${dpCiSvg(row.mean, row.ci_lo, row.ci_hi)}</td>` +
        `<td class="dp-score-cell">${(row.mean * 100).toFixed(1)}%</td>` +
        `<td class="dp-ci-text-cell">${row.ci_lo !== null && row.ci_hi !== null ? `${(row.ci_lo * 100).toFixed(1)} – ${(row.ci_hi * 100).toFixed(1)}%` : "—"}</td>` +
        `</tr>`
      );
    })
    .join("");

  const exN = rowsExcluded.length;
  const excludedRows = rowsExcluded
    .map((row) => {
      const dataAttrs = DP_PROPS.map(
        (p) => `data-${p.key}="${row[p.key]}"`,
      ).join(" ");
      return (
        `<tr class="dp-excluded-row dp-clickable" ${dataAttrs}>` +
        `<td class="dp-n-cell">${fmtNum(row.n)}</td>` +
        makePropCells(row, " dp-excl-prop") +
        `<td class="dp-ci-cell dp-excl-ci"></td>` +
        `<td class="dp-score-cell dp-excl-score">—</td>` +
        `<td class="dp-ci-text-cell">—</td>` +
        `</tr>`
      );
    })
    .join("");

  const totalCols = 1 + DP_PROPS.length + 3;
  const emptyTds = "<td></td>".repeat(DP_PROPS.length);
  const axisRow = `<tr><td></td>${emptyTds}<td class="dp-axis-cell">${dpAxisSvg()}</td><td></td><td></td></tr>`;

  const excludedSection =
    exN > 0
      ? `<tbody class="dp-excluded-toggle-tbody">` +
        `<tr><td colspan="${totalCols}" class="dp-excluded-toggle-cell">` +
        `<button class="dp-excluded-btn" type="button">` +
        `▶ ${exN} design point${exN !== 1 ? "s" : ""} with N < 5` +
        `</button></td></tr></tbody>` +
        `<tbody class="dp-excluded-body" hidden>${excludedRows}</tbody>`
      : "";

  document.getElementById("dpTableContainer").innerHTML =
    `<p class="click-hint">Click a row to list its statements.</p>` +
    `<table class="dp-table">` +
    `<colgroup><col class="dp-col-n"/>${propCols}<col class="dp-col-ci" style="width:${DP_W}px"/><col class="dp-col-score"/><col class="dp-col-citext"/></colgroup>` +
    `<thead>` +
    `<tr><th class="dp-th-n" title="Statements with a score (at least 10 ratings)">N</th>${propThs}<th class="dp-th-ci dp-axis-cell">${dpAxisSvgTop()}</th><th class="dp-th-score">Mean score</th><th class="dp-th-citext">95% CI</th></tr>` +
    `</thead>` +
    `<tbody>${bodyRows}</tbody>` +
    excludedSection +
    `<tfoot>${axisRow}</tfoot>` +
    `</table>`;

  // Single delegated handler — toggle excluded section OR select a qualified row
  document.getElementById("dpTableContainer").onclick = (e) => {
    const btn = e.target.closest(".dp-excluded-btn");
    if (btn) {
      const tbody = btn.closest("table").querySelector(".dp-excluded-body");
      const opening = tbody.hidden;
      tbody.hidden = !opening;
      btn.textContent =
        (opening ? "▼" : "▶") +
        ` ${exN} design point${exN !== 1 ? "s" : ""} with N < 5`;
      return;
    }
    const tr = e.target.closest("tr.dp-clickable");
    if (!tr) return;
    const alreadySelected = tr.classList.contains("dp-selected");
    document
      .querySelectorAll("#dpTableContainer .dp-selected")
      .forEach((r) => r.classList.remove("dp-selected"));
    if (alreadySelected) {
      document.getElementById("dpDetailCard").classList.add("hidden");
      return;
    }
    tr.classList.add("dp-selected");
    const props = Object.fromEntries(
      DP_PROPS.map((p) => [p.key, parseInt(tr.dataset[p.key])]),
    );
    loadDpStatements(dpCountrySelect.value, props);
  };
}

async function loadDpStatements(country, props) {
  const detailCard = document.getElementById("dpDetailCard");
  const detailBody = document.getElementById("dpDetailBody");
  detailCard.classList.remove("hidden");

  const labels = DP_PROPS.map((p, i) => {
    const isActive = props[p.key] === 1;
    const label = isActive ? p.label : PROP_DEFS[i].v0;
    return isActive
      ? `<strong>${esc(label)}</strong>`
      : `<span style="color:var(--c-muted)">${esc(label)}</span>`;
  }).join(" · ");
  document.getElementById("dpDetailTitle").textContent =
    "Statements in this design point";
  document.getElementById("dpDetailSub").innerHTML = labels;
  detailBody.innerHTML =
    '<div class="empty-row" style="padding:20px 0">Loading…</div>';

  detailCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const params = new URLSearchParams({ country });
  DP_PROPS.forEach((p) => params.set(p.key, props[p.key]));

  let data;
  try {
    data = await fetch(`${API}/dp-statements?${params}${dateParams()}`).then((r) => r.json());
  } catch {
    detailBody.innerHTML = '<div class="empty-row">Failed to load.</div>';
    return;
  }

  document.getElementById("dpDetailSub").innerHTML =
    labels +
    `<div class="dp-detail-counts">${fmtNum(data.n)} statement${data.n !== 1 ? "s" : ""}: ` +
    `${fmtNum(data.n_qualified)} with a score, which give the mean` +
    (data.n_excluded ? `, and ${fmtNum(data.n_excluded)} with fewer than 10 ratings (listed without scores)` : "") +
    `</div>`;
  renderDpStatements(data.rows);
}

// ── DP detail table sort state ─────────────────────────────────────────────
let dpDetailSortKey = "published";
let dpDetailSortDir = "desc";
let dpDetailAllRows = [];
let dpDetailPage = 1;

// Default order is published first, then by rating count. Ties on any column
// fall back to rating count; unqualified statements have no scores, so they
// sink to the bottom when sorting by a score column in either direction.
function buildDpDetailRows() {
  const rows = [...dpDetailAllRows];
  const sign = dpDetailSortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[dpDetailSortKey], bv = b[dpDetailSortKey];
    if (av === null || bv === null) {
      if (av !== bv) return av === null ? 1 : -1;
    } else if (av !== bv) {
      return sign * (av - bv);
    }
    return b.n_ratings - a.n_ratings;
  });
  return rows;
}

function getFilteredDpDetailRows() {
  const rows = buildDpDetailRows();
  const dpq = dpDetailSearchQuery.trim().toLowerCase();
  return dpq ? rows.filter((r) => r.statement.toLowerCase().includes(dpq)) : rows;
}

function updateDpDetailSortHeaders() {
  document
    .querySelectorAll("#dpDetailTable thead th.sortable")
    .forEach((th) => {
      const icon = th.querySelector(".sort-icon");
      const active = th.dataset.sort === dpDetailSortKey;
      th.classList.toggle("sort-active", active);
      icon.textContent = active ? (dpDetailSortDir === "asc" ? "▲" : "▼") : "";
    });
}

function renderDpDetailBody() {
  const rows = getFilteredDpDetailRows();
  const tp = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = (dpDetailPage - 1) * PAGE_SIZE;

  const tbody = document.querySelector("#dpDetailTable tbody");
  tbody.innerHTML = "";
  let qualRank = rows.slice(0, start).filter((r) => r.qualified).length + 1;
  rows.slice(start, start + PAGE_SIZE).forEach((row) => {
    const tr = document.createElement("tr");
    const head =
      `<td class="td-statement">${esc(fixStatement(row.statement))}</td>` +
      `<td class="td-published">${badge(row.published)}</td>` +
      `<td class="td-num">${fmtNum(row.n_ratings)}</td>`;
    if (!row.qualified) {
      // Too few ratings to score — shown for completeness, not in the mean
      tr.classList.add("row-excluded");
      tr.innerHTML =
        `<td class="td-rank td-dim">—</td>` + head +
        `<td class="td-dim">—</td>`.repeat(5);
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => {
        const c = dpCountrySelect.value;
        openStmtInfo(row.statement, row.statementId,
          notEnoughRatingsHtml(row.n_ratings, c === "all" ? "all countries" : c));
      });
    } else {
      tr.innerHTML =
        `<td class="td-rank">${fmtNum(qualRank++)}</td>` + head +
        `<td>${pctBar(row.I_agree_mean)}</td>` +
        `<td>${pctBar(row.others_agree_mean)}</td>` +
        `<td>${pctBarScore(row.consensus)}</td>` +
        `<td>${pctBarScore(row.awareness)}</td>` +
        `<td>${pctBarScore(row.commonsensicality)}</td>`;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () =>
        openStmtDetail(row, dpCountrySelect.value),
      );
    }
    tbody.appendChild(tr);
  });

  document.getElementById("dpDetailPageInfo").textContent =
    `Page ${fmtNum(dpDetailPage)} of ${fmtNum(tp)}`;
  document.getElementById("dpDetailBtnPrev").disabled = dpDetailPage <= 1;
  document.getElementById("dpDetailBtnNext").disabled = dpDetailPage >= tp;
  // The card's subtitle already gives the totals; count only search matches
  document.getElementById("dpDetailCount").textContent = dpDetailSearchQuery.trim()
    ? `${fmtNum(rows.length)} of ${fmtNum(dpDetailAllRows.length)} statements match`
    : "";
}

function renderDpStatements(rows) {
  dpDetailAllRows = rows;
  dpDetailSortKey = "published";
  dpDetailSortDir = "desc";
  dpDetailPage = 1;
  dpDetailSearchQuery = "";

  const detailBody = document.getElementById("dpDetailBody");
  if (!rows.length) {
    detailBody.innerHTML =
      '<div class="empty-row" style="padding:20px 0">No statements in this design point.</div>';
    return;
  }

  detailBody.innerHTML =
    `<div class="scores-nav" style="padding:6px 0 2px">` +
    `<span id="dpDetailCount" class="scores-filter-label"></span>` +
    `<input type="search" id="dpDetailSearchInput" class="stmt-search-input" placeholder="Search these statements…" aria-label="Search these statements" style="flex:1;max-width:280px;margin:0 10px">` +
    `</div>` +
    `<div class="table-nav-row">` +
    `<p class="click-hint">Click a row to see how its score is calculated.</p>` +
    `<div class="pagination">` +
    `<button id="dpDetailBtnPrev" class="page-btn" disabled>&#8249;</button>` +
    `<span id="dpDetailPageInfo" class="page-info"></span>` +
    `<button id="dpDetailBtnNext" class="page-btn" disabled>&#8250;</button>` +
    `</div></div>` +
    `<div class="dp-detail-table-wrap"><table id="dpDetailTable" style="margin-top:4px;table-layout:fixed;width:100%;border-collapse:collapse;background:var(--c-surface)">` +
    `<colgroup><col class="col-rank"/><col class="col-dp-stmt"/><col class="col-dp-published"/><col class="col-num"/>` +
    `<col class="col-stmtscore"/><col class="col-stmtscore"/><col class="col-stmtscore"/>` +
    `<col class="col-stmtscore"/><col class="col-stmtscore"/></colgroup>` +
    `<thead><tr>` +
    `<th class="col-rank">#</th>` +
    `<th class="col-dp-stmt">Statement</th>` +
    `<th class="col-dp-published sortable sort-active" data-sort="published">Published <button class="prop-help-btn" type="button" data-col-label="Published" data-col-def="Whether the statement is currently being sampled to participants.">?</button> <span class="sort-icon">▼</span></th>` +
    `<th class="col-num sortable" data-sort="n_ratings">Ratings <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="I_agree_mean">Agree <button class="prop-help-btn" type="button" data-col-label="Agree" data-col-def="Share of raters who agree with the statement. Orange when under 50%, so the majority disagrees.">?</button> <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="others_agree_mean">Think most agree <button class="prop-help-btn" type="button" data-col-label="Think most agree" data-col-def="Share of raters who think most other people would agree with the statement.">?</button> <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="consensus">Consensus <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="awareness">Awareness <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="commonsensicality">Common&shy;sensicality <span class="sort-icon"></span></th>` +
    `</tr></thead><tbody></tbody></table></div>`;

  renderDpDetailBody();
  mirrorPager(
    document.getElementById("dpDetailBtnPrev").parentElement,
    detailBody.querySelector(".dp-detail-table-wrap"),
  );

  document
    .querySelectorAll("#dpDetailTable thead th.sortable")
    .forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (dpDetailSortKey === key) {
          dpDetailSortDir = dpDetailSortDir === "asc" ? "desc" : "asc";
        } else {
          dpDetailSortKey = key;
          dpDetailSortDir = "desc";
        }
        dpDetailPage = 1;
        updateDpDetailSortHeaders();
        renderDpDetailBody();
      });
    });

  document.getElementById("dpDetailBtnPrev").addEventListener("click", () => {
    if (dpDetailPage > 1) {
      dpDetailPage--;
      renderDpDetailBody();
    }
  });
  document.getElementById("dpDetailBtnNext").addEventListener("click", () => {
    const tp = Math.max(1, Math.ceil(getFilteredDpDetailRows().length / PAGE_SIZE));
    if (dpDetailPage < tp) {
      dpDetailPage++;
      renderDpDetailBody();
    }
  });
  document
    .getElementById("dpDetailSearchInput")
    .addEventListener("input", (e) => {
      dpDetailSearchQuery = e.target.value;
      dpDetailPage = 1;
      renderDpDetailBody();
    });
}

// ── Country matrix ─────────────────────────────────────────────────────────

function getFilteredCmRows() {
  if (!countryMatrixData) return [];
  let rows = countryMatrixData.rows;
  for (const { key } of PROP_DEFS) {
    const { v1, v0 } = cmPropFilters[key];
    if ((!v1 && !v0) || (v1 && v0)) continue;
    rows = rows.filter(r => {
      const v = r[key];
      if (v === null || v === undefined) return false;
      if (v1 && v !== 1) return false;
      if (v0 && v !== 0) return false;
      return true;
    });
  }
  const q = cmSearchQuery.trim().toLowerCase();
  if (q) rows = rows.filter(r => r.statement.toLowerCase().includes(q));
  if (cmOnlyFlips) rows = rows.filter(r => r._flip);
  return rows;
}

function getSortedCmRows() {
  if (!countryMatrixData) return [];
  const rows = getFilteredCmRows();
  if (cmSortKey === null) return rows;
  return [...rows].sort((a, b) => {
    if (cmSortKey === 'stmt') {
      const cmp = a.statement.localeCompare(b.statement);
      return cmSortDir === 'asc' ? cmp : -cmp;
    }
    let va, vb;
    if (cmSortKey === 'n') {
      va = a._n; vb = b._n;
      if (va !== vb) return cmSortDir === 'asc' ? va - vb : vb - va;
      return (b.sd || 0) - (a.sd || 0); // tiebreaker: SD desc
    } else if (cmSortKey === 'sd') {
      va = cmView === 'agree' ? a._aSd : a.sd || 0; vb = cmView === 'agree' ? b._aSd : b.sd || 0;
    } else if (cmSortKey === 'mean') {
      va = cmView === 'agree' ? a._aMean : a.mean || 0; vb = cmView === 'agree' ? b._aMean : b.mean || 0;
    } else {
      const k = cmView === 'agree' ? 'a' : 's';
      va = a.scores[cmSortKey]?.[k]; vb = b.scores[cmSortKey]?.[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
    }
    return cmSortDir === 'asc' ? va - vb : vb - va;
  });
}

function updateCmSortIndicators() {
  document.querySelectorAll('#cmHeadRow th[data-sort]').forEach(th => {
    const icon = th.querySelector('.cm-sort-icon');
    if (!icon) return;
    const active = th.dataset.sort === cmSortKey;
    icon.textContent = active ? (cmSortDir === 'desc' ? ' ▼' : ' ▲') : '';
    th.classList.toggle('cm-th-sort-active', active);
  });
}

function cmTotalPages() {
  return countryMatrixData
    ? Math.max(1, Math.ceil(getFilteredCmRows().length / CM_PAGE_SIZE))
    : 1;
}

function updateCmSummary() {
  if (!countryMatrixData) return;
  const total    = countryMatrixData.rows.length;
  const filtered = getFilteredCmRows().length;
  const flipBtn = document.getElementById('cmFlipBtn');
  if (flipBtn) flipBtn.textContent = `Only where majorities differ (${fmtNum(countryMatrixData.rows.filter(r => r._flip).length)})`;
  document.getElementById('cmSummary').textContent =
    filtered < total
      ? `${fmtNum(filtered)} of ${fmtNum(total)} statements · ${fmtNum(countryMatrixData.countries.length)} countries`
      : `${fmtNum(total)} statements · ${fmtNum(countryMatrixData.countries.length)} countries`;
}

// Cell shading: --c-ramp-base (white; the card on the dark theme) at 0 to
// a 43% mix of --c-agree at 100, opaque so the row striping doesn't show
// through. The toolbar legend uses the same ramp. Text stays --c-text on
// every step in both themes.
function cmMix(hue, t) {
  return `color-mix(in srgb, var(${hue}) ${(t * 100).toFixed(1)}%, var(--c-ramp-base))`;
}
function cmScoreBg(score) {
  return cmMix("--c-agree", 0.03 + 0.4 * Math.max(0, Math.min(100, score)) / 100);
}
// "Share who agree" view: diverging, orange where the majority disagrees and
// blue where it agrees, deeper the further the share is from 50%
function cmAgreeBg(a) {
  const d = Math.min(50, Math.abs(Math.max(0, Math.min(100, a)) - 50)) / 50;
  return cmMix(a >= 50 ? "--c-agree" : "--c-expect", 0.03 + 0.4 * d);
}

// Toolbar legend, the M / SD header tooltips and the note for the current view
function cmSyncView() {
  const agree = cmView === 'agree';
  const ramp = document.getElementById("cmLegendRamp");
  if (ramp) {
    ramp.style.background = agree
      ? `linear-gradient(90deg, ${cmAgreeBg(0)}, ${cmAgreeBg(50)}, ${cmAgreeBg(100)})`
      : `linear-gradient(90deg, ${cmScoreBg(0)}, ${cmScoreBg(50)}, ${cmScoreBg(100)})`;
  }
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set("cmLegendName", agree ? "Share who agree" : "Score");
  set("cmLegendLo", agree ? "0%" : "0");
  set("cmLegendHi", agree ? "100%" : "100");
  const legend = document.getElementById("cmLegend");
  if (legend) legend.setAttribute("aria-label", agree ? "Cell shading: share who agree, orange below 50% and blue above" : "Cell shading: commonsensicality from 0 to 100");
  document.querySelectorAll("#cmViews [data-cm-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cmView === cmView)));
  const flip = document.getElementById("cmFlipBtn");
  if (flip) flip.setAttribute("aria-pressed", String(cmOnlyFlips));
  const mTh = document.querySelector('#cmHeadRow th[data-sort="mean"]');
  const sdTh = document.querySelector('#cmHeadRow th[data-sort="sd"]');
  if (mTh) mTh.title = agree ? "Mean share who agree across the countries with at least 10 ratings" : "Mean of a statement's commonsensicality score among all applicable countries";
  if (sdTh) sdTh.title = agree ? "Standard deviation of the share who agree across those countries" : "Standard deviation of a statement's commonsensicality score among all applicable countries";
  const note = document.getElementById("cmViewNote");
  const parts = [];
  if (agree) parts.push("Each cell is the share of that country's raters who agree: blue when most agree, orange when most disagree. <em>M</em> and <em>SD</em> summarize these shares.");
  if (cmOnlyFlips) parts.push("Only statements where at least one country's majority agrees and another's disagrees, among countries with 10+ ratings. Small countries are noisy, so a share near 50% can land on either side by chance.");
  note.innerHTML = parts.join(" ");
  note.hidden = !parts.length;
}
cmSyncView();

document.getElementById("cmViews").addEventListener("click", (e) => {
  const v = e.target.closest("[data-cm-view]");
  if (v) {
    cmView = v.dataset.cmView;
  } else if (e.target.closest("#cmFlipBtn")) {
    cmOnlyFlips = !cmOnlyFlips;
    cmPage = 1;
  } else {
    return;
  }
  cmSyncView();
  renderCmPage();
});

// The first five columns (#, Statement, N, M, SD) stick to the left while the
// matrix scrolls sideways. Their widths depend on the content (auto layout),
// so measure them and set each one's left offset, rather than hardcoding it.
function cmFixStickyLefts() {
  const table = document.querySelector("#panelCountries .cm-table");
  const head = document.getElementById("cmHeadRow");
  if (!table || !head || head.cells.length < 5 || !table.offsetWidth) return;
  let left = 0;
  for (let i = 0; i < 5; i++) {
    table.style.setProperty(`--cm-left-${i}`, `${left}px`);
    left += head.cells[i].getBoundingClientRect().width;
  }
}

// ── Countries matrix in a scrolling page ──────────────────────────────────
// All 25 rows of the matrix sit in the page (style.css). Its wrapper scrolls
// sideways, so a sticky-top header row would stick inside that wrapper and
// never move; cmPinHeader() instead shifts the header cells down by however
// far the table top has scrolled above the panel's visible top. The
// wrapper's own scrollbar, which would sit under the 25th row, is replaced
// by .cm-hscroll, kept at the bottom of the window and synced both ways.
function cmPinHeader() {
  const sc = document.querySelector("#panelCountries .scores-wrap");
  const table = document.querySelector("#panelCountries .cm-table");
  if (!sc || !table || !table.tHead) return;
  const head = table.tHead;
  const room = table.offsetHeight - head.offsetHeight;
  const dy = Math.max(0, Math.min(sc.getBoundingClientRect().top - table.getBoundingClientRect().top, room));
  const t = dy > 0 ? `translateY(${dy}px)` : "";
  head.querySelectorAll("th").forEach((th) => { th.style.transform = t; });
}

function cmSyncHScroll() {
  const wrap = document.querySelector("#panelCountries .cm-table-wrap");
  const bar = document.querySelector("#panelCountries .cm-hscroll");
  if (!wrap || !bar || !wrap.clientWidth) return; // hidden panel: measure when shown
  bar.firstElementChild.style.width = `${wrap.scrollWidth}px`;
  bar.hidden = wrap.scrollWidth <= wrap.clientWidth + 1;
  bar.scrollLeft = wrap.scrollLeft;
}

function cmInitScroll() {
  const sc = document.querySelector("#panelCountries .scores-wrap");
  const wrap = document.querySelector("#panelCountries .cm-table-wrap");
  const bar = document.createElement("div");
  bar.className = "cm-hscroll";
  bar.setAttribute("aria-hidden", "true");
  bar.appendChild(document.createElement("div"));
  wrap.after(bar);
  // Each follows the other; once both match, the echoed event changes nothing
  const follow = (from, to) => () => {
    if (Math.abs(to.scrollLeft - from.scrollLeft) > 0.5) to.scrollLeft = from.scrollLeft;
  };
  bar.addEventListener("scroll", follow(bar, wrap), { passive: true });
  wrap.addEventListener("scroll", follow(wrap, bar), { passive: true });
  let frame = 0;
  sc.addEventListener("scroll", () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; cmPinHeader(); });
  }, { passive: true });
  window.addEventListener("resize", () => { cmFixStickyLefts(); cmSyncHScroll(); cmPinHeader(); });
  mirrorPager(document.getElementById("btnCmPrev").parentElement, bar);
}

function renderCmPage() {
  if (!countryMatrixData) return;
  const { countries } = countryMatrixData;
  const sorted   = getSortedCmRows();
  const start    = (cmPage - 1) * CM_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + CM_PAGE_SIZE);

  const tbody    = document.getElementById('cmBody');
  const fragment = document.createDocumentFragment();

  pageRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.dataset.stmtId = row.statementId;

    const tdRank = document.createElement('td');
    tdRank.className = 'cm-rank-cell';
    tdRank.textContent = start + i + 1;
    tr.appendChild(tdRank);

    const tdStmt = document.createElement('td');
    tdStmt.className = 'cm-stmt-cell';
    tdStmt.textContent = fixStatement(row.statement);
    tr.appendChild(tdStmt);

    const tdN = document.createElement('td');
    tdN.className = 'cm-n-cell';
    tdN.textContent = row._n;
    tr.appendChild(tdN);

    const agreeView = cmView === 'agree';
    const tdMean = document.createElement('td');
    tdMean.className = 'cm-mean-cell';
    tdMean.textContent = row._n > 0 ? (agreeView ? `${row._aMean.toFixed(0)}%` : row.mean.toFixed(1)) : '—';
    tr.appendChild(tdMean);

    const tdSd = document.createElement('td');
    tdSd.className = 'cm-sd-cell';
    tdSd.textContent = row._n > 1 ? (agreeView ? row._aSd.toFixed(1) : row.sd.toFixed(1)) : '—';
    tr.appendChild(tdSd);

    countries.forEach(c => {
      const td = document.createElement('td');
      const entry = row.scores[c];
      if (entry != null && entry.s != null) {
        td.className = 'cm-score-cell cm-score-cell-clickable';
        td.dataset.country = c;
        if (cmView === 'agree') {
          td.style.background = cmAgreeBg(entry.a);
          td.innerHTML =
            `${entry.a.toFixed(0)}%` +
            `<div class="cm-score-n"><em>N</em> = ${fmtNum(entry.n)}</div>`;
        } else {
          td.style.background = cmScoreBg(entry.s);
          td.innerHTML =
            entry.s.toFixed(1) +
            `<div class="cm-score-n"><em>N</em> = ${fmtNum(entry.n)}</div>`;
        }
      } else {
        // Under 10 ratings: no score, but still opens the statement's info
        const n = entry != null ? entry.n : 0;
        td.className = 'cm-score-cell cm-score-cell-sub cm-score-cell-clickable';
        td.dataset.country = c;
        td.dataset.n = n;
        td.innerHTML = `<div class="cm-score-n"><em>N</em> = ${fmtNum(n)}</div>`;
      }
      tr.appendChild(td);
    });

    fragment.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);

  const tp = cmTotalPages();
  document.getElementById('cmPageInfo').textContent =
    `Page ${fmtNum(cmPage)} of ${fmtNum(tp)}`;
  document.getElementById('btnCmPrev').disabled = cmPage <= 1;
  document.getElementById('btnCmNext').disabled = cmPage >= tp;
  updateCmSummary();
  cmFixStickyLefts();
  cmSyncHScroll();
  cmPinHeader();
}

async function loadCountryMatrix() {
  document.getElementById('cmBody').innerHTML =
    '<tr><td class="empty-row">Computing…</td></tr>';
  document.getElementById('cmSpinner').classList.remove('hidden');

  let data;
  try {
    data = await fetch(`${API}/country-matrix?${dateParams().slice(1) || ""}`).then(r => r.json());
  } catch {
    document.getElementById('cmBody').innerHTML =
      '<tr><td class="empty-row">Failed to load.</td></tr>';
    document.getElementById('cmSpinner').classList.add('hidden');
    return;
  }
  document.getElementById('cmSpinner').classList.add('hidden');
  countryMatrixData = data;
  // Per row: countries scored, whether their majorities point different
  // ways, and the mean and SD of the share who agree (the "Share who agree" view)
  data.rows.forEach(row => {
    const cells = Object.values(row.scores).filter(e => e.s != null);
    row._n = cells.length;
    const a = cells.map(e => e.a);
    const nAgree = a.filter(v => v >= 50).length;
    row._flip = nAgree > 0 && nAgree < a.length;
    row._aMean = a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    row._aSd = a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - row._aMean) ** 2, 0) / (a.length - 1)) : 0;
  });

  const headRow = document.getElementById('cmHeadRow');
  headRow.innerHTML =
    `<th class="cm-rank-th">#</th>` +
    `<th class="cm-stmt-th cm-th-sortable" data-sort="stmt">Statement<span class="cm-sort-icon"></span></th>` +
    `<th class="cm-n-th cm-th-sortable" data-sort="n" title="Number of countries that have at least 10 ratings for a statement">Countries<span class="cm-sort-icon"></span></th>` +
    `<th class="cm-mean-th cm-th-sortable" data-sort="mean" title="Mean of a statement&#39;s commonsensicality score among all applicable countries"><em>M</em><span class="cm-sort-icon"></span></th>` +
    `<th class="cm-sd-th cm-th-sortable" data-sort="sd" title="Standard deviation of a statement&#39;s commonsensicality score among all applicable countries"><em>SD</em><span class="cm-sort-icon"></span></th>` +
    data.countries.map(c =>
      `<th class="cm-country-th cm-th-sortable" data-sort="${esc(c)}" title="${esc(c)}, ${fmtNum(data.country_n_statements[c])} statements">` +
        `<div class="cm-country-th-inner">` +
          `<span class="cm-flag">${countryFlag(c)}</span>` +
          `<span class="cm-country-name">${esc(countryCode(c))}</span>` +
          `<span class="cm-country-n">${fmtNum(data.country_n_statements[c])}</span>` +
        `</div>` +
      `</th>`
    ).join('');

  headRow.onclick = (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (key === cmSortKey) {
      cmSortDir = cmSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      cmSortKey = key;
      cmSortDir = 'desc';
    }
    cmPage = 1;
    updateCmSortIndicators();
    renderCmPage();
  };

  updateCmSummary();

  document.getElementById('cmBody').onclick = async (e) => {
    const td = e.target.closest('.cm-score-cell-clickable');
    if (!td) return;
    const stmtId = parseInt(td.closest('tr').dataset.stmtId);
    const country = td.dataset.country;
    if (td.classList.contains('cm-score-cell-sub')) {
      const row = countryMatrixData.rows.find(r => r.statementId === stmtId);
      openStmtInfo(row ? row.statement : '', stmtId, notEnoughRatingsHtml(Number(td.dataset.n), country));
      return;
    }
    try {
      const cell = await fetch(
        `${API}/country-cell?statementId=${encodeURIComponent(stmtId)}&country=${encodeURIComponent(country)}${dateParams()}`
      ).then(r => r.json());
      if (!cell.error) openStmtDetail(cell, country);
    } catch {}
  };

  cmPage = 1;
  cmSortKey = 'n';
  cmSortDir = 'desc';
  updateCmSortIndicators();
  cmSyncView();
  renderCmPage();
  notifyIntro("countries", data);
}

async function loadDesignPoints(country) {
  document.getElementById("dpTableContainer").innerHTML =
    '<div class="empty-row" style="padding:30px 0">Loading…</div>';
  let data;
  try {
    data = await fetch(
      `${API}/design-points?country=${encodeURIComponent(country)}${dateParams()}`,
    ).then((r) => r.json());
  } catch {
    document.getElementById("dpTableContainer").innerHTML =
      '<div class="empty-row">Failed to load design points.</div>';
    return;
  }
  if (!data.rows || !data.rows.length) {
    document.getElementById("dpTableContainer").innerHTML =
      '<div class="empty-row">No data.</div>';
    return;
  }
  renderDesignPoints(data.rows, data.rows_excluded || []);
  notifyIntro("dp", data, { country });
}

document.querySelectorAll(".prop-filter-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.closest(".prop-filter-panel");
    const grid = panel.querySelector(".prop-filter-grid");
    const opening = grid.classList.contains("hidden");
    grid.classList.toggle("hidden", !opening);
    panel.classList.toggle("is-open", opening);
  });
});

PROP_DEFS.forEach(({ key }) => {
  const ss1 = document.getElementById(`ssFilter_${key}_1`);
  const ss0 = document.getElementById(`ssFilter_${key}_0`);

  ss1.addEventListener("change", () => {
    ssPropFilters[key].v1 = ss1.checked;
    buildStmtScoresRows();
    renderStmtScoresPage(true);
  });
  ss0.addEventListener("change", () => {
    ssPropFilters[key].v0 = ss0.checked;
    buildStmtScoresRows();
    renderStmtScoresPage(true);
  });
});

document.getElementById("scoresSearch").addEventListener("input", (e) => {
  scoresSearchQuery = e.target.value;
  buildScoresRows();
  renderScoresPage();
});

function handleGlobalDateChange() {
  // Reset all panel loaded flags so each reloads with the new date filter
  _homeMapLoaded = false;
  _homeCountryData = null;
  _selectedHomeCountry = null;
  document.getElementById("homeCountryCard").classList.add("hidden");
  scoresLoaded = false;
  stmtScoresLoaded = false;
  dpPanelLoaded = false;
  countryMatrixLoaded = false;

  // Reload eagerly-loaded panels immediately
  stmtScoresLoaded = true;
  loadStmtScores(stmtScoresCountrySelect.value);
  loadGroupCompare();

  // Reload the current active panel (Home only when it is on screen; the
  // statement-generation pages have no tab button either)
  const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
  if (_currentTab === "home") {
    _homeMapLoaded = true; loadHomeMap();
    if (typeof loadHomeSummary === "function") loadHomeSummary();
  }
  else if (activeTab === "scores") { scoresLoaded = true; loadScores(targetSelect.value, referenceSelect.value); }
  else if (activeTab === "dp") { dpPanelLoaded = true; loadDesignPoints(dpCountrySelect.value); }
  else if (activeTab === "countries") { countryMatrixLoaded = true; loadCountryMatrix(); }
}

// ── Global date filter (top bar) ───────────────────────────────────────────
// One button that opens a popover: quick presets apply at once, a custom
// range applies with "Apply". Both go through setGlobalDates(), so a range
// change reloads the panels once (not once per field).
const DATE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATA_FIRST_YEAR = 2023; // first ratings: July 2023

function fmtDateShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${DATE_MONTHS[m - 1]} ${y}`;
}
function isoDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function datePresets() {
  const now = new Date();
  const yearAgo = new Date(now);
  yearAgo.setFullYear(now.getFullYear() - 1);
  const presets = [
    { label: "All dates", from: "", to: "" },
    { label: "Last 12 months", from: isoDate(yearAgo), to: "" },
  ];
  for (let y = now.getFullYear(); y >= DATA_FIRST_YEAR; y--) {
    presets.push({ label: String(y), from: `${y}-01-01`, to: `${y}-12-31` });
  }
  return presets;
}

function dateRangeLabel(from, to) {
  if (!from && !to) return "All dates";
  const preset = datePresets().find((p) => p.from === from && p.to === to);
  if (preset) return preset.label;
  if (from && to) {
    // "1 Jul – 30 Sep 2024" within one year, to keep the button short
    return from.slice(0, 4) === to.slice(0, 4)
      ? `${fmtDateShort(from).replace(/ \d{4}$/, "")} – ${fmtDateShort(to)}`
      : `${fmtDateShort(from)} – ${fmtDateShort(to)}`;
  }
  return from ? `Since ${fmtDateShort(from)}` : `Until ${fmtDateShort(to)}`;
}

const dateFilterEl = document.getElementById("dateFilter");
const dateBtn = document.getElementById("dateBtn");
const datePop = document.getElementById("datePop");
const dateFromInput = document.getElementById("globalDateFrom");
const dateToInput = document.getElementById("globalDateTo");

function renderDateFilter() {
  document.getElementById("dateBtnLabel").textContent = dateRangeLabel(globalDateFrom, globalDateTo);
  dateFilterEl.classList.toggle("is-active", Boolean(globalDateFrom || globalDateTo));
  dateFromInput.value = globalDateFrom;
  dateToInput.value = globalDateTo;
  document.getElementById("datePresets").innerHTML = datePresets()
    .map((p) => `<button type="button" class="date-preset" data-from="${p.from}" data-to="${p.to}" aria-pressed="${p.from === globalDateFrom && p.to === globalDateTo}">${p.label}</button>`)
    .join("");
}

function setDatePopOpen(open) {
  datePop.hidden = !open;
  dateBtn.setAttribute("aria-expanded", String(open));
  if (open) renderDateFilter();
}

function setGlobalDates(from, to) {
  if (from && to && from > to) [from, to] = [to, from];
  setDatePopOpen(false);
  if (from === globalDateFrom && to === globalDateTo) return;
  globalDateFrom = from;
  globalDateTo = to;
  renderDateFilter();
  handleGlobalDateChange();
}

dateBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setThemePopOpen(false); // one top-bar popover at a time
  setDatePopOpen(datePop.hidden);
});
document.getElementById("datePresets").addEventListener("click", (e) => {
  const b = e.target.closest(".date-preset");
  if (b) setGlobalDates(b.dataset.from, b.dataset.to);
});
document.getElementById("dateApply").addEventListener("click", () =>
  setGlobalDates(dateFromInput.value, dateToInput.value),
);
document.getElementById("dateClear").addEventListener("click", () => setGlobalDates("", ""));
datePop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input")) setGlobalDates(dateFromInput.value, dateToInput.value);
  if (e.key === "Escape") { setDatePopOpen(false); dateBtn.focus(); }
});
document.addEventListener("click", (e) => {
  if (!datePop.hidden && !dateFilterEl.contains(e.target)) setDatePopOpen(false);
});
renderDateFilter();

document.getElementById("stmtScoresSearch").addEventListener("input", (e) => {
  stmtScoresSearchQuery = e.target.value;
  buildStmtScoresRows();
  renderStmtScoresPage(true);
});

document.getElementById("cmSearch").addEventListener("input", (e) => {
  cmSearchQuery = e.target.value;
  cmPage = 1;
  renderCmPage();
});

PROP_DEFS.forEach(({ key }) => {
  const cm1 = document.getElementById(`cmFilter_${key}_1`);
  const cm0 = document.getElementById(`cmFilter_${key}_0`);
  cm1.addEventListener("change", () => {
    cmPropFilters[key].v1 = cm1.checked;
    cmPage = 1;
    renderCmPage();
  });
  cm0.addEventListener("change", () => {
    cmPropFilters[key].v0 = cm0.checked;
    cmPage = 1;
    renderCmPage();
  });
});

// ── Property help popup ────────────────────────────────────────────────────
(function () {
  const popup = document.getElementById("propHelpPopup");
  let pinned = false;
  let activeBtn = null;
  let mouseX = 0,
    mouseY = 0;
  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  function propDefByKey(key) {
    return PROP_DEFS.find((d) => d.key === key);
  }

  function showPopup(el) {
    if (el.dataset.colDef) {
      popup.innerHTML =
        `<div class="prop-help-popup-entry">` +
        `<div class="prop-help-popup-label">${esc(el.dataset.colLabel || "")}</div>` +
        `<div class="prop-help-popup-def">${esc(el.dataset.colDef)}</div>` +
        `</div>`;
    } else if (el.classList.contains("dp-prop-cell")) {
      const def = propDefByKey(el.dataset.propKey);
      if (!def) return;
      const isActive = parseInt(el.dataset.propVal) === 1;
      const circle = isActive
        ? '<span class="popup-circle-filled">●</span>'
        : '<span class="popup-circle-empty">○</span>';
      const label = isActive ? esc(def.v1) : esc(def.v0);
      const defTxt = isActive ? esc(def.def1) : esc(def.def0);
      popup.innerHTML =
        `<div class="prop-help-popup-entry">` +
        `<div class="prop-help-popup-label">${circle} ${label}</div>` +
        `<div class="prop-help-popup-def">${defTxt}</div>` +
        `</div>`;
    } else {
      const def = propDefByKey(el.dataset.propKey);
      if (!def) return;
      popup.innerHTML =
        `<div class="prop-help-popup-entry">` +
        `<div class="prop-help-popup-label"><span class="popup-circle-filled">●</span> ${esc(def.v1)}</div>` +
        `<div class="prop-help-popup-def">${esc(def.def1)}</div>` +
        `</div>` +
        `<div class="prop-help-popup-entry">` +
        `<div class="prop-help-popup-label"><span class="popup-circle-empty">○</span> ${esc(def.v0)}</div>` +
        `<div class="prop-help-popup-def">${esc(def.def0)}</div>` +
        `</div>`;
    }
    positionPopup();
    popup.classList.add("visible");
  }

  function positionPopup() {
    const pw = 340;
    let left = mouseX + 14;
    let top = mouseY + 14;
    if (left + pw > window.innerWidth - 8) left = mouseX - pw - 8;
    if (top + popup.offsetHeight > window.innerHeight - 8)
      top = mouseY - popup.offsetHeight - 8;
    popup.style.left = left + "px";
    popup.style.top = Math.max(8, top) + "px";
  }

  function hidePopup() {
    popup.classList.remove("visible");
    if (activeBtn) {
      activeBtn.classList.remove("pinned");
      activeBtn = null;
    }
    pinned = false;
  }

  function getTarget(e) {
    return e.target.closest(".prop-help-btn");
  }

  document.addEventListener("click", (e) => {
    const el = getTarget(e);
    if (el) {
      e.stopPropagation();
      if (pinned && activeBtn === el) {
        hidePopup();
      } else {
        if (activeBtn && activeBtn !== el) activeBtn.classList.remove("pinned");
        activeBtn = el;
        pinned = true;
        el.classList.add("pinned");
        showPopup(el);
      }
      return;
    }
    if (!popup.contains(e.target)) hidePopup();
  });

  document.addEventListener("mouseover", (e) => {
    if (pinned) return;
    const el = getTarget(e);
    if (el) {
      activeBtn = el;
      showPopup(el);
    } else if (!popup.contains(e.target)) {
      popup.classList.remove("visible");
      activeBtn = null;
    }
  });
})();

// ── Group Comparison panel ─────────────────────────────────────────────────
const compareGroupAEl = document.getElementById("compareGroupA");
const compareGroupBEl = document.getElementById("compareGroupB");
const compareSpinnerEl = document.getElementById("compareSpinner");
let compareIndivChartInst = null;
let compareStmtChartInst = null;
let compareScatterChartInst = null;
let cmpData = null;
let cmpLabelA = "";
let cmpLabelB = "";
let cmpGroupA = "all";
let cmpGroupB = "all";
let cmpReq = 0; // latest /api/group-compare request; older responses are dropped

// The two groups' hues, as tokens for HTML (the charts use UI.agree and
// UI.expect, and UI.bad for statements whose majorities differ)
const CMP_COLOR_A = "var(--c-agree)";
const CMP_COLOR_B = "var(--c-expect)";
// Group names and headings in a group's hue use its -ink step
const cmpInk = (color) => (color === CMP_COLOR_A ? "var(--c-agree-ink)" : color === CMP_COLOR_B ? "var(--c-expect-ink)" : color);
const CMP_DETAIL_PLACEHOLDER =
  '<p class="cmp-detail-placeholder">Click a bar or a dot on the left to list the participants or statements behind it.</p>';

function cmpBinScores(scores) {
  const N = 20;
  const counts = new Array(N).fill(0);
  for (const s of scores) {
    const i = Math.min(Math.floor(s * N), N - 1);
    counts[i]++;
  }
  return counts;
}

function linReg(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, x) => a + x, 0) / n;
  const my = ys.reduce((a, y) => a + y, 0) / n;
  const SSx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (!SSx) return null;
  const SSxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const b = SSxy / SSx;
  const a_ = my - b * mx;
  const yhat = xs.map((x) => a_ + b * x);
  const SSres = ys.reduce((a, y, i) => a + (y - yhat[i]) ** 2, 0);
  const s = Math.sqrt(SSres / (n - 2));
  return { a: a_, b, mx, SSx, s, n };
}

function regCI(reg, x, z = 1.96) {
  const { a, b, mx, SSx, s, n } = reg;
  const yhat = a + b * x;
  const se = s * Math.sqrt(1 / n + (x - mx) ** 2 / SSx);
  return { yhat, lo: yhat - z * se, hi: yhat + z * se };
}

function pearsonR(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, x) => a + x, 0) / n;
  const my = ys.reduce((a, y) => a + y, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return dx && dy ? num / (dx * dy) : null;
}

function cmpMean(arr) {
  return arr.length
    ? ((arr.reduce((a, x) => a + x, 0) / arr.length) * 100).toFixed(1) + "%"
    : "—";
}

function cmpSD(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, x) => a + x, 0) / arr.length;
  return Math.sqrt(
    arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1),
  );
}

function cohenD(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const na = a.length,
    nb = b.length;
  const sda = cmpSD(a),
    sdb = cmpSD(b);
  const pooled = Math.sqrt(
    ((na - 1) * sda * sda + (nb - 1) * sdb * sdb) / (na + nb - 2),
  );
  if (!pooled) return null;
  const ma = a.reduce((s, x) => s + x, 0) / na;
  const mb = b.reduce((s, x) => s + x, 0) / nb;
  return (ma - mb) / pooled;
}

function effectSizeLabel(d) {
  const abs = Math.abs(d);
  if (abs < 0.2) return "negligible";
  if (abs < 0.5) return "small";
  if (abs < 0.8) return "medium";
  return "large";
}

function makeCompareHistChart(
  canvasId,
  countsA,
  countsB,
  labelA,
  labelB,
  onClickFn,
) {
  const N = 20;
  const edges = Array.from({ length: N + 1 }, (_, i) => i / N);
  const totalA = countsA.reduce((a, x) => a + x, 0) || 1;
  const totalB = countsB.reduce((a, x) => a + x, 0) || 1;
  const pctA = histPoints(countsA.map((c) => +((c / totalA) * 100).toFixed(2)), edges);
  const pctB = histPoints(countsB.map((c) => +((c / totalB) * 100).toFixed(2)), edges);
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "bar",
    data: {
      datasets: [
        {
          label: labelA,
          data: pctA,
          backgroundColor: UI.agree,
          borderWidth: 0,
          borderRadius: 2,
        },
        {
          label: labelB,
          data: pctB,
          backgroundColor: UI.expect,
          borderWidth: 0,
          borderRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      onClick: (evt, elements) => {
        if (elements.length && onClickFn) onClickFn(elements[0].index);
      },
      onHover: (evt, elements) => {
        if (evt.native)
          evt.native.target.style.cursor = elements.length
            ? "pointer"
            : "default";
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { font: CHART_FONT.legend, padding: 14, boxWidth: 14 },
        },
        tooltip: {
          callbacks: {
            title: (items) =>
              `Score: ${items[0].dataIndex * 5}% – ${items[0].dataIndex * 5 + 5}%`,
            label: (item) => `${item.dataset.label}: ${item.raw.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: histXScale("Commonsensicality score"),
        y: {
          title: { display: true, text: "Share of group", font: CHART_FONT.title },
          beginAtZero: true,
          grid: { color: UI.grid },
          ticks: { font: CHART_FONT.tick, callback: (v) => v + "%" },
        },
      },
    },
  });
}

function makeScatterChart(canvasId, paired, labelA, labelB, onClickFn) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const points = paired.map((p) => ({
    x: +(p.score_a * 100).toFixed(2),
    y: +(p.score_b * 100).toFixed(2),
    stmt: p.statement,
    opp: p.maj_a !== p.maj_b,
  }));

  // Regression + CI band
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const reg = linReg(xs, ys);
  const GRID = Array.from({ length: 51 }, (_, i) => i * 2); // 0, 2, …, 100
  const regLine = reg
    ? GRID.map((x) => ({ x, y: +(reg.a + reg.b * x).toFixed(2) }))
    : [];
  const ciHi = reg
    ? GRID.map((x) => ({ x, y: +regCI(reg, x).hi.toFixed(2) }))
    : [];
  const ciLo = reg
    ? GRID.map((x) => ({ x, y: +regCI(reg, x).lo.toFixed(2) }))
    : [];

  const lineBase = { type: "line", pointRadius: 0, fill: false };
  return new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        // 0: scatter points — faint so regression is readable
        // statements whose two majorities point opposite ways are red
        // (and drawn last, on top: loadGroupCompare() sorts them to the end)
        {
          label: "Statements",
          data: points,
          backgroundColor: points.map((p) => (p.opp ? UI.bad : UI.agreeDot)),
          borderColor: points.map((p) => (p.opp ? UI.surface : "transparent")),
          borderWidth: points.map((p) => (p.opp ? 1 : 0)),
          pointRadius: points.map((p) => (p.opp ? 6 : 5)),
          pointHoverRadius: 8,
        },
        // 1: y = x reference
        {
          ...lineBase,
          label: "y = x",
          data: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
          borderColor: UI.line,
          borderWidth: 1.5,
          borderDash: [6, 4],
        },
        // 2: 95% CI upper bound — fills DOWN to dataset 3 (lower bound)
        ...(reg
          ? [
              {
                ...lineBase,
                label: "95% CI",
                data: ciHi,
                borderColor: "transparent",
                backgroundColor: UI.agreeBand,
                fill: "+1",
              },
              // 3: 95% CI lower bound
              {
                ...lineBase,
                label: "",
                data: ciLo,
                borderColor: "transparent",
                backgroundColor: "transparent",
              },
              // 4: best-fit line
              {
                ...lineBase,
                label: "Best fit",
                data: regLine,
                borderColor: UI.agreeInk,
                borderWidth: 2,
              },
            ]
          : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        const hit = elements.find((e) => e.datasetIndex === 0);
        if (hit && onClickFn) onClickFn(paired[hit.index]);
      },
      onHover: (evt, elements) => {
        const isData = elements.some((e) => e.datasetIndex === 0);
        if (evt.native)
          evt.native.target.style.cursor = isData ? "pointer" : "default";
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              if (item.datasetIndex !== 0) return null;
              const p = item.raw;
              const s = p.stmt
                ? p.stmt.length > 70
                  ? p.stmt.slice(0, 70) + "…"
                  : p.stmt
                : "";
              const pr = paired[item.dataIndex];
              const side = (v) => (v ? "agrees" : "disagrees");
              return [
                s,
                `${labelA}: ${item.raw.x.toFixed(1)}%   ${labelB}: ${item.raw.y.toFixed(1)}%`,
                pr.maj_a === pr.maj_b
                  ? `Both majorities ${side(pr.maj_a)}`
                  : `Majority ${side(pr.maj_a)} in ${labelA}, ${side(pr.maj_b)} in ${labelB}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: -3,
          max: 103,
          title: { display: true, text: `${labelA} (%)`, font: CHART_FONT.title },
          grid: { color: UI.grid },
          ticks: { font: CHART_FONT.tick },
          afterBuildTicks: (axis) => {
            axis.ticks = [0, 20, 40, 60, 80, 100].map((v) => ({ value: v }));
          },
        },
        y: {
          type: "linear",
          min: -3,
          max: 103,
          title: { display: true, text: `${labelB} (%)`, font: CHART_FONT.title },
          grid: { color: UI.grid },
          ticks: { font: CHART_FONT.tick },
          afterBuildTicks: (axis) => {
            axis.ticks = [0, 20, 40, 60, 80, 100].map((v) => ({ value: v }));
          },
        },
      },
    },
  });
}

function cmpGroupHtml(items, label, color, rowFn) {
  const colorSolid = cmpInk(color);
  return `
    <div class="cmp-detail-group">
      <div class="cmp-detail-group-hd" style="color:${colorSolid}">
        ${esc(label)} &mdash; ${fmtNum(items.length)} ${items.length !== 1 ? "items" : "item"}
      </div>
      ${
        items.length
          ? `<table class="cmp-detail-table">${rowFn(items)}</table>`
          : '<p class="cmp-detail-empty">None in this range.</p>'
      }
    </div>`;
}

// ── Group Comparison detail lists ─────────────────────────────────────────
// 25 rows a page per group (one pager drives both columns), so the panel
// scrolls as one page instead of the list scrolling inside its card.
function cmpPagerHtml(page, pages, bottom = false) {
  if (pages <= 1) return "";
  return (
    `<div class="table-nav-row cmp-detail-pager${bottom ? " cmp-detail-pager-bottom" : ""}"><div class="pagination">` +
    `<button class="page-btn" type="button" data-pg="${page - 1}"${page <= 1 ? " disabled" : ""} aria-label="Previous page">&#8249;</button>` +
    `<span class="page-info">Page ${fmtNum(page)} of ${fmtNum(pages)}</span>` +
    `<button class="page-btn" type="button" data-pg="${page + 1}"${page >= pages ? " disabled" : ""} aria-label="Next page">&#8250;</button>` +
    `</div></div>`
  );
}

function cmpBindPager(content, rerender) {
  content.querySelectorAll("[data-pg]").forEach((b) =>
    b.addEventListener("click", () => {
      const fromBottom = !!b.closest(".cmp-detail-pager-bottom");
      rerender(Number(b.dataset.pg));
      if (fromBottom) revealTableTop(document.getElementById("compareDetailTitle"));
    }),
  );
}

// After a click on a chart, bring the detail card into view if it is not
function cmpRevealDetail() {
  const sc = document.getElementById("compareWrap");
  const card = document.querySelector("#panelCompare .compare-detail-card");
  const r = card.getBoundingClientRect(), s = sc.getBoundingClientRect();
  if (r.top < s.top || r.top > s.bottom - 120) sc.scrollTop += r.top - s.top - 8;
}

function renderCmpIndivDetail(binIdx, page = 1) {
  if (!cmpData) return;
  const N = 20,
    lo = binIdx * 5,
    hi = lo + 5;
  const rangeLabel = binIdx === N - 1 ? `${lo}% – 100%` : `${lo}% – ${hi}%`;
  const inBin = (arr) =>
    arr
      .filter((x) => {
        const p = x.score * 100;
        return p >= lo && (binIdx === N - 1 ? p <= 100 : p < hi);
      })
      .sort((a, b) => b.score - a.score);
  const ga = inBin(cmpData.individuals.a);
  const gb = inBin(cmpData.individuals.b);
  const pages = Math.max(1, Math.ceil(Math.max(ga.length, gb.length) / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * PAGE_SIZE;

  const colHtml = (items, label, color, groupVal) => {
    const colorSolid = cmpInk(color);
    const rows = items
      .slice(start, start + PAGE_SIZE)
      .map(
        (x) =>
          `<tr class="cmp-user-row" data-uid="${esc(x.userId)}" data-group="${esc(groupVal)}" data-consensus="${x.consensus}" data-awareness="${x.awareness}" data-score="${x.score}" style="cursor:pointer">` +
          `<td class="cmp-mono">${esc(x.userId.slice(0, 8))}…</td>` +
          `<td class="cmp-score-cell">${(x.score * 100).toFixed(1)}%</td></tr>`,
      )
      .join("");
    return `
      <div class="cmp-detail-col">
        <div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)} &mdash; ${fmtNum(items.length)}</div>
        ${
          !items.length
            ? '<p class="cmp-detail-empty">None in this range.</p>'
            : !rows
            ? '<p class="cmp-detail-empty">No more in this range.</p>'
            : `<table class="cmp-detail-table">
               <colgroup><col><col style="width:68px"></colgroup>
               <thead><tr><th>Participant</th><th style="text-align:right">Score</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
        }
      </div>`;
  };

  document.getElementById("compareDetailTitle").textContent =
    `Individual scores: ${rangeLabel}`;
  const content = document.getElementById("compareDetailContent");
  content.innerHTML =
    cmpPagerHtml(page, pages) +
    `<div class="cmp-detail-cols">${colHtml(ga, cmpLabelA, CMP_COLOR_A, cmpGroupA)}${colHtml(gb, cmpLabelB, CMP_COLOR_B, cmpGroupB)}</div>` +
    cmpPagerHtml(page, pages, true);
  cmpBindPager(content, (p) => renderCmpIndivDetail(binIdx, p));

  content.querySelectorAll(".cmp-user-row").forEach((tr) => {
    tr.addEventListener("mouseenter", () => (tr.style.background = "var(--c-accent-bg)"));
    tr.addEventListener("mouseleave", () => (tr.style.background = ""));
    tr.addEventListener("click", () => {
      openUserDetail(
        {
          sessionId: tr.dataset.uid,
          consensus: +tr.dataset.consensus,
          awareness: +tr.dataset.awareness,
          commonsensicality: +tr.dataset.score,
        },
        { reference: tr.dataset.group, target: tr.dataset.group },
      );
    });
  });
}

function renderCmpStmtDetail(binIdx, page = 1) {
  if (!cmpData) return;
  const N = 20,
    lo = binIdx * 5,
    hi = lo + 5;
  const rangeLabel = binIdx === N - 1 ? `${lo}% – 100%` : `${lo}% – ${hi}%`;
  const inBin = (arr) =>
    arr
      .filter((x) => {
        const p = x.score * 100;
        return p >= lo && (binIdx === N - 1 ? p <= 100 : p < hi);
      })
      .sort((a, b) => b.score - a.score);
  const ga = inBin(cmpData.statements.a);
  const gb = inBin(cmpData.statements.b);
  const pages = Math.max(1, Math.ceil(Math.max(ga.length, gb.length) / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * PAGE_SIZE;

  const colHtml = (items, label, color, groupVal) => {
    const colorSolid = cmpInk(color);
    const rows = items
      .slice(start, start + PAGE_SIZE)
      .map((x, j) => {
        const i = start + j; // index into the full list, for the click handler
        const fixed = fixStatement(x.statement);
        const snip = fixed.length > 60 ? fixed.slice(0, 57) + "…" : fixed;
        return (
          `<tr class="cmp-stmt-row" data-idx="${i}" data-group="${esc(groupVal)}" style="cursor:pointer">` +
          `<td class="cmp-stmt-snip">${esc(snip)}</td>` +
          `<td class="cmp-score-cell">${(x.score * 100).toFixed(1)}%</td></tr>`
        );
      })
      .join("");
    return `
      <div class="cmp-detail-col">
        <div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)} &mdash; ${fmtNum(items.length)}</div>
        ${
          !items.length
            ? '<p class="cmp-detail-empty">None in this range.</p>'
            : !rows
            ? '<p class="cmp-detail-empty">No more in this range.</p>'
            : `<table class="cmp-detail-table">
               <colgroup><col><col style="width:68px"></colgroup>
               <thead><tr><th>Statement</th><th style="text-align:right">Score</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
        }
      </div>`;
  };

  document.getElementById("compareDetailTitle").textContent =
    `Statement scores: ${rangeLabel}`;
  const content = document.getElementById("compareDetailContent");
  content.innerHTML =
    cmpPagerHtml(page, pages) +
    `<div class="cmp-detail-cols">${colHtml(ga, cmpLabelA, CMP_COLOR_A, cmpGroupA)}${colHtml(gb, cmpLabelB, CMP_COLOR_B, cmpGroupB)}</div>` +
    cmpPagerHtml(page, pages, true);
  cmpBindPager(content, (p) => renderCmpStmtDetail(binIdx, p));

  const itemsByGroup = { [cmpGroupA]: ga, [cmpGroupB]: gb };
  content.querySelectorAll(".cmp-stmt-row").forEach((tr) => {
    tr.addEventListener("mouseenter", () => (tr.style.background = "var(--c-accent-bg)"));
    tr.addEventListener("mouseleave", () => (tr.style.background = ""));
    tr.addEventListener("click", () => {
      const items = itemsByGroup[tr.dataset.group];
      const x = items[+tr.dataset.idx];
      openStmtDetail(x, tr.dataset.group);
    });
  });
}

function stmtScoreColHtml(x, label, color) {
  const colorSolid = cmpInk(color);
  if (!x)
    return `<div class="cmp-detail-col"><div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)}</div><p class="cmp-detail-empty">No data for this group.</p></div>`;
  const N = x.n_ratings;
  const A = x.I_agree_mean;
  const B = x.others_agree_mean;
  const majYes = A >= 0.5;
  const fp = (v) => (v * 100).toFixed(1) + "%";
  const consensus = 2 * Math.abs(A - 0.5);
  const awareness = majYes ? B : 1 - B;
  const comm = Math.sqrt(consensus * awareness);
  return `
    <div class="cmp-detail-col">
      <div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)}</div>
      <ul class="cmp-score-expl">
        <li><strong>N</strong> = ${fmtNum(N)} ratings</li>
        <li><strong>Agree</strong>: ${fp(A)} &rarr; the majority <strong>${majYes ? "agrees" : "disagrees"}</strong></li>
        <li><strong>Consensus</strong>: 2&thinsp;&times;&thinsp;|${fp(A)}&thinsp;&minus;&thinsp;50%| = <strong>${fp(consensus)}</strong></li>
        <li><strong>Think most agree</strong>: ${fp(B)} &rarr; <strong>awareness</strong> = <strong>${fp(awareness)}</strong></li>
        <li><strong>Commonsensicality</strong>: ${sqrtHtml(`${fp(consensus)}&thinsp;&times;&thinsp;${fp(awareness)}`)} = <strong>${fp(comm)}</strong></li>
      </ul>
    </div>`;
}

function stmtPropsHtml(statementId) {
  const row = stmtScoresAllRows.find((r) => r.statementId === statementId);
  if (!row) return "";
  const rows = PROP_DEFS.map(({ key, v1, v0 }) => {
    const val = row[key];
    if (val === null || val === undefined)
      return `<tr><td class="cmp-prop-name">${esc(v1)} / ${esc(v0)}</td><td class="cmp-prop-val">—</td></tr>`;
    const label = val === 1 ? v1 : v0;
    const dot =
      val === 1
        ? `<span class="popup-circle-filled">●</span>`
        : `<span class="popup-circle-empty">○</span>`;
    return `<tr><td class="cmp-prop-name">${esc(v1)} / ${esc(v0)}</td><td class="cmp-prop-val">${dot} ${esc(label)}</td></tr>`;
  }).join("");
  return `
    <div class="cmp-props-section">
      <div class="cmp-props-title">Statement features</div>
      <table class="cmp-props-table"><tbody>${rows}</tbody></table>
    </div>`;
}

// Statements scored in both groups whose majorities point opposite ways,
// largest difference in the share who agree first (cmpOpposite, set in
// loadGroupCompare()), 25 a page
let cmpOpposite = [];
function renderCmpOppDetail(page = 1) {
  const items = cmpOpposite;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * PAGE_SIZE;
  const bar = (v, color) =>
    `<span class="cmp-opp-bar"><span class="cmp-opp-fill" style="width:${(v * 100).toFixed(1)}%;background:${color}"></span></span>` +
    `<span class="cmp-opp-val">${(v * 100).toFixed(0)}%</span>`;
  const rows = items.slice(start, start + PAGE_SIZE).map((p, j) =>
    `<tr class="cmp-opp-row" data-idx="${start + j}" style="cursor:pointer">` +
    `<td class="cmp-stmt-snip">${esc(fixStatement(p.statement))}</td>` +
    `<td class="cmp-opp-cell">${bar(p.p_a, CMP_COLOR_A)}</td>` +
    `<td class="cmp-opp-cell">${bar(p.p_b, CMP_COLOR_B)}</td></tr>`,
  ).join("");
  document.getElementById("compareDetailTitle").textContent = `Opposite majorities: ${fmtNum(items.length)} statements`;
  const content = document.getElementById("compareDetailContent");
  content.innerHTML =
    `<p class="cmp-opp-intro">The share who agree in each group; the line marks 50%, and an exact 50/50 split counts as agreeing, as everywhere in the explorer. Click a statement for both calculations. With few ratings, a share near 50% can land on either side by chance.</p>` +
    cmpPagerHtml(page, pages) +
    `<table class="cmp-detail-table cmp-opp-table"><colgroup><col><col style="width:30%"><col style="width:30%"></colgroup>` +
    `<thead><tr><th>Statement</th><th>${esc(cmpLabelA)}</th><th>${esc(cmpLabelB)}</th></tr></thead><tbody>${rows}</tbody></table>` +
    cmpPagerHtml(page, pages, true);
  cmpBindPager(content, (pg) => renderCmpOppDetail(pg));
  content.querySelectorAll(".cmp-opp-row").forEach((tr) =>
    tr.addEventListener("click", () => renderScatterDetail(items[+tr.dataset.idx])),
  );
}

function renderScatterDetail(point) {
  const findStmt = (arr, sid) => arr.find((x) => x.statementId === sid);
  const xa = cmpData ? findStmt(cmpData.statements.a, point.statementId) : null;
  const xb = cmpData ? findStmt(cmpData.statements.b, point.statementId) : null;
  const stmt = fixStatement(point.statement || "");
  document.getElementById("compareDetailTitle").textContent =
    "Statement score comparison";
  document.getElementById("compareDetailContent").innerHTML = `
    <p class="cmp-detail-stmt-text">${esc(stmt)}</p>
    <div class="cmp-detail-cols">
      ${stmtScoreColHtml(xa, cmpLabelA, CMP_COLOR_A)}
      ${stmtScoreColHtml(xb, cmpLabelB, CMP_COLOR_B)}
    </div>
    ${stmtPropsHtml(point.statementId)}`;
}

async function loadGroupCompare() {
  const groupA = compareGroupAEl.value;
  const groupB = compareGroupBEl.value;
  const labelA = groupA === "all" ? "All countries" : groupA;
  const labelB = groupB === "all" ? "All countries" : groupB;
  notifyIntro("compare", null, { groupA, groupB });

  compareSpinnerEl.classList.remove("hidden");
  const req = ++cmpReq;
  let data;
  try {
    data = await fetch(
      `${API}/group-compare?groupA=${encodeURIComponent(groupA)}&groupB=${encodeURIComponent(groupB)}${dateParams()}`,
    ).then((r) => r.json());
  } catch {
    if (req === cmpReq) compareSpinnerEl.classList.add("hidden");
    return;
  }
  if (req !== cmpReq) return; // the groups changed while this was loading
  compareSpinnerEl.classList.add("hidden");

  // Store globally for detail rendering
  cmpData = data;
  cmpLabelA = labelA;
  cmpLabelB = labelB;
  cmpGroupA = groupA;
  cmpGroupB = groupB;

  // Helper: extract plain score arrays from enriched objects
  const scores = (arr) => arr.map((x) => x.score);

  // Section 1: Individual commonsensicality
  const ia = data.individuals.a,
    ib = data.individuals.b;
  const iaS = scores(ia),
    ibS = scores(ib);
  const rawNA = data.individuals.raw_n_a;
  const rawNB = data.individuals.raw_n_b;
  const swatch = (c) => `<span style="color:${c}" aria-hidden="true">■</span>`;
  const cmpLine = (color, label, n, noun, mean) =>
    `${swatch(color)} <strong>${esc(label)}</strong>: ${fmtNum(n)} ${noun}, mean ${mean}`;
  // Who has no score in each group (fewer than 5 statements with 10+ ratings there)
  const outA = rawNA != null ? rawNA - ia.length : 0;
  const outB = rawNB != null ? rawNB - ib.length : 0;
  const outParts = [];
  if (outA > 0) outParts.push(`${fmtNum(outA)} in ${esc(labelA)}`);
  if (outB > 0) outParts.push(`${fmtNum(outB)} in ${esc(labelB)}`);
  const cmpOutNote = outParts.length
    ? ` Not shown: ${outParts.join(" and ")}, with fewer than 5 statements that count (10+ ratings) in their own group.`
    : "";
  // "All countries" contains the other group whenever it is compared with a single country
  const cmpOverlap =
    (groupA === "all") !== (groupB === "all")
      ? ` All countries includes everyone in ${esc(groupA === "all" ? labelB : labelA)}, so the groups overlap.`
      : "";
  // A person's score depends on which statements they rated; say so when
  // the groups' statements differ (the Statement Scores card compares them)
  const nPaired = data.statements.paired.length;
  const nSa = data.statements.a.length, nSb = data.statements.b.length;
  const cmpItemsNote = groupA !== groupB && nPaired < Math.max(nSa, nSb)
    ? ` The groups rated different statements (${fmtNum(nPaired)} are scored in both), so part of a gap can come from which statements each saw.`
    : "";
  document.getElementById("compareIndivSub").innerHTML =
    cmpLine(CMP_COLOR_A, labelA, ia.length, "participants", cmpMean(iaS)) + " &nbsp;·&nbsp; " +
    cmpLine(CMP_COLOR_B, labelB, ib.length, "participants", cmpMean(ibS)) +
    `<span class="cmp-filter-note">Each group is scored against its own majority` +
    (groupA === "all" || groupB === "all" ? " (for All countries, everyone's pooled majority)" : "") +
    `.${cmpOverlap}${cmpOutNote}${cmpItemsNote}</span>`;
  const dIndiv = cohenD(iaS, ibS);
  // Say which group is higher, and how big the gap is (Cohen's conventions)
  document.getElementById("compareIndivEffect").innerHTML =
    dIndiv === null
      ? ""
      : Math.abs(dIndiv) < 0.2
        ? `Gap between the means: Cohen's <em>d</em> = ${Math.abs(dIndiv).toFixed(2)} (negligible)`
        : `<strong>${esc(dIndiv > 0 ? labelA : labelB)}</strong> scores higher: Cohen's <em>d</em> = <strong>${Math.abs(dIndiv).toFixed(2)}</strong> (${effectSizeLabel(dIndiv)})`;
  if (compareIndivChartInst) compareIndivChartInst.destroy();
  compareIndivChartInst = makeCompareHistChart(
    "compareIndivChart",
    cmpBinScores(iaS),
    cmpBinScores(ibS),
    labelA,
    labelB,
    (binIdx) => { renderCmpIndivDetail(binIdx); cmpRevealDetail(); },
  );

  // Section 2: Statement commonsensicality distributions
  const sa = data.statements.a,
    sb = data.statements.b;
  const saS = scores(sa),
    sbS = scores(sb);
  // Like for like: the two groups rated different statements, so their
  // means above mix a difference in views with a difference in statements
  const pairedAll = data.statements.paired;
  const likeForLike = pairedAll.length && (pairedAll.length < sa.length || pairedAll.length < sb.length)
    ? `On the <strong>${fmtNum(pairedAll.length)}</strong> statements scored in both, the mean is ` +
      `<strong>${cmpMean(pairedAll.map((p) => p.score_a))}</strong> in ${esc(labelA)} and <strong>${cmpMean(pairedAll.map((p) => p.score_b))}</strong> in ${esc(labelB)}.`
    : "";
  document.getElementById("compareStmtSub").innerHTML =
    cmpLine(CMP_COLOR_A, labelA, sa.length, "statements", cmpMean(saS)) + " &nbsp;·&nbsp; " +
    cmpLine(CMP_COLOR_B, labelB, sb.length, "statements", cmpMean(sbS)) +
    `<span class="cmp-filter-note">A statement is scored in a group once it has at least 10 ratings there.</span>`;
  document.getElementById("compareStmtEffect").innerHTML = likeForLike;
  if (compareStmtChartInst) compareStmtChartInst.destroy();
  compareStmtChartInst = makeCompareHistChart(
    "compareStmtChart",
    cmpBinScores(saS),
    cmpBinScores(sbS),
    labelA,
    labelB,
    (binIdx) => { renderCmpStmtDetail(binIdx); cmpRevealDetail(); },
  );

  // Section 3: Scatter plot of paired statement scores, with the statements
  // whose majorities point opposite ways last, so their dots are drawn on top
  const paired = [...data.statements.paired].sort(
    (x, y) => Number(x.maj_a !== x.maj_b) - Number(y.maj_a !== y.maj_b),
  );
  cmpOpposite = paired
    .filter((p) => p.maj_a !== p.maj_b)
    .sort((x, y) => Math.abs(y.p_a - y.p_b) - Math.abs(x.p_a - x.p_b));
  const r =
    paired.length >= 2
      ? pearsonR(
          paired.map((p) => p.score_a),
          paired.map((p) => p.score_b),
        )
      : null;
  const nOpp = cmpOpposite.length;
  document.getElementById("compareScatterSub").innerHTML =
    `${fmtNum(paired.length)} statements scored in both groups` +
    (r !== null
      ? ` &nbsp;·&nbsp; Pearson <em>r</em> = <strong>${fmtR(r)}</strong>`
      : "") +
    (paired.length
      ? `<span class="cmp-opp-line"><span class="cmp-opp-key" aria-hidden="true"></span>` +
        (nOpp
          ? `On <strong>${fmtNum(nOpp)}</strong> of them (${(100 * nOpp / paired.length).toFixed(1)}%) the two majorities point opposite ways. ` +
            `<button type="button" class="cmp-opp-btn" id="cmpOppBtn">List them</button>`
          : `On none of them do the two majorities point opposite ways.`) +
        `</span>`
      : "") +
    `<span class="cmp-filter-note">Dots above the dashed line score higher in ${esc(labelB)}. Click a dot to compare the two majorities.</span>`;
  const oppBtn = document.getElementById("cmpOppBtn");
  if (oppBtn) oppBtn.addEventListener("click", () => { renderCmpOppDetail(); cmpRevealDetail(); });
  if (compareScatterChartInst) compareScatterChartInst.destroy();
  compareScatterChartInst = paired.length
    ? makeScatterChart("compareScatterChart", paired, labelA, labelB, (point) => {
        renderScatterDetail(point);
        cmpRevealDetail();
      })
    : null;

  // Reset detail panel when groups change
  document.getElementById("compareDetailTitle").textContent = "Details";
  document.getElementById("compareDetailContent").innerHTML = CMP_DETAIL_PLACEHOLDER;
}

compareGroupAEl.addEventListener("change", loadGroupCompare);
compareGroupBEl.addEventListener("change", loadGroupCompare);

document.getElementById('btnCmPrev').addEventListener('click', () => {
  if (cmPage > 1) { cmPage--; renderCmPage(); }
});
document.getElementById('btnCmNext').addEventListener('click', () => {
  if (cmPage < cmTotalPages()) { cmPage++; renderCmPage(); }
});

mirrorPager(btnScoresPrev.parentElement, document.querySelector("#panelScores .table-scroll-wrap"));
mirrorPager(btnStmtScoresPrev.parentElement, document.querySelector("#panelStmtScores .table-scroll-wrap"));
cmInitScroll();

async function init() {
  await populateSelects();
  loadStmtScores("all");
  loadGroupCompare();
  // Load home map if not already triggered by switchToTab at startup
  if (!_homeMapLoaded && _initialTab === "home") { _homeMapLoaded = true; loadHomeMap(); }
}

init();

