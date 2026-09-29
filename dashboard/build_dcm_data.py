#!/usr/bin/env python3
"""
Build script for the "Store City & Agent-wise Deals -> Calls -> Meetings -> Store
Follow-up -> Sales Intelligence" dashboard (dashboard/deals-calls-meetings-sales.html).

Pulls from lucirajewelry-prod via `bq query` (same auth/pattern as build_ppi_data.py /
build_spsw_data.py — no Cloud Run, no live API, no deploy):

  1. sql/dcm_build.sql        -> one row per Deal (22,819 rows) with call-attempt 1/2/3
                                  (What_Id join) and first Meeting Raised (cdc_meetings JSON).
  2. sql/dcm_meetings_sheet.sql -> raw meetings_sheet_sync (928 rows, Store Follow-up source).
  3. sql/dcm_sales.sql        -> raw marketing_sale (2,531 rows).

All cross-table joins that are mobile-only and one-to-many (sheet, sales) are resolved here
in Python with an explicit "first matching record on/after the anchor date" rule, and are
labeled everywhere as mobile-matched (not Deal-ID-matched). Writes dashboard/dcm_data.js
(window.DCM_DATA = {...}).

Re-run to refresh: `python build_dcm_data.py` (requires `bq` on PATH, authenticated for
lucirajewelry-prod).

HONESTY CONSTRAINTS (do not violate):
  - Deals.Store_Assigned is 0% populated -- never read, never referenced as working.
  - Address_City is ~11% populated -- deals with no city go in an explicit "City Not
    Captured" bucket, never dropped.
  - Calls only join via What_Id = Deal id (the validated path). No mobile-fallback for calls.
  - Meeting Store / Store Called come from meetings_sheet_sync, matched to a Deal by
    normalized last-10-digit mobile only -- partial coverage, labeled "Not Available" (not a
    fabricated No) when no match exists.
  - marketing_sale has NO Deal ID column. Sale<->Deal is mobile-match only, and a sale dated
    before the deal's creation is never counted as caused by it.
  - Every day-diff is DATE(later)-DATE(earlier), never negative. A negative diff is logged as
    a data-quality flag and rendered as null/"-" everywhere downstream.
"""
import argparse, json, os, re, subprocess, sys, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_DIR = os.path.join(HERE, "sql")
OUT_JS = os.path.join(HERE, "dcm_data.js")

BQ_EXE = "bq.cmd" if os.name == "nt" else "bq"

argp = argparse.ArgumentParser(description="Build dcm_data.js")
argp.add_argument("--source", choices=["bigquery", "live"], default="bigquery",
                   help="'bigquery' (default, unchanged): Deals/Calls/Meetings via bq CLI. "
                        "'live': Deals/Calls/Meetings via the Zoho CRM v8 REST Modules API "
                        "(same-minute freshness; requires etl/.zoho.env). Store Follow-up "
                        "(meetings_sheet_sync) and Sales (marketing_sale) are ALWAYS BigQuery "
                        "-- no Zoho CRM equivalent exists for either.")
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


def dur_label(sec):
    """'N | Nsec (Nmin Nsec)' format per spec. sec may be None (no such call attempt)."""
    if sec is None:
        return None
    sec = int(sec)
    m, s = divmod(sec, 60)
    return "%ds (%dmin %ds)" % (sec, m, s)


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
        kept.append(group[-1])  # latest by timestamp, then by highest id
        removed += len(group) - 1
    return kept, removed


if ARGS.source == "live":
    from zoho_live_fetch import fetch_zoho_live, now_ist_str
    print("Step 1/3: fetching Deals + Calls + Meetings LIVE via Zoho CRM v8 REST Modules API ...")
    deals_raw = fetch_zoho_live(include_meeting_extra=False)
    print(f"  {len(deals_raw)} deal rows (live)")
else:
    print("Step 1/3: querying Deals + Calls(What_Id) + Meetings(cdc_meetings) ...")
    deals_raw = run_bq(os.path.join(SQL_DIR, "dcm_build.sql"))
    print(f"  {len(deals_raw)} deal rows")

deals_raw, same_day_mobile_dupes_removed = dedup_same_day_mobile_deals(deals_raw)
print(f"  Same-mobile/same-day dedup: removed {same_day_mobile_dupes_removed} earlier duplicate(s), kept latest -> {len(deals_raw)} deal rows")

print("Step 2/3: querying meetings_sheet_sync (Store Follow-up source) ...")
sheet_raw = run_bq(os.path.join(SQL_DIR, "dcm_meetings_sheet.sql"))
print(f"  {len(sheet_raw)} sheet rows")

print("Step 3/3: querying marketing_sale ...")
sale_raw = run_bq(os.path.join(SQL_DIR, "dcm_sales.sql"))
print(f"  {len(sale_raw)} sale rows")

flags = {}  # data-quality flag counters, e.g. negative date diffs

# ---------------------------------------------------------------------------
# Normalize SHEET (Store Follow-up) rows, index by mobile10
# ---------------------------------------------------------------------------
sheet_rows = []
for r in sheet_raw:
    mob10 = norm_mobile(r.get("mobile"))
    sheet_rows.append({
        "mobile10": mob10,
        "meeting_date": date_only(r.get("meeting_date")),
        "store": (r.get("store") or "").strip() or None,
        "call_status": r.get("call_status"),  # "Connected" / "Not Connected" / None
        "agent": r.get("agent"),
        "customer_name": r.get("customer_name"),
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
    meeting date) -- never count a sale that predates the deal as caused by it."""
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

    # --- Store Follow-up (meetings_sheet_sync), mobile-matched, honesty-gated ---
    # Meeting Store / Store Called only apply to deals with a Meeting Raised -- for deals with
    # no meeting, "store follow-up" is not applicable (not the same as "no record found").
    if meeting_raised:
        sheet_match = first_sheet_row_for(mob10, meeting_raised_date) if mob10 else None
        if sheet_match:
            meeting_store = sheet_match["store"] or (meeting_venue if meeting_venue else None)
            meeting_store_source = "meetings_sheet_sync" if sheet_match["store"] else ("cdc_meetings.venue" if meeting_venue else None)
            store_called = sheet_match["call_status"] is not None
            store_call_status = sheet_match["call_status"]  # Connected / Not Connected / None
            store_call_date = sheet_match["meeting_date"]
        else:
            # No sheet match at all -- fall back to cdc_meetings venue for Meeting Store only,
            # Store Called is honestly "Not Available" (never fabricated as No).
            meeting_store = meeting_venue if meeting_venue else None
            meeting_store_source = "cdc_meetings.venue" if meeting_venue else None
            store_called = None  # None = Not Available (no record), distinct from False
            store_call_status = None
            store_call_date = None
    else:
        # Not applicable -- no meeting was ever raised for this deal.
        meeting_store = None
        meeting_store_source = None
        store_called = None
        store_call_status = None
        store_call_date = None

    # --- Sale (marketing_sale), mobile-matched, honesty-gated, never predates deal ---
    sale_anchor = meeting_raised_date or created_date
    sale_match = first_sale_row_for(mob10, sale_anchor) if mob10 else None
    sale_status = "Sold" if sale_match else "Not Available"
    sale_date = sale_match["date"] if sale_match else None
    sale_amount = sale_match["net_sale"] if sale_match else None
    sale_store = sale_match["company_code"] if sale_match else None
    sale_invoice = sale_match["document_no"] if sale_match else None

    # --- date-calc rules: DATE(later)-DATE(earlier), never negative, "-" if missing ---
    days_deal_to_meeting = day_diff(meeting_raised_date, created_date, flags, "negative_deal_to_meeting")
    days_meeting_to_sale = day_diff(sale_date, meeting_raised_date, flags, "negative_meeting_to_sale") if meeting_raised_date else None
    days_meeting_to_storecall = day_diff(store_call_date, meeting_raised_date, flags, "negative_meeting_to_storecall") if meeting_raised_date else None

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
        "meeting_owner": meeting_owner,
        "meeting_venue": meeting_venue,

        "meeting_store": meeting_store,
        "meeting_store_source": meeting_store_source,  # "meetings_sheet_sync" | "cdc_meetings.venue" | None
        "store_called": store_called,       # True / False / None(=Not Available)
        "store_call_status": store_call_status,  # Connected / Not Connected / None
        "store_call_date": store_call_date,

        "sale_status": sale_status,          # "Sold" | "Not Available"
        "sale_date": sale_date,
        "sale_amount": sale_amount,
        "sale_store": sale_store,
        "sale_invoice": sale_invoice,

        "days_deal_to_meeting": days_deal_to_meeting,
        "days_meeting_to_sale": days_meeting_to_sale,
        "days_meeting_to_storecall": days_meeting_to_storecall,
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
n_store_called_na = sum(1 for r in rows if r["store_called"] is None)
n_sold = sum(1 for r in rows if r["sale_status"] == "Sold")

# cdc_meetings match-rate denominator: total meeting rows vs how many resolve a real Deal id
# (dcm_build.sql only ever selects meetings whose What_Id.id is non-null; the WHERE clause on
# the deal_id also drops meetings that carry a What_Id.id not present in Deals -- get the true
# totals with a small standalone query so this rate is honest, not inferred from the join).
if ARGS.source == "live":
    # Live mode's raw Deals/Calls/Events already came straight from the Zoho REST API (no
    # cdc_meetings JSON blob, no lucira_zoho_Calls table involved) -- these two BigQuery-only
    # diagnostic totals don't apply to that path, so they're honestly reported as unavailable
    # rather than run against a table this snapshot didn't actually use.
    mtg_total = mtg_with_what_id = calls_total = calls_with_what_id = None
else:
    # cdc_meetings match-rate denominator: total meeting rows vs how many resolve a real Deal id
    # (dcm_build.sql only ever selects meetings whose What_Id.id is non-null; the WHERE clause on
    # the deal_id also drops meetings that carry a What_Id.id not present in Deals -- get the true
    # totals with a small standalone query so this rate is honest, not inferred from the join).
    print("Querying cdc_meetings + Calls totals for match-rate denominators ...")
    mtg_totals_sql = (
        "SELECT COUNT(*) AS total, "
        "COUNTIF(JSON_VALUE(data,'$.What_Id.id') IS NOT NULL) AS with_what_id "
        "FROM `lucirajewelry-prod.zoho_crm.cdc_meetings`"
    )
    mtg_totals_path = os.path.join(SQL_DIR, "_tmp_mtg_totals.sql")
    with open(mtg_totals_path, "w", encoding="utf-8") as fh:
        fh.write(mtg_totals_sql)
    mtg_totals = run_bq(mtg_totals_path)
    os.remove(mtg_totals_path)
    mtg_total = to_int(mtg_totals[0]["total"]) if mtg_totals else None
    mtg_with_what_id = to_int(mtg_totals[0]["with_what_id"]) if mtg_totals else None

    calls_totals_sql = (
        "SELECT COUNT(*) AS total, COUNTIF(what_id IS NOT NULL) AS with_what_id "
        "FROM `lucirajewelry-prod.Lucira_Prod.lucira_zoho_Calls`"
    )
    calls_totals_path = os.path.join(SQL_DIR, "_tmp_calls_totals.sql")
    with open(calls_totals_path, "w", encoding="utf-8") as fh:
        fh.write(calls_totals_sql)
    calls_totals = run_bq(calls_totals_path)
    os.remove(calls_totals_path)
    calls_total = to_int(calls_totals[0]["total"]) if calls_totals else None
    calls_with_what_id = to_int(calls_totals[0]["with_what_id"]) if calls_totals else None

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
    "store_called_yes": n_store_called_yes,
    "store_called_no": n_store_called_no,
    "store_called_not_available": n_store_called_na,
    "sheet_rows_total": len(sheet_rows),
    "sheet_distinct_mobiles": len(sheet_distinct_mobiles),
    "sale_rows_total": len(sale_rows),
    "sale_distinct_mobiles": len(sale_distinct_mobiles),
    "sales_matched_to_deal": n_sold,
    "sales_matched_pct_of_deals": round(100 * n_sold / n_deals, 2) if n_deals else None,
    "negative_date_diff_flags": dict(flags),
    "cdc_meetings_total_rows": mtg_total,
    "cdc_meetings_with_what_id": mtg_with_what_id,
    "cdc_meetings_to_deal_match_pct": round(100 * mtg_with_what_id / mtg_total, 2) if mtg_total else None,
    "calls_total_rows": calls_total,
    "calls_with_what_id": calls_with_what_id,
    "calls_to_deal_match_pct": round(100 * calls_with_what_id / calls_total, 2) if calls_total else None,
}

print("\n=== DATA QUALITY SUMMARY ===")
for k, v in data_quality.items():
    print(f"  {k}: {v}")

# ===========================================================================
# AGGREGATES for the dashboard (precomputed; dashboard still cross-filters client-side
# over the full row-level `deals` array below -- these are just fast top-level summaries)
# ===========================================================================
cities = sorted(city_counter.keys(), key=lambda c: (c == "City Not Captured", -city_counter[c]))
agents = sorted(agent_counter.keys(), key=lambda a: -agent_counter[a])

dates_all = sorted(set(r["created_date"] for r in rows if r["created_date"]))

now_ist = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)

if ARGS.source == "live":
    meta_source = "live_zoho_crm+bigquery"
    meta_note = ("Deals/Calls/Meetings fetched LIVE via the Zoho CRM v8 REST Modules API "
                 "(same-minute freshness). Store Follow-up (meetings_sheet_sync) and Sales "
                 "(marketing_sale) are still BigQuery -- no Zoho CRM equivalent exists for "
                 "either. Rerun `python build_dcm_data.py --source live` to refresh.")
    meta_source_tables = [
        "Zoho CRM Deals (live REST)", "Zoho CRM Calls (live REST)", "Zoho CRM Events (live REST)",
        "Lucira_Prod.meetings_sheet_sync", "ds_imputed_reporting.marketing_sale",
    ]
else:
    meta_source = "bigquery"
    meta_note = "Locally-embedded snapshot queried directly from BigQuery lucirajewelry-prod via bq CLI. Not live -- rerun build_dcm_data.py to refresh."
    meta_source_tables = [
        "Lucira_Prod.lucira_zoho_Deals", "Lucira_Prod.lucira_zoho_Calls",
        "zoho_crm.cdc_meetings", "Lucira_Prod.meetings_sheet_sync",
        "ds_imputed_reporting.marketing_sale",
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
}

with open(OUT_JS, "w", encoding="utf-8") as f:
    f.write("/* AUTO-GENERATED by build_dcm_data.py -- do not hand-edit. Rerun the script to refresh.\n")
    f.write("   Snapshot generated at " + DATA["meta"]["generated_at_ist"] + " from live BigQuery tables. */\n")
    f.write("window.DCM_DATA = ")
    json.dump(DATA, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print("\nWrote", OUT_JS, "-", os.path.getsize(OUT_JS), "bytes")
print("Deals:", n_deals, "| Cities known:", n_city_known, f"({data_quality['city_known_pct']}%)",
      "| Meetings raised:", n_meeting_raised, "| Sales matched:", n_sold)
