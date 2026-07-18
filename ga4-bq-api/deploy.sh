#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# ga4-bq-api :: one-shot deploy
#   1. Build the destination dataset + summary tables (sql/00_setup.sql)
#   2. Backfill (optional) a history window
#   3. Deploy the Cloud Run service
#   4. Wire Cloud Scheduler to refresh daily at 09:00 IST (+ AI report 09:15 IST)
#
# Requires: gcloud + bq authenticated with rights to BigQuery + Cloud Run +
# Cloud Scheduler in the project. Run from this directory:  bash deploy.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── settings ────────────────────────────────────────────────────────────────
PROJECT="lucirajewelry-prod"
REGION="asia-south1"                       # keep in the same region as the GA4 export
SERVICE="ga4-bq-api"
DATASET="ga4_dashboard"
GA4_EXPORT_DATASET="analytics_478308692"   # raw GA4 export dataset (events_*)
BACKFILL_DAYS="90"                          # set 0 to skip backfill
SNAPSHOT_BUCKET="lucira-dashboards"         # GCS bucket for the daily static snapshot object
SNAPSHOT_PREFIX="ga4"                        # → gs://$SNAPSHOT_BUCKET/ga4/latest.json
# Set these to enable generative AI (else the dashboard uses its local assistant):
GEMINI_SECRET=""                            # Secret Manager secret name holding the Gemini key, e.g. gemini-api-key
CORS_ORIGIN="https://marketing-lucira.github.io"

gcloud config set project "$PROJECT"

echo "▸ Enabling APIs…"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  bigquery.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# ── 1. dataset + tables ─────────────────────────────────────────────────────
echo "▸ Creating dataset + summary tables…"
bq --location="$REGION" query --use_legacy_sql=false --project_id="$PROJECT" < sql/00_setup.sql

# ── 2. optional backfill (loop the refresh SQL over the last N days) ─────────
if [ "${BACKFILL_DAYS}" -gt 0 ]; then
  echo "▸ Backfilling ${BACKFILL_DAYS} days (this scans raw export once per day)…"
  for i in $(seq 1 "${BACKFILL_DAYS}"); do
    D=$(date -u -d "${i} days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${i}"d +%Y-%m-%d)
    for f in 10_refresh_daily_summary 11_refresh_campaign_summary 12_refresh_landing_summary \
             13_refresh_sku_summary 14_refresh_product_summary 15_refresh_audience_summary; do
      sed "s/DEFAULT DATE_SUB(CURRENT_DATE('Asia\/Kolkata'), INTERVAL 1 DAY)/DEFAULT DATE '${D}'/" \
        "sql/${f}.sql" | bq --location="$REGION" query --use_legacy_sql=false --project_id="$PROJECT"
    done
    echo "  · $D done"
  done
fi

# ── 2b. snapshot bucket (static daily JSON the dashboard reads) ─────────────
echo "▸ Ensuring snapshot bucket + public read…"
gsutil mb -l "$REGION" "gs://${SNAPSHOT_BUCKET}" 2>/dev/null || true
# Public-read on the snapshot prefix so the static GitHub Pages dashboard can GET it.
# (If you prefer not to expose it publicly, front it with a CDN/proxy instead.)
gsutil iam ch allUsers:objectViewer "gs://${SNAPSHOT_BUCKET}" || true

# ── 3. deploy Cloud Run (authenticated; source-based build) ─────────────────
echo "▸ Deploying Cloud Run service…"
ENV="GCP_PROJECT=${PROJECT},GA4_DASHBOARD_DATASET=${DATASET},GA4_CURRENCY=INR,WINDOW_DAYS=90,CORS_ORIGIN=${CORS_ORIGIN},SNAPSHOT_BUCKET=${SNAPSHOT_BUCKET},SNAPSHOT_PREFIX=${SNAPSHOT_PREFIX},SNAPSHOT_DAYS=400"
SECRET_ARG=()
if [ -n "${GEMINI_SECRET}" ]; then
  SECRET_ARG=(--set-secrets "GEMINI_API_KEY=${GEMINI_SECRET}:latest")
fi
gcloud run deploy "$SERVICE" \
  --source . --region "$REGION" --platform managed \
  --no-allow-unauthenticated \
  --memory 512Mi --cpu 1 --timeout 120 --concurrency 20 \
  --set-env-vars "$ENV" "${SECRET_ARG[@]}"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo "▸ Service URL: $URL"

# ── 4. Cloud Scheduler → refresh 09:00 IST, AI report 09:15 IST ─────────────
# A dedicated SA that is allowed to invoke the (private) Cloud Run service.
SA="ga4-scheduler@${PROJECT}.iam.gserviceaccount.com"
gcloud iam service-accounts create ga4-scheduler --display-name "GA4 dashboard scheduler" 2>/dev/null || true
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
  --member "serviceAccount:${SA}" --role roles/run.invoker

echo "▸ Creating Cloud Scheduler jobs (Asia/Kolkata)…"
gcloud scheduler jobs create http ga4-daily-refresh \
  --location "$REGION" --schedule "0 9 * * *" --time-zone "Asia/Kolkata" \
  --uri "${URL}/refresh" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
  --headers "Content-Type=application/json" --message-body '{}' \
  2>/dev/null || gcloud scheduler jobs update http ga4-daily-refresh --location "$REGION" \
  --schedule "0 9 * * *" --time-zone "Asia/Kolkata" --uri "${URL}/refresh"

gcloud scheduler jobs create http ga4-daily-snapshot \
  --location "$REGION" --schedule "5 9 * * *" --time-zone "Asia/Kolkata" \
  --uri "${URL}/snapshot" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
  --headers "Content-Type=application/json" --message-body '{}' \
  2>/dev/null || gcloud scheduler jobs update http ga4-daily-snapshot --location "$REGION" \
  --schedule "5 9 * * *" --time-zone "Asia/Kolkata" --uri "${URL}/snapshot"

gcloud scheduler jobs create http ga4-daily-report \
  --location "$REGION" --schedule "15 9 * * *" --time-zone "Asia/Kolkata" \
  --uri "${URL}/report" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
  --headers "Content-Type=application/json" --message-body '{}' \
  2>/dev/null || gcloud scheduler jobs update http ga4-daily-report --location "$REGION" \
  --schedule "15 9 * * *" --time-zone "Asia/Kolkata" --uri "${URL}/report"

SNAP_URL="https://storage.googleapis.com/${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}/latest.json"
echo "✓ Done."
echo "  Daily schedule (Asia/Kolkata): 09:00 refresh → 09:05 snapshot → 09:15 AI report."
echo "  Set the dashboard GitHub Variable  GA4_SNAPSHOT_URL = ${SNAP_URL}"
echo "  (This static object is the dashboard's data source — read once/day, no live querying.)"
echo "  Optional: set GA4_API_BASE = ${URL}  to enable the Gemini AI assistant (/ai)."
echo "  Trigger the first snapshot now:  gcloud scheduler jobs run ga4-daily-snapshot --location ${REGION}"
echo "  Note: /snapshot + /refresh + /report are guarded (Scheduler OIDC / REFRESH_TOKEN);"
echo "        the snapshot OBJECT is public-read so the static dashboard can fetch it."
