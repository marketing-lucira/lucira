"""
Zoho CRM (via BigQuery CDC) -> public LIVE bundle API for standalone dashboards
================================================================================
HTTP Cloud Function that reads the SAME `zoho_crm.cdc_*` BigQuery tables the
zoho-login-dashboard Flask app's `/api/crm-bundle` route uses (synced from Zoho
every 30 min by the existing `zoho-sync` Cloud Scheduler job) and returns the
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

    # city/state: cdc_deals' own Address_City/Address_State are 0% populated (checked live
    # 2026-08-11), so both come from a LEFT JOIN to a separate live Deals table
    # (Lucira_Prod.lucira_zoho_Deals — same table leads_bundle() below reads directly),
    # matched by Deal ID (~66% of cdc_deals ids find a match there). Unmatched or blank
    # rows come through as "" and land in the dashboard's "(Not Captured)" bucket — never
    # guessed at.
    deals = [[r["id"], r["name"], r["owner"], r["created"], r["stage"], r["prob"],
              r["lead_source"], r["reason_loss"], r["trigger"], r["utm_source"],
              r["utm_medium"], r["num_act"] or 0, r["mobile"] or "", r["city"] or "",
              r["state"] or "", r["modified"] or ""] for r in rows(f"""
        SELECT d.id, JSON_VALUE(d.data,'$.Deal_Name') name, d.owner_id owner, {ts.replace('created_time','d.created_time')} created,
               JSON_VALUE(d.data,'$.Stage') stage,
               SAFE_CAST(JSON_VALUE(d.data,'$.Probability') AS FLOAT64) prob,
               JSON_VALUE(d.data,'$.Lead_Source') lead_source,
               JSON_VALUE(d.data,'$.Reason_For_Loss__s') reason_loss,
               JSON_VALUE(d.data,'$.Deal_Trigger_Event') trigger,
               JSON_VALUE(d.data,'$.UTM_Source') utm_source,
               JSON_VALUE(d.data,'$.UTM_Medium') utm_medium,
               SAFE_CAST(JSON_VALUE(d.data,'$.Number_of_activity') AS INT64) num_act,
               RIGHT(REGEXP_REPLACE(COALESCE(JSON_VALUE(d.data,'$.Mobile'),''),r'[^0-9]',''),10) mobile,
               INITCAP(TRIM(c.Address_City)) city, c.Address_State state,
               {ts.replace('created_time','d.modified_time')} modified
        FROM {P}cdc_deals` d
        LEFT JOIN `{PROJECT}.Lucira_Prod.lucira_zoho_Deals` c ON c.id = d.id
        WHERE {rng.replace('created_time','d.created_time')}""")]

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


# =============================================================================
# [DELETED 2026-08-22, per explicit user request: "Ok lets delet everything in
# this filed" — the "Customer Activity + Call Intelligence" rebuild of
# dashboard/modified-deals-intelligence.html, its backend (this section:
# activity_call_intel_bundle/_build_activity_call_intel_bundle) and its Cloud
# Function (zoho-activity-call-intel-public) were all removed. Trigger: an
# unresolved data-accuracy gap — the real Zoho Analytics "Customer Activities
# - Today" export showed 59 rows for 2026-08-21, but this endpoint's
# DATE(Last_Activity_Time)=today cohort returned 630-780+ for the same day even
# after excluding same-day-created deals; several follow-up hypotheses (Task/
# Call/Meeting linkage, owner, stage, Record_Type) were tested live against
# BigQuery and each ruled out — the exact extra filter Zoho Analytics applies
# was never identified. See session memory (lucira-modified-deals-intelligence)
# for the full investigation before ever rebuilding this again — re-derive the
# cohort definition from Zoho Analytics' own report criteria (screenshot the
# report builder), not by re-guessing against the BigQuery replica alone.]
# =============================================================================


# =============================================================================
# City-Wise Leads bundle — dashboard/deals-calls-sales.html's "City-Wise Leads
# Dump" section. Deployed from this SAME source directory as a separate Cloud
# Function (--entry-point=leads_bundle).
#
# Reads `Lucira_Prod.lucira_zoho_Deals` — a DIFFERENT Deals table from the
# `zoho_crm.cdc_deals` feed every other endpoint in this file uses. Discovered
# 2026-08-11 after confirming cdc_deals' own Address_City/Address_State are
# 0% populated: this table has REAL, LIVE address data — Address_City/
# Address_State/Address_Zip as first-class typed columns (not buried in a
# JSON blob), 2,031/2,000 of 14,647 deals populated (~13.9%), and MAX(Creat_time)
# is today (2026-08-11) with ~150-250 new deals/day — genuinely current, unlike
# the earlier `zoho_crm.daily_leads` (a separate, stale Leads-module import
# frozen at 2026-07-28) this endpoint used before. `Deal_Owner` here is already
# a plain name (e.g. "Shreekant Balwat"), no id→name lookup needed. Only
# deals with a non-blank Address_City are included in citySummary/raw; the
# true totalDeals/dealsWithCity are still in meta so nothing is silently
# hidden. City summary buckets by Stage: Closed Won / Closed Lost / Open
# (Prospect + Add to Cart + Checkout + Payment — every other real Stage value
# found live) — the raw dump keeps the exact original Stage string per row.
#
# Deploy:
#   gcloud functions deploy zoho-leads-city-public \
#       --gen2 --runtime=python312 --region=asia-south1 \
#       --source=. --entry-point=leads_bundle --trigger-http --allow-unauthenticated \
#       --memory=512Mi --timeout=120 --project=lucirajewelry-prod \
#       --set-env-vars=BQ_PROJECT=lucirajewelry-prod,BQ_DATASET=zoho_crm
# =============================================================================
LEADS_CACHE_TTL = 300  # live/growing table now — shorter TTL than the old static-import source
_leads_cache = {"at": 0, "body": None}
DEALS_TABLE = "`lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`"


def _build_leads_bundle():
    D = DEALS_TABLE
    stage_bucket = """CASE
      WHEN Stage = 'Closed Won' THEN 'Won'
      WHEN Stage = 'Closed Lost' THEN 'Lost'
      ELSE 'Open' END"""

    meta_row = list(_bq.query(f"""
        SELECT COUNT(*) total,
               COUNTIF(Address_City IS NOT NULL AND TRIM(Address_City) != '') has_city,
               CAST(MAX(Creat_time) AS STRING) max_created,
               CAST(MIN(Creat_time) AS STRING) min_created
        FROM {D}""").result())[0]

    city_summary = [[r["city"], r["total"], r["won"], r["lost"], r["open"]]
                     for r in _bq.query(f"""
        SELECT INITCAP(TRIM(Address_City)) city, COUNT(*) total,
               COUNTIF({stage_bucket} = 'Won') won,
               COUNTIF({stage_bucket} = 'Lost') lost,
               COUNTIF({stage_bucket} = 'Open') open
        FROM {D}
        WHERE Address_City IS NOT NULL AND TRIM(Address_City) != ''
        GROUP BY city ORDER BY total DESC""").result()]

    raw = [[r["id"], r["name"], r["mobile"] or "", r["city"], r["state"] or "",
            r["source"] or "", r["stage"] or "", r["created"], r["owner"] or ""]
           for r in _bq.query(f"""
        SELECT id, Deal_Name name,
               RIGHT(REGEXP_REPLACE(COALESCE(Mobile, ''), r'[^0-9]', ''), 10) mobile,
               INITCAP(TRIM(Address_City)) city, Address_State state, Lead_Source source, Stage stage,
               CAST(Creat_time AS STRING) created, Deal_Owner owner
        FROM {D}
        WHERE Address_City IS NOT NULL AND TRIM(Address_City) != ''
        ORDER BY Creat_time DESC""").result()]

    gen = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%dT%H:%M:%S+05:30")
    return {"citySummary": city_summary, "raw": raw,
            "meta": {"generated": gen, "source": "bigquery.Lucira_Prod.lucira_zoho_Deals",
                     "module": "Zoho Deals — separate live table with real Address_City/State (cdc_deals' own copy of those fields is 0% populated)",
                     "stale": False, "maxCreated": meta_row["max_created"], "minCreated": meta_row["min_created"],
                     "totalLeads": meta_row["total"], "leadsWithCity": meta_row["has_city"],
                     "note": ("This reads a separate BigQuery table (Lucira_Prod.lucira_zoho_Deals) from the "
                               "cdc_deals feed the rest of this dashboard uses — genuinely live, current through "
                               "maxCreated. Only deals with a non-blank Address_City are included in citySummary/"
                               "raw; totalLeads/leadsWithCity above are the true totals so nothing is silently "
                               "hidden.")}}


@functions_framework.http
def leads_bundle(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    now = time.time()
    if _leads_cache["body"] and (now - _leads_cache["at"]) < LEADS_CACHE_TTL:
        return (jsonify(_leads_cache["body"]), 200, CORS)

    try:
        body = _build_leads_bundle()
    except Exception as e:
        return (jsonify(error=str(e)), 500, CORS)

    _leads_cache["body"] = body
    _leads_cache["at"] = now
    return (jsonify(body), 200, CORS)
