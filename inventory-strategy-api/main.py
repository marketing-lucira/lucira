"""
Lucira · Inventory Strategy Command Center — data + AI API
==========================================================
One HTTP Cloud Function (gen2 / Cloud Run) that powers
`dashboard/inventory-dashboard.html`.

PRIMARY GOAL = INVENTORY. Everything answers the CEO's questions:
  • Refresh strategy          → days-of-cover per store × SKU
  • Running stock alerts      → CRITICAL / LOW / HEALTHY / OVERSTOCK / DEAD
  • Inventory rolling         → aging buckets, fast/slow movers, transfer ideas
  • Refilling (reorder)       → qty = run-rate × (lead-time + safety) − on-hand
  • Store-level inventory     → per store × location working view
GA4 comes in only as *demand signal* (visibility + geo store-targeting).

Sources (single source of truth per metric):
  INVENTORY_TABLE  ds_imputed_reporting.Live_inventory        (current stock, item grain)
  SALES_TABLE      ornaverse_erp_administration.Sales_overview_table (velocity)
  GA4_DATASET      analytics_478308692.events_*                (funnel + geo demand)

Store bridge caveat: Live_inventory.Store_name and Sales.company_code do NOT map
1:1 (CS1/FCS have no store name; "Divinecarat" spans many locations). So
days-of-cover / reorder use NETWORK-WIDE SKU velocity (Full_sku), while on-hand is
shown per Store_name × location_name. Documented in the dashboard Knowledge Base.

Routing (single entry point `inventory_data`, dispatch on ?action=):
  (default)      → full analytics bundle (GET)
  ?action=chat   → NL question → Gemini writes guarded BigQuery SQL → rows + answer (POST)
  ?action=ai     → Gemini strategy narrative from the computed summary (GET/POST)
  ?action=health → ping

Deploy: see deploy.sh / README.md
"""

import os
import re
import json
import time
from datetime import datetime, timezone, date

import functions_framework
from google.cloud import bigquery

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
BQ_PROJECT      = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
INVENTORY_TABLE = os.environ.get("INVENTORY_TABLE", "lucirajewelry-prod.ds_imputed_reporting.Live_inventory")
SALES_TABLE     = os.environ.get("SALES_TABLE", "lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table")
GA4_DATASET     = os.environ.get("GA4_DATASET", "lucirajewelry-prod.analytics_478308692")

TIMEZONE = os.environ.get("TIMEZONE", "Asia/Kolkata")
CURRENCY = os.environ.get("CURRENCY", "INR")

VELOCITY_DAYS  = int(os.environ.get("VELOCITY_DAYS", "90"))
LEAD_TIME_DAYS = int(os.environ.get("LEAD_TIME_DAYS", "21"))
SAFETY_DAYS    = int(os.environ.get("SAFETY_DAYS", "14"))
GEO_DAYS       = int(os.environ.get("GEO_DAYS", "30"))

CRITICAL_COVER  = float(os.environ.get("CRITICAL_COVER", "14"))
LOW_COVER       = float(os.environ.get("LOW_COVER", "30"))
OVERSTOCK_COVER = float(os.environ.get("OVERSTOCK_COVER", "270"))
DEAD_DAYS       = int(os.environ.get("DEAD_DAYS", "180"))

VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
VERTEX_MODEL    = os.environ.get("VERTEX_MODEL", "gemini-2.5-flash")
CHAT_MAX_GB     = float(os.environ.get("CHAT_MAX_GB", "2"))

ITEM_CAP = int(os.environ.get("ITEM_CAP", "8000"))
STOCK_TARGET_N = int(os.environ.get("STOCK_TARGET_N", "500"))   # core assortment size per store
# Metals / product-types excluded from the whole dashboard (comma-separated).
# Silver metal + all coins (Gold Coin, Silver Coin) are dropped entirely — jewelry only.
EXCLUDE_METALS = [m.strip() for m in os.environ.get("EXCLUDE_METALS", "Silver").split(",") if m.strip()]
EXCLUDE_TYPES  = [t.strip() for t in os.environ.get("EXCLUDE_TYPES", "Silver Coin,Gold Coin").split(",") if t.strip()]

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}

# City → nearest physical store (GA4 geo demand → store targeting).
# Editable. Cities not listed fall under "Online / Other".
CITY_STORE = {
    "Mumbai": "Sky City Borivali CoCo Store", "Thane": "Sky City Borivali CoCo Store",
    "Navi Mumbai": "Sky City Borivali CoCo Store", "Pune": "JM Pune CoCo Store",
    "Pimpri-Chinchwad": "JM Pune CoCo Store", "Delhi": "Paschim Vihar Lucira Jewelry",
    "New Delhi": "Paschim Vihar Lucira Jewelry", "Noida": "Noida Sector 18 CoCo Store",
    "Ghaziabad": "Noida Sector 18 CoCo Store", "Greater Noida": "Noida Sector 18 CoCo Store",
    "Gurugram": "Paschim Vihar Lucira Jewelry", "Faridabad": "Paschim Vihar Lucira Jewelry",
}

# Product types that are bullion/investment, not jewelry merchandising.
COIN_TYPES = {"Gold Coin"}

# Sales store code (company_code) → inventory Store_name. Editable.
# Lets the product page filter STOCK by the same physical store it filters SALES by.
STORE_CODE_MAP = {
    "N18": "Noida Sector 18 CoCo Store",
    "PN1": "JM Pune CoCo Store",
    "PV1": "Paschim Vihar Lucira Jewelry",
    "BO1": "Sky City Borivali CoCo Store",
    "HO":  "Divinecarat Lifestyles Private Limited",
    "CS1": "Divinecarat Lifestyles Private Limited",
    "FCS": "HWI VENTURES",
}

_bq = None
def bq():
    global _bq
    if _bq is None:
        _bq = bigquery.Client(project=BQ_PROJECT or None)
    return _bq


def jdefault(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return str(o)


def num(v, nd=2):
    try:
        if v is None:
            return None
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


# Price-band ladder (retail ₹). Ordered; used for the price-range strategy filter.
PRICE_BANDS = [(25000, "< ₹25K"), (50000, "₹25K–50K"), (100000, "₹50K–1L"),
               (200000, "₹1L–2L"), (500000, "₹2L–5L"), (float("inf"), "₹5L+")]
PRICE_BAND_ORDER = ["< ₹25K", "₹25K–50K", "₹50K–1L", "₹1L–2L", "₹2L–5L", "₹5L+", "Unpriced"]

def price_band(v):
    if v is None or v <= 0:
        return "Unpriced"
    for hi, lbl in PRICE_BANDS:
        if v < hi:
            return lbl
    return "₹5L+"


# ═════════════════════════════════════════════════════════════════════════
#  SQL
# ═════════════════════════════════════════════════════════════════════════
def item_query():
    """Item grain: Store_name × location_name × Full_sku, enriched with velocity + GA4 signals."""
    return f"""
    WITH sales_vel AS (
      SELECT Full_sku,
             SUM(pieces)                        AS sold_win,
             SUM(SAFE_CAST(gross_amount AS FLOAT64)) AS rev_win,
             MAX(Transaction_Date)              AS last_sale_win,
             COUNT(DISTINCT Transaction_Date)   AS active_days
      FROM `{SALES_TABLE}`
      WHERE Transaction_Date >= DATE_SUB(CURRENT_DATE(), INTERVAL @vel_days DAY)
        AND pieces > 0
      GROUP BY Full_sku
    ),
    sales_all AS (
      SELECT Full_sku, MAX(Transaction_Date) AS last_sale_all, SUM(pieces) AS sold_all
      FROM `{SALES_TABLE}` WHERE pieces > 0 GROUP BY Full_sku
    ),
    inv AS (
      SELECT
        Store_name, location_name, Full_sku,
        ANY_VALUE(item_name)          AS item_name,
        ANY_VALUE(style_code)         AS style_code,
        ANY_VALUE(type_name)          AS category,
        ANY_VALUE(collection_name)    AS collection,
        ANY_VALUE(metal_name)         AS metal,
        ANY_VALUE(karat_name)         AS purity,
        ANY_VALUE(item_group_name)    AS item_group,
        ANY_VALUE(sub_type_name)      AS sub_type,
        ANY_VALUE(stone_color_name)   AS stone,
        ANY_VALUE(first_image)        AS image,
        ANY_VALUE(Shopify_price)      AS shopify_price,
        ANY_VALUE(shpify_tags)        AS tags,
        SUM(pieces)                                     AS on_hand,
        SUM(SAFE_CAST(item_rate AS FLOAT64) * pieces)   AS cost_value,
        SUM(IFNULL(is_allocated,0))                     AS allocated,
        SUM(IFNULL(pdp_views,0))                        AS pdp_views,
        SUM(IFNULL(add_to_cart,0))                      AS add_to_cart,
        SUM(IFNULL(begin_checkout,0))                   AS begin_checkout,
        MIN(document_date)                              AS first_stock_date,
        MAX(document_date)                              AS last_stock_date
      FROM `{INVENTORY_TABLE}`
      WHERE pieces > 0
        AND IFNULL(metal_name, '') NOT IN UNNEST(@excl_metals)
        AND IFNULL(type_name, '')  NOT IN UNNEST(@excl_types)
      GROUP BY Store_name, location_name, Full_sku
    )
    SELECT
      i.Store_name, i.location_name, i.Full_sku,
      i.item_name, i.style_code, i.category, i.collection, i.metal, i.purity,
      i.item_group, i.sub_type, i.stone, i.image, i.shopify_price, i.tags,
      i.on_hand, i.cost_value, i.allocated,
      i.pdp_views, i.add_to_cart, i.begin_checkout,
      i.first_stock_date, i.last_stock_date,
      DATE_DIFF(CURRENT_DATE(), i.first_stock_date, DAY) AS days_in_stock,
      v.sold_win, v.rev_win, v.last_sale_win, v.active_days,
      a.last_sale_all, a.sold_all
    FROM inv i
    LEFT JOIN sales_vel v USING (Full_sku)
    LEFT JOIN sales_all a USING (Full_sku)
    ORDER BY i.cost_value DESC
    LIMIT @cap
    """


def ga4_funnel_query():
    return f"""
    SELECT
      event_name,
      COUNT(*)                       AS events,
      COUNT(DISTINCT user_pseudo_id) AS users
    FROM `{GA4_DATASET}.events_*`
    WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @geo_days DAY))
                            AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND event_name IN ('view_item','add_to_cart','add_to_wishlist','begin_checkout',
                         'add_payment_info','purchase','view_cart','remove_from_cart')
    GROUP BY event_name
    """


def ga4_geo_query():
    return f"""
    SELECT
      geo.city   AS city,
      geo.region AS region,
      COUNTIF(event_name = 'view_item')       AS view_item,
      COUNTIF(event_name = 'add_to_cart')     AS add_to_cart,
      COUNTIF(event_name = 'add_to_wishlist') AS add_to_wishlist,
      COUNTIF(event_name = 'begin_checkout')  AS begin_checkout,
      COUNTIF(event_name = 'purchase')        AS purchase
    FROM `{GA4_DATASET}.events_*`
    WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @geo_days DAY))
                            AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
      AND geo.country = 'India' AND geo.city IS NOT NULL AND geo.city != '(not set)'
    GROUP BY city, region
    ORDER BY view_item DESC
    LIMIT 40
    """


# ═════════════════════════════════════════════════════════════════════════
#  BUNDLE — compute everything the dashboard needs
# ═════════════════════════════════════════════════════════════════════════
def classify(on_hand, vpd, days_in_stock, sold_win, last_sale_all):
    """Return (status, days_of_cover)."""
    cover = (on_hand / vpd) if vpd and vpd > 0 else None
    aged = days_in_stock if days_in_stock is not None else 0
    if (not sold_win or sold_win == 0) and aged >= DEAD_DAYS:
        return "DEAD", cover
    if cover is None:
        # no recent velocity but not yet dead → slow / watch
        return "NO_VELOCITY", None
    if cover < CRITICAL_COVER:
        return "CRITICAL", cover
    if cover < LOW_COVER:
        return "LOW", cover
    if cover > OVERSTOCK_COVER:
        return "OVERSTOCK", cover
    return "HEALTHY", cover


def aging_bucket(d):
    if d is None:
        return "Unknown"
    if d <= 30:  return "0-30 (Fresh)"
    if d <= 90:  return "31-90 (Active)"
    if d <= 180: return "91-180 (Aging)"
    if d <= 365: return "181-365 (Stale)"
    return "365+ (Dead)"


def build_bundle():
    t0 = time.time()
    c = bq()

    def run(sql, params):
        return list(c.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())

    item_params = [
        bigquery.ScalarQueryParameter("vel_days", "INT64", VELOCITY_DAYS),
        bigquery.ScalarQueryParameter("cap", "INT64", ITEM_CAP),
        bigquery.ArrayQueryParameter("excl_metals", "STRING", EXCLUDE_METALS or [""]),
        bigquery.ArrayQueryParameter("excl_types", "STRING", EXCLUDE_TYPES or [""]),
    ]
    geo_params = [bigquery.ScalarQueryParameter("geo_days", "INT64", GEO_DAYS)]

    rows = run(item_query(), item_params)
    try:
        funnel_rows = run(ga4_funnel_query(), geo_params)
    except Exception:
        funnel_rows = []
    try:
        geo_rows = run(ga4_geo_query(), geo_params)
    except Exception:
        geo_rows = []

    items = []
    for r in rows:
        on_hand   = float(r["on_hand"] or 0)
        sold_win  = float(r["sold_win"] or 0)
        vpd       = sold_win / VELOCITY_DAYS if sold_win else 0.0
        dis       = int(r["days_in_stock"]) if r["days_in_stock"] is not None else None
        raw_type  = (r["category"] or "Uncat").strip()
        metal     = (r["metal"] or "").strip()
        # Segment + merchandising category:
        #  • Coins (Gold/Silver Coin) = BULLION — near-cash, excluded from jewelry
        #    dead-stock/reorder/rolling logic (a coin is never "dead").
        #  • Silver metal is excluded entirely upstream (EXCLUDE_METALS).
        #  • Everything else keeps its product type as the category.
        if raw_type in COIN_TYPES:
            segment, merch_cat = "Bullion", "Coins / Bullion"
        else:
            segment, merch_cat = "Jewelry", raw_type
        if segment == "Bullion":
            status, cover = "BULLION", ((on_hand / vpd) if vpd > 0 else None)
            reorder_qty = 0                      # coins are gold-rate driven, not merch reorder
        else:
            status, cover = classify(on_hand, vpd, dis, sold_win, r["last_sale_all"])
            target_stock = vpd * (LEAD_TIME_DAYS + SAFETY_DAYS)
            reorder_qty  = max(0, int(round(target_stock - on_hand))) if vpd > 0 else 0
        # per-piece retail (shopify_price is STRING, may hold ranges/blank)
        try:
            retail = float(re.sub(r"[^0-9.]", "", str(r["shopify_price"]))) if r["shopify_price"] else None
        except (TypeError, ValueError):
            retail = None
        unit_cost = (float(r["cost_value"]) / on_hand) if (r["cost_value"] and on_hand) else None
        pdp = int(r["pdp_views"] or 0); atc = int(r["add_to_cart"] or 0); chk = int(r["begin_checkout"] or 0)
        # GA4-event-driven demand score: web funnel weighted up to purchase, plus real sell-through.
        # This is the backbone that ranks WHAT to stock and validates every stocking decision.
        demand_score = round(0.02 * pdp + 1.0 * atc + 2.5 * chk + 4.0 * sold_win, 2)
        price_ref = retail if (retail and retail > 0) else unit_cost
        items.append({
            "store": r["Store_name"] or "—", "location": r["location_name"] or "—",
            "sku": r["Full_sku"] or "—", "name": r["item_name"] or "",
            "style": r["style_code"] or "", "category": merch_cat, "type": raw_type,
            "segment": segment,
            "collection": r["collection"] or "", "metal": r["metal"] or "", "purity": r["purity"] or "",
            "subtype": r["sub_type"] or "—", "stone": r["stone"] or "—",
            "group": r["item_group"] or "", "image": r["image"] or "", "tags": r["tags"] or "",
            "on_hand": round(on_hand, 2), "allocated": int(r["allocated"] or 0),
            "cost_value": num(r["cost_value"]) or 0, "unit_cost": num(unit_cost), "retail": num(retail),
            "price_band": price_band(price_ref), "demand_score": demand_score,
            "pdp_views": pdp, "add_to_cart": atc, "begin_checkout": chk,
            "sold_win": round(sold_win, 2), "rev_win": num(r["rev_win"]) or 0,
            "vpd": round(vpd, 4), "cover": (round(cover, 1) if cover is not None else None),
            "days_in_stock": dis, "aging": aging_bucket(dis),
            "last_sale": r["last_sale_all"].isoformat() if r["last_sale_all"] else None,
            "status": status,
            "reorder_qty": reorder_qty,
            "reorder_value": num((reorder_qty * (unit_cost or 0))) or 0,
        })

    # ── Split jewelry vs bullion ──
    jewel = [i for i in items if i["segment"] == "Jewelry"]
    bull  = [i for i in items if i["segment"] == "Bullion"]

    # ── KPIs (jewelry only — coins never distort dead-stock / reorder) ──
    total_pieces = sum(i["on_hand"] for i in items)          # all real stock
    stock_value  = sum(i["cost_value"] for i in items)
    jewel_value  = sum(i["cost_value"] for i in jewel)
    by_status = {}
    for i in jewel:
        by_status[i["status"]] = by_status.get(i["status"], 0) + 1
    dead_value = sum(i["cost_value"] for i in jewel if i["status"] == "DEAD")
    overstock_value = sum(i["cost_value"] for i in jewel if i["status"] == "OVERSTOCK")
    reorder_units = sum(i["reorder_qty"] for i in jewel)
    reorder_value = sum(i["reorder_value"] for i in jewel)

    kpis = {
        "sku_lines": len(jewel),
        "distinct_skus": len({i["sku"] for i in jewel}),
        "stores": len({i["store"] for i in items}),
        "total_pieces": round(total_pieces, 1),
        "stock_value": round(stock_value, 0),          # incl. bullion (real capital)
        "jewelry_value": round(jewel_value, 0),
        "dead_value": round(dead_value, 0),
        "dead_pct": round(100 * dead_value / jewel_value, 1) if jewel_value else 0,
        "overstock_value": round(overstock_value, 0),
        "critical_lines": by_status.get("CRITICAL", 0),
        "low_lines": by_status.get("LOW", 0),
        "dead_lines": by_status.get("DEAD", 0),
        "healthy_lines": by_status.get("HEALTHY", 0),
        "reorder_units": reorder_units,
        "reorder_value": round(reorder_value, 0),
        "by_status": by_status,
    }

    # ── Bullion block (tracked separately; gold-rate driven) ──
    def coin_split(name):
        sub = [i for i in bull if i["type"] == name]
        return {"lines": len(sub), "pieces": round(sum(i["on_hand"] for i in sub), 1),
                "value": round(sum(i["cost_value"] for i in sub), 0),
                "sold_win": round(sum(i["sold_win"] for i in sub), 1)}
    bullion = {
        "lines": len(bull), "pieces": round(sum(i["on_hand"] for i in bull), 1),
        "value": round(sum(i["cost_value"] for i in bull), 0),
        "sold_win": round(sum(i["sold_win"] for i in bull), 1),
        "gold_coin": coin_split("Gold Coin"), "silver_coin": coin_split("Silver Coin"),
        "items": sorted(bull, key=lambda x: x["cost_value"], reverse=True),
    }

    # ── Store rollup ──
    stores = {}
    for i in items:
        s = stores.setdefault(i["store"], {
            "store": i["store"], "pieces": 0, "value": 0.0, "bullion_value": 0.0, "skus": set(),
            "dead": 0, "critical": 0, "low": 0, "overstock": 0,
            "pdp_views": 0, "add_to_cart": 0, "reorder_value": 0.0, "locations": set(),
        })
        s["pieces"] += i["on_hand"]; s["value"] += i["cost_value"]; s["skus"].add(i["sku"])
        s["locations"].add(i["location"])
        s["pdp_views"] += i["pdp_views"]; s["add_to_cart"] += i["add_to_cart"]
        s["reorder_value"] += i["reorder_value"]
        if i["segment"] == "Bullion":
            s["bullion_value"] += i["cost_value"]
        if i["status"] in ("DEAD", "CRITICAL", "LOW", "OVERSTOCK"):
            s[i["status"].lower()] += 1
    store_list = []
    for s in stores.values():
        s["skus"] = len(s["skus"]); s["locations"] = len(s["locations"])
        s["pieces"] = round(s["pieces"], 1); s["value"] = round(s["value"], 0)
        s["bullion_value"] = round(s["bullion_value"], 0)
        s["reorder_value"] = round(s["reorder_value"], 0)
        store_list.append(s)
    store_list.sort(key=lambda x: x["value"], reverse=True)

    # ── Aging buckets (jewelry only — coins aren't aged) ──
    aging = {}
    for i in jewel:
        b = aging.setdefault(i["aging"], {"bucket": i["aging"], "lines": 0, "pieces": 0, "value": 0.0})
        b["lines"] += 1; b["pieces"] += i["on_hand"]; b["value"] += i["cost_value"]
    aging_list = sorted(aging.values(), key=lambda x: x["bucket"])
    for b in aging_list:
        b["pieces"] = round(b["pieces"], 1); b["value"] = round(b["value"], 0)

    # ── Transfer / redistribution suggestions ──
    # A piece is DEAD/OVERSTOCK where it sits, but its CATEGORY still sells across the
    # network → the capital is stuck in the wrong place. Suggest moving it to stores
    # that hold demand for that category but currently carry none of it.
    cat_velocity = {}          # category → network units sold in window
    cat_web = {}               # category → web add_to_cart (demand proxy)
    for i in jewel:
        cat_velocity[i["category"]] = cat_velocity.get(i["category"], 0) + i["sold_win"]
        cat_web[i["category"]] = cat_web.get(i["category"], 0) + i["add_to_cart"]
    store_cat = {}             # (store, category) → on_hand
    for i in jewel:
        store_cat[(i["store"], i["category"])] = store_cat.get((i["store"], i["category"]), 0) + i["on_hand"]
    all_stores = list(stores.keys())
    transfers = []
    for i in jewel:
        cat_dem = cat_velocity.get(i["category"], 0) + cat_web.get(i["category"], 0)
        if i["status"] in ("DEAD", "OVERSTOCK") and cat_dem > 0:
            # destinations: stores that carry little/none of this selling category
            ranked = sorted(
                [st for st in all_stores if st != i["store"]],
                key=lambda st: store_cat.get((st, i["category"]), 0))
            targets = [st for st in ranked if store_cat.get((st, i["category"]), 0) == 0][:3]
            no_stock = bool(targets)
            if not targets:
                targets = ranked[:2]   # fall back to the leanest-stocked stores
            short_from = (i["store"][:22] + "…") if len(i["store"]) > 23 else i["store"]
            short_to = ", ".join((t[:18] + "…") if len(t) > 19 else t for t in targets)
            aged = i["days_in_stock"]
            web = cat_web.get(i["category"], 0)
            if i["status"] == "DEAD":
                cond = f"has sat {aged}d unsold at {short_from}"
            else:
                cond = f"is overstocked at {short_from} ({aged}d in stock, cover > {int(OVERSTOCK_COVER)}d)"
            dest = (f"{short_to} carry none of it" if no_stock
                    else f"{short_to} are the leanest-stocked on this category")
            reason = (f"This {i['category']} {cond}, yet the category still has live demand "
                      f"(sold {int(cat_velocity.get(i['category'],0))} units + {int(web)} web add-to-carts in the window). "
                      f"{dest} — roll it there to convert stuck capital (₹{int(i['cost_value']):,}) into a sale.")
            transfers.append({
                "sku": i["sku"], "name": i["name"], "category": i["category"],
                "collection": i["collection"],
                "from_store": i["store"], "from_location": i["location"],
                "suggest_to": targets, "on_hand": i["on_hand"], "value": i["cost_value"],
                "status": i["status"], "days_in_stock": i["days_in_stock"],
                "category_demand": round(cat_dem, 1), "reason": reason,
            })
    transfers.sort(key=lambda x: (x["category_demand"], x["value"]), reverse=True)

    # ── GA4 funnel + geo ──
    funnel = {r["event_name"]: {"events": int(r["events"]), "users": int(r["users"])} for r in funnel_rows}
    geo = []
    for r in geo_rows:
        city = r["city"]
        geo.append({
            "city": city, "region": r["region"],
            "view_item": int(r["view_item"]), "add_to_cart": int(r["add_to_cart"]),
            "add_to_wishlist": int(r["add_to_wishlist"]), "begin_checkout": int(r["begin_checkout"]),
            "purchase": int(r["purchase"]),
            "target_store": CITY_STORE.get(city, "Online / Other"),
        })

    # ── Visibility: demand vs stock signals (GA4 pre-joined per SKU) ──
    hot_low = sorted(
        [i for i in jewel if i["add_to_cart"] > 0 and i["status"] in ("CRITICAL", "LOW")],
        key=lambda x: x["add_to_cart"], reverse=True)[:50]
    silent_stock = sorted(
        [i for i in jewel if i["pdp_views"] == 0 and i["on_hand"] > 0 and i["cost_value"] > 0],
        key=lambda x: x["cost_value"], reverse=True)[:50]

    # ── Price-band strategy (capital vs GA4 demand by price range) ──
    band_map = {}
    for i in jewel:
        b = band_map.setdefault(i["price_band"], {"band": i["price_band"], "lines": 0, "pieces": 0,
                                                  "value": 0.0, "demand": 0.0, "sold_win": 0.0, "atc": 0})
        b["lines"] += 1; b["pieces"] += i["on_hand"]; b["value"] += i["cost_value"]
        b["demand"] += i["demand_score"]; b["sold_win"] += i["sold_win"]; b["atc"] += i["add_to_cart"]
    tot_val = sum(b["value"] for b in band_map.values()) or 1
    tot_dem = sum(b["demand"] for b in band_map.values()) or 1
    price_bands = []
    for lbl in PRICE_BAND_ORDER:
        if lbl in band_map:
            b = band_map[lbl]
            b["value"] = round(b["value"], 0); b["pieces"] = round(b["pieces"], 1)
            b["demand"] = round(b["demand"], 1); b["sold_win"] = round(b["sold_win"], 1)
            b["value_share"] = round(100 * b["value"] / tot_val, 1)
            b["demand_share"] = round(100 * band_map[lbl]["demand"] / tot_dem, 1) if tot_dem else 0
            price_bands.append(b)

    # ── Assortment / stocking plan — WHAT to stock, ranked by GA4 ecommerce events ──
    # Network product demand deduped per SKU (velocity & GA4 signals are per-SKU, so take
    # the per-SKU value once — never summed across a SKU's store lines).
    sku_dem = {}
    for i in jewel:
        d = sku_dem.get(i["sku"])
        if d is None:
            d = {"sku": i["sku"], "name": i["name"], "category": i["category"], "metal": i["metal"],
                 "price_band": i["price_band"], "image": i["image"], "retail": i["retail"],
                 "sold_win": 0.0, "pdp": 0, "atc": 0, "chk": 0,
                 "stores_holding": set(), "on_hand_net": 0.0}
            sku_dem[i["sku"]] = d
        d["sold_win"] = max(d["sold_win"], i["sold_win"])      # per-SKU (equal across lines)
        d["pdp"] = max(d["pdp"], i["pdp_views"]); d["atc"] = max(d["atc"], i["add_to_cart"])
        d["chk"] = max(d["chk"], i["begin_checkout"])
        d["stores_holding"].add(i["store"]); d["on_hand_net"] += i["on_hand"]
    for d in sku_dem.values():
        d["demand_score"] = round(0.02 * d["pdp"] + 1.0 * d["atc"] + 2.5 * d["chk"] + 4.0 * d["sold_win"], 2)
    # core assortment = top-N products that actually have an ecommerce-event / sales signal
    core = sorted([d for d in sku_dem.values() if d["demand_score"] > 0],
                  key=lambda x: x["demand_score"], reverse=True)[:STOCK_TARGET_N]
    core_skus = {d["sku"] for d in core}
    # who can supply a gap SKU (a store holding it DEAD/OVERSTOCK) → transfer, else reorder
    supply = {}
    for i in jewel:
        if i["status"] in ("DEAD", "OVERSTOCK") and i["sku"] in core_skus:
            supply.setdefault(i["sku"], set()).add(i["store"])
    core_out = [{"sku": d["sku"], "name": d["name"], "category": d["category"], "metal": d["metal"],
                 "price_band": d["price_band"], "retail": d["retail"], "image": d["image"],
                 "demand_score": d["demand_score"], "sold_win": round(d["sold_win"], 1),
                 "pdp": d["pdp"], "atc": d["atc"], "chk": d["chk"],
                 "stores_holding": len(d["stores_holding"])} for d in core]
    # per-store coverage of the core assortment
    store_hold = {}
    for i in jewel:
        if i["sku"] in core_skus and i["on_hand"] > 0:
            store_hold.setdefault(i["store"], set()).add(i["sku"])
    assortment_stores = []
    for st in stores.keys():
        held = store_hold.get(st, set())
        gap = [d for d in core if d["sku"] not in held]
        gap_rows = [{"sku": d["sku"], "name": d["name"], "category": d["category"],
                     "price_band": d["price_band"], "retail": d["retail"], "demand_score": d["demand_score"],
                     "source": ("Transfer" if (d["sku"] in supply and st not in supply[d["sku"]]) else "Reorder"),
                     "from": next(iter(supply.get(d["sku"], set()) - {st}), None)} for d in gap[:120]]
        assortment_stores.append({
            "store": st, "target": STOCK_TARGET_N, "held": len(held),
            "gap": len(core) - len(held),
            "coverage_pct": round(100 * len(held) / max(1, len(core)), 1),
            "transfer_fillable": sum(1 for g in gap_rows if g["source"] == "Transfer"),
            "gap_items": gap_rows,
        })
    assortment_stores.sort(key=lambda x: x["coverage_pct"])
    assortment = {"target_n": STOCK_TARGET_N, "core_count": len(core),
                  "core": core_out, "by_store": assortment_stores}

    # ── Geo → Store targeting: GA4 catchment demand vs store stock (ratio analysis) ──
    store_demand = {}
    for g in geo:
        ts = g["target_store"]
        idx = 0.02 * g["view_item"] + 1.0 * g["add_to_cart"] + 1.0 * g["add_to_wishlist"] \
              + 2.5 * g["begin_checkout"] + 4.0 * g["purchase"]
        d = store_demand.setdefault(ts, {"target_store": ts, "view_item": 0, "add_to_cart": 0,
                                         "add_to_wishlist": 0, "begin_checkout": 0, "purchase": 0,
                                         "demand_index": 0.0, "cities": 0})
        for k in ("view_item", "add_to_cart", "add_to_wishlist", "begin_checkout", "purchase"):
            d[k] += g[k]
        d["demand_index"] += idx; d["cities"] += 1
    stock_by_store = {s["store"]: s["value"] for s in store_list}
    tot_dem_idx = sum(v["demand_index"] for v in store_demand.values()) or 1
    tot_stock = sum(stock_by_store.values()) or 1
    geo_targeting = []
    for ts, d in store_demand.items():
        physical = ts != "Online / Other"
        stock_val = stock_by_store.get(ts, 0)
        dem_share = d["demand_index"] / tot_dem_idx
        stock_share = (stock_val / tot_stock) if physical else 0
        ratio = (dem_share / stock_share) if stock_share > 0 else None
        verdict = ("Online — no store" if not physical else
                   "Under-served · add stock" if (ratio and ratio > 1.2) else
                   "Over-served · trim/roll" if (ratio and ratio < 0.8) else
                   "Balanced" if ratio else "No stock mapped")
        geo_targeting.append({
            "target_store": ts, "physical": physical, "cities": d["cities"],
            "demand_index": round(d["demand_index"], 1), "demand_share": round(100 * dem_share, 1),
            "stock_value": round(stock_val, 0), "stock_share": round(100 * stock_share, 1),
            "ratio": round(ratio, 2) if ratio else None, "verdict": verdict,
            "view_item": d["view_item"], "add_to_cart": d["add_to_cart"],
            "add_to_wishlist": d["add_to_wishlist"], "begin_checkout": d["begin_checkout"], "purchase": d["purchase"],
        })
    geo_targeting.sort(key=lambda x: x["demand_index"], reverse=True)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "currency": CURRENCY,
        "params": {
            "velocity_days": VELOCITY_DAYS, "lead_time_days": LEAD_TIME_DAYS,
            "safety_days": SAFETY_DAYS, "geo_days": GEO_DAYS,
            "critical_cover": CRITICAL_COVER, "low_cover": LOW_COVER,
            "overstock_cover": OVERSTOCK_COVER, "dead_days": DEAD_DAYS,
            "stock_target_n": STOCK_TARGET_N,
        },
        "kpis": kpis,
        "bullion": bullion,
        "items": items,
        "stores": store_list,
        "aging": aging_list,
        "transfers": transfers[:100],
        "funnel": funnel,
        "geo": geo,
        "geo_targeting": geo_targeting,
        "price_bands": price_bands,
        "assortment": assortment,
        "visibility": {"hot_low_stock": hot_low, "silent_stock": silent_stock},
        "elapsed_sec": round(time.time() - t0, 2),
    }


# ═════════════════════════════════════════════════════════════════════════
#  PRODUCT PERFORMANCE  (?action=product&days=&store=&category=)
#  Sell-through by sold-range, city demand (purchase + GA4), stock insight.
# ═════════════════════════════════════════════════════════════════════════
SOLD_ORDER = ["0 · no sale", "1", "2–5", "6–10", "11–25", "26+"]

def sold_bucket(n):
    n = n or 0
    if n <= 0:  return "0 · no sale"
    if n == 1:  return "1"
    if n <= 5:  return "2–5"
    if n <= 10: return "6–10"
    if n <= 25: return "11–25"
    return "26+"


def build_product(days, store, category):
    c = bq()
    days = max(1, min(730, int(days)))
    store_name = STORE_CODE_MAP.get(store) if store else None   # inventory Store_name for this sales code
    store_clause = " AND company_code = @store " if store else ""
    inv_store_clause = " AND Store_name = @store_name " if store_name else ""
    cat_clause_i = " AND type_name = @cat " if category else ""
    cat_clause_s = " AND type_name = @cat " if category else ""

    prod_sql = f"""
    WITH sales AS (
      SELECT Full_sku,
             SUM(pieces) AS sold, SUM(SAFE_CAST(gross_amount AS FLOAT64)) AS revenue,
             COUNT(DISTINCT document_no) AS orders, MAX(Transaction_Date) AS last_sale,
             ANY_VALUE(Item_name) AS sname, ANY_VALUE(type_name) AS scat, ANY_VALUE(metal_name) AS smetal,
             ANY_VALUE(style_code) AS sstyle, ANY_VALUE(sub_category) AS ssub
      FROM `{SALES_TABLE}`
      WHERE Transaction_Date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY) AND pieces > 0
        AND IFNULL(metal_name,'') NOT IN UNNEST(@excl_metals)
        AND IFNULL(type_name,'')  NOT IN UNNEST(@excl_types)
        {store_clause}{cat_clause_s}
      GROUP BY Full_sku
    ),
    inv AS (
      SELECT Full_sku, ANY_VALUE(item_name) AS name, ANY_VALUE(type_name) AS category,
             ANY_VALUE(metal_name) AS metal, ANY_VALUE(first_image) AS image, ANY_VALUE(Shopify_price) AS price,
             ANY_VALUE(style_code) AS style, ANY_VALUE(sub_type_name) AS subtype,
             SUM(pieces) AS stock, SUM(SAFE_CAST(item_rate AS FLOAT64) * pieces) AS value,
             SUM(IFNULL(pdp_views,0)) AS pdp, SUM(IFNULL(add_to_cart,0)) AS atc, SUM(IFNULL(begin_checkout,0)) AS chk
      FROM `{INVENTORY_TABLE}`
      WHERE pieces > 0
        AND IFNULL(metal_name,'') NOT IN UNNEST(@excl_metals)
        AND IFNULL(type_name,'')  NOT IN UNNEST(@excl_types)
        {cat_clause_i}{inv_store_clause}
      GROUP BY Full_sku
    )
    SELECT
      COALESCE(s.Full_sku, i.Full_sku) AS sku,
      COALESCE(i.name, s.sname) AS name, COALESCE(i.category, s.scat) AS category,
      COALESCE(i.metal, s.smetal) AS metal, i.image, i.price,
      COALESCE(i.style, s.sstyle) AS parent, i.subtype AS subtype, s.ssub AS sub_category,
      IFNULL(i.stock,0) AS stock, IFNULL(i.value,0) AS value,
      IFNULL(i.pdp,0) AS pdp, IFNULL(i.atc,0) AS atc, IFNULL(i.chk,0) AS chk,
      IFNULL(s.sold,0) AS sold, IFNULL(s.revenue,0) AS revenue, IFNULL(s.orders,0) AS orders, s.last_sale
    FROM sales s FULL OUTER JOIN inv i ON s.Full_sku = i.Full_sku
    """

    city_sql = f"""
    SELECT city_name AS city, ANY_VALUE(state_name) AS state,
           SUM(pieces) AS units, SUM(SAFE_CAST(gross_amount AS FLOAT64)) AS revenue,
           COUNT(DISTINCT document_no) AS orders
    FROM `{SALES_TABLE}`
    WHERE Transaction_Date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY) AND pieces > 0
      AND city_name IS NOT NULL AND city_name != ''
      {store_clause}{cat_clause_s}
    GROUP BY city ORDER BY revenue DESC LIMIT 50
    """

    params = [
        bigquery.ScalarQueryParameter("days", "INT64", days),
        bigquery.ArrayQueryParameter("excl_metals", "STRING", EXCLUDE_METALS or [""]),
        bigquery.ArrayQueryParameter("excl_types", "STRING", EXCLUDE_TYPES or [""]),
    ]
    if store:      params.append(bigquery.ScalarQueryParameter("store", "STRING", store))
    if store_name: params.append(bigquery.ScalarQueryParameter("store_name", "STRING", store_name))
    if category:   params.append(bigquery.ScalarQueryParameter("cat", "STRING", category))

    def run(sql, p=None):
        return list(c.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=p or params)).result())

    prod_rows = run(prod_sql)
    city_rows = run(city_sql)

    # GA4-demand → what website-demanded products this store should ADD to stock
    # (high web pull network-wide, but NOT currently on hand at this store).
    to_stock = []
    if store_name:
        ts_sql = f"""
        WITH held AS (
          SELECT DISTINCT Full_sku FROM `{INVENTORY_TABLE}`
          WHERE pieces > 0 AND Store_name = @store_name
        ),
        demand AS (
          SELECT Full_sku, ANY_VALUE(item_name) AS name, ANY_VALUE(type_name) AS category,
                 ANY_VALUE(first_image) AS image, ANY_VALUE(Shopify_price) AS price,
                 MAX(IFNULL(pdp_views,0)) AS pdp, MAX(IFNULL(add_to_cart,0)) AS atc,
                 MAX(IFNULL(begin_checkout,0)) AS chk
          FROM `{INVENTORY_TABLE}`
          WHERE pieces > 0
            AND IFNULL(metal_name,'') NOT IN UNNEST(@excl_metals)
            AND IFNULL(type_name,'')  NOT IN UNNEST(@excl_types){cat_clause_i}
          GROUP BY Full_sku
        )
        SELECT d.Full_sku AS sku, d.name, d.category, d.image, d.price, d.pdp, d.atc, d.chk
        FROM demand d LEFT JOIN held h ON d.Full_sku = h.Full_sku
        WHERE h.Full_sku IS NULL AND (d.atc > 0 OR d.pdp >= 50)
        ORDER BY (0.02*d.pdp + 1.0*d.atc + 2.5*d.chk) DESC
        LIMIT 100
        """
        for r in run(ts_sql):
            try:
                retail = float(re.sub(r"[^0-9.]", "", str(r["price"]))) if r["price"] else None
            except (TypeError, ValueError):
                retail = None
            to_stock.append({
                "sku": r["sku"], "name": r["name"] or "", "category": r["category"] or "Uncat",
                "image": r["image"] or "", "retail": num(retail), "price_band": price_band(retail),
                "pdp": int(r["pdp"] or 0), "atc": int(r["atc"] or 0), "chk": int(r["chk"] or 0),
                "demand_score": round(0.02*(r["pdp"] or 0) + 1.0*(r["atc"] or 0) + 2.5*(r["chk"] or 0), 1),
            })
    try:
        geo_rows = list(c.query(ga4_geo_query(), job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("geo_days", "INT64", days)])).result())
    except Exception:
        geo_rows = []

    # products
    prods = []
    for r in prod_rows:
        sold = float(r["sold"] or 0); stock = float(r["stock"] or 0)
        pdp = int(r["pdp"] or 0); atc = int(r["atc"] or 0); chk = int(r["chk"] or 0)
        try:
            retail = float(re.sub(r"[^0-9.]", "", str(r["price"]))) if r["price"] else None
        except (TypeError, ValueError):
            retail = None
        vpd = sold / days
        cover = round(stock / vpd, 1) if vpd > 0 else None
        # per-product stock insight + action
        if sold > 0 and stock <= 0:
            insight, action = "Sold out — sold with zero stock on hand", "Reorder now (proven demand, no cover)"
        elif sold > 0 and cover is not None and cover < 21:
            insight, action = f"Fast mover, only {cover}d cover", "Replenish — restock before stock-out"
        elif sold == 0 and atc > 0:
            insight, action = f"{atc} web ATC but no sale", "Push online / promote — demand not converting"
        elif sold == 0 and stock > 0:
            insight, action = "In stock, no sale in window", "Watch / consider markdown or transfer"
        elif sold > 0 and cover is not None and cover > 270:
            insight, action = f"Sells but overstocked ({cover}d)", "Hold buying; roll excess to other stores"
        else:
            insight, action = "Healthy sell-through", "Maintain"
        prods.append({
            "sku": r["sku"], "name": r["name"] or "", "category": r["category"] or "Uncat",
            "parent": r["parent"] or "—", "subtype": r["subtype"] or (r["sub_category"] or "—"),
            "metal": r["metal"] or "", "image": r["image"] or "", "retail": num(retail),
            "sold": round(sold, 1), "revenue": num(r["revenue"]) or 0, "orders": int(r["orders"] or 0),
            "stock": round(stock, 1), "value": num(r["value"]) or 0,
            "pdp": pdp, "atc": atc, "chk": chk, "cover": cover,
            "sold_range": sold_bucket(sold), "price_band": price_band(retail),
            "last_sale": r["last_sale"].isoformat() if r["last_sale"] else None,
            "insight": insight, "action": action,
        })
    prods.sort(key=lambda x: (x["sold"], x["revenue"]), reverse=True)

    # sold-range distribution with GA4 event totals + conversion ratios
    rng = {}
    for p in prods:
        b = rng.setdefault(p["sold_range"], {"range": p["sold_range"], "products": 0, "units": 0.0,
                                             "revenue": 0.0, "stock_value": 0.0,
                                             "views": 0, "atc": 0, "checkout": 0})
        b["products"] += 1; b["units"] += p["sold"]; b["revenue"] += p["revenue"]; b["stock_value"] += p["value"]
        b["views"] += p["pdp"]; b["atc"] += p["atc"]; b["checkout"] += p["chk"]
    sold_ranges = []
    for lbl in SOLD_ORDER:
        if lbl in rng:
            x = rng[lbl]
            x["units"] = round(x["units"], 1); x["revenue"] = round(x["revenue"], 0)
            x["stock_value"] = round(x["stock_value"], 0)
            x["atc_ratio"] = round(100 * x["atc"] / x["views"], 2) if x["views"] else 0      # view → add-to-cart
            x["cart_conv"] = round(100 * x["checkout"] / x["atc"], 2) if x["atc"] else 0       # add-to-cart → checkout
            x["sell_conv"] = round(100 * x["units"] / x["views"], 2) if x["views"] else 0       # view → unit sold
            x["units_per_product"] = round(x["units"] / x["products"], 2) if x["products"] else 0
            sold_ranges.append(x)

    # category breakdown (Category → sub-type) with the same GA4 + conversion columns
    def group_metrics(rows, keyfn):
        g = {}
        for p in rows:
            k = keyfn(p)
            b = g.setdefault(k, {"key": k, "products": 0, "units": 0.0, "revenue": 0.0, "stock": 0.0,
                                 "value": 0.0, "views": 0, "atc": 0, "checkout": 0})
            b["products"] += 1; b["units"] += p["sold"]; b["revenue"] += p["revenue"]
            b["stock"] += p["stock"]; b["value"] += p["value"]
            b["views"] += p["pdp"]; b["atc"] += p["atc"]; b["checkout"] += p["chk"]
        out = []
        for b in g.values():
            b["units"] = round(b["units"], 1); b["revenue"] = round(b["revenue"], 0)
            b["stock"] = round(b["stock"], 1); b["value"] = round(b["value"], 0)
            b["atc_ratio"] = round(100 * b["atc"] / b["views"], 2) if b["views"] else 0
            b["cart_conv"] = round(100 * b["checkout"] / b["atc"], 2) if b["atc"] else 0
            b["sell_conv"] = round(100 * b["units"] / b["views"], 2) if b["views"] else 0
            out.append(b)
        return sorted(out, key=lambda x: x["revenue"], reverse=True)
    category_breakdown = group_metrics(prods, lambda p: p["category"])
    subtype_breakdown = group_metrics(prods, lambda p: (p["category"] + " › " + (p["subtype"] or "—")))

    # city demand: merge purchases (sales) with GA4 funnel by city
    def ckey(s): return (s or "").strip().lower()
    ga4_by_city = {}
    for g in geo_rows:
        ga4_by_city[ckey(g["city"])] = g
    cities = {}
    for r in city_rows:
        k = ckey(r["city"])
        cities[k] = {"city": r["city"], "state": r["state"] or "",
                     "sales_units": int(r["units"] or 0), "sales_revenue": num(r["revenue"]) or 0,
                     "orders": int(r["orders"] or 0),
                     "view_item": 0, "add_to_cart": 0, "add_to_wishlist": 0, "begin_checkout": 0, "purchase": 0}
    for k, g in ga4_by_city.items():
        d = cities.setdefault(k, {"city": g["city"], "state": g["region"] or "", "sales_units": 0,
                                  "sales_revenue": 0, "orders": 0})
        d["view_item"] = int(g["view_item"]); d["add_to_cart"] = int(g["add_to_cart"])
        d["add_to_wishlist"] = int(g["add_to_wishlist"]); d["begin_checkout"] = int(g["begin_checkout"])
        d["purchase"] = int(g["purchase"]); d["target_store"] = CITY_STORE.get(g["city"], "Online / Other")
    city_demand = sorted(cities.values(), key=lambda x: (x.get("sales_revenue", 0), x.get("add_to_cart", 0)), reverse=True)[:40]
    for d in city_demand:
        d.setdefault("target_store", CITY_STORE.get(d["city"], "Online / Other"))

    # headline insights + action plan (rule-based, quantified)
    sold_out = [p for p in prods if p["sold"] > 0 and p["stock"] <= 0]
    fast_low = [p for p in prods if p["sold"] > 0 and p["cover"] is not None and p["cover"] < 21 and p["stock"] > 0]
    hot_novel = [p for p in prods if p["sold"] == 0 and p["atc"] > 0]
    dead_stock = [p for p in prods if p["sold"] == 0 and p["stock"] > 0]
    movers = [p for p in prods if p["sold"] > 0]
    top_city = city_demand[0] if city_demand else None
    insights = {
        "window_days": days, "store": store or "All stores", "category": category or "All categories",
        "products_sold": len(movers), "units_sold": round(sum(p["sold"] for p in movers), 0),
        "revenue": round(sum(p["revenue"] for p in movers), 0),
        "sold_out_winners": len(sold_out), "fast_low_cover": len(fast_low),
        "web_demand_no_sale": len(hot_novel), "idle_in_stock": len(dead_stock),
        "idle_value": round(sum(p["value"] for p in dead_stock), 0),
    }
    action_plan = []
    if sold_out:
        v = sum(p["revenue"] for p in sold_out)
        action_plan.append({"priority": "High", "action": f"Reorder {len(sold_out)} sold-out winners",
                            "why": f"They sold {round(sum(p['sold'] for p in sold_out))} units (₹{int(v):,}) in {days}d but now have zero stock."})
    if fast_low:
        action_plan.append({"priority": "High", "action": f"Replenish {len(fast_low)} fast movers under 21d cover",
                            "why": "Live sell-through will stock these out before the next cycle."})
    if hot_novel:
        action_plan.append({"priority": "Medium", "action": f"Promote {len(hot_novel)} web-wanted, unsold SKUs",
                            "why": "They draw add-to-cart online but aren't converting — merchandising/price fix."})
    if dead_stock:
        action_plan.append({"priority": "Medium", "action": f"Roll/mark-down {len(dead_stock)} idle SKUs (₹{int(insights['idle_value']):,})",
                            "why": f"No sale in {days}d while holding stock — free the capital."})
    if top_city:
        action_plan.append({"priority": "Medium", "action": f"Target {top_city['city']} demand → {top_city.get('target_store','Online / Other')}",
                            "why": f"Top city: {top_city.get('sales_units',0)} units sold, {top_city.get('add_to_cart',0)} web add-to-carts."})
    if to_stock:
        top_atc = sum(t["atc"] for t in to_stock[:20])
        action_plan.insert(0, {"priority": "High", "action": f"Add {len(to_stock)} web-demanded SKUs to {store_name}",
                               "why": f"They pull strong online demand (top 20 = {top_atc} add-to-carts) but this store holds none — stock them to convert local demand."})
    insights["to_stock_count"] = len(to_stock)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(), "currency": CURRENCY,
        "window_days": days, "store": store or "", "store_name": store_name or "",
        "category": category or "",
        "sold_ranges": sold_ranges, "products": prods[:1500],
        "category_breakdown": category_breakdown, "subtype_breakdown": subtype_breakdown,
        "city_demand": city_demand, "to_stock": to_stock,
        "insights": insights, "action_plan": action_plan,
    }


# ═════════════════════════════════════════════════════════════════════════
#  GEMINI (Vertex AI) — chat NL→SQL + strategy narrative
# ═════════════════════════════════════════════════════════════════════════
_client = None
def genai_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(vertexai=True, project=BQ_PROJECT, location=VERTEX_LOCATION)
    return _client


def gen_text(prompt, retries=2):
    """Generate text via Vertex Gemini over REST (firewall-friendly), with a small retry."""
    last = None
    for _ in range(retries + 1):
        try:
            r = genai_client().models.generate_content(model=VERTEX_MODEL, contents=prompt)
            return (r.text or "").strip()
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


SCHEMA_HINT = f"""
You write BigQuery Standard SQL for a jewellery retailer's inventory analytics.
Only these tables may be queried (fully-qualified, always backtick-quoted):

INVENTORY  `{INVENTORY_TABLE}`  — current stock, item grain. Key columns:
  Store_name STRING, location_name STRING, Full_sku STRING, item_name STRING,
  style_code STRING, type_name STRING (category), collection_name STRING,
  metal_name STRING, karat_name STRING, pieces INT (on-hand qty, filter pieces>0),
  item_rate NUMERIC (unit cost), Shopify_price STRING, document_date DATE (stock-in date),
  is_allocated INT, pdp_views INT, add_to_cart INT, begin_checkout INT, first_image STRING.

SALES  `{SALES_TABLE}`  — sales line items (for velocity). Key columns:
  Transaction_Date DATE, company_code STRING (store code), Channel STRING,
  Full_sku STRING, pieces INT (qty sold), gross_amount NUMERIC, type_name STRING,
  collection_name STRING, metal_name STRING, city_name STRING, state_name STRING.

GA4  `{GA4_DATASET}.events_*`  — web funnel. Filter with
  _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL N DAY))
  AND FORMAT_DATE('%Y%m%d', CURRENT_DATE()). event_name in view_item, add_to_cart,
  add_to_wishlist, begin_checkout, purchase. geo.city, geo.region, user_pseudo_id.

Join inventory↔sales on Full_sku (network velocity; store codes do NOT map 1:1 to Store_name).
"""

# Real mutating statements only — function names like REPLACE()/ARRAY are fine in a SELECT.
DENY = re.compile(r"\b(insert\s+into|update\s+\w|delete\s+from|drop\s+(table|view|schema|dataset)|"
                  r"create\s+(table|view|or\s+replace|schema|function|procedure)|alter\s+(table|view|schema)|"
                  r"\bmerge\s+into|truncate\s+table|grant\s+|revoke\s+)", re.I)


def gen_sql(question):
    prompt = (SCHEMA_HINT +
              "\nWrite ONE read-only SELECT (or WITH…SELECT) that answers the question. "
              "Always add a LIMIT (<=500). Return ONLY the SQL, no markdown, no comment.\n\n"
              f"Question: {question}\nSQL:")
    txt = gen_text(prompt)
    txt = re.sub(r"^```[a-zA-Z]*", "", txt).strip().strip("`").strip()
    return txt


def safe_sql(sql):
    s = sql.strip().rstrip(";")
    low = s.lower()
    if not (low.startswith("select") or low.startswith("with")):
        return None, "Only SELECT/WITH queries are allowed."
    if ";" in s:                       # no second statement smuggled in
        return None, "Only a single statement is allowed."
    if DENY.search(s):
        return None, "Query contains a data-modifying statement."
    # only whitelisted tables
    for tref in re.findall(r"`([^`]+)`", s):
        base = tref.split(".events_")[0] if ".events_" in tref else tref
        allowed = (tref.startswith(GA4_DATASET) or tref == INVENTORY_TABLE or tref == SALES_TABLE
                   or base == GA4_DATASET)
        if not allowed:
            return None, f"Table not allowed: {tref}"
    if not re.search(r"\blimit\b", low):
        s += "\nLIMIT 500"
    return s, None


def run_chat(question):
    c = bq()
    sql = gen_sql(question)
    safe, err = safe_sql(sql)
    if err:
        return {"question": question, "sql": sql, "error": err}
    # dry-run for cost guard
    dry = c.query(safe, job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False))
    gb = (dry.total_bytes_processed or 0) / 1e9
    if gb > CHAT_MAX_GB:
        return {"question": question, "sql": safe,
                "error": f"Query would scan {gb:.1f} GB (> {CHAT_MAX_GB} GB cap). Narrow the date range."}
    job = c.query(safe, job_config=bigquery.QueryJobConfig(
        maximum_bytes_billed=int(CHAT_MAX_GB * 1e9)))
    rows = [dict(r) for r in job.result(max_results=500)]
    for r in rows:
        for k, v in r.items():
            if isinstance(v, (datetime, date)):
                r[k] = v.isoformat()
            elif hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                r[k] = float(v)
    # natural-language answer
    sample = json.dumps(rows[:30], default=jdefault)
    ans_prompt = (f"You are an inventory strategist for a jewellery brand. Question: {question}\n"
                  f"Query returned {len(rows)} rows. Data (first 30): {sample}\n"
                  "Answer in 2-4 crisp sentences with the concrete numbers and one action. "
                  "Currency is INR (₹).")
    try:
        answer = gen_text(ans_prompt)
    except Exception as e:  # noqa: BLE001
        answer = f"(Returned {len(rows)} rows; narrative unavailable: {e})"
    return {"question": question, "sql": safe, "row_count": len(rows),
            "scanned_gb": round(gb, 3), "rows": rows, "answer": answer}


def run_ai_strategy(summary):
    prompt = (
        "You are the Head of Inventory & Merchandising for Lucira, an Indian fine-jewellery brand "
        "(gold + diamond). Below is a JSON summary of the live inventory position, velocity, aging, "
        "GA4 demand and reorder needs. Write a sharp strategy brief for the CEO.\n\n"
        "Cover, with specific numbers from the data and ₹ (INR):\n"
        "1. Inventory refresh strategy (what to reorder now, days-of-cover logic).\n"
        "2. Running stock alerts — the most urgent CRITICAL/LOW risks.\n"
        "3. Inventory rolling — dead & overstock capital locked, what to liquidate/transfer.\n"
        "4. Store-level actions — which store needs what.\n"
        "5. GA4-driven visibility — high-demand low-stock SKUs to push, silent stock to expose.\n"
        "Use short markdown sections and bullet points. Be decisive, quantified, action-first.\n\n"
        f"DATA:\n{json.dumps(summary, default=jdefault)[:14000]}"
    )
    return gen_text(prompt)


def strategy_summary(bundle):
    """Small digest fed to the strategy model (keeps the prompt lean)."""
    top_reorder = sorted(bundle["items"], key=lambda x: x["reorder_value"], reverse=True)[:15]
    top_dead    = sorted([i for i in bundle["items"] if i["status"] == "DEAD"],
                         key=lambda x: x["cost_value"], reverse=True)[:15]
    return {
        "currency": bundle["currency"], "params": bundle["params"], "kpis": bundle["kpis"],
        "bullion": {k: bundle["bullion"][k] for k in ("lines","pieces","value","gold_coin","silver_coin")},
        "stores": bundle["stores"], "aging": bundle["aging"], "funnel": bundle["funnel"],
        "price_bands": bundle["price_bands"], "geo_targeting": bundle["geo_targeting"],
        "assortment_coverage": [{k: s[k] for k in ("store","held","gap","coverage_pct","transfer_fillable")} for s in bundle["assortment"]["by_store"]],
        "geo_top": bundle["geo"][:12],
        "top_reorder": [{k: t[k] for k in ("sku","name","store","on_hand","vpd","cover","reorder_qty","reorder_value")} for t in top_reorder],
        "top_dead":    [{k: t[k] for k in ("sku","name","store","on_hand","cost_value","days_in_stock")} for t in top_dead],
        "hot_low_stock": [{k: t[k] for k in ("sku","name","store","add_to_cart","on_hand","cover")} for t in bundle["visibility"]["hot_low_stock"][:15]],
    }


# ═════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═════════════════════════════════════════════════════════════════════════
@functions_framework.http
def inventory_data(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    action = (request.args.get("action") or "bundle").lower()

    try:
        if action == "health":
            return (json.dumps({"ok": True, "service": "inventory-strategy-api",
                                "model": VERTEX_MODEL, "tables": {
                                    "inventory": INVENTORY_TABLE, "sales": SALES_TABLE, "ga4": GA4_DATASET}}),
                    200, CORS)

        if action == "chat":
            body = request.get_json(silent=True) or {}
            q = (body.get("question") or request.args.get("q") or "").strip()
            if not q:
                return (json.dumps({"error": "Provide 'question'."}), 400, CORS)
            return (json.dumps(run_chat(q), default=jdefault), 200, CORS)

        if action == "product":
            days = request.args.get("days", "30")
            try: days = int(days)
            except ValueError: days = 30
            store = (request.args.get("store") or "").strip()
            category = (request.args.get("category") or "").strip()
            return (json.dumps(build_product(days, store, category), default=jdefault), 200, CORS)

        if action == "stores":
            rows = list(bq().query(
                f"SELECT DISTINCT company_code FROM `{SALES_TABLE}` WHERE company_code IS NOT NULL ORDER BY company_code"
            ).result())
            return (json.dumps({"stores": [r["company_code"] for r in rows]}, default=jdefault), 200, CORS)

        if action == "ai":
            bundle = build_bundle()
            brief = run_ai_strategy(strategy_summary(bundle))
            return (json.dumps({"generated_at": bundle["generated_at"],
                                "strategy_markdown": brief, "kpis": bundle["kpis"]},
                               default=jdefault), 200, CORS)

        # default → full data bundle
        return (json.dumps(build_bundle(), default=jdefault), 200, CORS)

    except Exception as e:  # noqa: BLE001
        return (json.dumps({"error": "server_error", "action": action, "detail": str(e)},
                           default=jdefault), 500, CORS)
