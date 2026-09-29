#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  FreJun Call Logs -> BigQuery — Cloud Run deploy
#  Creates ONLY: dataset lucirajewelry-prod.frejun_data (+ its 3 tables),
#  Cloud Run service frejun-call-log-ingestion, and grants that service's
#  runtime SA access to the frejun-api-key secret + BigQuery. Touches
#  nothing else in the project.
#  Prereq: gcloud auth login on tech@lucirajewelry.com (or equivalent),
#  project already set to lucirajewelry-prod, and the frejun-api-key secret
#  already populated with a version (see README.md).
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
SERVICE="frejun-call-log-ingestion"
SECRET_NAME="frejun-api-key"

gcloud config set project "$PROJECT"

# 1) Create the dataset + tables (idempotent) ------------------------------
bq --location="$REGION" query --use_legacy_sql=false --format=none < sql/create_tables.sql

# 2) Deploy the Cloud Run service from source (buildpacks; no Dockerfile) --
gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT" --region="$REGION" \
  --no-allow-unauthenticated \
  --memory=1Gi --cpu=1 --timeout=900 --concurrency=1 --max-instances=2 \
  --set-env-vars "GCP_PROJECT=$PROJECT,BQ_DATASET=frejun_data,BQ_TABLE=frejun_call_log,BQ_STAGING_TABLE=frejun_call_log_stg,BQ_STATE_TABLE=frejun_sync_state,FREJUN_SECRET_NAME=$SECRET_NAME,FREJUN_BASE_URL=https://api.frejun.com/api/v2,FREJUN_USER_EMAIL=${FREJUN_USER_EMAIL:-}"

# 3) Get (or create) the runtime service account and grant least-privilege
#    access: this secret only, plus BigQuery on this project. ---------------
SA_EMAIL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(spec.template.spec.serviceAccountName)')"
echo "Runtime service account: $SA_EMAIL"

gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project="$PROJECT" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/bigquery.dataEditor" --condition=None >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/bigquery.jobUser" --condition=None >/dev/null

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo ""
echo "Service deployed (private, requires auth): $URL"
echo "Invoke with: curl -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" $URL/health"
