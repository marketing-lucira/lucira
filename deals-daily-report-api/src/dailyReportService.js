function normalizeMobile(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function isWhatsAppTriggered(deal) {
  const trigger = (deal.Deal_Trigger_Event || '').toString().toLowerCase();
  return trigger.includes('whatsapp');
}

// Same customer, same calendar day they were CREATED -> keep only the latest record
// (always anchored to Created_Time, regardless of which tab/date field rows are grouped
// by), remembering every raw id in the group so first-call lookups aren't lost when an
// earlier duplicate (not the survivor) is the one a real call got logged against.
function groupByMobileAndDay(deals) {
  const groups = new Map();

  for (const deal of deals) {
    const mobile = normalizeMobile(deal.Mobile);
    const dateVal = deal.Created_Time;
    if (!mobile || !dateVal) continue;

    const day = dateVal.slice(0, 10);
    const key = `${mobile}|${day}`;
    const t = new Date(dateVal).getTime();

    if (!groups.has(key)) {
      groups.set(key, { survivor: deal, survivorTime: t, ids: [deal.id] });
    } else {
      const g = groups.get(key);
      g.ids.push(deal.id);
      if (t > g.survivorTime) {
        g.survivor = deal;
        g.survivorTime = t;
      }
    }
  }

  return Array.from(groups.values()).map(g => ({ ...g.survivor, _groupDealIds: g.ids }));
}

// Earliest call per deal, only for calls linked directly to a Deal record (What_Id -> Deals).
function buildCallFirstIndex(calls) {
  const index = new Map();

  for (const call of calls) {
    const what = call.What_Id;
    if (!what || !what.id) continue;
    if (call.$se_module && call.$se_module !== 'Deals') continue;

    const startTime = call.Call_Start_Time;
    if (!startTime) continue;
    const t = new Date(startTime).getTime();

    const existing = index.get(what.id);
    if (!existing || t < existing.time) {
      index.set(what.id, {
        startTime,
        time: t,
        durationSeconds: call.Call_Duration_in_seconds || 0,
        callType: call.Call_Type || null,
      });
    }
  }

  return index;
}

function formatHHMMSS(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return null;
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

// Generic grouping aggregator — same 10 metrics, any grouping key (date, probability, ...).
// Working-hours and first-call metrics always anchor to Created_Time (the deal's actual
// origin), regardless of what the grouping key is based on.
function buildGroupedRows(deals, callIndex, keyFn) {
  const rowsByKey = new Map();

  for (const deal of deals) {
    const key = keyFn(deal);
    if (key == null) continue;

    const createdVal = deal.Created_Time;
    if (!createdVal) continue;
    const createdDay = createdVal.slice(0, 10);
    const hour = parseInt(createdVal.slice(11, 13), 10);

    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        key,
        totalDeals: 0,
        probScoreQualified: 0,
        lostCount: 0,
        wonCount: 0,
        workingHourCount: 0,
        workingHourSameDayCallCount: 0,
        nonWorkingHourCount: 0,
        sameDayCallSecondsSum: 0,
        sameDayCallDealCount: 0,
        under30MinCount: 0,
        connectedCount: 0,
        stageCounts: new Map(),
      });
    }
    const row = rowsByKey.get(key);
    row.totalDeals += 1;

    const prob = Number(deal.Probability_Score);
    if (!Number.isNaN(prob) && prob >= 70) row.probScoreQualified += 1;

    if (deal.Stage === 'Closed Lost') row.lostCount += 1;
    if (deal.Stage === 'Closed Won') row.wonCount += 1;

    const stageKey = deal.Stage || 'Unknown';
    row.stageCounts.set(stageKey, (row.stageCounts.get(stageKey) || 0) + 1);

    const isWorkingHour = hour >= 10 && hour < 21;
    if (isWorkingHour) row.workingHourCount += 1;
    else row.nonWorkingHourCount += 1;

    const idsToCheck = deal._groupDealIds || [deal.id];
    let firstCall = null;
    for (const id of idsToCheck) {
      const c = callIndex.get(id);
      if (c && (!firstCall || c.time < firstCall.time)) firstCall = c;
    }

    if (firstCall) {
      const diffSeconds = (firstCall.time - new Date(createdVal).getTime()) / 1000;
      if (diffSeconds >= 0) {
        const callDay = firstCall.startTime.slice(0, 10);
        const isSameDayCall = callDay === createdDay;
        if (isSameDayCall) {
          if (isWorkingHour) row.workingHourSameDayCallCount += 1;

          // Avg first call only counts deals created 10am–9pm whose first call
          // also landed 10am–9pm the same day (both legs inside working hours).
          const callHour = parseInt(firstCall.startTime.slice(11, 13), 10);
          const isCallWorkingHour = callHour >= 10 && callHour < 21;
          if (isWorkingHour && isCallWorkingHour) {
            row.sameDayCallSecondsSum += diffSeconds;
            row.sameDayCallDealCount += 1;
          }
        }
        if (diffSeconds <= 1800) row.under30MinCount += 1;
      }
      if ((firstCall.durationSeconds || 0) >= 30) row.connectedCount += 1;
    }
  }

  return Array.from(rowsByKey.values()).map(row => {
    let dominantStage = null;
    let dominantCount = -1;
    row.stageCounts.forEach((count, stage) => {
      if (count > dominantCount) {
        dominantCount = count;
        dominantStage = stage;
      }
    });

    return {
      key: row.key,
      totalDeals: row.totalDeals,
      probScoreQualified: row.probScoreQualified,
      probScorePct: row.totalDeals ? Math.round((row.probScoreQualified / row.totalDeals) * 1000) / 10 : 0,
      lostCount: row.lostCount,
      wonCount: row.wonCount,
      workingHourCount: row.workingHourCount,
      workingHourSameDayCallCount: row.workingHourSameDayCallCount,
      nonWorkingHourCount: row.nonWorkingHourCount,
      sameDayCallSecondsSum: row.sameDayCallSecondsSum,
      sameDayCallDealCount: row.sameDayCallDealCount,
      avgFirstCallFormatted: row.sameDayCallDealCount
        ? formatHHMMSS(row.sameDayCallSecondsSum / row.sameDayCallDealCount)
        : null,
      under30MinCount: row.under30MinCount,
      connectedCount: row.connectedCount,
      dominantStage,
    };
  });
}

function buildDailyRows(deals, callIndex, dateField) {
  const rows = buildGroupedRows(deals, callIndex, deal => {
    const dateVal = deal[dateField];
    return dateVal ? dateVal.slice(0, 10) : null;
  });
  return rows
    .map(row => ({ date: row.key, ...row, key: undefined }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function buildProbabilityRows(deals, callIndex) {
  const rows = buildGroupedRows(deals, callIndex, deal => {
    const prob = Number(deal.Probability_Score);
    return Number.isNaN(prob) ? null : prob;
  });
  return rows
    .map(row => ({ probability: row.key, ...row, key: undefined }))
    .sort((a, b) => a.probability - b.probability);
}

// One row per (agent, probability score) pair, with the full metric set (working
// hours, same-day call timing, etc.) — used for the Closed Lost agent breakdown.
function buildAgentProbabilityRows(deals, callIndex) {
  const rows = buildGroupedRows(deals, callIndex, deal => {
    const agent = (deal.Owner && deal.Owner.name) || 'Unassigned';
    const prob = Number(deal.Probability_Score);
    if (Number.isNaN(prob)) return null;
    return `${agent}|||${prob}`;
  });
  return rows
    .map(row => {
      const sep = row.key.lastIndexOf('|||');
      const agent = row.key.slice(0, sep);
      const probability = Number(row.key.slice(sep + 3));
      return { agent, probability, ...row, key: undefined };
    })
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.probability - b.probability);
}

// Pivot: one row per agent, one count column per distinct Probability value present.
function buildAgentProbabilityPivot(deals) {
  const agentMap = new Map();
  const probabilities = new Set();

  for (const deal of deals) {
    const agent = (deal.Owner && deal.Owner.name) || 'Unassigned';
    const prob = Number(deal.Probability_Score);
    if (Number.isNaN(prob)) continue;

    probabilities.add(prob);
    if (!agentMap.has(agent)) agentMap.set(agent, new Map());
    const counts = agentMap.get(agent);
    counts.set(prob, (counts.get(prob) || 0) + 1);
  }

  const sortedProbabilities = Array.from(probabilities).sort((a, b) => a - b);

  const rows = Array.from(agentMap.entries()).map(([agent, counts]) => {
    let total = 0;
    const byProbability = {};
    sortedProbabilities.forEach(p => {
      const c = counts.get(p) || 0;
      byProbability[p] = c;
      total += c;
    });
    return { agent, byProbability, total };
  }).sort((a, b) => b.total - a.total);

  return { probabilities: sortedProbabilities, rows };
}

function istDateKey(date) {
  const shifted = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getRangeWindow(range, customStart, customEnd) {
  if (range === 'custom' && customStart && customEnd) {
    return {
      start: new Date(`${customStart}T00:00:00+05:30`),
      end: new Date(`${customEnd}T23:59:59+05:30`),
    };
  }

  const today = istDateKey(new Date());
  const todayStart = new Date(`${today}T00:00:00+05:30`);
  const dayMs = 24 * 60 * 60 * 1000;

  switch (range) {
    case 'daily':
      return { start: todayStart, end: new Date(todayStart.getTime() + dayMs - 1) };
    case 'yesterday':
      return { start: new Date(todayStart.getTime() - dayMs), end: new Date(todayStart.getTime() - 1) };
    case 'weekly':
      return { start: new Date(todayStart.getTime() - 6 * dayMs), end: new Date(todayStart.getTime() + dayMs - 1) };
    case 'quarterly':
      return { start: new Date(todayStart.getTime() - 89 * dayMs), end: new Date(todayStart.getTime() + dayMs - 1) };
    case 'yearly':
      return { start: new Date(todayStart.getTime() - 364 * dayMs), end: new Date(todayStart.getTime() + dayMs - 1) };
    case 'monthly':
    default:
      return { start: new Date(todayStart.getTime() - 29 * dayMs), end: new Date(todayStart.getTime() + dayMs - 1) };
  }
}

module.exports = {
  normalizeMobile,
  isWhatsAppTriggered,
  groupByMobileAndDay,
  buildCallFirstIndex,
  buildDailyRows,
  buildProbabilityRows,
  buildAgentProbabilityPivot,
  buildAgentProbabilityRows,
  formatHHMMSS,
  getRangeWindow,
  istDateKey,
};
