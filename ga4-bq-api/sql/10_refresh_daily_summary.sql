-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh ga4_daily_summary for ONE date (idempotent: delete+insert partition).
-- Default target = yesterday IST (correct for a 09:00 IST scheduled run, since
-- that day's events_YYYYMMDD shard is finalized). The backend overrides
-- `target_date` when triggering a manual/backfill refresh.
--
-- Key events: GA4's BigQuery export does not flag conversions per-event, so
-- "key events" must be a curated event-name list. Edit key_events_set to match
-- the Key Events configured in your GA4 property.
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date    DATE          DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE suffix         STRING        DEFAULT FORMAT_DATE('%Y%m%d', target_date);
DECLARE key_events_set ARRAY<STRING> DEFAULT ['purchase'];  -- ← set to your GA4 Key Events

DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_daily_summary`
WHERE event_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_daily_summary`
WITH ev AS (
  SELECT
    user_pseudo_id,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'ga_session_id')       AS session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged')      AS session_engaged,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS eng_msec,
    event_name,
    ecommerce,
    items
  FROM `lucirajewelry-prod.analytics_478308692.events_*`
  WHERE _TABLE_SUFFIX = suffix
),
sess AS (
  SELECT
    CONCAT(user_pseudo_id, '-', CAST(session_id AS STRING)) AS skey,
    MAX(IF(session_engaged IN ('1', 'true'), 1, 0))         AS engaged
  FROM ev
  WHERE session_id IS NOT NULL
  GROUP BY skey
)
SELECT
  target_date                                                                       AS event_date,
  COUNT(DISTINCT user_pseudo_id)                                                    AS users,
  COUNT(DISTINCT IF(event_name = 'first_visit', user_pseudo_id, NULL))              AS new_users,
  HLL_COUNT.INIT(user_pseudo_id)                                                    AS users_hll,
  HLL_COUNT.INIT(IF(event_name = 'first_visit', user_pseudo_id, NULL))              AS new_users_hll,
  (SELECT COUNT(DISTINCT skey)      FROM sess)                                       AS sessions,
  (SELECT COUNTIF(engaged = 1)      FROM sess)                                       AS engaged_sessions,
  SAFE_DIVIDE(SUM(eng_msec) / 1000, COUNT(DISTINCT user_pseudo_id))                  AS avg_engagement_time_sec,
  COUNTIF(event_name IN ('page_view', 'screen_view'))                               AS page_views,
  COUNT(*)                                                                          AS event_count,
  COUNTIF(event_name = 'view_item')                                                 AS ev_view_item,
  COUNTIF(event_name = 'add_to_cart')                                               AS ev_add_to_cart,
  COUNTIF(event_name = 'begin_checkout')                                            AS ev_begin_checkout,
  COUNTIF(event_name = 'add_shipping_info')                                         AS ev_add_shipping,
  COUNTIF(event_name = 'add_payment_info')                                          AS ev_add_payment,
  COUNTIF(event_name = 'purchase')                                                  AS ev_purchase,
  COUNTIF(event_name IN UNNEST(key_events_set))                                     AS key_events,
  COUNTIF(event_name = 'purchase')                                                  AS transactions,
  SUM(IF(event_name = 'purchase',
         (SELECT COALESCE(SUM(it.quantity), 0) FROM UNNEST(items) it), 0))          AS items_purchased,
  COUNTIF(event_name = 'refund')                                                    AS refunds,
  SUM(IF(event_name = 'purchase', COALESCE(ecommerce.purchase_revenue, 0), 0))      AS revenue,
  SUM(IF(event_name = 'refund',   COALESCE(ecommerce.refund_value,     0), 0))      AS refund_value
FROM ev;
