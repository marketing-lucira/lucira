# ga4-bq-api — GA4 BigQuery-export backend (Cloud Run)

A cost-optimized backend for the **GA4 Analytics Command Center**
([`../dashboard/ga4-dashboard.html`](../dashboard/ga4-dashboard.html)). It reads the
**GA4 → BigQuery export** (`lucirajewelry-prod.analytics_478308692.events_*`), maintains
6 pre-aggregated daily summary tables, and serves the dashboard's exact JSON contract
from those small tables — so opening the dashboard never scans raw events.

> **Status / access reality.** This was authored against a **view-only** GCP account with
> **no BigQuery access, no deploy rights, and the BigQuery connector unauthenticated** in-session
> (confirmed this session). So the SQL and backend here are **production-shaped code that someone
> with access deploys and validates** — they have not been run against the real dataset. The 2–3
> spots that need validation against your actual export are flagged as **⚠ VALIDATE** below.

---

## Architecture & cost model

```
GA4 export (raw events_YYYYMMDD)                    ← scanned ONCE/day, one partition
        │  sql/10..15_*.sql  (incremental: DELETE+INSERT one date)
        ▼
ga4_dashboard.*  (6 small, partitioned + clustered summary tables, HLL user sketches)
        │  main.py /data  (GROUP BY over aggregates only — cheap)
        ▼
dashboard/ga4-dashboard.html   (same JSON contract as the old GA4 Data API function → drop-in)

Cloud Scheduler ──09:00 IST──▶ POST /refresh  (rebuild yesterday's partition in all 6 tables)
                └─09:15 IST──▶ POST /report   (Gemini daily report → ga4_ai_reports history)
```

Why it's cheap: raw events are scanned **once per day** by the refresh (a single date partition
each). Every dashboard load reads only the aggregated tables, which are partitioned by `event_date`
and clustered by the columns the dashboard filters/orders on. Distinct-user counts use **HLL++
sketches** so any date range gets an accurate distinct count from the daily rows (no re-scan, no
sum-of-daily error).

### The 6 summary tables (built by `sql/00_setup.sql`)

| Table | Grain | Serves |
|---|---|---|
| `ga4_daily_summary` | 1 row/day | Overview KPIs, daily trend, funnel |
| `ga4_campaign_summary` | day × channel × source × medium × campaign | Traffic, Campaigns, channel/source/medium |
| `ga4_landing_summary` | day × page (`is_landing` flag) | Landing Pages **and** all-Pages |
| `ga4_sku_summary` | day × item_id | SKU funnel + table |
| `ga4_product_summary` | day × name × category × brand | Product rollup / contribution |
| `ga4_audience_summary` | **tall**: day × dim × value | device/os/browser/platform/geo/language/hostname/newReturning/contentGroup **+ events** |

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/health` | liveness + config echo |
| GET | `/data?from&to` or `?days=` | full dashboard payload (the contract the dashboard consumes) |
| POST | `/refresh` `{date?}` | rebuild the 6 aggregates for a date (default: yesterday IST) |
| POST | `/ai` `{question, days?}` | Gemini answer grounded on recent aggregates |
| GET/POST | `/report` | GET latest stored daily report · POST generate+store (Scheduler) |

`/data` returns the **same keys** the older GA4 Data API function returned (`totals`, `daily`,
`channels`, `sourceMedium`, `campaigns`, `landingPages`, `devices`, `countries`, `cities`, `pages`,
`events`, `funnel`, `items`, …), so the dashboard is a drop-in: set `GA4_API_BASE` to `<url>/data`.

---

## Deploy

Prereqs: `gcloud` + `bq` authenticated with BigQuery + Cloud Run + Cloud Scheduler rights, and
**Data Viewer on the GA4 export dataset**. Then:

```bash
cd ga4-bq-api
bash deploy.sh          # creates dataset+tables, backfills 90d, deploys Cloud Run, wires Scheduler (09:00/09:15 IST)
```

Set the dashboard's `GA4_API_BASE` GitHub Variable to the printed `<service-url>/data`.

### Auth & the browser (read this)

`deploy.sh` deploys the service **private** (`--no-allow-unauthenticated`) and lets Cloud Scheduler
invoke `/refresh` + `/report` via OIDC. But a **static GitHub Pages dashboard cannot send OIDC
tokens**, so for the browser to call `/data` you must pick one:

- **A. Public read, guarded writes (simplest):** redeploy with `--allow-unauthenticated`, keep
  `/refresh` + `/report` protected by `REFRESH_TOKEN` (and Scheduler OIDC). `/data` is read-only
  aggregates; lock `CORS_ORIGIN` to `https://marketing-lucira.github.io`.
- **B. Authenticated proxy:** front `/data` with an authenticated proxy / API gateway that injects
  credentials. More secure, more setup.

`deploy.sh` prints this reminder too.

### Gemini (optional AI)

Store a Gemini API key in Secret Manager and set `GEMINI_SECRET` in `deploy.sh` (→ mounted as
`GEMINI_API_KEY`). Without it, `/ai` and `/report` return a friendly "not configured" and the
dashboard uses its **local** rule-based assistant.

---

## ⚠ VALIDATE against your real export

1. **Table path.** Code uses `lucirajewelry-prod.analytics_478308692.events_*` (the standard GA4
   export layout: dataset `analytics_<propertyId>`, tables `events_YYYYMMDD`). If your export lives
   elsewhere, adjust the `FROM` in `sql/*.sql`.
2. **Key events.** The export has no per-event conversion flag, so `key_events_set` in
   `10_refresh_daily_summary.sql` defaults to `['purchase']`. Add the event names you've marked as
   **Key Events** in GA4.
3. **Channel grouping & session source.** `default_channel_group()` and the session-source pick
   (earliest non-direct event) approximate GA4's last-non-direct model. Compare against GA4's
   Traffic-acquisition report and tune the rules if numbers diverge.
4. **Fields that vary by export:** `collected_traffic_source` (older exports lack it — code falls
   back to `traffic_source`), `content_group` (only if you send it), hostname (derived from
   `page_location`). `screenResolutions` isn't in the standard export, so that breakdown is empty.

---

## Files

```
ga4-bq-api/
  main.py            Cloud Run app (Flask): /data /refresh /ai /report /health
  requirements.txt   Flask, gunicorn, google-cloud-bigquery, (google-generativeai)
  .env.example       config reference (no secrets)
  deploy.sh          dataset+tables, backfill, Cloud Run deploy, Scheduler 09:00/09:15 IST
  sql/
    00_setup.sql               dataset + default_channel_group UDF + 6 tables + ga4_ai_reports
    10_refresh_daily_summary.sql
    11_refresh_campaign_summary.sql
    12_refresh_landing_summary.sql
    13_refresh_sku_summary.sql
    14_refresh_product_summary.sql
    15_refresh_audience_summary.sql
```

> The `.sql` files are **BigQuery GoogleSQL**. If your editor flags `DECLARE`/backticks/`CURSOR`
> errors, that's a T-SQL linter mismatch — not a real error.
