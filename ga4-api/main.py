"""
GA4 (Google Analytics 4) → Traffic Dashboard data API
=====================================================
HTTP Cloud Function that reads a **GA4 property via the Google Analytics Data
API v1** and returns compact traffic metrics as JSON for the "Traffic" tab in
dashboard/deals-vs-call.html.

Same thin-data-pump philosophy as gcp-cost-api / zoho-crm-api: this function
only runs a handful of GA4 reports and returns named, pre-shaped arrays; the
dashboard does ALL of the charting client-side.

Data source
-----------
Set GA4_PROPERTY_ID to your numeric GA4 property id (Admin → Property Settings →
"PROPERTY ID", e.g. 345678901). NOT the "G-XXXX" measurement id.

Auth
----
Uses Application Default Credentials. In production the Cloud Function's runtime
service account is used. That service account's email must be granted at least
**Viewer** access on the GA4 property (GA4 Admin → Property Access Management →
add the SA email, role = Viewer), and the **Google Analytics Data API** must be
enabled in the function's GCP project. No secrets are stored in source.

Deploy (same pattern as gcp-cost-api)
-------------------------------------
    gcloud functions deploy ga4-data \
        --gen2 --runtime=python312 --region=asia-south1 \
        --source=. --entry-point=ga4_data --trigger-http --allow-unauthenticated \
        --set-env-vars 'GA4_PROPERTY_ID=345678901,GA4_CURRENCY=INR,WINDOW_DAYS=90'

Then paste the function URL into CONFIG.GA4_API in dashboard/app.js.

Query params
------------
    ?from=YYYY-MM-DD&to=YYYY-MM-DD   explicit range (the dashboard passes the
                                     global date filter here), OR
    ?days=90                         trailing window ending today (fallback)
    ?debug=1                         include timing / row counts
"""

import os
import json
import time
from datetime import datetime, timezone

import functions_framework
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import (
    RunReportRequest, DateRange, Dimension, Metric, OrderBy,
)

# ─────────────────────────────────────────────────────────────
#  CONFIG (from environment)
# ─────────────────────────────────────────────────────────────
_PID          = os.environ.get("GA4_PROPERTY_ID", "").strip()
PROPERTY      = _PID if _PID.startswith("properties/") else (f"properties/{_PID}" if _PID else "")
CURRENCY      = os.environ.get("GA4_CURRENCY", "INR")
DEFAULT_DAYS  = int(os.environ.get("WINDOW_DAYS", "90"))
MAX_DAYS      = 400
TOP_LIMIT     = int(os.environ.get("TOP_LIMIT", "30"))   # rows for pages/sources/etc.


def _dedupe(seq):
    seen, out = set(), []
    for x in seq:
        x = (x or "").strip()
        if x and x not in seen:
            seen.add(x); out.append(x)
    return out


# GA4 renamed "conversions" → "keyEvents" in 2024. Probe candidates in order and
# use whichever the property/API accepts; likewise for the revenue metric.
KEY_EVENT_CANDIDATES = _dedupe([os.environ.get("GA4_CONVERSION_METRIC", ""), "keyEvents", "conversions"])
REVENUE_CANDIDATES   = _dedupe([os.environ.get("GA4_REVENUE_METRIC", ""), "totalRevenue", "purchaseRevenue"])

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}


# ─────────────────────────────────────────────────────────────
#  helpers
# ─────────────────────────────────────────────────────────────
def _fmt_date(ymd8: str) -> str:
    # GA4 'date' dimension comes back as YYYYMMDD
    return f"{ymd8[0:4]}-{ymd8[4:6]}-{ymd8[6:8]}" if ymd8 and len(ymd8) == 8 else ymd8


def _range(request):
    """Return (start_date, end_date) as GA4 accepts — either ISO dates or NdaysAgo/today."""
    frm, to = request.args.get("from"), request.args.get("to")
    if frm and to:
        return frm, to
    try:
        days = min(MAX_DAYS, max(1, int(request.args.get("days", DEFAULT_DAYS))))
    except (TypeError, ValueError):
        days = DEFAULT_DAYS
    return f"{days - 1}daysAgo", "today"


def _resolve_metric(client, start, end, candidates):
    """Return the first candidate metric name the property accepts, else None."""
    for name in candidates:
        try:
            client.run_report(RunReportRequest(
                property=PROPERTY,
                date_ranges=[DateRange(start_date="7daysAgo", end_date="today")],
                metrics=[Metric(name=name)],
                limit=1,
            ))
            return name
        except Exception:  # noqa: BLE001 — metric not available on this property/version
            continue
    return None


_METRIC_OK: dict = {}


def _metric_available(client, name):
    """Cache-checked probe: is this metric queryable on this property?"""
    if name in _METRIC_OK:
        return _METRIC_OK[name]
    try:
        client.run_report(RunReportRequest(
            property=PROPERTY,
            date_ranges=[DateRange(start_date="7daysAgo", end_date="today")],
            metrics=[Metric(name=name)], limit=1,
        ))
        _METRIC_OK[name] = True
    except Exception:  # noqa: BLE001
        _METRIC_OK[name] = False
    return _METRIC_OK[name]


def _keep_available(client, metrics):
    """Filter a metric list down to those the property actually supports."""
    return [x for x in metrics if _metric_available(client, x)]


def _run(client, start, end, dims, mets, order_metric=None, order_dim=None,
         order_desc=True, limit=None):
    req = RunReportRequest(
        property=PROPERTY,
        date_ranges=[DateRange(start_date=start, end_date=end)],
        dimensions=[Dimension(name=d) for d in dims],
        metrics=[Metric(name=m) for m in mets],
        limit=limit,
    )
    if order_metric:
        req.order_bys = [OrderBy(metric=OrderBy.MetricOrderBy(metric_name=order_metric), desc=order_desc)]
    elif order_dim:
        req.order_bys = [OrderBy(dimension=OrderBy.DimensionOrderBy(dimension_name=order_dim), desc=order_desc)]
    return client.run_report(req)


def _rows(resp):
    """Flatten a report response into a list of {dimName|metricName: value} dicts."""
    dh = [h.name for h in resp.dimension_headers]
    mh = [h.name for h in resp.metric_headers]
    out = []
    for r in (resp.rows or []):
        row = {}
        for i, name in enumerate(dh):
            row[name] = r.dimension_values[i].value
        for i, name in enumerate(mh):
            v = r.metric_values[i].value
            try:
                row[name] = float(v)
            except (TypeError, ValueError):
                row[name] = v
        out.append(row)
    return out


# ─────────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────────
@functions_framework.http
def ga4_data(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    if not PROPERTY:
        return (json.dumps({
            "error": "not_configured",
            "detail": "Set GA4_PROPERTY_ID (numeric GA4 property id) as an env var. "
                      "See README to grant the runtime service account Viewer access "
                      "on the property and enable the Google Analytics Data API.",
        }), 500, CORS)

    t0 = time.time()
    debug = request.args.get("debug") == "1"
    start, end = _range(request)
    warnings = []

    try:
        client = BetaAnalyticsDataClient()
    except Exception as e:  # noqa: BLE001
        return (json.dumps({"error": "auth_error", "detail": str(e)}), 502, CORS)

    # Resolve version-sensitive metric names once.
    key_metric = _resolve_metric(client, start, end, KEY_EVENT_CANDIDATES)
    rev_metric = _resolve_metric(client, start, end, REVENUE_CANDIDATES)
    if not key_metric:
        warnings.append("No key-event/conversion metric available; conversions omitted.")
    if not rev_metric:
        warnings.append("No revenue metric available; revenue omitted.")

    def m(v):  # round a metric to something compact
        return round(float(v or 0), 2)

    def safe(label, fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            warnings.append(f"{label}: {str(e)[:180]}")
            return None

    # ---- totals (no dimension → single row) ----
    core = ["sessions", "totalUsers", "newUsers", "activeUsers", "screenPageViews",
            "engagedSessions", "eventCount", "engagementRate", "averageSessionDuration",
            "userEngagementDuration", "transactions", "itemsPurchased",
            "addToCarts", "checkouts"]
    if key_metric:
        core.append(key_metric)
    if rev_metric:
        core.append(rev_metric)
    # Some of the above metrics are unavailable on older properties; probe & drop.
    core = _keep_available(client, core)

    totals = {"sessions": 0, "users": 0, "newUsers": 0, "activeUsers": 0, "pageViews": 0,
              "engagedSessions": 0, "eventCount": 0, "keyEvents": 0, "revenue": 0,
              "engagementRate": 0, "avgSessionDur": 0, "avgEngTime": 0,
              "purchases": 0, "itemsPurchased": 0, "addToCarts": 0, "checkouts": 0}
    tr = safe("totals", lambda: _rows(_run(client, start, end, [], core)))
    if tr:
        r = tr[0]
        au = float(r.get("activeUsers") or r.get("totalUsers") or 0)
        totals = {
            "sessions":        m(r.get("sessions")),
            "users":           m(r.get("totalUsers")),
            "newUsers":        m(r.get("newUsers")),
            "activeUsers":     m(r.get("activeUsers") or r.get("totalUsers")),
            "pageViews":       m(r.get("screenPageViews")),
            "engagedSessions": m(r.get("engagedSessions")),
            "eventCount":      m(r.get("eventCount")),
            "keyEvents":       m(r.get(key_metric)) if key_metric else 0,
            "revenue":         m(r.get(rev_metric)) if rev_metric else 0,
            "engagementRate":  round(float(r.get("engagementRate") or 0) * 100, 2),   # → %
            "avgSessionDur":   m(r.get("averageSessionDuration")),                    # seconds
            "avgEngTime":      round(float(r.get("userEngagementDuration") or 0) / au, 2) if au else 0,
            "purchases":       m(r.get("transactions")),
            "itemsPurchased":  m(r.get("itemsPurchased")),
            "addToCarts":      m(r.get("addToCarts")),
            "checkouts":       m(r.get("checkouts")),
        }

    # ---- daily time series ----
    daily_mets = _keep_available(client, [
        "sessions", "totalUsers", "newUsers", "activeUsers", "screenPageViews",
        "engagedSessions", "eventCount", "transactions"]
        + ([key_metric] if key_metric else []) + ([rev_metric] if rev_metric else []))
    daily = []
    dr = safe("daily", lambda: _rows(_run(client, start, end, ["date"], daily_mets,
                                          order_dim="date", order_desc=False)))
    for r in (dr or []):
        daily.append({
            "date":            _fmt_date(r.get("date", "")),
            "sessions":        m(r.get("sessions")),
            "users":           m(r.get("totalUsers")),
            "newUsers":        m(r.get("newUsers")),
            "activeUsers":     m(r.get("activeUsers") or r.get("totalUsers")),
            "pageViews":       m(r.get("screenPageViews")),
            "engagedSessions": m(r.get("engagedSessions")),
            "eventCount":      m(r.get("eventCount")),
            "purchases":       m(r.get("transactions")),
            "keyEvents":       m(r.get(key_metric)) if key_metric else 0,
            "revenue":         m(r.get(rev_metric)) if rev_metric else 0,
        })

    # ---- generic single-dimension breakdown ----------------------------------
    # Every dimension tab in the dashboard consumes the same metric bundle, so
    # one helper serves them all. Unavailable metrics are dropped per property.
    STD = _keep_available(client, [
        "totalUsers", "newUsers", "sessions", "engagedSessions", "screenPageViews",
        "eventCount", "engagementRate", "transactions", "itemsPurchased"]
        + ([key_metric] if key_metric else []) + ([rev_metric] if rev_metric else []))

    def breakdown(label, dim, limit=TOP_LIMIT, order="sessions"):
        rows = safe(label, lambda: _rows(_run(client, start, end, [dim], STD,
                                              order_metric=(order if order in STD else STD[0]),
                                              limit=limit))) or []
        out = []
        for r in rows:
            users = float(r.get("totalUsers") or 0)
            out.append({
                "name":            r.get(dim) or "(not set)",
                "users":           m(r.get("totalUsers")),
                "newUsers":        m(r.get("newUsers")),
                "sessions":        m(r.get("sessions")),
                "engagedSessions": m(r.get("engagedSessions")),
                "engagementRate":  round(float(r.get("engagementRate") or 0) * 100, 2),
                "views":           m(r.get("screenPageViews")),
                "eventCount":      m(r.get("eventCount")),
                "keyEvents":       m(r.get(key_metric)) if key_metric else 0,
                "purchases":       m(r.get("transactions")),
                "items":           m(r.get("itemsPurchased")),
                "revenue":         m(r.get(rev_metric)) if rev_metric else 0,
            })
        return out

    channels   = breakdown("channels",   "sessionDefaultChannelGroup", limit=20)
    sourceMed  = breakdown("sourceMed",   "sessionSourceMedium")
    sources    = breakdown("sources",     "sessionSource")
    mediums    = breakdown("mediums",     "sessionMedium", limit=20)
    campaigns  = breakdown("campaigns",   "sessionCampaignName")
    landing    = breakdown("landing",     "landingPagePlusQueryString")
    devices    = breakdown("devices",     "deviceCategory", limit=10)
    browsers   = breakdown("browsers",    "browser", limit=15)
    opsys      = breakdown("os",          "operatingSystem", limit=15)
    screenRes  = breakdown("screenRes",   "screenResolution", limit=15)
    platforms  = breakdown("platforms",   "platform", limit=10)
    countries  = breakdown("countries",   "country", limit=25)
    regions    = breakdown("regions",     "region", limit=25)
    cities     = breakdown("cities",      "city", limit=30)
    languages  = breakdown("languages",   "language", limit=20)
    hostnames  = breakdown("hostnames",   "hostName", limit=10)
    newReturn  = breakdown("newReturning", "newVsReturning", limit=5)

    # ---- pages (path + title) ----
    pages = []
    pr = safe("pages", lambda: _rows(_run(client, start, end, ["pagePath", "pageTitle"],
                                          _keep_available(client, ["screenPageViews", "totalUsers",
                                                                    "userEngagementDuration"]),
                                          order_metric="screenPageViews", limit=TOP_LIMIT)))
    for r in (pr or []):
        pages.append({
            "path":  r.get("pagePath") or "(not set)",
            "title": r.get("pageTitle") or "(not set)",
            "views": m(r.get("screenPageViews")),
            "users": m(r.get("totalUsers")),
        })

    # ---- content group ----
    contentGroups = breakdown("contentGroups", "contentGroup", limit=15) \
        if _metric_available(client, "engagementRate") else []

    # ---- events breakdown ----
    events = []
    evr = safe("events", lambda: _rows(_run(client, start, end, ["eventName"],
                                            _keep_available(client, ["eventCount", "totalUsers"]),
                                            order_metric="eventCount", limit=TOP_LIMIT)))
    for r in (evr or []):
        events.append({"name": r.get("eventName") or "(unnamed)",
                       "count": m(r.get("eventCount")), "users": m(r.get("totalUsers"))})

    # ---- e-commerce funnel (event counts for the standard purchase path) ----
    funnel_names = ["view_item", "add_to_cart", "begin_checkout", "add_payment_info", "purchase"]
    ev_map = {e["name"]: e["count"] for e in events}
    funnel = [{"name": n, "count": ev_map.get(n, 0)} for n in funnel_names]

    # ---- items (products) ----
    items = []
    it_mets = _keep_available(client, ["itemsPurchased", "itemRevenue", "itemsViewed", "itemsAddedToCart"])
    if it_mets:
        itr = safe("items", lambda: _rows(_run(client, start, end,
                                               ["itemName", "itemCategory", "itemBrand"],
                                               it_mets, order_metric=it_mets[0], limit=TOP_LIMIT)))
        for r in (itr or []):
            items.append({
                "name":     r.get("itemName") or "(not set)",
                "category": r.get("itemCategory") or "(not set)",
                "brand":    r.get("itemBrand") or "(not set)",
                "items":    m(r.get("itemsPurchased")),
                "revenue":  m(r.get("itemRevenue")),
                "views":    m(r.get("itemsViewed")),
                "addToCart": m(r.get("itemsAddedToCart")),
            })

    # window echo — derive real from/to from the daily rows when available
    win_from = daily[0]["date"] if daily else start
    win_to = daily[-1]["date"] if daily else end

    resp = {
        "generated_at":  datetime.now(timezone.utc).isoformat(),
        "property":      PROPERTY,
        "currency":      CURRENCY,
        "window":        {"from": win_from, "to": win_to},
        "metrics":       {"keyEvent": key_metric, "revenue": rev_metric},
        "totals":        totals,
        "daily":         daily,
        "channels":      channels,
        "sourceMedium":  sourceMed,
        "sources":       sources,
        "mediums":       mediums,
        "campaigns":     campaigns,
        "landingPages":  landing,
        "devices":       devices,
        "browsers":      browsers,
        "operatingSystems": opsys,
        "screenResolutions": screenRes,
        "platforms":     platforms,
        "countries":     countries,
        "regions":       regions,
        "cities":        cities,
        "languages":     languages,
        "hostnames":     hostnames,
        "newReturning":  newReturn,
        "contentGroups": contentGroups,
        "pages":         pages,
        "events":        events,
        "funnel":        funnel,
        "items":         items,
        "warnings":      warnings,
    }
    if debug:
        keys = ("daily", "channels", "sourceMedium", "campaigns", "landingPages",
                "devices", "browsers", "operatingSystems", "countries", "cities",
                "languages", "pages", "events", "items")
        resp["debug"] = {
            "elapsed_sec": round(time.time() - t0, 2),
            "requested_range": {"start": start, "end": end},
            "counts": {k: len(resp.get(k, [])) for k in keys},
        }
    return (json.dumps(resp), 200, CORS)
