-- ═══════════════════════════════════════════════════════════════════════════
-- Inventory master reporting build — run on a schedule (BigQuery Scheduled Query).
-- The dashboard API reads ONLY these reporting tables, never the raw sources,
-- so per-request cost is tiny and latency is low. Rebuilt daily/6-hourly.
--
-- Scope baked in: jewelry only (Silver metal + all coins excluded); velocity
-- window 90 days. Change here + let the schedule refresh.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Item-grain master (inventory × velocity × GA4 signals) --------------------
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inventory_master` AS
WITH sales_vel AS (
  SELECT Full_sku,
         SUM(pieces)                             AS sold_win,
         SUM(SAFE_CAST(gross_amount AS FLOAT64)) AS rev_win,
         MAX(Transaction_Date)                   AS last_sale_win,
         COUNT(DISTINCT Transaction_Date)        AS active_days
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE Transaction_Date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) AND pieces > 0
  GROUP BY Full_sku
),
sales_all AS (
  SELECT Full_sku, MAX(Transaction_Date) AS last_sale_all, SUM(pieces) AS sold_all
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE pieces > 0 GROUP BY Full_sku
),
inv AS (
  SELECT
    Store_name, location_name, Full_sku,
    ANY_VALUE(item_name)       AS item_name,
    ANY_VALUE(style_code)      AS style_code,
    ANY_VALUE(type_name)       AS category,
    ANY_VALUE(collection_name) AS collection,
    ANY_VALUE(metal_name)      AS metal,
    ANY_VALUE(karat_name)      AS purity,
    ANY_VALUE(item_group_name) AS item_group,
    ANY_VALUE(sub_type_name)   AS sub_type,
    ANY_VALUE(stone_color_name) AS stone,
    ANY_VALUE(first_image)     AS image,
    ANY_VALUE(Shopify_price)   AS shopify_price,
    ANY_VALUE(shpify_tags)     AS tags,
    SUM(pieces)                                   AS on_hand,
    SUM(SAFE_CAST(item_rate AS FLOAT64) * pieces) AS cost_value,
    SUM(IFNULL(is_allocated,0))                   AS allocated,
    SUM(IFNULL(pdp_views,0))                      AS pdp_views,
    SUM(IFNULL(add_to_cart,0))                    AS add_to_cart,
    SUM(IFNULL(begin_checkout,0))                 AS begin_checkout,
    MIN(document_date)                            AS first_stock_date,
    MAX(document_date)                            AS last_stock_date
  FROM `lucirajewelry-prod.ds_imputed_reporting.Live_inventory`
  WHERE pieces > 0
    AND IFNULL(metal_name,'') NOT IN ('Silver')
    AND IFNULL(type_name,'')  NOT IN ('Silver Coin','Gold Coin')
  GROUP BY Store_name, location_name, Full_sku
)
SELECT
  i.Store_name, i.location_name, i.Full_sku, i.item_name, i.style_code, i.category,
  i.collection, i.metal, i.purity, i.item_group, i.sub_type, i.stone, i.image,
  i.shopify_price, i.tags, i.on_hand, i.cost_value, i.allocated, i.pdp_views,
  i.add_to_cart, i.begin_checkout, i.first_stock_date, i.last_stock_date,
  DATE_DIFF(CURRENT_DATE(), i.first_stock_date, DAY) AS days_in_stock,
  v.sold_win, v.rev_win, v.last_sale_win, v.active_days,
  a.last_sale_all, a.sold_all,
  CURRENT_TIMESTAMP() AS _refreshed_at
FROM inv i
LEFT JOIN sales_vel v USING (Full_sku)
LEFT JOIN sales_all a USING (Full_sku);

-- 2) GA4 city geo (last 30d) --------------------------------------------------
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inv_ga4_geo` AS
SELECT
  geo.city   AS city,
  geo.region AS region,
  COUNTIF(event_name = 'view_item')       AS view_item,
  COUNTIF(event_name = 'add_to_cart')     AS add_to_cart,
  COUNTIF(event_name = 'add_to_wishlist') AS add_to_wishlist,
  COUNTIF(event_name = 'begin_checkout')  AS begin_checkout,
  COUNTIF(event_name = 'purchase')        AS purchase
FROM `lucirajewelry-prod.analytics_478308692.events_*`
WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
  AND geo.country = 'India' AND geo.city IS NOT NULL AND geo.city != '(not set)'
GROUP BY city, region
ORDER BY view_item DESC
LIMIT 40;

-- 3) GA4 funnel totals (last 30d) ---------------------------------------------
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inv_ga4_funnel` AS
SELECT
  event_name,
  COUNT(*)                       AS events,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM `lucirajewelry-prod.analytics_478308692.events_*`
WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
  AND event_name IN ('view_item','add_to_cart','add_to_wishlist','begin_checkout',
                     'add_payment_info','purchase','view_cart','remove_from_cart')
GROUP BY event_name;
