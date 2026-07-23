-- ============================================================================
-- Sales Analytics Dashboard — canonical queries + RECONCILIATION
-- Source (ONLY source):
--   lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table
--
-- Column names below are the REAL output columns of the client's DDL
-- (the CREATE OR REPLACE TABLE … AS SELECT that builds Sales_overview_table):
--   gross_amount      = GROSS SALE (Billed Returns are negative)
--   Transaction_Date  = SALE DATE (DATE)          document_no = DOCUMENT NUMBER
--   net_weight        = NET WEIGHT   weight = GROSS WEIGHT   pieces = QUANTITY
--   Fullfillment      = SALE TYPE (Rts / MTO / Online_MTO / TAH / Billed Returns)
--   type_name         = CATEGORY    sub_category = sub-category
--   Full_sku / style_code / half_sku · collection_name · metal_name / karat_name
--   party_id / party_name · Price_Range (pre-bucketed) · customer_type (New/Repeat)
--   Channel (Online/Store/TAH) · company_code · city_name / state_name
--
-- Business rules:
--   1. Gross Sales = SUM(gross_amount) straight from the table. Never derived.
--   2. Net Sales   = Gross / 1.03 (3% GST). Computed, never a column.
--   3. Sale Type   = Fullfillment, each totalled separately (Online_MTO folds into MTO in the app).
--   4. Dedupe      = drop a row ONLY when gross_amount + Transaction_Date + document_no +
--                    net_weight are ALL identical. (The table is already deduped at source
--                    via its final QUALIFY; this is a belt-and-braces safety pass + audit.)
--   5. Categories  = read dynamically from type_name. Never hardcoded.
-- @tz / @days / @cap are bind parameters.
-- ============================================================================

-- 0) INTROSPECT — confirm the columns exist / spellings ----------------------
SELECT column_name, data_type
FROM `lucirajewelry-prod.ornaverse_erp_administration`.INFORMATION_SCHEMA.COLUMNS
WHERE table_name = 'Sales_overview_table'
ORDER BY ordinal_position;

-- 1) DEDUPED ORDER-LINE DETAIL (the fact table the dashboard ingests) ---------
WITH base AS (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY gross_amount, Transaction_Date, CAST(document_no AS STRING), net_weight
           ORDER BY gross_amount) AS _rn
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE TIMESTAMP(Transaction_Date) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    AND Transaction_Date IS NOT NULL
)
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP(Transaction_Date), @tz) AS date,
  CAST(document_no AS STRING)                     AS document_no,
  CAST(party_id AS STRING) AS customer_id, party_name AS customer_name,
  city_name AS city, state_name AS state, country_name AS region,
  CAST(Full_sku AS STRING) AS sku, Item_name AS product_name,
  CAST(style_code AS STRING) AS style, type_name AS category, sub_category,
  collection_name AS collection, metal_name AS metal, Price_Range AS price_band,
  customer_type, Fullfillment AS sale_type,
  IFNULL(SAFE_CAST(pieces       AS FLOAT64),0) AS qty,
  IFNULL(SAFE_CAST(gross_amount AS FLOAT64),0) AS gross,                    -- rule 1
  IFNULL(SAFE_CAST(gross_amount AS FLOAT64),0) / 1.03 AS net,              -- rule 2
  IFNULL(SAFE_CAST(discount     AS FLOAT64),0) AS discount,
  IFNULL(SAFE_CAST(weight       AS FLOAT64),0) AS gross_weight,
  IFNULL(SAFE_CAST(net_weight   AS FLOAT64),0) AS net_weight,
  company_code AS store, Channel
FROM base
WHERE _rn = 1
ORDER BY date
LIMIT @cap;

-- ============================================================================
-- RECONCILIATION — run these and compare to the dashboard's Validation tab.
-- ============================================================================

-- R1) HEADLINE TOTALS (raw vs deduped) ---------------------------------------
SELECT
  COUNT(*)                                        AS raw_rows,
  COUNT(DISTINCT CONCAT(CAST(gross_amount AS STRING),'|',
        CAST(Transaction_Date AS STRING),'|',
        CAST(document_no AS STRING),'|',CAST(net_weight AS STRING))) AS deduped_rows,
  SUM(SAFE_CAST(gross_amount AS FLOAT64))         AS raw_gross,
  SUM(SAFE_CAST(gross_amount AS FLOAT64)) / 1.03  AS raw_net
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE TIMESTAMP(Transaction_Date) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
  AND Transaction_Date IS NOT NULL;

-- R2) DEDUPED GROSS + NET (the authoritative headline) ------------------------
WITH base AS (
  SELECT gross_amount,
         ROW_NUMBER() OVER (PARTITION BY gross_amount, Transaction_Date,
                            CAST(document_no AS STRING), net_weight ORDER BY gross_amount) AS _rn
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
  WHERE Transaction_Date IS NOT NULL )
SELECT COUNT(*) AS deduped_rows,
       SUM(SAFE_CAST(gross_amount AS FLOAT64))        AS gross_sales,
       SUM(SAFE_CAST(gross_amount AS FLOAT64)) / 1.03 AS net_sales
FROM base WHERE _rn = 1;

-- R3) GROSS SALES BY SALE TYPE (Fullfillment) --------------------------------
SELECT Fullfillment AS sale_type,
       COUNT(*) AS rows,
       COUNT(DISTINCT document_no) AS orders,
       SUM(SAFE_CAST(pieces AS FLOAT64)) AS qty,
       SUM(SAFE_CAST(gross_amount AS FLOAT64)) AS gross
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE Transaction_Date IS NOT NULL
GROUP BY Fullfillment ORDER BY gross DESC;

-- R4) GRANULARITY RECONCILIATION — daily / weekly / monthly / qtr / yearly ----
-- Each grain's SUM(gross) must add to R2.gross_sales.
SELECT 'daily' grain, FORMAT_DATE('%Y-%m-%d', Transaction_Date) k, SUM(gross_amount) gross
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table` GROUP BY k
UNION ALL SELECT 'monthly', FORMAT_DATE('%Y-%m', Transaction_Date), SUM(gross_amount)
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table` GROUP BY 2
UNION ALL SELECT 'quarterly', FORMAT_DATE('%Y-Q', Transaction_Date)||CAST(EXTRACT(QUARTER FROM Transaction_Date) AS STRING), SUM(gross_amount)
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table` GROUP BY 2
UNION ALL SELECT 'yearly', FORMAT_DATE('%Y', Transaction_Date), SUM(gross_amount)
  FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table` GROUP BY 2
ORDER BY grain, k;

-- R5) CATEGORY TOTALS (dynamic — type_name) ----------------------------------
SELECT type_name AS category, COUNT(*) rows,
       SUM(SAFE_CAST(gross_amount AS FLOAT64)) gross,
       SUM(SAFE_CAST(pieces AS FLOAT64)) units
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE Transaction_Date IS NOT NULL
GROUP BY type_name ORDER BY gross DESC;

-- R6) DUPLICATE AUDIT — rows the dedup would drop (should be ~0; table is
--     already deduped at source, so this proves it) ---------------------------
SELECT gross_amount, Transaction_Date, CAST(document_no AS STRING) AS document_no,
       net_weight, COUNT(*) AS copies
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE Transaction_Date IS NOT NULL
GROUP BY gross_amount, Transaction_Date, document_no, net_weight
HAVING COUNT(*) > 1
ORDER BY copies DESC LIMIT 200;

-- R7) NEW vs REPEAT (uses the table's own customer_type) ----------------------
SELECT customer_type,
       COUNT(DISTINCT party_id) AS customers,
       COUNT(DISTINCT document_no) AS orders,
       SUM(SAFE_CAST(gross_amount AS FLOAT64)) AS gross
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
WHERE Transaction_Date IS NOT NULL
GROUP BY customer_type;
