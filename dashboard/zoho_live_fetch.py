#!/usr/bin/env python3
"""
Shared live Zoho CRM REST fetch helper for build_dcm_data.py / build_svci_data.py
(--source live mode). NOT a replacement for the BigQuery path -- an additive overlay that
reshapes live Deals/Calls/Events REST data into the exact same in-memory row shape that
sql/dcm_build.sql / sql/svci_build.sql already produce via `bq query`, so all downstream
join/aggregation/KPI code in the two build scripts runs completely unchanged.

Credentials: read from dashboard/../etl/.zoho.env (git-ignored, 3 lines: ZOHO_CLIENT_ID,
ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN). Never print/log the actual secret or token values.

Scope limitation (confirmed live 2026-09-17): the OAuth grant is ZohoCRM.modules.ALL only.
The COQL query endpoint (/crm/v8/coql) returns OAUTH_SCOPE_MISMATCH under this grant and does
NOT work here. Only the plain REST Modules API (GET /crm/v8/<Module>) is usable, so this
module paginates each module's full record set client-side instead of running a COQL query.

Store_Assigned is intentionally never requested on Deals -- verified 0% populated (BigQuery
side), not expected to differ live.
"""
import os
import time
import datetime
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ETL_DIR = os.path.join(os.path.dirname(HERE), "etl")
ZOHO_ENV_PATH = os.path.join(ETL_DIR, ".zoho.env")

DC = "in"
TOKEN_URL = f"https://accounts.zoho.{DC}/oauth/v2/token"
API_BASE = f"https://www.zohoapis.{DC}/crm/v8"

PER_PAGE = 200
MAX_RETRY = 5

DEAL_FIELDS = [
    "id", "Deal_Name", "Owner", "Created_Time", "Address_City", "Address_State",
    "Mobile", "Email", "Stage", "Amount", "Contact_Name", "Lead_Source",
    "UTM_Source", "UTM_Medium", "UTM_Campaign", "Campaign_Source",
]
CALL_FIELDS = ["id", "What_Id", "Call_Duration_in_seconds", "Call_Start_Time", "Owner", "Call_Type"]
EVENT_FIELDS = ["id", "What_Id", "Venue", "Owner", "Created_Time", "Event_Title", "Description", "Created_By"]

# Fields for the "Meeting Intelligence" tab (build_svci_data.py) -- ALL Events/Meetings,
# not filtered to deal-linked ones. Confirmed live 2026-09-17 against the real v8 REST API:
# there is NO "Location" field on this module -- requesting it gets it silently dropped, so
# it is deliberately excluded here.
ALL_EVENTS_FIELDS = ["id", "Event_Title", "Venue", "Start_DateTime", "End_DateTime", "Created_Time", "Owner"]


def _read_zoho_env():
    if not os.path.exists(ZOHO_ENV_PATH):
        raise RuntimeError(
            f"Live mode requires {ZOHO_ENV_PATH} to exist (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, "
            "ZOHO_REFRESH_TOKEN). See etl/_lib.ps1 Get-ZohoCreds for the reference pattern."
        )
    creds = {}
    with open(ZOHO_ENV_PATH, "r", encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip()
    missing = [k for k in ("ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN") if not creds.get(k)]
    if missing:
        raise RuntimeError(f"etl/.zoho.env is missing: {', '.join(missing)}")
    return creds


def get_zoho_token():
    """Refresh an access token. Never logs the refresh token, client secret, or access token."""
    creds = _read_zoho_env()
    resp = requests.post(
        TOKEN_URL,
        data={
            "refresh_token": creds["ZOHO_REFRESH_TOKEN"],
            "client_id": creds["ZOHO_CLIENT_ID"],
            "client_secret": creds["ZOHO_CLIENT_SECRET"],
            "grant_type": "refresh_token",
        },
        timeout=40,
    )
    tok = resp.json()
    if "access_token" not in tok:
        raise RuntimeError(f"Zoho token refresh failed: {tok.get('error', 'unknown error')}")
    return tok["access_token"]


def get_all_records(token, module, fields, per_page=PER_PAGE, max_retry=MAX_RETRY):
    """Paginate a Zoho v8 REST Modules API endpoint end-to-end (no COQL -- current OAuth grant
    is ZohoCRM.modules.ALL only, which does not carry COQL scope). Uses info.next_page_token /
    info.more_records per the v8 pagination contract. Retries 429/5xx with exponential backoff,
    mirroring etl/_lib.ps1's Invoke-Coql retry pattern."""
    headers = {"Authorization": f"Zoho-oauthtoken {token}"}
    all_records = []
    page_token = None
    page = 0
    while True:
        page += 1
        params = {"fields": ",".join(fields), "per_page": per_page}
        if page_token:
            params["page_token"] = page_token
        else:
            params["page"] = 1

        for attempt in range(1, max_retry + 1):
            try:
                resp = requests.get(f"{API_BASE}/{module}", headers=headers, params=params, timeout=60)
            except requests.exceptions.RequestException as exc:
                # Transient network failures (DNS blip, connection reset, timeout) -- retry with
                # backoff same as a 429/5xx, rather than crashing the whole multi-thousand-page fetch.
                if attempt == max_retry:
                    raise RuntimeError(f"Zoho REST fetch for {module} failed after {max_retry} network retries: {exc}")
                time.sleep(min(30, 2 ** attempt))
                continue
            if resp.status_code == 204:
                return all_records
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(min(30, 2 ** attempt))
                continue
            if resp.status_code != 200:
                raise RuntimeError(f"Zoho REST fetch failed for {module} (HTTP {resp.status_code}): {resp.text[:500]}")
            break
        else:
            raise RuntimeError(f"Zoho REST fetch for {module} exhausted retries")

        body = resp.json() if resp.content else {}
        data = body.get("data") or []
        all_records.extend(data)
        info = body.get("info") or {}
        if not info.get("more_records"):
            break
        page_token = info.get("next_page_token")
        if not page_token:
            break
        time.sleep(0.12)  # gentle on rate limits, mirrors _lib.ps1
    return all_records


def _owner_name(v):
    if isinstance(v, dict):
        return v.get("name")
    return v


def _lookup_id(v):
    if isinstance(v, dict):
        return v.get("id")
    return None


def _lookup_name(v):
    if isinstance(v, dict):
        return v.get("name")
    return v


def fetch_zoho_live(include_meeting_extra=False):
    """Fetch Deals + Calls + Events (Meetings) live via the Zoho CRM v8 REST Modules API and
    reshape into a list of dicts with EXACTLY the same keys that sql/dcm_build.sql (and
    sql/svci_build.sql, via include_meeting_extra=True) produce from BigQuery -- one row per
    Deal, call1/2/3 + totals, first Meeting Raised. Downstream code in both build scripts
    consumes this list identically regardless of source.
    """
    token = get_zoho_token()

    print("  [live] fetching Deals ...")
    deals = get_all_records(token, "Deals", DEAL_FIELDS)
    print(f"  [live] {len(deals)} Deal records")

    print("  [live] fetching Calls ...")
    calls = get_all_records(token, "Calls", CALL_FIELDS)
    print(f"  [live] {len(calls)} Call records")

    print("  [live] fetching Events (Meetings) ...")
    events = get_all_records(token, "Events", EVENT_FIELDS)
    print(f"  [live] {len(events)} Event records")

    # --- Calls: only $se_module == "Deals" with a non-null What_Id count as deal-linked,
    # exactly like the validated BigQuery-side `what_id IS NOT NULL` join. ---
    calls_by_deal = {}
    for c in calls:
        if c.get("$se_module") != "Deals":
            continue
        deal_id = _lookup_id(c.get("What_Id"))
        if not deal_id:
            continue
        calls_by_deal.setdefault(deal_id, []).append(c)
    for deal_id in calls_by_deal:
        calls_by_deal[deal_id].sort(key=lambda c: c.get("Call_Start_Time") or "")

    # --- Events/Meetings: same $se_module=="Deals" + non-null What_Id rule; first meeting by
    # Created_Time ascending (matches cdc_meetings mtg_rank=1 ORDER BY meeting_raised_time). ---
    meetings_by_deal = {}
    for e in events:
        if e.get("$se_module") != "Deals":
            continue
        deal_id = _lookup_id(e.get("What_Id"))
        if not deal_id:
            continue
        existing = meetings_by_deal.get(deal_id)
        if existing is None or (e.get("Created_Time") or "") < (existing.get("Created_Time") or ""):
            meetings_by_deal[deal_id] = e

    rows = []
    for d in deals:
        deal_id = d.get("id")
        dcalls = calls_by_deal.get(deal_id, [])
        total_calls = len(dcalls)
        total_call_seconds = sum(int(c.get("Call_Duration_in_seconds") or 0) for c in dcalls)

        def call_attr(idx, attr):
            if idx < len(dcalls):
                return dcalls[idx].get(attr)
            return None

        m = meetings_by_deal.get(deal_id)

        row = {
            "deal_id": deal_id,
            "agent": _owner_name(d.get("Owner")),
            "deal_name": d.get("Deal_Name"),
            "contact_name": _lookup_name(d.get("Contact_Name")),
            "mobile": d.get("Mobile"),
            "email": d.get("Email"),
            "lead_source": d.get("Lead_Source"),
            "stage": d.get("Stage"),
            "utm_source": d.get("UTM_Source"),
            "utm_medium": d.get("UTM_Medium"),
            "utm_campaign": d.get("UTM_Campaign"),
            "campaign_source": d.get("Campaign_Source"),
            "created_date": d.get("Created_Time"),  # full ISO timestamp, +05:30 (IST) already
            "address_city": d.get("Address_City"),
            "address_state": d.get("Address_State"),
            "amount": d.get("Amount"),

            "total_calls": total_calls,
            "total_call_seconds": total_call_seconds,
            "call1_sec": call_attr(0, "Call_Duration_in_seconds"),
            "call1_time": call_attr(0, "Call_Start_Time"),
            "call2_sec": call_attr(1, "Call_Duration_in_seconds"),
            "call2_time": call_attr(1, "Call_Start_Time"),
            "call3_sec": call_attr(2, "Call_Duration_in_seconds"),
            "call3_time": call_attr(2, "Call_Start_Time"),

            "meeting_event_title": m.get("Event_Title") if m else None,
            "meeting_venue": m.get("Venue") if m else None,
            "meeting_owner": _owner_name(m.get("Owner")) if m else None,
            "meeting_raised_date": m.get("Created_Time") if m else None,
            "meeting_raised_time": m.get("Created_Time") if m else None,
        }
        if include_meeting_extra:
            row["meeting_created_by"] = _owner_name(m.get("Created_By")) if m else None
            row["meeting_description"] = m.get("Description") if m else None
        rows.append(row)

    return rows


def fetch_all_meetings_live(token=None):
    """Fetch the FULL Zoho CRM Events (Meetings) module live -- ALL records, not filtered to
    $se_module=='Deals'/non-null What_Id like fetch_zoho_live()'s deal-linked meeting join. Used
    by build_svci_data.py's "Meeting Intelligence" tab (broader than the rest of this dashboard).
    Returns a list of dicts shaped like sql/svci_all_meetings.sql's output columns (id,
    event_title, venue, created_time, start_datetime, end_datetime, owner_name) so downstream
    processing in build_svci_data.py is identical regardless of source.
    """
    if token is None:
        token = get_zoho_token()
    print("  [live] fetching ALL Events (full Meetings module, no What_Id filter) ...")
    events = get_all_records(token, "Events", ALL_EVENTS_FIELDS)
    print(f"  [live] {len(events)} Event records (all meetings)")
    rows = []
    for e in events:
        rows.append({
            "id": e.get("id"),
            "event_title": e.get("Event_Title"),
            "venue": e.get("Venue"),
            "created_time": e.get("Created_Time"),
            "start_datetime": e.get("Start_DateTime"),
            "end_datetime": e.get("End_DateTime"),
            "owner_name": _owner_name(e.get("Owner")),
        })
    return rows


def now_ist_str():
    now_ist = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)
    return now_ist.strftime("%Y-%m-%d %H:%M:%S IST")
