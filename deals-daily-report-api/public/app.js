function formatCount(n) {
  return new Intl.NumberFormat('en-IN').format(n || 0);
}

function formatPct(n) {
  return `${(n || 0).toFixed(1)}%`;
}

function formatDisplayDate(dayKey) {
  return new Date(`${dayKey}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatAmount(n) {
  if (!n) return '—';
  return '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function showStatus(message) {
  const bar = document.getElementById('statusBar');
  if (!message) {
    bar.hidden = true;
    bar.textContent = '';
    return;
  }
  bar.hidden = false;
  bar.textContent = `⚠ ${message}`;
}

let state = {
  dateField: 'Created_Time',
  range: 'yesterday',
  customStart: null,
  customEnd: null,
  stages: [],
  agents: [],
  qualifiedOnly: true,
};

let lastReportData = null;

// Reusable checkbox multi-select: an "All" row plus one row per value, a toggle
// button summarizing the current selection, and outside-click / re-open close.
function setupMultiselect({ toggleId, panelId, allLabel, onChange }) {
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  let values = [];
  let selected = [];

  function updateToggleLabel() {
    if (!selected.length) toggle.textContent = allLabel;
    else if (selected.length === 1) toggle.textContent = selected[0];
    else toggle.textContent = `${selected.length} selected`;
  }

  function renderPanel() {
    panel.innerHTML = '';

    const allRow = document.createElement('label');
    allRow.className = 'multiselect-option multiselect-option--all';
    const allCheckbox = document.createElement('input');
    allCheckbox.type = 'checkbox';
    allCheckbox.checked = selected.length === 0;
    allCheckbox.addEventListener('change', () => {
      selected = [];
      updateToggleLabel();
      renderPanel();
      onChange(selected);
    });
    allRow.appendChild(allCheckbox);
    allRow.appendChild(document.createTextNode(allLabel));
    panel.appendChild(allRow);

    values.forEach(v => {
      const row = document.createElement('label');
      row.className = 'multiselect-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.includes(v);
      checkbox.addEventListener('change', () => {
        selected = checkbox.checked ? [...selected, v] : selected.filter(s => s !== v);
        updateToggleLabel();
        renderPanel();
        onChange(selected);
      });
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(v));
      panel.appendChild(row);
    });
  }

  toggle.addEventListener('click', () => {
    const willOpen = panel.hidden;
    document.querySelectorAll('.multiselect-panel').forEach(p => { p.hidden = true; });
    panel.hidden = !willOpen;
  });

  document.addEventListener('click', e => {
    if (!panel.hidden && !toggle.contains(e.target) && !panel.contains(e.target)) {
      panel.hidden = true;
    }
  });

  return {
    setValues(newValues) {
      values = newValues;
      renderPanel();
    },
  };
}

const stageMultiselect = setupMultiselect({
  toggleId: 'stageToggle',
  panelId: 'stagePanel',
  allLabel: 'All stages',
  onChange: selected => {
    state.stages = selected;
  },
});

const agentMultiselect = setupMultiselect({
  toggleId: 'agentToggle',
  panelId: 'agentPanel',
  allLabel: 'All agents',
  onChange: selected => {
    state.agents = selected;
  },
});

async function loadMeta() {
  try {
    const res = await fetch('/api/meta');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load filter options');
    stageMultiselect.setValues(data.stages || []);
    agentMultiselect.setValues(data.agents || []);
  } catch (err) {
    showStatus(err.message || 'Failed to load filter options');
  }
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderDateRow(row, isTotal) {
  const tr = document.createElement('tr');
  if (isTotal) tr.className = 'row-total';

  tr.appendChild(cell(isTotal ? 'Grand Total' : formatDisplayDate(row.date)));
  tr.appendChild(cell(formatCount(row.totalDeals)));
  tr.appendChild(cell(formatCount(row.probScoreQualified)));
  tr.appendChild(cell(formatPct(row.contributionPct)));
  tr.appendChild(cell(formatCount(row.lostCount), 'cell-lost'));
  tr.appendChild(cell(formatCount(row.wonCount), 'cell-won'));
  tr.appendChild(cell(formatCount(row.workingHourCount)));
  tr.appendChild(cell(formatCount(row.workingHourSameDayCallCount)));
  tr.appendChild(cell(formatCount(row.nonWorkingHourCount)));
  tr.appendChild(cell(row.avgFirstCallFormatted || '—', row.avgFirstCallFormatted ? null : 'cell-muted'));
  tr.appendChild(cell(formatCount(row.under30MinCount)));
  tr.appendChild(cell(formatCount(row.connectedCount)));

  return tr;
}

function renderProbabilityRow(row, isTotal) {
  const tr = document.createElement('tr');
  if (isTotal) tr.className = 'row-total';

  tr.appendChild(cell(isTotal ? 'Grand Total' : `${row.probability}%`));
  tr.appendChild(cell(isTotal ? '—' : (row.dominantStage || '—')));
  tr.appendChild(cell(formatCount(row.totalDeals)));
  tr.appendChild(cell(formatPct(row.contributionPct)));
  tr.appendChild(cell(formatCount(row.lostCount), 'cell-lost'));
  tr.appendChild(cell(formatCount(row.wonCount), 'cell-won'));
  tr.appendChild(cell(formatCount(row.workingHourCount)));
  tr.appendChild(cell(formatCount(row.workingHourSameDayCallCount)));
  tr.appendChild(cell(formatCount(row.nonWorkingHourCount)));
  tr.appendChild(cell(row.avgFirstCallFormatted || '—', row.avgFirstCallFormatted ? null : 'cell-muted'));
  tr.appendChild(cell(formatCount(row.under30MinCount)));
  tr.appendChild(cell(formatCount(row.connectedCount)));

  return tr;
}

function renderEmptyRow(tbody, message, colSpan) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.className = 'cell-muted';
  td.style.textAlign = 'center';
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// Sums counts across rows and recomputes rate-based fields correctly (never averages
// pre-computed percentages/averages — sums the underlying numerator/denominator instead).
function sumRows(rows) {
  const totals = {
    totalDeals: 0, probScoreQualified: 0, lostCount: 0, wonCount: 0,
    workingHourCount: 0, workingHourSameDayCallCount: 0, nonWorkingHourCount: 0,
    under30MinCount: 0, connectedCount: 0,
    sameDayCallSecondsSum: 0, sameDayCallDealCount: 0,
  };
  rows.forEach(row => {
    totals.totalDeals += row.totalDeals;
    totals.probScoreQualified += row.probScoreQualified;
    totals.lostCount += row.lostCount;
    totals.wonCount += row.wonCount;
    totals.workingHourCount += row.workingHourCount;
    totals.workingHourSameDayCallCount += row.workingHourSameDayCallCount || 0;
    totals.nonWorkingHourCount += row.nonWorkingHourCount;
    totals.under30MinCount += row.under30MinCount;
    totals.connectedCount += row.connectedCount;
    totals.sameDayCallSecondsSum += row.sameDayCallSecondsSum || 0;
    totals.sameDayCallDealCount += row.sameDayCallDealCount || 0;
  });
  totals.probScorePct = totals.totalDeals ? Math.round((totals.probScoreQualified / totals.totalDeals) * 1000) / 10 : 0;
  totals.avgFirstCallFormatted = totals.sameDayCallDealCount
    ? formatHHMMSSFromSeconds(totals.sameDayCallSecondsSum / totals.sameDayCallDealCount)
    : null;
  return totals;
}

// Contribution % = this row's share of total deal volume across the current view
// (sum of totalDeals), not a rate derived from any single row's own fields.
function withContributionPct(rows) {
  const grandTotalDeals = rows.reduce((sum, r) => sum + r.totalDeals, 0);
  return rows.map(r => ({
    ...r,
    contributionPct: grandTotalDeals ? Math.round((r.totalDeals / grandTotalDeals) * 1000) / 10 : 0,
  }));
}

function formatHHMMSSFromSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function setTotalDealsMeta(elementId, count) {
  document.getElementById(elementId).textContent = `Total deals: ${formatCount(count)}`;
}

function renderDateTable(rows) {
  const tbody = document.getElementById('reportBody');
  tbody.innerHTML = '';
  setTotalDealsMeta('reportMeta', rows.reduce((sum, r) => sum + r.totalDeals, 0));
  if (!rows.length) {
    renderEmptyRow(tbody, 'No deals in this range', 12);
    return;
  }
  const withPct = withContributionPct(rows);
  withPct.forEach(row => tbody.appendChild(renderDateRow(row, false)));
  tbody.appendChild(renderDateRow({ ...sumRows(rows), contributionPct: 100 }, true));
}

function renderProbabilityTable() {
  const tbody = document.getElementById('probabilityBody');
  tbody.innerHTML = '';
  if (!lastReportData) return;

  const rows = lastReportData.probabilityRows;
  setTotalDealsMeta('probabilityMeta', rows.reduce((sum, r) => sum + r.totalDeals, 0));

  if (!rows.length) {
    renderEmptyRow(tbody, 'No deals in this range', 12);
    return;
  }
  const withPct = withContributionPct(rows);
  withPct.forEach(row => tbody.appendChild(renderProbabilityRow(row, false)));
  tbody.appendChild(renderProbabilityRow({ ...sumRows(rows), contributionPct: 100 }, true));
}

function renderAgentTable(agentPivot) {
  const thead = document.getElementById('agentTableHead');
  const tbody = document.getElementById('agentTableBody');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  setTotalDealsMeta('agentMeta', agentPivot.rows.reduce((sum, r) => sum + r.total, 0));

  const probabilities = agentPivot.probabilities;
  const colCount = probabilities.length + 2; // agent + total

  const headRow = document.createElement('tr');
  headRow.appendChild((() => { const th = document.createElement('th'); th.textContent = 'Agent'; return th; })());
  probabilities.forEach(p => {
    const th = document.createElement('th');
    th.textContent = `${p}%`;
    headRow.appendChild(th);
  });
  const totalTh = document.createElement('th');
  totalTh.textContent = 'Total';
  headRow.appendChild(totalTh);
  thead.appendChild(headRow);

  if (!agentPivot.rows.length) {
    renderEmptyRow(tbody, 'No deals in this range', colCount);
    return;
  }

  agentPivot.rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(row.agent));
    probabilities.forEach(p => tr.appendChild(cell(formatCount(row.byProbability[p]))));
    tr.appendChild(cell(formatCount(row.total)));
    tbody.appendChild(tr);
  });

  const totalRow = document.createElement('tr');
  totalRow.className = 'row-total';
  totalRow.appendChild(cell('Grand Total'));
  let grandTotal = 0;
  probabilities.forEach(p => {
    const colSum = agentPivot.rows.reduce((sum, r) => sum + (r.byProbability[p] || 0), 0);
    grandTotal += colSum;
    totalRow.appendChild(cell(formatCount(colSum)));
  });
  totalRow.appendChild(cell(formatCount(grandTotal)));
  tbody.appendChild(totalRow);
}

// One row per (agent, probability score) combination, full metric set (working
// hours, same-day call timing, etc.) — same shape as the By-date/By-probability tables.
function renderClosedLostAgentFlatTable(closedLostAgentRows) {
  const tbody = document.getElementById('closedLostAgentFlatBody');
  tbody.innerHTML = '';
  setTotalDealsMeta('closedLostMeta', closedLostAgentRows.reduce((sum, r) => sum + r.totalDeals, 0));

  if (!closedLostAgentRows.length) {
    renderEmptyRow(tbody, 'No closed lost deals in this range', 10);
    return;
  }

  const withPct = withContributionPct(closedLostAgentRows);
  withPct.forEach(row => tbody.appendChild(renderClosedLostAgentFlatRow(row, false)));
  tbody.appendChild(renderClosedLostAgentFlatRow({ ...sumRows(closedLostAgentRows), contributionPct: 100 }, true));
}

function renderClosedLostAgentFlatRow(row, isTotal) {
  const tr = document.createElement('tr');
  if (isTotal) tr.className = 'row-total';

  tr.appendChild(cell(isTotal ? 'Grand Total' : row.agent));
  tr.appendChild(cell(isTotal ? '—' : `${row.probability}%`));
  tr.appendChild(cell(formatCount(row.totalDeals)));
  tr.appendChild(cell(formatPct(row.contributionPct)));
  tr.appendChild(cell(formatCount(row.workingHourCount)));
  tr.appendChild(cell(formatCount(row.workingHourSameDayCallCount)));
  tr.appendChild(cell(formatCount(row.nonWorkingHourCount)));
  tr.appendChild(cell(row.avgFirstCallFormatted || '—', row.avgFirstCallFormatted ? null : 'cell-muted'));
  tr.appendChild(cell(formatCount(row.under30MinCount)));
  tr.appendChild(cell(formatCount(row.connectedCount)));

  return tr;
}

function renderDumpTable(dealsDump, whatsAppCount) {
  const tbody = document.getElementById('dumpBody');
  tbody.innerHTML = '';

  const metaEl = document.getElementById('dumpMeta');
  const scopeNote = `includes ${formatCount(whatsAppCount)} WhatsApp-triggered · Probability Score ≥ 70% only`;
  const metaText = dealsDump.truncated
    ? `Showing most recent ${formatCount(dealsDump.dump.length)} of ${formatCount(dealsDump.total)} deals · ${scopeNote}`
    : `${formatCount(dealsDump.total)} deals · ${scopeNote}`;
  metaEl.textContent = metaText;
  document.getElementById('dumpDetailMeta').textContent = `Total deals: ${formatCount(dealsDump.total)}`;

  if (!dealsDump.dump.length) {
    renderEmptyRow(tbody, 'No deals in this range', 14);
    return;
  }

  dealsDump.dump.forEach(d => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(formatDateTime(d.createdTime)));
    tr.appendChild(cell(formatDateTime(d.modifiedTime)));
    tr.appendChild(cell(d.stage || '—'));
    tr.appendChild(cell(d.probability != null ? `${d.probability}%` : '—'));
    tr.appendChild(cell(d.qualified ? 'Yes' : 'No', d.qualified ? 'cell-won' : 'cell-muted'));
    tr.appendChild(cell(formatAmount(d.amount)));
    tr.appendChild(cell(d.mobile || '—'));
    tr.appendChild(cell(d.owner || '—'));
    tr.appendChild(cell(d.triggerEvent || '—'));
    const isSameDayCall = d.firstCallTime && d.createdTime.slice(0, 10) === d.firstCallTime.slice(0, 10);
    tr.appendChild(cell(isSameDayCall ? formatDateTime(d.firstCallTime) : '—', isSameDayCall ? null : 'cell-muted'));
    tr.appendChild(cell(d.callType || '—'));
    tr.appendChild(cell(d.callDurationSeconds != null ? formatCount(d.callDurationSeconds) : '—'));
    tr.appendChild(cell(d.callConnected == null ? '—' : (d.callConnected ? 'Yes' : 'No'), d.callConnected ? 'cell-won' : 'cell-muted'));
    tr.appendChild(cell(isSameDayCall ? d.callDiffFormatted : '—', isSameDayCall ? null : 'cell-muted'));
    tbody.appendChild(tr);
  });
}

function renderFilterMeta(data) {
  const el = document.getElementById('filterMeta');
  const startLabel = formatDisplayDate(data.rangeStart.slice(0, 10));
  const endLabel = formatDisplayDate(data.rangeEnd.slice(0, 10));
  el.textContent =
    `${startLabel} – ${endLabel}\n` +
    `${formatCount(data.rawDealCount)} deals in range\n` +
    `${formatCount(data.excludedWhatsAppCount)} WhatsApp-triggered excluded\n` +
    `${formatCount(data.dedupedDealCount)} after dedup` +
    (data.qualifiedOnly ? `\n${formatCount(data.qualifiedDealCount)} at ≥70% probability` : '');
  el.style.whiteSpace = 'pre-line';
}

async function loadReport(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  const applyBtn = document.getElementById('applyFilters');
  refreshBtn.disabled = true;
  applyBtn.disabled = true;
  applyBtn.textContent = 'Applying…';
  showStatus(null);
  try {
    const params = new URLSearchParams({
      dateField: state.dateField,
      range: state.range,
      qualifiedOnly: state.qualifiedOnly ? 'true' : 'false',
    });
    if (forceRefresh) params.set('refresh', 'true');
    if (state.range === 'custom' && state.customStart && state.customEnd) {
      params.set('start', state.customStart);
      params.set('end', state.customEnd);
    }
    if (state.stages.length) params.set('stage', state.stages.join(','));
    if (state.agents.length) params.set('agent', state.agents.join(','));

    const res = await fetch(`/api/daily-report?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);

    lastReportData = data;
    renderDateTable(data.rows);
    renderProbabilityTable();
    renderAgentTable(data.agentPivot);
    renderClosedLostAgentFlatTable(data.closedLostAgentRows);
    renderDumpTable(data.dealsDump, data.dumpWhatsAppCount);

    renderFilterMeta(data);
    document.getElementById('updatedAt').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString('en-IN');
  } catch (err) {
    showStatus(err.message || 'Failed to load report');
  } finally {
    refreshBtn.disabled = false;
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply';
  }
}

const customForm = document.getElementById('customRangeForm');
const customStartInput = document.getElementById('customStart');
const customEndInput = document.getElementById('customEnd');

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === state.dateField) return;
    document.querySelector('.tab-btn.is-active').classList.remove('is-active');
    document.querySelector('.tab-btn.is-active')?.setAttribute('aria-selected', 'false');
    btn.classList.add('is-active');
    btn.setAttribute('aria-selected', 'true');
    state.dateField = btn.dataset.tab;
  });
});

document.querySelectorAll('.option-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = btn.dataset.range;

    if (range === 'custom') {
      customForm.hidden = false;
      if (!customEndInput.value) {
        const today = new Date();
        const past = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        customEndInput.value = today.toISOString().slice(0, 10);
        customStartInput.value = past.toISOString().slice(0, 10);
      }
      document.querySelector('.option-btn.is-active')?.classList.remove('is-active');
      btn.classList.add('is-active');
      return;
    }

    customForm.hidden = true;
    if (range === state.range) return;
    document.querySelector('.option-btn.is-active')?.classList.remove('is-active');
    btn.classList.add('is-active');
    state.range = range;
  });
});

document.getElementById('qualifiedOnlyToggle').addEventListener('change', e => {
  state.qualifiedOnly = e.target.checked;
});

document.getElementById('refreshBtn').addEventListener('click', () => loadReport(true));

document.getElementById('applyFilters').addEventListener('click', () => {
  if (state.range === 'custom') {
    if (!customStartInput.value || !customEndInput.value) return;
    state.customStart = customStartInput.value;
    state.customEnd = customEndInput.value;
  }
  loadReport(false);
  document.getElementById('filtersPanel').hidden = true;
});

function csvEscape(text) {
  const s = String(text ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Reads the rendered table's own rows (thead + tbody), so it always matches
// exactly what's on screen — including dynamic columns like the By-agent pivot.
function tableToCSV(table) {
  const lines = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.children).map(td => csvEscape(td.textContent.trim()));
    lines.push(cells.join(','));
  });
  return lines.join('\r\n');
}

function downloadCSV(filename, csvContent) {
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

document.querySelectorAll('.export-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const table = document.getElementById(btn.dataset.exportTable);
    if (!table) return;
    const dateLabel = (state.range === 'custom' && state.customStart && state.customEnd)
      ? `${state.customStart}_to_${state.customEnd}`
      : state.range;
    downloadCSV(`${btn.dataset.exportFilename}_${dateLabel}`, tableToCSV(table));
  });
});

const filtersToggle = document.getElementById('filtersToggle');
const filtersPanel = document.getElementById('filtersPanel');

filtersToggle.addEventListener('click', () => {
  filtersPanel.hidden = !filtersPanel.hidden;
});

document.addEventListener('click', e => {
  if (!filtersPanel.hidden && !filtersToggle.contains(e.target) && !filtersPanel.contains(e.target)) {
    filtersPanel.hidden = true;
  }
});

loadMeta();
loadReport(false);
