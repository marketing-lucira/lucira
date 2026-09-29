-- Pin Code performance from Zoho Deals — the ONLY connected source that carries a postal field
-- (GA4 export has no postal/pin dimension at all). Sparse by construction: same ~15% Address_City
-- coverage problem applies to Address_Zip. No Area/locality field exists anywhere, and there is no
-- Pin Code -> Area master table connected, so Area is intentionally not produced here.
--
-- Day-level grain (pincode, d): lets the dashboard's date-range filter actually change these
-- numbers (a plain pincode-total aggregate can't respond to "show me just last Tuesday" — there
-- was nothing to slice). The client re-aggregates across whatever date window is selected. Still
-- capped to the top 300 pincodes by lifetime deal volume, so the ranking stays stable regardless
-- of which window someone filters to.
WITH totals AS (
  SELECT Address_Zip AS pincode, COUNT(*) AS deals
  FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`
  WHERE Address_Zip IS NOT NULL AND Address_Zip != ''
  GROUP BY pincode
  ORDER BY deals DESC
  LIMIT 300
)
SELECT
  z.Address_Zip AS pincode,
  DATE(z.Creat_time) AS d,
  ANY_VALUE(z.Address_City) AS city,
  ANY_VALUE(z.Address_State) AS state,
  COUNT(*) AS deals,
  COUNTIF(z.Stage = 'Closed Won') AS won,
  SUM(IF(z.Amount IS NOT NULL, z.Amount, 0)) AS amount
FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals` z
JOIN totals t ON t.pincode = z.Address_Zip
WHERE z.Creat_time IS NOT NULL
GROUP BY pincode, d
ORDER BY pincode, d;
