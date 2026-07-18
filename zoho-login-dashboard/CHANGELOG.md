# Changelog — Zoho Login & Activity Dashboard

All work done on 2026-07-11 (Cloud Run revisions in parentheses).

## v1 — OAuth pipeline + first dashboard (rev 00001–00003)
- Flask service scaffolded; deployed to Cloud Run from source (no Dockerfile/CI).
- Zoho OAuth flow from the frontend ("Connect Zoho"); refresh token persisted in GCS;
  Client ID/Secret in Secret Manager; service account wired (BQ/GCS/Secrets).
- `/sync`: Zoho CRM Users API → GCS NDJSON → BigQuery `zoho_crm.crm_users`
  (full refresh) + `user_status_snapshots` (append) — 36 users on first sync.
- Dashboard v1: roster, role distribution, online/active KPIs.
- Fixed "Sync now" 401 by adding browser-safe `/ui/sync`.

## v2 — analytics + Gemini + scheduler (rev 00004–00006)
- Cloud Scheduler `zoho-sync` every 15 min (IST) → login-hours history accumulates.
- Date-range + filters (role/profile/status/online/search), default status = active.
- Derived login-hours from snapshots (capped intervals); active days; last seen.
- Deals enrichment joined per agent; range KPIs.
- **AI insight layer**: Gemini on Vertex AI via service-account ADC.
  `gemini-2.5-flash` (2.0/1.5 return 404 for this project). Markdown rendered.
- Dashboard rebuilt as independent async cards (summary / agents / insights load
  separately); tabs (Overview, Data & Sync); calendar presets.
- Login **sessions** reconstructed (gaps-and-islands): start/end/duration/gap,
  session-hour trend, per-day login chart.
- Data & Sync tab: table row counts/size/last-modified + sync status.

## v3 — hourly views + activity metrics + brand context (rev 00007)
- Durations formatted as `42m` / `3h 20m` everywhere.
- Calendar opens on click anywhere in the date field (`showPicker()`).
- All metrics strictly range-scoped (deals by Created_Time, won by Closing_Date).
- Calls + meetings metrics per agent (count, talk time, store visits).
- Team hourly trend (00–23 IST): online minutes vs calls. Peaks: 12:00, 16–17 IST.
- Agent day×hour heatmap with per-hour call badges.
- Gemini prompt: Lucira = Indian ecommerce + omnichannel lab-grown diamond brand
  (Candere founder, $5.5M Blume seed, stores Mumbai/Pune/Noida/Delhi).
- Default range switched to last 60 days + "Last 60 days" preset.

## v4 — own CDC pipeline, all modules, all columns (rev 00008–00011)
- OAuth scope extended with `ZohoCRM.modules.READ` (re-consent flow).
- **Generic CDC engine**: per-module `Modified_Time` cursor in GCS; fetch via
  `sort_by=Modified_Time desc` + `page_token` pagination; staging + MERGE by id;
  runs inside every 15-min `/sync`; `/backfill?module=X|all&days=N`.
- New self-owned tables (legacy externally-loaded tables abandoned):
  `cdc_contacts`, `cdc_deals`, `cdc_tasks`, `cdc_calls`, `cdc_meetings`,
  `cdc_online_activities`, plus typed `customer_events`.
- Full column coverage per module (Zoho caps 50 fields/request); complete raw
  record JSON stored in `data` on every table.
- 60-day backfill: 67,687 customer events, 13,277 calls, 12,896 deals,
  10,924 tasks (module previously thought empty!), 9,736 contacts,
  3,581 online activities, 94 meetings. (66k-record run needed 2Gi memory.)
- Dashboard rewired to CDC tables with exact `owner_id` joins; new metrics:
  Tasks, Online activities; customer-events funnel card
  (ProductView → Login → Signup → Checkout → ATC → Payment → Purchase).

## v5 — unified activity table + activity-based presence (rev 00012–00013)
- **`zoho_crm.all_activity` view** — one big table over all modules
  (108k+ rows): `activity_type, owner_id, activity_time, title, duration, amount…`.
- **Activity-derived presence** (fixes "agent shows login 5pm but worked since 11am"
  — polling can't be backfilled, but calls/tasks/meetings prove presence):
  - per-agent `active_hours` (distinct active IST hours) and Active span
    (first → last activity) — on dashboard table (default sort) and agent page;
  - heatmap: green = polled online, **blue = active by activity**, purple = calls;
  - Gemini told to prefer activity-hours over polled login-hours.

## v6 — today-default, conversational insights, Deals time-slot tab
- Default date range switched from **last 60 days** to **Today** (both ends = today, IST);
  the "Reset" button now returns to Today.
- **Conversational insights**: the Overview insights card keeps the Gemini briefing but
  adds a chat thread — managers ask follow-ups grounded on the same range-scoped numbers,
  with prior turns kept in context. New `POST /api/insights/chat`; briefing regeneration or
  a filter change resets the conversation. Refactored the prompt into a shared
  `_insights_context()` used by both the briefing and Q&A.
- **New Deals tab** (`/api/deals_slots`): deals bucketed into 5 IST time-slots — four
  3-hour working blocks (9–12, 12–15, 15–18, 18–21) + one non-working block (21:00–09:00) —
  with a **Created / Modified** toggle (buckets by `Created_Time` or `Modified_Time`) and the
  shared date range. Metrics per slot + totals: created deals, connected deals
  (`Number_of_activity > 0`), connectivity ratio, conversion (Closed Won), conversion ratio,
  deal→activity ratio (activities/deal). Plus a stage funnel (count + amount per stage).
  - Note: the 4 working blocks span 9 AM–9 PM, so the non-working block is treated as the
    complement (9 PM–9 AM) to keep the 5 buckets mutually exclusive.

## Open items
- Lock down public access to the dashboard.
- Rotate the Zoho admin password (was shared in chat during setup).
- Optional: date-partition big tables; customer-events drill-down (UTM/channel).
