-- ═══════════════════════════════════════════════════════════════════════════
-- GA4 → BigQuery Dashboard :: 00_setup.sql
-- One-time setup: destination dataset, the GA4 default-channel-group UDF, and
-- the 6 pre-aggregated summary tables the dashboard reads from.
--
-- Source (raw GA4 export, sharded daily):  `lucirajewelry-prod.analytics_478308692_*`
-- Destination (cheap aggregates):          `lucirajewelry-prod.ga4_dashboard.*`
--
-- Cost model: the raw event tables are scanned ONCE per day by the incremental
-- refresh (10_..15_*.sql), which processes only the newest date partition. The
-- dashboard backend then reads ONLY these small, partitioned+clustered summary
-- tables — never the raw events — so per-load BigQuery cost is negligible.
--
-- Distinct users cannot be summed across days, so user/new-user counts are
-- stored as HLL++ sketches (BYTES). The read layer does HLL_COUNT.MERGE over a
-- date range to get an accurate distinct count for ANY window, while a plain
-- per-day `users` INT is kept for the daily trend line.
--
-- Run once (bq CLI):  bq query --use_legacy_sql=false < sql/00_setup.sql
-- Requires: BigQuery Data Editor on the destination dataset + Data Viewer on the
--           GA4 export dataset for whoever/whatever runs it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard`
OPTIONS (location = 'asia-south1');   -- match your GA4 export dataset's region

-- ───────────────────────────────────────────────────────────────────────────
-- GA4 "Default Channel Group" — the export has no channel column, so we derive
-- it with the same rules GA4 UI uses (documented at
-- support.google.com/analytics/answer/9756891). Session source/medium/campaign
-- are passed in; returns the channel label. Kept intentionally close to GA4's
-- published logic — validate against your property's Traffic-acquisition report
-- and tune the brand/paid rules if numbers diverge.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION `lucirajewelry-prod.ga4_dashboard.default_channel_group`(
  source STRING, medium STRING, campaign STRING
) RETURNS STRING AS (
  CASE
    WHEN (source IS NULL OR source = '' OR source = '(direct)')
     AND (medium IS NULL OR medium = '' OR medium IN ('(none)', '(not set)'))
      THEN 'Direct'
    WHEN REGEXP_CONTAINS(campaign, r'(?i)^(.*shop.*)$')
     AND REGEXP_CONTAINS(medium, r'(?i)^(.*cp.*|ppc|paid.*)$')
      THEN 'Paid Shopping'
    WHEN REGEXP_CONTAINS(source, r'(?i)(google|bing|yahoo|duckduckgo|ecosia)')
     AND REGEXP_CONTAINS(medium, r'(?i)^(.*cp.*|ppc|paid.*)$')
      THEN 'Paid Search'
    WHEN REGEXP_CONTAINS(source, r'(?i)(facebook|instagram|fb|ig|tiktok|twitter|x\.com|linkedin|pinterest|snapchat|reddit|whatsapp)')
     AND REGEXP_CONTAINS(medium, r'(?i)^(.*cp.*|ppc|paid.*|social.*paid)$')
      THEN 'Paid Social'
    WHEN REGEXP_CONTAINS(medium, r'(?i)^(display|banner|cpm|expandable|interstitial)$')
      THEN 'Display'
    WHEN REGEXP_CONTAINS(medium, r'(?i)^(.*cp.*|ppc|paid.*|retargeting)$')
      THEN 'Paid Other'
    WHEN REGEXP_CONTAINS(source, r'(?i)(google|bing|yahoo|duckduckgo|ecosia|baidu|yandex)')
     AND REGEXP_CONTAINS(medium, r'(?i)^organic$')
      THEN 'Organic Search'
    WHEN REGEXP_CONTAINS(source, r'(?i)(facebook|instagram|fb|ig|tiktok|twitter|x\.com|linkedin|pinterest|snapchat|reddit|whatsapp|youtube)')
      OR REGEXP_CONTAINS(medium, r'(?i)^(social|social-network|social-media|sm|social network|social media)$')
      THEN 'Organic Social'
    WHEN REGEXP_CONTAINS(medium, r'(?i)^(email|e-mail|e_mail|newsletter)$')
      OR REGEXP_CONTAINS(source, r'(?i)(email|newsletter|klaviyo|mailchimp)')
      THEN 'Email'
    WHEN REGEXP_CONTAINS(medium, r'(?i)^(affiliate|affiliates)$')
      THEN 'Affiliates'
    WHEN REGEXP_CONTAINS(medium, r'(?i)(referral)')
      THEN 'Referral'
    WHEN REGEXP_CONTAINS(medium, r'(?i)^(video)$')
      OR REGEXP_CONTAINS(source, r'(?i)(youtube|vimeo)')
      THEN 'Organic Video'
    WHEN REGEXP_CONTAINS(medium, r'(?i)^(sms|mms|push|mobile|notification)$')
      THEN 'Mobile Push / SMS'
    WHEN source IS NOT NULL AND source <> '' AND (medium IS NULL OR medium = '' OR medium IN ('(none)', '(not set)'))
      THEN 'Referral'
    ELSE 'Unassigned'
  END
);

-- ───────────────────────────────────────────────────────────────────────────
-- Summary tables. All PARTITION BY event_date so the incremental refresh and
-- the ranged reads only touch the needed partitions. CLUSTER BY the columns the
-- dashboard filters/orders on most.
-- ───────────────────────────────────────────────────────────────────────────

-- 1) Daily totals (1 row per day) — powers Overview KPIs, the funnel, and the
--    daily trend. Additive columns SUM cleanly; distinct users come from the
--    HLL sketches for range-accurate totals, plus a per-day `users` for trends.
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_daily_summary` (
  event_date        DATE    NOT NULL,
  users             INT64,          -- distinct users THIS day (for the daily line)
  new_users         INT64,
  users_hll         BYTES,          -- HLL++ sketch of user_pseudo_id (range merge)
  new_users_hll     BYTES,
  sessions          INT64,
  engaged_sessions  INT64,
  avg_engagement_time_sec FLOAT64,  -- userEngagementDuration / activeUsers
  page_views        INT64,
  event_count       INT64,
  -- funnel-stage event counts (Overview + Live Funnel)
  ev_view_item      INT64,
  ev_add_to_cart    INT64,
  ev_begin_checkout INT64,
  ev_add_shipping   INT64,
  ev_add_payment    INT64,
  ev_purchase       INT64,
  key_events        INT64,          -- conversions / key events
  transactions      INT64,
  items_purchased   INT64,
  refunds           INT64,
  revenue           FLOAT64,
  refund_value      FLOAT64
)
PARTITION BY event_date;

-- 2) Traffic / campaign grain (date × channel × source × medium × campaign) —
--    serves Channels, Sources, Mediums, Source/Medium, Campaigns, Traffic tab.
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_campaign_summary` (
  event_date        DATE    NOT NULL,
  channel           STRING,
  source            STRING,
  medium            STRING,
  campaign          STRING,
  campaign_id       STRING,
  users_hll         BYTES,
  new_users_hll     BYTES,
  sessions          INT64,
  engaged_sessions  INT64,
  page_views        INT64,
  event_count       INT64,
  key_events        INT64,
  add_to_carts      INT64,
  checkouts         INT64,
  transactions      INT64,
  items_purchased   INT64,
  revenue           FLOAT64
)
PARTITION BY event_date
CLUSTER BY channel, source, medium;

-- 3) Landing / all-pages grain (date × page_path). is_landing flags the session
--    entrance page so the same table serves BOTH the Landing Pages view
--    (WHERE is_landing) and the Pages view (all rows).
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_landing_summary` (
  event_date        DATE    NOT NULL,
  page_path         STRING,
  page_title        STRING,
  is_landing        BOOL,
  users_hll         BYTES,
  sessions          INT64,          -- sessions that entered here (landing) / had this page
  engaged_sessions  INT64,
  entrances         INT64,
  page_views        INT64,
  bounces           INT64,          -- landing sessions that were NOT engaged
  user_engagement_sec FLOAT64,
  key_events        INT64,
  transactions      INT64,
  revenue           FLOAT64
)
PARTITION BY event_date
CLUSTER BY page_path;

-- 4) SKU grain (date × item_id) — item-level funnel + SKU table.
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_sku_summary` (
  event_date        DATE    NOT NULL,
  item_id           STRING,
  item_name         STRING,
  item_brand        STRING,
  item_category     STRING,
  item_views        INT64,          -- view_item item rows
  items_added       INT64,          -- add_to_cart item rows
  items_checkout    INT64,          -- begin_checkout item rows
  items_purchased   INT64,          -- purchase item quantity
  purchases         INT64,          -- distinct purchase events containing this SKU
  item_revenue      FLOAT64,
  refunds           INT64,
  refund_value      FLOAT64
)
PARTITION BY event_date
CLUSTER BY item_id;

-- 5) Product grain (date × item_name × category × brand) — higher-level product
--    rollup for contribution %, category/brand analysis (spec lists it distinct
--    from SKU; SKU = item_id grain, Product = name/category/brand grain).
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_product_summary` (
  event_date        DATE    NOT NULL,
  item_name         STRING,
  item_category     STRING,
  item_brand        STRING,
  item_views        INT64,
  items_added       INT64,
  items_checkout    INT64,
  items_purchased   INT64,
  item_revenue      FLOAT64
)
PARTITION BY event_date
CLUSTER BY item_category, item_name;

-- 6) Audience breakdown — a TALL table: one row per (date, dim, value) across
--    every single-dimension breakdown the dashboard needs (device, browser, os,
--    screenRes, platform, country, region, city, language, hostname,
--    newReturning, event, contentGroup). Low cardinality per dim, trivial to
--    read (WHERE dim='city'), and avoids a combinatorial wide table.
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_audience_summary` (
  event_date        DATE    NOT NULL,
  dim               STRING  NOT NULL,   -- which breakdown this row belongs to
  value             STRING,             -- the dimension value
  users_hll         BYTES,
  new_users_hll     BYTES,
  sessions          INT64,
  engaged_sessions  INT64,
  page_views        INT64,
  event_count       INT64,
  key_events        INT64,
  transactions      INT64,
  items_purchased   INT64,
  revenue           FLOAT64
)
PARTITION BY event_date
CLUSTER BY dim, value;

-- 7) AI report history — the daily Gemini report is stored here so the dashboard
--    can show "latest" and keep an audit trail (spec: "save report history").
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ga4_dashboard.ga4_ai_reports` (
  generated_at      TIMESTAMP NOT NULL,
  report_date       DATE,
  model             STRING,
  scope             STRING,            -- e.g. 'daily' | 'adhoc'
  report_json       JSON,              -- structured sections (summary, winners, risks, actions…)
  report_md         STRING             -- rendered markdown for direct display
)
PARTITION BY report_date;
