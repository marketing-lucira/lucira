"""
Lucira Gold Rate — live daily-price history API
================================================
Backs the "Today's Entry" / "Saved History" calculator in the Slab tab of
dashboard/product-pricing-intelligence.html (ppi.js).

Single source of truth: `Pos.metal_rates` (the 'Gold' row, joined to
`Pos.item_groups` for the item_group_name match) -- NOT the older
`gold_rates.daily_gold_prices` table, and NEVER a hard-coded/manually-typed
value. `sales_rate * 10` is the price per 10g (same convention the old
table used), so the per-gram/KT-split math below is unchanged -- only the
source table changed. When a date has more than one metal_rates row (a
same-day correction), the highest `rate_id` (the latest entry) wins.

Endpoint (Cloud Run function, entry point `gold_rate_history`):
    GET /?days=<n>     -- last n days (default 30, max 366), newest first.

Response (unchanged shape, so the frontend needs no changes):
    { rows: [{date, price10g, priceGram, kt22, kt18, kt14, kt9}, ...],
      generated_at }
"""
import os
from datetime import datetime, timezone

import functions_framework
from google.cloud import bigquery

BQ_PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
METAL_RATES_TABLE = os.environ.get("METAL_RATES_TABLE", "lucirajewelry-prod.Pos.metal_rates")
ITEM_GROUPS_TABLE = os.environ.get("ITEM_GROUPS_TABLE", "lucirajewelry-prod.Pos.item_groups")
MAX_DAYS   = 366
DEFAULT_DAYS = 30

# Same purity multipliers as the Metal Rate sheet block.
KARAT_PURITY = {"22": 0.92, "18": 0.76, "14": 0.59, "9": 0.40}

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
}


def _client():
    return bigquery.Client(project=BQ_PROJECT or None)


def fetch_history(days):
    bq = _client()
    sql = f"""
        WITH gold_rows AS (
          SELECT DATE(a.from_date) AS rate_date, a.rate_id, a.sales_rate * 10 AS gold_999_price
          FROM `{METAL_RATES_TABLE}` a
          LEFT JOIN `{ITEM_GROUPS_TABLE}` b ON a.metal_type_id = b.item_group_id
          WHERE b.item_group_name = 'Gold'
        ),
        dedup AS (
          SELECT rate_date, gold_999_price,
            ROW_NUMBER() OVER (PARTITION BY rate_date ORDER BY rate_id DESC) AS rn
          FROM gold_rows
        )
        SELECT rate_date AS date, gold_999_price
        FROM dedup
        WHERE rn = 1
        ORDER BY rate_date DESC
        LIMIT @days
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
    ))
    rows = []
    for r in job.result():
        price10g = float(r["gold_999_price"])
        per_gram = round(price10g / 10.0, 2)
        row = {
            "date": r["date"].isoformat() if hasattr(r["date"], "isoformat") else str(r["date"]),
            "price10g": price10g, "priceGram": per_gram,
        }
        for kt, mult in KARAT_PURITY.items():
            row[f"kt{kt}"] = round(per_gram * mult, 2)
        rows.append(row)
    return rows


@functions_framework.http
def gold_rate_history(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)
    try:
        days = min(MAX_DAYS, max(1, int(request.args.get("days", DEFAULT_DAYS))))
        rows = fetch_history(days)
        import json
        payload = {"rows": rows, "generated_at": datetime.now(timezone.utc).isoformat()}
        return (json.dumps(payload, separators=(",", ":")), 200, CORS)
    except Exception as e:
        import json
        return (json.dumps({"error": str(e)}), 500, CORS)
