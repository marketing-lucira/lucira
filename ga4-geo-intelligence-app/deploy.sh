#!/usr/bin/env bash
# Deploy the GA4 Geo Intelligence static dashboard as its own Cloud Run
# service — separate from every other Lucira dashboard. Re-run after copying
# a refreshed dashboard/ga4-geo-intelligence-dashboard.html + geo_intel_data.js
# into static/index.html + static/geo_intel_data.js.
set -euo pipefail

PROJECT="${BQ_PROJECT:-lucirajewelry-prod}"
REGION="${REGION:-asia-south1}"
NAME="ga4-geo-intelligence"

echo "▶ Deploying ${NAME} to ${PROJECT}/${REGION} …"

gcloud run deploy "${NAME}" \
  --source=. --region="${REGION}" --project="${PROJECT}" \
  --allow-unauthenticated \
  --memory=512Mi --timeout=300s --max-instances=5

URL=$(gcloud run services describe "${NAME}" --region="${REGION}" --project="${PROJECT}" --format='value(status.url)')
echo "✔ Deployed: ${URL}/dashboard"
