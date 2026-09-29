"""
Lucira Hourly Deals vs Orders -- live BigQuery bundle API
==========================================================
Backs dashboard/hourly-deals-orders.html. Thin data pump only: pulls raw
Deal rows (zoho_crm.cdc_deals) and Order rows (ds_imputed_reporting.marketing_sale)
for a rolling window of days and returns them as slim positional arrays. The
dashboard does ALL the IST-hour bucketing, dedup and Deals-vs-Orders math
client-side.

This replaces the earlier client-side dependency on zoho-crm-bundle-public
for Deals -- that endpoint pulls the FULL ~20k-row / ~20MB Deals history on
every call (30-40s). cdc_deals is the same underlying CDC-synced BigQuery
table that bundle reads from, so querying it directly with a date filter
returns identical Created_Time values in a fraction of a second.

created_time in cdc_deals is a real UTC TIMESTAMP -- we convert it to IST
with FORMAT_TIMESTAMP(..., 'Asia/Kolkata'). document_date in marketing_sale
is already a store-local ERP timestamp ("DD-MM-YYYY HH:MM:SS") in IST
wall-clock time -- we do not re-convert it, just parse it.

Endpoint (Cloud Run function, entry point `hourly_deals_orders`):
    GET /?days=<n>   -- rolling window, default 60, max 180

Response:
    { dealFields: [...], deals: [[id, created_iso, ownerId, ownerName], ...],
      orderFields: [...], orders: [[document_no, document_date_iso, channel, net_sale], ...],
      generated_at, days }

Deploy:
    gcloud functions deploy hourly-deals-orders-api \
        --gen2 --runtime=python312 --region=asia-south1 --source=. \
        --entry-point=hourly_deals_orders --trigger-http --allow-unauthenticated \
        --memory=256MB --timeout=60s \
        --set-env-vars BQ_PROJECT=lucirajewelry-prod,SALE_TABLE=lucirajewelry-prod.ds_imputed_reporting.marketing_sale,DEALS_TABLE=lucirajewelry-prod.zoho_crm.cdc_deals
"""
import json
import os
from datetime import datetime, timezone

import functions_framework
from google.cloud import bigquery

BQ_PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
SALE_TABLE = os.environ.get("SALE_TABLE", "lucirajewelry-prod.ds_imputed_reporting.marketing_sale")
DEALS_TABLE = os.environ.get("DEALS_TABLE", "lucirajewelry-prod.zoho_crm.cdc_deals")
DEFAULT_DAYS = 60
MAX_DAYS = 180

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
}


def _client():
    return bigquery.Client(project=BQ_PROJECT or None)


def _iso(document_date):
    # "DD-MM-YYYY HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS" (already IST wall-clock)
    try:
        dt = datetime.strptime(document_date.strip(), "%d-%m-%Y %H:%M:%S")
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None


def fetch_orders(bq, days):
    sql = f"""
        SELECT document_no, document_date, Channel, net_sale
        FROM `{SALE_TABLE}`
        WHERE Transaction_Date >= DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL @days DAY)
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
    ))
    out = []
    for r in job.result():
        iso = _iso(r["document_date"])
        if iso and r["document_no"]:
            net_sale = r["net_sale"]
            out.append([r["document_no"], iso, r["Channel"] or "", round(float(net_sale), 2) if net_sale is not None else 0])
    return out


# Marketing Sale Intelligence -- full line-item history (the table is tiny,
# ~2.5K rows across 13+ months as of 2026-09, so "days" here is just a safety
# cap, not a performance necessity -- one query, loaded once client-side,
# then every dimension breakdown/filter/drill-down in the dashboard is plain
# JS over that array. Order-level metrics (Total Orders, AOV) MUST dedupe on
# document_no client-side -- this returns one row per LINE ITEM (a single
# order can have several SKUs), matching marketing_sale's own grain.
MS_FIELDS = [
    "document_no", "date", "fulfillment", "channel", "company_code", "city_name", "state_name",
    "type_name", "full_sku", "product_title", "item_group_name", "karat_name", "metal_color_code",
    "vendor", "is_solitaire", "gemstone_setting", "gemstone_shape", "diamond_setting",
    "pf_sub_category_1", "pf_sub_category_2", "diamond_weight_band", "collection_name",
    "price_range", "net_sale", "pieces",
]
MS_DAYS_DEFAULT = 800  # safety cap only -- table spans ~13 months total


def fetch_marketing_sale_lines(bq, days):
    sql = f"""
        SELECT
          document_no, FORMAT_DATE('%Y-%m-%d', Transaction_Date) AS date,
          Fullfillment AS fulfillment, Channel AS channel, company_code, city_name, state_name,
          type_name, Full_sku AS full_sku, Product_Title AS product_title,
          item_group_name, karat_name, metal_color_code,
          Vendor AS vendor, Is_Solitaire AS is_solitaire, Gemstone_Setting AS gemstone_setting,
          Gemstone_1_Shape AS gemstone_shape, Diamond_Setting AS diamond_setting,
          PF_sub_category_1 AS pf_sub_category_1, PF_sub_category_2 AS pf_sub_category_2,
          Diamond_Weight_Band AS diamond_weight_band, collection_name,
          Price_Range AS price_range, net_sale, pieces
        FROM `{SALE_TABLE}`
        WHERE Transaction_Date >= DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL @days DAY)
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
    ))
    out = []
    for r in job.result():
        net_sale = r["net_sale"]
        out.append([
            r["document_no"], r["date"], r["fulfillment"] or "", r["channel"] or "",
            r["company_code"] or "", r["city_name"] or "", r["state_name"] or "",
            r["type_name"] or "", r["full_sku"] or "", r["product_title"] or "",
            r["item_group_name"] or "", r["karat_name"] or "", r["metal_color_code"] or "",
            r["vendor"] or "", r["is_solitaire"], r["gemstone_setting"] or "",
            r["gemstone_shape"] or "", r["diamond_setting"] or "",
            r["pf_sub_category_1"] or "", r["pf_sub_category_2"] or "",
            r["diamond_weight_band"] or "", r["collection_name"] or "",
            r["price_range"] or "",
            round(float(net_sale), 2) if net_sale is not None else 0,
            int(r["pieces"]) if r["pieces"] is not None else 0,
        ])
    return out


def fetch_deals(bq, days):
    sql = f"""
        SELECT id, owner_id, owner_name,
               FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', created_time, 'Asia/Kolkata') AS created_ist
        FROM `{DEALS_TABLE}`
        WHERE DATE(created_time, "Asia/Kolkata") >= DATE_SUB(CURRENT_DATE("Asia/Kolkata"), INTERVAL @days DAY)
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
    ))
    out = []
    for r in job.result():
        if r["id"] and r["created_ist"]:
            out.append([r["id"], r["created_ist"], r["owner_id"] or "", r["owner_name"] or "(unassigned)"])
    return out


@functions_framework.http
def hourly_deals_orders(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
    if (request.path or "/").rstrip("/").endswith("/marketing-sale-lines"):
        try:
            days = min(2000, max(1, int(request.args.get("days", MS_DAYS_DEFAULT))))
            bq = _client()
            lines = fetch_marketing_sale_lines(bq, days)
            payload = {
                "fields": MS_FIELDS, "lines": lines, "days": days,
                "tz": "Asia/Kolkata", "generated_at": datetime.now(timezone.utc).isoformat(),
            }
            return (json.dumps(payload, separators=(",", ":")), 200, CORS)
        except Exception as e:
            return (json.dumps({"error": str(e)}), 500, CORS)
    try:
        days = min(MAX_DAYS, max(1, int(request.args.get("days", DEFAULT_DAYS))))
        bq = _client()
        deals = fetch_deals(bq, days)
        orders = fetch_orders(bq, days)
        payload = {
            "dealFields": ["id", "created", "ownerId", "ownerName"],
            "deals": deals,
            "orderFields": ["orderId", "created", "channel", "netSale"],
            "orders": orders,
            "days": days,
            "tz": "Asia/Kolkata",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        return (json.dumps(payload, separators=(",", ":")), 200, CORS)
    except Exception as e:
        return (json.dumps({"error": str(e)}), 500, CORS)
