-- Session Analysis: source × medium × campaign × landing page, real session-grain metrics.
-- Bounce Rate / Exit Rate are NOT in this table (GA4 export has no bounce concept post-GA4;
-- exit rate would need page-sequence analysis this fact table doesn't carry) — omitted, not modelled.
SELECT
  source, medium, campaign, landing_page,
  COUNT(DISTINCT user_pseudo_id) AS users,
  COUNT(*)                        AS sessions,
  COUNTIF(engaged)                AS engaged_sessions,
  SUM(transactions)               AS purchases,
  SUM(revenue)                    AS revenue,
  ROUND(AVG(engagement_time_sec),1) AS avg_engagement_sec
FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
WHERE session_date >= DATE_SUB((SELECT MAX(session_date) FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`), INTERVAL 89 DAY)
GROUP BY source, medium, campaign, landing_page
HAVING sessions >= 15
ORDER BY sessions DESC
LIMIT 300;
