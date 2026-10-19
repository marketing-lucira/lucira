-- Per-pincode reference data for the Pin Code page (added 2026-10-19, merged from Store Location
-- Intelligence): nearest LUCIRA store + distance (ds_imputed_reporting.store_location_store_master,
-- the 6 real customer-facing store addresses from the ERP company master, hand-geocoded), all-time
-- distinct sale buyers per pincode, and the sales reconciliation totals (q9 only carries mapped sales).
-- Covers every real pincode that has a Zoho deal OR a mapped sale -- the same universe as q6 ∪ q9.
-- Output: one row per pincode, plus ONE extra row with pincode = '__totals__' holding the
-- marketing_sale reconciliation (total vs mapped, by channel) as JSON in `totals_json`.
WITH stores AS (
  SELECT store_code, store_name, ST_GEOGPOINT(SAFE_CAST(longitude AS FLOAT64), SAFE_CAST(latitude AS FLOAT64)) AS pt
  FROM `lucirajewelry-prod.ds_imputed_reporting.store_location_store_master`
  WHERE store_code != 'FCS'  -- FCS shares CS1's exact Chembur address, not a separate store
), inv AS (
  SELECT document_no, ANY_VALUE(TRIM(CAST(shipping_pin_code AS STRING))) AS pin
  FROM `lucirajewelry-prod.ornaverse_erp_pos.invoice` GROUP BY 1
), pty AS (
  SELECT CAST(party_id AS STRING) AS party_id, ANY_VALUE(TRIM(CAST(pin_code AS STRING))) AS pin
  FROM `lucirajewelry-prod.ornaverse_erp_master.party` GROUP BY 1
), cm AS (
  SELECT mobile, ARRAY_AGG(pin ORDER BY prio LIMIT 1)[OFFSET(0)] AS pin FROM (
    SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'[^0-9]', ''), 10) AS mobile, TRIM(CAST(pin_code AS STRING)) AS pin, 1 AS prio FROM `lucirajewelry-prod.ornaverse_crm_data.customer`
    UNION ALL SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'[^0-9]', ''), 10), TRIM(CAST(zip_code AS STRING)), 2 FROM `lucirajewelry-prod.ds_imputed_reporting.Shopify_customer`
    UNION ALL SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'[^0-9]', ''), 10), TRIM(CAST(pincode AS STRING)), 3 FROM `lucirajewelry-prod.ds_imputed_reporting.customer`
  ) WHERE REGEXP_CONTAINS(mobile, r'^[6-9][0-9]{9}$') AND REGEXP_CONTAINS(pin, r'^[1-9][0-9]{5}$')
  GROUP BY mobile
), geo_raw AS (
  SELECT pincode, district, state, officename, SAFE_CAST(latitude AS FLOAT64) AS lat, SAFE_CAST(longitude AS FLOAT64) AS lon
  FROM `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup`
), district_center AS (
  -- median coordinate per district: the India-Post master has corrupt points (e.g. 201310 Greater
  -- Noida is stored at 25.46,74.86 = Rajasthan, 414 km from Noida). A pincode more than 75 km from
  -- its own district's median is snapped to that median (coord_fixed = TRUE) before distances.
  SELECT district, state,
    APPROX_QUANTILES(lat, 2)[OFFSET(1)] AS mlat, APPROX_QUANTILES(lon, 2)[OFFSET(1)] AS mlon
  FROM geo_raw WHERE lat BETWEEN 6 AND 38 AND lon BETWEEN 68 AND 98
  GROUP BY district, state
), geo AS (
  SELECT g.pincode, g.district, g.state, g.officename,
    IF(bad, dc.mlat, g.lat) AS lat, IF(bad, dc.mlon, g.lon) AS lon, bad AS coord_fixed
  FROM (
    SELECT g.*, dc0.mlat, dc0.mlon,
      (g.lat IS NULL OR NOT (g.lat BETWEEN 6 AND 38 AND g.lon BETWEEN 68 AND 98)
       OR ST_DISTANCE(SAFE.ST_GEOGPOINT(g.lon, g.lat), ST_GEOGPOINT(dc0.mlon, dc0.mlat)) > 75000) AND dc0.mlat IS NOT NULL AS bad
    FROM geo_raw g LEFT JOIN district_center dc0 ON dc0.district = g.district AND dc0.state = g.state
  ) g
  LEFT JOIN district_center dc ON dc.district = g.district AND dc.state = g.state
), s AS (
  SELECT
    s.document_no, s.Channel AS channel, s.net_sale,
    RIGHT(REGEXP_REPLACE(IFNULL(s.Cus_mobile, ''), r'[^0-9]', ''), 10) AS mobile,
    COALESCE(g1.pincode, g2.pincode, g3.pincode, g4.pincode, g5.pincode) AS pincode
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale` s
  LEFT JOIN inv ON inv.document_no = s.document_no
  LEFT JOIN pty ON pty.party_id = CAST(s.party_id AS STRING)
  LEFT JOIN cm ON cm.mobile = RIGHT(REGEXP_REPLACE(IFNULL(s.Cus_mobile, ''), r'[^0-9]', ''), 10)
  LEFT JOIN geo g1 ON g1.pincode = TRIM(CAST(s.Pin_code AS STRING))
  LEFT JOIN geo g2 ON g2.pincode = inv.pin
  LEFT JOIN geo g3 ON g3.pincode = pty.pin
  LEFT JOIN geo g4 ON g4.pincode = REGEXP_EXTRACT(CONCAT(IFNULL(s.address, ''), ' ', IFNULL(s.address_1, '')), r'\b([1-9][0-9]{5})\b')
  LEFT JOIN geo g5 ON g5.pincode = cm.pin
), s2 AS (
  SELECT *, IF(channel IN ('Online', 'Store'), pincode, NULL) AS mapped_pincode FROM s
), deal_pins AS (
  SELECT DISTINCT pin AS pincode FROM (
    SELECT CASE
      WHEN REGEXP_CONTAINS(TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code')), r'^[1-9][0-9]{5}$') THEN TRIM(JSON_VALUE(d.data, '$.Address_Zip_Postal_Code'))
      ELSE TRIM(JSON_VALUE(c.data, '$.Mailing_Zip')) END AS pin
    FROM `lucirajewelry-prod.zoho_crm.cdc_deals` d
    LEFT JOIN `lucirajewelry-prod.zoho_crm.cdc_contacts` c ON c.id = JSON_VALUE(d.data, '$.Contact_Name.id')
    UNION ALL
    SELECT TRIM(CAST(address_zip AS STRING)) FROM `lucirajewelry-prod.zoho_crm.deals_address_live_patch`
  )
), universe AS (
  SELECT pincode FROM deal_pins UNION DISTINCT SELECT mapped_pincode FROM s2 WHERE mapped_pincode IS NOT NULL
), buyers AS (
  SELECT mapped_pincode AS pincode, COUNT(DISTINCT NULLIF(mobile, '')) AS buyers_all_time
  FROM s2 WHERE mapped_pincode IS NOT NULL GROUP BY 1
), nearest AS (
  SELECT g.pincode,
    ARRAY_AGG(STRUCT(st.store_code, st.store_name, ST_DISTANCE(ST_GEOGPOINT(g.lon, g.lat), st.pt) / 1000 AS km) ORDER BY ST_DISTANCE(ST_GEOGPOINT(g.lon, g.lat), st.pt) LIMIT 1)[OFFSET(0)] AS n
  FROM universe u JOIN geo g ON g.pincode = u.pincode CROSS JOIN stores st
  WHERE g.lat BETWEEN 6 AND 38 AND g.lon BETWEEN 68 AND 98  -- India bounds; the India-Post master has a few corrupt coordinates
  GROUP BY g.pincode
)
SELECT
  u.pincode, g.district, INITCAP(g.state) AS state, g.officename AS office, g.lat, g.lon, g.coord_fixed,
  n.n.store_code AS nearest_store_code, n.n.store_name AS nearest_store, ROUND(n.n.km, 1) AS nearest_store_km,
  IFNULL(b.buyers_all_time, 0) AS buyers_all_time,
  CAST(NULL AS STRING) AS totals_json
FROM universe u
JOIN geo g ON g.pincode = u.pincode
LEFT JOIN nearest n ON n.pincode = u.pincode
LEFT JOIN buyers b ON b.pincode = u.pincode
UNION ALL
SELECT '__totals__', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  TO_JSON_STRING(ARRAY_AGG(STRUCT(channel, orders, net_sales, mapped_orders, mapped_net_sales) ORDER BY net_sales DESC))
FROM (
  SELECT channel, COUNT(DISTINCT document_no) AS orders, ROUND(SUM(net_sale)) AS net_sales,
    COUNT(DISTINCT IF(mapped_pincode IS NOT NULL, document_no, NULL)) AS mapped_orders,
    ROUND(SUM(IF(mapped_pincode IS NOT NULL, net_sale, 0))) AS mapped_net_sales
  FROM s2 GROUP BY channel
);
