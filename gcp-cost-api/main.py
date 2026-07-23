"""
GCP Billing Export → Cost Dashboard data API
=================================================
HTTP Cloud Function that reads the **Cloud Billing export to BigQuery** and
returns compact daily cost line-items as JSON for gcp-cost-dashboard.html.

Same thin-data-pump philosophy as zoho-crm-api: the dashboard does ALL of the
analytics (trends, forecast, breakdowns, recommendations, alerts) client-side.
This function only:
    1. queries the billing export table, aggregated to one row per
       (day, project, service, sku, region, resource),
    2. flattens credits + resource labels,
    3. returns the shape the dashboard's `ingest()` expects.

Data source
-----------
Set BILLING_EXPORT_TABLE to your **detailed usage cost** export table, e.g.
    my-billing-project.billing_export.gcp_billing_export_resource_v1_0123AB_45CDEF_6789GH
The "resource_v1" (detailed) table has resource.name → enables resource-level
cost. If you only have the "standard" export (gcp_billing_export_v1_*), the
resource column falls back to the SKU and the Resources tab is coarser.

Deploy (same pattern as zoho-crm-api)
-------------------------------------
    gcloud functions deploy gcp-cost-data \
        --gen2 --runtime=python312 --region=asia-south1 \
        --source=. --entry-point=gcp_cost_data --trigger-http --allow-unauthenticated \
        --set-env-vars 'BQ_PROJECT=lucira-prod,BILLING_EXPORT_TABLE=lucira-prod.billing_export.gcp_billing_export_resource_v1_0123AB_45CDEF_6789GH,TIMEZONE=Asia/Kolkata,MONTHLY_BUDGET=180000' \
        --set-env-vars '^~^PROJECT_BUDGETS={"lucira-prod":105000,"lucira-analytics":42000,"lucira-staging":18000,"lucira-data-pipeline":15000}'

Then paste the function URL into CONFIG.API_BASE in gcp-cost-dashboard.html.

Security
--------
The function's runtime service account needs `roles/bigquery.dataViewer` on the
billing export dataset + `roles/bigquery.jobUser` on BQ_PROJECT. No secrets are
stored in source. Consider dropping --allow-unauthenticated and calling it with
an ID token if the data is sensitive.
"""

import os
import json
import time
from datetime import datetime, timezone

import functions_framework
from google.cloud import bigquery

# ─────────────────────────────────────────────────────────────
#  CONFIG (from environment)
# ─────────────────────────────────────────────────────────────
BQ_PROJECT       = os.environ.get("BQ_PROJECT", "")
BILLING_TABLE    = os.environ.get("BILLING_EXPORT_TABLE", "")   # fully-qualified `proj.dataset.table`
TIMEZONE         = os.environ.get("TIMEZONE", "Asia/Kolkata")   # day boundary for daily aggregation
MONTHLY_BUDGET   = float(os.environ.get("MONTHLY_BUDGET", "180000"))
PROJECT_BUDGETS  = json.loads(os.environ.get("PROJECT_BUDGETS", "{}"))
# label keys to surface (dashboard "Label" filter reads env/team)
LABEL_KEYS       = [k.strip() for k in os.environ.get("LABEL_KEYS", "env,team").split(",") if k.strip()]
DEFAULT_DAYS     = int(os.environ.get("WINDOW_DAYS", "95"))
MAX_DAYS         = 400

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}

# Service → cost category (kept in sync with the dashboard's svcCategory()).
CATEGORY = {
    "BigQuery": "Databases & Analytics", "Cloud SQL": "Databases & Analytics",
    "Cloud Run": "Compute", "Cloud Functions": "Compute", "Compute Engine": "Compute",
    "Cloud Storage": "Storage", "Artifact Registry": "Storage",
    "Networking": "Networking",
    "Pub/Sub": "Integration", "Cloud Scheduler": "Integration",
}
# Billing export uses long service names; normalise the common ones to the
# short labels the dashboard colours by. Anything unmapped passes through.
SERVICE_ALIAS = {
    "BigQuery": "BigQuery", "Cloud Run": "Cloud Run", "Cloud Functions": "Cloud Functions",
    "Cloud Storage": "Cloud Storage", "Compute Engine": "Compute Engine", "Cloud SQL": "Cloud SQL",
    "Cloud Pub/Sub": "Pub/Sub", "Cloud Scheduler": "Cloud Scheduler",
    "Secret Manager": "Secret Manager", "Cloud Logging": "Cloud Logging",
    "Stackdriver Monitoring": "Cloud Monitoring", "Cloud Monitoring": "Cloud Monitoring",
    "Networking": "Networking", "Artifact Registry": "Artifact Registry",
}


def short_service(desc: str) -> str:
    if not desc:
        return "Other"
    if desc in SERVICE_ALIAS:
        return SERVICE_ALIAS[desc]
    d = desc.lower()
    if "bigquery" in d:              return "BigQuery"
    if "cloud run" in d:             return "Cloud Run"
    if "cloud functions" in d:       return "Cloud Functions"
    if "cloud storage" in d:         return "Cloud Storage"
    if "compute engine" in d:        return "Compute Engine"
    if "cloud sql" in d:             return "Cloud SQL"
    if "pub/sub" in d or "pubsub" in d: return "Pub/Sub"
    if "scheduler" in d:             return "Cloud Scheduler"
    if "secret manager" in d:        return "Secret Manager"
    if "logging" in d:               return "Cloud Logging"
    if "monitoring" in d:            return "Cloud Monitoring"
    if "artifact registry" in d:     return "Artifact Registry"
    if "network" in d or "load balanc" in d: return "Networking"
    return desc


def category_for(service: str) -> str:
    return CATEGORY.get(service, "Operations & Security")


# ─────────────────────────────────────────────────────────────
#  QUERY  — one row per (day, project, service, sku, region, resource)
# ─────────────────────────────────────────────────────────────
def build_query() -> str:
    # NOTE: back-ticked table reference is injected (not a bind param — BQ table
    # names cannot be parameterised). BILLING_TABLE must be operator-controlled.
    label_selects = ",\n        ".join(
        f"(SELECT value FROM UNNEST(labels) WHERE key='{k}') AS lbl_{k}"
        for k in LABEL_KEYS
    )
    label_line = (",\n        " + label_selects) if label_selects else ""
    return f"""
    SELECT
        FORMAT_TIMESTAMP('%Y-%m-%d', usage_start_time, @tz)            AS date,
        IFNULL(project.id, '(unattributed)')                          AS project,
        service.description                                           AS service,
        sku.description                                               AS sku,
        IFNULL(location.region, 'global')                             AS region,
        IFNULL(resource.name, sku.description)                        AS resource,
        SUM(cost)                                                     AS cost,
        SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credit,
        SUM(usage.amount)                                             AS usage,
        ANY_VALUE(usage.unit)                                         AS usage_unit{label_line}
    FROM `{BILLING_TABLE}`
    WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    GROUP BY date, project, service, sku, region, resource{''.join(f', lbl_{k}' for k in LABEL_KEYS)}
    HAVING ABS(cost) > 0 OR ABS(credit) > 0
    ORDER BY date
    """


# ─────────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────────
@functions_framework.http
def gcp_cost_data(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    if not BILLING_TABLE:
        return (json.dumps({
            "error": "not_configured",
            "detail": "Set BILLING_EXPORT_TABLE (and BQ_PROJECT) env vars. See README to enable "
                      "Cloud Billing export to BigQuery first."
        }), 500, CORS)

    t0 = time.time()
    try:
        days = min(MAX_DAYS, max(1, int(request.args.get("days", DEFAULT_DAYS))))
    except ValueError:
        days = DEFAULT_DAYS
    debug = request.args.get("debug") == "1"

    try:
        client = bigquery.Client(project=BQ_PROJECT or None)
        job = client.query(
            build_query(),
            job_config=bigquery.QueryJobConfig(query_parameters=[
                bigquery.ScalarQueryParameter("tz", "STRING", TIMEZONE),
                bigquery.ScalarQueryParameter("days", "INT64", days),
            ]),
        )
        rows = list(job.result())
    except Exception as e:  # noqa: BLE001
        return (json.dumps({"error": "bq_query_error", "detail": str(e)}), 502, CORS)

    items = []
    resources_seen = {}
    max_date = None
    for r in rows:
        svc = short_service(r["service"])
        item = {
            "date": r["date"],
            "project": r["project"],
            "service": svc,
            "sku": r["sku"],
            "region": r["region"],
            "resource": r["resource"],
            "resourceId": f'{svc}:{r["resource"]}',
            "cost": round(float(r["cost"] or 0), 4),
            "credit": round(float(r["credit"] or 0), 4),
            "usage": round(float(r["usage"] or 0), 2),
            "usageUnit": r["usage_unit"] or "",
            "category": category_for(svc),
        }
        for k in LABEL_KEYS:
            item[k] = r.get(f"lbl_{k}") or ""
        items.append(item)
        if r["date"] and (max_date is None or r["date"] > max_date):
            max_date = r["date"]
        rid = item["resourceId"]
        if rid not in resources_seen:
            resources_seen[rid] = {
                "id": rid, "name": r["resource"], "service": svc,
                "project": r["project"], "region": r["region"], "meta": {},
            }

    resp = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asOf": max_date,
        "window_days": days,
        "currency": os.environ.get("BILLING_CURRENCY", "INR"),
        "monthlyBudget": MONTHLY_BUDGET,
        "budgets": PROJECT_BUDGETS,
        "items": items,
        # Billing export has no utilisation metadata (CPU%, memory, bucket size).
        # These come from the Monitoring/Asset APIs — see README "Optional enrichment".
        # With empty meta, cost-based views work fully; utilisation flags are hidden.
        "resources": list(resources_seen.values()),
    }
    if debug:
        resp["debug"] = {
            "row_count": len(items),
            "resource_count": len(resources_seen),
            "elapsed_sec": round(time.time() - t0, 2),
            "table": BILLING_TABLE,
        }
    return (json.dumps(resp), 200, CORS)
