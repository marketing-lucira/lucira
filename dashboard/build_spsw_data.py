#!/usr/bin/env python3
"""
Build script for the Store x Product Scan/Sale/Walk-in Intelligence dashboard
(dashboard/store-product-scan-sales.html).

Pulls three BigQuery tables via `bq query` into local raw JSON (see RAW_DIR),
then aggregates everything the dashboard needs into dashboard/spsw_data.js
(window.SPSW_DATA = {...}), following the ppi_data.js / walkin_source_data.js
locally-embedded-snapshot convention used elsewhere in this repo.

Re-run to refresh: `python build_spsw_data.py` (requires `bq` on PATH and an
authenticated gcloud session with access to lucirajewelry-prod).

HONESTY CONSTRAINTS (do not violate — see task brief this was built from):
  - Pos.estimation_item_scan.sku is NOT a product SKU (it's a doc/estimation
    reference). Product identity on the scan side is the OPAQUE item_id only.
  - There is a VERIFIED 0% string/int overlap between scan item_id/sku and any
    sales-side SKU field. No per-SKU scan<->sale join exists. Never fabricate one.
  - The only two valid cross-table links are:
      (a) party_id between scan and sale (low coverage - only rows where scan.party_id is set)
      (b) phone number between Walkin_marge and marketing_sale (good coverage)
  - Walk-in store_code values that are null/"HWI"/"Amazon" are UNMAPPED STORE,
    kept as a separate bucket, never merged into a real store or dropped.
"""
import json, re, datetime, subprocess, sys, os, collections, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = r"C:/Users/ADMIN/AppData/Local/Temp/claude/c--Users-ADMIN--antigravity-ide-dashboard/8ea8a174-083f-4715-98be-8d9adff4dfa5/scratchpad/spsw_raw"
OUT_JS = os.path.join(HERE, "spsw_data.js")

STORE_MASTER = [
    {"company_id":1,"company_name":"Divinecarat Lifestyles Private Limited","company_code":"HO","city":"Mumbai","state":"Maharashtra"},
    {"company_id":2,"company_name":"Chembur Mumbai CoCo Store","company_code":"CS1","city":"Mumbai","state":"Maharashtra"},
    {"company_id":4,"company_name":"JM Pune CoCo Store","company_code":"PN1","city":"Pune","state":"Maharashtra"},
    {"company_id":5,"company_name":"Sky City Borivali CoCo Store","company_code":"BO1","city":"Mumbai","state":"Maharashtra"},
    {"company_id":6,"company_name":"Noida Sector 18 CoCo Store","company_code":"N18","city":"Noida","state":"Uttar Pradesh"},
    {"company_id":7,"company_name":"HWI VENTURES","company_code":"FCS","city":"Mumbai","state":"Maharashtra"},
    {"company_id":8,"company_name":"Paschim Vihar Lucira Jewelry","company_code":"PV1","city":"Delhi","state":"Delhi"},
    {"company_id":9,"company_name":"Lagpat Nagar Delhi, Lucira Jewelry","company_code":"LPN","city":"Delhi","state":"Delhi"},
]
CODE_TO_NAME = {s["company_code"]: s["company_name"] for s in STORE_MASTER}
ID_TO_CODE   = {s["company_id"]: s["company_code"] for s in STORE_MASTER}
CODE_TO_ID   = {s["company_code"]: s["company_id"] for s in STORE_MASTER}
CODE_TO_CITY = {s["company_code"]: s["city"] for s in STORE_MASTER}
CODE_TO_STATE= {s["company_code"]: s["state"] for s in STORE_MASTER}

def norm_phone(m):
    if not m: return None
    d = re.sub(r"\D", "", str(m))
    if not d: return None
    return d[-10:] if len(d) >= 10 else d

def load(name):
    p = os.path.join(RAW_DIR, name)
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)

def to_num(v, default=0.0):
    if v is None or v == "": return default
    try: return float(v)
    except Exception: return default

def to_int(v):
    if v is None or v == "": return None
    try: return int(float(v))
    except Exception: return None

def dow_name(dstr):
    try:
        d = datetime.date.fromisoformat(dstr[:10])
        return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][d.weekday()]
    except Exception:
        return None

def month_key(dstr):
    return dstr[:7] if dstr else None

print("Loading raw snapshot files...")
scan_raw   = load("scan.json")
sale_raw   = load("sale.json")
walkin_raw = load("walkin.json")
print(f"  scan rows: {len(scan_raw)}  sale rows: {len(sale_raw)}  walkin rows: {len(walkin_raw)}")

# ---------------------------------------------------------------------------
# Normalize SCAN rows
# ---------------------------------------------------------------------------
scans = []
for r in scan_raw:
    cid = to_int(r.get("company_id"))
    code = ID_TO_CODE.get(cid)
    d = (r.get("date") or "")[:10]
    scans.append({
        "id": r.get("id"),
        "item_id": to_int(r.get("item_id")),
        "date": d,
        "raw_sku_field": r.get("sku"),      # NOT a product sku - kept only for data-quality display
        "company_id": cid,
        "store_code": code,                 # None if company_id didn't map (shouldn't happen - master is exhaustive)
        "party_id": to_int(r.get("party_id")),
    })
scan_dates = sorted([s["date"] for s in scans if s["date"]])

# ---------------------------------------------------------------------------
# Normalize SALE rows
# ---------------------------------------------------------------------------
sales = []
for r in sale_raw:
    code = r.get("company_code")
    d = (r.get("Transaction_Date") or "")[:10]
    net = to_num(r.get("net_sale"), 0.0)
    pieces = to_int(r.get("pieces")) or 0
    cus_mobile = norm_phone(r.get("Cus_mobile")) or norm_phone(r.get("mobile1"))
    sales.append({
        "company_code": code,
        "document_no": r.get("document_no"),
        "date": d,
        "party_id": to_int(r.get("party_id")),
        "email": r.get("email"),
        "phone": cus_mobile,
        "party_name": r.get("party_name"),
        "full_sku": r.get("Full_sku"),
        "item_code": r.get("half_sku"),  # ERP base style code (BigQuery column "half_sku") - the one product identifier surfaced everywhere in this dashboard
        "item_group_name": r.get("item_group_name"),
        "shape_name": r.get("shape_name"),
        "metal_name": r.get("metal_name"),
        "karat_name": r.get("karat_name"),
        "style_name": r.get("style_name"),
        "collection_name": r.get("collection_name"),
        "brand_code": r.get("brand_code"),
        "net_sale": net,
        "pieces": pieces,
    })
sale_dates = sorted([s["date"] for s in sales if s["date"]])

# ---------------------------------------------------------------------------
# Normalize WALK-IN rows
# ---------------------------------------------------------------------------
UNMAPPED_LABELS = {None, "", "HWI", "Amazon"}
walkins = []
for r in walkin_raw:
    raw_code = r.get("store_code")
    code = raw_code if raw_code in CODE_TO_NAME else None
    unmapped_reason = None
    if code is None:
        unmapped_reason = "NULL" if (raw_code is None or raw_code == "") else raw_code
    wd = r.get("walkin_date") or ""
    date_only = wd[:10] if wd else None
    walkins.append({
        "event_name": r.get("event_name"),
        "store_code": code,
        "unmapped_reason": unmapped_reason,
        "customer_name": r.get("customer_name"),
        "phone": norm_phone(r.get("phone")),
        "email": r.get("email"),
        "walkin_date": wd,
        "date": date_only,
        "dow": dow_name(date_only) if date_only else None,
        "month": month_key(date_only) if date_only else None,
        "status_flag": r.get("state"),   # "None"/"Completed" - NOT geography, see honesty note
        "RW": to_int(r.get("RW")),
    })
walkin_dates = sorted([w["date"] for w in walkins if w["date"]])

# ===========================================================================
# CROSS-TABLE LINKS
# ===========================================================================

# --- (a) scan <-> sale via party_id (LOW COVERAGE, measured) ---
scan_party_ids = set(s["party_id"] for s in scans if s["party_id"] is not None)
sale_party_ids = set(s["party_id"] for s in sales if s["party_id"] is not None)
scan_sale_party_match = scan_party_ids & sale_party_ids
scans_with_party = [s for s in scans if s["party_id"] is not None]
matched_scan_rows = [s for s in scans_with_party if s["party_id"] in sale_party_ids]

sales_by_party = collections.defaultdict(list)
for s in sales:
    if s["party_id"] is not None:
        sales_by_party[s["party_id"]].append(s)

party_linked_rows = []
for sc in matched_scan_rows:
    linked_sales = sales_by_party.get(sc["party_id"], [])
    total_net = sum(x["net_sale"] for x in linked_sales)
    party_linked_rows.append({
        "party_id": sc["party_id"],
        "scan_item_id": sc["item_id"],
        "scan_date": sc["date"],
        "scan_store": sc["store_code"],
        "linked_sale_count": len(linked_sales),
        "linked_sale_net": round(total_net, 2),
    })

# --- (b) walkin <-> sale via phone (GOOD COVERAGE, measured conversion) ---
sales_by_phone = collections.defaultdict(list)
for s in sales:
    if s["phone"]:
        sales_by_phone[s["phone"]].append(s)

walkin_matched = 0
walkin_conv_rows = []
for w in walkins:
    linked = sales_by_phone.get(w["phone"], []) if w["phone"] else []
    if linked:
        walkin_matched += 1
    net = sum(x["net_sale"] for x in linked)
    walkin_conv_rows.append({
        "store_code": w["store_code"] or "UNMAPPED",
        "date": w["date"],
        "phone": w["phone"],
        "matched": bool(linked),
        "matched_orders": len(set(x["document_no"] for x in linked)),
        "matched_net": round(net, 2),
    })

# ===========================================================================
# STORE-LEVEL AGGREGATES (Store Performance + Scan-vs-Sale correlation)
# ===========================================================================
def store_scan_agg(code):
    rows = [s for s in scans if s["store_code"] == code]
    unique_items = set(s["item_id"] for s in rows if s["item_id"] is not None)
    parties = set(s["party_id"] for s in rows if s["party_id"] is not None)
    ds = sorted(s["date"] for s in rows if s["date"])
    return {
        "total_scan_events": len(rows),
        "unique_scanned_item_ids": len(unique_items),
        "scans_with_party_id": sum(1 for s in rows if s["party_id"] is not None),
        "unique_parties_scanning": len(parties),
        "first_scan": ds[0] if ds else None,
        "last_scan": ds[-1] if ds else None,
    }

def store_sale_agg(code):
    rows = [s for s in sales if s["company_code"] == code]
    orders = set(s["document_no"] for s in rows)
    unique_skus = set(s["item_code"] for s in rows if s["item_code"])
    net = sum(s["net_sale"] for s in rows)
    pieces = sum(s["pieces"] for s in rows)
    ds = sorted(s["date"] for s in rows if s["date"])
    return {
        "total_sales_value": round(net, 2),
        "units_sold": pieces,
        "orders": len(orders),
        "unique_skus_sold": len(unique_skus),
        "aov": round(net/len(orders), 2) if orders else None,
        "first_sale": ds[0] if ds else None,
        "last_sale": ds[-1] if ds else None,
    }

def store_walkin_agg(code):
    rows = [w for w in walkins if (w["store_code"] or "UNMAPPED") == code]
    uniq_cust = set(w["phone"] for w in rows if w["phone"])
    return {"walkins": len(rows), "unique_customers": len(uniq_cust)}

store_perf = []
for s in STORE_MASTER:
    code = s["company_code"]
    sc = store_scan_agg(code)
    sl = store_sale_agg(code)
    wk = store_walkin_agg(code)
    sales_per_walkin = round(sl["total_sales_value"]/wk["walkins"], 2) if wk["walkins"] else None
    store_perf.append({
        "company_id": s["company_id"], "code": code, "name": s["company_name"],
        "city": s["city"], "state": s["state"],
        **{f"scan_{k}": v for k, v in sc.items()},
        **{f"sale_{k}": v for k, v in sl.items()},
        **{f"walkin_{k}": v for k, v in wk.items()},
        "sales_per_walkin": sales_per_walkin,
    })

unmapped_walkin_agg = store_walkin_agg("UNMAPPED")
unmapped_reason_counts = collections.Counter(w["unmapped_reason"] for w in walkins if w["store_code"] is None)

# ===========================================================================
# EXECUTIVE / GLOBAL KPIs
# ===========================================================================
total_sales_value = round(sum(s["net_sale"] for s in sales), 2)
total_orders = len(set(s["document_no"] for s in sales))
total_units = sum(s["pieces"] for s in sales)
total_walkins = len(walkins)
total_walkin_unique_customers = len(set(w["phone"] for w in walkins if w["phone"]))
total_scan_events = len(scans)
unique_products_scanned = len(set(s["item_id"] for s in scans if s["item_id"] is not None))
unique_products_sold = len(set(s["item_code"] for s in sales if s["item_code"]))
sales_per_walkin_overall = round(total_sales_value/total_walkins, 2) if total_walkins else None

top_store_by_sales = max(store_perf, key=lambda r: r["sale_total_sales_value"])["code"] if store_perf else None

sku_sales_agg = collections.defaultdict(lambda: {"net":0.0,"pieces":0,"orders":set(),"item_group_name":None,"style_name":None,"metal_name":None,"karat_name":None,"collection_name":None})
for s in sales:
    if not s["item_code"]: continue
    a = sku_sales_agg[s["item_code"]]
    a["net"] += s["net_sale"]; a["pieces"] += s["pieces"]; a["orders"].add(s["document_no"])
    for f in ("item_group_name","style_name","metal_name","karat_name","collection_name"):
        if not a[f] and s[f]: a[f] = s[f]
top_product_by_sales = max(sku_sales_agg.items(), key=lambda kv: kv[1]["net"])[0] if sku_sales_agg else None

# ===========================================================================
# DATE-RANGE-FILTERABLE DAY-GRAIN ROWS (client will filter/aggregate in JS)
# ===========================================================================
sales_daily = collections.defaultdict(lambda: {"net":0.0,"pieces":0,"orders":set()})
for s in sales:
    if not s["date"]: continue
    k = (s["date"], s["company_code"])
    a = sales_daily[k]
    a["net"] += s["net_sale"]; a["pieces"] += s["pieces"]; a["orders"].add(s["document_no"])
sales_daily_rows = [{"date":k[0], "store_code":k[1], "net_sale":round(v["net"],2), "pieces":v["pieces"], "orders":len(v["orders"])} for k,v in sales_daily.items()]

scan_daily = collections.defaultdict(lambda: {"events":0, "items":set()})
for s in scans:
    if not s["date"]: continue
    k = (s["date"], s["store_code"] or "UNMAPPED")
    a = scan_daily[k]
    a["events"] += 1
    if s["item_id"] is not None: a["items"].add(s["item_id"])
scan_daily_rows = [{"date":k[0], "store_code":k[1], "scan_events":v["events"], "unique_items":len(v["items"])} for k,v in scan_daily.items()]

walkin_daily = collections.defaultdict(lambda: {"count":0, "cust":set()})
for w in walkins:
    if not w["date"]: continue
    k = (w["date"], w["store_code"] or "UNMAPPED")
    a = walkin_daily[k]
    a["count"] += 1
    if w["phone"]: a["cust"].add(w["phone"])
walkin_daily_rows = [{"date":k[0], "store_code":k[1], "walkins":v["count"], "unique_customers":len(v["cust"])} for k,v in walkin_daily.items()]

# walk-in by day-of-week / month (aggregate across whole range for tab 5)
walkin_by_dow = collections.Counter(w["dow"] for w in walkins if w["dow"])
walkin_by_month = collections.Counter(w["month"] for w in walkins if w["month"])

# ===========================================================================
# PRODUCT SCAN ANALYSIS (opaque item_id grain) - tab 3
# ===========================================================================
item_scan_agg = collections.defaultdict(lambda: {"events":0, "stores":collections.Counter(), "dates":[], "parties":set()})
for s in scans:
    if s["item_id"] is None: continue
    a = item_scan_agg[s["item_id"]]
    a["events"] += 1
    if s["store_code"]: a["stores"][s["store_code"]] += 1
    if s["date"]: a["dates"].append(s["date"])
    if s["party_id"] is not None: a["parties"].add(s["party_id"])

top_scanned_items = []
for item_id, a in item_scan_agg.items():
    ds = sorted(a["dates"])
    top_scanned_items.append({
        "item_id": item_id,
        "scan_events": a["events"],
        "unique_parties_scanning": len(a["parties"]),
        "first_scan": ds[0] if ds else None,
        "last_scan": ds[-1] if ds else None,
        "top_store": a["stores"].most_common(1)[0][0] if a["stores"] else None,
        "store_breakdown": dict(a["stores"]),
    })
top_scanned_items.sort(key=lambda r: -r["scan_events"])

scans_with_party_count = sum(1 for s in scans if s["party_id"] is not None)

# ===========================================================================
# STORE x SKU (top-N) HEATMAP - tab 6
# ===========================================================================
TOP_N_SKU = 25
top_skus_for_heatmap = sorted(sku_sales_agg.items(), key=lambda kv: -kv[1]["net"])[:TOP_N_SKU]
heatmap_skus = [k for k,_ in top_skus_for_heatmap]
heatmap_cells = collections.defaultdict(lambda: {"net":0.0,"pieces":0,"orders":set()})
for s in sales:
    if s["item_code"] not in heatmap_skus: continue
    k = (s["item_code"], s["company_code"])
    a = heatmap_cells[k]
    a["net"] += s["net_sale"]; a["pieces"] += s["pieces"]; a["orders"].add(s["document_no"])
heatmap_rows = [{"item_code":k[0], "store_code":k[1], "net_sale":round(v["net"],2), "pieces":v["pieces"], "orders":len(v["orders"])} for k,v in heatmap_cells.items()]

# ===========================================================================
# OPPORTUNITY ANALYSIS - tab 7 (store-grain only, no per-SKU scan exists)
# ===========================================================================
def rank(items, key, reverse=False):
    s = sorted(items, key=key, reverse=reverse)
    return {id(o): i for i,o in enumerate(s)}

wr = rank(store_perf, key=lambda r: r["walkin_walkins"], reverse=True)   # rank 0 = highest walkins
sr = rank(store_perf, key=lambda r: r["sale_total_sales_value"], reverse=True)
scr = rank(store_perf, key=lambda r: r["scan_total_scan_events"], reverse=True)
n_stores = len(store_perf)
opportunities = []
for r in store_perf:
    w_rank, s_rank, sc_rank = wr[id(r)], sr[id(r)], scr[id(r)]
    flags = []
    if w_rank < n_stores/2 and s_rank >= n_stores/2:
        flags.append("High walk-in, low sales — conversion problem at this store")
    if sc_rank >= n_stores/2 and s_rank < n_stores/2:
        flags.append("Low scan volume, high sales — sales outrunning in-store product engagement (or scanning under-used)")
    if w_rank < n_stores/2 and sc_rank >= n_stores/2:
        flags.append("High walk-in, low scan volume — staff/customers may be under-using the scan process")
    if not flags:
        flags.append("No major imbalance flagged")
    opportunities.append({"code": r["code"], "name": r["name"], "walkin_rank": w_rank+1, "sale_rank": s_rank+1, "scan_rank": sc_rank+1, "flags": flags})

# ===========================================================================
# DATA QUALITY - tab 8
# ===========================================================================
data_quality = {
    "scan_row_count": len(scans),
    "sale_row_count": len(sales),
    "walkin_row_count": len(walkins),
    "scan_date_range": [scan_dates[0], scan_dates[-1]] if scan_dates else [None,None],
    "sale_date_range": [sale_dates[0], sale_dates[-1]] if sale_dates else [None,None],
    "walkin_date_range": [walkin_dates[0], walkin_dates[-1]] if walkin_dates else [None,None],
    "scan_party_id_populated": scans_with_party_count,
    "scan_party_id_populated_pct": round(100*scans_with_party_count/len(scans),2) if scans else None,
    "scan_sale_party_overlap_distinct_parties": len(scan_sale_party_match),
    "scan_sale_party_matched_scan_rows": len(matched_scan_rows),
    "scan_sale_sku_overlap_verified": 0,
    "walkin_unmapped_store_rows": unmapped_walkin_agg["walkins"],
    "walkin_unmapped_store_unique_customers": unmapped_walkin_agg["unique_customers"],
    "walkin_unmapped_reason_breakdown": dict(unmapped_reason_counts),
    "walkin_phone_populated": sum(1 for w in walkins if w["phone"]),
    "walkin_phone_matched_to_sale": walkin_matched,
    "walkin_phone_matched_pct": round(100*walkin_matched/len(walkins),2) if walkins else None,
    "sale_party_id_populated": sum(1 for s in sales if s["party_id"] is not None),
    "sale_phone_populated": sum(1 for s in sales if s["phone"]),
    "sale_item_code_distinct": len(set(s["item_code"] for s in sales if s["item_code"])),
    "sale_full_sku_distinct": len(set(s["full_sku"] for s in sales if s["full_sku"])),
    "scan_item_id_distinct": len(set(s["item_id"] for s in scans if s["item_id"] is not None)),
}

# ===========================================================================
# ASSEMBLE FINAL PAYLOAD
# ===========================================================================
now_ist = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)

DATA = {
    "meta": {
        "generated_at_ist": now_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
        "note": "Locally-embedded data snapshot (queried directly from BigQuery lucirajewelry-prod via bq CLI). Not a live/continuously-refreshing feed — rerun build_spsw_data.py to refresh.",
        "source_tables": [
            "Pos.estimation_item_scan", "ds_imputed_reporting.marketing_sale",
            "ds_imputed_reporting.Walkin_marge", "ornaverse_erp_master.company/cities/states"
        ],
    },
    "store_master": STORE_MASTER,
    "kpi": {
        "total_sales_value": total_sales_value,
        "total_orders": total_orders,
        "total_units_sold": total_units,
        "total_walkins": total_walkins,
        "total_walkin_unique_customers": total_walkin_unique_customers,
        "total_scan_events": total_scan_events,
        "unique_products_scanned_item_id": unique_products_scanned,
        "unique_products_sold_item_code": unique_products_sold,
        "sales_per_walkin": sales_per_walkin_overall,
        "top_store_by_sales": top_store_by_sales,
        "top_product_by_sales_item_code": top_product_by_sales,
        "walkin_to_sale_matched": walkin_matched,
        "walkin_to_sale_matched_pct": round(100*walkin_matched/total_walkins,2) if total_walkins else None,
    },
    "store_perf": store_perf,
    "sales_daily": sales_daily_rows,
    "scan_daily": scan_daily_rows,
    "walkin_daily": walkin_daily_rows,
    "walkin_by_dow": dict(walkin_by_dow),
    "walkin_by_month": dict(walkin_by_month),
    "top_scanned_items": top_scanned_items,  # uncapped - only 708 distinct item_ids, tiny
    "top_products_sold": [{"item_code":k, "net_sale":round(v["net"],2), "pieces":v["pieces"], "orders":len(v["orders"]),
                            "item_group_name":v["item_group_name"], "style_name":v["style_name"], "metal_name":v["metal_name"],
                            "karat_name":v["karat_name"], "collection_name":v["collection_name"]}
                           for k,v in sorted(sku_sales_agg.items(), key=lambda kv:-kv[1]["net"])],  # uncapped - only ~1028 distinct item codes, tiny
    "heatmap": {"skus": heatmap_skus, "stores": [s["company_code"] for s in STORE_MASTER], "cells": heatmap_rows},
    "party_linked_scan_sale": party_linked_rows,
    "walkin_sale_conversion_rows": walkin_conv_rows,  # uncapped (renamed from *_sample) - only 2877 rows, needed in full for the date/store filter to work correctly on Walk-in to Sale conversion
    "opportunities": opportunities,
    "data_quality": data_quality,
    "sale_rows_raw_sample": [ {k:s[k] for k in ("date","company_code","document_no","item_code","full_sku","net_sale","pieces","item_group_name","phone")} for s in sales ],
    "scan_rows_raw_sample": [ {k:s[k] for k in ("date","store_code","item_id","party_id")} for s in scans ],
    "walkin_rows_raw_sample": [ {k:w[k] for k in ("date","store_code","unmapped_reason","phone","dow","month")} for w in walkins ],
}

with open(OUT_JS, "w", encoding="utf-8") as f:
    f.write("/* AUTO-GENERATED by build_spsw_data.py — do not hand-edit. Rerun the script to refresh.\n")
    f.write("   Snapshot generated at " + DATA["meta"]["generated_at_ist"] + " from live BigQuery tables. */\n")
    f.write("window.SPSW_DATA = ")
    json.dump(DATA, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print("Wrote", OUT_JS)
print("total_sales_value =", total_sales_value, "total_orders =", total_orders,
      "total_walkins =", total_walkins, "total_scan_events =", total_scan_events,
      "walkin_matched =", walkin_matched, "of", total_walkins)
print("scan/sale party overlap distinct parties:", len(scan_sale_party_match), "matched scan rows:", len(matched_scan_rows), "of", scans_with_party_count, "scans-with-party_id")
