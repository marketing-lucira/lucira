"""
Lucira · Inventory Refilling Intelligence & AI Command Center — data + AI API
=============================================================================
One HTTP Cloud Function (gen2 / Cloud Run, entry `inventory_intel`) that powers
`dashboard/inventory-intelligence.html`.

SINGLE FACT TABLE ARCHITECTURE
------------------------------
A BigQuery Scheduled Query (sql/10_build_fact.sql + 20_build_transfers_insights.sql)
runs daily at 09:00 IST and rebuilds four reporting tables:

  FACT      reporting.inventory_intelligence_fact        (one row / sku x store)
  TRANSFERS reporting.inventory_intelligence_transfers   (inter-store moves)
  INSIGHTS  reporting.inventory_intelligence_insights    (auto AI insights)
  META      reporting.inventory_intelligence_meta         (KPI headline rollup)

This API reads ONLY those four tables — never the raw sources — so every load
scans a few MB and returns in well under a second. All heavy business logic
(cover days, turnover, sell-through, refill qty/priority, AI recommendation,
store transfers, health & stock-out risk) is already materialised in the fact
table by the scheduled query.

Scope: jewelry only. Silver + every Coin/bullion product is excluded at the
source (baked into the build SQL), so nothing here re-filters it.

Routing (dispatch on ?action=):
  (default)       → full bundle: fact rows + meta + insights + transfers (GET)
  ?action=chat    → NL question → Gemini writes guarded SQL over the fact table (POST)
  ?action=insights→ AI insights rows (+ optional Gemini narrative) (GET)
  ?action=health  → ping

Deploy: see deploy.sh / README.md
"""

import os
import re
import json
from datetime import datetime, timezone, date

import functions_framework
from google.cloud import bigquery

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
BQ_PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
DATASET    = os.environ.get("REPORT_DATASET", "lucirajewelry-prod.reporting")

FACT_TABLE      = os.environ.get("FACT_TABLE",      f"{DATASET}.inventory_intelligence_fact")
TRANSFERS_TABLE = os.environ.get("TRANSFERS_TABLE", f"{DATASET}.inventory_intelligence_transfers")
INSIGHTS_TABLE  = os.environ.get("INSIGHTS_TABLE",  f"{DATASET}.inventory_intelligence_insights")
META_TABLE      = os.environ.get("META_TABLE",      f"{DATASET}.inventory_intelligence_meta")

CURRENCY = os.environ.get("CURRENCY", "INR")
TIMEZONE = os.environ.get("TIMEZONE", "Asia/Kolkata")
ROW_CAP  = int(os.environ.get("ROW_CAP", "12000"))   # max fact rows returned to the dashboard

VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
VERTEX_MODEL    = os.environ.get("VERTEX_MODEL", "gemini-2.5-flash")
CHAT_MAX_GB     = float(os.environ.get("CHAT_MAX_GB", "1"))

CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    "Cache-Control":                "no-store",
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
    if hasattr(o, "__float__"):
        return float(o)
    return str(o)


def rows_to_dicts(job, max_results=None):
    out = []
    for r in job.result(max_results=max_results):
        d = {}
        for k, v in dict(r).items():
            if isinstance(v, (datetime, date)):
                d[k] = v.isoformat()
            elif hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                d[k] = float(v)
            else:
                d[k] = v
        out.append(d)
    return out


# ─────────────────────────────────────────────────────────────
#  BUNDLE — everything the dashboard needs, from the 4 tables only.
# ─────────────────────────────────────────────────────────────
def build_bundle():
    c = bq()
    # 1) headline KPIs (single-row meta table)
    meta_rows = rows_to_dicts(c.query(f"SELECT * FROM `{META_TABLE}` LIMIT 1"))
    meta = meta_rows[0] if meta_rows else {}

    # 2) fact rows (already jewelry-only, already computed). Cap for payload size.
    fact_sql = f"""
        SELECT * FROM `{FACT_TABLE}`
        WHERE refresh_date = (SELECT MAX(refresh_date) FROM `{FACT_TABLE}`)
        ORDER BY refill_priority_score DESC, inventory_value DESC
        LIMIT {ROW_CAP}
    """
    fact = rows_to_dicts(c.query(fact_sql))

    # 3) insights + transfers (small)
    insights = rows_to_dicts(c.query(
        f"SELECT * FROM `{INSIGHTS_TABLE}` "
        f"WHERE refresh_date = (SELECT MAX(refresh_date) FROM `{INSIGHTS_TABLE}`) ORDER BY ord"))
    transfers = rows_to_dicts(c.query(
        f"SELECT * FROM `{TRANSFERS_TABLE}` "
        f"WHERE refresh_date = (SELECT MAX(refresh_date) FROM `{TRANSFERS_TABLE}`) "
        f"ORDER BY priority_score DESC LIMIT 500"))

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "currency": CURRENCY,
        "source": "single_fact_table",
        "refresh_date": meta.get("refresh_date"),
        "refreshed_at": meta.get("refreshed_at"),
        "row_count": len(fact),
        "capped": len(fact) >= ROW_CAP,
        "kpis": meta,
        "items": fact,
        "insights": insights,
        "transfers": transfers,
    }


# ─────────────────────────────────────────────────────────────
#  AI — Vertex Gemini (chat NL→SQL + narratives)
# ─────────────────────────────────────────────────────────────
_client = None
def genai_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(vertexai=True, project=BQ_PROJECT, location=VERTEX_LOCATION)
    return _client


def gen_text(prompt, retries=2):
    last = None
    for _ in range(retries + 1):
        try:
            r = genai_client().models.generate_content(model=VERTEX_MODEL, contents=prompt)
            return (r.text or "").strip()
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


SCHEMA_HINT = f"""
You write BigQuery Standard SQL for a jewellery retailer's inventory command
centre. You may query ONLY these already-computed reporting tables (fully
qualified, always backtick-quoted). Every row is jewelry only (Silver + Coins
already excluded). Filter `refresh_date = CURRENT_DATE()` for the latest snapshot.

FACT `{FACT_TABLE}` — one row per SKU x store. Key columns:
  refresh_date DATE, store STRING, region STRING, city STRING, company STRING,
  sku STRING, item_code STRING, item_name STRING, style STRING, category STRING,
  sub_category STRING, product_type STRING, collection STRING, metal STRING,
  purity STRING, gender STRING, vendor STRING, designer STRING, mrp FLOAT,
  weight FLOAT, current_stock FLOAT, opening_inventory FLOAT, grn_received_qty FLOAT,
  inventory_value FLOAT, total_sold FLOAT, sold_today INT, sold_7 INT, sold_30 INT,
  sold_90 INT, first_sale_date DATE, last_sale_date DATE, first_grn_date DATE,
  last_grn_date DATE, days_since_last_sale INT, days_since_last_grn INT,
  inventory_age INT, avg_daily_sales FLOAT, avg_weekly_sales FLOAT,
  avg_monthly_sales FLOAT, days_cover FLOAT, cover_days FLOAT,
  inventory_turnover FLOAT, sell_through FLOAT, reorder_point INT, refill_qty INT,
  inventory_status STRING (Out of Stock|Low Stock|Over Stock|Healthy),
  movement_class STRING (Fast Moving|Slow Moving|Dead|Never Sold),
  is_out_of_stock BOOL, is_low_stock BOOL, is_over_stock BOOL, is_dead_stock BOOL,
  is_fast_moving BOOL, is_slow_moving BOOL, is_refill_required BOOL,
  stock_out_risk INT, refill_priority_score INT, health_score INT,
  ai_recommendation STRING, ai_reason STRING, ai_business_impact STRING,
  ai_priority STRING (Critical|High|Medium|Low), ai_confidence INT,
  forecast_7d FLOAT, forecast_15d FLOAT, forecast_30d FLOAT.

TRANSFERS `{TRANSFERS_TABLE}` — sku, source_store, dest_store, suggested_qty,
  expected_value_moved, priority_score.

INSIGHTS `{INSIGHTS_TABLE}` — kind, severity, title, detail.
"""

DENY = re.compile(r"\b(insert\s+into|update\s+\w|delete\s+from|drop\s+(table|view|schema|dataset)|"
                  r"create\s+(table|view|or\s+replace|schema|function|procedure)|alter\s+(table|view|schema)|"
                  r"\bmerge\s+into|truncate\s+table|grant\s+|revoke\s+)", re.I)
ALLOWED_TABLES = {FACT_TABLE, TRANSFERS_TABLE, INSIGHTS_TABLE, META_TABLE}


def gen_sql(question):
    prompt = (SCHEMA_HINT +
              "\nWrite ONE read-only SELECT (or WITH…SELECT) answering the question. "
              "Always add LIMIT (<=500). Return ONLY the SQL — no markdown, no comment.\n\n"
              f"Question: {question}\nSQL:")
    txt = gen_text(prompt)
    txt = re.sub(r"^```[a-zA-Z]*", "", txt).strip().strip("`").strip()
    return txt


def safe_sql(sql):
    s = sql.strip().rstrip(";")
    low = s.lower()
    if not (low.startswith("select") or low.startswith("with")):
        return None, "Only SELECT/WITH queries are allowed."
    if ";" in s:
        return None, "Only a single statement is allowed."
    if DENY.search(s):
        return None, "Query contains a data-modifying statement."
    for tref in re.findall(r"`([^`]+)`", s):
        if tref not in ALLOWED_TABLES:
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
    dry = c.query(safe, job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False))
    gb = (dry.total_bytes_processed or 0) / 1e9
    if gb > CHAT_MAX_GB:
        return {"question": question, "sql": safe,
                "error": f"Query would scan {gb:.1f} GB (> {CHAT_MAX_GB} GB cap)."}
    job = c.query(safe, job_config=bigquery.QueryJobConfig(maximum_bytes_billed=int(CHAT_MAX_GB * 1e9)))
    rows = rows_to_dicts(job, max_results=500)
    sample = json.dumps(rows[:30], default=jdefault)
    ans_prompt = (f"You are an inventory & merchandising strategist for a jewellery brand. "
                  f"Question: {question}\nQuery returned {len(rows)} rows. Data (first 30): {sample}\n"
                  "Answer in 2-4 crisp sentences with concrete numbers and ONE recommended action. "
                  "Currency INR (₹).")
    try:
        answer = gen_text(ans_prompt)
    except Exception as e:  # noqa: BLE001
        answer = f"(Returned {len(rows)} rows; narrative unavailable: {e})"
    return {"question": question, "sql": safe, "row_count": len(rows),
            "scanned_gb": round(gb, 3), "rows": rows, "answer": answer}


def run_insights(narrative=False):
    c = bq()
    rows = rows_to_dicts(c.query(
        f"SELECT * FROM `{INSIGHTS_TABLE}` "
        f"WHERE refresh_date = (SELECT MAX(refresh_date) FROM `{INSIGHTS_TABLE}`) ORDER BY ord"))
    out = {"insights": rows}
    if narrative:
        try:
            meta = rows_to_dicts(c.query(f"SELECT * FROM `{META_TABLE}` LIMIT 1"))
            prompt = ("You are Head of Inventory & Merchandising for Lucira, an Indian fine-jewellery "
                      "brand. Write a sharp CEO brief (short markdown sections, quantified, ₹ INR, "
                      "action-first) from this snapshot.\n\n"
                      f"KPIs: {json.dumps(meta[:1], default=jdefault)}\n"
                      f"Insights: {json.dumps(rows, default=jdefault)[:8000]}")
            out["narrative"] = gen_text(prompt)
        except Exception as e:  # noqa: BLE001
            out["narrative_error"] = str(e)
    return out


# ═════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═════════════════════════════════════════════════════════════════════════
@functions_framework.http
def inventory_intel(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS)

    action = (request.args.get("action") or "bundle").lower()
    try:
        if action == "app":
            # Serve the dashboard itself from this (already-public) endpoint, so
            # the page and its data share one origin. app.html is bundled next to
            # main.py at deploy time (deploy.sh copies it from ../dashboard/).
            try:
                with open(os.path.join(os.path.dirname(__file__), "app.html"), "r", encoding="utf-8") as fh:
                    html = fh.read()
            except OSError as e:  # noqa: BLE001
                return ("Dashboard asset not bundled: %s" % e, 500,
                        {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"})
            return (html, 200, {"Content-Type": "text/html; charset=utf-8",
                                "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})

        if action == "health":
            return (json.dumps({"ok": True, "service": "inventory-intelligence-api",
                                "model": VERTEX_MODEL, "tables": sorted(ALLOWED_TABLES)}), 200, CORS)

        if action == "chat":
            body = request.get_json(silent=True) or {}
            q = (body.get("question") or request.args.get("q") or "").strip()
            if not q:
                return (json.dumps({"error": "Provide 'question'."}), 400, CORS)
            return (json.dumps(run_chat(q), default=jdefault), 200, CORS)

        if action == "insights":
            nar = (request.args.get("narrative") or "").lower() in ("1", "true", "yes")
            return (json.dumps(run_insights(nar), default=jdefault), 200, CORS)

        # default: full bundle
        return (json.dumps(build_bundle(), default=jdefault), 200, CORS)

    except Exception as e:  # noqa: BLE001
        return (json.dumps({"error": str(e), "action": action}), 500, CORS)
