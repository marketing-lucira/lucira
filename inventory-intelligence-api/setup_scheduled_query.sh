#!/usr/bin/env bash
# Create the daily 09:00 IST BigQuery Scheduled Query that rebuilds the four
# reporting tables. Runs 10_build_fact.sql then 20_build_transfers_insights.sql
# (transfers/insights read the fact table, so they must run AFTER it — a single
# scheduled query executes the statements in order).
#
# Prereq: BigQuery Data Transfer API enabled; you have bigquery.admin (or the
# transferConfigs.create permission) on the project.
set -euo pipefail

PROJECT="${BQ_PROJECT:-lucirajewelry-prod}"
LOCATION="${BQ_LOCATION:-US}"          # must match the reporting dataset region
NAME="inventory_intelligence_daily_0900_IST"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Concatenate the two build scripts into one multi-statement query.
QUERY="$(cat "${HERE}/sql/10_build_fact.sql" "${HERE}/sql/20_build_transfers_insights.sql")"

# 09:00 Asia/Kolkata. Scheduled Queries accept a timezone-aware cron-like string.
bq mk --transfer_config \
  --project_id="${PROJECT}" \
  --location="${LOCATION}" \
  --data_source=scheduled_query \
  --display_name="${NAME}" \
  --schedule="every day 09:00" \
  --schedule_start_time="$(date -u +%Y-%m-%dT03:30:00Z)" \
  --params="$(python - "$QUERY" <<'PY'
import json, sys
print(json.dumps({"query": sys.argv[1]}))
PY
)"

echo "✔ Scheduled query '${NAME}' created."
echo "  NOTE: bq's 'every day 09:00' is in the transfer's timezone (project default UTC)."
echo "  For a strict 09:00 IST run, set the schedule in the BigQuery console"
echo "  (Scheduled queries → edit → 'At a set time' 09:00, timezone (GMT+05:30) India),"
echo "  or use the console cron: 30 3 * * *  (=09:00 IST) with timezone UTC."
