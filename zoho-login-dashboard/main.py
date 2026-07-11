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
import json
import secrets
import datetime as dt

import requests
from flask import (
    Flask, request, redirect, session, url_for,
    render_template, jsonify, abort,
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
    today = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)).date()
    return (today - dt.timedelta(days=59)).isoformat(), today.isoformat()


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


def _gemini_insights(rows, d_from, d_to):
    """Summarize the login/activity data and ask Gemini for manager insights."""
    import vertexai
    from vertexai.generative_models import GenerativeModel

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

    prompt = f"""You are a data analyst for Lucira Jewelry (lucirajewelry.com), an Indian
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
{summary}

Give a concise, manager-ready briefing in Markdown with these sections:
### Headline (2-3 bullets)
### Most & least engaged agents
### Activity vs. outcomes (do high-call/high-login agents create & win more deals?)
### Store vs. individual agent patterns
### Anomalies or things to check
### 3 concrete recommendations
Keep it tight and specific to the numbers. Do not invent data you weren't given."""

    vertexai.init(project=PROJECT, location=VERTEX_LOCATION)
    model = GenerativeModel(GEMINI_MODEL)
    resp = model.generate_content(prompt)
    return resp.text


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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
