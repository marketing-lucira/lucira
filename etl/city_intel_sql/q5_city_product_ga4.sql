-- Query 5 — city x product dimensions, last 90 days. Item-level metrics only
-- (pdp_views/add_to_cart/checkout/purchase/revenue/plp_*) — these are additive per
-- row and do NOT need session dedup (unlike `sessions`, which is intentionally omitted here).
SELECT
  city,
  IFNULL(product_type,'(unclassified)') AS product_type,
  IFNULL(collection,'(none)') AS collection,
  IFNULL(material_type,'(none)') AS material_type,
  IFNULL(gender,'(unisex)') AS gender,
  IFNULL(price_range,'(unknown)') AS price_range,
  IFNULL(margin_range,'(unknown)') AS margin_range,
  SUM(pdp_views) AS pdp_views, SUM(add_to_cart) AS add_to_cart,
  SUM(begin_checkout) AS begin_checkout, SUM(purchase) AS purchase,
  ROUND(SUM(revenue),2) AS revenue, SUM(plp_impressions) AS plp_impressions,
  SUM(plp_click) AS plp_click, SUM(add_to_wishlist) AS add_to_wishlist,
  ROUND(AVG(product_margin),4) AS avg_margin
FROM `lucirajewelry-prod.ga4_data.ga4_data`
WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
GROUP BY city, product_type, collection, material_type, gender, price_range, margin_range
HAVING pdp_views >= 10 OR revenue > 0
ORDER BY revenue DESC
LIMIT 6000;
