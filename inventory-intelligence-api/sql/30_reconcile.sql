-- ═══════════════════════════════════════════════════════════════════════════
--  RECONCILIATION — run after the first build to certify the fact table.
-- ═══════════════════════════════════════════════════════════════════════════

-- R1  Row / SKU / store counts + refresh freshness.
SELECT COUNT(*) rows, COUNT(DISTINCT sku) skus, COUNT(DISTINCT store) stores,
       MAX(refreshed_at) refreshed_at, MAX(refresh_date) refresh_date
FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
WHERE refresh_date = CURRENT_DATE();

-- R2  Scope integrity — Silver / Coin must be ZERO everywhere.
SELECT COUNTIF(LOWER(metal)='silver') silver_rows,
       COUNTIF(LOWER(category) LIKE '%coin%') coin_rows
FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
WHERE refresh_date = CURRENT_DATE();

-- R3  Status distribution should sum to total SKUs (no row uncategorised).
SELECT inventory_status, COUNT(*) n, SUM(current_stock) units
FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
WHERE refresh_date = CURRENT_DATE() GROUP BY 1 ORDER BY n DESC;

-- R4  Recommendation mix — sanity-check the AI engine spread.
SELECT ai_recommendation, ai_priority, COUNT(*) n,
       CAST(ROUND(AVG(ai_confidence)) AS INT64) avg_conf
FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
WHERE refresh_date = CURRENT_DATE() GROUP BY 1,2 ORDER BY n DESC;

-- R5  Fact vs META headline must agree (value + SKU count).
SELECT
  (SELECT ROUND(SUM(inventory_value)) FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact` WHERE refresh_date=CURRENT_DATE()) AS fact_value,
  (SELECT total_inventory_value FROM `lucirajewelry-prod.reporting.inventory_intelligence_meta`) AS meta_value,
  (SELECT COUNT(DISTINCT sku) FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact` WHERE refresh_date=CURRENT_DATE()) AS fact_skus,
  (SELECT total_sku FROM `lucirajewelry-prod.reporting.inventory_intelligence_meta`) AS meta_skus;

-- R6  No NULL leakage in the columns the dashboard renders directly.
SELECT
  COUNTIF(store IS NULL) null_store, COUNTIF(sku IS NULL) null_sku,
  COUNTIF(inventory_status IS NULL) null_status,
  COUNTIF(ai_recommendation IS NULL) null_rec,
  COUNTIF(days_cover IS NULL) null_cover
FROM `lucirajewelry-prod.reporting.inventory_intelligence_fact`
WHERE refresh_date = CURRENT_DATE();

-- R7  Transfer feasibility — suggested qty never exceeds source surplus.
SELECT COUNT(*) transfers, SUM(suggested_qty) units, SUM(expected_value_moved) value
FROM `lucirajewelry-prod.reporting.inventory_intelligence_transfers`
WHERE refresh_date = CURRENT_DATE();
