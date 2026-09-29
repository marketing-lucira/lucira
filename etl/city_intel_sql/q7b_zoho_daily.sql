SELECT DATE(Creat_time) AS d, COUNT(*) AS deals, ROUND(SUM(Amount),2) AS amount,
       COUNTIF(Stage='Closed Won') AS won, COUNTIF(Stage='Closed Lost') AS lost
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
WHERE Creat_time IS NOT NULL
GROUP BY d ORDER BY d;
