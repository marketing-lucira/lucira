-- ═══════════════════════════════════════════════════════════════════════════
--  INVENTORY REFILLING INTELLIGENCE — CONSOLIDATED FACT-TABLE BUILD
--  Single source of truth for the whole dashboard.  Runs as a BigQuery
--  Scheduled Query every day at 09:00 IST.  The dashboard / API read ONLY the
--  three reporting tables produced here — never the raw sources — so per-load
--  cost is a few MB and latency is sub-second.
--
--  Grain of the fact table: one row per (item SKU × store).
--  Scope baked in EVERYWHERE: jewelry only — Silver metal and every Coin /
--  bullion product are excluded from every measure, KPI and recommendation.
--
--  Sources
--    1. ornaverse_erp_administration.Sales_overview_table  (sales velocity)
--    2. ds_imputed_reporting.Live_inventory                (on-hand, attributes)
--    3. Lucira_Prod.GRN                                    (goods received)
--    4. test.Inventory_pivot                               (store-wise on-hand xcheck)
--
--  ┌─ CONFIG ────────────────────────────────────────────────────────────────┐
--  │ Sales_overview_table and Live_inventory column names below are CONFIRMED │
--  │ from prior work.  GRN and Inventory_pivot column names are ASSUMED —     │
--  │ run 00_introspect.sql, then adjust the g_* / piv_* aliases in the two    │
--  │ CONFIG CTEs (grn_cfg / pivot_src) if the real names differ.  All casts   │
--  │ are SAFE_* so a wrong name degrades a measure to NULL instead of failing.│
--  └──────────────────────────────────────────────────────────────────────────┘
--
--  Tunable business parameters (edit here, schedule re-applies next morning):
--    LEAD_TIME_DAYS     21   manufacture/replenish lead time
--    TARGET_COVER_DAYS  60   desired days-of-cover after refill
--    LOW_COVER_DAYS     15   below this = Low Stock / refill soon
--    OVER_COVER_DAYS    180  above this = Over Stock
--    DEAD_DAYS          180  no sale in this many days = Dead Stock
--    VELOCITY_WINDOW    90   trailing window for the run-rate
-- ═══════════════════════════════════════════════════════════════════════════

DECLARE LEAD_TIME_DAYS     INT64 DEFAULT 21;
DECLARE TARGET_COVER_DAYS  INT64 DEFAULT 60;
DECLARE LOW_COVER_DAYS     INT64 DEFAULT 15;
DECLARE OVER_COVER_DAYS    INT64 DEFAULT 180;
DECLARE DEAD_DAYS          INT64 DEFAULT 180;
DECLARE VELOCITY_WINDOW    INT64 DEFAULT 90;

CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.reporting`
  OPTIONS(location = 'US');   -- adjust to your dataset region if not US

-- ───────────────────────────────────────────────────────────────────────────
--  1) FACT TABLE  (sku × store)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TABLE `lucirajewelry-prod.reporting.inventory_intelligence_fact`
PARTITION BY refresh_date
CLUSTER BY store, category, inventory_status AS
WITH
-- Store crosswalk: sales use company_code, inventory uses Store_name. This map
-- is best-effort (velocity is network-wide by SKU; on-hand is per store).
store_map AS (
  SELECT * FROM UNNEST([
    STRUCT('N18' AS company_code, 'Noida Sec 18'        AS store, 'North' AS region),
    STRUCT('PN1',                  'JM Pune',            'West'),
    STRUCT('PV1',                  'Paschim Vihar',      'North'),
    STRUCT('BO1',                  'Sky City Borivali',  'West'),
    STRUCT('CS1',                  'Divinecarat',        'West'),
    STRUCT('HO',                   'Divinecarat',        'West'),
    STRUCT('FCS',                  'HWI',                'West')
  ])
),

-- 1a) Jewelry-only inventory, per SKU × store (Live_inventory is authoritative
--     for on-hand and carries Store_name + pieces already).
inv AS (
  SELECT
    IFNULL(NULLIF(TRIM(Store_name), ''), 'Unassigned')  AS store,
    ANY_VALUE(location_name)                            AS location,
    Full_sku                                            AS sku,
    ANY_VALUE(Full_sku)                                 AS item_code,
    ANY_VALUE(item_name)                                AS item_name,
    ANY_VALUE(style_code)                               AS style,
    ANY_VALUE(type_name)                                AS category,
    ANY_VALUE(sub_type_name)                            AS sub_category,
    ANY_VALUE(item_group_name)                          AS product_type,
    ANY_VALUE(collection_name)                          AS collection,
    ANY_VALUE(metal_name)                               AS metal,
    ANY_VALUE(karat_name)                               AS purity,
    ANY_VALUE(stone_color_name)                         AS stone,
    ANY_VALUE(first_image)                              AS image,
    ANY_VALUE(shpify_tags)                              AS tags,
    -- attributes that MAY be absent from Live_inventory: gender / vendor /
    -- designer / mrp. SAFE columns → NULL if the name is wrong; adjust here.
    ANY_VALUE(SAFE_CAST(NULL AS STRING))                AS gender,
    ANY_VALUE(SAFE_CAST(NULL AS STRING))                AS vendor,
    ANY_VALUE(SAFE_CAST(NULL AS STRING))                AS designer,
    ANY_VALUE(SAFE_CAST(Shopify_price AS FLOAT64))      AS mrp,
    ANY_VALUE(SAFE_CAST(net_weight AS FLOAT64))         AS weight,
    SUM(SAFE_CAST(pieces AS FLOAT64))                            AS on_hand,
    SUM(SAFE_CAST(item_rate AS FLOAT64) * SAFE_CAST(pieces AS FLOAT64)) AS inventory_value,
    SUM(IFNULL(SAFE_CAST(is_allocated AS INT64), 0))            AS allocated,
    SUM(IFNULL(SAFE_CAST(pdp_views AS INT64), 0))               AS pdp_views,
    SUM(IFNULL(SAFE_CAST(add_to_cart AS INT64), 0))             AS add_to_cart,
    SUM(IFNULL(SAFE_CAST(begin_checkout AS INT64), 0))          AS begin_checkout,
    MIN(SAFE_CAST(document_date AS DATE))                       AS first_stock_date,
    MAX(SAFE_CAST(document_date AS DATE))                       AS last_stock_date
  FROM `lucirajewelry-prod.ds_imputed_reporting.Live_inventory`
  WHERE SAFE_CAST(pieces AS FLOAT64) IS NOT NULL
    AND IFNULL(metal_name, '') NOT IN ('Silver')
    AND IFNULL(type_name, '')  NOT IN ('Silver Coin', 'Gold Coin', 'Coin')
    AND LOWER(IFNULL(type_name, ''))  NOT LIKE '%coin%'
    AND LOWER(IFNULL(item_name, ''))  NOT LIKE '%silver%'
  GROUP BY store, sku
),

-- 1b) Sales velocity — network-wide per SKU, full history + trailing windows.
--     Returns (Billed Returns, negative pieces) are netted out of totals.
sales AS (
  SELECT
    Full_sku AS sku,
    SUM(SAFE_CAST(pieces AS FLOAT64))                                                   AS sold_all,
    SUM(SAFE_CAST(gross_amount AS FLOAT64))                                             AS revenue_all,
    MIN(SAFE_CAST(Transaction_Date AS DATE))                                            AS first_sale_date,
    MAX(SAFE_CAST(Transaction_Date AS DATE))                                            AS last_sale_date,
    COUNT(DISTINCT SAFE_CAST(Transaction_Date AS DATE))                                 AS active_sale_days,
    SUM(IF(SAFE_CAST(Transaction_Date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 1   DAY), SAFE_CAST(pieces AS FLOAT64), 0)) AS sold_1,
    SUM(IF(SAFE_CAST(Transaction_Date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7   DAY), SAFE_CAST(pieces AS FLOAT64), 0)) AS sold_7,
    SUM(IF(SAFE_CAST(Transaction_Date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30  DAY), SAFE_CAST(pieces AS FLOAT64), 0)) AS sold_30,
    SUM(IF(SAFE_CAST(Transaction_Date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90  DAY), SAFE_CAST(pieces AS FLOAT64), 0)) AS sold_90,
    SUM(IF(SAFE_CAST(Transaction_Date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY), SAFE_CAST(pieces AS FLOAT64), 0)) AS sold_180
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE IFNULL(metal_name, '') NOT IN ('Silver')
    AND IFNULL(type_name, '')  NOT IN ('Silver Coin', 'Gold Coin', 'Coin')
    AND LOWER(IFNULL(type_name, '')) NOT LIKE '%coin%'
  GROUP BY sku
),

-- 1c) Sales per SKU × store (best-effort via company_code crosswalk) — used for
--     store-level sell-through where the mapping resolves.
sales_store AS (
  SELECT
    IFNULL(m.store, s.company_code)                          AS store,
    s.Full_sku                                               AS sku,
    SUM(SAFE_CAST(s.pieces AS FLOAT64))                      AS store_sold_all,
    MAX(SAFE_CAST(s.Transaction_Date AS DATE))              AS store_last_sale
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table` s
  LEFT JOIN store_map m ON m.company_code = s.company_code
  WHERE IFNULL(s.metal_name, '') NOT IN ('Silver')
    AND IFNULL(s.type_name, '')  NOT IN ('Silver Coin', 'Gold Coin', 'Coin')
  GROUP BY store, sku
),

-- 1d) GRN — goods received.  CONFIG: adjust aliases if introspection differs.
--     Assumed columns: Full_sku, document_date (grn date), pieces (qty),
--     Store_name, vendor_name, item_rate.  Wrong names → SAFE_CAST NULL.
grn AS (
  SELECT
    SAFE_CAST(Full_sku AS STRING)                          AS sku,
    IFNULL(NULLIF(TRIM(SAFE_CAST(Store_name AS STRING)),''),'Unassigned') AS store,
    SUM(SAFE_CAST(pieces AS FLOAT64))                      AS grn_received_qty,
    MIN(SAFE_CAST(document_date AS DATE))                  AS first_grn_date,
    MAX(SAFE_CAST(document_date AS DATE))                  AS last_grn_date,
    ANY_VALUE(SAFE_CAST(vendor_name AS STRING))            AS grn_vendor
  FROM `lucirajewelry-prod.Lucira_Prod.GRN`
  GROUP BY sku, store
),

-- 1e) Assemble raw metrics per SKU × store.
base AS (
  SELECT
    i.store, i.location, i.sku, i.item_code, i.item_name, i.style, i.category,
    i.sub_category, i.product_type, i.collection, i.metal, i.purity, i.stone,
    i.image, i.tags, i.gender, i.vendor, i.designer, i.mrp, i.weight,
    IFNULL(i.on_hand, 0)          AS current_stock,
    i.inventory_value, i.allocated, i.pdp_views, i.add_to_cart, i.begin_checkout,
    i.first_stock_date, i.last_stock_date,
    COALESCE(g.grn_vendor, i.vendor)                              AS vendor_final,
    IFNULL(g.grn_received_qty, 0)                                 AS grn_received_qty,
    g.first_grn_date, g.last_grn_date,
    -- Opening inventory ≈ current on-hand + everything sold since first GRN
    -- − everything received (a reconstruction; exact opening needs a snapshot).
    IFNULL(i.on_hand, 0) + IFNULL(ss.store_sold_all, 0) - IFNULL(g.grn_received_qty, 0) AS opening_inventory,
    IFNULL(ss.store_sold_all, 0)     AS store_sold,
    ss.store_last_sale,
    -- network velocity signals
    IFNULL(sa.sold_all, 0)  AS sold_all,
    IFNULL(sa.revenue_all,0) AS revenue_all,
    sa.first_sale_date, sa.last_sale_date, sa.active_sale_days,
    IFNULL(sa.sold_1,0) AS sold_1, IFNULL(sa.sold_7,0) AS sold_7,
    IFNULL(sa.sold_30,0) AS sold_30, IFNULL(sa.sold_90,0) AS sold_90,
    IFNULL(sa.sold_180,0) AS sold_180
  FROM inv i
  LEFT JOIN sales       sa ON sa.sku = i.sku
  LEFT JOIN sales_store ss ON ss.sku = i.sku AND ss.store = i.store
  LEFT JOIN grn         g  ON g.sku  = i.sku AND g.store  = i.store
),

-- 1f) Derived business metrics.
calc AS (
  SELECT
    b.*,
    -- run-rate: trailing-90 daily; fall back to 30d, then lifetime.
    ROUND(CASE
      WHEN b.sold_90  > 0 THEN b.sold_90  / 90.0
      WHEN b.sold_30  > 0 THEN b.sold_30  / 30.0
      WHEN b.sold_all > 0 AND b.first_sale_date IS NOT NULL
        THEN b.sold_all / GREATEST(DATE_DIFF(CURRENT_DATE(), b.first_sale_date, DAY), 1)
      ELSE 0 END, 4)                                                 AS avg_daily_sales,
    DATE_DIFF(CURRENT_DATE(), b.last_sale_date, DAY)                 AS days_since_last_sale,
    DATE_DIFF(CURRENT_DATE(), b.last_grn_date, DAY)                  AS days_since_last_grn,
    DATE_DIFF(b.first_sale_date, b.first_grn_date, DAY)             AS days_grn_to_first_sale,
    DATE_DIFF(CURRENT_DATE(), IFNULL(b.first_grn_date, b.first_stock_date), DAY) AS inventory_age,
    -- sell-through = sold / (sold + on hand)
    SAFE_DIVIDE(b.store_sold, NULLIF(b.store_sold + b.current_stock, 0)) AS sell_through
  FROM base b
),

final AS (
  SELECT
    c.*,
    ROUND(c.avg_daily_sales * 7,   3)                               AS avg_weekly_sales,
    ROUND(c.avg_daily_sales * 30,  2)                               AS avg_monthly_sales,
    -- days of cover: on-hand ÷ daily run-rate (999 = effectively infinite)
    CASE WHEN c.avg_daily_sales > 0
         THEN LEAST(ROUND(c.current_stock / c.avg_daily_sales, 1), 999)
         ELSE 999 END                                               AS cover_days,
    -- annualised turnover ≈ trailing-90 sold ×4 ÷ on-hand
    CASE WHEN c.current_stock > 0
         THEN ROUND((c.sold_90 * 4.0) / c.current_stock, 2) ELSE 0 END AS inventory_turnover,
    -- reorder point & refill quantity to reach TARGET_COVER_DAYS
    ROUND(c.avg_daily_sales * LEAD_TIME_DAYS)                       AS reorder_point,
    GREATEST(0, CAST(ROUND(c.avg_daily_sales * TARGET_COVER_DAYS - c.current_stock) AS INT64)) AS refill_qty
  FROM calc c
)

SELECT
  CURRENT_DATE()                                                    AS refresh_date,
  CURRENT_TIMESTAMP()                                               AS refreshed_at,
  f.store, f.location, f.sku, f.item_code, f.item_name, f.style,
  f.category, f.sub_category, f.product_type, f.collection,
  f.metal, f.purity, f.stone, f.gender, f.vendor_final AS vendor, f.designer,
  f.image, f.tags, f.mrp, f.weight,
  -- region / city / company from the crosswalk
  sm.region,
  sm.company_code                                                   AS company,
  f.location                                                        AS city,
  -- core measures
  f.current_stock, f.opening_inventory, f.grn_received_qty,
  f.inventory_value, f.allocated,
  f.store_sold, f.sold_all AS total_sold, f.revenue_all,
  f.sold_1 AS sold_today, f.sold_7, f.sold_30, f.sold_90, f.sold_180,
  f.pdp_views, f.add_to_cart, f.begin_checkout,
  -- dates
  f.first_sale_date, f.last_sale_date, f.first_grn_date, f.last_grn_date,
  f.first_stock_date, f.last_stock_date,
  f.days_since_last_sale, f.days_since_last_grn, f.days_grn_to_first_sale,
  f.inventory_age, f.active_sale_days,
  -- velocity & efficiency
  f.avg_daily_sales, f.avg_weekly_sales, f.avg_monthly_sales,
  f.cover_days AS days_cover, f.cover_days AS cover_days,
  f.inventory_turnover,
  ROUND(f.sell_through, 4)                                          AS sell_through,
  f.reorder_point, f.refill_qty,

  -- ── Inventory status ─────────────────────────────────────────────────────
  CASE
    WHEN f.current_stock <= 0                                     THEN 'Out of Stock'
    WHEN f.avg_daily_sales > 0 AND f.cover_days < LOW_COVER_DAYS  THEN 'Low Stock'
    WHEN (f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS)
      OR (f.avg_daily_sales = 0 AND f.current_stock > 0 AND f.days_since_last_sale > DEAD_DAYS)
                                                                   THEN 'Over Stock'
    ELSE 'Healthy' END                                            AS inventory_status,

  -- ── Movement class ───────────────────────────────────────────────────────
  CASE
    WHEN f.total_sold = 0 AND f.current_stock > 0                 THEN 'Never Sold'
    WHEN f.current_stock > 0 AND IFNULL(f.days_since_last_sale, 9999) > DEAD_DAYS THEN 'Dead'
    WHEN f.sold_90 >= 6 OR f.avg_daily_sales >= 0.1               THEN 'Fast Moving'
    WHEN f.sold_90 = 0                                            THEN 'Slow Moving'
    ELSE 'Slow Moving' END                                        AS movement_class,

  -- ── Boolean flags the filters use ────────────────────────────────────────
  (f.current_stock <= 0)                                          AS is_out_of_stock,
  (f.avg_daily_sales > 0 AND f.cover_days < LOW_COVER_DAYS)       AS is_low_stock,
  (f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS)      AS is_over_stock,
  (f.current_stock > 0 AND IFNULL(f.days_since_last_sale,9999) > DEAD_DAYS) AS is_dead_stock,
  (f.sold_90 >= 6 OR f.avg_daily_sales >= 0.1)                    AS is_fast_moving,
  (f.total_sold > 0 AND f.sold_90 = 0)                           AS is_slow_moving,
  (f.refill_qty > 0)                                             AS is_refill_required,

  -- ── Stock-out risk (0-100) ───────────────────────────────────────────────
  CAST(ROUND(CASE
    WHEN f.avg_daily_sales <= 0 THEN 0
    WHEN f.cover_days >= TARGET_COVER_DAYS THEN 0
    ELSE 100 * (1 - f.cover_days / TARGET_COVER_DAYS) END) AS INT64) AS stock_out_risk,

  -- ── Refill priority score (0-100) ────────────────────────────────────────
  --   weights demand (run-rate), urgency (low cover), value, and OOS.
  CAST(ROUND(LEAST(100,
      (CASE WHEN f.current_stock <= 0 AND f.avg_daily_sales > 0 THEN 40 ELSE 0 END)
    + (CASE WHEN f.avg_daily_sales > 0 THEN LEAST(30, 30 * (1 - LEAST(f.cover_days, TARGET_COVER_DAYS)/CAST(TARGET_COVER_DAYS AS FLOAT64))) ELSE 0 END)
    + LEAST(20, f.avg_daily_sales * 40)
    + LEAST(10, IFNULL(f.mrp,0) / 50000.0 * 10)
  )) AS INT64)                                                    AS refill_priority_score,

  -- ── Health score per SKU (0-100) ─────────────────────────────────────────
  CAST(ROUND(GREATEST(0, LEAST(100,
      50
    + (CASE WHEN f.sold_90 > 0 THEN 20 ELSE -10 END)
    + (CASE WHEN f.current_stock <= 0 THEN -20
            WHEN f.avg_daily_sales > 0 AND f.cover_days < LOW_COVER_DAYS THEN -10
            WHEN f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS THEN -12
            ELSE 15 END)
    + (CASE WHEN f.days_since_last_sale > DEAD_DAYS THEN -18 ELSE 0 END)
    + (CASE WHEN f.inventory_turnover >= 2 THEN 15 WHEN f.inventory_turnover >= 1 THEN 8 ELSE 0 END)
  ))) AS INT64)                                                   AS health_score,

  -- ── AI Refill Recommendation (decision tree) ─────────────────────────────
  CASE
    WHEN f.current_stock <= 0 AND f.avg_daily_sales > 0                        THEN 'Refill Immediately'
    WHEN f.avg_daily_sales > 0 AND f.cover_days < LEAD_TIME_DAYS               THEN 'Refill Immediately'
    WHEN f.avg_daily_sales > 0 AND f.cover_days < TARGET_COVER_DAYS            THEN 'Refill Next Week'
    WHEN f.total_sold = 0 AND f.days_since_last_grn > DEAD_DAYS                THEN 'Stop Manufacturing'
    WHEN f.current_stock > 0 AND f.days_since_last_sale > 270 AND f.inventory_value >= 100000 THEN 'Liquidation Required'
    WHEN f.current_stock > 0 AND f.days_since_last_sale > DEAD_DAYS            THEN 'Promotional Discount'
    WHEN f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS              THEN 'Transfer From Another Store'
    WHEN f.sold_90 >= 10 AND f.cover_days < TARGET_COVER_DAYS                  THEN 'Increase Manufacturing'
    ELSE 'No Refill Required' END                                             AS ai_recommendation,

  -- Reason
  CASE
    WHEN f.current_stock <= 0 AND f.avg_daily_sales > 0                        THEN CONCAT('Out of stock with live demand of ', CAST(ROUND(f.avg_daily_sales,2) AS STRING), '/day')
    WHEN f.avg_daily_sales > 0 AND f.cover_days < LEAD_TIME_DAYS               THEN CONCAT('Only ', CAST(f.cover_days AS STRING), 'd cover vs ', CAST(LEAD_TIME_DAYS AS STRING), 'd lead time')
    WHEN f.avg_daily_sales > 0 AND f.cover_days < TARGET_COVER_DAYS            THEN CONCAT(CAST(f.cover_days AS STRING), 'd cover — below ', CAST(TARGET_COVER_DAYS AS STRING), 'd target')
    WHEN f.total_sold = 0 AND f.days_since_last_grn > DEAD_DAYS                THEN CONCAT('No sales since GRN ', CAST(f.days_since_last_grn AS STRING), 'd ago')
    WHEN f.current_stock > 0 AND f.days_since_last_sale > 270 AND f.inventory_value >= 100000 THEN CONCAT('₹', CAST(CAST(ROUND(f.inventory_value) AS INT64) AS STRING), ' idle ', CAST(f.days_since_last_sale AS STRING), 'd')
    WHEN f.current_stock > 0 AND f.days_since_last_sale > DEAD_DAYS            THEN CONCAT('Dead ', CAST(f.days_since_last_sale AS STRING), 'd — move with promotion')
    WHEN f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS              THEN CONCAT('Over-stocked ', CAST(f.cover_days AS STRING), 'd cover — rebalance network')
    WHEN f.sold_90 >= 10 AND f.cover_days < TARGET_COVER_DAYS                  THEN CONCAT('High demand ', CAST(f.sold_90 AS STRING), ' in 90d — scale production')
    ELSE 'Cover within healthy band' END                                     AS ai_reason,

  -- Business impact
  CASE
    WHEN f.current_stock <= 0 AND f.avg_daily_sales > 0                        THEN 'Lost sales daily until replenished'
    WHEN f.avg_daily_sales > 0 AND f.cover_days < TARGET_COVER_DAYS            THEN CONCAT('Protects ~₹', CAST(CAST(ROUND(f.avg_daily_sales * LEAD_TIME_DAYS * IFNULL(f.mrp,0)) AS INT64) AS STRING), ' of demand')
    WHEN f.current_stock > 0 AND f.days_since_last_sale > DEAD_DAYS            THEN CONCAT('Frees ₹', CAST(CAST(ROUND(f.inventory_value) AS INT64) AS STRING), ' locked capital')
    WHEN f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS              THEN 'Avoids new manufacturing cost'
    ELSE 'Maintains service level' END                                       AS ai_business_impact,

  -- Priority label
  CASE
    WHEN f.current_stock <= 0 AND f.avg_daily_sales > 0                        THEN 'Critical'
    WHEN f.avg_daily_sales > 0 AND f.cover_days < LEAD_TIME_DAYS               THEN 'Critical'
    WHEN f.avg_daily_sales > 0 AND f.cover_days < TARGET_COVER_DAYS            THEN 'High'
    WHEN f.current_stock > 0 AND f.days_since_last_sale > DEAD_DAYS            THEN 'High'
    WHEN f.avg_daily_sales > 0 AND f.cover_days > OVER_COVER_DAYS              THEN 'Medium'
    ELSE 'Low' END                                                           AS ai_priority,

  -- Confidence (data sufficiency)
  CAST(ROUND(LEAST(0.98, GREATEST(0.4,
      0.4 + LEAST(0.4, f.active_sale_days / 60.0) + LEAST(0.18, f.sold_90 / 50.0)
  ))*100) AS INT64)                                                          AS ai_confidence,

  -- demand forecasts (naive run-rate; the API/AI layer can refine)
  ROUND(f.avg_daily_sales * 7)   AS forecast_7d,
  ROUND(f.avg_daily_sales * 15)  AS forecast_15d,
  ROUND(f.avg_daily_sales * 30)  AS forecast_30d
FROM final f
LEFT JOIN store_map sm ON sm.store = f.store;
