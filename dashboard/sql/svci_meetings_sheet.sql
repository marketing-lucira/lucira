-- Raw pull of the Store Visit / Store Follow-up source sheet (928 rows). Joined to deals by
-- normalized mobile in Python (build_svci_data.py) -- NOT here, because a mobile can map to
-- multiple deals/sheet rows and the "closest date on/after" honesty rule is easier to apply
-- in Python.
--
-- action: "Store Visit" (694) / "Video Call" (219) / "TAH" (15) -- the meeting TYPE.
-- show_no_show: "Show" / "No Show" / "WIP" / NULL -- genuine visit attendance.
-- Store Visit Confirmed = action = 'Store Visit' AND show_no_show = 'Show' (52 rows, verified
-- live 2026-09-16). This is a real, distinct, non-fabricated attendance signal -- do not widen
-- it to include Video Call/TAH rows or WIP/null status.
SELECT
  row_num, customer_name, mobile, meeting_date, action, store, call_status,
  agent, deal_source, product, conversion_status, show_no_show
FROM `lucirajewelry-prod.Lucira_Prod.meetings_sheet_sync`
