-- ============================================================================
-- bi.fact_kpi_daily — the copilot's heart. Tall table: one row per metric/day/slice.
-- The KPI engine writes here; this DDL just guarantees the shape (idempotent).
--
-- Population happens in Python (kpi/engine.py) OR you can materialise a domain
-- directly in SQL and MERGE. Example sales-revenue population shown at the bottom.
-- ============================================================================
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.bi.fact_kpi_daily` (
  date         DATE      NOT NULL,
  domain       STRING    NOT NULL,   -- sales|marketing|crm|inventory|product|ops
  kpi_key      STRING    NOT NULL,   -- revenue|orders|aov|...
  dimension    STRING,               -- store|channel|category|owner ... (NULL = grand total)
  dim_value    STRING,
  value        FLOAT64,
  unit         STRING,               -- INR|count|pct|days|ratio
  target       FLOAT64,
  source_table STRING,
  computed_at  TIMESTAMP
)
PARTITION BY date
CLUSTER BY domain, kpi_key
OPTIONS (description = 'Long/tall KPI fact. Add a KPI via config, never a schema change.');

-- ── Example: populate sales revenue+orders for one run_date directly in SQL. ──
-- (The Python KPI engine generalises this for every KPI in kpis.yaml.)
-- DECLARE run_date DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
--
-- MERGE `lucirajewelry-prod.bi.fact_kpi_daily` T
-- USING (
--   SELECT date, 'sales' domain, 'revenue' kpi_key,
--          CAST(NULL AS STRING) dimension, CAST(NULL AS STRING) dim_value,
--          SUM(net_amount) value, 'INR' unit, CAST(NULL AS FLOAT64) target,
--          'sales_dashboard.sales_reporting' source_table, CURRENT_TIMESTAMP() computed_at
--   FROM `lucirajewelry-prod.sales_dashboard.sales_reporting`
--   WHERE date = run_date GROUP BY date
-- ) S
-- ON  T.date=S.date AND T.domain=S.domain AND T.kpi_key=S.kpi_key
-- AND IFNULL(T.dimension,'')=IFNULL(S.dimension,'') AND IFNULL(T.dim_value,'')=IFNULL(S.dim_value,'')
-- WHEN MATCHED THEN UPDATE SET value=S.value, computed_at=S.computed_at
-- WHEN NOT MATCHED THEN INSERT ROW;
