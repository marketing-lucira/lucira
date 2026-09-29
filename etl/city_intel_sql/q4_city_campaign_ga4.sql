-- Query 4 — city x campaign (source/medium/campaign_name/channel_type), last 90 days.
-- Feeds Campaign Analysis + Marketing ROI pages. GA4 export has NO cost data, so
-- ROAS/CPA/CPC/CTR are flagged in the dashboard as modelled, not measured spend.
WITH win AS (
  SELECT *
  FROM `lucirajewelry-prod.ga4_data.ga4_data`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
),
sesskey AS (
  SELECT
    event_date, city, source, medium, campaign_name, channel_type,
    MAX(sessions) AS sess,
    SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
    SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase, SUM(revenue) AS revenue
  FROM win
  GROUP BY event_date, city, source, medium, campaign_name, channel_type
)
SELECT
  city, source, medium, IFNULL(campaign_name,'(not set)') AS campaign_name, channel_type,
  SUM(sess) AS sessions, SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
  SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase, ROUND(SUM(revenue),2) AS revenue
FROM sesskey
GROUP BY city, source, medium, campaign_name, channel_type
HAVING SUM(sess) >= 30
ORDER BY sessions DESC
LIMIT 4000;
