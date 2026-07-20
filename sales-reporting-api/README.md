# Lucira Sales Intelligence — Reporting Layer (10:00 AM IST)

## ✅ DEPLOYED & LIVE (lucirajewelry-prod, 2026-07-20)
| Resource | Value |
|---|---|
| Reporting tables | `sales_dashboard.sales_reporting` (2,100 rows) · `_reporting_style` (527) · `_reporting_customer` (981) |
| Snapshot service | `https://sales-snapshot-3mvv5mdr2q-el.a.run.app` (gen2, asia-south1, public) |
| Public snapshot | `https://storage.googleapis.com/lucira-dashboards/sales/latest.json` |
| Daily refresh | Cloud Scheduler **`sales-reporting-refresh`** → `POST /refresh`, `0 10 * * *` **Asia/Kolkata** |
| Dashboard wiring | `CONFIG.SNAPSHOT_URL` already points at the public snapshot — status pill shows *Live · reporting layer · as of 2026-07-19* |

`POST /refresh` rebuilds the reporting tables (runs `sql/refresh_reporting.sql` as one BQ
script) **and** writes the snapshot — one scheduler, one atomic daily job (~27 s).
`POST /snapshot` writes the snapshot only; `GET /` serves the cached snapshot.
Certified on live data: raw 3,016 → deduped 2,100 (916 exact dupes removed),
gross ₹7.331 Cr, net ₹7.118 Cr (= gross ÷ 1.03).


The dashboard [`dashboard/sales-intelligence.html`](../dashboard/sales-intelligence.html)
**never queries BigQuery on open**. It reads one static JSON snapshot that this
service rebuilds once a day. No repeated query cost while executives explore.

```
Sales_overview_table  ──(10:00 IST scheduled query)──►  sales_dashboard.sales_reporting   (the reporting table)
                                                        + _reporting_style / _reporting_customer (aux refs)
                                                                    │
                                              (10:10 IST Cloud Scheduler → /snapshot)
                                                                    ▼
                                          gs://<bucket>/sales/latest.json   (public static snapshot)
                                                                    │
                                                        browser fetch, once/day
                                                                    ▼
                                          dashboard/sales-intelligence.html  (< 3 s load, cached in localStorage)
```

## Single source of truth & business rules
Everything comes from `lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table`
— no joins. Rules are enforced **once**, in [`sql/refresh_reporting.sql`](sql/refresh_reporting.sql):

1. **Gross Sales** = `gross_amount` summed directly (Returns negative).
2. **Net Sales** = `gross / 1.03` (3% GST), computed.
3. **Dedup** = drop a row only if `gross + date + document_no + net_weight` all match.
4. **Sale Type** = normalized to `MTO / RTS / TAH / Return / Exchange / Other`.
5. **Categories** = read dynamically from the table.

## Files
| File | Purpose |
|---|---|
| `sql/refresh_reporting.sql` | The **daily scheduled query**. Builds the reporting table + two aux ref tables. Edit only the aliased physical column names if the schema changes. |
| `main.py` | Cloud Run function `sales_snapshot`. `/snapshot` rebuilds & writes the static JSON; `/` serves the latest. |
| `deploy.sh` | Dataset build, 10:00 IST scheduled query, public bucket, function deploy, 10:10 IST scheduler. |

## Go live (someone with GCP deploy rights)
> This machine's `gcloud`/ADC tokens were expired at build time — run `gcloud auth login`
> **and** `gcloud auth application-default login` in an interactive terminal first, then:

1. **Build + schedule the reporting table**
   ```bash
   bash deploy.sh
   ```
   (Or, in the BigQuery console: paste `sql/refresh_reporting.sql`, region `asia-south1`,
   schedule **every day 10:00**, timezone **Asia/Kolkata**.)

2. **Grant the function runtime service account**
   - `roles/bigquery.dataViewer` on `sales_dashboard` **and** the source dataset
   - `roles/bigquery.jobUser` on the project
   - `roles/storage.objectAdmin` on the snapshot bucket

3. **Wire the dashboard** — set in `dashboard/sales-intelligence.html`:
   ```js
   const CONFIG = { ...,
     SNAPSHOT_URL: "https://storage.googleapis.com/lucira-dashboards/sales/latest.json",
     REFRESH_HOUR_IST: 10, ... };
   ```
   The status pill turns green — *“Live · reporting layer · as of &lt;date&gt;”*.
   Leave `SNAPSHOT_URL` empty to keep the built-in sample.

## Cost & performance
- Dashboard opens read a ~single static object → **zero** BigQuery cost, < 3 s load.
- BigQuery is touched **twice a day**: the 10:00 refresh (partition-pruned to 540 days)
  and the 10:10 snapshot read of the already-small reporting table.

## Capability gating (honest)
`Sales_overview_table` has **no COGS** (Profit/Margin), **no stock column**
(true dead-stock/overstock), **no salesperson** (Sales-Team leaderboard), and **no
exchange/return-reason** fields. Those KPIs/sections show a clear *“activates when
the column exists”* state and light up automatically once the reporting SQL exposes them.
Everything else — revenue, orders, AOV/ASP, customers, retention, RFM, MTO/RTS,
returns, stores, products, geography — is exact.
