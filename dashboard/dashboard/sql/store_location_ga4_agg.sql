-- Builds the GA4-side reporting tables in ds_imputed_reporting for the Store Location Intelligence
-- dashboard. Source: lucirajewelry-prod.ga4_data.ga4_data (the existing flat marketing x product
-- mart, 9.9M rows, 2025-05-03..2026-08-26 -- same range as the raw events_* tables). We use this
-- mart rather than re-scanning ~480 daily raw events_* shards, because every field the spec asks
-- for at city/campaign grain (sessions/pdp_views/add_to_cart/begin_checkout/purchase/revenue,
-- campaign_id/name/source/medium, sku/category/price_range) already exists here pre-aggregated.
--
-- Business rule enforced everywhere below: GA4 has NO pincode dimension and NO user identifier.
-- Every table here is grouped at CITY/STATE and/or CAMPAIGN grain only -- never pincode, never
-- allocated/split across pincodes. The dashboard build script joins these to the WebEngage
-- pincode-grain aggregates by matching city/state text or campaign identity, but always keeps the
-- two tagged separately rather than blending into one fabricated pincode number.
--
-- Real, known caveats carried into every table:
-- 1. country='India' is filtered everywhere -- GA4's geo resolution captures real international
--    traffic (VPNs, bots, diaspora -- confirmed live, e.g. a "Lulea, Sweden" row with real session
--    volume) that would otherwise pollute a "top Indian cities for store expansion" ranking.
--    India is 14.40M/14.62M sessions (98.6%) live-verified -- excluding the rest is a real fix,
--    not a meaningful data loss.
-- 2. Even within India, city/state text is free-text from GA4's own geo resolution (thousands of
--    distinct city values, many non-canonical/junk) -- not cleaned here, left for the dashboard's
--    Data Quality tab to disclose.
-- 3. GA4's own default channel labels ((organic)/(referral)/(direct)) are excluded from every
--    campaign table -- they are traffic buckets, not marketing campaigns.
-- 4. GA4 purchase/revenue undercounts real sales (GoKwik external checkout breaks GA4 purchase
--    tracking -- same documented caveat as lucira-ga4-dashboard).
--
-- Detail tables (product/price-band/campaign-city/top-sku) are restricted to the Top 80 India
-- cities by session volume -- covers 12.45M/14.24M sessions (87.4%) live-verified. Without this
-- cutoff a full state x city x category x...x SKU cross join produced 450K+ rows / ~39MB JSON,
-- too large to ship into a browser dashboard usefully, and most of the excluded "cities" are
-- one-off free-text noise anyway. This cutoff and its coverage % is disclosed in the Data Quality tab.
--
-- Cost: ~700MB-1.1GB scanned per table (single mart, no raw event scan). Cadence: NOT scheduled
-- yet -- rerun manually via `bq query --use_legacy_sql=false --project_id=lucirajewelry-prod < store_location_ga4_agg.sql`.

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_state_city_agg` AS
SELECT
  state, city,
  SUM(sessions) AS sessions,
  SUM(pdp_views) AS pdp_views,
  SUM(add_to_cart) AS add_to_cart,
  SUM(begin_checkout) AS begin_checkout,
  SUM(purchase) AS purchase,
  SUM(revenue) AS revenue,
  COUNT(DISTINCT campaign_id) AS distinct_campaigns,
  MIN(event_date) AS min_date, MAX(event_date) AS max_date
FROM `lucirajewelry-prod.ga4_data.ga4_data`
WHERE city IS NOT NULL AND city != '' AND state IS NOT NULL AND state != '' AND country = 'India'
GROUP BY state, city;

-- Top 80 India cities by session volume, used to bound every detail table below (kept as a
-- separate table with city_rank<=200 stored for reference/lookup use in the dashboard).
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` AS
SELECT city, state, sessions, RANK() OVER (ORDER BY sessions DESC) AS city_rank
FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_state_city_agg`
QUALIFY city_rank <= 200;

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_campaign_agg` AS
SELECT
  campaign_id, campaign_name AS campaign_key, source, medium,
  SUM(sessions) AS sessions,
  SUM(pdp_views) AS pdp_views,
  SUM(add_to_cart) AS add_to_cart,
  SUM(begin_checkout) AS begin_checkout,
  SUM(purchase) AS purchase,
  SUM(revenue) AS revenue,
  COUNT(DISTINCT city) AS distinct_cities,
  COUNT(DISTINCT state) AS distinct_states,
  MIN(event_date) AS min_date, MAX(event_date) AS max_date
FROM `lucirajewelry-prod.ga4_data.ga4_data`
WHERE campaign_name IS NOT NULL AND campaign_name NOT IN ('', '(not set)', '(organic)', '(referral)', '(direct)')
  AND country = 'India'
GROUP BY campaign_id, campaign_name, source, medium;

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_campaign_city_agg` AS
SELECT
  d.campaign_name AS campaign_key, d.source, d.medium, d.state, d.city,
  SUM(d.sessions) AS sessions,
  SUM(d.pdp_views) AS pdp_views,
  SUM(d.add_to_cart) AS add_to_cart,
  SUM(d.begin_checkout) AS begin_checkout,
  SUM(d.purchase) AS purchase,
  SUM(d.revenue) AS revenue
FROM `lucirajewelry-prod.ga4_data.ga4_data` d
JOIN (SELECT city, state FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` WHERE city_rank <= 80) t
  ON t.city = d.city AND t.state = d.state
WHERE d.campaign_name IS NOT NULL AND d.campaign_name NOT IN ('', '(not set)', '(organic)', '(referral)', '(direct)')
  AND d.country = 'India'
GROUP BY d.campaign_name, d.source, d.medium, d.state, d.city;

-- Category-level product demand (no SKU grain here -- kept bounded/table-friendly).
-- IMPORTANT: ga4_data.ga4_data's own `category` column is actually DEVICE type
-- (mobile/desktop/tablet/smart tv -- confirmed live: "mobile" alone is 8.5M rows / 3.3M PDP views),
-- NOT a product category. The real top-level jewelry taxonomy is `product_type`
-- (Rings/Earrings/Bracelets/Necklaces/Mangalsutra/Chain/Nosepins/Pendants/Gold Coin), aliased to
-- `category` below; `sub_category_1` (aliased `sub_category`) is the finer style-line dimension
-- (e.g. "Mens Ring"/"Solitaire Rings"/"Studs"). Never select the raw `category` column for
-- anything product-related in this pipeline.
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_product_agg` AS
SELECT
  d.state, d.city,
  d.product_type AS category, d.sub_category_1 AS sub_category, d.price_range,
  SUM(d.pdp_views) AS pdp_views,
  SUM(d.add_to_cart) AS add_to_cart,
  SUM(d.purchase) AS purchase,
  SUM(d.revenue) AS revenue
FROM `lucirajewelry-prod.ga4_data.ga4_data` d
JOIN (SELECT city, state FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` WHERE city_rank <= 80) t
  ON t.city = d.city AND t.state = d.state
WHERE d.sku IS NOT NULL AND d.sku != '' AND d.country = 'India'
GROUP BY d.state, d.city, d.product_type, d.sub_category_1, d.price_range;

-- Top 10 SKUs per city by PDP views -- bounded leaf-level "what should a new store stock" detail,
-- kept separate from the category table above so the main product table stays small. Same
-- category/sub_category aliasing as above.
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_sku_agg` AS
SELECT * EXCEPT(sku_rank) FROM (
  SELECT
    d.state, d.city, d.product_type AS category, d.sub_category_1 AS sub_category,
    d.sku, d.product_title, d.price, d.price_range,
    SUM(d.pdp_views) AS pdp_views, SUM(d.add_to_cart) AS add_to_cart,
    SUM(d.purchase) AS purchase, SUM(d.revenue) AS revenue,
    RANK() OVER (PARTITION BY d.state, d.city ORDER BY SUM(d.pdp_views) DESC) AS sku_rank
  FROM `lucirajewelry-prod.ga4_data.ga4_data` d
  JOIN (SELECT city, state FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` WHERE city_rank <= 80) t
    ON t.city = d.city AND t.state = d.state
  WHERE d.sku IS NOT NULL AND d.sku != '' AND d.country = 'India'
  GROUP BY d.state, d.city, d.product_type, d.sub_category_1, d.sku, d.product_title, d.price, d.price_range
)
WHERE sku_rank <= 10;

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_priceband_agg` AS
SELECT
  d.state, d.city, d.price_range,
  SUM(d.pdp_views) AS pdp_views,
  SUM(d.add_to_cart) AS add_to_cart,
  SUM(d.purchase) AS purchase,
  SUM(d.revenue) AS revenue
FROM `lucirajewelry-prod.ga4_data.ga4_data` d
JOIN (SELECT city, state FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` WHERE city_rank <= 80) t
  ON t.city = d.city AND t.state = d.state
WHERE d.price_range IS NOT NULL AND d.price_range != '' AND d.country = 'India'
GROUP BY d.state, d.city, d.price_range;

-- Daily grain, added on request for a real (non-cosmetic) Date Range filter. Bounded to the Top 80
-- cities (34,051 rows, 483 days live-verified) -- small enough to ship, unlike a full India-wide
-- daily city cross product. Powers the Executive and City tabs' date filter.
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_daily_city_agg` AS
SELECT
  d.event_date, d.state, d.city,
  SUM(d.sessions) AS sessions, SUM(d.pdp_views) AS pdp_views, SUM(d.add_to_cart) AS add_to_cart,
  SUM(d.begin_checkout) AS begin_checkout, SUM(d.purchase) AS purchase, SUM(d.revenue) AS revenue
FROM `lucirajewelry-prod.ga4_data.ga4_data` d
JOIN (SELECT city, state FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` WHERE city_rank <= 80) t
  ON t.city = d.city AND t.state = d.state
WHERE d.country = 'India'
GROUP BY d.event_date, d.state, d.city;

-- Daily grain for campaigns (33,318 rows) -- powers the Campaign tab's date filter. Not bounded to
-- Top 80 cities (campaigns are explicitly cross-India by the spec's own rule), but IS bounded to
-- real named campaigns (excludes organic/referral/direct placeholders, same as ga4_geo_campaign_agg).
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_daily_campaign_agg` AS
SELECT
  d.event_date, d.campaign_name AS campaign_key, d.source, d.medium,
  SUM(d.sessions) AS sessions, SUM(d.pdp_views) AS pdp_views, SUM(d.add_to_cart) AS add_to_cart,
  SUM(d.begin_checkout) AS begin_checkout, SUM(d.purchase) AS purchase, SUM(d.revenue) AS revenue
FROM `lucirajewelry-prod.ga4_data.ga4_data` d
WHERE d.campaign_name IS NOT NULL AND d.campaign_name NOT IN ('', '(not set)', '(organic)', '(referral)', '(direct)')
  AND d.country = 'India'
GROUP BY d.event_date, d.campaign_name, d.source, d.medium;

-- Gender demand (added on request) -- real GA4 field, values Women/Men/Unisex/Kids (live-verified,
-- Women dominant at 2.6M of ~3.46M total PDP views). Top 80 cities, all-time (not daily -- kept
-- bounded/simple; ask if a date-filtered version is ever needed).
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_gender_agg` AS
SELECT
  d.state, d.city, d.gender,
  SUM(d.pdp_views) AS pdp_views, SUM(d.add_to_cart) AS add_to_cart,
  SUM(d.purchase) AS purchase, SUM(d.revenue) AS revenue
FROM `lucirajewelry-prod.ga4_data.ga4_data` d
JOIN (SELECT city, state FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_geo_top_cities` WHERE city_rank <= 80) t
  ON t.city = d.city AND t.state = d.state
WHERE d.sku IS NOT NULL AND d.sku != '' AND d.country = 'India' AND d.gender IS NOT NULL
GROUP BY d.state, d.city, d.gender;

-- Dedupe ds_india_geo.india_pincode to one row per pincode -- see store_location_store_master.sql
-- header for the documented "some office rows have real geocoding errors" caveat this addresses.
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup` AS
SELECT pincode, district, statename AS state, latitude, longitude, officename
FROM (
  SELECT pincode, district, statename, latitude, longitude, officename,
    ROW_NUMBER() OVER (
      PARTITION BY pincode
      ORDER BY (CASE WHEN ENDS_WITH(officename,'HO') OR ENDS_WITH(officename,'H.O') OR ENDS_WITH(officename,'H.O.') THEN 0 ELSE 1 END), officename
    ) AS rn
  FROM `lucirajewelry-prod.ds_india_geo.india_pincode`
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
)
WHERE rn = 1;
