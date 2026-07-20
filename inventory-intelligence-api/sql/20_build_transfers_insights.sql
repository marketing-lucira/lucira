-- ═══════════════════════════════════════════════════════════════════════════
--  DERIVED REPORTING TABLES — run right after 10_build_fact.sql in the same
--  scheduled query.  Both read ONLY the fact table, so they are cheap.
--
--    reporting.inventory_intelligence_transfers  — inter-store transfer recs
--    reporting.inventory_intelligence_insights   — auto AI business insights
--    reporting.inventory_intelligence_meta        — KPI headline rollups
-- ═══════════════════════════════════════════════════════════════════════════

DECLARE OVER_COVER_DAYS INT64 DEFAULT 180;
DECLARE LOW_COVER_DAYS  INT64 DEFAULT 15;

-- ───────────────────────────────────────────────────────────────────────────
--  STORE TRANSFER RECOMMENDATIONS
--  For each SKU: stores with excess (high cover, surplus over target) are
--  sources; stores with shortage (out / low cover but proven demand) are
--  destinations.  Suggested qty = min(surplus at source, need at destination).
--  Recommend transfers BEFORE manufacturing.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inventory_intelligence_transfers` AS
WITH f AS (
  SELECT * FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
  WHERE refresh_date = CURRENT_DATE()
),
surplus AS (   -- units a store can give up while staying above target cover
  SELECT sku, store AS source_store, item_name, style, category, mrp,
         current_stock,
         GREATEST(0, CAST(current_stock - CEIL(avg_daily_sales * 45) AS INT64)) AS surplus_units
  FROM f
  WHERE (is_over_stock OR avg_daily_sales = 0) AND current_stock > 1
),
shortage AS (  -- units a store needs to reach a safe position, with live demand
  SELECT sku, store AS dest_store, avg_daily_sales, cover_days,
         GREATEST(1, refill_qty) AS need_units, refill_priority_score
  FROM f
  WHERE avg_daily_sales > 0 AND (is_out_of_stock OR is_low_stock)
)
SELECT
  CURRENT_DATE()                                        AS refresh_date,
  su.sku, su.item_name, su.style, su.category,
  su.source_store, sh.dest_store,
  LEAST(su.surplus_units, sh.need_units)                AS suggested_qty,
  sh.avg_daily_sales                                    AS dest_daily_demand,
  sh.cover_days                                         AS dest_cover_days,
  su.mrp,
  CAST(ROUND(LEAST(su.surplus_units, sh.need_units) * IFNULL(su.mrp,0)) AS INT64) AS expected_value_moved,
  sh.refill_priority_score                              AS priority_score
FROM surplus su
JOIN shortage sh USING (sku)
WHERE su.source_store != sh.dest_store
  AND su.surplus_units >= 1
QUALIFY ROW_NUMBER() OVER (PARTITION BY su.sku, sh.dest_store ORDER BY su.surplus_units DESC) = 1
ORDER BY priority_score DESC, expected_value_moved DESC;

-- ───────────────────────────────────────────────────────────────────────────
--  AUTO AI INSIGHTS — one row per insight, regenerated each refresh.
--  Rendered as-is by the dashboard's AI Insights panel + Action Center.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inventory_intelligence_insights` AS
WITH f AS (
  SELECT * FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
  WHERE refresh_date = CURRENT_DATE()
),
agg AS (
  SELECT
    COUNTIF(stock_out_risk >= 60 AND days_cover <= 7)                    AS stockout_7d,
    COUNTIF(inventory_age > 180)                                         AS aged_180,
    COUNTIF(total_sold = 0)                                              AS never_sold,
    COUNTIF(is_dead_stock)                                               AS dead_cnt,
    CAST(ROUND(SUM(IF(is_dead_stock, inventory_value, 0))) AS INT64)     AS dead_value,
    COUNTIF(is_refill_required)                                          AS refill_cnt,
    COUNTIF(is_out_of_stock)                                             AS oos_cnt,
    COUNTIF(ai_recommendation='Increase Manufacturing')                 AS scale_up,
    COUNTIF(ai_recommendation='Stop Manufacturing')                     AS stop_mfg,
    CAST(ROUND(AVG(health_score)) AS INT64)                             AS avg_health
  FROM f
),
ins AS (
  SELECT 'risk' AS kind, 'critical' AS severity, 1 AS ord,
         CONCAT(CAST(stockout_7d AS STRING), ' products likely to stock out within 7 days') AS title,
         'Prioritise these on the next refill run before demand is lost.' AS detail FROM agg WHERE stockout_7d > 0
  UNION ALL
  SELECT 'aging', 'warn', 2,
         CONCAT(CAST(aged_180 AS STRING), ' products are older than 180 days'),
         'Review for promotion, transfer or liquidation to release capital.' FROM agg WHERE aged_180 > 0
  UNION ALL
  SELECT 'nosale', 'warn', 3,
         CONCAT(CAST(never_sold AS STRING), ' products have had no sale since GRN'),
         'Candidates to stop manufacturing and clear.' FROM agg WHERE never_sold > 0
  UNION ALL
  SELECT 'dead', 'critical', 4,
         CONCAT('₹', CAST(dead_value AS STRING), ' locked in ', CAST(dead_cnt AS STRING), ' dead SKUs'),
         'High-value dead inventory should be liquidated first.' FROM agg WHERE dead_cnt > 0
  UNION ALL
  SELECT 'refill', 'info', 5,
         CONCAT(CAST(refill_cnt AS STRING), ' SKUs require refill (', CAST(oos_cnt AS STRING), ' already out of stock)'),
         'Open the Refill Center to action by priority.' FROM agg WHERE refill_cnt > 0
  UNION ALL
  SELECT 'scale', 'good', 6,
         CONCAT(CAST(scale_up AS STRING), ' fast-movers should increase production'),
         'Demand is outpacing supply on these lines.' FROM agg WHERE scale_up > 0
  UNION ALL
  SELECT 'stop', 'info', 7,
         CONCAT(CAST(stop_mfg AS STRING), ' products should stop manufacturing'),
         'No demand signal — pause to avoid dead stock.' FROM agg WHERE stop_mfg > 0
  UNION ALL
  SELECT 'health', 'info', 8,
         CONCAT('Network inventory health score: ', CAST(avg_health AS STRING), '/100'),
         'Average across all in-scope jewelry SKUs.' FROM agg
),
-- store-level urgent refill
store_ins AS (
  SELECT 'store' AS kind, 'warn' AS severity, 20 AS ord,
    CONCAT(store, ' needs urgent refill on ', CAST(COUNT(*) AS STRING), ' SKUs') AS title,
    CONCAT('₹', CAST(CAST(ROUND(SUM(avg_daily_sales*mrp*21)) AS INT64) AS STRING), ' of demand at risk') AS detail
  FROM f WHERE is_out_of_stock OR is_low_stock GROUP BY store HAVING COUNT(*) >= 3
),
-- category performance
cat_ins AS (
  SELECT 'category' AS kind, 'good' AS severity, 30 AS ord,
    CONCAT('Best category by sell-through: ', category) AS title,
    CONCAT(CAST(ROUND(AVG(sell_through)*100) AS STRING), '% sell-through, ₹',
           CAST(CAST(ROUND(SUM(revenue_all)) AS INT64) AS STRING), ' revenue') AS detail
  FROM f WHERE category IS NOT NULL GROUP BY category
  QUALIFY ROW_NUMBER() OVER (ORDER BY AVG(sell_through) DESC) = 1
),
-- transfer opportunity
xfer_ins AS (
  SELECT 'transfer' AS kind, 'good' AS severity, 40 AS ord,
    CONCAT(CAST(COUNT(*) AS STRING), ' inter-store transfers can avoid manufacturing') AS title,
    CONCAT('₹', CAST(CAST(ROUND(SUM(expected_value_moved)) AS INT64) AS STRING), ' can be rebalanced across stores') AS detail
  FROM `lucirajewelry-prod.reporting.inventory_intelligence_transfers`
  WHERE refresh_date = CURRENT_DATE() HAVING COUNT(*) > 0
)
SELECT CURRENT_DATE() AS refresh_date, CURRENT_TIMESTAMP() AS generated_at, * FROM (
  SELECT * FROM ins
  UNION ALL SELECT * FROM store_ins
  UNION ALL SELECT * FROM cat_ins
  UNION ALL SELECT * FROM xfer_ins
)
ORDER BY ord;

-- ───────────────────────────────────────────────────────────────────────────
--  META / KPI ROLLUP — one row.  Powers the executive KPI strip instantly.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inventory_intelligence_meta` AS
SELECT
  CURRENT_DATE()                                              AS refresh_date,
  CURRENT_TIMESTAMP()                                         AS refreshed_at,
  CAST(SUM(current_stock) AS INT64)                          AS total_inventory,
  CAST(ROUND(SUM(inventory_value)) AS INT64)                 AS total_inventory_value,
  COUNT(DISTINCT sku)                                        AS total_sku,
  CAST(SUM(current_stock) AS INT64)                          AS current_live_inventory,
  CAST(SUM(total_sold) AS INT64)                             AS total_sold,
  CAST(SUM(sold_today) AS INT64)                             AS sales_today,
  CAST(SUM(sold_7) AS INT64)                                 AS sales_7d,
  CAST(SUM(sold_30) AS INT64)                                AS sales_30d,
  ROUND(SUM(sold_30)/30.0, 1)                                AS avg_daily_sales,
  ROUND(SAFE_DIVIDE(SUM(sold_90)*4.0, NULLIF(SUM(current_stock),0)), 2) AS inventory_turnover,
  ROUND(SAFE_DIVIDE(SUM(total_sold), NULLIF(SUM(total_sold)+SUM(current_stock),0))*100, 1) AS sell_through_pct,
  CAST(ROUND(AVG(health_score)) AS INT64)                    AS inventory_health_score,
  COUNTIF(is_dead_stock)                                     AS dead_inventory,
  COUNTIF(is_out_of_stock)                                   AS out_of_stock,
  COUNTIF(is_low_stock)                                      AS low_stock,
  COUNTIF(is_over_stock)                                     AS over_stock,
  COUNTIF(is_refill_required)                                AS refill_required_sku,
  ROUND(AVG(NULLIF(days_cover,999)), 0)                      AS avg_days_cover,
  CAST(ROUND(AVG(stock_out_risk)) AS INT64)                 AS avg_stock_out_risk
FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
WHERE refresh_date = CURRENT_DATE();
