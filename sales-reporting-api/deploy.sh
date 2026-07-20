#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira Sales Intelligence — reporting layer deploy (as-built 2026-07-20)
#  Design: ONE Cloud Run function does refresh + snapshot; ONE Cloud Scheduler
#  fires it daily at 10:00 IST. The dashboard reads only the public snapshot.
#  Prereq: gcloud auth login + gcloud auth application-default login on a
#  principal with BigQuery + Cloud Run + Scheduler + Storage admin.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"                      # MUST match the source dataset location
DATASET="sales_dashboard"
BUCKET="lucira-dashboards"                # public bucket for the static snapshot
SERVICE="sales-snapshot"

gcloud config set project "$PROJECT"

# 1) Reporting dataset + first build of the reporting tables ----------------
bq --location="$REGION" mk --dataset --force "$PROJECT:$DATASET" || true
bq --location="$REGION" query --use_legacy_sql=false --format=none < sql/refresh_reporting.sql

# 2) Public snapshot bucket (+ CORS so browsers can fetch cross-origin) ------
gsutil mb -l "$REGION" -b on "gs://$BUCKET" 2>/dev/null || true
gsutil iam ch allUsers:objectViewer "gs://$BUCKET"
cat > /tmp/cors.json <<'JSON'
[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
JSON
gsutil cors set /tmp/cors.json "gs://$BUCKET"

# 3) Deploy the refresh+snapshot function (Cloud Run function) ---------------
gcloud functions deploy "$SERVICE" \
  --gen2 --runtime=python312 --region="$REGION" --source=. \
  --entry-point=sales_snapshot --trigger-http --allow-unauthenticated \
  --memory=512MB --timeout=300s \
  --set-env-vars "BQ_PROJECT=$PROJECT,REPORT_DATASET=$PROJECT.$DATASET,SALES_TABLE=$PROJECT.ornaverse_erp_administration.Sales_overview_table,CURRENCY=INR,GST_DIVISOR=1.03,WINDOW_DAYS=540,SNAPSHOT_BUCKET=$BUCKET,SNAPSHOT_PATH=sales/latest.json"

URL="$(gcloud functions describe "$SERVICE" --region="$REGION" --gen2 --format='value(serviceConfig.uri)')"
echo "Snapshot service: $URL"

# 4) Build the first snapshot now -------------------------------------------
curl -s -X POST "$URL/refresh" >/dev/null && echo "Initial snapshot written."

# 5) Schedule the DAILY 10:00 IST refresh+snapshot --------------------------
gcloud scheduler jobs create http sales-reporting-refresh \
  --location="$REGION" --schedule="0 10 * * *" --time-zone="Asia/Kolkata" \
  --uri="$URL/refresh" --http-method=POST --attempt-deadline=300s 2>/dev/null || \
gcloud scheduler jobs update http sales-reporting-refresh \
  --location="$REGION" --schedule="0 10 * * *" --time-zone="Asia/Kolkata" \
  --uri="$URL/refresh" --http-method=POST --attempt-deadline=300s

echo ""
echo "DONE. Public snapshot: https://storage.googleapis.com/$BUCKET/sales/latest.json"
echo "It is already wired as CONFIG.SNAPSHOT_URL in dashboard/sales-intelligence.html."
