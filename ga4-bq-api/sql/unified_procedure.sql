-- ═══════════════════════════════════════════════════════════════════════════
-- ga4_unified_refresh_and_snapshot()  —  daily automation for the UNIFIED GA4 dashboard.
-- One statement a Scheduled Query can call. It:
--   (1) rebuilds the partitioned mart mirror ga4_data.ga4_data_part from ga4_data.ga4_data, and
--   (2) EXPORTs the unified snapshot JSON { session:{…}, mart:{…} } to GCS.
-- The session model reads ga4_dashboard.ga4_fact_sessions, which is kept current by the
-- SEPARATE existing "GA4 fact_sessions daily" scheduled query (runs just before this one).
--
-- Create/refresh:
--   bq --location=asia-south1 query --use_legacy_sql=false < unified_procedure.sql
-- Schedule daily ~09:05 IST (03:35 UTC):
--   CALL `lucirajewelry-prod.ga4_dashboard.ga4_unified_refresh_and_snapshot`();
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE PROCEDURE `lucirajewelry-prod.ga4_dashboard.ga4_unified_refresh_and_snapshot`()
BEGIN
  DECLARE sd_to   DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
  DECLARE sd_from DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 200 DAY);
  DECLARE md_to   DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 1 DAY);
  DECLARE md_from DATE DEFAULT DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 90 DAY);

  -- (1) rebuild the partitioned+clustered mart mirror (source mart is not partitioned).
  CREATE OR REPLACE TABLE `lucirajewelry-prod.ga4_data.ga4_data_part`
  PARTITION BY event_date CLUSTER BY channel_type, item_id AS
  SELECT * FROM `lucirajewelry-prod.ga4_data.ga4_data`;

  -- (2) export the unified snapshot (session-grain + mart, namespaced).
  EXPORT DATA OPTIONS(
    uri='gs://lucirajewelry-prod-dashboards/ga4/unified-latest-*.json',
    format='JSON', overwrite=true
  ) AS
  WITH
    f AS (
      SELECT * FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
      WHERE session_date BETWEEN sd_from AND sd_to
    ),
    base AS (
      SELECT * FROM `lucirajewelry-prod.ga4_data.ga4_data_part`
      WHERE event_date BETWEEN md_from AND md_to
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
    mdaily AS (
      SELECT i.event_date, COALESCE(s.sessions,0) AS sessions,
        i.plp_impr, i.plp_click, i.pdp_views, i.add_to_cart, i.remove_from_cart,
        i.add_to_wishlist, i.begin_checkout, i.add_shipping_info, i.purchase, i.revenue
      FROM item_daily i LEFT JOIN sess_daily s USING (event_date)
    )
  SELECT
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', CURRENT_TIMESTAMP()) AS generated_at,
    'unified:ga4_fact_sessions+ga4_data_part' AS source,
    'INR' AS currency,
    STRUCT(CAST(sd_from AS STRING) AS `from`, CAST(sd_to AS STRING) AS `to`) AS `window`,

    (SELECT AS STRUCT
      STRUCT(CAST(sd_from AS STRING) AS `from`, CAST(sd_to AS STRING) AS `to`) AS `window`,
      (SELECT AS STRUCT
         COUNT(*) AS sessions, COUNT(DISTINCT user_pseudo_id) AS users,
         COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers,
         COUNT(DISTINCT user_pseudo_id) AS activeUsers, SUM(page_views) AS pageViews,
         COUNTIF(engaged) AS engagedSessions, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents,
         ROUND(SUM(revenue),2) AS revenue,
         ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate,
         ROUND(SAFE_DIVIDE(SUM(engagement_time_sec),COUNT(DISTINCT user_pseudo_id)),2) AS avgSessionDur,
         ROUND(SAFE_DIVIDE(SUM(engagement_time_sec),COUNT(DISTINCT user_pseudo_id)),2) AS avgEngTime,
         SUM(transactions) AS purchases, SUM(items_qty) AS itemsPurchased,
         SUM(ev_add_to_cart) AS addToCarts, SUM(ev_begin_checkout) AS checkouts
       FROM f) AS totals,
      ARRAY(SELECT AS STRUCT CAST(session_date AS STRING) AS date, COUNT(*) AS sessions,
         COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers,
         COUNT(DISTINCT user_pseudo_id) AS activeUsers, SUM(page_views) AS pageViews,
         COUNTIF(engaged) AS engagedSessions, SUM(event_count) AS eventCount,
         SUM(ev_purchase) AS purchases, SUM(key_events) AS keyEvents, ROUND(SUM(revenue),2) AS revenue
       FROM f GROUP BY session_date ORDER BY session_date) AS daily,
      [ STRUCT('view_item' AS name, (SELECT SUM(ev_view_item) FROM f) AS count),
        STRUCT('add_to_cart', (SELECT SUM(ev_add_to_cart) FROM f)),
        STRUCT('begin_checkout', (SELECT SUM(ev_begin_checkout) FROM f)),
        STRUCT('add_payment_info', (SELECT SUM(ev_add_payment) FROM f)),
        STRUCT('purchase', (SELECT SUM(ev_purchase) FROM f)) ] AS funnel,
      ARRAY(SELECT AS STRUCT channel AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 20) AS channels,
      ARRAY(SELECT AS STRUCT CONCAT(source,' / ',medium) AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 30) AS sourceMedium,
      ARRAY(SELECT AS STRUCT source AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 30) AS sources,
      ARRAY(SELECT AS STRUCT medium AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 20) AS mediums,
      ARRAY(SELECT AS STRUCT campaign AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 30) AS campaigns,
      ARRAY(SELECT AS STRUCT landing_page AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 30) AS landingPages,
      ARRAY(SELECT AS STRUCT device_category AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 10) AS devices,
      ARRAY(SELECT AS STRUCT browser AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 15) AS browsers,
      ARRAY(SELECT AS STRUCT operating_system AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 15) AS operatingSystems,
      ARRAY(SELECT AS STRUCT platform AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 10) AS platforms,
      ARRAY(SELECT AS STRUCT country AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 25) AS countries,
      ARRAY(SELECT AS STRUCT region AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 25) AS regions,
      ARRAY(SELECT AS STRUCT city AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 30) AS cities,
      ARRAY(SELECT AS STRUCT language AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 20) AS languages,
      ARRAY(SELECT AS STRUCT hostname AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 10) AS hostnames,
      ARRAY(SELECT AS STRUCT IF(is_new_user,'new','returning') AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 5) AS newReturning,
      ARRAY(SELECT AS STRUCT content_group AS name, COUNT(DISTINCT user_pseudo_id) AS users, COUNT(DISTINCT IF(is_new_user,user_pseudo_id,NULL)) AS newUsers, COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions, ROUND(SAFE_DIVIDE(COUNTIF(engaged),COUNT(*))*100,2) AS engagementRate, SUM(page_views) AS views, SUM(event_count) AS eventCount, SUM(key_events) AS keyEvents, SUM(transactions) AS purchases, SUM(items_qty) AS items, ROUND(SUM(revenue),2) AS revenue FROM f GROUP BY name ORDER BY sessions DESC LIMIT 15) AS contentGroups,
      ARRAY(SELECT AS STRUCT p.page_path AS path, ANY_VALUE(p.page_title) AS title, SUM(p.views) AS views, COUNT(DISTINCT user_pseudo_id) AS users FROM f, UNNEST(pages) p GROUP BY path ORDER BY views DESC LIMIT 30) AS pages,
      ARRAY(SELECT AS STRUCT e.event_name AS name, SUM(e.cnt) AS count, COUNT(DISTINCT user_pseudo_id) AS users FROM f, UNNEST(events) e GROUP BY name ORDER BY count DESC LIMIT 30) AS events,
      ARRAY(SELECT AS STRUCT it.item_name AS name, ANY_VALUE(it.item_category) AS category, ANY_VALUE(it.item_brand) AS brand, SUM(IF(it.event_name='purchase',it.quantity,0)) AS items, ROUND(SUM(IF(it.event_name='purchase',it.item_revenue,0)),2) AS revenue, COUNTIF(it.event_name='view_item') AS views, COUNTIF(it.event_name='add_to_cart') AS addToCart FROM f, UNNEST(items) it GROUP BY name ORDER BY views DESC LIMIT 30) AS items
    ) AS session,

    (SELECT AS STRUCT
      STRUCT(CAST(md_from AS STRING) AS `from`, CAST(md_to AS STRING) AS `to`, 90 AS days) AS `window`,
      'sessions are de-duplicated per traffic group (attributed sessions, est.); item metrics are exact sums' AS notes,
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
       FROM mdaily) AS totals,
      ARRAY(SELECT AS STRUCT CAST(event_date AS STRING) AS date, sessions, plp_impr AS plpImpressions,
         plp_click AS plpClicks, pdp_views AS pdpViews, add_to_cart AS addToCart, begin_checkout AS beginCheckout,
         add_shipping_info AS addShippingInfo, purchase AS purchases, revenue
         FROM mdaily ORDER BY event_date) AS daily,
      [ STRUCT('plp_impressions' AS name, (SELECT SUM(plp_impr) FROM mdaily) AS count),
        STRUCT('plp_click',       (SELECT SUM(plp_click) FROM mdaily)),
        STRUCT('pdp_views',       (SELECT SUM(pdp_views) FROM mdaily)),
        STRUCT('add_to_cart',     (SELECT SUM(add_to_cart) FROM mdaily)),
        STRUCT('begin_checkout',  (SELECT SUM(begin_checkout) FROM mdaily)),
        STRUCT('add_shipping_info',(SELECT SUM(add_shipping_info) FROM mdaily)),
        STRUCT('purchase',        (SELECT SUM(purchase) FROM mdaily)) ] AS funnel,
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
         ORDER BY revenue DESC, pdpViews DESC LIMIT 100) AS products
    ) AS mart;
END;
