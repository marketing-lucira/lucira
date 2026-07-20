"""
Lucira Sales Intelligence — reporting-layer snapshot builder
============================================================
The dashboard (dashboard/sales-intelligence.html) must NOT query BigQuery when
users open or explore it. This service reads the DAILY reporting table (built by
sql/refresh_reporting.sql at 10:00 IST) and writes ONE static JSON snapshot to a
public GCS object. The browser fetches only that object — zero BigQuery cost per
open, sub-3-second loads.

Endpoints (Cloud Run / Cloud Function, entry point `sales_snapshot`):
    GET  /            → serve the latest snapshot JSON (from GCS; rebuild if missing)
    GET|POST /snapshot → rebuild snapshot from the reporting table + write to GCS
                         (call this from Cloud Scheduler at ~10:10 IST, after the
                          10:00 IST scheduled query has refreshed the table)

Data contract returned == exactly what the dashboard's ingest() expects:
    { asOf, currency, gst_divisor, capabilities, validation,
      items[], styleRef[], customerRef[] }

Deploy: see README.md.
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
REPORT_DATASET = os.environ.get("REPORT_DATASET", "lucirajewelry-prod.sales_dashboard")
FACT_TABLE     = f"{REPORT_DATASET}.sales_reporting"
STYLE_TABLE    = f"{REPORT_DATASET}.sales_reporting_style"
CUST_TABLE     = f"{REPORT_DATASET}.sales_reporting_customer"
RAW_TABLE      = os.environ.get("SALES_TABLE",
                 "lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table")
CURRENCY       = os.environ.get("CURRENCY", "INR")
GST_DIVISOR    = float(os.environ.get("GST_DIVISOR", "1.03"))
WINDOW_DAYS    = int(os.environ.get("WINDOW_DAYS", "540"))
DETAIL_CAP     = int(os.environ.get("DETAIL_ROW_CAP", "300000"))
SNAP_BUCKET    = os.environ.get("SNAPSHOT_BUCKET", "")        # e.g. lucira-dashboards
SNAP_PATH      = os.environ.get("SNAPSHOT_PATH", "sales/latest.json")

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
    """Rebuild the reporting layer by running the bundled DDL as one BQ script.
    BigQuery runs multi-statement scripts in a single job, so the whole
    sql/refresh_reporting.sql (CREATE SCHEMA + 3 CREATE OR REPLACE TABLE) executes
    atomically. Called by the 10:00 IST scheduler before the snapshot is written."""
    sql_path = os.path.join(os.path.dirname(__file__), "sql", "refresh_reporting.sql")
    with open(sql_path, "r", encoding="utf-8") as fh:
        script = fh.read()
    _client().query(script).result()
    return sql_path


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def build_snapshot():
    """Read the reporting layer and shape the dashboard JSON."""
    bq = _client()
    def run(sql):
        return list(bq.query(sql).result())

    fact_sql = f"""
        SELECT date, document_no, customer_id, customer_name, city, state, region,
               sku, product_name, style, category, sub_category, collection, metal,
               price_band, customer_type, sale_type, store, channel,
               qty, gross, net, discount, gross_weight, net_weight
        FROM `{FACT_TABLE}`
        WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL {WINDOW_DAYS} DAY)
        ORDER BY date
        LIMIT {DETAIL_CAP}
    """
    val_sql = f"""
        SELECT COUNT(*) AS deduped_rows,
               ROUND(SUM(gross), 2) AS gross
        FROM `{FACT_TABLE}`
        WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL {WINDOW_DAYS} DAY)
    """
    raw_sql = f"""
        SELECT COUNT(*) AS raw_rows
        FROM `{RAW_TABLE}`
        WHERE `Transaction_Date` IS NOT NULL
          AND CAST(`Transaction_Date` AS DATE) >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL {WINDOW_DAYS} DAY)
    """

    fact = run(fact_sql)
    items, max_date = [], None
    for r in fact:
        d = _iso(r["date"])
        items.append({
            "date": d, "document_no": r["document_no"], "order_id": r["document_no"],
            "customer_id": r["customer_id"], "customer_name": r["customer_name"] or "",
            "city": r["city"] or "", "state": r["state"] or "", "region": r["region"] or "",
            "sku": r["sku"], "product_name": r["product_name"] or "", "style": r["style"],
            "category": r["category"] or "", "sub_category": r["sub_category"] or "",
            "collection": r["collection"] or "", "metal": r["metal"] or "",
            "price_band": r["price_band"] or "", "customer_type": (r["customer_type"] or ""),
            "sale_type": r["sale_type"] or "Other",
            "qty": float(r["qty"] or 0), "gross": float(r["gross"] or 0),
            "net": float(r["net"] or 0), "discount": float(r["discount"] or 0),
            "gross_weight": float(r["gross_weight"] or 0), "net_weight": float(r["net_weight"] or 0),
            "cogs": None, "store": r["store"] or "", "salesperson": "", "channel": r["channel"] or "",
        })
        if d and (max_date is None or d > max_date):
            max_date = d

    style_ref = [{
        "style": r["style"], "category": r["category"] or "", "metal": r["metal"] or "",
        "collection": r["collection"] or "",
        "first_sale_date": _iso(r["first_sale_date"]), "last_sale_date": _iso(r["last_sale_date"]),
        "units_all_time": float(r["units_all_time"] or 0),
        "first_inventory_date": None, "stock_qty": None,
    } for r in run(f"SELECT * FROM `{STYLE_TABLE}`")]

    customer_ref = [{
        "customer_id": r["customer_id"], "first_order_date": _iso(r["first_order_date"]),
        "last_order_date": _iso(r["last_order_date"]),
        "lifetime_orders": int(r["lifetime_orders"] or 0),
        "lifetime_net": float(r["lifetime_net"] or 0),
    } for r in run(f"SELECT * FROM `{CUST_TABLE}`")]

    v = run(val_sql)[0]
    raw = run(raw_sql)[0]
    validation = {
        "raw_rows": int(raw["raw_rows"]), "deduped_rows": int(v["deduped_rows"]),
        "removed": int(raw["raw_rows"]) - int(v["deduped_rows"]),
        "raw_gross": float(v["gross"] or 0), "returned_rows": len(items),
        "returned_gross": float(v["gross"] or 0), "gst_divisor": GST_DIVISOR,
        "dedup_key": "gross + sale_date + document_no + net_weight",
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asOf": max_date, "window_days": WINDOW_DAYS, "currency": CURRENCY, "gst_divisor": GST_DIVISOR,
        "capabilities": {
            "margin": False, "inventory": False, "selling_days": False, "customer": True,
            "salesperson": False, "sale_type": True, "weights": True,
            "price_band": True, "customer_type": True, "sub_category": True, "exchange": False,
        },
        "validation": validation,
        "items": items, "styleRef": style_ref, "customerRef": customer_ref,
    }


def _write_gcs(payload):
    if not (SNAP_BUCKET and storage):
        return None
    body = json.dumps(payload, separators=(",", ":"))
    client = storage.Client(project=BQ_PROJECT or None)
    bucket = client.bucket(SNAP_BUCKET)
    for path in (SNAP_PATH, SNAP_PATH.replace("latest", payload.get("asOf") or "snapshot")):
        blob = bucket.blob(path)
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
def sales_snapshot(request):
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
                                    "and the runtime SA has bigquery.dataViewer + storage.objectAdmin."}),
                502, CORS)
