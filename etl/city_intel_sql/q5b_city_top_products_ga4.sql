-- Query 5b — top 5 products by revenue per city, last 90 days.
WITH ranked AS (
  SELECT
    city, sku, product_title, product_type, price, price_range, margin_range,
    SUM(revenue) AS revenue, SUM(purchase) AS purchase, SUM(pdp_views) AS pdp_views,
    ROW_NUMBER() OVER (PARTITION BY city ORDER BY SUM(revenue) DESC) AS rn
  FROM `lucirajewelry-prod.ga4_data.ga4_data`
  WHERE event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND sku IS NOT NULL AND product_title IS NOT NULL
  GROUP BY city, sku, product_title, product_type, price, price_range, margin_range
)
SELECT city, sku, product_title, product_type, price, price_range, margin_range,
       ROUND(revenue,2) AS revenue, purchase, pdp_views
FROM ranked
WHERE rn <= 5 AND revenue > 0
ORDER BY city, rn;
