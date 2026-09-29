#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Creates/updates the Cloud Scheduler job that triggers the ONE daily
# snapshot refresh (POST /refresh-snapshot) at exactly 12:01 PM IST.
# Run this once after pos-price-api has been deployed with a REFRESH_TOKEN
# (see deploy.sh) -- export the SAME REFRESH_TOKEN value here.
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
JOB="pricing-snapshot-refresh"

: "${REFRESH_TOKEN:?export the SAME REFRESH_TOKEN used in pos-price-api deploy.sh}"

URL="$(gcloud functions describe pos-price-api --region="$REGION" --gen2 --project="$PROJECT" --format='value(serviceConfig.uri)')"

if gcloud scheduler jobs describe "$JOB" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" \
    --location="$REGION" --project="$PROJECT" \
    --schedule="1 12 * * *" --time-zone="Asia/Kolkata" \
    --uri="${URL}/refresh-snapshot" --http-method=POST \
    --headers="X-Refresh-Token=${REFRESH_TOKEN}" \
    --attempt-deadline=1800s
else
  gcloud scheduler jobs create http "$JOB" \
    --location="$REGION" --project="$PROJECT" \
    --schedule="1 12 * * *" --time-zone="Asia/Kolkata" \
    --uri="${URL}/refresh-snapshot" --http-method=POST \
    --headers="X-Refresh-Token=${REFRESH_TOKEN}" \
    --attempt-deadline=1800s
fi

echo "DONE. Job runs daily at 12:01 PM Asia/Kolkata."
echo "Trigger it manually right now with:"
echo "  gcloud scheduler jobs run $JOB --location=$REGION --project=$PROJECT"
