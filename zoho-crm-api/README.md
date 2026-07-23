# Lucira CRM Performance Dashboard

A modern executive CRM dashboard for Zoho CRM (Deals · Calls · Events) with
unique-deal logic, deal↔call connectivity/SLA, executive scorecards and AI
insights. Two pieces:

| File | Role |
|------|------|
| `zoho-crm-api/main.py` | Cloud Function that pulls raw Deals/Calls/Events from Zoho and returns compact JSON (the live, auto-refreshing data source). |
| `dashboard/crm-dashboard.html` | Self-contained dashboard. Computes **all** business logic client-side. Works offline with a labelled sample dataset; switches to live data once `API_BASE` is set. |

## How it works

The dashboard does the heavy lifting in the browser so the logic stays visible
and tweakable:

- **Unique Deal** = distinct `Mobile` (normalised to last 10 digits) + `Created_Time` date.
  Duplicate rows for the same customer on the same day collapse to one. This is the
  default metric everywhere; **Total Deals** is shown alongside.
- **Deal ↔ Call join** = `Call.What_Id.id == Deal.id` (the linkage Zoho actually
  populates — ~84% of calls; phone numbers are mostly blank on scheduled calls).
- **First-call response** = earliest `Call_Start_Time` across a unique deal's rows,
  minus the deal's creation time → bucketed (≤5/10/15/30 min, 30–60, 1–2h, >2h, never).
- **Connected call** = `Call_Duration_in_seconds > 0`. **Missed** = `Call_Type = 'Missed'`.
- Labels are normalised (trim + case-merge + URL-decode) so `productview` / `ProductView`
  / `NitroProductView` and `Not+interested` don't fragment the charts.

## Deploy the API (live data)

1. **Create a Zoho self-client / server-based OAuth app** (already done — reuse the
   creds from `zoho-task-function`) with scope `ZohoCRM.coql.READ,ZohoCRM.modules.READ`.

2. **Deploy** (India DC shown; matches your existing function):

   ```bash
   cd zoho-crm-api
   gcloud functions deploy zoho-crm-data \
     --gen2 --runtime=python312 --region=asia-south1 \
     --source=. --entry-point=crm_data --trigger-http --allow-unauthenticated \
     --memory=512Mi --timeout=120 \
     --set-env-vars=ZOHO_DC=in,ZOHO_CLIENT_ID=xxx,ZOHO_CLIENT_SECRET=xxx,ZOHO_REFRESH_TOKEN=xxx
   ```

3. **Test:** `curl "https://<url>/zoho-crm-data?days=30&debug=1"` → JSON with
   `deals`, `calls`, `events` arrays and a `debug` count block.

4. **Wire the dashboard:** open `dashboard/crm-dashboard.html`, set at the top:

   ```js
   const CONFIG = { API_BASE: "https://<your-cloud-function-url>", WINDOW_DAYS: 120, ... };
   ```

   Reload — the header pill turns green ("Live · Zoho CRM"), full history loads, and
   it auto-refreshes every 5 minutes (`REFRESH_MS`).

### Query params
- `days` — history window in days (default 120; `0` = all history, heavier).
- `debug=1` — include per-module counts + timing.

## ⚠️ Security

`zoho-task-function/main.py` currently has the Zoho **Client Secret and Refresh
Token hardcoded in source**. Anyone with repo access can pull all CRM data. You
should:
1. **Rotate** those credentials in the Zoho API console.
2. Move them to environment variables (this new `zoho-crm-api/main.py` already
   reads from `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN`).
3. Consider requiring auth on the Cloud Function (drop `--allow-unauthenticated`)
   and calling it through an authenticated proxy, since it exposes customer PII.

## Notes
- The sample dataset in the HTML is generated deterministically from your **real
  measured distributions** (owners, stages, sources, trigger events, connectivity
  rates) so every panel is populated before you connect the API. It is clearly
  flagged "Sample data" in the header.
- Single Zoho pipeline detected — `Stage` is the pipeline stage. If you enable
  multiple pipelines later, add the `Pipeline` field to `DEAL_FIELDS` and a matching
  filter.
