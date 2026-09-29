#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira Google Business Profile pipeline — Cloud Run + Scheduler deploy
#  Prereq: gcloud auth login as tech@lucirajewelry.com, BigQuery + Cloud Run
#  + Scheduler + Storage admin on lucirajewelry-prod. GOOGLE_CLIENT_ID /
#  GOOGLE_CLIENT_SECRET must already exist (created once in Cloud Console,
#  see README.md "One-time manual setup"). SYNC_TOKEN and FLASK_SECRET should
#  be pulled from Secret Manager, not typed here in plaintext long-term.
#  NOTE: this script is not executed automatically -- review then run by hand.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
DATASET="ds_imputed_reporting"
BUCKET="lucira-dashboards"
SERVICE="gbp-pipeline"

: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID in your shell before running deploy.sh}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET in your shell before running deploy.sh}"
: "${SYNC_TOKEN:?Set SYNC_TOKEN (any random string) in your shell before running deploy.sh}"

gcloud config set project "$PROJECT"

# 1) Create the reporting tables (idempotent) --------------------------------
bq --location="$REGION" query --use_legacy_sql=false --format=none < sql/create_locations_table.sql
bq --location="$REGION" query --use_legacy_sql=false --format=none < sql/create_daily_table.sql
bq --location="$REGION" query --use_legacy_sql=false --format=none < sql/create_log_table.sql

# 2) Deploy the Cloud Run service ---------------------------------------------
gcloud run deploy "$SERVICE" \
  --region="$REGION" --source=. \
  --allow-unauthenticated \
  --memory=512Mi --timeout=600s \
  --set-env-vars "BQ_PROJECT=$PROJECT,BQ_DATASET=$DATASET,GCS_BUCKET=$BUCKET,SYNC_TOKEN=$SYNC_TOKEN,GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo "Service URL: $URL"
echo ""
echo "IMPORTANT -- one more manual step before this URL works:"
echo "  Set GOOGLE_REDIRECT_URI=\$URL/oauth/callback as an env var on the"
echo "  service AND add that exact URL as an authorized redirect URI on the"
echo "  OAuth client in Cloud Console, then redeploy (or gcloud run services"
echo "  update with --update-env-vars). Only after that will /oauth/login work."

# 3) Schedule the daily 7-day-window refresh (after GBP data for yesterday settles) ---
gcloud scheduler jobs create http gbp-daily-sync \
  --location="$REGION" --schedule="0 9 * * *" --time-zone="Asia/Kolkata" \
  --uri="$URL/sync/daily" --http-method=POST \
  --headers="X-Sync-Token=$SYNC_TOKEN" --attempt-deadline=600s 2>/dev/null || \
gcloud scheduler jobs update http gbp-daily-sync \
  --location="$REGION" --schedule="0 9 * * *" --time-zone="Asia/Kolkata" \
  --uri="$URL/sync/daily" --http-method=POST \
  --headers="X-Sync-Token=$SYNC_TOKEN" --attempt-deadline=600s

# 4) Schedule a weekly location re-discovery (new/closed stores) --------------
gcloud scheduler jobs create http gbp-weekly-locations \
  --location="$REGION" --schedule="0 8 * * 1" --time-zone="Asia/Kolkata" \
  --uri="$URL/sync/locations" --http-method=POST \
  --headers="X-Sync-Token=$SYNC_TOKEN" --attempt-deadline=600s 2>/dev/null || \
gcloud scheduler jobs update http gbp-weekly-locations \
  --location="$REGION" --schedule="0 8 * * 1" --time-zone="Asia/Kolkata" \
  --uri="$URL/sync/locations" --http-method=POST \
  --headers="X-Sync-Token=$SYNC_TOKEN" --attempt-deadline=600s

echo ""
echo "DONE. Manual next steps:"
echo "  1) curl -X POST -H \"X-Sync-Token: \$SYNC_TOKEN\" \$URL/sync/locations"
echo "  2) curl -X POST -H \"X-Sync-Token: \$SYNC_TOKEN\" \"\$URL/backfill?days=540\""
echo "  3) curl \$URL/test/sample"
