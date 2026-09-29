#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira Gold Rate History -- live daily-price API deploy
#  Backs the Slab tab's "Today's Entry" / "Saved History" calculator in
#  dashboard/product-pricing-intelligence.html.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
SERVICE="gold-rate-api"

gcloud config set project "$PROJECT"

gcloud functions deploy "$SERVICE" \
  --gen2 --runtime=python312 --region="$REGION" --source=. \
  --entry-point=gold_rate_history --trigger-http --allow-unauthenticated \
  --memory=256MB --timeout=60s \
  --set-env-vars "BQ_PROJECT=$PROJECT,METAL_RATES_TABLE=$PROJECT.Pos.metal_rates,ITEM_GROUPS_TABLE=$PROJECT.Pos.item_groups"

URL="$(gcloud functions describe "$SERVICE" --region="$REGION" --gen2 --format='value(serviceConfig.uri)')"
echo ""
echo "DONE. API: $URL"
echo "Wire this as GOLD_API in dashboard/ppi.js."
