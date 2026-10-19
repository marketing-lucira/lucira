-- Real SALES by the sale's OWN pincode (added 2026-10-19, merged from Store Location Intelligence,
-- see dashboard/sql/store_location_app_events_pull.sql Q14/Q14b).
-- Source: lucirajewelry-prod.ds_imputed_reporting.marketing_sale -- the authoritative company sales
-- ledger. Each line item's pincode = first REAL India-Post pincode of:
--   1) marketing_sale.Pin_code   2) ERP POS invoice shipping_pin_code (document_no)
--   3) ERP customer master party.pin_code (party_id -- the main source for Store sales)
--   4) a 6-digit pincode inside the sale's address text
--   5) the customer's typed record by mobile (ERP CRM customer > Shopify customer > imputed customer)
-- Amazon / Managment_sale / TAH are NOT customer-located (their ERP party is the marketplace or an
-- internal account) and are never put on a pincode -- q9b reports them in the totals.
-- Day grain (pincode, d, channel, pincode_source). 'orders' = distinct document_no.
-- 'buyers' is distinct customers per row (NOT additive across days -- the page uses it per pincode
-- only via q9c's all-time buyer count).
WITH inv AS (
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
), geo AS (
  SELECT pincode FROM `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup`
), s AS (
  SELECT
    s.document_no, s.Transaction_Date AS d, s.Channel AS channel, s.net_sale, s.pieces,
    RIGHT(REGEXP_REPLACE(IFNULL(s.Cus_mobile, ''), r'[^0-9]', ''), 10) AS mobile,
    TRIM(CAST(s.Pin_code AS STRING)) AS p1, inv.pin AS p2, pty.pin AS p3,
    REGEXP_EXTRACT(CONCAT(IFNULL(s.address, ''), ' ', IFNULL(s.address_1, '')), r'\b([1-9][0-9]{5})\b') AS p4
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale` s
  LEFT JOIN inv ON inv.document_no = s.document_no
  LEFT JOIN pty ON pty.party_id = CAST(s.party_id AS STRING)
  WHERE s.Channel IN ('Online', 'Store')
), r AS (
  SELECT s.*,
    COALESCE(g1.pincode, g2.pincode, g3.pincode, g4.pincode, g5.pincode) AS pincode,
    CASE WHEN g1.pincode IS NOT NULL THEN 'sale_pin_code' WHEN g2.pincode IS NOT NULL THEN 'invoice_shipping'
         WHEN g3.pincode IS NOT NULL THEN 'erp_customer_master' WHEN g4.pincode IS NOT NULL THEN 'sale_address'
         WHEN g5.pincode IS NOT NULL THEN 'crm_shopify_customer' END AS pincode_source
  FROM s
  LEFT JOIN geo g1 ON g1.pincode = s.p1
  LEFT JOIN geo g2 ON g2.pincode = s.p2
  LEFT JOIN geo g3 ON g3.pincode = s.p3
  LEFT JOIN geo g4 ON g4.pincode = s.p4
  LEFT JOIN cm ON cm.mobile = s.mobile
  LEFT JOIN geo g5 ON g5.pincode = cm.pin
)
SELECT
  r.pincode, CAST(r.d AS STRING) AS d, r.channel, r.pincode_source,
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
  COUNT(DISTINCT r.document_no) AS orders,
  ROUND(SUM(r.net_sale), 2) AS net_sales,
  SUM(r.pieces) AS units
FROM r
JOIN `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup` g ON g.pincode = r.pincode
GROUP BY r.pincode, d, r.channel, r.pincode_source, city, state
ORDER BY r.pincode, d;
