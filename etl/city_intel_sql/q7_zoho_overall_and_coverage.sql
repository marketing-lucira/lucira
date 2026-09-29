-- Query 7 — Zoho Deals: overall totals (ALL rows), city-coverage %, daily trend,
-- stage funnel, lead-source & UTM breakdowns. Run as 4 separate result sets (bq
-- only returns one result per query, so the build script issues these as 4 queries).

-- 7a: overall totals + coverage
SELECT
  COUNT(*) AS deals_total,
  COUNTIF(Address_City IS NOT NULL AND TRIM(Address_City) != '') AS deals_with_city,
  COUNTIF(Stage = 'Closed Won') AS won_total,
  COUNTIF(Stage = 'Closed Won' AND Address_City IS NOT NULL AND TRIM(Address_City) != '') AS won_with_city,
  ROUND(SUM(Amount),2) AS amount_total,
  ROUND(SUM(IF(Address_City IS NOT NULL AND TRIM(Address_City) != '', Amount, 0)),2) AS amount_with_city,
  MIN(Creat_time) AS min_date, MAX(Creat_time) AS max_date
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`;

-- 7b: daily trend (all rows, city-agnostic — deals happen regardless of address capture)
SELECT DATE(Creat_time) AS d, COUNT(*) AS deals, ROUND(SUM(Amount),2) AS amount,
       COUNTIF(Stage='Closed Won') AS won, COUNTIF(Stage='Closed Lost') AS lost
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
WHERE Creat_time IS NOT NULL
GROUP BY d ORDER BY d;

-- 7c: stage funnel
SELECT Stage AS stage, COUNT(*) AS n, ROUND(SUM(Amount),2) AS amount
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
GROUP BY stage ORDER BY n DESC;

-- 7d: lead source breakdown (top 20)
SELECT IFNULL(Lead_Source,'(blank)') AS lead_source, COUNT(*) AS n,
       COUNTIF(Stage='Closed Won') AS won, ROUND(SUM(Amount),2) AS amount
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
GROUP BY lead_source ORDER BY n DESC LIMIT 20;
