-- Store Location Intelligence -- Zoho CRM Deals + Google Ads geo pulls (added 2026-09-29).
-- All four run against lucirajewelry-prod (asia-south1), each as its OWN job, output saved to
-- etl/raw/store_location_v2/<file>.json via:
--   bq query --use_legacy_sql=false --format=json --max_rows=200000 < <one query> > <file>.json
-- Merged client-side in etl/build_store_location_intel_v2.js like every other source here.
--
-- Why: WebEngage mobile-matched customers only reach ~160 people on a real pincode. Zoho Deals
-- (~280/day) carry a real address via the linked Contact's Mailing_Zip, and Google Ads reports
-- ~65% of spend against an exact postal-code geo target -- both far denser pincode signals.

-- Q15: One row per Zoho Deal (latest CDC version) with its resolved pincode. Feeds
-- zoho_deals_pincode.json. Pincode = Deal.Address_Zip_Postal_Code if 6-digit, else the linked
-- Contact's Mailing_Zip (Deal.Contact_Name.id -> cdc_contacts.id). Kept even when no pincode
-- resolves (pincode NULL) so the merge script can report the unmapped share honestly.
WITH d AS (
  SELECT id, created_time, data FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
), c AS (
  SELECT id, data FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
  WHERE id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
), pz AS (
  -- 2026-10-19: deals_address_live_patch carries Address_Zip for deals whose CDC row lacks it.
  SELECT CAST(id AS STRING) AS id, ANY_VALUE(TRIM(CAST(address_zip AS STRING))) AS zip
  FROM `lucirajewelry-prod.zoho_crm.deals_address_live_patch`
  WHERE REGEXP_CONTAINS(TRIM(CAST(address_zip AS STRING)), r'^[1-9][0-9]{5}$') GROUP BY 1
)
SELECT
  d.id AS deal_id,
  FORMAT_DATE('%Y-%m-%d', DATE(d.created_time, 'Asia/Kolkata')) AS created_date,
  CASE
    WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code'))
    WHEN pz.zip IS NOT NULL THEN pz.zip
    WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(c.data, '$.Mailing_Zip')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(c.data, '$.Mailing_Zip'))
    ELSE NULL
  END AS pincode,
  CASE
    WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code')), r'^[1-9][0-9]{5}$') THEN 'deal'
    WHEN pz.zip IS NOT NULL THEN 'deal'
    WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(c.data, '$.Mailing_Zip')), r'^[1-9][0-9]{5}$') THEN 'contact'
    ELSE NULL
  END AS pincode_source,
  CASE
    WHEN REGEXP_CONTAINS(REGEXP_REPLACE(JSON_VALUE(d.data, '$.Mobile'), r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(JSON_VALUE(d.data, '$.Mobile'), r'[^0-9]', ''), 3)
    WHEN REGEXP_CONTAINS(REGEXP_REPLACE(JSON_VALUE(d.data, '$.Mobile'), r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(JSON_VALUE(d.data, '$.Mobile'), r'[^0-9]', ''), 2)
    WHEN REGEXP_CONTAINS(REGEXP_REPLACE(JSON_VALUE(d.data, '$.Mobile'), r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(JSON_VALUE(d.data, '$.Mobile'), r'[^0-9]', '')
    ELSE NULL
  END AS mobile,
  JSON_VALUE(d.data, '$.Stage') AS stage,
  JSON_VALUE(d.data, '$.Deal_Trigger_Event') AS trigger_event,
  JSON_VALUE(d.data, '$.Lead_Source') AS lead_source,
  JSON_VALUE(d.data, '$.UTM_Source') AS utm_source,
  SAFE_CAST(JSON_VALUE(d.data, '$.Amount') AS FLOAT64) AS amount
FROM d LEFT JOIN c ON c.id = JSON_VALUE(d.data, '$.Contact_Name.id')
LEFT JOIN pz ON pz.id = d.id;

-- Q16: Zoho Contact mobile -> pincode map (latest-modified contact per mobile). Feeds
-- zoho_mobile_pincode.json -- used as a FALLBACK pincode for marketing_sale customers whose
-- mobile has no real pincode in WebEngage's canonical_mobile_pincode.json.
SELECT mobile, pincode FROM (
  SELECT
    CASE
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'[^0-9]', ''), r'^91[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'[^0-9]', ''), 3)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'[^0-9]', ''), r'^0[6-9][0-9]{9}$') THEN SUBSTR(REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'[^0-9]', ''), 2)
      WHEN REGEXP_CONTAINS(REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'[^0-9]', ''), r'^[6-9][0-9]{9}$') THEN REGEXP_REPLACE(JSON_VALUE(data, '$.Mobile'), r'[^0-9]', '')
      ELSE NULL
    END AS mobile,
    TRIM(JSON_VALUE(data, '$.Mailing_Zip')) AS pincode,
    modified_time
  FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
  WHERE REGEXP_CONTAINS(TRIM(JSON_VALUE(data, '$.Mailing_Zip')), r'^[1-9][0-9]{5}$')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
)
WHERE mobile IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY mobile ORDER BY modified_time DESC) = 1;

-- Q17: Google Ads spend by most-specific geo target (all dates in the export). Feeds
-- gads_geo_spend.json. The numeric id is decoded client-side with Google's public geotargets CSV
-- (etl/raw/store_location_v2/geotargets_in_postal.json = India "Postal Code" rows only, from
-- developers.google.com/google-ads/api/data/geotargets, 2026-08-12 release). Non-postal targets
-- (City / Neighborhood / District ...) are NOT allocated to pincodes -- reported as unmapped.
SELECT
  REGEXP_EXTRACT(segments_geo_target_most_specific_location, r'(\d+)$') AS loc,
  ROUND(SUM(IF(segments_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 30 DAY), metrics_cost_micros, 0)) / 1e6, 2) AS spend30,
  ROUND(SUM(metrics_cost_micros) / 1e6, 2) AS spend_all,
  SUM(IF(segments_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 30 DAY), metrics_clicks, 0)) AS clicks30,
  SUM(metrics_clicks) AS clicks_all,
  SUM(metrics_impressions) AS impressions_all,
  ROUND(SUM(metrics_conversions), 2) AS conversions_all,
  CAST(MIN(segments_date) AS STRING) AS first_date, CAST(MAX(segments_date) AS STRING) AS last_date
FROM `lucirajewelry-prod.google_ads.ads_GeoStats_2348623547`
GROUP BY loc;
