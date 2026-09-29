-- City-level REAL distinct users + new/returning split, from the session-grain fact table
-- (the flat ga4_data mart has no user_pseudo_id, so it cannot produce a true distinct-user count).
--
-- Day grain (session_date, city): lets the date-range filter actually change these
-- numbers instead of always showing a fixed 90-day total. The client re-aggregates
-- distinct users across whichever window is selected (distinct-user counts can't be
-- summed across days that were pre-aggregated server-side without double-counting
-- a user who visited on multiple days, so this must stay at day+city grain, not
-- collapsed further here).
--
-- Scoped down like q7_city_ga4_daily.sql (same rationale, same thresholds): trailing
-- 180-day window (matches q3's own windowing) and cities capped to >=500 lifetime
-- sessions, to keep this a reasonable static payload instead of every one-off town.
WITH bounds AS (SELECT MAX(session_date) AS max_d FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`),
qualifying_cities AS (
  SELECT city FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
  WHERE city IS NOT NULL AND city NOT IN ('(not set)','')
  GROUP BY city HAVING COUNT(*) >= 500
)
SELECT
  f.session_date AS d,
  f.city,
  COUNT(DISTINCT f.user_pseudo_id)                             AS users,
  COUNT(*)                                                      AS sessions,
  COUNTIF(f.engaged)                                            AS engaged_sessions,
  COUNT(DISTINCT IF(f.is_new_user, f.user_pseudo_id, NULL))     AS new_users,
  COUNT(DISTINCT IF(NOT f.is_new_user, f.user_pseudo_id, NULL)) AS returning_users_est,
  ROUND(AVG(f.engagement_time_sec), 1)                          AS avg_engagement_sec,
  SUM(f.revenue)                                                AS revenue,
  SUM(f.transactions)                                           AS purchases
FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions` f, bounds
JOIN qualifying_cities q ON q.city = f.city
WHERE f.session_date >= DATE_SUB(bounds.max_d, INTERVAL 179 DAY)
GROUP BY d, f.city
HAVING sessions >= 5
ORDER BY d, sessions DESC;
