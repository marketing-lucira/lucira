#!/usr/bin/env bash
# Deploy the Inventory Intelligence API as a gen2 Cloud Function (Cloud Run under
# the hood). Idempotent — re-run to update. Requires: gcloud auth + a project.
set -euo pipefail

PROJECT="${BQ_PROJECT:-lucirajewelry-prod}"
REGION="${REGION:-asia-south1}"
SA="${RUNTIME_SA:-inventory-intel-api@${PROJECT}.iam.gserviceaccount.com}"
NAME="inventory-intel-api"

echo "▶ Deploying ${NAME} to ${PROJECT}/${REGION} …"

gcloud functions deploy "${NAME}" \
  --gen2 --runtime=python312 --region="${REGION}" --project="${PROJECT}" \
  --source=. --entry-point=inventory_intel \
  --trigger-http --allow-unauthenticated \
  --memory=512Mi --timeout=120s --max-instances=10 \
  --service-account="${SA}" \
  --set-env-vars="BQ_PROJECT=${PROJECT},REPORT_DATASET=${PROJECT}.reporting,VERTEX_LOCATION=us-central1,VERTEX_MODEL=gemini-2.5-flash,CURRENCY=INR,TIMEZONE=Asia/Kolkata"

URL=$(gcloud functions describe "${NAME}" --gen2 --region="${REGION}" --project="${PROJECT}" --format='value(serviceConfig.uri)')
echo "✔ Deployed: ${URL}"
echo "  Health:   ${URL}?action=health"
echo "  Paste this URL into CONFIG.API_BASE in dashboard/inventory-intelligence.html"

# ── One-time IAM (uncomment / run once) ────────────────────────────────────
# gcloud iam service-accounts create inventory-intel-api --project="${PROJECT}"
# gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${SA}" --role="roles/bigquery.jobUser"
# bq add-iam-policy-binding --member="serviceAccount:${SA}" --role="roles/bigquery.dataViewer" "${PROJECT}:reporting"
# gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${SA}" --role="roles/aiplatform.user"
