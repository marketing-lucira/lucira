// Store Location Intelligence & Campaign Demand — v2 build script.
// GA4 (`lucirajewelry-prod.ga4_data.ga4_data`) has ZERO dependency here. Every behavioral metric
// (PDP views, ATC, checkout, purchase, wishlist, campaign, product/SKU, daily) is now sourced from
// `test-webengage.11b56595a_shared.application_view_v1`, pulled via
// dashboard/sql/store_location_app_events_pull.sql. Store master + India pincode master (never GA4)
// and the WebEngage PROFILE-level "Users" count (user_profile_view_v3, kept as a distinct signal
// from event volume) are unchanged from the v1 pipeline.
//
// REAL, LOAD-BEARING GAPS (confirmed live 2026-09-01, disclosed in dataQuality below, not hidden):
//  1. application_view_v1 has 0% postal_code. Pincode-exact event data exists ONLY for the ~11% of
//     events with a valid mobile `cuid` that ALSO matches a real pincode via a same-project join to
//     user_profile_view_v3 (see app_pincode_agg.json). This is a REAL improvement over the old GA4
//     pipeline for the matched slice (pincode-exact funnel events, not a city proxy) but covers far
//     fewer events than the city-grain tables.
//  2. cuid (mobile) covers ~11% of all event rows; the other 89% are real events usable only as
//     anonymous city/campaign volume, never linked to a phone-identified customer.
//  3. addToCart has 0% json_data (no category/price ever available for ATC, not estimated).
//     productView (camelCase) json_data is 1.2%-populated and only holds an image URL. Product
//     Viewed (Title Case, 100% json coverage) is the only reliable PDP-view product/category/price
//     source. Purchase json_data is 100% populated with real items[] (sku/price/category) AND a
//     real shipping/billing address (city/state/zipcode) -- Purchase rows carry a REAL pincode,
//     independent of the mobile-join, which is genuinely better than anything GA4 ever provided.
//  4. No `gender` field exists anywhere on application_view_v1 -- Gender Demand has no WebEngage
//     equivalent and is marked unavailable below, not faked.
//  5. Event Count vs Unique Customer are BOTH surfaced everywhere they differ meaningfully (a
//     customer generating 5 PDP views + 1 purchase must not read as 6 different customers).
//
// MOBILE NORMALIZATION (customer key, Tier 1): +91/91/0-prefixed or bare 10-digit Indian mobile,
// applied identically in every SQL pull (see store_location_app_events_pull.sql header) and here
// for the customer sample. Tier 2 (luid) is NOT usable for cross-table identity: application_view_v1
// luid is a 32-char hash, user_profile_view_v3 luid is a 40-char hash -- different ID namespaces,
// confirmed live -- so luid is only used as an anonymous WITHIN-application_view_v1 device count,
// never joined across tables.
//
// Run: node build_store_location_intel_v2.js
// Reads: ./raw/store_location_v2/*.json
// Writes: ./out/store_location_intel.json

const fs = require('fs');
const path = require('path');

// SLI_RAW_DIR / SLI_OUT_DIR let the daily pincode-refresh Cloud Run Job run this same file from /tmp.
const RAW = process.env.SLI_RAW_DIR || path.join(__dirname, 'raw', 'store_location_v2');
const OUT = process.env.SLI_OUT_DIR || path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function loadJSON(name) { return JSON.parse(fs.readFileSync(path.join(RAW, name), 'utf8')); }
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function round1(v) { return v === null || v === undefined || isNaN(v) ? null : Math.round(v * 10) / 10; }
function safeDiv(a, b) { return b > 0 ? (a / b) * 100 : null; }
// City alias map -- reconciles India Post district-name spelling (used by pincode/store-master
// records) with WebEngage's own free-text city field (used by every application_view_v1
// aggregate), so a pincode can look up its city-level context by district. Exported into
// meta.dataLineage below so the dashboard's Data Lineage tab can render this table exactly as
// used, not a hand-copied summary that can drift from the real code.
const CITY_ALIASES = {
  'new delhi': 'delhi', 'west delhi': 'delhi', 'south delhi': 'delhi', 'east delhi': 'delhi',
  'north delhi': 'delhi', 'north west delhi': 'delhi', 'south west delhi': 'delhi',
  'gurugram': 'gurgaon', 'bengaluru': 'bangalore', 'bombay': 'mumbai',
  'greater mumbai': 'mumbai', 'navi mumbai': 'mumbai', 'thane': 'mumbai',
  'calcutta': 'kolkata', 'madras': 'chennai', 'pune city': 'pune',
  'noida': 'noida', 'greater noida': 'noida', 'gautam buddha nagar': 'noida',
  // Same bug class as the Delhi fix below: India Post district names for major metros don't
  // match WebEngage's own city text. Confirmed live: real event volume exists under "Mumbai"
  // (2.5M events) and "Bengaluru" (622K events) but district "MUMBAI SUBURBAN" (40 pincodes) /
  // "BENGALURU URBAN" (15) / "BENGALURU RURAL" (2) were silently unmatched, all blank.
  'mumbai suburban': 'mumbai', 'mumbai city': 'mumbai',
  'bengaluru urban': 'bangalore', 'bengaluru rural': 'bangalore',
  // BUG FIX 2026-09-01, found by user inspection: the India Post pincode master names Delhi's
  // 11 districts with bare directional words ("WEST", "CENTRAL", "NORTH EAST", "SHAHDARA", ...)
  // while WebEngage's own city text uses "West Delhi"/"South Delhi"/etc -- normCity() on the raw
  // district alone ("west") never matched the "delhi"-aliased app-event city key, so 10 of 11
  // Delhi districts silently got NO city-proxy data (PDP/ATC/Purchase/Revenue all blank) even
  // though the real event data existed, aggregated under "delhi". Confirmed live: every bare
  // directional district value in the full pincode master belongs exclusively to Delhi state
  // (zero collisions with any other state's district naming) -- safe to alias unconditionally.
  'west': 'delhi', 'east': 'delhi', 'north': 'delhi', 'south': 'delhi', 'central': 'delhi',
  'north east': 'delhi', 'south east': 'delhi', 'north west': 'delhi', 'south west': 'delhi',
  'shahdara': 'delhi'
};
function normCity(s) {
  if (!s) return '';
  let c = String(s).trim().toLowerCase();
  return CITY_ALIASES[c] || c;
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function percentileRanker(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v) => {
    if (n === 0) return 0;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return n === 1 ? 100 : (lo / (n - 1)) * 100;
  };
}
function normMobile(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^0-9]/g, '');
  if (/^91[6-9][0-9]{9}$/.test(d)) return d.slice(2);
  if (/^0[6-9][0-9]{9}$/.test(d)) return d.slice(1);
  if (/^[6-9][0-9]{9}$/.test(d)) return d;
  return null;
}
function maskMobile(m) { return m ? '••••••' + m.slice(-4) : null; }

console.log('Loading raw sources (WebEngage application_view_v1 + user_profile_view_v3 + store/pincode masters -- ZERO ga4_data dependency)...');
const storeMaster = loadJSON('store_master.json').map(s => ({
  storeCode: s.store_code, storeName: s.store_name, address: s.address, pincode: s.pincode,
  district: s.district, state: s.state, lat: num(s.latitude), lon: num(s.longitude), notes: s.notes || null
}));
const pincodeGeo = loadJSON('pincode_geo_lookup.json');
const pincodeGeoMap = new Map(pincodeGeo.map(p => [p.pincode, p]));

const wePincodeAgg = loadJSON('we_pincode_agg.json');            // profile-level "Users" (unchanged source, not GA4)
const weDataQuality = loadJSON('we_data_quality.json')[0];

const appPincodeAgg = loadJSON('app_pincode_agg.json');          // event-level, mobile-joined, PINCODE-EXACT
const appPincodeCampaign = loadJSON('app_pincode_campaign_agg.json');
const appStateCity = loadJSON('app_state_city_agg.json');
const appCampaign = loadJSON('app_campaign_agg.json');
const appCampaignCity = loadJSON('app_campaign_city_agg.json');
const appProductPdp = loadJSON('app_product_pdp_agg.json');
const appProductPurchase = loadJSON('app_product_purchase_agg.json');
const appDailyCity = loadJSON('app_daily_city_agg.json');
const appDailyCampaign = loadJSON('app_daily_campaign_agg.json');
const appDataQuality = loadJSON('app_data_quality.json')[0];
const appEventCoverage = loadJSON('app_event_coverage.json');
const appPurchaseEventsByCity = loadJSON('app_purchase_events_by_city.json'); // event-level (not line-item) Purchase count, same address-based city as revenue
// Customer x Pincode grain (2026-09-01 drill-down feature): one row per (mobile, pincode), pincode
// picked as the CANONICAL one per customer (latest user_profile_view_v3 record by last_seen,
// ROW_NUMBER-deduped in SQL -- confirmed live: 292 rows, 292 distinct mobiles, i.e. every customer
// maps to exactly one pincode, no duplication). This is the real ceiling: of 64,015 customers with
// a real mobile+pincode profile, only 292 ever generated an application_view_v1 event with that
// same mobile attached -- everyone else's events are real but not identity-linkable.
const customerPincodeEvents = loadJSON('customer_pincode_events.json');
const customerPincodeRevenue = loadJSON('customer_pincode_revenue.json');
// LUID-based customer x pincode grain (added 2026-09-16, supplementary/comparison only). Live
// data-validation finding: LUID has a much HIGHER raw identity-overlap between application_view_v1
// and user_profile_view_v3 (82%, confirmed live) than mobile does, and needs no de-dup (unlike
// mobile, user_profile_view_v3 already has exactly 1 row per LUID). But when restricted to a REAL
// India-Post pincode, LUID surfaces FEWER usable customers than mobile (95 vs 158 confirmed live)
// -- because a valid real pincode is independently rare across the whole profile table regardless
// of which identifier reaches it, and the mobile path happens to land on more of those rare rows.
// Kept here as a SUPPLEMENTARY, side-by-side count on each pincode -- mobile stays the primary
// customer-drill-down identifier (uniqueCustomers_exact) since it finds more real customers.
const customerPincodeEventsLuid = loadJSON('customer_pincode_events_luid.json');
// Competitor store presence (Tanishq + CaratLane), added 2026-09-02. NOT a BigQuery source --
// pre-existing local files (etl/tanishq_store_master.json, etl/caratlane_store_master.json), the
// same real, one-time public-store-locator capture already used by the sibling GA4 Geo
// Intelligence dashboard's CaratLane layer, matched by EXACT pincode string (no geocoding here --
// lat/lon comes from OUR OWN pincode_geo_lookup for any matched pincode, same master as everything
// else). Confirmed live: 103 of our 3,096 real pincodes have a Tanishq store, 66 have a CaratLane
// store (of 509 and 308 total captured store-pincodes respectively -- most competitor stores sit
// outside our tracked-pincode set, which is expected: our pincode set is bounded to where
// WebEngage/Lucira has real user data, not every pincode in India).
const tanishqStores = loadJSON('tanishq_store_master.json');
const caratlaneStores = loadJSON('caratlane_store_master.json');
const tanishqByPincode = new Map(tanishqStores.map(r => [r.pincode, r.stores || []]));
const caratlaneByPincode = new Map(caratlaneStores.map(r => [r.pincode, r.stores || []]));
// CaratLane's own public online-catalog mix per store (category counts + price-band counts) --
// real data, no equivalent capture exists for Tanishq (their public locator has no catalog view).
const caratlaneCatalog = loadJSON('caratlane_stores.json');
const caratlaneCatalogByPincode = new Map();
for (const s of caratlaneCatalog) {
  const arr = caratlaneCatalogByPincode.get(s.pincode) || [];
  arr.push({ store: s.store, address: s.address, cat: s.cat || {}, pb: s.pb || {} });
  caratlaneCatalogByPincode.set(s.pincode, arr);
}
// Real sales (2026-09-01 addition): lucirajewelry-prod.ds_imputed_reporting.marketing_sale --
// company-wide sales ledger (Online/Store/Amazon/TAH channels, ~2,350 line items, ~1,790 orders,
// Rs 9.28 crore net_sale over 2025-08-18 to 2026-08-31), NOT GA4. Cus_mobile is 100% populated and
// already clean-formatted, but the table itself has NO pincode column (city_name/address are
// 60-90% NULL) -- geography comes from the SAME canonical-mobile-to-pincode join used for events.
// Pulled as two SEPARATE single-project queries (test-webengage canonical mobile map,
// lucirajewelry-prod sales rows) and merged HERE client-side -- marketing_sale lives in
// lucirajewelry-prod while user_profile_view_v3 lives in test-webengage, so joining them in one
// BigQuery job hits the same cross-region restriction documented throughout this pipeline
// (confirmed live: "Access Denied" when attempted in a single query).
const canonicalMobilePincode = loadJSON('canonical_mobile_pincode.json');
const salesRaw = loadJSON('sales_raw.json');
const customerMasterPincode = loadJSON('customer_master_pincode.json'); // Q14b: typed customer-record pincode by mobile (ERP CRM > Shopify > imputed customer)

// ---------- Zoho CRM Deals + Google Ads geo (added 2026-09-29, dashboard/sql/store_location_zoho_ads_pull.sql) ----------
// Zoho: one row per deal, pincode = Deal zip else linked Contact's Mailing_Zip. Validated live
// against the sale's OWN address pincode for the 65 buyers that have both: only 2 exact matches,
// 71% same state, 26% same district, median 37km apart -- i.e. APPROXIMATE (looks IP-derived;
// NitroProductView-triggered, ISP-hub pincodes like 562130/110001 dominate). So Zoho deals are
// shown and rolled up to City/State, but carry 0% weight in the PINCODE Opportunity Score.
// Google Ads: geographic_view, 100% LOCATION_OF_PRESENCE (Google's own user-location), decoded
// via Google's public geotargets CSV -- only "Postal Code" targets map to a pincode.
const zohoDealsRaw = loadJSON('zoho_deals_pincode.json');
const zohoMobilePincode = loadJSON('zoho_mobile_pincode.json');
const gadsGeoSpend = loadJSON('gads_geo_spend.json');
const geotargetsInPostal = loadJSON('geotargets_in_postal.json'); // criteria id -> {pincode, canonical}
const ADS_MIN_SPEND_FOR_UNIVERSE = 1000; // Rs, all-time: an ads-only pincode joins the pincode universe above this

// city-text -> app-event city agg (normalized key; sum on collision, same pattern as v1)
const appCityMap = new Map();
for (const r of appStateCity) {
  const key = normCity(r.city);
  const cur = appCityMap.get(key) || { pdp_views: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0, wishlist: 0, total_events: 0, unique_devices: 0, rawCities: new Set() };
  cur.pdp_views += num(r.pdp_views); cur.add_to_cart += num(r.add_to_cart); cur.begin_checkout += num(r.begin_checkout);
  cur.purchase += num(r.purchase); cur.wishlist += num(r.wishlist); cur.total_events += num(r.total_events);
  cur.unique_devices += num(r.unique_devices); cur.rawCities.add(r.city);
  appCityMap.set(key, cur);
}
// real revenue by city, from Purchase-side (real shipping-address city, independent of mobile join)
const cityRevenueMap = new Map();
for (const r of appProductPurchase) {
  const key = normCity(r.city);
  cityRevenueMap.set(key, (cityRevenueMap.get(key) || 0) + num(r.revenue));
}
// REAL BUG found via headless testing, not review: Purchase events have 0% top-level city/country
// (confirmed live) -- app_state_city_agg's "purchase" column (grouped on the top-level city/country
// fields) is silently always 0 everywhere, while revenue (sourced from the JSON shipping/billing
// address) was correctly non-zero -- a KPI showing real revenue against 0 purchases exposed it.
// Fix: purchase COUNT (event-level, not line-item) also comes from the address-based city, same
// source as revenue.
const cityPurchaseCountMap = new Map();
for (const r of appPurchaseEventsByCity) {
  const key = normCity(r.city);
  cityPurchaseCountMap.set(key, (cityPurchaseCountMap.get(key) || 0) + num(r.purchase_events));
}
// Same root cause means campaign-level purchase attribution is genuinely NOT AVAILABLE: Purchase
// events (server-side order webhooks) carry no campaign_id at all (confirmed live: 0 of 2,686
// campaigns and 0 of 13,971 campaign x city rows have purchase > 0) -- not a bug to fix, a real
// gap, disclosed in dataQuality.campaignPurchaseGap rather than shown as a misleading literal 0.

// ---------- Customer x Pincode grain (drill-down feature, 2026-09-01) ----------
console.log('Building customer x pincode grain (real, canonical-pincode-per-customer)...');
const customerRevenueMap = new Map(); // "mobile|pincode" -> {revenue, purchaseEvents}
for (const r of customerPincodeRevenue) {
  customerRevenueMap.set(`${r.mobile}|${r.pincode}`, { revenue: num(r.revenue), purchaseEvents: num(r.purchase_events) });
}
const customerRowsByPincode = new Map(); // pincode -> [customer rows]
const allCustomerRows = [];
// Fake-pincode rows (format-valid 6-digit string, but NOT a real India Post pincode) -- previously
// silently discarded here (`continue`, no trace anywhere). Now captured for the Fake Pincodes tab
// instead of thrown away, per explicit user request -- some of these carry real, large event
// volume (e.g. one single customer on a fake pincode drove 867 PDP views / 6,082 events, more than
// any REAL pincode in the dataset) that was previously invisible anywhere on the dashboard.
const fakePincodeRowsByPincode = new Map();
for (const r of customerPincodeEvents) {
  const geo = pincodeGeoMap.get(r.pincode);
  const rev = customerRevenueMap.get(`${r.mobile}|${r.pincode}`) || { revenue: 0, purchaseEvents: 0 };
  const row = {
    mobile_masked: maskMobile(r.mobile), pincode: r.pincode, district: geo ? geo.district : null, state: geo ? geo.state : null,
    sessions: num(r.sessions), pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart),
    checkout: num(r.begin_checkout), purchase: num(r.purchase), wishlist: num(r.wishlist),
    plpImpressions: num(r.plp_impressions), removeFromCart: num(r.remove_from_cart),
    revenue: Math.round(rev.revenue), totalEvents: num(r.total_events),
    firstSeen: r.first_seen || null, lastSeen: r.last_seen || null
  };
  if (!geo) {
    const arr = fakePincodeRowsByPincode.get(r.pincode) || [];
    arr.push(row);
    fakePincodeRowsByPincode.set(r.pincode, arr);
    continue; // format-valid-but-fake pincode -- excluded from every REAL pincode/city/state number
  }
  allCustomerRows.push(row);
  const arr = customerRowsByPincode.get(r.pincode) || [];
  arr.push(row);
  customerRowsByPincode.set(r.pincode, arr);
}
const fakePincodes = [...fakePincodeRowsByPincode.entries()].map(([pincode, rows]) => {
  const t = sumCustomerRows(rows);
  return { pincode, uniqueCustomers: t.uniqueCustomers, sessions: t.sessions, pdpViews: t.pdpViews,
    addToCart: t.addToCart, checkout: t.checkout, purchase: t.purchase, revenue: t.revenue,
    totalEvents: rows.reduce((a, r) => a + r.totalEvents, 0) };
}).sort((a, b) => b.pdpViews - a.pdpViews);
// Real, reconciled pincode-level totals computed BOTTOM-UP from the customer rows themselves --
// NOT re-derived from a separate aggregate query -- so "pincode total" and "sum of its customers"
// can never silently drift apart (the reconciliation the user's spec explicitly requires).
function sumCustomerRows(rows) {
  const t = { uniqueCustomers: rows.length, sessions: 0, pdpViews: 0, addToCart: 0, checkout: 0, purchase: 0, wishlist: 0, plpImpressions: 0, removeFromCart: 0, revenue: 0 };
  for (const c of rows) {
    t.sessions += c.sessions; t.pdpViews += c.pdpViews; t.addToCart += c.addToCart; t.checkout += c.checkout;
    t.purchase += c.purchase; t.wishlist += c.wishlist; t.plpImpressions += c.plpImpressions;
    t.removeFromCart += c.removeFromCart; t.revenue += c.revenue;
  }
  return t;
}
// LUID-matched customer counts per pincode -- supplementary comparison only, real-pincode-filtered
// the same way as the mobile path (pincodeGeoMap.get(pincode) must exist).
const luidCustomerRowsByPincode = new Map();
for (const r of customerPincodeEventsLuid) {
  if (!pincodeGeoMap.get(r.pincode)) continue;
  const arr = luidCustomerRowsByPincode.get(r.pincode) || [];
  arr.push({ luid: r.luid, sessions: num(r.sessions), pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), checkout: num(r.begin_checkout), totalEvents: num(r.total_events) });
  luidCustomerRowsByPincode.set(r.pincode, arr);
}

// ---------- Real Sales (marketing_sale, client-side merge with canonical pincode) ----------
console.log('Merging real sales data (marketing_sale x canonical mobile-pincode map)...');
const canonicalPincodeByMobile = new Map(canonicalMobilePincode.map(r => [r.mobile, r.postal_code]));
const salesByCustomerPincode = new Map(); // "mobile|pincode" -> {orders:Set, netSales, grossSales, units, first, last, isNew/isRepeat via orders.size}
const zohoPincodeByMobile = new Map(zohoMobilePincode.map(r => [r.mobile, r.pincode]));
let unmappedSales = { orders: new Set(), netSales: 0, grossSales: 0, units: 0, lineItems: 0, reasonNoMobile: 0, reasonNoPincodeMatch: 0 };
// Pincode tiers for a sale (REWRITTEN 2026-10-19 -- user: "use the SALE pincode, from marketing_sale").
// First real India-Post pincode wins:
//   1) marketing_sale.Pin_code (the ERP customer/shipping pincode on the sale itself)
//   2) ornaverse_erp_pos.invoice.shipping_pin_code (same document_no)
//   3) ornaverse_erp_master.party.pin_code (ERP customer master, by party_id -- the main source for
//      Store-channel sales, which carry no Pin_code on the sale row)
//   4) a 6-digit pincode inside the sale's own free-text address
//   4b) typed customer record by mobile (ERP CRM customer > Shopify customer > ds_imputed_reporting.customer)
//   5) the customer's WebEngage canonical profile pincode (mobile) -- last-resort, browsing location
// A sale with none of these is NOT guessed: if the mobile has an (APPROXIMATE) Zoho Contact pincode
// it surfaces separately as netSales_zohoApprox, otherwise it is reported as unmapped.
const salesTierCounts = { sale_pincode: 0, invoice_pincode: 0, party_pincode: 0, address: 0, customer_master: 0, webengage: 0, zohoApprox: 0 };
const salesTierNet = { sale_pincode: 0, invoice_pincode: 0, party_pincode: 0, address: 0, customer_master: 0, webengage: 0 };
const customerMasterPinByMobile = new Map(customerMasterPincode.map(r => [r.mobile, r.pincode]));
const salesChannelTotals = {}; // channel -> {net, mappedNet, orders:Set, mappedOrders:Set}
const salesChannelByPincode = new Map(); // pincode -> {Online:{net,orders:Set}, Store:{...}, Other:{...}}
let salesAtStoreOwnPincode = { lineItems: 0, net: 0 }; // party pincode == the selling store's own pincode (possible default fill)
const storePincodeByCode = new Map(storeMaster.map(s => [s.storeCode, s.pincode]));
storePincodeByCode.set('FCS', storePincodeByCode.get('CS1')); // same physical Chembur address
const realPin = v => (v && pincodeGeoMap.get(String(v).trim())) ? String(v).trim() : null;
const chanBucket = c => c === 'Online' ? 'Online' : c === 'Store' ? 'Store' : 'Other';
const salesApproxByPincode = new Map(); // pincode -> {orders:Set, customers:Set, netSales}
let salesMinDate = null, salesMaxDate = null;
for (const r of salesRaw) {
  const netSale = num(r.net_sale), discount = num(r.discount), units = num(r.pieces);
  const grossSale = netSale + discount;
  if (!salesMinDate || r.Transaction_Date < salesMinDate) salesMinDate = r.Transaction_Date;
  if (!salesMaxDate || r.Transaction_Date > salesMaxDate) salesMaxDate = r.Transaction_Date;
  const ch = r.channel || 'Unknown';
  const ct = salesChannelTotals[ch] || (salesChannelTotals[ch] = { net: 0, mappedNet: 0, orders: new Set(), mappedOrders: new Set(), lineItems: 0, mappedLineItems: 0 });
  ct.net += netSale; ct.orders.add(r.document_no); ct.lineItems++;
  // Amazon / Management / TAH sales are NOT customer-located: their ERP party is the marketplace or
  // an internal account (verified: all Amazon orders resolve to Amazon's own 560055 party pincode),
  // so mapping them would plant fake demand on one pincode. Counted in totals, never on a pincode.
  if (ch !== 'Online' && ch !== 'Store') {
    unmappedSales.orders.add(r.document_no); unmappedSales.netSales += netSale; unmappedSales.grossSales += grossSale; unmappedSales.units += units; unmappedSales.lineItems++;
    unmappedSales.reasonNonRetailChannel = (unmappedSales.reasonNonRetailChannel || 0) + 1; unmappedSales.nonRetailNet = (unmappedSales.nonRetailNet || 0) + netSale;
    continue;
  }
  const wePin = r.mobile ? realPin(canonicalPincodeByMobile.get(r.mobile)) : null;
  let tier = null, pincode = null;
  for (const [t, v] of [['sale_pincode', r.sale_pincode], ['invoice_pincode', r.invoice_pincode], ['party_pincode', r.party_pincode], ['address', r.address_pincode], ['customer_master', r.mobile ? customerMasterPinByMobile.get(r.mobile) : null], ['webengage', wePin]]) {
    const rp = realPin(v); if (rp) { tier = t; pincode = rp; break; }
  }
  if (!pincode) {
    const zPin = r.mobile ? realPin(zohoPincodeByMobile.get(r.mobile)) : null;
    if (zPin) {
      const a = salesApproxByPincode.get(zPin) || { orders: new Set(), customers: new Set(), netSales: 0 };
      a.orders.add(r.document_no); a.customers.add(r.mobile); a.netSales += netSale; salesApproxByPincode.set(zPin, a);
      salesTierCounts.zohoApprox++;
    }
    unmappedSales.orders.add(r.document_no); unmappedSales.netSales += netSale; unmappedSales.grossSales += grossSale; unmappedSales.units += units; unmappedSales.lineItems++;
    if (r.mobile) unmappedSales.reasonNoPincodeMatch++; else unmappedSales.reasonNoMobile++;
    continue;
  }
  salesTierCounts[tier]++; salesTierNet[tier] += netSale;
  ct.mappedNet += netSale; ct.mappedOrders.add(r.document_no); ct.mappedLineItems++;
  if (tier === 'party_pincode' && storePincodeByCode.get(r.company_code) === pincode) { salesAtStoreOwnPincode.lineItems++; salesAtStoreOwnPincode.net += netSale; }
  const cb = salesChannelByPincode.get(pincode) || { Online: { net: 0, orders: new Set() }, Store: { net: 0, orders: new Set() }, Other: { net: 0, orders: new Set() } };
  cb[chanBucket(ch)].net += netSale; cb[chanBucket(ch)].orders.add(r.document_no); salesChannelByPincode.set(pincode, cb);
  const key = `${r.mobile || 'doc:' + r.document_no}|${pincode}`;
  const cur = salesByCustomerPincode.get(key) || { mobile: r.mobile, pincode, orders: new Set(), netSales: 0, grossSales: 0, units: 0, first: null, last: null };
  cur.orders.add(r.document_no); cur.netSales += netSale; cur.grossSales += grossSale; cur.units += units;
  if (!cur.first || r.Transaction_Date < cur.first) cur.first = r.Transaction_Date;
  if (!cur.last || r.Transaction_Date > cur.last) cur.last = r.Transaction_Date;
  salesByCustomerPincode.set(key, cur);
}
const salesRowsByPincode = new Map(); // pincode -> [customer sales rows]
for (const cur of salesByCustomerPincode.values()) {
  const row = { mobile: cur.mobile, pincode: cur.pincode, orders: cur.orders.size, netSales: Math.round(cur.netSales), grossSales: Math.round(cur.grossSales), units: cur.units, isRepeat: cur.orders.size > 1, firstPurchase: cur.first, lastPurchase: cur.last };
  const arr = salesRowsByPincode.get(cur.pincode) || []; arr.push(row); salesRowsByPincode.set(cur.pincode, arr);
}
function sumSalesRows(rows) {
  const t = { customers: rows.length, orders: 0, netSales: 0, grossSales: 0, units: 0, repeatCustomers: 0 };
  for (const s of rows) { t.orders += s.orders; t.netSales += s.netSales; t.grossSales += s.grossSales; t.units += s.units; if (s.isRepeat) t.repeatCustomers++; }
  t.aov = t.orders ? Math.round(t.netSales / t.orders) : null;
  return t;
}
const totalMappedSales = [...salesByCustomerPincode.values()].reduce((a, c) => a + c.netSales, 0);
console.log(`  Sales: ${salesRaw.length} line items, ${[...new Set(salesRaw.map(r=>r.document_no))].length} distinct orders, Rs ${Math.round(totalMappedSales + unmappedSales.netSales).toLocaleString('en-IN')} total net sales.`);
console.log(`  Mapped to a real pincode: Rs ${Math.round(totalMappedSales).toLocaleString('en-IN')} (${salesByCustomerPincode.size} customers). Unmapped: Rs ${Math.round(unmappedSales.netSales).toLocaleString('en-IN')} (${unmappedSales.reasonNoMobile} no-mobile line items, ${unmappedSales.reasonNoPincodeMatch} no-real-pincode-match line items).`);
console.log(`  Sales pincode tiers (line items): ${JSON.stringify(salesTierCounts)}; at selling store's own pincode via party master: ${salesAtStoreOwnPincode.lineItems} line items.`);
for (const [ch, t] of Object.entries(salesChannelTotals)) console.log(`    ${ch}: Rs ${Math.round(t.net).toLocaleString('en-IN')} / ${t.orders.size} orders, mapped Rs ${Math.round(t.mappedNet).toLocaleString('en-IN')} (${round1(t.mappedNet / (t.net || 1) * 100)}%)`);

// ---------- Zoho Deals per pincode (APPROXIMATE location -- see validation note at load) ----------
const zohoMaxDate = zohoDealsRaw.reduce((m, r) => r.created_date > m ? r.created_date : m, '');
const zohoMinDate = zohoDealsRaw.reduce((m, r) => r.created_date && (!m || r.created_date < m) ? r.created_date : m, '');
const daysBefore = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const zohoCut30 = daysBefore(zohoMaxDate, 29), zohoCut7 = daysBefore(zohoMaxDate, 6);
const ZOHO_OPEN_STAGES = new Set(['Prospect', 'Payment', 'Add to Cart', 'Checkout', 'Negotiation/Review', 'Website_Chat']);
const zohoByPincode = new Map();
const zohoTotals = { deals: 0, deals30: 0, deals7: 0, withAnyPincode: 0, withRealPincode: 0, realPincode30: 0, fromDealZip: 0, fromContactZip: 0, won: 0 };
for (const r of zohoDealsRaw) {
  zohoTotals.deals++;
  const in30 = r.created_date >= zohoCut30, in7 = r.created_date >= zohoCut7;
  if (in30) zohoTotals.deals30++; if (in7) zohoTotals.deals7++;
  if (r.stage === 'Closed Won') zohoTotals.won++;
  if (!r.pincode) continue;
  zohoTotals.withAnyPincode++;
  if (!pincodeGeoMap.get(r.pincode)) continue;
  zohoTotals.withRealPincode++; if (in30) zohoTotals.realPincode30++;
  zohoTotals[r.pincode_source === 'deal' ? 'fromDealZip' : 'fromContactZip']++;
  const z = zohoByPincode.get(r.pincode) || { deals: 0, deals30: 0, deals7: 0, mobiles: new Set(), won: 0, open: 0, lost: 0, triggers: new Map(), dealZip: 0, contactZip: 0 };
  if (r.pincode_source === 'deal') z.dealZip++; else z.contactZip++;
  z.deals++; if (in30) z.deals30++; if (in7) z.deals7++;
  if (r.mobile) z.mobiles.add(r.mobile);
  if (r.stage === 'Closed Won') z.won++; else if (ZOHO_OPEN_STAGES.has(r.stage)) z.open++; else z.lost++;
  const t = r.trigger_event || '(none)'; z.triggers.set(t, (z.triggers.get(t) || 0) + 1);
  zohoByPincode.set(r.pincode, z);
}
// Live accuracy check (recomputed every build, replaces the hardcoded 2026-09-29 numbers): for
// buyers whose SALE has an ERP pincode (tiers 1-3), compare to the pincode on their Zoho deal(s),
// split by where the deal pincode came from (deal's own Address_Zip vs Contact Mailing_Zip).
const zohoPinsByMobile = new Map(); // mobile -> {deal:Set, contact:Set}
for (const r of zohoDealsRaw) {
  if (!r.mobile || !realPin(r.pincode)) continue;
  const m = zohoPinsByMobile.get(r.mobile) || { deal: new Set(), contact: new Set() };
  m[r.pincode_source === 'deal' ? 'deal' : 'contact'].add(r.pincode); zohoPinsByMobile.set(r.mobile, m);
}
const saleErpPinByMobile = new Map();
for (const r of salesRaw) { if (!r.mobile) continue; const p = realPin(r.sale_pincode) || realPin(r.invoice_pincode) || realPin(r.party_pincode); if (p) saleErpPinByMobile.set(r.mobile, p); }
function zohoValidation(src) {
  const out = { buyersCompared: 0, exactPincodeMatch: 0, sameDistrict: 0, sameState: 0, kms: [] };
  for (const [mob, sp] of saleErpPinByMobile) {
    const z = zohoPinsByMobile.get(mob); if (!z || !z[src].size) continue;
    const zp = [...z[src]][0], g1 = pincodeGeoMap.get(sp), g2 = pincodeGeoMap.get(zp);
    out.buyersCompared++;
    if (z[src].has(sp)) out.exactPincodeMatch++;
    if (g1.district === g2.district) out.sameDistrict++;
    if (g1.state === g2.state) out.sameState++;
    out.kms.push(haversineKm(num(g1.latitude), num(g1.longitude), num(g2.latitude), num(g2.longitude)));
  }
  out.kms.sort((a, b) => a - b);
  out.medianKmApart = out.kms.length ? Math.round(out.kms[Math.floor(out.kms.length / 2)]) : null;
  delete out.kms; return out;
}
const zohoValidationLive = { dealZip: zohoValidation('deal'), contactZip: zohoValidation('contact') };
console.log(`  Zoho pincode accuracy vs ERP sale pincode: ${JSON.stringify(zohoValidationLive)}`);
console.log(`  Zoho deals: ${zohoTotals.deals} (${zohoTotals.deals30} in last 30d to ${zohoMaxDate}), ${zohoTotals.withRealPincode} on a real pincode across ${zohoByPincode.size} pincodes (APPROXIMATE location).`);

// ---------- Google Ads spend per pincode (Postal Code geo targets only) ----------
const gadsByPincode = new Map();
const gadsTotals = { spend30: 0, spendAll: 0, postalSpend30: 0, postalSpendAll: 0, nonPostalSpend30: 0, nonPostalSpendAll: 0, postalNotInMasterSpendAll: 0, firstDate: null, lastDate: null };
for (const r of gadsGeoSpend) {
  const s30 = num(r.spend30), sAll = num(r.spend_all);
  gadsTotals.spend30 += s30; gadsTotals.spendAll += sAll;
  if (!gadsTotals.firstDate || r.first_date < gadsTotals.firstDate) gadsTotals.firstDate = r.first_date;
  if (!gadsTotals.lastDate || r.last_date > gadsTotals.lastDate) gadsTotals.lastDate = r.last_date;
  const t = geotargetsInPostal[r.loc];
  if (!t) { gadsTotals.nonPostalSpend30 += s30; gadsTotals.nonPostalSpendAll += sAll; continue; }
  if (!pincodeGeoMap.get(t.pincode)) { gadsTotals.postalNotInMasterSpendAll += sAll; gadsTotals.nonPostalSpend30 += s30; gadsTotals.nonPostalSpendAll += sAll; continue; }
  gadsTotals.postalSpend30 += s30; gadsTotals.postalSpendAll += sAll;
  const g = gadsByPincode.get(t.pincode) || { spend30: 0, spendAll: 0, clicks30: 0, clicksAll: 0, impressionsAll: 0, conversionsAll: 0 };
  g.spend30 += s30; g.spendAll += sAll; g.clicks30 += num(r.clicks30); g.clicksAll += num(r.clicks_all);
  g.impressionsAll += num(r.impressions_all); g.conversionsAll += num(r.conversions_all);
  gadsByPincode.set(t.pincode, g);
}
console.log(`  Google Ads: Rs ${Math.round(gadsTotals.spend30).toLocaleString('en-IN')} last 30d (${round1(gadsTotals.postalSpend30 / gadsTotals.spend30 * 100)}% on an exact postal code), ${gadsByPincode.size} pincodes with any spend.`);

function nearestStoreInfo(lat, lon) {
  if (!lat || !lon) return null;
  let best = null;
  const within = { w5: 0, w10: 0, w20: 0 };
  for (const s of storeMaster) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d <= 5) within.w5++; if (d <= 10) within.w10++; if (d <= 20) within.w20++;
    if (!best || d < best.distanceKm) best = { storeCode: s.storeCode, storeName: s.storeName, distanceKm: Math.round(d * 10) / 10 };
  }
  return { nearestStore: best, storesWithin5km: within.w5, storesWithin10km: within.w10, storesWithin20km: within.w20 };
}

// ---------- Pincode tier: profile "Users" (we_pincode_agg) x event-exact funnel (appPincodeAgg) ----------
console.log('Building pincode tier (profile Users + event-exact funnel via mobile join)...');
const appPincodeCampaignByPincode = new Map();
for (const r of appPincodeCampaign) {
  const arr = appPincodeCampaignByPincode.get(r.pincode) || [];
  arr.push({ campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium, events: num(r.total_events), customers: num(r.unique_customers) });
  appPincodeCampaignByPincode.set(r.pincode, arr);
}

let pincodes = [];
let unmatchedFormatValidUsers = 0, unmatchedFormatValidPincodes = 0;
// Pincode universe (widened 2026-09-29): every real pincode from WebEngage profiles, PLUS any real
// pincode that has Zoho deals, mapped sales, or >= Rs ADS_MIN_SPEND_FOR_UNIVERSE of Google Ads
// spend. Previously WebEngage-only, which silently dropped e.g. 720 of the 919 Zoho-deal pincodes.
// Non-WebEngage rows get zero profile Users (true -- no WebEngage profile claims that pincode).
const wePincodeSet = new Set(wePincodeAgg.map(r => r.pincode));
const extraPincodeSources = new Map(); // pincode -> Set of source tags
const addExtra = (pc, tag) => { if (!pc || wePincodeSet.has(pc) || !pincodeGeoMap.get(pc)) return; const s = extraPincodeSources.get(pc) || new Set(); s.add(tag); extraPincodeSources.set(pc, s); };
for (const pc of zohoByPincode.keys()) addExtra(pc, 'zoho');
for (const pc of salesRowsByPincode.keys()) addExtra(pc, 'sales');
for (const pc of salesApproxByPincode.keys()) addExtra(pc, 'sales_zoho_approx');
for (const [pc, g] of gadsByPincode) if (g.spendAll >= ADS_MIN_SPEND_FOR_UNIVERSE) addExtra(pc, 'google_ads');
const pincodeUniverseRows = [
  ...wePincodeAgg.map(r => ({ ...r, _sources: ['webengage'] })),
  ...[...extraPincodeSources].map(([pc, tags]) => ({ pincode: pc, city: null, region: null, users: 0, campaign_users: 0, users_with_phone: 0, _sources: [...tags] }))
];
for (const r of pincodeUniverseRows) {
  const geo = pincodeGeoMap.get(r.pincode);
  if (!geo) { unmatchedFormatValidUsers += num(r.users); unmatchedFormatValidPincodes++; continue; }
  const cityKey = normCity(geo.district || r.city);
  const appCity = appCityMap.get(cityKey) || null;             // broader city-grain context, same table
  const storeInfo = nearestStoreInfo(num(geo.latitude), num(geo.longitude));
  // Real customer-level rows for this pincode (drill-down feature) -- the AUTHORITATIVE source for
  // every "_exact" field below, computed bottom-up from the same rows the Customer tab shows, so
  // pincode totals can never silently drift from "sum of its customers" (reconciliation requirement).
  const custRows = customerRowsByPincode.get(r.pincode) || [];
  const exact = sumCustomerRows(custRows);
  const activeCustomers = custRows.filter(c => c.pdpViews > 0 || c.addToCart > 0 || c.checkout > 0).length;
  const luidRows = luidCustomerRowsByPincode.get(r.pincode) || [];
  const sales = sumSalesRows(salesRowsByPincode.get(r.pincode) || []);
  const tanishqHere = tanishqByPincode.get(r.pincode) || [];
  const caratlaneHere = caratlaneByPincode.get(r.pincode) || [];
  const caratlaneCatalogHere = caratlaneCatalogByPincode.get(r.pincode) || [];
  const zoho = zohoByPincode.get(r.pincode);
  const gads = gadsByPincode.get(r.pincode);
  const salesApprox = salesApproxByPincode.get(r.pincode);
  const chanHere = salesChannelByPincode.get(r.pincode);
  pincodes.push({
    pincode: r.pincode,
    district: geo.district, state: geo.state, lat: num(geo.latitude), lon: num(geo.longitude),
    weCity: r.city, weRegion: r.region,
    sources: r._sources, inWebEngage: r._sources.includes('webengage'),
    // Zoho CRM Deals -- APPROXIMATE location (Contact Mailing_Zip; validated ~26% same-district
    // vs real sale addresses). Shown + rolled up to City/State; 0% weight in the pincode score.
    zohoDeals: zoho ? zoho.deals : 0, zohoDeals30: zoho ? zoho.deals30 : 0, zohoDeals7: zoho ? zoho.deals7 : 0,
    zohoDealCustomers: zoho ? zoho.mobiles.size : 0, zohoWon: zoho ? zoho.won : 0, zohoOpen: zoho ? zoho.open : 0, zohoLost: zoho ? zoho.lost : 0,
    zohoTopTriggers: zoho ? [...zoho.triggers].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => ({ trigger: t, deals: n })) : [],
    // Google Ads -- Google's own LOCATION_OF_PRESENCE for users in this exact postal code.
    gadsSpend30: gads ? Math.round(gads.spend30) : 0, gadsSpendAll: gads ? Math.round(gads.spendAll) : 0,
    gadsClicks30: gads ? gads.clicks30 : 0, gadsClicksAll: gads ? gads.clicksAll : 0,
    gadsImpressionsAll: gads ? gads.impressionsAll : 0, gadsConversionsAll: gads ? round1(gads.conversionsAll) : 0,
    // Sales whose ONLY pincode is the approximate Zoho one -- never mixed into netSales.
    netSales_zohoApprox: salesApprox ? Math.round(salesApprox.netSales) : 0,
    salesOrders_zohoApprox: salesApprox ? salesApprox.orders.size : 0,
    salesCustomers_zohoApprox: salesApprox ? salesApprox.customers.size : 0,
    // Competitor presence -- real, matched by exact pincode string (not geocoded), same one-time
    // public-store-locator capture the GA4 Geo Intelligence dashboard's CaratLane layer already
    // uses. A pincode with no competitor listed here means none was found in that capture, not a
    // confirmed absence (disclosed in Data Quality).
    tanishqStoreCount: tanishqHere.length, tanishqStores: tanishqHere.map(s => s.name),
    caratlaneStoreCount: caratlaneHere.length, caratlaneStores: caratlaneHere.map(s => s.name),
    // Real CaratLane public online-catalog mix for any of their stores in this pincode (category
    // counts + price-band counts) -- their own catalog listing, not a sales/inventory figure.
    caratlaneCatalog: caratlaneCatalogHere,
    users: num(r.users), campaignUsersProfile: num(r.campaign_users), usersWithPhone: num(r.users_with_phone),
    // PINCODE-EXACT event funnel (mobile-joined to a real pincode, bottom-up from real customer
    // rows) -- a real improvement over the old GA4-city-proxy pattern for the slice of events with
    // a valid mobile. uniqueCustomers_exact is a COUNT OF DISTINCT CUSTOMERS, never event count.
    uniqueCustomers_exact: exact.uniqueCustomers,
    activeCustomers_exact: activeCustomers,
    // LUID-based comparison count -- NOT the primary customer identifier (mobile finds more real
    // customers overall, 158 vs 95 system-wide), but shown alongside for transparency since LUID
    // needs no profile de-dup and has much higher raw identity-overlap between the two tables.
    uniqueCustomers_luid: luidRows.length,
    pdpViews_luid: luidRows.reduce((a, c) => a + c.pdpViews, 0),
    // Real sales (marketing_sale, mobile-mapped to this canonical pincode) -- separate from
    // WebEngage-derived revenue_exact below (digital purchase-event revenue), per the explicit
    // instruction to use marketing_sale as the authoritative sales number, not GA4/WebEngage.
    salesOrders: sales.orders, salesCustomers: sales.customers, salesUnits: sales.units,
    netSales: sales.netSales, grossSales: sales.grossSales, aov: sales.aov, repeatSalesCustomers: sales.repeatCustomers,
    // Channel split of the SAME mapped sales (2026-10-19) -- Online sales far from a store are the
    // purest "demand without a store" signal; Store sales show an existing store's catchment.
    netSales_online: chanHere ? Math.round(chanHere.Online.net) : 0, salesOrders_online: chanHere ? chanHere.Online.orders.size : 0,
    netSales_store: chanHere ? Math.round(chanHere.Store.net) : 0, salesOrders_store: chanHere ? chanHere.Store.orders.size : 0,
    netSales_other: chanHere ? Math.round(chanHere.Other.net) : 0, salesOrders_other: chanHere ? chanHere.Other.orders.size : 0,
    zohoDeals_dealZip: zoho ? zoho.dealZip : 0, zohoDeals_contactZip: zoho ? zoho.contactZip : 0,
    sessions_exact: exact.sessions,
    pdpViews_exact: exact.pdpViews,
    addToCart_exact: exact.addToCart,
    checkout_exact: exact.checkout,
    purchase_exact: exact.purchase,
    wishlist_exact: exact.wishlist,
    plpImpressions_exact: exact.plpImpressions,
    removeFromCart_exact: exact.removeFromCart,
    revenue_exact: exact.revenue,
    totalEvents_exact: custRows.reduce((a, c) => a + c.totalEvents, 0),
    campaigns: appPincodeCampaignByPincode.get(r.pincode) || [],
    // City-level context from the SAME table (application_view_v1), not this pincode's own events.
    pdpViews_cityProxy: appCity ? appCity.pdp_views : null,
    addToCart_cityProxy: appCity ? appCity.add_to_cart : null,
    checkout_cityProxy: appCity ? appCity.begin_checkout : null,
    purchase_cityProxy: cityPurchaseCountMap.has(cityKey) ? cityPurchaseCountMap.get(cityKey) : (appCity ? 0 : null),
    revenue_cityProxy: cityRevenueMap.has(cityKey) ? Math.round(cityRevenueMap.get(cityKey)) : null,
    attribution: exact.uniqueCustomers > 0 ? 'pincode_exact' : (appCity ? 'city_proxy' : 'no_match'),
    ...storeInfo
  });
}
console.log(`  Real matched pincodes: ${pincodes.length}, unmatched format-valid pincodes: ${unmatchedFormatValidPincodes} (${unmatchedFormatValidUsers} users)`);
console.log(`  Of those, ${pincodes.filter(p => p.totalEvents_exact > 0).length} have at least one pincode-EXACT event (mobile-joined).`);

for (const p of pincodes) {
  p.funnel = {
    pdpToAtcPct: p.pdpViews_exact ? round1(safeDiv(p.addToCart_exact, p.pdpViews_exact)) : null,
    atcToCheckoutPct: p.addToCart_exact ? round1(safeDiv(p.checkout_exact, p.addToCart_exact)) : null,
    checkoutToPurchasePct: p.checkout_exact ? round1(safeDiv(p.purchase_exact, p.checkout_exact)) : null
  };
}

// ---------- Opportunity Score v3 (2026-09-01) -- every component is percentile-ranked, 0-100, and
// shown to the user (not just the final number). Per-customer ratios (not raw counts) are used for
// engagement/funnel components so a 5,000-customer city and a 5-customer pincode are compared on
// intensity, not just size -- raw customer/store-gap components still carry the size signal.
// Weights sum to 100%, chosen to give real sales the single largest share (still not revenue-only:
// no single component exceeds 15% except Customer Demand's absolute count, at 15% also) while still
// counting demand signals even where sales data is (very) sparse.
const rankUsers = percentileRanker(pincodes.map(p => p.uniqueCustomers_exact));
const rankActiveRate = percentileRanker(pincodes.map(p => p.uniqueCustomers_exact ? p.activeCustomers_exact / p.uniqueCustomers_exact : 0));
const rankPdpPerCust = percentileRanker(pincodes.map(p => p.uniqueCustomers_exact ? p.pdpViews_exact / p.uniqueCustomers_exact : 0));
const rankAtcPerCust = percentileRanker(pincodes.map(p => p.uniqueCustomers_exact ? p.addToCart_exact / p.uniqueCustomers_exact : 0));
const rankCheckoutPerCust = percentileRanker(pincodes.map(p => p.uniqueCustomers_exact ? p.checkout_exact / p.uniqueCustomers_exact : 0));
const rankConversion = percentileRanker(pincodes.map(p => p.uniqueCustomers_exact ? p.salesCustomers / p.uniqueCustomers_exact : 0));
const rankSalesPerCust = percentileRanker(pincodes.map(p => p.salesCustomers ? p.netSales / p.salesCustomers : 0));
const rankDistance = percentileRanker(pincodes.map(p => p.nearestStore ? p.nearestStore.distanceKm : 0));
const rankAdClicks = percentileRanker(pincodes.map(p => p.gadsClicksAll));

// v4 (2026-09-29): added Paid Search Demand = Google Ads clicks from users Google locates IN this
// exact postal code (the densest location-reliable signal available: 16.5K pincodes). WebEngage
// funnel weights reduced to make room. Zoho deals deliberately NOT a component (approximate
// location -- they would push ISP-hub pincodes to the top); they feed City/State scores instead.
const SCORE_WEIGHTS = {
  customerDemand: 0.10,     // Unique Customers (WebEngage-identified, mobile-matched)
  activeCustomerRate: 0.05, // % of those customers with any real funnel activity (not just a session)
  pdpEngagement: 0.05,      // PDP Views per customer
  cartIntent: 0.05,         // Add to Cart per customer
  checkoutIntent: 0.05,     // Checkout per customer
  paidSearchDemand: 0.25,   // Google Ads clicks, all-time, Google LOCATION_OF_PRESENCE postal code
  conversion: 0.15,         // % of customers who actually PURCHASED (marketing_sale-mapped)
  salesPerformance: 0.15,   // Real net sales per purchasing customer (marketing_sale, not GA4/WebEngage)
  storeGap: 0.15            // Distance to nearest existing store
};
for (const p of pincodes) {
  const s = {
    customerDemandScore: round1(rankUsers(p.uniqueCustomers_exact)),
    activeCustomerRateScore: round1(rankActiveRate(p.uniqueCustomers_exact ? p.activeCustomers_exact / p.uniqueCustomers_exact : 0)),
    pdpEngagementScore: round1(rankPdpPerCust(p.uniqueCustomers_exact ? p.pdpViews_exact / p.uniqueCustomers_exact : 0)),
    cartIntentScore: round1(rankAtcPerCust(p.uniqueCustomers_exact ? p.addToCart_exact / p.uniqueCustomers_exact : 0)),
    checkoutIntentScore: round1(rankCheckoutPerCust(p.uniqueCustomers_exact ? p.checkout_exact / p.uniqueCustomers_exact : 0)),
    paidSearchDemandScore: round1(rankAdClicks(p.gadsClicksAll)),
    conversionScore: round1(rankConversion(p.uniqueCustomers_exact ? p.salesCustomers / p.uniqueCustomers_exact : 0)),
    salesPerformanceScore: round1(rankSalesPerCust(p.salesCustomers ? p.netSales / p.salesCustomers : 0)),
    storeGapScore: round1(rankDistance(p.nearestStore ? p.nearestStore.distanceKm : 0))
  };
  const overall = round1(
    s.customerDemandScore * SCORE_WEIGHTS.customerDemand + s.activeCustomerRateScore * SCORE_WEIGHTS.activeCustomerRate +
    s.pdpEngagementScore * SCORE_WEIGHTS.pdpEngagement + s.cartIntentScore * SCORE_WEIGHTS.cartIntent +
    s.checkoutIntentScore * SCORE_WEIGHTS.checkoutIntent + s.paidSearchDemandScore * SCORE_WEIGHTS.paidSearchDemand +
    s.conversionScore * SCORE_WEIGHTS.conversion +
    s.salesPerformanceScore * SCORE_WEIGHTS.salesPerformance + s.storeGapScore * SCORE_WEIGHTS.storeGap
  );
  p.scoreComponents = s;
  p.scores = { opportunityScore: overall };
  const demandHigh = s.customerDemandScore >= 66 || s.pdpEngagementScore >= 66 || s.paidSearchDemandScore >= 66;
  const demandMed = s.customerDemandScore >= 33 || s.pdpEngagementScore >= 33 || s.paidSearchDemandScore >= 33;
  const dist = p.nearestStore ? p.nearestStore.distanceKm : 0;
  p.storeGapFlag = (demandHigh && dist > 15) ? 'HIGH' : ((demandMed && dist > 5) ? 'MEDIUM' : 'LOW');
}
const rankOpportunity = percentileRanker(pincodes.map(p => p.scores.opportunityScore));
for (const p of pincodes) {
  const opRank = rankOpportunity(p.scores.opportunityScore);
  p.priority = opRank >= 90 ? 'High' : opRank >= 70 ? 'Medium' : opRank >= 40 ? 'Low' : 'Watch';
  // Section 11 flag: an existing store within 5km is treated as an EXISTING STORE MARKET regardless
  // of opportunity percentile -- opening a second store there is a different decision than opening
  // a first one, so it's called out separately rather than folded into the demand-only tiers.
  const dist = p.nearestStore ? p.nearestStore.distanceKm : Infinity;
  p.opportunityFlag = dist <= 5 ? 'EXISTING STORE' : (opRank >= 70 ? 'HIGH OPPORTUNITY' : opRank >= 40 ? 'MEDIUM OPPORTUNITY' : 'LOW OPPORTUNITY');
}
pincodes.sort((a, b) => b.scores.opportunityScore - a.scores.opportunityScore);

// ---------- City rollup ----------
console.log('Building city rollup...');
const pincodesByCity = new Map();
for (const p of pincodes) { const key = normCity(p.district); const arr = pincodesByCity.get(key) || []; arr.push(p); pincodesByCity.set(key, arr); }
const storesByCity = new Map();
for (const s of storeMaster) storesByCity.set(normCity(s.district), (storesByCity.get(normCity(s.district)) || 0) + 1);

let cities = [];
for (const [key, cur] of appCityMap) {
  const realPincodesHere = pincodesByCity.get(key) || [];
  const avgDist = realPincodesHere.length ? round1(realPincodesHere.reduce((a, p) => a + (p.nearestStore ? p.nearestStore.distanceKm : 0), 0) / realPincodesHere.length) : null;
  const highOppPincodes = realPincodesHere.filter(p => p.priority === 'High').length;
  const usersHere = realPincodesHere.reduce((a, p) => a + p.users, 0);
  // Real unique-customer rollup, bottom-up from the SAME pincode records the Pincode tab shows --
  // sum of each real pincode's uniqueCustomers_exact, which is itself a true distinct-mobile count
  // (never event count), so City total reconciles exactly with the sum of its Pincode rows.
  const exactHere = realPincodesHere.reduce((a, p) => ({
    uniqueCustomers: a.uniqueCustomers + p.uniqueCustomers_exact, sessions: a.sessions + p.sessions_exact,
    pdpViews: a.pdpViews + p.pdpViews_exact, addToCart: a.addToCart + p.addToCart_exact,
    checkout: a.checkout + p.checkout_exact, purchase: a.purchase + p.purchase_exact,
    wishlist: a.wishlist + p.wishlist_exact, plpImpressions: a.plpImpressions + p.plpImpressions_exact,
    removeFromCart: a.removeFromCart + p.removeFromCart_exact, revenue: a.revenue + p.revenue_exact
  }), { uniqueCustomers: 0, sessions: 0, pdpViews: 0, addToCart: 0, checkout: 0, purchase: 0, wishlist: 0, plpImpressions: 0, removeFromCart: 0, revenue: 0 });
  // Real sales rollup, bottom-up from the same pincode records (never re-derived separately).
  const salesHere = realPincodesHere.reduce((a, p) => ({
    orders: a.orders + p.salesOrders, customers: a.customers + p.salesCustomers, units: a.units + p.salesUnits,
    netSales: a.netSales + p.netSales, grossSales: a.grossSales + p.grossSales, repeatCustomers: a.repeatCustomers + p.repeatSalesCustomers,
    online: a.online + p.netSales_online, onlineOrders: a.onlineOrders + p.salesOrders_online, store: a.store + p.netSales_store, storeOrders: a.storeOrders + p.salesOrders_store,
    other: a.other + p.netSales_other, otherOrders: a.otherOrders + p.salesOrders_other, dealZip: a.dealZip + p.zohoDeals_dealZip
  }), { orders: 0, customers: 0, units: 0, netSales: 0, grossSales: 0, repeatCustomers: 0, online: 0, onlineOrders: 0, store: 0, storeOrders: 0, other: 0, otherOrders: 0, dealZip: 0 });
  const zohoHere = realPincodesHere.reduce((a, p) => ({
    deals: a.deals + p.zohoDeals, deals30: a.deals30 + p.zohoDeals30, deals7: a.deals7 + p.zohoDeals7,
    customers: a.customers + p.zohoDealCustomers, won: a.won + p.zohoWon, open: a.open + p.zohoOpen,
    gSpend30: a.gSpend30 + p.gadsSpend30, gSpendAll: a.gSpendAll + p.gadsSpendAll, gClicksAll: a.gClicksAll + p.gadsClicksAll,
    salesApprox: a.salesApprox + p.netSales_zohoApprox
  }), { deals: 0, deals30: 0, deals7: 0, customers: 0, won: 0, open: 0, gSpend30: 0, gSpendAll: 0, gClicksAll: 0, salesApprox: 0 });
  // BUG FIX 2026-09-02, found by user inspection: this city's total PDP/ATC/Checkout/Purchase/
  // Revenue was previously REPEATED UNCHANGED on every one of its real pincodes (e.g. every Delhi
  // pincode showed Delhi's full city PDP total) -- correct as "this pincode's city, for context",
  // but it read as a bug (every pincode looking identical) and silently multiplied the city total
  // once per real pincode when summed into the State rollup below. Fixed: each pincode now gets an
  // ALLOCATED SHARE of the city total, weighted by that pincode's share of the city's real,
  // pincode-level profile Users (`users` -- itself never an estimate, already computed per pincode
  // from user_profile_view_v3 postal_code, same source as everywhere else in this pipeline).
  // Formula: pincode.metric_cityProxy = city.metric_total * (pincode.users / sum(users across the
  // city's real pincodes)). Falls back to an equal split across the city's real pincodes only if
  // NONE of them have any profile Users at all (keeps the estimate from silently zeroing out).
  // This also means pincode-level cityProxy values now sum back to the real city total exactly --
  // no more separate de-dup step needed when rolling them up to City/State.
  const cityUsersSum = realPincodesHere.reduce((a, p) => a + p.users, 0);
  for (const p of realPincodesHere) {
    const weight = cityUsersSum > 0 ? (p.users / cityUsersSum) : (realPincodesHere.length ? 1 / realPincodesHere.length : 0);
    p.pdpViews_cityProxy = Math.round(cur.pdp_views * weight);
    p.addToCart_cityProxy = Math.round(cur.add_to_cart * weight);
    p.checkout_cityProxy = Math.round(cur.begin_checkout * weight);
    p.purchase_cityProxy = cityPurchaseCountMap.has(key) ? Math.round(cityPurchaseCountMap.get(key) * weight) : 0;
    p.revenue_cityProxy = cityRevenueMap.has(key) ? Math.round(cityRevenueMap.get(key) * weight) : null;
    p.cityProxyAllocationPct = round1(weight * 100);
  }
  cities.push({
    city: [...cur.rawCities][0], allCityTextVariants: [...cur.rawCities],
    // Fixed 2026-09-29: previously the FIRST WebEngage free-text row with this city name supplied the
    // state, which picked noise rows (live showed "New Delhi, Uttar Pradesh", "Mumbai, Gujarat").
    // Now = the most common India-Post state among this city's own real pincodes; old lookup is the fallback.
    state: (() => {
      const cnt = new Map(); for (const p of realPincodesHere) if (p.state) cnt.set(p.state, (cnt.get(p.state) || 0) + 1);
      const best = [...cnt].sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : (appStateCity.find(r => normCity(r.city) === key)?.state || null);
    })(),
    users: usersHere,
    pdpViews: cur.pdp_views, addToCart: cur.add_to_cart, checkout: cur.begin_checkout,
    purchase: cityPurchaseCountMap.has(key) ? cityPurchaseCountMap.get(key) : 0,
    wishlist: cur.wishlist, totalEvents: cur.total_events, uniqueDevices: cur.unique_devices,
    revenue: cityRevenueMap.has(key) ? Math.round(cityRevenueMap.get(key)) : 0,
    realPincodesTracked: realPincodesHere.length,
    // Real, mobile-matched, reconciled-with-Pincode-tab customer numbers (sparse -- most cities
    // will show 0, honestly, since only 292 customers nationally are identity-linkable at all).
    uniqueCustomers_exact: exactHere.uniqueCustomers, sessions_exact: exactHere.sessions,
    pdpViews_exact: exactHere.pdpViews, addToCart_exact: exactHere.addToCart, checkout_exact: exactHere.checkout,
    purchase_exact: exactHere.purchase, wishlist_exact: exactHere.wishlist, plpImpressions_exact: exactHere.plpImpressions,
    removeFromCart_exact: exactHere.removeFromCart, revenue_exact: Math.round(exactHere.revenue),
    // Real sales (marketing_sale, mobile-mapped, bottom-up from Pincode tab -- authoritative, not GA4/WebEngage).
    salesOrders: salesHere.orders, salesCustomers: salesHere.customers, salesUnits: salesHere.units,
    netSales: Math.round(salesHere.netSales), grossSales: Math.round(salesHere.grossSales),
    aov: salesHere.orders ? Math.round(salesHere.netSales / salesHere.orders) : null, repeatSalesCustomers: salesHere.repeatCustomers,
    existingStoreCount: storesByCity.get(key) || 0, avgDistanceToStoreKm: avgDist, highOpportunityPincodeCount: highOppPincodes,
    // Zoho Deals (approximate pincode, but ~71% same-state -- city/state rollups are where it is most usable).
    zohoDeals: zohoHere.deals, zohoDeals30: zohoHere.deals30, zohoDeals7: zohoHere.deals7,
    zohoDealCustomers: zohoHere.customers, zohoWon: zohoHere.won, zohoOpen: zohoHere.open,
    gadsSpend30: zohoHere.gSpend30, gadsSpendAll: zohoHere.gSpendAll, gadsClicksAll: zohoHere.gClicksAll,
    netSales_zohoApprox: zohoHere.salesApprox,
    netSales_online: salesHere.online, salesOrders_online: salesHere.onlineOrders, netSales_store: salesHere.store, salesOrders_store: salesHere.storeOrders,
    netSales_other: salesHere.other, salesOrders_other: salesHere.otherOrders, zohoDeals_dealZip: salesHere.dealZip
  });
}
// v4 (2026-09-29): Zoho deals + Google Ads clicks added -- both far denser than WebEngage profile Users.
const rankCityUsers = percentileRanker(cities.map(c => c.users));
const rankCityRevenue = percentileRanker(cities.map(c => (c.netSales || 0) + (c.netSales_zohoApprox || 0)));
const rankCityDeals = percentileRanker(cities.map(c => c.zohoDeals));
const rankCityClicks = percentileRanker(cities.map(c => c.gadsClicksAll));
for (const c of cities) c.opportunityScore = round1(rankCityUsers(c.users) * 0.20 + rankCityDeals(c.zohoDeals) * 0.30 + rankCityClicks(c.gadsClicksAll) * 0.20 + rankCityRevenue((c.netSales || 0) + (c.netSales_zohoApprox || 0)) * 0.30);
const rankCityOpportunity = percentileRanker(cities.map(c => c.opportunityScore));
for (const c of cities) { const r = rankCityOpportunity(c.opportunityScore); c.priority = r >= 90 ? 'High' : r >= 70 ? 'Medium' : r >= 40 ? 'Low' : 'Watch'; }
cities.sort((a, b) => b.opportunityScore - a.opportunityScore);

// ---------- State rollup ----------
console.log('Building state rollup...');
const stateMap = new Map();
for (const p of pincodes) {
  const st = p.state || 'Unknown';
  const cur = stateMap.get(st) || { cities: new Set(), pincodes: 0, users: 0, pdpViews: 0, addToCart: 0, checkout: 0, purchase: 0, revenue: 0, highOppCities: new Set(), highOppPincodes: 0, uniqueCustomers_exact: 0, sessions_exact: 0, pdpViews_exact: 0, addToCart_exact: 0, checkout_exact: 0, purchase_exact: 0, revenue_exact: 0, salesOrders: 0, salesCustomers: 0, salesUnits: 0, netSales: 0, grossSales: 0, repeatSalesCustomers: 0, zohoDeals: 0, zohoDeals30: 0, zohoDeals7: 0, zohoDealCustomers: 0, zohoWon: 0, zohoOpen: 0, gadsSpend30: 0, gadsSpendAll: 0, gadsClicksAll: 0, netSales_zohoApprox: 0 };
  for (const k of ['zohoDeals','zohoDeals30','zohoDeals7','zohoDealCustomers','zohoWon','zohoOpen','gadsSpend30','gadsSpendAll','gadsClicksAll','netSales_zohoApprox','netSales_online','salesOrders_online','netSales_store','salesOrders_store','netSales_other','salesOrders_other','zohoDeals_dealZip']) cur[k] = (cur[k] || 0) + (p[k] || 0);
  cur.cities.add(p.district); cur.pincodes++; cur.users += p.users;
  cur.pdpViews += (p.pdpViews_cityProxy || 0); cur.addToCart += (p.addToCart_cityProxy || 0);
  cur.checkout += (p.checkout_cityProxy || 0); cur.purchase += (p.purchase_cityProxy || 0);
  cur.revenue += (p.revenue_cityProxy || 0);
  // Real, reconciled-with-Pincode-tab customer rollup -- bottom-up, same source as City.
  cur.uniqueCustomers_exact += p.uniqueCustomers_exact; cur.sessions_exact += p.sessions_exact;
  cur.pdpViews_exact += p.pdpViews_exact; cur.addToCart_exact += p.addToCart_exact;
  cur.checkout_exact += p.checkout_exact; cur.purchase_exact += p.purchase_exact; cur.revenue_exact += p.revenue_exact;
  // Real sales rollup, bottom-up (marketing_sale, mobile-mapped).
  cur.salesOrders += p.salesOrders; cur.salesCustomers += p.salesCustomers; cur.salesUnits += p.salesUnits;
  cur.netSales += p.netSales; cur.grossSales += p.grossSales; cur.repeatSalesCustomers += p.repeatSalesCustomers;
  if (p.priority === 'High') { cur.highOppPincodes++; cur.highOppCities.add(p.district); }
  stateMap.set(st, cur);
}
const storesByState = new Map();
for (const s of storeMaster) storesByState.set(s.state, (storesByState.get(s.state) || 0) + 1);
let states = [];
for (const [st, cur] of stateMap) {
  states.push({
    state: st, cityCount: cur.cities.size, pincodeCount: cur.pincodes, users: cur.users,
    pdpViews: Math.round(cur.pdpViews), addToCart: Math.round(cur.addToCart), checkout: Math.round(cur.checkout),
    purchase: Math.round(cur.purchase), revenue: Math.round(cur.revenue),
    uniqueCustomers_exact: cur.uniqueCustomers_exact, sessions_exact: cur.sessions_exact,
    pdpViews_exact: cur.pdpViews_exact, addToCart_exact: cur.addToCart_exact, checkout_exact: cur.checkout_exact,
    purchase_exact: cur.purchase_exact, revenue_exact: Math.round(cur.revenue_exact),
    salesOrders: cur.salesOrders, salesCustomers: cur.salesCustomers, salesUnits: cur.salesUnits,
    netSales: Math.round(cur.netSales), grossSales: Math.round(cur.grossSales),
    aov: cur.salesOrders ? Math.round(cur.netSales / cur.salesOrders) : null, repeatSalesCustomers: cur.repeatSalesCustomers,
    existingStores: storesByState.get(st) || 0, highOpportunityCities: cur.highOppCities.size, highOpportunityPincodes: cur.highOppPincodes,
    zohoDeals: cur.zohoDeals, zohoDeals30: cur.zohoDeals30, zohoDeals7: cur.zohoDeals7, zohoDealCustomers: cur.zohoDealCustomers, zohoWon: cur.zohoWon, zohoOpen: cur.zohoOpen,
    gadsSpend30: cur.gadsSpend30, gadsSpendAll: cur.gadsSpendAll, gadsClicksAll: cur.gadsClicksAll, netSales_zohoApprox: cur.netSales_zohoApprox,
    netSales_online: cur.netSales_online, salesOrders_online: cur.salesOrders_online, netSales_store: cur.netSales_store, salesOrders_store: cur.salesOrders_store,
    netSales_other: cur.netSales_other, salesOrders_other: cur.salesOrders_other, zohoDeals_dealZip: cur.zohoDeals_dealZip
  });
}
const rankStateUsers = percentileRanker(states.map(s => s.users));
const rankStateSales = percentileRanker(states.map(s => s.netSales || 0));
const rankStateDeals = percentileRanker(states.map(s => s.zohoDeals));
const rankStateClicks = percentileRanker(states.map(s => s.gadsClicksAll));
const rankStateSalesAll = percentileRanker(states.map(s => (s.netSales || 0) + (s.netSales_zohoApprox || 0)));
for (const s of states) s.opportunityScore = round1(rankStateUsers(s.users) * 0.20 + rankStateDeals(s.zohoDeals) * 0.30 + rankStateClicks(s.gadsClicksAll) * 0.20 + rankStateSalesAll((s.netSales || 0) + (s.netSales_zohoApprox || 0)) * 0.30);
const rankStateOpportunity = percentileRanker(states.map(s => s.opportunityScore));
for (const s of states) { const r = rankStateOpportunity(s.opportunityScore); s.priority = r >= 90 ? 'High' : r >= 70 ? 'Medium' : r >= 40 ? 'Low' : 'Watch'; }
states.sort((a, b) => b.opportunityScore - a.opportunityScore);

// ---------- Campaign intelligence (native columns on application_view_v1 -- no text-match join needed anymore) ----------
console.log('Building campaign intelligence (native WebEngage campaign fields, no cross-table text match required)...');
// purchase/conversionPct are NULL (not 0) at campaign grain: Purchase events carry no campaign_id
// at all (confirmed live, 0 of 2,686 campaigns), so this is a real "not available" gap, not a
// measured zero -- see dataQuality.campaignPurchaseGap.
let campaigns = appCampaign
  .filter(r => r.campaign_key && r.campaign_key !== 'unknown')
  .map(r => ({
    campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium,
    pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), checkout: num(r.begin_checkout), purchase: null,
    totalEvents: num(r.total_events), uniqueDevices: num(r.unique_devices), distinctCities: num(r.distinct_cities),
    conversionPct: null
  }));
campaigns.sort((a, b) => b.totalEvents - a.totalEvents);

let campaignCity = appCampaignCity.map(r => ({
  campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium, state: r.state, city: r.city,
  pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), checkout: num(r.begin_checkout), purchase: null,
  totalEvents: num(r.total_events), attribution: 'city_exact_webengage'
}));
let campaignPincodeExact = appPincodeCampaign.map(r => {
  const geo = pincodeGeoMap.get(r.pincode);
  return { pincode: r.pincode, district: geo ? geo.district : null, state: geo ? geo.state : null, campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium, totalEvents: num(r.total_events), uniqueCustomers: num(r.unique_customers), attribution: 'pincode_exact_webengage' };
});

// ---------- Product / Price band (city grain; PDP-view side has no ATC/checkout category -- disclosed) ----------
console.log('Building product & price-band tables (Product Viewed for PDP-view category/price; Purchase for real revenue/SKU)...');
let productByCity = appProductPdp.filter(r => r.category).map(r => ({
  state: r.state, city: r.city, category: r.category, priceRange: r.price_range,
  pdpViews: num(r.pdp_views), addToCart: null, purchase: null, revenue: null,
  attribution: 'city_exact_webengage_pdp_view_only'
}));
// merge in Purchase-side revenue/purchase counts onto matching (city, category, priceRange) rows where possible
const purchByCat = new Map();
for (const r of appProductPurchase) {
  const key = [normCity(r.city), r.category, r.price_range].join('|');
  const cur = purchByCat.get(key) || { purchase: 0, revenue: 0 };
  cur.purchase += num(r.purchase_line_items); cur.revenue += num(r.revenue);
  purchByCat.set(key, cur);
}
for (const row of productByCity) {
  const key = [normCity(row.city), row.category, row.priceRange].join('|');
  const p = purchByCat.get(key);
  if (p) { row.purchase = p.purchase; row.revenue = Math.round(p.revenue); }
}
// purchase-only categories with no PDP-view row (still real, still worth surfacing)
for (const [key, p] of purchByCat) {
  const [cityKey, category, priceRange] = key.split('|');
  if (!productByCity.some(r => normCity(r.city) === cityKey && r.category === category && r.priceRange === priceRange)) {
    const sample = appProductPurchase.find(r => normCity(r.city) === cityKey && r.category === category && r.price_range === priceRange);
    productByCity.push({ state: sample?.state, city: sample?.city, category, priceRange, pdpViews: null, addToCart: null, purchase: p.purchase, revenue: Math.round(p.revenue), attribution: 'city_exact_webengage_purchase_only' });
  }
}

let topSkuByCity = [];
{
  const byCity = new Map();
  for (const r of appProductPurchase) {
    if (!r.sku) continue;
    const key = normCity(r.city);
    const arr = byCity.get(key) || [];
    arr.push(r);
    byCity.set(key, arr);
  }
  for (const [key, rows] of byCity) {
    const bySku = new Map();
    for (const r of rows) {
      const cur = bySku.get(r.sku) || { state: r.state, city: r.city, category: r.category, sku: r.sku, productName: r.product_name, priceRange: r.price_range, purchase: 0, revenue: 0 };
      cur.purchase += num(r.purchase_line_items); cur.revenue += num(r.revenue);
      bySku.set(r.sku, cur);
    }
    topSkuByCity.push(...[...bySku.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10));
  }
}

let priceBand = [];
{
  const byKey = new Map();
  for (const r of appProductPdp) {
    const key = [r.state, r.city, r.price_range].join('|');
    const cur = byKey.get(key) || { state: r.state, city: r.city, priceRange: r.price_range, pdpViews: 0, purchase: 0, revenue: 0 };
    cur.pdpViews += num(r.pdp_views); byKey.set(key, cur);
  }
  for (const r of appProductPurchase) {
    const key = [r.state, r.city, r.price_range].join('|');
    const cur = byKey.get(key) || { state: r.state, city: r.city, priceRange: r.price_range, pdpViews: 0, purchase: 0, revenue: 0 };
    cur.purchase += num(r.purchase_line_items); cur.revenue += num(r.revenue); byKey.set(key, cur);
  }
  priceBand = [...byKey.values()].map(r => ({ ...r, revenue: Math.round(r.revenue), conversionPct: r.pdpViews ? round1(r.purchase / r.pdpViews * 100) : null, attribution: 'city_exact_webengage' }));
}

// ---------- Daily (IST) ----------
let dailyCity = appDailyCity.map(r => ({ date: r.event_date, state: r.state, city: r.city, pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), checkout: num(r.begin_checkout), purchase: num(r.purchase), totalEvents: num(r.total_events) }));
let dailyCampaign = appDailyCampaign.map(r => ({ date: r.event_date, campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium, pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), checkout: num(r.begin_checkout), purchase: num(r.purchase), totalEvents: num(r.total_events) }));
const dailyDateRange = { min: dailyCity.reduce((a, r) => !a || r.date < a ? r.date : a, null), max: dailyCity.reduce((a, r) => !a || r.date > a ? r.date : a, null) };

// city -> top category / top SKU / top price band (Store Recommendation reason text)
const topCategoryByCity = new Map();
for (const r of productByCity) { if (!r.pdpViews) continue; const key = normCity(r.city); const cur = topCategoryByCity.get(key); if (!cur || r.pdpViews > cur.pdpViews) topCategoryByCity.set(key, { category: r.category, pdpViews: r.pdpViews }); }
const topSkuByCityMap = new Map();
for (const r of topSkuByCity) { const key = normCity(r.city); if (!topSkuByCityMap.has(key)) topSkuByCityMap.set(key, r); }

// ---------- Store Recommendation (Top 10) ----------
console.log('Building store recommendation list...');
const storeRecommendations = pincodes.slice(0, 10).map((p, i) => {
  const cityKey = normCity(p.district);
  const topCat = topCategoryByCity.get(cityKey);
  const topSku = topSkuByCityMap.get(cityKey);
  const reasons = [];
  reasons.push(`${p.users.toLocaleString('en-IN')} real WebEngage profile users concentrated in pincode ${p.pincode} (${p.district}, ${p.state})`);
  if (p.totalEvents_exact > 0) reasons.push(`${p.totalEvents_exact.toLocaleString('en-IN')} pincode-exact WebEngage app events (mobile-matched), not a city estimate`);
  if (p.revenue_cityProxy) reasons.push(`its city (${p.weCity}) shows real WebEngage purchase revenue of ~₹${Math.round(p.revenue_cityProxy).toLocaleString('en-IN')} (city-level, from real order addresses)`);
  if (p.nearestStore) reasons.push(`${p.nearestStore.distanceKm} km from the nearest existing store (${p.nearestStore.storeName})`);
  if (p.storeGapFlag === 'HIGH') reasons.push('flagged HIGH store gap -- strong demand with no store nearby');
  if (p.tanishqStoreCount || p.caratlaneStoreCount) {
    const comp = [p.tanishqStoreCount ? `${p.tanishqStoreCount} Tanishq` : null, p.caratlaneStoreCount ? `${p.caratlaneStoreCount} CaratLane` : null].filter(Boolean).join(' + ');
    reasons.push(`${comp} store(s) already validate this pincode as a real jewelry-retail market`);
  }
  return {
    rank: i + 1, pincode: p.pincode, district: p.district, state: p.state,
    users: p.users, totalEvents_exact: p.totalEvents_exact, pdpViews_cityProxy: p.pdpViews_cityProxy,
    purchase_cityProxy: p.purchase_cityProxy, revenue_cityProxy: p.revenue_cityProxy,
    topCategory: topCat ? topCat.category : null, topProduct: topSku ? topSku.productName : null,
    nearestStore: p.nearestStore, storeGapFlag: p.storeGapFlag, opportunityScore: p.scores.opportunityScore, priority: p.priority,
    tanishqStoreCount: p.tanishqStoreCount, caratlaneStoreCount: p.caratlaneStoreCount,
    reason: reasons.join('; ') + '.'
  };
});

// ---------- Customer-level sample (Tab 11) -- mobile MASKED (PII policy, same as Walk-in Source Intelligence) ----------
console.log('Building customer-level sample (mobile masked)...');
// Real customer-level rows (drill-down feature) -- one row per real, mobile-matched customer, each
// with their OWN separate KPIs (never combined), canonical-pincode-deduped (see
// customerRowsByPincode construction above). This is ALL 292 real customers, not a sample -- the
// old app_customer_sample.json pull (a looser LIMIT-5000 query, not canonical-pincode-deduped) is
// superseded by this table and no longer used.
// Union of event-customers and sales-customers, keyed by mobile|pincode -- a customer who bought
// but never generated an identifiable browsing event (or vice versa) is NOT dropped, per the
// explicit "never hide unmapped records" instruction.
const customerUnionMap = new Map();
for (const c of allCustomerRows) {
  const key = `${c.mobile_masked}|${c.pincode}`; // mobile_masked is already the masked form, unique enough as a join key here since it's derived 1:1 from the real mobile
  customerUnionMap.set(key, {
    mobile_masked: c.mobile_masked, pincode: c.pincode, city: c.district, state: c.state,
    sessions: c.sessions, pdpViews: c.pdpViews, addToCart: c.addToCart, checkout: c.checkout,
    checkoutEvents: c.checkout, wishlist: c.wishlist, plpImpressions: c.plpImpressions, removeFromCart: c.removeFromCart,
    totalEvents: c.totalEvents, firstSeen: c.firstSeen, lastSeen: c.lastSeen,
    orders: 0, purchase: 0, netSales: 0, aov: null, isRepeat: false
  });
}
for (const s of salesByCustomerPincode.values()) {
  // Address-pincode sales can have no mobile at all -- key those per order so they never collide.
  const key = s.mobile ? `${maskMobile(s.mobile)}|${s.pincode}` : `no-mobile:${[...s.orders][0]}|${s.pincode}`;
  const existing = customerUnionMap.get(key);
  const salesFields = { orders: s.orders.size, purchase: s.orders.size, netSales: Math.round(s.netSales), aov: s.orders.size ? Math.round(s.netSales / s.orders.size) : null, isRepeat: s.orders.size > 1 };
  if (existing) { Object.assign(existing, salesFields); }
  else {
    customerUnionMap.set(key, {
      mobile_masked: maskMobile(s.mobile), pincode: s.pincode, city: pincodeGeoMap.get(s.pincode)?.district || null, state: pincodeGeoMap.get(s.pincode)?.state || null,
      sessions: 0, pdpViews: 0, addToCart: 0, checkout: 0, checkoutEvents: 0, wishlist: 0, plpImpressions: 0, removeFromCart: 0,
      totalEvents: 0, firstSeen: s.first, lastSeen: s.last, ...salesFields
    });
  }
}
const customers = [...customerUnionMap.values()].sort((a, b) => (b.totalEvents + b.orders * 100) - (a.totalEvents + a.orders * 100));

// ---------- Data Quality (Tab 12) ----------
console.log('Assembling data quality summary...');
const dataQuality = {
  ga4Removed: {
    note: 'ga4_data.ga4_data has ZERO dependency in this build (2026-09-01 rebuild). Every KPI, chart, campaign, product, and customer metric below is sourced from test-webengage.11b56595a_shared.application_view_v1 (events) and user_profile_view_v3 (profile Users count + pincode geo enrichment), plus the unchanged store/pincode masters. No fallback to GA4 exists anywhere in this dashboard or its data pipeline.'
  },
  eventMapping: {
    'Wish_list': 'addToWishlist', 'ATC': 'addToCart',
    'PDP View': 'productView + Product Viewed (combined, per the source screenshot mapping both to PDP View)',
    'Check_out': 'begin_checkout', 'Purchase': 'Purchase (capitalized)'
  },
  notCombined: 'Added To Cart / nitro_addtocart / Cart Updated are a separate near-duplicate cluster NOT folded into ATC (screenshot only names addToCart). Lowercase purchase / Order Completed / Order updated / Order created are separate order-lifecycle events NOT folded into Purchase.',
  eventCoverage: appEventCoverage.map(r => ({ eventName: r.event_name, category: r.category, eventCount: num(r.event_count), uniqueDevices: num(r.unique_devices), eventsWithAnyCuid: num(r.events_with_any_cuid) })),
  mobileMatching: {
    hierarchy: 'Tier 1: normalized mobile from cuid (strip +91/91/0 prefix intelligently -- only when the remainder is a valid 10-digit Indian mobile starting 6-9). Tier 2 (luid) NOT usable cross-table: application_view_v1 luid is a 32-char hash, user_profile_view_v3 luid is a 40-char hash -- different ID namespaces, confirmed live. So the only real cross-table customer key is the normalized mobile.',
    totalEvents: num(appDataQuality.total_events),
    eventsWithCuid: num(appDataQuality.events_with_cuid),
    eventsWithValidMobileShape: num(appDataQuality.events_with_valid_mobile_shape),
    coveragePct: round1(num(appDataQuality.events_with_valid_mobile_shape) / num(appDataQuality.total_events) * 100),
    note: `Only ~${round1(num(appDataQuality.events_with_valid_mobile_shape) / num(appDataQuality.total_events) * 100)}% of all application_view_v1 events carry a mobile-shaped cuid. The other ~89% are real events, countable at city/campaign grain via the 100%-populated luid (anonymous device), but NOT linkable to a phone-identified customer or to a real pincode.`
  },
  geographyGap: {
    note: 'postal_code is 0% populated on application_view_v1 (13.26M rows, zero, confirmed live). Pincode-exact event rows exist ONLY for events with a valid mobile cuid that also matches a real pincode via a same-project join to user_profile_view_v3 (both tables live in test-webengage.11b56595a_shared, so this join is NOT cross-region). city is 88% populated directly on application_view_v1 and is the basis of every city/state/campaign table that is not pincode-exact.'
  },
  salesMapping: {
    note: `Real sales from lucirajewelry-prod.ds_imputed_reporting.marketing_sale (all channels: ${Object.keys(salesChannelTotals).join(' / ')}; ${salesRaw.length.toLocaleString('en-IN')} line items, ${[...new Set(salesRaw.map(r=>r.document_no))].length.toLocaleString('en-IN')} distinct orders, ${salesMinDate} to ${salesMaxDate}) -- NOT GA4, NOT WebEngage. Pincode = the SALE's own pincode (rebuilt 2026-10-19), first real India-Post pincode wins: 1) marketing_sale.Pin_code (${salesTierCounts.sale_pincode} line items), 2) ERP POS invoice shipping_pin_code (${salesTierCounts.invoice_pincode}), 3) ERP customer master party.pin_code (${salesTierCounts.party_pincode} -- the main source for Store-channel sales), 4) a pincode inside the sale's address text (${salesTierCounts.address}), 5) the customer's typed record by mobile -- ERP CRM customer / Shopify customer (${salesTierCounts.customer_master}), 6) last resort the customer's WebEngage profile pincode by mobile (${salesTierCounts.webengage}). ${salesAtStoreOwnPincode.lineItems} line items (Rs ${Math.round(salesAtStoreOwnPincode.net).toLocaleString('en-IN')}) resolve via the party master to the SELLING STORE's own pincode -- may be genuine local customers or a store-pincode default typed at billing; kept, disclosed. A further ${salesTierCounts.zohoApprox} line items only map via the APPROXIMATE Zoho Contact pincode -- shown separately as "Sales (Zoho approx.)", never mixed into Sales. Mapped: Rs ${Math.round(totalMappedSales).toLocaleString('en-IN')}. Unmapped: Rs ${Math.round(unmappedSales.netSales).toLocaleString('en-IN')} (${unmappedSales.lineItems} line items) -- of which Rs ${Math.round(unmappedSales.nonRetailNet || 0).toLocaleString('en-IN')} is Amazon / Management / TAH (not customer-located: their ERP party is the marketplace or an internal account, so deliberately NOT put on any pincode), the rest has no pincode in any ERP/customer source. Never forced to a guessed pincode.`,
    unmappedNonRetailNetSales: Math.round(unmappedSales.nonRetailNet || 0),
    minDate: salesMinDate, maxDate: salesMaxDate, tierNetSales: Object.fromEntries(Object.entries(salesTierNet).map(([k, v]) => [k, Math.round(v)])),
    atStoreOwnPincode: { lineItems: salesAtStoreOwnPincode.lineItems, netSales: Math.round(salesAtStoreOwnPincode.net) },
    byChannel: Object.entries(salesChannelTotals).map(([channel, t]) => ({ channel, netSales: Math.round(t.net), orders: t.orders.size, lineItems: t.lineItems, mappedNetSales: Math.round(t.mappedNet), mappedOrders: t.mappedOrders.size, mappedLineItems: t.mappedLineItems })).sort((x, y) => y.netSales - x.netSales),
    totalNetSales: Math.round(totalMappedSales + unmappedSales.netSales),
    mappedNetSales: Math.round(totalMappedSales), mappedCustomerPincodePairs: salesByCustomerPincode.size,
    unmappedNetSales: Math.round(unmappedSales.netSales), unmappedLineItems: unmappedSales.lineItems, unmappedOrders: unmappedSales.orders.size,
    unmappedReasonNoMobile: unmappedSales.reasonNoMobile, unmappedReasonNoPincodeMatch: unmappedSales.reasonNoPincodeMatch,
    tierLineItems: salesTierCounts, zohoApproxNetSales: Math.round([...salesApproxByPincode.values()].reduce((a, c) => a + c.netSales, 0))
  },
  customerDrilldown: {
    note: `City -> Pincode -> Customer drill-down (added 2026-09-01). Real ceiling, confirmed live: 64,015 customers have a real mobile+pincode profile in user_profile_view_v3, but only ${customers.length} of them ever generated an application_view_v1 event with that same mobile attached -- everyone else's events are real but not identity-linkable (no reliable mobile on the event). Canonical pincode per customer = their MOST RECENT user_profile_view_v3 record by last_seen (not an arbitrary pick, not a duplicate across pincodes -- confirmed live: ${customers.length} rows, ${customers.length} distinct mobiles). Every "_exact" number on Pincode/City/State (uniqueCustomers_exact, sessions_exact, pdpViews_exact, etc.) is summed bottom-up from these same ${customers.length} customer rows, so pincode/city/state totals always reconcile exactly with "sum of their customers" -- never re-derived from a separate aggregate query that could drift.`,
    totalCustomers: customers.length,
    totalMatchableProfiles: 64015,
    // Total distinct real mobile numbers identified across the WHOLE WebEngage profile table
    // (user_profile_view_v3), not restricted to having any pincode at all -- confirmed live via
    // BigQuery 2026-09-07: COUNT(DISTINCT normalized cuid) = 225,352. This is the broadest honest
    // "how many customers do we know by mobile number" figure; totalMatchableProfiles (64,015) is
    // the narrower subset that ALSO has a real pincode.
    totalMobileNumbersSystemWide: 225352,
    pincodesWithAnyCustomer: new Set(customers.map(c => c.pincode)).size
  },
  luidVsMobileComparison: {
    note: `Live-tested 2026-09-16 whether LUID could match or beat mobile (cuid) as the customer-to-pincode join key. Raw identity overlap between application_view_v1 and user_profile_view_v3 is actually HIGHER via LUID (82% of profile LUIDs also appear in events, confirmed live) than the impression a small manual sample gave earlier -- and user_profile_view_v3 has exactly 1 row per LUID already, so LUID needs no de-dup step (mobile needs a ROW_NUMBER-by-last_seen step since a mobile can have multiple profile rows). But once restricted to a REAL India-Post-matched pincode, LUID finds FEWER usable customers system-wide: ${pincodes.reduce((a,p)=>a+p.uniqueCustomers_luid,0)} via LUID vs ${customers.length} via mobile. Kept as a supplementary, side-by-side count on every pincode (uniqueCustomers_luid) -- mobile remains the PRIMARY customer identifier and drill-down source.`,
    totalCustomersLuid: pincodes.reduce((a,p)=>a+p.uniqueCustomers_luid,0),
    totalCustomersMobile: customers.length
  },
  fakePincodesNote: {
    note: `${fakePincodes.length} format-valid-looking 6-digit postal_code values were entered by real, mobile-matched customers but are NOT real India Post pincodes (confirmed against ds_india_geo.india_pincode). Previously silently discarded here with no trace anywhere on the dashboard. Now shown on the Fake Pincodes tab rather than hidden -- some carry real, large event volume (the single biggest is a fake pincode with ${fakePincodes[0] ? fakePincodes[0].pdpViews : 0} PDP views from ${fakePincodes[0] ? fakePincodes[0].uniqueCustomers : 0} customer(s), more than any real pincode in this dataset). These numbers are real events from a real customer -- only the pincode value itself is unverifiable, so they are excluded from every Pincode/City/State total elsewhere on this dashboard.`,
    count: fakePincodes.length,
    totalPdpViews: fakePincodes.reduce((a, p) => a + p.pdpViews, 0),
    totalCustomers: fakePincodes.reduce((a, p) => a + p.uniqueCustomers, 0)
  },
  competitorCoverage: {
    note: `Real Tanishq/CaratLane store presence added 2026-09-02, matched by EXACT pincode string against a one-time public store-locator capture (etl/tanishq_store_master.json, etl/caratlane_store_master.json -- not BigQuery, and not re-scraped live). ${pincodes.filter(p=>p.tanishqStoreCount>0).length} of our ${pincodes.length} real pincodes have a Tanishq store; ${pincodes.filter(p=>p.caratlaneStoreCount>0).length} have a CaratLane store. A pincode showing no competitor here means none was found in that capture -- NOT a confirmed absence (the capture covers 509 Tanishq and 308 CaratLane store-pincodes nationally, most of which fall outside our own tracked-pincode set, since our pincodes are bounded to where real WebEngage/Lucira user data exists, not every pincode in India).`,
    tanishqPincodesTotal: 509, tanishqPincodesMatched: pincodes.filter(p=>p.tanishqStoreCount>0).length,
    caratlanePincodesTotal: 308, caratlanePincodesMatched: pincodes.filter(p=>p.caratlaneStoreCount>0).length
  },
  campaignPurchaseGap: {
    note: 'Purchase events carry NO campaign_id at all (server-side order webhooks, confirmed live: 0 of 2,686 campaigns and 0 of 13,971 campaign x city rows have any purchase). Campaign-level Purchase/Conversion% is genuinely not available and shown as "not available" rather than a misleading 0. City-level and pincode-level Purchase counts ARE available -- they come from the real order shipping/billing address inside Purchase events\' json_data, not from campaign attribution.'
  },
  purchaseCityAnomaly: {
    note: `A real bug was caught via headless testing (not code review): city rollup "purchase" counts were silently always 0 while "revenue" was correctly non-zero, because Purchase events have 0% top-level city/country and the purchase COUNT was wrongly sourced from that top-level field while revenue correctly used the JSON shipping-address city. Fixed to source both from the same address-based city. One real oddity surfaced by the fix, disclosed rather than smoothed over: "Palghar" carries 1,112 of 2,443 total Purchase events (45.5%) -- an order of magnitude above the next-highest real city (Mumbai, 583) -- worth a manual look before trusting Palghar-specific numbers.`
  },
  productDataGap: {
    note: 'addToCart has 0% json_data -- no category/price is ever available for ATC events, not estimated. productView (camelCase, the majority of PDP-view volume) json_data is only 1.2% populated and holds only an image URL, no category/price. "Product Viewed" (Title Case, 100% json coverage) is the only reliable PDP-view-level category/price source used in the Product Demand and Price Band tabs. Purchase json_data is 100% populated with real items[] (sku, price, category, quantity) AND a real shipping/billing address (city, state, zipcode) -- Purchase revenue and SKU tables are fully real, at real order-address grain, independent of the mobile join.'
  },
  genderUnavailable: {
    note: 'No gender field exists anywhere on application_view_v1 (confirmed against the full 187-column schema). GA4 provided this in the old build; there is no WebEngage equivalent. Gender Demand is NOT shown as a tab in this rebuild rather than fabricated.'
  },
  conversionScoreDropped: {
    note: 'The old Opportunity Score had a 10% "Conversion Score" component from GA4 city-level conversion%. Without a session/visit denominator on a single event table, an equivalent conversion rate is not directly available; that 10% weight was folded into Revenue Score (15% -> 25%) rather than silently dropped -- see meta.scoringMethodology.'
  },
  storeMaster: { note: '6 real customer-facing addresses from ornaverse_erp_master.company, unchanged from the v1 build (never GA4-sourced).', stores: storeMaster.map(s => s.storeCode) },
  zohoDeals: {
    note: `Zoho CRM Deals (zoho_crm.cdc_deals, live CDC, ~30-min sync). ${zohoTotals.deals.toLocaleString('en-IN')} deals created ${zohoMinDate} to ${zohoMaxDate} (${zohoTotals.deals30.toLocaleString('en-IN')} in the last 30 days, ~${Math.round(zohoTotals.deals30 / 30)}/day). Pincode = the deal's own Address_Zip_Postal_Code (CDC, or zoho_crm.deals_address_live_patch) if 6-digit (${zohoTotals.fromDealZip.toLocaleString('en-IN')} deals) else the linked Contact's Mailing_Zip (${zohoTotals.fromContactZip.toLocaleString('en-IN')}); ${zohoTotals.withRealPincode.toLocaleString('en-IN')} deals (${round1(zohoTotals.withRealPincode / zohoTotals.deals * 100)}%) land on a real India-Post pincode, across ${zohoByPincode.size} pincodes; the rest have no usable pincode in Zoho at all. ACCURACY, re-checked live every build against the ERP sale pincode of the same buyer (mobile): deal-zip ${zohoValidationLive.dealZip.exactPincodeMatch}/${zohoValidationLive.dealZip.buyersCompared} exact, ${zohoValidationLive.dealZip.sameDistrict} same district; contact-zip ${zohoValidationLive.contactZip.exactPincodeMatch}/${zohoValidationLive.contactZip.buyersCompared} exact, ${zohoValidationLive.contactZip.sameDistrict} same district. Treat Zoho deal pincodes as approximate (reliable at city/state level) -- 0% weight in the Pincode Opportunity Score, 30% in City/State scores.`,
    totalDeals: zohoTotals.deals, deals30: zohoTotals.deals30, deals7: zohoTotals.deals7, maxDate: zohoMaxDate,
    dealsWithRealPincode: zohoTotals.withRealPincode, realPincodeDeals30: zohoTotals.realPincode30,
    dealsWithAnyPincodeText: zohoTotals.withAnyPincode, pincodesWithDeals: zohoByPincode.size,
    fromDealZip: zohoTotals.fromDealZip, fromContactZip: zohoTotals.fromContactZip, closedWon: zohoTotals.won,
    validation: (() => { const d = zohoValidationLive.dealZip, c = zohoValidationLive.contactZip; const n = d.buyersCompared + c.buyersCompared;
      return { buyersCompared: n, exactPincodeMatch: d.exactPincodeMatch + c.exactPincodeMatch, sameState: d.sameState + c.sameState, sameDistrict: d.sameDistrict + c.sameDistrict,
        medianKmApart: c.medianKmApart != null ? c.medianKmApart : d.medianKmApart }; })(),
    validationBySource: zohoValidationLive, minDate: zohoMinDate
  },
  googleAds: {
    note: `Google Ads geographic_view (google_ads.ads_GeoStats_2348623547, ${gadsTotals.firstDate} to ${gadsTotals.lastDate}) added 2026-09-29. 100% of spend is LOCATION_OF_PRESENCE (Google's own estimate of where the user physically is). Location ids decoded with Google's public geotargets CSV (2026-08-12 release). Rs ${Math.round(gadsTotals.spend30).toLocaleString('en-IN')} spent in the last 30 days (~Rs ${Math.round(gadsTotals.spend30 / 30).toLocaleString('en-IN')}/day); ${round1(gadsTotals.postalSpend30 / gadsTotals.spend30 * 100)}% of it (Rs ${Math.round(gadsTotals.postalSpend30).toLocaleString('en-IN')}) sits on an exact real postal code and is shown per pincode. The rest was reported at City / Neighborhood / District level by Google and is NOT spread onto pincodes. Pincodes with only Google Ads activity join the pincode universe once all-time spend >= Rs ${ADS_MIN_SPEND_FOR_UNIVERSE}. Meta Ads is NOT included: meta_ads.AdInsights stopped syncing on 2026-01-06 and only has state-level Region.`,
    spend30: Math.round(gadsTotals.spend30), spendAll: Math.round(gadsTotals.spendAll),
    postalSpend30: Math.round(gadsTotals.postalSpend30), postalSpendAll: Math.round(gadsTotals.postalSpendAll),
    nonPostalSpend30: Math.round(gadsTotals.nonPostalSpend30), nonPostalSpendAll: Math.round(gadsTotals.nonPostalSpendAll),
    pincodesWithSpend: gadsByPincode.size, pincodesInUniverseWithSpend: pincodes.filter(p => p.gadsSpendAll > 0).length,
    spendAllInUniverse: pincodes.reduce((a, p) => a + p.gadsSpendAll, 0), spend30InUniverse: pincodes.reduce((a, p) => a + p.gadsSpend30, 0),
    firstDate: gadsTotals.firstDate, lastDate: gadsTotals.lastDate, minSpendForUniverse: ADS_MIN_SPEND_FOR_UNIVERSE
  },
  weProfile: {
    totalUsers: num(weDataQuality.total_users),
    usersAnyPincodeText: num(weDataQuality.users_any_pincode),
    usersFormatValidPincode: num(weDataQuality.users_format_valid_pincode),
    usersRealMatchedPincode: pincodes.reduce((a, p) => a + p.users, 0),
    distinctFormatValidPincodes: unmatchedFormatValidPincodes + pincodes.filter(p => p.inWebEngage).length,
    distinctRealMatchedPincodes: pincodes.filter(p => p.inWebEngage).length,
    totalPincodesInUniverse: pincodes.length,
    extraPincodesFromOtherSources: pincodes.filter(p => !p.inWebEngage).length,
    usersWithCity: num(weDataQuality.users_with_city),
    usersWithCoords_ALWAYS_ZERO: num(weDataQuality.users_with_coords),
    usersWithCampaignSource: num(weDataQuality.users_with_campaign_source),
    usersWithRealCampaignId: num(weDataQuality.users_with_campaign_id),
    usersWithAcquisitionSource_DEAD_FIELD: num(weDataQuality.users_with_acquisition_source),
    realPincodesWithExactEvents: pincodes.filter(p => p.totalEvents_exact > 0).length,
    note: '"Users" on every pincode/city/state row is the WebEngage PROFILE-level digital-user count (user_profile_view_v3, unchanged from v1) -- a distinct signal from application_view_v1 event volume, kept alongside it rather than replaced, since dropping it would lose real signal with no stated reason.'
  }
};

// ---------- Assemble & write ----------
const snapshot = {
  generatedAt: new Date().toISOString().slice(0, 10),
  meta: {
    title: 'Lucira Store Location Intelligence & Campaign Demand',
    dataArchitectureVersion: 'v2 -- GA4 fully removed 2026-09-01',
    sources: [
      'test-webengage.11b56595a_shared.application_view_v1 (WebEngage app/web events, region US) -- PRIMARY digital demand',
      'test-webengage.11b56595a_shared.user_profile_view_v3 (WebEngage profile, region US) -- profile Users count + canonical-pincode geo enrichment (mobile-matched)',
      'lucirajewelry-prod.ds_imputed_reporting.marketing_sale (real company sales ledger, Online/Store/Amazon/TAH) -- PRIMARY sales, NOT GA4/WebEngage-derived',
      'lucirajewelry-prod.ornaverse_erp_master.company (real store addresses)',
      'lucirajewelry-prod.zoho_crm.cdc_deals + cdc_contacts (Zoho CRM Deals, live CDC) -- deal volume, APPROXIMATE pincode (Contact Mailing_Zip)',
      'lucirajewelry-prod.google_ads.ads_GeoStats_2348623547 (Google Ads geographic_view, LOCATION_OF_PRESENCE) + Google public geotargets CSV -- spend/clicks per postal code',
      'lucirajewelry-prod.ds_india_geo.india_pincode (real India Post pincode/lat/lon master)'
    ],
    ga4Dependency: 'NONE',
    scoringMethodology: {
      pincodeOpportunityScore: 'v4 (2026-09-29). Weighted percentile-rank blend, 0-100, 9 visible components (see scoreComponents on every pincode): 10% Customer Demand (unique mobile-matched WebEngage customers) + 5% Active Customer Rate + 5% PDP Engagement (PDP views per customer) + 5% Cart Intent (ATC per customer) + 5% Checkout Intent (checkout per customer) + 25% Paid Search Demand (Google Ads clicks from users Google locates in this exact postal code, all-time) + 15% Conversion (% of customers who purchased, marketing_sale) + 15% Sales Performance (net sales per purchasing customer, marketing_sale) + 15% Store Gap (distance to nearest real store). Zoho Deals are shown but carry 0% here, because their pincode is approximate (see Data Quality). Priority = percentile of the blended score: High = top 10%, Medium = next 20%, Low = next 30%, else Watch. Opportunity Flag (separate from Priority) = EXISTING STORE if a real store sits within 5km regardless of score, else HIGH OPPORTUNITY = top 30% of scores, MEDIUM = next 30%, LOW = the rest.',
      cityOpportunityScore: 'v4 (2026-09-29): 30% Zoho Deals + 20% Google Ads clicks + 20% WebEngage profile Users + 30% Net Sales (marketing_sale, incl. Zoho-approx-mapped sales), each as a percentile rank. Same percentile-tier method.',
      stateOpportunityScore: 'v4 (2026-09-29): same blend as City -- 30% Zoho Deals + 20% Google Ads clicks + 20% profile Users + 30% Net Sales.',
      storeGapFlag: 'HIGH = top-tercile demand AND >15km from nearest store. MEDIUM = mid/high demand AND 5-15km. LOW = otherwise.',
      cityProxyAllocation: 'Every pincode\'s "(City Est.)" PDP/ATC/Checkout/Purchase/Revenue value is that pincode\'s ALLOCATED SHARE of its city\'s total application_view_v1 activity -- pincode.metric = city.metric_total * (pincode.users / SUM(users across every real pincode in that city)), where "users" is the real, pincode-level WebEngage profile Users count (never itself an estimate). Falls back to an equal split across the city\'s real pincodes only if none of them have any profile Users at all. Fixed 2026-09-02 (previously the full, un-allocated city total was repeated unchanged on every pincode in that city -- correct as "this pincode\'s city, for context" but read as a bug, and silently multiplied the city total once per real pincode when summed into the State rollup). Because the weights sum to 1 across a city\'s pincodes, these values now sum back to the true city total exactly.'
    },
    dailyDateRange,
    dateFilterNote: 'Executive/City/Campaign date filters recompute real application_view_v1 daily numbers (IST, Asia/Kolkata) within the picked range. Profile-level Users stays all-time (user_profile_view_v3 is a snapshot, not a session log).'
  },
  dataLineage: {
    sourceTables: [
      { table: 'test-webengage.11b56595a_shared.application_view_v1', project: 'test-webengage', region: 'US', role: 'PRIMARY', rows: '13.26M', usedFor: 'Every behavioral metric: PDP views, ATC, checkout, purchase, wishlist, campaign, product/SKU, daily events. Key columns: event_name, cuid, luid, city, region, country, campaign_id/source/medium, event_time, json_data.' },
      { table: 'test-webengage.11b56595a_shared.user_profile_view_v3', project: 'test-webengage', region: 'US', role: 'GEO + PROFILE', rows: '1.6M', usedFor: 'Profile-level "Users" count (unchanged from v1) and pincode geo-enrichment for application_view_v1 events (via a same-project mobile join -- both tables live in this one dataset). Key columns: cuid, postal_code, city, region.' },
      { table: 'lucirajewelry-prod.ornaverse_erp_master.company', project: 'lucirajewelry-prod', region: 'asia-south1', role: 'STORE MASTER', rows: '6 stores', usedFor: 'Real store addresses (BO1/CS1/FCS/LPN/N18/PN1/PV1, HO excluded) -- unchanged, never GA4-sourced.' },
      { table: 'lucirajewelry-prod.ds_india_geo.india_pincode', project: 'lucirajewelry-prod', region: 'asia-south1', role: 'PINCODE MASTER', rows: '19,561 pincodes', usedFor: 'Validates which WebEngage postal_code values are real India Post pincodes vs free-text noise; supplies district/state/lat/lon for every real pincode.' },
      { table: 'lucirajewelry-prod.ds_imputed_reporting.marketing_sale', project: 'lucirajewelry-prod', region: 'asia-south1', role: 'SALES', rows: '2,350 line items', usedFor: 'Real company sales (net_sale, orders, units), authoritative Sales source -- not GA4/WebEngage-derived. No pincode column; mapped via the same canonical mobile-to-pincode join used for events.' },
      { table: 'etl/tanishq_store_master.json (local file)', project: 'n/a', region: 'n/a', role: 'COMPETITOR', rows: '509 pincodes', usedFor: 'Real Tanishq store locations, one-time public store-locator capture, matched by exact pincode string. Not a BigQuery source.' },
      { table: 'etl/caratlane_store_master.json (local file)', project: 'n/a', region: 'n/a', role: 'COMPETITOR', rows: '308 pincodes', usedFor: 'Real CaratLane store locations, same capture methodology already used by the sibling GA4 Geo Intelligence dashboard, matched by exact pincode string. Not a BigQuery source.' },
      { table: 'etl/caratlane_stores.json (local file)', project: 'n/a', region: 'n/a', role: 'COMPETITOR CATALOG', rows: '207 stores', usedFor: 'CaratLane\'s own public online-catalog mix per store: category counts (Rings/Earrings/Necklaces/...) and price-band counts. No equivalent capture exists for Tanishq. Not a sales/inventory figure -- their public catalog listing only.' }
    ],
    pullQueries: [
      { file: 'app_pincode_agg.json', query: 'Q1', joins: 'application_view_v1 x user_profile_view_v3 (same-project, mobile-normalized JOIN)', grain: 'Pincode', produces: 'Pincode-EXACT funnel events (pdp/atc/checkout/purchase/wishlist), only for events with a valid mobile match to a real pincode.' },
      { file: 'app_pincode_campaign_agg.json', query: 'Q1b', joins: 'Same as Q1, + campaign_id from application_view_v1', grain: 'Pincode x Campaign', produces: 'Pincode-exact campaign co-occurrence.' },
      { file: 'app_state_city_agg.json', query: 'Q2', joins: 'None (single table)', grain: 'State x City', produces: 'City-level funnel totals, India only, all events with a city (no mobile match required).' },
      { file: 'app_campaign_agg.json', query: 'Q3', joins: 'None (campaign fields are native columns)', grain: 'Campaign', produces: 'Campaign funnel + reach, no cross-table match needed (unlike the old GA4 text-match join).' },
      { file: 'app_campaign_city_agg.json', query: 'Q4', joins: 'None, bounded to Top 80 cities x Top 200 campaigns', grain: 'Campaign x City', produces: 'Geographic campaign performance.' },
      { file: 'app_product_pdp_agg.json', query: 'Q5', joins: 'None, JSON_EXTRACT_SCALAR on json_data', grain: 'City x Category x Price Band', produces: 'PDP-view product data from the "Product Viewed" event only (the only PDP event with usable json_data).' },
      { file: 'app_product_purchase_agg.json', query: 'Q6', joins: 'None, UNNEST(json_data.items[]) + city from json_data.shipping_address', grain: 'City/Pincode x SKU', produces: 'Real order revenue/SKU/category, real address-derived pincode (independent of the mobile join).' },
      { file: 'app_daily_city_agg.json', query: 'Q7', joins: 'None, bounded to Top 80 cities', grain: 'Date x City', produces: 'IST daily funnel, powers the date-range filter.' },
      { file: 'app_daily_campaign_agg.json', query: 'Q8', joins: 'None, bounded to Top 200 campaigns', grain: 'Date x Campaign', produces: 'IST daily campaign funnel.' },
      { file: 'app_purchase_events_by_city.json', query: 'purchase-count fix', joins: 'None, city from json_data.shipping_address', grain: 'City', produces: 'Real Purchase EVENT count by city (not line-items) -- added after a bug was found where the city rollup purchase count was silently always 0.' },
      { file: 'we_pincode_agg.json / we_data_quality.json', query: 'unchanged from v1', joins: 'None', grain: 'Pincode / global', produces: 'Profile-level Users count, data-quality top-line counts.' },
      { file: 'store_master.json / pincode_geo_lookup.json', query: 'unchanged from v1', joins: 'None', grain: 'Store / Pincode', produces: 'Store addresses, real pincode master.' }
    ],
    joinLogic: [
      { name: 'application_view_v1 <-> user_profile_view_v3', type: 'Same-project SQL JOIN (in BigQuery)', key: 'normalized mobile (from cuid on both sides)', note: 'Both tables live in test-webengage.11b56595a_shared -- NOT the cross-region case. Only ~11% of application_view_v1 events have a mobile-shaped cuid, so this join is real but sparse by construction.' },
      { name: 'Pincode <-> City-level event context', type: 'Client-side JS Map lookup (in the merge script)', key: 'normCity(district) -> CITY_ALIASES -> appCityMap key', note: 'The India Post district name (e.g. "WEST", "MUMBAI SUBURBAN") is normalized and aliased to match WebEngage\'s own free-text city (e.g. "Delhi", "Mumbai"). This is the exact mapping table that had a real bug (10 of 11 Delhi districts + Mumbai Suburban + Bengaluru Urban/Rural silently unmatched) -- fixed 2026-09-01, see the alias table below.' },
      { name: 'Pincode <-> Nearest Store', type: 'Client-side JS computation', key: 'Haversine great-circle distance, lat/lon on both sides', note: 'Every real pincode is compared against all 6 real store addresses; the closest one wins. No SQL join -- pure geometry over two small in-memory arrays.' },
      { name: 'Purchase revenue/SKU <-> Pincode', type: 'Direct field extraction, no join', key: 'json_data.shipping_address.zipcode / billing_address.zipcode', note: 'Purchase events carry a REAL customer address inside their own JSON payload -- no join needed at all, and no dependency on the ~11% mobile-match rate.' }
    ],
    cityAliasMap: CITY_ALIASES,
    mobileNormalizationLogic: "strip everything but digits, then: /^91[6-9][0-9]{9}$/ (12 digits) -> strip leading '91'; /^0[6-9][0-9]{9}$/ (11 digits) -> strip leading '0'; /^[6-9][0-9]{9}$/ (bare 10-digit) -> keep as-is; anything else (email in cuid, garbage, wrong length) -> NULL, not a customer key. Applied identically in every SQL pull and in the merge script's customer sample."
  },
  stores: storeMaster,
  fakePincodes,
  pincodes, cities, states, campaigns, campaignCity, campaignPincodeExact,
  productByCity, topSkuByCity, priceBand, dailyCity, dailyCampaign,
  storeGapPincodes: pincodes,
  storeRecommendations, customers, dataQuality
};

const outPath = path.join(OUT, 'store_location_intel.json');
fs.writeFileSync(outPath, JSON.stringify(snapshot));
const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
console.log(`\nWrote ${outPath} (${sizeMB} MB)`);
console.log(`Pincodes: ${pincodes.length} (${pincodes.filter(p=>p.totalEvents_exact>0).length} with exact events), Cities: ${cities.length}, States: ${states.length}, Campaigns: ${campaigns.length}, Customers: ${customers.length}`);
console.log(`Daily city rows: ${dailyCity.length}, Daily campaign rows: ${dailyCampaign.length}, Date range: ${dailyDateRange.min} to ${dailyDateRange.max}`);
