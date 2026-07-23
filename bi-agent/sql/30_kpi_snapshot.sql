-- ============================================================================
-- bi.kpi_snapshot — dashboard-ready period-over-period rollup, rebuilt each run.
-- Reads the tall fact, produces current vs previous window with deltas + sparkline.
-- Parameterised by @win_days (period length) and @run_date (latest closed day).
-- ============================================================================
CREATE OR REPLACE TABLE `lucirajewelry-prod.bi.kpi_snapshot` AS
WITH params AS (
  SELECT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY) AS run_date, 7 AS win_days
),
windows AS (
  SELECT
    f.*,
    p.run_date,
    CASE
      WHEN f.date BETWEEN DATE_SUB(p.run_date, INTERVAL p.win_days-1 DAY) AND p.run_date THEN 'cur'
      WHEN f.date BETWEEN DATE_SUB(p.run_date, INTERVAL 2*p.win_days-1 DAY)
                      AND DATE_SUB(p.run_date, INTERVAL p.win_days DAY)   THEN 'prev'
      ELSE 'hist'
    END AS bucket
  FROM `lucirajewelry-prod.bi.fact_kpi_daily` f, params p
  WHERE f.date >= DATE_SUB(p.run_date, INTERVAL 30 DAY)
),
agg AS (
  SELECT domain, kpi_key, dimension, dim_value, unit, ANY_VALUE(target) target,
    SUM(IF(bucket='cur',  value, 0)) AS cur_value,
    SUM(IF(bucket='prev', value, 0)) AS prev_value,
    ARRAY_AGG(IF(bucket IN ('cur','hist'), value, NULL) IGNORE NULLS
              ORDER BY date) AS sparkline
  FROM windows
  GROUP BY domain, kpi_key, dimension, dim_value, unit
)
SELECT
  domain, kpi_key, dimension, dim_value, unit, target,
  cur_value  AS value,
  prev_value AS prev_value,
  cur_value - prev_value AS delta_abs,
  SAFE_DIVIDE(cur_value - prev_value, NULLIF(prev_value, 0)) * 100 AS delta_pct,
  SAFE_DIVIDE(cur_value, NULLIF(target, 0)) * 100 AS attainment_pct,
  sparkline,
  CURRENT_TIMESTAMP() AS computed_at
FROM agg;
