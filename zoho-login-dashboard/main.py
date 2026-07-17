"""
Zoho One / CRM Login & Status Dashboard
=======================================
A single Cloud Run service that:
  1. Runs the Zoho OAuth consent flow from the frontend ("Connect Zoho").
  2. Stores the long-lived refresh token in GCS (instance-independent).
  3. On /sync : calls the Zoho CRM Users API, writes NDJSON to GCS,
     loads it into BigQuery (zoho_crm.crm_users) and appends a status
     snapshot row per user (zoho_crm.user_status_snapshots).
  4. On /dashboard : queries BigQuery and renders the login/status report.

Session-by-session Zoho One "Account Activity" has no public API, so live
login/status is derived from the CRM Users API `Isonline` flag + status,
polled on a schedule (Cloud Scheduler -> /sync) to build an activity timeline.
"""
import os
import hmac
import json
import secrets
import datetime as dt

import requests
from flask import (
    Flask, request, redirect, session, url_for,
    render_template, jsonify, abort, Response,
)
from google.cloud import bigquery, storage

# --------------------------------------------------------------------------- #
# Configuration (all overridable via env; secrets injected from Secret Manager)
# --------------------------------------------------------------------------- #
PROJECT       = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
DATASET       = os.environ.get("BQ_DATASET", "zoho_crm")
USERS_TABLE   = os.environ.get("USERS_TABLE", "crm_users")
SNAP_TABLE    = os.environ.get("SNAP_TABLE", "user_status_snapshots")
GCS_BUCKET    = os.environ.get("GCS_BUCKET", "")
REFRESH_BLOB  = os.environ.get("REFRESH_BLOB", "oauth/zoho_refresh_token.json")

ZOHO_DC       = os.environ.get("ZOHO_DC", "in").lower()          # in / com / eu / au / jp / ca
ZOHO_CLIENT_ID     = os.environ.get("ZOHO_CLIENT_ID", "")
ZOHO_CLIENT_SECRET = os.environ.get("ZOHO_CLIENT_SECRET", "")
ZOHO_REDIRECT_URI  = os.environ.get("ZOHO_REDIRECT_URI", "")     # <service-url>/oauth/callback
OAUTH_SCOPES  = os.environ.get(
    "OAUTH_SCOPES",
    "ZohoCRM.users.READ,ZohoCRM.org.READ,ZohoCRM.modules.READ")

# Cloud Scheduler calls /sync with this shared token in the header.
SYNC_TOKEN    = os.environ.get("SYNC_TOKEN", "")

_DC_MAP = {
    "in":  ("https://accounts.zoho.in",     "https://www.zohoapis.in"),
    "com": ("https://accounts.zoho.com",    "https://www.zohoapis.com"),
    "us":  ("https://accounts.zoho.com",    "https://www.zohoapis.com"),
    "eu":  ("https://accounts.zoho.eu",     "https://www.zohoapis.eu"),
    "au":  ("https://accounts.zoho.com.au", "https://www.zohoapis.com.au"),
    "jp":  ("https://accounts.zoho.jp",     "https://www.zohoapis.jp"),
    "ca":  ("https://accounts.zohocloud.ca","https://www.zohoapis.ca"),
}
ACCOUNTS_BASE, API_BASE = _DC_MAP.get(ZOHO_DC, _DC_MAP["in"])

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "change-me-in-secret-manager")

_bq  = bigquery.Client(project=PROJECT)
_gcs = storage.Client(project=PROJECT)


# --------------------------------------------------------------------------- #
# Access control (HTTP Basic Auth)
# --------------------------------------------------------------------------- #
# Human-facing pages sit behind a shared username/password. Machine endpoints
# are exempt — they either carry their own protection (sync token / OAuth state)
# or must stay reachable by Google Scheduler / Zoho:
#   /health           liveness probe
#   /sync, /backfill  Cloud Scheduler (X-Sync-Token protected)
#   /oauth/callback   Zoho redirect target (own CSRF state check)
# The gate is OFF until both DASH_USER and DASH_PASS are set (avoids locking out
# an un-provisioned deploy); set them as env/secret on the service to turn it on.
DASH_USER = os.environ.get("DASH_USER", "")
DASH_PASS = os.environ.get("DASH_PASS", "")
_AUTH_EXEMPT = frozenset(("/health", "/sync", "/backfill", "/oauth/callback",
                          "/limechat/webhook", "/limechat/sync"))


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
        {"WWW-Authenticate": 'Basic realm="Lucira Dashboard"'},
    )


# --------------------------------------------------------------------------- #
# Refresh-token persistence (GCS)
# --------------------------------------------------------------------------- #
def _save_refresh_token(token: str) -> None:
    blob = _gcs.bucket(GCS_BUCKET).blob(REFRESH_BLOB)
    blob.upload_from_string(
        json.dumps({"refresh_token": token,
                    "saved_at": dt.datetime.utcnow().isoformat() + "Z"}),
        content_type="application/json",
    )


def _load_refresh_token() -> str | None:
    blob = _gcs.bucket(GCS_BUCKET).blob(REFRESH_BLOB)
    if not blob.exists():
        return None
    return json.loads(blob.download_as_text()).get("refresh_token")


def _is_connected() -> bool:
    try:
        return _load_refresh_token() is not None
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Zoho OAuth + API
# --------------------------------------------------------------------------- #
def _access_token() -> str:
    """Exchange the stored refresh token for a fresh access token."""
    rt = _load_refresh_token()
    if not rt:
        raise RuntimeError("Not connected to Zoho yet. Visit / and click Connect Zoho.")
    resp = requests.post(
        f"{ACCOUNTS_BASE}/oauth/v2/token",
        params={
            "refresh_token": rt,
            "client_id": ZOHO_CLIENT_ID,
            "client_secret": ZOHO_CLIENT_SECRET,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    data = resp.json()
    if "access_token" not in data:
        raise RuntimeError(f"Token refresh failed: {data}")
    return data["access_token"]


def _fetch_all_users(access_token: str) -> list[dict]:
    """Paginate the CRM Users API and return normalized user rows."""
    headers = {"Authorization": f"Zoho-oauthtoken {access_token}"}
    users, page = [], 1
    while True:
        r = requests.get(
            f"{API_BASE}/crm/v8/users",
            headers=headers,
            params={"type": "AllUsers", "page": page, "per_page": 200},
            timeout=60,
        )
        if r.status_code == 204:            # no content
            break
        r.raise_for_status()
        body = r.json()
        for u in body.get("users", []):
            users.append(_normalize_user(u))
        info = body.get("info", {})
        if not info.get("more_records"):
            break
        page += 1
    return users


def _normalize_user(u: dict) -> dict:
    role    = u.get("role") or {}
    profile = u.get("profile") or {}
    return {
        "user_id":      str(u.get("id", "")),
        "email":        u.get("email"),
        "full_name":    u.get("full_name"),
        "first_name":   u.get("first_name"),
        "last_name":    u.get("last_name"),
        "role":         role.get("name") if isinstance(role, dict) else None,
        "profile":      profile.get("name") if isinstance(profile, dict) else None,
        "status":       u.get("status"),
        "is_online":    True if str(u.get("Isonline", "")).lower() in ("true", "1") else False,
        "confirmed":    bool(u.get("confirm")) if u.get("confirm") is not None else None,
        "zuid":         str(u.get("zuid")) if u.get("zuid") is not None else None,
        "modified_time": u.get("Modified_Time"),
    }


# --------------------------------------------------------------------------- #
# BigQuery load
# --------------------------------------------------------------------------- #
def _users_schema():
    S = bigquery.SchemaField
    return [
        S("user_id", "STRING"), S("email", "STRING"), S("full_name", "STRING"),
        S("first_name", "STRING"), S("last_name", "STRING"), S("role", "STRING"),
        S("profile", "STRING"), S("status", "STRING"), S("is_online", "BOOL"),
        S("confirmed", "BOOL"), S("zuid", "STRING"),
        S("modified_time", "TIMESTAMP"), S("synced_at", "TIMESTAMP"),
    ]


def _snap_schema():
    S = bigquery.SchemaField
    return [
        S("user_id", "STRING"), S("email", "STRING"), S("full_name", "STRING"),
        S("status", "STRING"), S("is_online", "BOOL"), S("snapshot_time", "TIMESTAMP"),
    ]


def _load_ndjson_to_bq(rows: list[dict], table: str, schema, write: str, folder: str):
    """Write rows as NDJSON to GCS then load into BigQuery."""
    synced_at = dt.datetime.utcnow().isoformat() + "Z"
    ndjson = "\n".join(json.dumps(r) for r in rows)
    obj = f"{folder}/{synced_at}.json"
    _gcs.bucket(GCS_BUCKET).blob(obj).upload_from_string(
        ndjson, content_type="application/x-ndjson")

    uri = f"gs://{GCS_BUCKET}/{obj}"
    job = _bq.load_table_from_uri(
        uri,
        f"{PROJECT}.{DATASET}.{table}",
        job_config=bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
            schema=schema,
            write_disposition=write,
        ),
    )
    job.result()
    return uri


def run_sync() -> dict:
    at = _access_token()
    users = _fetch_all_users(at)
    now = dt.datetime.utcnow().isoformat() + "Z"

    for u in users:
        u["synced_at"] = now
    _load_ndjson_to_bq(users, USERS_TABLE, _users_schema(),
                       bigquery.WriteDisposition.WRITE_TRUNCATE, "exports/users")

    snaps = [{
        "user_id": u["user_id"], "email": u["email"], "full_name": u["full_name"],
        "status": u["status"], "is_online": u["is_online"], "snapshot_time": now,
    } for u in users]
    _load_ndjson_to_bq(snaps, SNAP_TABLE, _snap_schema(),
                       bigquery.WriteDisposition.WRITE_APPEND, "exports/snapshots")

    result = {
        "synced_at": now,
        "user_count": len(users),
        "online_now": sum(1 for u in users if u["is_online"]),
        "active": sum(1 for u in users if (u["status"] or "").lower() == "active"),
    }
    # incremental CDC sync of all configured modules; never break the user sync
    try:
        result["cdc"] = sync_customer_events(at)
    except Exception as e:
        result["cdc_error"] = str(e)
    return result


# --------------------------------------------------------------------------- #
# Customer_Events module sync (60-day backfill + incremental by Modified_Time)
# --------------------------------------------------------------------------- #
CE_TABLE = os.environ.get("CE_TABLE", "customer_events")
CE_FIELDS = ("id,Owner,Created_Time,Modified_Time,Name,Event_Type,Event_Time,Channel,"
             "Order_Id,Order_Value,Total_Paid,Total_Due,Grand_Total,Total_Quantity,"
             "Payment_Type,Coupon_Code,Event_Currency,Loyalty_Redeem,Reasons_for_Purchase,"
             "Order_Date,Expected_Delivery_Date,utm_source,utm_medium,utm_campaign,"
             "Contact,Deal,Lead,Description,Created_By,Modified_By,Last_Activity_Time,"
             "Record_Status__s,Billing_Address_City,Billing_Address_State_Province,"
             "Billing_Address_Country_Region,Billing_Address_Zip_Postal_Code,"
             "Shipping_Address_City,Shipping_Address_State_Province,"
             "Shipping_Address_Country_Region,Shipping_Address_Zip_Postal_Code")

# Our own CDC pipeline — one config entry per Zoho module. Each syncs into its
# own cdc_* table (generic schema: typed keys + full record JSON) and keeps a
# Modified_Time cursor in GCS. The legacy externally-loaded tables (deals,
# calls, store_event, contacts, tasks) are NOT used by the dashboard anymore.
# Field lists = every fetchable column per module (Zoho caps one request at 50
# fields; subform/image/virtual fields are not fetchable via the records API).
CDC_MODULES = {
    "Contacts": {
        "table": "cdc_contacts",
        "fields": "id,Owner,Created_Time,Modified_Time,Lead_Source,First_Name,Last_Name,"
                  "Full_Name,Account_Name,Vendor_Name,Email,Title,Department,Phone,"
                  "Home_Phone,Other_Phone,Fax,Mobile,Date_of_Birth,Assistant,Asst_Phone,"
                  "Email_Opt_Out,Skype_ID,Created_By,Modified_By,Salutation,Secondary_Email,"
                  "Last_Activity_Time,Twitter,Tag,Description,Reporting_To,"
                  "Unsubscribed_Mode,Unsubscribed_Time,Locked__s,Record_Status__s,"
                  "Mailing_City,Mailing_Country,Mailing_State,Mailing_Street,Mailing_Zip,"
                  "Mailing_Flat_House_No_Building_Apartment_Name,Other_City,Other_State,"
                  "Other_Country,Other_Street,Other_Zip,Last_Enriched_Time__s,Enrich_Status__s"},
    "Deals": {
        "table": "cdc_deals",
        "fields": "id,Owner,Created_Time,Modified_Time,Amount,Deal_Name,Closing_Date,"
                  "Account_Name,Stage,Type,Probability,Expected_Revenue,Next_Step,"
                  "Lead_Source,Campaign_Source,Contact_Name,Created_By,Modified_By,"
                  "Last_Activity_Time,Lead_Conversion_Time,Sales_Cycle_Duration,"
                  "Overall_Sales_Duration,Tag,Description,Reason_For_Loss__s,"
                  "Record_Status__s,Record_Type,Deal_Trigger_Event,Deal_Score,"
                  "Stage_Modified_Time,Email,Mobile,UTM_Medium,Store_Assigned,"
                  "First_Activity_Date,UTM_Campaign,UTM_Source,Number_of_activity,"
                  "Last_Activity_date,Customer_activity_date,Intent_Stage,Assigned_At,"
                  "Assignment_Status,Alternate_mobile,leadchain0__Social_Lead_ID"},
    "Tasks": {
        "table": "cdc_tasks",
        "fields": "id,Owner,Created_Time,Modified_Time,Subject,Due_Date,Who_Id,What_Id,"
                  "Status,Priority,Closed_Time,Send_Notification_Email,Recurring_Activity,"
                  "Remind_At,Created_By,Modified_By,Tag,Description,Locked__s,"
                  "Last_Activity_Time,Record_Status__s,Task_Type,Store_Visit_Date_Time,"
                  "Call_Link,Preferred_Branch,Home_Visit_Date_Time,Video_Call_Date_Time,"
                  "Next_Task_Due_Date_Time,Task_Outcome,Branch_Name,Street,Postal_Code,"
                  "City,State"},
    "Calls": {
        "table": "cdc_calls",
        "fields": "id,Owner,Created_Time,Modified_Time,Subject,Call_Type,Call_Purpose,"
                  "Who_Id,What_Id,Call_Start_Time,Call_Duration,Call_Duration_in_seconds,"
                  "Description,Call_Result,CTI_Entry,Created_By,Modified_By,Reminder,Tag,"
                  "Outgoing_Call_Status,Scheduled_In_CRM,Last_Activity_Time,Call_Agenda,"
                  "Caller_ID,Dialled_Number,Voice_Recording__s,From_Number__s,To_Number__s,"
                  "Record_Status__s"},
    "Events": {
        "table": "cdc_meetings",
        "fields": "id,Owner,Created_Time,Modified_Time,Event_Title,Venue,All_day,"
                  "Start_DateTime,End_DateTime,Who_Id,What_Id,Recurring_Activity,Remind_At,"
                  "Created_By,Modified_By,Participants,Description,Check_In_Time,"
                  "Check_In_By,Check_In_Comment,Check_In_Sub_Locality,Check_In_City,"
                  "Check_In_State,Check_In_Country,Latitude,Longitude,ZIP_Code,"
                  "Check_In_Address,Check_In_Status,Tag,Remind_Participants,"
                  "Last_Activity_Time,Meeting_Venue__s,Meeting_Provider__s,Record_Status__s"},
    "Online_Activity_Logs": {
        "table": "cdc_online_activities",
        "fields": "id,Owner,Created_Time,Modified_Time,Name,Activity_Type,Channel,"
                  "Event_time,Due_Date,Followup_date,Contact,Deal,Lead,Case,Description,"
                  "Created_By,Modified_By,Last_Activity_Time,Tag,Unsubscribed_Mode,"
                  "Unsubscribed_Time,Locked__s,Record_Status__s"},
}


def _cdc_schema():
    S = bigquery.SchemaField
    return [
        S("id", "STRING"), S("owner_id", "STRING"), S("owner_name", "STRING"),
        S("created_time", "TIMESTAMP"), S("modified_time", "TIMESTAMP"),
        S("data", "STRING"), S("synced_at", "TIMESTAMP"),
    ]


def _norm_cdc(r: dict, synced_at: str) -> dict:
    owner = r.get("Owner") or {}
    return {
        "id": str(r.get("id")),
        "owner_id": str(owner.get("id")) if owner.get("id") else None,
        "owner_name": owner.get("name"),
        "created_time": r.get("Created_Time"),
        "modified_time": r.get("Modified_Time"),
        "data": json.dumps(r, ensure_ascii=False),
        "synced_at": synced_at,
    }


def _ce_schema():
    S = bigquery.SchemaField
    return [
        S("id", "STRING"), S("name", "STRING"), S("event_type", "STRING"),
        S("event_time", "TIMESTAMP"), S("channel", "STRING"),
        S("order_id", "STRING"), S("order_value", "FLOAT64"),
        S("total_paid", "FLOAT64"), S("total_due", "FLOAT64"),
        S("payment_type", "STRING"), S("coupon_code", "STRING"),
        S("utm_source", "STRING"), S("utm_medium", "STRING"), S("utm_campaign", "STRING"),
        S("order_date", "DATE"),
        S("contact_id", "STRING"), S("contact_name", "STRING"),
        S("deal_id", "STRING"), S("deal_name", "STRING"),
        S("lead_id", "STRING"), S("lead_name", "STRING"),
        S("owner_id", "STRING"), S("owner_name", "STRING"),
        S("created_time", "TIMESTAMP"), S("modified_time", "TIMESTAMP"),
        S("data", "STRING"), S("synced_at", "TIMESTAMP"),
    ]


def _norm_event(r: dict, synced_at: str) -> dict:
    def look(k):
        v = r.get(k) or {}
        return (str(v.get("id")) if v.get("id") else None,
                v.get("name") if isinstance(v, dict) else None)
    c_id, c_nm = look("Contact"); d_id, d_nm = look("Deal")
    l_id, l_nm = look("Lead");    o_id, o_nm = look("Owner")
    def num(k):
        v = r.get(k)
        try: return float(v) if v is not None else None
        except Exception: return None
    return {
        "id": str(r.get("id")), "name": r.get("Name"),
        "event_type": r.get("Event_Type"), "event_time": r.get("Event_Time"),
        "channel": r.get("Channel"), "order_id": r.get("Order_Id"),
        "order_value": num("Order_Value"), "total_paid": num("Total_Paid"),
        "total_due": num("Total_Due"), "payment_type": r.get("Payment_Type"),
        "coupon_code": r.get("Coupon_Code"), "utm_source": r.get("utm_source"),
        "utm_medium": r.get("utm_medium"), "utm_campaign": r.get("utm_campaign"),
        "order_date": r.get("Order_Date"),
        "contact_id": c_id, "contact_name": c_nm, "deal_id": d_id, "deal_name": d_nm,
        "lead_id": l_id, "lead_name": l_nm, "owner_id": o_id, "owner_name": o_nm,
        "created_time": r.get("Created_Time"), "modified_time": r.get("Modified_Time"),
        "data": json.dumps(r, ensure_ascii=False),
        "synced_at": synced_at,
    }


def _fetch_module_since(access_token: str, module: str, fields: str,
                        since_iso: str, max_pages: int = 600):
    """Fetch a module's records with Modified_Time >= since_iso
    (sorted desc, page_token pagination past 2000 records)."""
    headers = {"Authorization": f"Zoho-oauthtoken {access_token}"}
    out, page_token, page = [], None, 1
    while page <= max_pages:
        params = {"fields": fields, "per_page": 200,
                  "sort_by": "Modified_Time", "sort_order": "desc"}
        if page_token:
            params["page_token"] = page_token
        else:
            params["page"] = page
        resp = requests.get(f"{API_BASE}/crm/v8/{module}",
                            headers=headers, params=params, timeout=60)
        if resp.status_code == 204:
            break
        resp.raise_for_status()
        body = resp.json()
        stop = False
        for r in body.get("data", []):
            if (r.get("Modified_Time") or "") < since_iso:
                stop = True
                break
            out.append(r)
        info = body.get("info", {})
        if stop or not info.get("more_records"):
            break
        page_token = info.get("next_page_token")
        page += 1
    return out


def _merge_rows(rows: list[dict], table: str, schema, normalizer, folder: str) -> int:
    """Normalize + de-dupe rows, stage via GCS, then MERGE into the target table."""
    if not rows:
        return 0
    synced_at = dt.datetime.utcnow().isoformat() + "Z"
    seen, uniq = set(), []
    for r in rows:
        n = normalizer(r, synced_at)
        if n["id"] not in seen:
            seen.add(n["id"]); uniq.append(n)
    tmp = f"{PROJECT}.{DATASET}.{table}_staging"
    obj = f"exports/{folder}/{synced_at}.json"
    _gcs.bucket(GCS_BUCKET).blob(obj).upload_from_string(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in uniq),
        content_type="application/x-ndjson")
    _bq.load_table_from_uri(
        f"gs://{GCS_BUCKET}/{obj}", tmp,
        job_config=bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
            schema=schema,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE),
    ).result()
    cols = [f.name for f in schema]
    upd = ", ".join(f"T.{c}=S.{c}" for c in cols if c != "id")
    _bq.query(f"""
        MERGE `{PROJECT}.{DATASET}.{table}` T
        USING `{tmp}` S ON T.id = S.id
        WHEN MATCHED THEN UPDATE SET {upd}
        WHEN NOT MATCHED THEN INSERT ({', '.join(cols)})
        VALUES ({', '.join('S.'+c for c in cols)})
    """).result()
    _bq.delete_table(tmp, not_found_ok=True)
    return len(uniq)


def _cursor_get(key: str):
    blob = _gcs.bucket(GCS_BUCKET).blob(f"state/{key}_cursor.json")
    if not blob.exists():
        return None
    return json.loads(blob.download_as_text()).get("cursor")


def _cursor_set(key: str, cursor: str):
    _gcs.bucket(GCS_BUCKET).blob(f"state/{key}_cursor.json").upload_from_string(
        json.dumps({"cursor": cursor}), content_type="application/json")


def _module_conf(module: str):
    """(fields, table, schema, normalizer, folder) for a module."""
    if module == "Customer_Events":
        return CE_FIELDS, CE_TABLE, _ce_schema(), _norm_event, "customer_events"
    conf = CDC_MODULES[module]
    return conf["fields"], conf["table"], _cdc_schema(), _norm_cdc, conf["table"]


def sync_module(access_token: str, module: str, since_iso: str | None = None) -> dict:
    """CDC sync for one module. Without since_iso, uses the stored cursor."""
    fields, table, schema, normalizer, folder = _module_conf(module)
    cursor = since_iso or _cursor_get(table)
    if not cursor:
        return {"skipped": "no cursor - run /backfill first"}
    rows = _fetch_module_since(access_token, module, fields, cursor)
    n = _merge_rows(rows, table, schema, normalizer, folder)
    if rows:
        _cursor_set(table, max(r.get("Modified_Time") or "" for r in rows))
    return {"merged": n}


def sync_customer_events(access_token: str) -> dict:
    # kept for backward compat with run_sync(); now delegates to the CDC engine
    results = {}
    for module in ["Customer_Events"] + list(CDC_MODULES.keys()):
        try:
            results[module] = sync_module(access_token, module)
        except Exception as e:
            results[module] = {"error": str(e)}
    return results


@app.route("/backfill", methods=["GET", "POST"])
def backfill():
    """Backfill one module (?module=Deals&days=60) or all (?module=all).
    Protected by the sync token."""
    if SYNC_TOKEN:
        supplied = request.headers.get("X-Sync-Token") or request.args.get("token")
        if supplied != SYNC_TOKEN:
            abort(401)
    days = int(request.args.get("days", "60"))
    module = request.args.get("module", "Customer_Events")
    since = ((dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30))
             - dt.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00+05:30")
    modules = (["Customer_Events"] + list(CDC_MODULES.keys())) if module == "all" else [module]
    out = {}
    try:
        at = _access_token()
        for m in modules:
            try:
                out[m] = sync_module(at, m, since_iso=since)
            except Exception as e:
                out[m] = {"error": str(e)}
        return jsonify(since=since, results=out)
    except Exception as e:
        return jsonify(error=str(e)), 500


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/health")
def health():
    return jsonify(status="ok", dc=ZOHO_DC, connected=_is_connected())


@app.route("/")
def index():
    return render_template(
        "index.html",
        connected=_is_connected(),
        configured=bool(ZOHO_CLIENT_ID and ZOHO_REDIRECT_URI),
        redirect_uri=ZOHO_REDIRECT_URI,
        dc=ZOHO_DC,
    )


@app.route("/oauth/login")
def oauth_login():
    if not (ZOHO_CLIENT_ID and ZOHO_REDIRECT_URI):
        return "OAuth not configured yet (missing client id / redirect uri).", 500
    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    params = {
        "scope": OAUTH_SCOPES,
        "client_id": ZOHO_CLIENT_ID,
        "response_type": "code",
        "access_type": "offline",
        "redirect_uri": ZOHO_REDIRECT_URI,
        "prompt": "consent",
        "state": state,
    }
    q = "&".join(f"{k}={requests.utils.quote(str(v), safe='')}" for k, v in params.items())
    return redirect(f"{ACCOUNTS_BASE}/oauth/v2/auth?{q}")


@app.route("/oauth/callback")
def oauth_callback():
    if request.args.get("state") != session.get("oauth_state"):
        return "State mismatch — possible CSRF. Try again.", 400
    if "error" in request.args:
        return f"Zoho returned an error: {request.args.get('error')}", 400
    code = request.args.get("code")
    if not code:
        return "Missing authorization code.", 400

    resp = requests.post(
        f"{ACCOUNTS_BASE}/oauth/v2/token",
        params={
            "grant_type": "authorization_code",
            "client_id": ZOHO_CLIENT_ID,
            "client_secret": ZOHO_CLIENT_SECRET,
            "redirect_uri": ZOHO_REDIRECT_URI,
            "code": code,
        },
        timeout=30,
    )
    data = resp.json()
    if "refresh_token" not in data:
        return f"Token exchange failed (no refresh_token). Zoho said: {data}", 400
    _save_refresh_token(data["refresh_token"])
    return redirect(url_for("index"))


@app.route("/sync", methods=["GET", "POST"])
def sync():
    # Cloud Scheduler auth: require the shared token if one is configured.
    if SYNC_TOKEN:
        supplied = request.headers.get("X-Sync-Token") or request.args.get("token")
        if supplied != SYNC_TOKEN:
            abort(401)
    try:
        return jsonify(run_sync())
    except Exception as e:
        return jsonify(error=str(e)), 500


@app.route("/ui/sync")
def ui_sync():
    """Browser-triggered sync (no scheduler token). Only works once connected."""
    if not _is_connected():
        return redirect(url_for("index"))
    try:
        run_sync()
    except Exception as e:
        return f"Sync failed: {e}", 500
    return redirect(url_for("dashboard"))


# --------------------------------------------------------------------------- #
# Analytics helpers (date range + filters + derived login hours + deals)
# --------------------------------------------------------------------------- #
TZ = "Asia/Kolkata"
POLL_CAP_SECONDS = int(os.environ.get("POLL_CAP_SECONDS", "1800"))       # cap per interval
SESSION_GAP_SECONDS = int(os.environ.get("SESSION_GAP_SECONDS", "1800")) # >gap => new session
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "900"))  # session tail credit
FILTER_KEYS = ("role", "profile", "status", "online", "q")


@app.template_filter("inr")
def _inr(v):
    try:
        return "₹{:,.0f}".format(float(v or 0))
    except Exception:
        return v


@app.template_filter("hrs")
def _hrs(v):
    try:
        return "{:.1f}".format(float(v or 0))
    except Exception:
        return v


def _default_range():
    # Default to *today* (IST). Both ends = today gives a single-day view.
    today = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date()
    return today.isoformat(), today.isoformat()


def _parse_range(args):
    d_from, d_to = _default_range()
    f = args.get("from") or d_from
    t = args.get("to") or d_to
    return f, t


def _parse_filters(args):
    """Filters from query args. Status defaults to 'active' when absent (explicit '' = All)."""
    filt = {k: args.get(k, "") for k in FILTER_KEYS}
    if "status" not in args:
        filt["status"] = "active"
    return filt


def _P(name, typ, val):
    return bigquery.ScalarQueryParameter(name, typ, val)


def _ist_str(v, fmt="%d %b %H:%M"):
    """UTC datetime (from BQ) -> IST display string."""
    if v is None:
        return None
    if isinstance(v, str):
        return v
    if isinstance(v, dt.datetime):
        return (v.replace(tzinfo=None) + dt.timedelta(hours=5, minutes=30)).strftime(fmt)
    return v.isoformat()  # date


def _ser_user(r):
    d = dict(r)
    d["modified_time"] = _ist_str(d.get("modified_time"), "%d %b %Y %H:%M")
    d["last_seen_online"] = _ist_str(d.get("last_seen_online"), "%d %b %H:%M")
    d["online_hours"] = round(float(d.get("online_hours") or 0), 2)
    d["won_amount"] = float(d.get("won_amount") or 0)
    d["talk_min"] = round(float(d.get("talk_min") or 0), 1)
    d["first_activity"] = _ist_str(d.get("first_activity"), "%d %b %H:%M")
    d["last_activity"] = _ist_str(d.get("last_activity"), "%d %b %H:%M")
    return d


def _users_query(d_from, d_to, filt, user_id=None):
    """Return per-user rows joining login-hours (snapshots) + deal metrics."""
    U = f"`{PROJECT}.{DATASET}.{USERS_TABLE}`"
    S = f"`{PROJECT}.{DATASET}.{SNAP_TABLE}`"
    D = f"`{PROJECT}.{DATASET}.cdc_deals`"
    CALLS = f"`{PROJECT}.{DATASET}.cdc_calls`"
    MEET = f"`{PROJECT}.{DATASET}.cdc_meetings`"
    TASKS = f"`{PROJECT}.{DATASET}.cdc_tasks`"
    OACT = f"`{PROJECT}.{DATASET}.cdc_online_activities`"
    params = [
        _P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
        _P("cap", "INT64", POLL_CAP_SECONDS),
    ]
    where = ["1=1"]
    if user_id:
        where.append("u.user_id=@uid"); params.append(_P("uid", "STRING", user_id))
    if filt.get("role"):
        where.append("u.role=@role"); params.append(_P("role", "STRING", filt["role"]))
    if filt.get("profile"):
        where.append("u.profile=@profile"); params.append(_P("profile", "STRING", filt["profile"]))
    if filt.get("status"):
        where.append("LOWER(u.status)=@status"); params.append(_P("status", "STRING", filt["status"].lower()))
    if filt.get("online") in ("true", "false"):
        where.append("u.is_online=@online"); params.append(_P("online", "BOOL", filt["online"] == "true"))
    if filt.get("q"):
        where.append("(LOWER(u.full_name) LIKE @q OR LOWER(u.email) LIKE @q)")
        params.append(_P("q", "STRING", f"%{filt['q'].lower()}%"))

    sql = f"""
    WITH rng AS (
      SELECT TIMESTAMP(@d_from, '{TZ}') AS ts_from,
             TIMESTAMP(DATE_ADD(@d_to, INTERVAL 1 DAY), '{TZ}') AS ts_to
    ),
    snap AS (
      SELECT user_id, snapshot_time, is_online,
        LEAD(snapshot_time) OVER (PARTITION BY user_id ORDER BY snapshot_time) AS nx
      FROM {S}, rng
      WHERE snapshot_time >= rng.ts_from AND snapshot_time < rng.ts_to
    ),
    online AS (
      SELECT user_id,
        SUM(IF(is_online, LEAST(TIMESTAMP_DIFF(nx, snapshot_time, SECOND), @cap), 0))/3600.0 AS online_hours,
        COUNT(DISTINCT IF(is_online, DATE(snapshot_time, '{TZ}'), NULL)) AS active_days,
        MAX(IF(is_online, snapshot_time, NULL)) AS last_seen_online
      FROM snap GROUP BY user_id
    ),
    dealsagg AS (
      -- strictly range-scoped: created by Created_Time, won by Closing_Date in range
      SELECT d.owner_id AS user_id,
        COUNTIF(d.created_time >= rng.ts_from AND d.created_time < rng.ts_to) AS deals_created,
        COUNTIF(JSON_VALUE(d.data,'$.Stage')='Closed Won'
                AND SAFE.PARSE_DATE('%F', JSON_VALUE(d.data,'$.Closing_Date')) BETWEEN @d_from AND @d_to) AS won_deals,
        SUM(IF(JSON_VALUE(d.data,'$.Stage')='Closed Won'
               AND SAFE.PARSE_DATE('%F', JSON_VALUE(d.data,'$.Closing_Date')) BETWEEN @d_from AND @d_to,
               COALESCE(CAST(JSON_VALUE(d.data,'$.Amount') AS FLOAT64),0), 0)) AS won_amount
      FROM {D} d CROSS JOIN rng
      GROUP BY 1
    ),
    callsagg AS (
      SELECT c.owner_id AS user_id,
        COUNT(*) AS calls_cnt,
        COALESCE(SUM(CAST(JSON_VALUE(c.data,'$.Call_Duration_in_seconds') AS FLOAT64)),0)/60.0 AS talk_min
      FROM {CALLS} c, rng
      WHERE SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(c.data,'$.Call_Start_Time')) >= rng.ts_from
        AND SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(c.data,'$.Call_Start_Time')) < rng.ts_to
      GROUP BY 1
    ),
    meetagg AS (
      SELECT m.owner_id AS user_id, COUNT(*) AS meetings
      FROM {MEET} m, rng
      WHERE SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(m.data,'$.Start_DateTime')) >= rng.ts_from
        AND SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(m.data,'$.Start_DateTime')) < rng.ts_to
      GROUP BY 1
    ),
    tasksagg AS (
      SELECT t.owner_id AS user_id, COUNT(*) AS tasks_cnt
      FROM {TASKS} t, rng
      WHERE t.created_time >= rng.ts_from AND t.created_time < rng.ts_to
      GROUP BY 1
    ),
    oactagg AS (
      SELECT a.owner_id AS user_id, COUNT(*) AS online_acts
      FROM {OACT} a, rng
      WHERE COALESCE(SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(a.data,'$.Event_time')),
                     a.created_time) >= rng.ts_from
        AND COALESCE(SAFE.PARSE_TIMESTAMP('%FT%T%Ez', JSON_VALUE(a.data,'$.Event_time')),
                     a.created_time) < rng.ts_to
      GROUP BY 1
    ),
    presagg AS (
      -- activity-derived presence for every agent (covers pre-polling history)
      SELECT owner_id AS user_id,
        MIN(activity_time) AS first_activity,
        MAX(activity_time) AS last_activity,
        COUNT(DISTINCT FORMAT_TIMESTAMP('%F-%H', activity_time, '{TZ}')) AS active_hours
      FROM `{PROJECT}.{DATASET}.all_activity`, rng
      WHERE activity_type IN ('call','task','meeting','online_activity')
        AND activity_time >= rng.ts_from AND activity_time < rng.ts_to
      GROUP BY 1
    )
    SELECT u.user_id, u.full_name, u.email, u.role, u.profile, u.status,
           u.is_online, u.modified_time,
           COALESCE(o.online_hours,0) AS online_hours,
           COALESCE(o.active_days,0) AS active_days,
           o.last_seen_online,
           COALESCE(da.deals_created,0) AS deals_created,
           COALESCE(da.won_deals,0) AS won_deals,
           COALESCE(da.won_amount,0) AS won_amount,
           COALESCE(ca.calls_cnt,0) AS calls_cnt,
           COALESCE(ca.talk_min,0) AS talk_min,
           COALESCE(ma.meetings,0) AS meetings,
           COALESCE(ta.tasks_cnt,0) AS tasks_cnt,
           COALESCE(oa.online_acts,0) AS online_acts,
           pa.first_activity, pa.last_activity,
           COALESCE(pa.active_hours,0) AS active_hours
    FROM {U} u
    LEFT JOIN online o ON o.user_id=u.user_id
    LEFT JOIN dealsagg da ON da.user_id=u.user_id
    LEFT JOIN callsagg ca ON ca.user_id=u.user_id
    LEFT JOIN meetagg ma ON ma.user_id=u.user_id
    LEFT JOIN tasksagg ta ON ta.user_id=u.user_id
    LEFT JOIN oactagg oa ON oa.user_id=u.user_id
    LEFT JOIN presagg pa ON pa.user_id=u.user_id
    WHERE {' AND '.join(where)}
    ORDER BY active_hours DESC, online_hours DESC, u.full_name
    """
    job = _bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    return [dict(r) for r in job.result()]


def _filter_options():
    U = f"`{PROJECT}.{DATASET}.{USERS_TABLE}`"
    def distinct(col):
        return [r[0] for r in _bq.query(
            f"SELECT DISTINCT {col} FROM {U} WHERE {col} IS NOT NULL ORDER BY {col}"
        ).result()]
    return {"roles": distinct("role"), "profiles": distinct("profile"),
            "statuses": distinct("status")}


# --------------------------------------------------------------------------- #
# Session reconstruction + trends (gaps-and-islands over the online timeline)
# --------------------------------------------------------------------------- #
def _sessions_for(d_from, d_to, user_id):
    """Reconstruct login sessions: contiguous online runs split by gaps > threshold."""
    S = f"`{PROJECT}.{DATASET}.{SNAP_TABLE}`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
              _P("uid", "STRING", user_id), _P("gap", "INT64", SESSION_GAP_SECONDS),
              _P("intv", "INT64", POLL_INTERVAL_SECONDS)]
    sql = f"""
    WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a, TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b),
    onl AS (
      SELECT snapshot_time,
        LAG(snapshot_time) OVER (ORDER BY snapshot_time) prev_t
      FROM {S}, rng
      WHERE user_id=@uid AND is_online=TRUE AND snapshot_time>=rng.a AND snapshot_time<rng.b
    ),
    marked AS (
      SELECT snapshot_time,
        CASE WHEN prev_t IS NULL OR TIMESTAMP_DIFF(snapshot_time,prev_t,SECOND) > @gap THEN 1 ELSE 0 END AS new_sess
      FROM onl
    ),
    sess AS (SELECT snapshot_time, SUM(new_sess) OVER (ORDER BY snapshot_time) sid FROM marked)
    SELECT MIN(snapshot_time) started, MAX(snapshot_time) ended,
           (TIMESTAMP_DIFF(MAX(snapshot_time),MIN(snapshot_time),SECOND)+@intv)/3600.0 hours,
           COUNT(*) polls
    FROM sess GROUP BY sid ORDER BY started
    """
    raw = list(_bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    out, prev_end = [], None
    for r in raw:
        gap_h = None
        if prev_end is not None and r["started"] is not None:
            gap_h = round(dt.timedelta.total_seconds(r["started"] - prev_end) / 3600.0, 2)
        out.append({
            "started": _ist_str(r["started"], "%d %b %H:%M"),
            "ended": _ist_str(r["ended"], "%d %b %H:%M"),
            "date": _ist_str(r["started"], "%d %b"),
            "hours": round(float(r["hours"] or 0), 2),
            "polls": r["polls"],
            "gap_hours": gap_h,
        })
        prev_end = r["ended"]
    return out


def _daily_for(d_from, d_to, user_id):
    S = f"`{PROJECT}.{DATASET}.{SNAP_TABLE}`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
              _P("uid", "STRING", user_id), _P("cap", "INT64", POLL_CAP_SECONDS)]
    rows = _bq.query(f"""
        WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a, TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b),
        snap AS (SELECT snapshot_time, is_online,
                   LEAD(snapshot_time) OVER (ORDER BY snapshot_time) nx
                 FROM {S}, rng WHERE user_id=@uid AND snapshot_time>=rng.a AND snapshot_time<rng.b)
        SELECT FORMAT_DATE('%d %b', DATE(snapshot_time,'{TZ}')) day,
          SUM(IF(is_online, LEAST(TIMESTAMP_DIFF(nx,snapshot_time,SECOND),@cap),0))/3600.0 hrs
        FROM snap GROUP BY day, DATE(snapshot_time,'{TZ}') ORDER BY DATE(snapshot_time,'{TZ}')
    """, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return [{"day": r["day"], "hrs": round(float(r["hrs"] or 0), 2)} for r in rows]


def _deals_for(user_id):
    D = f"`{PROJECT}.{DATASET}.cdc_deals`"
    rows = _bq.query(f"""
        SELECT JSON_VALUE(data,'$.Deal_Name') name, JSON_VALUE(data,'$.Stage') stage,
               CAST(JSON_VALUE(data,'$.Amount') AS FLOAT64) amount,
               created_time, JSON_VALUE(data,'$.Closing_Date') closing
        FROM {D} WHERE owner_id=@uid ORDER BY created_time DESC LIMIT 10
    """, job_config=bigquery.QueryJobConfig(query_parameters=[_P("uid","STRING",user_id)])).result()
    return [{"name": r["name"], "stage": r["stage"],
             "amount": float(r["amount"] or 0),
             "created": _ist_str(r["created_time"], "%d %b %Y"),
             "closing": r["closing"]} for r in rows]


# --------------------------------------------------------------------------- #
# Table details + sync status (for the Data & Sync tab)
# --------------------------------------------------------------------------- #
def _table_stats():
    out = []
    cdc_tables = tuple(c["table"] for c in CDC_MODULES.values())
    for name in (USERS_TABLE, SNAP_TABLE, CE_TABLE) + cdc_tables + ("login_history",):
        try:
            t = _bq.get_table(f"{PROJECT}.{DATASET}.{name}")
            out.append({
                "table": name, "rows": t.num_rows,
                "mb": round((t.num_bytes or 0) / 1e6, 3),
                "modified": _ist_str(t.modified, "%d %b %Y %H:%M"),
                "mode": ("append (incremental)" if name == SNAP_TABLE
                         else "truncate (full refresh)" if name == USERS_TABLE
                         else "manual / CSV" if name == "login_history"
                         else "CDC merge (incremental by Modified_Time)"),
            })
        except Exception as e:
            out.append({"table": name, "error": str(e)})
    return out


def _sync_status():
    U = f"`{PROJECT}.{DATASET}.{USERS_TABLE}`"
    S = f"`{PROJECT}.{DATASET}.{SNAP_TABLE}`"
    r = list(_bq.query(f"""
        SELECT (SELECT MAX(synced_at) FROM {U}) last_user_sync,
               (SELECT MAX(snapshot_time) FROM {S}) last_snapshot,
               (SELECT MIN(snapshot_time) FROM {S}) first_snapshot,
               (SELECT COUNT(*) FROM {S}) snapshot_rows,
               (SELECT COUNT(DISTINCT snapshot_time) FROM {S}) sync_runs
    """).result())[0]
    return {
        "last_user_sync": _ist_str(r["last_user_sync"], "%d %b %Y %H:%M:%S"),
        "last_snapshot": _ist_str(r["last_snapshot"], "%d %b %Y %H:%M:%S"),
        "first_snapshot": _ist_str(r["first_snapshot"], "%d %b %Y %H:%M"),
        "snapshot_rows": r["snapshot_rows"],
        "sync_runs": r["sync_runs"],
        "cadence": os.environ.get("SYNC_CADENCE", "every 15 min (Asia/Kolkata)"),
        "scheduler_job": "zoho-sync",
    }


@app.route("/dashboard")
def dashboard():
    """Fast shell — each card fetches its own data independently via /api/*."""
    if not _is_connected():
        return redirect(url_for("index"))
    d_from, d_to = _parse_range(request.args)
    filt = _parse_filters(request.args)
    try:
        opts = _filter_options()
    except Exception as e:
        return f"Query failed: {e}", 500
    return render_template("dashboard.html", d_from=d_from, d_to=d_to, filt=filt, opts=opts)


# ----- JSON APIs backing the independent dashboard cards --------------------- #
@app.route("/api/summary")
def api_summary():
    d_from, d_to = _parse_range(request.args)
    rows = _users_query(d_from, d_to, _parse_filters(request.args))
    total   = len(rows)
    tot_hrs = sum(r["online_hours"] for r in rows)
    return jsonify(
        total=total,
        online=sum(1 for r in rows if r["is_online"]),
        active=sum(1 for r in rows if (r["status"] or "").lower() == "active"),
        inactive=sum(1 for r in rows if (r["status"] or "").lower() != "active"),
        tot_hrs=round(tot_hrs, 2),
        avg_hrs=round(tot_hrs / total, 2) if total else 0,
        deals_created=sum(r["deals_created"] for r in rows),
        won_cnt=sum(r["won_deals"] for r in rows),
        won_amt=sum(r["won_amount"] for r in rows),
        calls=sum(r["calls_cnt"] for r in rows),
        talk_min=round(sum(r["talk_min"] for r in rows), 1),
        meetings=sum(r["meetings"] for r in rows),
        tasks=sum(r["tasks_cnt"] for r in rows),
        online_acts=sum(r["online_acts"] for r in rows),
        active_hours=sum(r["active_hours"] for r in rows),
    )


@app.route("/api/users")
def api_users():
    d_from, d_to = _parse_range(request.args)
    rows = _users_query(d_from, d_to, _parse_filters(request.args))
    return jsonify(users=[_ser_user(r) for r in rows])


@app.route("/api/insights")
def api_insights():
    d_from, d_to = _parse_range(request.args)
    rows = _users_query(d_from, d_to, _parse_filters(request.args))
    if not rows:
        return jsonify(html=None, error="No data in range.")
    try:
        import markdown as _md
        html = _md.markdown(_gemini_insights(rows, d_from, d_to),
                            extensions=["tables", "sane_lists"])
        return jsonify(html=html, model=GEMINI_MODEL, error=None)
    except Exception as e:
        return jsonify(html=None, error=str(e))


@app.route("/api/insights/chat", methods=["POST"])
def api_insights_chat():
    """Conversational follow-up on the insights: grounded on the same range-scoped
    data. Body: {from, to, filters..., history:[{role,content}], question}."""
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    if not question:
        return jsonify(html=None, error="Empty question.")
    d_from, d_to = _parse_range(request.args)
    filt = _parse_filters(request.args)
    try:
        rows = _users_query(d_from, d_to, filt)
    except Exception as e:
        return jsonify(html=None, error=f"Query failed: {e}")
    if not rows:
        return jsonify(html=None, error="No data in range.")
    try:
        import markdown as _md
        context = _insights_context(rows, d_from, d_to)
        answer = _gemini_chat_answer(context, body.get("history") or [], question)
        html = _md.markdown(answer, extensions=["tables", "sane_lists"])
        return jsonify(html=html, model=GEMINI_MODEL, error=None)
    except Exception as e:
        return jsonify(html=None, error=str(e))


@app.route("/api/tables")
def api_tables():
    return jsonify(tables=_table_stats(), sync=_sync_status())


@app.route("/api/customer_events")
def api_customer_events():
    """Range summary of website customer events (signups, purchases, order value)."""
    d_from, d_to = _parse_range(request.args)
    E = f"`{PROJECT}.{DATASET}.{CE_TABLE}`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to)]
    try:
        rows = list(_bq.query(f"""
            WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a,
                                TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b)
            SELECT COALESCE(event_type,'—') event_type, COUNT(*) n,
                   SUM(COALESCE(order_value,0)) order_value
            FROM {E}, rng
            WHERE COALESCE(event_time, created_time) >= rng.a
              AND COALESCE(event_time, created_time) < rng.b
            GROUP BY 1 ORDER BY n DESC
        """, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    except Exception as e:
        return jsonify(error=str(e), types=[])
    types = [{"type": r["event_type"], "n": int(r["n"]),
              "order_value": float(r["order_value"] or 0)} for r in rows]
    return jsonify(types=types,
                   total=sum(t["n"] for t in types),
                   order_value=sum(t["order_value"] for t in types))


@app.route("/api/team_hourly")
def api_team_hourly():
    """Hour-of-day profile (0-23, IST) for the range: online minutes + calls."""
    d_from, d_to = _parse_range(request.args)
    S = f"`{PROJECT}.{DATASET}.{SNAP_TABLE}`"
    C = f"`{PROJECT}.{DATASET}.cdc_calls`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
              _P("cap", "INT64", POLL_CAP_SECONDS)]
    sql = f"""
    WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a, TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b),
    snap AS (
      SELECT snapshot_time, is_online,
        LEAD(snapshot_time) OVER (PARTITION BY user_id ORDER BY snapshot_time) nx
      FROM {S}, rng WHERE snapshot_time>=rng.a AND snapshot_time<rng.b),
    onl AS (
      SELECT EXTRACT(HOUR FROM DATETIME(snapshot_time,'{TZ}')) hr,
        SUM(IF(is_online, LEAST(TIMESTAMP_DIFF(nx,snapshot_time,SECOND),@cap),0))/60.0 mins
      FROM snap GROUP BY hr),
    cls AS (
      SELECT EXTRACT(HOUR FROM DATETIME(SAFE.PARSE_TIMESTAMP('%FT%T%Ez',JSON_VALUE(data,'$.Call_Start_Time')),'{TZ}')) hr,
        COUNT(*) calls
      FROM {C}, rng
      WHERE SAFE.PARSE_TIMESTAMP('%FT%T%Ez',JSON_VALUE(data,'$.Call_Start_Time')) >= rng.a
        AND SAFE.PARSE_TIMESTAMP('%FT%T%Ez',JSON_VALUE(data,'$.Call_Start_Time')) < rng.b
      GROUP BY hr)
    SELECT hr, COALESCE(o.mins,0) mins, COALESCE(c.calls,0) calls
    FROM UNNEST(GENERATE_ARRAY(0,23)) AS hr
    LEFT JOIN onl o USING (hr)
    LEFT JOIN cls c USING (hr)
    ORDER BY hr
    """
    rows = _bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return jsonify(hours=[{"hr": r["hr"], "mins": round(float(r["mins"] or 0), 1),
                           "calls": int(r["calls"] or 0)} for r in rows])


# --------------------------------------------------------------------------- #
# Deal analytics by time-slot (Deals tab)
#   Working blocks (IST): 09–12, 12–15, 15–18, 18–21. Everything else
#   (21:00–09:00) is the single non-working block. Toggle buckets deals by
#   Created_Time or Modified_Time; date range comes from the filter.
# --------------------------------------------------------------------------- #
DEAL_SLOTS = [
    {"label": "9 AM – 12 PM", "hours": "09:00–12:00", "working": True},
    {"label": "12 PM – 3 PM", "hours": "12:00–15:00", "working": True},
    {"label": "3 PM – 6 PM",  "hours": "15:00–18:00", "working": True},
    {"label": "6 PM – 9 PM",  "hours": "18:00–21:00", "working": True},
    {"label": "9 PM – 9 AM",  "hours": "21:00–09:00", "working": False},
]


def _ratio(num, den):
    return round(100.0 * num / den, 1) if den else 0.0


@app.route("/api/deals_slots")
def api_deals_slots():
    """Deal metrics bucketed into the 4 working + 1 non-working IST time-slots.
    ?mode=created|modified selects which timestamp buckets each deal.
    ?from=&to= scope the range (defaults to today)."""
    d_from, d_to = _parse_range(request.args)
    mode = "modified" if request.args.get("mode") == "modified" else "created"
    tscol = "modified_time" if mode == "modified" else "created_time"
    D = f"`{PROJECT}.{DATASET}.cdc_deals`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to)]

    slot_sql = f"""
    WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a, TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b),
    base AS (
      SELECT EXTRACT(HOUR FROM DATETIME({tscol},'{TZ}')) h,
             COALESCE(SAFE_CAST(JSON_VALUE(data,'$.Number_of_activity') AS INT64),0) acts,
             JSON_VALUE(data,'$.Stage') stage
      FROM {D}, rng
      WHERE {tscol} >= rng.a AND {tscol} < rng.b
    ),
    slotted AS (
      SELECT CASE
               WHEN h >= 9  AND h < 12 THEN 0
               WHEN h >= 12 AND h < 15 THEN 1
               WHEN h >= 15 AND h < 18 THEN 2
               WHEN h >= 18 AND h < 21 THEN 3
               ELSE 4 END slot,
             acts, stage
      FROM base
    )
    SELECT slot,
           COUNT(*) created,
           COUNTIF(acts > 0) connected,
           COUNTIF(stage = 'Closed Won') won,
           SUM(acts) activities
    FROM slotted GROUP BY slot
    """
    funnel_sql = f"""
    WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a, TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b)
    SELECT COALESCE(JSON_VALUE(data,'$.Stage'),'—') stage, COUNT(*) n,
           SUM(COALESCE(SAFE_CAST(JSON_VALUE(data,'$.Amount') AS FLOAT64),0)) amount
    FROM {D}, rng
    WHERE {tscol} >= rng.a AND {tscol} < rng.b
    GROUP BY 1 ORDER BY n DESC
    """
    try:
        cfg = bigquery.QueryJobConfig(query_parameters=params)
        raw = {int(r["slot"]): r for r in _bq.query(slot_sql, job_config=cfg).result()}
        funnel_rows = list(_bq.query(funnel_sql, job_config=cfg).result())
    except Exception as e:
        return jsonify(error=str(e), slots=[], funnel=[])

    slots = []
    for i, meta in enumerate(DEAL_SLOTS):
        r = raw.get(i)
        created    = int(r["created"]) if r else 0
        connected  = int(r["connected"]) if r else 0
        won        = int(r["won"]) if r else 0
        activities = int(r["activities"] or 0) if r else 0
        slots.append({
            "label": meta["label"], "hours": meta["hours"], "working": meta["working"],
            "created": created, "connected": connected, "won": won,
            "activities": activities,
            "connectivity_ratio": _ratio(connected, created),  # % of deals with any activity
            "conversion": won,
            "conversion_ratio": _ratio(won, created),          # % of deals won
            "acts_per_deal": round(activities / created, 2) if created else 0.0,
        })

    def agg(k):
        return sum(s[k] for s in slots)
    tot_created, tot_conn = agg("created"), agg("connected")
    tot_won, tot_acts = agg("won"), agg("activities")
    totals = {
        "created": tot_created, "connected": tot_conn, "won": tot_won,
        "activities": tot_acts,
        "connectivity_ratio": _ratio(tot_conn, tot_created),
        "conversion": tot_won,
        "conversion_ratio": _ratio(tot_won, tot_created),
        "acts_per_deal": round(tot_acts / tot_created, 2) if tot_created else 0.0,
    }
    funnel = [{"stage": r["stage"], "n": int(r["n"]),
               "amount": float(r["amount"] or 0)} for r in funnel_rows]
    return jsonify(mode=mode, d_from=d_from, d_to=d_to,
                   slots=slots, totals=totals, funnel=funnel)


@app.route("/api/user/<user_id>/hourly")
def api_user_hourly(user_id):
    """Day x hour grid for one agent: online minutes + calls per cell (IST)."""
    d_from, d_to = _parse_range(request.args)
    S = f"`{PROJECT}.{DATASET}.{SNAP_TABLE}`"
    C = f"`{PROJECT}.{DATASET}.cdc_calls`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
              _P("cap", "INT64", POLL_CAP_SECONDS), _P("uid", "STRING", user_id)]
    sql = f"""
    WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a, TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b),
    snap AS (
      SELECT snapshot_time, is_online,
        LEAD(snapshot_time) OVER (ORDER BY snapshot_time) nx
      FROM {S}, rng WHERE user_id=@uid AND snapshot_time>=rng.a AND snapshot_time<rng.b),
    onl AS (
      SELECT DATE(snapshot_time,'{TZ}') day, EXTRACT(HOUR FROM DATETIME(snapshot_time,'{TZ}')) hr,
        SUM(IF(is_online, LEAST(TIMESTAMP_DIFF(nx,snapshot_time,SECOND),@cap),0))/60.0 mins
      FROM snap GROUP BY day, hr),
    cls AS (
      -- presence evidence from the unified activity feed (calls/tasks/meetings/online)
      SELECT DATE(activity_time,'{TZ}') day,
        EXTRACT(HOUR FROM DATETIME(activity_time,'{TZ}')) hr,
        COUNTIF(activity_type='call') calls, COUNT(*) acts
      FROM `{PROJECT}.{DATASET}.all_activity`, rng
      WHERE owner_id=@uid
        AND activity_type IN ('call','task','meeting','online_activity')
        AND activity_time >= rng.a AND activity_time < rng.b
      GROUP BY day, hr)
    SELECT COALESCE(o.day,c.day) day, COALESCE(o.hr,c.hr) hr,
           COALESCE(o.mins,0) mins, COALESCE(c.calls,0) calls, COALESCE(c.acts,0) acts
    FROM onl o FULL OUTER JOIN cls c ON o.day=c.day AND o.hr=c.hr
    ORDER BY day, hr
    """
    rows = _bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    grid = {}
    for r in rows:
        day = r["day"].strftime("%d %b")
        grid.setdefault(day, {})[int(r["hr"])] = {
            "mins": round(float(r["mins"] or 0), 1),
            "calls": int(r["calls"] or 0), "acts": int(r["acts"] or 0)}
    return jsonify(days=list(grid.keys()), grid=grid)


# --------------------------------------------------------------------------- #
# AI insight layer — Gemini on Vertex AI (uses the Cloud Run service account)
# --------------------------------------------------------------------------- #
VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
GEMINI_MODEL    = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")


def _insights_context(rows, d_from, d_to):
    """Build the shared data context (brand + team totals + per-agent summary)
    that both the auto-briefing and the conversational Q&A are grounded on."""
    # Compact the data so we send a small, structured summary (not raw rows).
    ranked = sorted(rows, key=lambda r: r["online_hours"], reverse=True)
    def line(r):
        return (f'{r["full_name"]} | role={r["role"]} | status={r["status"]} | '
                f'online_now={r["is_online"]} | login_hrs={r["online_hours"]:.2f} | '
                f'active_days={r["active_days"]} | deals_created={r["deals_created"]} | '
                f'won={r["won_deals"]} | won_value={r["won_amount"]:.0f} | '
                f'calls={r["calls_cnt"]} | talk_min={r["talk_min"]:.0f} | '
                f'meetings={r["meetings"]} | tasks={r["tasks_cnt"]} | '
                f'online_activities={r["online_acts"]} | '
                f'active_hours_by_activity={r["active_hours"]}')
    summary = "\n".join(line(r) for r in ranked)
    total = len(rows)
    online = sum(1 for r in rows if r["is_online"])
    tot_hrs = sum(r["online_hours"] for r in rows)
    tot_calls = sum(r["calls_cnt"] for r in rows)

    return f"""You are a data analyst for Lucira Jewelry (lucirajewelry.com), an Indian
ecommerce + omnichannel lab-grown diamond jewellery brand (founded by the Candere founder;
flagship stores in Mumbai, Pune, Noida, Delhi plus the online store). The "users" below are
CRM agents: sales executives and store teams (some accounts represent whole stores, e.g.
"Noida Store", "Borivali Team") handling website leads, calls, and store visits.

Below is their Zoho CRM login/activity data for {d_from} to {d_to}.
ALL metrics are scoped to that date range. Login hours are DERIVED from polling each
user's online status every 15 minutes — this history only started accumulating recently,
so treat very low login hours as "not enough data yet" rather than "inactive", and say so.
Calls/deals/meetings data is complete for the range. `active_hours_by_activity`
(distinct hours with any call/task/meeting/online-activity) is the RELIABLE
engagement measure — prefer it over login_hrs when they disagree.

Team totals: {total} users, {online} online now, {tot_hrs:.1f} login hours, {tot_calls} calls in range.

Per-user (sorted by login hours):
{summary}"""


def _gemini_model():
    import vertexai
    from vertexai.generative_models import GenerativeModel
    vertexai.init(project=PROJECT, location=VERTEX_LOCATION)
    return GenerativeModel(GEMINI_MODEL)


def _gemini_insights(rows, d_from, d_to):
    """Summarize the login/activity data and ask Gemini for a manager briefing."""
    prompt = _insights_context(rows, d_from, d_to) + """

Give a concise, manager-ready briefing in Markdown with these sections:
### Headline (2-3 bullets)
### Most & least engaged agents
### Activity vs. outcomes (do high-call/high-login agents create & win more deals?)
### Store vs. individual agent patterns
### Anomalies or things to check
### 3 concrete recommendations
Keep it tight and specific to the numbers. Do not invent data you weren't given."""
    return _gemini_model().generate_content(prompt).text


def _gemini_chat_answer(context, history, question):
    """Answer a follow-up question grounded on the same range-scoped data context.
    `history` is a list of {role: 'user'|'assistant', content: str} turns."""
    convo = "\n".join(
        f'{"MANAGER" if h.get("role") == "user" else "ANALYST"}: {h.get("content", "")}'
        for h in (history or [])
    )
    prompt = f"""{context}

You are answering a manager's follow-up questions about the data above in a running
conversation. Answer ONLY from the numbers provided in the context and the conversation.
If the answer isn't in the data, say so plainly and suggest what to check instead of
guessing. Be concise and specific; reply in Markdown (short paragraphs, bullets, or a
small table where it helps).

Conversation so far:
{convo}

MANAGER: {question}
ANALYST:"""
    return _gemini_model().generate_content(prompt).text


@app.route("/insights")
def insights():
    if not _is_connected():
        return redirect(url_for("index"))
    d_from, d_to = _parse_range(request.args)
    filt = {k: request.args.get(k, "") for k in ("role", "profile", "status", "online", "q")}
    try:
        rows = _users_query(d_from, d_to, filt)
    except Exception as e:
        return f"Query failed: {e}", 500
    if not rows:
        return render_template("insights.html", text=None, error="No data in range.",
                               d_from=d_from, d_to=d_to, filt=filt, model=GEMINI_MODEL)
    try:
        import markdown as _md
        text = _md.markdown(_gemini_insights(rows, d_from, d_to),
                            extensions=["tables", "sane_lists"])
        error = None
    except Exception as e:
        text, error = None, str(e)
    return render_template("insights.html", text=text, error=error,
                           d_from=d_from, d_to=d_to, filt=filt, model=GEMINI_MODEL)


@app.route("/user/<user_id>")
def user_detail(user_id):
    if not _is_connected():
        return redirect(url_for("index"))
    d_from, d_to = _parse_range(request.args)
    return render_template("user.html", user_id=user_id, d_from=d_from, d_to=d_to)


@app.route("/api/user/<user_id>/overview")
def api_user_overview(user_id):
    d_from, d_to = _parse_range(request.args)
    rows = _users_query(d_from, d_to, {}, user_id=user_id)
    if not rows:
        return jsonify(error="User not found"), 404
    # activity-derived presence: covers time before online-polling existed
    A = f"`{PROJECT}.{DATASET}.all_activity`"
    act = list(_bq.query(f"""
        WITH rng AS (SELECT TIMESTAMP(@d_from,'{TZ}') a,
                            TIMESTAMP(DATE_ADD(@d_to,INTERVAL 1 DAY),'{TZ}') b)
        SELECT MIN(activity_time) first_act, MAX(activity_time) last_act,
               COUNT(DISTINCT FORMAT_TIMESTAMP('%F-%H', activity_time, '{TZ}')) active_hours
        FROM {A}, rng
        WHERE owner_id=@uid AND activity_type IN ('call','task','meeting','online_activity')
          AND activity_time >= rng.a AND activity_time < rng.b
    """, job_config=bigquery.QueryJobConfig(query_parameters=[
        _P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
        _P("uid", "STRING", user_id)])).result())[0]
    activity = {
        "first": _ist_str(act["first_act"], "%d %b %H:%M"),
        "last": _ist_str(act["last_act"], "%d %b %H:%M"),
        "active_hours": int(act["active_hours"] or 0),
    }
    return jsonify(user=_ser_user(rows[0]),
                   daily=_daily_for(d_from, d_to, user_id),
                   deals=_deals_for(user_id),
                   activity=activity)


@app.route("/api/user/<user_id>/sessions")
def api_user_sessions(user_id):
    d_from, d_to = _parse_range(request.args)
    return jsonify(sessions=_sessions_for(d_from, d_to, user_id))


@app.route("/api/deal_triggers")
def api_deal_triggers():
    """Deals by entry trigger (Deal_Trigger_Event) + probability distribution,
    scoped to the deal date range. ?mode=created|modified selects the timestamp."""
    d_from, d_to = _parse_range(request.args)
    mode = "modified" if request.args.get("mode") == "modified" else "created"
    tscol = "modified_time" if mode == "modified" else "created_time"
    D = f"`{PROJECT}.{DATASET}.cdc_deals`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to)]
    rng = f"DATE({tscol},'{TZ}') BETWEEN @d_from AND @d_to"
    norm = ("CASE LOWER(TRIM(COALESCE(JSON_VALUE(data,'$.Deal_Trigger_Event'),'(none)')))"
            " WHEN 'add to cart' THEN 'atc' WHEN 'whatsapp chat' THEN 'whatsapp'"
            " WHEN 'sign up' THEN 'signup' WHEN 'purchase' THEN 'payment'"
            " ELSE LOWER(TRIM(COALESCE(JSON_VALUE(data,'$.Deal_Trigger_Event'),'(none)'))) END")
    trig_sql = f"""
      WITH d AS (
        SELECT {norm} trigger,
          SAFE_CAST(JSON_VALUE(data,'$.Probability') AS FLOAT64) prob,
          JSON_VALUE(data,'$.Stage')='Closed Won' won
        FROM {D} WHERE {rng}
      )
      SELECT trigger, COUNT(*) deals, ROUND(AVG(prob),1) avg_prob,
        COUNTIF(won) won, ROUND(100*COUNTIF(won)/COUNT(*),2) conv_pct
      FROM d GROUP BY trigger ORDER BY deals DESC LIMIT 30
    """
    prob_sql = f"""
      SELECT CAST(SAFE_CAST(JSON_VALUE(data,'$.Probability') AS FLOAT64) AS INT64) prob,
        COUNT(*) deals, COUNTIF(JSON_VALUE(data,'$.Stage')='Closed Won') won
      FROM {D} WHERE {rng} AND JSON_VALUE(data,'$.Probability') IS NOT NULL
      GROUP BY prob ORDER BY prob DESC
    """
    try:
        cfg = bigquery.QueryJobConfig(query_parameters=params)
        trig = [dict(r) for r in _bq.query(trig_sql, job_config=cfg).result()]
        prob = [dict(r) for r in _bq.query(prob_sql, job_config=cfg).result()]
    except Exception as e:
        return jsonify(error=str(e), triggers=[], prob=[]), 500
    return jsonify(
        triggers=[{"trigger": t["trigger"], "deals": t["deals"],
                   "avg_prob": float(t["avg_prob"] or 0), "won": t["won"],
                   "conv_pct": float(t["conv_pct"] or 0)} for t in trig],
        prob=[{"prob": p["prob"], "deals": p["deals"], "won": p["won"]} for p in prob],
        total=sum(t["deals"] for t in trig),
    )


# --------------------------------------------------------------------------- #
# Products — category / material / agent-by-category deal cuts
# --------------------------------------------------------------------------- #
# Deal↔product link lives in ds_imputed_reporting.corefactor_leads_data
# (Category ~36% filled, product_sku ~3.5%, agent 99.9%). Data currently ends
# ~30 May 2026, so this tab reports over all available lead history.
CF_LEADS = f"`{PROJECT}.ds_imputed_reporting.corefactor_leads_data`"
_CAT_NORM = """CASE LOWER(TRIM(Category))
  WHEN 'ring' THEN 'Rings' WHEN 'earring' THEN 'Earrings' WHEN 'bracelet' THEN 'Bracelets'
  WHEN 'necklace' THEN 'Necklaces' WHEN 'pendent' THEN 'Pendants' WHEN 'pendant' THEN 'Pendants'
  WHEN 'charms & pendants' THEN 'Pendants' WHEN 'charms' THEN 'Pendants' WHEN 'bangle' THEN 'Bangles'
  WHEN 'nosepins' THEN 'Nose Pin' WHEN 'nosepin' THEN 'Nose Pin' WHEN 'chain' THEN 'Chains'
  WHEN '' THEN NULL ELSE INITCAP(TRIM(Category)) END"""
# From SKU 3rd segment (e.g. 14YGLGD): hero MATERIAL (Diamond/Gold/Platinum) +
# metal COLOUR (YG->Yellow Gold). LGD=lab-grown diamond, PG=plain gold, PT=platinum.
_MATERIAL = """(SELECT CASE
    WHEN mc IS NULL THEN NULL
    WHEN REGEXP_CONTAINS(mc,'LGD') THEN 'Diamond'
    WHEN ENDS_WITH(mc,'PG') THEN 'Gold'
    WHEN STARTS_WITH(mc,'95') OR SUBSTR(mc,3,2)='PT' THEN 'Platinum'
    WHEN REGEXP_CONTAINS(mc,'GEM|CS') THEN 'Gemstone'
    ELSE 'Other' END FROM (SELECT SPLIT(product_sku,'-')[SAFE_OFFSET(2)] mc))"""
_COLOUR = """(SELECT CASE SUBSTR(mc,3,2)
    WHEN 'YG' THEN 'Yellow Gold' WHEN 'RG' THEN 'Rose Gold' WHEN 'WG' THEN 'White Gold'
    WHEN 'YW' THEN 'Yellow/White Gold' WHEN 'RW' THEN 'Rose/White Gold' WHEN 'PT' THEN 'Platinum'
    ELSE NULL END FROM (SELECT SPLIT(product_sku,'-')[SAFE_OFFSET(2)] mc))"""
_MATRIX_CATS = ["Rings", "Earrings", "Bracelets", "Necklaces", "Pendants", "Chains"]


@app.route("/api/products")
def api_products():
    """Deal cuts by product type, material, colour, gender, purity + agent ×
    product-type conversion. Date-filterable via ?from&to on the lead created_date."""
    d_from, d_to = request.args.get("from"), request.args.get("to")
    params, rng = [], "1=1"
    if d_from and d_to:
        params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to)]
        rng = "DATE(created_date) BETWEEN @d_from AND @d_to"

    def rows(sql):
        return [dict(r) for r in _bq.query(
            sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()]

    PROD = (f"(SELECT product_sku, ANY_VALUE(product_gender) g, ANY_VALUE(product_purity) p "
            f"FROM `{PROJECT}.ds_imputed_reporting.zoho_product_details` "
            f"WHERE product_sku IS NOT NULL GROUP BY product_sku)")
    conv = "COUNTIF(converted_date IS NOT NULL)"
    try:
        win = rows(f"SELECT FORMAT_DATE('%d %b %Y', MIN(DATE(created_date))) frm, "
                   f"FORMAT_DATE('%d %b %Y', MAX(DATE(created_date))) too, COUNT(*) total "
                   f"FROM {CF_LEADS} WHERE {rng}")[0]
        by_type = rows(f"""
          SELECT {_CAT_NORM} category, COUNT(*) deals, {conv} converted,
            ROUND(100*{conv}/COUNT(*),2) conv_pct,
            ROUND(AVG(NULLIF(product_price,0)),0) avg_price,
            ROUND(SUM(IF(converted_date IS NOT NULL, IFNULL(product_price,0),0)),0) won_value,
            ROUND(AVG(NULLIF(score,0)),1) avg_score,
            ROUND(AVG(conversion_duration_days),1) avg_days
          FROM {CF_LEADS} WHERE {rng} AND {_CAT_NORM} IS NOT NULL
          GROUP BY category ORDER BY deals DESC LIMIT 20""")
        by_material = rows(f"""
          SELECT {_MATERIAL} material, COUNT(*) deals, {conv} converted, ROUND(100*{conv}/COUNT(*),2) conv_pct
          FROM {CF_LEADS} WHERE {rng} AND product_sku IS NOT NULL AND product_sku!=''
          GROUP BY material HAVING material IS NOT NULL ORDER BY deals DESC LIMIT 10""")
        by_colour = rows(f"""
          SELECT {_COLOUR} colour, COUNT(*) deals, {conv} converted, ROUND(100*{conv}/COUNT(*),2) conv_pct
          FROM {CF_LEADS} WHERE {rng} AND product_sku IS NOT NULL AND product_sku!=''
          GROUP BY colour HAVING colour IS NOT NULL ORDER BY deals DESC LIMIT 10""")
        by_gender = rows(f"""
          SELECT COALESCE(pr.g,'(unknown)') gender, COUNT(*) deals,
            COUNTIF(l.converted_date IS NOT NULL) converted,
            ROUND(100*COUNTIF(l.converted_date IS NOT NULL)/COUNT(*),2) conv_pct
          FROM {CF_LEADS} l JOIN {PROD} pr ON pr.product_sku=l.product_sku
          WHERE {rng} GROUP BY gender ORDER BY deals DESC LIMIT 8""")
        by_purity = rows(f"""
          SELECT CASE WHEN LOWER(pr.p) LIKE 'platin%' THEN 'Platinum'
                      WHEN pr.p IN ('14KT','18KT','9KT','22KT') THEN pr.p ELSE '(other)' END purity,
            COUNT(*) deals, COUNTIF(l.converted_date IS NOT NULL) converted,
            ROUND(100*COUNTIF(l.converted_date IS NOT NULL)/COUNT(*),2) conv_pct
          FROM {CF_LEADS} l JOIN {PROD} pr ON pr.product_sku=l.product_sku
          WHERE {rng} GROUP BY purity ORDER BY deals DESC LIMIT 8""")
        by_price = rows(f"""
          SELECT band, {conv} converted, COUNT(*) deals, ROUND(100*{conv}/COUNT(*),2) conv_pct
          FROM (SELECT converted_date, CASE
              WHEN product_price < 10000 THEN '01·0–10k'   WHEN product_price < 20000 THEN '02·10k–20k'
              WHEN product_price < 30000 THEN '03·20k–30k' WHEN product_price < 40000 THEN '04·30k–40k'
              WHEN product_price < 50000 THEN '05·40k–50k' WHEN product_price < 75000 THEN '06·50k–75k'
              WHEN product_price < 100000 THEN '07·75k–100k' WHEN product_price < 150000 THEN '08·100k–150k'
              WHEN product_price < 200000 THEN '09·150k–200k' ELSE '10·200k+' END band
            FROM {CF_LEADS} WHERE {rng} AND product_price > 0)
          GROUP BY band ORDER BY band""")
        by_city = rows(f"""
          SELECT INITCAP(TRIM(city)) city, COUNT(*) deals, {conv} converted, ROUND(100*{conv}/COUNT(*),2) conv_pct
          FROM {CF_LEADS} WHERE {rng} AND city IS NOT NULL AND TRIM(city)!=''
          GROUP BY city ORDER BY deals DESC LIMIT 15""")
        by_month = rows(f"""
          SELECT FORMAT_DATE('%Y-%m', DATE(created_date)) month, COUNT(*) deals, {conv} converted,
            ROUND(100*{conv}/COUNT(*),2) conv_pct
          FROM {CF_LEADS} WHERE {rng} AND created_date IS NOT NULL
          GROUP BY month ORDER BY month""")
        by_segment = rows(f"""
          SELECT sg.segment, COUNT(*) deals, COUNTIF(l.converted_date IS NOT NULL) converted,
            ROUND(100*COUNTIF(l.converted_date IS NOT NULL)/COUNT(*),2) conv_pct
          FROM {CF_LEADS} l JOIN (
            SELECT z.product_sku, CASE WHEN na.product_id IS NOT NULL THEN 'New Arrival'
              WHEN bs.product_id IS NOT NULL THEN 'Bestseller' ELSE 'Other' END segment
            FROM (SELECT DISTINCT product_sku, product_code FROM `{PROJECT}.ds_imputed_reporting.zoho_product_details` WHERE product_sku IS NOT NULL) z
            LEFT JOIN (SELECT DISTINCT product_id FROM `{PROJECT}.product_segments.segments_newly_added_products`) na ON na.product_id=z.product_code
            LEFT JOIN (SELECT DISTINCT product_id FROM `{PROJECT}.product_segments.product_segments_table` WHERE segment='bestsellers') bs ON bs.product_id=z.product_code
          ) sg ON sg.product_sku=l.product_sku
          WHERE {rng} GROUP BY segment ORDER BY deals DESC""")
        agent_long = rows(f"""
          SELECT lead_owner agent, {_CAT_NORM} category, COUNT(*) deals, {conv} converted
          FROM {CF_LEADS}
          WHERE {rng} AND lead_owner IS NOT NULL AND lead_owner!='' AND {_CAT_NORM} IS NOT NULL
          GROUP BY agent, category""")
    except Exception as e:
        return jsonify(error=str(e)), 500

    agents = {}
    for r in agent_long:
        a = agents.setdefault(r["agent"], {"agent": r["agent"], "total_deals": 0, "total_conv": 0, "cats": {}})
        a["total_deals"] += r["deals"]
        a["total_conv"] += r["converted"]
        if r["category"] in _MATRIX_CATS:
            a["cats"][r["category"]] = {"deals": r["deals"], "converted": r["converted"],
                                        "conv_pct": round(100 * r["converted"] / r["deals"], 1) if r["deals"] else 0}
    agent_rows = sorted(agents.values(), key=lambda x: x["total_deals"], reverse=True)
    for a in agent_rows:
        a["conv_pct"] = round(100 * a["total_conv"] / a["total_deals"], 2) if a["total_deals"] else 0

    def n(v):
        return float(v) if v is not None else None

    def cut(lst, key):
        return [{key: r[key], "deals": r["deals"], "converted": r["converted"],
                 "conv_pct": float(r["conv_pct"] or 0)} for r in lst]

    return jsonify(
        window=win, matrix_cats=_MATRIX_CATS,
        by_type=[{"category": t["category"], "deals": t["deals"], "converted": t["converted"],
                  "conv_pct": float(t["conv_pct"] or 0), "avg_price": n(t["avg_price"]),
                  "won_value": n(t["won_value"]), "avg_score": n(t["avg_score"]),
                  "avg_days": n(t["avg_days"])} for t in by_type],
        by_material=cut(by_material, "material"), by_colour=cut(by_colour, "colour"),
        by_gender=cut(by_gender, "gender"), by_purity=cut(by_purity, "purity"),
        by_price=[{"band": b["band"].split("·", 1)[-1], "deals": b["deals"], "converted": b["converted"],
                   "conv_pct": float(b["conv_pct"] or 0)} for b in by_price],
        by_city=cut(by_city, "city"), by_segment=cut(by_segment, "segment"),
        by_month=[{"month": m["month"], "deals": m["deals"], "converted": m["converted"],
                   "conv_pct": float(m["conv_pct"] or 0)} for m in by_month],
        agents=agent_rows,
    )


# --------------------------------------------------------------------------- #
# Session Quality Index (SQI) — derived from the GA4 BigQuery export
# --------------------------------------------------------------------------- #
# Session = user_pseudo_id + ga_session_id. We aggregate GA4 events into one row
# per calendar day, score each day against the benchmark rules below (each metric
# earns its full weight when its benchmark is met, else 0), and expose per-day
# SQI (0-100), a trend series, and rolling/quarter daily-average cards.
#
# Traffic-source & funnel classification follows Lucira's channel rules:
#   Paid  = performance media (medium cpc/paid/display/retargeting/affiliate…)
#   TOF/MOF/BOF = utm_campaign token (online_tof_/_mof_/_bof_), with organic→TOF,
#                 retargeting→MOF, direct→MOF as defaults.
GA4_DATASET = os.environ.get("GA4_DATASET", "analytics_478308692")
PAID_MEDIA  = ("cpc", "ppc", "paid", "paidsearch", "display", "retargeting",
               "cpm", "affiliate")


def _safe_div(n, d):
    return (float(n) / float(d)) if d else 0.0


# (group, key, label, weight, value_fn(agg)->ratio, cmp, threshold, fmt, rule)
SQI_METRICS = [
    ("Traffic Quality", "source_split",    "Source Split",     10,
     lambda a: _safe_div(a["paid_sessions"], a["sessions"]),          "<=", 0.80,  "pct", "Paid share ≤ 80%"),
    ("Traffic Quality", "funnel_split",    "Funnel Split",     10,
     lambda a: _safe_div(a["tof_sessions"], a["sessions"]),           "<=", 0.60,  "pct", "TOF ≤ 60% (MOF+BOF ≥ 40%)"),
    ("Traffic Quality", "new_returning",   "New vs Returning", 10,
     lambda a: _safe_div(a["new_users"], a["total_users"]),           "<=", 0.75,  "pct", "New users ≤ 75% (Returning ≥ 25%)"),
    ("Engagement",      "engagement_time", "Engagement Time",  10,
     lambda a: _safe_div(a["eng_sec"], a["sessions"]),                ">=", 30.0,  "sec", "Avg engagement ≥ 30 sec"),
    ("Engagement",      "engaged_session", "Engaged Session",  10,
     lambda a: _safe_div(a["engaged_sessions"], a["sessions"]),       ">=", 0.48,  "pct", "Engaged sessions ÷ sessions ≥ 48%"),
    ("Engagement",      "event_count",     "Event Count",       5,
     lambda a: _safe_div(a["events"], a["sessions"]),                 ">=", 5.8,   "num", "Events ÷ session ≥ 5.8"),
    ("Intent Signals",  "product_view",    "Product View",      5,
     lambda a: _safe_div(a["view_items"], a["sessions"]),             ">=", 1.00,  "pct", "Product views ÷ session ≥ 100%"),
    ("Intent Signals",  "add_to_cart",     "Add to Cart",      10,
     lambda a: _safe_div(a["atc"], a["view_items"]),                  ">=", 0.017, "pct", "Add to cart ÷ product view ≥ 1.7%"),
    ("Intent Signals",  "view_cart",       "View Cart",         5,
     lambda a: _safe_div(a["view_cart"], a["page_views"]),            ">=", 0.0020,"pct", "View cart ÷ page view ≥ 0.20%"),
    ("Intent Signals",  "checkout_start",  "Checkout Start",   10,
     lambda a: _safe_div(a["begin_checkout"], a["sessions"]),         ">=", 0.0060,"pct", "Begin checkout ÷ session ≥ 0.60%"),
    ("Intent Signals",  "payment_attempt", "Payment Attempt",   5,
     lambda a: _safe_div(a["add_payment_info"], a["begin_checkout"]), ">=", 0.10,  "pct", "Payment attempt ÷ begin checkout ≥ 10%"),
    ("Trust Signals",   "pincode",         "Pincode Entered",   5,
     lambda a: _safe_div(a["pincode_sessions"], a["sessions"]),       ">=", 0.05,  "pct", "Pincode entered ÷ session ≥ 5%"),
    ("Trust Signals",   "whatsapp",        "WhatsApp Click",    5,
     lambda a: _safe_div(a["chat_sessions"], a["sessions"]),          ">=", 0.008, "pct", "Chat with expert ÷ session ≥ 0.8%"),
]
SQI_GROUP_WEIGHT = {"Traffic Quality": 30, "Engagement": 25,
                    "Intent Signals": 35, "Trust Signals": 10}


def _fmt_metric_value(val, fmt):
    if fmt == "pct":
        return f"{val * 100:.2f}%"
    if fmt == "sec":
        return f"{val:.1f}s"
    return f"{val:.2f}"


def _score_day(a):
    """Return (sqi_score, [metric dicts]) for one day-aggregate row."""
    sqi, metrics = 0, []
    for grp, key, label, wt, vfn, cmp, thr, fmt, rule in SQI_METRICS:
        val = vfn(a)
        passed = (val <= thr) if cmp == "<=" else (val >= thr)
        earned = wt if passed else 0
        sqi += earned
        metrics.append({
            "group": grp, "key": key, "label": label, "weight": wt,
            "earned": earned, "passed": passed, "rule": rule,
            "value": round(val, 5), "value_str": _fmt_metric_value(val, fmt),
        })
    return sqi, metrics


def _sqi_daily(start_yyyymmdd, end_yyyymmdd):
    """One aggregate row per GA4 day between the two YYYYMMDD suffixes."""
    E = f"`{PROJECT}.{GA4_DATASET}.events_*`"
    sql = f"""
    WITH base AS (
      SELECT
        CONCAT(user_pseudo_id,'-',CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key='ga_session_id') AS STRING)) sk,
        user_pseudo_id upid,
        PARSE_DATE('%Y%m%d', event_date) ed,
        event_name,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key='ga_session_number') snum,
        (SELECT COALESCE(value.int_value, SAFE_CAST(value.string_value AS INT64)) FROM UNNEST(event_params) WHERE key='session_engaged') eng,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key='engagement_time_msec') emsec,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key='creative_name') creative,
        session_traffic_source_last_click.manual_campaign.medium med,
        session_traffic_source_last_click.manual_campaign.source src,
        session_traffic_source_last_click.manual_campaign.campaign_name camp
      FROM {E}
      WHERE _TABLE_SUFFIX BETWEEN @start AND @end
    ),
    sess AS (
      SELECT sk, ANY_VALUE(upid) upid, MIN(ed) d, MAX(snum) snum, MAX(eng) eng, SUM(IFNULL(emsec,0)) emsec,
        COUNT(*) events,
        MAX(IF(event_name='first_visit',1,0)) is_fv,
        COUNTIF(event_name='page_view') page_views,
        COUNTIF(event_name='view_item') view_items,
        COUNTIF(event_name='add_to_cart') atc,
        COUNTIF(event_name='view_cart') view_cart,
        COUNTIF(event_name='begin_checkout') begin_checkout,
        COUNTIF(event_name='add_payment_info') add_payment_info,
        MAX(IF(event_name='select_promotion' AND creative='pincodeEntered',1,0)) pincode,
        MAX(IF(event_name='select_promotion' AND creative='chatWithExperts',1,0)) chat,
        ANY_VALUE(med) med, ANY_VALUE(src) src, ANY_VALUE(camp) camp
      FROM base GROUP BY sk
    ),
    cls AS (
      SELECT *,
        IF(LOWER(IFNULL(med,'')) IN UNNEST(@paid), 1, 0) is_paid,
        CASE
          WHEN REGEXP_CONTAINS(LOWER(IFNULL(camp,'')), r'bof') THEN 'BOF'
          WHEN REGEXP_CONTAINS(LOWER(IFNULL(camp,'')), r'mof') THEN 'MOF'
          WHEN REGEXP_CONTAINS(LOWER(IFNULL(camp,'')), r'tof') THEN 'TOF'
          WHEN LOWER(IFNULL(med,'')) = 'organic' THEN 'TOF'
          WHEN LOWER(IFNULL(med,'')) = 'retargeting' THEN 'MOF'
          WHEN IFNULL(src,'(not set)') IN ('(not set)','(direct)','(none)') THEN 'MOF'
          ELSE 'TOF' END funnel,
        IF(IFNULL(eng,0) = 1, 1, 0) is_engaged
      FROM sess
    )
    SELECT FORMAT_DATE('%Y-%m-%d', d) day,
      COUNT(*) sessions, SUM(events) events, SUM(page_views) page_views,
      SUM(view_items) view_items, SUM(atc) atc, SUM(view_cart) view_cart,
      SUM(begin_checkout) begin_checkout, SUM(add_payment_info) add_payment_info,
      SUM(emsec)/1000.0 eng_sec, SUM(is_engaged) engaged_sessions,
      COUNT(DISTINCT upid) total_users,
      COUNT(DISTINCT IF(is_fv=1, upid, NULL)) new_users,
      SUM(is_paid) paid_sessions,
      COUNTIF(funnel='TOF') tof_sessions, COUNTIF(funnel='MOF') mof_sessions,
      COUNTIF(funnel='BOF') bof_sessions, SUM(pincode) pincode_sessions, SUM(chat) chat_sessions
    FROM cls GROUP BY day ORDER BY day
    """
    params = [
        _P("start", "STRING", start_yyyymmdd),
        _P("end", "STRING", end_yyyymmdd),
        bigquery.ArrayQueryParameter("paid", "STRING", list(PAID_MEDIA)),
    ]
    rows = _bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return {r["day"]: dict(r) for r in rows}


def _prev_quarter_range(today):
    """Previous complete calendar quarter (start, end) relative to `today`."""
    curr_q_start = dt.date(today.year, ((today.month - 1) // 3) * 3 + 1, 1)
    pq_end = curr_q_start - dt.timedelta(days=1)
    pq_start = dt.date(pq_end.year, ((pq_end.month - 1) // 3) * 3 + 1, 1)
    return pq_start, pq_end


@app.route("/api/sqi")
def api_sqi():
    """Session Quality Index. Defaults to T-2 (GA4's last fully-baked day).
    ?date=YYYY-MM-DD selects the day whose metric breakdown is returned."""
    today = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date()
    t2 = today - dt.timedelta(days=2)
    try:
        sel_date = dt.date.fromisoformat(request.args.get("date", "")) if request.args.get("date") else t2
    except ValueError:
        sel_date = t2

    pq_start, pq_end = _prev_quarter_range(today)
    window_start = min(pq_start, t2 - dt.timedelta(days=92), sel_date)
    window_end = max(t2, sel_date)
    try:
        daily = _sqi_daily(window_start.strftime("%Y%m%d"), window_end.strftime("%Y%m%d"))
    except Exception as e:
        return jsonify(error=str(e)), 500

    scored = {day: _score_day(a)[0] for day, a in daily.items()}

    sel_key = sel_date.isoformat()
    if sel_key in daily:
        sqi_sel, metrics_sel = _score_day(daily[sel_key])
        sessions_sel = int(daily[sel_key]["sessions"])
    else:
        sqi_sel, metrics_sel, sessions_sel = None, [], 0

    def avg_over(a, b):
        vals = [v for d, v in scored.items() if a.isoformat() <= d <= b.isoformat()]
        return (round(sum(vals) / len(vals), 1), len(vals)) if vals else (None, 0)

    period_defs = [
        ("T-2", t2, t2),
        ("Last 7 Days", t2 - dt.timedelta(days=6), t2),
        ("Last 14 Days", t2 - dt.timedelta(days=13), t2),
        ("Last Month", t2 - dt.timedelta(days=29), t2),
        ("Last 3 Months", t2 - dt.timedelta(days=89), t2),
        ("Last Quarter", pq_start, pq_end),
    ]
    periods = []
    for label, a, b in period_defs:
        avg, n = avg_over(a, b)
        periods.append({"label": label, "avg_sqi": avg, "days": n,
                        "from": a.isoformat(), "to": b.isoformat()})

    trend, d = [], t2 - dt.timedelta(days=29)
    while d <= t2:
        k = d.isoformat()
        trend.append({"date": k, "sqi": scored.get(k)})
        d += dt.timedelta(days=1)

    return jsonify(
        t2=t2.isoformat(), max_date=t2.isoformat(), selected_date=sel_key,
        selected={"sqi": sqi_sel, "sessions": sessions_sel, "metrics": metrics_sel},
        group_weight=SQI_GROUP_WEIGHT, periods=periods, trend=trend,
    )


# --------------------------------------------------------------------------- #
# Deal Quality Index (DQI) — marketing-driven, benchmarked to June 2026
# --------------------------------------------------------------------------- #
# Deals-based (never leads). Quality is driven by source mix, GA4 session
# quality, connectivity (the one activity metric = deal has a >=30s call), and
# conversion. Each metric earns its weight when it beats the June benchmark.
# Junk = marketing sources that barely convert (nitro dominates). Shopify is
# neutral (store footfall that converted, not marketing lead quality).
DQI_JUNK_SOURCES = ("nitro", "ig", "fb", "broadcast", "trigger", "rtbcom", "direct", "chat", "c")

# Benchmarks are June's daily 25th-percentile (softened so a typical June day
# scores well). "High-converting" is now ATC-and-above deal share (funnel stage),
# not source buckets.
# (group, key, label, weight, value_fn(agg)->ratio, cmp, June-P25 threshold, fmt, rule)
DQI_METRICS = [
    ("Session Quality", "session_deal",   "Session → Deal rate",   10,
     lambda a: _safe_div(a["deals"], a["sessions"]),   ">=", 0.011,  "pct", "Deals ÷ sessions ≥ 1.1% (June)"),
    ("Session Quality", "quality_session", "Quality-session share", 10,
     lambda a: _safe_div(a["engaged"], a["sessions"]), ">=", 0.53,   "pct", "Engaged ÷ sessions ≥ 53% (June)"),
    ("Source & Intent", "atc_above",       "ATC+ deal share",       15,
     lambda a: _safe_div(a["atc_above"], a["deals"]),  ">=", 0.016,  "pct", "ATC-and-above deals ≥ 1.6% (June)"),
    ("Source & Intent", "junk_src",        "Junk-source share",     15,
     lambda a: _safe_div(a["junk"], a["deals"]),       "<=", 0.654,  "pct", "Junk-source deals ≤ 65% (June)"),
    ("Source & Intent", "diversity",       "Source diversity",      10,
     lambda a: 1 - _safe_div(a["top_c"], a["deals"]),  ">=", 0.31,   "pct", "1 − top-source share ≥ 31% (June)"),
    ("Connectivity",    "connectivity",    "Connectivity %",        15,
     lambda a: _safe_div(a["connected"], a["deals"]),  ">=", 0.115,  "pct", "Deals w/ ≥30s call ≥ 11.5% (June)"),
    ("Conversion",      "conversion",      "Deal conversion %",     15,
     lambda a: _safe_div(a["won"], a["deals"]),        ">=", 0.005,  "pct", "Closed Won ÷ deals ≥ 0.5% (June)"),
    ("Conversion",      "connected_won",   "Connected → Won %",     10,
     lambda a: _safe_div(a["won"], a["connected"]),    ">=", 0.05,   "pct", "Won ÷ connected ≥ 5% (June)"),
]
DQI_GROUP_WEIGHT = {"Session Quality": 20, "Source & Intent": 40,
                    "Connectivity": 15, "Conversion": 25}


def _score_day_dqi(a):
    sqi, metrics = 0, []
    for grp, key, label, wt, vfn, cmp, thr, fmt, rule in DQI_METRICS:
        val = vfn(a)
        passed = (val <= thr) if cmp == "<=" else (val >= thr)
        earned = wt if passed else 0
        sqi += earned
        metrics.append({"group": grp, "key": key, "label": label, "weight": wt,
                        "earned": earned, "passed": passed, "rule": rule,
                        "value": round(val, 5), "value_str": _fmt_metric_value(val, fmt)})
    return sqi, metrics


def _dqi_deals_daily(d_from, d_to):
    D = f"`{PROJECT}.{DATASET}.cdc_deals`"
    C = f"`{PROJECT}.{DATASET}.cdc_calls`"
    params = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to),
              bigquery.ArrayQueryParameter("junk", "STRING", list(DQI_JUNK_SOURCES))]
    sql = f"""
    WITH d AS (
      SELECT id, DATE(created_time,'{TZ}') day, JSON_VALUE(data,'$.Stage') stage,
        LOWER(COALESCE(JSON_VALUE(data,'$.UTM_Source'),'(none)')) src
      FROM {D} WHERE DATE(created_time,'{TZ}') BETWEEN @d_from AND @d_to
    ),
    conn AS (
      SELECT DISTINCT JSON_VALUE(data,'$.What_Id.id') deal_id FROM {C}
      WHERE SAFE_CAST(JSON_VALUE(data,'$.Call_Duration_in_seconds') AS FLOAT64) >= 30
        AND JSON_VALUE(data,'$.What_Id.id') IS NOT NULL
    ),
    b AS (
      SELECT day, id, stage,
        stage IN ('Add to Cart','Checkout','Payment','Closed Won') atc_above,
        src IN UNNEST(@junk) junk, src,
        id IN (SELECT deal_id FROM conn) connected FROM d
    ),
    per_src AS (SELECT day, src, COUNT(*) c FROM b GROUP BY day, src),
    top AS (SELECT day, MAX(c) top_c FROM per_src GROUP BY day)
    SELECT FORMAT_DATE('%Y-%m-%d', b.day) day, COUNT(*) deals,
      COUNTIF(stage='Closed Won') won, COUNTIF(atc_above) atc_above, COUNTIF(junk) junk,
      COUNTIF(connected) connected, ANY_VALUE(top.top_c) top_c
    FROM b JOIN top ON b.day=top.day GROUP BY b.day
    """
    rows = _bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return {r["day"]: dict(r) for r in rows}


def _dqi_ga4_daily(start_yyyymmdd, end_yyyymmdd):
    E = f"`{PROJECT}.{GA4_DATASET}.events_*`"
    sql = f"""
    WITH base AS (
      SELECT CONCAT(user_pseudo_id,'-',CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key='ga_session_id') AS STRING)) sk,
        PARSE_DATE('%Y%m%d', event_date) day,
        (SELECT COALESCE(value.int_value, SAFE_CAST(value.string_value AS INT64)) FROM UNNEST(event_params) WHERE key='session_engaged') eng
      FROM {E} WHERE _TABLE_SUFFIX BETWEEN @start AND @end
    ),
    sess AS (SELECT sk, MIN(day) day, MAX(eng) eng FROM base GROUP BY sk)
    SELECT FORMAT_DATE('%Y-%m-%d', day) day, COUNT(*) sessions,
      SUM(IF(IFNULL(eng,0)=1,1,0)) engaged FROM sess GROUP BY day
    """
    params = [_P("start", "STRING", start_yyyymmdd), _P("end", "STRING", end_yyyymmdd)]
    rows = _bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return {r["day"]: dict(r) for r in rows}


@app.route("/api/dqi")
def api_dqi():
    """Deal Quality Index. Defaults to T-1. ?date=YYYY-MM-DD selects the day
    whose metric breakdown is returned. (GA4 session metrics settle at T-2.)"""
    today = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date()
    t2 = today - dt.timedelta(days=1)
    try:
        sel_date = dt.date.fromisoformat(request.args.get("date", "")) if request.args.get("date") else t2
    except ValueError:
        sel_date = t2

    pq_start, pq_end = _prev_quarter_range(today)
    window_start = min(pq_start, t2 - dt.timedelta(days=92), sel_date)
    window_end = max(t2, sel_date)
    try:
        deals = _dqi_deals_daily(window_start.isoformat(), window_end.isoformat())
        ga4 = _dqi_ga4_daily(window_start.strftime("%Y%m%d"), window_end.strftime("%Y%m%d"))
    except Exception as e:
        return jsonify(error=str(e)), 500

    days = set(deals) | set(ga4)
    agg = {}
    for day in days:
        d = deals.get(day, {})
        g = ga4.get(day, {})
        agg[day] = {
            "deals": d.get("deals", 0), "won": d.get("won", 0),
            "atc_above": d.get("atc_above", 0), "junk": d.get("junk", 0),
            "connected": d.get("connected", 0), "top_c": d.get("top_c", 0),
            "sessions": g.get("sessions", 0), "engaged": g.get("engaged", 0),
        }
    scored = {day: _score_day_dqi(a)[0] for day, a in agg.items()}

    sel_key = sel_date.isoformat()
    if sel_key in agg and agg[sel_key]["deals"]:
        dqi_sel, metrics_sel = _score_day_dqi(agg[sel_key])
        deals_sel = agg[sel_key]["deals"]
    else:
        dqi_sel, metrics_sel, deals_sel = None, [], 0

    def avg_over(a, b):
        vals = [scored[dd] for dd in scored if a.isoformat() <= dd <= b.isoformat()
                and agg[dd]["deals"]]
        return (round(sum(vals) / len(vals), 1), len(vals)) if vals else (None, 0)

    period_defs = [
        ("T-1", t2, t2), ("Last 7 Days", t2 - dt.timedelta(days=6), t2),
        ("Last 14 Days", t2 - dt.timedelta(days=13), t2),
        ("Last Month", t2 - dt.timedelta(days=29), t2),
        ("Last 3 Months", t2 - dt.timedelta(days=89), t2),
        ("Last Quarter", pq_start, pq_end),
    ]
    periods = [{"label": lbl, "avg_sqi": avg_over(a, b)[0], "days": avg_over(a, b)[1],
                "from": a.isoformat(), "to": b.isoformat()} for lbl, a, b in period_defs]

    trend, d = [], t2 - dt.timedelta(days=29)
    while d <= t2:
        k = d.isoformat()
        trend.append({"date": k, "sqi": scored.get(k) if agg.get(k, {}).get("deals") else None})
        d += dt.timedelta(days=1)

    return jsonify(
        t2=t2.isoformat(), max_date=t2.isoformat(), selected_date=sel_key,
        selected={"sqi": dqi_sel, "sessions": deals_sel, "metrics": metrics_sel},
        group_weight=DQI_GROUP_WEIGHT, periods=periods, trend=trend,
    )


# --------------------------------------------------------------------------- #
# LimeChat webhook ingestion
# --------------------------------------------------------------------------- #
# LimeChat POSTs conversation/message events here. We verify a shared secret
# (LimeChat can't do our Basic Auth, so /limechat/webhook is auth-exempt) and
# stream the raw payload into limechat.events for later parsing. Schema is
# intentionally generic (full JSON in `payload`) since LimeChat's exact event
# shape is discovered from real traffic.
LIMECHAT_TOKEN = os.environ.get("LIMECHAT_WEBHOOK_TOKEN", "")
LIMECHAT_TABLE = f"{PROJECT}.limechat.events"


@app.route("/limechat/webhook", methods=["GET", "POST"])
def limechat_webhook():
    # Some providers validate a webhook with a GET challenge — echo it back.
    if request.method == "GET":
        chal = request.args.get("challenge") or request.args.get("hub.challenge")
        return (chal, 200) if chal else jsonify(ok=True, ready=True)

    if LIMECHAT_TOKEN:
        supplied = (request.headers.get("X-Limechat-Token")
                    or request.headers.get("Authorization", "").replace("Bearer ", "").strip()
                    or request.args.get("token", ""))
        if not hmac.compare_digest(supplied or "", LIMECHAT_TOKEN):
            abort(401)

    raw = request.get_data(as_text=True) or ""
    body = request.get_json(silent=True) or {}
    etype = body.get("event") or body.get("type") or body.get("event_type") or body.get("action")
    row = {
        "received_at": dt.datetime.utcnow().isoformat() + "Z",
        "event_type": etype,
        "source_ip": request.headers.get("X-Forwarded-For", request.remote_addr),
        "payload": raw if raw else json.dumps(body, ensure_ascii=False),
    }
    try:
        errors = _bq.insert_rows_json(LIMECHAT_TABLE, [row])
        if errors:
            return jsonify(ok=False, errors=errors), 500
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500
    return jsonify(ok=True), 200


# --------------------------------------------------------------------------- #
# LimeChat helpdesk sync (Chatwoot-based API) -> BigQuery limechat.conversations
# --------------------------------------------------------------------------- #
# Pulls conversations across all statuses, fetches each conversation's full
# message history, and derives per-conversation performance metrics:
#   sender.type: contact = customer, agent_bot = AI, user = human agent.
#   FRT = first human (user) reply - conversation created; bot-first likewise.
# Stored one row per conversation (full refresh) for the Chat/Helpdesk tab.
LIMECHAT_BASE      = os.environ.get("LIMECHAT_BASE", "https://app.limechat.ai")
LIMECHAT_ACCOUNT   = os.environ.get("LIMECHAT_ACCOUNT", "28613")
LIMECHAT_API_TOKEN = os.environ.get("LIMECHAT_API_TOKEN", "")
LC_CONV_TABLE = f"{PROJECT}.limechat.conversations"


def _lc_get(path, params=None, attempts=3):
    last = None
    for _ in range(attempts):
        try:
            r = requests.get(f"{LIMECHAT_BASE}{path}",
                             headers={"api_access_token": LIMECHAT_API_TOKEN},
                             params=params or {}, timeout=60)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last = e
    raise last


def _lc_epoch(v):
    """Chatwoot timestamp (epoch int or ISO string) -> epoch seconds."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def _lc_iso(epoch):
    return dt.datetime.utcfromtimestamp(epoch).isoformat() + "Z" if epoch else None


def _lc_all_messages(acct, cid):
    """Page a conversation's messages oldest-first (walks backward via `before`)."""
    out, before = [], None
    for _ in range(30):
        data = _lc_get(f"/api/v1/accounts/{acct}/conversations/{cid}/messages",
                       {"before": before} if before else None)
        batch = data.get("payload") if isinstance(data, dict) else data
        if not batch:
            break
        out.extend(batch)
        ids = [m.get("id") for m in batch if m.get("id")]
        if not ids:
            break
        mn = min(ids)
        if before is not None and mn >= before:
            break
        before = mn
        if len(batch) < 20:
            break
    return out


def _lc_msg_metrics(messages, created):
    """Response timings + message counts from a message list. sender.type is only
    populated on the per-conversation messages endpoint (detailed), not on the
    embedded list payload — so bot/human split is only meaningful when detailed."""
    first_bot = first_human = first_any = None
    n_in = n_out = n_bot = n_human = 0
    for m in sorted([x for x in (messages or []) if not x.get("private")],
                    key=lambda x: x.get("created_at") or 0):
        mt = m.get("message_type")
        st = ((m.get("sender") or {}).get("type") or "").lower()
        ts = _lc_epoch(m.get("created_at"))
        if mt == 0 or st == "contact":
            n_in += 1
        elif mt == 1:
            n_out += 1
            if first_any is None:
                first_any = ts
            if st == "agent_bot":
                n_bot += 1
                if first_bot is None:
                    first_bot = ts
            elif st == "user":
                n_human += 1
                if first_human is None:
                    first_human = ts
    d = lambda a: (a - created) if (a and created) else None
    return {"first_any": d(first_any), "first_bot": d(first_bot),
            "first_human": d(first_human), "n_in": n_in, "n_out": n_out,
            "n_bot": n_bot, "n_human": n_human}


def _lc_conv_row(conv, messages, synced_at, detailed):
    """detailed=True: messages are the full per-conversation history (accurate
    human FRT / bot split). detailed=False: metadata only (embedded messages) —
    human/bot inferred from whether a human agent is assigned."""
    created = _lc_epoch(conv.get("created_at"))
    assignee = (conv.get("meta") or {}).get("assignee") or {}
    sender = (conv.get("meta") or {}).get("sender") or {}
    has_assignee = bool(assignee.get("id"))
    m = _lc_msg_metrics(messages, created)
    status = conv.get("status")
    resolved = _lc_epoch(conv.get("timestamp")) if status in ("resolved", "closed") else None
    return {
        "conversation_id": conv.get("id"),
        "created_at": _lc_iso(created), "status": status,
        "inbox_id": conv.get("inbox_id"),
        "assignee_id": assignee.get("id"), "assignee_name": assignee.get("name"),
        "contact_name": sender.get("name"),
        "contact_phone": (sender.get("phone_number") or "").lstrip("+") or None,
        "first_response_sec": m["first_any"],
        "first_bot_response_sec": m["first_bot"] if detailed else None,
        "first_human_response_sec": m["first_human"] if detailed else None,
        "resolution_sec": (resolved - created) if (resolved and created) else None,
        "resolved_at": _lc_iso(resolved),
        "msgs_in": m["n_in"], "msgs_out": m["n_out"],
        "msgs_bot": m["n_bot"] if detailed else None,
        "msgs_human": m["n_human"] if detailed else None,
        "had_human": (m["n_human"] > 0) if detailed else has_assignee,
        "bot_handled_only": (m["n_bot"] > 0 and m["n_human"] == 0) if detailed
                            else (not has_assignee and m["n_out"] > 0),
        "detailed": detailed, "synced_at": synced_at,
    }


def _lc_conv_schema():
    S = bigquery.SchemaField
    return [
        S("conversation_id", "INT64"), S("created_at", "TIMESTAMP"), S("status", "STRING"),
        S("inbox_id", "INT64"), S("assignee_id", "INT64"), S("assignee_name", "STRING"),
        S("contact_name", "STRING"), S("contact_phone", "STRING"),
        S("first_response_sec", "INT64"), S("first_bot_response_sec", "INT64"),
        S("first_human_response_sec", "INT64"), S("resolution_sec", "INT64"),
        S("resolved_at", "TIMESTAMP"), S("msgs_in", "INT64"), S("msgs_out", "INT64"),
        S("msgs_bot", "INT64"), S("msgs_human", "INT64"), S("bot_handled_only", "BOOL"),
        S("had_human", "BOOL"), S("detailed", "BOOL"), S("synced_at", "TIMESTAMP"),
    ]


def sync_limechat(statuses=("open", "resolved"), max_pages=40, enrich_days=7):
    """Metadata sync of ALL conversations (list API only, no per-conversation
    calls) so counts match LimeChat, then fetch full message history only for
    conversations created within the last `enrich_days` to compute accurate
    human FRT / bot split. Full refresh."""
    if not LIMECHAT_API_TOKEN:
        raise RuntimeError("LIMECHAT_API_TOKEN not configured")
    acct = LIMECHAT_ACCOUNT
    now = dt.datetime.utcnow().isoformat() + "Z"
    seen = {}
    for status in statuses:
        for page in range(1, max_pages + 1):
            try:
                data = _lc_get(f"/api/v1/accounts/{acct}/conversations",
                               {"assignee_type": "all", "status": status, "page": page})
            except Exception:
                break  # invalid status / transient error — skip rest of this status
            payload = (data.get("data") or {}).get("payload") or []
            if not payload:
                break
            for conv in payload:
                cid = conv.get("id")
                if cid and cid not in seen:
                    seen[cid] = _lc_conv_row(conv, conv.get("messages") or [], now, detailed=False)

    enriched = 0
    if enrich_days:
        today = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date()
        cutoff = (today - dt.timedelta(days=enrich_days)).isoformat()
        for cid, row in seen.items():
            if row["created_at"] and row["created_at"][:10] >= cutoff:
                try:
                    full = _lc_all_messages(acct, cid)
                    created = _lc_epoch(row["created_at"])
                    mm = _lc_msg_metrics(full, created)
                    row.update({
                        "first_response_sec": mm["first_any"],
                        "first_bot_response_sec": mm["first_bot"],
                        "first_human_response_sec": mm["first_human"],
                        "msgs_in": mm["n_in"], "msgs_out": mm["n_out"],
                        "msgs_bot": mm["n_bot"], "msgs_human": mm["n_human"],
                        "had_human": mm["n_human"] > 0,
                        "bot_handled_only": mm["n_bot"] > 0 and mm["n_human"] == 0,
                        "detailed": True,
                    })
                    enriched += 1
                except Exception:
                    pass

    rows = list(seen.values())
    if rows:
        _bq.load_table_from_json(
            rows, LC_CONV_TABLE, location="asia-south1",
            job_config=bigquery.LoadJobConfig(
                schema=_lc_conv_schema(),
                write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE),
        ).result()
    return {"conversations": len(rows), "enriched": enriched, "synced_at": now}


def _chat_range(args):
    # GA4/LimeChat settle a day late — default to T-1 (yesterday), single day.
    t1 = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date() - dt.timedelta(days=1)
    f = args.get("from") or t1.isoformat()
    t = args.get("to") or t1.isoformat()
    return f, t


@app.route("/api/chat")
def api_chat():
    """LimeChat helpdesk metrics (FRT, resolution, agent performance, bot deflection)
    scoped to conversation created_at in range. Defaults to last 90 days."""
    d_from, d_to = _chat_range(request.args)
    T = f"`{PROJECT}.limechat.conversations`"
    P = [_P("d_from", "DATE", d_from), _P("d_to", "DATE", d_to)]
    rng = "DATE(created_at) BETWEEN @d_from AND @d_to"

    def q(sql):
        return list(_bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=P)).result())

    try:
        s = q(f"""
          SELECT COUNT(*) convs, COUNTIF(status='open') open, COUNTIF(status='resolved') resolved,
            COUNTIF(status='closed') closed, COUNTIF(detailed) detailed_convs,
            COUNTIF(had_human) with_human, COUNTIF(bot_handled_only) bot_only,
            ROUND(100*SAFE_DIVIDE(COUNTIF(bot_handled_only),COUNT(*)),1) bot_deflection,
            ROUND(APPROX_QUANTILES(first_human_response_sec,2)[OFFSET(1)]/60,1) frt_med_min,
            ROUND(AVG(first_human_response_sec)/60,1) frt_avg_min,
            ROUND(APPROX_QUANTILES(first_bot_response_sec,2)[OFFSET(1)],1) bot_resp_med_sec,
            ROUND(APPROX_QUANTILES(resolution_sec,2)[OFFSET(1)]/3600,1) ttr_med_hr,
            SUM(msgs_in) msgs_in, SUM(msgs_bot) msgs_bot, SUM(msgs_human) msgs_human
          FROM {T} WHERE {rng}
        """)[0]
        agents = q(f"""
          SELECT COALESCE(assignee_name,'(unassigned)') agent, COUNT(*) convs,
            COUNTIF(had_human) handled, COUNTIF(status='resolved') resolved,
            ROUND(APPROX_QUANTILES(first_human_response_sec,2)[OFFSET(1)]/60,1) frt_med_min,
            ROUND(APPROX_QUANTILES(resolution_sec,2)[OFFSET(1)]/3600,1) ttr_med_hr,
            SUM(msgs_human) msgs_human
          FROM {T} WHERE {rng} GROUP BY agent ORDER BY convs DESC
        """)
        daily = q(f"""
          SELECT DATE(created_at) d, COUNT(*) convs,
            COUNTIF(had_human) human, COUNTIF(bot_handled_only) bot
          FROM {T} WHERE {rng} GROUP BY d ORDER BY d
        """)
    except Exception as e:
        return jsonify(error=str(e)), 500

    def num(v):
        return None if v is None else (float(v) if isinstance(v, float) else v)
    summary = {k: num(s[k]) for k in s.keys()}
    return jsonify(
        d_from=d_from, d_to=d_to, summary=summary,
        agents=[{"agent": a["agent"], "convs": a["convs"], "handled": a["handled"],
                 "resolved": a["resolved"], "frt_med_min": num(a["frt_med_min"]),
                 "ttr_med_hr": num(a["ttr_med_hr"]), "msgs_human": a["msgs_human"]}
                for a in agents],
        daily=[{"date": d["d"].isoformat(), "convs": d["convs"],
                "human": d["human"], "bot": d["bot"]} for d in daily],
    )


@app.route("/limechat/sync", methods=["GET", "POST"])
def limechat_sync():
    if SYNC_TOKEN:
        supplied = request.headers.get("X-Sync-Token") or request.args.get("token")
        if supplied != SYNC_TOKEN:
            abort(401)
    kwargs = {}
    if request.args.get("max_pages"):
        kwargs["max_pages"] = int(request.args["max_pages"])
    if request.args.get("enrich_days") is not None:
        kwargs["enrich_days"] = int(request.args.get("enrich_days"))
    if request.args.get("statuses"):
        kwargs["statuses"] = tuple(request.args["statuses"].split(","))
    try:
        return jsonify(sync_limechat(**kwargs))
    except Exception as e:
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
