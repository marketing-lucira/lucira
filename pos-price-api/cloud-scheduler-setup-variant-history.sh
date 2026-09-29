#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Creates/updates the Cloud Scheduler job that appends TODAY's Variant Level
# data into the ONE historical table (pricing_snapshots.variant_level_daily_
# history) every day at 12:30 PM IST -- 29 minutes after the existing
# pricing-snapshot-refresh job (12:01 PM), so that one has already finished
# rebuilding the dashboard's own snapshot before this reads it.
#
# Separate job from pricing-snapshot-refresh on purpose (different schedule,
# different purpose: this ONLY archives, never touches the dashboard-facing
# snapshot tables/blobs or the UI in any way).
#
# Run this once after pos-price-api has been deployed with the history
# endpoint -- export the SAME REFRESH_TOKEN used in deploy.sh.
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
JOB="variant-level-daily-history"

: "${REFRESH_TOKEN:?export the SAME REFRESH_TOKEN used in pos-price-api deploy.sh}"

URL="$(gcloud functions describe pos-price-api --region="$REGION" --gen2 --project="$PROJECT" --format='value(serviceConfig.uri)')"

if gcloud scheduler jobs describe "$JOB" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" \
    --location="$REGION" --project="$PROJECT" \
    --schedule="30 12 * * *" --time-zone="Asia/Kolkata" \
    --uri="${URL}/variant-level-history-snapshot" --http-method=POST \
    --headers="X-Refresh-Token=${REFRESH_TOKEN}" \
    --attempt-deadline=1800s
else
  gcloud scheduler jobs create http "$JOB" \
    --location="$REGION" --project="$PROJECT" \
    --schedule="30 12 * * *" --time-zone="Asia/Kolkata" \
    --uri="${URL}/variant-level-history-snapshot" --http-method=POST \
    --headers="X-Refresh-Token=${REFRESH_TOKEN}" \
    --attempt-deadline=1800s
fi

echo "DONE. Job runs daily at 12:30 PM Asia/Kolkata."
echo "Trigger it manually right now with:"
echo "  gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT"
