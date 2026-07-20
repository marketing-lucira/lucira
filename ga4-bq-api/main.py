"""
GA4 → BigQuery Dashboard :: Cloud Run backend
=============================================
Serves the Lucira GA4 Analytics Command Center (dashboard/ga4-dashboard.html)
from the pre-aggregated summary tables in `lucirajewelry-prod.ga4_dashboard`
(built by sql/10..15_*.sql). It NEVER scans the raw GA4 export on a dashboard
load — only the small, partitioned summary tables — so per-load BigQuery cost is
negligible.

Endpoints
---------
GET  /            , /health      → liveness + config echo
GET  /data        ?from&to|days  → the dashboard JSON contract (same shape the
                                   older GA4 Data API function returned, so the
                                   dashboard is a drop-in: just point CONFIG.API_BASE here)
POST /refresh     {date?}        → run the 6 incremental aggregations for a date
                                   (default: yesterday IST). Protected — see AUTH.
POST /ai          {question,...} → Gemini answer grounded on the aggregates
GET/POST /report  {date?}        → generate + store the daily AI report; GET returns latest

Auth
----
Reads use ADC (Cloud Run runtime service account) with BigQuery Job User +
Data Viewer on the ga4_dashboard dataset. /refresh and /report are meant to be
called by Cloud Scheduler with an OIDC token; set REFRESH_TOKEN to also accept a
shared-secret bearer token for manual runs. No secrets in source.

Deploy: see deploy.sh + README.md.
"""

import os
import re
import json
import datetime as dt
from pathlib import Path

from flask import Flask, request, jsonify, make_response
from google.cloud import bigquery

# ─────────────────────────────────────────────────────────────
#  CONFIG (env)
# ─────────────────────────────────────────────────────────────
PROJECT       = os.environ.get("GCP_PROJECT", "lucirajewelry-prod")
DATASET       = os.environ.get("GA4_DASHBOARD_DATASET", "ga4_dashboard")
CURRENCY      = os.environ.get("GA4_CURRENCY", "INR")
DEFAULT_DAYS  = int(os.environ.get("WINDOW_DAYS", "90"))
MAX_DAYS      = int(os.environ.get("MAX_DAYS", "400"))
TOP_LIMIT     = int(os.environ.get("TOP_LIMIT", "30"))
REFRESH_TOKEN = os.environ.get("REFRESH_TOKEN", "")           # optional shared secret for /refresh
GEMINI_KEY    = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL  = os.environ.get("GA4_GEMINI_MODEL", "gemini-2.0-flash")
# Daily snapshot: /snapshot writes the day's payload as a static JSON object to
# this GCS bucket; the dashboard reads that object once/day (no per-load query).
SNAPSHOT_BUCKET = os.environ.get("SNAPSHOT_BUCKET", "")
SNAPSHOT_PREFIX = os.environ.get("SNAPSHOT_PREFIX", "ga4")
SNAPSHOT_DAYS   = int(os.environ.get("SNAPSHOT_DAYS", "400"))  # history the snapshot covers (client filters within it)
SQL_DIR       = Path(__file__).parent / "sql"
FQ            = f"`{PROJECT}.{DATASET}"                        # helper prefix (close with .table`)

app = Flask(__name__)
_bq = None


def bq():
    """Lazily create a BigQuery client so import never fails without creds."""
    global _bq
    if _bq is None:
        _bq = bigquery.Client(project=PROJECT)
    return _bq


CORS = {
    "Access-Control-Allow-Origin":  os.environ.get("CORS_ORIGIN", "*"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


def _cors(resp):
    for k, v in CORS.items():
        resp.headers[k] = v
    return resp


@app.after_request
def _add_cors(resp):
    return _cors(resp)


# ─────────────────────────────────────────────────────────────
#  helpers
# ─────────────────────────────────────────────────────────────
def _range():
    """(from_date, to_date) as python dates from ?from&to or ?days."""
    frm, to = request.args.get("from"), request.args.get("to")
    if frm and to:
        return dt.date.fromisoformat(frm), dt.date.fromisoformat(to)
    try:
        days = min(MAX_DAYS, max(1, int(request.args.get("days", DEFAULT_DAYS))))
    except (TypeError, ValueError):
        days = DEFAULT_DAYS
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).date()  # IST
    return today - dt.timedelta(days=days - 1), today


def _params(frm, to, limit=None):
    p = [
        bigquery.ScalarQueryParameter("from", "DATE", frm),
        bigquery.ScalarQueryParameter("to", "DATE", to),
    ]
    if limit is not None:
        p.append(bigquery.ScalarQueryParameter("limit", "INT64", limit))
    return bigquery.QueryJobConfig(query_parameters=p)


def _q(sql, frm, to, limit=None):
    return [dict(r) for r in bq().query(sql, job_config=_params(frm, to, limit)).result()]


def _f(v, nd=2):
    try:
        return round(float(v or 0), nd)
    except (TypeError, ValueError):
        return 0


# The SINGLE consolidated fact table is the dashboard's only data source.
FACT = f"`{PROJECT}.{DATASET}.ga4_fact_sessions`"

# The metric bundle every single-dimension breakdown returns (session grain, so
# distinct users = COUNT(DISTINCT); matches the dashboard's ingestLive contract).
_FACT_COLS = """
  COUNT(DISTINCT user_pseudo_id)                        AS users,
  COUNT(DISTINCT IF(is_new_user, user_pseudo_id, NULL)) AS newUsers,
  COUNT(*)                                              AS sessions,
  COUNTIF(engaged)                                      AS engagedSessions,
  SAFE_DIVIDE(COUNTIF(engaged), COUNT(*)) * 100         AS engagementRate,
  SUM(page_views)                                       AS views,
  SUM(event_count)                                      AS eventCount,
  SUM(key_events)                                       AS keyEvents,
  SUM(transactions)                                     AS purchases,
  SUM(items_qty)                                        AS items,
  SUM(revenue)                                          AS revenue
"""


def _map_breakdown(rows):
    out = []
    for r in rows:
        out.append({
            "name":            r.get("name") or "(not set)",
            "users":           _f(r.get("users")),
            "newUsers":        _f(r.get("newUsers")),
            "sessions":        _f(r.get("sessions")),
            "engagedSessions": _f(r.get("engagedSessions")),
            "engagementRate":  _f(r.get("engagementRate")),
            "views":           _f(r.get("views")),
            "eventCount":      _f(r.get("eventCount")),
            "keyEvents":       _f(r.get("keyEvents")),
            "purchases":       _f(r.get("purchases")),
            "items":           _f(r.get("items")),
            "revenue":         _f(r.get("revenue")),
        })
    return out


def _bd(frm, to, name_expr, limit):
    """One single-dimension breakdown straight off the consolidated fact table."""
    sql = f"""
      SELECT {name_expr} AS name, {_FACT_COLS}
      FROM {FACT}
      WHERE session_date BETWEEN @from AND @to
      GROUP BY name ORDER BY sessions DESC LIMIT @limit
    """
    return _map_breakdown(_q(sql, frm, to, limit))


# ─────────────────────────────────────────────────────────────
#  /data  — assemble the full dashboard payload from aggregates
# ─────────────────────────────────────────────────────────────
def build_payload(frm, to):
    # ---- daily rows ----
    daily = _q(f"""
      SELECT CAST(session_date AS STRING) AS date,
             COUNT(DISTINCT user_pseudo_id) AS users,
             COUNT(DISTINCT IF(is_new_user, user_pseudo_id, NULL)) AS newUsers,
             COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions,
             SUM(page_views) AS pageViews, SUM(event_count) AS eventCount,
             SUM(ev_purchase) AS purchases, SUM(key_events) AS keyEvents, SUM(revenue) AS revenue
      FROM {FACT}
      WHERE session_date BETWEEN @from AND @to GROUP BY session_date ORDER BY session_date
    """, frm, to)
    daily = [{
        "date": r["date"], "sessions": _f(r["sessions"]), "users": _f(r["users"]),
        "newUsers": _f(r["newUsers"]), "activeUsers": _f(r["users"]),
        "pageViews": _f(r["pageViews"]), "engagedSessions": _f(r["engagedSessions"]),
        "eventCount": _f(r["eventCount"]), "purchases": _f(r["purchases"]),
        "keyEvents": _f(r["keyEvents"]), "revenue": _f(r["revenue"]),
    } for r in daily]

    # ---- totals (HLL merge for distinct users; weighted avg eng time) ----
    tr = _q(f"""
      SELECT
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNT(DISTINCT IF(is_new_user, user_pseudo_id, NULL)) AS newUsers,
        COUNT(*) AS sessions, COUNTIF(engaged) AS engagedSessions,
        SUM(page_views) AS pageViews, SUM(event_count) AS eventCount,
        SUM(key_events) AS keyEvents, SUM(transactions) AS purchases,
        SUM(items_qty) AS itemsPurchased, SUM(ev_add_to_cart) AS addToCarts,
        SUM(ev_begin_checkout) AS checkouts, SUM(revenue) AS revenue,
        SAFE_DIVIDE(COUNTIF(engaged), COUNT(*)) * 100 AS engagementRate,
        SAFE_DIVIDE(SUM(engagement_time_sec), COUNT(DISTINCT user_pseudo_id)) AS avgEngTime,
        SUM(ev_view_item) AS viewItem, SUM(ev_add_to_cart) AS addToCart,
        SUM(ev_begin_checkout) AS beginCheckout, SUM(ev_add_payment) AS addPayment,
        SUM(ev_purchase) AS purchaseEv
      FROM {FACT}
      WHERE session_date BETWEEN @from AND @to
    """, frm, to)
    t = tr[0] if tr else {}
    totals = {
        "sessions": _f(t.get("sessions")), "users": _f(t.get("users")),
        "newUsers": _f(t.get("newUsers")), "activeUsers": _f(t.get("users")),
        "pageViews": _f(t.get("pageViews")), "engagedSessions": _f(t.get("engagedSessions")),
        "eventCount": _f(t.get("eventCount")), "keyEvents": _f(t.get("keyEvents")),
        "revenue": _f(t.get("revenue")), "engagementRate": _f(t.get("engagementRate")),
        "avgSessionDur": _f(t.get("avgEngTime")), "avgEngTime": _f(t.get("avgEngTime")),
        "purchases": _f(t.get("purchases")), "itemsPurchased": _f(t.get("itemsPurchased")),
        "addToCarts": _f(t.get("addToCarts")), "checkouts": _f(t.get("checkouts")),
    }

    # ---- funnel (event counts from daily sums) ----
    funnel = [
        {"name": "view_item",        "count": _f(t.get("viewItem"))},
        {"name": "add_to_cart",      "count": _f(t.get("addToCart"))},
        {"name": "begin_checkout",   "count": _f(t.get("beginCheckout"))},
        {"name": "add_payment_info", "count": _f(t.get("addPayment"))},
        {"name": "purchase",         "count": _f(t.get("purchaseEv"))},
    ]

    # ---- all single-dimension breakdowns (fact-table columns) ----
    channels    = _bd(frm, to, "channel", 20)
    sources     = _bd(frm, to, "source", TOP_LIMIT)
    mediums     = _bd(frm, to, "medium", 20)
    campaigns   = _bd(frm, to, "campaign", TOP_LIMIT)
    sourceMed   = _bd(frm, to, "CONCAT(source, ' / ', medium)", TOP_LIMIT)
    devices     = _bd(frm, to, "device_category", 10)
    browsers    = _bd(frm, to, "browser", 15)
    opsys       = _bd(frm, to, "operating_system", 15)
    platforms   = _bd(frm, to, "platform", 10)
    countries   = _bd(frm, to, "country", 25)
    regions     = _bd(frm, to, "region", 25)
    cities      = _bd(frm, to, "city", 30)
    languages   = _bd(frm, to, "language", 20)
    hostnames   = _bd(frm, to, "hostname", 10)
    newReturn   = _bd(frm, to, "IF(is_new_user, 'new', 'returning')", 5)
    contentGrp  = _bd(frm, to, "content_group", 15)
    landing     = _bd(frm, to, "landing_page", TOP_LIMIT)

    # ---- events (UNNEST events[]) → {name,count,users} ----
    ev_rows = _q(f"""
      SELECT e.event_name AS name, SUM(e.cnt) AS count,
             COUNT(DISTINCT user_pseudo_id) AS users
      FROM {FACT}, UNNEST(events) AS e
      WHERE session_date BETWEEN @from AND @to
      GROUP BY name ORDER BY count DESC LIMIT @limit
    """, frm, to, TOP_LIMIT)
    events = [{"name": r["name"] or "(unnamed)", "count": _f(r["count"]), "users": _f(r["users"])}
              for r in ev_rows]

    # ---- pages (UNNEST pages[]) → {path,title,views,users} ----
    pg = _q(f"""
      SELECT p.page_path AS path, ANY_VALUE(p.page_title) AS title,
             SUM(p.views) AS views, COUNT(DISTINCT user_pseudo_id) AS users
      FROM {FACT}, UNNEST(pages) AS p
      WHERE session_date BETWEEN @from AND @to
      GROUP BY path ORDER BY views DESC LIMIT @limit
    """, frm, to, TOP_LIMIT)
    pages = [{"path": r["path"] or "(not set)", "title": r["title"] or "(not set)",
              "views": _f(r["views"]), "users": _f(r["users"])} for r in pg]

    # ---- items / products (UNNEST items[]) ----
    it = _q(f"""
      SELECT it.item_name AS name, ANY_VALUE(it.item_category) AS category, ANY_VALUE(it.item_brand) AS brand,
             SUM(IF(it.event_name='purchase', it.quantity, 0))     AS items,
             SUM(IF(it.event_name='purchase', it.item_revenue, 0)) AS revenue,
             COUNTIF(it.event_name='view_item')                    AS views,
             COUNTIF(it.event_name='add_to_cart')                  AS addToCart
      FROM {FACT}, UNNEST(items) AS it
      WHERE session_date BETWEEN @from AND @to
      GROUP BY name ORDER BY revenue DESC LIMIT @limit
    """, frm, to, TOP_LIMIT)
    items = [{"name": r["name"] or "(not set)", "category": r["category"] or "(not set)",
              "brand": r["brand"] or "(not set)", "items": _f(r["items"]),
              "revenue": _f(r["revenue"]), "views": _f(r["views"]),
              "addToCart": _f(r["addToCart"])} for r in it]

    win_from = daily[0]["date"] if daily else frm.isoformat()
    win_to = daily[-1]["date"] if daily else to.isoformat()
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "bigquery_fact_table:ga4_fact_sessions",
        "currency": CURRENCY,
        "window": {"from": win_from, "to": win_to},
        "metrics": {"keyEvent": "key_events", "revenue": "purchase_revenue"},
        "totals": totals, "daily": daily,
        "channels": channels, "sourceMedium": sourceMed, "sources": sources,
        "mediums": mediums, "campaigns": campaigns, "landingPages": landing,
        "devices": devices, "browsers": browsers, "operatingSystems": opsys,
        "screenResolutions": [], "platforms": platforms, "countries": countries,
        "regions": regions, "cities": cities, "languages": languages,
        "hostnames": hostnames, "newReturning": newReturn, "contentGroups": contentGrp,
        "pages": pages, "events": events, "funnel": funnel, "items": items,
        "warnings": [],
    }


# ─────────────────────────────────────────────────────────────
#  routes
# ─────────────────────────────────────────────────────────────
@app.route("/", methods=["GET"])
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "project": PROJECT, "dataset": DATASET,
                    "currency": CURRENCY, "gemini": bool(GEMINI_KEY)})


@app.route("/data", methods=["GET", "OPTIONS"])
def data():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    try:
        frm, to = _range()
        payload = build_payload(frm, to)
        resp = make_response(json.dumps(payload), 200)
        resp.headers["Content-Type"] = "application/json"
        resp.headers["Cache-Control"] = "public, max-age=300"   # 5-min edge cache is fine (daily data)
        return resp
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": "query_error", "detail": str(e)[:400]}), 500


def _authed():
    """True if the caller presents the shared REFRESH_TOKEN (Cloud Scheduler OIDC
    is enforced separately by Cloud Run IAM when --no-allow-unauthenticated)."""
    if not REFRESH_TOKEN:
        return True  # rely on Cloud Run IAM / OIDC only
    auth = request.headers.get("Authorization", "")
    return auth == f"Bearer {REFRESH_TOKEN}"


def _prime_sql(sql, date_str):
    """Override the DECLARE target_date default with an explicit date, if given."""
    if not date_str:
        return sql
    return re.sub(
        r"DECLARE\s+target_date\s+DATE\s+DEFAULT[^;]+;",
        f"DECLARE target_date DATE DEFAULT DATE '{date_str}';",
        sql, count=1,
    )


# The single consolidated fact table is (re)built by one query. (The old 6
# per-topic aggregate refreshes are superseded by ga4_fact_sessions.)
REFRESH_FILES = [
    "fact_sessions.sql",
]


@app.route("/refresh", methods=["POST", "OPTIONS"])
def refresh():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    if not _authed():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    date_str = body.get("date") or request.args.get("date")  # optional YYYY-MM-DD
    results = []
    for fname in REFRESH_FILES:
        sql = _prime_sql((SQL_DIR / fname).read_text(encoding="utf-8"), date_str)
        try:
            job = bq().query(sql)
            job.result()
            results.append({"file": fname, "ok": True, "bytes_processed": job.total_bytes_processed})
        except Exception as e:  # noqa: BLE001
            results.append({"file": fname, "ok": False, "error": str(e)[:300]})
    ok = all(r["ok"] for r in results)
    return jsonify({"ok": ok, "date": date_str or "yesterday_IST", "steps": results}), (200 if ok else 500)


# ─────────────────────────────────────────────────────────────
#  AI (Gemini) — grounded on the aggregates. Degrades gracefully.
# ─────────────────────────────────────────────────────────────
def _gemini(prompt, system=None):
    if not GEMINI_KEY:
        return None, "gemini_not_configured"
    try:
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL, system_instruction=system)
        return model.generate_content(prompt).text, None
    except Exception as e:  # noqa: BLE001
        return None, str(e)[:300]


def _ai_context(days=30):
    """Compact JSON snapshot of the last N days for the model to reason over."""
    to = dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).date()
    frm = to - dt.timedelta(days=days - 1)
    p = build_payload(frm, to)
    # trim big arrays so the prompt stays small/cheap
    slim = {k: p[k] for k in ("window", "currency", "totals", "funnel")}
    for k in ("channels", "campaigns", "cities", "devices", "items", "landingPages", "events"):
        slim[k] = p.get(k, [])[:10]
    slim["daily"] = p.get("daily", [])
    return slim


AI_SYSTEM = (
    "You are the analytics co-pilot for Lucira Jewelry, an Indian D2C jewelry "
    "brand. You are given GA4 e-commerce aggregates (revenue in INR). Answer the "
    "user's question precisely using ONLY the data provided. Be concrete, cite "
    "numbers, and when asked for actions give prioritized, quantified recommendations "
    "(impact, confidence, expected revenue effect). Never invent data you weren't given."
)


@app.route("/ai", methods=["POST", "OPTIONS"])
def ai():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    if not question:
        return jsonify({"error": "no_question"}), 400
    ctx = body.get("context") or _ai_context(int(body.get("days", 30)))
    prompt = f"DATA (JSON):\n{json.dumps(ctx)[:120000]}\n\nQUESTION: {question}"
    text, err = _gemini(prompt, AI_SYSTEM)
    if err:
        return jsonify({"answer": None, "error": err,
                        "hint": "Set GEMINI_API_KEY on the service to enable generative AI. "
                                "The dashboard falls back to its built-in local assistant."}), 200
    return jsonify({"answer": text, "model": GEMINI_MODEL}), 200


REPORT_SECTIONS = (
    "Executive Summary, Revenue Summary, Traffic Summary, Conversion Summary, "
    "Campaign Summary, Product Summary, Top Winners, Top Losers, Customer Insights, "
    "Anomaly Detection, Revenue Forecast, Business Risks, Growth Opportunities, "
    "Priority Actions (each action with Impact, Confidence %, Expected Revenue, Owner, Timeline)"
)


@app.route("/report", methods=["GET", "POST", "OPTIONS"])
def report():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    # GET → return the latest stored report
    if request.method == "GET":
        rows = _q(f"""
          SELECT CAST(generated_at AS STRING) AS generated_at, CAST(report_date AS STRING) AS report_date,
                 model, report_md
          FROM {FQ}.ga4_ai_reports`
          WHERE report_date BETWEEN @from AND @to
          ORDER BY generated_at DESC LIMIT 1
        """, dt.date.today() - dt.timedelta(days=90), dt.date.today())
        return jsonify(rows[0] if rows else {"report_md": None}), 200

    # POST → generate + store (Cloud Scheduler calls this after /refresh)
    if not _authed():
        return jsonify({"error": "unauthorized"}), 401
    ctx = _ai_context(30)
    prompt = (f"Write the Lucira daily GA4 business report in markdown with these sections: "
              f"{REPORT_SECTIONS}. DATA (JSON):\n{json.dumps(ctx)[:120000]}")
    text, err = _gemini(prompt, AI_SYSTEM)
    if err:
        return jsonify({"ok": False, "error": err}), 200
    report_date = ctx["window"]["to"]
    bq().query(
        f"INSERT INTO {FQ}.ga4_ai_reports` (generated_at, report_date, model, scope, report_md) "
        f"VALUES (CURRENT_TIMESTAMP(), @d, @m, 'daily', @md)",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("d", "DATE", report_date),
            bigquery.ScalarQueryParameter("m", "STRING", GEMINI_MODEL),
            bigquery.ScalarQueryParameter("md", "STRING", text),
        ]),
    ).result()
    return jsonify({"ok": True, "report_date": report_date, "report_md": text}), 200


# ─────────────────────────────────────────────────────────────
#  /snapshot — build the daily static JSON the dashboard reads.
#  Cloud Scheduler calls this once/day (after /refresh). The dashboard loads the
#  resulting GCS object once and reuses it all day — no per-load BigQuery.
# ─────────────────────────────────────────────────────────────
@app.route("/snapshot", methods=["POST", "OPTIONS"])
def snapshot():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    if not _authed():
        return jsonify({"error": "unauthorized"}), 401
    if not SNAPSHOT_BUCKET:
        return jsonify({"error": "no_bucket", "detail": "Set SNAPSHOT_BUCKET to enable static snapshots."}), 400
    # Build a wide-window payload so the dashboard can filter any preset (incl. YTD) client-side.
    to = dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).date()
    frm = to - dt.timedelta(days=SNAPSHOT_DAYS - 1)
    payload = build_payload(frm, to)
    payload["snapshot"] = {"built_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                           "refresh_ist": "09:00", "days": SNAPSHOT_DAYS}
    body = json.dumps(payload, separators=(",", ":"))
    date_str = payload["window"]["to"]
    try:
        from google.cloud import storage
        bucket = storage.Client(project=PROJECT).bucket(SNAPSHOT_BUCKET)
        for name in (f"{SNAPSHOT_PREFIX}/latest.json", f"{SNAPSHOT_PREFIX}/{date_str}.json"):
            blob = bucket.blob(name)
            blob.cache_control = "public, max-age=300"
            blob.upload_from_string(body, content_type="application/json")
        url = f"https://storage.googleapis.com/{SNAPSHOT_BUCKET}/{SNAPSHOT_PREFIX}/latest.json"
        return jsonify({"ok": True, "date": date_str, "url": url, "bytes": len(body)}), 200
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)[:400]}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
