SELECT IFNULL(Lead_Source,'(blank)') AS lead_source, COUNT(*) AS n,
       COUNTIF(Stage='Closed Won') AS won, ROUND(SUM(Amount),2) AS amount
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
GROUP BY lead_source ORDER BY n DESC LIMIT 20;
