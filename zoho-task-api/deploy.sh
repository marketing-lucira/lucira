#!/bin/bash
# ============================================================
# deploy.sh — Deploy Zoho Task API to Google Cloud Functions
# ============================================================
# USAGE: bash deploy.sh
# PRE-REQUISITES:
#   1. gcloud CLI installed & authenticated
#   2. Cloud SQL instance created
#   3. .env values ready (fill in variables below)
# ============================================================

# ---- CONFIG — Fill these values ----
PROJECT_ID="your-gcp-project-id"
REGION="asia-south1"              # Mumbai region (India)
FUNCTION_NAME="zoho-task-api"
RUNTIME="python311"
DB_INSTANCE="your-cloud-sql-instance-name"

# ---- Zoho Credentials ----
ZOHO_CLIENT_ID="your_zoho_client_id"
ZOHO_CLIENT_SECRET="your_zoho_client_secret"
ZOHO_REFRESH_TOKEN="your_zoho_refresh_token"

# ---- Cloud SQL Credentials ----
DB_NAME="zoho_crm"
DB_USER="postgres"
DB_PASSWORD="your_db_password"
DB_PORT="5432"
DB_HOST="/cloudsql/${PROJECT_ID}:${REGION}:${DB_INSTANCE}"

# ============================================================
echo "🚀 Setting GCP project: $PROJECT_ID"
gcloud config set project $PROJECT_ID

# ============================================================
echo "📦 Deploying Cloud Function: $FUNCTION_NAME"
gcloud functions deploy $FUNCTION_NAME \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source=. \
  --entry-point=zoho_task_api \
  --trigger-http \
  --allow-unauthenticated \
  --add-cloudsql-instances="${PROJECT_ID}:${REGION}:${DB_INSTANCE}" \
  --set-env-vars="ZOHO_CLIENT_ID=${ZOHO_CLIENT_ID},\
ZOHO_CLIENT_SECRET=${ZOHO_CLIENT_SECRET},\
ZOHO_REFRESH_TOKEN=${ZOHO_REFRESH_TOKEN},\
DB_HOST=${DB_HOST},\
DB_NAME=${DB_NAME},\
DB_USER=${DB_USER},\
DB_PASSWORD=${DB_PASSWORD},\
DB_PORT=${DB_PORT}"

# ============================================================
echo ""
echo "✅ Deployment complete!"
echo "🌐 Function URL:"
gcloud functions describe $FUNCTION_NAME \
  --region=$REGION \
  --gen2 \
  --format="value(serviceConfig.uri)"

echo ""
echo "📋 Test with curl:"
echo "curl -X POST <FUNCTION_URL> \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"date\": \"2026-07-05\", \"module\": \"Tasks\"}'"
