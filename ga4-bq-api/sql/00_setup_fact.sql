-- ═══════════════════════════════════════════════════════════════════════════
-- Create the SINGLE consolidated fact table (run once). It is the dashboard's
-- only data source; fact_sessions.sql (a daily Scheduled Query) fills it from
-- the GA4 export. One row = one session; items[] holds product/SKU detail.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard`
OPTIONS (location = 'asia-south1');   -- ⚠ match your GA4 export dataset's region

CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions` (
  session_date        DATE    NOT NULL,
  session_key         STRING  NOT NULL,   -- user_pseudo_id + '-' + ga_session_id
  user_pseudo_id      STRING,
  is_new_user         BOOL,
  engaged             BOOL,
  engagement_time_sec FLOAT64,
  page_views          INT64,
  event_count         INT64,
  -- acquisition (session-scoped)
  channel             STRING,
  source              STRING,
  medium              STRING,
  campaign            STRING,
  campaign_id         STRING,
  -- audience / tech / geo
  device_category     STRING,
  operating_system    STRING,
  browser             STRING,
  platform            STRING,
  language            STRING,
  country             STRING,
  region              STRING,
  city                STRING,
  -- pages
  landing_page        STRING,
  landing_title       STRING,
  hostname            STRING,
  content_group       STRING,
  -- funnel event counts (ATC / checkout / payment / purchase …)
  ev_view_item        INT64,
  ev_add_to_cart      INT64,
  ev_begin_checkout   INT64,
  ev_add_shipping     INT64,
  ev_add_payment      INT64,
  ev_purchase         INT64,
  ev_refund           INT64,
  key_events          INT64,
  -- commerce
  transactions        INT64,
  items_qty           INT64,
  revenue             FLOAT64,
  refund_value        FLOAT64,
  -- product/SKU detail for this session (UNNEST for item analytics)
  items ARRAY<STRUCT<
    item_id STRING, item_name STRING, item_brand STRING, item_category STRING,
    quantity INT64, item_revenue FLOAT64, event_name STRING >>,
  -- all events in the session (UNNEST for the Events tab / any event_name)
  events ARRAY<STRUCT< event_name STRING, cnt INT64 >>,
  -- all pages viewed in the session (UNNEST for the Pages tab)
  pages  ARRAY<STRUCT< page_path STRING, page_title STRING, views INT64 >>
)
PARTITION BY session_date
CLUSTER BY channel, country, device_category;

-- The default_channel_group() UDF used by fact_sessions.sql:
CREATE OR REPLACE FUNCTION `lucirajewelry-prod.ga4_dashboard.default_channel_group`(
  source STRING, medium STRING, campaign STRING
) RETURNS STRING AS (
  CASE
    WHEN (source IS NULL OR source='' OR source='(direct)') AND (medium IS NULL OR medium='' OR medium IN ('(none)','(not set)')) THEN 'Direct'
    WHEN REGEXP_CONTAINS(source,r'(?i)(google|bing|yahoo|duckduckgo|ecosia)') AND REGEXP_CONTAINS(medium,r'(?i)^(.*cp.*|ppc|paid.*)$') THEN 'Paid Search'
    WHEN REGEXP_CONTAINS(source,r'(?i)(facebook|instagram|fb|ig|tiktok|twitter|x\.com|linkedin|pinterest|snapchat)') AND REGEXP_CONTAINS(medium,r'(?i)^(.*cp.*|ppc|paid.*|social.*paid)$') THEN 'Paid Social'
    WHEN REGEXP_CONTAINS(medium,r'(?i)^(display|banner|cpm|interstitial)$') THEN 'Display'
    WHEN REGEXP_CONTAINS(medium,r'(?i)^(.*cp.*|ppc|paid.*|retargeting)$') THEN 'Paid Other'
    WHEN REGEXP_CONTAINS(source,r'(?i)(google|bing|yahoo|duckduckgo|ecosia|baidu|yandex)') AND REGEXP_CONTAINS(medium,r'(?i)^organic$') THEN 'Organic Search'
    WHEN REGEXP_CONTAINS(source,r'(?i)(facebook|instagram|fb|ig|tiktok|twitter|x\.com|linkedin|pinterest|snapchat|youtube|whatsapp)') OR REGEXP_CONTAINS(medium,r'(?i)^(social|social-network|social-media|sm)$') THEN 'Organic Social'
    WHEN REGEXP_CONTAINS(medium,r'(?i)^(email|e-mail|newsletter)$') OR REGEXP_CONTAINS(source,r'(?i)(email|newsletter|klaviyo|mailchimp)') THEN 'Email'
    WHEN REGEXP_CONTAINS(medium,r'(?i)^(affiliate|affiliates)$') THEN 'Affiliates'
    WHEN REGEXP_CONTAINS(medium,r'(?i)^(sms|mms|push|whatsapp)$') THEN 'SMS / Push'
    WHEN REGEXP_CONTAINS(medium,r'(?i)(referral)') OR (source IS NOT NULL AND source<>'' AND (medium IS NULL OR medium='' OR medium IN ('(none)','(not set)'))) THEN 'Referral'
    ELSE 'Unassigned'
  END
);
