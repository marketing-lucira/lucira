# Lucira Hourly Store & Digital Intelligence

Live operational dashboard: `dashboard/hourly-store-intelligence.html` (+ `hsi.js`, `hsi-views.js`).
100% real data, zero mock/sample fallback. It fetches five live public endpoints directly from
the browser — nothing new to deploy to see it live, though the WebEngage hourly file (see below)
is hand-published rather than auto-refreshing yet.

## Why it looks smaller than the original 40-section spec

The original request assumed WebEngage session-level web analytics (`suid`, `luid`,
`device_type`, `session_type`, `landing_page`, `referrer`) and a per-record `Store` field on
every Zoho Deal/Call/Task. The `Store` field genuinely doesn't exist (`Store_Assigned` is 0%
populated on Deals/Calls/Tasks — see "Store" below). The WebEngage fields DO exist and ARE now
wired in — see "Sessions data sources: the corrected story" below for how an initial
`lucirajewelry-prod`-only search missed it. Every remaining gap is called out **on the Data
Quality tab of the dashboard itself**, live, not just in this file.

## Sessions data sources: the corrected story

An earlier version of this dashboard concluded WebEngage had no usable session data — that
conclusion was **wrong**, caught by the user pushing back and sharing WebEngage's own "BigQuery
Access" setup PDF plus a real query they'd written months earlier. The actual situation:

- WebEngage's real, live, native BigQuery data-share exists — but in a **separate GCP project**,
  `test-webengage`, dataset `11b56595a_shared` (region **US**) — not in `lucirajewelry-prod`
  (region `asia-south1`) where every other table in this project lives. A search scoped to
  `lucirajewelry-prod` (however exhaustive within that project) could never find it.
- It has a genuine session identifier: `system_view_v1`'s `user_session_started` event carries a
  real `suid` (WebEngage mints one fresh per session — no derivation/sessionization heuristic
  needed), plus `luid` (user), `device_type`, `city`. Confirmed live through the current day.
- `application_view_v1` has rich real e-commerce events too: `pageView` (~146K/week),
  `productView`, `addToCart`, `viewCart`, etc.
- `Lucira_Prod.Webengage_Final` and `Lucira_Prod.Webengage_lucira_global_events_table` (in
  `lucirajewelry-prod`) are real but unrelated dead ends: campaign-delivery counters only (email/
  SMS/WhatsApp/push sent/delivered/opened), no session data, and the latter is 9+ months stale.
- A cross-region BigQuery gotcha: because `test-webengage` (US) and `ds_imputed_reporting`
  (asia-south1) are in different regions, BigQuery can't `INSERT ... SELECT` or `EXPORT DATA`
  across them in one job. The working query runs standalone against `test-webengage` only, and
  the small result (~1,000 rows) is uploaded to the public GCS bucket directly rather than via a
  BigQuery destination table. See `dashboard/sql/webengage_hourly_sessions_refresh.sql`.

## Data sources (all real, all already live)

| Source | Endpoint | Grain | Freshness |
|---|---|---|---|
| Zoho CRM (Deals/Calls/Tasks/Meetings) | `zoho-crm-bundle-public` Cloud Function → `zoho_crm.cdc_*` BigQuery CDC tables | **Row-level, real timestamp** | ~30 min (Zoho CDC sync) |
| Deal City/State | `zoho-leads-city-public` Cloud Function → `Lucira_Prod.lucira_zoho_Deals` | Row-level | Live, same cadence |
| **WebEngage Sessions (hourly)** — primary Sessions source | Public GCS JSON, built 2026-08-19 from `test-webengage.11b56595a_shared.system_view_v1` (`user_session_started`, `COUNT(DISTINCT suid)`) | **Hour-level, real, suid-keyed** | Live through today at build time; **not on an auto-refresh schedule yet** — see Known follow-ups |
| GA4 Sessions (day-level breakdowns only) | Public GCS JSON (`ga4-bq-api` snapshot, built from `ga4_fact_sessions`) | Day-level only | Often several weeks stale in this environment (shown live on Data Quality). Used only for the Sessions tab's device/city/channel cuts. |
| Sales / Orders | Public GCS JSON (`sales-reporting-api` snapshot, built from `sales_dashboard.sales_reporting`) | Day + Store grain | Daily, ~10:00 IST |

No new Cloud Function was deployed — the dashboard is a static HTML/JS file that can be opened
locally or hosted anywhere that serves static files; it just fetches one more public GCS object.

## Business Date & Time Window logic

- **Business Hours**: 10:00 → 20:59 IST — same calendar day.
- **Overnight**: 21:00 → 09:59 IST next calendar day — attributed to the **prior** business_date.
- 10:00 AM starts a new business_date.
- Implemented once, in `hsi.js#businessDateOf()`, applied to every Deal/Call/Task/Meeting the
  moment the bundle loads (`business_date`, `window`, `hour` are precomputed fields on every
  record). This exact split already existed, tested, in `dashboard/dcs.js` (`inWindowA`/
  `windowBDeals`) — reused rather than reinvented.
- Sales/Orders has **no hour-of-day column** in this project's data (confirmed against the
  actual BigQuery schema), so it cannot appear in the hour-bucketed tables — shown at its real
  grain (day) elsewhere instead of being faked into an hourly shape. WebEngage Sessions DOES now
  have a real hourly source (see above) and appears in the Hourly Monitor.

## KPI / classification definitions

- **Connected Call** = duration > 30 seconds (the threshold already used by this CRM's own
  Agent Performance table, not invented here).
- **Store Visit / TAH / Video Call** = classified from **Zoho Meeting titles** (`classifyEvent()`
  keyword match: `visit`/`sv`→Store Visit, `tah`/`trial at home`/`try at home`→TAH, `video`→Video
  Call), **not** from the Zoho Tasks module's `Task_Type` field — that field has only 13
  non-blank values across the entire org and cannot classify anything at scale. This is the same
  real, tested source `dashboard/dcs.js` and `dashboard/mdi.js` already use.
- **Task Completed/Pending** = `Status` field contains "complet" (case-insensitive) — the only
  reliably-tested Task Status rule in this codebase; finer buckets (Not Started/Deferred/…)
  aren't independently verified so are folded into "Pending".
- **Deal Stage** = this CRM's real funnel vocabulary (Prospect/ATC/Checkout/Payment/Closed
  Won/Closed Lost) — there is no distinct "WIP" stage, so "Open" = everything not closed. Deal
  `Amount` is populated on under 0.5% of deals org-wide, so Deal Value is not shown as a KPI.
- **Store** = derived **only** from 6 known store-owner CRM accounts (Chembur/Pune/Borivali/
  Noida/Pashchim Vihar Store + Head Office). Zoho's own `Store_Assigned` field is 0% populated on
  Deals/Calls/Tasks — every other owner's activity is genuinely `Unmapped`, shown as its own row
  everywhere, never dropped or guessed.
- **Owner** = `owner_id` (join key) → `owner_name` (display), already unified across Deals/
  Calls/Tasks/Meetings by the CRM bundle endpoint itself — no separate normalization needed.
- **Deduplication**: one Deal per (Mobile Number, Created Date) — latest by Modified/Created time
  wins on a collision. Same rule as every other CRM dashboard in this project.

## What is NOT shown, and exactly why

- **Hourly Sales** — the `sales_reporting` table has no hour-of-day column (checked against its
  actual schema). Shown at day-level instead of being invented at hour-level.
- **Sessions → Deals → Calls → Store Visit → Sale funnel** — WebEngage sessions DO carry a real
  identity key (`cuid` = mobile number, the same key already used for the Deal City join), so
  this join is genuinely buildable, but it hasn't been built into the hourly aggregation yet —
  left out rather than half-built. The Hourly Monitor's funnel currently stops at Meetings.
- **Missed vs Busy vs No-Answer call sub-types** — `Call_Result` isn't reliably populated enough
  to split beyond Connected / Not Connected.
- **Device/City/Campaign breakdowns on the real hourly WebEngage data** — `system_view_v1` has
  `device_type`/`city` on every row (see sample data in the SQL file's header comment), but the
  current hourly aggregation only pulls `sessions`/`users`, not those dimensions. Buildable later
  by extending `webengage_hourly_sessions_refresh.sql`'s GROUP BY.

## Refresh

- Zoho CRM data: live on every dashboard load/auto-refresh (default 15 min, `CONFIG.AUTO_MS` in
  `hsi.js`), reflecting whatever the ~30-min Zoho→BigQuery CDC sync last wrote.
- GA4 / Sales: reflect whatever their respective snapshot builders last wrote (see Data Quality
  tab for the live lag in days).
- WebEngage hourly sessions: reflects whatever `webengage_hourly_sessions_refresh.sql` last
  wrote — a manual, one-time build as of 2026-08-19 (not yet on a schedule; see Known follow-ups).
- "Refresh Now" button in the header re-fetches all five sources immediately.

## How to run it locally

No build step. From `dashboard/`:

```bash
python -m http.server 8791
# open http://localhost:8791/hourly-store-intelligence.html
```

(A plain `file://` open also works for the data-fetching parts since all four sources are CORS-
open public endpoints, but a local server avoids other browsers' stricter `file://` script-tag
quirks.)

## How to deploy it

It's a static file — copy `hourly-store-intelligence.html`, `hsi.js`, `hsi-views.js` next to the
existing dashboards (e.g. into the same GitHub Pages repo / Cloud Run static folder every other
`dashboard/*.html` in this project already ships from). No environment variables, no server
process, no new Cloud Function or BigQuery table required for what's built today.

## Tested

Loaded live against production data via a headless-Chrome (puppeteer-core) smoke test:
all 11 tabs render with real numbers and no console errors; Owner and Store filters and the
Hourly Monitor's hour drill-down were verified to actually scope every other tab (a real bug
was caught and fixed here — an early version's filter state object was being reassigned instead
of mutated in place, silently orphaning the exported `HSI.F` reference so the drawer's controls
looked functional but never reached the filter predicates); the Task Aging table (10,000+ open
tasks org-wide) is capped to the oldest 500 rows with an explicit on-screen note, to keep the
page fast per the performance requirement.

## Known follow-ups

- **The WebEngage hourly sessions file is not on a refresh schedule.** It was built once
  (2026-08-19) via `gcloud auth login` + the query in
  `dashboard/sql/webengage_hourly_sessions_refresh.sql`, covering a 45-day rolling window,
  uploaded straight to GCS (see the cross-region note in that file). It will silently go stale
  (no error, just no new dates in the lookup — the Hourly Monitor already renders "—" rather than
  a fake number). A proper fix is a small scheduled job (Cloud Scheduler + a tiny Cloud Function
  or Cloud Run job) re-running that query and re-uploading daily — not built yet, since it needs a
  deploy (out of scope for a same-session BigQuery-only fix). Re-run manually in the meantime.
- **The BigQuery MCP connector (claude.ai) never worked this session** — every call returned
  "requires re-authorization (token expired)", including immediately after the user reauthorized
  it. The `gcloud`/`bq` CLI path (interactive `gcloud auth login`) is what actually got BigQuery
  access working and is what built everything above.
- **The GA4-derived hourly sessions table** (`ds_imputed_reporting.ga4_hourly_sessions`, built
  earlier the same session, `dashboard/sql/ga4_hourly_sessions_refresh.sql`) is now superseded by
  the real WebEngage source and no longer read by the dashboard — left in BigQuery as a
  cross-check / fallback if the WebEngage share ever breaks, not actively used.
- **Sessions→Deal join via `cuid`** (see "What is NOT shown") is a real, buildable next step, not
  a dead end — WebEngage's `cuid` is the same mobile-number key already used for the Deal City
  join elsewhere in this project.
