#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira pincode dashboards — daily refresh (Cloud Run Job + Cloud Scheduler)
#  Refreshes Store Location Intelligence (public GCS page) and the GA4 Geo
#  Intelligence data (served by the password-protected ga4-geo-intelligence
#  Cloud Run service) every day at 10:30 IST. See job.js for what refreshes.
#  Re-run this script after changing ANY of: job.js, the two build scripts,
#  or the SQL files — it bundles the current copies from the repo.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
JOB="pincode-dashboards-refresh"
PRIVATE_BUCKET="lucirajewelry-prod-pincode-refresh"
SA="385594025448-compute@developer.gserviceaccount.com"
ROOT=".."

# 1) Private bucket for static inputs + the GA4 Geo data file (NEVER public:
#    some inputs hold customer mobile numbers).
gcloud storage buckets describe "gs://$PRIVATE_BUCKET" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$PRIVATE_BUCKET" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention

# 2) Static inputs the job cannot re-pull (WebEngage share is Access Denied;
#    competitor captures are one-time) — upload only if missing, so a later
#    redeploy never overwrites them with something older.
upload_if_missing() { # $1 local file, $2 gs:// destination
  gcloud storage ls "$2" >/dev/null 2>&1 || gcloud storage cp "$1" "$2"
}
for f in "$ROOT"/etl/raw/store_location_v2/*.json; do
  upload_if_missing "$f" "gs://$PRIVATE_BUCKET/inputs/store_location_v2/$(basename "$f")"
done
for f in caratlane_stores.json caratlane_store_master.json tanishq_store_master.json pincode_area_display.json; do
  upload_if_missing "$ROOT/etl/$f" "gs://$PRIVATE_BUCKET/inputs/geo_static/$f"
done

# 3) Bundle the SAME build code + SQL the local pipeline uses.
rm -rf bundle && mkdir -p bundle/sql bundle/geo_intel_sql bundle/city_intel_sql
cp "$ROOT/etl/build_store_location_intel_v2.js" "$ROOT/etl/build_geo_intel.js" bundle/
cp "$ROOT/dashboard/sql/store_location_app_events_pull.sql" "$ROOT/dashboard/sql/store_location_zoho_ads_pull.sql" bundle/sql/
cp "$ROOT"/etl/geo_intel_sql/*.sql bundle/geo_intel_sql/
cp "$ROOT"/etl/city_intel_sql/*.sql bundle/city_intel_sql/

# 4) Deploy the job.
gcloud run jobs deploy "$JOB" --source . --region "$REGION" --project "$PROJECT" \
  --service-account "$SA" --memory 4Gi --cpu 2 --task-timeout 3600 --max-retries 1 \
  --set-env-vars "BQ_PROJECT=$PROJECT,PRIVATE_BUCKET=$PRIVATE_BUCKET,PUBLIC_BUCKET=lucira-dashboards"

# 5) Daily trigger, 10:30 IST.
URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run"
if gcloud scheduler jobs describe "$JOB-daily" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB-daily" --location "$REGION" --project "$PROJECT" \
    --schedule "30 10 * * *" --time-zone "Asia/Kolkata" --uri "$URI" --http-method POST \
    --oauth-service-account-email "$SA"
else
  gcloud scheduler jobs create http "$JOB-daily" --location "$REGION" --project "$PROJECT" \
    --schedule "30 10 * * *" --time-zone "Asia/Kolkata" --uri "$URI" --http-method POST \
    --oauth-service-account-email "$SA"
fi
echo "Deployed. Run now with: gcloud run jobs execute $JOB --region $REGION --project $PROJECT --wait"
