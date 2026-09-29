require('dotenv').config();
const express = require('express');
const path = require('path');
const {
  ACTIVITY_FIELD,
  fetchActivityDeals,
  fetchCallsFrom,
  buildCallIndexes,
  buildRecords,
  computeKpis,
  stageDistribution,
  ownerDistribution,
  hourlyDistribution,
  dailyTrend,
  frtDistribution,
  notCalledList,
  detailTable,
  activityDateKeyOf,
  callDateKeyOf,
} = require('./src/activityService');
const { getDealFieldsMeta } = require('./src/zohoClient');

const app = express();
const PORT = process.env.PORT || 3100;

// The dashboard is a standalone static HTML file (opened via file:// or a
// different port), so the API needs to be reachable cross-origin.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// The dashboard shows real customer names/mobile numbers, so gate the whole
// service behind HTTP Basic Auth once credentials are configured (same
// pattern as zoho-login-dashboard's DASH_USER/DASH_PASS). Left open when
// CAI_USER/CAI_PASS aren't set, so local development needs no extra setup.
function requireAuth(req, res, next) {
  const user = process.env.CAI_USER;
  const pass = process.env.CAI_PASS;
  if (!user || !pass) return next();

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Customer Activities Intelligence"');
  res.status(401).send('Authentication required.');
}
app.use(requireAuth);
app.use(express.json());

// Serves the dashboard itself (public/index.html + public/cai.js) same-origin,
// so the whole thing works from one public Cloud Run URL with no CORS involved.
app.use(express.static(path.join(__dirname, 'public')));

function istDateKey(date) {
  const shifted = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function addDaysKey(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return istDateKey(new Date(dt.getTime() - 5.5 * 60 * 60 * 1000));
}

const WINDOW_DAYS = 30; // always fetch a superset covering every quick-range preset

let cache = { fetchedAt: 0, records: [], rawDeals: [], rawCalls: [], windowStartKey: null };
const CACHE_MS = 3 * 60 * 1000; // how long cache is served with no background refresh at all
let inFlightFetch = null; // dedupes concurrent Zoho pulls onto one promise

// Actually hits Zoho: Deals + Calls fetch concurrently (previously sequential
// — this alone roughly halves the live-pull time) and rebuilds the window.
async function fetchFreshWindow(windowStartKey) {
  const startISO = `${windowStartKey}T00:00:00+05:30`;
  const [deals, calls] = await Promise.all([fetchActivityDeals(startISO), fetchCallsFrom(startISO)]);
  const indexes = buildCallIndexes(calls);
  const { records } = buildRecords(deals, indexes);
  cache = { fetchedAt: Date.now(), records, rawDeals: deals, rawCalls: calls, windowStartKey };
  return cache;
}

// Stale-while-revalidate: a live Zoho pull for the full 30-day window takes
// real time (dozens of records to page through), and the old version made
// whichever request happened to land after the 3-minute cache expired pay
// that cost synchronously — which is what made loads feel slow. Now: once
// there's ANY cache for today's window, every request gets it back
// instantly, and a background refresh (deduped so concurrent callers never
// trigger two live pulls at once) keeps it current for next time. Only a true
// cold start, a forced refresh, or the window rolling to a new day blocks.
async function loadWindow(forceRefresh) {
  const today = istDateKey(new Date());
  const windowStartKey = addDaysKey(today, -(WINDOW_DAYS - 1));
  const sameWindow = cache.windowStartKey === windowStartKey;
  const isFresh = sameWindow && cache.records.length && Date.now() - cache.fetchedAt < CACHE_MS;

  if (!forceRefresh && isFresh) return cache;

  const mustBlock = forceRefresh || !sameWindow || !cache.records.length;
  if (mustBlock) {
    if (!inFlightFetch) inFlightFetch = fetchFreshWindow(windowStartKey).finally(() => { inFlightFetch = null; });
    return inFlightFetch;
  }

  // Stale but usable — serve immediately, refresh in the background.
  if (!inFlightFetch) {
    inFlightFetch = fetchFreshWindow(windowStartKey)
      .catch(err => { console.error('Background Zoho refresh failed:', err.message); })
      .finally(() => { inFlightFetch = null; });
  }
  return cache;
}

function inRange(records, fromKey, toKey) {
  return records.filter(r => r.activityDate >= fromKey && r.activityDate <= toKey);
}

// Distinct Deal Owner names across the full fetched window — used to populate
// the dashboard's Owner filter dropdown regardless of which owner (if any) is
// currently selected, so switching owners doesn't shrink the option list.
function ownersListOf(records) {
  return Array.from(new Set(records.map(r => r.owner).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

// Same idea as ownersListOf, for Deal Stage.
function stagesListOf(records) {
  return Array.from(new Set(records.map(r => r.stage).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function rangeWindow(range, today, customStart, customEnd) {
  switch (range) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDaysKey(today, -1); return { from: y, to: y }; }
    case '7d': return { from: addDaysKey(today, -6), to: today };
    case '30d': return { from: addDaysKey(today, -29), to: today };
    case 'custom': return { from: customStart || today, to: customEnd || today };
    default: return { from: today, to: today };
  }
}

// Shared range parsing/validation for every endpoint that takes a date filter.
const VALID_RANGES = ['today', 'yesterday', '7d', '30d', 'custom'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function parseRangeParams(req) {
  const range = VALID_RANGES.includes(req.query.range) ? req.query.range : 'today';
  const customStart = DATE_ONLY.test(req.query.start || '') ? req.query.start : null;
  const customEnd = DATE_ONLY.test(req.query.end || '') ? req.query.end : null;
  const today = istDateKey(new Date());
  return { range, window: rangeWindow(range, today, customStart, customEnd), today };
}

// Data Quality needs to reflect the SAME selected date range (and, when set,
// the same Owner/Stage filters) as every other tab, not the full 30-day fetch
// window — recompute it from the raw deals/calls filtered to that scope
// (cheap: a few thousand records at most).
function dataQualityForWindow(rawDeals, rawCalls, from, to, ownerList, stageList) {
  const scopedDeals = rawDeals
    .filter(d => { const k = activityDateKeyOf(d); return k && k >= from && k <= to; })
    .filter(d => !ownerList.length || ownerList.includes(d.Owner && d.Owner.name))
    .filter(d => !stageList.length || stageList.includes(d.Stage));
  const scopedCalls = rawCalls.filter(c => { const k = callDateKeyOf(c); return k && k >= from && k <= to; });
  const indexes = buildCallIndexes(scopedCalls);
  const { dataQuality } = buildRecords(scopedDeals, indexes);
  dataQuality.totalCallsFetched = scopedCalls.length;
  dataQuality.callsWithNoMatch = indexes.noRelationship;
  dataQuality.callsWithInvalidTimestamp = indexes.noStartTime;
  return dataQuality;
}

app.get('/api/meta', async (req, res) => {
  try {
    const fields = await getDealFieldsMeta();
    const field = fields.find(f => f.api_name === ACTIVITY_FIELD);
    res.json({
      activityFieldConfigured: ACTIVITY_FIELD,
      activityFieldFound: !!field,
      activityFieldLabel: field ? field.field_label : null,
      activityFieldType: field ? field.data_type : null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// A filter query param is either absent/'all' (no filter) or a comma-separated
// list of values to match ANY of (multi-select) — e.g. owner=Alice,Bob.
function parseMultiParam(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed === 'all') return [];
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

// Builds the exact same report bundle /api/report returns, from the request's
// range/owner/stage query params. Shared with /api/chat so the AI answers
// from precisely what the dashboard itself is showing — not a re-derivation.
async function buildReportPayload(req) {
  const forceRefresh = req.query.refresh === 'true';
  const { range, window: selWindow, today } = parseRangeParams(req);
  const ownerList = parseMultiParam(req.query.owner);
  const stageList = parseMultiParam(req.query.stage);

  const { records: allRecords, rawDeals, rawCalls, fetchedAt } = await loadWindow(forceRefresh);
  const owners = ownersListOf(allRecords);
  const stages = stagesListOf(allRecords);
  let records = ownerList.length ? allRecords.filter(r => ownerList.includes(r.owner)) : allRecords;
  if (stageList.length) records = records.filter(r => stageList.includes(r.stage));

  const presets = {};
  for (const r of ['today', 'yesterday', '7d', '30d']) {
    const w = rangeWindow(r, today);
    presets[r] = computeKpis(inRange(records, w.from, w.to));
  }

  const selRecords = inRange(records, selWindow.from, selWindow.to);

  return {
    generatedAt: new Date().toISOString(),
    dataAsOf: new Date(fetchedAt).toISOString(),
    activityField: ACTIVITY_FIELD,
    range,
    rangeFrom: selWindow.from,
    rangeTo: selWindow.to,
    owners,
    selectedOwners: ownerList,
    stages,
    selectedStages: stageList,
    presets,
    selected: {
      kpis: computeKpis(selRecords),
      stageDistribution: stageDistribution(selRecords),
      ownerDistribution: ownerDistribution(selRecords),
      hourly: hourlyDistribution(selRecords),
      frtDistribution: frtDistribution(selRecords),
      notCalled: notCalledList(selRecords),
      detail: detailTable(selRecords),
    },
    dailyTrend: dailyTrend(records),
    dataQuality: dataQualityForWindow(rawDeals, rawCalls, selWindow.from, selWindow.to, ownerList, stageList),
  };
}

// Maps an internal error (Zoho response bodies, request paths, upstream
// status text) to a message safe to send to the browser. Full detail is
// still logged server-side (Cloud Run logs) via sendError below — nothing
// here should ever echo raw err.message for anything that touched Zoho or
// Gemini, since those can carry internal endpoint/config detail.
function clientSafeError(err) {
  const message = String((err && err.message) || '');
  if (message === 'question is required') return { status: 400, code: 'bad_request', error: message };
  if (/GEMINI_API_KEY is not configured/.test(message)) {
    return { status: 503, code: 'ask_ai_unavailable', error: 'Ask AI is not configured yet.' };
  }
  if (/Zoho token refresh failed/.test(message) || /invalid_client|invalid_code|OAUTH_SCOPE_MISMATCH/i.test(message)) {
    return { status: 502, code: 'zoho_auth_error', error: 'Zoho CRM is not connected. Contact an administrator.' };
  }
  if (/^Zoho fetch/.test(message)) {
    return { status: 502, code: 'zoho_upstream_error', error: 'Unable to reach Zoho CRM right now. Please try again shortly.' };
  }
  if (/Gemini API error/.test(message)) {
    return { status: 502, code: 'ask_ai_upstream_error', error: 'Ask AI is temporarily unavailable. Please try again shortly.' };
  }
  return { status: 500, code: 'internal_error', error: 'Something went wrong. Please try again shortly.' };
}

function sendError(res, err) {
  console.error(err);
  const safe = clientSafeError(err);
  res.status(safe.status).json({ error: safe.error, code: safe.code });
}

app.get('/api/report', async (req, res) => {
  try {
    res.json(await buildReportPayload(req));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Ask AI (Gemini) — answers questions grounded ONLY in the same computed
// data the dashboard is already showing for the caller's current range/owner
// filters. No separate Zoho pull, no data the dashboard doesn't already have.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const CHAT_ROW_CAP = 300; // keep the prompt bounded on wide date ranges

async function askGemini(question, context) {
  if (!GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not configured on the server.');
    err.status = 501;
    throw err;
  }
  const prompt = `You are the data-analyst assistant embedded in Lucira Jewelry's "Customer Activities Intelligence" dashboard.
Answer the user's question using ONLY the JSON data below — it is exactly what the dashboard is currently showing for the selected date range and owner filter. Do not invent numbers, deals, or names that aren't in this data. If the answer isn't derivable from it, say so plainly. Be concise and cite the specific numbers you used.

DASHBOARD DATA (JSON):
${JSON.stringify(context)}

USER QUESTION: ${question}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  const j = await res.json();
  const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  const text = parts ? parts.map(p => p.text || '').join('') : '';
  return text.trim() || 'Gemini returned no answer for that question.';
}

app.post('/api/chat', async (req, res) => {
  try {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });

    const report = await buildReportPayload(req);
    const context = {
      range: report.range,
      rangeFrom: report.rangeFrom,
      rangeTo: report.rangeTo,
      selectedOwners: report.selectedOwners,
      owners: report.owners,
      selectedStages: report.selectedStages,
      stages: report.stages,
      kpis: report.selected.kpis,
      periodPresets: report.presets,
      stageDistribution: report.selected.stageDistribution,
      ownerDistribution: report.selected.ownerDistribution,
      hourlyActivity: report.selected.hourly.filter(h => h.activities > 0),
      frtDistribution: report.selected.frtDistribution,
      dailyTrend: report.dailyTrend,
      dataQuality: report.dataQuality,
      notCalledCustomers: report.selected.notCalled.slice(0, CHAT_ROW_CAP),
      notCalledTruncated: report.selected.notCalled.length > CHAT_ROW_CAP,
      detailRecords: report.selected.detail.slice(0, CHAT_ROW_CAP),
      detailTruncated: report.selected.detail.length > CHAT_ROW_CAP,
    };

    const answer = await askGemini(question, context);
    res.json({ answer });
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`Customer Activities Intelligence API running at http://localhost:${PORT}`);
  console.log(`Configured Customer Activities field: ${ACTIVITY_FIELD} (run "npm run discover-fields" if this looks wrong)`);
  // Warm the cache immediately so the first real dashboard load after a cold
  // start doesn't have to be the one that pays for the live Zoho pull.
  loadWindow(false).catch(err => console.error('Startup cache warm-up failed:', err.message));
});
