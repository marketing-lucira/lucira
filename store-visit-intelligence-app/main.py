"""
Zoho Meeting -> Call -> Walk-in -> Sale Intelligence -- Cloud Run service
=========================================================================
Serves the dashboard (index.html + journey.js) and a small live JSON API behind
HTTP Basic Auth (the meeting table shows real customer names / mobile numbers).

Auth pattern unchanged from the previous Store Visit Intelligence build (copied
from zoho-login-dashboard/main.py): the gate is OFF only if DASH_USER/DASH_PASS
are both unset; they are Cloud Run env vars, never in code or frontend JS.

Data is LIVE from BigQuery: /api/journey reads the view
ds_imputed_reporting.zoho_meeting_journey_v (sql/meeting_journey_view.sql), which
is built on the 30-minute Zoho CDC tables + Walkin_marge + marketing_sale. The
result (~550 meetings) is cached in-process for CACHE_TTL_SEC so the ~240 MB view
scan runs at most once per TTL, not once per page view. No Zoho credentials are
used or needed by this service -- it only reads BigQuery with its runtime SA.

Endpoints
    GET /                 dashboard
    GET /api/journey      {refreshed_at_ist, rows[], health[]}   (?refresh=1 to bypass cache)
    GET /api/health       source-health only (cheap)
    GET /health           liveness (unauthenticated)
"""
import os
import gzip
import hmac
import json
import time
import threading
import datetime as dt

from flask import Flask, request, Response, send_from_directory
from google.cloud import bigquery

HERE = os.path.dirname(os.path.abspath(__file__))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

BQ_PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
JOURNEY_VIEW = os.environ.get("JOURNEY_VIEW", "lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v")
CACHE_TTL_SEC = int(os.environ.get("CACHE_TTL_SEC", "600"))
MIN_FORCE_REFRESH_SEC = 60

app = Flask(__name__, static_folder=None)

DASH_USER = os.environ.get("DASH_USER", "")
DASH_PASS = os.environ.get("DASH_PASS", "")
_AUTH_EXEMPT = frozenset(("/health",))


@app.before_request
def _require_login():
    if not (DASH_USER and DASH_PASS):
        return None
    if request.path in _AUTH_EXEMPT:
        return None
    auth = request.authorization
    if (auth is not None
            and hmac.compare_digest(auth.username or "", DASH_USER)
            and hmac.compare_digest(auth.password or "", DASH_PASS)):
        return None
    return Response(
        "Authentication required.", 401,
        {"WWW-Authenticate": 'Basic realm="Store Visit Intelligence"'},
    )


# Explicit column list (no SELECT *): exactly what the dashboard renders.
JOURNEY_COLUMNS = [
    "meeting_id", "meeting_title", "meeting_created_ist", "meeting_created_date", "from_date", "from_ist",
    "all_day", "meeting_status", "meeting_type", "meeting_location", "venue", "meeting_store_code", "store",
    "meeting_owner", "meeting_created_by", "meeting_description", "related_module",
    "customer_name", "mobile", "mobile_source", "contact_id",
    "deal_id", "deal_name", "deal_stage", "deal_trigger", "probability", "deal_city", "deal_state",
    "jc", "jc_source", "lead_source", "campaign_source", "utm_source", "utm_medium", "utm_campaign",
    "deal_store_assigned", "deal_record_type", "intent_stage", "deal_amount", "closing_date", "deal_created_ist",
    "calls_after", "connected_calls", "missed_calls", "first_call_ist", "last_call_ist", "first_connected_ist",
    "talk_time_sec",
    "prev_walkin", "prev_walkin_ist", "prev_walkin_store_code",
    "walkins_after", "first_walkin_ist", "first_walkin_store_code", "days_to_walkin",
    "sales_after", "sales_amount_after", "first_sale_ist", "first_sale_amount", "first_sale_store_code",
    "first_sale_channel", "first_sale_skus", "days_to_sale",
    "journey_status", "calls", "walkins", "sales",
]

# Source health: cheap metadata / narrow-column reads only.
#   CDC tables: MAX(synced_at) = when the 30-min Zoho sync last wrote; MAX(created_time) = newest record.
#   Walk-in / Sales: table last-modified + newest record timestamp (IST).
HEALTH_SQL = """
WITH t AS (
  SELECT table_id, TIMESTAMP_MILLIS(last_modified_time) AS last_modified
  FROM `lucirajewelry-prod.ds_imputed_reporting.__TABLES__`
  WHERE table_id IN ('Walkin_marge', 'marketing_sale')
)
SELECT 'Zoho Meetings' AS source, 'zoho_crm.cdc_meetings' AS tbl, MAX(synced_at) AS last_sync, MAX(created_time) AS latest_record, COUNT(*) AS n
  FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
UNION ALL
SELECT 'Zoho Deals', 'zoho_crm.cdc_deals', MAX(synced_at), MAX(created_time), COUNT(*) FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
UNION ALL
SELECT 'Zoho Calls', 'zoho_crm.cdc_calls', MAX(synced_at), MAX(created_time), COUNT(*) FROM `lucirajewelry-prod.zoho_crm.cdc_calls`
UNION ALL
SELECT 'Walk-in', 'ds_imputed_reporting.Walkin_marge',
  (SELECT last_modified FROM t WHERE table_id = 'Walkin_marge'),
  TIMESTAMP(DATETIME_SUB(MAX(SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', walkin_date)), INTERVAL 330 MINUTE), 'Asia/Kolkata'),
  COUNT(*)
  FROM `lucirajewelry-prod.ds_imputed_reporting.Walkin_marge`
UNION ALL
SELECT 'Sales', 'ds_imputed_reporting.marketing_sale',
  (SELECT last_modified FROM t WHERE table_id = 'marketing_sale'),
  TIMESTAMP(MAX(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date)), 'Asia/Kolkata'),
  COUNT(DISTINCT document_no)
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
"""
# How old a source's last write may be before it is flagged STALE.
STALE_AFTER_MIN = {"Zoho Meetings": 90, "Zoho Deals": 90, "Zoho Calls": 90, "Walk-in": 36 * 60, "Sales": 36 * 60}
CADENCE = {"Zoho Meetings": "CDC sync every 30 min", "Zoho Deals": "CDC sync every 30 min",
           "Zoho Calls": "CDC sync every 30 min", "Walk-in": "daily load (~06:30 IST)",
           "Sales": "refreshed through the day"}

_bq = None
_lock = threading.Lock()
_cache = {"at": 0.0, "payload": None}


def _client():
    global _bq
    if _bq is None:
        _bq = bigquery.Client(project=BQ_PROJECT)
    return _bq


def _ist(ts):
    return ts.astimezone(IST).strftime("%Y-%m-%dT%H:%M:%S") if ts else None


def _jsonable(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if hasattr(v, "as_integer_ratio") and not isinstance(v, (int, float)):  # Decimal
        return float(v)
    return v


def _json(payload, status=200):
    """JSON response, gzip-compressed when the browser accepts it (journey payload is ~1 MB raw)."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Accept-Encoding"}
    if "gzip" in (request.headers.get("Accept-Encoding") or ""):
        body = gzip.compress(body, compresslevel=6)
        headers["Content-Encoding"] = "gzip"
    return Response(body, status, headers)


def fetch_health():
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    try:
        for r in _client().query(HEALTH_SQL).result():
            age_min = round((now - r["last_sync"]).total_seconds() / 60) if r["last_sync"] else None
            status = "OK" if age_min is not None and age_min <= STALE_AFTER_MIN[r["source"]] else "STALE"
            out.append({"source": r["source"], "table": r["tbl"], "last_sync_ist": _ist(r["last_sync"]),
                        "latest_record_ist": _ist(r["latest_record"]), "rows": r["n"],
                        "age_min": age_min, "status": status, "cadence": CADENCE[r["source"]]})
    except Exception as e:  # noqa: BLE001 -- surfaced to the UI as a visible warning, never hidden
        out.append({"source": "All sources", "status": "ERROR", "error": str(e)[:500]})
    order = list(STALE_AFTER_MIN)
    out.sort(key=lambda h: order.index(h["source"]) if h["source"] in order else 99)
    return out


def fetch_journey():
    sql = f"SELECT {', '.join(JOURNEY_COLUMNS)} FROM `{JOURNEY_VIEW}` ORDER BY meeting_created_ist DESC"
    rows = [{k: _jsonable(r[k]) for k in JOURNEY_COLUMNS} for r in _client().query(sql).result()]
    return rows


def build_payload():
    t0 = time.time()
    payload = {"refreshed_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"),
               "cache_ttl_sec": CACHE_TTL_SEC, "view": JOURNEY_VIEW}
    try:
        payload["rows"] = fetch_journey()
        payload["ok"] = True
    except Exception as e:  # noqa: BLE001
        payload["rows"] = []
        payload["ok"] = False
        payload["error"] = str(e)[:800]
    payload["health"] = fetch_health()
    payload["elapsed_sec"] = round(time.time() - t0, 2)
    return payload


@app.route("/health")
def health():
    return {"status": "ok"}


@app.route("/api/journey")
def api_journey():
    force = request.args.get("refresh") == "1"
    with _lock:
        age = time.time() - _cache["at"]
        stale = _cache["payload"] is None or age > CACHE_TTL_SEC or not _cache["payload"].get("ok")
        if stale or (force and age > MIN_FORCE_REFRESH_SEC):
            payload = build_payload()
            if payload["ok"]:
                _cache.update(at=time.time(), payload=payload)
            elif _cache["payload"] is not None and _cache["payload"].get("ok"):
                # Keep serving the last good result, but flag the failed refresh visibly.
                cached = dict(_cache["payload"])
                cached["refresh_error"] = payload["error"]
                cached["health"] = payload["health"]
                cached["cache_age_sec"] = round(time.time() - _cache["at"])
                return _json(cached)
            else:
                return _json(payload, 502)
        payload = dict(_cache["payload"])
    payload["cache_age_sec"] = round(time.time() - _cache["at"])
    return _json(payload)


@app.route("/api/health")
def api_health():
    return _json({"checked_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"), "health": fetch_health()})


@app.route("/")
@app.route("/index.html")
def index():
    resp = send_from_directory(HERE, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/journey.js")
def journey_js():
    resp = send_from_directory(HERE, "journey.js")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
