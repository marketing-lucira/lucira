"""
Zoho CRM -> "Deals VS Call" dashboard LIVE bundle API
=====================================================
HTTP Cloud Function that pulls Deals, Calls, Tasks, Online_Activity_Logs (chat),
Events (meetings) and Customer_Events from Zoho CRM (India DC) and returns the
EXACT bundle the deals-vs-call.html dashboard expects as `window.DASH`.

The dashboard does ALL business logic client-side. This function is a thin,
paginated data pump that packs records into slim positional arrays (identical
to etl/build.ps1) so the browser can hydrate() straight from the response.

Deploy (same pattern as zoho-task-function / zoho-crm-api):
    gcloud functions deploy zoho-crm-bundle \
        --gen2 --runtime=python312 --region=asia-south1 \
        --source=. --entry-point=crm_bundle --trigger-http --allow-unauthenticated \
        --memory=512Mi --timeout=300 \
        --set-env-vars=ZOHO_DC=in,ZOHO_CLIENT_ID=xxx,ZOHO_CLIENT_SECRET=xxx,ZOHO_REFRESH_TOKEN=xxx,CUTOFF=2026-05-31

Then in dashboard/app.js set:
    CONFIG.CRM_API = "https://<your-cloud-run-url>/zoho-crm-bundle"

SECURITY: credentials come from environment variables only. Never hardcode them.
NOTE: pulls ~40k records live -> first call ~20-40s. For a true "live within a
few minutes" feel, front this with the BigQuery CDC tables you already sync, or
cache the JSON in GCS/Memorystore with a 60-120s TTL (see README).
"""
import os, re, json, time
from datetime import datetime, timezone
import requests
import functions_framework

ZOHO_DC       = os.environ.get("ZOHO_DC", "in")
CLIENT_ID     = os.environ["ZOHO_CLIENT_ID"]
CLIENT_SECRET = os.environ["ZOHO_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["ZOHO_REFRESH_TOKEN"]
CUTOFF_DATE   = os.environ.get("CUTOFF", "2026-05-31")           # Created_Time >= this (per "after 31st May")
CUTOFF        = f"{CUTOFF_DATE}T00:00:00+05:30"
API   = f"https://www.zohoapis.{ZOHO_DC}/crm/v8"
TOKEN = f"https://accounts.zoho.{ZOHO_DC}/oauth/v2/token"

CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept", "Content-Type": "application/json"}

# ---------- helpers ----------
def token():
    r = requests.post(TOKEN, data={"refresh_token": REFRESH_TOKEN, "client_id": CLIENT_ID,
                                   "client_secret": CLIENT_SECRET, "grant_type": "refresh_token"}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]

def coql(tok, q):
    """One COQL page (<=2000 rows). Retries on 429/5xx."""
    for attempt in range(4):
        r = requests.post(f"{API}/coql", headers={"Authorization": f"Zoho-oauthtoken {tok}",
                          "Content-Type": "application/json"}, json={"select_query": q}, timeout=60)
        if r.status_code == 204:
            return []
        if r.status_code in (429, 500, 502, 503):
            time.sleep(1.5 * (attempt + 1)); continue
        r.raise_for_status()
        return r.json().get("data", [])
    raise RuntimeError("COQL retries exhausted")

def paginate(tok, module, cols):
    """Full offset pagination for one module, Created_Time >= CUTOFF, ordered by id."""
    out, off = [], 0
    while True:
        rows = coql(tok, f"select {cols} from {module} where Created_Time >= '{CUTOFF}' "
                         f"order by id asc limit 2000 offset {off}")
        out.extend(rows)
        if len(rows) < 2000:
            break
        off += 2000
        if off > 200000:   # safety
            break
    return out

def ist(s):
    if not s: return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})", s)
    if m: return m.group(1)
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) + "T00:00:00" if m else None

def digits10(s):
    d = re.sub(r"[^0-9]", "", s or "")
    return d[-10:] if len(d) >= 10 else d

def owner_id(r):
    o = r.get("Owner")
    if isinstance(o, dict): return str(o.get("id", ""))
    return str(r.get("Owner.id", "") or "")

def ce_cat(t):
    x = (t or "").lower()
    if "signup" in x or "singup" in x: return "Signup"
    if "atc" in x or "addtocart" in x or "add to cart" in x: return "ATC"
    if "checkout" in x: return "Checkout"
    if "purchase" in x or "payment" in x: return "Purchase"
    if "productview" in x or "pageview" in x or "websitevisit" in x or "view" in x: return "Website Visit"
    return "Other"

# ---------- entry point ----------
@functions_framework.http
def crm_bundle(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
    t0 = time.time()
    try:
        tok = token()

        # owners
        u = requests.get(f"{API}/users?type=AllUsers&per_page=200",
                         headers={"Authorization": f"Zoho-oauthtoken {tok}"}, timeout=30).json()
        owners = {str(x["id"]): (x.get("full_name") or (x.get("first_name","")+" "+x.get("last_name","")).strip())
                  for x in u.get("users", [])}

        deals_raw = paginate(tok, "Deals", "id,Deal_Name,Owner.id,Created_Time,Mobile,Stage,Probability,"
                             "Lead_Source,Reason_For_Loss__s,Deal_Trigger_Event,UTM_Source,UTM_Medium,Number_of_activity")
        calls_raw = paginate(tok, "Calls", "id,Owner.id,Created_Time,Call_Type,Call_Duration_in_seconds,"
                             "Call_Start_Time,Subject,What_Id")
        tasks_raw = paginate(tok, "Tasks", "id,Owner.id,Created_Time,Status,Due_Date,Closed_Time")
        online_raw= paginate(tok, "Online_Activity_Logs", "id,Owner.id,Created_Time,Channel,Activity_Type")
        events_raw= paginate(tok, "Events", "id,Owner.id,Created_Time,Start_DateTime,End_DateTime,Event_Title")
        ce_raw    = paginate(tok, "Customer_Events", "Event_Type,Created_Time")

        # pack (positional order MUST match dashboard app.js pd/pc/pt/po/pe)
        deals = [[r.get("id"), r.get("Deal_Name"), owner_id(r), ist(r.get("Created_Time")), r.get("Stage"),
                  int(r["Probability"]) if r.get("Probability") is not None else None, r.get("Lead_Source"),
                  r.get("Reason_For_Loss__s"), r.get("Deal_Trigger_Event"), r.get("UTM_Source"), r.get("UTM_Medium"),
                  int(r.get("Number_of_activity") or 0), digits10(r.get("Mobile"))] for r in deals_raw]

        def phone_from_subject(s):
            if not s: return ""
            m = re.findall(r"\(([^)]*\d[^)]*)\)", s)
            return digits10(m[-1]) if m else ""
        calls = [[r.get("id"), owner_id(r), ist(r.get("Created_Time")), r.get("Call_Type"),
                  int(r.get("Call_Duration_in_seconds") or 0), ist(r.get("Call_Start_Time")),
                  (r.get("What_Id") or {}).get("id","") if isinstance(r.get("What_Id"), dict) else "",
                  phone_from_subject(r.get("Subject"))] for r in calls_raw]

        tasks = [[r.get("id"), owner_id(r), ist(r.get("Created_Time")), r.get("Status"), r.get("Due_Date"),
                  ist(r.get("Closed_Time"))] for r in tasks_raw]
        online= [[r.get("id"), owner_id(r), ist(r.get("Created_Time")), r.get("Channel"), r.get("Activity_Type")]
                 for r in online_raw]
        events= [[r.get("id"), owner_id(r), ist(r.get("Created_Time")), ist(r.get("Start_DateTime")),
                  ist(r.get("End_DateTime")), r.get("Event_Title")] for r in events_raw]

        # customer events aggregate
        cats = ["Signup","ATC","Checkout","Purchase","Website Visit","Other"]
        by_cat_day = {c: {} for c in cats}; by_day = {}; by_raw = {}; ce_total = 0
        for r in ce_raw:
            iso = ist(r.get("Created_Time"))
            if not iso: continue
            day = iso[:10]; raw = r.get("Event_Type") or "(blank)"; cat = ce_cat(raw)
            ce_total += 1
            by_raw[raw] = by_raw.get(raw, 0) + 1
            by_cat_day[cat][day] = by_cat_day[cat].get(day, 0) + 1
            by_day[day] = by_day.get(day, 0) + 1
        by_cat = {c: sum(by_cat_day[c].values()) for c in cats}
        raw_top = [{"t": k, "n": v} for k, v in sorted(by_raw.items(), key=lambda kv: -kv[1])[:25]]

        bundle = {
            "meta": {"generated": datetime.now(timezone.utc).astimezone().isoformat(),
                     "cutoff": CUTOFF_DATE, "tz": "Asia/Kolkata",
                     "pagesRead": None, "elapsed_s": round(time.time() - t0, 1), "source": "zoho-live"},
            "owners": owners,
            "dealFields": ["id","name","owner","created","stage","prob","leadSource","reasonLoss","trigger","utmSource","utmMedium","numAct","mobile10"],
            "callFields": ["id","owner","created","type","durSec","start","whatId","phone10"],
            "taskFields": ["id","owner","created","status","dueDate","closed"],
            "onlineFields": ["id","owner","created","channel","activityType"],
            "eventFields": ["id","owner","created","start","end","title"],
            "deals": deals, "calls": calls, "tasks": tasks, "online": online, "events": events,
            "ce": {"total": ce_total, "cats": cats, "byCat": by_cat, "byCatDay": by_cat_day, "byDay": by_day, "rawTop": raw_top},
            "validation": {"Deals": len(deals), "Calls": len(calls), "Tasks": len(tasks),
                           "Online": len(online), "Events": len(events), "CustomerEvents": ce_total},
        }
        return (json.dumps(bundle), 200, CORS)
    except Exception as e:
        return (json.dumps({"error": str(e)}), 502, CORS)
