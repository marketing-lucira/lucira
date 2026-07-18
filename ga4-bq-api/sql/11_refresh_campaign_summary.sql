-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh ga4_campaign_summary for ONE date (date × channel × source × medium ×
-- campaign). Serves the Traffic + Campaign dashboards and the channel/source/
-- medium/sourceMedium/campaign breakdowns.
--
-- Session attribution: each session is tagged with the source/medium/campaign of
-- its earliest event that carries a real (non-direct) collected source — a
-- session-grain approximation of GA4's last-non-direct model. `collected_traffic_
-- source` (event-scoped) is preferred; falls back to `traffic_source` (user
-- first-touch) on older exports. Validate against GA4's Traffic acquisition report.
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date DATE   DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
DECLARE suffix      STRING DEFAULT FORMAT_DATE('%Y%m%d', target_date);

DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_campaign_summary`
WHERE event_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_campaign_summary`
WITH ev AS (
  SELECT
    user_pseudo_id,
    event_name,
    event_timestamp,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key = 'ga_session_id')  AS session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged,
    COALESCE(collected_traffic_source.manual_source,        traffic_source.source) AS src,
    COALESCE(collected_traffic_source.manual_medium,        traffic_source.medium) AS med,
    COALESCE(collected_traffic_source.manual_campaign_name, traffic_source.name)   AS camp,
    collected_traffic_source.manual_campaign_id                                    AS camp_id,
    ecommerce, items
  FROM `lucirajewelry-prod.analytics_478308692.events_*`
  WHERE _TABLE_SUFFIX = suffix
),
-- Per-session defining source: first event that has a real source wins.
ranked AS (
  SELECT
    CONCAT(user_pseudo_id, '-', CAST(session_id AS STRING)) AS skey,
    user_pseudo_id, src, med, camp, camp_id,
    ROW_NUMBER() OVER (
      PARTITION BY CONCAT(user_pseudo_id, '-', CAST(session_id AS STRING))
      ORDER BY (src IS NOT NULL AND src NOT IN ('', '(direct)')) DESC, event_timestamp ASC
    ) AS rn
  FROM ev
  WHERE session_id IS NOT NULL
),
sattr AS (
  SELECT
    skey, user_pseudo_id,
    COALESCE(NULLIF(src, ''),  '(direct)') AS source,
    COALESCE(NULLIF(med, ''),  '(none)')   AS medium,
    COALESCE(NULLIF(camp, ''), '(not set)') AS campaign,
    COALESCE(camp_id, '')                   AS campaign_id
  FROM ranked WHERE rn = 1
),
-- Tag every session-bearing event with its session's attributes.
tagged AS (
  SELECT
    e.user_pseudo_id, e.event_name, e.ecommerce, e.items,
    (e.session_engaged IN ('1','true')) AS engaged,
    CONCAT(e.user_pseudo_id, '-', CAST(e.session_id AS STRING)) AS skey,
    a.source, a.medium, a.campaign, a.campaign_id
  FROM ev e
  JOIN sattr a
    ON a.skey = CONCAT(e.user_pseudo_id, '-', CAST(e.session_id AS STRING))
)
SELECT
  target_date AS event_date,
  `lucirajewelry-prod.ga4_dashboard.default_channel_group`(source, medium, campaign) AS channel,
  source, medium, campaign, campaign_id,
  HLL_COUNT.INIT(user_pseudo_id)                                                     AS users_hll,
  HLL_COUNT.INIT(IF(event_name = 'first_visit', user_pseudo_id, NULL))              AS new_users_hll,
  COUNT(DISTINCT skey)                                                              AS sessions,
  COUNT(DISTINCT IF(engaged, skey, NULL))                                           AS engaged_sessions,
  COUNTIF(event_name IN ('page_view', 'screen_view'))                              AS page_views,
  COUNT(*)                                                                          AS event_count,
  COUNTIF(event_name = 'purchase')                                                  AS key_events,
  COUNTIF(event_name = 'add_to_cart')                                               AS add_to_carts,
  COUNTIF(event_name = 'begin_checkout')                                            AS checkouts,
  COUNTIF(event_name = 'purchase')                                                  AS transactions,
  SUM(IF(event_name = 'purchase',
         (SELECT COALESCE(SUM(it.quantity), 0) FROM UNNEST(items) it), 0))          AS items_purchased,
  SUM(IF(event_name = 'purchase', COALESCE(ecommerce.purchase_revenue, 0), 0))      AS revenue
FROM tagged2
GROUP BY channel, source, medium, campaign, campaign_id;
