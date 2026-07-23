#!/usr/bin/env bash
# One-command go-live for the Lucira BI Copilot.  Requires gcloud authed on lucirajewelry-prod.
set -euo pipefail

PROJECT="lucirajewelry-prod"
REGION="asia-south1"
SERVICE="bi-copilot"
BUCKET="lucira-dashboards"

echo "==> 1/4  Build the BI semantic layer (idempotent DDL)"
for f in sql/00_setup_bi_dataset.sql sql/10_dim_date.sql sql/20_fact_kpi_daily.sql \
         sql/30_kpi_snapshot.sql sql/40_logs.sql; do
  echo "    - $f"
  bq query --project_id="$PROJECT" --use_legacy_sql=false --location="$REGION" < "$f"
done

echo "==> 2/4  Deploy Cloud Run service"
gcloud run deploy "$SERVICE" --source . --project="$PROJECT" --region="$REGION" \
  --allow-unauthenticated \
  --memory=1Gi --timeout=600 \
  --set-env-vars "BI_CONFIG_DIR=config" \
  --set-secrets "LLM_API_KEY=bi-llm-key:latest"    # add WA/SMTP secrets when enabled

URL=$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
      --format='value(status.url)')
echo "    service: $URL"

echo "==> 3/4  Schedule the 09:00 IST daily run"
SA="$(gcloud config get-value account)"
gcloud scheduler jobs create http "${SERVICE}-daily" \
  --project="$PROJECT" --location="$REGION" \
  --schedule="0 9 * * *" --time-zone="Asia/Kolkata" \
  --uri="${URL}/run" --http-method=POST \
  --oidc-service-account-email="$SA" || \
gcloud scheduler jobs update http "${SERVICE}-daily" \
  --project="$PROJECT" --location="$REGION" \
  --schedule="0 9 * * *" --time-zone="Asia/Kolkata" --uri="${URL}/run"

echo "==> 4/4  Smoke test (dry run)"
curl -s -X POST "${URL}/run?dry=1" | tee /dev/stderr

cat <<EOF

Done. Next:
  • Wire dashboard/bi-copilot.html CONFIG.SNAPSHOT_URL to:
      https://storage.googleapis.com/${BUCKET}/bi/latest.json
  • Grant the Cloud Run SA: bigquery.jobUser, bigquery.dataViewer (source datasets),
    bigquery.dataEditor (bi), storage.objectAdmin (${BUCKET}).
  • Flip notifications.whatsapp.enabled=true in settings.yaml once the WA vendor is onboarded.
EOF
