SELECT Stage AS stage, COUNT(*) AS n, ROUND(SUM(Amount),2) AS amount
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
GROUP BY stage ORDER BY n DESC;
