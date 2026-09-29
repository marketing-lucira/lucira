-- Lucira Store Visit Campaign Intelligence — daily reporting-layer refresh.
-- Run as ONE BigQuery script (multi-statement, single job, atomic) by Cloud
-- Scheduler -> store-visit-snapshot /refresh, at 10:00 IST daily.
--
-- Rebuilds, in order:
--   1) store_visit_activity — every Webengage_Final row belonging to a campaign/journey
--      whose name identifies it as "Store Visit" activity, with per-channel
--      sent/delivered/opened/clicked normalized into single columns (each row is
--      already single-channel in the source table).
--   2) store_visit_targets — one row per distinct valid-mobile customer targeted by
--      that activity, with first-touch date and the campaigns/channels that reached them.
--   3) store_visit_deal_outcomes — every lucira_zoho_Deals record matched to a targeted
--      mobile number (PII masked in the SELECT itself — this table feeds a public snapshot).
--   4) store_visit_sale_outcomes — every sales_oneview_data (Shopify + POS) purchase record
--      matched to a targeted mobile number, with a data-quality "flagged" signal for
--      same-day zero-value duplicate-looking rows (PII masked in the SELECT itself).
--
-- This is the single canonical copy of this DDL — it is what actually runs in production.
-- Mirrors walkin-source-api/sql/refresh_reporting.sql layout.

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.store_visit_activity` AS
SELECT
  cuid,
  RIGHT(REGEXP_REPLACE(cuid, r'[^0-9]', ''), 10) AS mobile_number,
  campaign_name, journey_title, channel, event_date,
  CASE channel
    WHEN 'push_notification' THEN COALESCE(push_sent, 0)
    WHEN 'whatsapp'          THEN COALESCE(whatsapp_sent, 0)
    WHEN 'sms'               THEN COALESCE(sms_Sent, 0)
    WHEN 'email'             THEN COALESCE(email_Sent, 0)
    WHEN 'RCS'               THEN COALESCE(rcs_sent, 0)
    ELSE 0
  END AS sent,
  CASE channel
    WHEN 'push_notification' THEN COALESCE(push_Dlivered, 0)
    WHEN 'whatsapp'          THEN COALESCE(whatsapp_Delivered, 0)
    WHEN 'sms'               THEN COALESCE(sms_Dlivered, 0)
    WHEN 'email'             THEN COALESCE(email_delivered, 0)
    WHEN 'RCS'               THEN COALESCE(rcs_Delivered, 0)
    ELSE 0
  END AS delivered,
  -- "opened" is genuinely absent for SMS (WebEngage's schema has no open/read concept for it) —
  -- kept NULL rather than fabricated as 0, so the dashboard can render it as "—".
  CASE channel
    WHEN 'push_notification' THEN Unique_Impression
    WHEN 'whatsapp'          THEN whatsapp_read
    WHEN 'email'             THEN Unique_email_open
    WHEN 'RCS'               THEN rcs_read
    ELSE NULL
  END AS opened,
  CASE channel
    WHEN 'push_notification' THEN 'Impressions'
    WHEN 'whatsapp'          THEN 'Read'
    WHEN 'email'             THEN 'Opened'
    WHEN 'RCS'               THEN 'Read'
    ELSE NULL
  END AS opened_label,
  CASE channel
    WHEN 'push_notification' THEN COALESCE(Unique_push_click, 0)
    WHEN 'whatsapp'          THEN COALESCE(Unique_whatsapp_click, 0)
    WHEN 'sms'               THEN COALESCE(Unique_sms_click, 0)
    WHEN 'email'             THEN COALESCE(Unique_email_click, 0)
    WHEN 'RCS'               THEN COALESCE(Unique_RCS_Click, 0)
    ELSE 0
  END AS clicked
FROM `lucirajewelry-prod.Lucira_Prod.Webengage_Final`
WHERE (LOWER(campaign_name) LIKE '%store_visit%' OR LOWER(campaign_name) LIKE '%storevisit%')
   OR LOWER(journey_title) LIKE '%store visit%';

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.store_visit_targets` AS
SELECT
  mobile_number,
  MIN(event_date) AS first_touch_date,
  STRING_AGG(DISTINCT campaign_name, ', ' ORDER BY campaign_name) AS campaigns,
  STRING_AGG(DISTINCT channel, ', ' ORDER BY channel) AS channels_used
FROM `lucirajewelry-prod.ds_imputed_reporting.store_visit_activity`
WHERE REGEXP_CONTAINS(mobile_number, r'^[6-9][0-9]{9}$')
GROUP BY mobile_number;

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.store_visit_deal_outcomes` AS
SELECT
  CONCAT('••••••', SUBSTR(t.mobile_number, 7, 4)) AS mobile_masked,
  t.first_touch_date,
  t.campaigns,
  t.channels_used AS channels,
  d.Stage AS stage,
  d.Creat_time AS deal_created,
  d.Store_Assigned AS store_assigned,
  d.Address_City AS city,
  d.Lead_Source AS lead_source,
  DATE_DIFF(d.Creat_time, t.first_touch_date, DAY) AS days_touch_to_deal
FROM `lucirajewelry-prod.ds_imputed_reporting.store_visit_targets` t
JOIN `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals` d
  ON t.mobile_number = RIGHT(REGEXP_REPLACE(d.Mobile, r'[^0-9]', ''), 10)
WHERE d.Mobile IS NOT NULL
ORDER BY d.Creat_time DESC;

-- Internal-only flags table (kept unmasked — never exported to the public JSON
-- snapshot, only COUNTIF() aggregates are). Exists specifically so has_deal/
-- has_sale/has_both/has_either can be computed on the real mobile_number —
-- joining on mobile_masked (last-4-digits only) risks collisions between
-- different numbers sharing the same last 4 digits and silently inflates counts.
CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.store_visit_target_flags` AS
SELECT
  t.mobile_number,
  EXISTS(
    SELECT 1 FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals` d
    WHERE t.mobile_number = RIGHT(REGEXP_REPLACE(d.Mobile, r'[^0-9]', ''), 10)
  ) AS has_deal,
  EXISTS(
    SELECT 1 FROM `lucirajewelry-prod.Lucira_Prod.sales_oneview_data` s
    WHERE t.mobile_number = RIGHT(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), 10)
  ) AS has_sale
FROM `lucirajewelry-prod.ds_imputed_reporting.store_visit_targets` t;

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.store_visit_sale_outcomes` AS
WITH joined AS (
  SELECT
    CONCAT('••••••', SUBSTR(t.mobile_number, 7, 4)) AS mobile_masked,
    t.first_touch_date,
    t.campaigns,
    s.total_orders,
    s.ltv,
    s.aov,
    s.first_order_date,
    s.latest_order_date,
    s.city,
    s.state,
    DATE_DIFF(s.first_order_date, t.first_touch_date, DAY) AS days_touch_to_first_order
  FROM `lucirajewelry-prod.ds_imputed_reporting.store_visit_targets` t
  JOIN `lucirajewelry-prod.Lucira_Prod.sales_oneview_data` s
    ON t.mobile_number = RIGHT(REGEXP_REPLACE(s.Cus_mobile, r'[^0-9]', ''), 10)
  WHERE s.Cus_mobile IS NOT NULL
)
SELECT
  *,
  -- Data-quality flag, NOT a hardcoded date: catches any future batch of identical
  -- same-day zero-value "orders" across multiple customers, the same artifact found
  -- on 2026-06-05 at build time (7 rows) — never silently dropped, always surfaced.
  (ltv = 0 AND COUNT(*) OVER (PARTITION BY first_order_date, ltv) > 1) AS flagged
FROM joined
ORDER BY ltv DESC;
