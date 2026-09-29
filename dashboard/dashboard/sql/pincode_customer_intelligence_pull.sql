-- Pincode-Level Customer Intelligence — WebEngage pull.
-- Normalization is MANDATED by spec: normalized_cuid = RIGHT(TRIM(CAST(cuid AS STRING)), 10).
-- This is a DIFFERENT (looser) rule than the regex-validated mobile-shape normalization used
-- elsewhere in this dashboard (store_location_app_events_pull.sql) -- kept separate on purpose,
-- do not conflate the two when reading other SQL files in this repo.
--
-- Cross-region rule (same as every other WebEngage pull in this repo): both queries below run
-- with --project_id=lucirajewelry-prod as the BILLING project even though the FROM table lives in
-- `test-webengage` (region US). application_view_v1 and user_profile_view_v3 are BOTH in
-- `test-webengage.11b56595a_shared` so this is a same-project join (not cross-region) -- but the
-- RESULT of these queries can never be joined to a `lucirajewelry-prod` table (marketing_sale) in
-- the same SQL job. Sales gets normalized+aggregated separately (see
-- pincode_customer_intelligence_sales_pull.sql) and merged client-side in
-- etl/build_pincode_customer_intelligence.js.
--
-- Real event-name verification (2026-09-16, live query against application_view_v1, 94 distinct
-- event_name values total -- do not trust any older memory claiming fewer):
--   PDP View : productView (3,651,712) + Product Viewed (1,986,263)  -- same convention as the rest
--              of this dashboard, combined not double-counted.
--   Add to Cart : addToCart (96,250) only -- 'Added To Cart' / 'nitro_addtocart' / 'Cart Updated'
--              are separate, NOT-combined near-duplicate events (same disclosed convention).
--   Checkout : begin_checkout (6,504) only -- 'Started_Checkout_GK' / 'Checkout updated' /
--              'Checkout created' / 'gokwik_checkout_initiated' are separate near-duplicates.
--   Order    : Purchase (2,555, capitalized) -- lowercase 'purchase' (348) / 'Order Completed' (660)
--              / 'Order created'/'Order updated' are separate order-lifecycle events, not folded in.
--
-- Run: bq query --use_legacy_sql=false --format=json --project_id=lucirajewelry-prod --max_rows=500000 < <one block at a time>

-- ════════════════════════════════════════════════════════════════════════
-- Q1: Customer Profile Mapping (Layer B) — one row per normalized_cuid.
-- Dedup rule (spec-mandated): prefer a row with a non-blank pincode, then the most recently
-- updated record. ROW_NUMBER() PARTITION BY normalized_cuid prevents any fan-out later.
-- ════════════════════════════════════════════════════════════════════════
WITH ranked AS (
  SELECT
    RIGHT(TRIM(CAST(cuid AS STRING)), 10) AS normalized_cuid,
    postal_code, city, region AS state, last_updated_time,
    ROW_NUMBER() OVER (
      PARTITION BY RIGHT(TRIM(CAST(cuid AS STRING)), 10)
      ORDER BY (postal_code IS NOT NULL AND TRIM(postal_code) != '') DESC, last_updated_time DESC
    ) AS rn
  FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
  WHERE cuid IS NOT NULL AND TRIM(CAST(cuid AS STRING)) != ''
    AND LENGTH(RIGHT(TRIM(CAST(cuid AS STRING)), 10)) = 10
)
SELECT normalized_cuid, postal_code AS pincode, city, state
FROM ranked WHERE rn = 1;

-- ════════════════════════════════════════════════════════════════════════
-- Q2: WebEngage Event Aggregation (Layer C) — one row per normalized_cuid.
-- pdp_views/atc_events use SUM on the running counter columns (total_page_view_count,
-- session_count) per explicit user instruction 2026-09-19, NOT COUNTIF on event rows.
-- NOTE (flagged, not blocking): these two columns were proven live to be cumulative/
-- snapshot counters that repeat within a session and reset per session, not per-event
-- increments -- SUM on them measures something closer to "total counter-value observed
-- across all rows", not "number of PDP views" or "number of add-to-cart actions". The
-- user was shown a live side-by-side (COUNT=116 vs SUM=3,796 for PDP; COUNT=7 vs SUM=102
-- for ATC on pincode 110077) and asked for SUM anyway.
-- ════════════════════════════════════════════════════════════════════════
SELECT
  RIGHT(TRIM(CAST(cuid AS STRING)), 10) AS normalized_cuid,
  SUM(CASE WHEN event_name IN ('productView', 'Product Viewed') THEN total_page_view_count ELSE 0 END) AS pdp_views,
  SUM(CASE WHEN event_name = 'addToCart' THEN session_count ELSE 0 END) AS atc_events,
  COUNTIF(event_name = 'begin_checkout') AS checkout_events,
  COUNTIF(event_name = 'Purchase') AS order_events,
  COUNT(*) AS total_events,
  MIN(event_time) AS first_activity_date,
  MAX(event_time) AS last_activity_date
FROM `test-webengage.11b56595a_shared.application_view_v1`
WHERE cuid IS NOT NULL AND TRIM(CAST(cuid AS STRING)) != ''
  AND LENGTH(RIGHT(TRIM(CAST(cuid AS STRING)), 10)) = 10
GROUP BY normalized_cuid;

-- ════════════════════════════════════════════════════════════════════════
-- Q3: Validation counts (Section 12) — run once, numbers go straight into dataQuality in the
-- merge script rather than being recomputed by hand.
-- ════════════════════════════════════════════════════════════════════════
SELECT
  (SELECT COUNT(DISTINCT RIGHT(TRIM(CAST(cuid AS STRING)), 10)) FROM `test-webengage.11b56595a_shared.application_view_v1` WHERE cuid IS NOT NULL AND TRIM(CAST(cuid AS STRING)) != '') AS distinct_norm_cuid_events,
  (SELECT COUNT(DISTINCT RIGHT(TRIM(CAST(cuid AS STRING)), 10)) FROM `test-webengage.11b56595a_shared.user_profile_view_v3` WHERE cuid IS NOT NULL AND TRIM(CAST(cuid AS STRING)) != '') AS distinct_norm_cuid_profile,
  (SELECT COUNT(*) FROM `test-webengage.11b56595a_shared.application_view_v1` WHERE cuid IS NULL OR TRIM(CAST(cuid AS STRING)) = '') AS null_blank_cuid_events,
  (SELECT COUNT(*) FROM `test-webengage.11b56595a_shared.user_profile_view_v3` WHERE cuid IS NULL OR TRIM(CAST(cuid AS STRING)) = '') AS null_blank_cuid_profile;

-- ════════════════════════════════════════════════════════════════════════
-- Q4: Campaign fields per normalized_cuid (for the Campaign/Source/Medium filter) — native columns,
-- most-frequent non-null campaign per customer (mode-ish: just take MAX so it's deterministic).
-- ════════════════════════════════════════════════════════════════════════
SELECT
  normalized_cuid,
  latest[OFFSET(0)].campaign_id AS campaign_id,
  latest[OFFSET(0)].campaign_source AS campaign_source,
  latest[OFFSET(0)].campaign_medium AS campaign_medium
FROM (
  SELECT
    RIGHT(TRIM(CAST(cuid AS STRING)), 10) AS normalized_cuid,
    ARRAY_AGG(STRUCT(campaign_id, campaign_source, campaign_medium) ORDER BY event_time DESC LIMIT 1) AS latest
  FROM `test-webengage.11b56595a_shared.application_view_v1`
  WHERE cuid IS NOT NULL AND TRIM(CAST(cuid AS STRING)) != '' AND campaign_id IS NOT NULL AND campaign_id != ''
  GROUP BY normalized_cuid
);
