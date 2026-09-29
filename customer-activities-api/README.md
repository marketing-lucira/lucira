# Customer Activities Intelligence API

Live Zoho CRM backend for `dashboard/customer-activities-intelligence.html`. No BigQuery, no static snapshot, no mock data — every request re-pulls from Zoho CRM (India DC) directly via OAuth, matching the dashboard's strict data-source requirement.

**Deployed:** Cloud Run, project `lucirajewelry-prod`, region `asia-south1` — `https://customer-activities-api-385594025448.asia-south1.run.app` (public, `--allow-unauthenticated`, CORS `*`, matching the `zoho-crm-bundle-public` pattern used by other Lucira dashboards). `dashboard/cai.js` `CONFIG.API_BASE` already points here. Currently returns a graceful `invalid_client` error on every call — no real Zoho credentials are set yet.

To add real credentials once you have a Self Client refresh token, update the Cloud Run service's env vars directly (no redeploy needed):
```
gcloud run services update customer-activities-api --project=lucirajewelry-prod --region=asia-south1 \
  --set-env-vars=ZOHO_CLIENT_ID=...,ZOHO_CLIENT_SECRET=...,ZOHO_REFRESH_TOKEN=...,ZOHO_DOMAIN=zoho.in,CUSTOMER_ACTIVITY_FIELD=Customer_Activities
```
Same pattern for the Ask AI tab's Gemini key:
```
gcloud run services update customer-activities-api --project=lucirajewelry-prod --region=asia-south1 \
  --update-env-vars=GEMINI_API_KEY=...
```

## Setup

1. In the [Zoho API Console](https://api-console.zoho.in/) create/reuse a **Self Client**, generate a code, then a refresh token with these scopes:
   - `ZohoCRM.modules.deals.READ`
   - `ZohoCRM.modules.calls.READ`
   - `ZohoCRM.settings.fields.READ`
2. `cp .env.example .env` and fill in `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`.
3. `npm install`
4. `npm run discover-fields` — finds the real Zoho API name of the "Customer Activities" custom field on Deals (custom field labels almost never match their `api_name`). Paste the confirmed name into `.env` as `CUSTOMER_ACTIVITY_FIELD`.
5. For the **Ask AI** tab: get a free key at the [Google AI Studio API key page](https://aistudio.google.com/apikey) and set it as `GEMINI_API_KEY` in `.env` (optional — every other tab works without it; Ask AI just returns a "not configured" error until it's set).
6. `npm start` — serves the API on `http://localhost:3100` (see `PORT` in `.env`).
7. Open `dashboard/customer-activities-intelligence.html` — it points at `http://localhost:3100` by default (`cai.js` `CONFIG.API_BASE`). Update that constant once this API is deployed somewhere reachable by the dashboard's real hosting origin.

## Endpoints

- `GET /api/meta` — confirms whether `CUSTOMER_ACTIVITY_FIELD` actually resolves to a real Deals field.
- `GET /api/report?range=today|yesterday|7d|30d|custom&start=YYYY-MM-DD&end=YYYY-MM-DD&owner=<name>|all&refresh=true` — full report bundle: KPIs for the selected range + all four quick-range presets, deal-stage distribution, hourly breakdown, FRT distribution, not-called list, full detail table, 30-day daily trend, data-quality counters. `owner` scopes everything to one Deal Owner (omit or `all` for everyone).
- `POST /api/chat?range=...&owner=...` with JSON body `{ "question": "..." }` — powers the dashboard's "Ask AI" tab. Answers via Gemini, grounded strictly in the same report bundle `/api/report` would return for those query params (no separate Zoho pull). Requires `GEMINI_API_KEY` — see Setup below.

## How the numbers are computed

See the dashboard's own **Logic** tab — it documents the exact pipeline (mobile cleaning, per-day dedup, call-matching tiers, FRT, working-hours rule) end to end, mirroring `src/activityService.js`.

## Known limitation

The Zoho REST Search API used for `Deals/search` doesn't support the `OR`-style cascade described in spec section 7 ("strongest available relationship") as a single query — the three-tier match (Deal ID → Contact ID → mobile) is done client-side in `buildCallIndexes`/`callsForDeal` after fetching Calls for the window, not server-side.
