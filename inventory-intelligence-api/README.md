# Inventory Refilling Intelligence & AI Command Center — API

Backend for `dashboard/inventory-intelligence.html`. Implements the
**single-fact-table architecture**: a daily 09:00 IST BigQuery Scheduled Query
consolidates four raw sources into reporting tables; this API reads **only**
those tables; the dashboard reads only this API. No frontend query ever touches
a raw source table.

```
 Raw sources                         Scheduled Query (09:00 IST)         Serving
 ───────────                         ───────────────────────────         ───────
 Sales_overview_table  ┐
 Live_inventory        ├─►  10_build_fact.sql  ─►  reporting.inventory_intelligence_fact
 GRN                   │    20_build_...  ─────►  …_transfers / …_insights / …_meta
 Inventory_pivot       ┘                                    │
                                                            ▼
                                          inventory-intelligence-api  ─►  dashboard
```

## Why this shape
- **Cost**: the frontend scans ~a few MB/load (one partition of one table),
  not the multi-GB raw sales/GA4 history. Heavy joins run once/day, not per user.
- **Speed**: sub-second loads; every metric is pre-materialised.
- **Consistency**: one definition of "refill qty", "cover days", "dead stock",
  etc., computed in SQL — the dashboard and the AI assistant agree by construction.

## Setup (once)

### 0. Confirm the two unknown source schemas
```bash
bq query --use_legacy_sql=false < sql/00_introspect.sql
```
`Sales_overview_table` and `Live_inventory` columns are already correct in the
build SQL. If `GRN` / `Inventory_pivot` use different column names, adjust the
`grn` CTE / CONFIG aliases in `sql/10_build_fact.sql` (all casts are `SAFE_*`,
so a mismatch degrades a measure to NULL rather than failing the build).

### 1. First manual build + reconcile
```bash
bq query --use_legacy_sql=false < sql/10_build_fact.sql
bq query --use_legacy_sql=false < sql/20_build_transfers_insights.sql
bq query --use_legacy_sql=false < sql/30_reconcile.sql   # R1–R7 must pass
```

### 2. Schedule the daily refresh (09:00 IST)
```bash
./setup_scheduled_query.sh
```
Or in the BigQuery console → *Scheduled queries* → paste
`10_build_fact.sql` + `20_build_transfers_insights.sql`, schedule **09:00,
timezone (GMT+05:30) India Standard Time**.

### 3. Deploy the API
```bash
./deploy.sh            # gen2 Cloud Function, entry inventory_intel
```
IAM the runtime SA needs: `bigquery.jobUser` (project) + `bigquery.dataViewer`
(reporting dataset) + `aiplatform.user` (for the AI chat/narratives). The IAM
one-liners are at the bottom of `deploy.sh`.

### 4. Wire the dashboard
Paste the deployed URL into `CONFIG.API_BASE` in
`dashboard/inventory-intelligence.html` (or serve with `?api=<url>`; it also
reads `window.__INV_INTEL_CONFIG__` for CI injection). Status dot turns green
"Live · single fact table · as of <refresh_date>".

## Endpoints
| Route | Method | Returns |
|---|---|---|
| `?action=bundle` (default) | GET | `{kpis, items[], insights[], transfers[]}` — the whole dashboard |
| `?action=chat` | POST `{question}` | Gemini writes guarded SQL over the fact table → `{sql, rows, answer}` |
| `?action=insights[&narrative=1]` | GET | AI insight rows (+ optional CEO narrative) |
| `?action=health` | GET | ping + table list |

## Guardrails
- Chat SQL is validated by `safe_sql()`: SELECT/WITH only, single statement, no
  DDL/DML, and **only the four reporting tables** are allowed. A dry-run enforces
  a `CHAT_MAX_GB` scan cap before execution.
- Scope (jewelry only — Silver + Coins excluded) is enforced in the build SQL, so
  it cannot be bypassed from the frontend or the chat.

## Local dev
No system Python on the build machine — use gcloud's bundled Python:
```powershell
$py = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\platform\bundledpython\python.exe"
& $py -m venv .venv ; .\.venv\Scripts\pip install -r requirements.txt
$env:BQ_PROJECT="lucirajewelry-prod"; $env:REPORT_DATASET="lucirajewelry-prod.reporting"
.\.venv\Scripts\functions-framework --target=inventory_intel --port=8080
```
Then open the dashboard with `?api=http://localhost:8080`.

## Config
All via env vars — see `.env.example`. Tune business parameters (lead time,
target cover, dead-stock threshold, velocity window) in the `DECLARE` block at
the top of `sql/10_build_fact.sql`.
