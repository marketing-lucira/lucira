-- Store Visit & Sales Conversion Intelligence -- canonical deal-grain build query.
-- Run by build_svci_data.py via `bq query`. Produces ONE ROW PER DEAL (22,819 rows expected).
--
-- Journey modeled: Deal Created -> Agent Call Attempts -> Meeting Raised -> Store Assigned
-- (Meeting Store) -> Store Visit -> Store Follow-up Call -> Sale.
--
-- Reuses the already-validated joins from sql/dcm_build.sql (sibling dashboard, same session):
--   - Calls join: Calls.what_id = Deals.id (validated, no mobile-fallback for calls)
--   - Meeting join: cdc_meetings JSON What_Id.id = Deals.id, first meeting by created_time_ist
-- Deliberately NOT done here (done in Python, see build_svci_data.py):
--   - meetings_sheet_sync (Store Visit / Store Called) join -- mobile-only, one-to-many, needs
--     the "closest date on/after" honesty rule applied in Python, not a SQL fan-out join.
--   - marketing_sale join -- same reason (mobile-only, "first sale on/after" rule).
-- Deals.Store_Assigned is intentionally NEVER selected here -- verified 0% populated, unusable.

SELECT
  d.id                    AS deal_id,
  d.Deal_Owner             AS agent,
  d.Deal_Name              AS deal_name,
  d.Contact_Name           AS contact_name,
  d.Mobile                 AS mobile,
  d.Email                  AS email,
  d.Lead_Source            AS lead_source,
  d.Stage                  AS stage,
  d.UTM_Source             AS utm_source,
  d.UTM_Medium             AS utm_medium,
  d.UTM_Campaign           AS utm_campaign,
  d.Campaign_Source        AS campaign_source,
  d.Creat_time             AS created_date,
  d.Address_City           AS address_city,
  d.Address_State          AS address_state,
  d.Amount                 AS amount,

  c.total_calls, c.total_call_seconds,
  c.call1_sec, c.call1_time,
  c.call2_sec, c.call2_time,
  c.call3_sec, c.call3_time,

  m.event_title            AS meeting_event_title,
  m.venue                  AS meeting_venue,
  m.owner_name             AS meeting_owner,
  m.created_by_name        AS meeting_created_by,
  m.description             AS meeting_description,
  m.meeting_raised_date,
  m.meeting_raised_time

FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals` d

LEFT JOIN (
  SELECT
    what_id AS deal_id,
    COUNT(*) AS total_calls,
    SUM(IFNULL(Call_Duration_in_seconds,0)) AS total_call_seconds,
    MAX(IF(call_rank=1, Call_Duration_in_seconds, NULL)) AS call1_sec,
    MAX(IF(call_rank=1, Call_Start_Time, NULL))          AS call1_time,
    MAX(IF(call_rank=2, Call_Duration_in_seconds, NULL)) AS call2_sec,
    MAX(IF(call_rank=2, Call_Start_Time, NULL))          AS call2_time,
    MAX(IF(call_rank=3, Call_Duration_in_seconds, NULL)) AS call3_sec,
    MAX(IF(call_rank=3, Call_Start_Time, NULL))          AS call3_time
  FROM (
    SELECT
      what_id, Call_Start_Time, Call_Duration_in_seconds,
      ROW_NUMBER() OVER (PARTITION BY what_id ORDER BY Call_Start_Time) AS call_rank
    FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls`
    WHERE what_id IS NOT NULL
  )
  GROUP BY what_id
) c ON c.deal_id = d.id

LEFT JOIN (
  SELECT deal_id, event_title, venue, owner_name, created_by_name, description,
         meeting_raised_time, DATE(meeting_raised_time) AS meeting_raised_date
  FROM (
    SELECT
      JSON_VALUE(data,'$.What_Id.id')     AS deal_id,
      JSON_VALUE(data,'$.Event_Title')    AS event_title,
      JSON_VALUE(data,'$.Venue')          AS venue,
      JSON_VALUE(data,'$.Owner.name')     AS owner_name,
      JSON_VALUE(data,'$.Created_By.name') AS created_by_name,
      JSON_VALUE(data,'$.Description')    AS description,
      DATETIME(TIMESTAMP(JSON_VALUE(data,'$.Created_Time')), 'Asia/Kolkata') AS meeting_raised_time,
      ROW_NUMBER() OVER (
        PARTITION BY JSON_VALUE(data,'$.What_Id.id')
        ORDER BY DATETIME(TIMESTAMP(JSON_VALUE(data,'$.Created_Time')), 'Asia/Kolkata')
      ) AS mtg_rank
    FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
    WHERE JSON_VALUE(data,'$.What_Id.id') IS NOT NULL
  )
  WHERE mtg_rank = 1
) m ON m.deal_id = d.id
