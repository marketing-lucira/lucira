require('dotenv').config();
const express = require('express');
const path = require('path');
const { fetchRecordsSince, getAccessToken } = require('./src/zohoClient');
const {
  isWhatsAppTriggered,
  groupByMobileAndDay,
  buildCallFirstIndex,
  buildDailyRows,
  buildProbabilityRows,
  buildAgentProbabilityPivot,
  buildAgentProbabilityRows,
  getRangeWindow,
  formatHHMMSS,
} = require('./src/dailyReportService');

const app = express();
const PORT = process.env.PORT || 3000;

const VALID_RANGES = ['daily', 'yesterday', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];
const VALID_DATE_FIELDS = ['Created_Time', 'Modified_Time'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const DEAL_FIELDS = [
  'id', 'Deal_Name', 'Amount', 'Probability_Score', 'Stage',
  'Deal_Trigger_Event', 'Owner', 'Mobile', 'Created_Time', 'Modified_Time',
];
const CALL_FIELDS = ['What_Id', 'Call_Start_Time', 'Call_Duration_in_seconds', 'Call_Type', 'Created_Time'];
const DUMP_LIMIT = 500;

// Raw per-deal listing — always the full deduped set (ignores the qualifiedOnly
// toggle on purpose) so the underlying Zoho-mapped data can be audited directly.
function buildDealsDump(deduped, callIndex) {
  const sorted = [...deduped].sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
  const dump = sorted.slice(0, DUMP_LIMIT).map(d => {
    const prob = Number(d.Probability_Score);

    const idsToCheck = d._groupDealIds || [d.id];
    let firstCall = null;
    for (const id of idsToCheck) {
      const c = callIndex.get(id);
      if (c && (!firstCall || c.time < firstCall.time)) firstCall = c;
    }

    let callDiffSeconds = null;
    let callDiffFormatted = null;
    if (firstCall) {
      callDiffSeconds = (firstCall.time - new Date(d.Created_Time).getTime()) / 1000;
      callDiffFormatted = (callDiffSeconds < 0 ? '-' : '') + formatHHMMSS(Math.abs(callDiffSeconds));
    }

    return {
      id: d.id,
      dealName: d.Deal_Name || null,
      createdTime: d.Created_Time,
      modifiedTime: d.Modified_Time,
      stage: d.Stage || null,
      probability: Number.isNaN(prob) ? null : prob,
      qualified: !Number.isNaN(prob) && prob >= 70,
      amount: Number(d.Amount) || 0,
      mobile: d.Mobile || null,
      owner: (d.Owner && d.Owner.name) || null,
      triggerEvent: d.Deal_Trigger_Event || null,
      whatsApp: isWhatsAppTriggered(d),
      firstCallTime: firstCall ? firstCall.startTime : null,
      callType: firstCall ? firstCall.callType || null : null,
      callDurationSeconds: firstCall ? firstCall.durationSeconds || 0 : null,
      callConnected: firstCall ? (firstCall.durationSeconds || 0) >= 30 : null,
      callDiffFormatted,
    };
  });
  return { dump, total: sorted.length, truncated: sorted.length > DUMP_LIMIT };
}

let rawCache = new Map();
let metaCache = null;

async function getRawForRange(dateField, startISO, forceRefresh) {
  const key = `${dateField}|${startISO}`;
  if (!forceRefresh && rawCache.has(key)) return rawCache.get(key);

  const deals = await fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: dateField, stopBeforeISO: startISO });

  const callStopBeforeISO = new Date(new Date(startISO).getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const calls = await fetchRecordsSince('Calls', CALL_FIELDS, { sortField: 'Created_Time', stopBeforeISO: callStopBeforeISO });

  const result = { deals, calls, fetchedAt: Date.now() };
  rawCache.set(key, result);
  return result;
}

async function getMeta(forceRefresh) {
  if (!forceRefresh && metaCache) return metaCache;
  const token = await getAccessToken();
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const tld = domain.replace(/^zoho\./, '');
  const res = await fetch(`https://www.zohoapis.${tld}/crm/v2/settings/fields?module=Deals`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  const stageField = data.fields.find(f => f.api_name === 'Stage');

  // Owner has no fixed picklist — derive the agent list from who actually owns recent deals.
  const recentDeals = await fetchRecordsSince('Deals', ['Owner'], { sortField: 'Created_Time', maxPages: 15 });
  const agents = Array.from(new Set(
    recentDeals.map(d => d.Owner && d.Owner.name).filter(Boolean)
  )).filter(name => name !== 'Lucira Tech').sort();

  metaCache = {
    stages: (stageField ? stageField.pick_list_values : []).map(v => v.display_value).filter(v => v !== '-None-'),
    agents,
  };
  return metaCache;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/meta', async (req, res) => {
  try {
    res.json(await getMeta(req.query.refresh === 'true'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-report', async (req, res) => {
  try {
    const dateField = VALID_DATE_FIELDS.includes(req.query.dateField) ? req.query.dateField : 'Created_Time';
    let range = VALID_RANGES.includes(req.query.range) ? req.query.range : 'yesterday';
    const forceRefresh = req.query.refresh === 'true';
    const customStart = DATE_ONLY.test(req.query.start || '') ? req.query.start : null;
    const customEnd = DATE_ONLY.test(req.query.end || '') ? req.query.end : null;
    if (range === 'custom' && (!customStart || !customEnd)) range = 'yesterday';
    const stages = req.query.stage ? req.query.stage.split(',').filter(Boolean) : [];
    const agents = req.query.agent ? req.query.agent.split(',').filter(Boolean) : [];
    const qualifiedOnly = req.query.qualifiedOnly === 'true';

    const { start, end } = getRangeWindow(range, customStart, customEnd);
    const { deals: rawDeals, calls } = await getRawForRange(dateField, start.toISOString(), forceRefresh);

    const startTime = start.getTime();
    const endTime = end.getTime();
    const inRange = rawDeals.filter(d => {
      const t = new Date(d[dateField]).getTime();
      return t >= startTime && t <= endTime;
    });

    const stageAgentFilter = d => {
      if (stages.length && !stages.includes(d.Stage)) return false;
      if (agents.length && (!d.Owner || !agents.includes(d.Owner.name))) return false;
      return true;
    };

    const cleanDeals = inRange.filter(d => !isWhatsAppTriggered(d));
    const filteredDeals = cleanDeals.filter(stageAgentFilter);

    const deduped = groupByMobileAndDay(filteredDeals);
    const scopedDeals = qualifiedOnly
      ? deduped.filter(d => { const p = Number(d.Probability_Score); return !Number.isNaN(p) && p >= 70; })
      : deduped;

    // The dump is an audit view — it intentionally includes WhatsApp-triggered deals
    // (unlike the three aggregate tables above) so it can be cross-checked against
    // Zoho's own raw record counts, but is still scoped to Probability Score >= 70%.
    // WhatsApp and non-WhatsApp deals are deduped SEPARATELY (matching the main
    // pipeline's non-WhatsApp dedup exactly) so a same-day WhatsApp deal for a
    // customer never knocks their non-WhatsApp deal out of the count, or vice versa —
    // keeping dump_total == main_total + whatsapp_count always true.
    const dumpSourceDeals = inRange.filter(stageAgentFilter);
    const dumpNonWhatsAppDeduped = groupByMobileAndDay(dumpSourceDeals.filter(d => !isWhatsAppTriggered(d)));
    const dumpWhatsAppDeduped = groupByMobileAndDay(dumpSourceDeals.filter(isWhatsAppTriggered));
    const dumpDeduped = [...dumpNonWhatsAppDeduped, ...dumpWhatsAppDeduped];
    const dumpQualified = dumpDeduped.filter(d => { const p = Number(d.Probability_Score); return !Number.isNaN(p) && p >= 70; });

    const callIndex = buildCallFirstIndex(calls);
    const rows = buildDailyRows(scopedDeals, callIndex, dateField);
    const probabilityRows = buildProbabilityRows(scopedDeals, callIndex);
    const agentPivot = buildAgentProbabilityPivot(scopedDeals);
    const dealsDump = buildDealsDump(dumpQualified, callIndex);
    const dumpWhatsAppCount = dumpQualified.filter(isWhatsAppTriggered).length;

    const closedLostDeals = scopedDeals.filter(d => d.Stage === 'Closed Lost');
    const closedLostAgentRows = buildAgentProbabilityRows(closedLostDeals, callIndex);

    res.json({
      range,
      dateField,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
      stage: stages,
      agent: agents,
      qualifiedOnly,
      rawDealCount: inRange.length,
      excludedWhatsAppCount: inRange.length - cleanDeals.length,
      dedupedDealCount: deduped.length,
      qualifiedDealCount: scopedDeals.length,
      probabilityRows,
      agentPivot,
      closedLostAgentRows,
      dealsDump,
      dumpWhatsAppCount,
      rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
