// Pincode-Level Customer Intelligence — build script.
//
// Sources (raw pulls in ./raw/pincode_customer_intel/*.csv, each row a single TO_JSON_STRING(...)
// column -- this shape works around a real bq CLI display bug, not a BigQuery bug: bq's CSV/JSON
// formatters silently reformat any STRING column whose value LOOKS like a bare number (e.g. a
// 10-digit mobile) into scientific notation / space-grouped digits, corrupting the value. Wrapping
// the whole row in TO_JSON_STRING(STRUCT(...)) makes the column start with `{"`, which bq's
// formatter never touches. Confirmed live 2026-09-16: a bare `RIGHT(...,10)` pull silently produced
// ".18879E+11"-style garbage for a subset of rows; the TO_JSON_STRING wrap fixed the bq-CLI part of
// it, but ~0.24% of user_profile_view_v3 rows have a raw `cuid` value that is ALREADY corrupted at
// the SOURCE (e.g. "9.19767E+11" -- someone's phone number was mangled by Excel/a spreadsheet tool
// upstream of WebEngage, before it ever reached BigQuery) -- RIGHT(...,10) of that garbage produces
// a non-digit "normalized_cuid" like ".19767E+11". These are filtered out below (see
// isValidNormCuid) as a real, disclosed data-quality finding, not silently kept as fake keys.
//
// CUID normalization is MANDATED by the spec for this feature specifically:
//   normalized_cuid = RIGHT(TRIM(CAST(cuid AS STRING)), 10)
// This is a DIFFERENT, looser rule than the regex-validated Indian-mobile-shape normalization used
// by the rest of this dashboard (build_store_location_intel_v2.js) -- kept deliberately separate,
// do not conflate the two.
//
// Run: node build_pincode_customer_intelligence.js
// Reads: ./raw/pincode_customer_intel/*.csv
// Writes: ./out/pincode_customer_intelligence.json

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'raw', 'pincode_customer_intel');
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// Each row of these CSVs is: header "j", then one CSV field per row containing a JSON object,
// CSV-quoted (wrapping "..." with internal quotes doubled). Parse defensively line-by-line.
function loadJsonRowsCsv(file) {
  const text = fs.readFileSync(path.join(RAW, file), 'utf8');
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) { // skip header row "j"
    const line = lines[i];
    if (!line || line === '') continue;
    // Strip one leading/trailing quote, then unescape doubled quotes.
    let s = line;
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    s = s.replace(/""/g, '"');
    try { out.push(JSON.parse(s)); }
    catch (e) { /* malformed line (e.g. a stray blank/partial line from bq CLI) -- skip, not fabricate */ }
  }
  return out;
}

function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
const NCUID_RE = /^[0-9]{10}$/;
function isValidNormCuid(v) { return typeof v === 'string' && NCUID_RE.test(v); }

console.log('Loading raw pulls...');
const profileRaw = loadJsonRowsCsv('profile_mapping.csv');
const eventRaw = loadJsonRowsCsv('event_agg.csv');
const salesRaw = loadJsonRowsCsv('sales_agg.csv');
const campaignRaw = loadJsonRowsCsv('campaign_per_customer.csv');
const geoRaw = loadJsonRowsCsv('pincode_geo_lookup.csv');
const storeRaw = loadJsonRowsCsv('store_master.csv');
const companyRaw = loadJsonRowsCsv('company.csv');
console.log(`  profile=${profileRaw.length} event=${eventRaw.length} sales=${salesRaw.length} campaign=${campaignRaw.length} geo=${geoRaw.length} store=${storeRaw.length} company=${companyRaw.length}`);

// ── Data-quality counters (Section 12) ──────────────────────────────────────
const dq = {
  profileRowsPulled: profileRaw.length,
  eventRowsPulled: eventRaw.length,
  salesRowsPulled: salesRaw.length,
  malformedNormCuidProfile: 0,
  malformedNormCuidEvent: 0,
  malformedNormMobileSales: 0,
};

// ── Pincode reference (built up-front so Layer B can validate against the REAL India Post
// master, not just 6-digit shape -- same convention as the rest of this dashboard: a 6-digit-
// shaped value is not necessarily a real pincode, e.g. "999999" or a plausible-looking free-text
// guess. pincode_geo_lookup is already 1-row-per-pincode by construction (19,561 rows == 19,561
// distinct pincodes, confirmed at the BigQuery layer), deduped here defensively anyway). ──
const geoByPincode = new Map();
for (const r of geoRaw) {
  if (!geoByPincode.has(r.pincode)) geoByPincode.set(r.pincode, { district: r.district, state: r.state, lat: r.latitude, lon: r.longitude });
}

// ── Layer B: Customer Profile Mapping (already deduped 1-row-per-normalized_cuid in SQL) ──
const profileByCuid = new Map();
for (const r of profileRaw) {
  if (!isValidNormCuid(r.normalized_cuid)) { dq.malformedNormCuidProfile++; continue; }
  const shapeValid = r.pincode && /^[1-9][0-9]{5}$/.test(r.pincode);
  profileByCuid.set(r.normalized_cuid, {
    pincode: (shapeValid && geoByPincode.has(r.pincode)) ? r.pincode : null,
    rawPincodeClaimed: r.pincode || null,
    city: r.city || null,
    state: r.state || null,
    fullName: (r.full_name || '').trim() || null,
  });
}

// ── Layer C: WebEngage Event Aggregation (already grouped 1-row-per-normalized_cuid in SQL) ──
const eventByCuid = new Map();
for (const r of eventRaw) {
  if (!isValidNormCuid(r.normalized_cuid)) { dq.malformedNormCuidEvent++; continue; }
  eventByCuid.set(r.normalized_cuid, {
    pdpViews: num(r.pdp_views), atcEvents: num(r.atc_events),
    checkoutEvents: num(r.checkout_events), orderEvents: num(r.order_events),
    totalEvents: num(r.total_events),
    firstActivity: r.first_activity_date || null, lastActivity: r.last_activity_date || null,
  });
}

// Campaign (optional enrichment, last-touch per customer)
const campaignByCuid = new Map();
for (const r of campaignRaw) {
  if (!isValidNormCuid(r.normalized_cuid)) continue;
  campaignByCuid.set(r.normalized_cuid, {
    campaignId: r.campaign_id || null, campaignSource: r.campaign_source || null, campaignMedium: r.campaign_medium || null,
  });
}

// ── Sales: aggregated by normalized MOBILE (not cuid -- marketing_sale has no cuid at all) ──
const salesByMobile = new Map();
for (const r of salesRaw) {
  if (!isValidNormCuid(r.normalized_mobile)) { dq.malformedNormMobileSales++; continue; }
  salesByMobile.set(r.normalized_mobile, {
    salesOrders: num(r.sales_orders), salesLineItems: num(r.sales_line_items), netSales: num(r.net_sales),
    firstOrderDate: r.first_order_date || null, lastOrderDate: r.last_order_date || null,
    companyCodes: r.company_codes || null, channels: r.channels || null, productCategories: r.product_categories || null,
  });
}

// ── Layer D: Customer-level final dataset -- FULL union of every normalized_cuid appearing in
// EITHER profile OR event data (spec: "never silently exclude customers with missing pincode"),
// then sales matched in by the SAME normalized key against the mobile-derived sales key. ──
const allCuids = new Set([...profileByCuid.keys(), ...eventByCuid.keys()]);
const customers = [];
let salesMatchedCuids = 0;
for (const cuid of allCuids) {
  const prof = profileByCuid.get(cuid);
  const ev = eventByCuid.get(cuid) || { pdpViews: 0, atcEvents: 0, checkoutEvents: 0, orderEvents: 0, totalEvents: 0, firstActivity: null, lastActivity: null };
  const sale = salesByMobile.get(cuid);
  if (sale) salesMatchedCuids++;
  const camp = campaignByCuid.get(cuid);
  const pin = (prof && prof.pincode) ? prof.pincode : 'UNKNOWN';
  // City/state for FILTERING and display come from the real pincode master (geoByPincode) when a
  // known pincode exists -- authoritative, since that pincode was already validated against
  // india_pincode/pincode_geo_lookup. The raw WebEngage profile `city`/`region` fields are sparse
  // (region is null for all but a handful of the 230k profiles, confirmed live) and were producing
  // near-empty State-filter results before this fix -- kept only as a fallback for UNKNOWN-pincode
  // customers, who have no geo master row to draw from.
  const geo = pin !== 'UNKNOWN' ? geoByPincode.get(pin) : null;
  customers.push({
    normalizedCuid: cuid,
    pincode: pin,
    rawPincodeClaimed: prof ? prof.rawPincodeClaimed : null,
    city: geo ? geo.district : (prof ? prof.city : null),
    state: geo ? geo.state : (prof ? prof.state : null),
    fullName: prof ? prof.fullName : null,
    pdpViews: ev.pdpViews, atcEvents: ev.atcEvents, checkoutEvents: ev.checkoutEvents, orderEvents: ev.orderEvents,
    totalEvents: ev.totalEvents, firstActivity: ev.firstActivity, lastActivity: ev.lastActivity,
    salesOrders: sale ? sale.salesOrders : 0, salesLineItems: sale ? sale.salesLineItems : 0,
    netSales: sale ? sale.netSales : 0, firstOrderDate: sale ? sale.firstOrderDate : null, lastOrderDate: sale ? sale.lastOrderDate : null,
    companyCodes: sale ? sale.companyCodes : null, channels: sale ? sale.channels : null, productCategories: sale ? sale.productCategories : null,
    hasSale: !!sale,
    campaignId: camp ? camp.campaignId : null, campaignSource: camp ? camp.campaignSource : null, campaignMedium: camp ? camp.campaignMedium : null,
  });
}
// Duplicate check (spec Section 12): normalized_cuid must be unique in the customer-level dataset.
const dupCheck = new Set();
let duplicateCustomerRows = 0;
for (const c of customers) { if (dupCheck.has(c.normalizedCuid)) duplicateCustomerRows++; dupCheck.add(c.normalizedCuid); }

// Sales customers whose normalized mobile never matches ANY WebEngage customer (profile or event) --
// kept out of the customer-level join, disclosed explicitly rather than invented.
let unmatchedSalesCustomers = 0, unmatchedSalesOrders = 0, unmatchedSalesNet = 0;
for (const [mobile, s] of salesByMobile) {
  if (!allCuids.has(mobile)) { unmatchedSalesCustomers++; unmatchedSalesOrders += s.salesOrders; unmatchedSalesNet += s.netSales; }
}

// ── Store master + company enrichment (store_code -> company_name lookup) ──
const companyByCode = new Map(companyRaw.map(r => [r.company_code, r.company_name]));
const stores = storeRaw.map(s => ({
  storeCode: s.store_code, storeName: s.store_name, companyName: companyByCode.get(s.store_code) || null,
  address: s.address, pincode: s.pincode, district: s.district, state: s.state, lat: s.latitude, lon: s.longitude,
}));
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function nearestStore(lat, lon) {
  if (lat == null || lon == null) return null;
  let best = null, bestDist = Infinity;
  for (const s of stores) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best ? { storeCode: best.storeCode, storeName: best.storeName, distanceKm: Math.round(bestDist * 10) / 10 } : null;
}

// ── Layer E: Pincode-level aggregation (+ one explicit "UNKNOWN" bucket row) ──────────────────
const byPincode = new Map();
for (const c of customers) {
  const key = c.pincode;
  if (!byPincode.has(key)) byPincode.set(key, []);
  byPincode.get(key).push(c);
}
const pincodes = [];
for (const [pin, custs] of byPincode) {
  const geo = pin !== 'UNKNOWN' ? geoByPincode.get(pin) : null;
  const uniquePdp = custs.filter(c => c.pdpViews > 0).length;
  const uniqueAtc = custs.filter(c => c.atcEvents > 0).length;
  const uniqueCheckout = custs.filter(c => c.checkoutEvents > 0).length;
  const uniqueOrderEvt = custs.filter(c => c.orderEvents > 0).length;
  const uniqueSalesCust = custs.filter(c => c.hasSale).length;
  const totalPdp = custs.reduce((s, c) => s + c.pdpViews, 0);
  const totalAtc = custs.reduce((s, c) => s + c.atcEvents, 0);
  const totalCheckout = custs.reduce((s, c) => s + c.checkoutEvents, 0);
  const totalOrderEvt = custs.reduce((s, c) => s + c.orderEvents, 0);
  const totalSalesOrders = custs.reduce((s, c) => s + c.salesOrders, 0);
  const totalNetSales = custs.reduce((s, c) => s + c.netSales, 0);
  // City/state: sourced from the real pincode master (geo), never guessed from an arbitrary
  // customer's profile text -- the UNKNOWN bucket spans every state nationwide, so it explicitly
  // gets no single district/state rather than whichever customer happened to be iterated first.
  pincodes.push({
    pincode: pin,
    isKnown: pin !== 'UNKNOWN',
    district: geo ? geo.district : null,
    state: geo ? geo.state : null,
    lat: geo ? geo.lat : null, lon: geo ? geo.lon : null,
    nearestStore: geo ? nearestStore(geo.lat, geo.lon) : null,
    uniqueCustomers: custs.length,
    totalPdpViews: totalPdp, uniquePdpCustomers: uniquePdp,
    totalAtc: totalAtc, uniqueAtcCustomers: uniqueAtc,
    totalCheckout: totalCheckout, uniqueCheckoutCustomers: uniqueCheckout,
    totalOrderEvents: totalOrderEvt, uniqueOrderEventCustomers: uniqueOrderEvt,
    salesOrders: totalSalesOrders, uniqueSalesCustomers: uniqueSalesCust,
    netSales: Math.round(totalNetSales * 100) / 100,
    avgSalesPerCustomer: uniqueSalesCust > 0 ? Math.round((totalNetSales / uniqueSalesCust) * 100) / 100 : null,
    pdpToAtcPct: totalPdp > 0 ? Math.round((totalAtc / totalPdp) * 1000) / 10 : null,
    atcToCheckoutPct: totalAtc > 0 ? Math.round((totalCheckout / totalAtc) * 1000) / 10 : null,
    checkoutToOrderPct: totalCheckout > 0 ? Math.round((totalOrderEvt / totalCheckout) * 1000) / 10 : null,
  });
}
pincodes.sort((a, b) => b.uniqueCustomers - a.uniqueCustomers);

// ── KPIs (Section 7) ──
const kpis = {
  totalUniqueCustomers: customers.length,
  totalPincodes: pincodes.filter(p => p.isKnown).length,
  totalPdpViews: customers.reduce((s, c) => s + c.pdpViews, 0),
  totalUniquePdpCustomers: customers.filter(c => c.pdpViews > 0).length,
  totalAtc: customers.reduce((s, c) => s + c.atcEvents, 0),
  totalUniqueAtcCustomers: customers.filter(c => c.atcEvents > 0).length,
  totalCheckout: customers.reduce((s, c) => s + c.checkoutEvents, 0),
  totalUniqueCheckoutCustomers: customers.filter(c => c.checkoutEvents > 0).length,
  totalOrderEvents: customers.reduce((s, c) => s + c.orderEvents, 0),
  totalUniqueOrderEventCustomers: customers.filter(c => c.orderEvents > 0).length,
  totalSalesOrders: customers.reduce((s, c) => s + c.salesOrders, 0),
  totalUniqueSalesCustomers: customers.filter(c => c.hasSale).length,
  totalNetSales: Math.round(customers.reduce((s, c) => s + c.netSales, 0) * 100) / 100,
};

// ── Data Quality / validation block (Section 12) ──
dq.distinctNormCuidCustomers = allCuids.size;
dq.duplicateCustomerRows = duplicateCustomerRows;
dq.customersWithMissingPincode = customers.filter(c => c.pincode === 'UNKNOWN').length;
dq.customersWithRealPincode = customers.filter(c => c.pincode !== 'UNKNOWN').length;
dq.customersWithClaimedButInvalidPincode = customers.filter(c => c.pincode === 'UNKNOWN' && c.rawPincodeClaimed).length;
dq.salesTotalNetSalesRaw = Math.round(salesRaw.reduce((s, r) => s + num(r.net_sales), 0) * 100) / 100;
dq.salesTotalNetSalesMatched = kpis.totalNetSales;
dq.salesMatchedCuids = salesMatchedCuids;
dq.salesUnmatchedCustomers = unmatchedSalesCustomers;
dq.salesUnmatchedOrders = unmatchedSalesOrders;
dq.salesUnmatchedNetSales = Math.round(unmatchedSalesNet * 100) / 100;
dq.eventTotalRowsRaw = eventRaw.reduce((s, r) => s + num(r.total_events), 0);
dq.eventTotalRowsAfterJoin = customers.reduce((s, c) => s + c.totalEvents, 0);
dq.pincodeUnknownBucketCustomers = dq.customersWithMissingPincode;

console.log('Validation summary:', JSON.stringify(dq, null, 2));
console.log('KPIs:', JSON.stringify(kpis, null, 2));
console.log(`Pincodes (known): ${pincodes.filter(p=>p.isKnown).length}, Unknown bucket size: ${dq.customersWithMissingPincode}`);

const snapshot = {
  generatedAt: new Date().toISOString(),
  meta: {
    normalization: 'RIGHT(TRIM(CAST(cuid AS STRING)), 10) -- mandated for this feature, distinct from the rest of this dashboard\'s regex-validated mobile normalization',
    sources: [
      'test-webengage.11b56595a_shared.application_view_v1',
      'test-webengage.11b56595a_shared.user_profile_view_v3',
      'lucirajewelry-prod.ds_india_geo.india_pincode (source of pincode_geo_lookup)',
      'lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup',
      'lucirajewelry-prod.ds_imputed_reporting.store_location_store_master',
      'lucirajewelry-prod.ds_imputed_reporting.marketing_sale',
      'lucirajewelry-prod.ornaverse_erp_master.company',
    ],
  },
  kpis,
  dataQuality: dq,
  pincodes,
  // Section 13 perf requirement: never ship raw/full WebEngage-scale data to the frontend. The
  // customer-level drill-down (spec Section 9) is only ever opened for ONE real pincode at a time,
  // so only customers with a REAL matched pincode are shipped (17,315 of 228,549) -- the other
  // 211,234 "UNKNOWN pincode" customers are already fully reflected in the UNKNOWN pincode row's
  // aggregate totals above; shipping their individual rows would cost >100MB for zero drill-down
  // value (nobody drills into "UNKNOWN"). Disclosed in dataQuality.customersShippedForDrilldown.
  customers: customers.filter(c => c.pincode !== 'UNKNOWN'),
};
dq.customersShippedForDrilldown = snapshot.customers.length;
dq.customersOmittedUnknownBucket = customers.length - snapshot.customers.length;

const outPath = path.join(OUT, 'pincode_customer_intelligence.json');
fs.writeFileSync(outPath, JSON.stringify(snapshot));
console.log('Wrote', outPath, (fs.statSync(outPath).size / 1024 / 1024).toFixed(2), 'MB');
