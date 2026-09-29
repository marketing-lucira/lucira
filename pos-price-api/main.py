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
import csv, gzip, io, json, math, os, time
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
    "item_code": "Item Code", "item_name": "Item Name", "weight": "Weight", "pieces": "Pieces",
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
        CASE item_group_name
          WHEN 'Gold' THEN @disc_gold
          WHEN 'Diamond' THEN @disc_diamond
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


# Labour -- master table gold_rates.labour_rates (FOR ALL PRODUCTS / BELOW
# 1.5 GMS), single source of truth for Variant Level's "CP. pr gm making"
# column. Editable Amount from the Slab tab -- never hard-coded here.
LABOUR_TABLE = os.environ.get("LABOUR_TABLE", "lucirajewelry-prod.gold_rates.labour_rates")
LABOUR_KEYS = ["for_all", "below_1_5"]
LABOUR_NET_WEIGHT_CUTOFF = 1.5  # GM
# CP. pr gm making, <= cutoff: a FIXED amount, not a per-gram rate and not
# looked up from the Labour table (explicit spec) -- unlike the > cutoff
# case, which is Net Weight * the Labour table's "for_all" rate.
CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF = 1500.0

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


def labour_rates_list():
    bq = _client()
    rows = bq.query(
        f"SELECT rate_key, sort_order, label, amount, updated_at "
        f"FROM `{LABOUR_TABLE}` ORDER BY sort_order"
    ).result()
    out = []
    for r in rows:
        out.append({
            "rate_key": r["rate_key"], "sort_order": int(r["sort_order"]),
            "label": r["label"], "amount": float(r["amount"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })
    return out


def labour_rates_update(rate_key, amount):
    if rate_key not in LABOUR_KEYS:
        raise ValueError(f"unknown rate_key {rate_key!r}")
    if not (amount > 0):
        raise ValueError("amount must be a positive number")
    bq = _client()
    bq.query(
        f"UPDATE `{LABOUR_TABLE}` SET amount = @a, updated_at = CURRENT_TIMESTAMP() WHERE rate_key = @rate_key",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("a", "FLOAT64", amount),
            bigquery.ScalarQueryParameter("rate_key", "STRING", rate_key),
        ]),
    ).result()
    # Invalidate the 60s TTL cache immediately -- see the matching comment in
    # diamond_slab_update.
    _LABOUR_RATES_CACHE["ts"] = 0.0
    _LABOUR_RATES_CACHE["data"] = {}
    return labour_rates_list()


_LABOUR_RATES_CACHE = {"ts": 0.0, "data": {}}


def fetch_labour_rates():
    """{"for_all": amount, "below_1_5": amount} -- cached 60s (see
    _SMALL_CONFIG_TTL_SEC above) so a Slab tab edit is reflected within a
    minute, not necessarily on the very next request."""
    now = time.time()
    if _LABOUR_RATES_CACHE["data"] and (now - _LABOUR_RATES_CACHE["ts"]) < _SMALL_CONFIG_TTL_SEC:
        return _LABOUR_RATES_CACHE["data"]
    rates = {}
    try:
        bq = _client()
        rows = bq.query(f"SELECT rate_key, amount FROM `{LABOUR_TABLE}`").result()
        rates = {r["rate_key"]: float(r["amount"]) for r in rows}
    except Exception:
        pass
    if rates:
        _LABOUR_RATES_CACHE["data"] = rates
        _LABOUR_RATES_CACHE["ts"] = now
    return rates or _LABOUR_RATES_CACHE["data"]


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
          SUM(IF(item_group_name = 'Diamond', IFNULL(ROUND({case_sql}, 2), 0), 0)) AS diamond_amount
        FROM `{TABLE}`
        GROUP BY item_code
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    result = {}
    for row in job.result(page_size=5000):
        result[row["item_code"]] = {
            "metal_amount": round(float(row["metal_amount"]), 2) if row["metal_amount"] is not None else 0.0,
            "diamond_amount": round(float(row["diamond_amount"]), 2) if row["diamond_amount"] is not None else 0.0,
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
                 CASE WHEN item_group_name = 'Diamond' AND pieces IS NOT NULL AND pieces > 0
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
          SUM(IFNULL(carat_weight * purchase_rate * pieces, 0)) AS total_diamond_cp
        FROM priced_final
        GROUP BY item_code
    """
    job = bq.query(sql)
    result = {}
    for row in job.result(page_size=5000):
        result[row["item_code"]] = round(float(row["total_diamond_cp"]), 2) if row["total_diamond_cp"] is not None else 0.0
    _VARIANT_DIAMOND_CP_CACHE["data"] = result
    _VARIANT_DIAMOND_CP_CACHE["ts"] = now
    return result


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
VARIANT_COLUMNS = [
    "item_code", "product_composition", "item_name", "image_url", "status", "item_group",
    "net_weight", "weight", "diamond_weight", "purity", "g2d", "g2d_band",
    "metal_amount", "diamond_amount", "overall_selling_price",
    "making_charge_per_g", "making_amount",
    "before_gst_overall", "before_gst_value", "original_after_gst_overall",
    "making_discount_pct", "making_discount_amount", "net_making_amount",
    "diamond_disc_pct", "diamond_discount_amount", "net_diamond_amount",
    "after_discount", "gst", "final_after_gst_overall",
    "total_diamond_cp", "cp_pr_gm_making", "total_cp_cost",
    "cash_back_pct", "final_amount_post_discount", "margin_pct",
    "additional_disc", "margin2_pct",
]
VARIANT_LABELS = {
    "item_code": "Item Code", "product_composition": "Product Composition",
    "item_name": "Item Name", "status": "Status", "item_group": "Item Group",
    "net_weight": "Net Weight", "weight": "Weight", "diamond_weight": "Diamond Weight",
    "purity": "Purity", "g2d": "G2D Ratio", "g2d_band": "G2D Band",
    "metal_amount": "Metal Amount", "diamond_amount": "Diamond Amount",
    "overall_selling_price": "Overall Selling Price",
    "making_charge_per_g": "Making Charge /g", "making_amount": "Making Amount",
    "before_gst_overall": "Before GST Overall",
    "before_gst_value": "Before GST Value", "original_after_gst_overall": "Original After GST Overall",
    "making_discount_pct": "Making Discount %", "making_discount_amount": "Making Discount Amount",
    "net_making_amount": "Net Making Amount",
    "diamond_disc_pct": "Diamond Disc%", "diamond_discount_amount": "Diamond Discount Amount",
    "net_diamond_amount": "Net Diamond Amount",
    "after_discount": "After Discount", "gst": "GST", "final_after_gst_overall": "Final After GST Overall",
    "total_diamond_cp": "Total Diamond CP", "cp_pr_gm_making": "CP. pr gm making",
    "total_cp_cost": "Total CP Cost", "margin_pct": "Margin %",
    "cash_back_pct": "Cash Back", "final_amount_post_discount": "Final Amount Post Discount",
    "additional_disc": "Additional Disc", "margin2_pct": "Margin2",
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
                 price, compare_price, is_publish, creation_date,
                 {_VARIANT_G2D_EXPR} AS g2d,
                 {mc_case_sql},
                 {dp_case_sql},
                 ROW_NUMBER() OVER (
                   PARTITION BY item_code ORDER BY COALESCE(modified_date, creation_date) DESC
                 ) AS rn
          FROM `{G2D_TABLE}`
          {where_clause}
        )
        SELECT * FROM items_dedup WHERE rn = 1
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


GST_RATE = 0.03  # flat 3%, per spec


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

    # -- Pricing waterfall (full precision internally; rounded only when returned) --
    metal_amount = md.get("metal_amount", 0.0) or 0.0
    diamond_amount = md.get("diamond_amount", 0.0) or 0.0
    net_weight = item.get("net_weight") or 0.0
    making_charge_per_g = item.get("making_charge_per_g") or 0.0
    making_amount = net_weight * making_charge_per_g

    overall = metal_amount + diamond_amount + making_amount
    before_gst_overall = overall
    before_gst_value = before_gst_overall * GST_RATE
    original_after_gst_overall = before_gst_overall + before_gst_value

    making_discount_amount = making_amount * (making_discount_pct / 100.0)
    net_making_amount = making_amount - making_discount_amount
    diamond_discount_amount = diamond_amount * (diamond_disc_pct / 100.0)
    net_diamond_amount = diamond_amount - diamond_discount_amount

    after_discount = metal_amount + net_making_amount + net_diamond_amount
    gst = after_discount * GST_RATE
    final_after_gst_overall = after_discount + gst
    final_after_gst_overall_rounded = math.ceil(final_after_gst_overall)  # rounded UP to the nearest whole rupee
    cash_back_pct = _cash_back_pct(product_composition, cls.get("has_diamond"), final_after_gst_overall_rounded,
                                    cash_back_rates)

    # -- CP. pr gm making / Total CP Cost / Margin % --
    # <= 1.5 GM: a fixed CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF.
    # >  1.5 GM: Net Weight * the Labour table's "for_all" rate (Slab tab,
    #            editable, never hard-coded here).
    labour_rates = labour_rates or {}
    total_diamond_cp = (diamond_cp_map or {}).get(code, 0.0)
    if net_weight <= LABOUR_NET_WEIGHT_CUTOFF:
        cp_pr_gm_making = CP_PR_GM_MAKING_FIXED_BELOW_CUTOFF
    else:
        cp_pr_gm_making = net_weight * labour_rates.get("for_all", 0.0)
    total_cp_cost = total_diamond_cp + cp_pr_gm_making + metal_amount
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
    additional_disc = final_after_gst_overall_rounded * (cash_back_pct / 100.0)
    net_after_additional_disc = final_after_gst_overall_rounded - additional_disc
    margin2_pct = (
        (net_after_additional_disc - total_cp_cost) / net_after_additional_disc * 100.0
        if net_after_additional_disc else None
    )

    return {
        "item_code": code,
        "product_composition": product_composition,
        "item_name": item.get("item_name") or cls.get("item_name_pp"),
        "item_group": cls["item_group"],
        "metal_amount": round(metal_amount, 2), "diamond_amount": round(diamond_amount, 2),
        "net_weight": net_weight, "making_charge_per_g": item.get("making_charge_per_g"),
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
                 CASE WHEN item_group_name = 'Diamond' AND pieces IS NOT NULL AND pieces > 0
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
          SELECT item_code, SUM(IFNULL(carat_weight * purchase_rate * pieces, 0)) AS total_diamond_cp
          FROM priced_final
          GROUP BY item_code
        ),
        selling_agg AS (
          SELECT item_code,
            SUM(IF(item_group_name IN ({metal_list_sql}), IFNULL(ROUND({selling_case_sql}, 2), 0), 0)) AS metal_amount,
            SUM(IF(item_group_name = 'Diamond', IFNULL(ROUND({selling_case_sql}, 2), 0), 0)) AS diamond_amount,
            SUM(ROUND({selling_case_sql}, 2)) AS overall_selling_price
          FROM filtered_pp
          GROUP BY item_code
        ),
        items_dedup AS (
          SELECT item_code, item_name, sku, weight, net_weight, diamond_weight, purity,
                 price, compare_price, is_publish, creation_date,
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
          diamond_cp_agg.total_diamond_cp,
          id.item_name, id.sku, id.weight, id.net_weight, id.diamond_weight, id.purity,
          id.price, id.compare_price, id.is_publish, id.creation_date,
          id.g2d, id.making_charge_per_g, id.discount_pct
        FROM cls
        LEFT JOIN selling_agg USING(item_code)
        LEFT JOIN diamond_cp_agg USING(item_code)
        LEFT JOIN items_dedup id ON id.item_code = cls.item_code AND id.rn = 1
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
        }
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
            f_labour = ex.submit(fetch_labour_rates)
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
    labour_rates = fetch_labour_rates()
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
    labour_rates = fetch_labour_rates()
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
    "Access-Control-Allow-Headers": "Content-Type",
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


def _stone_rate_rows_cte():
    return f"""
        stone_rate_rows AS (
          SELECT
            LOWER(TRIM(b.item_group_name)) AS ig,
            LOWER(TRIM(b.shape_name)) AS sh,
            LOWER(TRIM(b.quality_name)) AS ql,
            LOWER(TRIM(b.stone_color_name)) AS sc,
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
            CASE WHEN p.item_group_name = 'Diamond' AND p.pieces IS NOT NULL AND p.pieces > 0
                 THEN p.net_weight / p.pieces END AS carat_weight,
            CASE WHEN g.diamond_weight IS NOT NULL AND g.diamond_weight > 0
                      AND g.g2d_net_weight IS NOT NULL AND g.g2d_net_weight > 0
                 THEN ROUND(g.diamond_weight / g.g2d_net_weight, 4) END AS raw_g2d_ratio
          FROM `{TABLE}` AS p
          LEFT JOIN g2d_dedup g ON g.item_code = p.item_code AND g.rn = 1
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
        ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY item_name
              ORDER BY CASE WHEN raw_g2d_ratio IS NOT NULL THEN 0 ELSE 1 END, item_code
            ) AS variant_rank
          FROM priced_final
        ),
        with_g2d AS (
          SELECT {", ".join(f"`{c}`" for c in COLUMNS)}, carat_weight, purchase_rate,
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
    ("item_code", "STRING"), ("item_name", "STRING"), ("weight", "FLOAT64"), ("pieces", "INTEGER"),
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
    ("status", "STRING"), ("item_group", "STRING"),
    ("net_weight", "FLOAT64"), ("weight", "FLOAT64"), ("diamond_weight", "FLOAT64"), ("purity", "FLOAT64"),
    ("g2d", "FLOAT64"), ("g2d_band", "STRING"),
    ("metal_amount", "FLOAT64"), ("diamond_amount", "FLOAT64"), ("overall_selling_price", "FLOAT64"),
    ("making_charge_per_g", "FLOAT64"), ("making_amount", "FLOAT64"),
    ("before_gst_overall", "FLOAT64"), ("before_gst_value", "FLOAT64"), ("original_after_gst_overall", "FLOAT64"),
    ("making_discount_pct", "FLOAT64"), ("making_discount_amount", "FLOAT64"), ("net_making_amount", "FLOAT64"),
    ("diamond_disc_pct", "FLOAT64"), ("diamond_discount_amount", "FLOAT64"), ("net_diamond_amount", "FLOAT64"),
    ("after_discount", "FLOAT64"), ("gst", "FLOAT64"), ("final_after_gst_overall", "FLOAT64"),
    ("total_diamond_cp", "FLOAT64"), ("cp_pr_gm_making", "FLOAT64"), ("total_cp_cost", "FLOAT64"),
    ("margin_pct", "FLOAT64"), ("cash_back_pct", "FLOAT64"),
    ("final_amount_post_discount", "FLOAT64"),
    ("additional_disc", "FLOAT64"), ("margin2_pct", "FLOAT64"), ("image_url", "STRING"),
    ("_snapshot_seq", "INTEGER"),
]

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
] + [f for f in VARIANT_SNAPSHOT_SCHEMA if f[0] != "_snapshot_seq"]


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
#         update / labour_rates_update / cash_back_rates_update /
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
        "labour": {
            "list": labour_rates_list, "key_field": "rate_key",
            "update": lambda c: labour_rates_update(c["rate_key"], c["amount"]),
            "value_fields": ["amount"],
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
#  MTO Daily Margin -- reuses the EXISTING Sales Analytics fact table
#  (sales_dashboard.sales_reporting, rebuilt daily 10:00 IST, already
#  deduped/GST-adjusted) filtered to sale_type='MTO', joined to the SAME
#  SKU-then-style cost fallback (cost_reference / cost_reference_style)
#  the existing Sales dashboard uses for margin. NOT a new calculation
#  engine and NOT the Product Pricing / Variant Level engine (those price
#  a catalog SKU in the abstract; this reports what an MTO order actually
#  sold for and actually cost) -- Cost is left blank (never guessed) for
#  any SKU/style the cost tables don't cover yet.
# ══════════════════════════════════════════════════════════════════════
SALES_REPORTING_TABLE = os.environ.get(
    "SALES_REPORTING_TABLE", "lucirajewelry-prod.sales_dashboard.sales_reporting")
COST_REFERENCE_TABLE = os.environ.get(
    "COST_REFERENCE_TABLE", "lucirajewelry-prod.sales_dashboard.cost_reference")
COST_REFERENCE_STYLE_TABLE = os.environ.get(
    "COST_REFERENCE_STYLE_TABLE", "lucirajewelry-prod.sales_dashboard.cost_reference_style")


def mto_daily_margin(date_str):
    bq = _client()
    rows = list(bq.query(
        f"""
        SELECT sr.date, sr.document_no, sr.sku, sr.product_name, sr.store, sr.channel,
               sr.gross, sr.discount, sr.net,
               COALESCE(cr.unit_cost_sku, crs.unit_cost_style) AS cost
        FROM `{SALES_REPORTING_TABLE}` sr
        LEFT JOIN `{COST_REFERENCE_TABLE}` cr ON cr.full_sku = sr.sku
        LEFT JOIN `{COST_REFERENCE_STYLE_TABLE}` crs ON crs.style_token = sr.style
        WHERE sr.sale_type = 'MTO' AND sr.date = @d
        ORDER BY sr.document_no, sr.sku
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("d", "DATE", date_str),
        ]),
    ).result())
    out = []
    for r in rows:
        net = float(r["net"]) if r["net"] is not None else 0.0
        cost = float(r["cost"]) if r["cost"] is not None else None
        margin_amt = (net - cost) if cost is not None else None
        margin_pct = (margin_amt / net * 100.0) if (margin_amt is not None and net) else None
        out.append({
            "date": r["date"].isoformat() if r["date"] else None,
            "document_no": r["document_no"], "sku": r["sku"], "product_name": r["product_name"],
            "store": r["store"], "channel": r["channel"],
            "gross": round(float(r["gross"]), 2) if r["gross"] is not None else None,
            "discount": round(float(r["discount"]), 2) if r["discount"] is not None else None,
            "net": round(net, 2),
            "cost": round(cost, 2) if cost is not None else None,
            "margin_amt": round(margin_amt, 2) if margin_amt is not None else None,
            "margin_pct": round(margin_pct, 2) if margin_pct is not None else None,
        })
    return out


def mto_available_dates(limit=60):
    bq = _client()
    rows = list(bq.query(
        f"SELECT DISTINCT date FROM `{SALES_REPORTING_TABLE}` WHERE sale_type='MTO' "
        f"ORDER BY date DESC LIMIT {int(limit)}"
    ).result())
    return [r["date"].isoformat() for r in rows]


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


@functions_framework.http
def pos_price(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
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
    if (request.path or "/").rstrip("/").endswith("/mto-daily-margin"):
        import json
        try:
            date_str = (request.args.get("date") or "").strip()
            if not date_str:
                dates = mto_available_dates(limit=1)
                if not dates:
                    return (json.dumps({"date": None, "available_dates": [], "rows": []}), 200, CORS)
                date_str = dates[0]
            rows = mto_daily_margin(date_str)
            available_dates = mto_available_dates()
            return (json.dumps({"date": date_str, "available_dates": available_dates, "rows": rows},
                                separators=(",", ":")), 200, CORS)
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
    if (request.path or "/").rstrip("/").endswith("/labour-config"):
        import json
        try:
            if request.method == "GET":
                return (json.dumps({"rows": labour_rates_list()}, separators=(",", ":")), 200, CORS)
            if request.method in ("POST", "PUT"):
                body = request.get_json(force=True, silent=True) or {}
                rows = labour_rates_update(str(body.get("rate_key") or "").strip(), float(body.get("amount")))
                snapshot_refreshed = (_safe_refresh_snapshots("config_edit:labour")
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
