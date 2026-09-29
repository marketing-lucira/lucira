#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira Hourly Deals vs Orders -- live BigQuery orders API deploy
#  Backs dashboard/hourly-deals-orders.html.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
SERVICE="hourly-deals-orders-api"

gcloud config set project "$PROJECT"

gcloud functions deploy "$SERVICE" \
  --gen2 --runtime=python312 --region="$REGION" --source=. \
  --entry-point=hourly_deals_orders --trigger-http --allow-unauthenticated \
  --memory=256MB --timeout=60s \
  --set-env-vars "BQ_PROJECT=$PROJECT,SALE_TABLE=$PROJECT.ds_imputed_reporting.marketing_sale,DEALS_TABLE=$PROJECT.zoho_crm.cdc_deals"

URL="$(gcloud functions describe "$SERVICE" --region="$REGION" --gen2 --format='value(serviceConfig.uri)')"
echo ""
echo "DONE. API: $URL"
echo "Wire this as CONFIG.ORDERS_API in dashboard/hdo.js."
