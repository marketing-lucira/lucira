-- ========================================================================================
--  Store Visit meetings  (1 row = 1 Zoho CRM Meeting, every meeting type)
--  View: lucirajewelry-prod.ds_imputed_reporting.zoho_store_visit_meetings_v
--  Read by store-visit-intelligence-app/main.py (/api/deal-funnel -> "meetings").
--  The Deals Funnel tab counts "Store Visit" = meetings RAISED (Created_Time, IST) in the selected
--  date range; agent / store / store city are taken from the linked deal in
--  zoho_deal_store_funnel_v (joined in the browser on deal_id), falling back to the meeting itself.
-- ========================================================================================
CREATE OR REPLACE VIEW `lucirajewelry-prod.ds_imputed_reporting.zoho_store_visit_meetings_v`
OPTIONS (description = "1 row per Zoho CRM meeting (all types) with its deal_id, raised date (IST), venue store. Built by store-visit-intelligence-app/sql/store_visit_meetings_view.sql") AS
WITH m AS (
  SELECT
    id                                                    AS meeting_id,
    JSON_VALUE(data, '$.Event_Title')                     AS meeting_title,
    JSON_VALUE(data, '$."$se_module"')                    AS module,
    JSON_VALUE(data, '$.What_Id.id')                      AS what_id,
    JSON_VALUE(data, '$.Who_Id.id')                       AS who_id,
    JSON_VALUE(data, '$.Created_By.name')                 AS created_by,
    JSON_VALUE(data, '$.Venue')                           AS venue,
    TIMESTAMP(JSON_VALUE(data, '$.Created_Time'))         AS created_ts,
    IF(SAFE_CAST(JSON_VALUE(data, '$.All_day') AS BOOL), SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(JSON_VALUE(data, '$.Start_DateTime'), 1, 10)),
       DATE(TIMESTAMP(JSON_VALUE(data, '$.Start_DateTime')), 'Asia/Kolkata'))                AS visit_date,
    LOWER(IFNULL(JSON_VALUE(data, '$.Venue'), ''))        AS v,
    NULLIF(TRIM(JSON_VALUE(data, '$.Store_Name')), '')    AS store_name
  FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
),
-- Contact-linked meetings: attribute to that contact's latest deal created before the meeting.
contact_deal AS (
  SELECT m.meeting_id, ARRAY_AGG(d.id ORDER BY TIMESTAMP(JSON_VALUE(d.data, '$.Created_Time')) DESC LIMIT 1)[OFFSET(0)] AS deal_id
  FROM m JOIN `lucirajewelry-prod.zoho_crm.cdc_deals` d
    ON m.module = 'Contacts' AND JSON_VALUE(d.data, '$.Contact_Name.id') = m.who_id
   AND TIMESTAMP(JSON_VALUE(d.data, '$.Created_Time')) < m.created_ts
  GROUP BY m.meeting_id
)
SELECT
  m.meeting_id,
  m.meeting_title,
  m.module,
  IF(m.module = 'Deals', m.what_id, cd.deal_id)                                  AS deal_id,
  m.created_by,
  m.venue,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', m.created_ts, 'Asia/Kolkata')             AS created_ist,
  DATE(m.created_ts, 'Asia/Kolkata')                                              AS created_date,
  m.visit_date,
  -- Meeting store = Zoho "Store - Name" (Store_Name) as selected on the meeting; Venue keywords only
  -- when Store_Name is blank (meetings before the field was in use, ~22 Sep 2026). Head Office -> none.
  CASE
    WHEN m.store_name IS NOT NULL THEN
      CASE m.store_name
        WHEN 'Borivali Store'      THEN 'BO1'
        WHEN 'Chembur Store'       THEN 'CS1'
        WHEN 'Lajpat Nagar Store'  THEN 'LPN'
        WHEN 'Paschim Vihar Store' THEN 'PV1'
        WHEN 'Noida Store'         THEN 'N18'
        WHEN 'Pune Store'          THEN 'PN1'
        WHEN 'Malleshwaram Store'  THEN 'MAL'
      END
    WHEN REGEXP_CONTAINS(m.v, r'bori')                                   THEN 'BO1'
    WHEN REGEXP_CONTAINS(m.v, r'chemb|chmb|chmeb|chamber')               THEN 'CS1'
    WHEN REGEXP_CONTAINS(m.v, r'lajpat|lachpat')                         THEN 'LPN'
    WHEN REGEXP_CONTAINS(m.v, r'paschim|pashchim|pashim|pachim|panchim|pashcim|ppashcim') THEN 'PV1'
    WHEN REGEXP_CONTAINS(m.v, r'noida')                                  THEN 'N18'
    WHEN REGEXP_CONTAINS(m.v, r'pune')                                   THEN 'PN1'
    WHEN REGEXP_CONTAINS(m.v, r'mallesh|malleswar|m[ae]l+[ae]?s[hg]?w[ae]?r|mallikarjun|b[ae]?n[ae]?g[ae]?l[ou]r') THEN 'MAL'
  END                                                                             AS venue_store
FROM m
LEFT JOIN contact_deal cd USING (meeting_id)

