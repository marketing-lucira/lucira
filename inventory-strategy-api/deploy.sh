#!/usr/bin/env bash
# Deploy the Inventory Strategy API to Cloud Run (gen2 function) in asia-south1.
# Requires: gcloud auth + project set to lucirajewelry-prod, Vertex AI + Run enabled.
set -euo pipefail

PROJECT="${BQ_PROJECT:-lucirajewelry-prod}"
REGION="${REGION:-asia-south1}"
NAME="${SERVICE:-inventory-strategy-api}"

gcloud functions deploy "$NAME" \
  --project="$PROJECT" \
  --gen2 --runtime=python312 --region="$REGION" \
  --source=. --entry-point=inventory_data \
  --trigger-http --allow-unauthenticated \
  --memory=1Gi --timeout=120s --max-instances=5 \
  --set-env-vars "^@^BQ_PROJECT=$PROJECT@INVENTORY_TABLE=lucirajewelry-prod.ds_imputed_reporting.Live_inventory@SALES_TABLE=lucirajewelry-prod.ornaverse_erp_administration.Sales_overview_table@GA4_DATASET=lucirajewelry-prod.analytics_478308692@TIMEZONE=Asia/Kolkata@CURRENCY=INR@EXCLUDE_METALS=Silver@EXCLUDE_TYPES=Silver Coin,Gold Coin@VELOCITY_DAYS=90@LEAD_TIME_DAYS=21@SAFETY_DAYS=14@GEO_DAYS=30@CRITICAL_COVER=14@LOW_COVER=30@OVERSTOCK_COVER=270@DEAD_DAYS=180@VERTEX_LOCATION=us-central1@VERTEX_MODEL=gemini-2.5-flash@CHAT_MAX_GB=2"

echo ""
echo "Deployed. URL:"
gcloud functions describe "$NAME" --gen2 --region="$REGION" --project="$PROJECT" --format='value(serviceConfig.uri)'
