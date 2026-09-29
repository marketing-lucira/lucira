-- Real hourly GA4 sessions — built 2026-08-18 to fill a genuine gap: nothing else in this
-- project rolls GA4 sessions up to hour-of-day (ga4_fact_sessions and the public "unified"
-- snapshot are both day-grain only). This queries the LIVE raw GA4 export directly
-- (analytics_478308692.events_*, confirmed current through yesterday at build time) instead
-- of duplicating the existing day-grain pipeline.
--
-- Sessionization: same method as dashboard/ds/ga4-bq-api/sql/fact_sessions.sql and the
-- ds_imputed_reporting.website_session_data view already in this project — group raw events
-- by (user_pseudo_id, ga_session_id) and take MIN(event_timestamp) as the session's start.
-- A session is bucketed into whichever hour/business_date its START falls into, using the
-- SAME Business Hours (10:00-20:59 IST) / Overnight (21:00-09:59 IST next day) logic as every
-- other table in this dashboard (dashboard/hsi.js#businessDateOf).
--
-- Cost: ~0.8 GB per 30 days scanned (confirmed via dry run) — cheap. Bounded to a 45-day
-- rolling window on purpose (WHERE _TABLE_SUFFIX BETWEEN ...), never a full-history scan.
--
-- NOT on a schedule yet. To refresh: run this file, then the EXPORT DATA statement below,
-- via `bq query --use_legacy_sql=false < ga4_hourly_sessions_refresh.sql` (needs `gcloud auth
-- login` on an account with BigQuery job + Storage Object Admin on lucirajewelry-prod-dashboards
-- first). A real fix would be a small Cloud Scheduler job running this daily, same pattern as
-- walkin-source-api / store-visit-api's 10:00 IST refresh — not built yet, see main README.

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.ga4_hourly_sessions` AS
WITH ev AS (
  SELECT
    user_pseudo_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key='ga_session_id') AS session_id,
    event_timestamp
  FROM `lucirajewelry-prod.analytics_478308692.events_*`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 45 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Kolkata'))
),
sess AS (
  SELECT CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey,
         ANY_VALUE(user_pseudo_id) AS user_pseudo_id,
         MIN(event_timestamp) AS start_ts
  FROM ev WHERE session_id IS NOT NULL
  GROUP BY skey
),
bucketed AS (
  SELECT
    skey, user_pseudo_id,
    EXTRACT(HOUR FROM DATETIME(TIMESTAMP_MICROS(start_ts), 'Asia/Kolkata')) AS hour_ist,
    DATE(DATETIME(TIMESTAMP_MICROS(start_ts), 'Asia/Kolkata')) AS cal_date
  FROM sess
)
-- `window` is a reserved word in BigQuery SQL — column is named time_window instead.
SELECT
  IF(hour_ist < 10, DATE_SUB(cal_date, INTERVAL 1 DAY), cal_date) AS business_date,
  IF(hour_ist >= 10 AND hour_ist < 21, 'Business Hours', 'Overnight') AS time_window,
  hour_ist AS hour,
  COUNT(*) AS sessions,
  COUNT(DISTINCT user_pseudo_id) AS users
FROM bucketed
GROUP BY business_date, time_window, hour
ORDER BY business_date, hour;

-- Publish to the SAME public bucket the other 3 live sources already use (CORS-open,
-- unauthenticated GET) — dashboard/hsi.js fetches this directly, no new Cloud Function needed.
-- EXPORT DATA requires a wildcard URI even for a single-shard result; this table is small
-- (~1,080 rows for a 45-day window) so it always lands in one file, `*-000000000000.json`.
EXPORT DATA OPTIONS (
  uri = 'gs://lucirajewelry-prod-dashboards/ga4/hourly-sessions-latest-*.json',
  format = 'JSON',
  overwrite = true
) AS
SELECT business_date, time_window, hour, sessions, users
FROM `lucirajewelry-prod.ds_imputed_reporting.ga4_hourly_sessions`
ORDER BY business_date, hour;
