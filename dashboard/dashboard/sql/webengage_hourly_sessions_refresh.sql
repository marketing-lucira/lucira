-- REAL WebEngage hourly sessions — built 2026-08-19, superseding the GA4-derived stand-in
-- (dashboard/sql/ga4_hourly_sessions_refresh.sql). The user pointed out the actual WebEngage
-- BigQuery data-share DOES exist and IS live — it lives in a SEPARATE GCP project
-- (`test-webengage`, dataset `11b56595a_shared`), not in `lucirajewelry-prod` where every other
-- table in this project lives. That's why the earlier exhaustive search of `lucirajewelry-prod`
-- never found it. Confirmed live 2026-08-19: `system_view_v1`'s `user_session_started` event
-- carries a genuine per-session `suid` (WebEngage generates this fresh per session — no
-- gap-based sessionization needed, unlike the GA4 stand-in), real `luid` (user), `event_time`,
-- `device_type`, `city`. Data present back to at least 2026-05-22, current through today.
--
-- Same DELETE+INSERT rolling-window pattern as ga4-bq-api/sql/fact_sessions.sql and the
-- existing `ga4_data.ga4_data` refresh (self-healing: any missed run or late-arriving day
-- corrects itself on the next run, per the user's own example). `pt` is WebEngage's documented
-- partition column — always filter on it, per WebEngage's own BigQuery Access doc.
--
-- NOT on a schedule yet — see README "Known follow-ups". Re-run manually via
-- `bq query --use_legacy_sql=false < webengage_hourly_sessions_refresh.sql`.

CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ds_imputed_reporting.webengage_hourly_sessions` (
  business_date DATE,
  time_window STRING,
  hour INT64,
  sessions INT64,
  users INT64
);

DELETE FROM `lucirajewelry-prod.ds_imputed_reporting.webengage_hourly_sessions`
WHERE business_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 45 DAY);

INSERT INTO `lucirajewelry-prod.ds_imputed_reporting.webengage_hourly_sessions`
WITH ev AS (
  SELECT
    suid,
    luid,
    DATETIME(event_time, 'Asia/Kolkata') AS ist_dt
  FROM `test-webengage.11b56595a_shared.system_view_v1`
  WHERE event_name = 'user_session_started'
    AND suid IS NOT NULL
    -- pt filter for partition pruning (WebEngage's own guidance) — scanned wider than the
    -- 45-day output window so overnight hours 0-9 (which roll back to the PRIOR business_date)
    -- near the boundary are never silently dropped.
    AND pt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 46 DAY)
),
bucketed AS (
  SELECT
    suid, luid,
    EXTRACT(HOUR FROM ist_dt) AS hour_ist,
    DATE(ist_dt) AS cal_date
  FROM ev
)
SELECT
  IF(hour_ist < 10, DATE_SUB(cal_date, INTERVAL 1 DAY), cal_date) AS business_date,
  IF(hour_ist >= 10 AND hour_ist < 21, 'Business Hours', 'Overnight') AS time_window,
  hour_ist AS hour,
  COUNT(DISTINCT suid) AS sessions,
  COUNT(DISTINCT luid) AS users
FROM bucketed
WHERE IF(hour_ist < 10, DATE_SUB(cal_date, INTERVAL 1 DAY), cal_date) >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 45 DAY)
GROUP BY business_date, time_window, hour;

-- Publish to a public GCS path, separate from the old GA4 one so it's obvious which is which.
EXPORT DATA OPTIONS (
  uri = 'gs://lucirajewelry-prod-dashboards/webengage/hourly-sessions-latest-*.json',
  format = 'JSON',
  overwrite = true
) AS
SELECT business_date, time_window, hour, sessions, users
FROM `lucirajewelry-prod.ds_imputed_reporting.webengage_hourly_sessions`
ORDER BY business_date, hour;
