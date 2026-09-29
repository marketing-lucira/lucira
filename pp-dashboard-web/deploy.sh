#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Lucira Product Pricing Intelligence -- live dashboard host, gated by a
#  shared username/password (same pattern as zoho-login-dashboard).
#
#  Export DASH_USER / DASH_PASS before running this script -- reuse the
#  SAME values on every later deploy so the credentials don't change
#  under people who already have them.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
SERVICE="pp-dashboard-web"

: "${DASH_USER:?export DASH_USER first}"
: "${DASH_PASS:?export DASH_PASS first}"

gcloud config set project "$PROJECT"

gcloud run deploy "$SERVICE" --source . \
  --project="$PROJECT" --region="$REGION" \
  --allow-unauthenticated \
  --memory=512Mi --timeout=300s \
  --set-env-vars "DASH_USER=$DASH_USER,DASH_PASS=$DASH_PASS"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo ""
echo "DONE. Dashboard: $URL"
echo "Share this URL + the username/password with anyone who needs access."
