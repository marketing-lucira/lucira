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
--    ds_imputed_reporting.Walkin_marge     Store walk-ins (same source as Walk-in Source Intelligence)
--    ds_imputed_reporting.marketing_sale   Sales (line-item grain)
--    ornaverse_erp_master.company          Store code -> store name (ERP master)
--
--  Anti fan-out: meeting base is built first; calls / walk-ins / sales are each AGGREGATED per
--  meeting in their own CTE and only then LEFT JOINed back on meeting_id. Meeting x Calls x
--  Walk-ins x Sales is never joined directly.
--
--  Time zone: every comparison is done on absolute TIMESTAMPs; every displayed value is IST.
--    * Zoho Created_Time / Call_Start_Time / Start_DateTime carry an explicit offset -> TIMESTAMP().
--    * marketing_sale.document_date is IST wall-clock "DD-MM-YYYY HH:MM:SS" -> TIMESTAMP(.., 'Asia/Kolkata').
--    * Walkin_marge.walkin_date is shifted +05:30 vs the matching POS document_date (verified on
--      1,002 exact walk-in<->invoice matches: diff = +330 min). True IST = walkin_date - 330 min.
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
    JSON_VALUE(data, '$.Meeting_Venue__s')               AS meeting_location,
    JSON_VALUE(data, '$.Check_In_Status')                AS meeting_status,
    JSON_VALUE(data, '$."$se_module"')                   AS related_module,
    JSON_VALUE(data, '$.What_Id.id')                     AS what_id,
    JSON_VALUE(data, '$.Who_Id.id')                      AS who_id,
    JSON_VALUE(data, '$.Who_Id.name')                    AS who_name,
    JSON_VALUE(data, '$.Owner.name')                     AS meeting_owner,
    JSON_VALUE(data, '$.Created_By.name')                AS meeting_created_by,
    JSON_VALUE(data, '$.Description')                    AS meeting_description
  FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
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
         JSON_VALUE(data, '$.Phone')     AS contact_phone
  FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
  WHERE id IN (SELECT contact_id FROM m1)
),
lead AS (
  SELECT record_id AS lead_id,
         LAX_STRING(lead_data.Mobile)    AS lead_mobile,
         LAX_STRING(lead_data.Phone)     AS lead_phone,
         LAX_STRING(lead_data.Full_Name) AS lead_full_name
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
    -- From Date: Start_DateTime in IST. All-day meetings are stored as 00:00 UTC of the calendar
    -- day, so their date part is taken as-is (converting would still land on the same day).
    IF(m1.all_day, SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(m1.start_raw, 1, 10)),
       DATE(TIMESTAMP(m1.start_raw), 'Asia/Kolkata'))                                   AS from_date,
    IF(m1.all_day, NULL, TIMESTAMP(m1.start_raw))                                       AS from_ts,
    -- Meeting store: free-text Venue mapped to an ERP store code by keyword; raw Venue kept as-is.
    CASE
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'bori')                                  THEN 'BO1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'chemb|chmb|chmeb|chamber')              THEN 'CS1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'lajpat|lachpat')                        THEN 'LPN'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'paschim|pashchim|pashim|pachim|pashcim|pashchim|ppashcim') THEN 'PV1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'noida')                                 THEN 'N18'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'pune')                                  THEN 'PN1'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(m1.venue, '')), r'mallesh|malleswar')                     THEN 'MAL'
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
  -- A call belongs to a meeting when it started strictly AFTER the meeting was created AND it is
  -- linked by Deal ID (What_Id), else Contact ID (Who_Id), else normalised customer mobile.
  -- DISTINCT call_id: a call matched by more than one key is still counted once.
  SELECT DISTINCT b.meeting_id, c.call_id, c.call_ts, c.dur, c.call_type, c.call_owner,
    CASE WHEN c.what_id = b.deal_id THEN 'Deal ID' WHEN c.who_id = b.contact_id THEN 'Contact ID' ELSE 'Mobile' END AS match_key
  FROM base b
  JOIN calls c
    ON c.call_ts > b.created_ts
   AND (   (b.deal_id    IS NOT NULL AND c.what_id = b.deal_id)
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
  SELECT DISTINCT
    RIGHT(REGEXP_REPLACE(phone, r'\D', ''), 10)                                          AS mobile,
    TIMESTAMP(DATETIME_SUB(SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date), INTERVAL 330 MINUTE), 'Asia/Kolkata') AS walkin_ts,
    store_code
  FROM `lucirajewelry-prod.ds_imputed_reporting.Walkin_marge`
  WHERE event_name = 'StoreVisit'
    AND IFNULL(store_code, '') NOT IN ('Amazon', 'HO')     -- not physical customer-facing stores
    AND REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(phone, ''), r'\D', ''), 10), r'^[6-9][0-9]{9}$')
    AND SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date) IS NOT NULL
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
  JOIN walkins w ON w.mobile = b.mobile
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
)
-- -- 5. Final: 1 row per meeting ----------------------------------------------------------
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
  b.meeting_store_code,
  CASE WHEN b.meeting_store_code IS NOT NULL THEN CONCAT(b.meeting_store_code, ' - ', sm.store_label)
       WHEN b.venue IS NOT NULL THEN CONCAT('Unmapped: ', b.venue) END             AS store,
  b.meeting_owner,
  b.meeting_created_by,
  b.meeting_description,
  b.related_module,
  b.customer_name,
  b.mobile,
  b.mobile_source,
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
  -- sales
  IFNULL(sa.sales_after, 0)                                                        AS sales_after,
  IFNULL(sa.sales_amount_after, 0)                                                 AS sales_amount_after,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', sa.first_sale_ts, 'Asia/Kolkata')           AS first_sale_ist,
  sa.first_sale.amount                                                             AS first_sale_amount,
  sa.first_sale.store_code                                                         AS first_sale_store_code,
  sa.first_sale.channel                                                            AS first_sale_channel,
  sa.first_sale.skus                                                               AS first_sale_skus,
  DATE_DIFF(DATE(sa.first_sale_ts, 'Asia/Kolkata'), DATE(b.created_ts, 'Asia/Kolkata'), DAY) AS days_to_sale,
  -- journey status (priority order; a record with no customer identifier is not forced into a status)
  CASE
    WHEN b.mobile IS NULL AND b.deal_id IS NULL AND b.contact_id IS NULL THEN 'Not Trackable (no customer ID)'
    WHEN IFNULL(wa.walkins_after, 0) > 0 AND IFNULL(sa.sales_after, 0) > 0 THEN 'Walk-in - Sale'
    WHEN IFNULL(wa.walkins_after, 0) > 0                                 THEN 'Walk-in - No Sale'
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
