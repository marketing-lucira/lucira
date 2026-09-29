#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira POS Product Price -- live paginated API deploy
#  Backs dashboard/product-pricing-intelligence.html's "Product Price" tab.
#  Prereq: gcloud auth login + gcloud auth application-default login on a
#  principal with BigQuery Data Viewer + Cloud Functions/Run admin.
#
#  Export REFRESH_TOKEN before the FIRST deploy (a long random string --
#  e.g. `python3 -c "import secrets;print(secrets.token_hex(24))"`) and
#  reuse the SAME value on every later deploy; it's the shared secret the
#  Cloud Scheduler job (see cloud-scheduler-setup.sh) must send as
#  X-Refresh-Token to trigger POST /refresh-snapshot. Omitting it disables
#  that endpoint entirely (refuses with 500) rather than leaving it open.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
SERVICE="pos-price-api"

: "${REFRESH_TOKEN:?export REFRESH_TOKEN first -- see header above}"

gcloud config set project "$PROJECT"

gcloud functions deploy "$SERVICE" \
  --gen2 --runtime=python312 --region="$REGION" --source=. \
  --entry-point=pos_price --trigger-http --allow-unauthenticated \
  --memory=4096MB --timeout=1800s \
  --min-instances=1 \
  --set-env-vars "BQ_PROJECT=$PROJECT,PRICE_TABLE=$PROJECT.Pos.Product_price,SHOPIFY_PRODUCTS_TABLE=$PROJECT.Lucira_Prod.Lucira_Shopify_products,SNAPSHOT_DATASET=$PROJECT.pricing_snapshots,REFRESH_TOKEN=$REFRESH_TOKEN"

URL="$(gcloud functions describe "$SERVICE" --region="$REGION" --gen2 --format='value(serviceConfig.uri)')"
echo ""
echo "DONE. API: $URL"
echo "Wire this as CONFIG.PP_API_URL in dashboard/ppi.js."
