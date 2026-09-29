-- National daily trend from the fact table, including the most recent available day
-- (used for "Today's Users" — labelled honestly as "most recent available day", since the GA4
-- export itself lags real-time by ~2 days; there is no same-day GA4 data to show).
SELECT
  session_date,
  COUNT(DISTINCT user_pseudo_id) AS users,
  COUNT(*)                        AS sessions,
  COUNTIF(engaged)                AS engaged_sessions,
  COUNT(DISTINCT IF(is_new_user, user_pseudo_id, NULL)) AS new_users,
  SUM(revenue)                    AS revenue,
  SUM(transactions)               AS purchases,
  SUM(ev_view_item)               AS pdp_views,
  SUM(ev_add_to_cart)             AS add_to_cart,
  SUM(ev_begin_checkout)          AS begin_checkout
FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
WHERE session_date >= DATE_SUB((SELECT MAX(session_date) FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`), INTERVAL 179 DAY)
GROUP BY session_date
ORDER BY session_date;
