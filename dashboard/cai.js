"use strict";
/* ═══════════════════════════════════════════════════════════════════════
   LUCIRA CUSTOMER ACTIVITIES INTELLIGENCE — engine
   Single live source: customer-activities-api (Node/Express, direct Zoho
   CRM REST — no BigQuery, no static snapshot). See dashboard's "Logic" tab
   for the full calculation chain (dedup, FRT, working-hours rules).
   ═══════════════════════════════════════════════════════════════════════ */
const CONFIG = {
  // window.CAI_API_BASE lets the hosting page override this (the copy served
  // same-origin by customer-activities-api sets it to '' before loading this
  // file) — this file itself stays identical in both places.
  API_BASE: typeof window.CAI_API_BASE === 'string' ? window.CAI_API_BASE : 'https://customer-activities-api-385594025448.asia-south1.run.app',
};

const STATE = { data: null, range: 'today', customFrom: null, customTo: null, selectedOwners: [], selectedStages: [], tab: 'overview', sort: {}, chat: [], chatLoading: false };

/* ── generic helpers ─────────────────────────────────────────── */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtInt(n) { return (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-IN'); }
function fmtPct(n, dp) { return (n == null || isNaN(n)) ? '—' : n.toFixed(dp == null ? 1 : dp) + '%'; }
function fmtMin(m) { if (m == null) return '—'; if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; }
function yn(b) { return b == null ? '—' : (b ? 'Yes' : 'No'); }
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function downloadBlob(content, filename, mime) {
  if (mime === 'text/csv' && content.charCodeAt(0) !== 0xFEFF) content = '﻿' + content;
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function csvOf(rows) {
  return rows.map(r => r.map(v => {
    v = (v == null ? '' : '' + v);
    // Long pure-digit strings (Zoho record IDs, 10-digit mobiles) get mangled
    // by Excel's CSV import into scientific notation, silently losing
    // precision on IDs. Force text with the ="..." formula trick.
    if (/^\d{9,}$/.test(v)) return `="${v}"`;
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\n');
}
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2400); }

// "· Owner: A, B · Stage: C" suffix for section headers, from the report's
// (possibly multi-select) selectedOwners/selectedStages arrays.
function filterScopeSuffix(D) {
  let s = '';
  if (D.selectedOwners && D.selectedOwners.length) s += ` · Owner: ${D.selectedOwners.join(', ')}`;
  if (D.selectedStages && D.selectedStages.length) s += ` · Stage: ${D.selectedStages.join(', ')}`;
  return s;
}

/* ═══════════════════════════════════════════════════════════════════════
   TABS
   ═══════════════════════════════════════════════════════════════════════ */
const TABS = [
  ['overview', '◈ Overview'],
  ['stage', '◆ Deal Stage'],
  ['callsfrt', '☎ Calls & FRT'],
  ['hours', '◷ Working Hours'],
  ['notcalled', '⚠ Not Called'],
  ['detail', '☰ Detail Table'],
  ['quality', '✓ Data Quality'],
  ['insights', '✦ Insights'],
  ['ask', '✨ Ask AI'],
  ['logic', '⚙ Logic', 'logic'],
];

function buildTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = TABS.map(([k, label, cls]) =>
    `<div class="tab ${cls || ''} ${STATE.tab === k ? 'active' : ''}" data-tab="${k}">${label}</div>`).join('');
  nav.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => {
    STATE.tab = el.dataset.tab; buildTabs(); render();
  }));
}

// Shared by loadData so every tab filters on the exact same
// selected range (Today/Yesterday/Last 7/Last 30/Custom) AND the same
// selected Deal Owner(s) / Deal Stage(s) (each multi-select: 0 selected = all).
function rangeParams(forceRefresh) {
  const p = new URLSearchParams({
    range: STATE.range,
    owner: STATE.selectedOwners.length ? STATE.selectedOwners.join(',') : 'all',
    stage: STATE.selectedStages.length ? STATE.selectedStages.join(',') : 'all',
  });
  if (forceRefresh) p.set('refresh', 'true');
  if (STATE.range === 'custom') {
    if (STATE.customFrom) p.set('start', STATE.customFrom);
    if (STATE.customTo) p.set('end', STATE.customTo);
  }
  return p;
}

/* ── multi-select filter dropdowns (Owner / Stage) ──────────────────────
   Hand-rolled checkbox dropdown (no native <select multiple> — awful UX).
   The wrapper <div> (#ownerMsel / #stageMsel) is static markup that's wired
   ONCE in boot(); only its button label + panel innerHTML get refreshed
   whenever fresh option lists arrive, so the delegated listeners survive. */
function multiSelectSummary(allLabel, values, selected) {
  if (!selected.length) return allLabel;
  if (selected.length === 1) return selected[0];
  return `${selected.length} of ${values.length} selected`;
}
function syncMultiSelect(wrapId, allLabel, values, stateKey) {
  const wrap = document.getElementById(wrapId);
  if (!wrap || !values) return;
  // Drop any previously-picked values that no longer exist in the fresh list.
  STATE[stateKey] = STATE[stateKey].filter(v => values.includes(v));
  const selected = STATE[stateKey];
  wrap.querySelector('.msel-btn').innerHTML = `${esc(multiSelectSummary(allLabel, values, selected))} <span class="msel-car">▾</span>`;
  wrap.querySelector('.msel-panel').innerHTML = `
    <div class="msel-list">
      <label class="msel-opt"><input type="checkbox" data-msel-all ${!selected.length ? 'checked' : ''}> ${esc(allLabel)}</label>
      <div class="msel-sep"></div>
      ${values.map(v => `<label class="msel-opt"><input type="checkbox" data-msel-val="${esc(v)}" ${selected.includes(v) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
    </div>
    <div class="msel-footer"><button type="button" class="btn gold msel-apply">Apply</button></div>
  `;
}
// Toggle-open/close + checkbox handling, wired once (the wrapper survives
// across data refreshes — only syncMultiSelect's innerHTML changes). Checking
// boxes only stages the selection in STATE; nothing reloads until Apply is
// clicked, so picking several names doesn't require reopening the panel.
function wireMultiSelect(wrapId, stateKey, allLabel, valuesOf) {
  const wrap = document.getElementById(wrapId);
  const panel = wrap.querySelector('.msel-panel');
  wrap.querySelector('.msel-btn').addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.msel-panel').forEach(p => { if (p !== panel) p.hidden = true; });
    panel.hidden = !panel.hidden;
  });
  // Clicks inside the panel (checkboxes, labels, Apply) must never bubble to
  // the document-level "click outside to close" listener below — otherwise
  // every checkbox click closed the panel before a second one could be picked.
  panel.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('.msel-apply')) { panel.hidden = true; onRangeChanged(); }
  });
  panel.addEventListener('change', e => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.hasAttribute('data-msel-all')) {
      STATE[stateKey] = [];
    } else {
      const v = t.getAttribute('data-msel-val');
      STATE[stateKey] = t.checked
        ? [...new Set([...STATE[stateKey], v])]
        : STATE[stateKey].filter(x => x !== v);
    }
    syncMultiSelect(wrapId, allLabel, valuesOf(), stateKey);
  });
}
document.addEventListener('click', () => document.querySelectorAll('.msel-panel').forEach(p => { p.hidden = true; }));

// Every tab reloads on any date/owner/stage filter change, so the selected
// scope applies dashboard-wide.
function onRangeChanged() {
  loadData(false);
}

/* ═══════════════════════════════════════════════════════════════════════
   LOAD
   ═══════════════════════════════════════════════════════════════════════ */
async function loadData(forceRefresh) {
  setSrc('connecting', 'Connecting…');
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/report?${rangeParams(forceRefresh)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    STATE.data = j;
    syncMultiSelect('ownerMsel', 'All Owners', j.owners, 'selectedOwners');
    syncMultiSelect('stageMsel', 'All Stages', j.stages, 'selectedStages');
    setSrc('live', 'Live · Zoho CRM');
    document.getElementById('freshPill').textContent = `Data as of ${new Date(j.dataAsOf).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}`;
  } catch (e) {
    console.error('Load failed:', e);
    setSrc('err', 'Zoho CRM not connected');
    document.getElementById('freshPill').textContent = e.message.includes('Failed to fetch')
      ? 'API unreachable — start customer-activities-api' : e.message;
    STATE.data = STATE.data || null;
  }
  render();
}
function setSrc(cls, txt) {
  const dot = document.getElementById('srcDot');
  dot.className = 'src-dot ' + (cls === 'live' ? 'live' : cls === 'err' ? 'err' : '');
  document.getElementById('srcTxt').textContent = txt;
}

/* ═══════════════════════════════════════════════════════════════════════
   RENDER ROOT
   ═══════════════════════════════════════════════════════════════════════ */
function render() {
  const main = document.getElementById('main');
  if (STATE.tab === 'logic') { main.innerHTML = renderLogic(); return; }

  if (!STATE.data) {
    main.innerHTML = `<div class="hero"><h1>Waiting for live Zoho CRM connection</h1>
      <p>This dashboard reads directly from Zoho CRM Deals via <code>customer-activities-api</code> (no BigQuery, no static snapshot, no mock data — per spec). Start the API (<code>cd customer-activities-api && npm start</code>) once <code>.env</code> has a valid ZOHO_CLIENT_ID / SECRET / REFRESH_TOKEN with Deals + Calls read scope, then click Refresh Data above.</p></div>
      <div class="card"><div class="pad"><h3>What will appear here</h3><p class="hint" style="margin-top:8px">Unique customer activities, deal stage breakdown, call coverage, first-response-time distribution, working-hours split, follow-up backlog and a full drill-down table — all recomputed live on every refresh. See the <b>Logic</b> tab for exactly how each number is calculated.</p></div></div>`;
    return;
  }

  const fns = { overview: renderOverview, stage: renderStage, callsfrt: renderCallsFrt, hours: renderHours, notcalled: renderNotCalled, detail: renderDetail, quality: renderQuality, insights: renderInsights, ask: renderAsk };
  main.innerHTML = (fns[STATE.tab] || renderOverview)(STATE.data);
  wireInteractions();
}

/* ═══════════════════════════════════════════════════════════════════════
   SHARED UI BUILDERS
   ═══════════════════════════════════════════════════════════════════════ */
function kpi(label, val, sub, cls) {
  return `<div class="kpi ${cls || ''}"><div class="lab">${esc(label)}</div><div class="val">${val}</div>${sub ? `<div class="sub2">${sub}</div>` : ''}</div>`;
}
function kpiCmp(label, cur) {
  if (!cur) return kpi(label, '—');
  return null;
}
function card(title, hint, body, id) {
  return `<div class="card" ${id ? `id="${id}"` : ''}><div class="pad"><div class="ct"><h3>${esc(title)}</h3>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>${body}</div></div>`;
}
function sectionHead(eyebrow, title, sub) {
  return `<div class="sec-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>`;
}
function emptyMsg(txt) { return `<div class="empty">${esc(txt)}</div>`; }

function table(rows, cols, opts) {
  opts = opts || {};
  if (!rows.length) return emptyMsg(opts.emptyText || 'No records in this range.');
  const thead = cols.map(c => `<th class="${c.num ? 'num' : ''}" data-key="${c.key}">${esc(c.label)}</th>`).join('');
  const tbody = rows.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] == null ? '—' : r[c.key])}</td>`).join('')}</tr>`).join('');
  let tfoot = '';
  if (opts.totalRow) {
    const t = opts.totalRow;
    const cells = cols.map((c, i) => {
      if (i === 0) return `<td class="${c.num ? 'num' : ''}"><b>${esc(t[c.key] != null ? t[c.key] : 'Grand Total')}</b></td>`;
      const v = t[c.key];
      return `<td class="${c.num ? 'num' : ''}">${v == null ? '' : `<b>${c.fmt ? c.fmt(v, t) : esc(v)}</b>`}</td>`;
    }).join('');
    tfoot = `<tfoot><tr class="total-row">${cells}</tr></tfoot>`;
  }
  return `<div class="scroll-x scroll-y"><table class="dt"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody>${tfoot}</table></div>`;
}

function svg(w, h, inner) { return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`; }

function hbarChart(items, opts) {
  opts = opts || {};
  const w = 640, rowH = 26, pad = 4, labelW = opts.labelW || 160, h = items.length * (rowH + pad) + 10;
  const max = Math.max(1, ...items.map(i => i.value));
  const barW = w - labelW - 60;
  let y = 6;
  let bars = '';
  for (const it of items) {
    const bw = Math.max(2, (it.value / max) * barW);
    bars += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11.5" fill="var(--ink-2)">${esc(trunc(it.label, 22))}</text>
      <rect x="${labelW}" y="${y}" width="${bw}" height="${rowH - 6}" rx="5" fill="${it.color || 'var(--gold)'}" opacity="${it.opacity || 0.85}"/>
      <text x="${labelW + bw + 8}" y="${y + rowH / 2 + 4}" font-size="11.5" fill="var(--ink)">${it.valueLabel != null ? it.valueLabel : it.value}</text>`;
    y += rowH + pad;
  }
  return svg(w, h, bars);
}

function lineChartSvg(points, opts) {
  opts = opts || {};
  if (!points.length) return emptyMsg('No trend data.');
  const w = 900, h = 220, padL = 44, padB = 26, padT = 14, padR = 14;
  const max = Math.max(1, ...points.map(p => p.value));
  const stepX = (w - padL - padR) / Math.max(1, points.length - 1);
  const xy = p => [padL + p.i * stepX, padT + (h - padT - padB) * (1 - p.value / max)];
  const pts = points.map((p, i) => ({ ...p, i }));
  const path = pts.map((p, i) => { const [x, y] = xy(p); return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
  const area = path + ` L${xy(pts[pts.length - 1])[0]},${h - padB} L${xy(pts[0])[0]},${h - padB} Z`;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = padT + (h - padT - padB) * (1 - f);
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--grid)"/><text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(max * f)}</text>`;
  }).join('');
  const xTicks = pts.filter((_, i) => i % Math.ceil(pts.length / 10 || 1) === 0).map(p => {
    const [x] = xy(p); return `<text x="${x}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(p.label)}</text>`;
  }).join('');
  const dots = pts.map(p => { const [x, y] = xy(p); return `<circle cx="${x}" cy="${y}" r="2.6" fill="${opts.color || 'var(--gold)'}"/>`; }).join('');
  // Skip labeling every point once there are too many to fit without overlap.
  const labelEvery = pts.length > 20 ? 2 : 1;
  const valueLabels = pts.filter((_, i) => i % labelEvery === 0).map(p => {
    const [x, y] = xy(p);
    return `<text x="${x}" y="${Math.max(10, y - 8)}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--ink)">${fmtInt(p.value)}</text>`;
  }).join('');
  return svg(w, h, `${gridLines}<path d="${area}" fill="${opts.color || 'var(--gold)'}" opacity=".12"/><path d="${path}" fill="none" stroke="${opts.color || 'var(--gold)'}" stroke-width="2.2"/>${dots}${valueLabels}${xTicks}`);
}

function donutSvg(parts, opts) {
  opts = opts || {};
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return emptyMsg('No data.');
  const r = 70, cx = 90, cy = 90, sw = 26;
  let angle = -90, arcs = '';
  for (const p of parts) {
    const frac = p.value / total, sweep = frac * 360;
    const large = sweep > 180 ? 1 : 0;
    const a0 = angle * Math.PI / 180, a1 = (angle + sweep) * Math.PI / 180;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    arcs += `<path d="M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}" fill="none" stroke="${p.color}" stroke-width="${sw}"/>`;
    angle += sweep;
  }
  return svg(180, 180, arcs + `<text x="90" y="84" text-anchor="middle" font-size="20" fill="var(--ink)" font-family="var(--serif)">${fmtInt(total)}</text><text x="90" y="102" text-anchor="middle" font-size="9.5" fill="var(--muted)">TOTAL</text>`);
}

function legendOf(items) {
  return `<div class="legend">${items.map(i => `<span><i style="background:${i.color}"></i>${esc(i.label)} — ${fmtInt(i.value)}</span>`).join('')}</div>`;
}

function wireInteractions() {
  document.querySelectorAll('[data-csv]').forEach(btn => btn.addEventListener('click', () => {
    const rows = JSON.parse(btn.dataset.csv);
    downloadBlob(csvOf(rows), (btn.dataset.name || 'export') + '.csv', 'text/csv');
    toast('CSV exported');
  }));
  const chatForm = document.getElementById('chatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', e => { e.preventDefault(); sendChatQuestion(); });
    const log = document.getElementById('chatLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
}
function csvBtn(name, rows) { return `<button class="btn no-print" data-csv='${JSON.stringify(rows).replace(/'/g, '&#39;')}' data-name="${name}">⭳ CSV</button>`; }

/* ═══════════════════════════════════════════════════════════════════════
   OVERVIEW
   ═══════════════════════════════════════════════════════════════════════ */
function renderOverview(D) {
  const k = D.selected.kpis, p = D.presets;
  const kpiRow1 = [
    kpi('Unique Customer Activities', fmtInt(k.uniqueCustomerActivities)),
    kpi('Deals with Customer Activity', fmtInt(k.dealsWithActivity)),
    kpi('Total Call Attempts', fmtInt(k.callsMade), 'Total call events — a customer called twice counts as 2'),
    kpi('Customers Not Called', fmtInt(k.customersNotCalled), null, k.customersNotCalled > 0 ? 'neg' : ''),
  ].join('');
  const kpiRow2 = [
    kpi('Call Coverage %', fmtPct(k.callCoveragePct)),
    kpi('Average FRT', k.avgFrtFmt || '—'),
    kpi('Median FRT', k.medianFrtFmt || '—'),
    kpi('Working Hour Activities', fmtInt(k.workingHourActivities), fmtPct(k.workingHourPct) + ' of total'),
    kpi('Non-Working Hour Activities', fmtInt(k.nonWorkingHourActivities), fmtPct(k.nonWorkingHourPct) + ' of total'),
  ].join('');

  const presetRows = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 Days'], ['30d', 'Last 30 Days']].map(([key, label]) => {
    const pk = p[key];
    return { period: label, unique: pk.uniqueCustomerActivities, deals: pk.dealsWithActivity, called: pk.customersCalled, notCalled: pk.customersNotCalled, coverage: fmtPct(pk.callCoveragePct), avgFrt: pk.avgFrtFmt || '—' };
  });

  const trend = D.dailyTrend.slice(0, 30).reverse(); // oldest-first, for the charts below (left-to-right time series)
  const trendChart = lineChartSvg(trend.map(t => ({ label: t.date.slice(5), value: t.uniqueCustomers })), { color: 'var(--gold)' });
  const coverageChart = lineChartSvg(trend.map(t => ({ label: t.date.slice(5), value: t.callCoveragePct || 0 })), { color: 'var(--good)' });

  // Table below wants newest-first — D.dailyTrend already comes newest-first
  // from the server, so just cap it (no reverse) — plus a summed Total row.
  const trendTableRows = D.dailyTrend.slice(0, 30);
  const totalUnique = trendTableRows.reduce((s, t) => s + t.uniqueCustomers, 0);
  const totalDeals = trendTableRows.reduce((s, t) => s + t.deals, 0);
  const totalCalled = trendTableRows.reduce((s, t) => s + t.called, 0);
  const totalNotCalled = trendTableRows.reduce((s, t) => s + t.notCalled, 0);
  const totalCoveragePct = totalUnique ? Math.round((totalCalled / totalUnique) * 1000) / 10 : null;
  // Avg FRT can't just be averaged across days (each day has a different
  // sample size) — weight each day's Avg FRT by that day's Called count.
  const frtDays = trendTableRows.filter(t => t.avgFrtMinutes != null && t.called);
  const frtWeight = frtDays.reduce((s, t) => s + t.called, 0);
  const totalAvgFrtMinutes = frtWeight ? Math.round(frtDays.reduce((s, t) => s + t.avgFrtMinutes * t.called, 0) / frtWeight) : null;
  const totalRow = {
    datePretty: 'Total', uniqueCustomers: totalUnique, deals: totalDeals, called: totalCalled,
    notCalled: totalNotCalled, callCoveragePct: totalCoveragePct, avgFrtFmt: totalAvgFrtMinutes != null ? fmtMin(totalAvgFrtMinutes) : '—',
  };
  const trendTableWithTotal = [...trendTableRows, totalRow];

  return `
  ${sectionHead('Live · Zoho CRM', 'Customer Activities Overview', `Range: ${D.rangeFrom} to ${D.rangeTo} · Field: Customer Activities (${D.activityField})${filterScopeSuffix(D)}`)}
  <div class="grid g-4" style="margin-bottom:14px">${kpiRow1}</div>
  <div class="grid g-5" style="margin-bottom:16px">${kpiRow2}</div>
  ${card('Period Comparison', 'Today · Yesterday · Last 7 Days · Last 30 Days', table(presetRows, [
    { key: 'period', label: 'Period' }, { key: 'unique', label: 'Unique Customers', num: true, fmt: fmtInt },
    { key: 'deals', label: 'Deals', num: true, fmt: fmtInt }, { key: 'called', label: 'Called', num: true, fmt: fmtInt },
    { key: 'notCalled', label: 'Not Called', num: true, fmt: fmtInt }, { key: 'coverage', label: 'Coverage', num: true },
    { key: 'avgFrt', label: 'Avg FRT', num: true },
  ]))}
  <div class="grid g-2">
    ${card('Daily Unique Customer Activity Trend', '30 days', trendChart)}
    ${card('Call Coverage % Trend', '30 days', coverageChart)}
  </div>
  ${card('Overall Daily Trend — Full Data Table', `Every day currently in the fetched window (${trendTableRows.length} days), newest to oldest, with totals below`, table(trendTableWithTotal, [
    { key: 'datePretty', label: 'Date', fmt: v => v === 'Total' ? `<b>${esc(v)}</b>` : esc(v) }, { key: 'uniqueCustomers', label: 'Unique Customers', num: true, fmt: fmtInt },
    { key: 'deals', label: 'Deals', num: true, fmt: fmtInt }, { key: 'called', label: 'Called', num: true, fmt: fmtInt },
    { key: 'notCalled', label: 'Not Called', num: true, fmt: fmtInt }, { key: 'callCoveragePct', label: 'Coverage', num: true, fmt: fmtPct },
    { key: 'avgFrtFmt', label: 'Avg FRT' },
  ]) + csvBtn('overall_daily_trend', [['Date', 'Unique Customers', 'Deals', 'Called', 'Not Called', 'Coverage %', 'Avg FRT'], ...trendTableWithTotal.map(t => [t.datePretty, t.uniqueCustomers, t.deals, t.called, t.notCalled, t.callCoveragePct, t.avgFrtFmt])]))}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   DEAL STAGE
   ═══════════════════════════════════════════════════════════════════════ */
function renderStage(D) {
  const rows = D.selected.stageDistribution;
  const colors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
  const byActivity = hbarChart(rows.map((r, i) => ({ label: r.stage, value: r.deals, color: colors[i % 5] })));
  const calledVsNot = rows.map((r, i) => ({ stage: r.stage, called: r.called, notCalled: r.notCalled }));

  return `
  ${sectionHead('Deal Stage', 'Customer Activities by Deal Stage', 'Every Customer Activity, joined to its current Zoho Deal stage')}
  ${card('Customer Activities by Deal Stage', null, byActivity)}
  ${card('Called vs Not Called by Deal Stage', 'Deal-level: at least one post-activity call = Called', hbarChart(
    calledVsNot.flatMap((r, i) => [
      { label: r.stage + ' · Called', value: r.called, color: 'var(--good)' },
      { label: r.stage + ' · Not Called', value: r.notCalled, color: 'var(--crit)' },
    ])
  ))}
  ${card('Deal Stage Distribution', 'Won/Lost only populated where the stage itself is Closed Won/Closed Lost', table(rows, [
    { key: 'stage', label: 'Stage' }, { key: 'uniqueCustomers', label: 'Unique Customers', num: true, fmt: fmtInt },
    { key: 'deals', label: 'Deals', num: true, fmt: fmtInt }, { key: 'called', label: 'Called', num: true, fmt: fmtInt },
    { key: 'notCalled', label: 'Not Called', num: true, fmt: fmtInt }, { key: 'callCoveragePct', label: 'Call Coverage %', num: true, fmt: fmtPct },
    { key: 'avgFrtMinutes', label: 'Avg FRT', num: true, fmt: fmtMin }, { key: 'won', label: 'Won', num: true, fmt: fmtInt },
    { key: 'lost', label: 'Lost', num: true, fmt: fmtInt },
  ]) + csvBtn('deal_stage_distribution', [Object.keys(rows[0] || {}), ...rows.map(r => Object.values(r))]))}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   CALLS & FRT
   ═══════════════════════════════════════════════════════════════════════ */
function renderCallsFrt(D) {
  const dist = D.selected.frtDistribution;
  const colors = { '0-15 min': 'var(--good)', '15-30 min': 'var(--series-3)', '30-60 min': 'var(--warn)', '1-2 hr': 'var(--series-2)', '2+ hr': 'var(--crit)', 'Called — No Timed FRT': 'var(--info)', 'No Response': 'var(--muted)' };
  const chart = hbarChart(dist.map(d => ({ label: d.bucket, value: d.count, color: colors[d.bucket] })));
  const k = D.selected.kpis;

  const detail = D.selected.detail;
  const workingFrts = detail.filter(r => r.firstCallWorking === true && r.frtMinutes != null).map(r => r.frtMinutes);
  const nonWorkingFrts = detail.filter(r => r.firstCallWorking === false && r.frtMinutes != null).map(r => r.frtMinutes);
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;

  return `
  ${sectionHead('Calls & Response', 'First Response Time (FRT) Analysis', 'FRT = time from Customer Activity to the first call made at/after that activity')}
  <div class="grid g-5" style="margin-bottom:16px">
    ${kpi('Average FRT', k.avgFrtFmt || '—')}
    ${kpi('Median FRT', k.medianFrtFmt || '—')}
    ${kpi('Responded ≤ 15 min', fmtInt(dist.find(d => d.bucket === '0-15 min').count))}
    ${kpi('Called — No Timed FRT', fmtInt(dist.find(d => d.bucket === 'Called — No Timed FRT').count), 'Called same-day, before the activity’s clock time — no meaningful response time to show')}
    ${kpi('Customers Not Called', fmtInt(k.customersNotCalled), 'Same figure as Overview: Total Customer Activity − Total Call Attempts', k.customersNotCalled > 0 ? 'neg' : '')}
  </div>
  ${card('FRT Distribution', 'Per unique customer-day, min FRT across their deals', chart)}
  ${card('Working Hour FRT vs Non-Working Hour FRT', 'Only deals whose first call has a working-hour classification', table([
    { period: 'Working Hour First-Call FRT', avg: fmtMin(avg(workingFrts)), n: workingFrts.length },
    { period: 'Non-Working Hour First-Call FRT', avg: fmtMin(avg(nonWorkingFrts)), n: nonWorkingFrts.length },
  ], [{ key: 'period', label: 'Segment' }, { key: 'avg', label: 'Avg FRT', num: true }, { key: 'n', label: 'Sample Size', num: true, fmt: fmtInt }]))}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   WORKING HOURS
   ═══════════════════════════════════════════════════════════════════════ */
function renderHours(D) {
  const k = D.selected.kpis;
  const donut = donutSvg([
    { label: 'Working Hours', value: k.workingHourActivities, color: 'var(--good)' },
    { label: 'Non-Working Hours', value: k.nonWorkingHourActivities, color: 'var(--crit)' },
  ]);
  const hourly = D.selected.hourly;
  const hourlyChart = hbarChart(hourly.filter(h => h.activities > 0).map(h => ({
    label: h.label + (h.working ? '' : ' ⛔'), value: h.activities, color: h.working ? 'var(--gold)' : 'var(--muted)',
  })), { labelW: 90 });

  return `
  ${sectionHead('Working Hours', 'Working vs Non-Working Hour Analysis', 'Working = 10:00 AM–8:59:59 PM · Non-Working = 9:00 PM–9:59:59 AM (IST)')}
  <div class="grid g-4" style="margin-bottom:16px">
    ${kpi('Working Hour Activities', fmtInt(k.workingHourActivities))}
    ${kpi('Non-Working Hour Activities', fmtInt(k.nonWorkingHourActivities))}
    ${kpi('Working Hour %', fmtPct(k.workingHourPct))}
    ${kpi('Non-Working Hour %', fmtPct(k.nonWorkingHourPct))}
  </div>
  <div class="grid g-2">
    ${card('Customer Activities — Working vs Non-Working', null, `<div style="display:flex;justify-content:center">${donut}</div>` + legendOf([
      { label: 'Working Hours', value: k.workingHourActivities, color: 'var(--good)' },
      { label: 'Non-Working Hours', value: k.nonWorkingHourActivities, color: 'var(--crit)' },
    ]))}
    ${card('Hourly Customer Activity (24h)', '10 AM–9 PM = Working Hours', hourlyChart)}
  </div>
  ${card('Hourly Breakdown Table', 'Called/Not Called uses the same date-only Call Status rule as the rest of the dashboard — a call made earlier the same day still counts as Called', table(hourly, [
    { key: 'label', label: 'Hour' }, { key: 'activities', label: 'Activities', num: true, fmt: fmtInt },
    { key: 'uniqueCustomers', label: 'Unique Customers', num: true, fmt: fmtInt }, { key: 'calls', label: 'Calls', num: true, fmt: fmtInt },
    { key: 'firstResponses', label: 'Called', num: true, fmt: fmtInt }, { key: 'noCalls', label: 'Not Called', num: true, fmt: fmtInt },
    { key: 'working', label: 'Working?', fmt: yn },
  ]))}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   NOT CALLED
   ═══════════════════════════════════════════════════════════════════════ */
function renderNotCalled(D) {
  const rows = D.selected.notCalled;
  return `
  ${sectionHead('Follow-up Backlog', 'Customers Not Called', 'Every Customer Activity with zero calls made at/after it — pending follow-up')}
  <div class="grid g-3" style="margin-bottom:16px">
    ${kpi('Pending Follow-ups', fmtInt(rows.length), null, rows.length ? 'neg' : 'pos')}
    ${kpi('Oldest Pending (min)', rows.length ? fmtInt(rows[0].ageMinutes) : '—')}
    ${kpi('Working-Hour Activity, Not Called', fmtInt(rows.filter(r => r.activityWorking).length))}
  </div>
  ${card('Customers Not Called', 'Sorted by longest-pending first', table(rows, [
    { key: 'activityDate', label: 'Activity Date' }, { key: 'activityTime', label: 'Activity Time' },
    { key: 'mobile', label: 'Mobile' }, { key: 'dealName', label: 'Deal Name' }, { key: 'dealId', label: 'Deal ID' },
    { key: 'stage', label: 'Stage' }, { key: 'owner', label: 'Owner' },
    { key: 'ageMinutes', label: 'Age Since Activity', num: true, fmt: fmtMin },
    { key: 'activityWorking', label: 'Working?', fmt: yn },
  ]) + csvBtn('customers_not_called', [['Activity Date', 'Activity Time', 'Mobile', 'Deal Name', 'Deal ID', 'Stage', 'Owner', 'Age (min)', 'Working?'], ...rows.map(r => [r.activityDate, r.activityTime, r.mobile, r.dealName, r.dealId, r.stage, r.owner, r.ageMinutes, yn(r.activityWorking)])]))}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   DETAIL TABLE
   ═══════════════════════════════════════════════════════════════════════ */
function renderDetail(D) {
  const rows = D.selected.detail;
  const byOwner = D.selected.ownerDistribution;
  const ownerTotal = byOwner.length ? (() => {
    const deals = byOwner.reduce((s, r) => s + r.deals, 0);
    const called = byOwner.reduce((s, r) => s + r.called, 0);
    const notCalled = byOwner.reduce((s, r) => s + r.notCalled, 0);
    const callsMade = byOwner.reduce((s, r) => s + r.callsMade, 0);
    const uniqueCustomers = new Set(rows.map(r => r.mobile).filter(Boolean)).size;
    const frts = rows.map(r => r.frtMinutes).filter(v => v != null);
    return {
      owner: 'Grand Total', deals, uniqueCustomers, called, notCalled, callsMade,
      callCoveragePct: deals ? Math.round((called / deals) * 1000) / 10 : null,
      avgFrtMinutes: frts.length ? Math.round(frts.reduce((a, b) => a + b, 0) / frts.length) : null,
    };
  })() : null;
  return `
  ${sectionHead('Drill-Down', 'Customer / Deal Activity Detail', `${rows.length} records in the selected range`)}
  ${card('Owner-wise Summary', 'Deal-level: same Call Status rule as the rest of the dashboard, one row per Deal Owner', table(byOwner, [
    { key: 'owner', label: 'Owner' }, { key: 'deals', label: 'Deals', num: true, fmt: fmtInt },
    { key: 'uniqueCustomers', label: 'Unique Customers', num: true, fmt: fmtInt },
    { key: 'called', label: 'Called', num: true, fmt: fmtInt }, { key: 'notCalled', label: 'Not Called', num: true, fmt: fmtInt },
    { key: 'callsMade', label: 'Total Call Attempts', num: true, fmt: fmtInt },
    { key: 'callCoveragePct', label: 'Call Coverage %', num: true, fmt: fmtPct },
    { key: 'avgFrtMinutes', label: 'Avg FRT', num: true, fmt: fmtMin },
  ], { totalRow: ownerTotal }) + csvBtn('owner_wise_summary', [Object.keys(byOwner[0] || {}), ...byOwner.map(r => Object.values(r)), ownerTotal ? Object.values(ownerTotal) : []]))}
  ${card('Full Detail Table', 'Click a column header is not wired yet — export to Excel/CSV for sorting/filtering', table(rows, [
    { key: 'activityDate', label: 'Activity Date' }, { key: 'activityTime', label: 'Activity Time' },
    { key: 'mobile', label: 'Mobile' }, { key: 'dealId', label: 'Deal ID' }, { key: 'dealName', label: 'Deal Name' },
    { key: 'stage', label: 'Stage' }, { key: 'owner', label: 'Owner' }, { key: 'activityWorking', label: 'Activity Working?', fmt: yn },
    { key: 'called', label: 'Call Status', fmt: v => v ? '<span class="pill ok">Called</span>' : '<span class="pill bad">Not Called</span>' },
    { key: 'totalCalls', label: 'Total Calls', num: true, fmt: fmtInt }, { key: 'firstCallTime', label: 'First Call' },
    { key: 'lastCallTime', label: 'Last Call' }, { key: 'frtFmt', label: 'FRT' },
    { key: 'firstCallWorking', label: 'First Call Working?', fmt: yn }, { key: 'matchTier', label: 'Match Basis' },
  ]) + csvBtn('customer_activity_detail', [Object.keys(rows[0] || {}), ...rows.map(r => Object.values(r))]))}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   DATA QUALITY
   ═══════════════════════════════════════════════════════════════════════ */
function renderQuality(D) {
  const q = D.dataQuality;
  const eligible = q.totalDealsFetched - q.invalidTimestamp - q.excludedSameDayOrEarlier;
  const rows = [
    ['Total Zoho Deals Fetched (range)', q.totalDealsFetched],
    ['Customer Activities with Invalid/Missing Timestamp', q.invalidTimestamp],
    ['Excluded — Same Day or Earlier Activity (master filter)', q.excludedSameDayOrEarlier],
    ['— of which: Missing Created Time entirely', q.missingCreatedTime],
    ['Eligible Deals (DATE(Activity) > DATE(Created))', eligible],
    ['Missing Mobile (of eligible)', q.missingMobile],
    ['Invalid Mobile — unparseable (of eligible)', q.invalidMobile],
    ['Valid Mobile (of eligible)', q.validMobile],
    ['Deals with No Stage (of eligible)', q.noStage],
    ['Total Calls Fetched (range)', q.totalCallsFetched],
    ['Calls with Invalid/Missing Timestamp', q.callsWithInvalidTimestamp],
    ['Calls with No Matching Customer/Deal', q.callsWithNoMatch],
  ];
  return `
  ${sectionHead('Data Quality', 'Zoho CRM Data Quality', `Scoped to the currently selected range: ${esc(D.rangeFrom)} to ${esc(D.rangeTo)}`)}
  ${card('Data Quality Summary', null, table(rows.map(r => ({ metric: r[0], value: r[1] })), [
    { key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value', num: true, fmt: fmtInt },
  ]))}
  <div class="gate-note"><b>Master filter:</b> a Deal only becomes a "Customer Activity" for this dashboard when <code>DATE(Customer_Activities) &gt; DATE(Created_Time)</code> — strictly a later calendar day, not just a later time same-day, and not equal. "Excluded — Same Day or Earlier Activity" counts every otherwise-valid Deal this rule removes BEFORE any KPI/chart/table below is computed — see the Logic tab for the full rule and worked examples. Duplicate mobile/day records among the eligible set are not a data-quality issue — they're the expected input to the dedup step. "Missing Mobile" and "Invalid Mobile" deals are excluded from Unique Customer counts but still counted in Eligible Deals.</div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   INSIGHTS  (rule-based, grounded only in the currently-loaded real data)
   ═══════════════════════════════════════════════════════════════════════ */
function genInsights(D) {
  const k = D.selected.kpis, stages = D.selected.stageDistribution, hourly = D.selected.hourly;
  const out = [];
  if (!k.dealsWithActivity) return out;

  const todayK = D.presets.today, yestK = D.presets.yesterday;
  if (todayK.uniqueCustomerActivities != null && yestK.uniqueCustomerActivities != null) {
    const delta = todayK.uniqueCustomerActivities - yestK.uniqueCustomerActivities;
    out.push(`<b>Day-over-day:</b> Unique Customer Activities today (<b>${fmtInt(todayK.uniqueCustomerActivities)}</b>) is ${delta >= 0 ? 'up' : 'down'} <b>${Math.abs(delta)}</b> vs yesterday (<b>${fmtInt(yestK.uniqueCustomerActivities)}</b>).`);
  }
  if (stages.length) {
    const top = [...stages].sort((a, b) => b.deals - a.deals)[0];
    out.push(`<b>Busiest stage:</b> <b>${esc(top.stage)}</b> has the most Customer Activity (<b>${fmtInt(top.deals)}</b> deals, ${fmtPct(top.callCoveragePct)} call coverage).`);
    const worstCoverage = [...stages].filter(s => s.deals >= 3).sort((a, b) => (a.callCoveragePct || 0) - (b.callCoveragePct || 0))[0];
    if (worstCoverage) out.push(`<b>Weakest follow-up:</b> <b>${esc(worstCoverage.stage)}</b> has the lowest call coverage among stages with ≥3 deals (<b>${fmtPct(worstCoverage.callCoveragePct)}</b>, ${worstCoverage.notCalled} not called).`);
  }
  out.push(`<b>Call coverage:</b> <b>${fmtPct(k.callCoveragePct)}</b> of unique customers were called (<b>${fmtInt(k.customersCalled)}</b> of ${fmtInt(k.uniqueCustomerActivities)}); <b>${fmtInt(k.customersNotCalled)}</b> Customers Not Called (Total Customer Activity − Total Call Attempts).`);
  if (k.avgFrtFmt) out.push(`<b>Response speed:</b> average first response time is <b>${k.avgFrtFmt}</b> (median <b>${k.medianFrtFmt}</b>).`);
  const busiestHour = [...hourly].sort((a, b) => b.activities - a.activities)[0];
  if (busiestHour && busiestHour.activities > 0) out.push(`<b>Peak activity hour:</b> <b>${busiestHour.label}</b> sees the most customer activity (<b>${fmtInt(busiestHour.activities)}</b>), classified as ${busiestHour.working ? 'a working hour' : 'a non-working hour'}.`);
  out.push(`<b>Working vs non-working split:</b> <b>${fmtPct(k.workingHourPct)}</b> of activity happens inside working hours vs <b>${fmtPct(k.nonWorkingHourPct)}</b> outside them.`);
  return out;
}

function renderInsights(D) {
  const items = genInsights(D);
  return `
  ${sectionHead('Executive', 'AI Insights', 'Generated only from real numbers currently loaded — no fabricated observations')}
  ${card('✦ Key Insights', null, items.length ? items.map(i => `<div class="insightBox">${i}</div>`).join('') : emptyMsg('Not enough data in this range to generate insights yet.'))}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   ASK AI — free-form Q&A over the currently loaded (already-computed)
   dashboard data, answered by Gemini server-side (customer-activities-api
   /api/chat). Nothing here is a fresh Zoho pull — it's grounded in exactly
   the same numbers the rest of the dashboard is showing for the current
   range/owner filters.
   ═══════════════════════════════════════════════════════════════════════ */
function renderAsk(D) {
  const scopeNote = `Grounded in the currently selected scope — Range: ${D.rangeFrom} to ${D.rangeTo}${filterScopeSuffix(D)}. Change the filters above and ask again to re-scope the answer.`;
  const log = STATE.chat.length
    ? STATE.chat.map(m => `<div class="chat-msg ${m.role === 'user' ? 'user' : 'ai'}${m.error ? ' err' : ''}"><b>${m.role === 'user' ? 'You' : 'Gemini'}</b><div>${esc(m.text).replace(/\n/g, '<br>')}</div></div>`).join('')
    : emptyMsg('Ask anything about this data — e.g. "which deal stage has the worst call coverage?" or "how many customers were not called today?"');
  return `
  ${sectionHead('Gemini AI', 'Ask AI About This Data', scopeNote)}
  ${card('Chat', 'Answers are generated by Gemini using only the numbers already computed on this dashboard for the current filters — not a fresh CRM lookup', `
    <div class="chat-log" id="chatLog">${log}${STATE.chatLoading ? '<div class="chat-msg ai"><b>Gemini</b><div>Thinking…</div></div>' : ''}</div>
    <form id="chatForm" class="chat-form">
      <input type="text" id="chatInput" class="inp" placeholder="Ask a question about this data…" autocomplete="off" ${STATE.chatLoading ? 'disabled' : ''}>
      <button type="submit" class="btn gold" ${STATE.chatLoading ? 'disabled' : ''}>Ask</button>
    </form>
  `)}
  `;
}

async function sendChatQuestion() {
  const input = document.getElementById('chatInput');
  const question = (input && input.value || '').trim();
  if (!question || STATE.chatLoading) return;
  input.value = '';
  STATE.chat.push({ role: 'user', text: question });
  STATE.chatLoading = true;
  render();
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/chat?${rangeParams(false)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
    STATE.chat.push({ role: 'ai', text: j.answer });
  } catch (e) {
    STATE.chat.push({ role: 'ai', text: `Couldn't get an answer: ${e.message}`, error: true });
  }
  STATE.chatLoading = false;
  render();
}

/* ═══════════════════════════════════════════════════════════════════════
   LOGIC TAB — exactly how every number on this dashboard is computed
   ═══════════════════════════════════════════════════════════════════════ */
function renderLogic() {
  const steps = [
    ['Source field', `<code>Deals.${(STATE.data && STATE.data.activityField) || 'Customer_Activities'}</code> is the single source-of-truth timestamp. The backend confirms its real Zoho API name via <code>npm run discover-fields</code> (Deals field metadata lookup) rather than assuming a label-to-api_name mapping.`],
    ['★ MASTER FILTER — Customer Activities Date vs Created Date', `Every single Customer Activity metric on this dashboard — every KPI, chart, table, card, filter, drill-down and export — is built ONLY from Deals passing this one rule, applied before anything else: <pre class="logic-code" style="margin-top:8px">DATE(Customer_Activities) &gt; DATE(Created_Time)</pre>Compares the <b>calendar date only</b> — never time-of-day, never a timestamp/duration diff. Same-day activity is <b>excluded</b> even if it happened hours after creation; a previous-day-late-night creation followed by an early-next-day activity is <b>included</b>. Deals with no Created_Time at all can't satisfy "strictly greater than" and are excluded too. See the Data Quality tab for exactly how many Deals this removes.<table class="dt" style="margin-top:10px"><thead><tr><th>Customer Activities</th><th>Created Time</th><th>Include?</th></tr></thead><tbody>
      <tr><td>22-Aug-2026 10:30 AM</td><td>21-Aug-2026 11:45 PM</td><td><span class="pill ok">YES</span></td></tr>
      <tr><td>22-Aug-2026 09:00 AM</td><td>22-Aug-2026 08:00 AM</td><td><span class="pill bad">NO</span> (same day)</td></tr>
      <tr><td>22-Aug-2026 11:59 PM</td><td>22-Aug-2026 12:01 AM</td><td><span class="pill bad">NO</span> (same day)</td></tr>
      <tr><td>21-Aug-2026 10:00 AM</td><td>22-Aug-2026 09:00 AM</td><td><span class="pill bad">NO</span> (activity before creation)</td></tr>
      <tr><td>23-Aug-2026 01:00 AM</td><td>22-Aug-2026 11:59 PM</td><td><span class="pill ok">YES</span></td></tr>
    </tbody></table>`],
    ['Fetch (server-side, live)', `<code>customer-activities-api</code> calls Zoho CRM's <b>Search API</b> — <code>GET /crm/v2/Deals/search?criteria=(Customer_Activities:greater_equal:START)and(Customer_Activities:less_equal:END)</code> — for a rolling 30-day window, fully paginated (200/page). Calls are fetched from the same window start onward via the standard list API, also fully paginated. Nothing is cached beyond 3 minutes, and Refresh Data forces an immediate live re-pull. The master filter above is applied to every fetched Deal immediately, before mobile cleaning, stage checks, or call matching.`],
    ['Mobile cleaning', `Strip everything except digits → drop a leading country code/trunk-0 by keeping the <b>last 10 digits</b> → reject anything that doesn't match a real Indian mobile pattern (<code>^[6-9]\\d{9}$</code>). A Deal with no clean mobile is still counted in <b>Deals with Customer Activity</b> but excluded from every "Unique Customer" metric (it has no identity to dedupe on).`],
    ['Unique customer dedup', `Key = <code>Activity Date + cleaned mobile</code> (spec section 17). Multiple deals for the same mobile on the same day count as <b>1</b> unique customer but still contribute to <b>Total Deals with Activity</b> separately. The same mobile on different days counts once <i>per day</i> (section 18) — global cross-date dedup is never applied.`],
    ['Call matching (strongest relationship first)', `For each Deal: <b>Tier 1</b> — a Call whose <code>What_Id.id</code> equals the Deal's id (direct link). <b>Tier 2</b> — a Call whose <code>Who_Id.id</code> equals the Deal's linked <code>Contact_Name.id</code>. <b>Tier 3</b> — a Call whose dialed number (<code>To_Number__s</code> / <code>From_Number__s</code>, or a number parsed out of the free-text <code>Subject</code> for CTI/scheduled calls) matches the Deal's cleaned mobile. The dashboard's Detail table shows which tier matched via <b>Match Basis</b>.`],
    ['"Called" = responded to THIS activity, not any historical call', `Compares <b>calendar date only</b>, never time-of-day: a call whose <code>DATE(Call_Start_Time)</code> is <b>on or after</b> <code>DATE(Customer_Activities)</code> counts toward Call Made / Total Calls / First Call / Last Call / FRT for that activity. A call dated on an earlier day than the activity is not treated as a response to it — even a call earlier the same clock-day still qualifies.<table class="dt" style="margin-top:10px"><thead><tr><th>Customer Activity</th><th>Call</th><th>Result</th></tr></thead><tbody>
      <tr><td>24-Aug-2026 12:00 PM</td><td>24-Aug-2026 01:00 PM</td><td><span class="pill ok">Called</span></td></tr>
      <tr><td>24-Aug-2026 03:00 PM</td><td>24-Aug-2026 09:00 AM</td><td><span class="pill ok">Called</span> (same date)</td></tr>
      <tr><td>24-Aug-2026</td><td>25-Aug-2026 / 26-Aug-2026</td><td><span class="pill ok">Called</span></td></tr>
      <tr><td>24-Aug-2026</td><td>23-Aug-2026</td><td><span class="pill bad">Not Called</span> (earlier date)</td></tr>
    </tbody></table>A customer is "Called" if <b>at least one</b> qualifying call exists on/after the activity date.`],
    ['First Response Time (FRT)', `<code>FRT = first qualifying call's Call_Start_Time − Customer Activity timestamp</code>, in minutes — a separate, optional stat from <b>Call Status</b> above and never used to decide it. If the qualifying call's clock time is earlier than the activity's (same-day case from the table above), there's no real "time to respond" to report, so the record is bucketed as <b>"Called — No Timed FRT"</b> — never a fabricated 0/negative number, and never lumped in with genuine <b>"No Response"</b> (calls.total = 0), since that would make an actually-Called record look like nobody ever called. Per-customer Average/Median FRT uses the <b>minimum</b> FRT across that customer's deals for the day (their fastest response), matching the "unique customer" framing used everywhere else in this dashboard.`],
    ['Working hours', `Working = local hour <b>10–20</b> (10:00:00 AM up to but not including 9:00:00 PM). Non-working = hour <b>21–23 or 0–9</b> (9:00 PM up to but not including 10:00 AM). Applied identically to the Customer Activity timestamp, every call timestamp, and the first-call timestamp. Zoho India-DC timestamps are already IST wall-clock, so the hour is read directly off the string — no timezone conversion is applied.`],
    ['Deal Stage table', `Grouped by the Deal's live <code>Stage</code>. Unlike the headline KPIs, <b>Called/Not Called here is deal-level</b> (a deal has ≥1 qualifying call or not) rather than customer-level — because one mobile can have deals sitting in different stages simultaneously, so a single "customer called" flag can't be attributed to just one stage. This is a deliberate, documented choice, not an inconsistency.`],
    ['Follow-up backlog ("Not Called")', `Every Deal-level activity record with zero qualifying calls, sorted oldest-first by minutes elapsed since the activity. This is deal-level (not deduped by customer) so every pending deal is individually visible and actionable.`],
    ['What is intentionally NOT shown', `No revenue/AOV metrics (out of scope for this dashboard). No fabricated call-outcome taxonomy — only real Zoho fields are used. If Zoho's Deals/Calls modules don't expose a field the spec asked for (e.g. a true telephony disconnect reason), it is omitted rather than approximated.`],
  ];
  return `
  ${sectionHead('How This Dashboard Works', 'Calculation Logic', 'Every KPI, chart and table above is derived exclusively from these rules — nothing is hardcoded')}
  ${card('Pipeline', null, steps.map((s, i) => `<div class="logic-step"><div class="n">${i + 1}</div><div><h4>${esc(s[0])}</h4><p>${s[1]}</p></div></div>`).join(''))}
  ${card('Reference: cleaning + working-hours code (as actually deployed)', null, `<pre class="logic-code">${esc(
`function isDateEligible(activityRaw, createdRaw) {
  if (!createdRaw) return false;             // can't prove strictly-after
  const activityDateOnly = String(activityRaw).slice(0, 10);
  const createdDateOnly = String(createdRaw).slice(0, 10);
  return activityDateOnly > createdDateOnly; // DATE > DATE, never >=, never time-of-day
}

function cleanMobile(raw) {
  let digits = String(raw).replace(/\\D/g, '');
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length !== 10 || !/^[6-9]\\d{9}$/.test(digits)) return null;
  return digits;
}

function isWorkingHour(isoLike) {
  const h = parseInt(String(isoLike).slice(11, 13), 10);
  return h >= 10 && h < 21;               // 10:00 AM – 8:59:59 PM
}

function dedupKey(r) {
  return r.mobileClean ? \`\${r.activityDate}|\${r.mobileClean}\` : null;   // per-day, per-mobile
}`
  )}</pre>`)}
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════ */
function boot() {
  buildTabs();
  document.getElementById('btnTheme').addEventListener('click', () => {
    const html = document.documentElement;
    html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('btnPrint').addEventListener('click', () => window.print());
  document.getElementById('btnRefresh').addEventListener('click', () => loadData(true));

  document.getElementById('rangeSel').addEventListener('change', e => {
    STATE.range = e.target.value;
    const isCustom = STATE.range === 'custom';
    document.getElementById('customFrom').style.display = isCustom ? '' : 'none';
    document.getElementById('customTo').style.display = isCustom ? '' : 'none';
    if (!isCustom) onRangeChanged();
  });
  document.getElementById('customFrom').addEventListener('change', e => { STATE.customFrom = e.target.value; if (STATE.customFrom && STATE.customTo) onRangeChanged(); });
  document.getElementById('customTo').addEventListener('change', e => { STATE.customTo = e.target.value; if (STATE.customFrom && STATE.customTo) onRangeChanged(); });
  wireMultiSelect('ownerMsel', 'selectedOwners', 'All Owners', () => (STATE.data && STATE.data.owners) || []);
  wireMultiSelect('stageMsel', 'selectedStages', 'All Stages', () => (STATE.data && STATE.data.stages) || []);
  loadData(false);
}
document.addEventListener('DOMContentLoaded', boot);
