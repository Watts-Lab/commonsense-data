const FEAT_DEFS = [
  {
    key: 'fact', v1: 'Fact', v0: 'Opinion',
    def1: "Something that can be demonstrated to be correct or incorrect, independently of anyone's opinion.",
    def0: "Something that someone might think is true, but that cannot be demonstrated to be objectively correct or incorrect.",
  },
  {
    key: 'physical', v1: 'Physical', v0: 'Social',
    def1: 'Refers to objective features of the world described by natural rules and measurable empirically or derived logically.',
    def0: 'Refers to beliefs, preferences, institutions, and socially constructed rules of human origin.',
  },
  {
    key: 'literal language', v1: 'Literal Language', v0: 'Figure of Speech',
    def1: 'Plain and ordinary language that means exactly what it says.',
    def0: 'Contains an aphorism, metaphor, hyperbole, or another nonliteral expression.',
  },
  {
    key: 'positive', v1: 'Positive', v0: 'Normative',
    def1: 'Describes something in the world, such as an empirical regularity or scientific law.',
    def0: 'Expresses a judgment, belief, value, social norm, or convention.',
  },
  {
    key: 'knowledge', v1: 'Knowledge', v0: 'Reasoning',
    def1: 'States an observation about the world; it may be true or false, subjective or objective.',
    def0: 'Presents a conclusion reached by combining knowledge and logic.',
  },
  {
    key: 'everyday', v1: 'Everyday', v0: 'Abstract',
    def1: 'Concerns something people encounter, or could encounter, in ordinary experience.',
    def0: 'Concerns regularities or conclusions that cannot be observed or reached solely through individual experience.',
  },
];

const PAGE_SIZE = 50;
const featFilter = Object.fromEntries(FEAT_DEFS.map(({ key }) => [key, '']));
let models = [];
let currentModel = null;
let currentEvaluation = null;
let allRows = [];
let filtered = [];
let page = 0;
let loadVersion = 0;

const elements = {
  model: document.getElementById('modelSelect'),
  judge: document.getElementById('judgeSelect'),
  view: document.getElementById('viewMode'),
  display: document.getElementById('displayMode'),
  filterSource: document.getElementById('filterSource'),
  agreement: document.getElementById('agreementFilter'),
  commonsense: document.getElementById('commonsenseFilter'),
  search: document.getElementById('searchInput'),
  status: document.getElementById('loadStatus'),
  count: document.getElementById('countLabel'),
  caption: document.getElementById('tableCaption'),
  filterRow: document.getElementById('filterRow'),
  tablePanel: document.getElementById('tablePanel'),
  summaryPanel: document.getElementById('summaryPanel'),
  pagination: document.getElementById('paginationBar'),
  head: document.getElementById('tableHead'),
  body: document.getElementById('stmtBody'),
  prev: document.getElementById('btnPrev'),
  next: document.getElementById('btnNext'),
  pageInfo: document.getElementById('pageInfo'),
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) : 0;
}

function generatorAssessment(row, def) {
  const raw = String(row[def.key] ?? '').trim();
  const classification = raw === '1' ? def.v1 : raw === '0' ? def.v0 : '';
  return {
    classification,
    confidence: String(row[`${def.key}_confidence`] ?? '').trim(),
    explanation: String(row[`${def.key}_explanation`] ?? '').trim(),
  };
}

function judgeAssessment(row, def) {
  const evaluation = row._evaluation;
  if (!evaluation) return null;
  const raw = String(evaluation[`${def.key}_classification`] ?? '').trim();
  const normalized = raw.toLowerCase();
  const classification = normalized === def.v1.toLowerCase()
    ? def.v1
    : normalized === def.v0.toLowerCase()
      ? def.v0
      : raw;
  return {
    classification,
    confidence: String(evaluation[`${def.key}_confidence`] ?? '').trim(),
    explanation: String(evaluation[`${def.key}_explanation`] ?? '').trim(),
  };
}

function assessmentValue(assessment, def) {
  if (!assessment) return '';
  const value = assessment.classification.toLowerCase();
  if (value === def.v1.toLowerCase()) return '1';
  if (value === def.v0.toLowerCase()) return '0';
  return '';
}

function agrees(row, def) {
  const generated = generatorAssessment(row, def);
  const judged = judgeAssessment(row, def);
  return judged ? assessmentValue(generated, def) === assessmentValue(judged, def) : null;
}

function agreementCount(row) {
  if (!row._evaluation) return null;
  return FEAT_DEFS.reduce((total, def) => total + (agrees(row, def) ? 1 : 0), 0);
}

function confidenceBar(assessment, role) {
  if (!assessment) return '<span class="pending-label">Pending</span>';
  const confidence = Number(assessment.confidence) || 0;
  const roleClass = role.toLowerCase().startsWith('judge') ? 'judge' : 'generator';
  return `<span class="confidence-value" role="img" aria-label="${esc(role)} confidence: ${confidence ? `${confidence} out of 4` : 'not provided'}" ` +
    `data-label="${esc(`${role}: ${assessment.classification || 'Not provided'}`)}" data-confidence="${esc(assessment.confidence)}" ` +
    `data-explanation="${esc(assessment.explanation)}"><span class="confidence-fill ${roleClass}" style="width:${Math.min(100, confidence / 4 * 100)}%"></span></span>`;
}

function assessmentLine(role, assessment) {
  if (!assessment) {
    return `<div class="assessment-line"><span class="assessment-role">${esc(role)}</span><span class="pending-label">Pending</span><span></span></div>`;
  }
  return `<div class="assessment-line"><span class="assessment-role">${esc(role)}</span>` +
    `<span class="assessment-value">${esc(assessment.classification || 'Not provided')}</span>` +
    `${confidenceBar(assessment, role)}</div>`;
}

function buildHeader() {
  const mode = elements.view.value;
  const hasJudge = Boolean(currentEvaluation);
  elements.head.innerHTML = '<th class="col-num">#</th><th class="col-stmt">Statement</th>' +
    `<th class="col-meta">${mode === 'generated' || !hasJudge ? 'Gen. rationale' : mode === 'compare' ? 'Judge result' : 'Judge common sense'}</th>`;

  FEAT_DEFS.forEach((def, index) => {
    const th = document.createElement('th');
    th.className = `col-feat${index % 2 ? ' col-alt' : ''}`;
    th.dataset.key = def.key;
    const options = [['', 'All'], ['1', def.v1], ['0', def.v0]];
    const headerLines = def.key === 'literal language'
      ? ['Literal Language /', 'Figure of', 'Speech']
      : [`${def.v1} /`, def.v0];
    th.innerHTML = `<span class="th-label">${headerLines.map(line => `<span>${esc(line)}</span>`).join('')}</span>` +
      `<div class="feature-options" role="group" aria-label="${esc(`${def.v1} / ${def.v0}`)} filter">` +
      options.map(([value, label]) => {
        const shortLabel = def.key === 'literal language' && value
          ? (value === '1' ? 'Literal' : 'Figurative')
          : label;
        return `<div class="feature-option-row"><button type="button" class="feature-option" data-value="${value}" ` +
          `aria-pressed="${value === featFilter[def.key]}">${esc(shortLabel)}</button>` +
          (value ? `<button type="button" class="th-help-btn" data-key="${esc(def.key)}" data-value="${value}" aria-label="Definition of ${esc(label)}">?</button>` : '') +
          '</div>';
      }).join('') + '</div>';
    elements.head.appendChild(th);
  });
  updateFilterHeaders();
}

function updateFilterHeaders() {
  elements.head.querySelectorAll('th.col-feat[data-key]').forEach(th => {
    const value = featFilter[th.dataset.key];
    th.querySelectorAll('.feature-option').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
    });
    th.classList.toggle('filter-v1', value === '1');
    th.classList.toggle('filter-v0', value === '0');
  });
}

function featureCell(row, def, index) {
  const generated = generatorAssessment(row, def);
  const judged = judgeAssessment(row, def);
  const mode = elements.view.value;
  let content;
  if (mode === 'generated') {
    content = assessmentLine('Gen', generated);
  } else if (mode === 'judged') {
    content = assessmentLine('Judge', judged);
  } else {
    const agreement = agrees(row, def);
    const compactLabel = assessment => {
      if (!assessment) return 'Pending';
      if (def.key !== 'literal language') return assessment.classification;
      return assessmentValue(assessment, def) === '1' ? 'Literal' : 'Figurative';
    };
    const state = agreement === null ? 'pending' : agreement ? 'agree' : 'disagree';
    const stateLabel = state === 'pending' ? 'Pending' : state === 'agree' ? 'Agreement' : 'Disagreement';
    let heading;
    if (state === 'disagree') {
      const genLabel = compactLabel(generated);
      const judgeLabel = compactLabel(judged);
      heading = `<div class="feat-pair-heading" title="${esc(`${stateLabel}: ${genLabel} ≠ ${judgeLabel}`)}">` +
        `<span class="feat-pair-label feat-pair-label--gen">${esc(genLabel)}</span>` +
        `<span class="feat-icon feat-icon--disagree" aria-hidden="true">≠</span>` +
        `<span class="sr-only">${esc(stateLabel)}: </span>` +
        `<span class="feat-pair-label feat-pair-label--judge">${esc(judgeLabel)}</span></div>`;
    } else {
      const icon = state === 'pending' ? '•' : '✓';
      const classification = agreement
        ? compactLabel(generated)
        : `${compactLabel(generated)} / ${compactLabel(judged)}`;
      heading = `<div class="feat-verdict feat-verdict--${state}" title="${esc(`${stateLabel}: ${classification}`)}">` +
        `<span class="feat-icon" aria-hidden="true">${icon}</span>` +
        `<span class="sr-only">${esc(stateLabel)}: </span>` +
        `<span class="feat-value">${esc(classification)}</span></div>`;
    }
    content = heading + `<div class="feat-bars">${confidenceBar(generated, 'Generator')}${confidenceBar(judged, 'Judge')}</div>`;
  }
  return `<td class="col-feat${index % 2 ? ' col-alt' : ''}"><div class="feat-cell">${content}</div></td>`;
}

function commonsenseCell(row) {
  if (elements.view.value === 'generated' || !currentEvaluation) {
    return String(row.commonsense ?? '').trim()
      ? '<span class="status-chip neutral">Provided</span>'
      : '<span class="pending-label">—</span>';
  }
  if (!row._evaluation) return '<span class="pending-label">Pending</span>';
  const isCommonSense = String(row._evaluation.commonsense).trim() === '1';
  return `<span class="status-chip ${isCommonSense ? 'yes' : 'no'}">${isCommonSense ? 'Yes' : 'No'}</span>`;
}

function renderTable() {
  const start = page * PAGE_SIZE;
  const rows = filtered.slice(start, start + PAGE_SIZE);
  const showComparison = elements.view.value === 'compare' && currentEvaluation;
  const columnCount = 3 + FEAT_DEFS.length;

  if (!rows.length) {
    elements.body.innerHTML = `<tr class="empty-row"><td colspan="${columnCount}">No statements found.</td></tr>`;
    elements.pageInfo.textContent = '';
    elements.prev.disabled = true;
    elements.next.disabled = true;
    elements.count.textContent = '0 statements';
    return;
  }

  elements.body.innerHTML = rows.map(row => {
    const count = agreementCount(row);
    const resultCell = showComparison
      ? `<td class="col-meta judge-result">${commonsenseCell(row)}${count === null
          ? '<span class="meta-sub pending-label">Not evaluated</span>'
          : `<span class="meta-sub"><strong>${count}/6</strong> ${count === 6 ? 'same' : `${6 - count} differ`}</span>`}</td>`
      : `<td class="col-meta">${commonsenseCell(row)}</td>`;
    return `<tr data-source-row="${row._sourceRow}">` +
      `<td class="col-num">${row._sourceRow}</td>` +
      `<td class="col-stmt"><button type="button" class="statement-button" aria-haspopup="dialog">${esc(row.statement)}</button></td>` +
      resultCell +
      FEAT_DEFS.map((def, index) => featureCell(row, def, index)).join('') + '</tr>';
  }).join('');

  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  elements.pageInfo.textContent = `Page ${page + 1} of ${pages} · ${filtered.length} statement${filtered.length === 1 ? '' : 's'}`;
  elements.count.textContent = `${filtered.length} statement${filtered.length === 1 ? '' : 's'}`;
  elements.prev.disabled = page === 0;
  elements.next.disabled = page >= pages - 1;
}

function updateFiltersBadge() {
  const badge = document.getElementById('filtersBadge');
  const active = (elements.search.value.trim() ? 1 : 0) +
    (elements.agreement.value !== 'all' ? 1 : 0) +
    (elements.commonsense.value !== 'all' ? 1 : 0) +
    Object.values(featFilter).filter(Boolean).length;
  badge.hidden = !active;
  if (active) badge.textContent = String(active);
}

function applyFilter() {
  const query = elements.search.value.trim().toLowerCase();
  const source = elements.filterSource.value;
  filtered = allRows.filter(row => {
    if (query && !String(row.statement || '').toLowerCase().includes(query)) return false;
    for (const def of FEAT_DEFS) {
      const expected = featFilter[def.key];
      if (!expected) continue;
      const assessment = source === 'judge' ? judgeAssessment(row, def) : generatorAssessment(row, def);
      if (assessmentValue(assessment, def) !== expected) return false;
    }
    const agreementFilter = elements.agreement.value;
    const count = agreementCount(row);
    if (agreementFilter === 'pending' && count !== null) return false;
    if (agreementFilter !== 'all' && agreementFilter !== 'pending' && count !== Number(agreementFilter)) return false;
    const commonSenseFilter = elements.commonsense.value;
    if (commonSenseFilter === 'pending' && row._evaluation) return false;
    if ((commonSenseFilter === '0' || commonSenseFilter === '1') &&
        (!row._evaluation || String(row._evaluation.commonsense).trim() !== commonSenseFilter)) return false;
    return true;
  });
  page = 0;
  renderTable();
  updateFiltersBadge();
}

function renderSummary() {
  if (!currentEvaluation) {
    elements.summaryPanel.innerHTML = '<div class="summary-empty">Choose a generator with a completed judge evaluation to see agreement.</div>';
    return;
  }
  const evaluated = allRows.filter(row => row._evaluation);
  const commonSenseYes = evaluated.filter(row => String(row._evaluation.commonsense).trim() === '1').length;
  let agreements = 0;
  evaluated.forEach(row => { agreements += agreementCount(row); });
  const comparisonTotal = evaluated.length * FEAT_DEFS.length;

  const featureRows = FEAT_DEFS.map(def => {
    const count = evaluated.filter(row => agrees(row, def)).length;
    const value = percent(count, evaluated.length);
    return `<div class="summary-feature"><span>${esc(def.v1)} / ${esc(def.v0)}</span>` +
      `<div class="summary-track" role="img" aria-label="${value}% agreement"><div class="summary-fill" style="width:${value}%"></div></div>` +
      `<strong>${value}%</strong></div>`;
  }).join('');

  elements.summaryPanel.innerHTML = '<div class="summary-grid">' +
    `<article class="summary-card"><span>Evaluation progress</span><strong>${evaluated.length} / ${allRows.length}</strong></article>` +
    `<article class="summary-card"><span>Overall feature agreement</span><strong>${percent(agreements, comparisonTotal)}%</strong></article>` +
    `<article class="summary-card"><span>Judge says common sense</span><strong>${percent(commonSenseYes, evaluated.length)}%</strong><small>${commonSenseYes} of ${evaluated.length} evaluated</small></article>` +
    '</div><section class="agreement-summary"><h2>Agreement by feature</h2>' + featureRows + '</section>';
}

function updateView() {
  if (!currentEvaluation && elements.view.value !== 'generated') elements.view.value = 'generated';
  const mode = elements.view.value;
  const hasJudge = Boolean(currentEvaluation);
  elements.filterSource.disabled = mode !== 'compare' || !hasJudge;
  if (mode === 'generated') elements.filterSource.value = 'generator';
  if (mode === 'judged') elements.filterSource.value = 'judge';
  elements.agreement.disabled = mode !== 'compare' || !hasJudge;
  elements.commonsense.disabled = mode === 'generated' || !hasJudge;
  if (elements.agreement.disabled) elements.agreement.value = 'all';
  if (elements.commonsense.disabled) elements.commonsense.value = 'all';
  const judgeName = currentEvaluation ? currentEvaluation.name : 'no judge evaluation';
  elements.caption.innerHTML = mode === 'compare'
    ? `<span class="caption-legend"><i class="legend-swatch generator"></i>Generator <i class="legend-swatch judge"></i>Judge</span>` +
      `One label means both models chose the same side; two labels mark a disagreement. Confidence uses a 1–4 scale. Judge: ${esc(judgeName)}.`
    : mode === 'judged'
      ? `<span class="caption-legend"><i class="legend-swatch judge"></i>Judge</span>Labels and confidence on a 1–4 scale. Judge: ${esc(judgeName)}.`
      : '<span class="caption-legend"><i class="legend-swatch generator"></i>Generator</span>Labels, confidence, and explanations recorded during generation.';
  buildHeader();
  applyFilter();
}

function updateDisplay() {
  const summary = elements.display.value === 'summary';
  elements.summaryPanel.hidden = !summary;
  elements.tablePanel.hidden = summary;
  elements.pagination.hidden = summary;
  elements.filterRow.hidden = summary;
  elements.caption.hidden = summary;
  if (summary) renderSummary();
}

function assessmentPanel(title, assessment, role) {
  const roleClass = role ? ` assessment-panel--${role}` : '';
  if (!assessment) {
    return `<article class="assessment-panel${roleClass}"><h4>${esc(title)}</h4><p class="pending-label">Evaluation pending</p></article>`;
  }
  const confidence = assessment.confidence ?
    `<p class="feature-confidence">Confidence: ${esc(assessment.confidence)} / 4</p>` : '';
  return `<article class="assessment-panel${roleClass}"><h4>${esc(title)}</h4>` +
    `<strong>${esc(assessment.classification || 'Not provided')}</strong>` +
    confidence +
    `<p>${esc(assessment.explanation || 'No explanation provided.')}</p></article>`;
}

const statementDialog = document.getElementById('statementDialog');
function showStatement(row) {
  document.getElementById('statementText').textContent = row.statement;
  document.getElementById('statementModel').textContent = currentEvaluation
    ? `Generated by ${currentModel.name} · Judged by ${currentEvaluation.name}`
    : `Generated by ${currentModel?.name || row.model || 'unknown model'}`;

  const generatedRationale = String(row.commonsense ?? '').trim();
  const judgeCommonSense = row._evaluation
    ? (String(row._evaluation.commonsense).trim() === '1' ? 'Yes' : 'No')
    : null;
  document.getElementById('statementCommonsense').innerHTML =
    `<div class="comparison-grid">${assessmentPanel('Generator rationale', generatedRationale ? {
      classification: 'Provided', confidence: '', explanation: generatedRationale,
    } : null, 'generator')}${currentEvaluation ? assessmentPanel('Judge', row._evaluation ? {
      classification: judgeCommonSense,
      confidence: '',
      explanation: String(row._evaluation.commonsense_explanation ?? '').trim(),
    } : null, 'judge') : ''}</div>`;

  document.getElementById('statementFeatures').innerHTML = FEAT_DEFS.map(def => {
    const generated = generatorAssessment(row, def);
    const judged = judgeAssessment(row, def);
    const agreement = agrees(row, def);
    const badge = currentEvaluation
      ? `<span class="agreement-badge ${agreement === null ? '' : agreement ? 'agree' : 'disagree'}">${agreement === null ? 'Pending' : agreement ? 'Agree' : 'Disagree'}</span>`
      : '';
    const featureTitle = elements.view.value === 'generated'
      ? generated.classification
      : elements.view.value === 'judged'
        ? (judged?.classification || 'Pending')
        : agreement
          ? generated.classification
          : `${generated.classification} / ${judged?.classification || 'Pending'}`;
    let panels = assessmentPanel('Generator', generated, 'generator');
    if (elements.view.value === 'judged') panels = assessmentPanel('Judge', judged, 'judge');
    if (elements.view.value === 'compare') panels += assessmentPanel('Judge', judged, 'judge');
    return `<section class="statement-feature"><h3>${esc(featureTitle)}${badge}</h3>` +
      `<div class="comparison-grid ${elements.view.value === 'generated' || elements.view.value === 'judged' ? 'single' : ''}">${panels}</div></section>`;
  }).join('');
  hideConfidenceTooltip();
  statementDialog.showModal();
  statementDialog.scrollTop = 0;
}

const featPopup = document.getElementById('featPopup');
let activeHelpButton = null;
function showFeatureHelp(button) {
  const def = FEAT_DEFS.find(item => item.key === button.dataset.key);
  if (!def) return;
  activeHelpButton = button;
  const positive = button.dataset.value === '1';
  featPopup.innerHTML = `<div class="popup-entry"><div class="popup-label">${esc(positive ? def.v1 : def.v0)}</div>` +
    `<div class="popup-def">${esc(positive ? def.def1 : def.def0)}</div></div>`;
  featPopup.classList.add('visible');
  const rect = button.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - 160;
  let top = rect.bottom + 8;
  if (left + 320 > window.innerWidth - 8) left = window.innerWidth - 328;
  if (left < 8) left = 8;
  if (top + featPopup.offsetHeight > window.innerHeight - 8) top = rect.top - featPopup.offsetHeight - 8;
  featPopup.style.left = `${left}px`;
  featPopup.style.top = `${Math.max(8, top)}px`;
}

function hideFeatureHelp() {
  featPopup.classList.remove('visible');
  activeHelpButton = null;
}

const confidenceTooltip = document.getElementById('dotTooltip');
let confidenceTarget = null;
function moveConfidenceTooltip(x, y) {
  const width = 260;
  const height = confidenceTooltip.offsetHeight || 80;
  let left = x + 14;
  let top = y + 14;
  if (left + width > window.innerWidth - 8) left = x - width - 8;
  if (top + height > window.innerHeight - 8) top = y - height - 8;
  confidenceTooltip.style.left = `${left}px`;
  confidenceTooltip.style.top = `${Math.max(8, top)}px`;
}

function showConfidenceTooltip(bar, x, y) {
  if (!bar.dataset.explanation) return;
  document.getElementById('dtLabel').textContent = bar.dataset.label;
  document.getElementById('dtConfidence').textContent = bar.dataset.confidence
    ? `confidence ${bar.dataset.confidence}/4`
    : '';
  document.getElementById('dtExplanation').textContent = bar.dataset.explanation;
  confidenceTooltip.classList.add('visible');
  moveConfidenceTooltip(x, y);
}

function hideConfidenceTooltip() {
  confidenceTooltip.classList.remove('visible');
  confidenceTarget = null;
}

async function loadCsv(path) {
  const response = await fetch(encodePath(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = Papa.parse(await response.text(), { header: true, skipEmptyLines: true });
  if (result.errors.length) throw new Error(result.errors[0].message);
  return result;
}

function validateGenerator(result) {
  const fields = result.meta.fields || [];
  const required = ['statement', ...FEAT_DEFS.map(def => def.key)];
  if (!required.every(field => fields.includes(field))) {
    throw new Error('Generator CSV is missing statement or feature columns.');
  }
}

function validateEvaluation(result) {
  const fields = result.meta.fields || [];
  const required = ['source_row', 'statement', 'commonsense',
    ...FEAT_DEFS.flatMap(def => [`${def.key}_classification`, `${def.key}_confidence`, `${def.key}_explanation`])];
  if (!required.every(field => fields.includes(field))) {
    throw new Error('Evaluation CSV is missing source, feature, or common-sense columns.');
  }
}

async function attachEvaluation(version) {
  allRows.forEach(row => { row._evaluation = null; });
  if (!currentEvaluation) return 0;
  const result = await loadCsv(currentEvaluation.path);
  if (version !== loadVersion) return 0;
  validateEvaluation(result);
  const bySourceRow = new Map();
  result.data.forEach(evaluation => {
    const sourceRow = Number(evaluation.source_row);
    if (!Number.isInteger(sourceRow) || sourceRow < 1) return;
    if (bySourceRow.has(sourceRow)) throw new Error(`Evaluation contains duplicate source_row ${sourceRow}.`);
    bySourceRow.set(sourceRow, evaluation);
  });
  for (const row of allRows) {
    const evaluation = bySourceRow.get(row._sourceRow);
    if (!evaluation) continue;
    if (String(evaluation.statement).trim() !== String(row.statement).trim()) {
      throw new Error(`Evaluation source_row ${row._sourceRow} does not match the generator statement.`);
    }
    row._evaluation = evaluation;
  }
  return allRows.filter(row => row._evaluation).length;
}

function populateJudges() {
  const evaluations = currentModel?.evaluations || [];
  elements.judge.replaceChildren(...evaluations.map(evaluation => {
    const option = document.createElement('option');
    option.value = evaluation.path;
    option.textContent = evaluation.name;
    return option;
  }));
  elements.judge.disabled = !evaluations.length;
  currentEvaluation = evaluations[0] || null;
}

async function loadModel() {
  const version = ++loadVersion;
  currentModel = models.find(model => model.path === elements.model.value) || null;
  currentEvaluation = null;
  allRows = [];
  filtered = [];
  elements.status.textContent = 'Loading…';
  populateJudges();
  try {
    const generatorResult = await loadCsv(currentModel.path);
    if (version !== loadVersion) return;
    validateGenerator(generatorResult);
    allRows = generatorResult.data
      .filter(row => String(row.statement || '').trim())
      .map((row, index) => ({ ...row, _sourceRow: index + 1, _evaluation: null }));
    const evaluated = await attachEvaluation(version);
    if (version !== loadVersion) return;
    elements.view.value = currentEvaluation ? 'compare' : 'generated';
    const points = new Set(allRows.map(row => FEAT_DEFS.map(def => row[def.key]).join(',')));
    elements.status.textContent = currentEvaluation
      ? `${evaluated}/${allRows.length} evaluated · ${points.size}/64 design points`
      : `${points.size}/64 design points · no judge evaluation`;
    updateView();
    renderSummary();
    updateDisplay();
  } catch (error) {
    if (version !== loadVersion) return;
    elements.status.textContent = `Could not load data: ${error.message}`;
    updateView();
  }
}

async function loadJudge() {
  const version = ++loadVersion;
  currentEvaluation = (currentModel?.evaluations || []).find(item => item.path === elements.judge.value) || null;
  elements.status.textContent = 'Loading evaluation…';
  try {
    const evaluated = await attachEvaluation(version);
    if (version !== loadVersion) return;
    const points = new Set(allRows.map(row => FEAT_DEFS.map(def => row[def.key]).join(',')));
    elements.status.textContent = `${evaluated}/${allRows.length} evaluated · ${points.size}/64 design points`;
    if (currentEvaluation && elements.view.value === 'generated') elements.view.value = 'compare';
    updateView();
    renderSummary();
  } catch (error) {
    if (version !== loadVersion) return;
    elements.status.textContent = `Could not load evaluation: ${error.message}`;
    currentEvaluation = null;
    updateView();
  }
}

async function loadModels() {
  try {
    const response = await fetch('api/models', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    models = await response.json();
    elements.model.replaceChildren(...models.map(model => {
      const option = document.createElement('option');
      option.value = model.path;
      option.textContent = model.name;
      return option;
    }));
    elements.model.disabled = !models.length;
    if (models.length) await loadModel();
    else elements.status.textContent = 'No model statements found in data/ yet.';
  } catch (error) {
    elements.status.textContent = 'Could not discover models. Start the explorer with python server.py.';
  }
}

elements.head.addEventListener('click', event => {
  const help = event.target.closest('.th-help-btn');
  if (help) {
    event.stopPropagation();
    showFeatureHelp(help);
    return;
  }
  const option = event.target.closest('.feature-option');
  if (!option) return;
  const th = option.closest('th.col-feat');
  featFilter[th.dataset.key] = option.dataset.value;
  updateFilterHeaders();
  applyFilter();
});
elements.head.addEventListener('mouseover', event => {
  const help = event.target.closest('.th-help-btn');
  if (help && help !== activeHelpButton) showFeatureHelp(help);
});
elements.head.addEventListener('mouseout', event => {
  if (event.target.closest('.th-help-btn') && !featPopup.contains(event.relatedTarget)) hideFeatureHelp();
});
elements.body.addEventListener('click', event => {
  const tr = event.target.closest('tr[data-source-row]');
  if (!tr) return;
  const row = allRows.find(item => item._sourceRow === Number(tr.dataset.sourceRow));
  if (row) showStatement(row);
});
elements.body.addEventListener('mouseover', event => {
  const bar = event.target.closest('.confidence-value');
  if (bar && bar !== confidenceTarget) {
    confidenceTarget = bar;
    showConfidenceTooltip(bar, event.clientX, event.clientY);
  }
});
elements.body.addEventListener('mousemove', event => {
  if (confidenceTarget) moveConfidenceTooltip(event.clientX, event.clientY);
});
elements.body.addEventListener('mouseout', event => {
  if (event.target.closest('.confidence-value')) hideConfidenceTooltip();
});

elements.model.addEventListener('change', loadModel);
elements.judge.addEventListener('change', loadJudge);
elements.view.addEventListener('change', updateView);
elements.display.addEventListener('change', updateDisplay);
elements.filterSource.addEventListener('change', applyFilter);
elements.agreement.addEventListener('change', applyFilter);
elements.commonsense.addEventListener('change', applyFilter);
elements.search.addEventListener('input', applyFilter);
elements.prev.addEventListener('click', () => { page -= 1; renderTable(); });
elements.next.addEventListener('click', () => { page += 1; renderTable(); });
document.getElementById('closeStatement').addEventListener('click', () => statementDialog.close());
statementDialog.addEventListener('click', event => {
  const rect = statementDialog.getBoundingClientRect();
  if (event.target === statementDialog &&
      (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) {
    statementDialog.close();
  }
});
document.getElementById('tablePanel').addEventListener('scroll', hideFeatureHelp);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideFeatureHelp();
    hideConfidenceTooltip();
  }
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    const panel = btn.dataset.panel;
    document.getElementById('panelExplorer').hidden = panel !== 'explorer';
  });
});

buildHeader();
loadModels();
