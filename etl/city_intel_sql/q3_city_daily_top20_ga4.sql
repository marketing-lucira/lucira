-- Query 3 — daily trend for the top 20 cities only (by full-window sessions), full 400-day window.
-- Keeps payload bounded: 20 cities x ~400 days ≈ 8,000 rows.
WITH win AS (
  SELECT *
  FROM `lucirajewelry-prod.ga4_data.ga4_data`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 400 DAY)
),
sesskey AS (
  SELECT
    event_date, city, source, medium, campaign_name, channel_type,
    MAX(sessions) AS sess,
    SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
    SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase, SUM(revenue) AS revenue
  FROM win
  GROUP BY event_date, city, source, medium, campaign_name, channel_type
),
top20 AS (
  SELECT city FROM sesskey GROUP BY city ORDER BY SUM(sess) DESC LIMIT 20
)
SELECT
  s.event_date, s.city,
  SUM(s.sess) AS sessions, SUM(s.pdp_views) AS pdp_views, SUM(s.add_to_cart) AS add_to_cart,
  SUM(s.begin_checkout) AS begin_checkout, SUM(s.purchase) AS purchase, ROUND(SUM(s.revenue),2) AS revenue
FROM sesskey s
WHERE s.city IN (SELECT city FROM top20)
GROUP BY s.event_date, s.city
ORDER BY s.event_date, s.city;
