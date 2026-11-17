-- ========================================================================================
--  Zoho Meeting -> Call -> Walk-in -> Sale journey  (1 row = 1 Zoho CRM Meeting)
--  View: lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v
--  Read by store-visit-intelligence-app/main.py (/api/journey), cached server-side.
--
--  Sources (all live-synced BigQuery tables; nothing from GA4 / PDP / website analytics):
--    zoho_crm.cdc_meetings    Zoho Meetings (Events)  - CDC upsert, 1 row/id, synced every 30 min
--    zoho_crm.cdc_deals       Zoho Deals              - CDC upsert, 1 row/id, synced every 30 min
--    zoho_crm.cdc_calls       Zoho Calls              - CDC upsert, 1 row/id, synced every 30 min
--    zoho_crm.cdc_contacts    Zoho Contacts (customer name / mobile fallback)
--    zoho_crm.zoho_leads      Zoho Leads (mobile fallback for Lead-linked meetings only)
--    Lucira_Prod.customer_walkin           Store walk-ins (POS walk-in register)
--    ds_imputed_reporting.marketing_sale   Sales (line-item grain)
--    ornaverse_erp_master.company          Store code -> store name (ERP master)
--    Customer pincode (customer-typed only, matched on mobile): marketing_sale.Pin_code,
--      Shopify_customer.zip_code, customer_walkin.pin_code, ornaverse_erp_master.party.pin_code,
--      ornaverse_crm_data.customer.pin_code
--    ds_imputed_reporting.pincode_geo_lookup  India Post pincode -> lat/lon (fallback distance only)
--
--  Anti fan-out: meeting base is built first; calls / walk-ins / sales are each AGGREGATED per
--  meeting in their own CTE and only then LEFT JOINed back on meeting_id. Meeting x Calls x
--  Walk-ins x Sales is never joined directly.
--
--  Time zone: every comparison is done on absolute TIMESTAMPs; every displayed value is IST.
--    * Zoho Created_Time / Call_Start_Time / Start_DateTime carry an explicit offset -> TIMESTAMP().
--    * marketing_sale.document_date is IST wall-clock "DD-MM-YYYY HH:MM:SS" -> TIMESTAMP(.., 'Asia/Kolkata').
--    * customer_walkin.date is true UTC, except legacy visit_type = 3 rows = IST wall-clock -> TIMESTAMP(.., 'Asia/Kolkata').
-- ========================================================================================
CREATE OR REPLACE VIEW `lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v`
OPTIONS (description = "1 row per Zoho CRM meeting: calls / walk-ins / sales strictly AFTER meeting Created_Time (IST). Built by store-visit-intelligence-app/sql/meeting_journey_view.sql") AS
WITH
-- -- 1. Meeting base ----------------------------------------------------------------------
mtg AS (
  SELECT
    id                                                   AS meeting_id,
    JSON_VALUE(data, '$.Event_Title')                    AS meeting_title,
    TIMESTAMP(JSON_VALUE(data, '$.Created_Time'))        AS created_ts,
    JSON_VALUE(data, '$.Start_DateTime')                 AS start_raw,
    JSON_VALUE(data, '$.End_DateTime')                   AS end_raw,
    SAFE_CAST(JSON_VALUE(data, '$.All_day') AS BOOL)     AS all_day,
    JSON_VALUE(data, '$.Venue')                          AS venue,
    NULLIF(TRIM(JSON_VALUE(data, '$.Store_Name')), '')   AS store_name,
    JSON_VALUE(data, '$.Meeting_Venue__s')               AS meeting_location,
    JSON_VALUE(data, '$.Check_In_Status')                AS meeting_status,
    JSON_VALUE(data, '$."$se_module"')                   AS related_module,
    JSON_VALUE(data, '$.What_Id.id')                     AS what_id,
    JSON_VALUE(data, '$.Who_Id.id')                      AS who_id,
    JSON_VALUE(data, '$.Who_Id.name')                    AS who_name,
    JSON_VALUE(data, '$.Owner.name')                     AS meeting_owner,
    JSON_VALUE(data, '$.Created_By.name')                AS meeting_created_by,
    JSON_VALUE(data, '$.Description')                    AS meeting_description,
    -- Zoho meeting picklists filled by the team: Show_Status ('Show' = customer walked in) and
    -- Conversion_Status ('Converted' = order converted).
    -- LATEST VALUE ALWAYS WINS (user rule 2026-11-06): once the CDC row carries the field (every
    -- meeting created or edited in Zoho since 6 Oct 2026) its current value is used, even when it
    -- is blank, so a later change (No Show -> Show, or a cleared status) replaces the earlier one.
    -- The one-time REST backfill zoho_crm.meetings_status_patch is used ONLY for meetings whose
    -- CDC row has never carried the field (not edited in Zoho since 6 Oct 2026).
    IF(REGEXP_CONTAINS(m.data, r'"Show_Status"\s*:'),
       NULLIF(TRIM(JSON_VALUE(m.data, '$.Show_Status')), ''), p.Show_Status)             AS show_status,
    IF(REGEXP_CONTAINS(m.data, r'"Conversion_Status"\s*:'),
       NULLIF(TRIM(JSON_VALUE(m.data, '$.Conversion_Status')), ''), p.Conversion_Status) AS conversion_status
  FROM `lucirajewelry-prod.zoho_crm.cdc_meetings` m
  LEFT JOIN `lucirajewelry-prod.zoho_crm.meetings_status_patch` p USING (id)
),
deal AS (
  SELECT
    id                                                        AS deal_id,
    JSON_VALUE(data, '$.Deal_Name')                           AS deal_name,
    JSON_VALUE(data, '$.Stage')                               AS deal_stage,
    JSON_VALUE(data, '$.Deal_Trigger_Event')                  AS deal_trigger,
    SAFE_CAST(JSON_VALUE(data, '$.Probability') AS INT64)     AS probability,
    JSON_VALUE(data, '$.Address_City')                        AS deal_city,
    JSON_VALUE(data, '$.Address_State_Province')              AS deal_state,
    JSON_VALUE(data, '$.Owner.name')                          AS deal_owner,
    JSON_VALUE(data, '$.Lead_Source')                         AS lead_source,
    JSON_VALUE(data, '$.Campaign_Source')                     AS campaign_source,
    JSON_VALUE(data, '$.UTM_Source')                          AS utm_source,
    JSON_VALUE(data, '$.UTM_Medium')                          AS utm_medium,
    JSON_VALUE(data, '$.UTM_Campaign')                        AS utm_campaign,
    JSON_VALUE(data, '$.Store_Assigned')                      AS deal_store_assigned,
    JSON_VALUE(data, '$.Record_Type')                         AS deal_record_type,
    JSON_VALUE(data, '$.Intent_Stage')                        AS intent_stage,
    SAFE_CAST(JSON_VALUE(data, '$.Amount') AS FLOAT64)        AS deal_amount,
    JSON_VALUE(data, '$.Closing_Date')                        AS closing_date,
    TIMESTAMP(JSON_VALUE(data, '$.Created_Time'))             AS deal_created_ts,
    JSON_VALUE(data, '$.Mobile')                              AS deal_mobile,
    JSON_VALUE(data, '$.Email')                               AS deal_email,
    JSON_VALUE(data, '$.Contact_Name.id')                     AS deal_contact_id,
    JSON_VALUE(data, '$.Contact_Name.name')                   AS deal_contact_name
  FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  WHERE id IN (SELECT what_id FROM mtg WHERE related_module = 'Deals')
),
m1 AS (
  SELECT m.*, d.* EXCEPT (deal_id), IF(m.related_module = 'Deals', d.deal_id, NULL) AS deal_id,
         COALESCE(m.who_id, d.deal_contact_id) AS contact_id
  FROM mtg m
  LEFT JOIN deal d ON m.related_module = 'Deals' AND d.deal_id = m.what_id
),
contact AS (
  SELECT id AS contact_id,
         JSON_VALUE(data, '$.Full_Name') AS contact_full_name,
         JSON_VALUE(data, '$.Mobile')    AS contact_mobile,
         JSON_VALUE(data, '$.Phone')     AS contact_phone,
         JSON_VALUE(data, '$.Email')     AS contact_email
  FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
  WHERE id IN (SELECT contact_id FROM m1)
),
lead AS (
  SELECT record_id AS lead_id,
         LAX_STRING(lead_data.Mobile)    AS lead_mobile,
         LAX_STRING(lead_data.Phone)     AS lead_phone,
         LAX_STRING(lead_data.Full_Name) AS lead_full_name,
         LAX_STRING(lead_data.Email)     AS lead_email
  FROM `lucirajewelry-prod.zoho_crm.zoho_leads`
  WHERE record_id IN (SELECT what_id FROM mtg WHERE related_module = 'Leads')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY synced_at DESC) = 1
),
store_master AS (
  SELECT company_code AS store_code,
         CASE company_code WHEN 'CS1' THEN 'Chembur' WHEN 'HO' THEN 'Head Office' WHEN 'FCS' THEN 'FCS (Chembur address)'
              ELSE COALESCE(REGEXP_EXTRACT(company_name, r'\(([^)]+)\)'), company_name) END AS store_label
  FROM `lucirajewelry-prod.ornaverse_erp_master.company`
),
base AS (
  SELECT
    m1.*,
    c.contact_full_name, l.lead_full_name,
    COALESCE(c.contact_full_name, l.lead_full_name, m1.deal_contact_name, m1.who_name) AS customer_name,
    -- Normalised mobile: last 10 digits, must be a valid Indian mobile (same rule as walkin-source-api).
    COALESCE(
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(m1.deal_mobile, ''),     r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(m1.deal_mobile,     r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(c.contact_mobile, ''),   r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(c.contact_mobile,   r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(c.contact_phone, ''),    r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(c.contact_phone,    r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(l.lead_mobile, ''),      r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(l.lead_mobile,      r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(l.lead_phone, ''),       r'\D', ''), 10), r'^[6-9][0-9]{9}$'), RIGHT(REGEXP_REPLACE(l.lead_phone,       r'\D', ''), 10), NULL),
      IF(REGEXP_CONTAINS(IFNULL(m1.who_name, ''), r'^\+?[0-9 ]{10,}$') AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(m1.who_name, r'\D', ''), 10), r'^[6-9][0-9]{9}$'),
         RIGHT(REGEXP_REPLACE(m1.who_name, r'\D', ''), 10), NULL)
    ) AS mobile,
    CASE
      WHEN REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(m1.deal_mobile, ''),   r'\D', ''), 10), r'^[6-9][0-9]{9}$') THEN 'Deal.Mobile'
      WHEN REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(c.contact_mobile, ''), r'\D', ''), 10), r'^[6-9][0-9]{9}$') THEN 'Contact.Mobile'
      WHEN REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(c.contact_phone, ''),  r'\D', ''), 10), r'^[6-9][0-9]{9}$') THEN 'Contact.Phone'
      WHEN REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(l.lead_mobile, ''),    r'\D', ''), 10), r'^[6-9][0-9]{9}$') THEN 'Lead.Mobile'
      WHEN REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(l.lead_phone, ''),     r'\D', ''), 10), r'^[6-9][0-9]{9}$') THEN 'Lead.Phone'
      WHEN REGEXP_CONTAINS(IFNULL(m1.who_name, ''), r'^\+?[0-9 ]{10,}$') THEN 'Meeting.Who_Id name'
    END AS mobile_source,
    -- Customer email (walk-in match key alongside mobile): Deal, else Contact, else Lead.
    COALESCE(IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(m1.deal_email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$') AND NOT REGEXP_CONTAINS(LOWER(TRIM(m1.deal_email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(m1.deal_email)), NULL),
             IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(c.contact_email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$') AND NOT REGEXP_CONTAINS(LOWER(TRIM(c.contact_email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(c.contact_email)), NULL),
             IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(l.lead_email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$') AND NOT REGEXP_CONTAINS(LOWER(TRIM(l.lead_email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(l.lead_email)), NULL)) AS email,
    -- From Date: Start_DateTime in IST. All-day meetings are stored as 00:00 UTC of the calendar
    -- day, so their date part is taken as-is (converting would still land on the same day).
    IF(m1.all_day, SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(m1.start_raw, 1, 10)),
       DATE(TIMESTAMP(m1.start_raw), 'Asia/Kolkata'))                                   AS from_date,
    IF(m1.all_day, NULL, TIMESTAMP(m1.start_raw))                                       AS from_ts,
    -- Meeting store = the meeting's own Zoho "Store - Name" picklist (Store_Name), as selected by the
    -- team. Only when it is blank (meetings raised before the field was in use, ~22 Sep 2026) the
    -- free-text Venue is matched by keyword as a fallback; raw Venue kept as-is. Fallback MAL also
    -- takes misspellings (Mallesgwaram, Maleshwaram, Melleshwaram), the Kadu Mallikarjuna temple
    -- landmark, and a bare Bangalore / Bengaluru venue in any spelling (only store there).
    CASE
      WHEN m1.store_name IS NOT NULL THEN
        CASE m1.store_name
          WHEN 'Borivali Store'      THEN 'BO1'
          WHEN 'Chembur Store'       THEN 'CS1'
          WHEN 'Lajpat Nagar Store'  THEN 'LPN'
          WHEN 'Paschim Vihar Store' THEN 'PV1'
          WHEN 'Noida Store'         THEN 'N18'
          WHEN 'Pune Store'          THEN 'PN1'
          WHEN 'Malleshwaram Store'  THEN 'MAL'
          WHEN 'Head Office'         THEN 'HO'
        END
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'bori')                                  THEN 'BO1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'chemb|chmb|chmeb|chamber')              THEN 'CS1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'lajpat|lachpat')                        THEN 'LPN'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'paschim|pashchim|pashim|pachim|panchim|pashcim|ppashcim') THEN 'PV1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'noida')                                 THEN 'N18'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'pune')                                  THEN 'PN1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'mallesh|malleswar|m[ae]l+[ae]?s[hg]?w[ae]?r|mallikarjun|b[ae]?n[ae]?g[ae]?l[ou]r') THEN 'MAL'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'^\s*ho\s*$|head office|malad')          THEN 'HO'
    END AS meeting_store_code
  FROM m1
  LEFT JOIN contact c USING (contact_id)
  LEFT JOIN lead l ON m1.related_module = 'Leads' AND l.lead_id = m1.what_id
),
-- -- 2. Calls, aggregated per meeting -----------------------------------------------------
calls AS (
  SELECT
    id                                                                   AS call_id,
    TIMESTAMP(JSON_VALUE(data, '$.Call_Start_Time'))                     AS call_ts,
    IFNULL(SAFE_CAST(JSON_VALUE(data, '$.Call_Duration_in_seconds') AS INT64), 0) AS dur,
    JSON_VALUE(data, '$.Call_Type')                                      AS call_type,
    JSON_VALUE(data, '$.Owner.name')                                     AS call_owner,
    JSON_VALUE(data, '$.What_Id.id')                                     AS what_id,
    JSON_VALUE(data, '$.Who_Id.id')                                      AS who_id,
    RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.To_Number__s'), ''),   r'\D', ''), 10) AS to_n,
    RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.From_Number__s'), ''), r'\D', ''), 10) AS from_n,
    RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Dialled_Number'), ''), r'\D', ''), 10) AS dial_n
  FROM `lucirajewelry-prod.zoho_crm.cdc_calls`
  -- Planned CRM calls that never happened (Outgoing_Call_Status Scheduled / Overdue) are excluded.
  WHERE IFNULL(JSON_VALUE(data, '$.Outgoing_Call_Status'), '') NOT IN ('Scheduled', 'Overdue')
    AND JSON_VALUE(data, '$.Call_Start_Time') >= '2026-01-01'
),
call_match AS (
  -- A call belongs to a meeting when it started on the SAME IST DAY the meeting was created (even
  -- before the creation time) or any time after, AND it is linked by Deal ID (What_Id), else
  -- Contact ID (Who_Id), else normalised customer mobile.
  -- USER RULE 2026-11-14: the visit is usually booked on a call a few minutes BEFORE the agent saves
  -- the meeting (e.g. call 18:35, meeting created 18:42) -- that same-day call must count as Called.
  -- DISTINCT call_id: a call matched by more than one key is still counted once.
  SELECT DISTINCT b.meeting_id, c.call_id, c.call_ts, c.dur, c.call_type, c.call_owner,
    CASE WHEN c.what_id = b.deal_id THEN 'Deal ID' WHEN c.who_id = b.contact_id THEN 'Contact ID' ELSE 'Mobile' END AS match_key
  FROM base b
  JOIN calls c
    ON c.call_ts >= TIMESTAMP(DATE(b.created_ts, 'Asia/Kolkata'), 'Asia/Kolkata')
   AND (   (b.deal_id   IS NOT NULL AND c.what_id = b.deal_id)
        OR (b.contact_id IS NOT NULL AND c.who_id  = b.contact_id)
        OR (b.mobile     IS NOT NULL AND b.mobile IN (c.to_n, c.from_n, c.dial_n)))
),
call_agg AS (
  SELECT
    meeting_id,
    COUNTIF(call_type != 'Missed')                        AS calls_after,
    COUNTIF(call_type != 'Missed' AND dur >= 30)          AS connected_calls,
    COUNTIF(call_type = 'Missed')                         AS missed_calls,
    MIN(IF(call_type != 'Missed', call_ts, NULL))         AS first_call_ts,
    MAX(IF(call_type != 'Missed', call_ts, NULL))         AS last_call_ts,
    MIN(IF(call_type != 'Missed' AND dur >= 30, call_ts, NULL)) AS first_connected_ts,
    SUM(IF(call_type != 'Missed', dur, 0))                AS talk_time_sec,
    ARRAY_AGG(STRUCT(call_id AS id, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', call_ts, 'Asia/Kolkata') AS ts,
                     dur, call_type AS type, call_owner AS owner, match_key AS mk) ORDER BY call_ts) AS calls
  FROM call_match
  GROUP BY meeting_id
),
-- -- 3. Walk-ins, aggregated per meeting --------------------------------------------------
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
  SELECT
    b.meeting_id,
    COUNTIF(w.walkin_ts > b.created_ts)                                     AS walkins_after,
    MIN(IF(w.walkin_ts > b.created_ts, w.walkin_ts, NULL))                  AS first_walkin_ts,
    ARRAY_AGG(IF(w.walkin_ts > b.created_ts, w.store_code, NULL) IGNORE NULLS ORDER BY w.walkin_ts LIMIT 1)[SAFE_OFFSET(0)] AS first_walkin_store_code,
    COUNTIF(w.walkin_ts < b.created_ts)                                     AS walkins_before,
    MAX(IF(w.walkin_ts < b.created_ts, w.walkin_ts, NULL))                  AS prev_walkin_ts,
    ARRAY_AGG(IF(w.walkin_ts < b.created_ts, w.store_code, NULL) IGNORE NULLS ORDER BY w.walkin_ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS prev_walkin_store_code,
    ARRAY_AGG(STRUCT(FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', w.walkin_ts, 'Asia/Kolkata') AS ts, w.store_code AS store,
                     w.walkin_ts > b.created_ts AS after) ORDER BY w.walkin_ts) AS walkins
  FROM base b
  JOIN (
    -- mobile OR email; DISTINCT so a walk-in matched on both keys counts once
    SELECT DISTINCT b2.meeting_id, w.walkin_ts, w.store_code FROM base b2 JOIN walkins_k w ON w.mobile = b2.mobile
    UNION DISTINCT
    SELECT DISTINCT b2.meeting_id, w.walkin_ts, w.store_code FROM base b2 JOIN walkins_k w ON w.email = b2.email
  ) w USING (meeting_id)
  GROUP BY b.meeting_id
),
-- -- 4. Sales (invoice level), aggregated per meeting -------------------------------------
sale_docs AS (
  -- Existing project rule (hourly-deals-orders-api): marketing_sale is line-item grain; an order
  -- is a distinct document_no and its amount is SUM(net_sale) over all its lines.
  SELECT
    document_no,
    ANY_VALUE(RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1), r'\D', ''), 10))       AS mobile,
    MIN(TIMESTAMP(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date), 'Asia/Kolkata')) AS sale_ts,
    ANY_VALUE(company_code)                                                               AS store_code,
    ANY_VALUE(Channel)                                                                    AS channel,
    ROUND(SUM(net_sale), 2)                                                               AS amount,
    STRING_AGG(DISTINCT Full_sku, ', ')                                                   AS skus
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE COALESCE(Cus_mobile, mobile1) IS NOT NULL
  GROUP BY document_no
),
sale_agg AS (
  SELECT
    b.meeting_id,
    COUNT(*)                                                             AS sales_after,
    ROUND(SUM(s.amount), 2)                                              AS sales_amount_after,
    MIN(s.sale_ts)                                                       AS first_sale_ts,
    ARRAY_AGG(STRUCT(s.amount, s.store_code, s.channel, s.skus, s.document_no) ORDER BY s.sale_ts LIMIT 1)[OFFSET(0)] AS first_sale,
    ARRAY_AGG(STRUCT(s.document_no AS doc, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', s.sale_ts, 'Asia/Kolkata') AS ts,
                     s.amount, s.store_code AS store, s.channel, s.skus) ORDER BY s.sale_ts) AS sales
  FROM base b
  JOIN sale_docs s ON s.mobile = b.mobile AND s.sale_ts > b.created_ts
  GROUP BY b.meeting_id
),
-- -- 5. Customer pincode + km to the meeting's store --------------------------------------
store_pin AS (
  -- Published store-locator coordinates (Lucira_Nearest_10_Pincodes.xlsx, 22 Oct 2026; MAL is a
  -- provisional pin). near_pin = EVERY pincode whose polygon centre is within 6 km of the store pin:
  -- area-weighted centroid of the data.gov.in delivery-PO pincode polygons
  -- (bharatlas datagov_pincodes, May 2025), Haversine, R = 6371.0088 km -- the same method as that
  -- Excel, whose top-10 km it reproduces. It also covers the user's 26 Oct store-pincode list (all
  -- of it lies within 6 km). The list is complete to 6 km, so a pincode outside it is > 6 km away:
  -- list_max_km = 6.
  SELECT * FROM UNNEST([
    STRUCT('BO1' AS store_code, 19.2232556 AS lat, 72.8640139 AS lon, 6.0 AS list_max_km),
    STRUCT('CS1' AS store_code, 19.0579383 AS lat, 72.9004860 AS lon, 6.0 AS list_max_km),
    STRUCT('PN1' AS store_code, 18.5233666 AS lat, 73.8499211 AS lon, 6.0 AS list_max_km),
    STRUCT('N18' AS store_code, 28.5699580 AS lat, 77.3233777 AS lon, 6.0 AS list_max_km),
    STRUCT('PV1' AS store_code, 28.6681970 AS lat, 77.0945777 AS lon, 6.0 AS list_max_km),
    STRUCT('LPN' AS store_code, 28.5692718 AS lat, 77.2441075 AS lon, 6.0 AS list_max_km),
    STRUCT('MAL' AS store_code, 13.0068002 AS lat, 77.5666674 AS lon, 6.0 AS list_max_km)
  ])
),
near_pin AS (
  SELECT * FROM UNNEST(ARRAY<STRUCT<store_code STRING, pincode STRING, km FLOAT64>>[
    ('BO1', '400092', 1.656), ('BO1', '400101', 2.719), ('BO1', '400103', 3.312), ('BO1', '400068', 3.563), ('BO1', '400067', 4.067),
    ('BO1', '400097', 4.705), ('BO1', '400066', 4.789), ('BO1', '400064', 4.919), ('BO1', '400091', 5.966), ('CS1', '400071', 0.500),
    ('CS1', '400089', 1.096), ('CS1', '400024', 1.779), ('CS1', '400077', 2.121), ('CS1', '400070', 2.752), ('CS1', '400075', 3.086),
    ('CS1', '400094', 3.275), ('CS1', '400022', 3.376), ('CS1', '400086', 3.643), ('CS1', '400074', 3.908), ('CS1', '400084', 4.333),
    ('CS1', '400043', 4.340), ('CS1', '400029', 4.355), ('CS1', '400098', 4.378), ('CS1', '400088', 4.664), ('CS1', '400017', 5.016),
    ('CS1', '400051', 5.025), ('CS1', '400085', 5.067), ('CS1', '400037', 5.136), ('CS1', '400079', 5.545), ('CS1', '400019', 5.879),
    ('CS1', '400072', 5.882), ('CS1', '400099', 5.894), ('PN1', '411005', 1.062), ('PN1', '411011', 1.252), ('PN1', '411004', 1.777),
    ('PN1', '411002', 2.005), ('PN1', '411030', 2.124), ('PN1', '411016', 2.583), ('PN1', '411042', 2.588), ('PN1', '411009', 3.855),
    ('PN1', '411001', 3.941), ('PN1', '411020', 4.070), ('PN1', '411007', 4.110), ('PN1', '411003', 4.128), ('PN1', '411052', 4.653),
    ('PN1', '411008', 4.723), ('PN1', '411038', 4.961), ('PN1', '411037', 5.050), ('PN1', '411040', 5.473), ('PN1', '411006', 5.545),
    ('PN1', '411043', 5.858), ('PN1', '411051', 5.899), ('N18', '201301', 0.906), ('N18', '201303', 2.851), ('N18', '201313', 3.221),
    ('N18', '110025', 3.706), ('N18', '201307', 3.884), ('N18', '110096', 4.675), ('N18', '110091', 4.702), ('N18', '110076', 4.817),
    ('N18', '110020', 5.964), ('PV1', '110087', 0.899), ('PV1', '110063', 1.097), ('PV1', '110056', 2.460), ('PV1', '110083', 2.631),
    ('PV1', '110018', 2.943), ('PV1', '110027', 3.048), ('PV1', '110026', 3.637), ('PV1', '110034', 4.839), ('PV1', '110086', 5.036),
    ('PV1', '110064', 5.058), ('PV1', '110058', 5.093), ('PV1', '110015', 5.106), ('PV1', '110085', 5.542), ('PV1', '110028', 5.966),
    ('LPN', '110024', 0.411), ('LPN', '110065', 1.328), ('LPN', '110014', 2.030), ('LPN', '110049', 2.556), ('LPN', '110013', 2.765),
    ('LPN', '110048', 2.958), ('LPN', '110003', 3.014), ('LPN', '110019', 4.048), ('LPN', '110029', 4.271), ('LPN', '110025', 4.282),
    ('LPN', '110023', 4.390), ('LPN', '110069', 4.662), ('LPN', '110020', 4.900), ('LPN', '110017', 4.925), ('LPN', '110011', 5.259),
    ('LPN', '110016', 5.340), ('LPN', '110062', 5.572), ('LPN', '110066', 5.921), ('MAL', '560055', 0.759), ('MAL', '560003', 0.983),
    ('MAL', '560012', 1.377), ('MAL', '560080', 1.498), ('MAL', '560021', 1.613), ('MAL', '560020', 2.073), ('MAL', '560010', 2.311),
    ('MAL', '560086', 2.767), ('MAL', '560006', 3.169), ('MAL', '560054', 3.314), ('MAL', '560022', 3.360), ('MAL', '560009', 3.419),
    ('MAL', '560096', 3.583), ('MAL', '560094', 3.646), ('MAL', '560023', 3.765), ('MAL', '560032', 4.112), ('MAL', '560001', 4.123),
    ('MAL', '560053', 4.200), ('MAL', '560079', 4.235), ('MAL', '560051', 4.376), ('MAL', '560002', 5.038), ('MAL', '560018', 5.311),
    ('MAL', '560024', 5.523), ('MAL', '560040', 5.558), ('MAL', '560005', 5.613), ('MAL', '560104', 5.810), ('MAL', '560013', 5.840)
  ])
),
geo_raw AS (
  SELECT pincode, district, state, SAFE_CAST(latitude AS FLOAT64) AS lat, SAFE_CAST(longitude AS FLOAT64) AS lon
  FROM `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup`
),
district_center AS (
  -- Same rule as etl/geo_intel_sql/q10_pincode_meta.sql: a post-office point more than 75 km from
  -- its district's median is a corrupt coordinate and is snapped to that median.
  SELECT district, state, APPROX_QUANTILES(lat, 2)[OFFSET(1)] AS mlat, APPROX_QUANTILES(lon, 2)[OFFSET(1)] AS mlon
  FROM geo_raw WHERE lat BETWEEN 6 AND 38 AND lon BETWEEN 68 AND 98
  GROUP BY district, state
),
geo AS (
  SELECT g.pincode,
    IF(bad, g.mlat, g.lat) AS lat, IF(bad, g.mlon, g.lon) AS lon
  FROM (
    SELECT g.*, dc.mlat, dc.mlon,
      (g.lat IS NULL OR NOT (g.lat BETWEEN 6 AND 38 AND g.lon BETWEEN 68 AND 98)
       OR ST_DISTANCE(SAFE.ST_GEOGPOINT(g.lon, g.lat), ST_GEOGPOINT(dc.mlon, dc.mlat)) > 75000) AND dc.mlat IS NOT NULL AS bad
    FROM geo_raw g LEFT JOIN district_center dc ON dc.district = g.district AND dc.state = g.state
  ) g
),
cust_pin AS (
  -- The customer's own pincode, matched on normalised mobile, from records the customer filled in:
  -- sale delivery pincode > Shopify customer > store walk-in register > ERP party > ERP CRM
  -- customer (latest record within a source). Must be a real India Post pincode.
  -- Zoho Deal Address_Zip / Contact Mailing_Zip are NOT used: they hold one placeholder per city
  -- (562130 for Bengaluru, 400017 Mumbai, 110020 / 110001 Delhi) and match the customer's own
  -- pincode on only 18 of 140 meetings that have both. ds_imputed_reporting.customer.pincode carries
  -- the same placeholders (400019 / 562130 / 400017 are its top values), so it is not used either.
  SELECT mobile, ARRAY_AGG(STRUCT(pin, src) ORDER BY prio, ts DESC LIMIT 1)[OFFSET(0)] AS p
  FROM (
    SELECT RIGHT(REGEXP_REPLACE(IFNULL(Cus_mobile, ''), r'\D', ''), 10) AS mobile, TRIM(CAST(Pin_code AS STRING)) AS pin, 1 AS prio, 'Sale pincode' AS src,
           TIMESTAMP(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date), 'Asia/Kolkata') AS ts
    FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
    UNION ALL SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'\D', ''), 10), TRIM(CAST(zip_code AS STRING)), 2, 'Shopify customer', NULL
    FROM `lucirajewelry-prod.ds_imputed_reporting.Shopify_customer`
    UNION ALL SELECT RIGHT(REGEXP_REPLACE(IFNULL(mobile, ''), r'\D', ''), 10), CAST(pin_code AS STRING), 3, 'Walk-in register', TIMESTAMP(date)
    FROM `lucirajewelry-prod.Lucira_Prod.customer_walkin`
    UNION ALL SELECT RIGHT(REGEXP_REPLACE(IFNULL(mobile, ''), r'\D', ''), 10), CAST(pin_code AS STRING), 4, 'ERP party', NULL
    FROM `lucirajewelry-prod.ornaverse_erp_master.party`
    UNION ALL SELECT RIGHT(REGEXP_REPLACE(CAST(mobile AS STRING), r'\D', ''), 10), CAST(pin_code AS STRING), 5, 'ERP CRM customer', NULL
    FROM `lucirajewelry-prod.ornaverse_crm_data.customer`
  )
  WHERE mobile IN (SELECT mobile FROM base WHERE mobile IS NOT NULL)
    AND pin IN (SELECT pincode FROM geo)
  GROUP BY mobile
),
cust_store_km AS (
  -- km from every store to the customer's pincode: the polygon-centre km when the pincode is in the
  -- store's 6 km list; otherwise the India Post office point, never closer than list_max_km (6 km).
  SELECT cp.mobile, sp.store_code,
    COALESCE(np.km, GREATEST(ST_DISTANCE(ST_GEOGPOINT(g.lon, g.lat), ST_GEOGPOINT(sp.lon, sp.lat)) / 1000, sp.list_max_km)) AS km,
    IF(np.km IS NOT NULL, 'Pincode centre', 'Post-office point') AS km_basis
  FROM cust_pin cp
  JOIN geo g ON g.pincode = cp.p.pin
  CROSS JOIN store_pin sp
  LEFT JOIN near_pin np ON np.store_code = sp.store_code AND np.pincode = cp.p.pin
),
dist AS (
  -- Distance is measured to the MEETING's store (FCS = CS1's address); a meeting with no mapped
  -- store (or Head Office) is measured to the nearest Lucira store.
  SELECT b.meeting_id,
    ARRAY_AGG(STRUCT(k.store_code, k.km, k.km_basis)
              ORDER BY IF(k.store_code = IF(b.meeting_store_code = 'FCS', 'CS1', b.meeting_store_code), 0, 1), k.km LIMIT 1)[OFFSET(0)] AS d,
    LOGICAL_OR(k.store_code = IF(b.meeting_store_code = 'FCS', 'CS1', b.meeting_store_code)) AS to_meeting_store
  FROM base b
  JOIN cust_store_km k ON k.mobile = b.mobile
  WHERE k.km IS NOT NULL
  GROUP BY b.meeting_id
)
-- -- 6. Final: 1 row per meeting ----------------------------------------------------------
SELECT
  b.meeting_id,
  b.meeting_title,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', b.created_ts, 'Asia/Kolkata')              AS meeting_created_ist,
  DATE(b.created_ts, 'Asia/Kolkata')                                              AS meeting_created_date,
  b.from_date,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', b.from_ts, 'Asia/Kolkata')                 AS from_ist,
  b.all_day,
  -- Zoho's Check_In_Status. It reads 'PLANNED' on every record in the module (check-in is
  -- never used in this org), so it carries no information. Exposed only so the Help tab can
  -- say so honestly rather than have it look like a live status. Zoho DOES have a real
  -- Meeting_Status picklist, but it is ~3% populated AND is not carried in the CDC JSON feed,
  -- so it cannot be used here.
  b.meeting_status,
  b.meeting_title                                                                  AS meeting_type,
  -- Event_Title is free text and the same intent is spread across case and spelling variants
  -- ("Store Visit" / "store visit" / "store vist" / "store viist" / "STORE VISIT"). Grouping
  -- on the raw value splinters every breakdown, so this folds it to a category while the raw
  -- value stays available above. Test rows are matched FIRST so "Store Visit - Test" is not
  -- counted as a real store visit.
  CASE
    WHEN b.meeting_title IS NULL OR TRIM(b.meeting_title) = '' THEN NULL
    WHEN REGEXP_CONTAINS(LOWER(b.meeting_title), r'test')                    THEN 'Test / Internal'
    WHEN REGEXP_CONTAINS(LOWER(b.meeting_title), r'st[o0]re\s*v')            THEN 'Store Visit'
    WHEN REGEXP_CONTAINS(LOWER(b.meeting_title), r'vid[e]?[o0]\s*cal')       THEN 'Video Call'
    WHEN REGEXP_CONTAINS(LOWER(b.meeting_title), r'try\s*at\s*home|\btah\b') THEN 'Try at Home'
    WHEN REGEXP_CONTAINS(LOWER(b.meeting_title), r'new\s*meeting')           THEN 'New Meeting'
    WHEN REGEXP_CONTAINS(LOWER(b.meeting_title), r'follow\s*up')             THEN 'Follow Up'
    ELSE 'Other'
  END                                                                              AS meeting_type_norm,
  b.meeting_location,
  b.venue,
  b.store_name                                                                     AS zoho_store_name,
  b.meeting_store_code,
  -- A Store Name value not in the list above (e.g. a new store) is shown exactly as in Zoho. With
  -- Store Name blank, a venue naming only Mumbai / Delhi (two stores each) gets the same "store not
  -- assigned" label the Deals Funnel uses; anything else stays NULL ("Not Captured" on screen).
  CASE WHEN b.meeting_store_code IS NOT NULL THEN CONCAT(b.meeting_store_code, ' - ', sm.store_label)
       WHEN b.store_name IS NOT NULL THEN b.store_name
       WHEN REGEXP_CONTAINS(LOWER(b.venue), r'mumbai|bombay|juhu|goregaon|kh[a]?[e]?rghar|thane|andheri') THEN 'Mumbai - store not assigned'
       WHEN REGEXP_CONTAINS(LOWER(b.venue), r'delhi|gurgaon|gurugram')            THEN 'Delhi / Gurgaon - store not assigned' END AS store,
  CASE WHEN b.store_name IS NOT NULL THEN 'Zoho Store Name'
       WHEN b.venue IS NOT NULL      THEN 'Venue (Store Name blank)' END           AS store_source,
  b.meeting_owner,
  b.meeting_created_by,
  b.meeting_description,
  b.show_status,
  b.conversion_status,
  b.related_module,
  b.customer_name,
  b.mobile,
  b.mobile_source,
  b.email,
  b.contact_id,
  b.deal_id,
  b.deal_name,
  b.deal_stage,
  b.deal_trigger,
  b.probability,
  b.deal_city,
  b.deal_state,
  COALESCE(b.deal_owner, b.meeting_created_by)                                     AS jc,
  IF(b.deal_owner IS NOT NULL, 'Deal Owner', 'Meeting Created By')                 AS jc_source,
  b.lead_source,
  b.campaign_source,
  b.utm_source, b.utm_medium, b.utm_campaign,
  b.deal_store_assigned,
  b.deal_record_type,
  b.intent_stage,
  b.deal_amount,
  b.closing_date,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', b.deal_created_ts, 'Asia/Kolkata')         AS deal_created_ist,
  -- calls
  IFNULL(ca.calls_after, 0)                                                        AS calls_after,
  IFNULL(ca.connected_calls, 0)                                                    AS connected_calls,
  IFNULL(ca.missed_calls, 0)                                                       AS missed_calls,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', ca.first_call_ts, 'Asia/Kolkata')           AS first_call_ist,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', ca.last_call_ts, 'Asia/Kolkata')            AS last_call_ist,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', ca.first_connected_ts, 'Asia/Kolkata')      AS first_connected_ist,
  IFNULL(ca.talk_time_sec, 0)                                                      AS talk_time_sec,
  -- walk-ins
  IFNULL(wa.walkins_before, 0) > 0                                                 AS prev_walkin,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', wa.prev_walkin_ts, 'Asia/Kolkata')          AS prev_walkin_ist,
  wa.prev_walkin_store_code,
  IFNULL(wa.walkins_after, 0)                                                      AS walkins_after,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', wa.first_walkin_ts, 'Asia/Kolkata')         AS first_walkin_ist,
  wa.first_walkin_store_code,
  DATE_DIFF(DATE(wa.first_walkin_ts, 'Asia/Kolkata'), DATE(b.created_ts, 'Asia/Kolkata'), DAY) AS days_to_walkin,
  -- Walked in = a customer_walkin record after meeting creation OR the team marked the Zoho meeting
  -- Show_Status = 'Show' (user rule 2026-10-26). 'No Show' does not cancel a walk-in-register record.
  IFNULL(wa.walkins_after, 0) > 0 OR IFNULL(b.show_status, '') = 'Show'           AS walked_in,
  CASE WHEN IFNULL(wa.walkins_after, 0) > 0 AND b.show_status = 'Show' THEN 'Walk-in register + Zoho Show'
       WHEN IFNULL(wa.walkins_after, 0) > 0                         THEN 'Walk-in register'
       WHEN b.show_status = 'Show'                                  THEN 'Zoho Show' END AS walkin_evidence,
  -- sales
  IFNULL(sa.sales_after, 0)                                                        AS sales_after,
  IFNULL(sa.sales_amount_after, 0)                                                 AS sales_amount_after,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', sa.first_sale_ts, 'Asia/Kolkata')           AS first_sale_ist,
  sa.first_sale.amount                                                             AS first_sale_amount,
  sa.first_sale.store_code                                                         AS first_sale_store_code,
  sa.first_sale.channel                                                            AS first_sale_channel,
  sa.first_sale.skus                                                               AS first_sale_skus,
  DATE_DIFF(DATE(sa.first_sale_ts, 'Asia/Kolkata'), DATE(b.created_ts, 'Asia/Kolkata'), DAY) AS days_to_sale,
  -- customer pincode + straight-line km to the meeting's store (NULL = no customer pincode on record)
  cp.p.pin                                                                         AS customer_pincode,
  cp.p.src                                                                         AS customer_pincode_source,
  di.d.store_code                                                                  AS km_store_code,
  IF(di.d.store_code IS NULL, NULL, IF(di.to_meeting_store, 'Meeting store', 'Nearest store')) AS km_store_rule,
  ROUND(di.d.km, 2)                                                                AS km_to_store,
  di.d.km_basis                                                                    AS km_basis,
  IF(di.d.km IS NULL, NULL, di.d.km <= 5)                                          AS within_5km,
  -- journey status (priority order; a record with no customer identifier is not forced into a status)
  CASE
    WHEN (IFNULL(wa.walkins_after, 0) > 0 OR IFNULL(b.show_status, '') = 'Show') AND IFNULL(sa.sales_after, 0) > 0 THEN 'Walk-in - Sale'
    WHEN IFNULL(wa.walkins_after, 0) > 0 OR IFNULL(b.show_status, '') = 'Show'                                THEN 'Walk-in - No Sale'
    WHEN b.mobile IS NULL AND b.deal_id IS NULL AND b.contact_id IS NULL THEN 'Not Trackable (no customer ID)'
    WHEN IFNULL(sa.sales_after, 0) > 0                                   THEN 'Sale (No Walk-in)'
    WHEN IFNULL(ca.connected_calls, 0) > 0                               THEN 'Connected'
    WHEN IFNULL(ca.calls_after, 0) > 0                                   THEN 'Called'
    ELSE 'No Activity'
  END                                                                              AS journey_status,
  ca.calls,
  wa.walkins,
  sa.sales
FROM base b
LEFT JOIN store_master sm ON sm.store_code = b.meeting_store_code
LEFT JOIN call_agg   ca USING (meeting_id)
LEFT JOIN walkin_agg wa USING (meeting_id)
LEFT JOIN sale_agg   sa USING (meeting_id)
LEFT JOIN cust_pin   cp ON cp.mobile = b.mobile
LEFT JOIN dist       di USING (meeting_id)

