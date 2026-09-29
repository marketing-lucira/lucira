-- Store City & Agent-wise Deals -> Calls -> Meetings -> Store Follow-up -> Sales Intelligence
-- Canonical deal-grain build query, run by build_dcm_data.py via `bq query`.
--
-- Produces ONE ROW PER DEAL (22,819 rows expected) with:
--   - deal core fields (city/agent/created date/source honestly as-is, including empty Address_City)
--   - call attempt 1/2/3 + totals, joined via Calls.what_id = Deals.id (the validated join key;
--     no mobile-fallback join is used for calls per the brief)
--   - first Meeting Raised (by created_time_ist) joined via cdc_meetings JSON What_Id.id = Deals.id
--
-- Deliberately NOT done in this query (done in Python instead, see build_dcm_data.py):
--   - meetings_sheet_sync (Meeting Store / Store Called) join — mobile-only, one-to-many, needs the
--     "closest date on/after" honesty rule applied in Python, not a SQL fan-out join.
--   - marketing_sale join — same reason (mobile-only, "first sale on/after" rule).
-- Store_Assigned on Deals is intentionally NEVER selected here — verified 0% populated, unusable.

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
  SELECT deal_id, event_title, venue, owner_name, meeting_raised_time, DATE(meeting_raised_time) AS meeting_raised_date
  FROM (
    SELECT
      JSON_VALUE(data,'$.What_Id.id')     AS deal_id,
      JSON_VALUE(data,'$.Event_Title')    AS event_title,
      JSON_VALUE(data,'$.Venue')          AS venue,
      JSON_VALUE(data,'$.Owner.name')     AS owner_name,
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
