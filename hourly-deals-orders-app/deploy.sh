#!/usr/bin/env bash
# Deploy the Hourly Deals vs Orders dashboard as its own Cloud Run service --
# separate from every other Lucira dashboard, same pattern as
# ga4-geo-intelligence-app. Re-run after copying a refreshed
# dashboard/hourly-deals-orders.html + hdo.js into static/index.html + static/hdo.js.
#
# No login gate by default (DASH_USER/DASH_PASS left unset) so the link can
# be shared with the whole team directly -- set those two env vars on the
# Cloud Run service afterwards if a login should be added later.
set -euo pipefail

PROJECT="${BQ_PROJECT:-lucirajewelry-prod}"
REGION="${REGION:-asia-south1}"
NAME="hourly-deals-orders"

echo "Deploying ${NAME} to ${PROJECT}/${REGION} ..."

gcloud run deploy "${NAME}" \
  --source=. --region="${REGION}" --project="${PROJECT}" \
  --allow-unauthenticated \
  --memory=512Mi --timeout=300s --max-instances=5

URL=$(gcloud run services describe "${NAME}" --region="${REGION}" --project="${PROJECT}" --format='value(status.url)')
echo "Deployed: ${URL}/dashboard"
