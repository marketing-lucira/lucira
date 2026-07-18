-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh ga4_sku_summary for ONE date (date × item_id). Item-level funnel
-- (view → add → checkout → purchase) + SKU revenue/refunds. Unnests the GA4
-- `items` array per ecommerce event. BigQuery GoogleSQL (ignore T-SQL warnings).
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE suffix      STRING DEFAULT FORMAT_DATE('%Y%m%d', target_date);

DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_sku_summary`
WHERE event_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_sku_summary`
WITH item_rows AS (
  SELECT
    event_name,
    -- generate a stable per-event id so we can count distinct purchase events per SKU
    CONCAT(user_pseudo_id, '-', CAST(event_timestamp AS STRING)) AS event_key,
    it.item_id, it.item_name, it.item_brand, it.item_category,
    it.quantity, it.item_revenue
  FROM `lucirajewelry-prod.analytics_478308692.events_*`,
       UNNEST(items) AS it
  WHERE _TABLE_SUFFIX = suffix
    AND event_name IN ('view_item','add_to_cart','begin_checkout','purchase','refund')
)
SELECT
  target_date AS event_date,
  COALESCE(NULLIF(item_id, ''),   '(not set)')  AS item_id,
  COALESCE(NULLIF(item_name, ''), '(not set)')  AS item_name,
  COALESCE(NULLIF(item_brand, ''),'(not set)')  AS item_brand,
  COALESCE(NULLIF(item_category,''),'(not set)') AS item_category,
  COUNTIF(event_name = 'view_item')             AS item_views,
  COUNTIF(event_name = 'add_to_cart')           AS items_added,
  COUNTIF(event_name = 'begin_checkout')        AS items_checkout,
  SUM(IF(event_name = 'purchase', COALESCE(quantity, 0), 0)) AS items_purchased,
  COUNT(DISTINCT IF(event_name = 'purchase', event_key, NULL)) AS purchases,
  SUM(IF(event_name = 'purchase', COALESCE(item_revenue, 0), 0)) AS item_revenue,
  COUNTIF(event_name = 'refund')                AS refunds,
  SUM(IF(event_name = 'refund', COALESCE(item_revenue, 0), 0))   AS refund_value
FROM item_rows
GROUP BY item_id, item_name, item_brand, item_category;
