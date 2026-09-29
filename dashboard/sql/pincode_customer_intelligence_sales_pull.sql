-- Pincode-Level Customer Intelligence — Sales pull (marketing_sale has NO cuid and NO pincode
-- column at all, confirmed live via schema inspection 2026-09-16). Customer identity here is
-- Cus_mobile, normalized with the SAME mandated rule (RIGHT(TRIM(CAST(...AS STRING)),10)) so it
-- can be matched client-side against the WebEngage normalized_cuid from
-- pincode_customer_intelligence_pull.sql Q1/Q2. This is a same-project query
-- (lucirajewelry-prod only) -- no cross-region concern here, but it still can't be joined to the
-- test-webengage query results in one SQL job, so the match happens in
-- etl/build_pincode_customer_intelligence.js.
--
-- Run: bq query --use_legacy_sql=false --format=json --project_id=lucirajewelry-prod --max_rows=500000 < <one block at a time>

-- ════════════════════════════════════════════════════════════════════════
-- Q1: Customer-level sales aggregation (aggregate BEFORE any join, per spec section 6 --
-- prevents inflated sales/order counts from a fan-out join against raw WebEngage events).
-- ════════════════════════════════════════════════════════════════════════
SELECT
  RIGHT(TRIM(CAST(Cus_mobile AS STRING)), 10) AS normalized_mobile,
  COUNT(DISTINCT document_no) AS sales_orders,
  COUNT(*) AS sales_line_items,
  SUM(net_sale) AS net_sales,
  MIN(Transaction_Date) AS first_order_date,
  MAX(Transaction_Date) AS last_order_date,
  STRING_AGG(DISTINCT company_code, ',') AS company_codes,
  STRING_AGG(DISTINCT Channel, ',') AS channels,
  STRING_AGG(DISTINCT item_group_name, ',' LIMIT 5) AS product_categories
FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
WHERE Cus_mobile IS NOT NULL AND TRIM(Cus_mobile) != ''
GROUP BY normalized_mobile;

-- ════════════════════════════════════════════════════════════════════════
-- Q2: Validation — total rows, distinct normalized mobiles, total net_sale (before any join),
-- for the Data Quality section's "sales totals before vs after join" check.
-- ════════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*) AS total_rows,
  COUNT(DISTINCT document_no) AS distinct_orders,
  COUNT(DISTINCT RIGHT(TRIM(CAST(Cus_mobile AS STRING)), 10)) AS distinct_norm_mobile,
  SUM(net_sale) AS total_net_sale
FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`;
