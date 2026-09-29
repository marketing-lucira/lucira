"""
Lucira Walk-in Source Intelligence — reporting-layer snapshot builder
======================================================================
The dashboard (dashboard/walkin-source-intelligence.html) must NOT query BigQuery
when users open or explore it. This service reads the DAILY reporting tables
(rebuilt by sql/refresh_reporting.sql at 10:00 IST) and writes ONE static JSON
snapshot to a public GCS object. The browser fetches only that object — zero
BigQuery cost per open, sub-3-second loads. Mirrors sales-reporting-api/main.py.

Endpoints (Cloud Run function, entry point `walkin_snapshot`):
    GET  /            -> serve the latest snapshot JSON (from GCS; rebuild if missing)
    GET|POST /snapshot -> rebuild snapshot from the reporting table + write to GCS
    GET|POST /refresh  -> run sql/refresh_reporting.sql (rebuild both tables) THEN snapshot
                          (call this from Cloud Scheduler at 10:00 IST)

PII: customer_name and mobile_number are NEVER selected raw into this snapshot —
only customer_first_name (first token of the name) and mobile_masked (last 4
digits, rest replaced with bullet chars) are exported, because this snapshot is
written to a public, unauthenticated GCS object (same publication model as the
Sales Intelligence dashboard). Full unmasked detail stays queryable directly in
BigQuery for anyone with dataset access.

Data contract returned == exactly what the dashboard's ingest() expects:
    { meta, coverage, items[] }  (see dashboard/walkin_source_data.js for the shape)

Deploy: see README.md / deploy.sh.
"""
import os, json, time
from datetime import datetime, timezone

import functions_framework
from google.cloud import bigquery
try:
    from google.cloud import storage
except Exception:                      # storage optional (serve-only mode)
    storage = None

BQ_PROJECT     = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
REPORT_DATASET = os.environ.get("REPORT_DATASET", "lucirajewelry-prod.ds_imputed_reporting")
FACT_TABLE     = f"{REPORT_DATASET}.walkin_channel_final"
SNAP_BUCKET    = os.environ.get("SNAPSHOT_BUCKET", "lucira-dashboards")
SNAP_PATH      = os.environ.get("SNAPSHOT_PATH", "walkin-source/latest.json")
TODAY_TZ       = "Asia/Kolkata"

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}


def _client():
    return bigquery.Client(project=BQ_PROJECT or None)


def refresh_reporting_tables():
    """Rebuild customer_master_source + walkin_channel_final by running the bundled
    DDL as one BQ script (both CREATE OR REPLACE TABLE statements execute atomically
    in a single job). Called by the 10:00 IST scheduler before the snapshot is written."""
    sql_path = os.path.join(os.path.dirname(__file__), "sql", "refresh_reporting.sql")
    with open(sql_path, "r", encoding="utf-8") as fh:
        script = fh.read()
    _client().query(script).result()
    return sql_path


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def build_snapshot():
    """Read walkin_channel_final and shape the dashboard JSON. All PII is masked
    in the SELECT itself (never pulled unmasked into this process)."""
    bq = _client()
    def run(sql):
        return list(bq.query(sql).result())

    fact_sql = f"""
        SELECT
          visit_id, store_code, store_name, city, state, region,
          COALESCE(NULLIF(SPLIT(TRIM(customer_name), ' ')[OFFSET(0)], ''), 'Guest') AS customer_first_name,
          CONCAT('••••••', SUBSTR(mobile_number, 7, 4)) AS mobile_masked,
          CAST(visit_date AS STRING) AS visit_date,
          order_link_status,
          shopify_flag, webengage_flag, zoho_deals_flag, zoho_leads_flag,
          customer_channel, visit_seq, lifetime_visits, customer_type
        FROM `{FACT_TABLE}`
        ORDER BY visit_id
    """
    cov_sql = f"""
        SELECT
          COUNT(*) AS total_visits,
          MIN(visit_date) AS min_visit_date,
          MAX(visit_date) AS max_visit_date,
          DATE_DIFF(CURRENT_DATE('{TODAY_TZ}'), MAX(visit_date), DAY) AS data_freshness_lag_days,
          COUNTIF(store_code IS NULL) AS visits_with_unassigned_store,
          COUNTIF(city IS NULL) AS visits_with_unknown_city,
          COUNTIF(customer_channel='Shopify') AS shopify_ct,
          COUNTIF(customer_channel='WebEngage') AS webengage_ct,
          COUNTIF(customer_channel='Zoho Deals') AS deals_ct,
          COUNTIF(customer_channel='Zoho Leads') AS leads_ct,
          COUNTIF(customer_channel='Direct Walkin') AS organic_ct,
          COUNTIF(customer_type='New') AS new_ct,
          COUNTIF(customer_type='Repeat') AS repeat_ct
        FROM `{FACT_TABLE}`
    """

    fact = run(fact_sql)
    items = [{
        "visit_id": int(r["visit_id"]),
        "store_code": r["store_code"],
        "store_name": r["store_name"],
        "city": r["city"], "state": r["state"], "region": r["region"],
        "customer_first_name": r["customer_first_name"],
        "mobile_masked": r["mobile_masked"],
        "visit_date": r["visit_date"],
        "order_link_status": r["order_link_status"],
        "shopify_flag": bool(r["shopify_flag"]), "webengage_flag": bool(r["webengage_flag"]),
        "zoho_deals_flag": bool(r["zoho_deals_flag"]), "zoho_leads_flag": bool(r["zoho_leads_flag"]),
        "customer_channel": r["customer_channel"],
        "visit_seq": int(r["visit_seq"]), "lifetime_visits": int(r["lifetime_visits"]),
        "customer_type": r["customer_type"],
    } for r in fact]

    c = run(cov_sql)[0]
    total = int(c["total_visits"])
    unassigned = int(c["visits_with_unassigned_store"])
    lag = int(c["data_freshness_lag_days"])
    coverage = {
        "generated_for_date": _iso(datetime.now(timezone.utc).date()),
        "total_visits": total,
        "min_visit_date": _iso(c["min_visit_date"]),
        "max_visit_date": _iso(c["max_visit_date"]),
        "data_freshness_lag_days": lag,
        "channel_counts": {
            "Shopify": int(c["shopify_ct"]), "WebEngage": int(c["webengage_ct"]),
            "Zoho Deals": int(c["deals_ct"]), "Zoho Leads": int(c["leads_ct"]),
            "Direct Walkin": int(c["organic_ct"]),
        },
        "customer_type_counts": {"New": int(c["new_ct"]), "Repeat": int(c["repeat_ct"])},
        "visits_with_unassigned_store": unassigned,
        "visits_with_unknown_city": int(c["visits_with_unknown_city"]),
        "notes": [
            f"Walkin_marge lags real time by ~{lag} days (max visit_date={_iso(c['max_visit_date'])}); "
            "'Yesterday'/'Today' KPI cards fall back to the most recent available day and say so explicitly, "
            "rather than silently showing 0.",
            "City/State/Region are the STORE's location (a visit-location proxy), not the customer's home "
            "address -- Zoho Deals/Leads Address_City is populated on under 20% of records, too sparse to "
            "use as the primary geography dimension, so this dashboard does not claim customer home-city.",
            "No Gender, Age Group, Product Category, Purchase Status, or Sales Executive field exists on "
            "Walkin_marge or any of the 4 source tables, so those CEO-brief filters/cuts are not shown "
            "rather than fabricated.",
            "'New vs Repeat' is derived from how many times a phone number appears as a store visitor in "
            "this table (visit_seq==1 => New), i.e. repeat STORE VISITS, not full lifetime CRM order history.",
            "order_link_status is the source table's mislabeled 'state' column -- an order/fulfilment "
            "status (Completed/Rts/MTO/Billed Returns/Pending/TAH/None) carried over from a merge with an "
            "orders system, not a geography field. Shown as a secondary cut, not a KPI headline.",
            f"{unassigned} of {total} visits have no store_code (store_name='Unassigned') and are excluded "
            "from store/city rankings but included in every overall total.",
            "Customer name and mobile number are masked in this file (first name + last 4 digits only) -- "
            "this snapshot is published to a public, unauthenticated URL, same model as the Sales "
            "Intelligence dashboard; full detail stays queryable directly in BigQuery.",
        ],
    }
    channel_counts = coverage["channel_counts"]
    non_organic = {k: v for k, v in channel_counts.items() if k != "Direct Walkin"}
    lowest_channel = min(non_organic, key=non_organic.get) if non_organic else None
    if lowest_channel and total and (non_organic[lowest_channel] / total * 100) < 3:
        others = [k for k in non_organic if k != lowest_channel]
        coverage["notes"].append(
            f"{lowest_channel} contributes only {non_organic[lowest_channel]/total*100:.1f}% of final-channel "
            f"attribution here -- not necessarily a data problem: it's the lowest-priority channel checked, so "
            f"any phone number it shares with a higher-priority source ({', '.join(others)}) is claimed there "
            "first and never \"wins\" a match here."
        )

    return {
        "meta": {
            "source_tables": [
                "lucirajewelry-prod.ds_imputed_reporting.Walkin_marge",
                "lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_customers",
                "lucirajewelry-prod.Lucira_Prod.Webengage_Final",
                "lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals",
                "lucirajewelry-prod.zoho_crm.daily_leads",
            ],
            "reporting_tables": [
                "lucirajewelry-prod.ds_imputed_reporting.customer_master_source",
                f"{FACT_TABLE}",
            ],
            "channel_priority": ["Zoho Deals", "Zoho Leads", "Shopify", "WebEngage", "Direct Walkin"],
        },
        "coverage": coverage,
        "items": items,
    }


def _write_gcs(payload):
    if not (SNAP_BUCKET and storage):
        return None
    body = json.dumps(payload, separators=(",", ":"))
    client = storage.Client(project=BQ_PROJECT or None)
    bucket = client.bucket(SNAP_BUCKET)
    blob = bucket.blob(SNAP_PATH)
    blob.cache_control = "public, max-age=300"
    blob.upload_from_string(body, content_type="application/json")
    return f"gs://{SNAP_BUCKET}/{SNAP_PATH}"


def _read_gcs():
    if not (SNAP_BUCKET and storage):
        return None
    try:
        client = storage.Client(project=BQ_PROJECT or None)
        return client.bucket(SNAP_BUCKET).blob(SNAP_PATH).download_as_text()
    except Exception:
        return None


@functions_framework.http
def walkin_snapshot(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
    path = (request.path or "/").rstrip("/")
    t0 = time.time()
    try:
        do_refresh = path.endswith("/refresh") or request.args.get("refresh") == "full"
        if do_refresh or path.endswith("/snapshot") or request.args.get("snapshot") == "1":
            refreshed = None
            if do_refresh:
                refreshed = refresh_reporting_tables()
            payload = build_snapshot()
            dest = _write_gcs(payload)
            payload["_refreshed"] = bool(do_refresh)
            payload["_written_to"] = dest
            payload["_elapsed_sec"] = round(time.time() - t0, 2)
            return (json.dumps(payload, separators=(",", ":")), 200, CORS)
        # serve latest
        cached = _read_gcs()
        if cached:
            return (cached, 200, CORS)
        return (json.dumps(build_snapshot(), separators=(",", ":")), 200, CORS)
    except Exception as e:  # noqa: BLE001
        return (json.dumps({"error": "snapshot_error", "detail": str(e),
                            "hint": "Confirm the reporting tables exist (run sql/refresh_reporting.sql) "
                                    "and the runtime SA has bigquery.dataViewer + storage.objectAdmin on "
                                    "gs://" + SNAP_BUCKET + "."}),
                502, CORS)
