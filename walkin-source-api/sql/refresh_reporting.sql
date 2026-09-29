-- Lucira Walk-in Source Intelligence — daily reporting-layer refresh.
-- Run as ONE BigQuery script (multi-statement, single job, atomic) by Cloud
-- Scheduler -> walkin-source-snapshot /refresh, at 10:00 IST daily.
--
-- Rebuilds, in order:
--   1) customer_master_source — every normalized mobile number seen in
--      Shopify / WebEngage / Zoho Deals / Zoho Leads, with a presence flag per source.
--   2) walkin_channel_final — every StoreVisit row in Walkin_marge, matched against
--      (1) with channel priority Shopify > WebEngage > Zoho Deals > Zoho Leads > Direct Walkin,
--      plus store/city/state/region lookup and a real New/Repeat signal (visit_seq==1).
--
-- This is the single canonical copy of this DDL (mirrors sales-reporting-api's
-- sql/refresh_reporting.sql layout) — it is what actually runs in production.

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.customer_master_source` AS
WITH shop AS (
  SELECT DISTINCT RIGHT(REGEXP_REPLACE(phone, r'[^0-9]', ''), 10) AS mobile_number
  FROM `lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_customers`
  WHERE phone IS NOT NULL
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(phone, r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
),
web AS (
  -- WebEngage has no dedicated phone column; cuid carries the +91-prefixed mobile used to
  -- target email/sms/push/whatsapp/RCS campaigns, so it's the correct match key here.
  SELECT DISTINCT RIGHT(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 10) AS mobile_number
  FROM `lucirajewelry-prod.Lucira_Prod.Webengage_Final`
  WHERE cuid IS NOT NULL
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
),
deals AS (
  SELECT DISTINCT RIGHT(REGEXP_REPLACE(Mobile, r'[^0-9]', ''), 10) AS mobile_number
  FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
  WHERE Mobile IS NOT NULL
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(Mobile, r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
),
leads AS (
  SELECT DISTINCT RIGHT(REGEXP_REPLACE(COALESCE(Mobile, Phone), r'[^0-9]', ''), 10) AS mobile_number
  FROM `lucirajewelry-prod.zoho_crm.daily_leads`
  WHERE COALESCE(Mobile, Phone) IS NOT NULL
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(COALESCE(Mobile, Phone), r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
),
all_mobiles AS (
  SELECT mobile_number FROM shop
  UNION DISTINCT SELECT mobile_number FROM web
  UNION DISTINCT SELECT mobile_number FROM deals
  UNION DISTINCT SELECT mobile_number FROM leads
)
SELECT
  a.mobile_number,
  s.mobile_number IS NOT NULL AS shopify_flag,
  w.mobile_number IS NOT NULL AS webengage_flag,
  d.mobile_number IS NOT NULL AS zoho_deals_flag,
  l.mobile_number IS NOT NULL AS zoho_leads_flag
FROM all_mobiles a
LEFT JOIN shop   s USING (mobile_number)
LEFT JOIN web    w USING (mobile_number)
LEFT JOIN deals  d USING (mobile_number)
LEFT JOIN leads  l USING (mobile_number);

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.walkin_channel_final` AS
WITH base AS (
  SELECT
    event_name,
    store_code,
    customer_name,
    phone,
    email,
    SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date) AS visit_ts,
    state AS order_link_status,  -- source column is mislabeled "state"; it actually holds an order/fulfilment status (Completed/Rts/MTO/Billed Returns/Pending/TAH/None), not geography
    RIGHT(REGEXP_REPLACE(phone, r'[^0-9]', ''), 10) AS mobile_number
  FROM `lucirajewelry-prod.ds_imputed_reporting.Walkin_marge`
  WHERE phone IS NOT NULL
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(phone, r'[^0-9]', ''), 10), r'^[6-9][0-9]{9}$')
),
enriched AS (
  SELECT
    b.*,
    COALESCE(cms.shopify_flag, FALSE)     AS shopify_flag,
    COALESCE(cms.webengage_flag, FALSE)   AS webengage_flag,
    COALESCE(cms.zoho_deals_flag, FALSE)  AS zoho_deals_flag,
    COALESCE(cms.zoho_leads_flag, FALSE)  AS zoho_leads_flag,
    -- channel priority (client change, 2026-07-28): Zoho Deals > Zoho Leads > Shopify > WebEngage > Direct Walkin
    CASE
      WHEN COALESCE(cms.zoho_deals_flag, FALSE) THEN 'Zoho Deals'
      WHEN COALESCE(cms.zoho_leads_flag, FALSE) THEN 'Zoho Leads'
      WHEN COALESCE(cms.shopify_flag, FALSE)    THEN 'Shopify'
      WHEN COALESCE(cms.webengage_flag, FALSE)  THEN 'WebEngage'
      ELSE 'Direct Walkin'
    END AS customer_channel
  FROM base b
  LEFT JOIN `lucirajewelry-prod.ds_imputed_reporting.customer_master_source` cms
    USING (mobile_number)
),
seq AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY mobile_number ORDER BY visit_ts) AS visit_seq,
    COUNT(*)     OVER (PARTITION BY mobile_number)                   AS lifetime_visits
  FROM enriched
)
SELECT
  ROW_NUMBER() OVER (ORDER BY visit_ts) AS visit_id,
  event_name,
  store_code,
  CASE store_code
    WHEN 'HO'  THEN 'Head Office / Online Fulfilment'
    WHEN 'CS1' THEN 'Chembur'
    WHEN 'PN1' THEN 'Pune'
    WHEN 'BO1' THEN 'Borivali'
    WHEN 'N18' THEN 'Noida'
    WHEN 'PV1' THEN 'Pashchim Vihar'
    WHEN 'FCS' THEN 'FCS (unmapped)'
    ELSE 'Unassigned'
  END AS store_name,
  CASE store_code
    WHEN 'HO' THEN 'Mumbai' WHEN 'CS1' THEN 'Mumbai' WHEN 'BO1' THEN 'Mumbai'
    WHEN 'PN1' THEN 'Pune' WHEN 'N18' THEN 'Noida' WHEN 'PV1' THEN 'Delhi NCR'
    ELSE NULL
  END AS city,
  CASE store_code
    WHEN 'HO' THEN 'Maharashtra' WHEN 'CS1' THEN 'Maharashtra' WHEN 'BO1' THEN 'Maharashtra'
    WHEN 'PN1' THEN 'Maharashtra' WHEN 'N18' THEN 'Uttar Pradesh' WHEN 'PV1' THEN 'Delhi'
    ELSE NULL
  END AS state,
  CASE store_code
    WHEN 'N18' THEN 'North' WHEN 'PV1' THEN 'North'
    WHEN 'HO' THEN 'West' WHEN 'CS1' THEN 'West' WHEN 'BO1' THEN 'West' WHEN 'PN1' THEN 'West'
    ELSE NULL
  END AS region,
  customer_name,
  mobile_number,
  email,
  visit_ts,
  DATE(visit_ts) AS visit_date,
  order_link_status,
  shopify_flag,
  webengage_flag,
  zoho_deals_flag,
  zoho_leads_flag,
  customer_channel,
  visit_seq,
  lifetime_visits,
  IF(visit_seq = 1, 'New', 'Repeat') AS customer_type
FROM seq
ORDER BY visit_ts;
