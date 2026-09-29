-- WebEngage side of the Store Location Intelligence dashboard.
-- NOT a CREATE TABLE -- test-webengage (region US) cannot INSERT/EXPORT DATA into
-- lucirajewelry-prod's asia-south1 datasets in the same job (confirmed live: a cross-region JOIN
-- throws "Access Denied", not a location-mismatch error). Every SELECT below must be run with
-- --project_id=lucirajewelry-prod (billing project) even though the FROM table lives in
-- test-webengage -- querying with --project_id=test-webengage itself fails with a
-- bigquery.jobs.create permission error. Results are pulled to local JSON and merged into the
-- rest of the pipeline client-side by the Node build script (see etl/build_store_location_intel.js).
--
-- Pincode validity: postal_code is free text. Only a 6-digit, [1-9][0-9]{5} value is even
-- format-plausible, and even then only ~13.6% of those (by user count) match a REAL India Post
-- pincode in ds_india_geo.india_pincode -- confirmed live via a local join (125,435 distinct
-- format-valid values claimed, only 3,096 are real; 141,638 format-valid users, only 19,275 sit on
-- a real pincode). The `pincode_valid_format` and the master-match (done client-side against the
-- india_pincode list, not here) are the two-tier honesty check surfaced in the Data Quality tab.
--
-- acquisition_source is 100% NULL (dead field) -- campaign_source/campaign_medium used instead.
-- locality is 100% NULL. location.lat/location.lon are 100% NULL -- geocoding is by postal_code
-- against ds_india_geo.india_pincode only, never from this table's own coordinates.
--
-- Cadence: NOT scheduled yet -- rerun manually via
--   bq query --use_legacy_sql=false --format=json --project_id=lucirajewelry-prod --max_rows=500000 < <this file, one query at a time>

-- Query 1: pincode-grain rollup (users, sessions, time, campaign-user counts, city/state/region as seen for that pincode)
SELECT
  postal_code AS pincode,
  ANY_VALUE(city) AS city,
  ANY_VALUE(region) AS region,
  COUNT(*) AS users,
  SUM(session_count) AS total_sessions,
  SUM(time_spent) AS total_time_spent,
  COUNTIF(campaign_source IS NOT NULL AND campaign_source != '') AS campaign_users,
  COUNTIF(phone IS NOT NULL AND phone != '') AS users_with_phone,
  MIN(created_at) AS min_created, MAX(last_seen) AS max_last_seen
FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
WHERE REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')
GROUP BY postal_code;

-- Query 2: pincode x campaign rollup (for Tab 6 Campaign x Pincode, real WebEngage side)
SELECT
  postal_code AS pincode,
  campaign_id AS campaign_key, campaign_source, campaign_medium,
  COUNT(*) AS users,
  SUM(session_count) AS total_sessions
FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
WHERE REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')
  AND campaign_id IS NOT NULL AND campaign_id != '' AND campaign_id != 'unknown'
GROUP BY postal_code, campaign_id, campaign_source, campaign_medium;

-- Query 3: campaign-level rollup across ALL users (not just pincode-valid) -- real user/city/pincode spread per campaign for Tab 5
SELECT
  campaign_id AS campaign_key, campaign_source, campaign_medium,
  COUNT(*) AS users,
  COUNT(DISTINCT CASE WHEN REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$') THEN postal_code END) AS distinct_format_valid_pincodes,
  COUNT(DISTINCT CASE WHEN city IS NOT NULL AND city != '' THEN city END) AS distinct_cities,
  SUM(session_count) AS total_sessions
FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
WHERE campaign_id IS NOT NULL AND campaign_id != '' AND campaign_id != 'unknown'
GROUP BY campaign_id, campaign_source, campaign_medium;

-- Query 4: city/state rollup (broader coverage tier, ~74% of users)
SELECT
  city, region,
  COUNT(*) AS users,
  SUM(session_count) AS total_sessions,
  SUM(time_spent) AS total_time_spent,
  COUNTIF(campaign_source IS NOT NULL AND campaign_source != '') AS campaign_users,
  COUNT(DISTINCT CASE WHEN REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$') THEN postal_code END) AS distinct_format_valid_pincodes
FROM `test-webengage.11b56595a_shared.user_profile_view_v3`
WHERE city IS NOT NULL AND city != ''
GROUP BY city, region;

-- Query 5: data-quality top-line counts (drives the Data Quality tab -- the honest numbers)
SELECT
  COUNT(*) AS total_users,
  COUNTIF(postal_code IS NOT NULL AND postal_code != '') AS users_any_pincode,
  COUNTIF(REGEXP_CONTAINS(postal_code, r'^[1-9][0-9]{5}$')) AS users_format_valid_pincode,
  COUNTIF(city IS NOT NULL AND city != '') AS users_with_city,
  COUNTIF(region IS NOT NULL AND region != '') AS users_with_region,
  COUNTIF(locality IS NOT NULL AND locality != '') AS users_with_locality,
  COUNTIF(location.lat IS NOT NULL) AS users_with_coords,
  COUNTIF(campaign_source IS NOT NULL AND campaign_source != '') AS users_with_campaign_source,
  COUNTIF(campaign_id IS NOT NULL AND campaign_id != '' AND campaign_id != 'unknown') AS users_with_campaign_id,
  COUNTIF(acquisition_source IS NOT NULL AND acquisition_source != '') AS users_with_acquisition_source,
  COUNT(DISTINCT campaign_id) AS distinct_campaign_ids,
  MIN(created_at) AS min_created, MAX(last_seen) AS max_last_seen
FROM `test-webengage.11b56595a_shared.user_profile_view_v3`;
