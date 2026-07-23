-- ============================================================================
-- GCP Cost Dashboard — canonical BigQuery billing-export queries
-- Replace  `PROJECT.DATASET.gcp_billing_export_resource_v1_XXXX`  with your
-- detailed usage-cost export table.  These are the exact queries behind the
-- dashboard; main.py runs #1. The rest power the deep-dive tabs when enriched.
-- ============================================================================

-- 1) DAILY LINE ITEMS (the fact table the dashboard ingests) ------------------
-- One row per (day, project, service, sku, region, resource). Net cost =
-- cost + credits (credits are negative). @days / @tz are bind params.
SELECT
    FORMAT_TIMESTAMP('%Y-%m-%d', usage_start_time, @tz)            AS date,
    IFNULL(project.id, '(unattributed)')                          AS project,
    service.description                                           AS service,
    sku.description                                               AS sku,
    IFNULL(location.region, 'global')                             AS region,
    IFNULL(resource.name, sku.description)                        AS resource,
    SUM(cost)                                                     AS cost,
    SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credit,
    SUM(usage.amount)                                             AS usage,
    ANY_VALUE(usage.unit)                                         AS usage_unit,
    (SELECT value FROM UNNEST(labels) WHERE key='env')            AS lbl_env,
    (SELECT value FROM UNNEST(labels) WHERE key='team')           AS lbl_team
FROM `PROJECT.DATASET.gcp_billing_export_resource_v1_XXXX`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
GROUP BY date, project, service, sku, region, resource, lbl_env, lbl_team
HAVING ABS(cost) > 0 OR ABS(credit) > 0
ORDER BY date;

-- 2) MONTH-TO-DATE by service -------------------------------------------------
SELECT
    service.description AS service,
    SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c),0)) AS net_cost
FROM `PROJECT.DATASET.gcp_billing_export_resource_v1_XXXX`
WHERE invoice.month = FORMAT_TIMESTAMP('%Y%m', CURRENT_TIMESTAMP(), @tz)
GROUP BY service ORDER BY net_cost DESC;

-- 3) TOP EXPENSIVE BIGQUERY QUERIES (BigQuery tab) ----------------------------
-- Region-qualified. Cost estimated from bytes billed at the on-demand rate
-- (default $6.25/TiB — adjust for your edition / flat-rate reservations).
SELECT
    job_id, user_email,
    query,
    ROUND(total_bytes_billed / POW(2,40), 3)                 AS tib_billed,
    ROUND(total_bytes_billed / POW(2,40) * 6.25, 2)          AS est_cost_usd,
    creation_time
FROM `region-asia-south1`.INFORMATION_SCHEMA.JOBS
WHERE job_type = 'QUERY'
  AND state = 'DONE'
  AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
ORDER BY total_bytes_billed DESC
LIMIT 25;

-- 4) TOP BIGQUERY COST USERS --------------------------------------------------
SELECT
    user_email,
    ROUND(SUM(total_bytes_billed) / POW(2,40), 2)            AS tib_billed,
    ROUND(SUM(total_bytes_billed) / POW(2,40) * 6.25, 2)     AS est_cost_usd,
    COUNT(*)                                                 AS query_count
FROM `region-asia-south1`.INFORMATION_SCHEMA.JOBS
WHERE job_type='QUERY' AND state='DONE'
  AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
GROUP BY user_email ORDER BY tib_billed DESC LIMIT 20;

-- 5) DAY-OVER-DAY SPIKE DETECTION (Alerts tab) --------------------------------
WITH daily AS (
  SELECT FORMAT_TIMESTAMP('%Y-%m-%d', usage_start_time, @tz) AS date,
         SUM(cost)+SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c),0)) AS net
  FROM `PROJECT.DATASET.gcp_billing_export_resource_v1_XXXX`
  WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY date )
SELECT date, net,
       LAG(net) OVER (ORDER BY date) AS prev_net,
       SAFE_DIVIDE(net - LAG(net) OVER (ORDER BY date), LAG(net) OVER (ORDER BY date))*100 AS dod_pct
FROM daily ORDER BY date DESC;

-- 6) CREDITS BREAKDOWN (how much CUD / free-tier / promo you're getting) ------
SELECT c.type AS credit_type, SUM(c.amount) AS credit_amount
FROM `PROJECT.DATASET.gcp_billing_export_resource_v1_XXXX`, UNNEST(credits) c
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
GROUP BY credit_type ORDER BY credit_amount;

-- 7) UNATTRIBUTED / MISSING-LABEL COST (data-quality check) -------------------
-- Surfaces spend with no resource label so "no missing data" holds true.
SELECT service.description AS service, SUM(cost) AS cost
FROM `PROJECT.DATASET.gcp_billing_export_resource_v1_XXXX`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
  AND resource.name IS NULL
GROUP BY service ORDER BY cost DESC;
