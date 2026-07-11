# Lucira — Zoho CRM Login & Activity Dashboard

A self-contained Cloud Run service that syncs Zoho CRM data into BigQuery via its
own CDC pipeline and serves a live agent login/activity dashboard with an AI
insight layer (Gemini on Vertex AI).

**Live service:** `zoho-login-dashboard` · Cloud Run · `asia-south1` · project `lucirajewelry-prod`

---

## Architecture

```
                        ┌────────────────────────────────────────────┐
 Zoho CRM (.in DC)      │            Cloud Run: zoho-login-dashboard │
 ┌──────────────┐  OAuth│  ┌──────────┐   ┌──────────┐   ┌────────┐  │
 │ Users API    │◄──────┼──┤ /sync    │   │ /backfill│   │ UI/API │  │
 │ Module APIs  │       │  │ (15 min) │   │ (60d)    │   │ pages  │  │
 └──────────────┘       │  └────┬─────┘   └────┬─────┘   └───┬────┘  │
                        └───────┼──────────────┼─────────────┼───────┘
                                ▼              ▼             │
                    GCS (staging NDJSON + cursors + token)   │
                                ▼                            ▼
                        BigQuery  zoho_crm.*  ◄──── queries (JSON_VALUE)
                                ▲
                    Cloud Scheduler zoho-sync (*/15, IST)
                    Vertex AI Gemini (insights, same service account)
```

## Data pipeline (CDC)

Every 15 minutes Cloud Scheduler POSTs `/sync`, which:

1. **Users** — full refresh of `crm_users` (roster + live `Isonline` flag) and an
   append-only snapshot row per user into `user_status_snapshots` (the login-hours
   timeline is derived from these snapshots — Zoho has **no login-history API**).
2. **CDC modules** — for each module, fetches only records with
   `Modified_Time > cursor` (cursor stored in GCS), stages to a temp table, and
   **MERGEs by id** (insert new / update changed, no duplicates):

| BigQuery table | Zoho module | Notes |
|---|---|---|
| `cdc_contacts` | Contacts | 50 fields |
| `cdc_deals` | Deals | 50 fields incl. UTM, Deal_Score, Store_Assigned |
| `cdc_tasks` | Tasks | all 34 fields |
| `cdc_calls` | Calls | all 29 fields incl. duration |
| `cdc_meetings` | Events (Meetings) | all 35 fields incl. check-in geo |
| `cdc_online_activities` | Online_Activity_Logs | Chat/IVR/WhatsApp/Website channels |
| `customer_events` | Customer_Events | typed columns (order value, UTM, funnel type) |

Generic CDC schema: `id, owner_id, owner_name, created_time, modified_time,
data (full record JSON), synced_at` — any field is queryable via `JSON_VALUE(data, '$.Field')`.

**`all_activity` view** — one big table unioning all modules into a single feed:
`activity_type, id, owner_id, owner_name, activity_time, title, duration_seconds, amount, …`

`/backfill?module=<Name|all>&days=60` (sync-token protected) performs the initial
historical load. The 60-day backfill loaded ~118k records.

## Presence model

- **Polled presence** — `Isonline` sampled every 15 min → login hours, sessions
  (gaps-and-islands over the snapshot timeline), day×hour heatmap. Builds forward
  only; cannot be backfilled.
- **Activity presence** — hours where an agent has any call/task/meeting/online
  activity count as *active by activity* (blue cells in the heatmap; `active_hours`
  and first→last *Active span* metrics). This covers history before polling existed
  and is the primary engagement measure.

## Web app

| Route | Purpose |
|---|---|
| `/` | landing + Connect Zoho (OAuth) |
| `/oauth/login`, `/oauth/callback` | Zoho OAuth (server-based app, `.in` DC) |
| `/dashboard` | shell page — every card loads independently via the JSON APIs |
| `/user/<id>` | agent detail: KPIs, hourly heatmap, sessions, daily trend, deals |
| `/insights` | Gemini-generated manager briefing |
| `/sync` (POST) | scheduler entrypoint (X-Sync-Token header) |
| `/ui/sync` | browser-safe manual sync |
| `/backfill` | historical module load (token protected) |
| `/health` | status |
| `/api/summary`, `/api/users`, `/api/team_hourly`, `/api/customer_events`, `/api/insights`, `/api/tables`, `/api/user/<id>/overview`, `/api/user/<id>/sessions`, `/api/user/<id>/hourly` | JSON APIs backing the cards |

Dashboard features: calendar date-range (click-to-open) + presets (Today/7/30/60/This month,
default **last 60 days**), filters (role/profile/status — default **active** — online, search),
KPI cards, hourly team trend (online vs calls), agents table (activity-first),
website customer-events funnel card, Data & Sync tab (table stats + cursors + last sync).

## AI insights

Gemini (`gemini-2.5-flash`, Vertex AI, `us-central1`) runs under the same service
account via ADC — no API keys. The prompt carries Lucira brand context (Indian
ecommerce + omnichannel lab-grown diamond brand) and the per-agent range-scoped
metrics; output is a manager briefing (engagement, activity-vs-outcomes,
store-vs-agent patterns, anomalies, recommendations).

## GCP resources

- **Cloud Run** `zoho-login-dashboard` (asia-south1, 2Gi/2cpu, timeout 900s, public)
- **Service account** `zoho-login-run@lucirajewelry-prod.iam.gserviceaccount.com`
  (bigquery.dataEditor, bigquery.jobUser, storage.objectAdmin on bucket,
  secretmanager.secretAccessor, aiplatform.user)
- **GCS** `gs://lucirajewelry-prod-zoho-login` (staging, OAuth refresh token, CDC cursors)
- **Secret Manager** `zoho-client-id`, `zoho-client-secret`
- **Cloud Scheduler** `zoho-sync` — `*/15 * * * *` Asia/Kolkata → POST `/sync`
- **BigQuery** dataset `zoho_crm` (asia-south1)

## Zoho setup

- OAuth server-based app at api-console.zoho.com (data center `.in`),
  redirect URI `<service-url>/oauth/callback`
- Scopes: `ZohoCRM.users.READ, ZohoCRM.org.READ, ZohoCRM.modules.READ`
- Refresh token persisted in GCS; access tokens minted per request

## Deploy

```bash
gcloud run deploy zoho-login-dashboard --source . \
  --project=lucirajewelry-prod --region=asia-south1
```

No Dockerfile / Cloud Build pipeline — Google buildpacks build from source
(`requirements.txt` + `Procfile`).

## Known limits / TODO

- Dashboard is **publicly accessible** — add auth before wider rollout.
- Zoho fields API caps 50 fields/request (Contacts/Deals/Customer_Events carry
  their 50 most valuable; full record JSON still stored in `data`).
- Per-session IP/device history has no Zoho API (UI export only).
- Login-hours polling history starts 2026-07-11 17:03 IST; earlier presence is
  activity-derived.
