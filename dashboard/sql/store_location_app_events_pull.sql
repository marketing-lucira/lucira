-- Store Location Intelligence — WebEngage `application_view_v1` pull (replaces GA4 entirely).
-- GA4 (`lucirajewelry-prod.ga4_data.ga4_data`) has ZERO dependency in this pipeline as of 2026-09-01.
--
-- Every query below runs with --project_id=lucirajewelry-prod as BILLING project even though the
-- FROM table lives in `test-webengage` (region US) -- same cross-region billing rule as the old
-- WebEngage pull. UNLIKE the old GA4 pull, `application_view_v1` and `user_profile_view_v3` are
-- BOTH in `test-webengage.11b56595a_shared`, so joining them together for pincode enrichment is a
-- SAME-PROJECT join (confirmed live) -- no cross-region issue there. The cross-region rule only
-- blocks a `test-webengage` result from being JOINed or WRITTEN into a `lucirajewelry-prod` table
-- in the same job (confirmed live: a persistent lucirajewelry-prod UDF call fails with "Function
-- not found" the moment a test-webengage table appears in the FROM clause) -- so mobile
-- normalization is INLINED as a CASE expression in every query below, not a shared UDF.
--
-- MOBILE NORMALIZATION (Tier 1 customer key, applied identically everywhere below):
--   strip everything but digits -> then:
--     ^91[6-9][0-9]{9}$ (12 digits, 91 + valid 10-digit mobile) -> strip leading "91"
--     ^0[6-9][0-9]{9}$  (11 digits, leading 0)                  -> strip leading "0"
--     ^[6-9][0-9]{9}$   (bare 10-digit, already valid)          -> keep as-is
--     anything else (email in cuid, garbage, too short/long)    -> NULL, not a customer key
-- `cuid` is the only mobile-shaped field on both tables (no separate `phone` column on
-- application_view_v1; user_profile_view_v3 has both `cuid`/`phone`, always identical when set,
-- confirmed live -- cuid is preferred as it's populated slightly more often, occasionally holding
-- an email when phone is absent).
--
-- EVENT MAPPING (screenshot -> real event_name, verified against live counts 2026-09-01):
--   Wish_list  -> addToWishlist
--   ATC        -> addToCart            (Added To Cart / nitro_addtocart / Cart Updated are a
--                                        SEPARATE, NOT-combined near-duplicate cluster -- screenshot
--                                        only names addToCart, so only addToCart is counted as ATC)
--   PDP View   -> productView + Product Viewed (screenshot maps BOTH to "PDP View" -- combined,
--                                        not double counted as two metrics)
--   Check_out  -> begin_checkout
--   Purchase   -> Purchase (capitalized; lowercase `purchase` / Order Completed / Order updated
--                                        are separate near-duplicate order-lifecycle events, not
--                                        folded in -- flagged in Data Quality, not assumed identical)
--
-- REAL, LOAD-BEARING GAPS (confirmed live, disclosed in the dashboard's Data Quality tab, not hidden):
--  1. postal_code is 0% populated on application_view_v1 (13.26M rows, zero) -- pincode geography
--     for events comes ONLY from the mobile-join to user_profile_view_v3's real-pincode-matched
--     postal_code, so pincode-grain rows exist only for the ~11% of events with a valid mobile
--     `cuid` that ALSO matches a real India Post pincode via the profile table.
--  2. cuid (mobile) covers only ~11% of all 13.26M event rows; `luid` (anonymous device id) covers
--     100% but is NOT joinable to user_profile_view_v3's luid (confirmed live: 32-char vs 40-char
--     hash, different ID namespaces) -- so 89% of events are real but only usable as anonymous
--     event-count volume, never linkable to a phone-identified customer or a pincode.
--  3. addToCart has 0% json_data (no product/category ever available for ATC).
--     productView (camelCase) json_data is only 1.2% populated and even then only has an image URL
--     (no category/price) -- Product Viewed (Title Case, 100% json coverage) is the only reliable
--     PDP-view-level product/category/price source. begin_checkout json_data is ~49% populated.
--     Purchase json_data is 100% populated. Category/price on ATC and on productView-only rows is
--     genuinely NOT AVAILABLE, not estimated.
--  4. No `gender` field exists anywhere on application_view_v1 -- the old GA4 Gender Demand table
--     has no WebEngage equivalent and is marked unavailable, not faked.
--
-- Cadence: NOT scheduled -- rerun manually via
--   bq query --use_legacy_sql=false --format=json --project_id=lucirajewelry-prod --max_rows=500000 < <one query at a time>

-- ════════════════════════════════════════════════════════════════════════
-- Q1: Pincode-exact funnel agg (event-level, via mobile join to user_profile_view_v3)
-- ════════════════════════════════════════════════════════════════════════
WITH profile_geo AS (
  SELECT DISTINCT
    CASE
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
      ELSE NULL
    END AS mobile,
    postal_code
  FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
  WHERE cuid IS NOT NULL AND postal_code IS NOT NULL AND REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')
),
app_mobile AS (
  SELECT
    CASE
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
      ELSE NULL
    END AS mobile,
    event_name, campaign_id, campaign_source, campaign_medium, total_page_view_count, session_count
  FROM `test-webengage.11b56595a_shared.application_view_v1`
  WHERE cuid IS NOT NULL
)
SELECT
  p.postal_code AS pincode,
  SUM(CASE WHEN a.event_name IN ('productView','Product Viewed') THEN a.total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN a.event_name = 'addToCart' THEN a.session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(a.event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(a.event_name = 'Purchase') AS purchase,
  COUNTIF(a.event_name = 'addToWishlist') AS wishlist,
  COUNT(*) AS total_events,
  COUNT(DISTINCT a.mobile) AS unique_customers,
  COUNTIF(a.campaign_id IS NOT NULL AND a.campaign_id != '') AS campaign_events
FROM app_mobile a JOIN profile_geo p ON a.mobile = p.mobile
GROUP BY pincode;

-- ════════════════════════════════════════════════════════════════════════
-- Q2: City/State funnel agg (India only, all events with a city, no mobile match required)
-- ════════════════════════════════════════════════════════════════════════
SELECT
  region AS state, city,
  SUM(CASE WHEN event_name IN ('productView','Product Viewed') THEN total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN event_name = 'addToCart' THEN session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(event_name = 'Purchase') AS purchase,
  COUNTIF(event_name = 'addToWishlist') AS wishlist,
  COUNT(*) AS total_events,
  COUNT(DISTINCT luid) AS unique_devices,
  MIN(DATE(event_time, 'Asia/Kolkata')) AS min_date, MAX(DATE(event_time, 'Asia/Kolkata')) AS max_date
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE country = 'India' AND city IS NOT NULL AND city != ''
GROUP BY state, city;

-- ════════════════════════════════════════════════════════════════════════
-- Q3: Campaign agg (campaign fields are native columns on application_view_v1 -- no join needed)
-- ════════════════════════════════════════════════════════════════════════
SELECT
  campaign_id AS campaign_key, campaign_source, campaign_medium,
  SUM(CASE WHEN event_name IN ('productView','Product Viewed') THEN total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN event_name = 'addToCart' THEN session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(event_name = 'Purchase') AS purchase,
  COUNT(*) AS total_events,
  COUNT(DISTINCT luid) AS unique_devices,
  COUNT(DISTINCT city) AS distinct_cities
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE campaign_id IS NOT NULL AND campaign_id != ''
GROUP BY campaign_id, campaign_source, campaign_medium;

-- ════════════════════════════════════════════════════════════════════════
-- Q4: Campaign x City agg (India only)
-- ════════════════════════════════════════════════════════════════════════
SELECT
  campaign_id AS campaign_key, campaign_source, campaign_medium, region AS state, city,
  SUM(CASE WHEN event_name IN ('productView','Product Viewed') THEN total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN event_name = 'addToCart' THEN session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(event_name = 'Purchase') AS purchase,
  COUNT(*) AS total_events
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE campaign_id IS NOT NULL AND campaign_id != '' AND country = 'India' AND city IS NOT NULL AND city != ''
GROUP BY campaign_key, campaign_source, campaign_medium, state, city;

-- ════════════════════════════════════════════════════════════════════════
-- Q5: Product/category agg by city -- PDP-view side (Product Viewed only, the only PDP event with
-- json_data; productView and addToCart have no usable category/price, NOT estimated here).
-- BUG FIX 2026-09-16: grouping by the raw FLOAT price (not banded) produced 844,397 distinct
-- groups -- silently truncated to the bq CLI's 500,000-row cap, losing ~41% of the real data.
-- Fixed by bucketing into price_range bands BEFORE the GROUP BY (self-defined bands, no existing
-- convention for application_view_v1's raw price -- disclosed as self-defined in the dashboard).
-- ════════════════════════════════════════════════════════════════════════
SELECT
  region AS state, city,
  JSON_EXTRACT_SCALAR(json_data, '$.RECENTLY_VIEWED[0].product_type') AS category,
  CASE
    WHEN price < 25000 THEN 'Under ₹25K' WHEN price < 50000 THEN '₹25K-50K'
    WHEN price < 100000 THEN '₹50K-1L' WHEN price < 200000 THEN '₹1L-2L' ELSE '₹2L+'
  END AS price_range,
  COUNT(*) AS pdp_views
FROM (
  SELECT region, city, json_data, CAST(JSON_EXTRACT_SCALAR(json_data, '$.RECENTLY_VIEWED[0].price') AS FLOAT64) AS price
  FROM `test-webengage.11b56595a_shared.application_view_v1`
  WHERE event_name = 'Product Viewed' AND json_data IS NOT NULL AND country = 'India' AND city IS NOT NULL AND city != ''
)
GROUP BY state, city, category, price_range;

-- ════════════════════════════════════════════════════════════════════════
-- Q6: Product/category/SKU agg by city -- Purchase side (real revenue, items array, one row per
-- purchased SKU per city/category/price-band). BUG FIX 2026-09-16: Purchase events have 0%
-- top-level country/city (confirmed live -- same root cause as the earlier Purchase-count-always-0
-- bug documented in the Data Quality tab), so `a.country = 'India' AND a.city IS NOT NULL`
-- silently returned ZERO rows here. City/state now come from the real order address embedded in
-- json_data (shipping_address), same source already used by customer_pincode_revenue.json and
-- app_purchase_events_by_city.json. Same price-band fix as Q5, SKU kept at its own grain (not
-- banded away) since the merge script needs per-SKU rows for the Top-SKU-by-City table.
-- ════════════════════════════════════════════════════════════════════════
SELECT
  state, city, category,
  CASE
    WHEN price < 25000 THEN 'Under ₹25K' WHEN price < 50000 THEN '₹25K-50K'
    WHEN price < 100000 THEN '₹50K-1L' WHEN price < 200000 THEN '₹1L-2L' ELSE '₹2L+'
  END AS price_range,
  sku, ANY_VALUE(product_name) AS product_name,
  COUNT(*) AS purchase_line_items,
  SUM(price * IFNULL(quantity,1)) AS revenue
FROM (
  SELECT
    JSON_EXTRACT_SCALAR(a.json_data, '$.shipping_address.state') AS state,
    JSON_EXTRACT_SCALAR(a.json_data, '$.shipping_address.city') AS city,
    JSON_EXTRACT_SCALAR(item, '$.category') AS category,
    CAST(JSON_EXTRACT_SCALAR(item, '$.price') AS FLOAT64) AS price,
    CAST(JSON_EXTRACT_SCALAR(item, '$.quantity') AS FLOAT64) AS quantity,
    JSON_EXTRACT_SCALAR(item, '$.sku') AS sku,
    JSON_EXTRACT_SCALAR(item, '$.product_name') AS product_name
  FROM `test-webengage.11b56595a_shared.application_view_v1` a,
  UNNEST(JSON_EXTRACT_ARRAY(a.json_data, '$.items')) AS item
  WHERE a.event_name = 'Purchase' AND a.json_data IS NOT NULL
    AND JSON_EXTRACT_SCALAR(a.json_data, '$.shipping_address.city') IS NOT NULL
)
GROUP BY state, city, category, price_range, sku;

-- ════════════════════════════════════════════════════════════════════════
-- Q7: Daily city agg (IST date, real event_time -- powers the date-range filter)
-- ════════════════════════════════════════════════════════════════════════
SELECT
  DATE(event_time, 'Asia/Kolkata') AS event_date, region AS state, city,
  SUM(CASE WHEN event_name IN ('productView','Product Viewed') THEN total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN event_name = 'addToCart' THEN session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(event_name = 'Purchase') AS purchase,
  COUNT(*) AS total_events
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE country = 'India' AND city IS NOT NULL AND city != '' AND event_time IS NOT NULL
GROUP BY event_date, state, city;

-- ════════════════════════════════════════════════════════════════════════
-- Q8: Daily campaign agg
-- ════════════════════════════════════════════════════════════════════════
SELECT
  DATE(event_time, 'Asia/Kolkata') AS event_date, campaign_id AS campaign_key, campaign_source, campaign_medium,
  SUM(CASE WHEN event_name IN ('productView','Product Viewed') THEN total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN event_name = 'addToCart' THEN session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(event_name = 'Purchase') AS purchase,
  COUNT(*) AS total_events
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE campaign_id IS NOT NULL AND campaign_id != '' AND event_time IS NOT NULL
GROUP BY event_date, campaign_key, campaign_source, campaign_medium;

-- ════════════════════════════════════════════════════════════════════════
-- Q8b: Purchase EVENT count by city (not line items) -- real address-based city, same fix as Q6.
-- Previously undocumented (reconstructed 2026-09-16 from the merge script's field expectations).
-- ════════════════════════════════════════════════════════════════════════
SELECT
  JSON_EXTRACT_SCALAR(json_data, '$.shipping_address.state') AS state,
  JSON_EXTRACT_SCALAR(json_data, '$.shipping_address.city') AS city,
  COUNT(*) AS purchase_events
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE event_name = 'Purchase' AND json_data IS NOT NULL
  AND JSON_EXTRACT_SCALAR(json_data, '$.shipping_address.city') IS NOT NULL
GROUP BY state, city;

-- ════════════════════════════════════════════════════════════════════════
-- Q9: Event coverage / data-quality summary
-- ════════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*) AS total_events,
  COUNTIF(cuid IS NOT NULL AND cuid != '') AS events_with_cuid,
  COUNTIF(REGEXP_CONTAINS(REGEXP_REPLACE(IFNULL(cuid,''), r'[^0-9]', ''), r'^(91)?[6-9][0-9]{9}$|^0[6-9][0-9]{9}$')) AS events_with_valid_mobile_shape,
  COUNTIF(city IS NOT NULL AND city != '') AS events_with_city,
  COUNTIF(postal_code IS NOT NULL AND postal_code != '') AS events_with_postal_code,
  COUNTIF(country = 'India') AS events_india,
  COUNT(DISTINCT event_name) AS distinct_event_names,
  COUNT(DISTINCT luid) AS distinct_luid,
  MIN(DATE(event_time,'Asia/Kolkata')) AS min_date, MAX(DATE(event_time,'Asia/Kolkata')) AS max_date
FROM `test-webengage.11b56595a_shared.application_view_v1`;

-- ════════════════════════════════════════════════════════════════════════
-- Q10: Event-name coverage table (drives the Data Quality "Event Coverage" checklist, section 12)
-- ════════════════════════════════════════════════════════════════════════
SELECT event_name, category, COUNT(*) AS event_count, COUNT(DISTINCT luid) AS unique_devices,
  COUNT(DISTINCT CASE WHEN cuid IS NOT NULL THEN cuid END) AS events_with_any_cuid
FROM `test-webengage.11b56595a_shared.application_view_v1`
GROUP BY event_name, category
ORDER BY event_count DESC;

-- ════════════════════════════════════════════════════════════════════════
-- Q11: Customer x Pincode grain (City -> Pincode -> Customer drill-down, added 2026-09-01).
-- BASE TABLE: application_view_v1 (event side). JOINED TABLE: user_profile_view_v3 (geo side).
-- Both tables live in `test-webengage.11b56595a_shared` -- a SAME-PROJECT join, not the
-- cross-region case. JOIN TYPE: INNER JOIN (via profile_geo derived table). JOIN CONDITION:
-- app_mobile.mobile = profile_geo.mobile, where "mobile" on BOTH sides is the SAME normalized
-- expression applied to each table's own `cuid` column (there is no shared raw column -- the join
-- key is a derived/computed value, identical logic on both sides). No email/user_id/other
-- identifier is used or available on either table; mobile (via cuid) is the ONLY join key.
--
-- Duplicate-row risk and how it's prevented: user_profile_view_v3 can have MULTIPLE rows per
-- mobile (repeat visits/profile updates over time). Without de-duplication this JOIN would fan out
-- and double/triple-count a customer's events once per matching profile row. Prevented by
-- `profile_geo` picking exactly ONE canonical row per mobile -- ROW_NUMBER() OVER (PARTITION BY
-- mobile ORDER BY last_seen DESC), keep rn=1 (the most recent profile) -- BEFORE the join runs, so
-- the join itself is effectively 1:many event-rows-to-1-profile-row per mobile, and GROUP BY
-- pincode, mobile below collapses each customer to exactly one output row. Confirmed live 2026-09-01:
-- 292 output rows, 292 distinct mobiles -- zero duplication.
WITH profile_geo AS (
  SELECT mobile, postal_code FROM (
    SELECT
      CASE
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
        ELSE NULL
      END AS mobile,
      postal_code, last_seen,
      ROW_NUMBER() OVER (PARTITION BY CASE
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
        ELSE NULL END ORDER BY last_seen DESC) AS rn
    FROM `test-webengage.11b56595a_shared.user_profile_view_v3`   -- JOINED TABLE
    WHERE cuid IS NOT NULL AND postal_code IS NOT NULL AND REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')
  ) WHERE rn = 1   -- <-- the de-dup step that prevents fan-out duplication
),
app_mobile AS (
  SELECT
    CASE
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
      ELSE NULL
    END AS mobile,
    event_name, suid, event_time, total_page_view_count, session_count
  FROM `test-webengage.11b56595a_shared.application_view_v1`   -- BASE TABLE
  WHERE cuid IS NOT NULL
)
-- pdp_views/add_to_cart switched from COUNTIF to SUM on the running-counter columns
-- (total_page_view_count, session_count) per explicit user instruction 2026-09-19.
-- FLAGGED, not blocking: these columns are cumulative/snapshot counters proven live to
-- repeat within a session and reset per session -- NOT per-event increments. SUM inflates
-- PDP views ~33x and ATC ~14.6x versus the COUNTIF baseline (verified on pincode 110077:
-- COUNT=116 vs SUM=3,796 for PDP; COUNT=7 vs SUM=102 for ATC). User was shown this and
-- chose SUM anyway.
SELECT
  p.postal_code AS pincode, a.mobile,
  COUNT(DISTINCT a.suid) AS sessions,
  SUM(CASE WHEN a.event_name IN ('productView','Product Viewed') THEN a.total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN a.event_name = 'addToCart' THEN a.session_count ELSE 0 END) AS add_to_cart,
  COUNTIF(a.event_name = 'begin_checkout') AS begin_checkout,
  COUNTIF(a.event_name = 'Purchase') AS purchase,
  COUNTIF(a.event_name = 'addToWishlist') AS wishlist,
  COUNTIF(a.event_name = 'Category Viewed') AS plp_impressions,
  COUNTIF(a.event_name IN ('removeFromCart','Removed From Cart','nitro_removefromcart')) AS remove_from_cart,
  COUNT(*) AS total_events,
  MIN(a.event_time) AS first_seen, MAX(a.event_time) AS last_seen
FROM app_mobile a JOIN profile_geo p ON a.mobile = p.mobile   -- <-- THE JOIN: INNER JOIN on mobile
GROUP BY pincode, a.mobile;

-- Q13: Canonical mobile -> pincode map (same-project, test-webengage only). Feeds
-- canonical_mobile_pincode.json, used client-side to map marketing_sale customers (a
-- lucirajewelry-prod, same-project-but-different-dataset table) to a pincode -- previously
-- undocumented (reconstructed 2026-09-16 from etl/build_store_location_intel_v2.js's field
-- expectations). Same ROW_NUMBER-by-last_seen canonical-pincode logic as Q11/Q12.
SELECT mobile, postal_code FROM (
  SELECT
    CASE
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
      ELSE NULL
    END AS mobile,
    postal_code, last_seen,
    ROW_NUMBER() OVER (PARTITION BY CASE
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
      ELSE NULL END ORDER BY last_seen DESC) AS rn
  FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
  WHERE cuid IS NOT NULL AND postal_code IS NOT NULL AND REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')
) WHERE rn = 1;

-- Q14: Raw sales line items (lucirajewelry-prod.ds_imputed_reporting.marketing_sale -- SAME
-- project as the dashboard's own BigQuery, but this is run as its OWN job, never joined to the
-- test-webengage queries above in one job). Feeds sales_raw.json. Mobile normalized inline, same
-- rule as every other query in this file, so it can be matched client-side against
-- canonical_mobile_pincode.json's mobile.
-- 2026-10-19: the sale's OWN pincode now comes from ERP, not just an address regex. marketing_sale
-- has a real Pin_code column (84% of Online line items), plus the POS invoice shipping_pin_code
-- (by document_no) and the ERP customer master party.pin_code (by party_id -- the ONLY source for
-- most Store-channel sales). Tiers are resolved client-side (first real India-Post pincode wins).
WITH inv AS (
  SELECT document_no, ANY_VALUE(TRIM(CAST(shipping_pin_code AS STRING))) AS pin
  FROM `lucirajewelry-prod.ornaverse_erp_pos.invoice` GROUP BY 1
), pty AS (
  SELECT CAST(party_id AS STRING) AS party_id, ANY_VALUE(TRIM(CAST(pin_code AS STRING))) AS pin
  FROM `lucirajewelry-prod.ornaverse_erp_master.party` GROUP BY 1
)
SELECT
  s.document_no, s.Transaction_Date, s.net_sale, s.discount, s.pieces,
  s.Channel AS channel, s.company_code,
  CASE
    WHEN REGEXP_CONTAINS(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), 3)
    WHEN REGEXP_CONTAINS(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), 2)
    WHEN REGEXP_CONTAINS(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', '')
    ELSE NULL
  END AS mobile,
  TRIM(CAST(s.Pin_code AS STRING)) AS sale_pincode,
  inv.pin AS invoice_pincode,
  pty.pin AS party_pincode,
  REGEXP_EXTRACT(CONCAT(IFNULL(s.address, ''), ' ', IFNULL(s.address_1, '')), r'([1-9][0-9]{5})') AS address_pincode
FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale` s
LEFT JOIN inv ON inv.document_no = s.document_no
LEFT JOIN pty ON pty.party_id = CAST(s.party_id AS STRING);

-- Q12: Customer x Pincode purchase revenue (same JOIN pattern as Q11, applied to Purchase events'
-- items[] array). BASE TABLE application_view_v1, JOINED TABLE profile_geo (itself sourced from
-- user_profile_view_v3, same canonical-pincode de-dup as Q11).
WITH profile_geo AS (
  SELECT mobile, postal_code FROM (
    SELECT
      CASE
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
        ELSE NULL
      END AS mobile,
      postal_code, last_seen,
      ROW_NUMBER() OVER (PARTITION BY CASE
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 3)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 2)
        WHEN REGEXP_CONTAINS(REGEXP_REPLACE(cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(cuid, r'[^0-9]', '')
        ELSE NULL END ORDER BY last_seen DESC) AS rn
    FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
    WHERE cuid IS NOT NULL AND postal_code IS NOT NULL AND REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')
  ) WHERE rn = 1
)
SELECT
  p.postal_code AS pincode, p.mobile,
  SUM(CAST(JSON_EXTRACT_SCALAR(item, '$.price') AS FLOAT64) * IFNULL(CAST(JSON_EXTRACT_SCALAR(item, '$.quantity') AS FLOAT64),1)) AS revenue,
  COUNT(DISTINCT a.event_id) AS purchase_events
FROM `test-webengage.11b56595a_shared.application_view_v1` a,
UNNEST(JSON_EXTRACT_ARRAY(a.json_data, '$.items')) AS item
JOIN profile_geo p ON p.mobile = CASE   -- <-- THE JOIN: INNER JOIN on mobile
  WHEN REGEXP_CONTAINS(REGEXP_REPLACE(a.cuid, r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(a.cuid, r'[^0-9]', ''), 3)
  WHEN REGEXP_CONTAINS(REGEXP_REPLACE(a.cuid, r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(a.cuid, r'[^0-9]', ''), 2)
  WHEN REGEXP_CONTAINS(REGEXP_REPLACE(a.cuid, r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(a.cuid, r'[^0-9]', '')
  ELSE NULL END
WHERE a.event_name = 'Purchase' AND a.json_data IS NOT NULL AND a.cuid IS NOT NULL
GROUP BY pincode, p.mobile;

-- Q14b (added 2026-10-19): customer mobile -> pincode from typed customer records, used as a sale
-- pincode fallback (tier 5, after the sale's own ERP pincodes, before WebEngage). Feeds
-- customer_master_pincode.json. Priority: ERP CRM customer (ornaverse_crm_data.customer) >
-- Shopify customer > ds_imputed_reporting.customer. Only real 6-digit values kept.
SELECT mobile, ARRAY_AGG(pin ORDER BY prio LIMIT 1)[OFFSET(0)] AS pincode, ARRAY_AGG(src ORDER BY prio LIMIT 1)[OFFSET(0)] AS src
FROM (
  SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'[^0-9]', ''), 10) AS mobile, TRIM(CAST(pin_code AS STRING)) AS pin, 1 AS prio, 'erp_crm_customer' AS src FROM `lucirajewelry-prod.ornaverse_crm_data.customer`
  UNION ALL
  SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'[^0-9]', ''), 10), TRIM(CAST(zip_code AS STRING)), 2, 'shopify_customer' FROM `lucirajewelry-prod.ds_imputed_reporting.Shopify_customer`
  UNION ALL
  SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'[^0-9]', ''), 10), TRIM(CAST(pincode AS STRING)), 3, 'imputed_customer' FROM `lucirajewelry-prod.ds_imputed_reporting.customer`
)
WHERE REGEXP_CONTAINS(mobile, r'^[6-9][0-9]{9}$') AND REGEXP_CONTAINS(pin, r'^[1-9][0-9]{5}$')
GROUP BY mobile;
