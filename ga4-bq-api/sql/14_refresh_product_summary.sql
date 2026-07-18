-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh ga4_product_summary for ONE date (date × item_name × category ×
-- brand). Higher-level product rollup (vs SKU/item_id grain) for category/brand
-- analysis and contribution %. BigQuery GoogleSQL (ignore T-SQL warnings).
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE suffix      STRING DEFAULT FORMAT_DATE('%Y%m%d', target_date);

DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_product_summary`
WHERE event_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_product_summary`
WITH item_rows AS (
  SELECT
    event_name,
    it.item_name, it.item_brand, it.item_category,
    it.quantity, it.item_revenue
  FROM `lucirajewelry-prod.analytics_478308692.events_*`,
       UNNEST(items) AS it
  WHERE _TABLE_SUFFIX = suffix
    AND event_name IN ('view_item','add_to_cart','begin_checkout','purchase')
)
SELECT
  target_date AS event_date,
  COALESCE(NULLIF(item_name, ''),  '(not set)') AS item_name,
  COALESCE(NULLIF(item_category,''),'(not set)') AS item_category,
  COALESCE(NULLIF(item_brand, ''), '(not set)') AS item_brand,
  COUNTIF(event_name = 'view_item')             AS item_views,
  COUNTIF(event_name = 'add_to_cart')           AS items_added,
  COUNTIF(event_name = 'begin_checkout')        AS items_checkout,
  SUM(IF(event_name = 'purchase', COALESCE(quantity, 0), 0))     AS items_purchased,
  SUM(IF(event_name = 'purchase', COALESCE(item_revenue, 0), 0)) AS item_revenue
FROM item_rows
GROUP BY item_name, item_category, item_brand;
