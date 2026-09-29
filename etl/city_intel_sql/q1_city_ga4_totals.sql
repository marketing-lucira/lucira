-- City Intelligence & Market Expansion — Query 1
-- One row per city, full 400-day GA4 window. Dedups the session fan-out via a
-- session-key (event_date, source, medium, campaign_name, channel_type, city, state)
-- before summing, per the mart's known replication pattern (see MART-README.md).
WITH win AS (
  SELECT *
  FROM `lucirajewelry-prod.ga4_data.ga4_data`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 400 DAY)
),
sesskey AS (
  SELECT
    event_date, city, state,
    source, medium, campaign_name, channel_type,
    MAX(sessions) AS sess,
    SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
    SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase,
    SUM(revenue) AS revenue, SUM(plp_impressions) AS plp_impressions,
    SUM(plp_click) AS plp_click, SUM(remove_from_cart) AS remove_from_cart,
    SUM(add_to_wishlist) AS add_to_wishlist, SUM(add_shipping_info) AS add_shipping_info
  FROM win
  GROUP BY event_date, city, state, source, medium, campaign_name, channel_type
),
city_full AS (
  SELECT
    city, ANY_VALUE(state) AS state,
    SUM(sess) AS sessions, SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
    SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase, SUM(revenue) AS revenue,
    SUM(plp_impressions) AS plp_impressions, SUM(plp_click) AS plp_click,
    SUM(remove_from_cart) AS remove_from_cart, SUM(add_to_wishlist) AS add_to_wishlist,
    SUM(add_shipping_info) AS add_shipping_info,
    COUNT(DISTINCT CONCAT(source,'|',medium,'|',campaign_name)) AS campaign_count,
    COUNT(DISTINCT source) AS source_count
  FROM sesskey
  GROUP BY city
),
prev90 AS (
  SELECT city, SUM(sess) AS sessions_prev90, SUM(revenue) AS revenue_prev90
  FROM sesskey
  WHERE event_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 91 DAY)
  GROUP BY city
),
last90 AS (
  SELECT city, SUM(sess) AS sessions_last90, SUM(revenue) AS revenue_last90
  FROM sesskey
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  GROUP BY city
)
SELECT
  f.city, f.state, f.sessions, f.pdp_views, f.add_to_cart, f.begin_checkout, f.purchase,
  ROUND(f.revenue,2) AS revenue, f.plp_impressions, f.plp_click, f.remove_from_cart,
  f.add_to_wishlist, f.add_shipping_info, f.campaign_count, f.source_count,
  IFNULL(l.sessions_last90,0) AS sessions_last90, ROUND(IFNULL(l.revenue_last90,0),2) AS revenue_last90,
  IFNULL(p.sessions_prev90,0) AS sessions_prev90, ROUND(IFNULL(p.revenue_prev90,0),2) AS revenue_prev90
FROM city_full f
LEFT JOIN prev90 p USING(city)
LEFT JOIN last90 l USING(city)
WHERE f.sessions >= 200
ORDER BY f.sessions DESC
LIMIT 80;
