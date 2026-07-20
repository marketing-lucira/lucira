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

## 6. Known modelling caveats (documented, not hidden) — verified on live data 2026-07-20
- **Sales ↔ inventory key mismatch (the big one).** Live_inventory uses
  `item_code`/`style_code` (e.g. `ALR-0289`/`0289`); Sales & GRN use a different
  SKU convention (`Full_sku=LJ-B00002-…`, `style=R00193`). Velocity is joined by
  `item_code=Full_sku` **OR** `style_code=style` (coalesced) — the best available
  keys — which matches only **~34 % of items (1,005 / 2,969)**. Items with no
  match surface as **Never Sold**; some of these genuinely sold under a
  non-matching code. The dashboard shows a standing insight *"Sales matched on N
  of M items"* so the number is never hidden. **Fix path:** add a SKU crosswalk
  table and join on it — the build is structured so only the `item_vel` CTE
  changes.
- **Velocity is network-wide, allocated to stores by on-hand share.** On-hand is
  exact per store (`location_name`); network velocity per item is distributed to
  its store rows in proportion to on-hand, so KPI sums stay exact and days-of-cover
  equals the item's network cover. `store_filter` in Live_inventory is uniformly
  `'Store'` (unusable) — `location_name` is the real store.
- **Stock is ~82 % in the central "Finish Goods" warehouse**, so store-to-store
  transfer opportunities are currently sparse (stock isn't distributed to stores).
- **GRN** (`Lucira_Prod.`\``GRN table`\`` — the name has a space) is HO-only, joined
  by `style`. **Opening inventory** is reconstructed (`on-hand + sold − received`).
- **`mrp`** is approximated by `item_rate` (no list-price column in Live_inventory);
  `gender`/`designer` have no source column (NULL). All casts are `SAFE_*`.

## 7. Files
```
inventory-intelligence-api/
  sql/00_introspect.sql            confirm the two unknown source schemas
  sql/10_build_fact.sql            the consolidated fact table (heart)
  sql/20_build_transfers_insights.sql  transfers + insights + meta
  sql/30_reconcile.sql             R1–R7 certification queries
  sql/40_build_procedure.sql       generated: wraps 10+20 into a stored procedure
                                   reporting.build_inventory_intelligence() that
                                   the daily scheduled query CALLs
  main.py                          API (bundle / chat / insights / health)
  deploy.sh                        deploy the Cloud Function
  setup_scheduled_query.sh         create the daily 09:00 IST scheduled query
  requirements.txt / .env.example / .gcloudignore
  README.md                        setup + endpoints + guardrails
  ARCHITECTURE.md                  this file
dashboard/
  inventory-intelligence.html      the premium command center (14 tabs)
```

## 8. LIVE STATUS (provisioned 2026-07-20)
Everything below is **already deployed** in `lucirajewelry-prod`:

| Component | Value |
|---|---|
| Fact tables | `reporting.inventory_intelligence_{fact,transfers,insights,meta}` (built) |
| Build procedure | `reporting.build_inventory_intelligence()` |
| Scheduled query | `inventory_intelligence_daily_0900_IST` — `every day 03:30` UTC = **09:00 IST** — runs `CALL …build_inventory_intelligence()` |
| API (Cloud Run gen2) | `inventory-intel-api`, asia-south1 → **https://inventory-intel-api-3mvv5mdr2q-el.a.run.app** |
| Dashboard | `dashboard/inventory-intelligence.html`, `CONFIG.API_BASE` wired to the URL above |
| Live snapshot | 2,969 rows · 2,294 items · 8 stores · **₹17.55 Cr** · scope clean (0 silver/coin) |

### Reproduce / update the pipeline
1. `bq query < sql/00_introspect.sql` — confirm source schemas (already done).
2. Edit `sql/10_build_fact.sql` / `20_build_transfers_insights.sql` as needed.
3. Regenerate the procedure: concatenate 10+20 (minus their DECLARE/CREATE SCHEMA
   lines) into `CREATE OR REPLACE PROCEDURE …build_inventory_intelligence() BEGIN
   <declares> … END`, then create it. The daily schedule picks up the new logic
   automatically (it only `CALL`s the procedure).
4. `bq query "CALL \`lucirajewelry-prod.reporting.build_inventory_intelligence\`()"` to rebuild now.
5. `bq query < sql/30_reconcile.sql` → R1–R7 must pass.
6. `./deploy.sh` (or `gcloud functions deploy inventory-intel-api …`) to update the API.

> **Windows/bq note:** the bq CLI's console codec is cp1252. Set
> `PYTHONUTF8=1` before piping SQL that contains any non-ASCII (the box-drawing
> comment borders), or the CLI raises a UnicodeEncodeError. The SQL itself is
> otherwise ASCII (currency rendered as `Rs`, not `₹`).
