# Sales Analytics — data API

Thin Cloud Function that feeds `dashboard/sales-dashboard.html` from the
**Ornaverse ERP** BigQuery table
`lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`.

Same architecture as `gcp-cost-api` / `zoho-crm-api`: the function is a **dumb
data pump**; all analytics (KPIs, trends, product/style/customer ranking,
market-basket, selling-days, inventory movement, AI insights) run **client-side**
in the dashboard.

> The dashboard **works immediately on built-in sample data** — you only need
> this API for live numbers.

## Locked business rules (final validation pass)

These are enforced in `main.py` and mirrored in the dashboard. Nothing comes from
any other table, and no value is manually mapped.

1. **Gross Sales** = `SUM(gross_amount)` straight from `Sales_Overview`. Never derived.
2. **Net Sales** = **Gross ÷ 1.03** (3% GST). Computed here, not read from a net column.
   Change the factor with the `GST_DIVISOR` env var.
3. **Sale Type** = MTO / RTS / Return / Exchange / Other — each totalled separately
   (own KPI + chart). Returns/Exchanges keep their sign from the table. Normalise your
   ERP's raw spellings in `SALE_TYPE_MAP` in `main.py`.
4. **Dedupe** = a row is a duplicate **only** when `gross + sale_date + document_no +
   net_weight` are **all** identical. Any difference on one → kept as a separate
   transaction. Done in SQL (`ROW_NUMBER` over those four keys); the dashboard also
   shows raw vs deduped counts in its **Validation** tab.
5. **Categories** = read dynamically from the `category` column. Never hardcoded.

**Reconcile against BigQuery:** run `queries.sql` R1–R6 in the console and compare to
the dashboard's Validation tab. `R2.gross_sales` must equal every "Gross Sales" KPI;
`R4` proves daily/weekly/monthly/quarterly/yearly all sum to the same grand total;
`R6` lists the exact duplicate rows that will be dropped so you can audit them first.

---

## Step 0 — Introspect the table & fill `COLMAP` (do this first)

The real column names in `Sales_overview_table` are almost certainly different
from the logical names the dashboard uses. Map them **once** in the `COLMAP`
dict at the top of `main.py`. Nothing else needs editing — every query is built
from `COLMAP`.

Dump the live schema:

```bash
bq query --use_legacy_sql=false \
'SELECT column_name, data_type
 FROM `lucirajewelry-prod.ornaverse_erp_administration`.INFORMATION_SCHEMA.COLUMNS
 WHERE table_name = "Sales_overview_table" ORDER BY ordinal_position'
```

Then in `main.py` set each `COLMAP` value to the matching physical column (or
`None` if the column doesn't exist — the dependent metric degrades gracefully
and the dashboard hides/flags it, instead of the query erroring):

```python
COLMAP = {
  "order_date":   "invoice_date",   # ← your real column
  "net":          "net_amount",
  "style":        "style_no",
  "customer_id":  "customer_id",
  "cogs":         None,             # no COGS column → margin views hidden
  "stock_qty":    None,             # no stock column → inventory movement degrades to sales-velocity
  ...
}
```

The `capabilities` block in the JSON response tells the dashboard which
column-dependent sections to show (`margin`, `inventory`, `selling_days`,
`customer`, `salesperson`).

## Step 1 — Permissions

The function's runtime service account needs:
- `roles/bigquery.dataViewer` on the `ornaverse_erp_administration` dataset,
- `roles/bigquery.jobUser` on `BQ_PROJECT`.

```bash
gcloud projects add-iam-policy-binding lucirajewelry-prod \
  --member="serviceAccount:SA_EMAIL" --role="roles/bigquery.jobUser"
bq add-iam-policy-binding --member="serviceAccount:SA_EMAIL" \
  --role="roles/bigquery.dataViewer" \
  lucirajewelry-prod:ornaverse_erp_administration
```

## Step 2 — Deploy

```bash
cd sales-api
gcloud functions deploy sales-data \
  --gen2 --runtime=python312 --region=asia-south1 \
  --source=. --entry-point=sales_data --trigger-http --allow-unauthenticated \
  --set-env-vars 'BQ_PROJECT=lucirajewelry-prod,SALES_TABLE=lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table,TIMEZONE=Asia/Kolkata,CURRENCY=INR,WINDOW_DAYS=400'
```

See `.env.example` for all variables. Test it:

```bash
curl "https://asia-south1-lucirajewelry-prod.cloudfunctions.net/sales-data?days=400&debug=1" | head -c 800
```

`debug=1` echoes the row counts and the resolved `COLMAP` — the fastest way to
confirm your mapping is right.

## Step 3 — Wire the dashboard

In `dashboard/sales-dashboard.html`, set:

```js
const CONFIG = { API_BASE: "https://asia-south1-lucirajewelry-prod.cloudfunctions.net/sales-data", … }
```

Reload — the status dot turns green: **“Live · Ornaverse ERP · as of &lt;date&gt;.”**

## Step 4 — Daily auto-refresh at 9:00 AM IST

Two independent refreshers; use either or both.

**(a) Browser-side (already built in):** the dashboard re-fetches the API every
`CONFIG.REFRESH_MS` (default 60 min) whenever it's open, and shows a live
countdown. Good enough if a screen keeps it open.

**(b) Server-side warm at 09:00 IST (recommended):** BigQuery has no push, so we
schedule a hit that keeps the result fresh / warms any cache. Cloud Scheduler
runs in UTC, and **09:00 IST = 03:30 UTC**:

```bash
gcloud scheduler jobs create http sales-refresh-0900-ist \
  --location=asia-south1 \
  --schedule="30 3 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="https://asia-south1-lucirajewelry-prod.cloudfunctions.net/sales-data?days=400" \
  --http-method=GET
```

(`--time-zone="Asia/Kolkata"` lets you write `"0 9 * * *"` directly if you
prefer — Scheduler converts it. The `30 3 * * *` UTC form is the fallback.)

> **Incremental refresh:** the detail query is windowed (`WINDOW_DAYS`, default
> 400 days) and partition-pruned on the date column, so each refresh scans only
> recent partitions, not the whole table — cheap and fast. If your table isn't
> partitioned/clustered on the date column, add it: it turns the daily refresh
> from a full-table scan into a few-partition read.

---

## Response shape

```jsonc
{
  "asOf": "2026-07-15",
  "currency": "INR", "gst_divisor": 1.03,
  "capabilities": { "margin": false, "inventory": false, "selling_days": false,
                    "customer": true, "salesperson": true, "sale_type": true, "weights": true },
  "validation": { "raw_rows": 41230, "deduped_rows": 40876, "raw_gross": 812340000,
                  "returned_rows": 40876, "returned_gross": 807110000,
                  "dedup_key": "gross + sale_date + document_no + net_weight" },
  "items": [                        // one DEDUPED order LINE within the window
    { "date":"2026-07-15","document_no":"INV-88231","order_id":"INV-88231","customer_id":"C-4471",
      "customer_name":"…","city":"Mumbai","state":"Maharashtra","region":"West",
      "sku":"LR-2231","product_name":"Ring","style":"ST-1180",
      "category":"Diamond Jewellery","collection":"Aurelia","metal":"Gold 18K","sale_type":"RTS",
      "qty":1,"gross":86000,"net":83495.15,"discount":4300,
      "gross_weight":7.42,"net_weight":6.88,"cogs":null,
      "store":"Bandra","salesperson":"Farha","channel":"Retail" }
  ],
  "styleRef": [                     // per-style, FULL history (selling-days, inventory age)
    { "style":"ST-1180","category":"Ring","metal":"Gold 18K",
      "first_sale_date":"2025-02-11","last_sale_date":"2026-07-10",
      "units_all_time":37,"first_inventory_date":null,"stock_qty":null }
  ],
  "customerRef": [                  // per-customer, FULL history (new/repeat, LTV)
    { "customer_id":"C-4471","first_order_date":"2024-11-02","last_order_date":"2026-07-15",
      "lifetime_orders":4,"lifetime_net":315400 }
  ]
}
```

## Live vs sample — the honest limitations

| Section | Live from `Sales_overview_table` | Needs an extra feed |
|---|---|---|
| Executive KPIs, Trends, Product/Style/Category/Pricing/Geo/Time/Sales-team, Customer & Repeat analysis, Product combinations | ✅ fully accurate | — |
| **Gross margin** (Product/Style margin, "highest-margin") | only if a **COGS/cost** column exists → set `COLMAP["cogs"]` | else hidden (flagged in UI) |
| **Inventory movement** (stock on hand, overstock, low-stock, sell-through, stock-turnover) | needs **stock_qty** in the table | else degrades to **sales-velocity** movement classes (Fast/Slow/Dead by units & recency) — still useful, no stock levels |
| **Selling-days** (first-inventory → first-sale) | needs an **inventory-in date** per style | else "days to sell" uses first-sale as the anchor and is flagged as approximate |

The **sample dataset ships every column populated** (including COGS, stock and
inventory-in dates) so you can see the full intended UX before wiring live data.

---

## Metric definitions

| Metric | Definition |
|---|---|
| **Gross Sales** | `SUM(gross_amount)` straight from the table (rule 1). The headline. Also split by sale type: **MTO / RTS / Return / Exchange / Other**. |
| **Net Sales** | **Gross ÷ 1.03** (rule 2, 3% GST). Computed, never read from a column. |
| **Total Orders** | `COUNT(DISTINCT order_id)`. |
| **AOV** | Net Sales ÷ Orders. |
| **ASP** | Net Sales ÷ Units (avg selling price per unit). |
| **Avg Products per Order** | Units ÷ Orders. |
| **New vs Repeat customer** | by `customerRef.first_order_date`: an order is *repeat* if the customer's first-ever order predates it. Repeat % = repeat orders ÷ orders. |
| **Revenue per Customer** | Net ÷ distinct customers. **per Product / per Style** analogous. |
| **Days to Sell (style)** | `first_sale_date − first_inventory_date`. No inventory feed → anchored on first_sale (approx, flagged). |
| **Movement class** | Fast / Slow / Dead by units sold in the window + days since last sale (thresholds in the dashboard's `CONFIG.MOVEMENT`). |
| **Sell-Through Rate** | units sold ÷ (units sold + stock on hand). Needs stock. |
| **Stock Turnover** | units sold in window ÷ avg stock. Needs stock. |
| **Growth % / Variance** | current period vs previous (day/week/month/year) on the selected metric. |
| **Contribution %** | an item's share of the total (revenue/units) in scope. |

## Export

The dashboard exports **CSV** and **Excel (.xlsx)** per panel and for the full
filtered dataset, respecting all active filters — no server round-trip.
