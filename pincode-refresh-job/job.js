// Lucira pincode dashboards — daily refresh (Cloud Run Job, added 2026-10-19).
//
// Rebuilds BOTH pincode dashboards from live BigQuery and publishes them:
//   1) Store Location Intelligence  -> gs://lucira-dashboards/store-location/latest.json (gzip, public page)
//   2) GA4 Geo Intelligence data    -> gs://$PRIVATE_BUCKET/ga4-geo/geo_intel_data.js (private; the
//      password-protected ga4-geo-intelligence Cloud Run service serves it from there)
//
// It runs the SAME build code as local (etl/build_store_location_intel_v2.js, etl/build_geo_intel.js)
// and the SAME SQL files, copied into ./bundle by deploy.sh — no logic is duplicated here.
//
// What refreshes daily: marketing_sale sales, Zoho deals, Google Ads geo, customer pincode masters,
// every GA4 geo / city query. What stays frozen: the WebEngage pulls (test-webengage share returns
// Access Denied for our accounts since 2026-09-29) and the competitor store captures — those are
// static inputs downloaded from gs://$PRIVATE_BUCKET/inputs/.
//
// Safety: each dashboard is only published if its sanity checks pass, so a bad/empty query result
// can never overwrite the live page with a broken one.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { BigQuery } = require('@google-cloud/bigquery');
const { Storage } = require('@google-cloud/storage');

const PROJECT = process.env.BQ_PROJECT || 'lucirajewelry-prod';
const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET || 'lucirajewelry-prod-pincode-refresh';
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET || 'lucira-dashboards';
const ONLY = process.env.ONLY || 'all'; // 'sli' | 'geo' | 'all'
const DRY_RUN = process.env.DRY_RUN === '1'; // build + sanity-check, but publish nothing
const B = path.join(__dirname, 'bundle');
const TMP = process.env.TMPDIR || '/tmp';

const bq = new BigQuery({ projectId: PROJECT });
const gcs = new Storage({ projectId: PROJECT });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// bq CLI --format=json emits every scalar as a string (null stays null). The build scripts were
// written against that shape, so query results are normalised to it.
function cliValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'value' in v) return String(v.value); // BigQueryDate/Timestamp/etc.
  if (typeof v === 'object' && typeof v.toFixed === 'function') return v.toString(); // Big (NUMERIC)
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
async function runQuery(sql, label) {
  const t0 = Date.now();
  const [job] = await bq.createQueryJob({ query: sql, useLegacySql: false });
  const [rows] = await job.getQueryResults({ autoPaginate: true }); // NOTE: passing maxResults silently capped results at one page (35,000 of 40,667 deals) -- never set it
  const out = rows.map(r => { const o = {}; for (const k of Object.keys(r)) o[k] = cliValue(r[k]); return o; });
  log(`  ${label}: ${out.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return out;
}
// Pull one query out of a multi-query .sql file by its "-- Qnn:" header.
function sliceSql(file, startMarker, endMarker) {
  const s = fs.readFileSync(file, 'utf8');
  const a = s.indexOf(startMarker);
  if (a < 0) throw new Error(`marker "${startMarker}" not found in ${file}`);
  const b = endMarker ? s.indexOf(endMarker, a + startMarker.length) : -1;
  return s.slice(a, b < 0 ? undefined : b);
}
async function downloadPrefix(bucket, prefix, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const [files] = await gcs.bucket(bucket).getFiles({ prefix });
  for (const f of files) {
    if (f.name.endsWith('/')) continue;
    await f.download({ destination: path.join(dest, path.basename(f.name)) });
  }
  log(`  downloaded ${files.length} inputs from gs://${bucket}/${prefix}`);
}
const writeJson = (dir, name, rows) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), JSON.stringify(rows)); };

async function refreshStoreLocation() {
  log('== Store Location Intelligence ==');
  const raw = path.join(TMP, 'sli_raw'), out = path.join(TMP, 'sli_out');
  await downloadPrefix(PRIVATE_BUCKET, 'inputs/store_location_v2/', raw);
  const ev = path.join(B, 'sql', 'store_location_app_events_pull.sql');
  const zo = path.join(B, 'sql', 'store_location_zoho_ads_pull.sql');
  const pulls = [
    ['sales_raw.json', sliceSql(ev, '-- Q14:', '-- Q12:'), 'Q14 marketing_sale'],
    ['customer_master_pincode.json', sliceSql(ev, '-- Q14b', null), 'Q14b customer pincode'],
    ['zoho_deals_pincode.json', sliceSql(zo, '-- Q15:', '-- Q16:'), 'Q15 Zoho deals'],
    ['zoho_mobile_pincode.json', sliceSql(zo, '-- Q16:', '-- Q17:'), 'Q16 Zoho mobile pincode'],
    ['gads_geo_spend.json', sliceSql(zo, '-- Q17:', null), 'Q17 Google Ads geo']
  ];
  for (const [file, sql, label] of pulls) writeJson(raw, file, await runQuery(sql, label));

  execFileSync('node', [path.join(B, 'build_store_location_intel_v2.js')], { env: { ...process.env, SLI_RAW_DIR: raw, SLI_OUT_DIR: out }, stdio: 'inherit' });
  const buf = fs.readFileSync(path.join(out, 'store_location_intel.json'));
  const snap = JSON.parse(buf);
  const sm = snap.dataQuality && snap.dataQuality.salesMapping, zq = snap.dataQuality && snap.dataQuality.zohoDeals;
  const problems = [];
  if (!snap.pincodes || snap.pincodes.length < 1000) problems.push(`only ${snap.pincodes ? snap.pincodes.length : 0} pincodes`);
  if (!sm || !(sm.totalNetSales > 0) || !(sm.mappedNetSales > 0)) problems.push('sales totals empty');
  if (!zq || !(zq.totalDeals > 0)) problems.push('zoho deals empty');
  if (problems.length) throw new Error('Store Location sanity check failed, NOT publishing: ' + problems.join('; '));
  if (DRY_RUN) { log(`  DRY_RUN: would publish store-location/latest.json (${snap.pincodes.length} pincodes, mapped Rs ${sm.mappedNetSales})`); return; }
  await gcs.bucket(PUBLIC_BUCKET).file('store-location/latest.json').save(zlib.gzipSync(buf, { level: 9 }), {
    resumable: false, metadata: { contentType: 'application/json', contentEncoding: 'gzip', cacheControl: 'no-cache, max-age=0' }
  });
  log(`  published store-location/latest.json: ${snap.pincodes.length} pincodes, deals to ${zq.maxDate}, sales to ${sm.maxDate}, mapped Rs ${sm.mappedNetSales}`);
}

const GEO_NEW = ['q1_national_totals_fact', 'q2_city_users_fact', 'q3_national_daily_fact', 'q4_session_analysis_fact', 'q5_funnel_fact',
  'q6_zoho_pincode', 'q6b_zoho_pincode_coverage', 'q7_city_ga4_daily', 'q8_webengage_pincode', 'q9_sales_pincode', 'q10_pincode_meta'];
const GEO_OLD = ['q1_city_ga4_totals', 'q4_city_campaign_ga4', 'q6_zoho_city_totals', 'q7a_zoho_totals', 'q7b_zoho_daily',
  'q7c_zoho_stage_funnel', 'q7d_zoho_lead_source', 'q8_city_device_ga4'];

async function refreshGeo() {
  log('== GA4 Geo Intelligence ==');
  const st = path.join(TMP, 'geo_static'), nw = path.join(TMP, 'geo_new'), od = path.join(TMP, 'geo_old'), js = path.join(TMP, 'geo_intel_data.js');
  await downloadPrefix(PRIVATE_BUCKET, 'inputs/geo_static/', st);
  for (const q of GEO_NEW) writeJson(nw, q + '.json', await runQuery(fs.readFileSync(path.join(B, 'geo_intel_sql', q + '.sql'), 'utf8'), q));
  for (const q of GEO_OLD) writeJson(od, q + '.json', await runQuery(fs.readFileSync(path.join(B, 'city_intel_sql', q + '.sql'), 'utf8'), q));
  execFileSync('node', [path.join(B, 'build_geo_intel.js')], { env: { ...process.env, GEO_OLD_OUT: od, GEO_NEW_OUT: nw, GEO_STATIC: st, GEO_OUT_JS: js }, stdio: 'inherit' });
  const text = fs.readFileSync(js, 'utf8');
  const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const problems = [];
  if (!(data.zohoPincode && data.zohoPincode.length > 1000)) problems.push('zohoPincode too small');
  if (!(data.salesPincode && data.salesPincode.length > 500)) problems.push('salesPincode too small');
  if (!(data.dailyFact && data.dailyFact.length > 30)) problems.push('dailyFact too small');
  if (problems.length) throw new Error('GA4 Geo sanity check failed, NOT publishing: ' + problems.join('; '));
  if (DRY_RUN) { log(`  DRY_RUN: would publish ga4-geo/geo_intel_data.js (${(text.length / 1048576).toFixed(1)} MB)`); return; }
  await gcs.bucket(PRIVATE_BUCKET).file('ga4-geo/geo_intel_data.js').save(text, {
    resumable: false, gzip: true, metadata: { contentType: 'application/javascript; charset=utf-8', cacheControl: 'no-cache, max-age=0' }
  });
  log(`  published gs://${PRIVATE_BUCKET}/ga4-geo/geo_intel_data.js (${(text.length / 1048576).toFixed(1)} MB), GA4 fact to ${data.meta.ga4_fact_window.max}`);
}

(async () => {
  const failures = [];
  if (ONLY === 'all' || ONLY === 'sli') { try { await refreshStoreLocation(); } catch (e) { failures.push(e); console.error('Store Location FAILED:', e); } }
  if (ONLY === 'all' || ONLY === 'geo') { try { await refreshGeo(); } catch (e) { failures.push(e); console.error('GA4 Geo FAILED:', e); } }
  if (failures.length) { console.error(`${failures.length} refresh(es) failed`); process.exit(1); }
  log('All refreshes published.');
})();
