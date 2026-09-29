-- National rollup from the SESSION-GRAIN fact table (real distinct users, not derivable from the
-- flat mart). Window = last 90 days available in ga4_fact_sessions.
SELECT
  COUNT(DISTINCT user_pseudo_id)                          AS users,
  COUNT(*)                                                 AS sessions,
  COUNTIF(engaged)                                         AS engaged_sessions,
  COUNT(DISTINCT IF(is_new_user, user_pseudo_id, NULL))    AS new_users,
  COUNT(DISTINCT IF(NOT is_new_user, user_pseudo_id, NULL)) AS returning_users_est,
  ROUND(AVG(engagement_time_sec), 1)                       AS avg_engagement_sec,
  SUM(revenue)                                             AS revenue,
  SUM(transactions)                                        AS purchases,
  MIN(session_date)                                        AS min_date,
  MAX(session_date)                                        AS max_date
FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
WHERE session_date >= DATE_SUB((SELECT MAX(session_date) FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`), INTERVAL 89 DAY);
