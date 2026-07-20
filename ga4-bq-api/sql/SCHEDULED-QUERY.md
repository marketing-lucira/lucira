# Daily refresh — BigQuery Scheduled Query

The dashboard's **only** data source is one consolidated fact table:
`lucirajewelry-prod.ga4_dashboard.ga4_fact_sessions` (one row per session, with
`items[]`, `events[]`, `pages[]` arrays). It is rebuilt **once a day** by a
BigQuery **Scheduled Query** — no Cloud Run needed for the refresh itself.

> ⚠ I could not run any of this (no BigQuery access from here). It's written
> against the standard GA4 export schema and needs a person with access to run +
> validate. Confirm the source dataset name first (see below).

## One-time

```bash
# 1) Create the fact table + channel-group UDF
bq query --use_legacy_sql=false --project_id=lucirajewelry-prod < sql/00_setup_fact.sql

# 2) (Optional) backfill history — loop the build over the last 90 days
for i in $(seq 1 90); do
  D=$(date -u -d "$i days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"$i"d +%Y-%m-%d)
  sed "s/DATE_SUB(COALESCE(@run_date, CURRENT_DATE('Asia\/Kolkata')), INTERVAL 1 DAY)/DATE '$D'/" \
    sql/fact_sessions.sql | bq query --use_legacy_sql=false --project_id=lucirajewelry-prod
done
```

## Create the daily Scheduled Query (09:00 IST)

**Console:** BigQuery → **Scheduled queries** → **Create scheduled query** → paste
the contents of [`fact_sessions.sql`](fact_sessions.sql) → Schedule: **Daily,
09:00**, Timezone **Asia/Kolkata** → run as a service account with BigQuery
Data Editor (on `ga4_dashboard`) + Data Viewer (on the GA4 export).

**Or via `bq`:**
```bash
bq mk --transfer_config --project_id=lucirajewelry-prod \
  --target_dataset=ga4_dashboard --display_name="GA4 fact_sessions daily" \
  --data_source=scheduled_query \
  --schedule="every day 09:00" --schedule_time_zone="Asia/Kolkata" \
  --params="$(python3 - <<'PY'
import json,io
sql=open('sql/fact_sessions.sql').read()
print(json.dumps({"query":sql}))
PY
)"
```

`@run_date` is supplied automatically by the Scheduled Query; the file rebuilds
**yesterday's** partition each run (correct for a 09:00 IST run).

## Confirm the source  ⚠

`fact_sessions.sql` reads `FROM \`lucirajewelry-prod.analytics_478308692.events_*\``
(the standard GA4 → BigQuery export). If your GA4 export dataset has a different
name/id, or you want to **join in Shopify / CRM** as extra sources, edit the
`FROM` (and add `LEFT JOIN`s) in `fact_sessions.sql` before scheduling. Also set
your **Key Events** list (`key_events_set`) to match GA4.

## How the dashboard consumes it

`main.py` (`/data`, `/snapshot`) reads **only** `ga4_fact_sessions` — every KPI,
breakdown, funnel, product list and AI context is derived from it (GROUP BY a
column; UNNEST `items[]` / `events[]` / `pages[]`). The 09:05 IST snapshot writes
that into a static JSON the dashboard downloads once a day. No sample data is used
once `GA4_SNAPSHOT_URL` (or `API_BASE`) is set — sample is only the offline
local-preview fallback.
