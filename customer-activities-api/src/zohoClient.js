require('dotenv').config();

// Same OAuth pattern as deals-daily-report-api/src/zohoClient.js — a Zoho
// Self Client (server-based) refresh token, never hardcoded.
const accessTokenCache = { token: null, expiresAt: 0 };
let refreshInFlight = null; // dedupes concurrent refreshes onto one request

function apiBase() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const tld = domain.replace(/^zoho\./, '');
  return `https://www.zohoapis.${tld}`;
}

async function refreshAccessToken() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const url = `https://accounts.${domain}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });

  const res = await fetch(url, { method: 'POST', body: params });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }
  accessTokenCache.token = data.access_token;
  accessTokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return accessTokenCache.token;
}

// With page fetches now running concurrently (see fetchRecordsSince below), a
// cold token cache would otherwise let every concurrent caller independently
// hit Zoho's OAuth endpoint at once — Zoho rate-limits that as "too many
// requests continuously". One shared in-flight refresh fixes it.
async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - 60000) {
    return accessTokenCache.token;
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function zohoFetch(path, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (res.status === 204) return { data: [], info: { more_records: false } };
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho fetch failed (${res.status}) ${path}: ${text}`);
    }
    return res.json();
  }
  throw new Error(`Zoho fetch retries exhausted: ${path}`);
}

// Plain module list, paginated, newest-first by sortField. Stops early once a
// page's oldest record is older than stopBeforeISO (bounded pulls).
//
// Pages within each round are fetched CONCURRENTLY (PAGE_CONCURRENCY at a
// time) instead of one at a time — pagination was previously the dominant
// cost of every dashboard load (a 30-day window can be dozens of sequential
// round trips). We don't know the true page count up front, so a round may
// speculatively fetch a few pages past the real end; Zoho returns an empty
// page for those (harmless, filtered out below) rather than erroring.
const PAGE_CONCURRENCY = 5;

async function fetchRecordsSince(module, fields, { sortField = 'Created_Time', stopBeforeISO = null, maxPages = 500 } = {}) {
  const stopBefore = stopBeforeISO ? new Date(stopBeforeISO).getTime() : null;
  const perPage = 200;

  const fetchPage = async page => {
    const path = `/crm/v2/${module}?fields=${encodeURIComponent(fields.join(','))}&page=${page}&per_page=${perPage}&sort_by=${sortField}&sort_order=desc`;
    const data = await zohoFetch(path);
    return Array.isArray(data.data) ? data.data : [];
  };

  const records = [];
  let page = 1;

  while (page <= maxPages) {
    const roundPages = [];
    for (let i = 0; i < PAGE_CONCURRENCY && page + i <= maxPages; i++) roundPages.push(page + i);
    const roundResults = await Promise.all(roundPages.map(fetchPage));

    let hitEnd = false;
    for (const pageRecords of roundResults) {
      records.push(...pageRecords);
      if (pageRecords.length < perPage) hitEnd = true; // short/empty page = no more data
      if (stopBefore !== null && pageRecords.length) {
        const oldest = new Date(pageRecords[pageRecords.length - 1][sortField]).getTime();
        if (oldest < stopBefore) hitEnd = true;
      }
    }
    if (hitEnd) break;
    page += PAGE_CONCURRENCY;
  }

  return stopBefore !== null
    ? records.filter(r => new Date(r[sortField]).getTime() >= stopBefore)
    : records;
}

// Search API — server-side filter on an arbitrary field via `criteria`, the
// only way to filter Deals directly by the Customer Activities datetime
// field instead of pulling full history client-side.
async function searchRecords(module, fields, criteria, { maxPages = 500 } = {}) {
  const records = [];
  let page = 1;
  const perPage = 200;

  while (page <= maxPages) {
    const path = `/crm/v2/${module}/search?criteria=${encodeURIComponent(criteria)}&fields=${encodeURIComponent(fields.join(','))}&page=${page}&per_page=${perPage}`;
    const data = await zohoFetch(path);
    const pageRecords = Array.isArray(data.data) ? data.data : [];
    records.push(...pageRecords);
    if (!data.info || !data.info.more_records) break;
    page += 1;
  }
  return records;
}

async function getDealFieldsMeta() {
  const data = await zohoFetch('/crm/v2/settings/fields?module=Deals');
  return data.fields || [];
}

module.exports = { getAccessToken, fetchRecordsSince, searchRecords, getDealFieldsMeta, apiBase };
