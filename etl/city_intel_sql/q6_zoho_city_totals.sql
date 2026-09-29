-- Query 6 — Zoho Deals rolled up by Address_City, ONLY for rows where city is known.
-- Only ~16% of deals carry a city (see q7 for the coverage stat) — this is a real
-- data-quality gap, not a filter choice, and the dashboard must say so everywhere it uses this.
SELECT
  TRIM(Address_City) AS city,
  ANY_VALUE(TRIM(Address_State)) AS state,
  COUNT(*) AS deals,
  COUNTIF(Stage = 'Closed Won') AS won,
  COUNTIF(Stage = 'Closed Lost') AS lost,
  COUNTIF(Stage IN ('Prospect','Add to Cart','Checkout','Payment')) AS open_deals,
  ROUND(SUM(Amount),2) AS amount,
  ROUND(SUM(IF(Stage='Closed Won', Amount, 0)),2) AS won_amount,
  ROUND(AVG(Probability),1) AS avg_probability,
  ROUND(AVG(Deal_Score),1) AS avg_deal_score,
  APPROX_TOP_COUNT(Lead_Source, 1)[OFFSET(0)].value AS top_lead_source,
  APPROX_TOP_COUNT(UTM_Source, 1)[OFFSET(0)].value AS top_utm_source
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
WHERE Address_City IS NOT NULL AND TRIM(Address_City) != ''
GROUP BY city
ORDER BY deals DESC;
