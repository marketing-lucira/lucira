SELECT
  COUNT(*) AS deals_total,
  COUNTIF(Address_City IS NOT NULL AND TRIM(Address_City) != '') AS deals_with_city,
  COUNTIF(Address_Zip IS NOT NULL AND TRIM(Address_Zip) != '') AS deals_with_zip,
  COUNTIF(Stage = 'Closed Won') AS won_total,
  COUNTIF(Stage = 'Closed Won' AND Address_City IS NOT NULL AND TRIM(Address_City) != '') AS won_with_city,
  ROUND(SUM(Amount),2) AS amount_total,
  ROUND(SUM(IF(Address_City IS NOT NULL AND TRIM(Address_City) != '', Amount, 0)),2) AS amount_with_city,
  MIN(Creat_time) AS min_date, MAX(Creat_time) AS max_date
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`;
