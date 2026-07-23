-- ============================================================================
-- bi.dim_date — IST calendar with jewelry seasonality. Rebuilt (cheap, static).
-- ============================================================================
CREATE OR REPLACE TABLE `lucirajewelry-prod.bi.dim_date`
CLUSTER BY date AS
WITH days AS (
  SELECT d AS date
  FROM UNNEST(GENERATE_DATE_ARRAY('2023-01-01', DATE_ADD(CURRENT_DATE('Asia/Kolkata'), INTERVAL 400 DAY))) AS d
)
SELECT
  date,
  FORMAT_DATE('%A', date)                                        AS day_name,
  EXTRACT(ISOWEEK  FROM date)                                    AS iso_week,
  EXTRACT(MONTH    FROM date)                                    AS month,
  EXTRACT(QUARTER  FROM date)                                    AS quarter,
  EXTRACT(YEAR     FROM date)                                    AS year,
  -- fiscal year Apr–Mar
  CONCAT('FY',
    CAST(IF(EXTRACT(MONTH FROM date) >= 4,
            EXTRACT(YEAR FROM date), EXTRACT(YEAR FROM date) - 1) AS STRING)) AS fiscal_year,
  EXTRACT(DAYOFWEEK FROM date) IN (1, 7)                         AS is_weekend,
  CASE
    WHEN EXTRACT(MONTH FROM date) IN (10, 11) THEN 'Diwali'
    WHEN EXTRACT(MONTH FROM date) IN (4, 5)   THEN 'Akshaya Tritiya'
    WHEN EXTRACT(MONTH FROM date) = 2         THEN 'Valentine'
    ELSE NULL
  END                                                           AS festival,
  CASE
    WHEN EXTRACT(MONTH FROM date) IN (10, 11) THEN 1.7
    WHEN EXTRACT(MONTH FROM date) IN (4, 5)   THEN 1.45
    WHEN EXTRACT(MONTH FROM date) = 2         THEN 1.3
    WHEN EXTRACT(DAYOFWEEK FROM date) IN (1, 7) THEN 1.15
    ELSE 1.0
  END                                                           AS season_weight
FROM days;
