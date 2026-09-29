-- Store Visit & Sales Conversion Intelligence -- "Meeting Intelligence" tab (Tab 0).
-- Pulls ALL Zoho CRM Events/Meetings from cdc_meetings, regardless of $se_module/What_Id --
-- i.e. the FULL Meetings module, not just deal-linked meetings (which is what svci_build.sql's
-- `m` subquery restricts to). cdc_meetings is a CDC table (one row can theoretically be appended
-- per change), so this dedupes defensively in Python on JSON_VALUE(data,'$.id') even though a
-- live check (2026-09-17) found 370 rows / 370 distinct ids -- i.e. currently no duplicates.
--
-- Column mapping used downstream by build_svci_data.py:
--   Store Name / Used Location <- Venue (same field, shown twice per client spec)
--   Create Date                <- date part of Created_Time (daily counts group on this)
--   From                       <- Start_DateTime
--   Title                      <- Event_Title
-- NOTE: there is no "Location" field on Events/Meetings -- never request it, it is silently
-- dropped by the Zoho API.
SELECT
  JSON_VALUE(data,'$.id')             AS id,
  JSON_VALUE(data,'$.Event_Title')    AS event_title,
  JSON_VALUE(data,'$.Venue')          AS venue,
  JSON_VALUE(data,'$.Created_Time')   AS created_time,
  JSON_VALUE(data,'$.Start_DateTime') AS start_datetime,
  JSON_VALUE(data,'$.End_DateTime')   AS end_datetime,
  JSON_VALUE(data,'$.Owner.name')     AS owner_name
FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
