-- ═══════════════════════════════════════════════════════════════════════════
--  STEP 0 — INTROSPECTION.  Run this ONCE before building the fact table.
--
--  Sales_overview_table and Live_inventory column names are already known and
--  baked into 10_build_fact.sql.  The two remaining sources — GRN and
--  Inventory_pivot — have not been introspected in-session (no live BigQuery
--  auth here).  Run the queries below, then reconcile the actual column names
--  against the CONFIG block at the top of 10_build_fact.sql and adjust if they
--  differ.  Everything downstream degrades gracefully via SAFE_CAST / IFNULL.
-- ═══════════════════════════════════════════════════════════════════════════

-- 0.1  Column list for every source ------------------------------------------
SELECT 'GRN' AS src, column_name, data_type
FROM `lucirajewelry-prod.Lucira_Prod.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'GRN'
UNION ALL
SELECT 'Inventory_pivot', column_name, data_type
FROM `lucirajewelry-prod.test.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'Inventory_pivot'
UNION ALL
SELECT 'Live_inventory', column_name, data_type
FROM `lucirajewelry-prod.ds_imputed_reporting.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'Live_inventory'
UNION ALL
SELECT 'Sales_overview_table', column_name, data_type
FROM `lucirajewelry-prod.ornaverse_erp_administration.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'Sales_overview_table'
ORDER BY src, column_name;

-- 0.2  GRN sample rows — confirm the join key (sku / item_code), the date
--      column, the quantity column, vendor, and rate.
SELECT * FROM `lucirajewelry-prod.Lucira_Prod.GRN` LIMIT 25;

-- 0.3  Inventory_pivot sample — confirm whether it is one-row-per-item with
--      one column per store (wide), or long (item, store, qty).  If wide, the
--      fact build reads store-wise on-hand from Live_inventory directly (it
--      already carries Store_name + pieces), so Inventory_pivot is only used
--      for cross-check.  If you prefer it as the on-hand source, remap in the
--      CONFIG block.
SELECT * FROM `lucirajewelry-prod.test.Inventory_pivot` LIMIT 25;

-- 0.4  Distinct stores / companies present across sources (used to build the
--      company_code → Store_name → Region/City crosswalk).
SELECT 'live'  AS src, Store_name AS store, location_name AS loc, COUNT(*) n
FROM `lucirajewelry-prod.ds_imputed_reporting.Live_inventory` GROUP BY 1,2,3
UNION ALL
SELECT 'sales', company_code, city_name, COUNT(*)
FROM `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table` GROUP BY 1,2,3
ORDER BY src, n DESC;
