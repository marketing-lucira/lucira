# Meeting → Call → Walk-in → Sale Intelligence (Cloud Run: `store-visit-intelligence`)

Live dashboard for one journey only: **Zoho CRM meeting created → call after creation → walk-in
after creation → sale after creation**. No GA4, PDP, product-view or website analytics data is used.

URL: https://store-visit-intelligence-3mvv5mdr2q-el.a.run.app (HTTP Basic Auth, unchanged)

## Architecture

```
zoho_crm.cdc_meetings / cdc_deals / cdc_calls / cdc_contacts   (Zoho CDC sync, every 30 min)
zoho_crm.zoho_leads                                            (Lead mobile fallback)
ds_imputed_reporting.Walkin_marge                               (store walk-ins, daily ~06:30 IST)
ds_imputed_reporting.marketing_sale                             (sales)
ornaverse_erp_master.company                                    (store code -> name)
        │
        ▼
ds_imputed_reporting.zoho_meeting_journey_v   (VIEW, sql/meeting_journey_view.sql, 1 row per meeting)
        │  one query per cache window (CACHE_TTL_SEC, default 600 s), ~240 MB scanned
        ▼
main.py  /api/journey  (+ /api/health)  ── gzip JSON, Basic Auth
        ▼
index.html + journey.js   (3 tabs; all filtering client-side over ~550 rows)
```

* No Zoho OAuth credentials are used by this service; it only reads BigQuery with its runtime SA.
* `DASH_USER` / `DASH_PASS` stay Cloud Run env vars (never in code or frontend JS).

## Tabs
1. **Created Time** – grouped by Meeting Created Date (IST).
2. **From Date / Today** – grouped by meeting `Start_DateTime` (IST); "Today's Expected Visits" = From Date = today IST.
   Calls / walk-ins / sales are still counted from the meeting's **Created Time**.
3. **Help / Logic** – definitions, sources, join/matching logic, live source status.

## Key logic (full detail in the Help tab and the SQL header)
* Call after creation: `Call_Start_Time > meeting Created_Time`; Outbound + Inbound; excludes Scheduled/Overdue
  (never happened) and Missed. Matched by Deal ID, else Contact ID, else normalised phone; DISTINCT call id.
* Connected: duration ≥ 30 s.
* Walk-in: `Walkin_marge` phone = customer mobile. `walkin_date` is +05:30 vs POS invoice time
  (verified on 1,002 exact matches) → IST = `walkin_date − 330 min`. Amazon/HO codes excluded.
* Sale: `marketing_sale` invoice (distinct `document_no`, amount = `SUM(net_sale)`, time = `document_date` IST)
  `> Created_Time`, mobile-matched.
* Anti fan-out: calls, walk-ins and sales are each aggregated per meeting before joining back.
* Meeting Type (`meeting_type_norm`) is derived in the view from the free-text meeting title, which holds
  the same intent in many spellings (23 raw variants of "Store Visit" fold to one). Titles mentioning
  "test" become `Test / Internal` so they are not counted as real store visits; the raw title is kept.
* Meeting **Status** is deliberately not offered as a filter/KPI: Zoho's `Check_In_Status` is `PLANNED` on
  every record (no information), and the real `Meeting_Status` picklist is ~3% populated and absent from
  the CDC feed.

## Deploy / redeploy
```bash
# 1) (re)create the view if the SQL changed
bq query --use_legacy_sql=false < sql/meeting_journey_view.sql
# 2) deploy the service (keeps existing env vars / IAM)
gcloud run deploy store-visit-intelligence --source . --project=lucirajewelry-prod --region=asia-south1
```

## Validation
`python validation/validate_meetings.py` picks real meetings for each case (no call, one call, multiple calls,
previous walk-in, walk-in after, sale after, walk-in + sale, sale without walk-in, different JC, different
city/stage/trigger, call before creation) and recomputes them from the raw tables in Python. Last run
(29 Sep 2026): 11/11 match. Results in `validation/validate_meetings_results.json`.
