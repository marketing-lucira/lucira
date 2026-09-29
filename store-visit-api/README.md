# Store Visit Campaign Intelligence — reporting API

Cloud Run function that keeps `dashboard/store-visit-intelligence.html` fed with a
static JSON snapshot, mirroring `walkin-source-api/` exactly. The dashboard never
queries BigQuery directly — it fetches one public JSON object.

## Endpoints (entry point `store_visit_snapshot`)
- `GET /` — serve the latest snapshot from GCS (rebuilds inline if the object is missing)
- `GET|POST /snapshot` — rebuild the JSON from the 5 reporting tables + write to GCS
- `GET|POST /refresh` — run `sql/refresh_reporting.sql` (rebuild all 5 tables) THEN snapshot
  (this is what Cloud Scheduler calls daily at 10:00 IST)

## Reporting tables (in `lucirajewelry-prod.ds_imputed_reporting`)
- `store_visit_activity` — Webengage_Final rows for the 8 store-visit campaigns, channel-normalized
- `store_visit_targets` — one row per distinct valid-mobile targeted customer
- `store_visit_target_flags` — **unmasked, BigQuery-internal only** — has_deal/has_sale booleans
  per targeted mobile, used solely to compute aggregate counts without ever re-joining on the
  masked mobile (which would risk last-4-digit collisions between different numbers)
- `store_visit_deal_outcomes` — Zoho Deals matched to targets, PII masked in the SELECT
- `store_visit_sale_outcomes` — sales_oneview_data purchases matched to targets, PII masked,
  with a dynamic `flagged` column for same-day ₹0 duplicate-looking rows

## Deploy
```
cd store-visit-api
./deploy.sh
```
Requires `gcloud auth login` + `gcloud auth application-default login` on a principal with
BigQuery + Cloud Run + Scheduler + Storage admin, and `bq`/`gcloud` on PATH.

## Live URLs (after deploy)
- Cloud Run service: printed by deploy.sh (`store-visit-snapshot`, asia-south1)
- Public snapshot: `https://storage.googleapis.com/lucira-dashboards/store-visit/latest.json`
- Cloud Scheduler job: `store-visit-refresh`, `0 10 * * *` Asia/Kolkata

## PII
Only `mobile_masked` (`"••••••NNNN"`, last 4 digits real) ever leaves BigQuery via this
snapshot — same model as `walkin-source-api`. Full unmasked mobile numbers never appear in
the JSON at any layer, including `store_visit_target_flags` (which is queried for aggregate
COUNTIF() only, never selected as rows into the snapshot).
