require('dotenv').config();

const accessTokenCache = { token: null, expiresAt: 0 };

function apiBase() {
  const domain = process.env.ZOHO_DOMAIN || 'zoho.com';
  const tld = domain.replace(/^zoho\./, '');
  return `https://www.zohoapis.${tld}`;
}

async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - 60000) {
    return accessTokenCache.token;
  }
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

// Fetches a module's records sorted by sortField desc, stopping pagination as
// soon as a page's oldest record falls before stopBeforeISO (records created
// before the range we care about) — avoids pulling full history every time.
async function fetchRecordsSince(module, fields, { sortField = 'Created_Time', stopBeforeISO = null, maxPages = 1000 } = {}) {
  const records = [];
  let page = 1;
  const perPage = 200;
  const stopBefore = stopBeforeISO ? new Date(stopBeforeISO).getTime() : null;

  while (page <= maxPages) {
    const token = await getAccessToken();
    const url = `${apiBase()}/crm/v2/${module}?fields=${encodeURIComponent(fields.join(','))}&page=${page}&per_page=${perPage}&sort_by=${sortField}&sort_order=desc`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho ${module} fetch failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const pageRecords = Array.isArray(data.data) ? data.data : [];
    records.push(...pageRecords);

    if (stopBefore !== null && pageRecords.length) {
      const oldestInPage = new Date(pageRecords[pageRecords.length - 1][sortField]).getTime();
      if (oldestInPage < stopBefore) break;
    }

    const more = data.info && data.info.more_records;
    if (!more) break;
    page += 1;
  }

  if (stopBefore !== null) {
    return records.filter(r => new Date(r[sortField]).getTime() >= stopBefore);
  }
  return records;
}

module.exports = { getAccessToken, fetchRecordsSince };
