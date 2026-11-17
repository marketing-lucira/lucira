-- ========================================================================================
--  Deal -> Store City -> Connected -> Store Visit (Zoho meeting) -> Sale -> Scheme funnel  (1 row = 1 Zoho Deal)
--  View: lucirajewelry-prod.ds_imputed_reporting.zoho_deal_store_funnel_v
--  Read by store-visit-intelligence-app/main.py (/api/deal-funnel), cached server-side.
--  Powers the "Deals Funnel" tab (Agent-wise + Store-wise tables).
--
--  Sources:
--    zoho_crm.cdc_deals / cdc_contacts / cdc_calls / cdc_meetings   Zoho CRM (CDC, 30-min sync)
--      Store Visit = a Zoho Meeting of type "Store Visit" on the deal (NOT customer_walkin)
--    Lucira_Prod.customer_walkin           Store walk-ins (reference only in the deal CSV + store fallback)
--    ds_imputed_reporting.marketing_sale   Sales (line-item grain -> invoice = distinct document_no)
--    Pos.scheme_enrollment                 ERP scheme enrolments (creation_date = true UTC timestamp)
--    ornaverse_erp_master.party / company  scheme party -> mobile, company_id -> store code
--
--  Every event (call / walk-in / sale / scheme) counts only when it happened strictly AFTER the
--  deal's Created_Time. Calls, walk-ins, sales and schemes are each aggregated per deal in their own
--  CTE and only then LEFT JOINed on deal_id (no fan-out).
-- ========================================================================================
CREATE OR REPLACE VIEW `lucirajewelry-prod.ds_imputed_reporting.zoho_deal_store_funnel_v`
OPTIONS (description = "1 row per Zoho deal: store-city flag, connected call (>30s), Store Visit = Zoho Store Visit meeting on the deal; sale / scheme enrolment strictly AFTER deal Created_Time. Built by store-visit-intelligence-app/sql/deal_store_funnel_view.sql") AS
WITH
deal0 AS (
  SELECT
    id                                                     AS deal_id,
    JSON_VALUE(data, '$.Deal_Name')                        AS deal_name,
    TIMESTAMP(JSON_VALUE(data, '$.Created_Time'))          AS created_ts,
    JSON_VALUE(data, '$.Owner.name')                       AS agent,
    JSON_VALUE(data, '$.Stage')                            AS deal_stage,
    NULLIF(TRIM(JSON_VALUE(data, '$.Address_City')), '')   AS deal_city,
    JSON_VALUE(data, '$.Mobile')                           AS deal_mobile,
    JSON_VALUE(data, '$.Email')                            AS deal_email,
    JSON_VALUE(data, '$.Contact_Name.id')                  AS contact_id,
    JSON_VALUE(data, '$.Contact_Name.name')                AS contact_name
  FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE JSON_VALUE(data, '$.Created_Time') IS NOT NULL
),
contact AS (
  SELECT id AS contact_id,
         NULLIF(TRIM(JSON_VALUE(data, '$.Mailing_City')), '') AS mailing_city,
         JSON_VALUE(data, '$.Mobile')                         AS c_mobile,
         JSON_VALUE(data, '$.Phone')                          AS c_phone,
         JSON_VALUE(data, '$.Email')                          AS c_email
  FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
),
deal1 AS (
  SELECT d.*,
    -- City: Deal Address_City; when blank, the linked Contact's Mailing_City (Address_City is only
    -- well captured from Sep 2026; Mailing_City fills ~half of the older blanks).
    COALESCE(d.deal_city, c.mailing_city)                                  AS city,
    CASE WHEN d.deal_city IS NOT NULL THEN 'Deal.Address_City'
         WHEN c.mailing_city IS NOT NULL THEN 'Contact.Mailing_City' END   AS city_source,
    COALESCE(
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(d.deal_mobile, ''), r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(d.deal_mobile, r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(c.c_mobile, ''),    r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(c.c_mobile,    r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(c.c_phone, ''),     r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(c.c_phone,     r'\D', ''), 10), NULL)
    )                                                                      AS mobile,
    COALESCE(IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(d.deal_email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$') AND NOT REGEXP_CONTAINS(LOWER(TRIM(d.deal_email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(d.deal_email)), NULL), IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(c.c_email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$') AND NOT REGEXP_CONTAINS(LOWER(TRIM(c.c_email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(c.c_email)), NULL)) AS email
  FROM deal0 d
  LEFT JOIN contact c USING (contact_id)
),
deal AS (
  SELECT *,
    -- Store City = same city list as the Zoho Login dashboard's Owner Performance
    -- "Store City Deals" column (zoho-login-dashboard/static/app.js STORE_CITY_RE).
    CASE
      WHEN REGEXP_CONTAINS(cn, r'\b(mumbai|bombay|thane|borivali|andheri|bandra|kandivali|malad|goregaon|dadar|kurla|ghatkopar|mulund|chembur|powai|kalyan|dombivli|bhiwandi|mira road|bhayandar|vasai|virar|panvel|kharghar|vashi|airoli|ulhasnagar|ambernath|badlapur)\b') THEN 'Mumbai'
      WHEN REGEXP_CONTAINS(cn, r'\b(pune|poona|pimpri|chinchwad)\b')                                           THEN 'Pune'
      WHEN REGEXP_CONTAINS(cn, r'\b(noida|gautam buddha nagar|ghaziabad|gaziabad)\b')                          THEN 'Noida / Ghaziabad'
      WHEN REGEXP_CONTAINS(cn, r'\b(delhi|karawal nagar|faridabad|gurgaon|gurugram)\b')                        THEN 'Delhi / Gurgaon'
      WHEN REGEXP_CONTAINS(cn, r'\b(bangalore|bengaluru)\b')                                                   THEN 'Bangalore'
    END AS store_city_group
  FROM (SELECT *, TRIM(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(IFNULL(city, '')), r'[^a-z ]', ' '), r'\s+', ' ')) AS cn FROM deal1)
),
-- -- Calls: connected = not Missed AND duration > 30 s, strictly after deal creation -------------
calls AS (
  SELECT
    id                                                                   AS call_id,
    TIMESTAMP(JSON_VALUE(data, '$.Call_Start_Time'))                     AS call_ts,
    IFNULL(SAFE_CAST(JSON_VALUE(data, '$.Call_Duration_in_seconds') AS INT64), 0) AS dur,
    JSON_VALUE(data, '$.Call_Type')                                      AS call_type,
    JSON_VALUE(data, '$.What_Id.id')                                     AS what_id,
    JSON_VALUE(data, '$.Who_Id.id')                                      AS who_id,
    [RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.To_Number__s'), ''),   r'\D', ''), 10),
     RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.From_Number__s'), ''), r'\D', ''), 10),
     RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Dialled_Number'), ''), r'\D', ''), 10)] AS nums
  FROM `lucirajewelry-prod.zoho_crm.cdc_calls`
  WHERE IFNULL(JSON_VALUE(data, '$.Outgoing_Call_Status'), '') NOT IN ('Scheduled', 'Overdue')
    AND JSON_VALUE(data, '$.Call_Start_Time') IS NOT NULL
),
call_match AS (
  -- Equi-joins on each key (Deal ID, Contact ID, mobile), then DISTINCT so a call matched on two
  -- keys counts once.
  SELECT DISTINCT deal_id, call_id, call_ts, dur, call_type FROM (
    SELECT d.deal_id, c.call_id, c.call_ts, c.dur, c.call_type
      FROM deal d JOIN calls c ON c.what_id = d.deal_id AND c.call_ts > d.created_ts
    UNION ALL
    SELECT d.deal_id, c.call_id, c.call_ts, c.dur, c.call_type
      FROM deal d JOIN calls c ON c.who_id = d.contact_id AND c.call_ts > d.created_ts
     WHERE d.contact_id IS NOT NULL
    UNION ALL
    SELECT d.deal_id, c.call_id, c.call_ts, c.dur, c.call_type
      FROM deal d JOIN (SELECT DISTINCT call_id, call_ts, dur, call_type, n FROM calls, UNNEST(nums) n WHERE n != '') c
        ON c.n = d.mobile AND c.call_ts > d.created_ts
     WHERE d.mobile IS NOT NULL
  )
),
call_agg AS (
  SELECT deal_id,
    COUNTIF(call_type != 'Missed')                                  AS calls_after,
    COUNTIF(call_type != 'Missed' AND dur > 30)                     AS connected_calls,
    MIN(IF(call_type != 'Missed' AND dur > 30, call_ts, NULL))      AS first_connected_ts
  FROM call_match GROUP BY deal_id
),
-- -- Walk-ins ----------------------------------------------------------------------------------
walkins AS (
  -- Lucira_Prod.customer_walkin (POS walk-in register). Since 2026-10-21 the loader writes `date`
  -- as DATETIME in IST wall-clock, EXCEPT legacy visit_type = 3 rows (imported history, up to Jul
  -- 2026), which come out 5:30 ahead (verified vs marketing_sale invoice times: types 1/2 sale =
  -- date + ~0-10 min, type 3 sale = date - ~328 min). company_id -> store code via the ERP company master.
  -- Customer keys: mobile = digits only (spaces, +91, dashes removed) -> RIGHT 10, valid Indian
  -- mobile only; email = lower/trim, valid shape, test@ / @lucirajewelry.com (staff) dropped.
  -- A walk-in matches a customer on mobile OR email.
  SELECT DISTINCT
    IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(w.mobile, ''), r'\D', ''), 10), r'^[6-9][0-9]{9}$'),
       RIGHT(REGEXP_REPLACE(w.mobile, r'\D', ''), 10), NULL)                               AS mobile,
    IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(w.email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$') AND NOT REGEXP_CONTAINS(LOWER(TRIM(w.email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(w.email)), NULL) AS email,
    TIMESTAMP(IF(w.visit_type = 3, DATETIME_SUB(w.date, INTERVAL 330 MINUTE), w.date), 'Asia/Kolkata')               AS walkin_ts,
    co.company_code                                                                       AS store_code
  FROM `lucirajewelry-prod.Lucira_Prod.customer_walkin` w
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.company` co ON co.company_id = w.company_id
  WHERE IFNULL(co.company_code, '') != 'HO'                -- head office (incl. Amazon seller), not a customer-facing store
    AND w.date IS NOT NULL
),
walkins_k AS (
  SELECT * FROM walkins WHERE mobile IS NOT NULL OR email IS NOT NULL
),
walkin_agg AS (
  SELECT d.deal_id,
    COUNT(*)                                                         AS walkins_after,
    MIN(w.walkin_ts)                                                 AS first_walkin_ts,
    ARRAY_AGG(w.store_code IGNORE NULLS ORDER BY w.walkin_ts LIMIT 1)[SAFE_OFFSET(0)] AS walkin_store
  FROM deal d JOIN (
    -- mobile OR email; DISTINCT so a walk-in matched on both keys counts once
    SELECT DISTINCT d2.deal_id, w.walkin_ts, w.store_code FROM deal d2 JOIN walkins_k w ON w.mobile = d2.mobile AND w.walkin_ts > d2.created_ts
    UNION DISTINCT
    SELECT DISTINCT d2.deal_id, w.walkin_ts, w.store_code FROM deal d2 JOIN walkins_k w ON w.email = d2.email AND w.walkin_ts > d2.created_ts
  ) w USING (deal_id)
  GROUP BY d.deal_id
),
-- -- Sales (invoice level) ---------------------------------------------------------------------
sale_docs AS (
  SELECT
    document_no,
    ANY_VALUE(RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1), r'\D', ''), 10))       AS mobile,
    MIN(TIMESTAMP(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date), 'Asia/Kolkata')) AS sale_ts,
    ANY_VALUE(company_code)                                                               AS store_code,
    ROUND(SUM(net_sale), 2)                                                               AS amount
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE COALESCE(Cus_mobile, mobile1) IS NOT NULL
  GROUP BY document_no
),
sale_agg AS (
  SELECT d.deal_id,
    COUNT(*)                                                         AS sales_after,
    ROUND(SUM(s.amount), 2)                                          AS sales_amount_after,
    MIN(s.sale_ts)                                                   AS first_sale_ts,
    ARRAY_AGG(IF(s.store_code IN ('HO', 'Amazon'), NULL, s.store_code) IGNORE NULLS ORDER BY s.sale_ts LIMIT 1)[SAFE_OFFSET(0)] AS sale_store,
    ARRAY_AGG(STRUCT(s.document_no AS doc, s.amount AS amt) ORDER BY s.sale_ts)                  AS sale_docs
  FROM deal d JOIN sale_docs s ON s.mobile = d.mobile AND s.sale_ts > d.created_ts
  GROUP BY d.deal_id
),
-- -- Scheme enrolments (ERP) -------------------------------------------------------------------
schemes AS (
  SELECT s.scheme_enrollment_id, s.creation_date AS scheme_ts, s.scheme_amount, co.company_code AS store_code,
         RIGHT(REGEXP_REPLACE(IFNULL(p.mobile, ''), r'\D', ''), 10) AS mobile
  FROM `lucirajewelry-prod.Pos.scheme_enrollment` s
  JOIN (SELECT CAST(party_id AS INT64) AS party_id, ANY_VALUE(mobile) AS mobile
          FROM `lucirajewelry-prod.ornaverse_erp_master.party` GROUP BY 1) p ON p.party_id = s.party_id
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.company` co ON co.company_id = s.company_id
  WHERE NOT IFNULL(s.is_cancelled, FALSE)
),
scheme_agg AS (
  SELECT d.deal_id,
    COUNT(*)                                                         AS schemes_after,
    ROUND(SUM(sc.scheme_amount), 2)                                  AS scheme_monthly_amount,
    MIN(sc.scheme_ts)                                                AS first_scheme_ts,
    ARRAY_AGG(IF(sc.store_code = 'HO', NULL, sc.store_code) IGNORE NULLS ORDER BY sc.scheme_ts LIMIT 1)[SAFE_OFFSET(0)] AS scheme_store,
    ARRAY_AGG(sc.scheme_enrollment_id ORDER BY sc.scheme_ts)         AS scheme_ids
  FROM deal d JOIN schemes sc ON sc.mobile = d.mobile AND sc.scheme_ts > d.created_ts
  GROUP BY d.deal_id
),
-- -- Store Visit = every Zoho CRM Meeting (Events) on the deal, any meeting type --------------
-- (business rule 2026-09-30: every meeting raised in Zoho is a store visit; e.g. 24 meetings raised
-- on 29 Sep 2026 = 24 store visits). Linked to the deal by What_Id (= Deal ID, $se_module = Deals),
-- or by Who_Id = the deal's Contact for Contact-linked meetings created after the deal.
sv_meetings AS (
  SELECT
    id                                                    AS meeting_id,
    JSON_VALUE(data, '$."$se_module"')                    AS module,
    JSON_VALUE(data, '$.What_Id.id')                      AS what_id,
    JSON_VALUE(data, '$.Who_Id.id')                       AS who_id,
    TIMESTAMP(JSON_VALUE(data, '$.Created_Time'))         AS created_ts,
    IF(SAFE_CAST(JSON_VALUE(data, '$.All_day') AS BOOL), SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(JSON_VALUE(data, '$.Start_DateTime'), 1, 10)),
       DATE(TIMESTAMP(JSON_VALUE(data, '$.Start_DateTime')), 'Asia/Kolkata'))                AS visit_date,
    -- Meeting store = Zoho "Store - Name" (Store_Name) as selected on the meeting; Venue keywords
    -- only when Store_Name is blank (meetings before the field was in use, ~22 Sep 2026).
    -- Head Office is not a customer store, so it gives no store here.
    CASE
      WHEN store_name IS NOT NULL THEN
        CASE store_name
          WHEN 'Borivali Store'      THEN 'BO1'
          WHEN 'Chembur Store'       THEN 'CS1'
          WHEN 'Lajpat Nagar Store'  THEN 'LPN'
          WHEN 'Paschim Vihar Store' THEN 'PV1'
          WHEN 'Noida Store'         THEN 'N18'
          WHEN 'Pune Store'          THEN 'PN1'
          WHEN 'Malleshwaram Store'  THEN 'MAL'
        END
      WHEN REGEXP_CONTAINS(v, r'bori')                                   THEN 'BO1'
      WHEN REGEXP_CONTAINS(v, r'chemb|chmb|chmeb|chamber')               THEN 'CS1'
      WHEN REGEXP_CONTAINS(v, r'lajpat|lachpat')                         THEN 'LPN'
      WHEN REGEXP_CONTAINS(v, r'paschim|pashchim|pashim|pachim|panchim|pashcim|ppashcim') THEN 'PV1'
      WHEN REGEXP_CONTAINS(v, r'noida')                                  THEN 'N18'
      WHEN REGEXP_CONTAINS(v, r'pune')                                   THEN 'PN1'
      WHEN REGEXP_CONTAINS(v, r'mallesh|malleswar|m[ae]l+[ae]?s[hg]?w[ae]?r|mallikarjun|b[ae]?n[ae]?g[ae]?l[ou]r') THEN 'MAL'
    END                                                   AS venue_store
  FROM (SELECT id, data, LOWER(IFNULL(JSON_VALUE(data, '$.Venue'), '')) AS v,
               NULLIF(TRIM(JSON_VALUE(data, '$.Store_Name')), '') AS store_name
          FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`)
),
sv_match AS (
  SELECT DISTINCT deal_id, meeting_id, created_ts, visit_date, venue_store FROM (
    SELECT d.deal_id, m.meeting_id, m.created_ts, m.visit_date, m.venue_store
      FROM deal d JOIN sv_meetings m ON m.module = 'Deals' AND m.what_id = d.deal_id
    UNION ALL
    SELECT d.deal_id, m.meeting_id, m.created_ts, m.visit_date, m.venue_store
      FROM deal d JOIN sv_meetings m ON m.module = 'Contacts' AND m.who_id = d.contact_id AND m.created_ts > d.created_ts
     WHERE d.contact_id IS NOT NULL
  )
),
sv_agg AS (
  SELECT deal_id,
    COUNT(*)                                                                   AS store_visit_meetings,
    MIN(created_ts)                                                            AS first_sv_created_ts,
    ARRAY_AGG(visit_date ORDER BY created_ts LIMIT 1)[OFFSET(0)]               AS first_sv_date,
    ARRAY_AGG(venue_store IGNORE NULLS ORDER BY created_ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS meeting_store
  FROM sv_match GROUP BY deal_id
),
store_master AS (
  SELECT company_code AS store_code,
         CASE company_code WHEN 'CS1' THEN 'Chembur' WHEN 'FCS' THEN 'FCS (Chembur address)'
              ELSE COALESCE(REGEXP_EXTRACT(company_name, r'\(([^)]+)\)'), company_name) END AS store_label
  FROM `lucirajewelry-prod.ornaverse_erp_master.company`
),
final AS (
  SELECT d.* EXCEPT (store_city_group, city_source),
    -- City blank on the deal AND the contact: fall back to the city of the store where the deal's
    -- Zoho Store Visit meeting is booked (Store Name, else Venue), so a booked store visit is not lost as "Non-Store".
    COALESCE(d.store_city_group, IF(d.city IS NULL,
      CASE sv.meeting_store WHEN 'BO1' THEN 'Mumbai' WHEN 'CS1' THEN 'Mumbai' WHEN 'LPN' THEN 'Delhi / Gurgaon'
           WHEN 'PV1' THEN 'Delhi / Gurgaon' WHEN 'N18' THEN 'Noida / Ghaziabad' WHEN 'PN1' THEN 'Pune'
           WHEN 'MAL' THEN 'Bangalore' END, NULL))                                AS store_city_group,
    COALESCE(d.city_source, IF(sv.meeting_store IS NOT NULL, 'Store Visit meeting store', NULL)) AS city_source,
    ca.calls_after, ca.connected_calls, ca.first_connected_ts,
    wa.walkins_after, wa.first_walkin_ts, wa.walkin_store,
    sa.sales_after, sa.sales_amount_after, sa.first_sale_ts, sa.sale_store, sa.sale_docs,
    sc.schemes_after, sc.scheme_monthly_amount, sc.first_scheme_ts, sc.scheme_store, sc.scheme_ids,
    sv.store_visit_meetings, sv.first_sv_created_ts, sv.first_sv_date, sv.meeting_store,
    -- Store attribution (Deals.Store_Assigned is 0% populated, so it is derived, strongest first):
    --   1 Store Name (else Venue) of the deal's Zoho meeting, 2 store of first walk-in after creation,
    --   3 store of first in-store sale, 4 scheme store, 5 the only store in the deal's city.
    --   Mumbai (Chembur / Borivali) and Delhi (Lajpat / Paschim Vihar) have two stores each, so a
    --   deal there with none of 1-4 is left "not assigned" instead of being guessed.
    COALESCE(sv.meeting_store, wa.walkin_store, sa.sale_store, sc.scheme_store,
      CASE d.store_city_group WHEN 'Pune' THEN 'PN1' WHEN 'Bangalore' THEN 'MAL' WHEN 'Noida / Ghaziabad' THEN 'N18' END) AS store_code,
    CASE WHEN sv.meeting_store IS NOT NULL THEN 'Store Visit meeting store'
         WHEN wa.walkin_store IS NOT NULL THEN 'Walk-in store'
         WHEN sa.sale_store IS NOT NULL THEN 'Sale store'
         WHEN sc.scheme_store IS NOT NULL THEN 'Scheme store'
         WHEN d.store_city_group IN ('Pune', 'Bangalore', 'Noida / Ghaziabad') THEN 'City (single store)' END AS store_source
  FROM deal d
  LEFT JOIN call_agg      ca USING (deal_id)
  LEFT JOIN walkin_agg    wa USING (deal_id)
  LEFT JOIN sale_agg      sa USING (deal_id)
  LEFT JOIN scheme_agg    sc USING (deal_id)
  LEFT JOIN sv_agg        sv USING (deal_id)
)
SELECT
  f.deal_id,
  f.deal_name,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', f.created_ts, 'Asia/Kolkata')              AS created_ist,
  DATE(f.created_ts, 'Asia/Kolkata')                                               AS created_date,
  f.agent,
  f.deal_stage,
  f.contact_name                                                                    AS customer_name,
  f.mobile,
  f.city,
  f.city_source,
  f.store_city_group IS NOT NULL                                                    AS is_store_city,
  f.store_city_group,
  f.store_code,
  CASE WHEN f.store_code IS NOT NULL THEN CONCAT(f.store_code, ' - ', IFNULL(sm.store_label, f.store_code))
       WHEN f.store_city_group = 'Mumbai' THEN 'Mumbai - store not assigned'
       WHEN f.store_city_group = 'Delhi / Gurgaon' THEN 'Delhi / Gurgaon - store not assigned'
       ELSE 'Non-Store City' END                                                    AS store,
  f.store_source,
  IFNULL(f.calls_after, 0)                                                          AS calls_after,
  IFNULL(f.connected_calls, 0)                                                      AS connected_calls,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', f.first_connected_ts, 'Asia/Kolkata')       AS first_connected_ist,
  IFNULL(f.store_visit_meetings, 0)                                                 AS store_visit_meetings,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', f.first_sv_created_ts, 'Asia/Kolkata')      AS first_sv_created_ist,
  f.first_sv_date,
  IFNULL(f.walkins_after, 0)                                                        AS walkins_after,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', f.first_walkin_ts, 'Asia/Kolkata')          AS first_walkin_ist,
  f.walkin_store,
  IFNULL(f.sales_after, 0)                                                          AS sales_after,
  IFNULL(f.sales_amount_after, 0)                                                   AS sales_amount_after,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', f.first_sale_ts, 'Asia/Kolkata')            AS first_sale_ist,
  f.sale_docs,
  IFNULL(f.schemes_after, 0)                                                        AS schemes_after,
  IFNULL(f.scheme_monthly_amount, 0)                                                AS scheme_monthly_amount,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', f.first_scheme_ts, 'Asia/Kolkata')          AS first_scheme_ist,
  f.scheme_ids
FROM final f
LEFT JOIN store_master sm ON sm.store_code = f.store_code

