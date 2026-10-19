-- Pin Code deals from Zoho CRM -- MERGED 2026-10-19 with the Store Location Intelligence logic
-- (dashboard/sql/store_location_zoho_ads_pull.sql Q15). Replaces the old version that read the
-- STALE Lucira_Prod.lucira_zoho_Deals copy, used Deal Address_Zip only (~12% of deals) and kept
-- only the top 300 pincodes.
--   * Source: zoho_crm.cdc_deals (live CDC, latest version per deal id).
--   * Pincode: the deal's own Address_Zip_Postal_Code (CDC, else zoho_crm.deals_address_live_patch)
--     if 6-digit, else the linked Contact's Mailing_Zip -- ~49% of deals land on a pincode.
--   * Only REAL India-Post pincodes (ds_imputed_reporting.pincode_geo_lookup) are kept.
--   * city/state come from India Post, mapped to GA4's own city names (Mumbai Suburban -> Mumbai,
--     Delhi districts -> Delhi, Gautam Buddha Nagar -> Noida ...) so the modelled GA4 columns on the
--     Pin Code page still find their city.
--   * pincode_source = 'deal' | 'contact'. ACCURACY: validated against the same buyer's ERP sale
--     pincode -- only ~4% exact, ~25% same district. Deal COUNTS are real; location is approximate.
-- Day grain (pincode, d, pincode_source) so the date-range filter works; the client re-aggregates.
WITH d AS (
  SELECT id, created_time, data FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
), c AS (
  SELECT id, data FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
  WHERE id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY synced_at DESC) = 1
), pz AS (
  SELECT CAST(id AS STRING) AS id, ANY_VALUE(TRIM(CAST(address_zip AS STRING))) AS zip
  FROM `lucirajewelry-prod.zoho_crm.deals_address_live_patch`
  WHERE REGEXP_CONTAINS(TRIM(CAST(address_zip AS STRING)), r'^[1-9][0-9]{5}$') GROUP BY 1
), x AS (
  SELECT
    DATE(d.created_time, 'Asia/Kolkata') AS d,
    JSON_VALUE(d.data, '$.Stage') AS stage,
    SAFE_CAST(JSON_VALUE(d.data, '$.Amount') AS FLOAT64) AS amount,
    CASE
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code'))
      WHEN pz.zip IS NOT NULL THEN pz.zip
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(c.data, '$.Mailing_Zip')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(c.data, '$.Mailing_Zip'))
    END AS pincode,
    CASE
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code')), r'^[1-9][0-9]{5}$') OR pz.zip IS NOT NULL THEN 'deal'
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(c.data, '$.Mailing_Zip')), r'^[1-9][0-9]{5}$') THEN 'contact'
    END AS pincode_source
  FROM d
  LEFT JOIN c ON c.id = JSON_VALUE(d.data, '$.Contact_Name.id')
  LEFT JOIN pz ON pz.id = d.id
)
SELECT
  x.pincode, CAST(x.d AS STRING) AS d, x.pincode_source,
  CASE
    WHEN UPPER(g.state) IN ('DELHI', 'NCT OF DELHI') THEN 'Delhi'
    WHEN UPPER(g.district) IN ('MUMBAI', 'MUMBAI SUBURBAN') THEN 'Mumbai'
    WHEN UPPER(g.district) IN ('BENGALURU URBAN', 'BENGALURU RURAL', 'BANGALORE', 'BANGALORE RURAL') THEN 'Bengaluru'
    WHEN UPPER(g.district) = 'GAUTAM BUDDHA NAGAR' THEN 'Noida'
    WHEN UPPER(g.district) IN ('GURGAON', 'GURUGRAM') THEN 'Gurugram'
    WHEN UPPER(g.district) = 'ERNAKULAM' THEN 'Kochi'
    WHEN UPPER(g.district) IN ('HYDERABAD', 'RANGAREDDY', 'MEDCHAL MALKAJGIRI', 'MEDCHAL-MALKAJGIRI') THEN 'Hyderabad'
    WHEN UPPER(g.district) IN ('AHMADABAD', 'AHMEDABAD') THEN 'Ahmedabad'
    WHEN UPPER(g.district) IN ('KHORDHA', 'KHURDA') THEN 'Bhubaneswar'
    WHEN UPPER(g.district) IN ('RANGA REDDY') THEN 'Hyderabad'
    WHEN UPPER(g.district) IN ('S.A.S NAGAR', 'SAS NAGAR') THEN 'Mohali'
    WHEN UPPER(g.district) = 'KANPUR NAGAR' THEN 'Kanpur'
    WHEN UPPER(g.district) IN ('KAMRUP', 'KAMRUP METRO', 'KAMRUP METROPOLITAN') THEN 'Guwahati'
    WHEN UPPER(g.district) IN ('VISAKHAPATANAM', 'VISAKHAPATNAM') THEN 'Visakhapatnam'
    WHEN UPPER(g.district) = 'NTR' THEN 'Vijayawada'
    WHEN UPPER(g.district) = 'EAST SINGHBUM' THEN 'Jamshedpur'
    WHEN UPPER(g.district) = 'DAKSHINA KANNADA' THEN 'Mangaluru'
    WHEN UPPER(g.district) = 'AURANGABAD' AND UPPER(g.state) = 'MAHARASHTRA' THEN 'Chhatrapati Sambhajinagar'
    ELSE INITCAP(g.district)
  END AS city,
  INITCAP(g.state) AS state,
  COUNT(*) AS deals,
  COUNTIF(x.stage = 'Closed Won') AS won,
  SUM(IFNULL(x.amount, 0)) AS amount
FROM x
JOIN `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup` g ON g.pincode = x.pincode
WHERE x.d IS NOT NULL
GROUP BY x.pincode, d, x.pincode_source, city, state
ORDER BY x.pincode, d;
