-- Daily Zoho deal-pincode coverage for the Pin Code page KPIs (added 2026-10-19): every deal
-- created per IST day vs how many of them resolve to a REAL India-Post pincode with the same
-- rules as q6_zoho_pincode.sql (deal zip / address patch / contact Mailing_Zip). Lets the page
-- show "deals with / without a pincode" for whatever date range is selected.
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
    CASE
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code'))
      WHEN pz.zip IS NOT NULL THEN pz.zip
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(c.data, '$.Mailing_Zip')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(c.data, '$.Mailing_Zip'))
    END AS pincode
  FROM d
  LEFT JOIN c ON c.id = JSON_VALUE(d.data, '$.Contact_Name.id')
  LEFT JOIN pz ON pz.id = d.id
)
SELECT
  CAST(x.d AS STRING) AS d,
  COUNT(*) AS deals_total,
  COUNTIF(g.pincode IS NOT NULL) AS deals_with_pincode
FROM x
LEFT JOIN `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup` g ON g.pincode = x.pincode
WHERE x.d IS NOT NULL
GROUP BY d
ORDER BY d;
