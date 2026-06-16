'use strict';

const PAGE_SIZE = 25;

// ── DOM refs ───────────────────────────────────────────────────────────────

// Modal
const userModal          = document.getElementById('userModal');
const modalExplanation   = document.getElementById('modalExplanation');
const stmtModal          = document.getElementById('stmtModal');
const stmtModalClose     = document.getElementById('stmtModalClose');
const stmtPropsModal     = document.getElementById('stmtPropsModal');
const stmtPropsClose     = document.getElementById('stmtPropsClose');
const modalUserId     = document.getElementById('modalUserId');
const modalUserScores = document.getElementById('modalUserScores');
const modalBody       = document.getElementById('modalBody');
const modalClose      = document.getElementById('modalClose');

// Statement Scores tab
const stmtScoresCountrySelect = document.getElementById('stmtScoresCountrySelect');
const dpCountrySelect         = document.getElementById('dpCountrySelect');
const stmtScoresSummaryEl     = document.getElementById('stmtScoresSummary');
const stmtScoresSpinnerEl     = document.getElementById('stmtScoresSpinner');
const stmtScoresBody          = document.getElementById('stmtScoresBody');
const btnStmtScoresPrev       = document.getElementById('btnStmtScoresPrev');
const btnStmtScoresNext       = document.getElementById('btnStmtScoresNext');
const stmtScoresPageInfoEl    = document.getElementById('stmtScoresPageInfo');
const stmtScoresFilterLabel   = document.getElementById('stmtScoresFilterLabel');

// Scores tab
const targetSelect      = document.getElementById('targetSelect');
const referenceSelect   = document.getElementById('referenceSelect');
const scoresSpinnerEl   = document.getElementById('scoresSpinner');
const scoresBody        = document.getElementById('scoresBody');
const btnScoresPrev     = document.getElementById('btnScoresPrev');
const btnScoresNext     = document.getElementById('btnScoresNext');
const scoresPageInfoEl  = document.getElementById('scoresPageInfo');
const scoresFilterLabel = document.getElementById('scoresFilterLabel');

// ── State ──────────────────────────────────────────────────────────────────

// Scores
let allScoresRows = [];   // raw from API, never mutated
let scoresRows    = [];   // current view: filtered + sorted slice of allScoresRows
let scoresPage    = 1;
let scoresLoaded  = false;

// Scores: sort
let sortKey = 'commonsensicality';
let sortDir = 'desc';

// Scores: histogram bin filter
let activeBinIdx = null;  // null = no filter

// Histogram
let histChart    = null;
let histBinEdges = [];

// Statement Scores
let stmtScoresAllRows    = [], stmtScoresRows = [], stmtScoresPage = 1;
let stmtScoresLoaded     = false;
let dpPanelLoaded        = false;
let stmtScoresSortKey    = 'commonsensicality', stmtScoresSortDir = 'desc';
let stmtScoresActiveBinIdx = null;
let stmtScoresHistChart  = null, stmtScoresHistBinEdges = [];

// ── Design-point constants ─────────────────────────────────────────────────
const DP_PROPS = [
  { key: 'fact',             label: 'Fact'             },
  { key: 'physical',         label: 'Physical'         },
  { key: 'literal_language', label: 'Literal language', labelHtml: 'Literal<br>language' },
  { key: 'positive',         label: 'Positive'         },
  { key: 'knowledge',        label: 'Knowledge'        },
  { key: 'everyday',         label: 'Everyday'         },
];
const DP_W = 280, DP_H = 18, DP_PAD = 12;
const DP_PW = DP_W - DP_PAD * 2;  // inner plot width

// Property filter definitions (value 1 = first label, 0 = second label)
const PROP_DEFS = [
  { key: 'fact',             v1: 'Fact',             v0: 'Opinion',
    def1: 'Something that can be demonstrated to be correct or incorrect, independently of anyone\'s opinion.',
    def0: 'Something that someone might think is true, or wants others to think is true, but can\'t be demonstrated to be objectively correct or incorrect. That is, it is inherently subjective.' },
  { key: 'physical',         v1: 'Physical',         v0: 'Social',
    def1: 'It refers to objective features of the world as described by, say, physics, biology, engineering, mathematics or other natural rules. It can be measured empirically, or derived logically.',
    def0: 'It refers to beliefs, perceptions, preferences, and socially constructed rules that govern human experience. It can be "real" or opinion, but is intrinsically of human origins.' },
  { key: 'literal_language', v1: 'Literal language', v0: 'Figure of speech',
    def1: 'It is plain and ordinary language that means exactly what it says.',
    def0: 'It contains an aphorism, metaphor, hyperbole, etc.' },
  { key: 'positive',         v1: 'Positive',         v0: 'Normative',
    def1: 'It refers to something in the world such as an empirical regularity or scientific law.',
    def0: 'It refers to a judgment, belief, value, social norm or convention.' },
  { key: 'knowledge',        v1: 'Knowledge',        v0: 'Reasoning',
    def1: 'It refers to some observation about the world; it may be true or false, opinion or fact, subjective or objective.',
    def0: 'It presents a conclusion that is arrived at by combining knowledge and logic.' },
  { key: 'everyday',         v1: 'Everyday',         v0: 'Abstract',
    def1: 'It is about something people encounter, or could encounter, situations like this in the course of their ordinary, everyday experiences.',
    def0: 'It refers to regularities or conclusions that cannot be observed or arrived at solely through individual experience.' },
];
// State: { v1: bool, v0: bool }. Both false OR both true = no filter.
const ssPropFilters   = Object.fromEntries(PROP_DEFS.map(d => [d.key, { v1: false, v0: false }]));

// Statement search queries
let stmtScoresSearchQuery = '';
let dpDetailSearchQuery   = '';

// ── Utilities ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pctBar(value) {
  const pct = (value * 100).toFixed(1);
  const cls = value >= 0.5 ? 'pct-fill-high' : 'pct-fill-low';
  return `<div class="pct-wrap">` +
    `<div class="pct-track"><div class="${cls}" style="width:${pct}%"></div></div>` +
    `<span class="pct-label">${pct}%</span></div>`;
}

function pctBarScore(value) {
  const pct = (value * 100).toFixed(1);
  return `<div class="pct-wrap">` +
    `<div class="pct-track"><div class="pct-fill-score" style="width:${pct}%"></div></div>` +
    `<span class="pct-label">${pct}%</span></div>`;
}

function fmtNum(n) { return n.toLocaleString(); }
function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }

function badge(value) {
  return value === 1
    ? '<span class="badge-yes">Yes</span>'
    : '<span class="badge-no">No</span>';
}

function refAvgAgree(mean) {
  if (mean === null || mean === undefined) return '—';
  const verdict = mean >= 0.5
    ? ' <span class="badge-yes">Yes</span>'
    : ' <span class="badge-no">No</span>';
  return fmtPct(mean) + verdict;
}

function refAvgOthers(mean) {
  return (mean === null || mean === undefined) ? '—' : fmtPct(mean);
}

function openStmtDetail(row, country) {
  document.getElementById('stmtModalText').textContent = fixStatement(row.statement);

  const N = row.n_ratings;
  const A = row.I_agree_mean;       // fraction 0-1
  const B = row.others_agree_mean;  // fraction 0-1
  const majorityYes = A >= 0.5;
  const fp = v => (v * 100).toFixed(1) + '%';

  // Consensus = 2 × |A − 0.5|
  const consensus = 2 * Math.abs(A - 0.5);
  const consFormula = `2 × |${fp(A)} − 50%| = 2 × ${fp(Math.abs(A - 0.5))} = <strong>${fp(consensus)}</strong>`;

  // Awareness: B if majority Yes, else 1 − B
  const awareness = majorityYes ? B : 1 - B;
  const awarenessText = majorityYes
    ? `Of the ${fmtNum(N)} individuals, <strong>${fp(B)}</strong> of them predicted that most people would agree with the statement (via the <em>Others agree</em> column). Since the majority opinion is "Yes", these ${fp(B)} correctly predicted the majority. Thus, the <strong>awareness</strong> score is <strong>${fp(awareness)}</strong>.`
    : `Of the ${fmtNum(N)} individuals, <strong>${fp(B)}</strong> of them predicted that most people would agree. Since the majority opinion is "No", the remaining <strong>${fp(1 - B)}</strong> who predicted "No" correctly predicted the majority. Thus, the <strong>awareness</strong> score is <strong>${fp(awareness)}</strong>.`;

  const commonsensicality = Math.sqrt(consensus * awareness);
  const c = country !== undefined ? country : stmtScoresCountrySelect.value;
  const groupLabel = c === 'all' ? 'all countries' : c;

  document.getElementById('stmtModalExplanation').innerHTML =
    `<p class="expl-context">The following calculation of this statement's commonsensicality score is relative to the target group, <strong>${esc(groupLabel)}</strong>.</p>` +
    `<ul class="expl-list">` +
    `<li>Within this group, this statement has received a total of <strong>${fmtNum(N)}</strong> rating${N !== 1 ? 's' : ''}.</li>` +
    `<li>Of the <strong>${fmtNum(N)}</strong> individuals who rated the statement, <strong>${fp(A)}</strong> of them agreed with it (via the <em>I agree</em> column). Since ${fp(A)} ${majorityYes ? '≥' : '<'} 50%, the majority opinion is <strong>"${majorityYes ? 'Yes' : 'No'}"</strong> — most people ${majorityYes ? 'agreed with' : 'disagreed with'} the statement.</li>` +
    `<li>Since ${fp(A)} of people agreed, the <strong>consensus</strong> score is ${consFormula}.</li>` +
    `<li>${awarenessText}</li>` +
    `<li>The <strong>commonsensicality</strong> score is the geometric mean of consensus and awareness: √(${fp(consensus)} × ${fp(awareness)}) = <strong>${fp(commonsensicality)}</strong>.</li>` +
    `</ul>`;

  stmtModal.classList.remove('hidden');
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
  return rows.filter(row => {
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
  if (s[0] >= 'a' && s[0] <= 'z') s = s[0].toUpperCase() + s.slice(1);
  // Add period if the statement doesn't already end with sentence punctuation
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    try {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('panelScores').classList.toggle('hidden', tab !== 'scores');
    document.getElementById('panelStmtScores').classList.toggle('hidden', tab !== 'stmtScores');
    document.getElementById('panelDP').classList.toggle('hidden', tab !== 'dp');
    document.getElementById('panelCompare').classList.toggle('hidden', tab !== 'compare');
    if (tab === 'scores' && !scoresLoaded) {
      scoresLoaded = true;
      loadScores('all', 'all');
    }
    if (tab === 'dp' && !dpPanelLoaded) {
      dpPanelLoaded = true;
      loadDesignPoints('all');
    }
    } catch (err) {
      console.error('Tab switch error:', err);
      alert('Page is outdated — please hard-refresh (Cmd+Shift+R / Ctrl+Shift+R) and try again.\n\n' + err.message);
    }
  });
});

// ── Country dropdowns ──────────────────────────────────────────────────────

async function populateSelects() {
  const countries = await fetch('/api/countries').then(r => r.json());
  countries.sort((a, b) => b.n_users - a.n_users);
  [targetSelect, referenceSelect, stmtScoresCountrySelect, dpCountrySelect, compareGroupAEl, compareGroupBEl].forEach(sel => {
    countries.forEach(({ country, n_users }) => {
      const opt = document.createElement('option');
      opt.value = country;
      opt.textContent = `${country} (${fmtNum(n_users)})`;
      sel.appendChild(opt);
    });
  });
  compareGroupAEl.value = 'United States';
  compareGroupBEl.value = 'India';
}

// ── User detail modal ──────────────────────────────────────────────────────

async function openUserDetail(userRow, opts = {}) {
  modalUserId.textContent = userRow.userSessionId;
  modalUserScores.textContent =
    `Consensus: ${fmtPct(userRow.consensus)} · ` +
    `Awareness: ${fmtPct(userRow.awareness)} · ` +
    `Commonsensicality: ${fmtPct(userRow.commonsensicality)}`;
  modalBody.innerHTML = '<tr><td colspan="5" class="empty-row">Loading…</td></tr>';
  modalExplanation.classList.add('hidden');
  userModal.classList.remove('hidden');

  const reference = opts.reference !== undefined ? opts.reference : referenceSelect.value;
  const target    = opts.target    !== undefined ? opts.target    : targetSelect.value;
  const url = `/api/user-detail?userId=${encodeURIComponent(userRow.userSessionId)}&reference=${encodeURIComponent(reference)}&target=${encodeURIComponent(target)}`;
  let data;
  try {
    data = await fetch(url).then(r => r.json());
  } catch {
    modalBody.innerHTML = '<tr><td colspan="5" class="empty-row">Failed to load.</td></tr>';
    return;
  }

  if (!data.rows.length) {
    modalBody.innerHTML = '<tr><td colspan="5" class="empty-row">No ratings found.</td></tr>';
    modalExplanation.classList.add('hidden');
    return;
  }

  // ── Score explanation — use server-computed values that match the scoring algorithm
  const refLabel    = reference === 'all' ? 'all countries' : reference;
  const targetLabel = target    === 'all' ? 'all countries' : target;
  const N_total   = data.rows.length;   // all statements the user rated
  const N         = data.n_scoring;     // qualifying statements used in calculation
  const A         = data.A;
  const B         = data.B;
  const consFrac  = N > 0 ? A / N : 0;
  const awareFrac = N > 0 ? B / N : 0;
  const commsFrac = Math.sqrt(consFrac * awareFrac);
  const fp = v => (v * 100).toFixed(1) + '%';

  const qualifyingNote = (N_total > N || data.disqualified)
    ? `In calculating the commonsensicality score, we require that every eligible statement was rated at least 5 times in the reference group (<strong>${esc(refLabel)}</strong>). Only <strong>${N}</strong> out of <strong>${N_total}</strong> statements qualify.` +
      (data.disqualified
        ? ` Since fewer than 5 statements qualify (minimum required), <strong>this user is excluded from the commonsensicality calculation</strong>.`
        : ` The calculation below is based on these <strong>${N}</strong> statements.`)
    : null;

  modalExplanation.innerHTML =
    `<p class="expl-context">The calculation of this user's commonsensicality score is based on the fact that the user, who is in the <strong>${esc(targetLabel)}</strong> group, is being measured relative to the <strong>${esc(refLabel)}</strong> group.</p>` +
    `<ul class="expl-list">` +
    `<li>This user has rated a total of <strong>${N_total}</strong> statement${N_total !== 1 ? 's' : ''}. See the table below.` +
    (qualifyingNote ? `<br><br>${qualifyingNote}` : '') +
    `</li>` +
    `<li>For each statement, we determine the majority opinion in the reference group (<strong>${esc(refLabel)}</strong>) via the <em>Ref. avg. agree</em> column: if ≥ 50%, the majority agrees; otherwise, the majority disagrees.</li>` +
    `<li>Of all <strong>${N}</strong> statements:` +
    `<ul>` +
    `<li>There ${A === 1 ? 'is' : 'are'} <strong>${A}</strong> statement${A !== 1 ? 's' : ''} for which the user's opinion (<em>I agree</em>) matches the majority opinion (<em>Ref. avg. agree</em>). Thus, the <strong>consensus</strong> score is <strong>${fp(consFrac)}</strong> (= ${A}/${N}).</li>` +
    `<li>There ${B === 1 ? 'is' : 'are'} <strong>${B}</strong> statement${B !== 1 ? 's' : ''} for which the user's prediction of the majority opinion (<em>Others agree</em>) matches the majority opinion (<em>Ref. avg. agree</em>). Thus, the <strong>awareness</strong> score is <strong>${fp(awareFrac)}</strong> (= ${B}/${N}).</li>` +
    `</ul></li>` +
    `<li>The <strong>commonsensicality</strong> score is the geometric mean of consensus and awareness: √(${fp(consFrac)} × ${fp(awareFrac)}) = <strong>${fp(commsFrac)}</strong>.</li>` +
    `</ul>`;
  modalExplanation.classList.remove('hidden');

  const fragment = document.createDocumentFragment();
  data.rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="td-statement">${esc(fixStatement(row.statement))}</td>` +
      `<td class="td-modal-right">${badge(row.I_agree)}</td>` +
      `<td class="td-modal-right">${badge(row.others_agree)}</td>` +
      `<td class="td-modal-right">${row.ref_n_ratings != null ? fmtNum(row.ref_n_ratings) : '—'}</td>` +
      `<td class="td-modal-right">${refAvgAgree(row.ref_i_agree_mean)}</td>`;
    fragment.appendChild(tr);
  });
  modalBody.innerHTML = '';
  modalBody.appendChild(fragment);
}

function closeModal()      { userModal.classList.add('hidden'); }
function closeStmtModal()  { stmtModal.classList.add('hidden'); }
function closeStmtProps()  { stmtPropsModal.classList.add('hidden'); }

modalClose.addEventListener('click', closeModal);
userModal.addEventListener('click', e => { if (e.target === userModal) closeModal(); });
stmtModalClose.addEventListener('click', closeStmtModal);
stmtModal.addEventListener('click', e => { if (e.target === stmtModal) closeStmtModal(); });
stmtPropsClose.addEventListener('click', closeStmtProps);
stmtPropsModal.addEventListener('click', e => { if (e.target === stmtPropsModal) closeStmtProps(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeStmtModal(); closeStmtProps(); } });

// ── Scores: sort & filter ──────────────────────────────────────────────────

function buildScoresRows() {
  const nBins = histBinEdges.length - 1;

  let rows = activeBinIdx === null
    ? [...allScoresRows]
    : allScoresRows.filter(r => {
        const lo = histBinEdges[activeBinIdx];
        const hi = histBinEdges[activeBinIdx + 1];
        const isLast = activeBinIdx === nBins - 1;
        return r.commonsensicality >= lo &&
               (isLast ? r.commonsensicality <= hi : r.commonsensicality < hi);
      });

  if (sortKey !== null) {
    rows.sort((a, b) => {
      const d = a[sortKey] - b[sortKey];
      return sortDir === 'asc' ? d : -d;
    });
  }

  scoresRows = rows;
  scoresPage = 1;
}

function updateSortHeaders() {
  document.querySelectorAll('#scoresTable thead th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    const isActive = sortKey !== null && th.dataset.sort === sortKey;
    th.classList.toggle('sort-active', isActive);
    icon.textContent = isActive ? (sortDir === 'asc' ? '▲' : '▼') : '';
  });
}

// ── Scores: bar colors ─────────────────────────────────────────────────────

function getBarColors() {
  const n = Math.max(histBinEdges.length - 1, 20);
  return Array.from({ length: n }, (_, i) => {
    if (activeBinIdx === null) return '#3B82F6';
    return i === activeBinIdx ? '#1D4ED8' : '#93C5FD';
  });
}

function updateBarColors() {
  if (!histChart) return;
  histChart.data.datasets[0].backgroundColor = getBarColors();
  histChart.update('none');
}

// ── Scores: table page ─────────────────────────────────────────────────────

function scoresTotalPages() { return Math.max(1, Math.ceil(scoresRows.length / PAGE_SIZE)); }

function renderScoresPage() {
  const start = (scoresPage - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();

  scoresRows.slice(start, start + PAGE_SIZE).forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    const userId = row.userSessionId;
    tr.innerHTML =
      `<td class="td-rank">${fmtNum(start + i + 1)}</td>` +
      `<td class="td-user" title="${esc(userId)}">${esc(userId.slice(0, 14))}…</td>` +
      `<td class="td-num">${fmtNum(row.n_statements)}</td>` +
      `<td>${pctBarScore(row.consensus)}</td>` +
      `<td>${pctBarScore(row.awareness)}</td>` +
      `<td>${pctBarScore(row.commonsensicality)}</td>`;
    tr.addEventListener('click', () => openUserDetail(row));
    fragment.appendChild(tr);
  });

  scoresBody.innerHTML = '';
  scoresBody.appendChild(fragment);

  // Update filter label
  if (activeBinIdx === null) {
    const noteVisible = !document.getElementById('scoresMinRatingsNote').classList.contains('hidden');
    scoresFilterLabel.textContent =
      (scoresRows.length && !noteVisible) ? `${fmtNum(scoresRows.length)} users` : '';
  } else {
    const lo = fmtPct(histBinEdges[activeBinIdx]);
    const hi = fmtPct(histBinEdges[activeBinIdx + 1]);
    scoresFilterLabel.textContent =
      `Filtered: score ${lo} – ${hi} · ${fmtNum(scoresRows.length)} users · click bar again to clear`;
  }

  const tp = scoresTotalPages();
  scoresPageInfoEl.textContent = `Page ${fmtNum(scoresPage)} of ${fmtNum(tp)}`;
  btnScoresPrev.disabled = scoresPage <= 1;
  btnScoresNext.disabled = scoresPage >= tp;
}

// ── Histogram ──────────────────────────────────────────────────────────────

function renderHistogram({ counts, bin_edges }) {
  histBinEdges = bin_edges;
  const labels   = bin_edges.slice(0, -1).map(fmtPct);
  const histData = counts;
  const colors   = getBarColors();

  if (histChart) {
    histChart.data.labels = labels;
    histChart.data.datasets[0].data = histData;
    histChart.data.datasets[0].backgroundColor = colors;
    histChart.update();
    return;
  }

  const ctx = document.getElementById('histChart').getContext('2d');
  histChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: histData,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 3,
        minBarLength: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: 1.0,
      barPercentage: 0.9,
      onClick: (evt, _elements, chart) => {
        const { left, right } = chart.scales.x;
        const { top, bottom } = chart.chartArea;
        if (evt.x < left || evt.x > right || evt.y < top || evt.y > bottom) return;
        const nBins = histBinEdges.length - 1;
        if (!nBins) return;
        const idx = Math.min(nBins - 1, Math.floor((evt.x - left) / (right - left) * nBins));
        activeBinIdx = idx !== activeBinIdx ? idx : null;
        updateBarColors();
        buildScoresRows();
        renderScoresPage();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const i = items[0].dataIndex;
              return `Score: ${fmtPct(histBinEdges[i])} – ${fmtPct(histBinEdges[i + 1])}`;
            },
            label: item => `${fmtNum(item.raw)} user${item.raw !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Commonsensicality score (%)', font: { size: 20 }},
          grid: { display: false },
          ticks: { font: { size: 16 }, callback: (_, idx, ticks) => [0, 4, 8, 12, 16].includes(idx) ? labels[idx] : idx === ticks.length - 1 ? '100%' : '' },
        },
        y: {
          title: { display: true, text: 'Users', font: { size: 20 }},
          beginAtZero: true,
          grid: { color: '#F1F5F9' },
          ticks: { precision: 0, font: { size: 16 } },
        },
      },
    },
  });
}

// ── Scores: load ───────────────────────────────────────────────────────────

async function loadScores(target, reference) {
  scoresSpinnerEl.classList.remove('hidden');
  scoresFilterLabel.textContent = '';
  scoresPageInfoEl.textContent = '';
  btnScoresPrev.disabled = true;
  btnScoresNext.disabled = true;
  scoresBody.innerHTML = '<tr><td colspan="6" class="empty-row">Computing scores…</td></tr>';

  // Reset view state
  activeBinIdx = null;
  sortKey = 'n_statements';
  sortDir = 'desc';
  updateSortHeaders();

  let data;
  try {
    const url = `/api/scores?target=${encodeURIComponent(target)}&reference=${encodeURIComponent(reference)}`;
    data = await fetch(url).then(r => r.json());
  } catch {
    scoresBody.innerHTML = '<tr><td colspan="6" class="empty-row">Failed to compute scores.</td></tr>';
    scoresSpinnerEl.classList.add('hidden');
    return;
  }

  scoresSpinnerEl.classList.add('hidden');

  if (!data.users) {
    scoresBody.innerHTML = `<tr><td colspan="6" class="empty-row">Server error: ${esc(data.error || 'unexpected response')}. Restart the server and try again.</td></tr>`;
    return;
  }

  allScoresRows = data.users;

  const tLabel = target === 'all' ? 'all countries' : target;
  const rLabel = reference === 'all' ? 'all countries' : reference;

  const noteEl = document.getElementById('scoresMinRatingsNote');
  if (data.raw_n_users != null && data.n_users < data.raw_n_users) {
    noteEl.textContent =
      `Note: Only ${fmtNum(data.n_users)} of ${fmtNum(data.raw_n_users)} users in the target group (${tLabel}) are shown. ` +
      `To qualify, a user in the target group (${tLabel}) must have rated at least 5 statements. ` +
      `In addition, each statement must have received at least 5 ratings from the reference group (${rLabel}).`;
    noteEl.classList.remove('hidden');
  } else {
    noteEl.classList.add('hidden');
  }

  if (allScoresRows.length === 0) {
    scoresBody.innerHTML = '<tr><td colspan="6" class="empty-row">No users met the minimum criteria.</td></tr>';
    return;
  }

  buildScoresRows();
  renderHistogram(data.histogram);
  renderScoresPage();
}

// ── Statement Scores tab ───────────────────────────────────────────────────

function stmtScoresTotalPages() { return Math.max(1, Math.ceil(stmtScoresRows.length / PAGE_SIZE)); }

function buildStmtScoresRows() {
  const nBins = stmtScoresHistBinEdges.length - 1;
  let rows = stmtScoresActiveBinIdx === null
    ? [...stmtScoresAllRows]
    : stmtScoresAllRows.filter(r => {
        const lo = stmtScoresHistBinEdges[stmtScoresActiveBinIdx];
        const hi = stmtScoresHistBinEdges[stmtScoresActiveBinIdx + 1];
        const isLast = stmtScoresActiveBinIdx === nBins - 1;
        return r.commonsensicality >= lo &&
               (isLast ? r.commonsensicality <= hi : r.commonsensicality < hi);
      });

  if (stmtScoresSortKey !== null) {
    rows.sort((a, b) => {
      const d = a[stmtScoresSortKey] - b[stmtScoresSortKey];
      return stmtScoresSortDir === 'asc' ? d : -d;
    });
  }
  let ssFiltered = applyPropFilters(rows, ssPropFilters);
  const ssq = stmtScoresSearchQuery.trim().toLowerCase();
  if (ssq) ssFiltered = ssFiltered.filter(r => r.statement.toLowerCase().includes(ssq));
  stmtScoresRows = ssFiltered;
  stmtScoresPage = 1;
}

function updateStmtScoresSortHeaders() {
  document.querySelectorAll('#stmtScoresTable thead th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    const isActive = stmtScoresSortKey !== null && th.dataset.sort === stmtScoresSortKey;
    th.classList.toggle('sort-active', isActive);
    icon.textContent = isActive ? (stmtScoresSortDir === 'asc' ? '▲' : '▼') : '';
  });
}

function getStmtScoresBarColors() {
  const n = Math.max(stmtScoresHistBinEdges.length - 1, 20);
  return Array.from({ length: n }, (_, i) => {
    if (stmtScoresActiveBinIdx === null) return '#3B82F6';
    return i === stmtScoresActiveBinIdx ? '#1D4ED8' : '#93C5FD';
  });
}

function updateStmtScoresBarColors() {
  if (!stmtScoresHistChart) return;
  stmtScoresHistChart.data.datasets[0].backgroundColor = getStmtScoresBarColors();
  stmtScoresHistChart.update('none');
}

function renderStmtScoresPage(preserveScroll = false) {
  const start = (stmtScoresPage - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();

  stmtScoresRows.slice(start, start + PAGE_SIZE).forEach((row, i) => {
    const tr = document.createElement('tr');
    const stmt = fixStatement(row.statement);
    tr.innerHTML =
      `<td class="td-rank">${fmtNum(start + i + 1)}</td>` +
      `<td class="td-statement" title="${esc(stmt)}">${esc(stmt)}</td>` +
      `<td class="td-num">${fmtNum(row.n_ratings)}</td>` +
      `<td>${pctBar(row.I_agree_mean)}</td>` +
      `<td>${pctBar(row.others_agree_mean)}</td>` +
      `<td>${pctBarScore(row.consensus)}</td>` +
      `<td>${pctBarScore(row.awareness)}</td>` +
      `<td>${pctBarScore(row.commonsensicality)}</td>`;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openStmtCombined(row));
    fragment.appendChild(tr);
  });

  stmtScoresBody.innerHTML = '';
  stmtScoresBody.appendChild(fragment);
  if (!preserveScroll) document.querySelector('#panelStmtScores .scores-wrap').scrollTop = 0;

  if (stmtScoresActiveBinIdx === null) {
    stmtScoresFilterLabel.textContent =
      stmtScoresRows.length ? `${fmtNum(stmtScoresRows.length)} statements` : '';
  } else {
    const lo = fmtPct(stmtScoresHistBinEdges[stmtScoresActiveBinIdx]);
    const hi = fmtPct(stmtScoresHistBinEdges[stmtScoresActiveBinIdx + 1]);
    stmtScoresFilterLabel.textContent =
      `Filtered: score ${lo} – ${hi} · ${fmtNum(stmtScoresRows.length)} statements · click bar again to clear`;
  }

  const tp = stmtScoresTotalPages();
  stmtScoresPageInfoEl.textContent = `Page ${fmtNum(stmtScoresPage)} of ${fmtNum(tp)}`;
  btnStmtScoresPrev.disabled = stmtScoresPage <= 1;
  btnStmtScoresNext.disabled = stmtScoresPage >= tp;
}

function renderStmtScoresHistogram({ counts, bin_edges }) {
  stmtScoresHistBinEdges = bin_edges;
  const labels    = bin_edges.slice(0, -1).map(fmtPct);
  const histData  = counts;
  const colors    = getStmtScoresBarColors();

  if (stmtScoresHistChart) {
    stmtScoresHistChart.data.labels = labels;
    stmtScoresHistChart.data.datasets[0].data = histData;
    stmtScoresHistChart.data.datasets[0].backgroundColor = colors;
    stmtScoresHistChart.update();
    return;
  }

  const ctx = document.getElementById('stmtScoresHistChart').getContext('2d');
  stmtScoresHistChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: histData, backgroundColor: colors, borderWidth: 0, borderRadius: 3, minBarLength: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: 1.0,
      barPercentage: 0.9,
      onClick: (evt, _elements, chart) => {
        const { left, right } = chart.scales.x;
        const { top, bottom } = chart.chartArea;
        if (evt.x < left || evt.x > right || evt.y < top || evt.y > bottom) return;
        const nBins = stmtScoresHistBinEdges.length - 1;
        if (!nBins) return;
        const idx = Math.min(nBins - 1, Math.floor((evt.x - left) / (right - left) * nBins));
        stmtScoresActiveBinIdx = idx !== stmtScoresActiveBinIdx ? idx : null;
        updateStmtScoresBarColors();
        buildStmtScoresRows();
        renderStmtScoresPage();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const i = items[0].dataIndex;
              return `Score: ${fmtPct(stmtScoresHistBinEdges[i])} – ${fmtPct(stmtScoresHistBinEdges[i + 1])}`;
            },
            label: item => `${fmtNum(item.raw)} statement${item.raw !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Commonsensicality score (%)', font: { size: 20 }},
          grid: { display: false },
          ticks: { font: { size: 16 }, callback: (_, idx, ticks) => [0, 4, 8, 12, 16].includes(idx) ? labels[idx] : idx === ticks.length - 1 ? '100%' : '' },
        },
        y: {
          title: { display: true, text: 'Statements', font: { size: 20 }},
          beginAtZero: true,
          grid: { color: '#F1F5F9' },
          ticks: { precision: 0, font: { size: 16 } },
        },
      },
    },
  });
}

async function openStmtCombined(row) {
  const country = stmtScoresCountrySelect.value;
  const groupLabel = country === 'all' ? 'all countries' : country;
  document.getElementById('stmtPropsText').textContent = fixStatement(row.statement);
  document.getElementById('stmtPropsBody').innerHTML = '<p style="color:#94A3B8;padding:12px 0">Loading…</p>';
  stmtPropsModal.classList.remove('hidden');

  // Fetch top countries async
  let countriesHtml = '';
  try {
    const countries = await fetch(`/api/statement-countries?statementId=${encodeURIComponent(row.statementId)}`).then(r => r.json());
    if (countries.length) {
      const countryRows = countries.map((c, i) =>
        `<tr><td class="prop-country-rank">${i + 1}</td><td class="prop-country-name">${esc(c.country)}</td><td class="prop-country-n">${fmtNum(c.n_ratings)}</td></tr>`
      ).join('');
      countriesHtml =
        `<div class="prop-countries-section">` +
          `<div class="prop-detail-category" style="padding:10px 20px 4px">Top countries by ratings</div>` +
          `<table class="prop-countries-table"><tbody>${countryRows}</tbody></table>` +
        `</div>`;
    }
  } catch (_) {}

  // Score calculation section
  const N = row.n_ratings;
  const A = row.I_agree_mean;
  const B = row.others_agree_mean;
  const majorityYes = A >= 0.5;
  const fp = v => (v * 100).toFixed(1) + '%';
  const consensus = 2 * Math.abs(A - 0.5);
  const consFormula = `2 × |${fp(A)} − 50%| = 2 × ${fp(Math.abs(A - 0.5))} = <strong>${fp(consensus)}</strong>`;
  const awareness = majorityYes ? B : 1 - B;
  const awarenessText = majorityYes
    ? `Of the ${fmtNum(N)} individuals, <strong>${fp(B)}</strong> of them predicted that most people would agree (via <em>Others agree</em>). Since the majority opinion is "Yes", these ${fp(B)} correctly predicted the majority. Thus, the <strong>awareness</strong> score is <strong>${fp(awareness)}</strong>.`
    : `Of the ${fmtNum(N)} individuals, <strong>${fp(B)}</strong> of them predicted that most people would agree. Since the majority opinion is "No", the remaining <strong>${fp(1 - B)}</strong> who predicted "No" correctly predicted the majority. Thus, the <strong>awareness</strong> score is <strong>${fp(awareness)}</strong>.`;
  const commonsensicality = Math.sqrt(consensus * awareness);
  const scoreHtml =
    `<p class="expl-context">The following calculation of this statement's commonsensicality score is relative to the target group, <strong>${esc(groupLabel)}</strong>.</p>` +
    `<ul class="expl-list">` +
    `<li>Within this group, this statement has received a total of <strong>${fmtNum(N)}</strong> rating${N !== 1 ? 's' : ''}.</li>` +
    `<li>Of the <strong>${fmtNum(N)}</strong> individuals who rated the statement, <strong>${fp(A)}</strong> of them agreed with it (via <em>I agree</em>). Since ${fp(A)} ${majorityYes ? '≥' : '<'} 50%, the majority opinion is <strong>"${majorityYes ? 'Yes' : 'No'}"</strong> — most people ${majorityYes ? 'agreed with' : 'disagreed with'} the statement.</li>` +
    `<li>Since ${fp(A)} of people agreed, the <strong>consensus</strong> score is ${consFormula}.</li>` +
    `<li>${awarenessText}</li>` +
    `<li>The <strong>commonsensicality</strong> score is the geometric mean of consensus and awareness: √(${fp(consensus)} × ${fp(awareness)}) = <strong>${fp(commonsensicality)}</strong>.</li>` +
    `</ul>`;

  // Property definitions section
  const propItems = PROP_DEFS.map(({ key, v1, v0, def1, def0 }) => {
    const val = row[key];
    if (val === null || val === undefined)
      return `<li class="prop-detail-item prop-detail-unknown"><span class="prop-detail-category">${esc(v1)} / ${esc(v0)}</span><span class="prop-detail-desc">—</span></li>`;
    const label = val === 1 ? v1 : v0;
    const def   = val === 1 ? def1 : def0;
    const contrastLabel = val === 1 ? v0 : v1;
    const contrastDef   = val === 1 ? def0 : def1;
    return `<li class="prop-detail-item">` +
      `<span class="prop-detail-category">${esc(v1)} / ${esc(v0)}</span>` +
      `<span class="prop-detail-desc">This statement is an example of <strong>${esc(label)}</strong>: ${esc(def)}</span>` +
      `<span class="prop-detail-contrast">(This is in contrast to <strong>${esc(contrastLabel)}</strong>: ${esc(contrastDef)})</span>` +
      `</li>`;
  }).join('');

  document.getElementById('stmtPropsBody').innerHTML =
    countriesHtml +
    `<div class="stmt-combined-section"><div class="stmt-combined-section-title">Commonsensicality score</div>${scoreHtml}</div>` +
    `<div class="stmt-combined-section"><div class="stmt-combined-section-title">Statement properties</div><ul class="prop-detail-list">${propItems}</ul></div>`;
}

async function loadStmtScores(country) {
  stmtScoresSpinnerEl.classList.remove('hidden');
  stmtScoresSummaryEl.textContent = 'Computing…';
  stmtScoresFilterLabel.textContent = '';
  stmtScoresPageInfoEl.textContent = '';
  btnStmtScoresPrev.disabled = true;
  btnStmtScoresNext.disabled = true;
  stmtScoresBody.innerHTML = '<tr><td colspan="8" class="empty-row">Computing scores…</td></tr>';

  stmtScoresActiveBinIdx = null;
  stmtScoresSortKey = 'n_ratings';
  stmtScoresSortDir = 'desc';
  updateStmtScoresSortHeaders();

  let data;
  try {
    data = await fetch(`/api/statement-scores?country=${encodeURIComponent(country)}`).then(r => r.json());
  } catch {
    stmtScoresBody.innerHTML = '<tr><td colspan="8" class="empty-row">Failed to compute scores.</td></tr>';
    stmtScoresSummaryEl.textContent = '';
    stmtScoresSpinnerEl.classList.add('hidden');
    return;
  }

  stmtScoresSpinnerEl.classList.add('hidden');

  if (!data.rows) {
    stmtScoresBody.innerHTML = `<tr><td colspan="8" class="empty-row">Server error: ${esc(data.error || 'unexpected response')}. Restart the server and try again.</td></tr>`;
    stmtScoresSummaryEl.textContent = '';
    return;
  }

  stmtScoresAllRows = data.rows;

  const label = country === 'all' ? 'all countries' : country;
  stmtScoresSummaryEl.textContent =
    `${fmtNum(data.n_statements)} statements · ${fmtNum(data.n_users)} participants (${label})`;

  if (!stmtScoresAllRows.length) {
    stmtScoresBody.innerHTML = '<tr><td colspan="8" class="empty-row">No statements met the minimum criteria.</td></tr>';
    return;
  }

  buildStmtScoresRows();
  renderStmtScoresHistogram(data.histogram);
  renderStmtScoresPage();
}

// ── Init ───────────────────────────────────────────────────────────────────

btnScoresPrev.addEventListener('click', () => {
  if (scoresPage > 1) { scoresPage--; renderScoresPage(); }
});
btnScoresNext.addEventListener('click', () => {
  if (scoresPage < scoresTotalPages()) { scoresPage++; renderScoresPage(); }
});

document.querySelectorAll('#scoresTable thead th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'desc';
    }
    buildScoresRows();
    updateSortHeaders();
    renderScoresPage();
  });
});

targetSelect.addEventListener('change', () => {
  referenceSelect.value = targetSelect.value;
  loadScores(targetSelect.value, referenceSelect.value);
});
referenceSelect.addEventListener('change', () => loadScores(targetSelect.value, referenceSelect.value));
stmtScoresCountrySelect.addEventListener('change', e => loadStmtScores(e.target.value));
dpCountrySelect.addEventListener('change', e => {
  document.getElementById('dpDetailCard').classList.add('hidden');
  document.querySelectorAll('#dpTableContainer .dp-selected').forEach(r => r.classList.remove('dp-selected'));
  loadDesignPoints(e.target.value);
});

btnStmtScoresPrev.addEventListener('click', () => {
  if (stmtScoresPage > 1) { stmtScoresPage--; renderStmtScoresPage(); }
});
btnStmtScoresNext.addEventListener('click', () => {
  if (stmtScoresPage < stmtScoresTotalPages()) { stmtScoresPage++; renderStmtScoresPage(); }
});

document.querySelectorAll('#stmtScoresTable thead th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (stmtScoresSortKey === key) {
      stmtScoresSortDir = stmtScoresSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      stmtScoresSortKey = key;
      stmtScoresSortDir = 'desc';
    }
    buildStmtScoresRows();
    updateStmtScoresSortHeaders();
    renderStmtScoresPage();
  });
});

// ── Design-point forest plot ───────────────────────────────────────────────

function dpX(v) { return (DP_PAD + v * DP_PW).toFixed(1); }

function dpCiSvg(mean, ci_lo, ci_hi) {
  if (mean === null) return '';
  const cy = (DP_H / 2).toFixed(1);
  const lo = ci_lo !== null ? ci_lo : mean;
  const hi = ci_hi !== null ? ci_hi : mean;
  const grids = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map(v =>
    `<line x1="${dpX(v)}" y1="2" x2="${dpX(v)}" y2="${DP_H - 2}" stroke="#CBD5E1" stroke-width="1"/>`
  ).join('');
  return `<svg width="${DP_W}" height="${DP_H}" style="display:block">` +
    grids +
    `<line x1="${dpX(lo)}" y1="${cy}" x2="${dpX(hi)}" y2="${cy}" stroke="#334155" stroke-width="2.5" stroke-linecap="round"/>` +
    `<circle cx="${dpX(mean)}" cy="${cy}" r="5" fill="#1E293B"/>` +
    `</svg>`;
}

function dpAxisSvg() {
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const lbls  = ['0', '20', '40', '60', '80', '100'];
  const lines = ticks.map(v =>
    `<line x1="${dpX(v)}" y1="0" x2="${dpX(v)}" y2="6" stroke="#1E293B" stroke-width="1"/>`
  ).join('');
  const texts = ticks.map((v, i) =>
    `<text x="${dpX(v)}" y="28" text-anchor="middle" font-size="19" font-weight="700" fill="#1E293B">${lbls[i]}</text>`
  ).join('');
  return `<svg width="${DP_W}" height="30" overflow="visible" style="display:block">` +
    `<line x1="${dpX(0)}" y1="0" x2="${dpX(1)}" y2="0" stroke="#1E293B" stroke-width="1.5"/>` +
    lines + texts + '</svg>';
}

function dpAxisSvgTop() {
  // Uses dpX — same coordinate system as data rows so ticks align with gridlines
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const lbls  = ['0', '20', '40', '60', '80', '100'];
  const axisY = 19;
  const lines = ticks.map(v =>
    `<line x1="${dpX(v)}" y1="${axisY}" x2="${dpX(v)}" y2="${axisY - 5}" stroke="#1E293B" stroke-width="1"/>`
  ).join('');
  const texts = ticks.map((v, i) =>
    `<text x="${dpX(v)}" y="${axisY - 16}" text-anchor="middle" font-size="19" fill="#1E293B">${lbls[i]}</text>`
  ).join('');
  return `<svg width="${DP_W}" height="20" overflow="visible" style="display:block">` +
    `<line x1="${dpX(0)}" y1="${axisY}" x2="${dpX(1)}" y2="${axisY}" stroke="#1E293B" stroke-width="1"/>` +
    lines + texts + '</svg>';
}

function renderDesignPoints(rows, rowsExcluded) {
  const propCols = DP_PROPS.map(() => `<col class="dp-col-prop"/>`).join('');
  const propThs  = DP_PROPS.map((p, i) =>
    `<th class="dp-th-prop${i % 2 === 0 ? ' dp-th-alt' : ''}">` +
      `<span class="dp-prop-label">${p.labelHtml || esc(p.label)}</span>` +
      `<button class="prop-help-btn dp-prop-help-btn" type="button" data-prop-key="${p.key}">?</button>` +
    `</th>`
  ).join('');

  const makePropCells = (row, extraClass) => DP_PROPS.map((p, i) => {
    const v = row[p.key];
    const alt = i % 2 === 0 ? ' dp-prop-alt' : '';
    return `<td class="dp-prop-val ${v === 1 ? 'dp-val-1' : 'dp-val-0'}${alt} dp-prop-cell${extraClass}" data-prop-key="${p.key}" data-prop-val="${v}">${v === 1 ? '●' : '○'}</td>`;
  }).join('');

  const bodyRows = rows.map(row => {
    const dataAttrs = DP_PROPS.map(p => `data-${p.key}="${row[p.key]}"`).join(' ');
    return `<tr class="dp-clickable" ${dataAttrs}>` +
      `<td class="dp-n-cell">N = ${fmtNum(row.n)}</td>` +
      makePropCells(row, '') +
      `<td class="dp-ci-cell">${dpCiSvg(row.mean, row.ci_lo, row.ci_hi)}</td>` +
      `<td class="dp-score-cell">${(row.mean * 100).toFixed(1)}%</td>` +
      `<td class="dp-ci-text-cell">${row.ci_lo !== null && row.ci_hi !== null ? `${(row.ci_lo * 100).toFixed(2)} – ${(row.ci_hi * 100).toFixed(2)}%` : '—'}</td>` +
      `</tr>`;
  }).join('');

  const exN = rowsExcluded.length;
  const excludedRows = rowsExcluded.map(row => {
    const dataAttrs = DP_PROPS.map(p => `data-${p.key}="${row[p.key]}"`).join(' ');
    return `<tr class="dp-excluded-row" ${dataAttrs}>` +
      `<td class="dp-n-cell">N = ${fmtNum(row.n)}</td>` +
      makePropCells(row, ' dp-excl-prop') +
      `<td class="dp-ci-cell dp-excl-ci"></td>` +
      `<td class="dp-score-cell dp-excl-score">—</td>` +
      `<td class="dp-ci-text-cell">—</td>` +
      `</tr>`;
  }).join('');

  const totalCols = 1 + DP_PROPS.length + 3;
  const emptyTds = '<td></td>'.repeat(DP_PROPS.length);
  const axisRow  = `<tr><td></td>${emptyTds}<td class="dp-axis-cell">${dpAxisSvg()}</td><td></td><td></td></tr>`;

  const excludedSection = exN > 0
    ? `<tbody class="dp-excluded-toggle-tbody">` +
      `<tr><td colspan="${totalCols}" class="dp-excluded-toggle-cell">` +
      `<button class="dp-excluded-btn" type="button">` +
      `▶ ${exN} design point${exN !== 1 ? 's' : ''} with N < 5` +
      `</button></td></tr></tbody>` +
      `<tbody class="dp-excluded-body" hidden>${excludedRows}</tbody>`
    : '';

  document.getElementById('dpTableContainer').innerHTML =
    `<p class="click-hint">Click on a row to see its statements.</p>` +
    `<table class="dp-table">` +
    `<colgroup><col class="dp-col-n"/>${propCols}<col class="dp-col-ci"/><col class="dp-col-score"/><col class="dp-col-citext"/></colgroup>` +
    `<thead>` +
    `<tr><th class="dp-th-n">N</th>${propThs}<th class="dp-th-ci dp-axis-cell">${dpAxisSvgTop()}</th><th class="dp-th-score">Avg. Score</th><th class="dp-th-citext">95% CI</th></tr>` +
    `</thead>` +
    `<tbody>${bodyRows}</tbody>` +
    excludedSection +
    `<tfoot>${axisRow}</tfoot>` +
    `</table>`;

  // Single delegated handler — toggle excluded section OR select a qualified row
  document.getElementById('dpTableContainer').onclick = e => {
    const btn = e.target.closest('.dp-excluded-btn');
    if (btn) {
      const tbody = btn.closest('table').querySelector('.dp-excluded-body');
      const opening = tbody.hidden;
      tbody.hidden = !opening;
      btn.textContent = (opening ? '▼' : '▶') + ` ${exN} design point${exN !== 1 ? 's' : ''} with N < 5`;
      return;
    }
    const tr = e.target.closest('tr.dp-clickable');
    if (!tr) return;
    const alreadySelected = tr.classList.contains('dp-selected');
    document.querySelectorAll('#dpTableContainer .dp-selected').forEach(r => r.classList.remove('dp-selected'));
    if (alreadySelected) {
      document.getElementById('dpDetailCard').classList.add('hidden');
      return;
    }
    tr.classList.add('dp-selected');
    const props = Object.fromEntries(DP_PROPS.map(p => [p.key, parseInt(tr.dataset[p.key])]));
    loadDpStatements(dpCountrySelect.value, props);
  };
}

async function loadDpStatements(country, props) {
  const detailCard = document.getElementById('dpDetailCard');
  const detailBody = document.getElementById('dpDetailBody');
  detailCard.classList.remove('hidden');

  const labels = DP_PROPS.map((p, i) => {
    const isActive = props[p.key] === 1;
    const label    = isActive ? p.label : PROP_DEFS[i].v0;
    return isActive
      ? `<strong>${esc(label)}</strong>`
      : `<span style="color:#94A3B8">${esc(label)}</span>`;
  }).join(' · ');
  document.getElementById('dpDetailTitle').textContent = 'Statements for selected design point';
  document.getElementById('dpDetailSub').innerHTML = labels;
  detailBody.innerHTML = '<div class="empty-row" style="padding:20px 0">Loading…</div>';

  detailCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const params = new URLSearchParams({ country });
  DP_PROPS.forEach(p => params.set(p.key, props[p.key]));

  let data;
  try {
    data = await fetch(`/api/dp-statements?${params}`).then(r => r.json());
  } catch {
    detailBody.innerHTML = '<div class="empty-row">Failed to load.</div>';
    return;
  }

  document.getElementById('dpDetailTitle').textContent =
    `Statements for selected design point (N = ${fmtNum(data.n)})`;
  renderDpStatements(data.rows);
}

// ── DP detail table sort state ─────────────────────────────────────────────
let dpDetailSortKey = 'n_ratings';
let dpDetailSortDir = 'desc';
let dpDetailAllRows = [];
let dpDetailPage    = 1;

function buildDpDetailRows() {
  const rows = [...dpDetailAllRows];
  rows.sort((a, b) => {
    const d = a[dpDetailSortKey] - b[dpDetailSortKey];
    return dpDetailSortDir === 'asc' ? d : -d;
  });
  return rows;
}

function updateDpDetailSortHeaders() {
  document.querySelectorAll('#dpDetailTable thead th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    const active = th.dataset.sort === dpDetailSortKey;
    th.classList.toggle('sort-active', active);
    icon.textContent = active ? (dpDetailSortDir === 'asc' ? '▲' : '▼') : '';
  });
}

function renderDpDetailBody() {
  let rows = buildDpDetailRows();
  const dpq = dpDetailSearchQuery.trim().toLowerCase();
  if (dpq) rows = rows.filter(r => r.statement.toLowerCase().includes(dpq));
  const tp    = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = (dpDetailPage - 1) * PAGE_SIZE;

  const tbody = document.querySelector('#dpDetailTable tbody');
  tbody.innerHTML = '';
  rows.slice(start, start + PAGE_SIZE).forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="td-rank">${start + i + 1}</td>` +
      `<td class="td-statement">${esc(fixStatement(row.statement))}</td>` +
      `<td class="td-num">${fmtNum(row.n_ratings)}</td>` +
      `<td>${pctBar(row.I_agree_mean)}</td>` +
      `<td>${pctBar(row.others_agree_mean)}</td>` +
      `<td>${pctBarScore(row.consensus)}</td>` +
      `<td>${pctBarScore(row.awareness)}</td>` +
      `<td>${pctBarScore(row.commonsensicality)}</td>`;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openStmtDetail(row, dpCountrySelect.value));
    tbody.appendChild(tr);
  });

  document.getElementById('dpDetailPageInfo').textContent =
    `Page ${fmtNum(dpDetailPage)} of ${fmtNum(tp)}`;
  document.getElementById('dpDetailBtnPrev').disabled = dpDetailPage <= 1;
  document.getElementById('dpDetailBtnNext').disabled = dpDetailPage >= tp;
  document.getElementById('dpDetailCount').textContent =
    `${fmtNum(rows.length)} statement${rows.length !== 1 ? 's' : ''}`;
}

function renderDpStatements(rows) {
  dpDetailAllRows    = rows;
  dpDetailSortKey    = 'n_ratings';
  dpDetailSortDir    = 'desc';
  dpDetailPage       = 1;
  dpDetailSearchQuery = '';

  const detailBody = document.getElementById('dpDetailBody');
  if (!rows.length) {
    detailBody.innerHTML = '<div class="empty-row" style="padding:20px 0">No statements meet the minimum ratings threshold.</div>';
    return;
  }

  detailBody.innerHTML =
    `<div class="scores-nav" style="padding:6px 0 2px">` +
    `<span id="dpDetailCount" class="scores-filter-label"></span>` +
    `<input type="text" id="dpDetailSearchInput" class="stmt-search-input" placeholder="Search statements…" style="flex:1;max-width:280px;margin:0 10px">` +
    `</div>` +
    `<div class="table-nav-row">` +
    `<p class="click-hint">Click on a row to explore more.</p>` +
    `<div class="pagination">` +
    `<button id="dpDetailBtnPrev" class="page-btn" disabled>&#8249;</button>` +
    `<span id="dpDetailPageInfo" class="page-info"></span>` +
    `<button id="dpDetailBtnNext" class="page-btn" disabled>&#8250;</button>` +
    `</div></div>` +
    `<table id="dpDetailTable" style="margin-top:4px;table-layout:fixed;width:100%;border-collapse:collapse;background:#fff">` +
    `<colgroup><col class="col-rank"/><col class="col-dp-stmt"/><col class="col-num"/>` +
    `<col class="col-stmtscore"/><col class="col-stmtscore"/><col class="col-stmtscore"/>` +
    `<col class="col-stmtscore"/><col class="col-stmtscore"/></colgroup>` +
    `<thead><tr>` +
    `<th class="col-rank">#</th>` +
    `<th class="col-dp-stmt">Statement</th>` +
    `<th class="col-num sortable sort-active" data-sort="n_ratings">Ratings <span class="sort-icon">▼</span></th>` +
    `<th class="col-stmtscore sortable" data-sort="I_agree_mean">I agree <button class="prop-help-btn" type="button" data-col-label="I agree" data-col-def="Percentage of users who subjectively agreed with the statement.">?</button> <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="others_agree_mean">Others agree <button class="prop-help-btn" type="button" data-col-label="Others agree" data-col-def="Percentage of users who believed that most other people would agree with the statement.">?</button> <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="consensus">Consensus <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="awareness">Awareness <span class="sort-icon"></span></th>` +
    `<th class="col-stmtscore sortable" data-sort="commonsensicality">Commonsensicality <span class="sort-icon"></span></th>` +
    `</tr></thead><tbody></tbody></table>`;

  renderDpDetailBody();

  document.querySelectorAll('#dpDetailTable thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (dpDetailSortKey === key) {
        dpDetailSortDir = dpDetailSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        dpDetailSortKey = key;
        dpDetailSortDir = 'desc';
      }
      dpDetailPage = 1;
      updateDpDetailSortHeaders();
      renderDpDetailBody();
    });
  });

  document.getElementById('dpDetailBtnPrev').addEventListener('click', () => {
    if (dpDetailPage > 1) { dpDetailPage--; renderDpDetailBody(); }
  });
  document.getElementById('dpDetailBtnNext').addEventListener('click', () => {
    const tp = Math.max(1, Math.ceil(dpDetailAllRows.length / PAGE_SIZE));
    if (dpDetailPage < tp) { dpDetailPage++; renderDpDetailBody(); }
  });
  document.getElementById('dpDetailSearchInput').addEventListener('input', e => {
    dpDetailSearchQuery = e.target.value;
    dpDetailPage = 1;
    renderDpDetailBody();
  });
}

async function loadDesignPoints(country) {
  document.getElementById('dpTableContainer').innerHTML =
    '<div class="empty-row" style="padding:30px 0">Loading…</div>';
  let data;
  try {
    data = await fetch(`/api/design-points?country=${encodeURIComponent(country)}`).then(r => r.json());
  } catch {
    document.getElementById('dpTableContainer').innerHTML =
      '<div class="empty-row">Failed to load design points.</div>';
    return;
  }
  if (!data.rows || !data.rows.length) {
    document.getElementById('dpTableContainer').innerHTML =
      '<div class="empty-row">No data.</div>';
    return;
  }
  renderDesignPoints(data.rows, data.rows_excluded || []);
}

document.querySelectorAll('.prop-filter-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.closest('.prop-filter-panel');
    const grid  = panel.querySelector('.prop-filter-grid');
    const opening = grid.classList.contains('hidden');
    grid.classList.toggle('hidden', !opening);
    panel.classList.toggle('is-open', opening);
  });
});

PROP_DEFS.forEach(({ key }) => {
  const ss1 = document.getElementById(`ssFilter_${key}_1`);
  const ss0 = document.getElementById(`ssFilter_${key}_0`);

  ss1.addEventListener('change', () => {
    ssPropFilters[key].v1 = ss1.checked;
    buildStmtScoresRows(); renderStmtScoresPage(true);
  });
  ss0.addEventListener('change', () => {
    ssPropFilters[key].v0 = ss0.checked;
    buildStmtScoresRows(); renderStmtScoresPage(true);
  });
});

document.getElementById('stmtScoresSearch').addEventListener('input', e => {
  stmtScoresSearchQuery = e.target.value;
  buildStmtScoresRows();
  renderStmtScoresPage(true);
});

// ── Property help popup ────────────────────────────────────────────────────
(function () {
  const popup  = document.getElementById('propHelpPopup');
  let pinned   = false;
  let activeBtn = null;
  let mouseX = 0, mouseY = 0;
  document.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });

  function propDefByKey(key) {
    return PROP_DEFS.find(d => d.key === key);
  }

  function showPopup(el) {
    if (el.dataset.colDef) {
      popup.innerHTML =
        `<div class="prop-help-popup-entry">` +
          `<div class="prop-help-popup-label">${esc(el.dataset.colLabel || '')}</div>` +
          `<div class="prop-help-popup-def">${esc(el.dataset.colDef)}</div>` +
        `</div>`;
    } else if (el.classList.contains('dp-prop-cell')) {
      const def = propDefByKey(el.dataset.propKey);
      if (!def) return;
      const isActive = parseInt(el.dataset.propVal) === 1;
      const circle = isActive ? '<span class="popup-circle-filled">●</span>' : '<span class="popup-circle-empty">○</span>';
      const label  = isActive ? esc(def.v1) : esc(def.v0);
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
    popup.classList.add('visible');
  }

  function positionPopup() {
    const pw = 340;
    let left = mouseX + 14;
    let top  = mouseY + 14;
    if (left + pw > window.innerWidth - 8) left = mouseX - pw - 8;
    if (top + popup.offsetHeight > window.innerHeight - 8) top = mouseY - popup.offsetHeight - 8;
    popup.style.left = left + 'px';
    popup.style.top  = Math.max(8, top) + 'px';
  }

  function hidePopup() {
    popup.classList.remove('visible');
    if (activeBtn) { activeBtn.classList.remove('pinned'); activeBtn = null; }
    pinned = false;
  }

  function getTarget(e) {
    return e.target.closest('.prop-help-btn');
  }

  document.addEventListener('click', e => {
    const el = getTarget(e);
    if (el) {
      e.stopPropagation();
      if (pinned && activeBtn === el) {
        hidePopup();
      } else {
        if (activeBtn && activeBtn !== el) activeBtn.classList.remove('pinned');
        activeBtn = el;
        pinned = true;
        el.classList.add('pinned');
        showPopup(el);
      }
      return;
    }
    if (!popup.contains(e.target)) hidePopup();
  });

  document.addEventListener('mouseover', e => {
    if (pinned) return;
    const el = getTarget(e);
    if (el) {
      activeBtn = el;
      showPopup(el);
    } else if (!popup.contains(e.target)) {
      popup.classList.remove('visible');
      activeBtn = null;
    }
  });
})();

// ── Group Comparison panel ─────────────────────────────────────────────────
const compareGroupAEl  = document.getElementById('compareGroupA');
const compareGroupBEl  = document.getElementById('compareGroupB');
const compareSpinnerEl = document.getElementById('compareSpinner');
let compareIndivChartInst   = null;
let compareStmtChartInst    = null;
let compareScatterChartInst = null;
let cmpData    = null;
let cmpLabelA  = '';
let cmpLabelB  = '';
let cmpGroupA  = 'all';
let cmpGroupB  = 'all';

const CMP_COLOR_A = 'rgba(37,99,235,0.65)';
const CMP_COLOR_B = 'rgba(234,88,12,0.65)';

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
  const SSx  = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (!SSx) return null;
  const SSxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const b    = SSxy / SSx;
  const a_   = my - b * mx;
  const yhat = xs.map(x => a_ + b * x);
  const SSres = ys.reduce((a, y, i) => a + (y - yhat[i]) ** 2, 0);
  const s = Math.sqrt(SSres / (n - 2));
  return { a: a_, b, mx, SSx, s, n };
}

function regCI(reg, x, z = 1.96) {
  const { a, b, mx, SSx, s, n } = reg;
  const yhat = a + b * x;
  const se   = s * Math.sqrt(1 / n + (x - mx) ** 2 / SSx);
  return { yhat, lo: yhat - z * se, hi: yhat + z * se };
}

function pearsonR(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, x) => a + x, 0) / n;
  const my = ys.reduce((a, y) => a + y, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const dx  = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
  const dy  = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return (dx && dy) ? num / (dx * dy) : null;
}

function cmpMean(arr) {
  return arr.length ? (arr.reduce((a, x) => a + x, 0) / arr.length * 100).toFixed(1) + '%' : '—';
}

function cmpSD(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, x) => a + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1));
}

function cohenD(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const na = a.length, nb = b.length;
  const sda = cmpSD(a), sdb = cmpSD(b);
  const pooled = Math.sqrt(((na - 1) * sda * sda + (nb - 1) * sdb * sdb) / (na + nb - 2));
  if (!pooled) return null;
  const ma = a.reduce((s, x) => s + x, 0) / na;
  const mb = b.reduce((s, x) => s + x, 0) / nb;
  return (ma - mb) / pooled;
}

function effectSizeLabel(d) {
  const abs = Math.abs(d);
  if (abs < 0.2) return 'negligible';
  if (abs < 0.5) return 'small';
  if (abs < 0.8) return 'medium';
  return 'large';
}

function makeCompareHistChart(canvasId, countsA, countsB, labelA, labelB, onClickFn) {
  const N = 20;
  const labels = Array.from({ length: N }, (_, i) => `${i * 5}%`);
  const totalA = countsA.reduce((a, x) => a + x, 0) || 1;
  const totalB = countsB.reduce((a, x) => a + x, 0) || 1;
  const pctA = countsA.map(c => +(c / totalA * 100).toFixed(2));
  const pctB = countsB.map(c => +(c / totalB * 100).toFixed(2));
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: labelA, data: pctA, backgroundColor: CMP_COLOR_A, borderWidth: 0, borderRadius: 2 },
        { label: labelB, data: pctB, backgroundColor: CMP_COLOR_B, borderWidth: 0, borderRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (evt, elements) => { if (elements.length && onClickFn) onClickFn(elements[0].index); },
      onHover: (evt, elements) => { if (evt.native) evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { display: true, position: 'top', labels: { font: { size: 14 }, padding: 16 } },
        tooltip: { callbacks: {
          title: items => `Score: ${labels[items[0].dataIndex]} – ${(parseInt(labels[items[0].dataIndex]) + 5)}%`,
          label: item => `${item.dataset.label}: ${item.raw.toFixed(1)}%`,
        }},
      },
      scales: {
        x: {
          title: { display: true, text: 'Commonsensicality score (%)', font: { size: 17 } },
          grid: { display: false },
          ticks: { font: { size: 14 }, callback: (_, idx, ticks) => [0, 4, 8, 12, 16].includes(idx) ? labels[idx] : idx === ticks.length - 1 ? '100%' : '' },
        },
        y: {
          title: { display: true, text: 'Frequency', font: { size: 17 } },
          beginAtZero: true, grid: { color: '#F1F5F9' },
          ticks: { font: { size: 14 }, callback: v => v + '%' },
        },
      },
    },
  });
}

function makeScatterChart(canvasId, paired, labelA, labelB, onClickFn) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const points = paired.map(p => ({ x: +(p.score_a * 100).toFixed(2), y: +(p.score_b * 100).toFixed(2), stmt: p.statement }));

  // Regression + CI band
  const xs  = points.map(p => p.x);
  const ys  = points.map(p => p.y);
  const reg = linReg(xs, ys);
  const GRID = Array.from({ length: 51 }, (_, i) => i * 2); // 0, 2, …, 100
  const regLine = reg ? GRID.map(x => ({ x, y: +((reg.a + reg.b * x)).toFixed(2) })) : [];
  const ciHi    = reg ? GRID.map(x => ({ x, y: +regCI(reg, x).hi.toFixed(2) })) : [];
  const ciLo    = reg ? GRID.map(x => ({ x, y: +regCI(reg, x).lo.toFixed(2) })) : [];

  const lineBase = { type: 'line', pointRadius: 0, fill: false };
  return new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        // 0: scatter points — faint so regression is readable
        { label: 'Statements', data: points, backgroundColor: 'rgba(37,99,235,0.18)', pointRadius: 5, pointHoverRadius: 7 },
        // 1: y = x reference
        { ...lineBase, label: 'y = x', data: [{x:0,y:0},{x:100,y:100}],
          borderColor: '#CBD5E1', borderWidth: 1.5, borderDash: [6,4] },
        // 2: 95% CI upper bound — fills DOWN to dataset 3 (lower bound)
        ...(reg ? [
          { ...lineBase, label: '95% CI', data: ciHi,
            borderColor: 'transparent', backgroundColor: 'rgba(147,197,253,0.25)', fill: '+1' },
          // 3: 95% CI lower bound
          { ...lineBase, label: '', data: ciLo,
            borderColor: 'transparent', backgroundColor: 'transparent' },
          // 4: best-fit line
          { ...lineBase, label: 'Best fit', data: regLine,
            borderColor: 'rgba(30,64,175,0.9)', borderWidth: 2 },
        ] : []),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (evt, elements) => {
        const hit = elements.find(e => e.datasetIndex === 0);
        if (hit && onClickFn) onClickFn(paired[hit.index]);
      },
      onHover: (evt, elements) => {
        const isData = elements.some(e => e.datasetIndex === 0);
        if (evt.native) evt.native.target.style.cursor = isData ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          label: item => {
            if (item.datasetIndex !== 0) return null;
            const p = item.raw;
            const s = p.stmt ? (p.stmt.length > 70 ? p.stmt.slice(0, 70) + '…' : p.stmt) : '';
            return [s, `${labelA}: ${item.raw.x.toFixed(1)}%   ${labelB}: ${item.raw.y.toFixed(1)}%`];
          },
        }},
      },
      scales: {
        x: { type: 'linear', min: -3, max: 103,
          title: { display: true, text: `${labelA} (%)`, font: { size: 17 } },
          grid: { color: '#F1F5F9' },
          ticks: { font: { size: 14 } },
          afterBuildTicks: axis => { axis.ticks = [0,20,40,60,80,100].map(v => ({ value: v })); } },
        y: { type: 'linear', min: -3, max: 103,
          title: { display: true, text: `${labelB} (%)`, font: { size: 17 } },
          grid: { color: '#F1F5F9' },
          ticks: { font: { size: 14 } },
          afterBuildTicks: axis => { axis.ticks = [0,20,40,60,80,100].map(v => ({ value: v })); } },
      },
    },
  });
}

function cmpGroupHtml(items, label, color, rowFn) {
  const colorSolid = color.replace('0.65', '1');
  return `
    <div class="cmp-detail-group">
      <div class="cmp-detail-group-hd" style="color:${colorSolid}">
        ${esc(label)} &mdash; ${fmtNum(items.length)} ${items.length !== 1 ? 'items' : 'item'}
      </div>
      ${items.length
        ? `<table class="cmp-detail-table">${rowFn(items)}</table>`
        : '<p class="cmp-detail-empty">None in this range.</p>'}
    </div>`;
}

function renderCmpIndivDetail(binIdx) {
  if (!cmpData) return;
  const N = 20, lo = binIdx * 5, hi = lo + 5;
  const rangeLabel = binIdx === N - 1 ? `${lo}% – 100%` : `${lo}% – ${hi}%`;
  const inBin = arr => arr
    .filter(x => { const p = x.score * 100; return p >= lo && (binIdx === N - 1 ? p <= 100 : p < hi); })
    .sort((a, b) => b.score - a.score);
  const ga = inBin(cmpData.individuals.a);
  const gb = inBin(cmpData.individuals.b);

  const colHtml = (items, label, color, groupVal) => {
    const colorSolid = color.replace('0.65', '1');
    const rows = items.map(x =>
      `<tr class="cmp-user-row" data-uid="${esc(x.userId)}" data-group="${esc(groupVal)}" data-consensus="${x.consensus}" data-awareness="${x.awareness}" data-score="${x.score}" style="cursor:pointer">` +
      `<td class="cmp-mono">${esc(x.userId.slice(0, 8))}…</td>` +
      `<td class="cmp-score-cell">${(x.score*100).toFixed(1)}%</td></tr>`
    ).join('');
    return `
      <div class="cmp-detail-col">
        <div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)} &mdash; ${fmtNum(items.length)}</div>
        ${items.length
          ? `<table class="cmp-detail-table">
               <colgroup><col><col style="width:68px"></colgroup>
               <thead><tr><th>User</th><th style="text-align:right">Score</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
          : '<p class="cmp-detail-empty">None in this range.</p>'}
      </div>`;
  };

  document.getElementById('compareDetailTitle').textContent = `Individual scores: ${rangeLabel}`;
  const content = document.getElementById('compareDetailContent');
  content.innerHTML = `<div class="cmp-detail-cols">${colHtml(ga, cmpLabelA, CMP_COLOR_A, cmpGroupA)}${colHtml(gb, cmpLabelB, CMP_COLOR_B, cmpGroupB)}</div>`;

  content.querySelectorAll('.cmp-user-row').forEach(tr => {
    tr.addEventListener('mouseenter', () => tr.style.background = '#EFF6FF');
    tr.addEventListener('mouseleave', () => tr.style.background = '');
    tr.addEventListener('click', () => {
      openUserDetail(
        { userSessionId: tr.dataset.uid,
          consensus: +tr.dataset.consensus,
          awareness: +tr.dataset.awareness,
          commonsensicality: +tr.dataset.score },
        { reference: tr.dataset.group, target: tr.dataset.group }
      );
    });
  });
}

function renderCmpStmtDetail(binIdx) {
  if (!cmpData) return;
  const N = 20, lo = binIdx * 5, hi = lo + 5;
  const rangeLabel = binIdx === N - 1 ? `${lo}% – 100%` : `${lo}% – ${hi}%`;
  const inBin = arr => arr
    .filter(x => { const p = x.score * 100; return p >= lo && (binIdx === N - 1 ? p <= 100 : p < hi); })
    .sort((a, b) => b.score - a.score);
  const ga = inBin(cmpData.statements.a);
  const gb = inBin(cmpData.statements.b);

  const colHtml = (items, label, color, groupVal) => {
    const colorSolid = color.replace('0.65', '1');
    const rows = items.map((x, i) => {
      const fixed = fixStatement(x.statement);
      const snip  = fixed.length > 60 ? fixed.slice(0, 57) + '…' : fixed;
      return `<tr class="cmp-stmt-row" data-idx="${i}" data-group="${esc(groupVal)}" style="cursor:pointer">` +
        `<td class="cmp-stmt-snip">${esc(snip)}</td>` +
        `<td class="cmp-score-cell">${(x.score*100).toFixed(1)}%</td></tr>`;
    }).join('');
    return `
      <div class="cmp-detail-col">
        <div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)} &mdash; ${fmtNum(items.length)}</div>
        ${items.length
          ? `<table class="cmp-detail-table">
               <colgroup><col><col style="width:68px"></colgroup>
               <thead><tr><th>Statement</th><th style="text-align:right">Score</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
          : '<p class="cmp-detail-empty">None in this range.</p>'}
      </div>`;
  };

  document.getElementById('compareDetailTitle').textContent = `Statement scores: ${rangeLabel}`;
  const content = document.getElementById('compareDetailContent');
  content.innerHTML = `<div class="cmp-detail-cols">${colHtml(ga, cmpLabelA, CMP_COLOR_A, cmpGroupA)}${colHtml(gb, cmpLabelB, CMP_COLOR_B, cmpGroupB)}</div>`;

  const itemsByGroup = { [cmpGroupA]: ga, [cmpGroupB]: gb };
  content.querySelectorAll('.cmp-stmt-row').forEach(tr => {
    tr.addEventListener('mouseenter', () => tr.style.background = '#EFF6FF');
    tr.addEventListener('mouseleave', () => tr.style.background = '');
    tr.addEventListener('click', () => {
      const items = itemsByGroup[tr.dataset.group];
      const x = items[+tr.dataset.idx];
      openStmtDetail(x, tr.dataset.group);
    });
  });
}

function stmtScoreColHtml(x, label, color) {
  const colorSolid = color.replace('0.65', '1');
  if (!x) return `<div class="cmp-detail-col"><div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)}</div><p class="cmp-detail-empty">No data for this group.</p></div>`;
  const N = x.n_ratings;
  const A = x.I_agree_mean;
  const B = x.others_agree_mean;
  const majYes = A >= 0.5;
  const fp = v => (v * 100).toFixed(1) + '%';
  const consensus = 2 * Math.abs(A - 0.5);
  const awareness = majYes ? B : 1 - B;
  const comm = Math.sqrt(consensus * awareness);
  return `
    <div class="cmp-detail-col">
      <div class="cmp-detail-group-hd" style="color:${colorSolid}">${esc(label)}</div>
      <ul class="cmp-score-expl">
        <li><strong>N</strong> = ${fmtNum(N)} ratings</li>
        <li><strong>I agree</strong>: ${fp(A)} &rarr; majority <strong>${majYes ? 'Yes' : 'No'}</strong></li>
        <li><strong>Consensus</strong>: 2&thinsp;&times;&thinsp;|${fp(A)}&thinsp;&minus;&thinsp;50%| = <strong>${fp(consensus)}</strong></li>
        <li><strong>Others agree</strong>: ${fp(B)} &rarr; <strong>awareness</strong> = <strong>${fp(awareness)}</strong></li>
        <li><strong>Commonsensicality</strong>: &radic;(${fp(consensus)}&thinsp;&times;&thinsp;${fp(awareness)}) = <strong>${fp(comm)}</strong></li>
      </ul>
    </div>`;
}

function stmtPropsHtml(statementId) {
  const row = stmtScoresAllRows.find(r => r.statementId === statementId);
  if (!row) return '';
  const rows = PROP_DEFS.map(({ key, v1, v0 }) => {
    const val = row[key];
    if (val === null || val === undefined) return `<tr><td class="cmp-prop-name">${esc(v1)} / ${esc(v0)}</td><td class="cmp-prop-val">—</td></tr>`;
    const label = val === 1 ? v1 : v0;
    const dot   = val === 1
      ? `<span class="popup-circle-filled">●</span>`
      : `<span class="popup-circle-empty">○</span>`;
    return `<tr><td class="cmp-prop-name">${esc(v1)} / ${esc(v0)}</td><td class="cmp-prop-val">${dot} ${esc(label)}</td></tr>`;
  }).join('');
  return `
    <div class="cmp-props-section">
      <div class="cmp-props-title">Statement properties</div>
      <table class="cmp-props-table"><tbody>${rows}</tbody></table>
    </div>`;
}

function renderScatterDetail(point) {
  const findStmt = (arr, sid) => arr.find(x => x.statementId === sid);
  const xa = cmpData ? findStmt(cmpData.statements.a, point.statementId) : null;
  const xb = cmpData ? findStmt(cmpData.statements.b, point.statementId) : null;
  const stmt = fixStatement(point.statement || '');
  document.getElementById('compareDetailTitle').textContent = 'Statement score comparison';
  document.getElementById('compareDetailContent').innerHTML = `
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
  const labelA = groupA === 'all' ? 'All countries' : groupA;
  const labelB = groupB === 'all' ? 'All countries' : groupB;

  compareSpinnerEl.classList.remove('hidden');
  let data;
  try {
    data = await fetch(`/api/group-compare?groupA=${encodeURIComponent(groupA)}&groupB=${encodeURIComponent(groupB)}`).then(r => r.json());
  } catch {
    compareSpinnerEl.classList.add('hidden');
    return;
  }
  compareSpinnerEl.classList.add('hidden');

  // Store globally for detail rendering
  cmpData   = data;
  cmpLabelA = labelA;
  cmpLabelB = labelB;
  cmpGroupA = groupA;
  cmpGroupB = groupB;

  // Helper: extract plain score arrays from enriched objects
  const scores = arr => arr.map(x => x.score);

  // Section 1: Individual commonsensicality
  const ia = data.individuals.a, ib = data.individuals.b;
  const iaS = scores(ia), ibS = scores(ib);
  const rawNA = data.individuals.raw_n_a;
  const rawNB = data.individuals.raw_n_b;
  const cmpIndivNoteA = (rawNA != null && ia.length < rawNA)
    ? ` (${fmtNum(ia.length)} of ${fmtNum(rawNA)})` : '';
  const cmpIndivNoteB = (rawNB != null && ib.length < rawNB)
    ? ` (${fmtNum(ib.length)} of ${fmtNum(rawNB)})` : '';
  const cmpIndivFootnote = (cmpIndivNoteA || cmpIndivNoteB)
    ? `<br><span class="cmp-filter-note">Not all users are shown — each must have rated ≥5 statements with ≥5 ratings in their own group.</span>`
    : '';
  document.getElementById('compareIndivSub').innerHTML =
    `<span style="color:${CMP_COLOR_A.replace('0.65','1')}">■</span> <strong>${esc(labelA)}</strong>: ${fmtNum(ia.length)}${cmpIndivNoteA} individuals, mean ${cmpMean(iaS)} &nbsp;·&nbsp; ` +
    `<span style="color:${CMP_COLOR_B.replace('0.65','1')}">■</span> <strong>${esc(labelB)}</strong>: ${fmtNum(ib.length)}${cmpIndivNoteB} individuals, mean ${cmpMean(ibS)}` +
    cmpIndivFootnote;
  const dIndiv = cohenD(iaS, ibS);
  document.getElementById('compareIndivEffect').innerHTML = dIndiv !== null
    ? `Effect size: Cohen's <em>d</em> = <strong>${Math.abs(dIndiv).toFixed(3)}</strong>`
    : '';
  if (compareIndivChartInst) compareIndivChartInst.destroy();
  compareIndivChartInst = makeCompareHistChart(
    'compareIndivChart', cmpBinScores(iaS), cmpBinScores(ibS), labelA, labelB,
    binIdx => renderCmpIndivDetail(binIdx)
  );

  // Section 2: Statement commonsensicality distributions
  const sa = data.statements.a, sb = data.statements.b;
  const saS = scores(sa), sbS = scores(sb);
  document.getElementById('compareStmtSub').innerHTML =
    `<span style="color:${CMP_COLOR_A.replace('0.65','1')}">■</span> <strong>${esc(labelA)}</strong>: ${fmtNum(sa.length)} statements, mean ${cmpMean(saS)} &nbsp;·&nbsp; ` +
    `<span style="color:${CMP_COLOR_B.replace('0.65','1')}">■</span> <strong>${esc(labelB)}</strong>: ${fmtNum(sb.length)} statements, mean ${cmpMean(sbS)}`;
  document.getElementById('compareStmtEffect').innerHTML = '';
  if (compareStmtChartInst) compareStmtChartInst.destroy();
  compareStmtChartInst = makeCompareHistChart(
    'compareStmtChart', cmpBinScores(saS), cmpBinScores(sbS), labelA, labelB,
    binIdx => renderCmpStmtDetail(binIdx)
  );

  // Section 3: Scatter plot of paired statement scores
  const paired = data.statements.paired;
  const r = paired.length >= 2 ? pearsonR(paired.map(p => p.score_a), paired.map(p => p.score_b)) : null;
  document.getElementById('compareScatterSub').innerHTML =
    `${fmtNum(paired.length)} statements common to both groups` +
    (r !== null ? ` &nbsp;·&nbsp; Pearson <em>r</em> = <strong>${r.toFixed(3)}</strong>` : '');
  if (compareScatterChartInst) compareScatterChartInst.destroy();
  compareScatterChartInst = paired.length
    ? makeScatterChart('compareScatterChart', paired, labelA, labelB, point => renderScatterDetail(point))
    : null;

  // Reset detail panel when groups change
  document.getElementById('compareDetailTitle').textContent = 'Click a bar or scatter point to explore';
  document.getElementById('compareDetailContent').innerHTML =
    '<p class="cmp-detail-placeholder">Select a histogram bar or scatter point on the left to see individuals or statements in that range.</p>';
}

compareGroupAEl.addEventListener('change', loadGroupCompare);
compareGroupBEl.addEventListener('change', loadGroupCompare);

async function init() {
  await populateSelects();
  loadStmtScores('all');
  loadGroupCompare();
}

init();
