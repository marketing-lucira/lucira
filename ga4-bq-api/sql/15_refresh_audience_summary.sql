-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh ga4_audience_summary for ONE date. TALL table: one row per
-- (date, dim, value) across every single-dimension breakdown the dashboard
-- needs — device, os, browser, platform, country, region, city, language,
-- hostname, newReturning, contentGroup (session-grain) + event (event-grain).
--
-- Technique: build one session-level base, then tag each session row once per
-- dimension via UNION ALL (fixed column list) and GROUP BY (dim, value). The
-- `event` breakdown is event-grain so it's computed separately and unioned in.
-- BigQuery GoogleSQL (ignore T-SQL "CURSOR"/backtick warnings).
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE suffix      STRING DEFAULT FORMAT_DATE('%Y%m%d', target_date);

DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_audience_summary`
WHERE event_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_audience_summary`
WITH ev AS (
  SELECT
    user_pseudo_id, event_name, event_timestamp, platform, items, ecommerce,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'ga_session_id')     AS session_id,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'ga_session_number') AS session_number,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged')   AS session_engaged,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'content_group')     AS content_group,
    REGEXP_EXTRACT(
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location'),
      r'^https?://([^/]+)')                    AS hostname,
    device.category            AS device_category,
    device.operating_system    AS os,
    device.web_info.browser    AS browser,
    device.language            AS language,
    geo.country                AS country,
    geo.region                 AS region,
    geo.city                   AS city
  FROM `lucirajewelry-prod.analytics_478308692.events_*`
  WHERE _TABLE_SUFFIX = suffix
),
-- one row per session with its (stable) attributes + rolled-up metrics
sess AS (
  SELECT
    CONCAT(user_pseudo_id, '-', CAST(session_id AS STRING)) AS skey,
    ANY_VALUE(user_pseudo_id)                     AS user_pseudo_id,
    IF(MAX(IF(event_name = 'first_visit' OR session_number = 1, 1, 0)) = 1, 'new', 'returning') AS new_returning,
    COALESCE(NULLIF(ANY_VALUE(device_category), ''), '(not set)') AS device_category,
    COALESCE(NULLIF(ANY_VALUE(os), ''),              '(not set)') AS os,
    COALESCE(NULLIF(ANY_VALUE(browser), ''),         '(not set)') AS browser,
    COALESCE(NULLIF(ANY_VALUE(platform), ''),        '(not set)') AS platform,
    COALESCE(NULLIF(ANY_VALUE(language), ''),        '(not set)') AS language,
    COALESCE(NULLIF(ANY_VALUE(hostname), ''),        '(not set)') AS hostname,
    COALESCE(NULLIF(ANY_VALUE(country), ''),         '(not set)') AS country,
    COALESCE(NULLIF(ANY_VALUE(region), ''),          '(not set)') AS region,
    COALESCE(NULLIF(ANY_VALUE(city), ''),            '(not set)') AS city,
    COALESCE(NULLIF(ANY_VALUE(content_group), ''),   '(not set)') AS content_group,
    MAX(IF(session_engaged IN ('1','true'), 1, 0))               AS engaged,
    COUNTIF(event_name IN ('page_view','screen_view'))           AS page_views,
    COUNT(*)                                                     AS event_count,
    COUNTIF(event_name = 'purchase')                             AS purchases,
    SUM(IF(event_name = 'purchase',
           (SELECT COALESCE(SUM(it.quantity), 0) FROM UNNEST(items) it), 0)) AS items_purchased,
    SUM(IF(event_name = 'purchase', COALESCE(ecommerce.purchase_revenue, 0), 0)) AS revenue
  FROM ev
  WHERE session_id IS NOT NULL
  GROUP BY skey
),
-- tag each session once per dimension. Every branch selects the SAME columns.
tagged AS (
  SELECT 'device' AS dim, device_category AS value,
         user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'os',           os,            user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'browser',      browser,       user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'platform',     platform,      user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'country',      country,       user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'region',       region,        user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'city',         city,          user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'language',     language,      user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'hostname',     hostname,      user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'newReturning', new_returning, user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
  UNION ALL SELECT 'contentGroup', content_group, user_pseudo_id, new_returning, engaged, page_views, event_count, purchases, items_purchased, revenue FROM sess
),
dim_rows AS (
  SELECT
    target_date AS event_date, dim,
    COALESCE(NULLIF(value, ''), '(not set)')                        AS value,
    HLL_COUNT.INIT(user_pseudo_id)                                  AS users_hll,
    HLL_COUNT.INIT(IF(new_returning = 'new', user_pseudo_id, NULL)) AS new_users_hll,
    COUNT(*)                                                        AS sessions,
    SUM(engaged)                                                    AS engaged_sessions,
    SUM(page_views)                                                 AS page_views,
    SUM(event_count)                                                AS event_count,
    SUM(purchases)                                                  AS key_events,
    SUM(purchases)                                                  AS transactions,
    SUM(items_purchased)                                            AS items_purchased,
    SUM(revenue)                                                    AS revenue
  FROM tagged
  GROUP BY dim, value
),
event_rows AS (
  SELECT
    target_date AS event_date, 'event' AS dim,
    COALESCE(NULLIF(event_name, ''), '(unnamed)')              AS value,
    HLL_COUNT.INIT(user_pseudo_id)                             AS users_hll,
    CAST(NULL AS BYTES)                                        AS new_users_hll,
    COUNT(DISTINCT CONCAT(user_pseudo_id, '-', CAST(session_id AS STRING))) AS sessions,
    CAST(NULL AS INT64)                                        AS engaged_sessions,
    COUNTIF(event_name IN ('page_view','screen_view'))        AS page_views,
    COUNT(*)                                                   AS event_count,
    COUNTIF(event_name = 'purchase')                          AS key_events,
    COUNTIF(event_name = 'purchase')                          AS transactions,
    CAST(NULL AS INT64)                                        AS items_purchased,
    SUM(IF(event_name = 'purchase', COALESCE(ecommerce.purchase_revenue, 0), 0)) AS revenue
  FROM ev
  GROUP BY value
)
SELECT * FROM dim_rows
UNION ALL
SELECT * FROM event_rows;
