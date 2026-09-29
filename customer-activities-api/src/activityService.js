const { cleanMobile } = require('./mobile');
const { isWorkingHour } = require('./workingHours');
const { fetchRecordsSince } = require('./zohoClient');

const ACTIVITY_FIELD = process.env.CUSTOMER_ACTIVITY_FIELD || 'Customer_Activities';

const DEAL_FIELDS = ['id', 'Deal_Name', 'Mobile', 'Stage', 'Owner', 'Contact_Name', 'Created_Time', ACTIVITY_FIELD];
const CALL_FIELDS = ['id', 'Owner', 'Call_Type', 'Call_Start_Time', 'Call_Duration_in_seconds', 'Subject', 'Who_Id', 'What_Id', 'To_Number__s', 'From_Number__s', 'Created_Time'];

// Date-key extractors used to scope raw Deals/Calls to a selected range
// (Data Quality + Raw Data Dump need this same range filter every other tab gets).
function activityDateKeyOf(deal) {
  const raw = deal[ACTIVITY_FIELD];
  return raw && /^\d{4}-\d{2}-\d{2}T/.test(String(raw)) ? String(raw).slice(0, 10) : null;
}
function callDateKeyOf(call) {
  const raw = call.Call_Start_Time || call.Created_Time;
  return raw ? String(raw).slice(0, 10) : null;
}

// ═══════════════════════════════════════════════════════════════════════
// MASTER ELIGIBILITY FILTER — the single rule every Customer Activity
// calculation in this dashboard is built on. Compares CALENDAR DATE ONLY
// (never time-of-day, never a timestamp/duration diff):
//
//   DATE(Customer_Activities) > DATE(Created_Time)   ->  eligible
//   DATE(Customer_Activities) = DATE(Created_Time)   ->  excluded (same day)
//   DATE(Customer_Activities) < DATE(Created_Time)   ->  excluded
//   Created_Time missing                             ->  excluded (unprovable)
//
// Deliberately NOT `>=` (same-day activity is excluded even if it happened
// hours after creation) and NOT a timestamp/duration comparison — see the
// dashboard's Logic tab for the full rationale and worked examples.
// Plain ISO 'YYYY-MM-DD' string comparison is a safe, correct date-only
// ordering — no Date object / time-of-day math involved.
function isDateEligible(activityRaw, createdRaw) {
  if (!createdRaw) return false;
  const activityDateOnly = String(activityRaw).slice(0, 10);
  const createdDateOnly = String(createdRaw).slice(0, 10);
  return activityDateOnly > createdDateOnly;
}

function digits10(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

// Scheduled/CTI calls sometimes carry the dialed number in the free-text
// Subject instead of To_Number__s/From_Number__s — same fallback used by
// the existing zoho-crm-api/crm_bundle.py pipeline.
function phoneFromSubject(subject) {
  if (!subject) return null;
  const matches = String(subject).match(/\(([^)]*\d[^)]*)\)/g);
  if (!matches || !matches.length) return null;
  return digits10(matches[matches.length - 1]);
}

function formatTime12h(isoLike) {
  if (!isoLike) return null;
  const h = parseInt(String(isoLike).slice(11, 13), 10);
  const m = String(isoLike).slice(14, 16);
  if (Number.isNaN(h)) return null;
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${m} ${period}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDatePretty(dateOnly) {
  if (!dateOnly) return null;
  const [y, m, d] = dateOnly.split('-').map(Number);
  if (!y || !m || !d) return null;
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}

// ── STEP 1: fetch Deals whose Customer Activities timestamp falls in the window ──
// Zoho's /search criteria endpoint rejects range operators (greater_equal,
// greater_than, between) on this field with INVALID_QUERY "invalid operator
// found" (confirmed live, not a guess — this custom field isn't enabled for
// criteria-search). The plain list API sorted by the field itself works, so
// fetch newest-first and stop once records fall behind the window start —
// same pattern as fetchRecordsSince for Calls below. endISO isn't needed as
// an upper bound: the window's end is always "today", so every record newer
// than startISO is already <= now <= endISO.
async function fetchActivityDeals(startISO) {
  return fetchRecordsSince('Deals', DEAL_FIELDS, { sortField: ACTIVITY_FIELD, stopBeforeISO: startISO, maxPages: 800 });
}

// ── STEP 2: fetch Calls from the activity window start onward (a call can
// only be a valid response if it happens at/after the Customer Activity) ──
async function fetchCallsFrom(startISO) {
  return fetchRecordsSince('Calls', CALL_FIELDS, { sortField: 'Created_Time', stopBeforeISO: startISO, maxPages: 800 });
}

// ── STEP 3: strongest-relationship call matching per deal ──
// tier 1: Call.What_Id.id === Deal.id (direct Deal link)
// tier 2: Call.Who_Id.id === Deal.Contact_Name.id (same Contact record)
// tier 3: cleaned mobile match (To_Number__s / From_Number__s / Subject-parsed)
function buildCallIndexes(calls) {
  const byWhatId = new Map();
  const byWhoId = new Map();
  const byMobile = new Map();
  let noRelationship = 0;
  let noStartTime = 0;

  for (const c of calls) {
    const startTime = c.Call_Start_Time || c.Created_Time;
    if (!startTime) { noStartTime += 1; continue; }
    const rec = {
      id: c.id,
      startTime,
      durationSeconds: c.Call_Duration_in_seconds || 0,
      callType: c.Call_Type || null,
      owner: (c.Owner && c.Owner.name) || null,
    };

    const whatId = c.What_Id && c.What_Id.id;
    if (whatId) {
      if (!byWhatId.has(whatId)) byWhatId.set(whatId, []);
      byWhatId.get(whatId).push(rec);
    }
    const whoId = c.Who_Id && c.Who_Id.id;
    if (whoId) {
      if (!byWhoId.has(whoId)) byWhoId.set(whoId, []);
      byWhoId.get(whoId).push(rec);
    }
    const mobile = digits10(c.To_Number__s) || digits10(c.From_Number__s) || phoneFromSubject(c.Subject);
    if (mobile) {
      if (!byMobile.has(mobile)) byMobile.set(mobile, []);
      byMobile.get(mobile).push(rec);
    }
    if (!whatId && !whoId && !mobile) noRelationship += 1;
  }

  const sortByTime = list => [...list].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  byWhatId.forEach((v, k) => byWhatId.set(k, sortByTime(v)));
  byWhoId.forEach((v, k) => byWhoId.set(k, sortByTime(v)));
  byMobile.forEach((v, k) => byMobile.set(k, sortByTime(v)));

  return { byWhatId, byWhoId, byMobile, noRelationship, noStartTime };
}

// A deal can have calls under a stronger tier (e.g. directly linked via
// What_Id) that all happened BEFORE the Customer Activity, while a real,
// later call only shows up under a weaker tier (contact/mobile) because
// that later call was logged against the Contact rather than the Deal.
// Stopping at the first tier that has ANY calls (old behavior) let that
// stale, pre-activity tier-1 call silently block the real tier-2/3 response
// from ever being considered — the deal showed "Not Called" even though a
// genuine, date-eligible call existed in Zoho. Fix: prefer the strongest
// tier that has at least one call ON/AFTER the activity date; only fall
// back to "strongest tier with any calls at all" when no tier has an
// eligible one (so Not-Called records still report a sensible matchTier).
function callsForDeal(deal, mobileClean, indexes, activityDate) {
  const contactId = deal.Contact_Name && deal.Contact_Name.id;
  const candidates = [
    { tier: 'deal_id', calls: indexes.byWhatId.get(deal.id) || [] },
    { tier: 'contact_id', calls: contactId ? (indexes.byWhoId.get(contactId) || []) : [] },
    { tier: 'mobile', calls: mobileClean ? (indexes.byMobile.get(mobileClean) || []) : [] },
  ];

  for (const c of candidates) {
    if (c.calls.some(x => String(x.startTime).slice(0, 10) >= activityDate)) {
      return { calls: c.calls, matchTier: c.tier };
    }
  }
  for (const c of candidates) {
    if (c.calls.length) return { calls: c.calls, matchTier: c.tier };
  }
  return { calls: [], matchTier: null };
}

// ── STEP 4: build one enriched record per Deal that has a valid Customer Activity ──
function buildRecords(deals, callIndexes) {
  const records = [];
  const dq = {
    totalDealsFetched: deals.length,
    missingMobile: 0,
    invalidMobile: 0,
    validMobile: 0,
    invalidTimestamp: 0,
    noStage: 0,
    missingCreatedTime: 0,
    excludedSameDayOrEarlier: 0,
  };

  for (const d of deals) {
    const activityRaw = d[ACTIVITY_FIELD];
    if (!activityRaw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(activityRaw))) {
      dq.invalidTimestamp += 1;
      continue;
    }

    // MASTER FILTER — applied before anything else can happen to this deal.
    // DATE(Customer_Activities) must be STRICTLY greater than DATE(Created_Time).
    if (!d.Created_Time) dq.missingCreatedTime += 1;
    if (!isDateEligible(activityRaw, d.Created_Time)) {
      dq.excludedSameDayOrEarlier += 1;
      continue;
    }

    const activityDate = String(activityRaw).slice(0, 10);
    const activityTime = formatTime12h(activityRaw);
    const activityWorking = isWorkingHour(activityRaw);

    const mobileRaw = d.Mobile;
    const mobileClean = cleanMobile(mobileRaw);
    if (!mobileRaw) dq.missingMobile += 1;
    else if (!mobileClean) dq.invalidMobile += 1;
    else dq.validMobile += 1;

    if (!d.Stage) dq.noStage += 1;

    const { calls, matchTier } = callsForDeal(d, mobileClean, callIndexes, activityDate);
    // A call counts as a "response" to this activity if its CALENDAR DATE is
    // on/after the activity's calendar date — time-of-day is irrelevant. A
    // 9 AM call on the activity's own day still counts even if the activity
    // itself was logged at 3 PM that day; only calls on an earlier date are excluded.
    const responseCalls = calls.filter(c => String(c.startTime).slice(0, 10) >= activityDate);

    const first = responseCalls[0] || null;
    const last = responseCalls.length ? responseCalls[responseCalls.length - 1] : null;
    // FRT is a separate, optional stat from Call Status — Call Status (`called`
    // below) is decided purely by the date-only rule above and never touches
    // this. A same-day call can carry a clock time earlier than the activity's,
    // making the raw timestamp diff negative; there's no real "response time"
    // to report for that, so FRT is left unset (null) rather than shown as a
    // fabricated "0 min" — it does NOT affect whether the record is Called.
    const rawFrtMinutes = first ? Math.round((new Date(first.startTime).getTime() - new Date(activityRaw).getTime()) / 60000) : null;
    const frtMinutes = rawFrtMinutes != null && rawFrtMinutes >= 0 ? rawFrtMinutes : null;

    records.push({
      dealId: d.id,
      dealName: d.Deal_Name || null,
      owner: (d.Owner && d.Owner.name) || null,
      stage: d.Stage || 'Unknown',
      mobileRaw: mobileRaw || null,
      mobileClean,
      activityRaw,
      activityDate,
      activityDatePretty: formatDatePretty(activityDate),
      activityTime,
      activityWorking,
      createdTime: d.Created_Time || null,
      calls: {
        total: responseCalls.length,
        matchTier,
        firstTime: first ? first.startTime : null,
        firstTimeFmt: first ? formatTime12h(first.startTime) : null,
        firstWorking: first ? isWorkingHour(first.startTime) : null,
        lastTime: last ? last.startTime : null,
        lastTimeFmt: last ? formatTime12h(last.startTime) : null,
        connectedCount: responseCalls.filter(c => (c.durationSeconds || 0) > 0).length,
      },
      called: responseCalls.length > 0,
      frtMinutes,
      frtBucket: frtBucketOf(frtMinutes, responseCalls.length > 0),
    });
  }

  return { records, dataQuality: dq };
}

// `called` must be checked FIRST — a record can be Called with no timed FRT
// (matched call precedes the activity same-day, see buildRecords above) and
// that must never land in the same bucket as a record nobody ever called.
function frtBucketOf(mins, called) {
  if (!called) return 'No Response';
  if (mins == null) return 'Called — No Timed FRT';
  if (mins <= 15) return '0-15 min';
  if (mins <= 30) return '15-30 min';
  if (mins <= 60) return '30-60 min';
  if (mins <= 120) return '1-2 hr';
  return '2+ hr';
}

// ── Dedup: unique customer = cleaned mobile, unique PER DAY (spec sec 4/17/18) ──
function dedupKey(r) {
  return r.mobileClean ? `${r.activityDate}|${r.mobileClean}` : null;
}

function groupByCustomerDay(records) {
  const groups = new Map();
  for (const r of records) {
    const key = dedupKey(r);
    if (!key) continue; // no valid mobile -> can't be counted as a "unique customer"
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function fmtMinutes(mins) {
  if (mins == null) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── Primary KPI block for a date-filtered slice of records ──
function computeKpis(records) {
  const dealsWithActivity = records.length;
  const customerGroups = groupByCustomerDay(records);
  const uniqueCustomers = customerGroups.size;

  let customersCalled = 0;
  const customerFrts = [];
  customerGroups.forEach(group => {
    const anyCalled = group.some(r => r.called);
    if (anyCalled) customersCalled += 1;
    const frts = group.map(r => r.frtMinutes).filter(v => v != null);
    if (frts.length) customerFrts.push(Math.min(...frts));
  });
  const callCoverage = uniqueCustomers ? (customersCalled / uniqueCustomers) * 100 : null;

  const callsMade = records.reduce((sum, r) => sum + r.calls.total, 0);
  // Customers Not Called = Total Customer Activity − Calls Made (per business
  // request), not the unique-customer "nobody responded" count it used to be.
  const customersNotCalled = uniqueCustomers - callsMade;
  const avgFrt = customerFrts.length ? Math.round(customerFrts.reduce((a, b) => a + b, 0) / customerFrts.length) : null;
  const medFrt = median(customerFrts);

  const workingActivities = records.filter(r => r.activityWorking === true).length;
  const nonWorkingActivities = records.filter(r => r.activityWorking === false).length;

  return {
    uniqueCustomerActivities: uniqueCustomers,
    dealsWithActivity,
    callsMade,
    customersCalled,
    customersNotCalled,
    callCoveragePct: callCoverage == null ? null : Math.round(callCoverage * 10) / 10,
    avgFrtMinutes: avgFrt,
    avgFrtFmt: fmtMinutes(avgFrt),
    medianFrtMinutes: medFrt,
    medianFrtFmt: fmtMinutes(medFrt),
    workingHourActivities: workingActivities,
    nonWorkingHourActivities: nonWorkingActivities,
    workingHourPct: dealsWithActivity ? Math.round((workingActivities / dealsWithActivity) * 1000) / 10 : null,
    nonWorkingHourPct: dealsWithActivity ? Math.round((nonWorkingActivities / dealsWithActivity) * 1000) / 10 : null,
  };
}

// ── Deal Stage distribution (deal-level Called/Not Called — see LOGIC tab) ──
function stageDistribution(records) {
  const byStage = new Map();
  for (const r of records) {
    if (!byStage.has(r.stage)) byStage.set(r.stage, []);
    byStage.get(r.stage).push(r);
  }
  return Array.from(byStage.entries()).map(([stage, rows]) => {
    const uniqueCustomers = new Set(rows.map(r => r.mobileClean).filter(Boolean)).size;
    const called = rows.filter(r => r.called).length;
    const frts = rows.map(r => r.frtMinutes).filter(v => v != null);
    return {
      stage,
      uniqueCustomers,
      deals: rows.length,
      called,
      notCalled: rows.length - called,
      callCoveragePct: rows.length ? Math.round((called / rows.length) * 1000) / 10 : null,
      avgFrtMinutes: frts.length ? Math.round(frts.reduce((a, b) => a + b, 0) / frts.length) : null,
      won: /closed won/i.test(stage) ? rows.length : null,
      lost: /closed lost/i.test(stage) ? rows.length : null,
    };
  }).sort((a, b) => b.deals - a.deals);
}

// ── Deal Owner distribution (deal-level Called/Not Called, same rule as everywhere else) ──
function ownerDistribution(records) {
  const byOwner = new Map();
  for (const r of records) {
    const owner = r.owner || 'Unassigned';
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(r);
  }
  return Array.from(byOwner.entries()).map(([owner, rows]) => {
    const uniqueCustomers = new Set(rows.map(r => r.mobileClean).filter(Boolean)).size;
    const called = rows.filter(r => r.called).length;
    const callsMade = rows.reduce((sum, r) => sum + r.calls.total, 0);
    const frts = rows.map(r => r.frtMinutes).filter(v => v != null);
    return {
      owner,
      deals: rows.length,
      uniqueCustomers,
      called,
      notCalled: rows.length - called,
      callsMade,
      callCoveragePct: rows.length ? Math.round((called / rows.length) * 1000) / 10 : null,
      avgFrtMinutes: frts.length ? Math.round(frts.reduce((a, b) => a + b, 0) / frts.length) : null,
    };
  }).sort((a, b) => b.deals - a.deals);
}

// ── Hourly (0-23) activity/call/response breakdown ──
function hourlyDistribution(records) {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`,
    activities: 0,
    uniqueCustomers: new Set(),
    calls: 0,
    firstResponses: 0,
    noCalls: 0,
    working: h >= 10 && h < 21,
  }));
  for (const r of records) {
    const h = parseInt(r.activityRaw.slice(11, 13), 10);
    if (Number.isNaN(h)) continue;
    const row = hours[h];
    row.activities += 1;
    if (r.mobileClean) row.uniqueCustomers.add(r.mobileClean);
    row.calls += r.calls.total;
    if (r.called) row.firstResponses += 1; else row.noCalls += 1;
  }
  return hours.map(r => ({ ...r, uniqueCustomers: r.uniqueCustomers.size }));
}

// ── Daily trend across the whole fetched record set ──
function dailyTrend(records) {
  const byDay = new Map();
  for (const r of records) {
    if (!byDay.has(r.activityDate)) byDay.set(r.activityDate, []);
    byDay.get(r.activityDate).push(r);
  }
  return Array.from(byDay.entries()).map(([date, rows]) => {
    const k = computeKpis(rows);
    return {
      date,
      datePretty: formatDatePretty(date),
      uniqueCustomers: k.uniqueCustomerActivities,
      deals: k.dealsWithActivity,
      called: k.customersCalled,
      notCalled: k.customersNotCalled,
      callCoveragePct: k.callCoveragePct,
      avgFrtMinutes: k.avgFrtMinutes,
      avgFrtFmt: k.avgFrtFmt,
    };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ── FRT distribution buckets ──
function frtDistribution(records) {
  const order = ['0-15 min', '15-30 min', '30-60 min', '1-2 hr', '2+ hr', 'Called — No Timed FRT', 'No Response'];
  const counts = Object.fromEntries(order.map(k => [k, 0]));
  for (const r of records) counts[r.frtBucket] = (counts[r.frtBucket] || 0) + 1;
  return order.map(k => ({ bucket: k, count: counts[k] }));
}

// ── Customers Not Called drill-down (spec section 9) ──
function notCalledList(records, nowISO) {
  const now = new Date(nowISO || Date.now()).getTime();
  return records.filter(r => !r.called).map(r => ({
    activityDate: r.activityDatePretty,
    activityTime: r.activityTime,
    dealId: r.dealId,
    dealName: r.dealName,
    mobile: r.mobileClean,
    stage: r.stage,
    owner: r.owner,
    ageMinutes: Math.round((now - new Date(r.activityRaw).getTime()) / 60000),
    activityWorking: r.activityWorking,
  })).sort((a, b) => b.ageMinutes - a.ageMinutes);
}

// ── Full customer/deal detail table (spec section 15) ──
function detailTable(records) {
  return records.map(r => ({
    activityDate: r.activityDatePretty,
    activityTime: r.activityTime,
    mobile: r.mobileClean,
    dealId: r.dealId,
    dealName: r.dealName,
    stage: r.stage,
    owner: r.owner,
    activityWorking: r.activityWorking,
    called: r.called,
    totalCalls: r.calls.total,
    firstCallTime: r.calls.firstTimeFmt,
    lastCallTime: r.calls.lastTimeFmt,
    frtMinutes: r.frtMinutes,
    frtFmt: r.frtMinutes != null ? fmtMinutes(r.frtMinutes) : (r.called ? 'Called — No Timed FRT' : 'No Response'),
    firstCallWorking: r.calls.firstWorking,
    matchTier: r.calls.matchTier,
  }));
}

module.exports = {
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
  groupByCustomerDay,
  activityDateKeyOf,
  callDateKeyOf,
  isDateEligible,
};
