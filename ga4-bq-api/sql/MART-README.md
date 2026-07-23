# Lucira Sales Intelligence — mart pipeline

The dashboard [`dashboard/sales-mart-dashboard.html`](../../dashboard/sales-mart-dashboard.html)
is rebuilt around the flat **marketing × product mart** `lucirajewelry-prod.ga4_data.ga4_data`
(NOT the GA4 raw export). This folder's *other* files (`fact_sessions.sql`, `00_setup.sql`,
`10..15_*.sql`, `snapshot_export.sql`) belong to the **separate GA4-export dashboard**
(`ga4-dashboard.html`) and are unrelated to this mart pipeline.

## The source table
`ga4_data.ga4_data` — 7.55M rows, 16.6 GB, `event_date` 2025-05-03 → present.
Grain: one row per `event_date × source/medium/campaign/channel_type × geo × item_id`,
joined to the product master. **Not partitioned.**

Column semantics that matter:
- **Additive across rows (SUM is correct):** `pdp_views, add_to_cart, remove_from_cart,
  add_to_wishlist, begin_checkout, add_shipping_info, purchase, revenue, plp_impressions, plp_click`.
- **`sessions` FANS OUT** — the same value is replicated on every product row of a traffic
  group, so summing it inflates ~25×. We **de-duplicate**: `MAX(sessions)` once per
  `SESSKEY = (event_date, source, medium, campaign_name, channel_type, country, state, city)`,
  then sum. Labelled "attributed sessions (est.)". No session ID exists, so it's an estimate.
- **`category` = DEVICE** (mobile/desktop/tablet/smart tv), **not** product category.
- **`product_type` = product category** (Rings, Earrings, Necklaces, …).
- **`channel_type` / `funnel` are ~99.9% "Others"** → attribution leads on `source`/`medium`.
- Not present: user id (no cohorts/LTV/new-vs-returning), browser/OS, page paths, languages, engagement time.

## Objects created
| Object | What |
|---|---|
| `ga4_data.ga4_data_part` | Partitioned+clustered mirror (`PARTITION BY event_date CLUSTER BY channel_type,item_id`). Snapshot reads only the 90-day window → fast/cheap. |
| `ga4_data.mart_refresh_and_snapshot()` | Stored procedure: rebuilds the mirror, then EXPORTs the snapshot JSON. See [`mart_procedure.sql`](mart_procedure.sql). |
| `gs://lucirajewelry-prod-dashboards/ga4/mart-latest-*.json` | The ~88 KB daily snapshot the dashboard downloads (public object, CORS `*`). |
| [`mart_snapshot.sql`](mart_snapshot.sql) | Stand-alone/manual version of the export (same query as the procedure's step 2). |

## Snapshot contract (what the dashboard consumes)
`generated_at, source, currency, notes, window{from,to,days}`, `totals{…}`, `daily[]`
(per-day, EXACT — drives all date-sliced KPIs/trend/funnel), `funnel[]`, and window-level
breakdowns: `sources, sources_sess, mediums, sourceMedium, campaigns, channels, countries,
states, cities, devices, genders, materials, productTypes, collections, priceRanges,
marginRanges, products[]` (top 100 by revenue w/ image, price, margin, ageing, COGS).

> Date range (7/30/90) slices KPIs, trend and funnel from `daily[]` exactly. Dimensional
> breakdowns are window-level (last 90 days) leaderboards, captioned as such in the UI.

## Daily automation (set up ONE scheduled query)
Create a **BigQuery Scheduled Query** (asia-south1) — either in the console or via CLI:

```
bq mk --transfer_config --project_id=lucirajewelry-prod --location=asia-south1 \
  --data_source=scheduled_query --display_name="Mart refresh + snapshot" \
  --schedule="every day 03:30" \
  --params='{"query":"CALL `lucirajewelry-prod.ga4_data.mart_refresh_and_snapshot`()"}'
```

`03:30 UTC = 09:00 IST`. That single call rebuilds the mirror and rewrites the snapshot JSON.
(Re-create the procedure after any edit: pipe `mart_procedure.sql` to `bq query` via stdin —
the query is too long for an inline arg; use `bq query ... < mart_procedure.sql`.)

## Cost
- Mirror rebuild: full-scans the 16.6 GB source once/day ≈ 500 GB/mo — inside BigQuery's
  1 TB/mo on-demand free tier (effectively free).
- Snapshot export: scans only the 90-day window of the partitioned mirror (~few GB).
- Dashboard load: downloads one ~88 KB static JSON — **zero** per-view BigQuery cost.

## Dashboard wiring
`CONFIG.SNAPSHOT_URL` in `sales-mart-dashboard.html` → the public `mart-latest-*.json`.
CI/host can override via `window.__MART_CONFIG__` (marker `MART_CONFIG_INJECT`).
