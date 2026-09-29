"""
Lucira Store Visit Campaign Intelligence — reporting-layer snapshot builder
============================================================================
The dashboard (dashboard/store-visit-intelligence.html) must NOT query BigQuery
when users open or explore it. This service reads the DAILY reporting tables
(rebuilt by sql/refresh_reporting.sql at 10:00 IST) and writes ONE static JSON
snapshot to a public GCS object. The browser fetches only that object — zero
BigQuery cost per open, sub-3-second loads. Mirrors walkin-source-api/main.py.

Endpoints (Cloud Run function, entry point `store_visit_snapshot`):
    GET  /            -> serve the latest snapshot JSON (from GCS; rebuild if missing)
    GET|POST /snapshot -> rebuild snapshot from the reporting tables + write to GCS
    GET|POST /refresh  -> run sql/refresh_reporting.sql (rebuild all 4 tables) THEN
                          snapshot (call this from Cloud Scheduler at 10:00 IST)

PII: mobile numbers are NEVER selected raw into this snapshot — the reporting
tables themselves mask to mobile_masked (last 4 digits, rest replaced with
bullet chars) in the SQL, because this snapshot is written to a public,
unauthenticated GCS object (same publication model as Sales Intelligence /
Walk-in Source Intelligence). Full unmasked detail stays queryable directly
in BigQuery for anyone with dataset access.

Data contract returned == exactly what dashboard/store_visit_data.js exports as
window.STORE_VISIT_DATA: { meta, campaigns[], monthly[], dealsRegister[], salesRegister[] }.

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
ACTIVITY_TABLE = f"{REPORT_DATASET}.store_visit_activity"
TARGETS_TABLE  = f"{REPORT_DATASET}.store_visit_targets"
FLAGS_TABLE    = f"{REPORT_DATASET}.store_visit_target_flags"
DEALS_TABLE    = f"{REPORT_DATASET}.store_visit_deal_outcomes"
SALES_TABLE    = f"{REPORT_DATASET}.store_visit_sale_outcomes"
SNAP_BUCKET    = os.environ.get("SNAPSHOT_BUCKET", "lucira-dashboards")
SNAP_PATH      = os.environ.get("SNAPSHOT_PATH", "store-visit/latest.json")

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
    """Rebuild all 4 reporting tables by running the bundled DDL as one BQ script
    (all CREATE OR REPLACE TABLE statements execute in a single job). Called by
    the 10:00 IST scheduler before the snapshot is written."""
    sql_path = os.path.join(os.path.dirname(__file__), "sql", "refresh_reporting.sql")
    with open(sql_path, "r", encoding="utf-8") as fh:
        script = fh.read()
    _client().query(script).result()
    return sql_path


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def build_snapshot():
    """Read the 4 small reporting tables (never the raw multi-GB source tables) and
    shape the dashboard JSON. All PII is masked upstream in the SQL, never pulled
    unmasked into this process."""
    bq = _client()
    def run(sql):
        return list(bq.query(sql).result())

    campaigns_sql = f"""
        SELECT
          campaign_name, journey_title, channel,
          MIN(event_date) AS first_run, MAX(event_date) AS last_run,
          COUNT(DISTINCT cuid) AS users,
          SUM(sent) AS sent, SUM(delivered) AS delivered,
          SUM(opened) AS opened, ANY_VALUE(opened_label) AS opened_label,
          SUM(clicked) AS clicked,
          LOGICAL_OR(opened IS NOT NULL) AS has_open
        FROM `{ACTIVITY_TABLE}`
        GROUP BY campaign_name, journey_title, channel
        ORDER BY first_run
    """
    monthly_sql = f"""
        SELECT FORMAT_DATE('%Y-%m', event_date) AS ym,
          SUM(sent) AS sent, COUNT(DISTINCT cuid) AS users
        FROM `{ACTIVITY_TABLE}`
        GROUP BY ym ORDER BY ym
    """
    deals_sql = f"""
        SELECT mobile_masked, first_touch_date, campaigns, channels, stage,
          deal_created, store_assigned, city, lead_source, days_touch_to_deal
        FROM `{DEALS_TABLE}` ORDER BY deal_created DESC
    """
    sales_sql = f"""
        SELECT mobile_masked, first_touch_date, campaigns, total_orders, ltv, aov,
          first_order_date, latest_order_date, city, state,
          days_touch_to_first_order, flagged
        FROM `{SALES_TABLE}` ORDER BY ltv DESC
    """
    # Counts computed from the unmasked internal flags table, NOT by re-joining on
    # mobile_masked (last-4-digits only) — that would risk collisions between
    # different numbers sharing the same last 4 digits and silently inflate counts.
    counts_sql = f"""
        SELECT
          COUNT(*) AS total_targeted,
          COUNTIF(has_deal) AS has_deal,
          COUNTIF(has_sale) AS has_sale,
          COUNTIF(has_deal AND has_sale) AS has_both,
          COUNTIF(has_deal OR has_sale) AS has_either,
          (SELECT COUNTIF(ltv > 0) FROM `{SALES_TABLE}`) AS revenue_populated_deals
        FROM `{FLAGS_TABLE}`
    """

    campaigns = [{
        "campaign_name": r["campaign_name"], "journey_title": r["journey_title"], "channel": r["channel"],
        "first_run": _iso(r["first_run"]), "last_run": _iso(r["last_run"]), "users": int(r["users"]),
        "sent": int(r["sent"] or 0), "delivered": int(r["delivered"] or 0),
        "opened": (int(r["opened"]) if r["has_open"] else None), "opened_label": r["opened_label"],
        "clicked": int(r["clicked"] or 0),
    } for r in run(campaigns_sql)]

    monthly = [{"ym": r["ym"], "sent": int(r["sent"] or 0), "users": int(r["users"])} for r in run(monthly_sql)]

    deals_register = [{
        "mobile_masked": r["mobile_masked"], "first_touch": _iso(r["first_touch_date"]),
        "campaigns": r["campaigns"], "channels": r["channels"], "stage": r["stage"],
        "deal_created": _iso(r["deal_created"]), "days_touch_to_deal": int(r["days_touch_to_deal"]) if r["days_touch_to_deal"] is not None else None,
        "city": r["city"], "lead_source": r["lead_source"],
    } for r in run(deals_sql)]

    sales_register = [{
        "mobile_masked": r["mobile_masked"], "first_touch": _iso(r["first_touch_date"]),
        "campaigns": r["campaigns"], "total_orders": int(r["total_orders"] or 0),
        "ltv": float(r["ltv"] or 0), "aov": float(r["aov"] or 0),
        "first_order_date": _iso(r["first_order_date"]), "latest_order_date": _iso(r["latest_order_date"]),
        "days_touch_to_first_order": int(r["days_touch_to_first_order"]) if r["days_touch_to_first_order"] is not None else None,
        "city": r["city"], "state": r["state"], "flagged": bool(r["flagged"]),
    } for r in run(sales_sql)]

    c = run(counts_sql)[0]
    total_targeted = int(c["total_targeted"])
    has_deal, has_sale, has_both, has_either = int(c["has_deal"]), int(c["has_sale"]), int(c["has_both"]), int(c["has_either"])
    flagged_count = sum(1 for r in sales_register if r["flagged"])
    seen = {}
    for r in deals_register:
        seen[r["mobile_masked"]] = seen.get(r["mobile_masked"], 0) + 1
    dup_mobile = max(seen, key=seen.get) if seen else None
    if dup_mobile and seen[dup_mobile] <= 1:
        dup_mobile = None

    notes = [
        "WebEngage has no literal \"store visit\" (footfall) event — there is no event_name/event-type column in Webengage_Final at all. Every send/delivery/engagement number in this dashboard is messaging-campaign activity for campaigns whose NAME references a store visit, not a confirmed physical visit.",
        "\"Deals Created\" and \"Made a Purchase\" are both mobile-number matches (WebEngage cuid → Zoho Deals Mobile / sales_oneview_data Cus_mobile) — correlation, not proven causation. A matched customer may have converted for reasons unrelated to this campaign.",
        f"Real revenue IS available via sales_oneview_data (Shopify + POS order history, LTV/AOV/order dates) — {has_sale} of {total_targeted} targeted users have a purchase on record. Zoho Deals' own Amount field is separately near-empty ({int(c['revenue_populated_deals'])} of {len(sales_register)} matched sales rows have ltv > 0) so deal-stage revenue is NOT shown — sales_oneview_data is the only revenue source used.",
        "sales_oneview_data covers only 1,057 customers company-wide — far fewer than the Shopify customer table (15,855) or Zoho Deals (13,927) — so it likely reflects a specific channel/time-window rather than the full historical customer base. Treat the matched sales figures as a lower bound, not complete coverage.",
        f"{flagged_count} of {len(sales_register)} matched sales rows are flagged: identical order date + ₹0 LTV/AOV shared across multiple customers — a likely data-quality artifact (bulk import or test orders), not independent revenue-generating conversions. Shown as-is (not excluded), marked in the register.",
        "Store_Assigned is null for effectively all matched deal rows — no store-level attribution is possible for the deals cohort.",
        (f"Mobile {dup_mobile} has {seen.get(dup_mobile, 0)} separate Deal records on file — a known Zoho duplicate-creation pattern, not independent conversions. Shown as-is in the register, not deduplicated or hidden." if dup_mobile and seen.get(dup_mobile, 0) > 1 else "No duplicate-Deal-record customers detected in this pull."),
        "days_touch_to_deal / days_touch_to_first_order are negative for several matched rows (the deal or order predates the customer's first store-visit campaign touch) — shown as-is rather than filtered out; the causal direction does not hold for those rows.",
        f"Only {has_both} of the {has_either} customers with any commercial outcome have BOTH a Zoho Deal and a sales_oneview_data purchase — the two systems mostly capture different customers, not the same funnel twice.",
        "No cross-check yet against actual footfall (Walkin_marge, used by the Walk-in Source Intelligence dashboard) — this dashboard cannot currently confirm whether any targeted customer physically visited a store.",
    ]

    return {
        "meta": {
            "generated_at": _iso(datetime.now(timezone.utc).date()),
            "source_campaigns": "lucirajewelry-prod.Lucira_Prod.Webengage_Final",
            "source_deals": "lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals",
            "source_sales": "lucirajewelry-prod.Lucira_Prod.sales_oneview_data",
            "reporting_tables": [ACTIVITY_TABLE, TARGETS_TABLE, DEALS_TABLE, SALES_TABLE],
            "join_key": "WebEngage cuid = Zoho Deals Mobile = sales_oneview_data Cus_mobile, all normalized to last-10-digits",
            "campaign_match": "campaign_name LIKE '%store_visit%'/'%storevisit%' OR journey_title LIKE '%store visit%'",
            "total_targeted_valid_mobile": total_targeted,
            "has_deal": has_deal, "has_sale": has_sale, "has_both": has_both, "has_either": has_either,
            "notes": notes,
        },
        "campaigns": campaigns,
        "monthly": monthly,
        "dealsRegister": deals_register,
        "salesRegister": sales_register,
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
def store_visit_snapshot(request):
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
