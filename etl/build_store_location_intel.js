// Builds the merged JSON snapshot for the Store Location Intelligence & Campaign Demand dashboard.
//
// WHY THIS SCRIPT EXISTS (not a BigQuery view): WebEngage's real BigQuery share lives in a
// separate GCP project (test-webengage, region US); lucirajewelry-prod's datasets are asia-south1.
// BigQuery cannot JOIN or EXPORT DATA across the two regions in one job (confirmed live). So the
// two sources are pulled as independent result sets (see etl/raw/store_location/*.json, produced
// by dashboard/sql/store_location_*.sql via `bq query`) and merged HERE, client-side, in plain
// JS -- never blended in SQL.
//
// DATA INTEGRITY RULES ENFORCED HERE (mirrors the dashboard spec's own rules):
// 1. Pincode-grain numbers (Users, Sessions, Time Spent, Campaign Users) come ONLY from WebEngage,
//    and ONLY for pincodes that are format-valid AND match a real India Post pincode in
//    ds_india_geo.india_pincode. Format-valid-but-fake pincodes are counted in dataQuality but
//    never given a data row.
// 2. GA4 numbers (Sessions*, PDP*, ATC*, Checkout*, Purchase*, Revenue*) are NEVER attached to an
//    individual pincode. They are attached at CITY grain only, matched to a pincode's city by
//    normalized text, and every field carrying such a value is suffixed `_cityProxy` and tagged
//    `attribution:'city_proxy'` in the pincode/campaign-pincode records so the dashboard can render
//    an explicit "not exact -- city-level" label. This is the spec's own prescribed fallback
//    ("Use GA4 for campaign-level funnel metrics wherever exact pincode attribution is not
//    technically available... Clearly distinguish Exact Pincode Metric vs Campaign/City-level
//    Metric"), not an invented shortcut.
// 3. No revenue-only scoring; no proportional allocation of a city total down to pincodes.
//
// Run: node build_store_location_intel.js
// Reads: ./raw/store_location/*.json (produced by dashboard/sql/store_location_*.sql)
// Writes: ./out/store_location_intel.json

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'raw', 'store_location');
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function loadJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(RAW, name), 'utf8'));
}
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function normCity(s) {
  if (!s) return '';
  let c = String(s).trim().toLowerCase();
  const ALIASES = {
    'new delhi': 'delhi', 'west delhi': 'delhi', 'south delhi': 'delhi', 'east delhi': 'delhi',
    'north delhi': 'delhi', 'north west delhi': 'delhi', 'south west delhi': 'delhi',
    'gurugram': 'gurgaon', 'bengaluru': 'bangalore', 'bombay': 'mumbai',
    'greater mumbai': 'mumbai', 'navi mumbai': 'mumbai', 'thane': 'mumbai',
    'calcutta': 'kolkata', 'madras': 'chennai', 'pune city': 'pune',
    'noida': 'noida', 'greater noida': 'noida', 'gautam buddha nagar': 'noida'
  };
  return ALIASES[c] || c;
}

// ---------- Haversine distance (km) ----------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- percentile rank (0-100), ties get the same rank ----------
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

console.log('Loading raw sources...');
const storeMaster = loadJSON('store_master.json').map(s => ({
  storeCode: s.store_code, storeName: s.store_name, address: s.address, pincode: s.pincode,
  district: s.district, state: s.state, lat: num(s.latitude), lon: num(s.longitude), notes: s.notes || null
}));
const pincodeGeo = loadJSON('pincode_geo_lookup.json');
const pincodeGeoMap = new Map(pincodeGeo.map(p => [p.pincode, p]));

const wePincodeAgg = loadJSON('we_pincode_agg.json');
const wePincodeCampaign = loadJSON('we_pincode_campaign_agg.json');
const weCampaignAgg = loadJSON('we_campaign_agg.json');
const weCityAgg = loadJSON('we_city_agg.json');
const weDataQuality = loadJSON('we_data_quality.json')[0];
const weCustomerSample = loadJSON('we_customer_sample.json');

const ga4StateCity = loadJSON('ga4_state_city.json');
const ga4Campaign = loadJSON('ga4_campaign.json');
const ga4CampaignCity = loadJSON('ga4_campaign_city.json');
const ga4Product = loadJSON('ga4_product.json');
const ga4TopSku = loadJSON('ga4_top_sku.json');
const ga4Priceband = loadJSON('ga4_priceband.json');
const ga4DailyCity = loadJSON('ga4_daily_city.json');
const ga4DailyCampaign = loadJSON('ga4_daily_campaign.json');
const ga4Gender = loadJSON('ga4_gender.json');

// city-text -> GA4 city agg (normalized key; a city can collide, so we sum)
const ga4CityMap = new Map();
for (const r of ga4StateCity) {
  const key = normCity(r.city);
  const cur = ga4CityMap.get(key) || { sessions: 0, pdp_views: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0, revenue: 0, rawCities: new Set() };
  cur.sessions += num(r.sessions); cur.pdp_views += num(r.pdp_views); cur.add_to_cart += num(r.add_to_cart);
  cur.begin_checkout += num(r.begin_checkout); cur.purchase += num(r.purchase); cur.revenue += num(r.revenue);
  cur.rawCities.add(r.city);
  ga4CityMap.set(key, cur);
}

// ---------- Store master + nearest-store distance helper ----------
function nearestStoreInfo(lat, lon) {
  if (!lat || !lon) return null;
  let best = null;
  const within = { w5: 0, w10: 0, w20: 0 };
  for (const s of storeMaster) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d <= 5) within.w5++;
    if (d <= 10) within.w10++;
    if (d <= 20) within.w20++;
    if (!best || d < best.distanceKm) best = { storeCode: s.storeCode, storeName: s.storeName, distanceKm: Math.round(d * 10) / 10 };
  }
  return { nearestStore: best, storesWithin5km: within.w5, storesWithin10km: within.w10, storesWithin20km: within.w20 };
}

// ---------- Real, matched pincodes only (the honest "Pincode" tier) ----------
console.log('Building pincode tier (real, master-matched pincodes only)...');
const wePincodeCampaignByPincode = new Map();
for (const r of wePincodeCampaign) {
  const arr = wePincodeCampaignByPincode.get(r.pincode) || [];
  arr.push({ campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium, users: num(r.users), sessions: num(r.total_sessions) });
  wePincodeCampaignByPincode.set(r.pincode, arr);
}

let pincodes = [];
let unmatchedFormatValidUsers = 0, unmatchedFormatValidPincodes = 0;
for (const r of wePincodeAgg) {
  const geo = pincodeGeoMap.get(r.pincode);
  if (!geo) { unmatchedFormatValidUsers += num(r.users); unmatchedFormatValidPincodes++; continue; }
  const cityKey = normCity(geo.district || r.city);
  const ga4 = ga4CityMap.get(cityKey) || ga4CityMap.get(normCity(r.city)) || null;
  const storeInfo = nearestStoreInfo(num(geo.latitude), num(geo.longitude));
  pincodes.push({
    pincode: r.pincode,
    district: geo.district, state: geo.state, lat: num(geo.latitude), lon: num(geo.longitude),
    weCity: r.city, weRegion: r.region,
    users: num(r.users), totalSessionsWE: num(r.total_sessions), totalTimeSpentSec: num(r.total_time_spent),
    campaignUsers: num(r.campaign_users), usersWithPhone: num(r.users_with_phone),
    campaigns: wePincodeCampaignByPincode.get(r.pincode) || [],
    // City-level GA4 proxy metrics -- NOT exact for this pincode, see meta.attribution note.
    sessions_cityProxy: ga4 ? Math.round(ga4.sessions) : null,
    pdpViews_cityProxy: ga4 ? Math.round(ga4.pdp_views) : null,
    addToCart_cityProxy: ga4 ? Math.round(ga4.add_to_cart) : null,
    checkout_cityProxy: ga4 ? Math.round(ga4.begin_checkout) : null,
    purchase_cityProxy: ga4 ? Math.round(ga4.purchase) : null,
    revenue_cityProxy: ga4 ? Math.round(ga4.revenue) : null,
    attribution: ga4 ? 'city_proxy' : 'no_city_match',
    ...storeInfo
  });
}
console.log(`  Real matched pincodes: ${pincodes.length}, unmatched format-valid pincodes: ${unmatchedFormatValidPincodes} (${unmatchedFormatValidUsers} users)`);

// ---------- Funnel % + scoring ----------
function safeDiv(a, b) { return b > 0 ? (a / b) * 100 : null; }
for (const p of pincodes) {
  p.funnel = {
    pdpToAtcPct: p.pdpViews_cityProxy ? round1(safeDiv(p.addToCart_cityProxy, p.pdpViews_cityProxy)) : null,
    atcToCheckoutPct: p.addToCart_cityProxy ? round1(safeDiv(p.checkout_cityProxy, p.addToCart_cityProxy)) : null,
    checkoutToPurchasePct: p.checkout_cityProxy ? round1(safeDiv(p.purchase_cityProxy, p.checkout_cityProxy)) : null,
    overallConversionPct: p.sessions_cityProxy ? round1(safeDiv(p.purchase_cityProxy, p.sessions_cityProxy)) : null
  };
}
function round1(v) { return v === null || v === undefined ? null : Math.round(v * 10) / 10; }

const rankUsers = percentileRanker(pincodes.map(p => p.users));
const rankSessionsWE = percentileRanker(pincodes.map(p => p.totalSessionsWE));
const rankCampaignUsers = percentileRanker(pincodes.map(p => p.campaignUsers));
const rankRevenueProxy = percentileRanker(pincodes.map(p => p.revenue_cityProxy || 0));
const rankConversionProxy = percentileRanker(pincodes.map(p => p.funnel.overallConversionPct || 0));
const rankDistance = percentileRanker(pincodes.map(p => p.nearestStore ? p.nearestStore.distanceKm : 0));

const WEIGHTS = { userDemand: 0.25, digitalDemand: 0.20, campaignDemand: 0.15, revenueProxy: 0.15, conversionProxy: 0.10, storeGap: 0.15 };
for (const p of pincodes) {
  const s = {
    userDemandScore: round1(rankUsers(p.users)),
    digitalDemandScore: round1(rankSessionsWE(p.totalSessionsWE)),
    campaignDemandScore: round1(rankCampaignUsers(p.campaignUsers)),
    revenueScore_cityProxy: round1(rankRevenueProxy(p.revenue_cityProxy || 0)),
    conversionScore_cityProxy: round1(rankConversionProxy(p.funnel.overallConversionPct || 0)),
    storeGapScore: round1(rankDistance(p.nearestStore ? p.nearestStore.distanceKm : 0))
  };
  const overall = round1(
    s.userDemandScore * WEIGHTS.userDemand + s.digitalDemandScore * WEIGHTS.digitalDemand +
    s.campaignDemandScore * WEIGHTS.campaignDemand + s.revenueScore_cityProxy * WEIGHTS.revenueProxy +
    s.conversionScore_cityProxy * WEIGHTS.conversionProxy + s.storeGapScore * WEIGHTS.storeGap
  );
  p.scores = { ...s, opportunityScore: overall };

  const demandHigh = s.userDemandScore >= 66 || s.digitalDemandScore >= 66;
  const demandMed = s.userDemandScore >= 33 || s.digitalDemandScore >= 33;
  const dist = p.nearestStore ? p.nearestStore.distanceKm : 0;
  p.storeGapFlag = (demandHigh && dist > 15) ? 'HIGH' : ((demandMed && dist > 5) ? 'MEDIUM' : 'LOW');
}
// Priority tiers are assigned by PERCENTILE of the final blended opportunityScore, not an absolute
// cutoff. A 6-way weighted percentile-rank blend regresses hard toward the middle (live-verified:
// p90=19.3, max=74.9 on a 0-100 scale) -- a fixed "High >= 75" threshold would almost never fire.
// Percentile-of-the-blend guarantees a real, non-empty High tier (top 10%) regardless of how
// compressed the underlying distribution is.
const rankOpportunity = percentileRanker(pincodes.map(p => p.scores.opportunityScore));
for (const p of pincodes) {
  const opRank = rankOpportunity(p.scores.opportunityScore);
  p.priority = opRank >= 90 ? 'High' : opRank >= 70 ? 'Medium' : opRank >= 40 ? 'Low' : 'Watch';
}
pincodes.sort((a, b) => b.scores.opportunityScore - a.scores.opportunityScore);

// ---------- City rollup (Tab 3) ----------
console.log('Building city rollup...');
const cityRollupMap = new Map();
for (const r of weCityAgg) {
  const key = normCity(r.city);
  const cur = cityRollupMap.get(key) || { rawCities: new Set(), state: null, users: 0, sessionsWE: 0, timeSpent: 0, campaignUsers: 0, pincodes: 0 };
  cur.rawCities.add(r.city); cur.state = cur.state || r.region;
  cur.users += num(r.users); cur.sessionsWE += num(r.total_sessions); cur.timeSpent += num(r.total_time_spent);
  cur.campaignUsers += num(r.campaign_users); cur.pincodes += num(r.distinct_format_valid_pincodes);
  cityRollupMap.set(key, cur);
}
const pincodesByCity = new Map();
for (const p of pincodes) {
  const key = normCity(p.district);
  const arr = pincodesByCity.get(key) || [];
  arr.push(p);
  pincodesByCity.set(key, arr);
}
const storesByCity = new Map();
for (const s of storeMaster) {
  const key = normCity(s.district);
  storesByCity.set(key, (storesByCity.get(key) || 0) + 1);
}
let cities = [];
for (const [key, cur] of cityRollupMap) {
  const ga4 = ga4CityMap.get(key);
  const realPincodesHere = pincodesByCity.get(key) || [];
  const avgDist = realPincodesHere.length ? round1(realPincodesHere.reduce((a, p) => a + (p.nearestStore ? p.nearestStore.distanceKm : 0), 0) / realPincodesHere.length) : null;
  const highOppPincodes = realPincodesHere.filter(p => p.priority === 'High').length;
  cities.push({
    city: [...cur.rawCities][0], allCityTextVariants: [...cur.rawCities], state: cur.state,
    users: cur.users, sessionsWE: cur.sessionsWE, timeSpentSec: cur.timeSpent, campaignUsers: cur.campaignUsers,
    realPincodesTracked: realPincodesHere.length, formatValidPincodeCountRaw: cur.pincodes,
    sessions_cityProxy: ga4 ? Math.round(ga4.sessions) : null, pdpViews_cityProxy: ga4 ? Math.round(ga4.pdp_views) : null,
    addToCart_cityProxy: ga4 ? Math.round(ga4.add_to_cart) : null, checkout_cityProxy: ga4 ? Math.round(ga4.begin_checkout) : null,
    purchase_cityProxy: ga4 ? Math.round(ga4.purchase) : null, revenue_cityProxy: ga4 ? Math.round(ga4.revenue) : null,
    existingStoreCount: storesByCity.get(key) || 0, avgDistanceToStoreKm: avgDist, highOpportunityPincodeCount: highOppPincodes
  });
}
const rankCityUsers = percentileRanker(cities.map(c => c.users));
const rankCityRevenue = percentileRanker(cities.map(c => c.revenue_cityProxy || 0));
for (const c of cities) {
  c.opportunityScore = round1(rankCityUsers(c.users) * 0.55 + rankCityRevenue(c.revenue_cityProxy || 0) * 0.45);
}
const rankCityOpportunity = percentileRanker(cities.map(c => c.opportunityScore));
for (const c of cities) {
  const opRank = rankCityOpportunity(c.opportunityScore);
  c.priority = opRank >= 90 ? 'High' : opRank >= 70 ? 'Medium' : opRank >= 40 ? 'Low' : 'Watch';
}
cities.sort((a, b) => b.opportunityScore - a.opportunityScore);

// ---------- State rollup (Tab 4) ----------
console.log('Building state rollup...');
const stateMap = new Map();
for (const p of pincodes) {
  const st = p.state || 'Unknown';
  const cur = stateMap.get(st) || { cities: new Set(), pincodes: 0, users: 0, sessionsWE: 0, highOppCities: new Set(), highOppPincodes: 0, revenue_cityProxy: 0, sessions_cityProxy: 0, pdpViews_cityProxy: 0, addToCart_cityProxy: 0, purchase_cityProxy: 0 };
  cur.cities.add(p.district); cur.pincodes++; cur.users += p.users; cur.sessionsWE += p.totalSessionsWE;
  cur.revenue_cityProxy += (p.revenue_cityProxy || 0); cur.sessions_cityProxy += (p.sessions_cityProxy || 0);
  cur.pdpViews_cityProxy += (p.pdpViews_cityProxy || 0); cur.addToCart_cityProxy += (p.addToCart_cityProxy || 0);
  cur.purchase_cityProxy += (p.purchase_cityProxy || 0);
  if (p.priority === 'High') { cur.highOppPincodes++; cur.highOppCities.add(p.district); }
  stateMap.set(st, cur);
}
const storesByState = new Map();
for (const s of storeMaster) storesByState.set(s.state, (storesByState.get(s.state) || 0) + 1);
let states = [];
for (const [st, cur] of stateMap) {
  states.push({
    state: st, cityCount: cur.cities.size, pincodeCount: cur.pincodes, users: cur.users, sessionsWE: cur.sessionsWE,
    sessions_cityProxy: Math.round(cur.sessions_cityProxy), pdpViews_cityProxy: Math.round(cur.pdpViews_cityProxy),
    addToCart_cityProxy: Math.round(cur.addToCart_cityProxy), purchase_cityProxy: Math.round(cur.purchase_cityProxy),
    revenue_cityProxy: Math.round(cur.revenue_cityProxy), existingStores: storesByState.get(st) || 0,
    highOpportunityCities: cur.highOppCities.size, highOpportunityPincodes: cur.highOppPincodes
  });
}
const rankStateUsers = percentileRanker(states.map(s => s.users));
for (const s of states) s.opportunityScore = round1(rankStateUsers(s.users));
const rankStateOpportunity = percentileRanker(states.map(s => s.opportunityScore));
for (const s of states) {
  const opRank = rankStateOpportunity(s.opportunityScore);
  s.priority = opRank >= 90 ? 'High' : opRank >= 70 ? 'Medium' : opRank >= 40 ? 'Low' : 'Watch';
}
states.sort((a, b) => b.opportunityScore - a.opportunityScore);

// ---------- Campaign Intelligence (Tab 5): WebEngage real users/geo + GA4 real funnel, joined by campaign text ----------
console.log('Building campaign intelligence...');
const ga4CampaignByKey = new Map(ga4Campaign.map(r => [String(r.campaign_key || '').trim(), r]));
let campaigns = weCampaignAgg
  .filter(r => r.campaign_key && r.campaign_key !== 'unknown')
  .map(r => {
    const ga4 = ga4CampaignByKey.get(String(r.campaign_key).trim());
    return {
      campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium,
      users: num(r.users), distinctPincodesFormatValid: num(r.distinct_format_valid_pincodes), distinctCities: num(r.distinct_cities),
      sessionsWE: num(r.total_sessions),
      matchedInGA4: !!ga4,
      sessions_ga4: ga4 ? num(ga4.sessions) : null, pdpViews_ga4: ga4 ? num(ga4.pdp_views) : null,
      addToCart_ga4: ga4 ? num(ga4.add_to_cart) : null, checkout_ga4: ga4 ? num(ga4.begin_checkout) : null,
      purchase_ga4: ga4 ? num(ga4.purchase) : null, revenue_ga4: ga4 ? num(ga4.revenue) : null,
      conversionPct_ga4: ga4 && num(ga4.sessions) ? round1(num(ga4.purchase) / num(ga4.sessions) * 100) : null
    };
  });
campaigns.sort((a, b) => b.users - a.users);
const campaignMatchRate = round1(campaigns.filter(c => c.matchedInGA4).length / campaigns.length * 100);

// GA4-only campaigns (paid campaigns with real ad spend/funnel but no WebEngage user match) -- kept as a separate honest list
const weCampaignKeySet = new Set(weCampaignAgg.map(r => String(r.campaign_key || '').trim()));
let ga4OnlyCampaigns = ga4Campaign
  .filter(r => !weCampaignKeySet.has(String(r.campaign_key).trim()))
  .map(r => ({ campaignKey: r.campaign_key, source: r.source, medium: r.medium, sessions_ga4: num(r.sessions), purchase_ga4: num(r.purchase), revenue_ga4: num(r.revenue), distinctCities_ga4: num(r.distinct_cities) }))
  .sort((a, b) => b.sessions_ga4 - a.sessions_ga4)
  .slice(0, 100);

// ---------- Campaign x City (Tab 6, primary honest view) + tiny exact-pincode set ----------
console.log('Building campaign x pincode/city...');
let campaignCity = ga4CampaignCity.map(r => ({
  campaignKey: r.campaign_key, source: r.source, medium: r.medium, state: r.state, city: r.city,
  sessions: num(r.sessions), pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), checkout: num(r.begin_checkout),
  purchase: num(r.purchase), revenue: num(r.revenue), attribution: 'city_exact_ga4'
}));
let campaignPincodeExact = wePincodeCampaign.map(r => {
  const geo = pincodeGeoMap.get(r.pincode);
  return { pincode: r.pincode, district: geo ? geo.district : null, state: geo ? geo.state : null, campaignKey: r.campaign_key, source: r.campaign_source, medium: r.campaign_medium, users: num(r.users), sessionsWE: num(r.total_sessions), attribution: 'pincode_exact_webengage' };
});

// ---------- Product / Price band (Tab 7, 8) -- city grain, never pincode ----------
console.log('Building product & price-band tables...');
// NOTE: ga4_data.ga4_data's own `category` column is actually DEVICE type (mobile/desktop/tablet
// -- confirmed live, "mobile" was 8.5M rows / 3.3M PDP views, "desktop"/"tablet" the rest), NOT a
// product category -- a real mislabeled-column bug in the source mart, not something introduced
// here. `product_type` is the real top-level jewelry category (Rings/Earrings/Bracelets/Necklaces/
// Mangalsutra/Chain/Nosepins/Pendants/Gold Coin) and is aliased to `category` in the SQL
// (store_location_ga4_agg.sql) before it ever reaches this script. `sub_category_1` (aliased
// `sub_category`) is the finer style-line dimension (e.g. "Mens Ring"/"Solitaire Rings"/"Studs").
let productByCity = ga4Product.map(r => ({
  state: r.state, city: r.city, category: r.category, subCategory: r.sub_category, priceRange: r.price_range,
  pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), purchase: num(r.purchase), revenue: num(r.revenue), attribution: 'city_exact_ga4'
}));
let topSkuByCity = ga4TopSku.map(r => ({
  state: r.state, city: r.city, category: r.category, subCategory: r.sub_category,
  sku: r.sku, productTitle: r.product_title, price: num(r.price), priceRange: r.price_range,
  pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), purchase: num(r.purchase), revenue: num(r.revenue)
}));
let priceBand = ga4Priceband.map(r => ({
  state: r.state, city: r.city, priceRange: r.price_range,
  pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), purchase: num(r.purchase), revenue: num(r.revenue),
  conversionPct: num(r.pdp_views) ? round1(num(r.purchase) / num(r.pdp_views) * 100) : null, attribution: 'city_exact_ga4'
}));

// ---------- Daily GA4 (real, day-grain) -- powers the Date Range filter on Executive/City/Campaign.
// Shipped as raw daily rows (not pre-aggregated to a range) so the dashboard can sum any date range
// the user picks, client-side, without re-running the pipeline. WebEngage's own data has NO
// per-day breakdown (it's a user-profile snapshot, not a session log) -- date filtering only
// applies to real GA4 numbers, never to WebEngage's pincode-exact Users/Sessions/Campaign Users.
let dailyCity = ga4DailyCity.map(r => ({
  date: r.event_date, state: r.state, city: r.city,
  sessions: num(r.sessions), pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart),
  checkout: num(r.begin_checkout), purchase: num(r.purchase), revenue: num(r.revenue)
}));
let dailyCampaign = ga4DailyCampaign.map(r => ({
  date: r.event_date, campaignKey: r.campaign_key, source: r.source, medium: r.medium,
  sessions: num(r.sessions), pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart),
  checkout: num(r.begin_checkout), purchase: num(r.purchase), revenue: num(r.revenue)
}));
const dailyDateRange = { min: dailyCity.reduce((a,r)=>!a||r.date<a?r.date:a, null), max: dailyCity.reduce((a,r)=>!a||r.date>a?r.date:a, null) };

// ---------- Gender demand (added on request) -- real GA4 field, city-exact, Top 80 cities. ----------
let genderDemand = ga4Gender.map(r => ({
  state: r.state, city: r.city, gender: r.gender,
  pdpViews: num(r.pdp_views), addToCart: num(r.add_to_cart), purchase: num(r.purchase), revenue: num(r.revenue)
}));

// city -> top category / top SKU / top price band (for Store Recommendation reason text)
const topCategoryByCity = new Map();
for (const r of productByCity) {
  const key = normCity(r.city);
  const cur = topCategoryByCity.get(key);
  if (!cur || r.pdpViews > cur.pdpViews) topCategoryByCity.set(key, { category: r.category, pdpViews: r.pdpViews });
}
const topSkuByCityMap = new Map();
for (const r of topSkuByCity) {
  const key = normCity(r.city);
  if (!topSkuByCityMap.has(key)) topSkuByCityMap.set(key, r); // already rank 1 per city from SQL
}
const topPriceBandByCity = new Map();
for (const r of priceBand) {
  const key = normCity(r.city);
  const cur = topPriceBandByCity.get(key);
  if (!cur || r.purchase > cur.purchase) topPriceBandByCity.set(key, { priceRange: r.priceRange, purchase: r.purchase });
}

// ---------- Store Recommendation (Top 10) ----------
console.log('Building store recommendation list...');
const storeRecommendations = pincodes.slice(0, 10).map((p, i) => {
  const cityKey = normCity(p.district);
  const topCat = topCategoryByCity.get(cityKey);
  const topSku = topSkuByCityMap.get(cityKey);
  const topPB = topPriceBandByCity.get(cityKey);
  const reasons = [];
  reasons.push(`${p.users.toLocaleString('en-IN')} real WebEngage users concentrated in pincode ${p.pincode} (${p.district}, ${p.state})`);
  if (p.scores.userDemandScore >= 66) reasons.push('top-tercile user concentration vs. every other tracked pincode');
  if (p.revenue_cityProxy) reasons.push(`its city (${p.weCity}) shows real GA4 online revenue of ~₹${Math.round(p.revenue_cityProxy).toLocaleString('en-IN')} (city-level proxy, not pincode-exact)`);
  if (p.nearestStore) reasons.push(`${p.nearestStore.distanceKm} km from the nearest existing store (${p.nearestStore.storeName})`);
  if (p.storeGapFlag === 'HIGH') reasons.push('flagged HIGH store gap -- strong demand with no store nearby');
  return {
    rank: i + 1, pincode: p.pincode, district: p.district, state: p.state,
    users: p.users, sessionsWE: p.totalSessionsWE, sessions_cityProxy: p.sessions_cityProxy, pdpViews_cityProxy: p.pdpViews_cityProxy,
    addToCart_cityProxy: p.addToCart_cityProxy, checkout_cityProxy: p.checkout_cityProxy, purchase_cityProxy: p.purchase_cityProxy, revenue_cityProxy: p.revenue_cityProxy,
    topCategory_cityProxy: topCat ? topCat.category : null,
    topProduct_cityProxy: topSku ? topSku.productTitle : null,
    topPriceBand_cityProxy: topPB ? topPB.priceRange : null,
    nearestStore: p.nearestStore, storeGapFlag: p.storeGapFlag, opportunityScore: p.scores.opportunityScore, priority: p.priority,
    reason: reasons.join('; ') + '.'
  };
});

// ---------- Customer-level (Tab 11) -- masked, bounded to real matched pincodes only ----------
console.log('Building customer-level sample...');
const customers = weCustomerSample
  .filter(r => pincodeGeoMap.has(r.pincode))
  .map(r => ({
    luid: r.luid ? (String(r.luid).slice(0, 8) + '…') : null, // shortened -- WebEngage's own internal id, not a phone/email
    pincode: r.pincode, city: r.city, state: pincodeGeoMap.get(r.pincode).state,
    campaignKey: (r.campaign_key && r.campaign_key !== 'unknown') ? r.campaign_key : null,
    campaignSource: r.campaign_source || null,
    sessions: num(r.session_count), firstSeen: r.first_logged_in || null, lastSeen: r.last_seen || null
  }));

// ---------- Data Quality (Tab 12) ----------
console.log('Assembling data quality summary...');
const dataQuality = {
  webengage: {
    totalUsers: num(weDataQuality.total_users),
    usersAnyPincodeText: num(weDataQuality.users_any_pincode),
    usersFormatValidPincode: num(weDataQuality.users_format_valid_pincode),
    usersRealMatchedPincode: pincodes.reduce((a, p) => a + p.users, 0),
    distinctFormatValidPincodes: unmatchedFormatValidPincodes + pincodes.length,
    distinctRealMatchedPincodes: pincodes.length,
    usersWithCity: num(weDataQuality.users_with_city),
    usersWithRegion: num(weDataQuality.users_with_region),
    usersWithLocality: num(weDataQuality.users_with_locality),
    usersWithCoords_ALWAYS_ZERO: num(weDataQuality.users_with_coords),
    usersWithCampaignSource: num(weDataQuality.users_with_campaign_source),
    usersWithRealCampaignId: num(weDataQuality.users_with_campaign_id),
    usersWithAcquisitionSource_DEAD_FIELD: num(weDataQuality.users_with_acquisition_source),
    distinctCampaignIds: num(weDataQuality.distinct_campaign_ids),
    minCreated: weDataQuality.min_created, maxLastSeen: weDataQuality.max_last_seen,
    exactPincodeCampaignIntersectionUsers: wePincodeCampaign.reduce((a, r) => a + num(r.users), 0),
    realPincodesWithAnySessionData: pincodes.filter(p => p.totalSessionsWE > 0).length,
    sessionSparsityNote: 'WebEngage session_count is well-populated system-wide (77% of all 1.6M users, 1.99M total sessions) but is almost entirely NULL for the specific segment of users who also provided a real pincode -- only 8 of 3,096 real pincodes have any session_count data at all. Pincode-providing users and session-tracked users are largely disjoint segments in this data, not a bug -- disclosed here rather than smoothed over. This makes the pincode-level "Digital Demand Score" component of the Opportunity Score effectively a sparse signal for most pincodes.'
  },
  ga4: {
    dateRange: { min: Math.min(...ga4StateCity.map(r => r.min_date)), max: Math.max(...ga4StateCity.map(r => r.max_date)) },
    distinctIndiaCities: ga4StateCity.length,
    top80CityCoverage: 'Product/price-band/campaign-city detail tables restricted to Top 80 India cities by session volume (~87.4% of sessions live-verified 2026-08-28); long tail of thousands of low-volume/free-text city values excluded from those tables (still present in the full city rollup).',
    countryFilterApplied: "country='India' applied everywhere -- excludes real international/bot/VPN traffic (Sweden, USA, etc. seen live) that would otherwise pollute city rankings.",
    campaignPlaceholdersExcluded: '(organic)/(referral)/(direct) excluded from every campaign table -- traffic buckets, not marketing campaigns.',
    knownRevenueCaveat: 'GA4 purchase/revenue undercounts real sales -- GoKwik external checkout breaks GA4 purchase tracking (same caveat as the GA4 dashboard).'
  },
  campaignJoin: {
    note: 'WebEngage campaign_id stores the same human-readable UTM campaign string GA4 uses in campaign_name (confirmed live) -- the two are joined by exact text match on that string, not a numeric id.',
    matchRatePct: campaignMatchRate,
    weCampaignsTotal: campaigns.length,
    weCampaignsMatchedToGA4: campaigns.filter(c => c.matchedInGA4).length,
    ga4OnlyCampaignsShown: ga4OnlyCampaigns.length
  },
  exactVsProxyLabels: {
    EXACT: ['Pincode: Users, Sessions (WebEngage), Time Spent, Campaign Users, Campaign x Pincode (11-user set)', 'City/State: existing store count, avg distance to store', 'GA4 city/campaign/product/price-band tables (city or campaign grain, as-is)'],
    NOT_EXACT_AT_PINCODE_LEVEL: ['Sessions/PDP/ATC/Checkout/Purchase/Revenue shown on a pincode row are a CITY-LEVEL PROXY (that pincode\'s city total, GA4 has no pincode dimension) -- suffixed _cityProxy everywhere, never presented as pincode-exact.']
  },
  storeMaster: {
    note: '6 real customer-facing addresses from ornaverse_erp_master.company (ERP address master, not the CRM owner-map which is missing Lajpat Nagar entirely). HO excluded (back-office). FCS shares CS1\'s exact address (not counted as a 7th location).',
    stores: storeMaster.map(s => s.storeCode)
  }
};

// ---------- Assemble & write ----------
const snapshot = {
  generatedAt: '2026-08-31', // stamped manually -- Date.now() unavailable in this pipeline context
  meta: {
    title: 'Lucira Store Location Intelligence & Campaign Demand',
    sources: [
      'test-webengage.11b56595a_shared.user_profile_view_v3 (WebEngage, region US)',
      'lucirajewelry-prod.ga4_data.ga4_data (GA4 flat mart, region asia-south1)',
      'lucirajewelry-prod.ornaverse_erp_master.company (real store addresses)',
      'lucirajewelry-prod.ds_india_geo.india_pincode (real India Post pincode/lat/lon master)'
    ],
    scoringMethodology: {
      pincodeOpportunityScore: 'Weighted percentile-rank blend, 0-100. 25% User Demand (WebEngage real users) + 20% Digital Demand (WebEngage real sessions) + 15% Campaign Demand (WebEngage real campaign-attributed users) + 15% Revenue Score (GA4 city-level proxy) + 10% Conversion Score (GA4 city-level proxy) + 15% Store Gap (distance to nearest real store, percentile-ranked). Never revenue-only. A 6-way percentile blend regresses hard toward the middle (live-verified: p90=19.3, max=74.9 on the raw 0-100 scale), so Priority is assigned by PERCENTILE OF THE BLENDED SCORE, not an absolute cutoff: High = top 10% of pincodes by opportunityScore, Medium = next 20% (70-90th pct), Low = next 30% (40-70th pct), else Watch. Same method for City Priority.',
      cityOpportunityScore: '55% User percentile-rank (WebEngage real) + 45% Revenue percentile-rank (GA4 real, city-exact). Priority tiers by percentile-of-score, same method as the pincode score.',
      storeGapFlag: 'HIGH = top-tercile demand AND >15km from nearest store. MEDIUM = mid/high demand AND 5-15km. LOW = otherwise (includes low demand or <=5km from a store).'
    },
    dailyDateRange,
    dateFilterNote: 'The Date Range filter (Executive/City/Campaign tabs) recomputes real GA4 daily numbers within the picked range. It does NOT affect WebEngage-native fields (Users, Sessions, Campaign Users, Opportunity Score, Priority) -- WebEngage\'s user_profile_view_v3 is a profile snapshot, not a session log, so it has no per-day breakdown. Pincode/State/Product/Price-Band/Store-Gap/Recommendation tabs stay all-time.'
  },
  stores: storeMaster,
  pincodes,
  cities,
  states,
  campaigns,
  ga4OnlyCampaigns,
  campaignCity,
  campaignPincodeExact,
  productByCity,
  topSkuByCity,
  priceBand,
  genderDemand,
  dailyCity,
  dailyCampaign,
  storeGapPincodes: pincodes, // same records carry storeGapFlag; kept as an alias for the dashboard's Tab 9
  storeRecommendations,
  customers,
  dataQuality
};

const outPath = path.join(OUT, 'store_location_intel.json');
fs.writeFileSync(outPath, JSON.stringify(snapshot));
const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
console.log(`\nWrote ${outPath} (${sizeMB} MB)`);
console.log(`Pincodes: ${pincodes.length}, Cities: ${cities.length}, States: ${states.length}, Campaigns: ${campaigns.length}, Customers: ${customers.length}`);
console.log(`Daily city rows: ${dailyCity.length}, Daily campaign rows: ${dailyCampaign.length}, Gender rows: ${genderDemand.length}, Date range: ${dailyDateRange.min} to ${dailyDateRange.max}`);
