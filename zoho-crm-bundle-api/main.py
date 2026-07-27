"""
Zoho CRM (via BigQuery CDC) -> public LIVE bundle API for standalone dashboards
================================================================================
HTTP Cloud Function that reads the SAME `zoho_crm.cdc_*` BigQuery tables the
zoho-login-dashboard Flask app's `/api/crm-bundle` route uses (synced from Zoho
every 15 min by the existing `zoho-sync` Cloud Scheduler job) and returns the
identical positional bundle shape `dashboard/data.js` / `window.DASH` expects.

Unlike `/api/crm-bundle` (which lives inside the Basic-Auth-gated Flask app and
is same-origin only), this function is public + CORS-open so a standalone
static file (e.g. dashboard/deals-calls-sales.html) can fetch it directly,
the same way dashboard/sales-intelligence.html fetches the public Sales
snapshot. It reads BigQuery only — no Zoho OAuth credentials needed.

Deploy:
    gcloud functions deploy zoho-crm-bundle-public \
        --gen2 --runtime=python312 --region=asia-south1 \
        --source=. --entry-point=crm_bundle --trigger-http --allow-unauthenticated \
        --memory=512Mi --timeout=120 --project=lucirajewelry-prod \
        --set-env-vars=BQ_PROJECT=lucirajewelry-prod,BQ_DATASET=zoho_crm,CRM_CUTOFF=2026-05-31

Then in the dashboard set CONFIG.CRM_API to the printed URL.
"""
import os
import time
from datetime import datetime, timezone, timedelta

import functions_framework
from flask import jsonify
from google.cloud import bigquery

PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
DATASET = os.environ.get("BQ_DATASET", "zoho_crm")
CUTOFF_DEFAULT = os.environ.get("CRM_CUTOFF", "2026-05-31")
TZ = "Asia/Kolkata"
CACHE_TTL = 60  # seconds — avoid re-querying BigQuery on every rapid page reload

CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "3600"}

_bq = bigquery.Client(project=PROJECT)
_cache = {"at": 0, "body": None}


def _crm_ce(P, cutoff):
    catcase = """CASE
      WHEN LOWER(event_type) LIKE '%signup%' OR LOWER(event_type) LIKE '%sign up%' OR LOWER(event_type) LIKE '%singup%' THEN 'Signup'
      WHEN LOWER(event_type) LIKE '%checkout%' THEN 'Checkout'
      WHEN LOWER(event_type) = 'atc' OR LOWER(event_type) LIKE '%add to cart%' OR LOWER(event_type) LIKE '%add_to_cart%' OR LOWER(event_type) LIKE '%addtocart%' THEN 'ATC'
      WHEN LOWER(event_type) LIKE '%payment%' OR LOWER(event_type) LIKE '%purchase%' THEN 'Purchase'
      WHEN LOWER(event_type) LIKE '%whatsapp%' THEN 'WhatsApp'
      WHEN LOWER(event_type) LIKE '%productview%' OR LOWER(event_type) LIKE '%product view%' OR LOWER(event_type) LIKE '%pageview%' OR LOWER(event_type) LIKE '%nitroproduct%' THEN 'ProductView'
      WHEN LOWER(event_type) LIKE '%website%' THEN 'Website Visit'
      ELSE INITCAP(COALESCE(event_type,'(none)')) END"""
    byCatDay, cats, total = {}, set(), 0
    for r in _bq.query(f"""
        SELECT {catcase} cat, CAST(DATE(event_time,'{TZ}') AS STRING) day, COUNT(*) n
        FROM {P}customer_events`
        WHERE DATE(event_time,'{TZ}') >= '{cutoff}' AND event_type IS NOT NULL
        GROUP BY cat, day""").result():
        byCatDay.setdefault(r["cat"] or "(none)", {})[r["day"]] = r["n"]
        cats.add(r["cat"] or "(none)"); total += r["n"]
    rawTop = [{"t": r["t"], "n": r["n"]} for r in _bq.query(f"""
        SELECT event_type t, COUNT(*) n FROM {P}customer_events`
        WHERE DATE(event_time,'{TZ}') >= '{cutoff}' AND event_type IS NOT NULL
        GROUP BY t ORDER BY n DESC LIMIT 25""").result()]
    return {"byCat": {}, "byCatDay": byCatDay, "byDay": {}, "cats": sorted(cats),
            "rawTop": rawTop, "total": total}


def _build_bundle(cutoff):
    P = f"`{PROJECT}.{DATASET}."
    ts = f"FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', created_time, '{TZ}')"
    rng = f"DATE(created_time,'{TZ}') >= '{cutoff}'"
    rows = lambda sql: list(_bq.query(sql).result())

    deals = [[r["id"], r["name"], r["owner"], r["created"], r["stage"], r["prob"],
              r["lead_source"], r["reason_loss"], r["trigger"], r["utm_source"],
              r["utm_medium"], r["num_act"] or 0, r["mobile"] or ""] for r in rows(f"""
        SELECT id, JSON_VALUE(data,'$.Deal_Name') name, owner_id owner, {ts} created,
               JSON_VALUE(data,'$.Stage') stage,
               SAFE_CAST(JSON_VALUE(data,'$.Probability') AS FLOAT64) prob,
               JSON_VALUE(data,'$.Lead_Source') lead_source,
               JSON_VALUE(data,'$.Reason_For_Loss__s') reason_loss,
               JSON_VALUE(data,'$.Deal_Trigger_Event') trigger,
               JSON_VALUE(data,'$.UTM_Source') utm_source,
               JSON_VALUE(data,'$.UTM_Medium') utm_medium,
               SAFE_CAST(JSON_VALUE(data,'$.Number_of_activity') AS INT64) num_act,
               RIGHT(REGEXP_REPLACE(COALESCE(JSON_VALUE(data,'$.Mobile'),''),r'[^0-9]',''),10) mobile
        FROM {P}cdc_deals` WHERE {rng}""")]

    calls = [[r["id"], r["owner"], r["created"], r["type"], r["dur"] or 0,
              r["cstart"], r["what_id"] or "", r["phone"] or "", r["result"] or ""] for r in rows(f"""
        SELECT id, owner_id owner, {ts} created,
               JSON_VALUE(data,'$.Call_Type') type,
               SAFE_CAST(JSON_VALUE(data,'$.Call_Duration_in_seconds') AS INT64) dur,
               JSON_VALUE(data,'$.Call_Start_Time') cstart,
               JSON_VALUE(data,'$.What_Id.id') what_id,
               RIGHT(REGEXP_REPLACE(COALESCE(JSON_VALUE(data,'$.Subject'),''),r'[^0-9]',''),10) phone,
               JSON_VALUE(data,'$.Call_Result') result
        FROM {P}cdc_calls` WHERE {rng}""")]

    tasks = [[r["id"], r["owner"], r["created"], r["status"], r["due"], r["closed"], r["what_id"] or ""]
             for r in rows(f"""
        SELECT id, owner_id owner, {ts} created,
               JSON_VALUE(data,'$.Status') status, JSON_VALUE(data,'$.Due_Date') due,
               JSON_VALUE(data,'$.Closed_Time') closed,
               JSON_VALUE(data,'$.What_Id.id') what_id
        FROM {P}cdc_tasks` WHERE {rng}""")]

    online = [[r["id"], r["owner"], r["created"], r["channel"], r["atype"]]
              for r in rows(f"""
        SELECT id, owner_id owner, {ts} created,
               JSON_VALUE(data,'$.Channel') channel, JSON_VALUE(data,'$.Activity_Type') atype
        FROM {P}cdc_online_activities` WHERE {rng}""")]

    events = [[r["id"], r["owner"], r["created"], r["estart"], r["eend"], r["title"]]
              for r in rows(f"""
        SELECT id, owner_id owner, {ts} created,
               JSON_VALUE(data,'$.Start_DateTime') estart,
               JSON_VALUE(data,'$.End_DateTime') eend, JSON_VALUE(data,'$.Event_Title') title
        FROM {P}cdc_meetings` WHERE {rng}""")]

    owners = {r["owner_id"]: r["nm"] for r in rows(f"""
        SELECT owner_id, ANY_VALUE(owner_name) nm FROM (
          SELECT owner_id, owner_name FROM {P}cdc_deals`
          UNION ALL SELECT owner_id, owner_name FROM {P}cdc_calls`
          UNION ALL SELECT owner_id, owner_name FROM {P}cdc_tasks`
          UNION ALL SELECT owner_id, owner_name FROM {P}cdc_meetings`
          UNION ALL SELECT owner_id, owner_name FROM {P}cdc_online_activities`)
        WHERE owner_id IS NOT NULL GROUP BY owner_id""")}

    ce = _crm_ce(P, cutoff)

    gen = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%dT%H:%M:%S+05:30")
    return {"owners": owners, "deals": deals, "calls": calls, "tasks": tasks, "online": online,
            "events": events, "ce": ce,
            "meta": {"generated": gen, "cutoff": cutoff + "T00:00:00", "tz": TZ,
                     "pagesRead": 0, "source": "cdc_bigquery_public"}}


@functions_framework.http
def crm_bundle(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    cutoff = request.args.get("cutoff", CUTOFF_DEFAULT)
    now = time.time()
    if cutoff == CUTOFF_DEFAULT and _cache["body"] and (now - _cache["at"]) < CACHE_TTL:
        return (jsonify(_cache["body"]), 200, CORS)

    try:
        body = _build_bundle(cutoff)
    except Exception as e:
        return (jsonify(error=str(e)), 500, CORS)

    if cutoff == CUTOFF_DEFAULT:
        _cache["body"] = body
        _cache["at"] = now
    return (jsonify(body), 200, CORS)
