#!/usr/bin/env python3
"""
Build script for "Store Visit & Sales Conversion Intelligence" (dashboard/
store-visit-sales-conversion-intelligence.html).

Journey modeled: Deal Created -> Agent Call Attempts -> Meeting Raised -> Store Assigned
-> Store Visit -> Store Follow-up Call -> Sale. Primary hierarchy: City -> Agent -> Day ->
Deal -> Store Visit -> Sale.

Sibling of dashboard/build_dcm_data.py (same session, same validated join model for
Deals/Calls/Meetings/Sales). This build adds one NEW, more precise signal that the DCM
dashboard did not use: genuine Store Visit attendance from `meetings_sheet_sync.show_no_show`,
distinct from Meeting Raised and from Store Called.

Pulls from lucirajewelry-prod via `bq query` (same auth/pattern as build_dcm_data.py /
build_ppi_data.py / build_spsw_data.py -- no Cloud Run, no live API, no deploy):

  1. sql/svci_build.sql          -> one row per Deal (22,819 rows) with call-attempt 1/2/3
                                     (What_Id join) and first Meeting Raised (cdc_meetings JSON).
  2. sql/svci_meetings_sheet.sql -> raw meetings_sheet_sync (928 rows, Store Visit + Store
                                     Follow-up Call source).
  3. sql/svci_sales.sql          -> raw marketing_sale (2,531 rows).

All cross-table joins that are mobile-only and one-to-many (sheet, sales) are resolved here
in Python with an explicit "first matching record on/after the anchor date" rule, and are
labeled everywhere as mobile-matched (not Deal-ID-matched). Writes dashboard/svci_data.js
(window.SVCI_DATA = {...}).

Re-run to refresh: `python build_svci_data.py` (requires `bq` on PATH, authenticated for
lucirajewelry-prod).

HONESTY CONSTRAINTS (do not violate):
  - Deals.Store_Assigned is 0% populated -- never read, never referenced as working.
  - Address_City is ~11.2% populated -- deals with no city go in an explicit "City Not
    Captured" bucket, never dropped.
  - Calls only join via What_Id = Deal id (the validated path). No mobile-fallback for calls.
  - Meeting Raised != Store Visit != Store Called -- three distinct fields, three distinct
    columns/sources, never conflated in KPI math or table columns:
      * Meeting Raised   <- cdc_meetings (a meeting record exists for the deal)
      * Store Visit      <- meetings_sheet_sync.action='Store Visit' AND show_no_show='Show'
                             (genuine attendance -- "Store Visit Confirmed"). Video Call / TAH
                             rows and WIP/null show_no_show are explicitly NOT a confirmed
                             visit -- rendered as "Scheduled / No-Show", never as a visit.
      * Store Called     <- meetings_sheet_sync.call_status IS NOT NULL
  - Store Visit Status = "Not Available" when no meetings_sheet_sync row matches a
    meeting-raised deal's mobile -- never inferred as visited just because a meeting exists,
    and never inferred as not-visited either.
  - marketing_sale has NO Deal ID column. Sale<->Deal is mobile-match only, and a sale dated
    before the deal's/meeting's anchor date is never counted as caused by it.
  - Every day-diff is DATE(later)-DATE(earlier), never negative. A negative diff is logged as
    a data-quality flag and rendered as null/"-" everywhere downstream.
"""
import argparse, json, os, re, subprocess, sys, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_DIR = os.path.join(HERE, "sql")
OUT_JS = os.path.join(HERE, "svci_data.js")

BQ_EXE = "bq.cmd" if os.name == "nt" else "bq"

argp = argparse.ArgumentParser(description="Build svci_data.js")
argp.add_argument("--source", choices=["bigquery", "live"], default="bigquery",
                   help="'bigquery' (default, unchanged): Deals/Calls/Meetings via bq CLI. "
                        "'live': Deals/Calls/Meetings via the Zoho CRM v8 REST Modules API "
                        "(same-minute freshness; requires etl/.zoho.env). Store Visit / Store "
                        "Follow-up (meetings_sheet_sync) and Sales (marketing_sale) are ALWAYS "
                        "BigQuery -- no Zoho CRM equivalent exists for either.")
ARGS = argp.parse_args()


def run_bq(sql_path):
    with open(sql_path, "r", encoding="utf-8") as fh:
        sql = fh.read()
    proc = subprocess.run(
        [BQ_EXE, "query", "--use_legacy_sql=false", "--format=json", "--max_rows=200000",
         "--project_id=lucirajewelry-prod"],
        input=sql, capture_output=True, text=True, shell=(os.name == "nt")
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        sys.exit(1)
    out = proc.stdout.strip()
    if not out:
        return []
    return json.loads(out)


def run_bq_str(sql):
    tmp = os.path.join(SQL_DIR, "_tmp_svci_adhoc.sql")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(sql)
    try:
        return run_bq(tmp)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def norm_mobile(m):
    if not m:
        return None
    d = re.sub(r"\D", "", str(m))
    if not d:
        return None
    return d[-10:] if len(d) >= 10 else None  # require full 10 digits to count as a real mobile


def to_num(v, default=None):
    if v in (None, ""):
        return default
    try:
        return float(v)
    except Exception:
        return default


def to_int(v):
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except Exception:
        return None


def date_only(s):
    if not s:
        return None
    return str(s)[:10]


def day_diff(later, earlier, flag_bucket, flag_name):
    """DATE(later) - DATE(earlier) in days. Returns None if either missing or if negative
    (and logs the negative case as a data-quality flag, never surfaced as a negative number)."""
    if not later or not earlier:
        return None
    try:
        dl = datetime.date.fromisoformat(later[:10])
        de = datetime.date.fromisoformat(earlier[:10])
    except Exception:
        return None
    n = (dl - de).days
    if n < 0:
        flag_bucket[flag_name] = flag_bucket.get(flag_name, 0) + 1
        return None
    return n


def dedup_same_day_mobile_deals(deals_raw):
    """Same customer (mobile), same Deal-Created day -> keep only the LATEST-created Deal, drop
    the earlier one(s). E.g. mobile X has a deal created 1pm and another at 2pm the same day:
    keep the 2pm one, exclude the 1pm one. Recency is decided by the full Created_Time timestamp
    when available (live Zoho REST mode); the BigQuery snapshot's `Creat_time` is DATE-only (no
    time-of-day), so on that path -- and as a tie-break whenever timestamps are equal/missing --
    we fall back to the numerically higher Zoho record id, which is a reliable recency proxy
    because Zoho CRM ids are assigned in strictly increasing creation order. Deals with no usable
    mobile (can't be normalized to 10 digits) are never deduped -- there's nothing to group them
    on, so they all pass through unchanged."""
    groups = collections.defaultdict(list)
    passthrough = []
    for d in deals_raw:
        mob10 = norm_mobile(d.get("mobile"))
        day = date_only(d.get("created_date"))
        if not mob10 or not day:
            passthrough.append(d)
            continue
        groups[(mob10, day)].append(d)

    def sort_key(d):
        created = d.get("created_date") or ""
        try:
            deal_id_num = int(re.sub(r"\D", "", str(d.get("deal_id") or "0")) or "0")
        except Exception:
            deal_id_num = 0
        return (created, deal_id_num)

    kept = list(passthrough)
    removed = 0
    for (mob10, day), group in groups.items():
        if len(group) == 1:
            kept.append(group[0])
            continue
        group.sort(key=sort_key)
        kept.append(group[-1])
        removed += len(group) - 1
    return kept, removed


if ARGS.source == "live":
    from zoho_live_fetch import fetch_zoho_live, fetch_all_meetings_live, now_ist_str
    print("Step 1/4: fetching Deals + Calls + Meetings LIVE via Zoho CRM v8 REST Modules API ...")
    deals_raw = fetch_zoho_live(include_meeting_extra=True)
    print(f"  {len(deals_raw)} deal rows (live)")
else:
    print("Step 1/4: querying Deals + Calls(What_Id) + Meetings(cdc_meetings) ...")
    deals_raw = run_bq(os.path.join(SQL_DIR, "svci_build.sql"))
    print(f"  {len(deals_raw)} deal rows")

deals_raw, same_day_mobile_dupes_removed = dedup_same_day_mobile_deals(deals_raw)
print(f"  Same-mobile/same-day dedup: removed {same_day_mobile_dupes_removed} earlier duplicate(s), kept latest -> {len(deals_raw)} deal rows")

print("Step 2/4: querying meetings_sheet_sync (Store Visit + Store Follow-up source) ...")
sheet_raw = run_bq(os.path.join(SQL_DIR, "svci_meetings_sheet.sql"))
print(f"  {len(sheet_raw)} sheet rows")

print("Step 3/4: querying marketing_sale ...")
sale_raw = run_bq(os.path.join(SQL_DIR, "svci_sales.sql"))
print(f"  {len(sale_raw)} sale rows")

# ---------------------------------------------------------------------------
# Step 4: "Meeting Intelligence" tab -- ALL Zoho CRM Meetings (Events), not filtered to
# deal-linked ones like the join above. Broader than the rest of this dashboard, per the
# client spec: Store Name/Used Location <- Venue, Create Date <- date(Created_Time),
# From <- Start_DateTime, Title <- Event_Title. There is no "Location" field on this module.
# ---------------------------------------------------------------------------
if ARGS.source == "live":
    print("Step 4/4: fetching ALL Meetings (full Events module) LIVE via Zoho CRM v8 REST API ...")
    all_meetings_raw = fetch_all_meetings_live()
    print(f"  {len(all_meetings_raw)} meeting rows (live, all -- not just deal-linked)")
else:
    print("Step 4/4: querying ALL Meetings (full cdc_meetings, no What_Id filter) ...")
    all_meetings_raw = run_bq(os.path.join(SQL_DIR, "svci_all_meetings.sql"))
    print(f"  {len(all_meetings_raw)} meeting rows (all -- not just deal-linked)")

all_meetings_seen_ids = set()
all_meetings_dupe_ids_removed = 0
all_meetings = []
for m in all_meetings_raw:
    mid = m.get("id")
    if mid is not None:
        if mid in all_meetings_seen_ids:
            all_meetings_dupe_ids_removed += 1
            continue
        all_meetings_seen_ids.add(mid)
    all_meetings.append({
        "id": mid,
        "venue": (m.get("venue") or "").strip() or None,
        "event_title": (m.get("event_title") or "").strip() or None,
        "created_time": m.get("created_time"),           # full ISO timestamp, already IST (+05:30)
        "created_date": date_only(m.get("created_time")), # date part only -- daily counts group on THIS
        "start_datetime": m.get("start_datetime"),        # full ISO timestamp, already IST (+05:30)
    })
print(f"  All Meetings processed: {len(all_meetings)}  duplicate ids removed: {all_meetings_dupe_ids_removed}")

flags = {}  # data-quality flag counters, e.g. negative date diffs

# ---------------------------------------------------------------------------
# Normalize SHEET (Store Visit / Store Follow-up) rows, index by mobile10
# ---------------------------------------------------------------------------
sheet_rows = []
for r in sheet_raw:
    mob10 = norm_mobile(r.get("mobile"))
    action = (r.get("action") or "").strip() or None
    show_no_show = (r.get("show_no_show") or "").strip() or None
    is_confirmed_visit = (action == "Store Visit" and show_no_show == "Show")
    sheet_rows.append({
        "mobile10": mob10,
        "meeting_date": date_only(r.get("meeting_date")),
        "action": action,
        "store": (r.get("store") or "").strip() or None,
        "call_status": r.get("call_status"),  # "Connected" / "Not Connected" / None
        "agent": r.get("agent"),
        "customer_name": r.get("customer_name"),
        "conversion_status": r.get("conversion_status"),
        "show_no_show": show_no_show,
        "is_confirmed_visit": is_confirmed_visit,
    })
sheet_by_mobile = collections.defaultdict(list)
for r in sheet_rows:
    if r["mobile10"]:
        sheet_by_mobile[r["mobile10"]].append(r)
for mob in sheet_by_mobile:
    sheet_by_mobile[mob].sort(key=lambda r: r["meeting_date"] or "9999-99-99")

sheet_distinct_mobiles = set(sheet_by_mobile.keys())

# ---------------------------------------------------------------------------
# Normalize SALE rows, index by mobile10
# ---------------------------------------------------------------------------
sale_rows = []
for r in sale_raw:
    mob10 = norm_mobile(r.get("cus_mobile")) or norm_mobile(r.get("mobile1"))
    sale_rows.append({
        "mobile10": mob10,
        "date": date_only(r.get("transaction_date")),
        "company_code": r.get("company_code"),
        "document_no": r.get("document_no"),
        "net_sale": to_num(r.get("net_sale"), 0.0),
        "party_name": r.get("party_name"),
    })
sale_by_mobile = collections.defaultdict(list)
for r in sale_rows:
    if r["mobile10"]:
        sale_by_mobile[r["mobile10"]].append(r)
for mob in sale_by_mobile:
    sale_by_mobile[mob].sort(key=lambda r: r["date"] or "9999-99-99")

sale_distinct_mobiles = set(sale_by_mobile.keys())


def first_sheet_row_for(mob10, anchor_date):
    """First meetings_sheet_sync row for this mobile with meeting_date >= anchor_date,
    else the first row overall for that mobile (still real data, just not date-gated)."""
    rows = sheet_by_mobile.get(mob10) or []
    if not rows:
        return None
    if anchor_date:
        on_or_after = [r for r in rows if r["meeting_date"] and r["meeting_date"] >= anchor_date]
        if on_or_after:
            return on_or_after[0]
    return rows[0]


def first_sale_row_for(mob10, anchor_date):
    """First sale for this mobile with Transaction_Date >= anchor_date (deal creation or
    meeting date) -- never count a sale that predates the deal/meeting as caused by it."""
    rows = sale_by_mobile.get(mob10) or []
    if not rows or not anchor_date:
        return None
    on_or_after = [r for r in rows if r["date"] and r["date"] >= anchor_date]
    return on_or_after[0] if on_or_after else None


# ---------------------------------------------------------------------------
# Process DEALS (the main grain)
# ---------------------------------------------------------------------------
deal_ids_seen = set()
duplicate_deal_ids = 0

rows = []
city_counter = collections.Counter()
agent_counter = collections.Counter()

for d in deals_raw:
    deal_id = d.get("deal_id")
    if deal_id in deal_ids_seen:
        duplicate_deal_ids += 1
    deal_ids_seen.add(deal_id)

    created_date = date_only(d.get("created_date"))
    address_city = (d.get("address_city") or "").strip() or None
    city_bucket = address_city if address_city else "City Not Captured"
    city_counter[city_bucket] += 1
    agent = (d.get("agent") or "").strip() or "Unassigned"
    agent_counter[agent] += 1

    mob10 = norm_mobile(d.get("mobile"))

    call1_sec = to_int(d.get("call1_sec"))
    call2_sec = to_int(d.get("call2_sec"))
    call3_sec = to_int(d.get("call3_sec"))
    call1_time = d.get("call1_time")
    call2_time = d.get("call2_time")
    call3_time = d.get("call3_time")
    total_calls = to_int(d.get("total_calls")) or 0
    total_call_seconds = to_int(d.get("total_call_seconds")) or 0

    meeting_raised_date = date_only(d.get("meeting_raised_date"))
    meeting_raised = meeting_raised_date is not None
    meeting_owner = d.get("meeting_owner")
    meeting_venue = d.get("meeting_venue")
    meeting_created_by = d.get("meeting_created_by")
    meeting_description = d.get("meeting_description")
    meeting_event_title = d.get("meeting_event_title")

    # --- Store Visit / Store Follow-up (meetings_sheet_sync), mobile-matched, honesty-gated.
    # Meeting Store / Store Visit / Store Called only apply to deals with Meeting Raised = Yes
    # -- for deals with no meeting, "store follow-up" is not applicable (not the same as
    # "no record found").
    if meeting_raised:
        sheet_match = first_sheet_row_for(mob10, meeting_raised_date) if mob10 else None
        if sheet_match:
            meeting_store = sheet_match["store"] or (meeting_venue if meeting_venue else None)
            meeting_store_source = "meetings_sheet_sync" if sheet_match["store"] else ("cdc_meetings.venue" if meeting_venue else None)
            store_called = sheet_match["call_status"] is not None
            store_call_status = sheet_match["call_status"]  # Connected / Not Connected / None
            store_call_date = sheet_match["meeting_date"]

            sheet_action = sheet_match["action"]
            show_no_show = sheet_match["show_no_show"]
            store_visit_confirmed = sheet_match["is_confirmed_visit"]
            if sheet_action == "Store Visit" and show_no_show == "Show":
                store_visit_status = "Visited (Confirmed)"
            elif sheet_action == "Store Visit" and show_no_show == "No Show":
                store_visit_status = "No Show"
            elif sheet_action == "Store Visit":
                store_visit_status = "Scheduled / Pending"  # WIP or null show_no_show
            elif sheet_action == "Video Call":
                store_visit_status = "Not a Store Visit (Video Call)"
            elif sheet_action == "TAH":
                store_visit_status = "Not a Store Visit (TAH)"
            else:
                store_visit_status = "Not Available"
            store_visit_date = sheet_match["meeting_date"] if sheet_action == "Store Visit" else None
            store_visit_action = sheet_action
            store_visit_conversion_status = sheet_match["conversion_status"]
        else:
            # No sheet match at all -- fall back to cdc_meetings venue for Meeting Store only,
            # everything sheet-derived is honestly "Not Available" (never fabricated).
            meeting_store = meeting_venue if meeting_venue else None
            meeting_store_source = "cdc_meetings.venue" if meeting_venue else None
            store_called = None  # None = Not Available (no record), distinct from False
            store_call_status = None
            store_call_date = None
            store_visit_confirmed = False
            store_visit_status = "Not Available"
            store_visit_date = None
            store_visit_action = None
            store_visit_conversion_status = None
    else:
        # Not applicable -- no meeting was ever raised for this deal.
        meeting_store = None
        meeting_store_source = None
        store_called = None
        store_call_status = None
        store_call_date = None
        store_visit_confirmed = False
        store_visit_status = None  # N/A (not even "Not Available" -- no meeting to begin with)
        store_visit_date = None
        store_visit_action = None
        store_visit_conversion_status = None

    # --- Sale (marketing_sale), mobile-matched, honesty-gated, never predates deal ---
    sale_anchor = store_visit_date or meeting_raised_date or created_date
    sale_match = first_sale_row_for(mob10, sale_anchor) if mob10 else None
    sale_status = "Sold" if sale_match else "Not Available"
    sale_date = sale_match["date"] if sale_match else None
    sale_amount = sale_match["net_sale"] if sale_match else None
    sale_store = sale_match["company_code"] if sale_match else None
    sale_invoice = sale_match["document_no"] if sale_match else None

    # --- date-calc rules: DATE(later)-DATE(earlier), never negative, "-" if missing ---
    days_deal_to_meeting = day_diff(meeting_raised_date, created_date, flags, "negative_deal_to_meeting")
    days_meeting_to_visit = day_diff(store_visit_date, meeting_raised_date, flags, "negative_meeting_to_visit") if meeting_raised_date and store_visit_date else None
    days_meeting_to_storecall = day_diff(store_call_date, meeting_raised_date, flags, "negative_meeting_to_storecall") if meeting_raised_date else None
    days_meeting_to_sale = day_diff(sale_date, meeting_raised_date, flags, "negative_meeting_to_sale") if meeting_raised_date else None
    days_visit_to_sale = day_diff(sale_date, store_visit_date, flags, "negative_visit_to_sale") if store_visit_date else None

    rows.append({
        "deal_id": deal_id,
        "deal_name": d.get("deal_name"),
        "contact_name": d.get("contact_name"),
        "mobile": d.get("mobile"),
        "email": d.get("email"),
        "agent": agent,
        "city": address_city,
        "city_bucket": city_bucket,
        "lead_source": d.get("lead_source"),
        "stage": d.get("stage"),
        "utm_source": d.get("utm_source"),
        "utm_medium": d.get("utm_medium"),
        "utm_campaign": d.get("utm_campaign"),
        "campaign_source": d.get("campaign_source"),
        "created_date": created_date,
        "amount": to_num(d.get("amount")),

        "call1_sec": call1_sec, "call1_time": call1_time,
        "call2_sec": call2_sec, "call2_time": call2_time,
        "call3_sec": call3_sec, "call3_time": call3_time,
        "total_calls": total_calls, "total_call_seconds": total_call_seconds,
        "has_call_attempt": total_calls > 0,

        "meeting_raised": meeting_raised,
        "meeting_raised_date": meeting_raised_date,
        "meeting_event_title": meeting_event_title,
        "meeting_owner": meeting_owner,
        "meeting_venue": meeting_venue,
        "meeting_created_by": meeting_created_by,
        "meeting_description": meeting_description,

        "meeting_store": meeting_store,
        "meeting_store_source": meeting_store_source,  # "meetings_sheet_sync" | "cdc_meetings.venue" | None

        "store_visit_status": store_visit_status,  # "Visited (Confirmed)"|"No Show"|"Scheduled / Pending"|"Not a Store Visit (...)"|"Not Available"|None
        "store_visit_confirmed": store_visit_confirmed,  # bool -- the single honest attendance flag
        "store_visit_date": store_visit_date,
        "store_visit_action": store_visit_action,
        "store_visit_conversion_status": store_visit_conversion_status,

        "store_called": store_called,       # True / False / None(=Not Available)
        "store_call_status": store_call_status,  # Connected / Not Connected / None
        "store_call_date": store_call_date,

        "sale_status": sale_status,          # "Sold" | "Not Available"
        "sale_date": sale_date,
        "sale_amount": sale_amount,
        "sale_store": sale_store,
        "sale_invoice": sale_invoice,

        "days_deal_to_meeting": days_deal_to_meeting,
        "days_meeting_to_visit": days_meeting_to_visit,
        "days_meeting_to_storecall": days_meeting_to_storecall,
        "days_meeting_to_sale": days_meeting_to_sale,
        "days_visit_to_sale": days_visit_to_sale,
    })

print(f"Deal rows processed: {len(rows)}  duplicate deal_id rows: {duplicate_deal_ids}")

# ===========================================================================
# DATA QUALITY SUMMARY
# ===========================================================================
n_deals = len(rows)
n_city_known = sum(1 for r in rows if r["city"])
n_meeting_raised = sum(1 for r in rows if r["meeting_raised"])
n_call_matched_deals = sum(1 for r in rows if r["total_calls"] > 0)
n_meeting_store_from_sheet = sum(1 for r in rows if r["meeting_store_source"] == "meetings_sheet_sync")
n_meeting_store_from_venue = sum(1 for r in rows if r["meeting_store_source"] == "cdc_meetings.venue")
n_store_called_yes = sum(1 for r in rows if r["store_called"] is True)
n_store_called_no = sum(1 for r in rows if r["store_called"] is False)
n_store_called_na = sum(1 for r in rows if r["store_called"] is None and r["meeting_raised"])
n_store_visit_confirmed = sum(1 for r in rows if r["store_visit_confirmed"])
n_store_visit_no_show = sum(1 for r in rows if r["store_visit_status"] == "No Show")
n_store_visit_scheduled = sum(1 for r in rows if r["store_visit_status"] == "Scheduled / Pending")
n_store_visit_not_avail = sum(1 for r in rows if r["meeting_raised"] and r["store_visit_status"] == "Not Available")
n_sold = sum(1 for r in rows if r["sale_status"] == "Sold")
n_sold_from_visit = sum(1 for r in rows if r["store_visit_confirmed"] and r["sale_status"] == "Sold")

if ARGS.source == "live":
    # Live mode's raw Deals/Calls/Events came straight from the Zoho REST API (no cdc_meetings
    # JSON blob, no lucira_zoho_Calls table involved) -- these two BigQuery-only diagnostic
    # totals don't apply to that path, honestly reported as unavailable rather than queried
    # against a table this snapshot didn't actually use.
    mtg_total = mtg_with_what_id = mtg_resolves_deal = None
    calls_total = calls_with_what_id = None
else:
    # cdc_meetings match-rate denominator: use the ACTUAL join against Deals.id (the true test),
    # not just "has a non-null What_Id" -- re-verified live per the brief's instruction that this
    # number "moved slightly since last check due to $se_module filtering nuance."
    print("Querying cdc_meetings + Calls totals for match-rate denominators (re-verified live) ...")
    mtg_totals = run_bq_str(
        "SELECT COUNT(*) AS total, "
        "COUNTIF(JSON_VALUE(data,'$.What_Id.id') IS NOT NULL) AS with_what_id, "
        "COUNTIF(JSON_VALUE(data,'$.What_Id.id') IN (SELECT id FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Deals`)) AS resolves_deal "
        "FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`"
    )
    mtg_total = to_int(mtg_totals[0]["total"]) if mtg_totals else None
    mtg_with_what_id = to_int(mtg_totals[0]["with_what_id"]) if mtg_totals else None
    mtg_resolves_deal = to_int(mtg_totals[0]["resolves_deal"]) if mtg_totals else None

    calls_totals = run_bq_str(
        "SELECT COUNT(*) AS total, COUNTIF(what_id IS NOT NULL) AS with_what_id "
        "FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls`"
    )
    calls_total = to_int(calls_totals[0]["total"]) if calls_totals else None
    calls_with_what_id = to_int(calls_totals[0]["with_what_id"]) if calls_totals else None

# Sheet-level action/show_no_show totals (re-verified live, independent of the deal-join path)
sheet_totals = run_bq_str(
    "SELECT COUNT(*) total_rows, "
    "COUNTIF(action='Store Visit') store_visit, "
    "COUNTIF(action='Video Call') video_call, "
    "COUNTIF(action='TAH') tah, "
    "COUNTIF(action='Store Visit' AND show_no_show='Show') store_visit_confirmed, "
    "COUNTIF(show_no_show='No Show') no_show, "
    "COUNTIF(show_no_show='WIP') wip, "
    "COUNTIF(call_status IS NOT NULL) store_called "
    "FROM `lucirajewelry-prod.Lucira_Prod.meetings_sheet_sync`"
)
sh = sheet_totals[0] if sheet_totals else {}

data_quality = {
    "deal_id_uniqueness_pct": round(100 * (n_deals - duplicate_deal_ids) / n_deals, 3) if n_deals else None,
    "duplicate_deal_id_rows": duplicate_deal_ids,
    "same_day_mobile_duplicate_deals_removed": same_day_mobile_dupes_removed,
    "total_deals": n_deals,
    "city_known_count": n_city_known,
    "city_known_pct": round(100 * n_city_known / n_deals, 2) if n_deals else None,
    "call_to_deal_matched_deals": n_call_matched_deals,
    "call_to_deal_matched_pct": round(100 * n_call_matched_deals / n_deals, 2) if n_deals else None,
    "meeting_raised_count": n_meeting_raised,
    "meeting_raised_pct": round(100 * n_meeting_raised / n_deals, 2) if n_deals else None,
    "meeting_store_from_sheet": n_meeting_store_from_sheet,
    "meeting_store_from_venue_fallback": n_meeting_store_from_venue,
    "meeting_store_not_available": n_meeting_raised - n_meeting_store_from_sheet - n_meeting_store_from_venue,
    "store_visit_confirmed_deals": n_store_visit_confirmed,
    "store_visit_confirmed_sheet_rows": to_int(sh.get("store_visit_confirmed")),
    "store_visit_no_show_deals": n_store_visit_no_show,
    "store_visit_scheduled_pending_deals": n_store_visit_scheduled,
    "store_visit_not_available_deals": n_store_visit_not_avail,
    "store_called_yes": n_store_called_yes,
    "store_called_no": n_store_called_no,
    "store_called_not_available": n_store_called_na,
    "sheet_rows_total": len(sheet_rows),
    "sheet_distinct_mobiles": len(sheet_distinct_mobiles),
    "sheet_action_store_visit": to_int(sh.get("store_visit")),
    "sheet_action_video_call": to_int(sh.get("video_call")),
    "sheet_action_tah": to_int(sh.get("tah")),
    "sheet_no_show_rows": to_int(sh.get("no_show")),
    "sheet_wip_rows": to_int(sh.get("wip")),
    "sale_rows_total": len(sale_rows),
    "sale_distinct_mobiles": len(sale_distinct_mobiles),
    "sales_matched_to_deal": n_sold,
    "sales_matched_pct_of_deals": round(100 * n_sold / n_deals, 2) if n_deals else None,
    "sales_matched_from_confirmed_visit": n_sold_from_visit,
    "sales_matched_from_confirmed_visit_pct": round(100 * n_sold_from_visit / n_store_visit_confirmed, 2) if n_store_visit_confirmed else None,
    "negative_date_diff_flags": dict(flags),
    "cdc_meetings_total_rows": mtg_total,
    "cdc_meetings_with_what_id": mtg_with_what_id,
    "cdc_meetings_resolves_deal": mtg_resolves_deal,
    "cdc_meetings_to_deal_match_pct": round(100 * mtg_resolves_deal / mtg_total, 2) if mtg_total else None,
    "calls_total_rows": calls_total,
    "calls_with_what_id": calls_with_what_id,
    "calls_to_deal_match_pct": round(100 * calls_with_what_id / calls_total, 2) if calls_total else None,
    "all_meetings_total": len(all_meetings),
    "all_meetings_duplicate_ids_removed": all_meetings_dupe_ids_removed,
}

print("\n=== DATA QUALITY SUMMARY ===")
for k, v in data_quality.items():
    print(f"  {k}: {v}")

# ===========================================================================
# META
# ===========================================================================
cities = sorted(city_counter.keys(), key=lambda c: (c == "City Not Captured", -city_counter[c]))
agents = sorted(agent_counter.keys(), key=lambda a: -agent_counter[a])

dates_all = sorted(set(r["created_date"] for r in rows if r["created_date"]))

now_ist = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)

if ARGS.source == "live":
    meta_source = "live_zoho_crm+bigquery"
    meta_note = ("Deals/Calls/Meetings fetched LIVE via the Zoho CRM v8 REST Modules API "
                 "(same-minute freshness). Store Visit / Store Follow-up (meetings_sheet_sync) "
                 "and Sales (marketing_sale) are still BigQuery -- no Zoho CRM equivalent "
                 "exists for either. Rerun `python build_svci_data.py --source live` to refresh.")
    meta_source_tables = [
        "Zoho CRM Deals (live REST)", "Zoho CRM Calls (live REST)", "Zoho CRM Events (live REST, deal-linked)",
        "Zoho CRM Events (live REST, ALL meetings -- Meeting Intelligence tab)",
        "Lucira_Prod.meetings_sheet_sync", "ds_imputed_reporting.marketing_sale",
    ]
else:
    meta_source = "bigquery"
    meta_note = "Locally-embedded snapshot queried directly from BigQuery lucirajewelry-prod via bq CLI. Not live -- rerun build_svci_data.py to refresh."
    meta_source_tables = [
        "Lucira_Prod.lucira_zoho_Deals", "Lucira_Prod.lucira_zoho_Calls",
        "zoho_crm.cdc_meetings", "zoho_crm.cdc_meetings (ALL rows -- Meeting Intelligence tab)",
        "Lucira_Prod.meetings_sheet_sync", "ds_imputed_reporting.marketing_sale",
    ]

DATA = {
    "meta": {
        "source": meta_source,
        "generated_at_ist": now_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
        "note": meta_note,
        "source_tables": meta_source_tables,
        "date_min": dates_all[0] if dates_all else None,
        "date_max": dates_all[-1] if dates_all else None,
    },
    "cities": cities,
    "agents": agents,
    "data_quality": data_quality,
    "deals": rows,
    "all_meetings": all_meetings,
}

with open(OUT_JS, "w", encoding="utf-8") as f:
    f.write("/* AUTO-GENERATED by build_svci_data.py -- do not hand-edit. Rerun the script to refresh.\n")
    f.write("   Snapshot generated at " + DATA["meta"]["generated_at_ist"] + " from live BigQuery tables. */\n")
    f.write("window.SVCI_DATA = ")
    json.dump(DATA, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print("\nWrote", OUT_JS, "-", os.path.getsize(OUT_JS), "bytes")
print("Deals:", n_deals, "| Cities known:", n_city_known, f"({data_quality['city_known_pct']}%)",
      "| Meetings raised:", n_meeting_raised, "| Store Visit Confirmed:", n_store_visit_confirmed,
      "| Sales matched:", n_sold, "| All Meetings (Meeting Intelligence tab):", len(all_meetings),
      "(dupe ids removed:", all_meetings_dupe_ids_removed, ")")
