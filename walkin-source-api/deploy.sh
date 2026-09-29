#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira Walk-in Source Intelligence — reporting layer deploy
#  Design: ONE Cloud Run function does refresh + snapshot; ONE Cloud Scheduler
#  fires it daily at 10:00 IST. The dashboard reads only the public snapshot.
#  Mirrors sales-reporting-api/deploy.sh exactly.
#  Prereq: gcloud auth login + gcloud auth application-default login on a
#  principal with BigQuery + Cloud Run + Scheduler + Storage admin.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"                      # MUST match the source dataset location
BUCKET="lucira-dashboards"                # existing public bucket (already used by sales-reporting-api)
SERVICE="walkin-source-snapshot"

gcloud config set project "$PROJECT"

# 1) First build of the reporting tables --------------------------------
bq --location="$REGION" query --use_legacy_sql=false --format=none < sql/refresh_reporting.sql

# 2) Confirm the shared public snapshot bucket exists (created by the Sales
#    Intelligence deploy already; idempotent no-op if so) ----------------
gsutil mb -l "$REGION" -b on "gs://$BUCKET" 2>/dev/null || true
gsutil iam ch allUsers:objectViewer "gs://$BUCKET" 2>/dev/null || true

# 3) Deploy the refresh+snapshot function (Cloud Run function) -----------
gcloud functions deploy "$SERVICE" \
  --gen2 --runtime=python312 --region="$REGION" --source=. \
  --entry-point=walkin_snapshot --trigger-http --allow-unauthenticated \
  --memory=512MB --timeout=300s \
  --set-env-vars "BQ_PROJECT=$PROJECT,REPORT_DATASET=$PROJECT.ds_imputed_reporting,SNAPSHOT_BUCKET=$BUCKET,SNAPSHOT_PATH=walkin-source/latest.json"

URL="$(gcloud functions describe "$SERVICE" --region="$REGION" --gen2 --format='value(serviceConfig.uri)')"
echo "Snapshot service: $URL"

# 4) Build the first snapshot now -----------------------------------------
# -d '' forces a Content-Length header on the empty POST body — GFE rejects a
# bodyless POST with 411 Length Required otherwise.
curl -s -X POST -d '' "$URL/refresh" >/dev/null && echo "Initial snapshot written."

# 5) Schedule the DAILY 10:00 IST refresh+snapshot ------------------------
gcloud scheduler jobs create http walkin-source-refresh \
  --location="$REGION" --schedule="0 10 * * *" --time-zone="Asia/Kolkata" \
  --uri="$URL/refresh" --http-method=POST --attempt-deadline=300s 2>/dev/null || \
gcloud scheduler jobs update http walkin-source-refresh \
  --location="$REGION" --schedule="0 10 * * *" --time-zone="Asia/Kolkata" \
  --uri="$URL/refresh" --http-method=POST --attempt-deadline=300s

echo ""
echo "DONE. Public snapshot: https://storage.googleapis.com/$BUCKET/walkin-source/latest.json"
echo "This URL is already wired as CONFIG.SNAPSHOT_URL in dashboard/walkin-source-intelligence.html."
