-- ═══════════════════════════════════════════════════════════════════════════
-- mart_refresh_and_snapshot()  —  daily automation for the mart dashboard.
-- Wraps BOTH steps so a Scheduled Query can call it with one short statement:
--   (1) rebuild the partitioned mirror ga4_data_part from the source mart, and
--   (2) EXPORT the dashboard snapshot JSON to GCS.
-- Create/refresh this procedure by piping this file to bq (stdin), then schedule
--   CALL `lucirajewelry-prod.ga4_data.mart_refresh_and_snapshot`();
-- daily at ~09:00 IST (03:30 UTC).  See MART-README.md.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE PROCEDURE `lucirajewelry-prod.ga4_data.mart_refresh_and_snapshot`()
BEGIN
  DECLARE window_days INT64 DEFAULT 90;
  DECLARE d_to   DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
  DECLARE d_from DATE DEFAULT DATE_SUB(DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY), INTERVAL 89 DAY);

  -- (1) refresh the partitioned+clustered mirror (source mart is not partitioned).
  -- Full rebuild; ~16.6GB scan/day, within BigQuery's 1TB/mo on-demand free tier.
  CREATE OR REPLACE TABLE `lucirajewelry-prod.ga4_data.ga4_data_part`
  PARTITION BY event_date CLUSTER BY channel_type, item_id AS
  SELECT * FROM `lucirajewelry-prod.ga4_data.ga4_data`;

  -- (2) export the dashboard snapshot (reads only the 90-day window of the mirror).
  EXPORT DATA OPTIONS(
    uri='gs://lucirajewelry-prod-dashboards/ga4/mart-latest-*.json',
    format='JSON', overwrite=true
  ) AS
  WITH
  base AS (
    SELECT * FROM `lucirajewelry-prod.ga4_data.ga4_data_part`
    WHERE event_date BETWEEN d_from AND d_to
  ),
  tg AS (
    SELECT event_date, source, medium, campaign_name, channel_type, country, state, city,
           MAX(sessions) AS sess
    FROM base GROUP BY 1,2,3,4,5,6,7,8
  ),
  sess_daily AS ( SELECT event_date, SUM(sess) AS sessions FROM tg GROUP BY 1 ),
  item_daily AS (
    SELECT event_date,
      SUM(plp_impressions) AS plp_impr, SUM(plp_click) AS plp_click, SUM(pdp_views) AS pdp_views,
      SUM(add_to_cart) AS add_to_cart, SUM(remove_from_cart) AS remove_from_cart,
      SUM(add_to_wishlist) AS add_to_wishlist, SUM(begin_checkout) AS begin_checkout,
      SUM(add_shipping_info) AS add_shipping_info, SUM(purchase) AS purchase,
      ROUND(SUM(revenue),2) AS revenue
    FROM base GROUP BY 1
  ),
  daily AS (
    SELECT i.event_date, COALESCE(s.sessions,0) AS sessions,
      i.plp_impr, i.plp_click, i.pdp_views, i.add_to_cart, i.remove_from_cart,
      i.add_to_wishlist, i.begin_checkout, i.add_shipping_info, i.purchase, i.revenue
    FROM item_daily i LEFT JOIN sess_daily s USING (event_date)
  )
  SELECT
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', CURRENT_TIMESTAMP()) AS generated_at,
    'bigquery_mart:ga4_data.ga4_data_part' AS source,
    'INR' AS currency,
    'sessions are de-duplicated per traffic group (attributed sessions, est.); item metrics are exact sums' AS notes,
    STRUCT(CAST(d_from AS STRING) AS `from`, CAST(d_to AS STRING) AS `to`, window_days AS days) AS `window`,
    (SELECT AS STRUCT
       (SELECT SUM(sess) FROM tg) AS sessions,
       SUM(plp_impr) AS plpImpressions, SUM(plp_click) AS plpClicks, SUM(pdp_views) AS pdpViews,
       SUM(add_to_cart) AS addToCart, SUM(remove_from_cart) AS removeFromCart,
       SUM(add_to_wishlist) AS addToWishlist, SUM(begin_checkout) AS beginCheckout,
       SUM(add_shipping_info) AS addShippingInfo, SUM(purchase) AS purchases,
       ROUND(SUM(revenue),2) AS revenue,
       ROUND(SAFE_DIVIDE(SUM(revenue),NULLIF(SUM(purchase),0)),2) AS aov,
       ROUND(SAFE_DIVIDE(SUM(purchase),NULLIF((SELECT SUM(sess) FROM tg),0))*100,3) AS convRate,
       ROUND(SAFE_DIVIDE(SUM(plp_click),NULLIF(SUM(plp_impr),0))*100,2) AS plpCtr,
       ROUND(SAFE_DIVIDE(SUM(add_to_cart),NULLIF(SUM(pdp_views),0))*100,2) AS pdpToCartRate,
       ROUND(SAFE_DIVIDE(SUM(purchase),NULLIF(SUM(begin_checkout),0))*100,2) AS checkoutToPurchaseRate
     FROM daily) AS totals,
    ARRAY(SELECT AS STRUCT CAST(event_date AS STRING) AS date, sessions, plp_impr AS plpImpressions,
       plp_click AS plpClicks, pdp_views AS pdpViews, add_to_cart AS addToCart, begin_checkout AS beginCheckout,
       add_shipping_info AS addShippingInfo, purchase AS purchases, revenue
       FROM daily ORDER BY event_date) AS daily,
    [ STRUCT('plp_impressions' AS name, (SELECT SUM(plp_impr) FROM daily) AS count),
      STRUCT('plp_click',       (SELECT SUM(plp_click) FROM daily)),
      STRUCT('pdp_views',       (SELECT SUM(pdp_views) FROM daily)),
      STRUCT('add_to_cart',     (SELECT SUM(add_to_cart) FROM daily)),
      STRUCT('begin_checkout',  (SELECT SUM(begin_checkout) FROM daily)),
      STRUCT('add_shipping_info',(SELECT SUM(add_shipping_info) FROM daily)),
      STRUCT('purchase',        (SELECT SUM(purchase) FROM daily)) ] AS funnel,
    ARRAY(SELECT AS STRUCT source AS name, SUM(sess) AS sessions FROM tg GROUP BY 1
          ORDER BY sessions DESC LIMIT 30) AS sources_sess,
    ARRAY(SELECT AS STRUCT COALESCE(source,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(begin_checkout) AS beginCheckout, SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC LIMIT 30) AS sources,
    ARRAY(SELECT AS STRUCT COALESCE(medium,'(none)') AS name, (SELECT SUM(t.sess) FROM tg t WHERE t.medium=b.medium) AS sessions,
          SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart, SUM(begin_checkout) AS beginCheckout,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base b GROUP BY medium ORDER BY revenue DESC LIMIT 37) AS mediums,
    ARRAY(SELECT AS STRUCT CONCAT(COALESCE(source,'(none)'),' / ',COALESCE(medium,'(none)')) AS name,
          SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart, SUM(begin_checkout) AS beginCheckout,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC LIMIT 30) AS sourceMedium,
    ARRAY(SELECT AS STRUCT COALESCE(campaign_name,'(none)') AS name, SUM(pdp_views) AS pdpViews,
          SUM(add_to_cart) AS addToCart, SUM(begin_checkout) AS beginCheckout, SUM(purchase) AS purchases,
          ROUND(SUM(revenue),2) AS revenue FROM base GROUP BY 1 ORDER BY revenue DESC LIMIT 30) AS campaigns,
    ARRAY(SELECT AS STRUCT COALESCE(channel_type,'(none)') AS name, SUM(sess) AS sessions FROM tg GROUP BY 1
          ORDER BY sessions DESC) AS channels,
    ARRAY(SELECT AS STRUCT COALESCE(country,'(none)') AS name, SUM(pdp_views) AS pdpViews,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue FROM base GROUP BY 1
          ORDER BY revenue DESC LIMIT 40) AS countries,
    ARRAY(SELECT AS STRUCT COALESCE(state,'(none)') AS name, SUM(pdp_views) AS pdpViews,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue FROM base GROUP BY 1
          ORDER BY revenue DESC LIMIT 30) AS states,
    ARRAY(SELECT AS STRUCT COALESCE(city,'(none)') AS name, SUM(pdp_views) AS pdpViews,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue FROM base GROUP BY 1
          ORDER BY revenue DESC LIMIT 40) AS cities,
    ARRAY(SELECT AS STRUCT COALESCE(category,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(begin_checkout) AS beginCheckout, SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC) AS devices,
    ARRAY(SELECT AS STRUCT COALESCE(gender,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC) AS genders,
    ARRAY(SELECT AS STRUCT COALESCE(material_type,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC LIMIT 15) AS materials,
    ARRAY(SELECT AS STRUCT COALESCE(product_type,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(begin_checkout) AS beginCheckout, SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC) AS productTypes,
    ARRAY(SELECT AS STRUCT COALESCE(collection,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(begin_checkout) AS beginCheckout, SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC) AS collections,
    ARRAY(SELECT AS STRUCT COALESCE(price_range,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart,
          SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
          FROM base GROUP BY 1 ORDER BY revenue DESC) AS priceRanges,
    ARRAY(SELECT AS STRUCT COALESCE(margin_range,'(none)') AS name, SUM(pdp_views) AS pdpViews, SUM(purchase) AS purchases,
          ROUND(SUM(revenue),2) AS revenue, ROUND(AVG(product_margin),3) AS avgMargin
          FROM base GROUP BY 1 ORDER BY revenue DESC) AS marginRanges,
    ARRAY(SELECT AS STRUCT
       item_id AS itemId, ANY_VALUE(product_title) AS title, ANY_VALUE(sku) AS sku,
       ANY_VALUE(category) AS category, ANY_VALUE(collection) AS collection, ANY_VALUE(product_type) AS productType,
       ANY_VALUE(price_range) AS priceRange, ROUND(ANY_VALUE(price),0) AS price,
       ROUND(ANY_VALUE(product_margin),3) AS margin, ANY_VALUE(margin_range) AS marginRange,
       ANY_VALUE(ageing) AS ageing, ROUND(ANY_VALUE(g2d_ratio),2) AS g2dRatio, ROUND(ANY_VALUE(final_cogs),0) AS cogs,
       ANY_VALUE(first_image) AS image,
       SUM(pdp_views) AS pdpViews, SUM(add_to_cart) AS addToCart, SUM(begin_checkout) AS beginCheckout,
       SUM(purchase) AS purchases, ROUND(SUM(revenue),2) AS revenue
       FROM base WHERE item_id IS NOT NULL GROUP BY item_id
       ORDER BY revenue DESC, pdpViews DESC LIMIT 100) AS products;
END;
