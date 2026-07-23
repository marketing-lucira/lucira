"""
Ornaverse ERP  →  Sales Analytics Dashboard  data API
======================================================
HTTP Cloud Function that reads the BigQuery **Sales_Overview** table and returns
compact JSON for `dashboard/sales-dashboard.html`.

SINGLE SOURCE OF TRUTH: every number comes from
    lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table
and nothing else. No joins, no other tables, no manual mapping.

Business rules (locked by the client 2026-07-16 final validation pass)
----------------------------------------------------------------------
1. GROSS SALES = the table's gross-amount column, summed directly. Never derived.
2. NET SALES   = GROSS / 1.03  (3% GST adjustment). Computed here, NOT read from a
                 net column. (Set GST_DIVISOR env to change the factor.)
3. SALE TYPE   = MTO / RTS / Return / Exchange / Other — split out so each has its
                 own totals. Returns/Exchanges keep their sign from the table.
4. DEDUPE      = drop a row ONLY if Gross Sale + Sale Date + Document Number +
                 Net Weight are ALL identical to another row. Anything differing on
                 any one of those four is a distinct transaction and is kept.
5. CATEGORIES  = read dynamically from the table. Never hardcoded.

⚠️  SCHEMA REMAP — the one thing you must edit: COLMAP below.
Dump the live schema (README step 0), then set each logical name to the real
column. `None` = column absent → the dependent metric degrades gracefully and the
dashboard hides/flags it.

Deploy (see README)
-------------------
    gcloud functions deploy sales-data \
        --gen2 --runtime=python312 --region=asia-south1 \
        --source=. --entry-point=sales_data --trigger-http --allow-unauthenticated \
        --set-env-vars 'BQ_PROJECT=lucirajewelry-prod,SALES_TABLE=lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table,TIMEZONE=Asia/Kolkata,CURRENCY=INR,WINDOW_DAYS=400,GST_DIVISOR=1.03'
"""

import os
import json
import time
from datetime import datetime, timezone

import functions_framework
from google.cloud import bigquery

# ─────────────────────────────────────────────────────────────
#  CONFIG (from environment)
# ─────────────────────────────────────────────────────────────
BQ_PROJECT   = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
SALES_TABLE  = os.environ.get(
    "SALES_TABLE",
    "lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table",
)
TIMEZONE     = os.environ.get("TIMEZONE", "Asia/Kolkata")
CURRENCY     = os.environ.get("CURRENCY", "INR")
GST_DIVISOR  = float(os.environ.get("GST_DIVISOR", "1.03"))   # Net = Gross / GST_DIVISOR
DEFAULT_DAYS = int(os.environ.get("WINDOW_DAYS", "400"))
MAX_DAYS     = int(os.environ.get("MAX_WINDOW_DAYS", "3650"))
DETAIL_CAP   = int(os.environ.get("DETAIL_ROW_CAP", "200000"))

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}

# ═════════════════════════════════════════════════════════════════════════
#  COLMAP  —  logical name  →  actual column in Sales_overview_table
#  Mapped 2026-07-16 to the REAL output columns of the client's DDL
#  (the CREATE TABLE ... AS SELECT that builds Sales_overview_table).
#  `None` = column absent in the table → metric degrades / is hidden.
# ═════════════════════════════════════════════════════════════════════════
COLMAP = {
    # — dedup key (all four must match to be a duplicate) —
    "gross":         "gross_amount",   # GROSS SALE — authoritative; Billed Returns are NEGATIVE
    "order_date":    "Transaction_Date",# SALE DATE (DATE). document_date is a formatted string — don't use it
    "document_no":   "document_no",
    "net_weight":    "net_weight",
    # — other measures —
    "gross_weight":  "weight",          # 'weight' = gross weight (grams); net_weight & pure_weight also exist
    "discount":      "discount",
    "qty":           "pieces",          # PIECES = quantity
    "tax":           "tax_amount",      # present, but Net is still computed as Gross/GST_DIVISOR
    "cogs":          None,              # no COGS column → gross margin hidden
    # — sale type —  (Fullfillment: Rts / MTO / Online_MTO / TAH / Billed Returns) —
    "sale_type":     "Fullfillment",
    # — product / style / category —
    "sku":           "Full_sku",
    "product_name":  "Item_name",       # also base_item / item_group_name available
    "style":         "style_code",      # design key. Alternative: half_sku (SKU design part)
    "category":      "type_name",       # main category (Gold Jewellery / Diamond Jewellery / …)
    "sub_category":  "sub_category",     # finer category from Shopify metafields
    "collection":    "collection_name", # attr collection. Alternative: collection_GA4
    "metal":         "metal_name",      # Gold / Platinum / Silver / …
    "purity":        "karat_name",      # 22K / 18K / … (metal purity)
    "price_band":    "Price_Range",     # ALREADY bucketed in the table (0-10K, 10K-20K, …)
    # — customer —
    "customer_id":   "party_id",
    "customer_name": "party_name",
    "customer_city": "city_name",
    "customer_state":"state_name",
    "region":        "country_name",
    "customer_type": "customer_type",   # New / Repeat — ALREADY computed in the table (first purchase per party)
    # — channel / people —
    "store":         "company_code",    # company/branch code. Channel gives Online/Store/TAH split
    "salesperson":   None,              # NOT in Sales_overview_table → Sales-Team tab & person filter hidden
    "channel":       "Channel",         # Online / Store / TAH
    # — inventory (not in this table) —
    "stock_qty":         None,
    "inventory_in_date": None,
}

# Raw Fullfillment value → canonical bucket the dashboard groups by.
# Online_MTO folds into MTO (the Channel column keeps the online/store split).
SALE_TYPE_MAP = {
    "mto": "MTO", "online_mto": "MTO", "online mto": "MTO", "make to order": "MTO", "order": "MTO",
    "rts": "RTS", "ready to sell": "RTS", "ready to ship": "RTS", "stock": "RTS",
    "tah": "TAH",
    "billed returns": "Return", "billed return": "Return", "return": "Return", "sales return": "Return", "cn": "Return",
    "exchange": "Exchange", "exch": "Exchange",
}


def col(logical, default_sql="NULL"):
    phys = COLMAP.get(logical)
    return f"`{phys}`" if phys else default_sql


def has(logical):
    return COLMAP.get(logical) is not None


def norm_sale_type(v):
    if v is None:
        return "Other"
    k = str(v).strip().lower()
    return SALE_TYPE_MAP.get(k, "MTO" if "mto" in k else "RTS" if "rts" in k
                             else "TAH" if "tah" in k
                             else "Return" if "return" in k else "Exchange" if "exch" in k
                             else (str(v).strip() or "Other"))


# ─────────────────────────────────────────────────────────────
#  QUERY 1 — deduped order-line detail (windowed fact table)
#  Dedupe rule 4 via QUALIFY on (gross, date, document_no, net_weight).
# ─────────────────────────────────────────────────────────────
def build_detail_query():
    date_col = col("order_date")
    gross    = col("gross", "0")
    net_wt   = col("net_weight", "0")
    doc      = col("document_no", "'-'")
    # dedup partition — the four locked keys. Others differing → kept (different partition).
    dedup = f"PARTITION BY {gross}, DATE(TIMESTAMP({date_col})), CAST({doc} AS STRING), {net_wt}"
    return f"""
    WITH base AS (
      SELECT *,
             ROW_NUMBER() OVER ({dedup} ORDER BY {gross}) AS _rn
      FROM `{SALES_TABLE}`
      WHERE TIMESTAMP({date_col}) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        AND {date_col} IS NOT NULL
    )
    SELECT
        FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP({date_col}), @tz) AS date,
        CAST({doc} AS STRING)                        AS document_no,
        CAST({col("customer_id","'-'")} AS STRING)   AS customer_id,
        {col("customer_name","''")}                  AS customer_name,
        {col("customer_city","''")}                  AS city,
        {col("customer_state","''")}                 AS state,
        {col("region","''")}                         AS region,
        CAST({col("sku","'-'")} AS STRING)           AS sku,
        {col("product_name","''")}                   AS product_name,
        CAST({col("style","'-'")} AS STRING)         AS style,
        {col("category","''")}                       AS category,
        {col("sub_category","''")}                   AS sub_category,
        {col("collection","''")}                     AS collection,
        {col("metal","''")}                          AS metal,
        {col("price_band","''")}                     AS price_band,
        {col("customer_type","''")}                  AS customer_type,
        {col("sale_type","''")}                      AS sale_type,
        IFNULL(SAFE_CAST({col("qty","1")} AS FLOAT64), 0)          AS qty,
        IFNULL(SAFE_CAST({gross} AS FLOAT64), 0)                   AS gross,
        IFNULL(SAFE_CAST({col("discount","0")} AS FLOAT64), 0)     AS discount,
        IFNULL(SAFE_CAST({col("gross_weight","0")} AS FLOAT64), 0) AS gross_weight,
        IFNULL(SAFE_CAST({net_wt} AS FLOAT64), 0)                  AS net_weight,
        {("IFNULL(SAFE_CAST(" + col("cogs") + " AS FLOAT64), 0)") if has("cogs") else "NULL"} AS cogs,
        {col("store","''")}                          AS store,
        {col("salesperson","''")}                    AS salesperson,
        {col("channel","''")}                        AS channel
    FROM base
    WHERE _rn = 1
    ORDER BY date
    LIMIT @cap
    """


# ─────────────────────────────────────────────────────────────
#  QUERY 2 — validation totals (raw vs deduped, gross reconciliation)
#  Lets the dashboard's Validation tab prove the dedup + gross totals.
# ─────────────────────────────────────────────────────────────
def build_validation_query():
    date_col = col("order_date")
    gross    = col("gross", "0")
    net_wt   = col("net_weight", "0")
    doc      = col("document_no", "'-'")
    key = f"CONCAT(CAST({gross} AS STRING),'|',CAST(DATE(TIMESTAMP({date_col})) AS STRING),'|',CAST({doc} AS STRING),'|',CAST({net_wt} AS STRING))"
    return f"""
    SELECT
      COUNT(*)                                              AS raw_rows,
      COUNT(DISTINCT {key})                                 AS deduped_rows,
      SUM(IFNULL(SAFE_CAST({gross} AS FLOAT64),0))          AS raw_gross
    FROM `{SALES_TABLE}`
    WHERE TIMESTAMP({date_col}) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      AND {date_col} IS NOT NULL
    """


def build_style_ref_query():
    date_col = col("order_date")
    return f"""
    SELECT
        CAST({col("style","'-'")} AS STRING)  AS style,
        ANY_VALUE({col("category","''")})     AS category,
        ANY_VALUE({col("metal","''")})        AS metal,
        MIN(DATE(TIMESTAMP({date_col})))      AS first_sale_date,
        MAX(DATE(TIMESTAMP({date_col})))      AS last_sale_date,
        SUM(IFNULL(SAFE_CAST({col("qty","1")} AS FLOAT64),0)) AS units_all_time
    FROM `{SALES_TABLE}`
    WHERE {date_col} IS NOT NULL
    GROUP BY style
    """


def build_customer_ref_query():
    if not has("customer_id"):
        return None
    date_col = col("order_date")
    gross    = col("gross", "0")
    return f"""
    SELECT
        CAST({col("customer_id")} AS STRING)  AS customer_id,
        MIN(DATE(TIMESTAMP({date_col})))      AS first_order_date,
        MAX(DATE(TIMESTAMP({date_col})))      AS last_order_date,
        COUNT(DISTINCT {col("document_no","1")}) AS lifetime_orders,
        SUM(IFNULL(SAFE_CAST({gross} AS FLOAT64),0)) / {GST_DIVISOR} AS lifetime_net
    FROM `{SALES_TABLE}`
    GROUP BY customer_id
    """


# ─────────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────────
@functions_framework.http
def sales_data(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
    if not SALES_TABLE:
        return (json.dumps({"error": "not_configured",
                            "detail": "Set SALES_TABLE (and BQ_PROJECT) env vars. See README."}), 500, CORS)

    t0 = time.time()
    try:
        days = min(MAX_DAYS, max(1, int(request.args.get("days", DEFAULT_DAYS))))
    except ValueError:
        days = DEFAULT_DAYS
    debug = request.args.get("debug") == "1"

    client = bigquery.Client(project=BQ_PROJECT or None)

    def run(sql, params):
        return list(client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())

    detail_params = [
        bigquery.ScalarQueryParameter("tz", "STRING", TIMEZONE),
        bigquery.ScalarQueryParameter("days", "INT64", days),
        bigquery.ScalarQueryParameter("cap", "INT64", DETAIL_CAP),
    ]
    win_params = [
        bigquery.ScalarQueryParameter("tz", "STRING", TIMEZONE),
        bigquery.ScalarQueryParameter("days", "INT64", days),
    ]

    try:
        detail_rows = run(build_detail_query(), detail_params)
        valid_rows  = run(build_validation_query(), win_params)
        style_rows  = run(build_style_ref_query(), [])
        cust_sql    = build_customer_ref_query()
        cust_rows   = run(cust_sql, []) if cust_sql else []
    except Exception as e:  # noqa: BLE001
        return (json.dumps({"error": "bq_query_error", "detail": str(e),
                            "hint": "Most failures here are a wrong column in COLMAP — dump the live "
                                    "schema (README step 0) and fix the mapping."}), 502, CORS)

    def d(v):
        return v.isoformat() if hasattr(v, "isoformat") else v

    items, max_date = [], None
    for r in detail_rows:
        gross = round(float(r["gross"] or 0), 2)
        it = {
            "date": r["date"], "document_no": r["document_no"], "order_id": r["document_no"],
            "customer_id": r["customer_id"], "customer_name": r["customer_name"] or "",
            "city": r["city"] or "", "state": r["state"] or "", "region": r["region"] or "",
            "sku": r["sku"], "product_name": r["product_name"] or "", "style": r["style"],
            "category": r["category"] or "", "sub_category": r["sub_category"] or "",
            "collection": r["collection"] or "", "metal": r["metal"] or "",
            "price_band": r["price_band"] or "", "customer_type": (r["customer_type"] or "").title(),
            "sale_type": norm_sale_type(r["sale_type"]),
            "qty": round(float(r["qty"] or 0), 3),
            "gross": gross,
            "net": round(gross / GST_DIVISOR, 2),                 # rule 2: Net = Gross / 1.03
            "discount": round(float(r["discount"] or 0), 2),
            "gross_weight": round(float(r["gross_weight"] or 0), 3),
            "net_weight": round(float(r["net_weight"] or 0), 3),
            "cogs": (round(float(r["cogs"]), 2) if r["cogs"] is not None else None),
            "store": r["store"] or "", "salesperson": r["salesperson"] or "", "channel": r["channel"] or "",
        }
        items.append(it)
        if r["date"] and (max_date is None or r["date"] > max_date):
            max_date = r["date"]

    style_ref = [{
        "style": r["style"], "category": r["category"] or "", "metal": r["metal"] or "",
        "first_sale_date": d(r["first_sale_date"]), "last_sale_date": d(r["last_sale_date"]),
        "units_all_time": round(float(r["units_all_time"] or 0), 3),
        "first_inventory_date": None, "stock_qty": None,
    } for r in style_rows]

    customer_ref = [{
        "customer_id": r["customer_id"], "first_order_date": d(r["first_order_date"]),
        "last_order_date": d(r["last_order_date"]), "lifetime_orders": int(r["lifetime_orders"] or 0),
        "lifetime_net": round(float(r["lifetime_net"] or 0), 2),
    } for r in cust_rows]

    v = valid_rows[0] if valid_rows else None
    validation = {
        "raw_rows": int(v["raw_rows"]) if v else len(items),
        "deduped_rows": int(v["deduped_rows"]) if v else len(items),
        "raw_gross": round(float(v["raw_gross"]), 2) if v else round(sum(i["gross"] for i in items), 2),
        "returned_rows": len(items),
        "returned_gross": round(sum(i["gross"] for i in items), 2),
        "gst_divisor": GST_DIVISOR,
        "dedup_key": "gross + sale_date + document_no + net_weight",
    }

    resp = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asOf": max_date, "window_days": days, "currency": CURRENCY, "gst_divisor": GST_DIVISOR,
        "capabilities": {
            "margin": has("cogs"), "inventory": has("stock_qty"),
            "selling_days": has("inventory_in_date"), "customer": has("customer_id"),
            "salesperson": has("salesperson"), "sale_type": has("sale_type"),
            "weights": has("net_weight") or has("gross_weight"),
            "price_band": has("price_band"), "customer_type": has("customer_type"),
            "sub_category": has("sub_category"),
        },
        "validation": validation,
        "items": items, "styleRef": style_ref, "customerRef": customer_ref,
    }
    if debug:
        resp["debug"] = {"detail_rows": len(items), "styles": len(style_ref), "customers": len(customer_ref),
                         "elapsed_sec": round(time.time() - t0, 2), "table": SALES_TABLE, "colmap": dict(COLMAP)}
    return (json.dumps(resp), 200, CORS)
