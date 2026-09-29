-- Raw pull of the Store Follow-up source sheet (928 rows). Joined to deals by normalized
-- mobile in Python (build_dcm_data.py) — NOT here, because a mobile can map to multiple
-- deals/sheet rows and the "closest date on/after" honesty rule is easier to apply in Python.
SELECT
  row_num, customer_name, mobile, meeting_date, action, store, call_status,
  agent, deal_source, product, conversion_status, show_no_show
FROM `lucirajewelry-prod.Lucira_Prod.meetings_sheet_sync`
