# Walk-in Source Intelligence — reporting layer

Backend for `dashboard/walkin-source-intelligence.html`. Follows the exact same
pattern as `sales-reporting-api/` (see that folder for the sibling implementation).

## What it does

1. **`sql/refresh_reporting.sql`** — rebuilds two BigQuery tables in
   `lucirajewelry-prod.ds_imputed_reporting`:
   - `customer_master_source` — every normalized mobile number seen in Shopify,
     WebEngage, Zoho Deals, or Zoho Leads, with a presence flag per source.
   - `walkin_channel_final` — every store-visit row in `Walkin_marge`, matched
     against the above with channel priority **Shopify > WebEngage > Zoho Deals
     > Zoho Leads > Direct Walkin**, plus store/city/state/region and a New/Repeat
     signal derived from repeat visits by the same phone number.

2. **`main.py`** — a Cloud Run function (`walkin_snapshot`) with three routes:
   - `POST /refresh` — reruns the SQL above, then rebuilds and republishes the
     snapshot. This is what Cloud Scheduler calls at **10:00 IST daily**.
   - `POST /snapshot` — rebuilds/republishes the snapshot only (no table rebuild).
   - `GET /` — serves the last published snapshot from GCS (rebuilds on the fly
     if nothing has been published yet).

3. The snapshot is written to **`gs://lucira-dashboards/walkin-source/latest.json`**
   (the same public bucket already used by the Sales Intelligence dashboard).
   The dashboard's `CONFIG.SNAPSHOT_URL` already points here — once deployed,
   no dashboard code changes are needed; it just goes live.

## PII handling (important)

That GCS object is **public and unauthenticated** — anyone with the URL can
read it, same publication model already in use for Sales Intelligence. Because
this dataset includes real customer names and phone numbers (not just
aggregate revenue), `main.py`'s `build_snapshot()` query masks PII **before it
ever leaves BigQuery**:

- `customer_first_name` — first token of the name only (e.g. "Priya", not
  "Priya Sharma").
- `mobile_masked` — last 4 digits only (e.g. `"••••••6210"`).

Full unmasked detail is never selected into this process at all — it stays
queryable directly in BigQuery for anyone with dataset access.

## Data-honesty notes

`build_snapshot()` emits a `coverage.notes[]` array (rendered verbatim in the
dashboard's "Data Coverage & Assumptions" panel) documenting real limitations
of the source data — freshness lag, store-location-not-customer-address for
city/state/region, no Gender/Age/Category/Purchase-Status/Sales-Executive
fields anywhere in the 5 source tables, and why Zoho Deals is expected to show
~0% of final attribution. Don't remove or soften these when editing.

## Deploy

```bash
cd walkin-source-api
./deploy.sh
```

Requires `gcloud auth login` + `gcloud auth application-default login` on a
principal with BigQuery + Cloud Run + Cloud Scheduler + Storage admin, and a
project already set to `lucirajewelry-prod`. See `sales-reporting-api/README.md`
for the general gotchas (bq-on-Windows PATH issues, PowerShell quoting, etc. —
same environment, same fixes apply).

After first deploy, verify:
```bash
curl -s "$(gcloud functions describe walkin-source-snapshot --region=asia-south1 --gen2 --format='value(serviceConfig.uri)')/" | head -c 500
```
