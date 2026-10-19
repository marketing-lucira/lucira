#!/usr/bin/env node
// build_geo_intel.js -- Node port of build_geo_intel.ps1 (2026-10-19), so the same snapshot can be
// built inside the pincode-refresh Cloud Run Job (no PowerShell there). Merges the city-intel
// BigQuery outputs (etl/city_intel_sql/out/*.json) with the GA4 Geo Intelligence outputs
// (etl/geo_intel_sql/out/*.json) + static competitor/area files into window.GEO_INTEL_DATA.
//
// Paths are overridable so the job can point at /tmp:
//   GEO_OLD_OUT  (default etl/city_intel_sql/out)
//   GEO_NEW_OUT  (default etl/geo_intel_sql/out)
//   GEO_STATIC   (default etl)  -- caratlane_stores.json, caratlane_store_master.json,
//                                  tanishq_store_master.json, pincode_area_display.json
//   GEO_OUT_JS   (default dashboard/geo_intel_data.js)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OLD_OUT = process.env.GEO_OLD_OUT || path.join(ROOT, 'etl', 'city_intel_sql', 'out');
const NEW_OUT = process.env.GEO_NEW_OUT || path.join(ROOT, 'etl', 'geo_intel_sql', 'out');
const STATIC_DIR = process.env.GEO_STATIC || path.join(ROOT, 'etl');
const OUT_JS = process.env.GEO_OUT_JS || path.join(ROOT, 'dashboard', 'geo_intel_data.js');

const load = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, ''));
const int = v => (v == null || v === '' ? 0 : parseInt(v, 10) || 0);
const dbl = v => (v == null || v === '' ? 0 : parseFloat(v) || 0);
const round1 = x => Math.round(x * 10) / 10;

// ---- city-intel outputs ----
const q1old = load(OLD_OUT, 'q1_city_ga4_totals.json');
const q4old = load(OLD_OUT, 'q4_city_campaign_ga4.json');
const q6old = load(OLD_OUT, 'q6_zoho_city_totals.json');
const q7a = load(OLD_OUT, 'q7a_zoho_totals.json');
const q7b = load(OLD_OUT, 'q7b_zoho_daily.json');
const q7c = load(OLD_OUT, 'q7c_zoho_stage_funnel.json');
const q7d = load(OLD_OUT, 'q7d_zoho_lead_source.json');
const q8old = load(OLD_OUT, 'q8_city_device_ga4.json');

// ---- fact-table + pincode outputs ----
const natTotals = load(NEW_OUT, 'q1_national_totals_fact.json');
const cityUsers = load(NEW_OUT, 'q2_city_users_fact.json');
const dailyFact = load(NEW_OUT, 'q3_national_daily_fact.json');
const sessAnl = load(NEW_OUT, 'q4_session_analysis_fact.json');
const funnel = load(NEW_OUT, 'q5_funnel_fact.json');
const zohoZip = load(NEW_OUT, 'q6_zoho_pincode.json');
const cityGa4Daily = load(NEW_OUT, 'q7_city_ga4_daily.json');
const webengagePincode = load(NEW_OUT, 'q8_webengage_pincode.json');
// 2026-10-19 Pin Code merge (see build_geo_intel.ps1 header for what each query is)
const zohoPinCoverage = load(NEW_OUT, 'q6b_zoho_pincode_coverage.json');
const salesPincode = load(NEW_OUT, 'q9_sales_pincode.json');
const pincodeMetaAll = load(NEW_OUT, 'q10_pincode_meta.json');
const pincodeMeta = pincodeMetaAll.filter(r => r.pincode !== '__totals__').map(r => { const o = { ...r }; delete o.totals_json; return o; });
const totalsRow = pincodeMetaAll.find(r => r.pincode === '__totals__');
const salesTotalsJson = totalsRow && totalsRow.totals_json ? String(totalsRow.totals_json) : '[]';

// ---- static competitor + area reference data ----
const caratlaneStores = load(STATIC_DIR, 'caratlane_stores.json');
const caratlaneStoreMaster = load(STATIC_DIR, 'caratlane_store_master.json');
const tanishqStoreMaster = load(STATIC_DIR, 'tanishq_store_master.json');
const areaPath = path.join(STATIC_DIR, 'pincode_area_display.json');
const areaLookup = fs.existsSync(areaPath) ? load(STATIC_DIR, 'pincode_area_display.json') : {};
for (const row of zohoZip) row.area = areaLookup[String(row.pincode)] ?? null;

const t = q7a[0];
const dealsWithZip = int(t.deals_with_zip);
const dealsTotal = int(t.deals_total), dealsWithCity = int(t.deals_with_city);
const coverage = {
  deals_total: dealsTotal,
  deals_with_city: dealsWithCity,
  deals_with_city_pct: round1(100 * dealsWithCity / dealsTotal),
  deals_with_zip: dealsWithZip,
  deals_without_zip: dealsTotal - dealsWithZip,
  deals_with_zip_pct: round1(100 * dealsWithZip / dealsTotal),
  won_total: int(t.won_total),
  won_with_city: int(t.won_with_city),
  amount_total: dbl(t.amount_total),
  amount_with_city: dbl(t.amount_with_city),
  min_date: t.min_date,
  max_date: t.max_date,
  note: `Only ${dealsWithCity} of ${dealsTotal} deals (${round1(100 * dealsWithCity / dealsTotal)}%) have Address_City populated, and only ${dealsWithZip} of ${dealsTotal} (${round1(100 * dealsWithZip / dealsTotal)}%) have Address_Zip populated in the legacy Lucira_Prod.lucira_zoho_Deals copy used by the city pages. The Pin Code page no longer depends on this: it reads live zoho_crm.cdc_deals with deal zip / contact Mailing_Zip (see zohoPincodeCoverage) and real marketing_sale sales by sale pincode (salesPincode). Zoho Amount is ~always 0, so revenue by city comes from GA4 (city pages) or marketing_sale (Pin Code page).`
};

const natTotalsRow = natTotals[0];
const nowIst = new Date(Date.now() + 330 * 60000).toISOString().replace('Z', '+05:30').replace(/\.\d{3}/, '');
const payload = {
  meta: {
    generated_at: nowIst,
    ga4_mart_source: 'lucirajewelry-prod.ga4_data.ga4_data',
    ga4_fact_source: 'lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions',
    zoho_source: 'lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals (city pages); zoho_crm.cdc_deals (Pin Code page)',
    sales_source: 'lucirajewelry-prod.ds_imputed_reporting.marketing_sale (Pin Code page, sale-pincode mapped)',
    erp_source: 'Ornaverse ERP live snapshot (fetched client-side, same as Sales Intelligence)',
    ga4_fact_window: { min: natTotalsRow.min_date, max: natTotalsRow.max_date },
    zoho_window: { min: coverage.min_date, max: coverage.max_date }
  },
  coverage,
  nationalTotals: natTotalsRow,
  funnel: funnel[0],
  cityTotals: q1old,
  cityUsersFact: cityUsers,
  cityGa4Daily,
  dailyFact,
  campaigns: q4old,
  sessionAnalysis: sessAnl,
  zohoCity: q6old,
  zohoPincode: zohoZip,
  webengagePincode,
  caratlaneStores,
  caratlaneStoreMaster,
  tanishqStoreMaster,
  zohoDaily: q7b,
  zohoStages: q7c,
  zohoLeadSource: q7d,
  devices: q8old,
  zohoPincodeCoverage: zohoPinCoverage,
  salesPincode,
  pincodeMeta,
  salesTotalsJson
};

fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
fs.writeFileSync(OUT_JS, 'window.GEO_INTEL_DATA = ' + JSON.stringify(payload) + ';');
console.log(`WROTE ${OUT_JS} (${(fs.statSync(OUT_JS).size / 1024).toFixed(1)} KB)`);
console.log(`GA4 fact ${natTotalsRow.min_date}..${natTotalsRow.max_date}; deals pincode rows ${zohoZip.length}; sales pincode rows ${salesPincode.length}`);
