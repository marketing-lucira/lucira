-- ═══════════════════════════════════════════════════════════════════════════
--  INVENTORY REFILLING INTELLIGENCE — CONSOLIDATED FACT-TABLE BUILD
--  Single source of truth for the whole dashboard.  Runs as a BigQuery
--  Scheduled Query every day at 09:00 IST.  The dashboard / API read ONLY the
--  reporting tables produced here — never the raw sources.
--
--  Grain: one row per (item_code × store).  store = Live_inventory.location_name.
--  Scope baked in EVERYWHERE: jewelry only — Silver metal and every Coin/bullion
--  product are excluded from every measure, KPI and recommendation.
--
--  REAL SCHEMAS (introspected 2026-07-20, live BigQuery) ──────────────────────
--   Live_inventory  : location_name(store), item_code, sku, style_code, item_name,
--     type_name(category), sub_type_name, item_group_name, collection_name,
--     metal_name, karat_name, stone_color_name, party_name(supplier), image,
--     net_weight, item_rate(unit value), pieces(on-hand), document_date(stock-in).
--     NB store_filter is uniformly 'Store' (useless); location_name is the store.
--   Sales_overview_table : Full_sku, style_code, Transaction_Date, pieces,
--     gross_amount, company_code, type_name, metal_name, ...
--   GRN table (name has a SPACE): transaction_type, document_date, sku, style,
--     location(HO only), document_no, pieces.
--   Inventory_pivot : Item_code(=style_code), today_date, + one INT col per store
--     code (FCS/PV1/LPN/N18/BO1/CS1/PN1/HO) — used only for cross-check (R-queries).
--
--  KEY BRIDGES (measured overlaps):
--   • Live.style_code = Inventory_pivot.Item_code   ≈ 100%
--   • Live.style_code = GRN.style                    98% of styles have GRN
--   • Sales↔Live velocity: join by item_code=Full_sku OR style_code=style
--     (coalesced) → ~776/2530 items carry velocity; the rest are genuinely
--     no-recent-sale (slow/dead) — a real signal, not fabricated.
--
--  Velocity is NETWORK-WIDE per item then ALLOCATED to stores by on-hand share,
--  so KPI sums stay exact and days-of-cover is the item's network cover.
--
--  Tunables (edit; next 09:00 run applies):
--    LEAD_TIME_DAYS 21 · TARGET_COVER_DAYS 60 · LOW_COVER_DAYS 15
--    OVER_COVER_DAYS 180 · DEAD_DAYS 180 · VELOCITY_WINDOW 90
-- ═══════════════════════════════════════════════════════════════════════════

DECLARE LEAD_TIME_DAYS     INT64 DEFAULT 21;
DECLARE TARGET_COVER_DAYS  INT64 DEFAULT 60;
DECLARE LOW_COVER_DAYS     INT64 DEFAULT 15;
DECLARE OVER_COVER_DAYS    INT64 DEFAULT 180;
DECLARE DEAD_DAYS          INT64 DEFAULT 180;

CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.reporting`;

CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inventory_intelligence_fact`
PARTITION BY refresh_date
CLUSTER BY store, category, inventory_status AS
WITH
-- Store crosswalk keyed by Live_inventory.location_name.
store_xwalk AS (
  SELECT * FROM UNNEST([
    STRUCT('Finish Goods'     AS location_name, 'HO'  AS company, 'Central Warehouse' AS city, 'HO'         AS region),
    STRUCT('Wave Noida',       'N18', 'Noida',       'North'),
    STRUCT('Lajpat Nagar',     'LPN', 'New Delhi',   'North'),
    STRUCT('Paschim Vihar',    'PV1', 'New Delhi',   'North'),
    STRUCT('Pune JM Road',     'PN1', 'Pune',        'West'),
    STRUCT('SkyCity Borivali', 'BO1', 'Mumbai',      'West'),
    STRUCT('Chembur Store',    'CS1', 'Mumbai',      'West'),
    STRUCT('Market Place',     'FCS', 'Online',      'Pan-India')
  ])
),

-- 1) Jewelry-only inventory, per store(location_name) × item_code. Live_inventory
--    is authoritative for on-hand and attributes.
inv AS (
  SELECT
    IFNULL(NULLIF(TRIM(location_name), ''), 'Unassigned')  AS store,
    item_code                                              AS item_code,
    ANY_VALUE(sku)                                         AS sku,
    ANY_VALUE(style_code)                                  AS style,
    ANY_VALUE(item_name)                                   AS item_name,
    ANY_VALUE(type_name)                                   AS category,
    ANY_VALUE(sub_type_name)                               AS sub_category,
    ANY_VALUE(item_group_name)                             AS product_type,
    ANY_VALUE(collection_name)                             AS collection,
    ANY_VALUE(metal_name)                                  AS metal,
    ANY_VALUE(karat_name)                                  AS purity,
    ANY_VALUE(stone_color_name)                            AS stone,
    ANY_VALUE(CAST(NULL AS STRING))                        AS gender,     -- no source column
    ANY_VALUE(party_name)                                  AS vendor,     -- supplier of the stock
    ANY_VALUE(CAST(NULL AS STRING))                        AS designer,   -- no source column
    ANY_VALUE(image)                                       AS image,
    ANY_VALUE(SAFE_CAST(item_rate AS FLOAT64))             AS mrp,        -- unit value proxy
    ANY_VALUE(SAFE_CAST(net_weight AS FLOAT64))            AS weight,
    SUM(SAFE_CAST(pieces AS FLOAT64))                              AS on_hand,
    SUM(SAFE_CAST(item_rate AS FLOAT64) * SAFE_CAST(pieces AS FLOAT64)) AS inventory_value,
    MIN(SAFE_CAST(document_date AS DATE))                  AS first_stock_date,
    MAX(SAFE_CAST(document_date AS DATE))                  AS last_stock_date
  FROM `lucirajewelry-prod.ds_imputed_reporting.Live_inventory`
  WHERE item_code IS NOT NULL
    AND SAFE_CAST(pieces AS FLOAT64) IS NOT NULL
    AND IFNULL(metal_name, '') NOT IN ('Silver')
    AND IFNULL(type_name, '')  NOT IN ('Gold Coin', 'Silver Coin', 'Coin')
    AND LOWER(IFNULL(type_name, '')) NOT LIKE '%coin%'
  GROUP BY store, item_code
),

-- item_code → style_code map (for velocity/GRN joins) + network on-hand total.
item_key AS (
  SELECT item_code, ANY_VALUE(style) AS style, SUM(on_hand) AS total_on_hand
  FROM inv GROUP BY item_code
),

-- 2) Sales velocity — network-wide, aggregated two ways so we can match by the
--    precise SKU (Full_sku) OR fall back to style. Jewelry only.
sales_base AS (
  SELECT Full_sku, style_code, image_url,
         SAFE_CAST(Transaction_Date AS DATE) AS d,
         SAFE_CAST(pieces AS FLOAT64) AS q,
         SAFE_CAST(gross_amount AS FLOAT64) AS amt
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE IFNULL(metal_name, '') NOT IN ('Silver')
    AND IFNULL(type_name, '')  NOT IN ('Gold Coin', 'Silver Coin', 'Coin')
    AND LOWER(IFNULL(type_name, '')) NOT LIKE '%coin%'
),
sales_by_full AS (
  SELECT Full_sku AS k,
    ANY_VALUE(IF(image_url!='',image_url,NULL)) img,
    SUM(q) sold_all, SUM(amt) rev_all, MIN(d) first_sale, MAX(d) last_sale,
    COUNT(DISTINCT d) active_days,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 1   DAY),q,0)) s1,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 7   DAY),q,0)) s7,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 30  DAY),q,0)) s30,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 90  DAY),q,0)) s90,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 180 DAY),q,0)) s180
  FROM sales_base WHERE Full_sku IS NOT NULL GROUP BY k
),
sales_by_style AS (
  SELECT style_code AS k,
    ANY_VALUE(IF(image_url!='',image_url,NULL)) img,
    SUM(q) sold_all, SUM(amt) rev_all, MIN(d) first_sale, MAX(d) last_sale,
    COUNT(DISTINCT d) active_days,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 1   DAY),q,0)) s1,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 7   DAY),q,0)) s7,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 30  DAY),q,0)) s30,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 90  DAY),q,0)) s90,
    SUM(IF(d>=DATE_SUB(CURRENT_DATE(),INTERVAL 180 DAY),q,0)) s180
  FROM sales_base WHERE style_code IS NOT NULL AND style_code!='' GROUP BY k
),

-- 3) GRN — goods received, network per style (GRN.location is HO only).
grn AS (
  SELECT style AS k, SUM(SAFE_CAST(pieces AS FLOAT64)) grn_qty,
         MIN(SAFE_CAST(document_date AS DATE)) first_grn, MAX(SAFE_CAST(document_date AS DATE)) last_grn
  FROM `lucirajewelry-prod.Lucira_Prod.GRN table` GROUP BY k
),

-- 4) Network velocity per item_code: prefer precise Full_sku match, else style.
item_vel AS (
  SELECT
    ik.item_code, ik.style, ik.total_on_hand,
    COALESCE(f.sold_all,  st.sold_all,  0)                 AS sold_all,
    COALESCE(f.rev_all,   st.rev_all,   0)                 AS rev_all,
    COALESCE(f.first_sale, st.first_sale)                  AS first_sale,
    COALESCE(f.last_sale,  st.last_sale)                   AS last_sale,
    COALESCE(f.active_days, st.active_days, 0)             AS active_days,
    COALESCE(f.s1,  st.s1,  0) AS s1,  COALESCE(f.s7,  st.s7,  0) AS s7,
    COALESCE(f.s30, st.s30, 0) AS s30, COALESCE(f.s90, st.s90, 0) AS s90,
    COALESCE(f.s180, st.s180, 0) AS s180,
    COALESCE(f.img, st.img) AS image_url,
    g.grn_qty, g.first_grn, g.last_grn
  FROM item_key ik
  LEFT JOIN sales_by_full  f  ON f.k  = ik.item_code
  LEFT JOIN sales_by_style st ON st.k = ik.style
  LEFT JOIN grn            g  ON g.k  = ik.style
),

-- 5) Allocate network velocity to stores by on-hand share, then derive metrics.
alloc AS (
  SELECT
    i.*, iv.style AS _style, iv.first_sale, iv.last_sale, iv.first_grn, iv.last_grn,
    iv.active_days, iv.image_url AS shopify_image,
    SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand, 0)) AS share,
    iv.total_on_hand,
    iv.sold_all  * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS store_sold_all,
    iv.rev_all   * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS store_rev,
    iv.grn_qty   * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS store_grn,
    iv.s1  * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS s1,
    iv.s7  * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS s7,
    iv.s30 * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS s30,
    iv.s90 * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS s90,
    iv.s180 * IFNULL(SAFE_DIVIDE(i.on_hand, NULLIF(iv.total_on_hand,0)),0) AS s180
  FROM inv i
  LEFT JOIN item_vel iv ON iv.item_code = i.item_code
),
calc AS (
  SELECT a.*,
    ROUND(CASE WHEN a.s90>0 THEN a.s90/90.0 WHEN a.s30>0 THEN a.s30/30.0
               WHEN a.store_sold_all>0 AND a.first_sale IS NOT NULL
                 THEN a.store_sold_all/GREATEST(DATE_DIFF(CURRENT_DATE(),a.first_sale,DAY),1)
               ELSE 0 END, 4)                                   AS avg_daily_sales,
    DATE_DIFF(CURRENT_DATE(), a.last_sale, DAY)                 AS days_since_last_sale,
    DATE_DIFF(CURRENT_DATE(), a.last_grn,  DAY)                 AS days_since_last_grn,
    DATE_DIFF(a.first_sale, a.first_grn, DAY)                   AS days_grn_to_first_sale,
    DATE_DIFF(CURRENT_DATE(), IFNULL(a.first_grn, a.first_stock_date), DAY) AS inventory_age
  FROM alloc a
),
final AS (
  SELECT c.*,
    ROUND(c.avg_daily_sales*7,3)  AS avg_weekly_sales,
    ROUND(c.avg_daily_sales*30,2) AS avg_monthly_sales,
    CASE WHEN c.avg_daily_sales>0 THEN LEAST(ROUND(c.on_hand/c.avg_daily_sales,1),999) ELSE 999 END AS cover_days,
    CASE WHEN c.on_hand>0 THEN ROUND((c.s90*4.0)/c.on_hand,2) ELSE 0 END AS inventory_turnover,
    SAFE_DIVIDE(c.store_sold_all, NULLIF(c.store_sold_all + c.on_hand,0)) AS sell_through,
    ROUND(c.avg_daily_sales*LEAD_TIME_DAYS) AS reorder_point,
    GREATEST(0, CAST(ROUND(c.avg_daily_sales*TARGET_COVER_DAYS - c.on_hand) AS INT64)) AS refill_qty
  FROM calc c
)
SELECT
  CURRENT_DATE()                          AS refresh_date,
  CURRENT_TIMESTAMP()                     AS refreshed_at,
  f.store, f.store AS location, f.sku, f.item_code, f.item_name, f.style,
  f.category, f.sub_category, f.product_type, f.collection,
  f.metal, f.purity, f.stone, f.gender, f.vendor, f.designer, f.image,
  f.shopify_image AS image_url,
  CAST(NULL AS STRING)                    AS tags,
  f.mrp, f.weight,
  x.region, x.company, x.city,
  f.on_hand                               AS current_stock,
  CAST(ROUND(f.on_hand + f.store_sold_all - IFNULL(f.store_grn,0)) AS INT64) AS opening_inventory,
  CAST(ROUND(IFNULL(f.store_grn,0)) AS INT64) AS grn_received_qty,
  f.inventory_value,
  CAST(0 AS INT64)                        AS allocated,
  CAST(ROUND(f.store_sold_all) AS INT64)  AS store_sold,
  CAST(ROUND(f.store_sold_all) AS INT64)  AS total_sold,
  f.store_rev                             AS revenue_all,
  CAST(ROUND(f.s1) AS INT64)  AS sold_today,
  CAST(ROUND(f.s7) AS INT64)  AS sold_7,
  CAST(ROUND(f.s30) AS INT64) AS sold_30,
  CAST(ROUND(f.s90) AS INT64) AS sold_90,
  CAST(ROUND(f.s180) AS INT64) AS sold_180,
  0 AS pdp_views, 0 AS add_to_cart, 0 AS begin_checkout,
  f.first_sale AS first_sale_date, f.last_sale AS last_sale_date,
  f.first_grn AS first_grn_date, f.last_grn AS last_grn_date,
  f.first_stock_date, f.last_stock_date,
  IFNULL(f.days_since_last_sale, 9999) AS days_since_last_sale,
  f.days_since_last_grn, f.days_grn_to_first_sale,
  IFNULL(f.inventory_age, 0) AS inventory_age, f.active_days AS active_sale_days,
  f.avg_daily_sales, f.avg_weekly_sales, f.avg_monthly_sales,
  f.cover_days AS days_cover, f.cover_days,
  f.inventory_turnover, ROUND(f.sell_through,4) AS sell_through,
  f.reorder_point, f.refill_qty,

  CASE
    WHEN f.on_hand<=0 THEN 'Out of Stock'
    WHEN f.avg_daily_sales>0 AND f.cover_days<LOW_COVER_DAYS THEN 'Low Stock'
    WHEN (f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS)
      OR (f.avg_daily_sales=0 AND f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS) THEN 'Over Stock'
    ELSE 'Healthy' END AS inventory_status,
  CASE
    WHEN f.store_sold_all=0 AND f.on_hand>0 THEN 'Never Sold'
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS THEN 'Dead'
    WHEN f.s90>=6 OR f.avg_daily_sales>=0.1 THEN 'Fast Moving'
    ELSE 'Slow Moving' END AS movement_class,
  (f.on_hand<=0) AS is_out_of_stock,
  (f.avg_daily_sales>0 AND f.cover_days<LOW_COVER_DAYS) AS is_low_stock,
  (f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS) AS is_over_stock,
  (f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS) AS is_dead_stock,
  (f.s90>=6 OR f.avg_daily_sales>=0.1) AS is_fast_moving,
  (f.store_sold_all>0 AND f.s90=0) AS is_slow_moving,
  (f.refill_qty>0) AS is_refill_required,
  CAST(ROUND(CASE WHEN f.avg_daily_sales<=0 THEN 0 WHEN f.cover_days>=TARGET_COVER_DAYS THEN 0
                  ELSE 100*(1-f.cover_days/TARGET_COVER_DAYS) END) AS INT64) AS stock_out_risk,
  CAST(ROUND(LEAST(100,
      (CASE WHEN f.on_hand<=0 AND f.avg_daily_sales>0 THEN 40 ELSE 0 END)
    + (CASE WHEN f.avg_daily_sales>0 THEN LEAST(30,30*(1-LEAST(f.cover_days,TARGET_COVER_DAYS)/CAST(TARGET_COVER_DAYS AS FLOAT64))) ELSE 0 END)
    + LEAST(20, f.avg_daily_sales*40)
    + LEAST(10, IFNULL(f.mrp,0)/50000.0*10) )) AS INT64) AS refill_priority_score,
  CAST(ROUND(GREATEST(0, LEAST(100,
      50 + (CASE WHEN f.s90>0 THEN 20 ELSE -10 END)
    + (CASE WHEN f.on_hand<=0 THEN -20 WHEN f.avg_daily_sales>0 AND f.cover_days<LOW_COVER_DAYS THEN -10
            WHEN f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS THEN -12 ELSE 15 END)
    + (CASE WHEN IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS THEN -18 ELSE 0 END)
    + (CASE WHEN f.inventory_turnover>=2 THEN 15 WHEN f.inventory_turnover>=1 THEN 8 ELSE 0 END)
  ))) AS INT64) AS health_score,

  CASE
    WHEN f.on_hand<=0 AND f.avg_daily_sales>0 THEN 'Refill Immediately'
    WHEN f.avg_daily_sales>0 AND f.cover_days<LEAD_TIME_DAYS THEN 'Refill Immediately'
    WHEN f.avg_daily_sales>0 AND f.cover_days<TARGET_COVER_DAYS THEN 'Refill Next Week'
    WHEN f.store_sold_all=0 AND IFNULL(f.days_since_last_grn,0)>DEAD_DAYS THEN 'Stop Manufacturing'
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>270 AND f.inventory_value>=100000 THEN 'Liquidation Required'
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS THEN 'Promotional Discount'
    WHEN f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS THEN 'Transfer From Another Store'
    WHEN f.s90>=10 AND f.cover_days<TARGET_COVER_DAYS THEN 'Increase Manufacturing'
    ELSE 'No Refill Required' END AS ai_recommendation,
  CASE
    WHEN f.on_hand<=0 AND f.avg_daily_sales>0 THEN CONCAT('Out of stock with demand ',CAST(ROUND(f.avg_daily_sales,2) AS STRING),'/day')
    WHEN f.avg_daily_sales>0 AND f.cover_days<LEAD_TIME_DAYS THEN CONCAT('Only ',CAST(f.cover_days AS STRING),'d cover vs ',CAST(LEAD_TIME_DAYS AS STRING),'d lead time')
    WHEN f.avg_daily_sales>0 AND f.cover_days<TARGET_COVER_DAYS THEN CONCAT(CAST(f.cover_days AS STRING),'d cover — below ',CAST(TARGET_COVER_DAYS AS STRING),'d target')
    WHEN f.store_sold_all=0 AND IFNULL(f.days_since_last_grn,0)>DEAD_DAYS THEN CONCAT('No sales since GRN ',CAST(f.days_since_last_grn AS STRING),'d ago')
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>270 AND f.inventory_value>=100000 THEN CONCAT('Rs ',CAST(CAST(ROUND(f.inventory_value) AS INT64) AS STRING),' idle ',CAST(f.days_since_last_sale AS STRING),'d')
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS THEN CONCAT('Dead ',CAST(f.days_since_last_sale AS STRING),'d — move with promotion')
    WHEN f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS THEN CONCAT('Over-stocked ',CAST(f.cover_days AS STRING),'d cover — rebalance')
    WHEN f.s90>=10 AND f.cover_days<TARGET_COVER_DAYS THEN CONCAT('High demand ',CAST(CAST(ROUND(f.s90) AS INT64) AS STRING),' in 90d — scale production')
    ELSE 'Cover within healthy band' END AS ai_reason,
  CASE
    WHEN f.on_hand<=0 AND f.avg_daily_sales>0 THEN 'Lost sales daily until replenished'
    WHEN f.avg_daily_sales>0 AND f.cover_days<TARGET_COVER_DAYS THEN CONCAT('Protects ~Rs ',CAST(CAST(ROUND(f.avg_daily_sales*LEAD_TIME_DAYS*IFNULL(f.mrp,0)) AS INT64) AS STRING),' of demand')
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS THEN CONCAT('Frees Rs ',CAST(CAST(ROUND(f.inventory_value) AS INT64) AS STRING),' locked capital')
    WHEN f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS THEN 'Avoids new manufacturing cost'
    ELSE 'Maintains service level' END AS ai_business_impact,
  CASE
    WHEN f.on_hand<=0 AND f.avg_daily_sales>0 THEN 'Critical'
    WHEN f.avg_daily_sales>0 AND f.cover_days<LEAD_TIME_DAYS THEN 'Critical'
    WHEN f.avg_daily_sales>0 AND f.cover_days<TARGET_COVER_DAYS THEN 'High'
    WHEN f.on_hand>0 AND IFNULL(f.days_since_last_sale,9999)>DEAD_DAYS THEN 'High'
    WHEN f.avg_daily_sales>0 AND f.cover_days>OVER_COVER_DAYS THEN 'Medium'
    ELSE 'Low' END AS ai_priority,
  CAST(ROUND(LEAST(98, GREATEST(40, 40 + LEAST(40, f.active_days/60.0*40) + LEAST(18, f.s90/50.0*18)))) AS INT64) AS ai_confidence,
  ROUND(f.avg_daily_sales*7)  AS forecast_7d,
  ROUND(f.avg_daily_sales*15) AS forecast_15d,
  ROUND(f.avg_daily_sales*30) AS forecast_30d
FROM final f
LEFT JOIN store_xwalk x ON x.location_name = f.store;
