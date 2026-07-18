-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh ga4_landing_summary for ONE date. Emits TWO row-sets into the same
-- table, distinguished by is_landing:
--   • is_landing = TRUE  → one row per session ENTRANCE page (Landing Pages tab):
--                          sessions, entrances, engaged, bounces, revenue.
--   • is_landing = FALSE → one row per page (Pages tab): page_views, users, eng.
-- NOTE (dialect): these files are BigQuery GoogleSQL. IDE "T-SQL" warnings about
-- DECLARE/CURSOR/backticks are false positives — do not "fix" them.
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE suffix      STRING DEFAULT FORMAT_DATE('%Y%m%d', target_date);

DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_landing_summary`
WHERE event_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_landing_summary`
WITH ev AS (
  SELECT
    user_pseudo_id,
    event_name,
    event_timestamp,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'ga_session_id')       AS session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged')      AS session_engaged,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS eng_msec,
    -- normalise page_location to a path (strip origin + query for grouping)
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location'),
        r'^https?://[^/]+', ''),
      r'[?#].*$', '')                                                                         AS page_path,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_title')            AS page_title,
    ecommerce
  FROM `lucirajewelry-prod.analytics_478308692.events_*`
  WHERE _TABLE_SUFFIX = suffix
),
-- session-level facts: entrance page (first page_view), engaged flag, revenue
sess AS (
  SELECT
    CONCAT(user_pseudo_id, '-', CAST(session_id AS STRING)) AS skey,
    ANY_VALUE(user_pseudo_id)                               AS user_pseudo_id,
    ARRAY_AGG(IF(event_name IN ('page_view','screen_view'), page_path, NULL)
              IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS landing_path,
    ARRAY_AGG(IF(event_name IN ('page_view','screen_view'), page_title, NULL)
              IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS landing_title,
    MAX(IF(session_engaged IN ('1','true'), 1, 0))          AS engaged,
    SUM(eng_msec) / 1000                                    AS eng_sec,
    SUM(IF(event_name = 'purchase', COALESCE(ecommerce.purchase_revenue, 0), 0)) AS revenue,
    COUNTIF(event_name = 'purchase')                        AS transactions
  FROM ev
  WHERE session_id IS NOT NULL
  GROUP BY skey
),
landing_rows AS (
  SELECT
    target_date                     AS event_date,
    COALESCE(landing_path, '(not set)') AS page_path,
    COALESCE(landing_title, '(not set)') AS page_title,
    TRUE                            AS is_landing,
    HLL_COUNT.INIT(user_pseudo_id)  AS users_hll,
    COUNT(DISTINCT skey)            AS sessions,
    COUNTIF(engaged = 1)            AS engaged_sessions,
    COUNT(DISTINCT skey)            AS entrances,
    CAST(NULL AS INT64)             AS page_views,
    COUNTIF(engaged = 0)            AS bounces,
    SUM(eng_sec)                    AS user_engagement_sec,
    SUM(transactions)               AS key_events,
    SUM(transactions)               AS transactions,
    SUM(revenue)                    AS revenue
  FROM sess
  GROUP BY page_path, page_title
),
page_rows AS (
  SELECT
    target_date                          AS event_date,
    COALESCE(page_path, '(not set)')     AS page_path,
    COALESCE(page_title, '(not set)')    AS page_title,
    FALSE                                AS is_landing,
    HLL_COUNT.INIT(user_pseudo_id)       AS users_hll,
    CAST(NULL AS INT64)                  AS sessions,
    CAST(NULL AS INT64)                  AS engaged_sessions,
    CAST(NULL AS INT64)                  AS entrances,
    COUNTIF(event_name IN ('page_view','screen_view')) AS page_views,
    CAST(NULL AS INT64)                  AS bounces,
    SUM(eng_msec) / 1000                 AS user_engagement_sec,
    CAST(NULL AS INT64)                  AS key_events,
    CAST(NULL AS INT64)                  AS transactions,
    CAST(NULL AS FLOAT64)                AS revenue
  FROM ev
  WHERE event_name IN ('page_view','screen_view')
  GROUP BY page_path, page_title
)
SELECT * FROM landing_rows
UNION ALL
SELECT * FROM page_rows;
