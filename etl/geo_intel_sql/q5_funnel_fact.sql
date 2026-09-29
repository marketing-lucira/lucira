-- User Journey funnel, national, real session-grain event counts (sessions reaching each step).
SELECT
  COUNT(DISTINCT user_pseudo_id)                    AS users,
  COUNT(*)                                          AS sessions,
  COUNTIF(ev_view_item > 0)                         AS sessions_view_item,
  COUNTIF(ev_add_to_cart > 0)                       AS sessions_add_to_cart,
  COUNTIF(ev_begin_checkout > 0)                    AS sessions_checkout,
  COUNTIF(ev_add_payment > 0)                       AS sessions_add_payment,
  COUNTIF(ev_purchase > 0)                          AS sessions_purchase,
  SUM(transactions)                                 AS purchases,
  SUM(revenue)                                      AS revenue
FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
WHERE session_date >= DATE_SUB((SELECT MAX(session_date) FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`), INTERVAL 89 DAY);
