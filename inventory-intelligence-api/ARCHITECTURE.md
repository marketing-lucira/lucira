# Inventory Refilling Intelligence & AI Command Center — Architecture

A single-source-of-truth inventory decision system for Lucira Jewelry's
Merchandising, Inventory, Retail and Management teams. It answers: **what to
refill, what to transfer, what to stop making, and what to liquidate** — with a
reason, business impact, priority and confidence on every recommendation.

## 1. Design principle — one consolidated fact table

The frontend **never** queries a raw source. A daily BigQuery Scheduled Query
consolidates four sources into a handful of reporting tables; the API reads only
those; the dashboard reads only the API.

```
 RAW SOURCES (BigQuery)                                   REPORTING (rebuilt daily 09:00 IST)
 ─────────────────────                                    ─────────────────────────────────────
 ornaverse_erp_administration.Sales_overview_table ─┐
 ds_imputed_reporting.Live_inventory                ├─► reporting.inventory_intelligence_fact   (sku × store)
 Lucira_Prod.GRN                                    │   reporting.inventory_intelligence_transfers
 test.Inventory_pivot                               ┘   reporting.inventory_intelligence_insights
                                                        reporting.inventory_intelligence_meta
                                                                        │
                          inventory-intelligence-api  (Cloud Function) ─┤ reads ONLY the 4 tables
                                                                        │
                          dashboard/inventory-intelligence.html ────────┘ reads ONLY the API
```

**Why:** raw sales + GA4 history is multi-GB; joining it per page-load would be
slow and expensive. Doing the joins **once/day** and serving a pre-computed
fact table makes every dashboard load scan a few MB and return sub-second, and
guarantees the dashboard, the AI assistant and the recommendation engine all use
**one definition** of every metric.

## 2. Scope rule (enforced at the source)

Jewelry only. **Silver** metal and **every Coin/bullion** product are filtered
out in the build SQL (`10_build_fact.sql`), so they cannot reappear in any KPI,
chart, recommendation, insight, transfer or chat answer — the exclusion cannot
be bypassed from the frontend.

## 3. The fact table (`inventory_intelligence_fact`)

One row per **SKU × store**, partitioned by `refresh_date`, clustered by
`store, category, inventory_status`. Columns fall into four groups:

| Group | Columns |
|---|---|
| **Dimensions** | store, location, region, city, company, sku, item_code, item_name, style, category, sub_category, product_type, collection, metal, purity, stone, gender, vendor, designer, image, tags, mrp, weight |
| **Base measures** | current_stock, opening_inventory, grn_received_qty, inventory_value, allocated, total_sold, revenue_all, sold_today/7/30/90/180, pdp_views, add_to_cart, begin_checkout |
| **Dates & durations** | first/last sale, first/last GRN, first/last stock, days_since_last_sale, days_since_last_grn, days_grn_to_first_sale, inventory_age, active_sale_days |
| **Computed intelligence** | avg_daily/weekly/monthly_sales, days_cover, inventory_turnover, sell_through, reorder_point, refill_qty, inventory_status, movement_class, is_* flags, stock_out_risk, refill_priority_score, health_score, ai_recommendation, ai_reason, ai_business_impact, ai_priority, ai_confidence, forecast_7d/15d/30d |

### Business logic (all in SQL)
- **avg_daily_sales** — trailing-90 units ÷ 90 (→ 30d → lifetime fallback).
- **days_cover** — on-hand ÷ avg_daily_sales (999 = no demand).
- **inventory_turnover** — (90-day sold × 4) ÷ on-hand (annualised).
- **sell_through** — sold ÷ (sold + on-hand).
- **refill_qty** — max(0, run-rate × `TARGET_COVER_DAYS` − on-hand).
- **reorder_point** — run-rate × `LEAD_TIME_DAYS`.
- **inventory_status** — Out of Stock / Low Stock / Over Stock / Healthy.
- **movement_class** — Fast Moving / Slow Moving / Dead / Never Sold.
- **stock_out_risk (0-100)**, **refill_priority_score (0-100)**, **health_score (0-100)** — transparent weighted formulas.
- **ai_recommendation** — a documented decision tree (below).

### Recommendation decision tree
| Condition | Recommendation | Priority |
|---|---|---|
| OOS with live demand | Refill Immediately | Critical |
| cover < lead time | Refill Immediately | Critical |
| cover < target | Refill Next Week | High |
| never sold & GRN > 180d | Stop Manufacturing | Medium |
| idle > 270d & value ≥ ₹1L | Liquidation Required | High |
| dead > 180d | Promotional Discount | High |
| over-stocked (cover > 180d) | Transfer From Another Store | Medium |
| 90d demand ≥ 10 & cover < target | Increase Manufacturing | High |
| otherwise | No Refill Required | Low |

Each row also carries `ai_reason`, `ai_business_impact` and a data-sufficiency
`ai_confidence`.

## 4. Derived tables
- **transfers** — for each SKU, surplus stores → shortage stores, `suggested_qty
  = min(protected surplus, need)`. Recommends moving stock **before** manufacturing.
- **insights** — auto business insights (stock-out risk, aging, dead capital,
  scale/stop production, store urgency, best category, transfer value).
- **meta** — one-row KPI headline rollup for the executive strip.

## 5. Tunable parameters
Edit the `DECLARE` block at the top of `sql/10_build_fact.sql`; the next 09:00
run applies them:

| Param | Default | Meaning |
|---|---|---|
| `LEAD_TIME_DAYS` | 21 | replenish/manufacture lead time |
| `TARGET_COVER_DAYS` | 60 | desired days-of-cover after refill |
| `LOW_COVER_DAYS` | 15 | Low Stock threshold |
| `OVER_COVER_DAYS` | 180 | Over Stock threshold |
| `DEAD_DAYS` | 180 | dead-stock threshold |
| `VELOCITY_WINDOW` | 90 | run-rate window |

## 6. Known modelling caveats (documented, not hidden)
- **Store ↔ sales-code mapping is approximate.** On-hand is per store (from
  Live_inventory); sales velocity is **network-wide by SKU** because
  `company_code` does not map 1:1 to `Store_name`. Days-of-cover therefore uses
  network run-rate against per-store on-hand. The crosswalk lives in the
  `store_map` CTE — extend it as mappings are confirmed.
- **Opening inventory** is reconstructed (`on-hand + sold − received`); an exact
  opening needs a historical snapshot table.
- **GRN / Inventory_pivot column names** are assumed until `00_introspect.sql`
  is run; all casts are `SAFE_*` so a mismatch degrades a measure to NULL rather
  than failing the build.

## 7. Files
```
inventory-intelligence-api/
  sql/00_introspect.sql            confirm the two unknown source schemas
  sql/10_build_fact.sql            the consolidated fact table (heart)
  sql/20_build_transfers_insights.sql  transfers + insights + meta
  sql/30_reconcile.sql             R1–R7 certification queries
  main.py                          API (bundle / chat / insights / health)
  deploy.sh                        deploy the Cloud Function
  setup_scheduled_query.sh         create the daily 09:00 IST scheduled query
  requirements.txt / .env.example / .gcloudignore
  README.md                        setup + endpoints + guardrails
  ARCHITECTURE.md                  this file
dashboard/
  inventory-intelligence.html      the premium command center (14 tabs)
```

## 8. Go-live checklist
1. `bq query < sql/00_introspect.sql` → adjust GRN/Inventory_pivot aliases if needed.
2. `bq query < sql/10_build_fact.sql` then `20_build_transfers_insights.sql`.
3. `bq query < sql/30_reconcile.sql` → R1–R7 must pass (scope = 0 silver/coin, no NULL leakage).
4. `./setup_scheduled_query.sh` (or console: 09:00 IST, GMT+05:30).
5. `./deploy.sh` → grant the runtime SA `bigquery.jobUser` + `bigquery.dataViewer` + `aiplatform.user`.
6. Paste the API URL into `CONFIG.API_BASE` in the dashboard (or serve `?api=<url>`).
7. Status dot turns green *Live · single fact table · as of <refresh_date>*.
