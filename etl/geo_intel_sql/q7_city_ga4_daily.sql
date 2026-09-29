-- City-level GA4 activity, DAY grain -- lets the dashboard's date-range filter actually
-- change Sessions/PDP/ATC/Checkout/Revenue for a city (and everything derived from a
-- city total, e.g. the Pin Code page's modelled columns), instead of always showing a
-- fixed full-window number no matter what window is selected.
--
-- Sourced from ga4_fact_sessions (the self-healing daily fact table), not the older
-- ga4_data.ga4_data mart -- same source family as q2's real distinct-user counts, so
-- Sessions*/Users* stay internally consistent instead of mixing two different systems'
-- idea of a "session".
--
-- Scoped down to control payload size (this is a static JSON shipped to every page
-- load, not a live query): the trailing 180-day window matches q3's own windowing
-- (nothing outside it is even selectable in the date picker), and cities are capped
-- to ones with >=500 lifetime sessions (~220 cities) -- the long tail of one-off towns
-- with a handful of sessions on a single day was 3x the row count for no analytical
-- value (nobody is filtering the date range down to see 4 sessions in a town with no
-- other data).
WITH bounds AS (SELECT MAX(session_date) AS max_d FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`),
qualifying_cities AS (
  SELECT city FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions`
  WHERE city IS NOT NULL AND city NOT IN ('(not set)','')
  GROUP BY city HAVING COUNT(*) >= 500
)
SELECT
  f.session_date AS d,
  f.city,
  COUNT(*)                AS sessions,
  SUM(f.ev_view_item)      AS pdp_views,
  SUM(f.ev_add_to_cart)    AS add_to_cart,
  SUM(f.ev_begin_checkout) AS begin_checkout,
  SUM(f.ev_purchase)       AS purchase,
  SUM(f.revenue)           AS revenue
FROM `lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions` f, bounds
JOIN qualifying_cities q ON q.city = f.city
WHERE f.session_date >= DATE_SUB(bounds.max_d, INTERVAL 179 DAY)
GROUP BY d, f.city
HAVING sessions >= 5
ORDER BY d, f.city;
