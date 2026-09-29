-- Query 8 — city x device (the `category` field is device_category, per prior mart
-- inspection — NOT product category), last 90 days, deduped sessions.
WITH win AS (
  SELECT * FROM `lucirajewelry-prod.ga4_data.ga4_data`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
),
sesskey AS (
  SELECT event_date, city, category AS device, source, medium, campaign_name, channel_type,
         MAX(sessions) AS sess, SUM(purchase) AS purchase, SUM(revenue) AS revenue,
         SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart
  FROM win
  GROUP BY event_date, city, device, source, medium, campaign_name, channel_type
)
SELECT city, IFNULL(device,'(unknown)') AS device,
       SUM(sess) AS sessions, SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
       SUM(purchase) AS purchase, ROUND(SUM(revenue),2) AS revenue
FROM sesskey
GROUP BY city, device
HAVING sessions >= 20
ORDER BY sessions DESC
LIMIT 1500;
