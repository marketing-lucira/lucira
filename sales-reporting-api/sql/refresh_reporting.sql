-- ════════════════════════════════════════════════════════════════════════
--  LUCIRA SALES INTELLIGENCE — DAILY REPORTING LAYER
--  Run as a BigQuery **Scheduled Query** every day at 10:00 AM IST.
--  It rebuilds ONE optimized, dashboard-ready reporting table from the single
--  source of truth. The dashboard NEVER queries the raw table on open — it
--  reads a static JSON snapshot built from this table (see main.py /snapshot).
--
--  SOURCE (only this table, never joined):
--      lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table
--
--  BUSINESS RULES baked in here (locked by the client):
--    1. Gross Sales   = gross_amount summed directly (Returns are NEGATIVE).
--    2. Net Sales     = gross / 1.03  (3% GST) — computed, not read.
--    3. Dedup         = drop a row ONLY if gross + date + document_no +
--                       net_weight are ALL identical (QUALIFY below).
--    4. Sale Type     = normalized to MTO / RTS / TAH / Return / Exchange /
--                       Other (Online_MTO folds into MTO).
--    5. Categories    = taken dynamically from the table, never hardcoded.
--
--  ⚠️  COLUMN MAP: the aliases below match the real output columns of the
--  client's DDL (2026-07-16). If the schema changes, edit ONLY the aliased
--  physical column names in the `src` CTE — everything downstream is logical.
-- ════════════════════════════════════════════════════════════════════════

-- One-time (safe to leave in; IF NOT EXISTS): the reporting dataset.
-- NOTE: dataset location MUST match the source dataset's location.
CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.sales_dashboard`;

CREATE OR REPLACE TABLE `lucirajewelry-prod.sales_dashboard.sales_reporting`
PARTITION BY date
CLUSTER BY sale_type, store, category
OPTIONS(description="Deduped, GST-adjusted, dashboard-ready sales fact. Rebuilt daily 10:00 IST.") AS
WITH src AS (
  SELECT
    CAST(`Transaction_Date` AS DATE)                              AS date,
    CAST(`document_no` AS STRING)                                 AS document_no,
    CAST(`party_id` AS STRING)                                    AS customer_id,
    `party_name`                                                  AS customer_name,
    `city_name`                                                   AS city,
    `state_name`                                                  AS state,
    `country_name`                                                AS region,
    CAST(`Full_sku` AS STRING)                                    AS sku,
    `Item_name`                                                   AS product_name,
    CAST(`style_code` AS STRING)                                  AS style,
    `type_name`                                                   AS category,
    `sub_category`                                                AS sub_category,
    `collection_name`                                             AS collection,
    `metal_name`                                                  AS metal,
    `karat_name`                                                  AS purity,
    `Price_Range`                                                 AS price_band,
    `customer_type`                                               AS customer_type,
    `Fullfillment`                                                AS sale_type_raw,
    `company_code`                                                AS store,
    `Channel`                                                     AS channel,
    IFNULL(SAFE_CAST(`pieces`     AS FLOAT64), 0)                 AS qty,
    IFNULL(SAFE_CAST(`gross_amount` AS FLOAT64), 0)              AS gross,
    IFNULL(SAFE_CAST(`discount`   AS FLOAT64), 0)                 AS discount,
    IFNULL(SAFE_CAST(`weight`     AS FLOAT64), 0)                 AS gross_weight,
    IFNULL(SAFE_CAST(`net_weight` AS FLOAT64), 0)                 AS net_weight,
    IFNULL(SAFE_CAST(`tax_amount` AS FLOAT64), 0)                 AS tax_amount
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE `Transaction_Date` IS NOT NULL
    AND CAST(`Transaction_Date` AS DATE) >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 540 DAY)
  -- RULE 3 — dedup: keep one row per (gross, date, document_no, net_weight).
  -- NOTE: BigQuery forbids window PARTITION BY on FLOAT64, and NUMERIC equality
  -- must be exact — so partition on the STRING form of gross & net_weight.
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY CAST(`gross_amount` AS STRING),
                 CAST(`Transaction_Date` AS DATE),
                 CAST(`document_no` AS STRING),
                 CAST(`net_weight` AS STRING)
    ORDER BY `gross_amount`
  ) = 1
)
SELECT
  date, document_no, customer_id, customer_name, city, state, region,
  sku, product_name, style, category, sub_category, collection, metal, purity,
  price_band, INITCAP(customer_type) AS customer_type, store, channel,
  qty,
  ROUND(gross, 2)                                                 AS gross,
  ROUND(gross / 1.03, 2)                                          AS net,        -- RULE 2
  ROUND(discount, 2)                                              AS discount,
  ROUND(gross_weight, 3)                                          AS gross_weight,
  ROUND(net_weight, 3)                                            AS net_weight,
  ROUND(tax_amount, 2)                                            AS tax_amount,
  -- RULE 4 — normalized sale type
  CASE
    WHEN LOWER(sale_type_raw) LIKE '%return%'                     THEN 'Return'
    WHEN LOWER(sale_type_raw) LIKE '%exch%'                       THEN 'Exchange'
    WHEN LOWER(sale_type_raw) LIKE '%mto%'
      OR LOWER(sale_type_raw) = 'order'                           THEN 'MTO'
    WHEN LOWER(sale_type_raw) LIKE '%rts%'                        THEN 'RTS'
    WHEN LOWER(sale_type_raw) LIKE '%tah%'                        THEN 'TAH'
    ELSE COALESCE(NULLIF(sale_type_raw, ''), 'Other')
  END                                                             AS sale_type
FROM src;

-- ── Aux 1: per-STYLE reference (full history) — movement / selling-days ──────
CREATE OR REPLACE TABLE `lucirajewelry-prod.sales_dashboard.sales_reporting_style` AS
SELECT
  CAST(`style_code` AS STRING)            AS style,
  ANY_VALUE(`type_name`)                  AS category,
  ANY_VALUE(`metal_name`)                 AS metal,
  ANY_VALUE(`collection_name`)            AS collection,
  MIN(CAST(`Transaction_Date` AS DATE))   AS first_sale_date,
  MAX(CAST(`Transaction_Date` AS DATE))   AS last_sale_date,
  SUM(IFNULL(SAFE_CAST(`pieces` AS FLOAT64),0)) AS units_all_time
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE `Transaction_Date` IS NOT NULL
GROUP BY style;

-- ── Aux 2: per-CUSTOMER reference (full history) — CLV / new-vs-repeat ───────
CREATE OR REPLACE TABLE `lucirajewelry-prod.sales_dashboard.sales_reporting_customer` AS
SELECT
  CAST(`party_id` AS STRING)              AS customer_id,
  MIN(CAST(`Transaction_Date` AS DATE))   AS first_order_date,
  MAX(CAST(`Transaction_Date` AS DATE))   AS last_order_date,
  COUNT(DISTINCT `document_no`)           AS lifetime_orders,
  ROUND(SUM(IFNULL(SAFE_CAST(`gross_amount` AS FLOAT64),0)) / 1.03, 2) AS lifetime_net
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE `party_id` IS NOT NULL
GROUP BY customer_id;
