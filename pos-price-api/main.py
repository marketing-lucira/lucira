"""
Lucira POS Product Price — paginated/searchable live API
==========================================================
Backs the "Product Price" tab in dashboard/product-pricing-intelligence.html.

`lucirajewelry-prod.Pos.Product_price` is ~368K rows / ~99MB (one row per
metal/stone BOM line item, 104K distinct item codes) -- too large to embed
as a static JS snapshot the way the dashboard's other tabs do. This service
queries it live, server-side, and returns only one page of results at a time
(and only rows matching the search term, if any) -- the browser never holds
more than `pageSize` rows in memory.

Endpoint (Cloud Run function, entry point `pos_price`):
    GET /?q=<search>&page=<n>&pageSize=<n>
    GET /?q=<search>&format=csv         -- ALL matching rows (no pagination),
                                            streamed as a CSV file download.

    q         optional. Case-insensitive substring match across every
              string column (item_code, item_name, shape_name, ...). Numeric
              columns are matched by casting to string, so "50000" also
              matches a Selling Price / SP per Ct value.
    page      1-based page number (default 1). Ignored when format=csv.
    pageSize  rows per page (default 50, max 500). Ignored when format=csv.
    format    "csv" streams every row matching `q` (up to CSV_ROW_CAP) as
              text/csv with a Content-Disposition attachment header, so the
              browser downloads it directly instead of holding it in JS memory.

Response (default, JSON):
    { rows: [...], total, page, pageSize, columns: [...], generated_at }

Deploy: see deploy.sh / README.md.
"""
import base64, csv, gzip, hashlib, hmac, io, json, math, os, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import functions_framework
from google.cloud import bigquery, storage

BQ_PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
TABLE      = os.environ.get("PRICE_TABLE", "lucirajewelry-prod.Pos.Product_price")
SHOPIFY_PRODUCTS_TABLE = os.environ.get("SHOPIFY_PRODUCTS_TABLE", "lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_products")
MAX_PAGE_SIZE = 500
DEFAULT_PAGE_SIZE = 50
CSV_ROW_CAP = 500000  # safety cap; the table is ~368K rows as of 2026-09-04

# ═══════════════════════════════════════════════════════════════════════
# Daily snapshot -- the expensive full-dataset build (all_product_price_
# rows_full / all_variant_rows_full, both further down) used to re-run on
# EVERY /?full=1 and /variant-level?full=1 request, which is what made the
# dashboard slow to open. Now that work runs ONCE A DAY (Cloud Scheduler ->
# POST /refresh-snapshot at 12:01 PM IST -- see refresh_snapshots()) and the
# result is materialized into these 2 BigQuery tables; /?full=1 and
# /variant-level?full=1 below just SELECT * from them (fast, no
# recomputation). snapshot_runs tracks one row per attempt (success or
# failure) so a broken refresh never overwrites the last good snapshot and
# is still visible for diagnosis -- see refresh_snapshots().
SNAPSHOT_DATASET = os.environ.get("SNAPSHOT_DATASET", "lucirajewelry-prod.pricing_snapshots")
PRODUCT_PRICE_SNAPSHOT_TABLE = f"{SNAPSHOT_DATASET}.product_price_snapshot"
VARIANT_SNAPSHOT_TABLE = f"{SNAPSHOT_DATASET}.variant_level_snapshot"
SNAPSHOT_RUNS_TABLE = f"{SNAPSHOT_DATASET}.snapshot_runs"
# The BigQuery tables above are the durable source of truth (per spec), but
# re-fetching ~370K/~105K rows through the BigQuery client and re-serializing
# them to JSON on every /?full=1 request still took ~80s -- almost all of it
# Python-side row iteration + json.dumps, not the (sub-2s) BigQuery query
# itself. refresh_snapshots() ALSO renders the exact gzip response body
# once and stores it in this bucket; /?full=1 / /variant-level?full=1 then
# return that object's public URL instead of proxying the bytes -- Cloud
# Functions/Run enforces a hard ~10MB response-size ceiling ("Response size
# was too large") and these blobs (~8MB gzipped) sit right at that edge, so
# the browser fetches the object directly from GCS instead (see ppi.js
# fetchPosPriceAll/fetchVariantAll's 2-step fetch). A DEDICATED bucket
# (not the shared lucirajewelry-prod-dashboards one) has allUsers:
# objectViewer -- this is no wider than the existing exposure, since
# /?full=1 was already fully unauthenticated data; the dedicated bucket
# just avoids making the *shared* bucket's unrelated files public too.
# Falls back to a live BigQuery read (query_snapshot_rows) if a cached
# blob is ever missing -- never a hard dependency on GCS being warm.
SNAPSHOT_GCS_BUCKET = os.environ.get("SNAPSHOT_GCS_BUCKET", "lucirajewelry-prod-pricing-snapshots")
SNAPSHOT_GCS_PREFIX = os.environ.get("SNAPSHOT_GCS_PREFIX", "pricing-snapshots")
PRODUCT_PRICE_SNAPSHOT_BLOB = f"{SNAPSHOT_GCS_PREFIX}/product_price_full.json.gz"
VARIANT_SNAPSHOT_BLOB = f"{SNAPSHOT_GCS_PREFIX}/variant_level_full.json.gz"
# Shared secret Cloud Scheduler must send as X-Refresh-Token -- refreshing
# the snapshot is expensive (the very thing this system exists to avoid
# doing on a whim), so the endpoint is not left open to the public internet
# the way the read-only GETs are. Refuses to run at all if unset.
REFRESH_TOKEN = os.environ.get("REFRESH_TOKEN", "")

try:
    from zoneinfo import ZoneInfo
    _IST = ZoneInfo("Asia/Kolkata")
except Exception:
    _IST = None

# Display/sort order ONLY for the Product Price tab -- Item Group values
# themselves are never changed. Gold rows first, then Diamond, then every
# other Item Group (Color Stone, Silver, Platinum, blank, ...) last.
ITEM_GROUP_SORT_EXPR = r"""
    CASE item_group_name
      WHEN 'Gold' THEN 1
      WHEN 'Diamond' THEN 2
      ELSE 3
    END
"""

# Verbatim column order matching the BigQuery schema (see build_ppi_data.py
# sibling notes) -- the dashboard's PP_COLS keys must match these exactly.
COLUMNS = [
    "item_code", "item_name", "weight", "pieces", "net_weight", "purity", "pure_weight",
    "bom_rate", "bom_base_amount", "center_stone", "item_group_name", "base_item",
    "type_code", "metal_name", "karat_code", "metal_color_code", "collection_name",
    "super_type_name", "shape_name", "stone_size_id", "stone_size_name", "quality_name",
    "stone_color_name", "type_name", "metal_amount", "sp_ct", "Diamond_type", "Saleing_price",
]

# CSV export mirrors the dashboard's merged "Metal Amount / SP per Ct" column:
# metal_amount and sp_ct collapse into one column since a row is always METAL
# xor STONE, never both. Labels match dashboard/ppi.js's PP_COLS exactly.
CSV_COLUMNS = [c for c in COLUMNS if c not in ("metal_amount", "sp_ct")]
# Attribute = common_attributes.attribute of the stone_rates row that priced
# this line (same match as Purchase Rate); blank when no rate matched.
CSV_COLUMNS.insert(CSV_COLUMNS.index("item_name") + 1, "attribute")
# Cost Price / Sale Price = Stone Rate Slab purchase_rate / sales_rate for this
# row's Attribute + Carat Weight (see slab_priced in _g2d_ranked_cte).
CSV_COLUMNS.insert(CSV_COLUMNS.index("attribute") + 1, "cost_price")
CSV_COLUMNS.insert(CSV_COLUMNS.index("cost_price") + 1, "sale_price")
CSV_COLUMNS.insert(CSV_COLUMNS.index("item_group_name") + 1, "discount_pct")
CSV_COLUMNS.insert(CSV_COLUMNS.index("discount_pct") + 1, "diamond_disc_pct")
CSV_COLUMNS.insert(CSV_COLUMNS.index("Diamond_type"), "metal_amount")
CSV_COLUMNS.insert(CSV_COLUMNS.index("Diamond_type") + 1, "g2d_ratio")
CSV_COLUMNS.insert(CSV_COLUMNS.index("g2d_ratio") + 1, "making_charge_per_g")
CSV_COLUMNS.append("overall_selling_price")
CSV_COLUMNS.append("carat_weight")
CSV_COLUMNS.append("purchase_rate")
CSV_COLUMNS.append("purchase_amount")
CSV_COLUMNS.append("diamond_cp")
CSV_LABELS = {
    "item_code": "Item Code", "item_name": "Item Name", "attribute": "Attribute", "cost_price": "Cost Price", "sale_price": "Sale Price", "weight": "Weight", "pieces": "Pieces",
    "net_weight": "Net Weight", "purity": "Purity", "pure_weight": "Pure Weight", "bom_rate": "BOM Rate",
    "bom_base_amount": "BOM Base Amount", "center_stone": "Center Stone", "item_group_name": "Item Group",
    "discount_pct": "Making Discount %", "diamond_disc_pct": "Diamond Disc%",
    "carat_weight": "Carat Weight", "purchase_rate": "Purchase Rate", "purchase_amount": "Pr.Ct Amount",
    "diamond_cp": "Diamond CP",
    "base_item": "Base Item", "type_code": "Type Code", "metal_name": "Metal Name", "karat_code": "Karat Code",
    "metal_color_code": "Metal Color", "collection_name": "Collection", "super_type_name": "Super Type",
    "shape_name": "Shape", "stone_size_id": "Stone Size ID", "stone_size_name": "Stone Size",
    "quality_name": "Quality", "stone_color_name": "Stone Color", "type_name": "Type",
    "metal_amount": "Metal Amount / SP per Ct", "Diamond_type": "Diamond Type", "g2d_ratio": "G2D Ratio",
    "making_charge_per_g": "Making Charge /g",
    "Saleing_price": "Selling Price", "overall_selling_price": "Overall Selling Price",
}

# Discount % is a per-Item-Group master value (Gold / Diamond / Other),
# editable from the dashboard's Product Price panel -- same pattern as the
# G2D Making Charges table. It uses the SAME Gold/Diamond/Other bucketing as
# ITEM_GROUP_SORT_EXPR above (display-only column; never changes Item Group
# values or Overall Selling Price).
ITEM_GROUP_DISCOUNTS_TABLE = os.environ.get("ITEM_GROUP_DISCOUNTS_TABLE", "lucirajewelry-prod.gold_rates.item_group_discounts")
ITEM_GROUP_KEYS = ["gold", "diamond", "other"]


def fetch_item_group_discounts():
    rates = {}
    try:
        bq = _client()
        rows = bq.query(f"SELECT group_key, discount_pct FROM `{ITEM_GROUP_DISCOUNTS_TABLE}`").result()
        rates = {r["group_key"]: float(r["discount_pct"]) for r in rows}
    except Exception:
        pass
    return rates


def _discount_pct_case(discounts):
    params = [
        bigquery.ScalarQueryParameter("disc_gold", "FLOAT64", discounts.get("gold", 0.0)),
        bigquery.ScalarQueryParameter("disc_diamond", "FLOAT64", discounts.get("diamond", 0.0)),
        bigquery.ScalarQueryParameter("disc_other", "FLOAT64", discounts.get("other", 0.0)),
    ]
    case_sql = r"""
        CASE
          WHEN STARTS_WITH(UPPER(item_code), 'LJ-GC') THEN 0
          WHEN item_group_name = 'Gold' THEN @disc_gold
          WHEN item_group_name = 'Diamond' THEN @disc_diamond
          ELSE @disc_other
        END AS discount_pct
    """
    return case_sql, params


# Variant Level's G2D / Making Charge /g / Discount % -- computed from
# items.diamond_weight / items.net_weight (NOT the pre-stored items.g2d
# column, which is no longer used), matched against the SAME live
# g2d_making_charges master bands the Product Price tab reads (edit one,
# both tabs reflect it). No Plain-Gold-naming or Item-Group gating here --
# just the ratio matched straight to its band; a ratio of 0 or blank
# naturally lands in the lowest band or stays blank.
_VARIANT_G2D_BANDS = [
    ("supper_ultra_low", "mc_sul", "dp_sul", 3500, 30),
    ("ultra_low",        "mc_ul",  "dp_ul",  3500, 30),
    ("low",              "mc_low", "dp_low", 3000, 30),
    ("medium",           "mc_med", "dp_med", 2500, 50),
    ("high",             "mc_high","dp_high",2500, 50),
    ("ultra_high",       "mc_uh",  "dp_uh",  2500, 50),
    ("supper_ultra_high","mc_suh", "dp_suh", 2500, 50),
]
_VARIANT_G2D_EXPR = (
    "CASE WHEN net_weight IS NOT NULL AND net_weight > 0 AND diamond_weight IS NOT NULL "
    "THEN ROUND(diamond_weight / net_weight, 4) ELSE NULL END"
)


G2D_BAND_LABELS = [
    (0.049, "Supper Ultra Low"), (0.099, "Ultra Low"), (0.199, "Low"),
    (0.299, "Medium"), (0.499, "High"), (0.999, "Ultra High"),
]


def g2d_band_label(ratio):
    """Same cutoffs as _variant_g2d_case's WHEN clauses -- the G2D Band name
    (fixed, never editable) for a given G2D Ratio. None when ratio is blank."""
    if ratio is None:
        return None
    for cutoff, label in G2D_BAND_LABELS:
        if ratio <= cutoff:
            return label
    return "Supper Ultra High"


# Same cutoffs as G2D_BAND_LABELS, but returning the g2d_making_charges
# band_key -- used to look up a variant's G2D-band Diamond Discount.
G2D_BAND_KEYS_BY_CUTOFF = [
    (0.049, "supper_ultra_low"), (0.099, "ultra_low"), (0.199, "low"),
    (0.299, "medium"), (0.499, "high"), (0.999, "ultra_high"),
]


def g2d_band_key(ratio):
    if ratio is None:
        return None
    for cutoff, band_key in G2D_BAND_KEYS_BY_CUTOFF:
        if ratio <= cutoff:
            return band_key
    return "supper_ultra_high"


# Variant Level's Diamond Disc% = the variant's G2D band "Diamond Discount"
# (Slab tab, G2D Making Charges panel) -- but ONLY for these diamond
# qualities; every other quality (Round, TQ, Other, ...) gets 0. Replaces
# the old per-code Diamond Slab Disc% on Variant Level.
G2D_DIAMOND_DISCOUNT_QUALITIES = frozenset(("E-F", "CD", "RB", "SC"))


def fetch_g2d_diamond_discounts():
    """{band_key: diamond_dis_pct}, read through fetch_g2d_bands' cache."""
    return {k: v.get("diamond_dis_pct", 0.0) for k, v in fetch_g2d_bands().items()}


# These 4 small config tables (G2D bands, Diamond Slab, Labour, gold rate)
# used to be re-queried from BigQuery on EVERY single request -- fine in
# isolation, but an exact Variant search that hits all 4 turns "one fast
# combined query" into 5 separate BigQuery round-trips. A short (60s) TTL
# cache cuts that back to ~1 per minute per warm instance while still
# picking up a Slab-tab edit within a minute -- same "short-lived cache,
# never stale calculations" tradeoff Total Diamond CP etc. already use at
# 30 min; this is deliberately much shorter since these feed EVERY search.
_SMALL_CONFIG_TTL_SEC = 60
_G2D_BANDS_CACHE = {"ts": 0.0, "data": {}}


def fetch_g2d_bands():
    now = time.time()
    if _G2D_BANDS_CACHE["data"] and (now - _G2D_BANDS_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _G2D_BANDS_CACHE["data"]
    bands = {}
    try:
        bq = _client()
        rows = bq.query(
            f"SELECT band_key, making_charge, dis_pct, COALESCE(diamond_dis_pct, 0) AS diamond_dis_pct "
            f"FROM `{MAKING_CHARGES_TABLE}`").result()
        bands = {r["band_key"]: {"making_charge": float(r["making_charge"]), "dis_pct": float(r["dis_pct"]),
                                 "diamond_dis_pct": float(r["diamond_dis_pct"])} for r in rows}
    except Exception:
        pass
    if bands:
        _G2D_BANDS_CACHE["data"] = bands
        _G2D_BANDS_CACHE["ts"] = now
    return bands or _G2D_BANDS_CACHE["data"]


def _variant_g2d_case(bands):
    params = []
    for band_key, mc_param, dp_param, mc_default, dp_default in _VARIANT_G2D_BANDS:
        b = bands.get(band_key, {})
        params.append(bigquery.ScalarQueryParameter(mc_param, "FLOAT64", b.get("making_charge", mc_default)))
        params.append(bigquery.ScalarQueryParameter(dp_param, "FLOAT64", b.get("dis_pct", dp_default)))
    g = _VARIANT_G2D_EXPR
    mc_case = f"""
        CASE
          WHEN {g} IS NULL THEN NULL
          WHEN {g} <= 0.049 THEN @mc_sul  WHEN {g} <= 0.099 THEN @mc_ul
          WHEN {g} <= 0.199 THEN @mc_low  WHEN {g} <= 0.299 THEN @mc_med
          WHEN {g} <= 0.499 THEN @mc_high WHEN {g} <= 0.999 THEN @mc_uh
          ELSE @mc_suh
        END AS making_charge_per_g
    """
    dp_case = f"""
        CASE
          WHEN {g} IS NULL THEN NULL
          WHEN {g} <= 0.049 THEN @dp_sul  WHEN {g} <= 0.099 THEN @dp_ul
          WHEN {g} <= 0.199 THEN @dp_low  WHEN {g} <= 0.299 THEN @dp_med
          WHEN {g} <= 0.499 THEN @dp_high WHEN {g} <= 0.999 THEN @dp_uh
          ELSE @dp_suh
        END AS discount_pct
    """
    return mc_case, dp_case, params


def item_group_discount_list():
    bq = _client()
    rows = bq.query(
        f"SELECT group_key, sort_order, label, discount_pct, updated_at "
        f"FROM `{ITEM_GROUP_DISCOUNTS_TABLE}` ORDER BY sort_order"
    ).result()
    out = []
    for r in rows:
        out.append({
            "group_key": r["group_key"], "sort_order": int(r["sort_order"]),
            "label": r["label"], "discount_pct": float(r["discount_pct"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })
    return out


def item_group_discount_update(group_key, discount_pct):
    if group_key not in ITEM_GROUP_KEYS:
        raise ValueError(f"unknown group_key {group_key!r}")
    if not (0 <= discount_pct <= 100):
        raise ValueError("discount_pct must be between 0 and 100")
    bq = _client()
    bq.query(
        f"UPDATE `{ITEM_GROUP_DISCOUNTS_TABLE}` SET discount_pct = @d, updated_at = CURRENT_TIMESTAMP() "
        f"WHERE group_key = @group_key",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("d", "FLOAT64", discount_pct),
            bigquery.ScalarQueryParameter("group_key", "STRING", group_key),
        ]),
    ).result()
    return item_group_discount_list()


# Diamond Slab -- master table gold_rates.diamond_slab (Code/Rate/Cost/Disc%,
# seeded from the sheet's Diamond Slab block). Only Disc% is editable from
# the dashboard, matching the ask; Rate/Cost stay as stored. "Diamond Disc%"
# on the Product Price tab is this same live Disc%, matched via each row's
# Diamond Type against Code -- edit one place, the other follows.
DIAMOND_SLAB_TABLE = os.environ.get("DIAMOND_SLAB_TABLE", "lucirajewelry-prod.gold_rates.diamond_slab")
DIAMOND_SLAB_CODES = ["E-F", "CD", "RB", "SC", "Round", "TQ", "Other"]


def diamond_slab_list():
    bq = _client()
    rows = bq.query(
        f"SELECT code, sort_order, rate, cost, disc_pct, updated_at "
        f"FROM `{DIAMOND_SLAB_TABLE}` ORDER BY sort_order"
    ).result()
    out = []
    for r in rows:
        out.append({
            "code": r["code"], "sort_order": int(r["sort_order"]),
            "rate": float(r["rate"]), "cost": float(r["cost"]), "disc_pct": float(r["disc_pct"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })
    return out


def diamond_slab_update(code, disc_pct):
    if code not in DIAMOND_SLAB_CODES:
        raise ValueError(f"unknown code {code!r}")
    if not (0 <= disc_pct <= 100):
        raise ValueError("disc_pct must be between 0 and 100")
    bq = _client()
    bq.query(
        f"UPDATE `{DIAMOND_SLAB_TABLE}` SET disc_pct = @d, updated_at = CURRENT_TIMESTAMP() WHERE code = @code",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("d", "FLOAT64", disc_pct),
            bigquery.ScalarQueryParameter("code", "STRING", code),
        ]),
    ).result()
    # Invalidate the 60s TTL cache immediately -- otherwise a snapshot rebuild
    # triggered right after this write (see _safe_refresh_snapshots) could
    # still read the pre-update value from a warm instance's own in-memory
    # cache instead of what was just saved.
    _DIAMOND_SLAB_DISCOUNTS_CACHE["ts"] = 0.0
    _DIAMOND_SLAB_DISCOUNTS_CACHE["data"] = {}
    return diamond_slab_list()


# Labour -- Variant Level's "CP. pr gm making" now reads the ERP Labour Rate
# Slab (gold_rates.labour_rate_slab view = Lucira_Prod.labour_rates x
# common_attributes; see LABOUR_RATE_SLAB_VIEW / fetch_labour_rate_slab). The
# old editable gold_rates.labour_rates table (FOR ALL PRODUCTS / BELOW 1.5 GMS)
# was removed 2026-10-01 per the user. Same calculation shape as before:
#   Net Weight <= cutoff -> a FIXED amount (unchanged);
#   Net Weight >  cutoff -> Net Weight x Labour Charge, where Labour Charge is
#   the slab matching the variant's own item group + type (Rings, Pendants...;
#   falls back to that group's "NA" type) and weight -- G2D ratio for
#   Diamond/Platinum Jewellery (their bands are the G2D ranges), Net Weight for
#   every other group. No matching slab -> Labour Charge blank, CP 0.
LABOUR_NET_WEIGHT_CUTOFF = 1.5  # GM
CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF = 1500.0

# Gold coins = item codes starting LJ-GC (the silver coin is LJ-SC, untouched).
GOLD_COIN_MAKING_CHARGE_PER_G = float(os.environ.get("GOLD_COIN_MAKING_CHARGE_PER_G", "500"))
GOLD_COIN_CP_MAKING_PER_G = float(os.environ.get("GOLD_COIN_CP_MAKING_PER_G", "200"))


def _is_gold_coin(item_code):
    return (item_code or "").strip().upper().startswith("LJ-GC")
LABOUR_G2D_GROUPS = ("diamond jewellery", "platinum jewellery")

# Cash Back -- Variant Level only, from Product Composition + Final After
# GST Overall, against master table gold_rates.cash_back_rates (editable
# from the Slab tab -- never hard-coded here; the constants below are only
# the last-known-good fallback if that table is ever unreachable/empty,
# same pattern as every other editable master table in this file).
# Threshold is strictly greater-than, so exactly at the threshold is 0%.
# Diamond tier: ANY component-level presence of Diamond (has_diamond flag --
# same one Product Composition itself is built from), not an exact-string
# match on "Diamond" alone -- so a mixed "Diamond/Gold" or "Diamond/Gems
# Stone" SKU qualifies too, same as pure Diamond, per explicit request.
# Gold tier: still exact "Plain Gold" (gold-only, no diamond/gems) --
# unaffected, since Plain Gold by definition never has_diamond.
CASH_BACK_TABLE = os.environ.get("CASH_BACK_TABLE", "lucirajewelry-prod.gold_rates.cash_back_rates")
CASH_BACK_KEYS = ["plain_gold", "diamond"]
CASH_BACK_THRESHOLD = 25000.0
CASH_BACK_PLAIN_GOLD_PCT = 3.0
CASH_BACK_DIAMOND_PCT = 5.0


def cash_back_rates_list():
    bq = _client()
    rows = bq.query(
        f"SELECT rate_key, sort_order, label, threshold, cash_back_pct, updated_at "
        f"FROM `{CASH_BACK_TABLE}` ORDER BY sort_order"
    ).result()
    out = []
    for r in rows:
        out.append({
            "rate_key": r["rate_key"], "sort_order": int(r["sort_order"]),
            "label": r["label"], "threshold": float(r["threshold"]), "cash_back_pct": float(r["cash_back_pct"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })
    return out


def cash_back_rates_update(rate_key, threshold=None, cash_back_pct=None):
    if rate_key not in CASH_BACK_KEYS:
        raise ValueError(f"unknown rate_key {rate_key!r}")
    if threshold is None and cash_back_pct is None:
        raise ValueError("nothing to update -- provide threshold and/or cash_back_pct")
    set_parts = ["updated_at = CURRENT_TIMESTAMP()"]
    params = [bigquery.ScalarQueryParameter("rate_key", "STRING", rate_key)]
    if threshold is not None:
        if not (threshold >= 0):
            raise ValueError("threshold must be a non-negative number")
        set_parts.append("threshold = @th")
        params.append(bigquery.ScalarQueryParameter("th", "FLOAT64", threshold))
    if cash_back_pct is not None:
        if not (0 <= cash_back_pct <= 100):
            raise ValueError("cash_back_pct must be between 0 and 100")
        set_parts.append("cash_back_pct = @cb")
        params.append(bigquery.ScalarQueryParameter("cb", "FLOAT64", cash_back_pct))
    bq = _client()
    bq.query(
        f"UPDATE `{CASH_BACK_TABLE}` SET {', '.join(set_parts)} WHERE rate_key = @rate_key",
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    # Invalidate the 60s TTL cache immediately -- see the matching comment in
    # diamond_slab_update.
    _CASH_BACK_RATES_CACHE["ts"] = 0.0
    _CASH_BACK_RATES_CACHE["data"] = {}
    return cash_back_rates_list()


_CASH_BACK_RATES_CACHE = {"ts": 0.0, "data": {}}


def fetch_cash_back_rates():
    """{"plain_gold": {"threshold":.., "cash_back_pct":..}, "diamond": {...}}
    -- cached 60s (see _SMALL_CONFIG_TTL_SEC) so a Slab tab edit is
    reflected within a minute."""
    now = time.time()
    if _CASH_BACK_RATES_CACHE["data"] and (now - _CASH_BACK_RATES_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _CASH_BACK_RATES_CACHE["data"]
    rates = {}
    try:
        bq = _client()
        rows = bq.query(f"SELECT rate_key, threshold, cash_back_pct FROM `{CASH_BACK_TABLE}`").result()
        rates = {r["rate_key"]: {"threshold": float(r["threshold"]), "cash_back_pct": float(r["cash_back_pct"])}
                  for r in rows}
    except Exception:
        pass
    if rates:
        _CASH_BACK_RATES_CACHE["data"] = rates
        _CASH_BACK_RATES_CACHE["ts"] = now
    return rates or _CASH_BACK_RATES_CACHE["data"]


def _cash_back_pct(product_composition, has_diamond, final_after_gst_overall, cash_back_rates=None):
    cash_back_rates = cash_back_rates or {}
    if has_diamond:
        r = cash_back_rates.get("diamond", {})
        threshold, pct = r.get("threshold", CASH_BACK_THRESHOLD), r.get("cash_back_pct", CASH_BACK_DIAMOND_PCT)
    elif product_composition == "Plain Gold":
        r = cash_back_rates.get("plain_gold", {})
        threshold, pct = r.get("threshold", CASH_BACK_THRESHOLD), r.get("cash_back_pct", CASH_BACK_PLAIN_GOLD_PCT)
    else:
        return 0.0
    if final_after_gst_overall is None or final_after_gst_overall <= threshold:
        return 0.0
    return pct


_LABOUR_SLAB_CACHE = {"ts": 0.0, "data": {}}


def fetch_labour_rate_slab():
    """{(item_group_lower, type_lower): [(from_weight, to_weight, rate), ...]}
    from the Labour Rate Slab view -- cached like the other small configs."""
    now = time.time()
    if _LABOUR_SLAB_CACHE["data"] and (now - _LABOUR_SLAB_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _LABOUR_SLAB_CACHE["data"]
    out = {}
    try:
        bq = _client()
        rows = bq.query(
            f"SELECT item_group_name, type_name, from_weight, to_weight, purchase_rate "
            f"FROM `{LABOUR_RATE_SLAB_VIEW}` WHERE purchase_rate IS NOT NULL"
        ).result()
        for r in rows:
            k = ((r["item_group_name"] or "").strip().lower(), (r["type_name"] or "").strip().lower())
            out.setdefault(k, []).append((float(r["from_weight"]), float(r["to_weight"]), float(r["purchase_rate"])))
    except Exception as e:
        print(f"[labour-slab] query failed: {e}")
    if out:
        _LABOUR_SLAB_CACHE["data"] = out
        _LABOUR_SLAB_CACHE["ts"] = now
    return out or _LABOUR_SLAB_CACHE["data"]


def labour_charge_for(labour_slab, group, type_name, net_weight, g2d):
    """Labour Charge (per gram) for one variant, or None if no slab matches.
    Exact type first, then the group's "NA" type; narrowest slab wins."""
    g = (group or "").strip().lower()
    if not g or not labour_slab:
        return None
    w = (g2d or 0.0) if g in LABOUR_G2D_GROUPS else (net_weight or 0.0)
    for t in ((type_name or "").strip().lower(), "na"):
        hits = [s for s in labour_slab.get((g, t), []) if s[0] <= w <= s[1]]
        if hits:
            return min(hits, key=lambda s: s[1] - s[0])[2]
    return None


_DIAMOND_SLAB_DISCOUNTS_CACHE = {"ts": 0.0, "data": {}}


def fetch_diamond_slab_discounts():
    now = time.time()
    if _DIAMOND_SLAB_DISCOUNTS_CACHE["data"] and (now - _DIAMOND_SLAB_DISCOUNTS_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _DIAMOND_SLAB_DISCOUNTS_CACHE["data"]
    discounts = {}
    try:
        bq = _client()
        rows = bq.query(f"SELECT code, disc_pct FROM `{DIAMOND_SLAB_TABLE}`").result()
        discounts = {r["code"]: float(r["disc_pct"]) for r in rows}
    except Exception:
        pass
    if discounts:
        _DIAMOND_SLAB_DISCOUNTS_CACHE["data"] = discounts
        _DIAMOND_SLAB_DISCOUNTS_CACHE["ts"] = now
    return discounts or _DIAMOND_SLAB_DISCOUNTS_CACHE["data"]


def _diamond_disc_pct_case(discounts, column_expr="Diamond_type", param_prefix="dd", gate_expr=None):
    """gate_expr, if given (e.g. "pv.item_group = 'Diamond'"), makes the whole
    column 0 when false -- used on Variant Level so a non-Diamond variant
    shows 0 rather than deriving anything from a stray Diamond Type."""
    params = [
        bigquery.ScalarQueryParameter(f"{param_prefix}_{i}", "FLOAT64", discounts.get(code, 0.0))
        for i, code in enumerate(DIAMOND_SLAB_CODES)
    ]
    when_clauses = "\n".join(
        f"WHEN {column_expr} = '{code}' THEN @{param_prefix}_{i}" for i, code in enumerate(DIAMOND_SLAB_CODES)
    )
    inner_case = f"CASE {when_clauses} ELSE NULL END"
    if gate_expr:
        case_sql = f"CASE WHEN {gate_expr} THEN ({inner_case}) ELSE 0 END AS diamond_disc_pct"
    else:
        case_sql = f"{inner_case} AS diamond_disc_pct"
    return case_sql, params


# Same purity multipliers as the Metal Rate sheet block (build_ppi_data.py
# RATE_CARD_RAW): 22K 92%, 18K 76%, 14K 59%, 9K 40% of the 24K (999) rate.
KARAT_PURITY = {"24": 1.00, "22": 0.92, "18": 0.76, "14": 0.59, "9": 0.40}
# Single source of truth for the Gold Rate -- Pos.metal_rates (the 'Gold'
# row, joined to Pos.item_groups for the name match), NEVER a hard-coded or
# manually-entered value. `sales_rate * 10` = price per 10g, same
# convention the old gold_rates.daily_gold_prices table used, so the
# per-gram/KT-split math below is unchanged. "Latest applicable" = the
# newest from_date that is <= today (Asia/Kolkata); if today has no row
# yet, the most recent earlier date's rate is used automatically -- no
# code change needed when a new day's rate is added to the table.
METAL_RATES_TABLE = os.environ.get("METAL_RATES_TABLE", "lucirajewelry-prod.Pos.metal_rates")
ITEM_GROUPS_TABLE = os.environ.get("ITEM_GROUPS_TABLE", "lucirajewelry-prod.Pos.item_groups")


_GOLD_RATES_CACHE = {"ts": 0.0, "data": {}}


def todays_gold_rates():
    """{"24": rate_per_gram, "22": ..., ...} from Pos.metal_rates (see
    module comment above) -- the SAME source drives Product Price, Variant
    Level, the Slab tab's Metal Rate/Gold rows, and Saved History (via
    gold-rate-api, which runs the identical query). No hard-coded fallback:
    if the table is unreachable and nothing has ever been fetched yet, this
    returns {} and every dependent calculation blanks out rather than
    fabricating a number -- an honest empty beats a fake rate. Cached 60s
    (see _SMALL_CONFIG_TTL_SEC) -- gold rate changes at most once a day, so
    a 60s-stale read is never actually stale in practice."""
    now = time.time()
    if _GOLD_RATES_CACHE["data"] and (now - _GOLD_RATES_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _GOLD_RATES_CACHE["data"]
    result = {}
    try:
        bq = _client()
        rows = list(bq.query(f"""
            SELECT a.sales_rate * 10 AS gold_rate
            FROM `{METAL_RATES_TABLE}` a
            LEFT JOIN `{ITEM_GROUPS_TABLE}` b ON a.metal_type_id = b.item_group_id
            WHERE b.item_group_name = 'Gold'
              AND DATE(a.from_date) <= CURRENT_DATE('Asia/Kolkata')
            ORDER BY a.from_date DESC, a.rate_id DESC
            LIMIT 1
        """).result())
        if rows and rows[0]["gold_rate"] is not None:
            per_gram_24k = float(rows[0]["gold_rate"]) / 10.0
            result = {kt: round(per_gram_24k * mult, 2) for kt, mult in KARAT_PURITY.items()}
    except Exception:
        pass
    if result:
        _GOLD_RATES_CACHE["data"] = result
        _GOLD_RATES_CACHE["ts"] = now
        return result
    return _GOLD_RATES_CACHE["data"]  # last-known-good live value (never a hard-coded one), or {}


def _norm_karat(code):
    # karat_code is stored zero-padded for some rows (e.g. "09" for 9K --
    # 5,452 Gold SKUs as of 2026-09-16), while KARAT_PURITY/gold_rates keys
    # are un-padded ("9"). Strip leading zeros so both spellings resolve to
    # the same rate instead of silently missing and zeroing out Metal Amount.
    c = str(code or "").strip()
    stripped = c.lstrip("0")
    return stripped if stripped else c


def merged_amount(row, gold_rates):
    # No multiplying by weight, no recalculation -- Metal Amount / SP per Ct
    # is exactly the karat's per-gram gold rate for METAL rows.
    if row.get("base_item") == "METAL":
        rate = gold_rates.get(_norm_karat(row.get("karat_code")))
        return rate if rate is not None else row.get("metal_amount")
    return row.get("sp_ct")


def selling_price(row, gold_rates):
    existing = row.get("Saleing_price")
    if existing is not None:
        return existing  # never overwrite/recalculate an existing value
    if row.get("item_group_name") == "Gold":
        rate = gold_rates.get(_norm_karat(row.get("karat_code")))  # == Metal Amount / SP per Ct
        net_wt = row.get("net_weight")
        if rate is not None and net_wt is not None:
            try:
                return round(float(net_wt) * rate, 2)
            except (TypeError, ValueError):
                pass
    return None  # blank, non-Gold: stays blank


def overall_selling_price(row, gold_rates):
    """Just Selling Price -- Making Charge /g is NOT added in anymore
    (removed per explicit request; it was double-counting since Making
    Charge is a rate, not a weighted amount)."""
    return selling_price(row, gold_rates)


# ═══════════════════════════════════════════════════════════════════════
# Variant Level -- one row per Variant (= items.item_code), NOT per
# component/material line. Backs the dashboard's "Variant Level" tab,
# alongside (not replacing) the component-level Product Price tab.
#
# Master/source: ds_imputed_reporting.items (already 1 row per item_code,
# same table/key used for G2D Ratio -- reused here as the variant list, not
# duplicated as a separate lookup).
#
# Overall Selling Price per variant = SUM of every Product_price COMPONENT
# row's Overall Selling Price (== Selling Price -- Making Charge is no longer
# added in) for that item_code -- i.e. every stone line + the metal line,
# added up. Since Overall Selling Price depends only on Saleing_price /
# item_group_name / karat_code / net_weight (NOT on G2D ratio or Making
# Charge at all anymore), this aggregates with a single GROUP BY straight in
# BigQuery -- no need for the expensive G2D-ranked/making-charge CTE chain
# that Product Price's per-row Making Charge /g column requires. This is
# what makes Variant Level's cold load fast: a plain SUM over 368K rows
# instead of pulling every row into Python. A variant with no computable
# component price gets NULL (blank), never 0 -- and it still appears, since
# the base table here is `items`, not Product_price.
# ═══════════════════════════════════════════════════════════════════════
_VARIANT_AGG_CACHE = {"ts": 0.0, "data": {}}
VARIANT_AGG_TTL_SEC = 1800  # re-aggregate at most every 30 min per instance --
# gold rates rarely change within a day, so a cached aggregation stays
# accurate for practical purposes between real edits.

GOLD_RATE_KARAT_PARAMS = [("24", "gr_24"), ("22", "gr_22"), ("18", "gr_18"), ("14", "gr_14"), ("9", "gr_9")]


def _selling_price_sql(gold_rates):
    """SQL mirror of selling_price(): existing Saleing_price kept as-is;
    else Gold rows compute net_weight * that karat's gold rate; else NULL."""
    params = [
        bigquery.ScalarQueryParameter(pname, "FLOAT64", gold_rates.get(karat))
        for karat, pname in GOLD_RATE_KARAT_PARAMS
    ]
    case_sql = r"""
        CASE
          WHEN Saleing_price IS NOT NULL THEN Saleing_price
          WHEN item_group_name = 'Gold' THEN net_weight * (
            CASE IFNULL(NULLIF(LTRIM(TRIM(IFNULL(karat_code, '')), '0'), ''), TRIM(IFNULL(karat_code, '')))
              WHEN '24' THEN @gr_24 WHEN '22' THEN @gr_22 WHEN '18' THEN @gr_18
              WHEN '14' THEN @gr_14 WHEN '9' THEN @gr_9
              ELSE NULL
            END
          )
          ELSE NULL
        END
    """
    return case_sql, params


def build_variant_overall_price_map():
    now = time.time()
    if _VARIANT_AGG_CACHE["data"] and (now - _VARIANT_AGG_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_AGG_CACHE["data"]
    bq = _client()
    gold_rates = todays_gold_rates()
    case_sql, params = _selling_price_sql(gold_rates)
    sql = f"""
        SELECT item_code, SUM(ROUND({case_sql}, 2)) AS total
        FROM `{TABLE}`
        GROUP BY item_code
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    result = {}
    for row in job.result(page_size=5000):
        if row["total"] is not None:
            result[row["item_code"]] = round(float(row["total"]), 2)
    _VARIANT_AGG_CACHE["data"] = result
    _VARIANT_AGG_CACHE["ts"] = now
    return result


# Which item_codes are Variants (Product_price's distinct set), and their
# per-variant Item Group / Consignment flag / representative Diamond Type --
# cached the same way as the price aggregates below. This used to be a live
# GROUP BY over all of Product_price INSIDE every single page/search request
# (via _variant_base_cte's price_variants CTE) -- the actual reason Variant
# Level was slow on every load, not just cold cache misses. Caching it here
# means a normal page/search/sort only touches this dict (in-memory) plus one
# small query against ds_imputed_reporting.items filtered to that page's
# item_codes -- no per-request scan of the 368K-row Product_price table.
_VARIANT_CLASS_CACHE = {"ts": 0.0, "data": {}}


def build_variant_classification_map():
    now = time.time()
    if _VARIANT_CLASS_CACHE["data"] and (now - _VARIANT_CLASS_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_CLASS_CACHE["data"]
    bq = _client()
    sql = f"""
        SELECT item_code,
          ANY_VALUE(item_name) AS item_name_pp,
          CASE
            WHEN LOGICAL_OR(item_group_name = 'Diamond') THEN 'Diamond'
            WHEN LOGICAL_OR(item_group_name = 'Gold') THEN 'Gold'
            ELSE 'Other'
          END AS item_group,
          LOGICAL_OR(LOWER(IFNULL(item_name, '')) LIKE 'consignment%') AS is_consignment,
          MAX(Diamond_type) AS any_diamond_type,
          LOGICAL_OR(LOWER(TRIM(item_group_name)) IN ({_sql_in_list(PRODUCT_COMPOSITION_DIAMOND_GROUPS)})) AS has_diamond,
          LOGICAL_OR(LOWER(TRIM(item_group_name)) IN ({_sql_in_list(PRODUCT_COMPOSITION_GOLD_GROUPS)})) AS has_gold,
          LOGICAL_OR(LOWER(TRIM(item_group_name)) IN ({_sql_in_list(PRODUCT_COMPOSITION_GEMS_GROUPS)})) AS has_gems
        FROM `{TABLE}`
        GROUP BY item_code
    """
    job = bq.query(sql)
    result = {}
    for row in job.result(page_size=5000):
        result[row["item_code"]] = {
            "item_name_pp": row["item_name_pp"], "item_group": row["item_group"],
            "is_consignment": bool(row["is_consignment"]), "any_diamond_type": row["any_diamond_type"],
            "has_diamond": bool(row["has_diamond"]), "has_gold": bool(row["has_gold"]),
            "has_gems": bool(row["has_gems"]),
        }
    _VARIANT_CLASS_CACHE["data"] = result
    _VARIANT_CLASS_CACHE["ts"] = now
    return result


# Diamond Amount / Making Charge Discount -- two more Variant Level columns,
# each a SUM over Product_price COMPONENT rows for that item_code (computed
# BEFORE collapsing to one row per Variant, per the spec):
#   Diamond Amount         = SUM(Selling Price * Diamond Disc% / 100)
#   Making Charge Discount = SUM(Making Charge /g * Making Discount% / 100)
# A row with a NULL/blank Diamond Disc% (not a diamond stone row) or a NULL
# Making Charge /g contributes 0, never removes the variant. Unlike Overall
# Selling Price, Making Charge /g depends on each row's G2D ratio, which
# needs the full ranked/joined chain (_g2d_ranked_cte) -- so this one
# necessarily re-scans everything the way Overall Selling Price used to;
# it's cached the same 30-min way to keep that cost off the common path.
_VARIANT_MD_CACHE = {"ts": 0.0, "data": {}}
METAL_GROUPS = ("Gold", "Silver", "Platinum")
# Gemstone = every non-diamond stone line of the BOM (user, 2026-10-29).
GEMSTONE_GROUPS = ("Color Stone", "Cubic Zirconia")
_GEM_IN_SQL = ", ".join(f"'{g}'" for g in GEMSTONE_GROUPS)
_METAL_IN_SQL = ", ".join(f"'{g}'" for g in METAL_GROUPS)


def _stone_extras_sql(selling_case_sql):
    """Per-variant diamond pieces + "Other BOM" columns (internally still
    gemstone_*), from the BOM lines (Product_price): Type ("Green Pear
    (Synthetic)", NA parts dropped), Pcs, Wt (ct) for the stone lines, and
    Amount = the Selling Price of EVERY BOM line that is neither metal nor
    diamond (colour stone, CZ, accessories -- same rule as Diamond Amount).
    That amount is part of Final After GST (user, 2026-10-30); accessories'
    names / pieces / CP are added from the ERP BOM by _with_accessories."""
    na = lambda c: f"UPPER(TRIM(IFNULL({c}, 'NA'))) IN ('NA', '', 'MIX')"
    gem_type = f"""NULLIF(TRIM(CONCAT(
          IF(item_group_name = 'Cubic Zirconia', 'CZ ', ''),
          IF({na('stone_color_name')}, '', CONCAT(TRIM(stone_color_name), ' ')),
          IF({na('shape_name')}, '', TRIM(shape_name)),
          IF({na('quality_name')}, '', CONCAT(' (', TRIM(quality_name), ')')))), '')"""
    return f"""
          SUM(IF(item_group_name = 'Diamond', IFNULL(pieces, 0), 0)) AS diamond_pieces,
          STRING_AGG(DISTINCT IF(item_group_name IN ({_GEM_IN_SQL}), {gem_type}, NULL), ', ') AS gemstone_type,
          SUM(IF(item_group_name IN ({_GEM_IN_SQL}), IFNULL(pieces, 0), 0)) AS gemstone_pieces,
          SUM(IF(item_group_name IN ({_GEM_IN_SQL}), IFNULL(net_weight, 0), 0)) AS gemstone_weight,
          SUM(IF(item_group_name NOT IN ({_METAL_IN_SQL}, 'Diamond'), IFNULL(ROUND({selling_case_sql}, 2), 0), 0)) AS gemstone_amount"""


def _stone_extras(row):
    """The _stone_extras_sql columns of one result row, as md_map fields."""
    f = lambda v: round(float(v), 3) if v is not None else 0.0
    return {"diamond_pieces": f(row["diamond_pieces"]), "gemstone_type": row["gemstone_type"],
            "gemstone_pieces": f(row["gemstone_pieces"]), "gemstone_weight": f(row["gemstone_weight"]),
            "gemstone_amount": round(float(row["gemstone_amount"] or 0), 2)}


def build_variant_metal_diamond_map():
    """Metal Amount = SUM(Selling Price) over component rows whose Item Group
    is an actual metal (Gold/Silver/Platinum) -- NOT "everything that isn't
    Diamond" (that would wrongly sweep in Color Stone/Accessories/Cubic
    Zirconia rows). Diamond Amount = SUM(Selling Price) over Item Group =
    Diamond rows. Both are pure Selling Price sums, no Making Charge or
    Disc% involved -- selling_price() has no G2D dependency, so unlike the
    old Making Charge-based aggregate this replaced, this is a cheap query
    (same class as build_variant_overall_price_map), cached the same way."""
    now = time.time()
    if _VARIANT_MD_CACHE["data"] and (now - _VARIANT_MD_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_MD_CACHE["data"]
    bq = _client()
    gold_rates = todays_gold_rates()
    case_sql, params = _selling_price_sql(gold_rates)
    metal_list_sql = ", ".join(f"'{g}'" for g in METAL_GROUPS)
    sql = f"""
        SELECT item_code,
          SUM(IF(item_group_name IN ({metal_list_sql}), IFNULL(ROUND({case_sql}, 2), 0), 0)) AS metal_amount,
          SUM(IF(item_group_name = 'Diamond', IFNULL(ROUND({case_sql}, 2), 0), 0)) AS diamond_amount,
          {_stone_extras_sql(case_sql)}
        FROM `{TABLE}`
        GROUP BY item_code
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    result = {}
    for row in job.result(page_size=5000):
        result[row["item_code"]] = {
            "metal_amount": round(float(row["metal_amount"]), 2) if row["metal_amount"] is not None else 0.0,
            "diamond_amount": round(float(row["diamond_amount"]), 2) if row["diamond_amount"] is not None else 0.0,
            **_stone_extras(row),
        }
    _VARIANT_MD_CACHE["data"] = result
    _VARIANT_MD_CACHE["ts"] = now
    return result


# Total Diamond CP -- SUM of Product Price's component-level Diamond CP
# (= Carat Weight * Purchase Rate * Pieces, via the stone_rates match) per
# item_code. Reuses the EXACT same stone_rate_rows join/narrowest-slab-wins
# logic as _g2d_ranked_cte's carat_weight/purchase_rate/diamond_cp columns --
# not recreated from any other field. A component with no computable
# Diamond CP (non-Diamond row, or no matching stone rate) contributes 0.
_VARIANT_DIAMOND_CP_CACHE = {"ts": 0.0, "data": {}}


# Main Shape per Variant -- for the Margin tab's "Shape" breakdown. The
# centre stone's shape (Product_price.center_stone = 1) when the variant has
# one, else the shape of its single largest diamond (carat weight = net
# weight / pieces). Variants with no diamond line have no shape (blank).
_VARIANT_SHAPE_CACHE = {"ts": 0.0, "data": {}}


def build_variant_shape_map():
    now = time.time()
    if _VARIANT_SHAPE_CACHE["data"] and (now - _VARIANT_SHAPE_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_SHAPE_CACHE["data"]
    bq = _client()
    sql = f"""
        SELECT item_code, shape_name
        FROM `{TABLE}`
        WHERE item_group_name = 'Diamond' AND shape_name IS NOT NULL AND TRIM(shape_name) NOT IN ('', 'NA')
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY item_code
          ORDER BY IFNULL(center_stone, 0) DESC, SAFE_DIVIDE(net_weight, pieces) DESC, shape_name
        ) = 1
    """
    result = {}
    try:
        for row in bq.query(sql).result(page_size=10000):
            result[row["item_code"]] = row["shape_name"]
    except Exception as e:
        print(f"[variant-shape] query failed: {e}")
    if result:
        _VARIANT_SHAPE_CACHE["data"] = result
        _VARIANT_SHAPE_CACHE["ts"] = now
    return result or _VARIANT_SHAPE_CACHE["data"]


def build_variant_diamond_cp_map():
    now = time.time()
    if _VARIANT_DIAMOND_CP_CACHE["data"] and (now - _VARIANT_DIAMOND_CP_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_DIAMOND_CP_CACHE["data"]
    bq = _client()
    sql = f"""
        WITH {_stone_rate_rows_cte()},
        joined AS (
          SELECT item_code, item_group_name, shape_name, quality_name, stone_color_name,
                 pieces, net_weight,
                 ROW_NUMBER() OVER () AS _prowid,
                 CASE WHEN item_group_name IN ('Diamond', 'Color Stone', 'Cubic Zirconia') AND pieces IS NOT NULL AND pieces > 0
                      THEN net_weight / pieces END AS carat_weight
          FROM `{TABLE}`
        ),
        priced AS (
          SELECT j.*, sr.purchase_rate,
            ROW_NUMBER() OVER (
              PARTITION BY j._prowid
              ORDER BY (sr.to_weight - sr.from_weight) ASC
            ) AS _rate_rn
          FROM joined j
          LEFT JOIN stone_rate_rows sr
            ON sr.ig = LOWER(TRIM(j.item_group_name)) AND sr.sh = LOWER(TRIM(j.shape_name))
           AND sr.ql = LOWER(TRIM(j.quality_name)) AND sr.sc = LOWER(TRIM(j.stone_color_name))
           AND j.carat_weight IS NOT NULL
           AND j.carat_weight >= sr.from_weight AND j.carat_weight <= sr.to_weight
        ),
        priced_final AS (
          SELECT * EXCEPT(_rate_rn) FROM priced WHERE _rate_rn = 1
        )
        SELECT item_code,
          SUM(IF(item_group_name = 'Diamond', IFNULL(carat_weight * purchase_rate * pieces, 0), 0)) AS total_diamond_cp,
          SUM(IF(item_group_name IN ({_GEM_IN_SQL}), IFNULL(carat_weight * purchase_rate * pieces, 0), 0)) AS gemstone_cp
        FROM priced_final
        GROUP BY item_code
    """
    job = bq.query(sql)
    result, gem = {}, {}
    for row in job.result(page_size=5000):
        result[row["item_code"]] = round(float(row["total_diamond_cp"]), 2) if row["total_diamond_cp"] is not None else 0.0
        if row["gemstone_cp"]:
            gem[row["item_code"]] = round(float(row["gemstone_cp"]), 2)
    _VARIANT_DIAMOND_CP_CACHE["data"] = result
    _VARIANT_DIAMOND_CP_CACHE["gem"] = gem
    _VARIANT_DIAMOND_CP_CACHE["ts"] = now
    return result


def _with_gemstone_cp(md_map):
    """md_map + each variant's Gemstone CP (split out of the stone-rate CP by
    build_variant_diamond_cp_map, which must have run first) + its accessories
    (_with_accessories). New dicts, so the cached maps are never mutated."""
    gem = _VARIANT_DIAMOND_CP_CACHE.get("gem") or {}
    return _with_accessories({c: ({**v, "gemstone_cp": gem[c]} if c in gem else v) for c, v in md_map.items()})


# Accessories (Ceramic, Silicon band, Stretchable Belt, cord thread, Memory Wire,
# Alloy ...) -- BOM lines that are neither metal, diamond nor stone (user,
# 2026-10-30: "band mai rubber band ..."). Product_price has no name or rate for
# them, so they come from the ERP BOM (Pos.items_bom, rm_id -> the accessory
# item), costed at that accessory's LATEST purchase rate (consignment-in BOM,
# newest line with a rate): per piece when its unit (items.uoc_id) is 3, per
# gram otherwise -- the unit those purchase amounts were billed in. No selling
# rate exists for them anywhere in the ERP, so they add to CP, not to price.
ACCESSORY_GROUPS = ("Accessories", "Alloy")
ITEMS_BOM_TABLE = os.environ.get("ITEMS_BOM_TABLE", "lucirajewelry-prod.Pos.items_bom")
ERP_ITEMS_TABLE = os.environ.get("ERP_ITEMS_TABLE", "lucirajewelry-prod.ornaverse_erp_master.items")
PURCHASE_BOM_TABLE = os.environ.get("PURCHASE_BOM_TABLE", "lucirajewelry-prod.Lucira_Prod.consignment_in_items_bom")
UOC_PER_PIECE = 3
_VARIANT_ACCESSORY_CACHE = {"ts": 0.0, "data": {}}


def build_variant_accessory_map():
    """{item_code: {"names", "pieces", "cp"}} for every variant with an accessory line."""
    now = time.time()
    if _VARIANT_ACCESSORY_CACHE["data"] and (now - _VARIANT_ACCESSORY_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_ACCESSORY_CACHE["data"]
    acc_in_sql = ", ".join(f"'{g}'" for g in ACCESSORY_GROUPS)
    sql = f"""
        WITH rate AS (
          SELECT rm_id, rate FROM `{PURCHASE_BOM_TABLE}` WHERE rate > 0
          QUALIFY ROW_NUMBER() OVER (PARTITION BY rm_id ORDER BY transaction_bom_id DESC) = 1
        )
        SELECT fi.item_code,
          STRING_AGG(DISTINCT rm.item_name, ', ') AS names,
          SUM(IFNULL(b.pieces, 0)) AS pieces,
          SUM(IFNULL(r.rate, 0) * IF(rm.uoc_id = {UOC_PER_PIECE}, IFNULL(b.pieces, 0), IFNULL(b.weight, 0))) AS cp
        FROM `{ITEMS_BOM_TABLE}` b
        JOIN `{ERP_ITEMS_TABLE}` rm ON rm.item_id = b.rm_id
        JOIN `{ITEM_GROUPS_TABLE}` g ON g.item_group_id = rm.item_group_id
        JOIN `{ERP_ITEMS_TABLE}` fi ON fi.item_id = b.item_id
        LEFT JOIN rate r ON r.rm_id = b.rm_id
        WHERE g.item_group_name IN ({acc_in_sql}) AND fi.item_code IS NOT NULL
        GROUP BY fi.item_code
    """
    result = {}
    try:
        for r in _client().query(sql).result(page_size=5000):
            result[r["item_code"]] = {"names": r["names"], "pieces": float(r["pieces"] or 0),
                                      "cp": round(float(r["cp"] or 0), 2)}
    except Exception as e:
        print(f"[variant-accessories] query failed: {e}")
    if result:
        _VARIANT_ACCESSORY_CACHE["data"] = result
        _VARIANT_ACCESSORY_CACHE["ts"] = now
    return result or _VARIANT_ACCESSORY_CACHE["data"]


def _with_accessories(md_map):
    """Folds each variant's accessories into its Other BOM columns: names onto
    the Type, pieces onto Pcs, purchase cost onto CP (-> Total CP Cost)."""
    acc = build_variant_accessory_map()
    out = {}
    for c, v in md_map.items():
        a = acc.get(c)
        if a:
            v = {**v,
                 "gemstone_type": ", ".join(t for t in (v.get("gemstone_type"), a["names"]) if t),
                 "gemstone_pieces": round((v.get("gemstone_pieces") or 0.0) + a["pieces"], 3),
                 "gemstone_cp": round((v.get("gemstone_cp") or 0.0) + a["cp"], 2)}
        out[c] = v
    return out


# Status / Image -- two Shopify-sourced, display-only Variant Level columns
# (added on top of the existing pricing waterfall, which they never touch).
# Source: Lucira_Shopify_products, UNNEST(variants) AS v matched on v.sku
# against Variant Level's item_code (TRIM+LOWER on BOTH sides for matching
# only -- the displayed item_code/SKU value is never altered). `status` is
# the real Shopify product status field, taken as-is (never invented). A
# product can have several images; a variant's OWN image (variants.image_id
# == images.id) wins if present, else the lowest-`position` product image --
# QUALIFY/ROW_NUMBER guarantees exactly ONE row per normalized SKU either
# way, so this can NEVER duplicate a Variant Level row. A SKU with no
# Shopify match simply has no key in this map -- callers treat that as
# blank/null, never as a reason to drop the Variant (which comes from
# Product_price, not from Shopify).
_VARIANT_SHOPIFY_CACHE = {"ts": 0.0, "data": {}}


def build_variant_shopify_map():
    now = time.time()
    if _VARIANT_SHOPIFY_CACHE["data"] and (now - _VARIANT_SHOPIFY_CACHE["ts"]) < VARIANT_AGG_TTL_SEC:
        return _VARIANT_SHOPIFY_CACHE["data"]
    bq = _client()
    sql = f"""
        SELECT
          TRIM(LOWER(v.sku)) AS sku_key,
          p.status AS status,
          i.src AS image_url
        FROM `{SHOPIFY_PRODUCTS_TABLE}` p
        LEFT JOIN UNNEST(p.variants) AS v
        LEFT JOIN UNNEST(p.images) AS i
        WHERE v.sku IS NOT NULL AND TRIM(v.sku) != ''
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY TRIM(LOWER(v.sku))
          ORDER BY IF(i.id = v.image_id, 0, 1) ASC, i.position ASC, i.id ASC, p.id ASC
        ) = 1
    """
    result = {}
    try:
        job = bq.query(sql)
        for row in job.result(page_size=5000):
            result[row["sku_key"]] = {"status": row["status"], "image_url": row["image_url"]}
    except Exception as e:
        print(f"[variant-shopify] query failed, falling back to blank status/image: {e}")
    _VARIANT_SHOPIFY_CACHE["data"] = result
    _VARIANT_SHOPIFY_CACHE["ts"] = now
    return result


# Variant Level's base list is Product_price's DISTINCT item_code -- NOT every
# item_code in `items`. items is only used to fill in variant details (never
# to decide which variants appear). Item Group here is a PER-VARIANT
# classification (a variant usually has both a Gold/metal row and Diamond/
# stone rows in Product_price): Diamond if it has ANY Diamond component,
# else Gold if it has a Gold component, else Other. "Consignment" is any
# variant whose Item Name starts with "Consignment" (a mixed-material
# customer-consignment batch, not a real product family) -- these always
# sort last, regardless of their Item Group.
# The pricing waterfall (Metal/Diamond Amount through Final After GST
# Overall) is entirely per-Variant arithmetic -- no extra BigQuery calls
# beyond the two already-cheap cached maps (Overall Selling Price's price
# map is NOT used here; Metal/Diamond Amount come from
# build_variant_metal_diamond_map, Making Amount from the variant's own
# Net Weight x Making Charge /g). See _build_variant_row. GST is a flat 3%,
# per the spec. Column order matches the user-supplied reference table
# exactly (screenshot, 2026-09-07) -- "Overall" (Metal+Diamond+Making, same
# value as Before GST Overall) and a few detail fields (Consignment, SKU,
# Price, Compare Price, G2D Dis%) are dropped from display per that table;
# sorting (Gold -> Diamond -> Other, Consignment last) is unaffected since
# it never depended on which columns are shown.
# Column order + names = the user's sheet (2026-10-08), used by EVERY tab that
# shows these columns (Ornaverse Variant / Product Default / Shopify / Inventory).
VARIANT_COLUMNS = [
    "item_code", "product_composition", "item_name", "image_url", "status", "item_group",
    "category", "main_shape", "purity", "g2d", "g2d_band",
    "total_diamond_cp", "labour_charge", "cp_pr_gm_making", "total_cp_cost",
    "net_weight", "weight", "metal_amount", "diamond_weight", "diamond_pieces", "diamond_amount",
    "gemstone_type", "gemstone_pieces", "gemstone_weight", "gemstone_amount", "gemstone_cp",
    "making_charge_per_g", "making_amount",
    "before_gst_overall", "before_gst_value", "original_after_gst_overall", "margin1_pct",
    "making_discount_pct", "making_discount_amount", "net_making_amount",
    "diamond_disc_pct", "diamond_discount_amount", "net_diamond_amount", "total_discount",
    "final_after_gst_overall", "margin_pct", "final_amount_post_discount",
    # slab-based pricing (2026-10-08): the two requested columns + how they were reached
    "amount_ex_gst", "free_gold_coin", "free_coin_qty", "free_coin_cp", "actual_sp", "net_margin", "net_margin_pct",
    "material_type", "slab_status",
]
# Still calculated and stored (Margin / Inventory tabs use them), not in the sheet's list.
VARIANT_EXTRA_COLUMNS = ["overall_selling_price", "after_discount", "gst", "cash_back_pct", "margin2_pct"]
VARIANT_LABELS = {
    "item_code": "Item Code", "product_composition": "Product Composition",
    "item_name": "Item Name", "status": "Status", "item_group": "Item Group",
    "category": "Category", "main_shape": "Main Shape",
    "net_weight": "Net Weight", "weight": "Weight", "diamond_weight": "Diamond Weight",
    "diamond_pieces": "Diamond Pieces", "gemstone_type": "Other BOM Items", "gemstone_pieces": "Other BOM Pcs",
    "gemstone_weight": "Other BOM Stone Wt (ct)", "gemstone_amount": "Other BOM Amount", "gemstone_cp": "Other BOM CP",
    "purity": "Purity", "g2d": "G2D Ratio", "g2d_band": "G2D Band",
    "metal_amount": "Metal Amount", "diamond_amount": "Diamond Amount",
    "overall_selling_price": "Overall Selling Price",
    "making_charge_per_g": "Making Charge /g", "making_amount": "Making Amount",
    "before_gst_overall": "Before GST Overall",
    "before_gst_value": "GST Value", "original_after_gst_overall": "With GST SP",
    "margin1_pct": "Margin 1% (without discount)", "total_discount": "Total Discount",
    "amount_ex_gst": "Amount ex GST", "free_gold_coin": "Free Gold Coin", "free_coin_qty": "Free Coin Qty",
    "free_coin_cp": "Free Coin Value", "actual_sp": "Actual SP", "net_margin": "Final Margin (SP - CP)",
    "net_margin_pct": "Final Margin %", "material_type": "Material Type", "slab_status": "Slab Status",
    "making_discount_pct": "Making Discount %", "making_discount_amount": "Making Discount Amount",
    "net_making_amount": "Net Making Amount",
    "diamond_disc_pct": "Diamond Disc%", "diamond_discount_amount": "Diamond Discount Amount",
    "net_diamond_amount": "Net Diamond Amount",
    "after_discount": "After Discount", "gst": "GST", "final_after_gst_overall": "Final After GST Overall",
    "total_diamond_cp": "Total Diamond CP", "labour_charge": "Labour Charge", "cp_pr_gm_making": "CP. pr gm making",
    "total_cp_cost": "Total CP Cost", "margin_pct": "Margin 2% with discount",
    "cash_back_pct": "Cash Back", "final_amount_post_discount": "Final Amount Post Discount",
    "additional_disc": "Addition discount", "margin2_pct": "Margin2",
    "image_url": "Image",
}
GROUP_PRIORITY = {"Gold": 1, "Diamond": 2}  # else 3 ("Other")

# Product Composition -- which of the 3 fixed categories (Diamond / Gold /
# Gems Stone) are present among a Variant's Product_price component rows'
# item_group_name, rolled up to ONE distinct-category string per Variant.
# Matched case-insensitively/trimmed against Product_price's own
# item_group_name -- nothing invented, no new Item Group field. Everything
# NOT in one of these 3 lists (Silver, Platinum, Cubic Zirconia,
# Accessories, Finding, Consumables, Sample line, Services, ...) contributes
# to none of the 3 categories and is simply left out of the composition.
PRODUCT_COMPOSITION_DIAMOND_GROUPS = ("diamond", "diamond jewellery", "natural diamond jewellery")
PRODUCT_COMPOSITION_GOLD_GROUPS = ("gold", "gold jewellery", "plain gold jewellery")
PRODUCT_COMPOSITION_GEMS_GROUPS = ("color stone",)


def _sql_in_list(values):
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


def _product_composition(has_diamond, has_gold, has_gems):
    """{Diamond, Gold, Gems Stone} presence flags -> the fixed-order
    "Diamond/Gold/Gems Stone" string (never alphabetized, never
    deduplicated-with-repeats since each flag is boolean already). The one
    special case: Gold with neither Diamond nor Gems Stone displays as
    "Plain Gold", not "Gold". None present -> None (blank cell)."""
    if has_gold and not has_diamond and not has_gems:
        return "Plain Gold"
    parts = []
    if has_diamond:
        parts.append("Diamond")
    if has_gold:
        parts.append("Gold")
    if has_gems:
        parts.append("Gems Stone")
    return "/".join(parts) if parts else None


def _variant_matched_sorted_codes(q):
    """Every matching item_code, in final display order -- computed ENTIRELY
    from the cached classification map (in-memory, no BigQuery call). This is
    what makes search/sort/pagination fast: the only per-request BigQuery
    query left is a tiny one for the current page's item details."""
    cls_map = build_variant_classification_map()
    ql = (q or "").strip().lower()
    codes = []
    for code, cls in cls_map.items():
        if ql:
            hay = f"{code} {cls.get('item_name_pp') or ''} {cls.get('item_group') or ''}".lower()
            if ql not in hay:
                continue
        codes.append(code)
    codes.sort(key=lambda c: (
        1 if cls_map[c]["is_consignment"] else 0,
        GROUP_PRIORITY.get(cls_map[c]["item_group"], 3),
        c,
    ))
    return codes, cls_map


def _variant_items_detail(codes, mc_case_sql, dp_case_sql, g2d_params):
    """Small query against ds_imputed_reporting.items ONLY (no Product_price
    touched here) -- optionally filtered to `codes` (a page's worth) via
    IN UNNEST, or unfiltered (None) for a full export. Returns {item_code: row}."""
    bq = _client()
    where_clause = "WHERE item_code IN UNNEST(@codes)" if codes is not None else ""
    params = list(g2d_params)
    if codes is not None:
        params.append(bigquery.ArrayQueryParameter("codes", "STRING", codes))
    sql = f"""
        WITH items_dedup AS (
          SELECT item_code, item_name, sku, weight, net_weight, diamond_weight, purity,
                 price, compare_price, is_publish, creation_date, item_attribute_id,
                 {_VARIANT_G2D_EXPR} AS g2d,
                 {mc_case_sql},
                 {dp_case_sql},
                 ROW_NUMBER() OVER (
                   PARTITION BY item_code ORDER BY COALESCE(modified_date, creation_date) DESC
                 ) AS rn
          FROM `{G2D_TABLE}`
          {where_clause}
        )
        SELECT d.*, ca.item_group_name AS labour_group, ca.type_name AS labour_type
        FROM items_dedup d
        LEFT JOIN `{ITEM_ATTRIBUTES_TABLE}` ca ON ca.item_attribute_id = d.item_attribute_id
        WHERE d.rn = 1
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    out = {}
    for row in job.result(page_size=5000):
        d = dict(row)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
            elif hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                d[k] = float(v)
        out[d["item_code"]] = d
    return out



# ══════════════════════════════════════════════════════════════════════
#  Slab-based pricing (2026-10-08) -- the Slab tab's Excel table
#  (gold_rates.slab_excel) applied inside _build_variant_row, so every tab
#  built on it (Ornaverse Variant / Product Default / Shopify / Inventory /
#  Margin) uses it.
#   Match: Category (= ERP item type, e.g. Rings) AND Material Type (= ERP
#   item group, e.g. Diamond Jewellery) -- case/space-insensitive exact --
#   AND the product's G2D inside the row's G2D range (both ends inclusive).
#   Making Discount / Diamond Discount / Making Charges: the slab value when
#   present, else the product keeps its existing value. Blank, "" and "—"
#   mean "no value", never 0. Discounts written as fractions (0.4) are read
#   as 40%; values above 1 are taken as already-percent.
#   Several rows may share Category+Material+G2D (one per Price Range / coin
#   tier) -- their discount/making values must agree, else "Error".
#   Free Gold Coin: among those rows, the one whose Price Range contains the
#   NEW Final After GST; its Free value is the coin SKU, optionally with a
#   quantity ("2 x LJ-GC0002-916YGPG", "LJ-GC0002-916YGPG x2"; plain = 1).
#   Two Price Ranges containing the price -> "Error", coin left blank.
#   Net Margin = Final After GST - Total CP Cost - coin CP x qty, where the
#   coin's CP is its own Total CP Cost from the published Variant snapshot.
# ══════════════════════════════════════════════════════════════════════
import re as _re

_SLAB_BLANKS = {"", "-", "—", "–", "na", "n/a", "none", "null", "nil"}


def _slab_num(v):
    if v is None:
        return None
    t = str(v).strip().replace(",", "").replace("₹", "").replace("%", "")
    if t.lower() in _SLAB_BLANKS:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _slab_pct(v):
    x = _slab_num(v)
    if x is None:
        return None
    return x * 100.0 if abs(x) <= 1 else x


def _slab_range(v):
    """'0.05 to 0.099' / '0.05-0.099' / '1 and above' / 'above 300000' / '>= 2' / '0.07' -> (lo, hi)."""
    if v is None:
        return None
    t = str(v).strip().lower().replace(",", "").replace("₹", "")
    if t in _SLAB_BLANKS:
        return None
    nums = [float(x) for x in _re.findall(r"-?\d+(?:\.\d+)?", t.replace(" - ", " to "))]
    if not nums:
        return None
    if _re.search(r"above|\+|>|more|plus|onwards", t) and len(nums) == 1:
        return (nums[0], float("inf"))
    if _re.search(r"below|under|<|upto|up to", t) and len(nums) == 1:
        return (float("-inf"), nums[0])
    if len(nums) >= 2:
        lo, hi = nums[0], nums[1]
        return (min(lo, hi), max(lo, hi))
    return (nums[0], nums[0])


def _slab_free(v):
    """'LJ-GC0002-916YGPG' -> (sku, 1); '2 x SKU' / 'SKU x 2' / 'SKU * 2' -> (sku, 2)."""
    if v is None:
        return None, 0
    t = str(v).strip()
    if t.lower() in _SLAB_BLANKS:
        return None, 0
    m = _re.match(r"^(\d+)\s*[x×*]\s*(\S+)$", t, _re.I) or None
    if m:
        return m.group(2), int(m.group(1))
    m = _re.match(r"^(\S+)\s*[x×*]\s*(\d+)$", t, _re.I)
    if m:
        return m.group(1), int(m.group(2))
    return t, 1


_SLAB_CACHE = {"ts": 0.0, "data": None}


def fetch_slab_rules():
    """Parsed slab rows, cached like the other small configs."""
    now = time.time()
    if _SLAB_CACHE["data"] is not None and (now - _SLAB_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _SLAB_CACHE["data"]
    rules = []
    try:
        for r in slab_excel_list()["rows"]:
            # Blank Category / Material Type / G2D = no restriction on that field
            # (the row applies to every value of it); see slab_match.
            cat = None if str(r.get("category") or "").strip().lower() in _SLAB_BLANKS else str(r.get("category")).strip().lower()
            mat = None if str(r.get("material_type") or "").strip().lower() in _SLAB_BLANKS else str(r.get("material_type")).strip().lower()
            g = _slab_range(r.get("g2d"))
            sku, qty = _slab_free(r.get("free"))
            rules.append({
                "cat": cat, "mat": mat, "g2d": g,
                "score": (cat is not None) + (mat is not None) + (g is not None),
                "making_disc": _slab_pct(r.get("making_discount")),
                "diamond_disc": _slab_pct(r.get("diamond_discount")),
                "making_charge": _slab_num(r.get("making_charges")),
                "price": _slab_range(r.get("price_range")), "coin": sku, "coin_qty": qty,
            })
    except Exception as e:
        print(f"[slab] couldn't read slab table: {e}")
        rules = _SLAB_CACHE["data"] or []
    _SLAB_CACHE["data"] = rules
    _SLAB_CACHE["ts"] = now
    return rules


_COIN_CP_CACHE = {"ts": 0.0, "data": {}}


# Free gold coin benefit = a FIXED amount per coin (user, 2026-10-10), not the
# coin's gold value: 1 coin = Rs 1,600, 2 = 3,200, 3 = 4,800 ...
FREE_COIN_FIXED_VALUE = float(os.environ.get("FREE_COIN_FIXED_VALUE", "1600"))


def fetch_coin_value(sku):
    """Value of ONE free coin -- the fixed FREE_COIN_FIXED_VALUE for every coin SKU."""
    return FREE_COIN_FIXED_VALUE if sku else None


def slab_match(category, material, g2d):
    """Resolve the slab for one product.
    A row matches when every FILLED key matches: Category (exact, case/space-
    insensitive), Material Type (same), G2D inside its range (inclusive); a blank
    key matches anything. Each value (Making Disc / Diamond Disc / Making Charges)
    comes from the MOST SPECIFIC matching row that has it filled (most filled
    keys, then narrowest G2D range); blank everywhere -> keep the existing value.
    Two equally specific rows giving different values -> error, never a silent
    pick. Returns (resolved, coin_rows, matched, error)."""
    c = str(category or "").strip().lower()
    m = str(material or "").strip().lower()
    def ok(r):
        if r["cat"] is not None and r["cat"] != c: return False
        if r["mat"] is not None and r["mat"] != m: return False
        if r["g2d"] is not None and (g2d is None or not (r["g2d"][0] <= g2d <= r["g2d"][1])): return False
        return True
    hits = [r for r in fetch_slab_rules() if ok(r)]
    if not hits:
        return {}, [], False, None
    def rank(r):  # more filled keys first, then the narrower G2D range
        width = (r["g2d"][1] - r["g2d"][0]) if r["g2d"] is not None else float("inf")
        return (-r["score"], width)
    resolved, errors = {}, []
    for f in ("making_disc", "diamond_disc", "making_charge"):
        cands = sorted([h for h in hits if h[f] is not None], key=rank)
        if not cands:
            continue
        top = [h for h in cands if rank(h) == rank(cands[0])]
        vals = {h[f] for h in top}
        if len(vals) > 1:
            errors.append(f)
        else:
            resolved[f] = cands[0][f]
    coin_rows = [h for h in hits if h["price"] and h["coin"]]
    if coin_rows:
        best = min(rank(h) for h in coin_rows)
        coin_rows = [h for h in coin_rows if rank(h) == best]
    err = (f"Error: equally specific slab rows disagree on {', '.join(errors)}") if errors else None
    return resolved, coin_rows, True, err


def _free_coin_for(slab_coin_rows, amount_ex_gst):
    """Free gold coin an ex-GST amount earns under the slab's coin rows (steps 2-3
    of the Free Gold Coin spec in _build_variant_row) -> (coin, qty, value, error)."""
    free_coin, free_coin_qty, free_coin_value, coin_err = None, 0, None, None
    if slab_coin_rows:
        tiers = [h for h in slab_coin_rows
                 if amount_ex_gst >= h["price"][0] and (h["price"][1] == float("inf") or amount_ex_gst <= h["price"][1])]
        if tiers:
            top = max(h["price"][0] for h in tiers)
            best = [h for h in tiers if h["price"][0] == top]
            if len({(h["coin"], h["coin_qty"]) for h in best}) > 1:
                coin_err = "Error: different free coins for the same Price Range"
            else:
                h = best[0]
                steps = int(amount_ex_gst // h["price"][0]) if (h["price"][1] == float("inf") and h["price"][0] > 0) else 1
                free_coin, free_coin_qty = h["coin"], max(1, steps) * (h["coin_qty"] or 1)
                unit = fetch_coin_value(free_coin)
                if unit is None:
                    coin_err = f"Error: no gold value for {free_coin}"
                else:
                    free_coin_value = round(unit * free_coin_qty, 2)
    return free_coin, free_coin_qty, free_coin_value, coin_err


GST_RATE = 0.03  # flat 3%, per spec
# Finished item's own attribute (item group "Diamond Jewellery" + type "Rings"
# ...) -- the Labour Rate Slab's key.
ITEM_ATTRIBUTES_TABLE = os.environ.get("ITEM_ATTRIBUTES_TABLE", "lucirajewelry-prod.ornaverse_erp_master.common_attributes")


def _build_variant_row(code, cls_map, item_by_code, price_map, md_map, diamond_discounts,
                        diamond_cp_map=None, labour_rates=None, shopify_map=None, cash_back_rates=None):
    cls = cls_map[code]
    item = item_by_code.get(code, {})
    shop = (shopify_map or {}).get((code or "").strip().lower(), {})
    product_composition = _product_composition(
        cls.get("has_diamond"), cls.get("has_gold"), cls.get("has_gems"))
    # diamond_discounts here is {g2d band_key: diamond_dis_pct} (see
    # fetch_g2d_diamond_discounts) -- applied only to E-F / CD / RB / SC.
    diamond_disc_pct = 0.0
    if cls["item_group"] == "Diamond" and cls.get("any_diamond_type") in G2D_DIAMOND_DISCOUNT_QUALITIES:
        diamond_disc_pct = diamond_discounts.get(g2d_band_key(item.get("g2d")), 0.0)
    # Making Discount % comes from the SAME G2D Making Charges band as Making
    # Charge /g (the item's own discount_pct, i.e. "G2D Dis%") -- not the
    # separate item_group_discounts table, which stays all-zero unless
    # someone edits it and was silently making this column (and therefore
    # Making Discount Amount / Net Making Amount / Final After GST Overall)
    # a permanent no-op.
    making_discount_pct = item.get("discount_pct") or 0.0
    md = md_map.get(code, {})

    # -- Slab override (see slab_match): only filled values replace the existing ones --
    making_charge_per_g = item.get("making_charge_per_g") or 0.0
    slab_vals, slab_coin_rows, slab_matched, slab_err = slab_match(
        item.get("labour_type"), item.get("labour_group"), item.get("g2d"))
    kept = []
    if not slab_matched:
        slab_status = "No slab match"
    else:
        # values the slab can't settle (error) also keep the existing value
        if "making_disc" in slab_vals: making_discount_pct = slab_vals["making_disc"]
        else: kept.append("making disc")
        if "diamond_disc" in slab_vals: diamond_disc_pct = slab_vals["diamond_disc"]
        else: kept.append("diamond disc")
        if "making_charge" in slab_vals: making_charge_per_g = slab_vals["making_charge"]
        else: kept.append("making charges")
        slab_status = "Slab applied" + (f" (kept existing: {', '.join(kept)})" if kept else "")
        if slab_err:
            slab_status = f"{slab_status}; {slab_err}"

    # Gold coins (LJ-GC...): no making / diamond discount, fixed Making Charge /g
    # (user, 2026-10-23) -- overrides both the G2D band and the slab.
    if _is_gold_coin(code):
        making_discount_pct = 0.0
        diamond_disc_pct = 0.0
        making_charge_per_g = GOLD_COIN_MAKING_CHARGE_PER_G
        slab_status = "Gold coin: no discount, fixed making"

    # -- Pricing waterfall (full precision internally; rounded only when returned) --
    metal_amount = md.get("metal_amount", 0.0) or 0.0
    diamond_amount = md.get("diamond_amount", 0.0) or 0.0
    # Other BOM amount (colour stone / CZ / accessories, user 2026-10-30) is part of
    # the price now; no making or diamond discount applies to it.
    other_amount = md.get("gemstone_amount", 0.0) or 0.0
    net_weight = item.get("net_weight") or 0.0
    making_amount = net_weight * making_charge_per_g
    if _is_gold_coin(code) and net_weight > 0:
        # Gold coin (user, 2026-10-23): 1 g and below -> fixed Rs 500; above 1 g ->
        # exact weight x Rs 500 (1.2 g -> 600, 1.3 g -> 650, 2.3 g -> 1150).
        making_amount = max(1.0, net_weight) * making_charge_per_g

    overall = metal_amount + diamond_amount + making_amount + other_amount
    before_gst_overall = overall
    # Gold coin making is NOT taxed (user, 2026-10-23): GST only on the rest.
    coin_untaxed = making_amount if _is_gold_coin(code) else 0.0
    before_gst_value = (before_gst_overall - coin_untaxed) * GST_RATE
    original_after_gst_overall = before_gst_overall + before_gst_value

    making_discount_amount = making_amount * (making_discount_pct / 100.0)
    net_making_amount = making_amount - making_discount_amount
    diamond_discount_amount = diamond_amount * (diamond_disc_pct / 100.0)
    net_diamond_amount = diamond_amount - diamond_discount_amount

    after_discount = metal_amount + net_making_amount + net_diamond_amount + other_amount
    gst = (after_discount - (net_making_amount if _is_gold_coin(code) else 0.0)) * GST_RATE
    final_after_gst_overall = after_discount + gst
    final_after_gst_overall_rounded = math.ceil(final_after_gst_overall)  # rounded UP to the nearest whole rupee
    # Addition discount / Cash Back REMOVED from pricing (user, 2026-10-10): nothing is
    # taken off Final After GST any more, so Final Amount Post Discount = Final After GST.
    cash_back_pct = 0.0

    # -- CP. pr gm making / Total CP Cost / Margin % --
    # <= 1.5 GM: a fixed CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF.
    # >  1.5 GM: Net Weight * Labour Charge from the ERP Labour Rate Slab
    #            (labour_rates here = fetch_labour_rate_slab(); see LABOUR_*).
    total_diamond_cp = (diamond_cp_map or {}).get(code, 0.0)
    # Other BOM CP (colour stone / CZ at the stone rate + accessories at their
    # purchase rate) -- its own column, added into Total CP Cost here.
    gemstone_cp = md.get("gemstone_cp", 0.0) or 0.0
    labour_charge = labour_charge_for(labour_rates, item.get("labour_group"), item.get("labour_type"),
                                      net_weight, item.get("g2d"))
    if _is_gold_coin(code):
        # Gold coin (user, 2026-10-23): <= 1 g -> Rs 200 fixed; above that, weight
        # rounded UP to the next 0.5 g x Rs 200 (1.3/1.5 -> 300, 2 -> 400, 2.3 -> 500).
        cp_pr_gm_making = max(1.0, math.ceil(net_weight * 2 - 1e-9) / 2.0) * GOLD_COIN_CP_MAKING_PER_G
    elif net_weight <= LABOUR_NET_WEIGHT_CUTOFF:
        cp_pr_gm_making = CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF
    else:
        cp_pr_gm_making = net_weight * (labour_charge or 0.0)
    # CP is GST-inclusive (user, 2026-10-23): the components are ex-GST, so add 3%
    # to compare like-for-like with the GST-inclusive selling price.
    total_cp_cost = (total_diamond_cp + gemstone_cp + cp_pr_gm_making + metal_amount) * (1.0 + GST_RATE)
    margin_pct = (
        (final_after_gst_overall_rounded - total_cp_cost) / final_after_gst_overall_rounded * 100.0
        if final_after_gst_overall_rounded else None
    )

    # -- Additional Disc / Margin2 --
    # Additional Disc = Final After GST Overall * Cash Back% (the extra
    # discount given to the customer on top of everything else already
    # baked into Final After GST Overall). Margin2 = margin AFTER that
    # extra discount is taken off the post-GST selling price, i.e.
    # ((Final After GST Overall - Additional Disc) - Total CP Cost)
    # / (Final After GST Overall - Additional Disc) -- Total CP Cost itself
    # is unchanged, only the effective selling price shrinks.
    additional_disc = 0.0  # Addition discount removed (see cash_back_pct above)
    net_after_additional_disc = final_after_gst_overall_rounded - additional_disc

    # -- Free Gold Coin / Actual SP / Final Margin (user's spec, 2026-10-09) --
    # 1. Amount ex GST = Final Amount Post Discount / 1.03 (slab discounts and
    #    making are already in it -- applied above).
    # 2. Free coin: the slab Price Range the ex-GST amount meets or exceeds.
    #    "Above X" ranges step up: >= X -> 1 coin, >= 2X -> 2, >= 3X -> 3 ...
    #    (x any quantity written in Free, e.g. "2 x SKU"); a closed range
    #    ("0 to 100000") gives the Free quantity once. Highest qualifying
    #    tier wins; two different coins at the same tier -> error.
    # 3. Coin value = coins x the fixed Rs 1,600 per coin (FREE_COIN_FIXED_VALUE).
    # 4. Actual SP = amount ex GST - coin value;  Final Margin % = (SP - CP) / SP.
    amount_ex_gst = net_after_additional_disc / (1.0 + GST_RATE)
    free_coin, free_coin_qty, free_coin_value, coin_err = _free_coin_for(slab_coin_rows, amount_ex_gst)
    if coin_err:
        slab_status = f"{slab_status}; {coin_err}"
    # Actual SP = Final After GST Overall - Free Coin Value (user, 2026-10-23); the
    # ex-GST amount above is still what picks the free-coin tier.
    actual_sp = net_after_additional_disc - (free_coin_value or 0.0)
    net_margin = actual_sp - total_cp_cost
    net_margin_pct = (net_margin / actual_sp * 100.0) if actual_sp else None
    margin2_pct = (
        (net_after_additional_disc - total_cp_cost) / net_after_additional_disc * 100.0
        if net_after_additional_disc else None
    )

    return {
        "item_code": code,
        "product_composition": product_composition,
        "item_name": item.get("item_name") or cls.get("item_name_pp"),
        "item_group": cls["item_group"],
        # Category = the finished item's ERP type (Rings, Pendants, ...).
        "category": item.get("labour_type"),
        "main_shape": build_variant_shape_map().get(code),
        "metal_amount": round(metal_amount, 2), "diamond_amount": round(diamond_amount, 2),
        "net_weight": net_weight, "making_charge_per_g": making_charge_per_g,
        "making_amount": round(making_amount, 2),
        "overall": round(overall, 2), "before_gst_overall": round(before_gst_overall, 2),
        "before_gst_value": round(before_gst_value, 2),
        "original_after_gst_overall": round(original_after_gst_overall, 2),
        "making_discount_pct": making_discount_pct,
        "making_discount_amount": round(making_discount_amount, 2),
        "net_making_amount": round(net_making_amount, 2),
        "diamond_disc_pct": diamond_disc_pct,
        "diamond_discount_amount": round(diamond_discount_amount, 2),
        "net_diamond_amount": round(net_diamond_amount, 2),
        "after_discount": round(after_discount, 2), "gst": round(gst, 2),
        "final_after_gst_overall": final_after_gst_overall_rounded,
        "is_consignment": cls["is_consignment"],
        "sku": item.get("sku"), "weight": item.get("weight"),
        "diamond_weight": item.get("diamond_weight"), "purity": item.get("purity"),
        "price": item.get("price"), "compare_price": item.get("compare_price"),
        "g2d": item.get("g2d"), "g2d_band": g2d_band_label(item.get("g2d")),
        "discount_pct": item.get("discount_pct"),
        "is_publish": item.get("is_publish"), "creation_date": item.get("creation_date"),
        "overall_selling_price": price_map.get(code),
        "total_diamond_cp": total_diamond_cp,
        "diamond_pieces": md.get("diamond_pieces"),
        "gemstone_type": md.get("gemstone_type"), "gemstone_pieces": md.get("gemstone_pieces"),
        "gemstone_weight": md.get("gemstone_weight"), "gemstone_amount": md.get("gemstone_amount"),
        "gemstone_cp": round(gemstone_cp, 2),
        "labour_charge": labour_charge,
        "cp_pr_gm_making": round(cp_pr_gm_making, 2),
        "total_cp_cost": round(total_cp_cost, 2),
        "margin_pct": round(margin_pct, 2) if margin_pct is not None else None,
        "cash_back_pct": cash_back_pct,
        # Final Amount Post Discount = Final After GST Overall - Cash Back
        # Amount (Final After GST Overall * Cash Back%) -- same value as
        # net_after_additional_disc above, just exposed under its own name
        # since it's now a first-class Variant Level column in its own
        # right (positioned before Margin %), not only an internal step
        # toward Margin2.
        "final_amount_post_discount": round(net_after_additional_disc, 2),
        "additional_disc": round(additional_disc, 2),
        "margin2_pct": round(margin2_pct, 2) if margin2_pct is not None else None,
        # Total Discount = Making Discount Amount + Diamond Discount Amount;
        # Margin 1% = margin on With GST SP (before any discount), same CP.
        "total_discount": round(making_discount_amount + diamond_discount_amount, 2),
        "material_type": item.get("labour_group"),
        "slab_status": slab_status,
        "amount_ex_gst": round(amount_ex_gst, 2),
        "free_gold_coin": free_coin, "free_coin_qty": free_coin_qty or None, "free_coin_cp": free_coin_value,
        "actual_sp": round(actual_sp, 2),
        "net_margin": round(net_margin, 2),
        "net_margin_pct": round(net_margin_pct, 2) if net_margin_pct is not None else None,
        "margin1_pct": (round((original_after_gst_overall - total_cp_cost) / original_after_gst_overall * 100.0, 2)
                        if original_after_gst_overall else None),
        "status": shop.get("status"),
        "image_url": shop.get("image_url"),
    }


# Short-lived cache for a repeated Variant search (re-render, tab switch,
# retyping the same term) -- 5 min, the low end of "short-lived" so a live
# Slab/Labour-tab edit or a new day's gold rate isn't masked for long. A
# cache hit skips BigQuery entirely.
_VARIANT_SEARCH_CACHE = {}
VARIANT_SEARCH_TTL_SEC = 300

# A substring search matching more than this many distinct item_codes is a
# broad "browse" query (e.g. "gold", "ring"), not someone looking for one
# Variant -- for those, the classification-map path's cached full-dataset
# sort/pagination is a better fit than aggregating hundreds of variants'
# component rows on every request.
VARIANT_SEARCH_MAX_CODES = 500


def _variant_search_and_aggregate(q, gold_rates, g2d_bands):
    """ONE combined BigQuery query that both resolves which item_codes
    match `q` (code/name/item_group_name substring, capped at
    VARIANT_SEARCH_MAX_CODES via the `matched_codes` CTE) AND aggregates
    ONLY those codes' component rows -- merging what used to be two
    sequential round-trips (resolve-then-aggregate) into one, since the
    second query's only input was the first's code list. Product_price is
    filtered down to the matched codes FIRST, before any join/aggregation,
    so this never scans/joins the full 368K-row table's worth of stone-rate
    or G2D data. `gold_rates`/`g2d_bands` are passed in (fetched concurrently
    by the caller, see query_variant_targeted) rather than fetched here, so
    those small independent BigQuery calls don't add sequentially to this
    query's own latency. Returns (cls_map, item_by_code, price_map, md_map,
    diamond_cp_map, capped) in the exact shape `_build_variant_row` expects
    -- same function, same arithmetic, only the data-fetching path differs.
    Exact-vs-substring priority (an exact item_code match should return
    ONLY that variant, not other codes that merely contain `q`) is applied
    by the caller in Python after this returns every substring match."""
    bq = _client()
    ql = q.strip().lower()
    pattern = f"%{ql}%"
    selling_case_sql, selling_params = _selling_price_sql(gold_rates)
    mc_case_sql, dp_case_sql, g2d_params = _variant_g2d_case(g2d_bands)
    metal_list_sql = ", ".join(f"'{g}'" for g in METAL_GROUPS)
    sql = f"""
        WITH matched_codes AS (
          SELECT DISTINCT item_code
          FROM `{TABLE}`
          WHERE LOWER(item_code) LIKE @pat
             OR LOWER(item_name) LIKE @pat
             OR LOWER(item_group_name) LIKE @pat
          LIMIT {VARIANT_SEARCH_MAX_CODES + 1}
        ),
        filtered_pp AS (
          SELECT item_code, item_name, item_group_name, net_weight, pieces,
                 shape_name, quality_name, stone_color_name, Saleing_price,
                 karat_code, Diamond_type
          FROM `{TABLE}`
          WHERE item_code IN (SELECT item_code FROM matched_codes)
        ),
        cls AS (
          SELECT item_code,
            ANY_VALUE(item_name) AS item_name_pp,
            CASE
              WHEN LOGICAL_OR(item_group_name = 'Diamond') THEN 'Diamond'
              WHEN LOGICAL_OR(item_group_name = 'Gold') THEN 'Gold'
              ELSE 'Other'
            END AS item_group,
            LOGICAL_OR(LOWER(IFNULL(item_name, '')) LIKE 'consignment%') AS is_consignment,
            MAX(Diamond_type) AS any_diamond_type,
            LOGICAL_OR(LOWER(TRIM(item_group_name)) IN ({_sql_in_list(PRODUCT_COMPOSITION_DIAMOND_GROUPS)})) AS has_diamond,
            LOGICAL_OR(LOWER(TRIM(item_group_name)) IN ({_sql_in_list(PRODUCT_COMPOSITION_GOLD_GROUPS)})) AS has_gold,
            LOGICAL_OR(LOWER(TRIM(item_group_name)) IN ({_sql_in_list(PRODUCT_COMPOSITION_GEMS_GROUPS)})) AS has_gems
          FROM filtered_pp
          GROUP BY item_code
        ),
        {_stone_rate_rows_cte()},
        joined AS (
          SELECT item_code, item_group_name, shape_name, quality_name, stone_color_name,
                 pieces, net_weight,
                 ROW_NUMBER() OVER () AS _prowid,
                 CASE WHEN item_group_name IN ('Diamond', 'Color Stone', 'Cubic Zirconia') AND pieces IS NOT NULL AND pieces > 0
                      THEN net_weight / pieces END AS carat_weight
          FROM filtered_pp
        ),
        priced AS (
          SELECT j.*, sr.purchase_rate,
            ROW_NUMBER() OVER (
              PARTITION BY j._prowid
              ORDER BY (sr.to_weight - sr.from_weight) ASC
            ) AS _rate_rn
          FROM joined j
          LEFT JOIN stone_rate_rows sr
            ON sr.ig = LOWER(TRIM(j.item_group_name)) AND sr.sh = LOWER(TRIM(j.shape_name))
           AND sr.ql = LOWER(TRIM(j.quality_name)) AND sr.sc = LOWER(TRIM(j.stone_color_name))
           AND j.carat_weight IS NOT NULL
           AND j.carat_weight >= sr.from_weight AND j.carat_weight <= sr.to_weight
        ),
        priced_final AS (
          SELECT * EXCEPT(_rate_rn) FROM priced WHERE _rate_rn = 1
        ),
        diamond_cp_agg AS (
          SELECT item_code,
            SUM(IF(item_group_name = 'Diamond', IFNULL(carat_weight * purchase_rate * pieces, 0), 0)) AS total_diamond_cp,
            SUM(IF(item_group_name IN ({_GEM_IN_SQL}), IFNULL(carat_weight * purchase_rate * pieces, 0), 0)) AS gemstone_cp
          FROM priced_final
          GROUP BY item_code
        ),
        selling_agg AS (
          SELECT item_code,
            SUM(IF(item_group_name IN ({metal_list_sql}), IFNULL(ROUND({selling_case_sql}, 2), 0), 0)) AS metal_amount,
            SUM(IF(item_group_name = 'Diamond', IFNULL(ROUND({selling_case_sql}, 2), 0), 0)) AS diamond_amount,
            SUM(ROUND({selling_case_sql}, 2)) AS overall_selling_price,
            {_stone_extras_sql(selling_case_sql)}
          FROM filtered_pp
          GROUP BY item_code
        ),
        items_dedup AS (
          SELECT item_code, item_name, sku, weight, net_weight, diamond_weight, purity,
                 price, compare_price, is_publish, creation_date, item_attribute_id,
                 {_VARIANT_G2D_EXPR} AS g2d,
                 {mc_case_sql},
                 {dp_case_sql},
                 ROW_NUMBER() OVER (
                   PARTITION BY item_code ORDER BY COALESCE(modified_date, creation_date) DESC
                 ) AS rn
          FROM `{G2D_TABLE}`
          WHERE item_code IN (SELECT item_code FROM matched_codes)
        )
        SELECT
          cls.item_code, cls.item_name_pp, cls.item_group, cls.is_consignment, cls.any_diamond_type,
          cls.has_diamond, cls.has_gold, cls.has_gems,
          selling_agg.metal_amount, selling_agg.diamond_amount, selling_agg.overall_selling_price,
          selling_agg.diamond_pieces, selling_agg.gemstone_type, selling_agg.gemstone_pieces,
          selling_agg.gemstone_weight, selling_agg.gemstone_amount,
          diamond_cp_agg.total_diamond_cp, diamond_cp_agg.gemstone_cp,
          id.item_name, id.sku, id.weight, id.net_weight, id.diamond_weight, id.purity,
          id.price, id.compare_price, id.is_publish, id.creation_date,
          id.g2d, id.making_charge_per_g, id.discount_pct,
          ca.item_group_name AS labour_group, ca.type_name AS labour_type
        FROM cls
        LEFT JOIN selling_agg USING(item_code)
        LEFT JOIN diamond_cp_agg USING(item_code)
        LEFT JOIN items_dedup id ON id.item_code = cls.item_code AND id.rn = 1
        LEFT JOIN `{ITEM_ATTRIBUTES_TABLE}` ca ON ca.item_attribute_id = id.item_attribute_id
    """
    params = [bigquery.ScalarQueryParameter("pat", "STRING", pattern)] + selling_params + g2d_params
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))

    def _f(v):
        return float(v) if (v is not None and hasattr(v, "__float__")) else v

    cls_map, item_by_code, price_map, md_map, diamond_cp_map = {}, {}, {}, {}, {}
    for r in job.result():
        item_code = r["item_code"]
        cls_map[item_code] = {
            "item_name_pp": r["item_name_pp"], "item_group": r["item_group"],
            "is_consignment": bool(r["is_consignment"]), "any_diamond_type": r["any_diamond_type"],
            "has_diamond": bool(r["has_diamond"]), "has_gold": bool(r["has_gold"]),
            "has_gems": bool(r["has_gems"]),
        }
        if r["overall_selling_price"] is not None:
            price_map[item_code] = round(_f(r["overall_selling_price"]), 2)
        md_map[item_code] = {
            "metal_amount": round(_f(r["metal_amount"]), 2) if r["metal_amount"] is not None else 0.0,
            "diamond_amount": round(_f(r["diamond_amount"]), 2) if r["diamond_amount"] is not None else 0.0,
            **(_stone_extras(r) if r["diamond_pieces"] is not None else {}),
            "gemstone_cp": round(_f(r["gemstone_cp"]), 2) if r["gemstone_cp"] else 0.0,
        }
        md_map[item_code] = _with_accessories({item_code: md_map[item_code]})[item_code]
        diamond_cp_map[item_code] = (
            round(_f(r["total_diamond_cp"]), 2) if r["total_diamond_cp"] is not None else 0.0
        )
        creation_date = r["creation_date"]
        item_by_code[item_code] = {
            "item_name": r["item_name"], "sku": r["sku"], "weight": _f(r["weight"]),
            "net_weight": _f(r["net_weight"]), "diamond_weight": _f(r["diamond_weight"]),
            "purity": _f(r["purity"]), "price": _f(r["price"]), "compare_price": _f(r["compare_price"]),
            "is_publish": r["is_publish"],
            "creation_date": creation_date.isoformat() if hasattr(creation_date, "isoformat") else creation_date,
            "g2d": _f(r["g2d"]), "making_charge_per_g": _f(r["making_charge_per_g"]),
            "discount_pct": _f(r["discount_pct"]),
            "labour_group": r["labour_group"], "labour_type": r["labour_type"],
        }
    capped = len(cls_map) > VARIANT_SEARCH_MAX_CODES
    return cls_map, item_by_code, price_map, md_map, diamond_cp_map, capped


def query_variant_targeted(q, page, page_size):
    """Fast path for ANY non-blank Variant Level search -- exact or
    partial/substring -- via ONE combined BigQuery query
    (_variant_search_and_aggregate) that filters Product_price down to just
    the matching item_codes FIRST, instead of the slow path's full
    368K-row classification/metal-diamond/diamond-cp maps.
    Returns None (caller falls back to the classification-map path,
    unchanged) when the search matched nothing, or matched more than
    VARIANT_SEARCH_MAX_CODES codes (a broad browse, not a Variant lookup)."""
    q = (q or "").strip()
    if not q:
        return None
    cache_key = q.lower()
    cached = _VARIANT_SEARCH_CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < VARIANT_SEARCH_TTL_SEC:
        rows = cached["rows"]
    else:
        t0 = time.time()
        # These 4 small config lookups are independent of each other and of
        # the main search query below -- fetched CONCURRENTLY rather than
        # one after another, so a cold config cache (each has its own 60s
        # TTL, see _SMALL_CONFIG_TTL_SEC) costs one round-trip's worth of
        # wall-clock time, not four stacked sequentially.
        with ThreadPoolExecutor(max_workers=4) as ex:
            f_gold = ex.submit(todays_gold_rates)
            f_g2d = ex.submit(fetch_g2d_bands)
            f_slab = ex.submit(fetch_g2d_diamond_discounts)
            f_labour = ex.submit(fetch_labour_rate_slab)
            gold_rates, g2d_bands = f_gold.result(), f_g2d.result()
            diamond_discounts, labour_rates = f_slab.result(), f_labour.result()
        cls_map, item_by_code, price_map, md_map, diamond_cp_map, capped = _variant_search_and_aggregate(
            q, gold_rates, g2d_bands)
        if capped:
            print(f"[variant-search] {q!r}: capped ({time.time()-t0:.2f}s) -- "
                  f"falling back to classification-map search")
            return None
        if not cls_map:
            # Genuinely no match -- a slower path re-running the SAME
            # substring test in-memory would only confirm the same empty
            # result, so return it directly instead of paying for a
            # classification-map cache build that changes nothing.
            print(f"[variant-search] {q!r}: no match ({time.time()-t0:.2f}s)")
            _VARIANT_SEARCH_CACHE[cache_key] = {"ts": time.time(), "rows": []}
            return [], 0
        # Exact-vs-substring priority: if `q` case-insensitively equals one
        # of the matched item_codes exactly, show ONLY that variant (same
        # priority rule the old exact-search fast path enforced), not every
        # other code that merely contains `q` as a fragment.
        ql = q.lower()
        exact_codes = [c for c in cls_map if c.strip().lower() == ql]
        codes = exact_codes if exact_codes else list(cls_map.keys())
        sorted_codes = sorted(codes, key=lambda c: (
            1 if cls_map.get(c, {}).get("is_consignment") else 0,
            GROUP_PRIORITY.get(cls_map.get(c, {}).get("item_group"), 3),
            c,
        ))
        shopify_map = build_variant_shopify_map()
        cash_back_rates = fetch_cash_back_rates()
        rows = [
            _build_variant_row(c, cls_map, item_by_code, price_map, md_map, diamond_discounts,
                                diamond_cp_map, labour_rates, shopify_map, cash_back_rates)
            for c in sorted_codes
        ]
        _VARIANT_SEARCH_CACHE[cache_key] = {"ts": time.time(), "rows": rows}
        print(f"[variant-search] {q!r}: matched {len(codes)} in {time.time()-t0:.2f}s (single combined query)")
    total = len(rows)
    page_rows = rows[(page - 1) * page_size: (page - 1) * page_size + page_size]
    return page_rows, total


def query_variant_page(q, page, page_size):
    q = (q or "").strip()
    if q:
        targeted = query_variant_targeted(q, page, page_size)
        if targeted is not None:
            return targeted

    codes, cls_map = _variant_matched_sorted_codes(q)
    total = len(codes)
    page_codes = codes[(page - 1) * page_size: (page - 1) * page_size + page_size]

    mc_case_sql, dp_case_sql, g2d_params = _variant_g2d_case(fetch_g2d_bands())
    item_by_code = _variant_items_detail(page_codes, mc_case_sql, dp_case_sql, g2d_params) if page_codes else {}
    price_map = build_variant_overall_price_map()
    md_map = build_variant_metal_diamond_map()
    diamond_discounts = fetch_g2d_diamond_discounts()
    diamond_cp_map = build_variant_diamond_cp_map()
    md_map = _with_gemstone_cp(md_map)
    labour_rates = fetch_labour_rate_slab()
    shopify_map = build_variant_shopify_map()
    cash_back_rates = fetch_cash_back_rates()

    rows = [
        _build_variant_row(code, cls_map, item_by_code, price_map, md_map, diamond_discounts,
                            diamond_cp_map, labour_rates, shopify_map, cash_back_rates)
        for code in page_codes
    ]
    return rows, total


def _variant_build_inputs(codes):
    """The 7 shared lookups every _build_variant_row call needs, fetched once.
    `codes` is None for a full export/dump (queries ALL of items -- cheaper
    than an IN UNNEST of >100K values, and items is only ~105K rows to begin
    with), or a specific code list for a page/search."""
    mc_case_sql, dp_case_sql, g2d_params = _variant_g2d_case(fetch_g2d_bands())
    item_by_code = _variant_items_detail(codes, mc_case_sql, dp_case_sql, g2d_params)
    price_map = build_variant_overall_price_map()
    md_map = build_variant_metal_diamond_map()
    diamond_discounts = fetch_g2d_diamond_discounts()
    diamond_cp_map = build_variant_diamond_cp_map()
    md_map = _with_gemstone_cp(md_map)
    labour_rates = fetch_labour_rate_slab()
    shopify_map = build_variant_shopify_map()
    cash_back_rates = fetch_cash_back_rates()
    return (item_by_code, price_map, md_map, diamond_discounts, diamond_cp_map, labour_rates, shopify_map,
            cash_back_rates)


def all_variant_rows_full():
    """Every Variant Level row, unfiltered, in the same Gold->Diamond->Other
    (Consignment last) order as every other Variant Level path -- backs the
    dashboard's "load once, filter client-side" Excel-style table. Reuses the
    exact same row-building function/formulas as the paginated and CSV paths;
    nothing is computed differently here."""
    codes, cls_map = _variant_matched_sorted_codes("")
    (item_by_code, price_map, md_map, diamond_discounts, diamond_cp_map, labour_rates, shopify_map,
     cash_back_rates) = _variant_build_inputs(None)
    return [
        _build_variant_row(code, cls_map, item_by_code, price_map, md_map, diamond_discounts,
                            diamond_cp_map, labour_rates, shopify_map, cash_back_rates)
        for code in codes
    ]


def stream_variant_csv_rows(q):
    codes, cls_map = _variant_matched_sorted_codes(q)
    (item_by_code, price_map, md_map, diamond_discounts, diamond_cp_map, labour_rates, shopify_map,
     cash_back_rates) = _variant_build_inputs(None)

    csv_cols = VARIANT_COLUMNS
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([VARIANT_LABELS[c] for c in csv_cols])
    yield buf.getvalue()
    buf.seek(0); buf.truncate(0)

    for code in codes:
        row = _build_variant_row(code, cls_map, item_by_code, price_map, md_map, diamond_discounts,
                                  diamond_cp_map, labour_rates, shopify_map, cash_back_rates)
        line = []
        for c in csv_cols:
            v = row.get(c)
            line.append("" if v is None else v)
        writer.writerow(line)
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)


CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Edit-Token",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}


def _client():
    return bigquery.Client(project=BQ_PROJECT or None)


def _gcs_client():
    return storage.Client(project=BQ_PROJECT or None)


def _search_clause(q, prefix=""):
    """Case-insensitive substring match across every column, cast to STRING."""
    if not q:
        return "TRUE", []
    col = (f"{prefix}." if prefix else "") + "`{c}`"
    parts = [f"LOWER(CAST({col.format(c=c)} AS STRING)) LIKE @q" for c in COLUMNS]
    return "(" + " OR ".join(parts) + ")", [
        bigquery.ScalarQueryParameter("q", "STRING", f"%{q.lower()}%")
    ]


# G2D Ratio = diamond_weight / net_weight from ds_imputed_reporting.items,
# joined on item_code only (no other field). Same "Variant" (item_name) can
# span several rows/item_codes with Item Group = Diamond (multiple stone
# lines); the ratio is identical across them, so it is shown on only the
# FIRST such row per Variant (item_name) -- every other Diamond row in that
# Variant, and every Variant with no valid diamond/net weight at all, is
# blank. Non-Diamond rows (Item Group != "Diamond") always show 0.
# items.item_code had zero duplicates as of 2026-09-04, but the ROW_NUMBER
# dedup guards against that changing. NONE of this drops or merges rows --
# every underlying Product_price row is still returned, only the g2d_ratio
# value differs per row.
G2D_TABLE = os.environ.get("G2D_TABLE", "lucirajewelry-prod.ds_imputed_reporting.items")

# Carat Weight / Purchase Rate / Purchase Amount -- Product Price tab only
# (component-level; NOT Variant Level). For Diamond rows: Carat Weight =
# Net Weight / Pieces. Purchase Rate is matched from stone_rates LEFT JOIN
# common_attributes on item_attribute_id, filtered to the row currently
# valid by date, normalized (LOWER(TRIM())) match on Item Group + Shape +
# Quality + Stone Color, AND Carat Weight BETWEEN from_weight AND to_weight
# (inclusive). The 4-attribute match alone is NOT unique -- common_attributes
# also carries a finer sieve/stone_size tier Product Price has no comparable
# field for, so several rate rows can still qualify for the same attributes
# + weight,  confirmed against LJ-MR0782-14YGLGD-14 (4 candidate rates for
# one component: 8150/14300/15000/43000). Per the user: the NARROWEST
# from_weight-to_weight slab wins (most specific over a broad catch-all).
# The join uses a per-row synthetic id (_prowid) + QUALIFY-style ROW_NUMBER
# so it can NEVER duplicate a Product_price row even when multiple slabs
# match -- exactly one rate (or NULL) per original row.
STONE_RATES_TABLE = os.environ.get("STONE_RATES_TABLE", "lucirajewelry-prod.Lucira_Prod.stone_rates")
COMMON_ATTRIBUTES_TABLE = os.environ.get("COMMON_ATTRIBUTES_TABLE", "lucirajewelry-prod.ornaverse_erp_administration.common_attributes")
# Stone Rate Slab -- view gold_rates.stone_rate_slab (sql/stone_rate_slab_view.sql):
# stone_rates LEFT JOIN ornaverse_erp_master.common_attributes, only rates valid
# today, and only the NEWEST from_date per stone + weight slab (older duplicate
# entries for the same slab removed). Display-only for now: the Slab tab shows
# it via GET /stone-rate-slab. Purchase Rate matching (_stone_rate_rows_cte)
# still reads stone_rates directly -- switching it to this view is pending
# the user's decision.
STONE_RATE_SLAB_VIEW = os.environ.get("STONE_RATE_SLAB_VIEW", "lucirajewelry-prod.gold_rates.stone_rate_slab")


# Labour Rate Slab -- view gold_rates.labour_rate_slab (sql/labour_rate_slab_view.sql):
# labour_rates LEFT JOIN ornaverse_erp_master.common_attributes. Display-only
# (Slab tab, GET /labour-rate-slab); purchase_rate = labour charge.
LABOUR_RATE_SLAB_VIEW = os.environ.get("LABOUR_RATE_SLAB_VIEW", "lucirajewelry-prod.gold_rates.labour_rate_slab")


def labour_rate_slab_list():
    bq = _client()
    rows = bq.query(
        f"SELECT item_group_name, type_name, from_weight, to_weight, purchase_rate "
        f"FROM `{LABOUR_RATE_SLAB_VIEW}` ORDER BY item_group_name, type_name, from_weight, to_weight"
    ).result()
    num = lambda v: float(v) if v is not None else None
    return [{
        "item_group_name": r["item_group_name"], "type_name": r["type_name"],
        "from_weight": num(r["from_weight"]), "to_weight": num(r["to_weight"]),
        "purchase_rate": num(r["purchase_rate"]),
    } for r in rows]


def stone_rate_slab_list():
    bq = _client()
    rows = bq.query(
        f"SELECT item_group_name, attribute, type_code, type_name, shape_code, shape_name, "
        f"from_weight, to_weight, DATE(from_date) AS from_date, DATE(to_date) AS to_date, "
        f"purchase_rate, sales_rate FROM `{STONE_RATE_SLAB_VIEW}` "
        f"ORDER BY item_group_name, type_code, attribute, from_weight, to_weight"
    ).result()
    num = lambda v: float(v) if v is not None else None
    return [{
        "item_group_name": r["item_group_name"], "attribute": r["attribute"],
        "type_code": r["type_code"], "type_name": r["type_name"],
        "shape_code": r["shape_code"], "shape_name": r["shape_name"],
        "from_weight": num(r["from_weight"]), "to_weight": num(r["to_weight"]),
        "from_date": r["from_date"].isoformat() if r["from_date"] else None,
        "to_date": r["to_date"].isoformat() if r["to_date"] else None,
        "purchase_rate": num(r["purchase_rate"]), "sales_rate": num(r["sales_rate"]),
    } for r in rows]


def _stone_rate_rows_cte():
    return f"""
        stone_rate_rows AS (
          SELECT
            LOWER(TRIM(b.item_group_name)) AS ig,
            LOWER(TRIM(b.shape_name)) AS sh,
            LOWER(TRIM(b.quality_name)) AS ql,
            LOWER(TRIM(b.stone_color_name)) AS sc,
            b.attribute,
            a.from_weight, a.to_weight, a.purchase_rate
          FROM `{STONE_RATES_TABLE}` a
          LEFT JOIN `{COMMON_ATTRIBUTES_TABLE}` b ON a.item_attribute_id = b.item_attribute_id
          WHERE CURRENT_DATE('Asia/Kolkata') BETWEEN DATE(a.from_date) AND DATE(a.to_date)
        )
    """

# Making Charge /g -- matched from that row's OWN g2d_ratio (computed above)
# against the G2D Making Charges bands. The RATE for each band is the master
# value from gold_rates.g2d_making_charges (read live every request, never
# hardcoded here) -- editable from the dashboard's G2D Making Charges panel.
# The band boundaries (G2D Range) and Dis% are NOT editable and stay fixed.
#
# "Plain Gold Jewellery" is checked explicitly FIRST via the item_code's own
# naming convention -- karat + metal color + "PG" right before the trailing
# size (e.g. "LJ-AN0002-14RGPG-6", "LJ-PGR015-18RGPG-12"). For every other
# row, Making Charge is blank unless g2d_ratio is a real, positive number --
# blank (not 0) when g2d_ratio is NULL or <= 0.
MAKING_CHARGES_TABLE = os.environ.get("MAKING_CHARGES_TABLE", "lucirajewelry-prod.gold_rates.g2d_making_charges")
# band_key -> (bigquery param name, fallback rate if the table row is ever missing)
MAKING_CHARGE_BANDS = [
    ("plain_gold",         "mc_pg",  3500),
    ("plain_gold_0_1g",    "mc_pg01",3000),
    ("supper_ultra_low",   "mc_sul", 3500),
    ("ultra_low",          "mc_ul",  3500),
    ("low",                "mc_low", 3000),
    ("medium",             "mc_med", 2500),
    ("high",               "mc_high",2500),
    ("ultra_high",         "mc_uh",  2500),
    ("supper_ultra_high",  "mc_suh", 2500),
]
# NOTE: "plain_gold_0_1g" (row added per explicit request: "0-1 gm | Plain
# Gold Jewellery | 3000") is a new EDITABLE reference row only -- it is NOT
# yet wired into _making_charge_case's CASE WHEN below, since which items
# should match "0-1 gm Plain Gold" vs the existing "plain_gold" band (by
# weight? by a different item_code pattern?) hasn't been confirmed. Until
# that's decided, this band's rate can be viewed/edited from the dashboard
# but does not yet change any Making Charge /g calculation.


def fetch_making_charge_rates():
    """{band_key: making_charge} read live from the master table -- the
    single source of truth every calculation (SQL below, CSV export, on-screen
    table) reads from. Falls back to the last-known sheet values per-band if
    a row is somehow missing (never fails the whole request over this)."""
    rates = {}
    try:
        bq = _client()
        rows = bq.query(f"SELECT band_key, making_charge FROM `{MAKING_CHARGES_TABLE}`").result()
        rates = {r["band_key"]: float(r["making_charge"]) for r in rows}
    except Exception:
        pass
    return rates


def _making_charge_case(rates):
    """Returns (case_sql, [ScalarQueryParameter, ...]) using live rates with
    per-band fallback to the sheet's original value if that band is missing."""
    params = [
        bigquery.ScalarQueryParameter(param, "FLOAT64", rates.get(band, fallback))
        for band, param, fallback in MAKING_CHARGE_BANDS
    ]
    case_sql = r"""
        CASE
          WHEN STARTS_WITH(UPPER(item_code), 'LJ-GC') THEN 500
          WHEN REGEXP_CONTAINS(item_code, r'PG-[0-9.]+$') THEN @mc_pg
          WHEN g2d_ratio IS NULL OR g2d_ratio <= 0 THEN NULL
          WHEN g2d_ratio <= 0.049 THEN @mc_sul
          WHEN g2d_ratio <= 0.099 THEN @mc_ul
          WHEN g2d_ratio <= 0.199 THEN @mc_low
          WHEN g2d_ratio <= 0.299 THEN @mc_med
          WHEN g2d_ratio <= 0.499 THEN @mc_high
          WHEN g2d_ratio <= 0.999 THEN @mc_uh
          ELSE @mc_suh
        END AS making_charge_per_g
    """
    return case_sql, params


def _g2d_ranked_cte(where_bare, making_case_sql, discount_case_sql="NULL AS discount_pct",
                     diamond_disc_case_sql="NULL AS diamond_disc_pct"):
    return f"""
        WITH g2d_dedup AS (
          SELECT item_code, diamond_weight, net_weight AS g2d_net_weight,
                 ROW_NUMBER() OVER (
                   PARTITION BY item_code ORDER BY COALESCE(modified_date, creation_date) DESC
                 ) AS rn
          FROM `{G2D_TABLE}`
        ),
        {_stone_rate_rows_cte()},
        joined AS (
          SELECT {_qualified_cols()}, ROW_NUMBER() OVER () AS _prowid,
            CASE WHEN p.item_group_name IN ('Diamond', 'Color Stone', 'Cubic Zirconia') AND p.pieces IS NOT NULL AND p.pieces > 0
                 THEN p.net_weight / p.pieces END AS carat_weight,
            CASE WHEN g.diamond_weight IS NOT NULL AND g.diamond_weight > 0
                      AND g.g2d_net_weight IS NOT NULL AND g.g2d_net_weight > 0
                 THEN ROUND(g.diamond_weight / g.g2d_net_weight, 4) END AS raw_g2d_ratio
          FROM `{TABLE}` AS p
          LEFT JOIN g2d_dedup g ON g.item_code = p.item_code AND g.rn = 1
        ),
        priced AS (
          SELECT j.*, sr.purchase_rate, sr.attribute,
            ROW_NUMBER() OVER (
              PARTITION BY j._prowid
              ORDER BY (sr.to_weight - sr.from_weight) ASC
            ) AS _rate_rn
          FROM joined j
          LEFT JOIN stone_rate_rows sr
            ON sr.ig = LOWER(TRIM(j.item_group_name)) AND sr.sh = LOWER(TRIM(j.shape_name))
           AND sr.ql = LOWER(TRIM(j.quality_name)) AND sr.sc = LOWER(TRIM(j.stone_color_name))
           AND j.carat_weight IS NOT NULL
           AND j.carat_weight >= sr.from_weight AND j.carat_weight <= sr.to_weight
        ),
        priced_final AS (
          SELECT * EXCEPT(_rate_rn) FROM priced WHERE _rate_rn = 1
        ),
        -- Cost Price / Sale Price: this row's Attribute + Carat Weight looked
        -- up in the Stone Rate Slab (latest rate only) -- the slab whose
        -- from_weight..to_weight contains the carat weight; narrowest slab
        -- wins, one rate per row (never duplicates a row).
        slab_priced AS (
          SELECT pf.*, ss.purchase_rate AS cost_price, ss.sales_rate AS sale_price,
            ROW_NUMBER() OVER (
              PARTITION BY pf._prowid
              ORDER BY (ss.to_weight - ss.from_weight) ASC
            ) AS _slab_rn
          FROM priced_final pf
          LEFT JOIN `{STONE_RATE_SLAB_VIEW}` ss
            ON ss.attribute = pf.attribute
           AND pf.carat_weight IS NOT NULL
           AND pf.carat_weight >= ss.from_weight AND pf.carat_weight <= ss.to_weight
        ),
        ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY item_name
              ORDER BY CASE WHEN raw_g2d_ratio IS NOT NULL THEN 0 ELSE 1 END, item_code
            ) AS variant_rank
          FROM slab_priced
          WHERE _slab_rn = 1
        ),
        with_g2d AS (
          SELECT {", ".join(f"`{c}`" for c in COLUMNS)}, attribute, cost_price, sale_price, carat_weight, purchase_rate,
            CASE WHEN carat_weight IS NOT NULL AND purchase_rate IS NOT NULL
                 THEN carat_weight * purchase_rate END AS purchase_amount,
            CASE WHEN carat_weight IS NOT NULL AND purchase_rate IS NOT NULL AND pieces IS NOT NULL
                 THEN carat_weight * purchase_rate * pieces END AS diamond_cp,
            CASE
              WHEN IFNULL(item_group_name, '') != 'Diamond' THEN 0
              WHEN raw_g2d_ratio IS NOT NULL AND variant_rank = 1 THEN raw_g2d_ratio
              ELSE NULL
            END AS g2d_ratio,
            raw_g2d_ratio
          FROM ranked
        )
        SELECT * EXCEPT(raw_g2d_ratio),
          {making_case_sql},
          {discount_case_sql},
          {diamond_disc_case_sql}
        FROM with_g2d
        WHERE {where_bare}
    """


def _g2d_diamond_disc_case(discounts):
    """Product Price's Diamond Disc% -- same rule as Variant Level: the
    item's G2D band "Diamond Discount" (raw_g2d_ratio, i.e. the same
    diamond_weight / net_weight Variant Level uses) for E-F / CD / RB / SC
    lines, 0 for any other diamond quality, blank for non-diamond lines."""
    band_params = [(k, f"gdd_{i}") for i, k in enumerate(
        [k for _, k in G2D_BAND_KEYS_BY_CUTOFF] + ["supper_ultra_high"])]
    params = [bigquery.ScalarQueryParameter(p, "FLOAT64", discounts.get(k, 0.0)) for k, p in band_params]
    quals = ", ".join(f"'{q}'" for q in sorted(G2D_DIAMOND_DISCOUNT_QUALITIES))
    band_whens = "\n".join(
        f"WHEN raw_g2d_ratio <= {cutoff} THEN @{band_params[i][1]}"
        for i, (cutoff, _) in enumerate(G2D_BAND_KEYS_BY_CUTOFF))
    case_sql = f"""
        CASE
          WHEN Diamond_type IS NULL OR TRIM(Diamond_type) = '' THEN NULL
          WHEN Diamond_type NOT IN ({quals}) THEN 0
          WHEN raw_g2d_ratio IS NULL THEN 0
          {band_whens}
          ELSE @{band_params[-1][1]}
        END AS diamond_disc_pct
    """
    return case_sql, params


def _qualified_cols():
    return ", ".join(f"p.`{c}`" for c in COLUMNS)


def query_page(q, page, page_size):
    bq = _client()
    where, params = _search_clause(q, prefix="p")
    where_bare, _ = _search_clause(q)
    offset = (page - 1) * page_size

    count_sql = f"SELECT COUNT(*) AS n FROM `{TABLE}` AS p WHERE {where}"
    count_job = bq.query(count_sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    total = int(list(count_job.result())[0]["n"])

    making_case_sql, making_params = _making_charge_case(fetch_making_charge_rates())
    discount_case_sql, discount_params = _discount_pct_case(fetch_item_group_discounts())
    diamond_disc_case_sql, diamond_disc_params = _g2d_diamond_disc_case(fetch_g2d_diamond_discounts())
    rows_sql = f"""
        {_g2d_ranked_cte(where_bare, making_case_sql, discount_case_sql, diamond_disc_case_sql)}
        ORDER BY {ITEM_GROUP_SORT_EXPR}, item_code
        LIMIT @page_size OFFSET @offset
    """
    rows_params = params + making_params + discount_params + diamond_disc_params + [
        bigquery.ScalarQueryParameter("page_size", "INT64", page_size),
        bigquery.ScalarQueryParameter("offset", "INT64", offset),
    ]
    rows_job = bq.query(rows_sql, job_config=bigquery.QueryJobConfig(query_parameters=rows_params))
    rows = [dict(r) for r in rows_job.result()]

    # NUMERIC/BIGNUMERIC come back as Decimal -- make them JSON-safe.
    for r in rows:
        for k, v in r.items():
            if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                r[k] = float(v)

    return rows, total


def query_all_rows(q):
    """Row iterator over every row matching `q` (up to CSV_ROW_CAP), streamed
    page-by-page from BigQuery rather than materialized all at once."""
    bq = _client()
    where_bare, params = _search_clause(q)
    making_case_sql, making_params = _making_charge_case(fetch_making_charge_rates())
    discount_case_sql, discount_params = _discount_pct_case(fetch_item_group_discounts())
    diamond_disc_case_sql, diamond_disc_params = _g2d_diamond_disc_case(fetch_g2d_diamond_discounts())
    sql = f"""
        {_g2d_ranked_cte(where_bare, making_case_sql, discount_case_sql, diamond_disc_case_sql)}
        ORDER BY {ITEM_GROUP_SORT_EXPR}, item_code
        LIMIT @cap
    """
    qparams = params + making_params + discount_params + diamond_disc_params + [bigquery.ScalarQueryParameter("cap", "INT64", CSV_ROW_CAP)]
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qparams))
    return job.result(page_size=5000)


def all_product_price_rows_full():
    """Every Product Price row, unfiltered, JSON-safe -- backs the
    dashboard's "load once, filter client-side" Excel-style column filters
    on the Product Price tab, same pattern as Variant Level's full=1.
    Reuses the exact same per-row computation as stream_csv_rows
    (merged_amount/selling_price/overall_selling_price) -- nothing computed
    differently here, just returned as JSON instead of written as CSV."""
    gold_rates = todays_gold_rates()
    out = []
    for row in query_all_rows(""):
        d = dict(row)
        rec = {}
        for c in CSV_COLUMNS:
            if c == "metal_amount":
                v = merged_amount(d, gold_rates)
            elif c == "Saleing_price":
                v = selling_price(d, gold_rates)
            elif c == "overall_selling_price":
                v = overall_selling_price(d, gold_rates)
            else:
                v = d.get(c)
            if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                v = float(v)
            rec[c] = v
        out.append(rec)
    return out


# ── Daily snapshot: build, validate, load, record ────────────────────────
def _validate_snapshot_rows(rows, required_cols, min_rows, unique_col=None, label=""):
    """Raises ValueError (caller treats this as a failed run -- previous
    snapshot stays active) if the freshly-built dataset looks wrong: too
    few rows, a missing column, or (for Variant Level) a duplicate
    item_code, which would mean the "one row per Variant" guarantee broke."""
    if len(rows) < min_rows:
        raise ValueError(f"{label}: only {len(rows)} rows (expected >= {min_rows})")
    missing = [c for c in required_cols if c not in rows[0]]
    if missing:
        raise ValueError(f"{label}: missing column(s) in built rows: {missing}")
    if unique_col:
        seen = set()
        for r in rows:
            v = r.get(unique_col)
            if v in seen:
                raise ValueError(f"{label}: duplicate {unique_col} {v!r} -- Variant Level must be one row per Variant")
            seen.add(v)


# Explicit load-job schemas -- autodetect was tried first and failed: it
# sampled early rows of `karat_code` (values like "14", "18") and guessed
# INTEGER, then choked the moment it hit a row with "NA". Every column here
# is typed from the real Product_price schema / the known type of each
# computed field, so this never depends on what BigQuery's sampler happens
# to see first. Anything in a row that ISN'T listed here (e.g. Variant
# Level's internal-only sku/price/is_publish/creation_date/etc., kept in
# the Python dict for other callers but not part of VARIANT_COLUMNS) is
# silently dropped via ignore_unknown_values, not an error.
PRODUCT_PRICE_SNAPSHOT_SCHEMA = [
    ("item_code", "STRING"), ("item_name", "STRING"), ("attribute", "STRING"), ("cost_price", "FLOAT64"), ("sale_price", "FLOAT64"), ("weight", "FLOAT64"), ("pieces", "INTEGER"),
    ("net_weight", "FLOAT64"), ("purity", "FLOAT64"), ("pure_weight", "FLOAT64"), ("bom_rate", "FLOAT64"),
    ("bom_base_amount", "FLOAT64"), ("center_stone", "INTEGER"), ("item_group_name", "STRING"),
    ("discount_pct", "FLOAT64"), ("diamond_disc_pct", "FLOAT64"),
    ("base_item", "STRING"), ("type_code", "STRING"), ("metal_name", "STRING"), ("karat_code", "STRING"),
    ("metal_color_code", "STRING"), ("collection_name", "STRING"), ("super_type_name", "STRING"),
    ("shape_name", "STRING"), ("stone_size_id", "INTEGER"), ("stone_size_name", "STRING"),
    ("quality_name", "STRING"), ("stone_color_name", "STRING"), ("type_name", "STRING"),
    ("metal_amount", "FLOAT64"), ("Diamond_type", "STRING"), ("g2d_ratio", "FLOAT64"),
    ("making_charge_per_g", "FLOAT64"), ("Saleing_price", "FLOAT64"), ("overall_selling_price", "FLOAT64"),
    ("carat_weight", "FLOAT64"), ("purchase_rate", "FLOAT64"), ("purchase_amount", "FLOAT64"), ("diamond_cp", "FLOAT64"),
    ("_snapshot_seq", "INTEGER"),
]
VARIANT_SNAPSHOT_SCHEMA = [
    ("item_code", "STRING"), ("product_composition", "STRING"), ("item_name", "STRING"),
    ("status", "STRING"), ("item_group", "STRING"), ("category", "STRING"), ("main_shape", "STRING"),
    ("net_weight", "FLOAT64"), ("weight", "FLOAT64"), ("diamond_weight", "FLOAT64"), ("purity", "FLOAT64"),
    ("g2d", "FLOAT64"), ("g2d_band", "STRING"),
    ("metal_amount", "FLOAT64"), ("diamond_amount", "FLOAT64"), ("overall_selling_price", "FLOAT64"),
    ("making_charge_per_g", "FLOAT64"), ("making_amount", "FLOAT64"),
    ("before_gst_overall", "FLOAT64"), ("before_gst_value", "FLOAT64"), ("original_after_gst_overall", "FLOAT64"),
    ("making_discount_pct", "FLOAT64"), ("making_discount_amount", "FLOAT64"), ("net_making_amount", "FLOAT64"),
    ("diamond_disc_pct", "FLOAT64"), ("diamond_discount_amount", "FLOAT64"), ("net_diamond_amount", "FLOAT64"),
    ("after_discount", "FLOAT64"), ("gst", "FLOAT64"), ("final_after_gst_overall", "FLOAT64"),
    ("total_diamond_cp", "FLOAT64"), ("labour_charge", "FLOAT64"), ("cp_pr_gm_making", "FLOAT64"), ("total_cp_cost", "FLOAT64"),
    ("margin_pct", "FLOAT64"), ("cash_back_pct", "FLOAT64"),
    ("total_discount", "FLOAT64"), ("margin1_pct", "FLOAT64"),
    ("free_gold_coin", "STRING"), ("net_margin", "FLOAT64"), ("net_margin_pct", "FLOAT64"), ("free_coin_qty", "INTEGER"),
    ("free_coin_cp", "FLOAT64"), ("material_type", "STRING"), ("slab_status", "STRING"),
    ("amount_ex_gst", "FLOAT64"), ("actual_sp", "FLOAT64"),
    ("final_amount_post_discount", "FLOAT64"),
    ("additional_disc", "FLOAT64"), ("margin2_pct", "FLOAT64"), ("image_url", "STRING"),
    ("diamond_pieces", "FLOAT64"), ("gemstone_type", "STRING"), ("gemstone_pieces", "FLOAT64"),
    ("gemstone_weight", "FLOAT64"), ("gemstone_amount", "FLOAT64"), ("gemstone_cp", "FLOAT64"),
    ("_snapshot_seq", "INTEGER"),
]
# Columns added 2026-10-29 that the daily-history table doesn't have yet (it
# would need an ALTER TABLE ... ADD COLUMN first); kept out of the archive.
_VARIANT_HISTORY_SKIP = {"_snapshot_seq", "diamond_pieces", "gemstone_type", "gemstone_pieces",
                         "gemstone_weight", "gemstone_amount", "gemstone_cp"}

# ══════════════════════════════════════════════════════════════════════
#  Variant Level daily history -- ONE growing table (never a per-day
#  table), separate from VARIANT_SNAPSHOT_TABLE (which only ever holds
#  TODAY's data and gets overwritten by every refresh). Reuses
#  all_variant_rows_full() -- the EXACT function that already builds the
#  dashboard's own snapshot -- so this only archives that output, never
#  recomputes anything. See append_variant_level_history().
# ══════════════════════════════════════════════════════════════════════
VARIANT_HISTORY_TABLE = f"{SNAPSHOT_DATASET}.variant_level_daily_history"
VARIANT_HISTORY_STAGING_TABLE = f"{SNAPSHOT_DATASET}.variant_level_daily_history_staging"
VARIANT_HISTORY_SCHEMA = [
    ("snapshot_date", "DATE"), ("snapshot_timestamp", "TIMESTAMP"),
] + [f for f in VARIANT_SNAPSHOT_SCHEMA if f[0] not in _VARIANT_HISTORY_SKIP]


def append_variant_level_history():
    """Idempotent daily archive: loads today's Variant Level rows into a
    staging table, then MERGEs into variant_level_daily_history keyed on
    (snapshot_date, item_code).
      - Same date rerun (e.g. a retry) -> WHEN MATCHED -> UPDATE in place,
        never a duplicate row.
      - New date -> WHEN NOT MATCHED -> INSERT.
      - Every earlier date's rows are untouched -- this MERGE has no
        DELETE clause and its WHERE-equivalent (the ON condition) only
        ever matches today's own snapshot_date."""
    t0 = time.time()
    now_utc = datetime.now(timezone.utc)
    snapshot_date = (now_utc.astimezone(_IST).date() if _IST else now_utc.date()).isoformat()
    snapshot_timestamp = now_utc.isoformat()

    vl_rows = all_variant_rows_full()
    row_count = len(vl_rows)
    history_cols = [c for c, _ in VARIANT_HISTORY_SCHEMA if c not in ("snapshot_date", "snapshot_timestamp")]
    staged_rows = [
        {"snapshot_date": snapshot_date, "snapshot_timestamp": snapshot_timestamp,
         **{c: r.get(c) for c in history_cols}}
        for r in vl_rows
    ]
    del vl_rows

    bq = _client()
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        schema=[bigquery.SchemaField(name, typ) for name, typ in VARIANT_HISTORY_SCHEMA],
        ignore_unknown_values=True,
    )
    bq.load_table_from_json(staged_rows, VARIANT_HISTORY_STAGING_TABLE, job_config=job_config).result()
    del staged_rows

    update_cols = [c for c in history_cols if c != "item_code"] + ["snapshot_timestamp"]
    set_clause = ", ".join(f"T.{c} = S.{c}" for c in update_cols)
    insert_cols = ["snapshot_date", "snapshot_timestamp"] + history_cols
    insert_cols_sql = ", ".join(insert_cols)
    insert_vals_sql = ", ".join(f"S.{c}" for c in insert_cols)
    bq.query(f"""
        MERGE `{VARIANT_HISTORY_TABLE}` T
        USING `{VARIANT_HISTORY_STAGING_TABLE}` S
        ON T.snapshot_date = S.snapshot_date AND T.item_code = S.item_code
        WHEN MATCHED THEN UPDATE SET {set_clause}
        WHEN NOT MATCHED THEN INSERT ({insert_cols_sql}) VALUES ({insert_vals_sql})
    """).result()

    return {
        "status": "SUCCESS", "snapshot_date": snapshot_date,
        "variant_level_rows": row_count, "duration_sec": round(time.time() - t0, 2),
    }


def _load_snapshot_table(table_fqn, rows, schema):
    """Atomic-from-readers'-perspective replace: a BigQuery load job with
    WRITE_TRUNCATE either fully replaces the table's contents or (on error)
    leaves the existing table completely untouched -- no reader ever sees a
    half-written table. Stamps each row with `_snapshot_seq` so the
    original build order (Gold -> Diamond -> Other, Consignment last, etc.)
    survives the round-trip -- BigQuery's SELECT * does not otherwise
    guarantee insertion order -- and query_snapshot_rows sorts by it."""
    bq = _client()
    seqd_rows = [{**r, "_snapshot_seq": i} for i, r in enumerate(rows)]
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        schema=[bigquery.SchemaField(name, typ) for name, typ in schema],
        ignore_unknown_values=True,
    )
    job = bq.load_table_from_json(seqd_rows, table_fqn, job_config=job_config)
    job.result()  # raises on failure


def _write_snapshot_blob(blob_name, rows, columns, snapshot_meta):
    """Pre-renders the EXACT gzip response body /?full=1 and
    /variant-level?full=1 serve, once, at refresh time -- so a dashboard
    open only has to stream a few MB of already-gzipped bytes back out
    (query_snapshot_blob), never re-run BigQuery's row iterator or
    json.dumps over ~370K/~105K rows on every request. The BigQuery
    snapshot tables (_load_snapshot_table) remain the durable source of
    truth; this is purely a served-response cache built from the same
    validated `rows` right after they pass _validate_snapshot_rows."""
    import json
    payload = {
        "rows": rows, "total": len(rows), "columns": columns, "q": "",
        "generated_at": snapshot_meta["snapshot_created_at"],
        "snapshot": snapshot_meta,
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(body, compresslevel=1)
    blob = _gcs_client().bucket(SNAPSHOT_GCS_BUCKET).blob(blob_name)
    blob.content_encoding = "gzip"
    blob.upload_from_string(gz, content_type="application/json")


def query_snapshot_blob_url(blob_name):
    """Public URL for the pre-rendered gzip blob _write_snapshot_blob
    wrote, or None if it doesn't exist yet -- callers fall back to
    query_snapshot_rows (a live-but-still-snapshot BigQuery read, returned
    inline) in that case, so a dashboard open never hard-depends on GCS
    being warm. Returning a URL rather than proxying the bytes through this
    function is required, not just an optimization: Cloud Functions/Run
    rejects responses over ~10MB ("Response size was too large"), and
    these blobs are close enough to that ceiling to hit it."""
    try:
        blob = _gcs_client().bucket(SNAPSHOT_GCS_BUCKET).blob(blob_name)
        if not blob.exists():
            return None
        return f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{blob_name}"
    except Exception:
        return None


def refresh_snapshots(triggered_by="scheduler"):
    """The ONE expensive pipeline run per day (see module docstring above).
    Builds both full datasets via the EXACT SAME functions the old
    always-recompute /?full=1 and /variant-level?full=1 paths used
    (all_product_price_rows_full / all_variant_rows_full -- nothing
    duplicated), validates them, and only overwrites the snapshot tables if
    both pass validation. Always writes one snapshot_runs row (SUCCESS or
    FAILED) so a bad run is visible for diagnosis and never silently
    replaces a good snapshot -- see _validate_snapshot_rows /
    _load_snapshot_table."""
    t0 = time.time()
    now_utc = datetime.now(timezone.utc)
    snapshot_date = now_utc.astimezone(_IST).date().isoformat() if _IST else now_utc.date().isoformat()
    snapshot_meta = {
        "snapshot_date": snapshot_date, "snapshot_created_at": now_utc.isoformat(),
        "product_price_rows": None, "variant_level_rows": None,  # filled in once counts are known, below
    }
    pp_count = vl_count = 0
    status, error_message = "SUCCESS", None
    try:
        # Sequential, not parallel: building BOTH full datasets at once (as
        # this used to, via ThreadPoolExecutor) roughly doubles peak memory
        # -- that's what OOM-killed the container the first time this ran
        # (2160MB used against a 2048MB limit). Freeing each dataset's
        # memory (by loading it to BigQuery and dropping the reference)
        # before building the next keeps peak usage to one dataset at a time.
        pp_rows = all_product_price_rows_full()
        _validate_snapshot_rows(pp_rows, CSV_COLUMNS, min_rows=100000, label="product_price")
        pp_count = len(pp_rows)
        snapshot_meta["product_price_rows"] = pp_count
        _load_snapshot_table(PRODUCT_PRICE_SNAPSHOT_TABLE, pp_rows, PRODUCT_PRICE_SNAPSHOT_SCHEMA)
        _write_snapshot_blob(PRODUCT_PRICE_SNAPSHOT_BLOB, pp_rows, CSV_COLUMNS, snapshot_meta)
        del pp_rows

        vl_rows = all_variant_rows_full()
        _validate_snapshot_rows(vl_rows, VARIANT_COLUMNS, min_rows=30000, unique_col="item_code", label="variant_level")
        vl_count = len(vl_rows)
        snapshot_meta["variant_level_rows"] = vl_count
        _load_snapshot_table(VARIANT_SNAPSHOT_TABLE, vl_rows, VARIANT_SNAPSHOT_SCHEMA)
        _write_snapshot_blob(VARIANT_SNAPSHOT_BLOB, vl_rows, VARIANT_COLUMNS, snapshot_meta)
        del vl_rows
    except Exception as e:
        status, error_message = "FAILED", str(e)

    # Shopify tab dataset (Variant Level on Shopify weights) -- rebuilt right
    # after Variant Level so the Shopify tab opens instantly. Separate try:
    # a failure here is logged and never affects the snapshots above.
    if status == "SUCCESS":
        try:
            shopify_snapshot(force=True)
        except Exception as e:
            print(f"[shopify-tab] rebuild after refresh failed: {e}")
        try:
            inventory_full_snapshot(force=True)  # Inventory Margin tab, same reason
        except Exception as e:
            print(f"[inventory-tab] rebuild after refresh failed: {e}")
        try:
            mto_margin_snapshot(force=True)  # MTO Margin tab, same reason
        except Exception as e:
            print(f"[mto-tab] rebuild after refresh failed: {e}")

    duration_sec = round(time.time() - t0, 2)
    bq = _client()
    bq.insert_rows_json(SNAPSHOT_RUNS_TABLE, [{
        "snapshot_date": snapshot_date,
        "snapshot_created_at": now_utc.isoformat(),
        "snapshot_status": status,
        "product_price_rows": pp_count,
        "variant_level_rows": vl_count,
        "duration_sec": duration_sec,
        "error_message": error_message,
        "triggered_by": triggered_by,
    }])
    return {
        "status": status, "snapshot_date": snapshot_date, "duration_sec": duration_sec,
        "product_price_rows": pp_count, "variant_level_rows": vl_count, "error": error_message,
    }


def _safe_refresh_snapshots(triggered_by):
    """Rebuild the snapshot right after a master-data edit (G2D / Diamond
    Slab / Labour / Cash Back / Item Group Discounts) so the Variant Level
    tab -- which loads its full dataset ONCE per browser session from the
    snapshot, not live -- reflects the change without waiting for the daily
    noon run. A failed rebuild must never mask an already-successful config
    write, so this always returns a plain bool rather than letting an
    exception propagate into the config-update response."""
    try:
        return refresh_snapshots(triggered_by=triggered_by)["status"] == "SUCCESS"
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════════
#  Daily Check (GET /health-check) -- one tick-box list for the dashboard's
#  "Daily Check" tab: did today's gold rate land, did the daily refresh run
#  on it, were rate edits deployed, is every slab loaded, and does every
#  calculation still hold on the published snapshot. Read-only; every check
#  re-derives its answer from the live tables / snapshot tables -- nothing
#  here is cached or self-reported. ok: True = tick, False = problem,
#  None = nothing to tick today (e.g. no rate edits were deployed).
# ══════════════════════════════════════════════════════════════════════
# Slabs editable from the Slab tab, and readable names for what changed.
HC_EDITABLE_SLABS = ["G2D Making Charges", "Slab Excel Table"]  # Cash Back no longer used (2026-10-10)
HC_SLAB_NAMES = {"slab_excel": "Slab Excel Table", "g2d": "G2D Making Charges", "cash_back": "Cash Back", "diamond_slab": "Diamond Slab",
                 "labour": "Labour", "item_group_discounts": "Item Group Discounts"}
HC_FIELD_NAMES = {"making_charge": "Making Charge", "dis_pct": "Dis%", "diamond_dis_pct": "Diamond Discount %",
                  "threshold": "Above (₹)", "cash_back_pct": "Cash Back %", "disc_pct": "Disc%",
                  "amount": "Amount", "discount_pct": "Discount %"}


# ══════════════════════════════════════════════════════════════════════
#  Shopify tab (GET /shopify?full=1[&refresh=1]) -- REBUILT 2026-10-05 per the
#  user: Variant Level's pricing, re-run on SHOPIFY weights.
#
#  1. Shopify table: Lucira_Shopify_product_variant_metafields (a) JOIN
#     ds_imputed_reporting.items (b) ON a.owner_id = b.external_variant_id,
#     namespace custom / ornaverse, one value per owner_id + key
#     (ORDER BY namespace DESC -> ornaverse first, as in the user's query),
#     pivoted to the user's column list; Item Code must not be blank.
#       diamond_pieces = diamond_pieces,  else total_number_of_diamonds  (first > 0)
#       diamond_weight = diamond_weight,  else total_weight_approx_      (first > 0)
#  2. Every Variant Level column is then computed by the SAME function that
#     builds Variant Level (_build_variant_row), with only the weights swapped:
#       Net Weight       -> Shopify metal_weight
#       Diamond Weight   -> Shopify diamond_weight (rule above)
#       G2D              -> diamond_weight / metal_weight (same formula)
#       Making /g, Making Discount %, Diamond Disc%  -> that G2D's band
#       Metal Amount     -> Shopify metal_weight x today's karat rate
#                           (non-gold: Variant Level metal amount scaled by weight)
#       Diamond Amount   -> Shopify diamond_weight x the variant's Variant Level
#                           diamond rate /ct (Diamond Amount / ERP diamond weight)
#       Total Diamond CP -> Variant Level diamond CP scaled the same way
#     Labour (CP. pr gm making), GST, Cash Back, CP, Margin, Margin2: unchanged
#     formulas, now on these inputs. A missing Shopify weight falls back to the
#     ERP weight and is flagged in weight_basis.
# ══════════════════════════════════════════════════════════════════════
SHOPIFY_METAFIELDS_TABLE = os.environ.get(
    "SHOPIFY_METAFIELDS_TABLE", "lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_product_variant_metafields")
SHOPIFY_DW_BLOB = f"{SNAPSHOT_GCS_PREFIX}/shopify_variant_level.json.gz"
SHOPIFY_KEYS = ["color_stone_pieces", "color_stone_weight",
                "diamond_1_numbers", "diamond_1_weight", "diamond_2_numbers", "diamond_2_weight",
                "diamond_3_numbers", "diamond_3_weight", "diamond_4_numbers", "diamond_4_weight",
                "diamond_pieces", "total_number_of_diamonds", "diamond_weight", "total_weight_approx_",
                "gemstone_1_numbers", "gemstone_1_weight", "metal_purity", "metal_weight",
                "stone_pieces", "stone_weight"]
SHOPIFY_TEXT_KEYS = {"metal_purity"}
SHOPIFY_OUT_KEYS = ["color_stone_pieces", "color_stone_weight",
                    "diamond_1_numbers", "diamond_1_weight", "diamond_2_numbers", "diamond_2_weight",
                    "diamond_3_numbers", "diamond_3_weight", "diamond_4_numbers", "diamond_4_weight",
                    "diamond_pieces", "diamond_weight", "gemstone_1_numbers", "gemstone_1_weight",
                    "metal_purity", "metal_weight", "stone_pieces", "stone_weight"]


def shopify_weight_rows():
    bq = _client()
    keys_sql = ", ".join("'" + k + "'" for k in SHOPIFY_KEYS)
    cast = lambda k: (f"NULLIF(TRIM({k}), '')" if k in SHOPIFY_TEXT_KEYS
                      else f"SAFE_CAST(TRIM({k}) AS FLOAT64)")
    sql = f"""
        WITH kv AS (
          SELECT * FROM (
            SELECT a.owner_id, a.key, a.value_st
            FROM `{SHOPIFY_METAFIELDS_TABLE}` a
            WHERE LOWER(a.namespace) IN ('custom', 'ornaverse') AND a.key IN ({keys_sql})
            QUALIFY ROW_NUMBER() OVER (PARTITION BY a.owner_id, a.key ORDER BY a.namespace DESC) = 1
          )
          PIVOT (ANY_VALUE(value_st) FOR key IN ({keys_sql}))
        ),
        b AS (
          SELECT external_variant_id, item_code, item_name
          FROM `{G2D_TABLE}`
          WHERE external_variant_id IS NOT NULL AND item_code IS NOT NULL AND TRIM(item_code) != ''
          QUALIFY ROW_NUMBER() OVER (
            PARTITION BY external_variant_id ORDER BY COALESCE(modified_date, creation_date) DESC) = 1
        ),
        sv AS (
          SELECT v.id AS variant_id, p.status
          FROM `{SHOPIFY_PRODUCTS_TABLE}` p, UNNEST(p.variants) v
          WHERE v.id IS NOT NULL
          QUALIFY ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY p.updated_at DESC) = 1
        ),
        -- Synced = the variant has a "components" metafield whose value_st is
        -- the {{"components":[...]}} JSON with at least one component.
        comp AS (
          SELECT owner_id
          FROM `{SHOPIFY_METAFIELDS_TABLE}`
          WHERE LOWER(namespace) IN ('custom', 'ornaverse') AND key = 'components'
          GROUP BY owner_id
          HAVING LOGICAL_OR(IFNULL(ARRAY_LENGTH(JSON_QUERY_ARRAY(value_st, '$.components')), 0) > 0)
        )
        SELECT CAST(kv.owner_id AS STRING) AS owner_id, b.item_code, b.item_name, sv.status,
          IF(comp.owner_id IS NOT NULL, 'Yes', 'No') AS synced,
          {", ".join(f"{cast(k)} AS {k}" for k in SHOPIFY_KEYS
                     if k not in ("diamond_pieces", "total_number_of_diamonds", "diamond_weight", "total_weight_approx_"))},
          -- first POSITIVE value wins: Ornaverse writes diamond_weight = 0.0 as a
          -- placeholder on 1,705 variants whose real weight sits in
          -- custom.total_weight_approx_ (equal to ERP on all of them).
          COALESCE(IF(SAFE_CAST(TRIM(diamond_pieces) AS FLOAT64) > 0, SAFE_CAST(TRIM(diamond_pieces) AS FLOAT64), NULL),
                   IF(SAFE_CAST(TRIM(total_number_of_diamonds) AS FLOAT64) > 0, SAFE_CAST(TRIM(total_number_of_diamonds) AS FLOAT64), NULL),
                   SAFE_CAST(TRIM(diamond_pieces) AS FLOAT64),
                   SAFE_CAST(TRIM(total_number_of_diamonds) AS FLOAT64)) AS diamond_pieces,
          COALESCE(IF(SAFE_CAST(TRIM(diamond_weight) AS FLOAT64) > 0, SAFE_CAST(TRIM(diamond_weight) AS FLOAT64), NULL),
                   IF(SAFE_CAST(TRIM(total_weight_approx_) AS FLOAT64) > 0, SAFE_CAST(TRIM(total_weight_approx_) AS FLOAT64), NULL),
                   SAFE_CAST(TRIM(diamond_weight) AS FLOAT64),
                   SAFE_CAST(TRIM(total_weight_approx_) AS FLOAT64)) AS diamond_weight
        FROM kv
        JOIN b ON b.external_variant_id = kv.owner_id
        LEFT JOIN sv ON sv.variant_id = kv.owner_id
        LEFT JOIN comp ON comp.owner_id = kv.owner_id
        ORDER BY b.item_code, kv.owner_id
    """
    out = []
    for r in bq.query(sql).result(page_size=20000):
        d = dict(r)
        st = d.get("status")
        d["status"] = st.capitalize() if isinstance(st, str) else None
        out.append(d)
    return out


def _karat_from_purity(purity, item_code):
    """'14KT' -> '14'; else the Item Code's metal segment (LJ-x-14WG.. -> 14). None if not gold."""
    import re
    m = re.match(r"\s*(\d{1,3})\s*K", str(purity or ""), re.I)
    d = m.group(1) if m else None
    if d is None:
        m = re.match(r"^[^-]+-[^-]+-(\d{1,3})([A-Z]{2})", str(item_code or ""), re.I)
        if m and m.group(2).upper() != "PT":
            d = m.group(1)
    if d is None:
        return None
    d = str(int(d))
    return {"916": "22", "995": "24", "999": "24"}.get(d, d if d in KARAT_PURITY else None)


def _calc_context(codes=None):
    """Everything _build_variant_row needs, fetched once (codes=None -> all items)."""
    _, cls_map = _variant_matched_sorted_codes("")
    (item_by_code, price_map, md_map, diamond_discounts, diamond_cp_map, labour_rates, shopify_map,
     cash_back_rates) = _variant_build_inputs(codes)
    return {"cls_map": cls_map, "item_by_code": item_by_code, "price_map": price_map, "md_map": md_map,
            "diamond_discounts": diamond_discounts, "diamond_cp_map": diamond_cp_map, "labour_rates": labour_rates,
            "shopify_map": shopify_map, "cash_back_rates": cash_back_rates, "gold": todays_gold_rates(),
            "bands": fetch_g2d_bands(), "defaults": {k: (mc, dp) for k, _, _, mc, dp in _VARIANT_G2D_BANDS}}


def _calc_on_weights(code, ctx, net_weight=None, diamond_weight=None, purity_text=None):
    """Variant Level's own calculation (_build_variant_row) for `code`, with Net
    Weight / Diamond Weight swapped for the given ones (None -> the ERP item's):
      G2D -> band -> Making /g + Making Discount %; Metal Amount = weight x today's
      karat rate (non-gold: Variant Level amount scaled by weight); Diamond Amount
      and Diamond CP = Variant Level values scaled by diamond weight (the variant's
      own rate /ct). Returns (row, info) or (None, info) if the code isn't priced."""
    info = {"basis": []}
    if code not in ctx["cls_map"]:
        info["basis"].append("Not in Variant Level")
        return None, info
    item = dict(ctx["item_by_code"].get(code, {}))
    md = ctx["md_map"].get(code, {}) or {}
    erp_nw = float(item.get("net_weight") or 0.0)
    erp_dw = float(item.get("diamond_weight") or 0.0)
    nw = float(net_weight) if (net_weight is not None and net_weight > 0) else erp_nw
    dw = float(diamond_weight) if diamond_weight is not None else erp_dw
    if not (net_weight is not None and net_weight > 0):
        info["basis"].append("metal wt from ERP")
    if diamond_weight is None:
        info["basis"].append("diamond wt from ERP")
    g2d = round(dw / nw, 4) if nw > 0 else None
    bk = g2d_band_key(g2d)
    if bk:
        b = ctx["bands"].get(bk, {})
        mc_d, dp_d = ctx["defaults"].get(bk, (None, None))
        item["making_charge_per_g"] = b.get("making_charge", mc_d)
        item["discount_pct"] = b.get("dis_pct", dp_d)
    else:
        item["making_charge_per_g"] = None
        item["discount_pct"] = None
    item["net_weight"], item["diamond_weight"], item["g2d"] = nw, dw, g2d
    kt = _karat_from_purity(purity_text, code)
    vl_metal = float(md.get("metal_amount") or 0.0)
    if kt and ctx["gold"].get(kt) is not None:
        metal_amount = round(nw * ctx["gold"][kt], 2)
    else:
        metal_amount = round(vl_metal * (nw / erp_nw), 2) if erp_nw > 0 else vl_metal
    vl_dia = float(md.get("diamond_amount") or 0.0)
    vl_cp = float((ctx["diamond_cp_map"] or {}).get(code, 0.0) or 0.0)
    ratio = (dw / erp_dw) if erp_dw > 0 else (1.0 if dw == 0 else None)
    if ratio is None:
        info["basis"].append("no ERP diamond rate")
        ratio = 0.0
    row = _build_variant_row(code, ctx["cls_map"], {code: item}, ctx["price_map"],
                             {code: {**md, "metal_amount": metal_amount, "diamond_amount": round(vl_dia * ratio, 2)}},
                             ctx["diamond_discounts"], {code: round(vl_cp * ratio, 2)},
                             ctx["labour_rates"], ctx["shopify_map"], ctx["cash_back_rates"])
    info.update({"karat": kt, "erp_nw": erp_nw, "erp_dw": erp_dw,
                 "diamond_rate": round(vl_dia / erp_dw, 2) if erp_dw > 0 and vl_dia > 0 else None})
    return row, info


def shopify_variant_level_rows():
    """Shopify columns + every Variant Level column, computed by
    _build_variant_row on Shopify weights (see the header above)."""
    sh_rows = shopify_weight_rows()
    ctx = _calc_context(None)
    out = []
    for s in sh_rows:
        code = s["item_code"]
        rec = {k: s.get(k) for k in ["owner_id", "item_code", "item_name", "status", "synced"] + SHOPIFY_OUT_KEYS}
        # Shopify diamond weight 0 on an item ERP says has diamonds = missing
        # (same as metal weight <= 0) -> ERP weight, flagged in weight_basis.
        dw = s.get("diamond_weight")
        if dw is not None and dw <= 0 and float((ctx["item_by_code"].get(code) or {}).get("diamond_weight") or 0) > 0:
            dw = None
        row, info = _calc_on_weights(code, ctx, s.get("metal_weight"), dw, s.get("metal_purity"))
        if row is None:
            rec["weight_basis"] = "Not in Variant Level"
            out.append(rec)
            continue
        for c in VARIANT_COLUMNS + VARIANT_EXTRA_COLUMNS:
            if c in ("item_code", "item_name", "status", "net_weight", "diamond_weight", "diamond_pieces", "image_url"):
                continue  # Shopify's own values stay in those columns
            v = row.get(c)
            if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                v = float(v)
            rec[c] = v
        rec["karat"] = info["karat"]
        rec["diamond_rate"] = info["diamond_rate"]
        rec["erp_net_weight"] = info["erp_nw"]
        rec["erp_diamond_weight"] = info["erp_dw"]
        rec["weight_basis"] = "Shopify" if not info["basis"] else "Shopify (" + ", ".join(info["basis"]) + ")"
        rec["diamond_weight_used"] = float(row.get("diamond_weight") or 0.0)
        rec["erp_diamond_pieces"] = row.get("diamond_pieces")
        rec["diamond_wt_check"] = _diamond_wt_check(rec, s.get("diamond_weight"))
        out.append(rec)
    return out


DIAMOND_WT_TOLERANCE = 0.01  # ct


def _diamond_wt_check(rec, shop_dw):
    """Diamond weight AND pieces are compulsory when Material Type is diamond
    (or the item carries diamonds anyway, e.g. Platinum Jewellery with LGD):
    the weight the calc used must be > 0, pieces must exist, Shopify should
    carry both and agree with ERP, and the weight must have produced a
    Diamond Amount and Total Diamond CP. First failing rule wins."""
    used, erp = rec["diamond_weight_used"], float(rec.get("erp_diamond_weight") or 0.0)
    shop_pcs, erp_pcs = float(rec.get("diamond_pieces") or 0.0), float(rec.get("erp_diamond_pieces") or 0.0)
    if "diamond" not in str(rec.get("material_type") or "").lower() and not (used > 0 or (shop_dw or 0) > 0):
        return "Not diamond"
    if used <= 0:
        return "Missing weight (Shopify & ERP)"
    if shop_pcs <= 0 and erp_pcs <= 0:
        return "Missing pieces (Shopify & ERP)"
    if not (rec.get("diamond_amount") or 0) > 0 or not (rec.get("total_diamond_cp") or 0) > 0:
        return "No diamond rate / CP"
    if not (shop_dw or 0) > 0 or shop_pcs <= 0:
        return "Shopify blank (ERP used)"
    if erp > 0 and abs(shop_dw - erp) > DIAMOND_WT_TOLERANCE:
        return "Shopify wt ≠ ERP"
    if erp_pcs > 0 and shop_pcs != erp_pcs:
        return "Shopify pcs ≠ ERP"
    return "OK"


def shopify_validation(rows):
    ids = [r["owner_id"] for r in rows]
    st = {}
    for r in rows:
        st[r.get("status") or "Not on Shopify"] = st.get(r.get("status") or "Not on Shopify", 0) + 1
    return {
        "total_variants": len(rows),
        "duplicate_owner_id_count": len(ids) - len(set(ids)),
        "blank_item_code": sum(1 for r in rows if not r.get("item_code")),
        "priced": sum(1 for r in rows if r.get("final_after_gst_overall") is not None),
        "not_in_variant_level": sum(1 for r in rows if r.get("weight_basis") == "Not in Variant Level"),
        "metal_wt_from_erp": sum(1 for r in rows if "metal wt from ERP" in (r.get("weight_basis") or "")),
        "diamond_wt_from_erp": sum(1 for r in rows if "diamond wt from ERP" in (r.get("weight_basis") or "")),
        "diamond_wt_null": sum(1 for r in rows if r.get("diamond_weight") is None),
        "diamond_pieces_null": sum(1 for r in rows if r.get("diamond_pieces") is None),
        "active_count": st.get("Active", 0), "draft_count": st.get("Draft", 0), "status_counts": st,
        "synced_yes": sum(1 for r in rows if r.get("synced") == "Yes"),
        "synced_no": sum(1 for r in rows if r.get("synced") == "No"),
        "diamond_wt_check": {k: sum(1 for r in rows if r.get("diamond_wt_check") == k)
                             for k in sorted({r.get("diamond_wt_check") for r in rows if r.get("diamond_wt_check")})},
    }


def shopify_snapshot(force=False):
    """{snapshot_url, snapshot}; (re)builds the gzip blob when missing, not from today (IST), or force."""
    import json
    bucket = _gcs_client().bucket(SNAPSHOT_GCS_BUCKET)
    blob = bucket.blob(SHOPIFY_DW_BLOB)
    today = (datetime.now(timezone.utc).astimezone(_IST).date() if _IST else datetime.now(timezone.utc).date())
    if not force and blob.exists():
        blob.reload()
        meta = blob.metadata or {}
        upd = blob.updated.astimezone(_IST).date() if (_IST and blob.updated) else None
        if upd == today and meta.get("snapshot"):
            return {"snapshot_url": f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{SHOPIFY_DW_BLOB}",
                    "snapshot": json.loads(meta["snapshot"])}
    rows = shopify_variant_level_rows()
    validation = shopify_validation(rows)
    print("[shopify-tab] validation " + json.dumps(validation))
    snap = {"snapshot_created_at": datetime.now(timezone.utc).isoformat(), "validation": validation}
    payload = {"rows": rows, "total": len(rows), "snapshot": snap}
    gz = gzip.compress(json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8"), compresslevel=1)
    blob.content_encoding = "gzip"
    blob.metadata = {"snapshot": json.dumps(snap, separators=(",", ":"))}
    blob.upload_from_string(gz, content_type="application/json")
    return {"snapshot_url": f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{SHOPIFY_DW_BLOB}", "snapshot": snap}


# Company tab (GET /company-inventory) -- live stock per company with its
# purchase amount (Live_inventory.item_cost, as booked) and the selling amount
# the dashboard prices that Item Code at: Variant Level's Final After GST from
# the published snapshot x pieces. One row per inventory piece-line; the tab
# aggregates by company. Pieces whose Item Code isn't in Variant Level come
# back with a blank selling amount (shown, never guessed).
LIVE_INVENTORY_TABLE = os.environ.get("LIVE_INVENTORY_TABLE", "lucirajewelry-prod.ds_imputed_reporting.Live_inventory")


def company_inventory_rows():
    bq = _client()
    sql = f"""
        SELECT li.company_code, li.company_name, li.location_name, li.item_code, li.item_name,
               li.item_group_name, li.document_date, li.pieces, li.item_cost,
               v.final_after_gst_overall, v.category, v.product_composition
        FROM `{LIVE_INVENTORY_TABLE}` li
        LEFT JOIN `{VARIANT_SNAPSHOT_TABLE}` v ON v.item_code = li.item_code
        ORDER BY li.company_code, li.item_code
    """
    out = []
    for r in bq.query(sql).result(page_size=10000):
        pcs = int(r["pieces"] or 0)
        cost = float(r["item_cost"]) if r["item_cost"] is not None else None
        unit = float(r["final_after_gst_overall"]) if r["final_after_gst_overall"] is not None else None
        out.append({
            "company_code": r["company_code"], "company_name": r["company_name"], "location_name": r["location_name"],
            "item_code": r["item_code"], "item_name": r["item_name"], "item_group": r["item_group_name"],
            "category": r["category"], "product_composition": r["product_composition"],
            "document_date": r["document_date"].isoformat() if r["document_date"] else None,
            "pieces": pcs, "purchase_amount": round(cost, 2) if cost is not None else None,
            "selling_price": unit, "selling_amount": round(unit * pcs, 2) if unit is not None else None,
        })
    snap = latest_snapshot_status().get("latest_success") or {}
    return {"rows": out, "snapshot": snap}


# ══════════════════════════════════════════════════════════════════════
#  Slab Excel table (GET / POST /slab-excel) -- Slab tab's Excel
#  Import / Export configuration table, stored in gold_rates.slab_excel.
#  Values are kept exactly as typed (STRING) so nothing is reformatted; an
#  import REPLACES the whole table (exact duplicate rows dropped), in one
#  atomic load job. Used by pricing via slab_match() (see "Slab-based pricing").
# ══════════════════════════════════════════════════════════════════════
SLAB_EXCEL_TABLE = os.environ.get("SLAB_EXCEL_TABLE", "lucirajewelry-prod.gold_rates.slab_excel")
SLAB_EXCEL_FIELDS = ["category", "material_type", "g2d", "making_discount", "diamond_discount",
                     "making_charges", "price_range", "free"]


def slab_excel_list():
    bq = _client()
    rows = bq.query(f"SELECT * FROM `{SLAB_EXCEL_TABLE}` ORDER BY sort_order").result()
    out = []
    for r in rows:
        out.append({f: r[f] for f in SLAB_EXCEL_FIELDS})
    upd = None
    try:
        t = bq.get_table(SLAB_EXCEL_TABLE)
        upd = t.modified.isoformat() if t.modified else None
    except Exception:
        pass
    return {"rows": out, "updated_at": upd}


def slab_excel_replace(rows):
    if not isinstance(rows, list):
        raise ValueError("rows must be a list")
    if len(rows) > 10000:
        raise ValueError("too many rows (max 10,000)")
    clean, seen = [], set()
    now = datetime.now(timezone.utc).isoformat()
    for r in rows:
        rec = {}
        for f in SLAB_EXCEL_FIELDS:
            v = (r or {}).get(f)
            v = None if v is None else str(v).strip()
            rec[f] = v if v not in ("", None) else None
        if all(rec[f] is None for f in SLAB_EXCEL_FIELDS):
            continue  # fully blank line
        key = tuple(rec[f] for f in SLAB_EXCEL_FIELDS)
        if key in seen:
            continue  # exact duplicate row
        seen.add(key)
        rec["sort_order"] = len(clean) + 1
        rec["updated_at"] = now
        clean.append(rec)
    bq = _client()
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        schema=[bigquery.SchemaField("sort_order", "INTEGER")]
               + [bigquery.SchemaField(f, "STRING") for f in SLAB_EXCEL_FIELDS]
               + [bigquery.SchemaField("updated_at", "TIMESTAMP")],
    )
    bq.load_table_from_json(clean, SLAB_EXCEL_TABLE, job_config=job_config).result()
    _SLAB_CACHE["ts"] = 0.0
    out = slab_excel_list()
    out["imported"] = len(clean)
    out["skipped"] = len(rows) - len(clean)
    return out


# ══════════════════════════════════════════════════════════════════════
#  Inventory Margin -- full grid (GET /inventory-full): EVERY Live_inventory
#  column (images_agg dropped -- a long image list; the Gender record
#  flattened to `gender`) + every Variant Level calculation column for that
#  Item Code (prefixed calc_, from the published snapshot) + purchase /
#  selling / margin. Purchase Amount = item_cost (as booked); Selling Amount
#  = calc_final_after_gst_overall x pieces (blank when the Item Code has no
#  price or a price of 0). Sent column-wise (one list per column) as a gzip
#  blob, rebuilt when older than 10 minutes so stock stays near-live.
# ══════════════════════════════════════════════════════════════════════
INVENTORY_FULL_BLOB = f"{SNAPSHOT_GCS_PREFIX}/inventory_full.json.gz"
INVENTORY_FULL_MAX_AGE_SEC = 1800  # piece-level recalculation takes ~1-2 min


def inventory_full_rows():
    """Every Live_inventory column + the Variant Level calculation run on THAT
    piece's own weights (its net_weight / diamond_weight / karat, today's gold &
    diamond rates, slab) -> SP. CP = the inventory's item_cost (the price it was
    actually received at), per piece; every margin uses it:
      Margin 1% = (With GST SP - CP) / With GST SP
      Margin 2% with discount = (Final After GST - CP) / Final After GST
      Net Margin = Final After GST - CP - free coin CP;  Margin2 = after Cash Back.
    Lines are per piece-line: amounts per line = per-piece x pieces."""
    from decimal import Decimal
    bq = _client()
    raw = list(bq.query(f"""
        SELECT li.* EXCEPT(images_agg, Gender), li.Gender.gender AS gender
        FROM `{LIVE_INVENTORY_TABLE}` li
        ORDER BY li.company_code, li.item_code
    """).result(page_size=5000))
    codes = sorted({r["item_code"] for r in raw if r["item_code"]})
    ctx = _calc_context(codes)
    calc_cols = [c for c in VARIANT_COLUMNS + VARIANT_EXTRA_COLUMNS if c not in ("item_code", "image_url")]
    def conv(v):
        if isinstance(v, Decimal):
            return str(v) if abs(v) >= 2 ** 53 else float(v)
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return v
    cols, data = None, []
    for r in raw:
        d = {k: conv(v) for k, v in dict(r).items()}
        pcs = int(d.get("pieces") or 0) or 1
        nw = (d.get("net_weight") / pcs) if d.get("net_weight") is not None else None
        dw = (d.get("diamond_weight") / pcs) if d.get("diamond_weight") is not None else None
        row, info = _calc_on_weights(d.get("item_code"), ctx, nw, dw, d.get("karat_name"))
        # CP incl. 3% GST (user, 2026-10-23) -- item_cost is booked ex-GST.
        cost = d.get("item_cost") * (1.0 + GST_RATE) if d.get("item_cost") is not None else None
        unit_cp = (cost / pcs) if cost is not None else None
        if row is not None and unit_cp is not None:
            fin = row.get("final_after_gst_overall") or 0
            orig = row.get("original_after_gst_overall") or 0
            add = row.get("additional_disc") or 0
            sp = row.get("actual_sp") or 0
            row["total_cp_cost"] = round(unit_cp, 2)
            row["margin1_pct"] = round((orig - unit_cp) / orig * 100, 2) if orig else None
            row["margin_pct"] = round((fin - unit_cp) / fin * 100, 2) if fin else None
            row["margin2_pct"] = round((fin - add - unit_cp) / (fin - add) * 100, 2) if (fin - add) else None
            row["net_margin"] = round(sp - unit_cp, 2)
            row["net_margin_pct"] = round((sp - unit_cp) / sp * 100, 2) if sp else None
        for c in calc_cols:
            v = row.get(c) if row is not None else None
            d[f"calc_{c}"] = float(v) if (hasattr(v, "__float__") and not isinstance(v, (int, float, bool))) else v
        # Gold columns, same basis as everywhere else: selling = Actual SP (Final
        # After GST - free coin value) x pieces; CP = item_cost incl. 3% GST.
        fin = d.get("calc_final_after_gst_overall")
        asp = d.get("calc_actual_sp")
        sell = round(asp * pcs, 2) if (asp is not None and fin is not None and fin > 0) else None
        d["purchase_amount"] = round(cost, 2) if cost is not None else None
        d["selling_amount"] = sell
        d["margin_amount"] = round(sell - cost, 2) if (sell is not None and cost is not None) else None
        d["margin_pct"] = round((sell - cost) / sell * 100, 2) if (sell and cost is not None) else None
        gross = (fin * pcs) if (fin is not None and fin > 0) else None   # old GST-inclusive basis, for comparison
        d["margin2_pct"] = round((gross - cost) / gross * 100, 2) if (gross and cost is not None) else None
        if cols is None:
            lead = ["purchase_amount", "selling_amount", "margin_amount", "margin_pct", "margin2_pct"]
            cols = [k for k in d.keys() if k not in lead] + lead
        data.append([d.get(c) for c in cols])
    return cols or [], data


def inventory_full_snapshot(force=False):
    import json
    bucket = _gcs_client().bucket(SNAPSHOT_GCS_BUCKET)
    blob = bucket.blob(INVENTORY_FULL_BLOB)
    if not force and blob.exists():
        blob.reload()
        age = (datetime.now(timezone.utc) - blob.updated).total_seconds() if blob.updated else 1e9
        meta = blob.metadata or {}
        if age < INVENTORY_FULL_MAX_AGE_SEC and meta.get("snapshot"):
            return {"snapshot_url": f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{INVENTORY_FULL_BLOB}",
                    "snapshot": json.loads(meta["snapshot"])}
    cols, data = inventory_full_rows()
    snap = {"snapshot_created_at": datetime.now(timezone.utc).isoformat(), "rows": len(data), "columns": len(cols),
            "prices": (latest_snapshot_status().get("latest_success") or {}).get("snapshot_date")}
    payload = {"columns": cols, "data": data, "snapshot": snap}
    gz = gzip.compress(json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8"), compresslevel=6)
    blob.content_encoding = "gzip"
    blob.metadata = {"snapshot": json.dumps(snap, separators=(",", ":"))}
    blob.upload_from_string(gz, content_type="application/json")
    return {"snapshot_url": f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{INVENTORY_FULL_BLOB}", "snapshot": snap}


# Gold Rate strip (GET /gold-rate-strip) -- shown above every dashboard tab:
# today's per-gram gold rate per karat (Pos.metal_rates, same source as every
# calculation) next to the per-gram rate actually baked into the published
# Product Price snapshot (its METAL rows carry exactly that karat's rate), so
# anyone can confirm the prices on screen were built on today's rate.
_GOLD_STRIP_CACHE = {"ts": 0.0, "data": None}


def gold_rate_strip():
    now = time.time()
    if _GOLD_STRIP_CACHE["data"] and (now - _GOLD_STRIP_CACHE["ts"]) < 120:
        return _GOLD_STRIP_CACHE["data"]
    bq = _client()
    g = list(bq.query(f"""
        SELECT DATE(a.from_date) AS d, a.sales_rate * 10 AS rate10
        FROM `{METAL_RATES_TABLE}` a LEFT JOIN `{ITEM_GROUPS_TABLE}` b ON a.metal_type_id = b.item_group_id
        WHERE b.item_group_name = 'Gold' AND DATE(a.from_date) <= CURRENT_DATE('Asia/Kolkata')
        ORDER BY a.from_date DESC, a.rate_id DESC LIMIT 1""").result())
    rates = todays_gold_rates()
    used = {}
    for r in bq.query(f"""
        SELECT IF(TRIM(karat_code) = '999', '24',  -- 24K gold is coded 999 on its METAL rows
                  IFNULL(NULLIF(LTRIM(TRIM(karat_code), '0'), ''), TRIM(karat_code))) AS kt,
               APPROX_TOP_COUNT(metal_amount, 1)[OFFSET(0)].value AS rate
        FROM `{PRODUCT_PRICE_SNAPSHOT_TABLE}`
        WHERE base_item = 'METAL' AND item_group_name = 'Gold' AND metal_amount > 0
        GROUP BY kt""").result():
        used[r["kt"]] = float(r["rate"])
    snap = latest_snapshot_status().get("latest_success") or {}
    karats = []
    for kt in ["24", "22", "18", "14", "9"]:
        today_rate, pub = rates.get(kt), used.get(kt)
        karats.append({"kt": kt, "purity_pct": round(KARAT_PURITY[kt] * 100, 1), "today": today_rate,
                       "published": pub,
                       "match": (today_rate is not None and pub is not None and abs(today_rate - pub) <= 0.5)
                                if pub is not None else None})
    out = {"rate_date": g[0]["d"].isoformat() if g else None,
           "rate_24k_10g": float(g[0]["rate10"]) if g else None,
           "snapshot_created_at": snap.get("snapshot_created_at"), "karats": karats}
    _GOLD_STRIP_CACHE["data"] = out
    _GOLD_STRIP_CACHE["ts"] = now
    return out


def _hc(group, name, ok, detail):
    return {"group": group, "name": name, "ok": ok, "detail": detail}


def health_check():
    bq = _client()
    one = lambda sql: list(bq.query(sql).result())[0]
    today = (datetime.now(timezone.utc).astimezone(_IST).date() if _IST else datetime.now(timezone.utc).date())
    checks = []

    # ── Daily refresh ──
    g = one(f"""
        SELECT DATE(a.from_date) AS d, a.sales_rate * 10 AS rate10
        FROM `{METAL_RATES_TABLE}` a LEFT JOIN `{ITEM_GROUPS_TABLE}` b ON a.metal_type_id = b.item_group_id
        WHERE b.item_group_name = 'Gold' AND DATE(a.from_date) <= CURRENT_DATE('Asia/Kolkata')
        ORDER BY a.from_date DESC, a.rate_id DESC LIMIT 1""")
    checks.append(_hc("Daily refresh", "Gold rate updated today", g["d"] == today,
        f"Latest gold rate is for {g['d'].isoformat()}: 24K ₹{float(g['rate10']):,.0f} / 10 g"
        + ("" if g["d"] == today else f" — no entry for today ({today.isoformat()}) in Pos.metal_rates")))

    runs = list(bq.query(f"""
        SELECT snapshot_date, snapshot_created_at, snapshot_status, product_price_rows, variant_level_rows,
               error_message, triggered_by
        FROM `{SNAPSHOT_RUNS_TABLE}` ORDER BY snapshot_created_at DESC LIMIT 1""").result())
    last = runs[0] if runs else None
    ran_today = bool(last and last["snapshot_date"] == today and last["snapshot_status"] == "SUCCESS")
    if last:
        t = last["snapshot_created_at"].astimezone(_IST) if _IST else last["snapshot_created_at"]
        det = (f"Last run {t.strftime('%d %b %Y %I:%M %p')} IST — {last['snapshot_status']}"
               f" ({last['product_price_rows'] or 0:,} Product Price rows, {last['variant_level_rows'] or 0:,} variants)")
        if last["snapshot_status"] != "SUCCESS" and last["error_message"]:
            det += f" — {last['error_message'][:200]}"
    else:
        det = "No refresh has ever run"
    checks.append(_hc("Daily refresh", "Daily data refresh ran today", ran_today, det))

    rates_now = todays_gold_rates()
    snap_rate = one(f"""
        SELECT ANY_VALUE(metal_amount) AS r, COUNT(DISTINCT metal_amount) AS k
        FROM `{PRODUCT_PRICE_SNAPSHOT_TABLE}`
        WHERE base_item = 'METAL' AND LTRIM(TRIM(karat_code), '0') = '14'""")
    want = rates_now.get("14")
    got = float(snap_rate["r"]) if snap_rate["r"] is not None else None
    same = want is not None and got is not None and abs(got - want) <= 0.5
    checks.append(_hc("Daily refresh", "Prices use today's gold rate", bool(same and ran_today),
        f"14K rate in the published prices ₹{got:,.2f}/g vs today's rate ₹{want:,.2f}/g" if (want and got)
        else "Couldn't read the 14K rate from the published prices"))

    # Slab edits made from the Slab tab ("Deploy & Refresh Calculations") --
    # named by slab, with what changed, so it reads as plain English.
    def _edit_summary(changed_fields_json):
        try:
            items = json.loads(changed_fields_json or "[]")
        except Exception:
            return "", []
        by_slab = {}
        for c in items:
            slab = HC_SLAB_NAMES.get(c.get("table"), c.get("table") or "?")
            key = str(c.get("key") or "").replace("_", " ").title().replace("0 1G", "0-1 g")
            field = HC_FIELD_NAMES.get(c.get("field"), c.get("field") or "")
            by_slab.setdefault(slab, []).append(f"{key} {field} {c.get('before'):g} → {c.get('after'):g}"
                                                if isinstance(c.get("before"), (int, float)) and isinstance(c.get("after"), (int, float))
                                                else f"{key} {field}")
        text = "; ".join(f"{slab}: " + ", ".join(v[:4]) + (f" +{len(v)-4} more" if len(v) > 4 else "")
                         for slab, v in by_slab.items())
        return text, list(by_slab)
    import json
    editable = " / ".join(HC_EDITABLE_SLABS)
    deps = list(bq.query(f"""
        SELECT version, deployed_at, status, validation_status, changed_fields, error_message
        FROM `{CONFIG_DEPLOYMENTS_TABLE}`
        WHERE DATE(deployed_at, 'Asia/Kolkata') = CURRENT_DATE('Asia/Kolkata')
        ORDER BY deployed_at DESC""").result())
    if not deps:
        prev = list(bq.query(f"""
            SELECT deployed_at, changed_fields FROM `{CONFIG_DEPLOYMENTS_TABLE}`
            WHERE status = 'SUCCESS' ORDER BY deployed_at DESC LIMIT 1""").result())
        det = f"No one edited the {' or '.join(HC_EDITABLE_SLABS)} slab today, so there was nothing to apply."
        if prev:
            t = prev[0]["deployed_at"].astimezone(_IST) if _IST else prev[0]["deployed_at"]
            txt, _ = _edit_summary(prev[0]["changed_fields"])
            det += f" Last edit: {t.strftime('%d %b %Y')} — {txt or 'details not recorded'} (applied OK)."
        checks.append(_hc("Daily refresh", f"Slab edits applied today ({editable})", None, det))
    else:
        d = deps[0]
        ok = d["status"] == "SUCCESS" and (d["validation_status"] in (None, "PASSED"))
        t = d["deployed_at"].astimezone(_IST) if _IST else d["deployed_at"]
        txt, slabs = _edit_summary(d["changed_fields"])
        name = f"Slab edits applied today ({' / '.join(slabs) if slabs else editable})"
        det = (f"Edited at {t.strftime('%I:%M %p')} IST — {txt or 'details not recorded'}. "
               + ("Saved, prices recalculated and checked OK." if ok else
                  f"NOT applied correctly: {d['status']} / validation {d['validation_status'] or '—'}"
                  + (f" — {d['error_message'][:200]}" if d["error_message"] else "")))
        if len(deps) > 1:
            det += f" ({len(deps)} edits today; showing the latest.)"
        checks.append(_hc("Daily refresh", name, ok, det))

    # ── Slabs ──
    kts = ["24", "22", "18", "14", "9"]
    missing = [k for k in kts if not (rates_now.get(k) or 0) > 0]
    checks.append(_hc("Slabs", "Metal Rate (24K / 22K / 18K / 14K / 9K)", not missing,
        ("All 5 karat rates present: " + ", ".join(f"{k}K ₹{rates_now[k]:,.0f}" for k in kts)) if not missing
        else f"Missing karat rate(s): {', '.join(missing)}"))

    mc = fetch_making_charge_rates()
    bad_mc = [b for b, _, _ in MAKING_CHARGE_BANDS if not (mc.get(b) or 0) > 0]
    checks.append(_hc("Slabs", "G2D Making Charges", not bad_mc,
        f"All {len(MAKING_CHARGE_BANDS)} bands have a making charge" if not bad_mc
        else f"Band(s) with no making charge: {', '.join(bad_mc)}"))


    s = one(f"""
        SELECT COUNT(*) AS n, COUNTIF(purchase_rate IS NULL OR sales_rate IS NULL) AS blank_rates,
          (SELECT COUNTIF(attribute IS NOT NULL) FROM `{PRODUCT_PRICE_SNAPSHOT_TABLE}`) AS with_attr,
          (SELECT COUNTIF(attribute IS NOT NULL AND cost_price IS NULL) FROM `{PRODUCT_PRICE_SNAPSHOT_TABLE}`) AS attr_no_cost
        FROM `{STONE_RATE_SLAB_VIEW}`""")
    checks.append(_hc("Slabs", "Stone Rate Slab (latest rates)",
        s["n"] > 0 and s["blank_rates"] == 0 and s["attr_no_cost"] == 0,
        f"{s['n']:,} slabs loaded, {s["blank_rates"]} with a blank rate; "
        f"{s['with_attr'] - s['attr_no_cost']:,} of {s['with_attr']:,} Product Price stone rows got a Cost / Sale Price"))

    l = one(f"""
        SELECT COUNT(*) AS n, COUNTIF(purchase_rate IS NULL) AS blank_rates,
          (SELECT COUNTIF(net_weight > {LABOUR_NET_WEIGHT_CUTOFF}) FROM `{VARIANT_SNAPSHOT_TABLE}`) AS heavy,
          (SELECT COUNTIF(net_weight > {LABOUR_NET_WEIGHT_CUTOFF} AND labour_charge IS NULL) FROM `{VARIANT_SNAPSHOT_TABLE}`) AS heavy_no_lc
        FROM `{LABOUR_RATE_SLAB_VIEW}`""")
    lc_cov = (l["heavy"] - l["heavy_no_lc"]) / l["heavy"] * 100 if l["heavy"] else 100.0
    checks.append(_hc("Slabs", "Labour Rate Slab", l["n"] > 0 and l["blank_rates"] == 0 and lc_cov >= 99.0,
        f"{l['n']:,} slabs loaded; {lc_cov:.2f}% of variants over {LABOUR_NET_WEIGHT_CUTOFF:g} g found a Labour Charge"
        + (f" ({l['heavy_no_lc']:,} without — no ERP labour rate for their group)" if l["heavy_no_lc"] else "")))

    # ── Calculations (re-checked on every published row) ──
    # Columns added 2026-10-29 only exist once a refresh has rebuilt the snapshot.
    snap_cols = {f.name for f in bq.get_table(VARIANT_SNAPSHOT_TABLE).schema}
    gem_cp_sql = "IFNULL(gemstone_cp,0)" if "gemstone_cp" in snap_cols else "0"
    gem_amt_sql = "IFNULL(gemstone_amount,0)" if "gemstone_amount" in snap_cols else "0"
    dia_pcs_sql = "diamond_pieces" if "diamond_pieces" in snap_cols else "1"
    v = one(f"""
        SELECT COUNT(*) AS n, COUNT(DISTINCT item_code) AS uniq,
          COUNTIF(final_after_gst_overall IS NULL) AS null_final,
          COUNTIF(ABS(IFNULL(making_amount,0) - IF(STARTS_WITH(UPPER(item_code),'LJ-GC') AND net_weight > 0, GREATEST(1, net_weight)*IFNULL(making_charge_per_g,0), IFNULL(net_weight,0)*IFNULL(making_charge_per_g,0))) > 0.05) AS bad_making,
          COUNTIF(ABS(IFNULL(after_discount,0) - (IFNULL(metal_amount,0)+IFNULL(net_making_amount,0)+IFNULL(net_diamond_amount,0)+{gem_amt_sql})) > 0.05) AS bad_after,
          COUNTIF(ABS(IFNULL(gst,0) - (IFNULL(after_discount,0) - IF(STARTS_WITH(UPPER(item_code),'LJ-GC'), IFNULL(net_making_amount,0), 0))*{GST_RATE}) > 0.05) AS bad_gst,
          COUNTIF(ABS(IFNULL(final_after_gst_overall,0) - CEIL(IFNULL(after_discount,0)+IFNULL(gst,0))) > 1) AS bad_final,
          COUNTIF((net_weight <= {LABOUR_NET_WEIGHT_CUTOFF} AND ABS(IFNULL(cp_pr_gm_making,0) - {CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF}) > 0.01)
               OR (net_weight > {LABOUR_NET_WEIGHT_CUTOFF} AND ABS(IFNULL(cp_pr_gm_making,0) - net_weight*IFNULL(labour_charge,0)) > 0.05)) AS bad_labour,
          COUNTIF(ABS(IFNULL(total_cp_cost,0) - (IFNULL(total_diamond_cp,0)+{gem_cp_sql}+IFNULL(cp_pr_gm_making,0)+IFNULL(metal_amount,0))*(1+{GST_RATE})) > 0.05) AS bad_cp,
          COUNTIF(final_after_gst_overall > 0 AND margin_pct IS NOT NULL
                  AND ABS(margin_pct - (final_after_gst_overall-total_cp_cost)/final_after_gst_overall*100) > 0.05) AS bad_margin,
          COUNTIF(item_group = 'Gold') AS gold, COUNTIF(item_group = 'Gold' AND NOT (metal_amount > 0)) AS gold_no_metal,
          COUNTIF(item_group = 'Diamond') AS dia, COUNTIF(item_group = 'Diamond' AND NOT (diamond_amount > 0)) AS dia_no_amt,
          COUNTIF(item_group = 'Diamond' AND NOT (total_diamond_cp > 0)) AS dia_no_cp,
          COUNTIF(LOWER(material_type) LIKE '%diamond%') AS dia_mt,
          COUNTIF(LOWER(material_type) LIKE '%diamond%' AND NOT (diamond_weight > 0)) AS dia_mt_no_dw,
          COUNTIF(LOWER(material_type) LIKE '%diamond%' AND NOT ({dia_pcs_sql} > 0)) AS dia_mt_no_pcs,
          STRING_AGG(DISTINCT IF(LOWER(material_type) LIKE '%diamond%' AND NOT (diamond_weight > 0 AND {dia_pcs_sql} > 0),
                                 REGEXP_EXTRACT(item_code, r'^[^-]+-[^-]+'), NULL) LIMIT 10) AS dia_mt_no_dw_styles
        FROM `{VARIANT_SNAPSHOT_TABLE}`""")
    p = one(f"""
        SELECT COUNT(*) AS n,
          COUNTIF(carat_weight IS NOT NULL AND purchase_rate IS NOT NULL
                  AND ABS(purchase_amount - carat_weight*purchase_rate) > 0.01) AS bad_pr_amt,
          COUNTIF(item_group_name = 'Gold' AND NOT (metal_amount > 0)) AS gold_no_rate
        FROM `{PRODUCT_PRICE_SNAPSHOT_TABLE}`""")
    n = v["n"]
    def calc(name, bad, what):
        checks.append(_hc("Calculations", name, bad == 0,
            f"All {n:,} variants correct — {what}" if bad == 0 else f"{bad:,} of {n:,} variants don't match — {what}"))
    checks.append(_hc("Calculations", "Data loaded (Product Price + Variant Level)",
        p["n"] >= 100000 and n >= 30000 and v["uniq"] == n and v["null_final"] == 0,
        f"{p['n']:,} Product Price rows, {n:,} variants ({v['uniq']:,} unique), "
        f"{v['null_final']:,} without a Final After GST"))
    calc("Making Amount", v["bad_making"], "Net Weight × Making Charge /g")
    calc("After Discount", v["bad_after"], "Metal + Net Making + Net Diamond")
    calc("GST 3%", v["bad_gst"], "After Discount × 3%")
    calc("Final After GST Overall", v["bad_final"], "After Discount + GST, rounded up")
    calc("CP. pr gm making (Labour)", v["bad_labour"], f"₹{CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF:,.0f} up to {LABOUR_NET_WEIGHT_CUTOFF:g} g, else Net Weight × Labour Charge")
    calc("Total CP Cost", v["bad_cp"], "Diamond CP + CP making + Metal Amount")
    calc("Margin %", v["bad_margin"], "(Final After GST − Total CP) ÷ Final After GST")
    checks.append(_hc("Calculations", "Pr.Ct Amount (Product Price)", p["bad_pr_amt"] == 0 and p["gold_no_rate"] == 0,
        f"Carat Weight × Purchase Rate on every stone row ({p['bad_pr_amt']:,} mismatches); "
        f"{p['gold_no_rate']:,} gold rows without a gold rate"))
    dia_cov = (v["dia"] - v["dia_no_cp"]) / v["dia"] * 100 if v["dia"] else 100.0
    checks.append(_hc("Calculations", "Metal & Diamond amounts filled",
        v["gold_no_metal"] == 0 and v["dia_no_amt"] == 0 and dia_cov >= 98.0,
        f"Gold variants without Metal Amount: {v['gold_no_metal']:,} of {v['gold']:,}; "
        f"Diamond variants without Diamond Amount: {v['dia_no_amt']:,}; "
        f"Diamond CP found for {dia_cov:.2f}% of {v['dia']:,} diamond variants"
        + (f" ({v['dia_no_cp']:,} with no stone rate match)" if v["dia_no_cp"] else "")))
    # Material Type diamond -> diamond weight AND pieces must not be 0 (user, 2026-10-29)
    ok_dia = v["dia_mt_no_dw"] == 0 and v["dia_mt_no_pcs"] == 0
    checks.append(_hc("Calculations", "Diamond weight & pieces — ERP (Variant Level)", ok_dia,
        (f"All {v['dia_mt']:,} Diamond material-type variants have diamond weight and pieces" if ok_dia else
         f"Of {v['dia_mt']:,} Diamond material-type variants: {v['dia_mt_no_dw']:,} with diamond weight 0, "
         f"{v['dia_mt_no_pcs']:,} with diamond pieces 0 (styles: {v['dia_mt_no_dw_styles']}) — Diamond Amount / CP are 0 for them")
        + ("" if "diamond_pieces" in snap_cols else " · pieces not checked yet: runs after the next data refresh")))
    s = one(f"""
        WITH kv AS (
          SELECT * FROM (
            SELECT a.owner_id, a.key, a.value_st FROM `{SHOPIFY_METAFIELDS_TABLE}` a
            WHERE LOWER(a.namespace) IN ('custom', 'ornaverse')
              AND a.key IN ('diamond_weight', 'total_weight_approx_', 'diamond_pieces', 'total_number_of_diamonds')
            QUALIFY ROW_NUMBER() OVER (PARTITION BY a.owner_id, a.key ORDER BY a.namespace DESC) = 1)
          PIVOT (ANY_VALUE(value_st) FOR key IN ('diamond_weight', 'total_weight_approx_', 'diamond_pieces', 'total_number_of_diamonds'))
        ),
        own AS (SELECT DISTINCT owner_id FROM `{SHOPIFY_METAFIELDS_TABLE}` WHERE LOWER(namespace) IN ('custom', 'ornaverse')),
        b AS (
          SELECT external_variant_id, item_code, item_attribute_id FROM `{G2D_TABLE}`
          WHERE external_variant_id IS NOT NULL AND item_code IS NOT NULL AND TRIM(item_code) != ''
          QUALIFY ROW_NUMBER() OVER (PARTITION BY external_variant_id ORDER BY COALESCE(modified_date, creation_date) DESC) = 1
        ),
        x AS (
          SELECT b.item_code,
            GREATEST(IFNULL(SAFE_CAST(TRIM(kv.diamond_weight) AS FLOAT64), 0), IFNULL(SAFE_CAST(TRIM(kv.total_weight_approx_) AS FLOAT64), 0)) AS dw,
            GREATEST(IFNULL(SAFE_CAST(TRIM(kv.diamond_pieces) AS FLOAT64), 0), IFNULL(SAFE_CAST(TRIM(kv.total_number_of_diamonds) AS FLOAT64), 0)) AS pcs
          FROM own JOIN b ON b.external_variant_id = own.owner_id
          LEFT JOIN kv ON kv.owner_id = own.owner_id
          LEFT JOIN `{ITEM_ATTRIBUTES_TABLE}` ca ON ca.item_attribute_id = b.item_attribute_id
          WHERE LOWER(ca.item_group_name) LIKE '%diamond%'
        )
        SELECT COUNT(*) AS n, COUNTIF(dw <= 0) AS no_dw, COUNTIF(pcs <= 0) AS no_pcs,
          STRING_AGG(DISTINCT IF(dw <= 0 OR pcs <= 0, REGEXP_EXTRACT(item_code, r'^[^-]+-[^-]+'), NULL) LIMIT 10) AS styles,
          COUNT(DISTINCT IF(dw <= 0 OR pcs <= 0, REGEXP_EXTRACT(item_code, r'^[^-]+-[^-]+'), NULL)) AS n_styles
        FROM x""")
    ok_sh = s["no_dw"] == 0 and s["no_pcs"] == 0
    checks.append(_hc("Calculations", "Diamond weight & pieces — Shopify", ok_sh,
        f"All {s['n']:,} Diamond material-type Shopify variants have diamond weight and pieces" if ok_sh else
        f"Of {s['n']:,} Diamond material-type Shopify variants: {s['no_dw']:,} with diamond weight blank/0, "
        f"{s['no_pcs']:,} with diamond pieces blank/0 ({s['n_styles']:,} styles, e.g. {s['styles']}) — "
        f"the Shopify tab prices these on the ERP weight"))

    return {"date": today.isoformat(), "checked_at": datetime.now(timezone.utc).isoformat(), "checks": checks,
            "passed": sum(1 for c in checks if c["ok"] is True),
            "failed": sum(1 for c in checks if c["ok"] is False),
            "blank": sum(1 for c in checks if c["ok"] is None)}


def latest_snapshot_status():
    bq = _client()
    rows = list(bq.query(f"""
        SELECT snapshot_date, snapshot_created_at, snapshot_status, product_price_rows, variant_level_rows
        FROM `{SNAPSHOT_RUNS_TABLE}`
        WHERE snapshot_status = 'SUCCESS'
        ORDER BY snapshot_created_at DESC
        LIMIT 1
    """).result())
    latest_attempt = list(bq.query(f"""
        SELECT snapshot_date, snapshot_created_at, snapshot_status, error_message
        FROM `{SNAPSHOT_RUNS_TABLE}`
        ORDER BY snapshot_created_at DESC
        LIMIT 1
    """).result())
    out = {"latest_success": None, "latest_attempt": None}
    if rows:
        r = rows[0]
        out["latest_success"] = {
            "snapshot_date": r["snapshot_date"].isoformat(),
            "snapshot_created_at": r["snapshot_created_at"].isoformat(),
            "product_price_rows": r["product_price_rows"], "variant_level_rows": r["variant_level_rows"],
        }
    if latest_attempt:
        r = latest_attempt[0]
        out["latest_attempt"] = {
            "snapshot_date": r["snapshot_date"].isoformat(),
            "snapshot_created_at": r["snapshot_created_at"].isoformat(),
            "snapshot_status": r["snapshot_status"], "error_message": r["error_message"],
        }
    return out


# ══════════════════════════════════════════════════════════════════════
#  Deploy & Refresh Calculations -- ONE button across every editable
#  master table (G2D Making Charges / Diamond Slab / Labour / Cash Back /
#  Item Group Discounts), instead of the 4 separate per-panel Apply flows
#  each running their own refresh_snapshots() pass. Flow:
#    validate every pending change (fail the whole batch before writing
#    anything if any entry is malformed)
#      -> apply each change via the SAME *_update() functions the
#         individual panels already use (each one also invalidates its
#         own in-memory TTL cache -- see the comments in diamond_slab_
#         update / cash_back_rates_update /
#         g2d_config_update)
#      -> ONE refresh_snapshots() rebuild for the whole batch
#      -> spot-check a handful of real SKUs, recomputed live through the
#         EXISTING _build_variant_row/query_variant_page engine, against
#         what the just-published snapshot table actually holds for those
#         same SKUs -- catching a case where the snapshot technically
#         "succeeded" (passed row-count/uniqueness validation) but still
#         doesn't reflect the values that were just deployed
#      -> ONE config_deployments row per deploy, versioned
#         v<YYYY.MM.DD>.<seq>, recording exactly what changed and whether
#         the whole thing is safe to call SUCCESS.
#  No parallel calculation engine: every number here comes from functions
#  that already exist and already back Product Price / Variant Level.
# ══════════════════════════════════════════════════════════════════════
CONFIG_DEPLOYMENTS_TABLE = os.environ.get(
    "CONFIG_DEPLOYMENTS_TABLE", "lucirajewelry-prod.gold_rates.config_deployments")

def _config_dispatch():
    """Built lazily (called per-request, not at import time) since several
    of the *_list/*_update functions it references (g2d_config_list/update
    in particular) are defined further down this file -- a plain
    module-level dict literal here would fail at import with a NameError
    before those names exist yet."""
    return {
        "g2d": {
            "list": g2d_config_list, "key_field": "band_key",
            "update": lambda c: g2d_config_update(
                c["band_key"], making_charge=c.get("making_charge"), dis_pct=c.get("dis_pct"),
                diamond_dis_pct=c.get("diamond_dis_pct")),
            "value_fields": ["making_charge", "dis_pct", "diamond_dis_pct"],
        },
        "diamond_slab": {
            "list": diamond_slab_list, "key_field": "code",
            "update": lambda c: diamond_slab_update(c["code"], c["disc_pct"]),
            "value_fields": ["disc_pct"],
        },
        "cash_back": {
            "list": cash_back_rates_list, "key_field": "rate_key",
            "update": lambda c: cash_back_rates_update(
                c["rate_key"], threshold=c.get("threshold"), cash_back_pct=c.get("cash_back_pct")),
            "value_fields": ["threshold", "cash_back_pct"],
        },
        "item_group_discounts": {
            "list": item_group_discount_list, "key_field": "group_key",
            "update": lambda c: item_group_discount_update(c["group_key"], c["discount_pct"]),
            "value_fields": ["discount_pct"],
        },
    }


def _next_config_version():
    """v<YYYY.MM.DD>.<3-digit-seq>, e.g. v2026.09.17.003 for the 3rd
    deployment made today (IST). The sequence is derived from today's
    existing row count in config_deployments, not a separate counter."""
    now_utc = datetime.now(timezone.utc)
    date_str = (now_utc.astimezone(_IST).date() if _IST else now_utc.date()).strftime("%Y.%m.%d")
    prefix = f"v{date_str}."
    bq = _client()
    rows = list(bq.query(
        f"SELECT COUNT(*) AS n FROM `{CONFIG_DEPLOYMENTS_TABLE}` WHERE version LIKE @prefix",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("prefix", "STRING", prefix + "%"),
        ]),
    ).result())
    seq = (rows[0]["n"] if rows else 0) + 1
    return f"{prefix}{seq:03d}"


def _validate_deployed_snapshot(sample_size=5):
    """Post-deploy safety net (see module docstring above): pick a handful
    of real item_codes already present in the just-published snapshot
    table, recompute them LIVE via query_variant_page (the exact engine
    Variant Level always uses -- every *_update() call just invalidated
    its own cache, so this reads the configuration that was JUST
    deployed), and compare the two. A mismatch means the published
    snapshot doesn't actually reflect the new configuration despite
    refresh_snapshots() reporting SUCCESS."""
    bq = _client()
    try:
        sample_rows = list(bq.query(
            f"SELECT item_code FROM `{VARIANT_SNAPSHOT_TABLE}` ORDER BY RAND() LIMIT {int(sample_size)}"
        ).result())
        sample_codes = [r["item_code"] for r in sample_rows]
        if not sample_codes:
            return "SKIPPED", "snapshot table empty"

        in_list = ", ".join(f"'{c}'" for c in sample_codes)
        snap_rows = {
            r["item_code"]: dict(r.items())
            for r in bq.query(
                f"SELECT * FROM `{VARIANT_SNAPSHOT_TABLE}` WHERE item_code IN ({in_list})"
            ).result()
        }

        check_fields = ["making_charge_per_g", "cp_pr_gm_making", "cash_back_pct",
                         "margin_pct", "final_amount_post_discount", "additional_disc", "margin2_pct",
                         "diamond_disc_pct", "final_after_gst_overall"]
        mismatches = []
        for code in sample_codes:
            live_rows, _ = query_variant_page(code, 1, 5)
            live = next((r for r in live_rows if r["item_code"] == code), None)
            snap = snap_rows.get(code)
            if live is None or snap is None:
                mismatches.append(f"{code}: missing from {'live result' if live is None else 'snapshot'}")
                continue
            for f in check_fields:
                lv, sv = live.get(f), snap.get(f)
                if lv is None and sv is None:
                    continue
                if lv is None or sv is None or abs(float(lv) - float(sv)) > 0.02:
                    mismatches.append(f"{code}.{f}: live={lv} snapshot={sv}")

        if mismatches:
            return "FAILED", "; ".join(mismatches[:10])
        return "PASSED", f"{len(sample_codes)} SKU(s) spot-checked, all matched"
    except Exception as e:
        return "SKIPPED", f"validation error: {e}"


def deploy_config(changes):
    """The single entry point behind 'Deploy & Refresh Calculations' --
    see the module docstring above this section for the full flow."""
    if not changes:
        raise ValueError("no changes to deploy")

    dispatch = _config_dispatch()
    for c in changes:
        table = c.get("table")
        if table not in dispatch:
            raise ValueError(f"unknown config table {table!r}")
        key_field = dispatch[table]["key_field"]
        if not c.get(key_field):
            raise ValueError(f"{table}: missing {key_field}")

    before_by_table = {}
    for table in {c["table"] for c in changes}:
        spec = dispatch[table]
        before_by_table[table] = {r[spec["key_field"]]: r for r in spec["list"]()}

    applied = 0
    try:
        for c in changes:
            dispatch[c["table"]]["update"](c)
            applied += 1
    except Exception as e:
        raise RuntimeError(
            f"failed after applying {applied}/{len(changes)} change(s) -- {e}"
        ) from e

    changed_fields = []
    for table in {c["table"] for c in changes}:
        spec = dispatch[table]
        after_rows = {r[spec["key_field"]]: r for r in spec["list"]()}
        for c in changes:
            if c["table"] != table:
                continue
            key = c[spec["key_field"]]
            before_row = before_by_table[table].get(key, {})
            after_row = after_rows.get(key, {})
            for f in spec["value_fields"]:
                if c.get(f) is not None:
                    changed_fields.append({
                        "table": table, "key": key, "field": f,
                        "before": before_row.get(f), "after": after_row.get(f),
                    })

    version = _next_config_version()
    snap = refresh_snapshots(triggered_by=f"deploy:{version}")

    validation_status, validation_detail = "SKIPPED", None
    if snap["status"] == "SUCCESS":
        validation_status, validation_detail = _validate_deployed_snapshot()

    status = "SUCCESS" if (snap["status"] == "SUCCESS" and validation_status == "PASSED") else "FAILED"
    if snap["status"] != "SUCCESS":
        error_message = snap.get("error")
    elif validation_status != "PASSED":
        error_message = f"post-deploy validation {validation_status.lower()}: {validation_detail}"
    else:
        error_message = None

    deployed_at = datetime.now(timezone.utc).isoformat()
    bq = _client()
    bq.insert_rows_json(CONFIG_DEPLOYMENTS_TABLE, [{
        "version": version,
        "deployed_at": deployed_at,
        "status": status,
        "changed_fields": json.dumps(changed_fields, separators=(",", ":")),
        "product_price_rows": snap.get("product_price_rows"),
        "variant_level_rows": snap.get("variant_level_rows"),
        "duration_sec": snap.get("duration_sec"),
        "validation_status": validation_status,
        "validation_detail": validation_detail,
        "error_message": error_message,
    }])

    return {
        "version": version, "status": status, "deployed_at": deployed_at,
        "changed_fields": changed_fields,
        "product_price_rows": snap.get("product_price_rows"),
        "variant_level_rows": snap.get("variant_level_rows"),
        "duration_sec": snap.get("duration_sec"),
        "validation_status": validation_status, "validation_detail": validation_detail,
        "error_message": error_message,
    }


def deploy_slab_excel():
    """'Deploy to Dashboard' on the Slab Excel Table: re-read the slab, rebuild
    every published dataset with it (Ornaverse BOM / Variant / Product Default,
    Shopify, Inventory -- refresh_snapshots), spot-check, and log one
    config_deployments row (so Daily Check shows it)."""
    import json
    _SLAB_CACHE["ts"] = 0.0
    _COIN_CP_CACHE["ts"] = 0.0; _COIN_CP_CACHE["data"] = {}
    rules = fetch_slab_rules()
    version = _next_config_version()
    snap = refresh_snapshots(triggered_by=f"slab_deploy:{version}")
    validation_status, validation_detail = "SKIPPED", None
    if snap["status"] == "SUCCESS":
        validation_status, validation_detail = _validate_deployed_snapshot()
    status = "SUCCESS" if (snap["status"] == "SUCCESS" and validation_status == "PASSED") else "FAILED"
    error_message = (snap.get("error") if snap["status"] != "SUCCESS"
                     else (None if validation_status == "PASSED" else f"post-deploy validation {validation_status.lower()}: {validation_detail}"))
    summary = {}
    try:
        r = list(_client().query(f"""
            SELECT COUNTIF(slab_status LIKE 'Slab applied%') AS applied,
                   COUNTIF(slab_status LIKE '%kept existing%') AS kept_existing,
                   COUNTIF(slab_status = 'No slab match') AS no_match,
                   COUNTIF(slab_status LIKE '%Error%') AS errors,
                   COUNTIF(free_gold_coin IS NOT NULL) AS with_coin, COUNT(*) AS total
            FROM `{VARIANT_SNAPSHOT_TABLE}`""").result())[0]
        summary = dict(r.items())
    except Exception as e:
        summary = {"error": str(e)}
    deployed_at = datetime.now(timezone.utc).isoformat()
    changed = [{"table": "slab_excel", "key": "slab rows", "field": "rows", "before": None, "after": len(rules)}]
    _client().insert_rows_json(CONFIG_DEPLOYMENTS_TABLE, [{
        "version": version, "deployed_at": deployed_at, "status": status,
        "changed_fields": json.dumps(changed, separators=(",", ":")),
        "product_price_rows": snap.get("product_price_rows"), "variant_level_rows": snap.get("variant_level_rows"),
        "duration_sec": snap.get("duration_sec"), "validation_status": validation_status,
        "validation_detail": validation_detail, "error_message": error_message,
    }])
    return {"version": version, "status": status, "deployed_at": deployed_at, "slab_rows": len(rules),
            "summary": summary, "duration_sec": snap.get("duration_sec"),
            "validation_status": validation_status, "validation_detail": validation_detail, "error_message": error_message}


def list_config_deployments(limit=20):
    bq = _client()
    rows = list(bq.query(
        f"SELECT version, deployed_at, status, changed_fields, product_price_rows, "
        f"variant_level_rows, duration_sec, validation_status, validation_detail, error_message "
        f"FROM `{CONFIG_DEPLOYMENTS_TABLE}` ORDER BY deployed_at DESC LIMIT {int(limit)}"
    ).result())
    out = []
    for r in rows:
        out.append({
            "version": r["version"],
            "deployed_at": r["deployed_at"].isoformat() if r["deployed_at"] else None,
            "status": r["status"],
            "changed_fields": json.loads(r["changed_fields"]) if r["changed_fields"] else [],
            "product_price_rows": r["product_price_rows"], "variant_level_rows": r["variant_level_rows"],
            "duration_sec": r["duration_sec"], "validation_status": r["validation_status"],
            "validation_detail": r["validation_detail"], "error_message": r["error_message"],
        })
    return out


# ══════════════════════════════════════════════════════════════════════
#  MTO Margin (GET /mto-margin) -- every MTO + Online_MTO order line booked
#  in marketing_sale (cancel_order lines never count), costed on the day it
#  was punched. CP = the Ornaverse Variant calculation (_calc_on_weights) on
#  the order line's own net / diamond weight + karat, with THAT DAY's gold
#  rate (Pos.metal_rates, newest from_date <= order date) instead of today's;
#  diamond / gemstone / labour CP use the current rate cards (no history is
#  kept for those). SP = the MTO order rate as booked: net_sale, which is
#  GST-INCLUSIVE in marketing_sale (tax_amount = net_sale - net_sale/1.03 on
#  441/463 MTO lines; Online_MTO tax is the GST inside net_sale + discount),
#  so it compares like-for-like with the GST-inclusive Total CP:
#    Margin 1%  = (Gross - CP) / Gross,  Gross = net_sale + discount + additional_discount
#    Margin 2%  = (net_sale - CP) / net_sale
#    Final Margin % = (Actual SP - CP) / Actual SP,  Actual SP = net_sale - free coin value
#  Free coin = the Slab Excel rule on the order's ex-GST amount (same as the
#  Variant tab), except in an order that already bills a gold coin line
#  (LJ-GC...) -- that coin is costed on its own line instead. A line whose
#  calculation has no metal value or no diamond CP keeps its CP blank (never
#  a fake-high margin) and says why in cp_basis.
# ══════════════════════════════════════════════════════════════════════
MARKETING_SALE_TABLE = os.environ.get(
    "MARKETING_SALE_TABLE", "lucirajewelry-prod.ds_imputed_reporting.marketing_sale")
MTO_FULFILLMENTS = ("MTO", "Online_MTO")
MTO_MARGIN_BLOB = f"{SNAPSHOT_GCS_PREFIX}/mto_margin.json.gz"
MTO_MARGIN_MAX_AGE_SEC = 1800
# Pos.metal_rates has no Gold row between 2025-06-27 and Oct 2025, so an order
# whose newest Pos rate is older than this falls back to the old
# gold_rates.daily_gold_prices table (same per-10g 999 convention) for its day.
DAILY_GOLD_PRICES_TABLE = os.environ.get("DAILY_GOLD_PRICES_TABLE", "lucirajewelry-prod.gold_rates.daily_gold_prices")
MTO_RATE_MAX_GAP_DAYS = 3


def gold_rate_history():
    """[(date, 24K rate per gram)] ascending -- one row per from_date, the same
    'Gold' row (and same-day tie-break) todays_gold_rates() reads."""
    bq = _client()
    rows = bq.query(f"""
        SELECT DATE(a.from_date) AS d, a.sales_rate * 10 AS rate10
        FROM `{METAL_RATES_TABLE}` a LEFT JOIN `{ITEM_GROUPS_TABLE}` b ON a.metal_type_id = b.item_group_id
        WHERE b.item_group_name = 'Gold' AND a.sales_rate IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY DATE(a.from_date) ORDER BY a.from_date DESC, a.rate_id DESC) = 1
        ORDER BY d""").result()
    return [(r["d"], float(r["rate10"]) / 10.0) for r in rows]


def daily_gold_price_history():
    """[(date, 24K rate per gram)] ascending from the old daily_gold_prices table
    (STRING columns, some dates repeated -> the day's highest)."""
    bq = _client()
    rows = bq.query(f"""
        SELECT SAFE.PARSE_DATE('%Y-%m-%d', date) AS d, MAX(SAFE_CAST(gold_999_price AS FLOAT64)) AS rate10
        FROM `{DAILY_GOLD_PRICES_TABLE}` GROUP BY d
        HAVING d IS NOT NULL AND rate10 IS NOT NULL ORDER BY d""").result()
    return [(r["d"], float(r["rate10"]) / 10.0) for r in rows]


def _rate_on(hist, day):
    """Newest (date, rate) in an ascending history on or before `day`, else (None, None)."""
    import bisect
    i = bisect.bisect_right([h[0] for h in hist], day) - 1
    return hist[i] if i >= 0 else (None, None)


def mto_margin_rows():
    from decimal import Decimal
    bq = _client()
    fulfil_sql = ", ".join(f"'{f}'" for f in MTO_FULFILLMENTS)
    raw = list(bq.query(f"""
        SELECT m.Transaction_Date AS order_date, m.Fullfillment AS order_type, m.document_no,
               CAST(m.item_line_no AS STRING) AS item_line_no,
               m.company_code, m.Channel AS channel, m.Full_sku AS item_code, m.Product_Title AS product_name,
               m.item_group_name, m.type_name AS category, m.karat_name, m.metal_color_name,
               m.pieces, m.net_weight, m.diamond_weight, m.discount, m.additional_discount, m.net_sale
        FROM `{MARKETING_SALE_TABLE}` m
        WHERE m.Fullfillment IN ({fulfil_sql})
          -- a line also booked as cancel_order never counts, whatever its own Fullfillment says
          AND NOT EXISTS (SELECT 1 FROM `{MARKETING_SALE_TABLE}` c
                          WHERE c.Fullfillment = 'cancel_order'
                            AND c.document_no = m.document_no AND c.Full_sku = m.Full_sku)
        ORDER BY m.Transaction_Date DESC, m.document_no, m.item_line_no
    """).result())
    hist, old_hist = gold_rate_history(), daily_gold_price_history()
    ctx = _calc_context(sorted({r["item_code"] for r in raw if r["item_code"]}))
    coin_docs = {r["document_no"] for r in raw if _is_gold_coin(r["item_code"])}
    num = lambda v: float(v) if isinstance(v, Decimal) else v
    out = []
    for r in raw:
        d = {k: num(v) for k, v in dict(r).items()}
        code, pcs = d["item_code"], int(d.get("pieces") or 0) or 1
        basis = []
        rate_date, r24 = _rate_on(hist, d["order_date"])
        if rate_date is None or (d["order_date"] - rate_date).days > MTO_RATE_MAX_GAP_DAYS:
            old_date, old_r24 = _rate_on(old_hist, d["order_date"])
            if old_date and (rate_date is None or old_date > rate_date):
                rate_date, r24 = old_date, old_r24
                basis.append("gold rate from daily_gold_prices (no Pos rate that week)")
        if r24:
            gold = {kt: round(r24 * mult, 2) for kt, mult in KARAT_PURITY.items()}
        else:
            gold = ctx["gold"]
            basis.append("no gold rate on/before order date -> today's")
        nw = (d["net_weight"] / pcs) if d.get("net_weight") else None
        dw = (d["diamond_weight"] / pcs) if d.get("diamond_weight") is not None else None
        # 0 diamond weight on an item ERP says has diamonds = not captured -> ERP weight
        if dw is not None and dw <= 0 and float((ctx["item_by_code"].get(code) or {}).get("diamond_weight") or 0) > 0:
            dw = None
        row, info = _calc_on_weights(code, {**ctx, "gold": gold}, nw, dw, d.get("karat_name"))
        basis += info["basis"]
        kt = _karat_from_purity(d.get("karat_name"), code)
        if row is not None and not (kt and gold.get(kt) is not None):
            basis.append("metal at today's rate (not gold)")
        net = d.get("net_sale") or 0.0
        disc = (d.get("discount") or 0.0) + (d.get("additional_discount") or 0.0)
        gross = net + disc
        rec = {
            "order_date": d["order_date"].isoformat() if d["order_date"] else None,
            "order_month": d["order_date"].strftime("%Y-%m") if d["order_date"] else None,
            "order_type": d["order_type"], "document_no": d["document_no"], "item_line_no": d["item_line_no"],
            "company_code": d["company_code"],
            "channel": d["channel"], "item_code": code, "product_name": d["product_name"],
            "item_group_name": d["item_group_name"], "category": d["category"], "karat_name": d["karat_name"],
            "metal_color_name": d["metal_color_name"], "pieces": pcs, "net_weight": d["net_weight"],
            "diamond_weight": d["diamond_weight"],
            "gold_rate_date": rate_date.isoformat() if rate_date else None,
            "gold_rate_24k": round(r24, 2) if r24 else None,
            "karat_rate": gold.get(kt) if kt else None,
            "gross_amount": round(gross, 2), "discount": round(disc, 2), "net_sale": round(net, 2),
            "order_ex_gst": round(net / (1.0 + GST_RATE), 2),
        }
        if row is None:
            rec["cp_basis"] = ", ".join(basis) or "Not priced"
            out.append(rec)
            continue
        dash = (row.get("final_after_gst_overall") or 0) * pcs
        rec.update({
            "metal_value": round(row["metal_amount"] * pcs, 2),
            "diamond_cp": round((row.get("total_diamond_cp") or 0.0) * pcs, 2),
            "gemstone_cp": round((row.get("gemstone_cp") or 0.0) * pcs, 2),
            "labour_cp": round((row.get("cp_pr_gm_making") or 0.0) * pcs, 2),
            "dashboard_price": round(dash, 2),
            "price_vs_dashboard_pct": round((net - dash) / dash * 100.0, 2) if dash else None,
        })
        missing = []
        if not (row["metal_amount"] or 0) > 0:
            missing.append("no metal value" if (row.get("net_weight") or 0) > 0 else "no metal weight")
        if float(row.get("diamond_weight") or 0) > 0 and not (row.get("total_diamond_cp") or 0) > 0:
            missing.append("no diamond CP")
        if missing:
            rec["cp_basis"] = ", ".join(basis + [f"CP incomplete: {' & '.join(missing)}"])
            out.append(rec)
            continue
        cp = row["total_cp_cost"] * pcs
        coin_qty, coin_value = 0, 0.0
        if d["document_no"] in coin_docs:
            basis.append("coin billed in order")
        else:
            _, coin_rows, _, _ = slab_match(row.get("category"), row.get("material_type"), row.get("g2d"))
            _, q, v, _ = _free_coin_for(coin_rows, net / pcs / (1.0 + GST_RATE))
            coin_qty, coin_value = (q or 0) * pcs, (v or 0.0) * pcs
        actual_sp = net - coin_value
        rec.update({
            "total_cp": round(cp, 2),
            "margin1_pct": round((gross - cp) / gross * 100.0, 2) if gross else None,
            "margin2_amount": round(net - cp, 2),
            "margin2_pct": round((net - cp) / net * 100.0, 2) if net else None,
            "free_coin_qty": coin_qty or None, "free_coin_value": round(coin_value, 2) if coin_value else None,
            "actual_sp": round(actual_sp, 2),
            "final_margin": round(actual_sp - cp, 2),
            "final_margin_pct": round((actual_sp - cp) / actual_sp * 100.0, 2) if actual_sp else None,
            "cp_basis": ", ".join(basis) or "Order weights",
        })
        out.append(rec)
    return out


MTO_MARGIN_COLUMNS = [
    "order_date", "order_month", "order_type", "document_no", "item_line_no", "company_code", "channel", "item_code",
    "product_name", "item_group_name", "category", "karat_name", "metal_color_name", "pieces", "net_weight",
    "diamond_weight", "gold_rate_date", "gold_rate_24k", "karat_rate", "metal_value", "diamond_cp",
    "gemstone_cp", "labour_cp", "total_cp", "gross_amount", "discount", "net_sale", "order_ex_gst",
    "dashboard_price", "price_vs_dashboard_pct", "margin1_pct", "margin2_amount", "margin2_pct", "free_coin_qty", "free_coin_value",
    "extra_discount", "actual_sp", "final_margin", "final_margin_pct", "cp_basis",
]


def mto_margin_snapshot(force=False):
    """Column-wise gzip blob of mto_margin_rows(), same shape/caching as
    inventory_full_snapshot (rebuilt when older than MTO_MARGIN_MAX_AGE_SEC)."""
    import json
    bucket = _gcs_client().bucket(SNAPSHOT_GCS_BUCKET)
    blob = bucket.blob(MTO_MARGIN_BLOB)
    if not force and blob.exists():
        blob.reload()
        age = (datetime.now(timezone.utc) - blob.updated).total_seconds() if blob.updated else 1e9
        meta = blob.metadata or {}
        if age < MTO_MARGIN_MAX_AGE_SEC and meta.get("snapshot"):
            return {"snapshot_url": f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{MTO_MARGIN_BLOB}",
                    "snapshot": json.loads(meta["snapshot"])}
    rows = mto_margin_rows()
    snap = {"snapshot_created_at": datetime.now(timezone.utc).isoformat(), "rows": len(rows),
            "orders": len({r["document_no"] for r in rows})}
    payload = {"columns": MTO_MARGIN_COLUMNS, "data": [[r.get(c) for c in MTO_MARGIN_COLUMNS] for r in rows],
               "snapshot": snap}
    gz = gzip.compress(json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8"), compresslevel=6)
    blob.content_encoding = "gzip"
    blob.metadata = {"snapshot": json.dumps(snap, separators=(",", ":"))}
    blob.upload_from_string(gz, content_type="application/json")
    return {"snapshot_url": f"https://storage.googleapis.com/{SNAPSHOT_GCS_BUCKET}/{MTO_MARGIN_BLOB}", "snapshot": snap}


def query_snapshot_rows(table_fqn):
    """Fast read of a materialized daily snapshot -- no joins, no
    aggregation, just the already-computed rows back out, in the original
    build order (see _load_snapshot_table). This is what /?full=1 and
    /variant-level?full=1 call now instead of rebuilding the dataset on
    every request."""
    # No per-cell Decimal/Timestamp coercion needed here (unlike the live
    # query paths elsewhere in this file) -- every snapshot column is
    # explicitly typed STRING/FLOAT64/INTEGER (see PRODUCT_PRICE_SNAPSHOT_
    # SCHEMA / VARIANT_SNAPSHOT_SCHEMA), so the BigQuery client already
    # hands back plain JSON-safe str/float/int/None. Skipping that loop
    # over ~370K rows x ~35 columns is a real chunk of the "make full=1
    # fast" win, not just the snapshot itself.
    bq = _client()
    sql = f"SELECT * EXCEPT(_snapshot_seq) FROM `{table_fqn}` ORDER BY _snapshot_seq"
    return [dict(r) for r in bq.query(sql).result(page_size=10000)]


def stream_csv_rows(q):
    gold_rates = todays_gold_rates()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([CSV_LABELS[c] for c in CSV_COLUMNS])
    yield buf.getvalue()
    buf.seek(0); buf.truncate(0)

    for row in query_all_rows(q):
        d = dict(row)
        line = []
        for c in CSV_COLUMNS:
            if c == "metal_amount":
                v = merged_amount(d, gold_rates)
            elif c == "Saleing_price":
                v = selling_price(d, gold_rates)
            elif c == "overall_selling_price":
                v = overall_selling_price(d, gold_rates)
            else:
                v = d.get(c)
            if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                v = float(v)
            line.append("" if v is None else v)
        writer.writerow(line)
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)


def g2d_config_list():
    bq = _client()
    rows = bq.query(
        f"SELECT band_key, sort_order, g2d_range, g2d_band, making_charge, dis_pct, "
        f"COALESCE(diamond_dis_pct, 0) AS diamond_dis_pct, updated_at "
        f"FROM `{MAKING_CHARGES_TABLE}` ORDER BY sort_order"
    ).result()
    out = []
    for r in rows:
        out.append({
            "band_key": r["band_key"], "sort_order": int(r["sort_order"]),
            "g2d_range": r["g2d_range"], "g2d_band": r["g2d_band"],
            "making_charge": float(r["making_charge"]), "dis_pct": float(r["dis_pct"]),
            # Display/record only for now -- not read by any price calculation.
            "diamond_dis_pct": float(r["diamond_dis_pct"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })
    return out


def g2d_config_update(band_key, making_charge=None, dis_pct=None, diamond_dis_pct=None):
    valid_keys = {band for band, _, _ in MAKING_CHARGE_BANDS}
    if band_key not in valid_keys:
        raise ValueError(f"unknown band_key {band_key!r}")
    if making_charge is None and dis_pct is None and diamond_dis_pct is None:
        raise ValueError("nothing to update -- provide making_charge, dis_pct and/or diamond_dis_pct")
    set_parts = ["updated_at = CURRENT_TIMESTAMP()"]
    params = [bigquery.ScalarQueryParameter("band_key", "STRING", band_key)]
    if making_charge is not None:
        if not (making_charge > 0):
            raise ValueError("making_charge must be a positive number")
        set_parts.append("making_charge = @mc")
        params.append(bigquery.ScalarQueryParameter("mc", "FLOAT64", making_charge))
    if dis_pct is not None:
        if not (0 <= dis_pct <= 100):
            raise ValueError("dis_pct must be between 0 and 100")
        set_parts.append("dis_pct = @dp")
        params.append(bigquery.ScalarQueryParameter("dp", "FLOAT64", dis_pct))
    if diamond_dis_pct is not None:
        if not (0 <= diamond_dis_pct <= 100):
            raise ValueError("diamond_dis_pct must be between 0 and 100")
        set_parts.append("diamond_dis_pct = @ddp")
        params.append(bigquery.ScalarQueryParameter("ddp", "FLOAT64", diamond_dis_pct))
    bq = _client()
    bq.query(
        f"UPDATE `{MAKING_CHARGES_TABLE}` SET {', '.join(set_parts)} WHERE band_key = @band_key",
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    # Invalidate the 60s TTL cache immediately -- see the matching comment in
    # diamond_slab_update. fetch_g2d_bands() (used by the bulk snapshot
    # pipeline and the targeted-search fast path) reads this SAME table
    # through a SEPARATE cache from fetch_making_charge_rates() (uncached,
    # used by the Product Price path) -- both must stay in sync with what
    # was just written.
    _G2D_BANDS_CACHE["ts"] = 0.0
    _G2D_BANDS_CACHE["data"] = {}
    return g2d_config_list()


# MTO Extra Discount (user, 2026-10-30): a discount given to the customer on
# top of the booked order rate, typed in per order line on the MTO tab by an
# editor. It comes off the sale price before Final Margin only (Actual SP =
# Order Rate - free coin - extra discount); Margin 1 / 2 are untouched. Kept in
# its own small table keyed by document_no + item_line_no (unique per MTO line)
# and read live by the tab, so an edit shows at once -- the 30-min margin blob
# is never rebuilt for it. DML only (no streaming inserts), so a value can be
# changed or cleared right after it was saved.
MTO_EXTRA_DISCOUNT_TABLE = os.environ.get(
    "MTO_EXTRA_DISCOUNT_TABLE", "lucirajewelry-prod.gold_rates.mto_extra_discounts")


def _ensure_mto_extra_discount_table():
    _client().query(f"""
        CREATE TABLE IF NOT EXISTS `{MTO_EXTRA_DISCOUNT_TABLE}` (
          document_no STRING, item_line_no STRING, item_code STRING, extra_discount FLOAT64,
          updated_by STRING, updated_at TIMESTAMP)""").result()


def mto_extra_discount_list():
    """{"document_no|item_line_no": {"amount", "by", "at"}}"""
    from google.api_core.exceptions import NotFound
    try:
        rows = _client().query(
            f"SELECT document_no, item_line_no, extra_discount, updated_by, updated_at FROM `{MTO_EXTRA_DISCOUNT_TABLE}`"
        ).result()
    except NotFound:
        return {}
    return {f"{r['document_no']}|{r['item_line_no']}": {
                "amount": float(r["extra_discount"]), "by": r["updated_by"],
                "at": r["updated_at"].isoformat() if r["updated_at"] else None} for r in rows}


def mto_extra_discount_set(document_no, item_line_no, item_code, amount, editor):
    """Save (amount > 0) or clear (blank / 0) one line's extra discount."""
    document_no, item_line_no = str(document_no or "").strip(), str(item_line_no or "").strip()
    if not document_no or not item_line_no:
        raise ValueError("document_no and item_line_no are required")
    if amount is not None and (not math.isfinite(amount) or amount < 0):
        raise ValueError("extra_discount must be a number of 0 or more")
    _ensure_mto_extra_discount_table()
    params = [bigquery.ScalarQueryParameter("doc", "STRING", document_no),
              bigquery.ScalarQueryParameter("line", "STRING", item_line_no)]
    if not amount:
        sql = f"DELETE FROM `{MTO_EXTRA_DISCOUNT_TABLE}` WHERE document_no = @doc AND item_line_no = @line"
    else:
        sql = f"""
            MERGE `{MTO_EXTRA_DISCOUNT_TABLE}` t
            USING (SELECT @doc AS document_no, @line AS item_line_no) s
            ON t.document_no = s.document_no AND t.item_line_no = s.item_line_no
            WHEN MATCHED THEN UPDATE SET extra_discount = @amt, item_code = @code, updated_by = @by,
                                         updated_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (document_no, item_line_no, item_code, extra_discount, updated_by, updated_at)
              VALUES (@doc, @line, @code, @amt, @by, CURRENT_TIMESTAMP())"""
        params += [bigquery.ScalarQueryParameter("amt", "FLOAT64", round(float(amount), 2)),
                   bigquery.ScalarQueryParameter("code", "STRING", str(item_code or "")),
                   bigquery.ScalarQueryParameter("by", "STRING", editor)]
    _client().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return {"key": f"{document_no}|{item_line_no}", "amount": round(float(amount), 2) if amount else None, "by": editor}


# ══════════════════════════════════════════════════════════════════════
#  Editor access (user, 2026-10-30): only EDITOR_EMAILS may change anything
#  -- every slab / rate-card write and the MTO extra discount; everyone
#  else who can open the dashboard is view-only. An editor signs in with
#  their email + their own password (EDITOR_PASSWORDS env,
#  "email=password;email=password") at POST /editor-login and gets a signed
#  token (HMAC-SHA256, key derived from EDIT_SECRET, else REFRESH_TOKEN),
#  valid EDITOR_TOKEN_TTL_SEC, which the page sends as X-Edit-Token on every
#  write. Every POST/PUT/DELETE to an EDIT_PATHS endpoint without a valid
#  token is refused (403) -- the API itself is public, so the check lives
#  here, not only in the page. Dropping an email from EDITOR_EMAILS revokes
#  it at once, even for a token already issued.
# ══════════════════════════════════════════════════════════════════════
EDITOR_EMAILS = tuple(e.strip().lower() for e in os.environ.get(
    "EDITOR_EMAILS", "data@lucirajewelry.com,data.cat@lucirajewelry.com,tech@lucirajewelry.com").split(",") if e.strip())
EDITOR_TOKEN_TTL_SEC = int(os.environ.get("EDITOR_TOKEN_TTL_SEC", str(12 * 3600)))
EDIT_PATHS = ("/config-deploy", "/g2d-config", "/item-group-discounts", "/slab-excel", "/slab-excel/deploy",
              "/diamond-slab-config", "/cash-back-config", "/mto-extra-discount")


def _edit_key():
    secret = os.environ.get("EDIT_SECRET") or REFRESH_TOKEN
    return hashlib.sha256(f"pp-editor:{secret}".encode()).digest() if secret else None


def _editor_passwords():
    out = {}
    for part in os.environ.get("EDITOR_PASSWORDS", "").split(";"):
        email, sep, pw = part.partition("=")
        email = email.strip().lower()
        if sep and pw and email in EDITOR_EMAILS:
            out[email] = pw
    return out


def issue_editor_token(email, password):
    email = str(email or "").strip().lower()
    key, pw = _edit_key(), _editor_passwords().get(email)
    if not (key and pw and hmac.compare_digest(pw.encode(), str(password or "").encode())):
        time.sleep(1)  # slows password guessing
        return None
    exp = int(time.time()) + EDITOR_TOKEN_TTL_SEC
    sig = hmac.new(key, f"{email}|{exp}".encode(), hashlib.sha256).hexdigest()
    return {"token": base64.urlsafe_b64encode(f"{email}|{exp}|{sig}".encode()).decode(), "email": email, "expires": exp}


def editor_from_token(token):
    """The editor's email for a valid, unexpired token, else None."""
    try:
        email, exp, sig = base64.urlsafe_b64decode(str(token or "").encode()).decode().split("|")
        exp = int(exp)
    except Exception:
        return None
    key = _edit_key()
    if not key or exp < time.time() or email not in EDITOR_EMAILS:
        return None
    good = hmac.new(key, f"{email}|{exp}".encode(), hashlib.sha256).hexdigest()
    return email if hmac.compare_digest(good, sig) else None


@functions_framework.http
def pos_price(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
    import json  # local, like every handler below (they make `json` a local name here)
    path = (request.path or "/").rstrip("/")
    if path.endswith("/editor-login"):
        if request.method != "POST":
            return (json.dumps({"error": "use POST"}), 405, CORS)
        body = request.get_json(force=True, silent=True) or {}
        tok = issue_editor_token(body.get("email"), body.get("password"))
        if not tok:
            return (json.dumps({"error": "Wrong email or password, or this email has no edit access."}), 401, CORS)
        print(f"[editor] login {tok['email']}")
        return (json.dumps(tok), 200, CORS)
    if path.endswith("/editor-check"):
        email = editor_from_token(request.headers.get("X-Edit-Token"))
        return (json.dumps({"email": email, "can_edit": bool(email), "editors": list(EDITOR_EMAILS)}), 200, CORS)
    editor = None
    if request.method in ("POST", "PUT", "DELETE") and path.endswith(EDIT_PATHS):
        editor = editor_from_token(request.headers.get("X-Edit-Token"))
        if not editor:
            return (json.dumps({"error": "View only — editor login required. Only " + ", ".join(EDITOR_EMAILS)
                                + " can make changes."}), 403, CORS)
        print(f"[editor] {editor} {request.method} {path}")
    if path.endswith("/mto-extra-discounts"):
        try:
            return (json.dumps({"rows": mto_extra_discount_list()}, separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if path.endswith("/mto-extra-discount"):
        if request.method != "POST":
            return (json.dumps({"error": "use POST"}), 405, CORS)
        try:
            body = request.get_json(force=True, silent=True) or {}
            amt = body.get("extra_discount")
            amt = float(amt) if amt not in (None, "") else None
            return (json.dumps(mto_extra_discount_set(body.get("document_no"), body.get("item_line_no"),
                                                      body.get("item_code"), amt, editor)), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/refresh-snapshot"):
        # Cloud Scheduler -> here, once a day at 12:01 PM IST (see deploy.sh
        # / the scheduler job created alongside this service). This is the
        # ONLY place the expensive full-dataset pipeline runs; every normal
        # dashboard load reads the snapshot this writes (query_snapshot_rows)
        # and never triggers this itself.
        import json
        if request.method != "POST":
            return (json.dumps({"error": "method not allowed -- POST only"}), 405, CORS)
        if not REFRESH_TOKEN:
            return (json.dumps({"error": "REFRESH_TOKEN not configured -- refusing to run"}), 500, CORS)
        if request.headers.get("X-Refresh-Token") != REFRESH_TOKEN:
            return (json.dumps({"error": "unauthorized"}), 401, CORS)
        try:
            result = refresh_snapshots(triggered_by="scheduler")
            code = 200 if result["status"] == "SUCCESS" else 500
            return (json.dumps(result, separators=(",", ":")), code, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/variant-level-history-snapshot"):
        # Daily archive job (Cloud Scheduler, 12:30 PM IST -- separate job
        # from pricing-snapshot-refresh's 12:01 PM, giving that one time to
        # finish first) -- appends TODAY's Variant Level into the ONE
        # growing variant_level_daily_history table. Never touches the
        # dashboard-facing snapshot tables/blobs; see append_variant_level_
        # history's docstring for the idempotent MERGE this runs.
        import json
        if request.method != "POST":
            return (json.dumps({"error": "method not allowed -- POST only"}), 405, CORS)
        if not REFRESH_TOKEN:
            return (json.dumps({"error": "REFRESH_TOKEN not configured -- refusing to run"}), 500, CORS)
        if request.headers.get("X-Refresh-Token") != REFRESH_TOKEN:
            return (json.dumps({"error": "unauthorized"}), 401, CORS)
        try:
            result = append_variant_level_history()
            return (json.dumps(result, separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/snapshot-status"):
        import json
        try:
            return (json.dumps(latest_snapshot_status(), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/mto-margin"):
        import json
        try:
            force = (request.args.get("refresh") or "").strip().lower() in ("1", "true", "yes")
            return (json.dumps(mto_margin_snapshot(force=force), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/config-deploy"):
        # "Deploy & Refresh Calculations" -- ONE endpoint across every
        # editable master table. GET returns recent deployment history
        # (for the dashboard's "Last deployed: v... at ..." badge); POST
        # applies a batch of pending changes as one deployment (see
        # deploy_config's docstring for the full flow). This call runs
        # synchronously for the whole rebuild+validate pipeline (same
        # ~3-4 min as the per-panel Apply already did) rather than a
        # separate async job queue -- the Cloud Function's own 1800s
        # timeout comfortably covers it, and a browser fetch() (unlike a
        # short-timeout CLI client) simply waits for the response.
        import json
        try:
            if request.method == "GET":
                return (json.dumps({"deployments": list_config_deployments()}, separators=(",", ":")), 200, CORS)
            if request.method == "POST":
                body = request.get_json(force=True, silent=True) or {}
                result = deploy_config(body.get("changes") or [])
                code = 200 if result["status"] == "SUCCESS" else 500
                return (json.dumps(result, separators=(",", ":")), code, CORS)
            return (json.dumps({"error": "method not allowed"}), 405, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/g2d-config"):
        import json
        try:
            if request.method == "GET":
                return (json.dumps({"rows": g2d_config_list()}, separators=(",", ":")), 200, CORS)
            if request.method in ("POST", "PUT"):
                body = request.get_json(force=True, silent=True) or {}
                mc = body.get("making_charge")
                dp = body.get("dis_pct")
                ddp = body.get("diamond_dis_pct")
                rows = g2d_config_update(
                    str(body.get("band_key") or "").strip(),
                    making_charge=(float(mc) if mc is not None else None),
                    dis_pct=(float(dp) if dp is not None else None),
                    diamond_dis_pct=(float(ddp) if ddp is not None else None),
                )
                snapshot_refreshed = (_safe_refresh_snapshots("config_edit:g2d")
                                     if (body.get("refresh", True)) else None)
                return (json.dumps({"rows": rows, "snapshot_refreshed": snapshot_refreshed},
                                    separators=(",", ":")), 200, CORS)
            return (json.dumps({"error": "method not allowed"}), 405, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/item-group-discounts"):
        import json
        try:
            if request.method == "GET":
                return (json.dumps({"rows": item_group_discount_list()}, separators=(",", ":")), 200, CORS)
            if request.method in ("POST", "PUT"):
                body = request.get_json(force=True, silent=True) or {}
                rows = item_group_discount_update(str(body.get("group_key") or "").strip(), float(body.get("discount_pct")))
                snapshot_refreshed = (_safe_refresh_snapshots("config_edit:item_group_discounts")
                                     if (body.get("refresh", True)) else None)
                return (json.dumps({"rows": rows, "snapshot_refreshed": snapshot_refreshed},
                                    separators=(",", ":")), 200, CORS)
            return (json.dumps({"error": "method not allowed"}), 405, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/labour-rate-slab"):
        import json
        try:
            return (json.dumps({"rows": labour_rate_slab_list()}, separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/slab-excel/deploy"):
        import json
        try:
            if request.method not in ("POST", "PUT"):
                return (json.dumps({"error": "use POST"}), 405, CORS)
            return (json.dumps(deploy_slab_excel(), separators=(",", ":"), default=str), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/slab-excel"):
        import json
        try:
            if request.method == "GET":
                return (json.dumps(slab_excel_list(), separators=(",", ":"), default=str), 200, CORS)
            if request.method in ("POST", "PUT"):
                body = request.get_json(force=True, silent=True) or {}
                return (json.dumps(slab_excel_replace(body.get("rows")), separators=(",", ":"), default=str), 200, CORS)
            return (json.dumps({"error": "method not allowed"}), 405, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/inventory-full"):
        import json
        try:
            force = (request.args.get("refresh") or "").strip().lower() in ("1", "true", "yes")
            return (json.dumps(inventory_full_snapshot(force=force), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/company-inventory"):
        import json
        try:
            return (json.dumps(company_inventory_rows(), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/shopify"):
        import json
        try:
            force = (request.args.get("refresh") or "").strip().lower() in ("1", "true", "yes")
            return (json.dumps(shopify_snapshot(force=force), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/gold-rate-strip"):
        import json
        try:
            return (json.dumps(gold_rate_strip(), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/health-check"):
        import json
        try:
            return (json.dumps(health_check(), separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.path or "/").rstrip("/").endswith("/stone-rate-slab"):
        import json
        try:
            return (json.dumps({"rows": stone_rate_slab_list()}, separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/diamond-slab-config"):
        import json
        try:
            if request.method == "GET":
                return (json.dumps({"rows": diamond_slab_list()}, separators=(",", ":")), 200, CORS)
            if request.method in ("POST", "PUT"):
                body = request.get_json(force=True, silent=True) or {}
                rows = diamond_slab_update(str(body.get("code") or "").strip(), float(body.get("disc_pct")))
                snapshot_refreshed = (_safe_refresh_snapshots("config_edit:diamond_slab")
                                     if (body.get("refresh", True)) else None)
                return (json.dumps({"rows": rows, "snapshot_refreshed": snapshot_refreshed},
                                    separators=(",", ":")), 200, CORS)
            return (json.dumps({"error": "method not allowed"}), 405, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/cash-back-config"):
        import json
        try:
            if request.method == "GET":
                return (json.dumps({"rows": cash_back_rates_list()}, separators=(",", ":")), 200, CORS)
            if request.method in ("POST", "PUT"):
                body = request.get_json(force=True, silent=True) or {}
                th = body.get("threshold")
                cb = body.get("cash_back_pct")
                rows = cash_back_rates_update(
                    str(body.get("rate_key") or "").strip(),
                    threshold=(float(th) if th is not None else None),
                    cash_back_pct=(float(cb) if cb is not None else None),
                )
                snapshot_refreshed = (_safe_refresh_snapshots("config_edit:cash_back")
                                     if (body.get("refresh", True)) else None)
                return (json.dumps({"rows": rows, "snapshot_refreshed": snapshot_refreshed},
                                    separators=(",", ":")), 200, CORS)
            return (json.dumps({"error": "method not allowed"}), 405, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 400, CORS)
    if (request.path or "/").rstrip("/").endswith("/variant-level"):
        q = (request.args.get("q") or "").strip()
        if (request.args.get("full") or "").strip().lower() in ("1", "true", "yes"):
            # Full unfiltered dataset -- returns the PUBLIC URL of the
            # pre-rendered gzip blob refresh_snapshots wrote (query_snapshot_
            # blob_url), not the bytes themselves: Cloud Functions/Run
            # rejects responses over ~10MB and these blobs (~8MB gzipped)
            # are close enough to that ceiling to hit it. The browser fetches
            # the object directly from GCS (see ppi.js's 2-step fetch).
            # Self-heals if the cache is ever missing: builds it once from
            # BigQuery, uploads it, then still returns a URL, never proxies
            # the (too-large) payload through this response.
            import json
            try:
                snap = latest_snapshot_status().get("latest_success")
                url = query_snapshot_blob_url(VARIANT_SNAPSHOT_BLOB)
                if url is None:
                    rows = query_snapshot_rows(VARIANT_SNAPSHOT_TABLE)
                    meta = snap or {"snapshot_date": None, "snapshot_created_at": datetime.now(timezone.utc).isoformat()}
                    _write_snapshot_blob(VARIANT_SNAPSHOT_BLOB, rows, VARIANT_COLUMNS, meta)
                    url = query_snapshot_blob_url(VARIANT_SNAPSHOT_BLOB)
                payload = {"snapshot_url": url, "snapshot": snap, "generated_at": datetime.now(timezone.utc).isoformat()}
                return (json.dumps(payload, separators=(",", ":")), 200, CORS)
            except Exception as e:
                return (json.dumps({"error": str(e)}), 500, CORS)
        if (request.args.get("format") or "").strip().lower() == "csv":
            from flask import Response
            headers = {
                "Content-Disposition": 'attachment; filename="variant-level.csv"',
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            }
            return Response(stream_variant_csv_rows(q), content_type="text/csv; charset=utf-8", headers=headers)
        t0 = time.time()
        try:
            page = max(1, int(request.args.get("page", 1)))
            page_size = min(MAX_PAGE_SIZE, max(1, int(request.args.get("pageSize", DEFAULT_PAGE_SIZE))))
            rows, total = query_variant_page(q, page, page_size)
            import json
            payload = {
                "rows": rows, "total": total, "page": page, "pageSize": page_size,
                "columns": VARIANT_COLUMNS, "q": q,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "elapsed_sec": round(time.time() - t0, 2),
            }
            return (json.dumps(payload, separators=(",", ":")), 200, CORS)
        except Exception as e:
            import json
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.args.get("full") or "").strip().lower() in ("1", "true", "yes"):
        # Full unfiltered dataset -- returns the PUBLIC URL of the
        # pre-rendered gzip blob refresh_snapshots wrote
        # (query_snapshot_blob_url), not the bytes themselves: Cloud
        # Functions/Run rejects responses over ~10MB and these blobs (~8MB
        # gzipped) are close enough to that ceiling to hit it. The browser
        # fetches the object directly from GCS (see ppi.js's 2-step fetch).
        # Self-heals if the cache is ever missing.
        import json
        try:
            snap = latest_snapshot_status().get("latest_success")
            url = query_snapshot_blob_url(PRODUCT_PRICE_SNAPSHOT_BLOB)
            if url is None:
                rows = query_snapshot_rows(PRODUCT_PRICE_SNAPSHOT_TABLE)
                meta = snap or {"snapshot_date": None, "snapshot_created_at": datetime.now(timezone.utc).isoformat()}
                _write_snapshot_blob(PRODUCT_PRICE_SNAPSHOT_BLOB, rows, CSV_COLUMNS, meta)
                url = query_snapshot_blob_url(PRODUCT_PRICE_SNAPSHOT_BLOB)
            payload = {"snapshot_url": url, "snapshot": snap, "generated_at": datetime.now(timezone.utc).isoformat()}
            return (json.dumps(payload, separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    if (request.args.get("format") or "").strip().lower() == "csv":
        q = (request.args.get("q") or "").strip()
        from flask import Response
        headers = {
            "Content-Disposition": 'attachment; filename="product-price.csv"',
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        }
        return Response(stream_csv_rows(q), content_type="text/csv; charset=utf-8", headers=headers)
    t0 = time.time()
    try:
        q = (request.args.get("q") or "").strip()
        page = max(1, int(request.args.get("page", 1)))
        page_size = min(MAX_PAGE_SIZE, max(1, int(request.args.get("pageSize", DEFAULT_PAGE_SIZE))))

        rows, total = query_page(q, page, page_size)

        payload = {
            "rows": rows, "total": total, "page": page, "pageSize": page_size,
            "columns": COLUMNS, "q": q,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "elapsed_sec": round(time.time() - t0, 2),
        }
        import json
        return (json.dumps(payload, separators=(",", ":")), 200, CORS)
    except Exception as e:
        import json
        return (json.dumps({"error": str(e)}), 500, CORS)
