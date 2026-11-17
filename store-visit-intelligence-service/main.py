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
is built on the 30-minute Zoho CDC tables + Lucira_Prod.customer_walkin + marketing_sale. The
result (~550 meetings) is cached in-process for CACHE_TTL_SEC so the ~240 MB view
scan runs at most once per TTL, not once per page view. No Zoho credentials are
used or needed by this service -- it only reads BigQuery with its runtime SA.

Endpoints
    GET /                 dashboard
    GET /api/journey      {refreshed_at_ist, rows[], health[]}   (?refresh=1 to bypass cache)
    GET /api/health       source-health only (cheap)
    GET /health           liveness (unauthenticated)
    GET /<STORES>         dashboard opened on a store link, e.g. /MAL-PN1-N18 (store keys joined by "-")
    GET /api/me           who is logged in + the stores this login may see
    GET /access           store-access admin page (ONLY the admin login, data@lucirajewelry.com)
    GET/POST /api/access  the access list behind that page

Login (2026-11-12, user rule: "mail id se login, Google se connect, no password")
    AUTH_MODE=iap (production): Google sign-in through Cloud Run IAP, exactly like lucira-ai-analyst.
      Nobody types a password and the old shared Basic-Auth login no longer works. The email comes
      from IAP's signed token (x-goog-iap-jwt-assertion), verified against Google's IAP keys -- a
      typed or forged email never gets in. What the email may see comes from the access list:
        data@lucirajewelry.com (ACCESS_ADMIN_EMAIL)  every store + the /access page
        email with stores in the list                ONLY those stores (filtered on the server)
        every other signed-in email                  the full dashboard, every store (user rule
                                                     2026-11-12: "sab mail ko 5 tab dikhna chahiye,
                                                     sirf jis mail ko store diya use wahi store")
    AUTH_MODE unset (local runs / rollback): the earlier HTTP Basic Auth logins below.

STORE LINKS -- what is LIVE (user decision 2026-11-12, final)
    Only the password login (DASH_USER / DASH_PASS) signs in and sees every store. That person picks
    stores in the Store filter and presses "Copy store link": the link is /MAL-PN1-N18?k=<signature>.
    Whoever opens that link needs NO login and gets ONLY those stores: the signature (HMAC of the
    store list, keyed by DASH_PASS) is checked on the server and every /api/* payload is cut down
    to those stores, so the viewer cannot change the stores (a changed address has a wrong
    signature) and the page shows them no Store filter. Changing DASH_PASS cancels every link.
    The page sends the link on its API calls in the X-Store-Link header ("<stores>.<signature>").

Store access by email (built 2026-11-12, switched OFF -- needs ACCESS_ADMIN_PASS / AUTH_MODE=iap)
    Three kinds of login in Basic-Auth mode:
      full   DASH_USER / DASH_PASS (the shared team login) -- every store, as before
      admin  ACCESS_ADMIN_EMAIL / ACCESS_ADMIN_PASS -- every store + may edit the access list
      store  an email from the access list + its own password -- ONLY its stores. Every /api/*
             payload is cut down to those stores on the SERVER, so changing the URL or calling
             the API by hand never shows another store.
    The access list (email -> stores, password hash) lives in the BigQuery table ACCESS_TABLE
    (or the JSON file ACCESS_FILE for local runs).
"""
import os
import re
import gzip
import hmac
import json
import time
import base64
import hashlib
import secrets
import threading
import datetime as dt

from flask import Flask, request, Response, send_from_directory, g, redirect
from google.cloud import bigquery

HERE = os.path.dirname(os.path.abspath(__file__))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

BQ_PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
JOURNEY_VIEW = os.environ.get("JOURNEY_VIEW", "lucirajewelry-prod.ds_imputed_reporting.zoho_meeting_journey_v")
FUNNEL_VIEW = os.environ.get("FUNNEL_VIEW", "lucirajewelry-prod.ds_imputed_reporting.zoho_deal_store_funnel_v")
CACHE_TTL_SEC = int(os.environ.get("CACHE_TTL_SEC", "600"))
MIN_FORCE_REFRESH_SEC = 60

app = Flask(__name__, static_folder=None)

DASH_USER = os.environ.get("DASH_USER", "")
DASH_PASS = os.environ.get("DASH_PASS", "")
_AUTH_EXEMPT = frozenset(("/health", "/journey.js"))     # journey.js is code only, no data


# ---------------------------------------------------------------------------------------------
# Store access list: email -> stores it may see (user request 2026-11-12)
# ---------------------------------------------------------------------------------------------
ACCESS_ADMIN_EMAIL = os.environ.get("ACCESS_ADMIN_EMAIL", "data@lucirajewelry.com").strip().lower()
ACCESS_ADMIN_PASS = os.environ.get("ACCESS_ADMIN_PASS", "")
ACCESS_TABLE = os.environ.get("ACCESS_TABLE", "lucirajewelry-prod.ds_imputed_reporting.store_visit_access")
ACCESS_FILE = os.environ.get("ACCESS_FILE", "")          # local runs / tests: a JSON file instead of BigQuery
ACCESS_TTL_SEC = 60
AUTH_MODE = os.environ.get("AUTH_MODE", "").lower()      # "iap" = Google sign-in (Cloud Run IAP)
IAP_AUDIENCE = os.environ.get("IAP_AUDIENCE", "")        # optional extra check of the token audience
IAP_CERTS = "https://www.gstatic.com/iap/verify/public_key"
ALL_STORES = "ALL"                                       # access-list value: every store
_iap_cache = {}                                          # jwt -> (email, expiry)
_ADMIN_PATHS = frozenset(("/access", "/api/access"))
_EMAIL_RE = re.compile(r"^[^@\s:]+@[^@\s:]+\.[a-z]{2,}$")
_STORE_PATH_RE = re.compile(r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
# Stores offered on the access page even before they have a meeting (label = the views' label).
DEFAULT_STORES = {"BO1": "BO1 - Borivali", "CS1": "CS1 - Chembur", "FCS": "FCS - FCS (Chembur address)",
                  "PN1": "PN1 - Pune", "N18": "N18 - Noida", "PV1": "PV1 - Paschim", "LPN": "LPN - Lajpat",
                  "MAL": "MAL - Malleshwaram"}


def _verify_iap(token):
    """Verified email of an IAP token, else None (same check as lucira-ai-analyst identity.py)."""
    if not token:
        return None
    hit = _iap_cache.get(token)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        from google.auth.transport import requests as greq
        from google.oauth2 import id_token
        claims = id_token.verify_token(token, greq.Request(), audience=IAP_AUDIENCE or None, certs_url=IAP_CERTS)
        if claims.get("iss") != "https://cloud.google.com/iap":
            return None
        email = (claims.get("email") or "").strip().lower()
        if not email:
            return None
        if len(_iap_cache) > 2000:
            _iap_cache.clear()
        _iap_cache[token] = (email, min(claims.get("exp", time.time() + 300), time.time() + 3600))
        return email
    except Exception:  # noqa: BLE001 -- any verification failure = not signed in
        return None


def _slug(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _store_key(code, label, blank="NOTCAPTURED"):
    """URL / access key of a store: its code (MAL), else the label without spaces and symbols
    (Hyderabad Kondapur -> HYDERABADKONDAPUR). Same rule as storeKeyOf() in journey.js."""
    return _slug(code) or _slug(label) or blank


_acc = {"at": 0.0, "users": {}}
_acc_lock = threading.Lock()
_pw_ok = {}          # (email, pass_hash) -> sha256 of the password that verified (skips PBKDF2 per request)


def _hash_password(pw, salt=None, rounds=120000):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, rounds)
    return f"pbkdf2${rounds}${salt.hex()}${h.hex()}"


def _check_password(email, pw, stored):
    quick = hashlib.sha256(pw.encode("utf-8")).digest()
    if hmac.compare_digest(_pw_ok.get((email, stored), b""), quick):
        return True
    try:
        _, rounds, salt, _h = stored.split("$")
        ok = hmac.compare_digest(_hash_password(pw, bytes.fromhex(salt), int(rounds)), stored)
    except Exception:  # noqa: BLE001 -- malformed hash = no login
        return False
    if ok:
        _pw_ok[(email, stored)] = quick
    return ok


def _access_read():
    if ACCESS_FILE:
        if not os.path.exists(ACCESS_FILE):
            return {}
        with open(ACCESS_FILE, encoding="utf-8") as f:
            return json.load(f)
    from google.api_core.exceptions import NotFound
    try:
        rows = list(_client().query(
            f"SELECT email, stores, pass_hash, updated_at FROM `{ACCESS_TABLE}`").result())
    except NotFound:                     # table is created on the first save
        return {}
    return {r["email"]: {"stores": [k for k in (r["stores"] or "").split("-") if k],
                         "pass_hash": r["pass_hash"] or "",
                         "updated_at": _ist(r["updated_at"])} for r in rows}


def _access_users(force=False):
    """email -> {stores, pass_hash, updated_at}. Re-read at most once a minute; if the read fails the
    last good list keeps working (an unknown email is simply not let in)."""
    with _acc_lock:
        if force or time.time() - _acc["at"] > ACCESS_TTL_SEC:
            try:
                _acc["users"] = _access_read()
            except Exception:  # noqa: BLE001
                if force:
                    raise
            _acc["at"] = time.time()
        return _acc["users"]


def _access_write(users):
    now = dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S")
    for e, u in users.items():
        u.setdefault("updated_at", now)
    if ACCESS_FILE:
        with open(ACCESS_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=1)
    else:
        schema = [bigquery.SchemaField("email", "STRING"), bigquery.SchemaField("stores", "STRING"),
                  bigquery.SchemaField("pass_hash", "STRING"), bigquery.SchemaField("updated_at", "TIMESTAMP")]
        rows = [{"email": e, "stores": "-".join(u["stores"]), "pass_hash": u["pass_hash"],
                 "updated_at": u["updated_at"] + "+05:30"} for e, u in users.items()]
        if rows:      # whole (small) list replaced in one load job: no streaming buffer, no partial state
            _client().load_table_from_json(rows, ACCESS_TABLE, job_config=bigquery.LoadJobConfig(
                schema=schema, write_disposition="WRITE_TRUNCATE")).result()
        else:
            _client().create_table(bigquery.Table(ACCESS_TABLE, schema=schema), exists_ok=True)
            _client().query(f"TRUNCATE TABLE `{ACCESS_TABLE}`").result()
    with _acc_lock:
        _acc["at"] = 0.0                 # next request re-reads


def _link_sig(slug):
    """Signature of a store link. Keyed by the login password, so a new password cancels all links."""
    key = hashlib.sha256(("store-link|" + DASH_PASS).encode("utf-8")).digest()
    return base64.urlsafe_b64encode(hmac.new(key, slug.encode("utf-8"), hashlib.sha256).digest()).decode().rstrip("=")[:22]


def _link_stores():
    """Stores of a valid signed store link on this request, else None. Page: /MAL-PN1?k=sig;
    API calls: header X-Store-Link: MAL-PN1.sig."""
    if not DASH_PASS:
        return None
    if request.path.startswith("/api/"):
        slug, _, sig = (request.headers.get("X-Store-Link") or "").partition(".")
    else:
        slug, sig = request.path.strip("/"), request.args.get("k") or ""
    if not (slug and sig and _STORE_PATH_RE.match(slug) and slug == slug.upper()):
        return None
    return slug.split("-") if hmac.compare_digest(_link_sig(slug), sig) else None


def _challenge(realm="Store Visit Intelligence", msg="Authentication required."):
    return Response(msg, 401, {"WWW-Authenticate": f'Basic realm="{realm}"'})


@app.before_request
def _require_login():
    g.role, g.email, g.stores = "full", None, None
    if request.path in _AUTH_EXEMPT:
        return None
    if AUTH_MODE == "iap":
        # Google sign-in: the email is whatever Google / IAP verified -- nothing is typed here
        email = _verify_iap(request.headers.get("x-goog-iap-jwt-assertion"))
        if not email:
            return Response("Google sign-in required.", 401)
        g.email = email
        if email == ACCESS_ADMIN_EMAIL:
            g.role = "admin"
        else:
            # not in the list = the full dashboard; in the list = only its stores
            stores = (_access_users().get(email) or {}).get("stores") or []
            if stores and ALL_STORES not in stores:
                g.role, g.stores = "store", list(stores)
        if request.path in _ADMIN_PATHS and g.role != "admin":
            return Response(f"Only {ACCESS_ADMIN_EMAIL} may open this page.", 403)
        return None
    auth = request.authorization
    user = ((auth.username if auth else "") or "").strip()
    pw = (auth.password if auth else "") or ""
    email = user.lower()
    if not (DASH_USER and DASH_PASS):
        pass                                          # gate off (local run): full access, no admin
    elif hmac.compare_digest(user, DASH_USER) and hmac.compare_digest(pw, DASH_PASS):
        pass                                          # shared team login: every store
    elif ACCESS_ADMIN_PASS and email == ACCESS_ADMIN_EMAIL and hmac.compare_digest(pw, ACCESS_ADMIN_PASS):
        g.role, g.email = "admin", email
    elif _link_stores():
        g.role, g.stores = "store", _link_stores()    # signed store link: no login, only its stores
    else:
        # the email access list is only looked at when the admin login is switched on (ACCESS_ADMIN_PASS)
        u = _access_users().get(email) if (ACCESS_ADMIN_PASS and email and pw) else None
        if not (u and u.get("stores") and u.get("pass_hash") and _check_password(email, pw, u["pass_hash"])):
            return _challenge()
        g.email = email
        if ALL_STORES not in u["stores"]:
            g.role, g.stores = "store", list(u["stores"])
    # USER RULE 2026-11-12: a dashboard opened on a store address (/MAL-LPN-BO1) is LOCKED to those
    # stores even for someone who signed in with the password -- the page sends the address it was
    # opened on with every API call (X-Store-Lock) and gets only those stores, with no Store filter.
    # (Not a security wall for a password holder -- they can still open "/"; the signed ?k= link is.)
    if (g.stores is None and request.path.startswith("/api/")
            and request.path not in _ADMIN_PATHS and request.path != "/api/store-link"):
        lock = (request.headers.get("X-Store-Lock") or "").upper()
        if lock and _STORE_PATH_RE.match(lock):
            g.role, g.stores = "store", lock.split("-")
    if request.path in _ADMIN_PATHS and g.role != "admin":
        if not ACCESS_ADMIN_PASS:
            return Response("Store access admin is not switched on: set the ACCESS_ADMIN_PASS env var.", 503)
        return _challenge("Store Visit Access Admin", f"Only {ACCESS_ADMIN_EMAIL} may open this page.")
    return None


def _scope(payload, kind):
    """A store login gets only its stores' rows -- filtered here, on the server, for every API."""
    if g.stores is None:
        return payload
    ok = set(g.stores)
    p = dict(payload)
    if kind == "journey":
        p["rows"] = [r for r in p.get("rows", []) if _store_key(r.get("meeting_store_code"), r.get("store")) in ok]
    elif kind == "funnel":
        key = {r["deal_id"]: _store_key(r.get("store_code"), r.get("store"), "NONSTORECITY") for r in p.get("rows", [])}
        p["rows"] = [r for r in p.get("rows", []) if key[r["deal_id"]] in ok]
        p["meetings"] = [m for m in p.get("meetings", [])
                         if (_slug(m.get("venue_store")) or key.get(m.get("deal_id"), "NONSTORECITY")) in ok]
    elif kind == "dims":
        i, j = DEAL_DIM_COLUMNS.index("store_code"), DEAL_DIM_COLUMNS.index("store")
        p["rows"] = [a for a in p.get("rows", []) if _store_key(a[i], a[j], "NONSTORECITY") in ok]
    elif kind == "walkins":
        i = ALL_WALKIN_COLUMNS.index("store_code")
        p["rows"] = [a for a in p.get("rows", []) if _store_key(a[i], None) in ok]
    elif kind == "outcomes":
        p["schemes"] = [x for x in p.get("schemes", []) if _slug(x.get("store_code")) in ok]
        p["share_case"] = []             # the sheet has free-text stores; not used by the page any more
    return p


# Explicit column list (no SELECT *): exactly what the dashboard renders.
JOURNEY_COLUMNS = [
    "meeting_id", "meeting_title", "meeting_created_ist", "meeting_created_date", "from_date", "from_ist",
    "all_day", "meeting_status", "meeting_type", "meeting_type_norm", "meeting_location", "venue", "zoho_store_name", "store_source", "meeting_store_code", "store",
    "meeting_owner", "meeting_created_by", "meeting_description", "show_status", "conversion_status", "related_module",
    "customer_name", "mobile", "mobile_source", "email", "contact_id",
    "deal_id", "deal_name", "deal_stage", "deal_trigger", "probability", "deal_city", "deal_state",
    "jc", "jc_source", "lead_source", "campaign_source", "utm_source", "utm_medium", "utm_campaign",
    "deal_store_assigned", "deal_record_type", "intent_stage", "deal_amount", "closing_date", "deal_created_ist",
    "calls_after", "connected_calls", "missed_calls", "first_call_ist", "last_call_ist", "first_connected_ist",
    "talk_time_sec",
    "prev_walkin", "prev_walkin_ist", "prev_walkin_store_code",
    "walkins_after", "first_walkin_ist", "first_walkin_store_code", "days_to_walkin", "walked_in", "walkin_evidence",
    "sales_after", "sales_amount_after", "first_sale_ist", "first_sale_amount", "first_sale_store_code",
    "first_sale_channel", "first_sale_skus", "days_to_sale",
    "customer_pincode", "customer_pincode_source", "km_store_code", "km_store_rule", "km_to_store", "km_basis", "within_5km",
    "journey_status", "calls", "walkins", "sales",
]

# Source health: cheap metadata / narrow-column reads only.
#   CDC tables: MAX(synced_at) = when the 30-min Zoho sync last wrote; MAX(created_time) = newest record.
#   Walk-in / Sales: table last-modified + newest record timestamp (IST).
HEALTH_SQL = """
WITH t AS (
  SELECT table_id, TIMESTAMP_MILLIS(last_modified_time) AS last_modified
  FROM `lucirajewelry-prod.ds_imputed_reporting.__TABLES__`
  WHERE table_id = 'marketing_sale'
  UNION ALL
  SELECT table_id, TIMESTAMP_MILLIS(last_modified_time)
  FROM `lucirajewelry-prod.Lucira_Prod.__TABLES__`
  WHERE table_id = 'customer_walkin'
)
SELECT 'Zoho Meetings' AS source, 'zoho_crm.cdc_meetings' AS tbl, MAX(synced_at) AS last_sync, MAX(created_time) AS latest_record, COUNT(*) AS n
  FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
UNION ALL
SELECT 'Zoho Deals', 'zoho_crm.cdc_deals', MAX(synced_at), MAX(created_time), COUNT(*) FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
UNION ALL
SELECT 'Zoho Calls', 'zoho_crm.cdc_calls', MAX(synced_at), MAX(created_time), COUNT(*) FROM `lucirajewelry-prod.zoho_crm.cdc_calls`
UNION ALL
SELECT 'Walk-in', 'Lucira_Prod.customer_walkin',
  (SELECT last_modified FROM t WHERE table_id = 'customer_walkin'),
  MAX(TIMESTAMP(IF(visit_type = 3, DATETIME_SUB(date, INTERVAL 330 MINUTE), date), 'Asia/Kolkata')),
  COUNT(*)
  FROM `lucirajewelry-prod.Lucira_Prod.customer_walkin`
UNION ALL
SELECT 'Sales', 'ds_imputed_reporting.marketing_sale',
  (SELECT last_modified FROM t WHERE table_id = 'marketing_sale'),
  TIMESTAMP(MAX(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date)), 'Asia/Kolkata'),
  COUNT(DISTINCT document_no)
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
"""
# How old a source's last write may be before it is flagged STALE.
STALE_AFTER_MIN = {"Zoho Meetings": 90, "Zoho Deals": 90, "Zoho Calls": 90, "Walk-in": 180, "Sales": 36 * 60}
CADENCE = {"Zoho Meetings": "CDC sync every 30 min", "Zoho Deals": "CDC sync every 30 min",
           "Zoho Calls": "CDC sync every 30 min", "Walk-in": "hourly load (:30 past each hour)",
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


# Zoho meeting "Pincode" field: typed by the agent from what the customer said (filled from ~29 Sep
# 2026; ~45% of Nov meetings). It is the customer's real pincode (145 different values on 223
# meetings -- not a city placeholder like the Deal / Contact zip), so it is the FIRST pincode source for
# the 7 km columns; the customer-record pincode of the view is the fallback. Real India Post pincodes only.
ZOHO_MEETING_PIN_SQL = r"""
SELECT id AS meeting_id,
       JSON_VALUE(data, '$.What_Id.id') AS deal_id,
       RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Mobile_Number'), ''), r'\D', ''), 10) AS mobile,
       TRIM(JSON_VALUE(data, '$.Pincode')) AS pin,
       TIMESTAMP(JSON_VALUE(data, '$.Created_Time')) AS created_ts
FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
WHERE REGEXP_CONTAINS(IFNULL(JSON_VALUE(data, '$.Pincode'), ''), r'^\s*[1-9][0-9]{5}\s*$')
  AND TRIM(JSON_VALUE(data, '$.Pincode')) IN (SELECT CAST(pincode AS STRING) FROM `lucirajewelry-prod.ds_imputed_reporting.pincode_geo_lookup`)
"""


def add_zoho_meeting_pins(rows):
    """zoho_pincode = this meeting's own Zoho Pincode, else the latest Zoho Pincode on any other meeting
    of the same customer (mobile). Never fails the journey load."""
    try:
        by_id, by_mob = {}, {}
        for r in _client().query(ZOHO_MEETING_PIN_SQL).result():
            by_id[r["meeting_id"]] = r["pin"]
            m = r["mobile"]
            if m and len(m) == 10 and (m not in by_mob or r["created_ts"] > by_mob[m][1]):
                by_mob[m] = (r["pin"], r["created_ts"])
    except Exception:  # noqa: BLE001
        return rows
    for row in rows:
        own = by_id.get(row.get("meeting_id"))
        if own:
            row["zoho_pincode"], row["zoho_pincode_source"] = own, "Zoho meeting Pincode"
        elif row.get("mobile") in by_mob:
            row["zoho_pincode"], row["zoho_pincode_source"] = by_mob[row["mobile"]][0], "Zoho Pincode (customer's other meeting)"
    return rows


# Deal "Probability %" = Zoho field Probability_Score (60/70/80/90/100/0) -- CDC JSON, else the one-time
# backfill table. The view's `probability` is the stage Probability field, which is blank on every deal,
# so it is overwritten here (no view change needed).
PROB_SCORE_SQL = r"""
SELECT d.id AS deal_id,
       COALESCE(SAFE_CAST(SAFE_CAST(JSON_VALUE(d.data, '$.Probability_Score') AS FLOAT64) AS INT64),
                SAFE_CAST(p.probability_score AS INT64)) AS score
FROM `lucirajewelry-prod.zoho_crm.cdc_deals` d
LEFT JOIN (SELECT id, ARRAY_AGG(probability_score ORDER BY pulled_at DESC LIMIT 1)[OFFSET(0)] AS probability_score
           FROM `lucirajewelry-prod.zoho_crm.deals_probability_score_patch` GROUP BY id) p ON p.id = d.id
"""


def add_probability_scores(rows):
    try:
        score = {r["deal_id"]: r["score"] for r in _client().query(PROB_SCORE_SQL).result() if r["score"] is not None}
    except Exception:  # noqa: BLE001
        return rows
    for row in rows:
        row["probability"] = score.get(row.get("deal_id"))
    return rows


# USER RULE 2026-11-03 (later): the pincode for the 7 km columns is ONLY the Zoho Deal field
# "Address - Zip / Postal Code" (Address_Zip_Postal_Code) -- the same column the team sees in the Zoho
# Deals export. A meeting uses the zip of its own deal, else the latest deal of the same mobile that has
# one. Digits only; anything that is not a 6-digit pincode (e.g. "20101", "M5A") = no pincode.
# The Zoho meeting Pincode / customer-record pincode are still loaded, but only shown for reference.
DEAL_ZIP_SQL = r"""
SELECT id AS deal_id,
       RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Mobile'), ''), r'\D', ''), 10) AS mobile,
       REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Address_Zip_Postal_Code'), ''), r'\D', '') AS zip,
       TIMESTAMP(JSON_VALUE(data, '$.Created_Time')) AS created_ts
FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
WHERE REGEXP_CONTAINS(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Address_Zip_Postal_Code'), ''), r'\D', ''), r'^[1-9][0-9]{5}$')
"""


def add_deal_zips(rows):
    """deal_zip = Zoho Deal Address - Zip / Postal Code of the meeting's deal, else of the customer's
    latest deal (same mobile) that has one. Never fails the journey load."""
    try:
        by_id, by_mob = {}, {}
        for r in _client().query(DEAL_ZIP_SQL).result():
            by_id[r["deal_id"]] = r["zip"]
            m = r["mobile"]
            if m and len(m) == 10 and (m not in by_mob or r["created_ts"] > by_mob[m][1]):
                by_mob[m] = (r["zip"], r["created_ts"])
    except Exception:  # noqa: BLE001
        return rows
    for row in rows:
        own = by_id.get(row.get("deal_id"))
        if own:
            row["deal_zip"], row["deal_zip_source"] = own, "Zoho Deal Address - Zip / Postal Code"
        elif row.get("mobile") in by_mob:
            row["deal_zip"], row["deal_zip_source"] = by_mob[row["mobile"]][0], "Zoho Deal Zip (customer's other deal)"
    return rows


# USER RULE 2026-11-04: the customer pincode comes from the Zoho CONTACT first -- the pincode in the
# contact's full Mailing Address (a 6-digit pincode typed in the Flat / Street text, else the Mailing
# Zip) -- and only when the contact has none, from the Deal zip above. Street text that is a Lucira
# store's own address (agents paste it: Sky City Mall Borivali, A/59A Lajpat Nagar, Sai Square Pune)
# is skipped -- that pincode is the store's, not the customer's. Zoho's separate "Full Address" text
# field exists only on Deals / Leads (not Contacts) and is not in the CDC feed; in the old export it
# was just "City, State, Zip, IN", i.e. the same zip.
CONTACT_PIN_SQL = r"""
WITH c AS (
  SELECT id AS contact_id,
         RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Mobile'), ''), r'\D', ''), 10) AS mobile,
         TIMESTAMP(JSON_VALUE(data, '$.Modified_Time')) AS mod_ts,
         CONCAT(IFNULL(JSON_VALUE(data, '$.Mailing_Flat_House_No_Building_Apartment_Name'), ''), ' ',
                IFNULL(JSON_VALUE(data, '$.Mailing_Street'), '')) AS addr,
         REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Mailing_Zip'), ''), r'\D', '') AS zip
  FROM `lucirajewelry-prod.zoho_crm.cdc_contacts`
), p AS (
  SELECT contact_id, mobile, mod_ts,
         IF(REGEXP_CONTAINS(LOWER(addr), r'sky city mall|a/59a|sai square|jangali maharaj'), NULL,
            REGEXP_REPLACE(REGEXP_EXTRACT(addr, r'(?:^|\D)([1-9][0-9]{2} ?[0-9]{3})(?:\D|$)'), r' ', '')) AS addr_pin,
         IF(REGEXP_CONTAINS(zip, r'^[1-9][0-9]{5}$'), zip, NULL) AS zip_pin
  FROM c
)
SELECT contact_id, mobile, mod_ts, COALESCE(addr_pin, zip_pin) AS pin,
       IF(addr_pin IS NOT NULL, 'address text', 'Mailing Zip') AS part
FROM p WHERE COALESCE(addr_pin, zip_pin) IS NOT NULL
"""


def add_contact_pins(rows):
    """contact_pin = pincode of the meeting's Zoho Contact (Who_Id, else the deal's contact), else of the
    latest-modified contact with the same mobile. Never fails the journey load."""
    try:
        by_id, by_mob = {}, {}
        for r in _client().query(CONTACT_PIN_SQL).result():
            by_id[r["contact_id"]] = (r["pin"], r["part"])
            m = r["mobile"]
            if m and len(m) == 10 and r["mod_ts"] and (m not in by_mob or r["mod_ts"] > by_mob[m][2]):
                by_mob[m] = (r["pin"], r["part"], r["mod_ts"])
    except Exception:  # noqa: BLE001
        return rows
    for row in rows:
        own = by_id.get(row.get("contact_id"))
        if own:
            row["contact_pin"], row["contact_pin_source"] = own[0], f"Zoho Contact address ({own[1]})"
        elif row.get("mobile") in by_mob:
            o = by_mob[row["mobile"]]
            row["contact_pin"], row["contact_pin_source"] = o[0], f"Zoho Contact address, same mobile ({o[1]})"
    return rows


# Reschedule / cancel inputs (user request 2026-11-11). Zoho has NO "Rescheduled" or "Cancelled" value
# on meetings (Show_Status = Show / No Show, Meeting_Status = Open / WIP / Closed), so journey.js
# derives both from these agent-set meeting fields: Connection_Status (Connected / Not Connected =
# did the agent reach the customer), Follow_Up (next date the agent set) and Meeting_Status.
MEETING_FOLLOWUP_SQL = r"""
SELECT id AS meeting_id,
       NULLIF(TRIM(JSON_VALUE(data, '$.Connection_Status')), '') AS connection_status,
       NULLIF(TRIM(JSON_VALUE(data, '$.Follow_Up')), '') AS follow_up,
       NULLIF(TRIM(JSON_VALUE(data, '$.Meeting_Status')), '') AS zoho_meeting_status,
       -- Zoho meeting picklist "Confirmation" (Confirmed / Not Confirmed / Not Connected), added in
       -- Zoho ~30 Oct 2026 and to the CDC field list on 2026-11-16 (user request: Confirmed KPI).
       -- NULL = not marked in Zoho (or the CDC row was synced before the field was added).
       NULLIF(TRIM(JSON_VALUE(data, '$.Confirmation')), '') AS confirmation
FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`
QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_time DESC) = 1
"""


def add_meeting_followups(rows):
    try:
        by_id = {r["meeting_id"]: r for r in _client().query(MEETING_FOLLOWUP_SQL).result()}
    except Exception:  # noqa: BLE001
        return rows
    for row in rows:
        r = by_id.get(row.get("meeting_id"))
        if r:
            row["connection_status"] = r["connection_status"]
            row["follow_up"] = r["follow_up"]
            row["zoho_meeting_status"] = r["zoho_meeting_status"]
            row["confirmation"] = r["confirmation"]
    return rows


# Sales of a meeting (USER RULES 2026-11-13) -- recomputed here from marketing_sale, replacing the
# view's sales columns (no view change needed):
#   1. Cancelled orders (Fullfillment = cancel_order) are never counted (booked-sales rule).
#   2. An order placed on the SAME IST day as the meeting was created counts even when it is a few
#      minutes BEFORE the creation time (e.g. online order 13:04, meeting raised 13:18). Orders of
#      earlier days still do not count.
#   3. One invoice maps to ONE meeting only. A customer with two meetings (From 5th and 8th) used to
#      show the same invoice on both rows. The invoice now goes to the meeting whose From Date is the
#      latest one on or before the sale day (the visit it belongs to); if every From Date is after the
#      sale, the earliest one; ties -> the meeting created last. Several different invoices of one
#      customer can still sit on one meeting (multi-invoice).
#   cats = the invoice split by product category (marketing_sale.type_name: Rings, Earrings, ...):
#          "Category|pieces|net_sale" joined by ';' -> feeds the "Sales by category" table (From Date tab).
MEETING_SALES_SQL = r"""
WITH l AS (
  SELECT document_no, IFNULL(NULLIF(TRIM(type_name), ''), 'Not Captured') AS cat,
         ANY_VALUE(RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1), r'\D', ''), 10)) AS mobile,
         MIN(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date)) AS ts,
         ANY_VALUE(company_code) AS store, ANY_VALUE(Channel) AS channel,
         SUM(net_sale) AS amount, SUM(IFNULL(pieces, 0)) AS qty,
         STRING_AGG(DISTINCT Full_sku, ', ') AS skus
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE COALESCE(Cus_mobile, mobile1) IS NOT NULL
    AND LOWER(TRIM(IFNULL(Fullfillment, ''))) != 'cancel_order'
  GROUP BY document_no, cat
)
SELECT document_no AS doc, ANY_VALUE(mobile) AS mobile,
       FORMAT_DATETIME('%Y-%m-%dT%H:%M:%S', MIN(ts)) AS ts,
       ANY_VALUE(store) AS store, ANY_VALUE(channel) AS channel,
       ROUND(SUM(amount), 2) AS amount, STRING_AGG(skus, ', ') AS skus,
       STRING_AGG(CONCAT(REPLACE(REPLACE(cat, '|', '/'), ';', ','), '|', CAST(qty AS STRING), '|',
                         CAST(ROUND(amount, 2) AS STRING)), ';' ORDER BY cat) AS cats
FROM l
GROUP BY document_no
"""


def _truthy(v):
    return v is True or v == "true"


def assign_sales(rows, docs):
    """Pure part of add_sales (testable): docs = [{doc, mobile, ts, store, channel, amount, skus}]."""
    by_mobile = {}
    for row in rows:
        row["sales"] = []
        if row.get("mobile") and row.get("meeting_created_ist"):
            by_mobile.setdefault(row["mobile"], []).append(row)
    for d in sorted(docs, key=lambda x: (x.get("ts") or "", x.get("doc") or "")):
        ts = d.get("ts")
        if not ts or not d.get("mobile"):
            continue
        day = ts[:10]
        cands = [m for m in by_mobile.get(d["mobile"], ()) if m["meeting_created_ist"][:10] <= day]
        if not cands:
            continue

        def fd(m):
            return m.get("from_date") or m["meeting_created_ist"][:10]

        on = [m for m in cands if fd(m) <= day]
        if on:
            best = max(on, key=lambda m: (fd(m), m["meeting_created_ist"]))
        else:
            first = min(fd(m) for m in cands)
            best = max((m for m in cands if fd(m) == first), key=lambda m: m["meeting_created_ist"])
        best["sales"].append({"doc": d["doc"], "ts": ts, "amount": float(d.get("amount") or 0),
                              "store": d.get("store"), "channel": d.get("channel"), "skus": d.get("skus"),
                              "cats": d.get("cats"),
                              "pre": ts < best["meeting_created_ist"]})
    for row in rows:
        s = row["sales"]
        first = s[0] if s else None
        row["sales_after"] = len(s)
        row["sales_amount_after"] = round(sum(x["amount"] for x in s), 2)
        row["first_sale_ist"] = first["ts"] if first else None
        row["first_sale_amount"] = first["amount"] if first else None
        row["first_sale_store_code"] = first["store"] if first else None
        row["first_sale_channel"] = first["channel"] if first else None
        row["first_sale_skus"] = first["skus"] if first else None
        row["days_to_sale"] = None
        if first and row.get("meeting_created_ist"):
            row["days_to_sale"] = (dt.date.fromisoformat(first["ts"][:10])
                                   - dt.date.fromisoformat(row["meeting_created_ist"][:10])).days
        st = row.get("journey_status")
        if _truthy(row.get("walked_in")):
            row["journey_status"] = "Walk-in - Sale" if s else "Walk-in - No Sale"
        elif st and st.startswith("Not Trackable"):
            pass
        elif s:
            row["journey_status"] = "Sale (No Walk-in)"
        elif (row.get("connected_calls") or 0) > 0:
            row["journey_status"] = "Connected"
        elif (row.get("calls_after") or 0) > 0:
            row["journey_status"] = "Called"
        else:
            row["journey_status"] = "No Activity"
    return rows


def add_sales(rows):
    try:
        docs = [dict(r) for r in _client().query(MEETING_SALES_SQL).result()]
    except Exception:  # noqa: BLE001  (keep the view's own sales columns)
        return rows
    return assign_sales(rows, docs)


def fetch_journey():
    # Only the columns the view has right now: a column added to JOURNEY_COLUMNS before the view is
    # re-created (e.g. email) is sent as null instead of failing the whole load.
    have = {f.name for f in _client().get_table(JOURNEY_VIEW).schema}
    cols = [k for k in JOURNEY_COLUMNS if k in have]
    sql = f"SELECT {', '.join(cols)} FROM `{JOURNEY_VIEW}` ORDER BY meeting_created_ist DESC"
    rows = [{k: (_jsonable(r[k]) if k in have else None) for k in JOURNEY_COLUMNS} for r in _client().query(sql).result()]
    return add_sales(add_meeting_followups(add_probability_scores(add_contact_pins(add_deal_zips(add_zoho_meeting_pins(rows))))))


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
                return _json(_scope(cached, "journey"))
            else:
                return _json(payload, 502)
        payload = dict(_cache["payload"])
    payload["cache_age_sec"] = round(time.time() - _cache["at"])
    return _json(_scope(payload, "journey"))


# Deals Funnel tab: 1 row per Zoho deal (sql/deal_store_funnel_view.sql). Separate cache so the
# meeting tabs never wait on it; the page only requests it when the Deals Funnel tab is opened.
FUNNEL_COLUMNS = [
    "deal_id", "deal_name", "created_ist", "created_date", "agent", "deal_stage", "customer_name", "mobile",
    "city", "city_source", "is_store_city", "store_city_group", "store_code", "store", "store_source",
    "calls_after", "connected_calls", "first_connected_ist",
    "store_visit_meetings", "first_sv_created_ist", "first_sv_date",
    "walkins_after", "first_walkin_ist", "walkin_store",
    "sales_after", "sales_amount_after", "first_sale_ist", "sale_docs",
    "schemes_after", "scheme_monthly_amount", "first_scheme_ist", "scheme_ids",
]
MEETINGS_VIEW = os.environ.get("MEETINGS_VIEW", "lucirajewelry-prod.ds_imputed_reporting.zoho_store_visit_meetings_v")
MEETING_COLUMNS = ["meeting_id", "meeting_title", "module", "deal_id", "created_by", "venue",
                   "created_ist", "created_date", "visit_date", "venue_store"]
_fcache = {"at": 0.0, "payload": None}
_flock = threading.Lock()


def build_funnel_payload():
    t0 = time.time()
    payload = {"refreshed_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"),
               "cache_ttl_sec": CACHE_TTL_SEC, "view": FUNNEL_VIEW}
    try:
        sql = f"SELECT {', '.join(FUNNEL_COLUMNS)} FROM `{FUNNEL_VIEW}`"
        payload["rows"] = [{k: _jsonable(r[k]) for k in FUNNEL_COLUMNS} for r in _client().query(sql).result()]
        # Store Visit = every Zoho meeting RAISED in the date range (counted in the browser by meeting date).
        msql = f"SELECT {', '.join(MEETING_COLUMNS)} FROM `{MEETINGS_VIEW}`"
        payload["meetings"] = [{k: _jsonable(r[k]) for k in MEETING_COLUMNS} for r in _client().query(msql).result()]
        payload["ok"] = True
    except Exception as e:  # noqa: BLE001
        payload["rows"], payload["ok"], payload["error"] = [], False, str(e)[:800]
    payload["elapsed_sec"] = round(time.time() - t0, 2)
    return payload


@app.route("/api/deal-funnel")
def api_deal_funnel():
    force = request.args.get("refresh") == "1"
    with _flock:
        age = time.time() - _fcache["at"]
        stale = _fcache["payload"] is None or age > CACHE_TTL_SEC
        if stale or (force and age > MIN_FORCE_REFRESH_SEC):
            payload = build_funnel_payload()
            if payload["ok"]:
                _fcache.update(at=time.time(), payload=payload)
            elif _fcache["payload"] is not None:
                cached = dict(_fcache["payload"])
                cached["refresh_error"] = payload["error"]
                cached["cache_age_sec"] = round(time.time() - _fcache["at"])
                return _json(_scope(cached, "funnel"))
            else:
                return _json(payload, 502)
        payload = dict(_fcache["payload"])
    payload["cache_age_sec"] = round(time.time() - _fcache["at"])
    return _json(_scope(payload, "funnel"))


# Total Deals / Store City Deals columns of the meeting tabs' "Analysis by dimension": the same
# deals as the Deals Funnel, but only the grouping fields, sent as arrays (~44k deals, ~0.2 MB
# gzipped vs ~39 MB raw for /api/deal-funnel), so the meeting tabs never load the full funnel.
DEAL_DIM_COLUMNS = ["created_date", "agent", "city_group", "deal_stage", "deal_trigger", "probability",
                    "lead_source", "utm_source", "is_store_city", "store_code", "store", "pin"]
# Store / store-city / owner come from the funnel view (its store rule); the other grouping fields
# are read from cdc_deals directly (1 row per deal id), so the view itself needs no extra columns.
# city_group = the view's store-city group (Address_City, else Contact Mailing_City, else the store
# of the deal's Zoho meeting), 'Other' for a city with no Lucira store, NULL when no city at all --
# so on the City breakdown a store-city row's Store City Deals always equals its Total Deals.
# Hyderabad (user 2026-11-03: a store is opening there) is a store city too: the view does not know it
# yet, so it is added here (same list as HYD_RE in journey.js) and those deals count as Store City Deals.
# pin = USER RULE 2026-11-04: the deal's Zoho Contact address pincode (CONTACT_PIN_SQL), else the
# deal's own Zoho "Address - Zip / Postal Code" (digits only, 6-digit pincodes; anything else = no
# pincode). No meeting / customer-record pincode.
HYD_RE = (r"\b(hyderabad|hydrabad|hyderbad|secunderabad|cyberabad|rangareddy|ranga reddy|medchal|malkajgiri|"
          r"gachibowli|kukatpally|madhapur|kondapur|hitech city|banjara hills|jubilee hills|ameerpet|begumpet|"
          r"miyapur|lb nagar|dilsukhnagar|kompally|manikonda|shamshabad)\b")
DEAL_DIMS_SQL = f"""
WITH v AS (
  SELECT *,
         v0.store_city_group IS NULL
           AND REGEXP_CONTAINS(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(IFNULL(v0.city, '')), r'[^a-z ]', ' '), r'\\s+', ' ')),
                               r'{HYD_RE}') AS is_hyd
  FROM `{FUNNEL_VIEW}` v0
)
SELECT v.created_date, v.agent,
       IF(v.is_hyd, 'Hyderabad', COALESCE(v.store_city_group, IF(v.city IS NOT NULL, 'Other', NULL))) AS city_group,
       v.deal_stage, d.deal_trigger, d.probability,
       d.lead_source, d.utm_source, (v.is_store_city OR v.is_hyd) AS is_store_city, v.store_code, v.store,
       -- pincode: the deal's Zoho Contact address first, else the deal's own zip (user rule 2026-11-04)
       COALESCE(cp.pin, IF(REGEXP_CONTAINS(d.zip, r'^[1-9][0-9]{{5}}$'), d.zip, NULL)) AS pin
FROM v
LEFT JOIN (
  SELECT id,
         JSON_VALUE(data, '$.Contact_Name.id')                 AS contact_id,
         REGEXP_REPLACE(IFNULL(JSON_VALUE(data, '$.Address_Zip_Postal_Code'), ''), r'\\D', '') AS zip,
         JSON_VALUE(data, '$.Deal_Trigger_Event')              AS deal_trigger,
         -- Probability % = Probability_Score (CDC, else backfill); the stage Probability is always blank
         COALESCE(SAFE_CAST(SAFE_CAST(JSON_VALUE(data, '$.Probability_Score') AS FLOAT64) AS INT64),
                  SAFE_CAST(ps.probability_score AS INT64))    AS probability,
         JSON_VALUE(data, '$.Lead_Source')                     AS lead_source,
         JSON_VALUE(data, '$.UTM_Source')                      AS utm_source
  FROM `lucirajewelry-prod.zoho_crm.cdc_deals`
  LEFT JOIN (SELECT id AS pid, ARRAY_AGG(probability_score ORDER BY pulled_at DESC LIMIT 1)[OFFSET(0)] AS probability_score
             FROM `lucirajewelry-prod.zoho_crm.deals_probability_score_patch` GROUP BY id) ps ON ps.pid = id) d ON d.id = v.deal_id
LEFT JOIN ({CONTACT_PIN_SQL}) cp ON cp.contact_id = d.contact_id
"""
_dcache = {"at": 0.0, "payload": None}
_dlock = threading.Lock()


def build_deal_dims_payload():
    t0 = time.time()
    payload = {"refreshed_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"),
               "cache_ttl_sec": CACHE_TTL_SEC, "view": FUNNEL_VIEW, "cols": DEAL_DIM_COLUMNS}
    try:
        payload["rows"] = [[_jsonable(r[k]) for k in DEAL_DIM_COLUMNS] for r in _client().query(DEAL_DIMS_SQL).result()]
        payload["ok"] = True
    except Exception as e:  # noqa: BLE001
        payload["rows"], payload["ok"], payload["error"] = [], False, str(e)[:800]
    payload["elapsed_sec"] = round(time.time() - t0, 2)
    return payload


@app.route("/api/deal-dims")
def api_deal_dims():
    force = request.args.get("refresh") == "1"
    with _dlock:
        age = time.time() - _dcache["at"]
        stale = _dcache["payload"] is None or age > CACHE_TTL_SEC
        if stale or (force and age > MIN_FORCE_REFRESH_SEC):
            payload = build_deal_dims_payload()
            if payload["ok"]:
                _dcache.update(at=time.time(), payload=payload)
            elif _dcache["payload"] is not None:
                cached = dict(_dcache["payload"])
                cached["refresh_error"] = payload["error"]
                cached["cache_age_sec"] = round(time.time() - _dcache["at"])
                return _json(_scope(cached, "dims"))
            else:
                return _json(payload, 502)
        payload = dict(_dcache["payload"])
    payload["cache_age_sec"] = round(time.time() - _dcache["at"])
    return _json(_scope(payload, "dims"))


# EVERY store walk-in of the POS walk-in register (user 2026-11-10: "many visits not showing"). The
# meeting tabs count only MEETING-LED visits (a walk-in of a customer who had a Zoho meeting before it,
# or a Zoho meeting marked Show); 1-9 Nov 2026 that was 59 of the register's 426 walk-ins -- the rest
# are customers with no Zoho meeting (about 1 in 5 has a Zoho deal, the others are not in Zoho at all).
# This endpoint serves the whole register, 1 row per customer per IST day (first walk-in of the day
# gives time / store), so the browser can show and count the walk-ins WITHOUT a meeting next to the
# meeting-led ones; the browser drops every customer-day it already counts as a meeting-led visit.
#   deal_*    the customer's latest Zoho deal created before the walk-in (matched on mobile, else
#             email); deal_after = 1 when the only deal was created after the walk-in
#   sales     the customer's invoices (marketing_sale, per document_no, same rule as the view) dated on
#             or after the visit day, up to 120 days later -- the browser keeps those in the date filter
# Same time rule as the view: customer_walkin.date is IST wall-clock, legacy visit_type 3 rows 5:30 ahead.
ALL_WALKIN_COLUMNS = ["day", "ts", "store_code", "sources", "n_records", "name", "mobile", "email", "pin",
                      "deal_id", "deal_name", "deal_owner", "deal_stage", "deal_trigger", "deal_prob",
                      "deal_created_ist", "deal_after", "sales"]
ALL_WALKINS_SQL = r"""
WITH w0 AS (
  SELECT
    IF(REGEXP_CONTAINS(RIGHT(REGEXP_REPLACE(IFNULL(w.mobile, ''), r'\D', ''), 10), r'^[6-9][0-9]{9}$'),
       RIGHT(REGEXP_REPLACE(w.mobile, r'\D', ''), 10), NULL)                                   AS mobile,
    IF(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(w.email, ''))), r'^[^@\s]+@[^@\s]+\.[a-z]{2,}$')
       AND NOT REGEXP_CONTAINS(LOWER(TRIM(w.email)), r'^test@|@lucirajewelry\.com$'), LOWER(TRIM(w.email)), NULL) AS email,
    TIMESTAMP(IF(w.visit_type = 3, DATETIME_SUB(w.date, INTERVAL 330 MINUTE), w.date), 'Asia/Kolkata') AS ts,
    co.company_code                                                                           AS store_code,
    NULLIF(TRIM(w.source), '')                                                                AS source,
    w.customer_id,
    NULLIF(TRIM(CONCAT(IFNULL(w.first_name, ''), ' ', IFNULL(w.last_name, ''))), '')         AS name,
    IF(REGEXP_CONTAINS(CAST(w.pin_code AS STRING), r'^[1-9][0-9]{5}$'), CAST(w.pin_code AS STRING), NULL) AS pin
  FROM `lucirajewelry-prod.Lucira_Prod.customer_walkin` w
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.company` co ON co.company_id = w.company_id
  WHERE IFNULL(co.company_code, '') != 'HO' AND w.date IS NOT NULL
),
w AS (
  SELECT ckey, day,
    MIN(ts)                                                                    AS ts,
    ARRAY_AGG(store_code IGNORE NULLS ORDER BY ts LIMIT 1)[SAFE_OFFSET(0)]     AS store_code,
    STRING_AGG(DISTINCT source, ', ')                                          AS sources,
    COUNT(*)                                                                   AS n_records,
    ARRAY_AGG(name IGNORE NULLS ORDER BY ts LIMIT 1)[SAFE_OFFSET(0)]           AS name,
    MAX(mobile) AS mobile, MAX(email) AS email,
    ARRAY_AGG(pin IGNORE NULLS ORDER BY ts LIMIT 1)[SAFE_OFFSET(0)]            AS pin
  FROM (SELECT *, COALESCE(mobile, email, CONCAT('id:', CAST(customer_id AS STRING))) AS ckey,
               DATE(ts, 'Asia/Kolkata') AS day FROM w0)
  GROUP BY ckey, day
),
deals AS (
  SELECT d.id AS deal_id,
    JSON_VALUE(d.data, '$.Deal_Name')                    AS deal_name,
    JSON_VALUE(d.data, '$.Owner.name')                   AS owner,
    JSON_VALUE(d.data, '$.Stage')                        AS stage,
    JSON_VALUE(d.data, '$.Deal_Trigger_Event')           AS trig,
    COALESCE(SAFE_CAST(SAFE_CAST(JSON_VALUE(d.data, '$.Probability_Score') AS FLOAT64) AS INT64),
             SAFE_CAST(ps.probability_score AS INT64))   AS prob,
    TIMESTAMP(JSON_VALUE(d.data, '$.Created_Time'))      AS created_ts,
    RIGHT(REGEXP_REPLACE(IFNULL(JSON_VALUE(d.data, '$.Mobile'), ''), r'\D', ''), 10) AS dmob,
    NULLIF(LOWER(TRIM(JSON_VALUE(d.data, '$.Email'))), '') AS demail
  FROM `lucirajewelry-prod.zoho_crm.cdc_deals` d
  LEFT JOIN (SELECT id AS pid, ARRAY_AGG(probability_score ORDER BY pulled_at DESC LIMIT 1)[OFFSET(0)] AS probability_score
             FROM `lucirajewelry-prod.zoho_crm.deals_probability_score_patch` GROUP BY id) ps ON ps.pid = d.id
),
wdeal AS (
  -- mobile first, email only when the walk-in has no mobile match; equi-joins (no OR join)
  SELECT w.ckey, w.day, d.* FROM w JOIN deals d ON w.mobile IS NOT NULL AND d.dmob = w.mobile
  UNION ALL
  SELECT w.ckey, w.day, d.* FROM w JOIN deals d ON w.email IS NOT NULL AND d.demail = w.email
  WHERE w.mobile IS NULL OR w.mobile NOT IN (SELECT dmob FROM deals WHERE dmob IS NOT NULL)
),
dpick AS (
  SELECT w.ckey, w.day,
    ARRAY_AGG(IF(x.created_ts <= w.ts, x.deal_id, NULL) IGNORE NULLS ORDER BY x.created_ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS before_id,
    ARRAY_AGG(IF(x.created_ts >  w.ts, x.deal_id, NULL) IGNORE NULLS ORDER BY x.created_ts LIMIT 1)[SAFE_OFFSET(0)]      AS after_id
  FROM w JOIN wdeal x USING (ckey, day)
  GROUP BY w.ckey, w.day
),
sale_docs AS (
  SELECT document_no,
    ANY_VALUE(RIGHT(REGEXP_REPLACE(COALESCE(Cus_mobile, mobile1), r'\D', ''), 10))         AS mobile,
    MIN(TIMESTAMP(SAFE.PARSE_DATETIME('%d-%m-%Y %H:%M:%S', document_date), 'Asia/Kolkata')) AS sale_ts,
    ANY_VALUE(company_code) AS store_code, ANY_VALUE(Channel) AS channel, ROUND(SUM(net_sale), 2) AS amount
  FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
  WHERE COALESCE(Cus_mobile, mobile1) IS NOT NULL
    AND LOWER(TRIM(IFNULL(Fullfillment, ''))) != 'cancel_order'   -- cancelled orders never count (2026-11-13)
  GROUP BY document_no
),
wsale AS (
  SELECT w.ckey, w.day,
    ARRAY_AGG(STRUCT(s.document_no AS doc, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', s.sale_ts, 'Asia/Kolkata') AS ts,
                     s.amount, s.store_code AS store, s.channel) ORDER BY s.sale_ts) AS sales
  FROM w JOIN sale_docs s
    ON s.mobile = w.mobile
   AND DATE(s.sale_ts, 'Asia/Kolkata') BETWEEN w.day AND DATE_ADD(w.day, INTERVAL 120 DAY)
  GROUP BY w.ckey, w.day
)
SELECT w.day, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', w.ts, 'Asia/Kolkata') AS ts, w.store_code, w.sources, w.n_records,
  w.name, w.mobile, w.email, w.pin,
  d.deal_id, d.deal_name, d.owner AS deal_owner, d.stage AS deal_stage, d.trig AS deal_trigger, d.prob AS deal_prob,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', d.created_ts, 'Asia/Kolkata') AS deal_created_ist,
  IF(p.before_id IS NULL AND p.after_id IS NOT NULL, 1, 0) AS deal_after,
  ws.sales AS sales
FROM w
LEFT JOIN dpick p USING (ckey, day)
LEFT JOIN deals d ON d.deal_id = COALESCE(p.before_id, p.after_id)
LEFT JOIN wsale ws USING (ckey, day)
ORDER BY w.day, w.ts
"""
_wcache = {"at": 0.0, "payload": None}
_wlock = threading.Lock()


def build_all_walkins_payload():
    t0 = time.time()
    payload = {"refreshed_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"),
               "cache_ttl_sec": CACHE_TTL_SEC, "cols": ALL_WALKIN_COLUMNS}
    try:
        payload["rows"] = [[_jsonable(r[k]) for k in ALL_WALKIN_COLUMNS] for r in _client().query(ALL_WALKINS_SQL).result()]
        payload["ok"] = True
    except Exception as e:  # noqa: BLE001
        payload["rows"], payload["ok"], payload["error"] = [], False, str(e)[:800]
    payload["elapsed_sec"] = round(time.time() - t0, 2)
    return payload


@app.route("/api/all-walkins")
def api_all_walkins():
    force = request.args.get("refresh") == "1"
    with _wlock:
        age = time.time() - _wcache["at"]
        stale = _wcache["payload"] is None or age > CACHE_TTL_SEC
        if stale or (force and age > MIN_FORCE_REFRESH_SEC):
            payload = build_all_walkins_payload()
            if payload["ok"]:
                _wcache.update(at=time.time(), payload=payload)
            elif _wcache["payload"] is not None:
                cached = dict(_wcache["payload"])
                cached["refresh_error"] = payload["error"]
                cached["cache_age_sec"] = round(time.time() - _wcache["at"])
                return _json(_scope(cached, "walkins"))
            else:
                return _json(payload, 502)
        payload = dict(_wcache["payload"])
    payload["cache_age_sec"] = round(time.time() - _wcache["at"])
    return _json(_scope(payload, "walkins"))



# Meeting Journey Intelligence tab: extra per-customer evidence joined in the browser onto the
# meeting rows already served by /api/journey (same meetings, same call / walk-in / sale matching).
# Each source is aggregated on its own here -- never joined raw to meetings -- so nothing multiplies:
#   doc_lines   invoice -> number of item lines (SKUs) in marketing_sale
#   schemes     ERP scheme enrolments (not cancelled) -> customer mobile + IST timestamp
#   share_case  Google Sheet "Share Case" (first worksheet), rows with Status (column I) = Connected
SHARE_CASE_CSV_URL = os.environ.get(
    "SHARE_CASE_CSV_URL",
    "https://docs.google.com/spreadsheets/d/1cs5bnZe5t-x3JC7Cja3E6dlYztIsHysOvluOfsFX1Lc/export?format=csv&gid=0")
DOC_LINES_SQL = """
SELECT document_no, COUNT(DISTINCT item_line_no) AS lines
FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
WHERE COALESCE(Cus_mobile, mobile1) IS NOT NULL
GROUP BY document_no
"""
SCHEMES_SQL = """
SELECT s.scheme_enrollment_id AS id,
       RIGHT(REGEXP_REPLACE(IFNULL(p.mobile, ''), r'\\D', ''), 10) AS mobile,
       FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', s.creation_date, 'Asia/Kolkata') AS ts,
       co.company_code AS store_code, s.scheme_amount AS amount
FROM `lucirajewelry-prod.Pos.scheme_enrollment` s
JOIN (SELECT CAST(party_id AS INT64) AS party_id, ANY_VALUE(mobile) AS mobile
        FROM `lucirajewelry-prod.ornaverse_erp_master.party` GROUP BY 1) p ON p.party_id = s.party_id
LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.company` co ON co.company_id = s.company_id
WHERE NOT IFNULL(s.is_cancelled, FALSE)
"""
_ocache = {"at": 0.0, "payload": None}
_olock = threading.Lock()


def _sheet_date(s):
    """Share Case DATE column is DD/MM/YYYY (sometimes D/M/YY); anything else -> None."""
    import re
    m = re.match(r"^\s*(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\s*$", s or "")
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y = y + 2000 if y < 100 else y
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def fetch_share_case():
    import csv
    import io
    import re
    import urllib.request
    raw = urllib.request.urlopen(SHARE_CASE_CSV_URL, timeout=30).read().decode("utf-8")
    rows = list(csv.reader(io.StringIO(raw)))
    out, total = [], 0
    for r in rows[1:]:
        r = r + [""] * (10 - len(r))
        name, number, date, action, store, status = r[3], r[4], r[5], r[6], r[7], r[8]
        if not (name.strip() or number.strip()):
            continue
        total += 1
        if status.strip().lower() != "connected":          # column I = Status
            continue
        mob = re.sub(r"\D", "", number)[-10:]
        if not re.match(r"^[6-9]\d{9}$", mob):
            continue
        out.append({"mobile": mob, "date": _sheet_date(date), "store": store.strip(), "action": action.strip(),
                    "show": r[9].strip()})
    return out, total


def build_outcomes_payload():
    t0 = time.time()
    payload = {"refreshed_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"), "ok": True}
    try:
        payload["doc_lines"] = {r["document_no"]: r["lines"] for r in _client().query(DOC_LINES_SQL).result()}
        payload["schemes"] = [{k: _jsonable(r[k]) for k in ("id", "mobile", "ts", "store_code", "amount")}
                              for r in _client().query(SCHEMES_SQL).result()]
    except Exception as e:  # noqa: BLE001
        payload.update(ok=False, error=str(e)[:800])
    try:
        payload["share_case"], payload["share_case_rows"] = fetch_share_case()
    except Exception as e:  # noqa: BLE001 -- sheet down: tab still renders, banner says walk-ins are system-only
        payload["share_case"], payload["share_case_error"] = [], str(e)[:300]
    payload["elapsed_sec"] = round(time.time() - t0, 2)
    return payload


@app.route("/api/meeting-outcomes")
def api_meeting_outcomes():
    force = request.args.get("refresh") == "1"
    with _olock:
        age = time.time() - _ocache["at"]
        stale = _ocache["payload"] is None or age > CACHE_TTL_SEC or "share_case_error" in _ocache["payload"]
        if stale or (force and age > MIN_FORCE_REFRESH_SEC):
            payload = build_outcomes_payload()
            if payload["ok"]:
                _ocache.update(at=time.time(), payload=payload)
            elif _ocache["payload"] is not None:
                cached = dict(_ocache["payload"])
                cached["refresh_error"] = payload["error"]
                return _json(_scope(cached, "outcomes"))
            else:
                return _json(payload, 502)
        payload = dict(_ocache["payload"])
    payload["cache_age_sec"] = round(time.time() - _ocache["at"])
    return _json(_scope(payload, "outcomes"))


@app.route("/api/health")
def api_health():
    return _json({"checked_at_ist": dt.datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S"), "health": fetch_health()})


@app.route("/api/me")
def api_me():
    return _json({"role": g.role, "email": g.email, "stores": g.stores, "google_login": AUTH_MODE == "iap",
                  "path": "-".join(g.stores) if g.stores else None, "admin_email": ACCESS_ADMIN_EMAIL})


@app.route("/api/store-link")
def api_store_link():
    """Signed link for the stores chosen in the Store filter -- only for the password login."""
    slug = (request.args.get("stores") or "").upper()
    if g.stores is not None or not DASH_PASS:
        return _json({"ok": False, "error": "Only the dashboard login can make store links."}, 403)
    if not _STORE_PATH_RE.match(slug):
        return _json({"ok": False, "error": "Choose at least one store in the Store filter."}, 400)
    return _json({"ok": True, "stores": slug.split("-"), "path": "/" + slug + "?k=" + _link_sig(slug)})


def _store_options(users):
    opts = dict(DEFAULT_STORES)
    for r in ((_cache["payload"] or {}).get("rows") or []):
        k = _store_key(r.get("meeting_store_code"), r.get("store"))
        if k != "NOTCAPTURED" and not k.endswith("STORENOTASSIGNED"):
            opts.setdefault(k, r.get("store") or k)
    for u in users.values():
        for k in u["stores"]:
            if k != ALL_STORES:
                opts.setdefault(k, k)
    return [{"key": k, "label": v} for k, v in sorted(opts.items(), key=lambda kv: kv[1])]


def _access_view(extra=None, status=200):
    users = _access_users(force=True)
    out = {"ok": True, "admin_email": ACCESS_ADMIN_EMAIL, "google_login": AUTH_MODE == "iap",
           "stores": _store_options(users),
           "users": [{"email": e, "stores": u["stores"], "updated_at": u.get("updated_at")}
                     for e, u in sorted(users.items())]}
    out.update(extra or {})
    return _json(out, status)


@app.route("/api/access", methods=["GET", "POST"])
def api_access():
    try:
        if request.method == "GET":
            return _access_view()
        # POST: JSON only + same-origin, so another site cannot post with the admin's saved login
        origin = request.headers.get("Origin")
        if not request.is_json or (origin and origin.split("://", 1)[-1] != request.host):
            return _json({"ok": False, "error": "Bad request."}, 400)
        body = request.get_json(silent=True) or {}
        action, email = body.get("action"), (body.get("email") or "").strip().lower()
        if not _EMAIL_RE.match(email):
            return _json({"ok": False, "error": "Enter a valid email id."}, 400)
        if email == ACCESS_ADMIN_EMAIL or (AUTH_MODE != "iap" and DASH_USER and email == DASH_USER.lower()):
            return _json({"ok": False, "error": "This login already sees every store."}, 400)
        google = AUTH_MODE == "iap"                    # Google sign-in: no passwords at all
        users = {e: dict(u) for e, u in _access_users(force=True).items()}
        new_pw = None
        if action == "delete":
            if users.pop(email, None) is None:
                return _json({"ok": False, "error": "Email not in the list."}, 404)
        elif action == "reset":
            if google:
                return _json({"ok": False, "error": "Google sign-in is on: there are no passwords."}, 400)
            if email not in users:
                return _json({"ok": False, "error": "Email not in the list."}, 404)
            new_pw = secrets.token_urlsafe(9)
            users[email]["pass_hash"] = _hash_password(new_pw)
        elif action == "save":
            stores = []
            for k in body.get("stores") or []:
                k = _slug(str(k))
                if k and k not in stores:
                    stores.append(k)
            if not stores:
                return _json({"ok": False, "error": "Tick at least one store."}, 400)
            if ALL_STORES in stores:
                stores = [ALL_STORES]
            if email not in users:
                new_pw = None if google else secrets.token_urlsafe(9)
                users[email] = {"pass_hash": "" if google else _hash_password(new_pw)}
            users[email]["stores"] = stores
        else:
            return _json({"ok": False, "error": "Unknown action."}, 400)
        if email in users:
            users[email].pop("updated_at", None)      # stamped "now" by _access_write
        _access_write(users)
        return _access_view({"saved": action, "email": email, "password": new_pw})
    except Exception as e:  # noqa: BLE001
        return _json({"ok": False, "error": "Access list could not be read / saved: " + str(e)[:400]}, 502)


@app.route("/access")
def access_page():
    resp = send_from_directory(HERE, "access.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
@app.route("/index.html")
@app.route("/<slug>")
def index(slug=None):
    """/ = every store; /MAL-PN1-N18 = the dashboard opened on those stores (the page reads the path).
    A store login is always sent to the link of ITS stores, so a link shared earlier follows the
    access list: add LPN to the email and /MAL-PN1-N18 opens as /MAL-PN1-N18-LPN."""
    if slug is not None and not _STORE_PATH_RE.match(slug):
        return Response("Not found.", 404)
    if g.stores is not None:
        mine = "-".join(g.stores)
        if slug != mine:
            return redirect("/" + mine, 302)
    elif slug and slug != slug.upper():
        return redirect("/" + slug.upper(), 302)
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
