# GCP Cost Command Center — data API

Thin Cloud Function that feeds `dashboard/gcp-cost-dashboard.html` from your
**Cloud Billing export to BigQuery**. Same architecture as `zoho-crm-api`: the
function is a dumb data pump; all analytics (trend, forecast, breakdowns,
recommendations, alerts) run client-side in the dashboard.

The dashboard **works immediately on built-in sample data** — you only need this
API for live numbers.

---

## Step 1 — Enable Billing export to BigQuery (the primary data source)

Billing export is **off by default**. Until it's on, GCP keeps no queryable cost
history, so turn it on now even if you wire the dashboard later (it can't
backfill days before it was enabled).

1. **Console → Billing → Billing export → BigQuery export.**
2. Enable **Detailed usage cost** (gives `resource.name` → the Resources /
   Cloud Run / Storage / Compute tabs). Optionally also **Standard usage cost**.
3. Pick/create a dataset (e.g. `billing_export`) in a region near you
   (`asia-south1`). Save.
4. Data starts flowing within a few hours and updates several times per day.
   Table name looks like
   `PROJECT.billing_export.gcp_billing_export_resource_v1_XXXXXX_XXXXXX_XXXXXX`.

CLI check that export is landing:

```bash
bq ls billing_export
bq query --use_legacy_sql=false \
  'SELECT MAX(usage_start_time) FROM `PROJECT.billing_export.gcp_billing_export_resource_v1_XXXX`'
```

> **Pricing exports** (for rate/optimization detail) are a separate toggle in the
> same screen — optional, not required by this dashboard.

## Step 2 — Permissions

The function's runtime service account needs:
- `roles/bigquery.dataViewer` on the billing export dataset,
- `roles/bigquery.jobUser` on `BQ_PROJECT`.

```bash
gcloud projects add-iam-policy-binding BQ_PROJECT \
  --member="serviceAccount:SA_EMAIL" --role="roles/bigquery.jobUser"
bq add-iam-policy-binding --member="serviceAccount:SA_EMAIL" \
  --role="roles/bigquery.dataViewer" PROJECT:billing_export
```

## Step 3 — Deploy

```bash
cd gcp-cost-api
gcloud functions deploy gcp-cost-data \
  --gen2 --runtime=python312 --region=asia-south1 \
  --source=. --entry-point=gcp_cost_data --trigger-http --allow-unauthenticated \
  --set-env-vars 'BQ_PROJECT=lucira-prod,BILLING_EXPORT_TABLE=lucira-prod.billing_export.gcp_billing_export_resource_v1_XXXX,TIMEZONE=Asia/Kolkata,MONTHLY_BUDGET=180000' \
  --set-env-vars '^~^PROJECT_BUDGETS={"lucira-prod":105000,"lucira-analytics":42000,"lucira-staging":18000,"lucira-data-pipeline":15000}'
```

(The `^~^` sets `~` as the delimiter so the JSON's commas aren't split.) See
`.env.example` for all variables.

## Step 4 — Wire the dashboard

In `dashboard/gcp-cost-dashboard.html`, set:

```js
const CONFIG = { API_BASE: "https://asia-south1-lucira-prod.cloudfunctions.net/gcp-cost-data", … }
```

Also set `MONTHLY_BUDGET` and `PROJECT_BUDGETS` in that CONFIG (the dashboard
uses the API's budgets if present, else CONFIG). Reload — the status dot turns
green: **“Live · billing export · as of <date>.”** It auto-refreshes every 30 min.

Test the endpoint directly:

```bash
curl "https://…/gcp-cost-data?days=95&debug=1" | head -c 600
```

---

## Response shape

```jsonc
{
  "asOf": "2026-07-14",
  "monthlyBudget": 180000,
  "budgets": { "lucira-prod": 105000, ... },
  "items": [                       // one row per day×project×service×sku×region×resource
    { "date":"2026-07-14","project":"lucira-prod","service":"BigQuery",
      "sku":"Analysis (on-demand queries)","region":"asia-south1",
      "resource":"crm_analytics","cost":812.4,"credit":-40.1,
      "usage":227.5,"usageUnit":"tebibyte","category":"Databases & Analytics",
      "env":"prod","team":"data" }
  ],
  "resources": [ { "id":"BigQuery:crm_analytics","name":"crm_analytics",
                   "service":"BigQuery","project":"lucira-analytics",
                   "region":"asia-south1","meta":{} } ]
}
```

## Live vs sample — the one limitation

Billing export contains **cost, credits and usage — but no utilisation
metadata** (CPU %, memory %, bucket size, request counts). So in live mode:

- ✅ Fully accurate: every KPI, trend, forecast, budget, breakdown by
  service/project/region/resource/SKU, BigQuery query costs, storage-class
  costs, egress costs, credits, alerts, and all **cost-derived** recommendations
  (idle = near-zero cost, cold storage class, high egress, un-partitioned BQ
  bytes).
- ⚠️ Hidden unless enriched: the utilisation **flags** in the Cloud Run /
  Storage / Compute tables (memory %, CPU %, object counts). These need the
  Monitoring + Cloud Asset APIs. The sample dataset ships them populated so you
  can see the intended UX.

**Optional enrichment:** add a second query to `main.py` that pulls
`run.googleapis.com/container/…`, `compute.googleapis.com/instance/cpu/utilization`,
etc. from `monitoring.timeSeries`, and bucket sizes from
`storage.googleapis.com/storage/total_bytes`, then attach them to each
`resources[].meta`. The dashboard already renders any meta you provide.

---

## Metric definitions (documentation for every card)

| Metric | Definition |
|---|---|
| **Net cost** | `cost + credits` (credits are negative). Everything on the dashboard is net unless a card says “Gross”. |
| **Today / Yesterday** | Cost on the latest complete billing day / the day before. Billing export lags a few hours, so “today” = last full day (`asOf`). |
| **Last 7 days** | Net cost over the trailing 7 complete days; delta vs the prior 7. |
| **Month-to-Date (MTD)** | Net cost from the 1st of the current month to `asOf`. |
| **Forecast EOM (blended)** | Average of two methods: **run-rate** (MTD ÷ days elapsed × days in month) and **linear regression** on the last 21 days projected to month end. |
| **Budget Used** | `MTD ÷ monthly budget`. Traffic light: green <80 %, yellow 80–90 %, red ≥90 %. |
| **Avg Daily Spend** | Trailing 7-day mean net cost. |
| **Savings Opportunity** | Sum of estimated monthly savings across all recommendations. |
| **7-day moving average** | Trailing 7-point mean on the daily series (smooths weekday seasonality). |
| **Day-over-day Δ / Growth %** | `today − yesterday`, and that as a % of yesterday. |
| **Overspend risk** | Based on forecast ÷ budget: HIGH ≥100 %, MEDIUM ≥90 %, else LOW. |
| **Recommendation saving** | Estimated `monthly cost × a factor` specific to the action (e.g. idle Cloud Run → ~90 % of its cost; over-provisioned memory → ~45 %). Directional, not a quote. |

## Alert thresholds (edit in the dashboard's `CONFIG.ALERTS`)

Daily cost > threshold · day-over-day spike > X % · a service's 7-day cost up
> X % vs prior 7 days · budget ≥80 % / ≥90 % / exceeded. In production, mirror
these as native **GCP Budgets & alerts** plus a **Monitoring alert policy** on
the billing metric so you get email/Slack/PagerDuty even when the dashboard is closed.
