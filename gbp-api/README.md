# Google Business Profile → BigQuery Pipeline

Pulls Lucira's Google Business Profile (GBP) data — review count, average
rating, direction requests, call clicks — for every store location, into
`lucirajewelry-prod.ds_imputed_reporting.google_business_profile_daily`,
one row per `(report_date, location_id)`. Runs daily on Cloud Scheduler.

## Status (as of this build)

- Business Profile APIs (`mybusinessaccountmanagement`, `mybusinessbusinessinformation`,
  `businessprofileperformance`, legacy `mybusiness` for reviews) are already
  **enabled** on `lucirajewelry-prod`.
- Google requires a **separate manual API access approval** beyond enabling
  the API (7–10 business days) before quota is granted — this was submitted
  via https://support.google.com/business/contact/api_default as
  `tech@lucirajewelry.com`. **Nothing in this pipeline can make a live API
  call until that approval lands.** Check quota in Cloud Console
  (APIs & Services > Business Profile Performance API > Quotas) — 0 QPM
  means still pending, 300 QPM means approved.
- Code in this repo has not been exercised against live traffic yet for that
  reason. Once access is approved, run the one-time OAuth consent below and
  then `curl` the sync endpoints to validate end-to-end before trusting the
  Scheduler jobs.

## One-time manual setup (you do this, not the pipeline)

1. **Create an OAuth 2.0 Client ID** in Cloud Console → APIs & Services →
   Credentials → Create Credentials → OAuth client ID → type **Web
   application** → name it `gbp-pipeline` → leave Authorized redirect URIs
   empty for now (added after first deploy, see step 3). Download nothing;
   just copy the **Client ID** and **Client Secret** shown on screen.
2. **Configure the OAuth consent screen** (if not already done for this
   project) as **Internal** (Lucira Workspace only) or **External** with
   `tech@lucirajewelry.com` as a test user, scope
   `https://www.googleapis.com/auth/business.manage`.
3. **Deploy** (`./deploy.sh`, after `export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... SYNC_TOKEN=...`
   in your shell — never commit these). Deploy prints the Cloud Run URL.
4. **Add the redirect URI**: back in Credentials, edit the OAuth client and
   add `<service-url>/oauth/callback` as an Authorized redirect URI. Update
   the Cloud Run service with `GOOGLE_REDIRECT_URI=<service-url>/oauth/callback`.
5. **Complete consent once**: visit `<service-url>/oauth/login` signed in as
   `tech@lucirajewelry.com` (the account that manages Lucira's listings in
   business.google.com), approve access. The refresh token is saved to
   `gs://lucira-dashboards/oauth/gbp_refresh_token.json` — after this, the
   daily job needs no further manual login.
6. Run `/sync/locations` once, review any `store_code IS NULL` rows in
   `google_business_profile_locations` (via `sql/validation.sql` query 2) and
   fix the mapping manually if the fuzzy match missed a store.
7. Run `/backfill?days=540` once for history, then let the scheduled
   `/sync/daily` job take over.

## Architecture

```
google-business-profile (this repo)
├── app/
│   ├── config.py          env-driven config, table names, API base URLs
│   ├── oauth.py           Google OAuth2 (business.manage scope), refresh
│   │                      token persisted in GCS (same pattern as
│   │                      zoho-login-dashboard) — no secrets hardcoded
│   ├── gbp_accounts.py    Account Management API (accounts.list, paginated)
│   ├── gbp_locations.py   Business Information API (locations.list) +
│   │                      fuzzy match to store_location_store_master +
│   │                      MERGE into google_business_profile_locations
│   ├── gbp_reviews.py     legacy v4 reviews API — review_count/avg_rating
│   │                      come from ListReviewsResponse's own aggregate
│   │                      fields; full pagination available for validation
│   ├── gbp_performance.py Business Profile Performance API
│   │                      (fetchMultiDailyMetricsTimeSeries) — CALL_CLICKS,
│   │                      BUSINESS_DIRECTION_REQUESTS only
│   ├── bigquery.py        staging-table + MERGE upsert into the daily table
│   └── logging_utils.py   retry/backoff + google_business_profile_api_log
├── main.py                Flask/Cloud Run routes
├── sql/                   CREATE TABLE + validation queries
├── deploy.sh              gcloud run deploy + Scheduler jobs (review before running)
├── Dockerfile
└── requirements.txt
```

## Why reviews aren't a daily time series

The Performance API gives per-day metrics, but the Reviews API only exposes
current state (total count + average rating), not historical daily values.
So `review_count`/`average_rating` in the daily table are the *current*
snapshot value, written against every date row touched by that sync run —
this is Google's actual data shape, not a simplification on our side.

## Metrics intentionally NOT included

The Performance API also exposes `WEBSITE_CLICKS`,
`BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`, `BUSINESS_IMPRESSIONS_MOBILE_MAPS`,
etc. These are left out of `google_business_profile_daily` per the
"don't add metrics beyond what's asked" instruction — add to
`config.DAILY_METRICS` and the table schema if wanted later.

## Endpoints

- `GET /health` — liveness + whether OAuth is connected
- `GET /oauth/login`, `GET /oauth/callback` — one-time consent
- `POST /sync/locations` — account/location discovery (weekly scheduled)
- `POST /sync/daily` — reprocesses the last 7 days (daily scheduled, 09:00 IST)
- `POST /backfill?days=N` — historical load, N capped at `MAX_BACKFILL_DAYS` (540)
- `GET /test/sample` — most recent row from the daily table, for validation only
  (BigQuery is the source of truth, not this endpoint)

`/sync/*` and `/backfill` require an `X-Sync-Token` header matching the
`SYNC_TOKEN` env var (set from Secret Manager in production).

## Security

No client secret, access token, or refresh token is ever hardcoded, logged,
or committed — see `.gitignore`. Refresh token lives only in the
`lucira-dashboards` GCS bucket; access tokens are minted per-request and
kept in memory only.
