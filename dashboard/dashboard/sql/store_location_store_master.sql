-- Builds: ds_imputed_reporting.store_location_store_master
-- What: One row per real Lucira physical retail store, geocoded to real lat/long.
-- Why: The Store Location Intelligence dashboard needs a real "nearest existing store" distance
--      calc for every pincode. No lat/long for any Lucira store exists anywhere else in this
--      codebase (dcs.js only maps store code -> city name). Source of truth for "does a store
--      physically exist" is the ERP address master (ornaverse_erp_master.company), which has a
--      real address + pin_code per company code -- more authoritative here than the Zoho CRM
--      owner-map (dcs.js's STORE_OWNERNAME_TO_CODE), which is scoped to deal/task routing and is
--      missing Lajpat Nagar (LPN) entirely even though LPN has a real ERP address.
-- Store set: 6 distinct customer-facing addresses. HO (Divinecarat Lifestyles' Mumbai back-office,
--      SV Rd) is excluded -- not a customer-facing store. FCS ("HWI VENTURES") shares the EXACT
--      SAME address as CS1 (Chembur) in ornaverse_erp_master.company -- included as an alias of
--      CS1, not a 7th location.
-- Geocoding: ds_india_geo.india_pincode (153,614-row real India Post pincode/lat/lon master) has
--      MULTIPLE office rows per pincode, and a real, confirmed data-quality issue in the source
--      itself -- e.g. pincode 201301 (Noida) has 2 of its 3 office rows with wildly wrong
--      coordinates (~700km off), while "Noida HO" is correct. For these 6 stores only, each
--      officename was manually inspected and the most locality-accurate / most reliable row was
--      picked by hand (see comments below) rather than trusting AVG()/MEDIAN() blindly, which
--      would silently average in bad rows. This is a one-time manual QA pass over exactly 6 known
--      addresses -- NOT the approach used for the thousands of WebEngage pincodes elsewhere in
--      this pipeline (those use a documented best-effort aggregate; see ga4_pincode_pincode_agg
--      build notes).
-- Cost: trivial (8-row literal join, no big table scan).
-- Cadence: static reference data -- rebuild only if Lucira opens/closes a physical store.

CREATE OR REPLACE TABLE `lucirajewelry-prod.ds_imputed_reporting.store_location_store_master` AS
WITH company AS (
  SELECT company_code, company_name, address, address_1, CAST(pin_code AS STRING) AS pincode
  FROM `lucirajewelry-prod.ornaverse_erp_master.company`
  WHERE company_code IN ('BO1','CS1','LPN','N18','PN1','PV1')
),
-- Manually verified best-match office row per store pincode (see header comment).
geo_pick AS (
  SELECT '400066' AS pincode, 'Borivali East SO' AS officename UNION ALL
  SELECT '400071', 'Chembur HO' UNION ALL
  SELECT '110024', 'Lajpat Nagar South Delhi SO' UNION ALL
  SELECT '201301', 'Noida HO' UNION ALL
  SELECT '411005', 'Shivajinagar H.O' UNION ALL
  SELECT '110063', 'Paschim Vihar S.O'
),
geo AS (
  SELECT g.pincode, p.district, p.statename AS state, p.latitude, p.longitude
  FROM geo_pick g
  JOIN `lucirajewelry-prod.ds_india_geo.india_pincode` p
    ON p.pincode = g.pincode AND p.officename = g.officename
)
SELECT
  c.company_code AS store_code,
  c.company_name AS store_name,
  CONCAT(c.address, ' ', COALESCE(c.address_1,'')) AS address,
  c.pincode,
  g.district,
  g.state,
  g.latitude,
  g.longitude,
  CASE
    WHEN c.company_code = 'CS1' THEN 'FCS (HWI VENTURES) shares this exact address -- same physical location, not a separate store.'
    WHEN c.company_code = 'N18' THEN 'Coordinates from the "Noida HO" office row -- the only reliable row for pincode 201301 in the India Post master; the other 2 office rows for this pincode contain real geocoding errors (~700km off) and were excluded, not averaged in.'
    ELSE NULL
  END AS notes
FROM company c
JOIN geo g ON g.pincode = c.pincode
ORDER BY store_code;
