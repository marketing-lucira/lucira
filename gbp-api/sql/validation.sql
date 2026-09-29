-- Google Business Profile pipeline — validation queries
-- Run these after each sync to confirm data health before trusting the table.

-- 1) Location count: GBP locations vs Lucira mapped stores -------------------
SELECT
  (SELECT COUNT(*) FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_locations`) AS gbp_locations,
  (SELECT COUNT(*) FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_locations` WHERE store_code IS NOT NULL) AS mapped_to_store,
  (SELECT COUNT(*) FROM `lucirajewelry-prod.ds_imputed_reporting.store_location_store_master`) AS lucira_stores;

-- 2) Locations with no store mapping (need manual resolution) ---------------
SELECT location_id, location_name, store_address, city
FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_locations`
WHERE store_code IS NULL;

-- 3) Locations with no review data in the last 3 days ------------------------
SELECT l.location_id, l.location_name
FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_locations` l
LEFT JOIN (
  SELECT DISTINCT location_id
  FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_daily`
  WHERE report_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
    AND review_count IS NOT NULL
) d USING (location_id)
WHERE d.location_id IS NULL AND l.is_active IS TRUE;

-- 4) Locations with no performance data in the last 3 days -------------------
SELECT l.location_id, l.location_name
FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_locations` l
LEFT JOIN (
  SELECT DISTINCT location_id
  FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_daily`
  WHERE report_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
    AND (call_clicks IS NOT NULL OR direction_requests IS NOT NULL)
) d USING (location_id)
WHERE d.location_id IS NULL AND l.is_active IS TRUE;

-- 5) Duplicate check: one row per (report_date, location_id) ----------------
SELECT
  COUNT(*) AS total_rows,
  COUNT(DISTINCT CONCAT(CAST(report_date AS STRING), '_', location_id)) AS distinct_keys
FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_daily`;
-- total_rows must equal distinct_keys

-- 6) Metric range validation --------------------------------------------------
SELECT *
FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_daily`
WHERE (average_rating IS NOT NULL AND (average_rating < 0 OR average_rating > 5))
   OR (review_count IS NOT NULL AND review_count < 0)
   OR (direction_requests IS NOT NULL AND direction_requests < 0)
   OR (call_clicks IS NOT NULL AND call_clicks < 0);

-- 7) Recent API failures, by store ------------------------------------------
SELECT store_code, location_id, api_name, status, error_message, run_timestamp
FROM `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_api_log`
WHERE status = 'FAILED'
  AND run_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
ORDER BY run_timestamp DESC;
