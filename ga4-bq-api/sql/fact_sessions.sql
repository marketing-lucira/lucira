-- ═══════════════════════════════════════════════════════════════════════════
-- ga4_fact_sessions  —  the SINGLE consolidated fact table (session grain)
-- ═══════════════════════════════════════════════════════════════════════════
-- Per the requirement: ONE optimized fact table is the dashboard's only data
-- source. It consolidates the GA4 export daily event shards
-- (`lucirajewelry-prod.analytics_478308692.events_*`) into one row per SESSION,
-- carrying every dimension + funnel counts + revenue + an items[] array. Every
-- KPI, chart, AI insight and recommendation is derived from THIS table alone
-- (GROUP BY a column for a breakdown; UNNEST(items) for product/SKU analytics).
--
-- ⚠ CONFIRM the source: this assumes the GA4 → BigQuery export dataset
--   `analytics_478308692`. If your tables live elsewhere (or you also want
--   Shopify/CRM joined in), change the FROM / add joins below.
--
-- Refresh: register this file as a **BigQuery Scheduled Query** running daily at
-- 09:00 IST (Asia/Kolkata). It rebuilds only the previous day's partition, so
-- cost stays low. `@run_date` is supplied automatically by Scheduled Queries;
-- the DECLARE default (yesterday IST) also lets you run it by hand.
--
-- Destination table (create once with 00_setup_fact.sql, or let the Scheduled
-- Query create it): `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
--   PARTITION BY session_date  CLUSTER BY channel, country, device_category
-- ═══════════════════════════════════════════════════════════════════════════
DECLARE target_date    DATE          DEFAULT DATE_SUB(COALESCE(@run_date, CURRENT_DATE('Asia/Kolkata')), INTERVAL 1 DAY);
DECLARE suffix         STRING        DEFAULT FORMAT_DATE('%Y%m%d', target_date);
DECLARE key_events_set ARRAY<STRING> DEFAULT ['purchase'];   -- ← set to your GA4 Key Events

-- idempotent: rebuild just this day's partition
DELETE FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
WHERE session_date = target_date;

INSERT INTO `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
WITH ev AS (
  SELECT
    user_pseudo_id, event_name, event_timestamp, platform, items, ecommerce,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key='ga_session_id')       AS session_id,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key='ga_session_number')   AS session_number,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='session_engaged')     AS session_engaged,
    (SELECT value.int_value    FROM UNNEST(event_params) WHERE key='engagement_time_msec') AS eng_msec,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='content_group')       AS content_group,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='page_location')       AS page_location,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='page_title')          AS page_title,
    COALESCE(collected_traffic_source.manual_source,        traffic_source.source) AS src,
    COALESCE(collected_traffic_source.manual_medium,        traffic_source.medium) AS med,
    COALESCE(collected_traffic_source.manual_campaign_name, traffic_source.name)   AS camp,
    collected_traffic_source.manual_campaign_id                                    AS camp_id,
    device.category         AS device_category,
    device.operating_system AS os,
    device.web_info.browser AS browser,
    device.language         AS language,
    geo.country AS country, geo.region AS region, geo.city AS city
  FROM `lucirajewelry-prod.analytics_478308692.events_*`
  WHERE _TABLE_SUFFIX = suffix
),
-- pick each session's defining traffic source (first real non-direct event)
src_rank AS (
  SELECT CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey, src, med, camp, camp_id,
    ROW_NUMBER() OVER (PARTITION BY CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING))
      ORDER BY (src IS NOT NULL AND src NOT IN ('','(direct)')) DESC, event_timestamp ASC) AS rn
  FROM ev WHERE session_id IS NOT NULL
),
sess_src AS (
  SELECT skey,
    COALESCE(NULLIF(src,''),'(direct)')  AS source,
    COALESCE(NULLIF(med,''),'(none)')    AS medium,
    COALESCE(NULLIF(camp,''),'(not set)') AS campaign,
    COALESCE(camp_id,'')                  AS campaign_id
  FROM src_rank WHERE rn = 1
),
-- session entrance (first page_view) for landing page
land AS (
  SELECT CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey,
    ARRAY_AGG(IF(event_name IN ('page_view','screen_view'),
      REGEXP_REPLACE(REGEXP_REPLACE(page_location,r'^https?://[^/]+',''),r'[?#].*$',''),NULL)
      IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS landing_page,
    ARRAY_AGG(IF(event_name IN ('page_view','screen_view'), page_title, NULL)
      IGNORE NULLS ORDER BY event_timestamp ASC LIMIT 1)[SAFE_OFFSET(0)] AS landing_title,
    REGEXP_EXTRACT(ANY_VALUE(page_location), r'^https?://([^/]+)') AS hostname
  FROM ev WHERE session_id IS NOT NULL GROUP BY skey
),
-- all item rows in the session → one items[] array on the session row
items_agg AS (
  SELECT CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey,
    ARRAY_AGG(STRUCT(
      it.item_id AS item_id, it.item_name AS item_name, it.item_brand AS item_brand,
      it.item_category AS item_category, it.quantity AS quantity,
      it.item_revenue AS item_revenue, e.event_name AS event_name)) AS items
  FROM ev e, UNNEST(e.items) AS it
  WHERE e.session_id IS NOT NULL
    AND e.event_name IN ('view_item','add_to_cart','begin_checkout','purchase','refund')
  GROUP BY skey
),
-- per-session event-name counts → events[] (powers the Events tab)
events_agg AS (
  SELECT skey, ARRAY_AGG(STRUCT(event_name AS event_name, cnt AS cnt)) AS events FROM (
    SELECT CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey, event_name, COUNT(*) AS cnt
    FROM ev WHERE session_id IS NOT NULL GROUP BY skey, event_name
  ) GROUP BY skey
),
-- per-session page counts → pages[] (powers the Pages tab)
pages_agg AS (
  SELECT skey, ARRAY_AGG(STRUCT(page_path AS page_path, page_title AS page_title, views AS views)) AS pages FROM (
    SELECT CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey,
      REGEXP_REPLACE(REGEXP_REPLACE(page_location,r'^https?://[^/]+',''),r'[?#].*$','') AS page_path,
      ANY_VALUE(page_title) AS page_title, COUNT(*) AS views
    FROM ev WHERE session_id IS NOT NULL AND event_name IN ('page_view','screen_view')
    GROUP BY skey, page_path
  ) GROUP BY skey
)
SELECT
  target_date AS session_date,
  s.skey AS session_key,
  ANY_VALUE(s.user_pseudo_id) AS user_pseudo_id,
  IF(MAX(IF(s.event_name='first_visit' OR s.session_number=1,1,0))=1, TRUE, FALSE) AS is_new_user,
  MAX(IF(s.session_engaged IN ('1','true'),1,0))=1 AS engaged,
  SUM(s.eng_msec)/1000 AS engagement_time_sec,
  COUNTIF(s.event_name IN ('page_view','screen_view')) AS page_views,
  COUNT(*) AS event_count,
  `lucirajewelry-prod.ga4_dashboard.default_channel_group`(a.source,a.medium,a.campaign) AS channel,
  a.source, a.medium, a.campaign, a.campaign_id,
  COALESCE(NULLIF(ANY_VALUE(s.device_category),''),'(not set)') AS device_category,
  COALESCE(NULLIF(ANY_VALUE(s.os),''),'(not set)') AS operating_system,
  COALESCE(NULLIF(ANY_VALUE(s.browser),''),'(not set)') AS browser,
  COALESCE(NULLIF(ANY_VALUE(s.platform),''),'(not set)') AS platform,
  COALESCE(NULLIF(ANY_VALUE(s.language),''),'(not set)') AS language,
  COALESCE(NULLIF(ANY_VALUE(s.country),''),'(not set)') AS country,
  COALESCE(NULLIF(ANY_VALUE(s.region),''),'(not set)') AS region,
  COALESCE(NULLIF(ANY_VALUE(s.city),''),'(not set)') AS city,
  COALESCE(NULLIF(l.landing_page,''),'(not set)') AS landing_page,
  COALESCE(NULLIF(l.landing_title,''),'(not set)') AS landing_title,
  COALESCE(NULLIF(l.hostname,''),'(not set)') AS hostname,
  COALESCE(NULLIF(ANY_VALUE(s.content_group),''),'(not set)') AS content_group,
  COUNTIF(s.event_name='view_item')        AS ev_view_item,
  COUNTIF(s.event_name='add_to_cart')      AS ev_add_to_cart,
  COUNTIF(s.event_name='begin_checkout')   AS ev_begin_checkout,
  COUNTIF(s.event_name='add_shipping_info') AS ev_add_shipping,
  COUNTIF(s.event_name='add_payment_info') AS ev_add_payment,
  COUNTIF(s.event_name='purchase')         AS ev_purchase,
  COUNTIF(s.event_name='refund')           AS ev_refund,
  COUNTIF(s.event_name IN UNNEST(key_events_set)) AS key_events,
  COUNTIF(s.event_name='purchase')         AS transactions,
  SUM(IF(s.event_name='purchase',(SELECT COALESCE(SUM(q.quantity),0) FROM UNNEST(s.items) q),0)) AS items_qty,
  SUM(IF(s.event_name='purchase', COALESCE(s.ecommerce.purchase_revenue,0),0)) AS revenue,
  SUM(IF(s.event_name='refund',   COALESCE(s.ecommerce.refund_value,0),0))     AS refund_value,
  ANY_VALUE(i.items)  AS items,
  ANY_VALUE(ea.events) AS events,
  ANY_VALUE(pa.pages)  AS pages
FROM (SELECT *, CONCAT(user_pseudo_id,'-',CAST(session_id AS STRING)) AS skey FROM ev WHERE session_id IS NOT NULL) s
LEFT JOIN sess_src   a  USING (skey)
LEFT JOIN land       l  USING (skey)
LEFT JOIN items_agg  i  USING (skey)
LEFT JOIN events_agg ea USING (skey)
LEFT JOIN pages_agg  pa USING (skey)
GROUP BY s.skey, a.source, a.medium, a.campaign, a.campaign_id,
         l.landing_page, l.landing_title, l.hostname;
