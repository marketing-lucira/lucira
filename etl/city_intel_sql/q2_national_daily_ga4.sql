-- Query 2 — national daily totals, full 400-day window (Executive Summary trend + predictions)
WITH win AS (
  SELECT *
  FROM `lucirajewelry-prod.ga4_data.ga4_data`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 400 DAY)
),
sesskey AS (
  SELECT
    event_date, city, state, source, medium, campaign_name, channel_type,
    MAX(sessions) AS sess,
    SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
    SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase, SUM(revenue) AS revenue
  FROM win
  GROUP BY event_date, city, state, source, medium, campaign_name, channel_type
)
SELECT
  event_date,
  SUM(sess) AS sessions, SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
  SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase, ROUND(SUM(revenue),2) AS revenue
FROM sesskey
GROUP BY event_date
ORDER BY event_date;
