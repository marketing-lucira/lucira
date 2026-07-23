"""
Zoho CRM → Dashboard data API
=================================================
HTTP Cloud Function that pulls Deals, Calls and Events from Zoho CRM (India DC)
and returns them as compact JSON arrays for the CRM Performance Dashboard.

The dashboard does ALL business logic client-side (unique-deal dedup, deal<->call
connectivity, SLA, executive ranking, AI insights). This function is a thin,
paginated data pump — keep it dumb so the logic stays visible in the dashboard.

Deploy (same pattern as zoho-task-function):
    gcloud functions deploy zoho-crm-data \
        --gen2 --runtime=python312 --region=asia-south1 \
        --source=. --entry-point=crm_data --trigger-http --allow-unauthenticated

Then set   API_BASE = "https://<your-cloud-run-url>"   in crm-dashboard.html.

Query params:
    days   int   Only return records created within the last N days (default 120,
                 0 = all history). Smaller = faster + lighter payload.
    debug  1     Include per-module counts + timing in the response.

SECURITY: credentials are read from environment variables. Set them at deploy time
    --set-env-vars ZOHO_CLIENT_ID=...,ZOHO_CLIENT_SECRET=...,ZOHO_REFRESH_TOKEN=...
    Do NOT hardcode secrets in source (your zoho-task-function/main.py currently
    does — rotate those and move them to env vars).
"""

import os
import json
import time
from datetime import datetime, timedelta, timezone

import requests
import functions_framework

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
ZOHO_DC        = os.environ.get("ZOHO_DC", "in")          # in | com | eu | ...
ZOHO_COQL_URL  = f"https://www.zohoapis.{ZOHO_DC}/crm/v8/coql"
ZOHO_TOKEN_URL = f"https://accounts.zoho.{ZOHO_DC}/oauth/v2/token"

CLIENT_ID     = os.environ.get("ZOHO_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("ZOHO_CLIENT_SECRET", "")
REFRESH_TOKEN = os.environ.get("ZOHO_REFRESH_TOKEN", "")

PAGE_SIZE = 2000          # Zoho COQL hard max per request
MAX_ROWS  = 100000        # safety ceiling per module

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}

# Fields pulled per module — keep in sync with the dashboard's field map.
DEAL_FIELDS = [
    "id", "Deal_Name", "Mobile", "Alternate_mobile", "Created_Time", "Owner",
    "Stage", "Amount", "Type", "Deal_Trigger_Event", "Lead_Source",
    "UTM_Source", "UTM_Campaign", "UTM_Medium", "Campaign_Source",
    "Store_Assigned", "Store_Executive", "Address_City", "Address_State_Province",
    "Closing_Date", "Contact_Name",
]
CALL_FIELDS = [
    "id", "Call_Type", "Call_Start_Time", "Call_Duration_in_seconds",
    "Call_Result", "Call_Purpose", "Owner", "To_Number__s", "From_Number__s",
    "Who_Id", "What_Id", "Created_Time",
]
EVENT_FIELDS = [
    "id", "Event_Title", "Start_DateTime", "End_DateTime", "Owner",
    "Check_In_Status", "Venue", "Created_Time",
]


# ─────────────────────────────────────────────────────────────
#  ZOHO HELPERS
# ─────────────────────────────────────────────────────────────
def get_access_token() -> str:
    if not (CLIENT_ID and CLIENT_SECRET and REFRESH_TOKEN):
        raise RuntimeError(
            "Missing Zoho credentials. Set ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / "
            "ZOHO_REFRESH_TOKEN environment variables."
        )
    r = requests.post(
        ZOHO_TOKEN_URL,
        data={
            "refresh_token": REFRESH_TOKEN,
            "client_id":     CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type":    "refresh_token",
        },
        timeout=30,
    )
    r.raise_for_status()
    tok = r.json()
    if "access_token" not in tok:
        raise RuntimeError(f"Token refresh failed: {tok}")
    return tok["access_token"]


def coql_page(token: str, query: str) -> dict:
    r = requests.post(
        ZOHO_COQL_URL,
        headers={"Authorization": f"Zoho-oauthtoken {token}",
                 "Content-Type": "application/json"},
        json={"select_query": query},
        timeout=60,
    )
    if r.status_code == 204:            # no content
        return {"data": [], "info": {"more_records": False}}
    r.raise_for_status()
    return r.json()


def fetch_all(token: str, module: str, fields: list, where: str) -> list:
    """Paginate a COQL query over a module and return all rows."""
    cols = ", ".join(fields)
    rows, offset = [], 0
    while offset < MAX_ROWS:
        q = (f"select {cols} from {module} where {where} "
             f"order by Created_Time desc limit {PAGE_SIZE} offset {offset}")
        payload = coql_page(token, q)
        batch = payload.get("data", []) or []
        rows.extend(batch)
        info = payload.get("info", {}) or {}
        if not info.get("more_records") or len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(0.15)               # be gentle on the API rate limit
    return rows


def flatten_lookup(v):
    """Zoho returns lookups/owners as {name,id}. Keep both, compact."""
    if isinstance(v, dict):
        return {"id": v.get("id"), "name": v.get("name")}
    return v


def slim(rows: list, lookup_fields: set) -> list:
    out = []
    for row in rows:
        rec = {}
        for k, v in row.items():
            rec[k] = flatten_lookup(v) if k in lookup_fields else v
        out.append(rec)
    return out


# ─────────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────────
@functions_framework.http
def crm_data(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    t0 = time.time()
    try:
        days = int(request.args.get("days", "120"))
    except ValueError:
        days = 120
    debug = request.args.get("debug") == "1"

    if days > 0:
        since = (datetime.now(timezone.utc) - timedelta(days=days))
        # Zoho wants ISO8601 with offset; use +00:00 (UTC) — COQL accepts it.
        since_str = since.strftime("%Y-%m-%dT%H:%M:%S+00:00")
        deal_where = f"Created_Time >= '{since_str}'"
        call_where = f"Call_Start_Time >= '{since_str}'"
        event_where = f"Start_DateTime >= '{since_str}'"
    else:
        deal_where = call_where = "id is not null"
        event_where = "id is not null"

    try:
        token = get_access_token()
        deals  = slim(fetch_all(token, "Deals",  DEAL_FIELDS,  deal_where),
                      {"Owner", "Created_By", "Contact_Name", "Campaign_Source"})
        calls  = slim(fetch_all(token, "Calls",  CALL_FIELDS,  call_where),
                      {"Owner", "Who_Id", "What_Id"})
        events = slim(fetch_all(token, "Events", EVENT_FIELDS, event_where),
                      {"Owner"})
    except requests.HTTPError as e:
        body = getattr(e.response, "text", str(e))
        return (json.dumps({"error": "zoho_http_error", "detail": body}), 502, CORS)
    except Exception as e:                                    # noqa: BLE001
        return (json.dumps({"error": "server_error", "detail": str(e)}), 500, CORS)

    resp = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days":  days,
        "deals":  deals,
        "calls":  calls,
        "events": events,
    }
    if debug:
        resp["debug"] = {
            "deal_count":  len(deals),
            "call_count":  len(calls),
            "event_count": len(events),
            "elapsed_sec": round(time.time() - t0, 2),
        }
    return (json.dumps(resp), 200, CORS)
