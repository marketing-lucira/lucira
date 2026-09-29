# FreJun Call Logs -> BigQuery

Pulls call records from the FreJun Call Logs API and upserts them into
`lucirajewelry-prod.frejun_data.frejun_call_log`, keyed on FreJun's `call_id`.

## Architecture

```
FreJun API (/integrations/calls/)
  -> Cloud Run service: frejun-call-log-ingestion (Python/Flask, this repo)
    -> BigQuery staging table: frejun_data.frejun_call_log_stg (WRITE_TRUNCATE)
      -> MERGE (sql/merge.sql)
        -> BigQuery production table: frejun_data.frejun_call_log
```

A small control table `frejun_data.frejun_sync_state` stores the incremental
watermark for `/ingest/incremental`.

Nothing in this pipeline reads, writes, or redeploys any other Lucira
dataset, table, Cloud Run service, Cloud Function, or Scheduler job.

## Auth

- FreJun API: `Authorization: Api-Key <key>` header + required `email` query
  param (the FreJun user the request acts as — not a secret, set via
  `FREJUN_USER_EMAIL`).
- The API key itself is read from Secret Manager secret **`frejun-api-key`**
  at request time only — never hard-coded, never logged, never returned in
  any response.

### Populating the secret

A secret named `frejun-api-key` has been created (empty). If you already
have the key stored elsewhere in Secret Manager (e.g. `FREJUN_API_KEY`,
already present in this project), populate it by piping directly between
secrets — this never displays the value in a terminal or log:

```bash
gcloud secrets versions access latest --secret=FREJUN_API_KEY --project=lucirajewelry-prod \
  | gcloud secrets versions add frejun-api-key --project=lucirajewelry-prod --data-file=-
```

Otherwise, add the key directly:

```bash
printf '%s' 'YOUR_FREJUN_API_KEY' | gcloud secrets versions add frejun-api-key --project=lucirajewelry-prod --data-file=-
```

## BigQuery schema (`frejun_data.frejun_call_log`)

Verified 2026-09-24 against the **live** FreJun API response via `/test/sample`
— the real field names differ from what the public docs describe (e.g. the
docs' `duration`/`start`/`end`/`name` are actually `call_duration`,
`call_start_time`, `call_end_time`, `candidate_name`; `virtual_number` is a
plain phone-number string, not a nested object; there is no `event_id` or
`reference_id` in the response). The schema below matches the live API.

| Column | Type | Source field | Notes |
|---|---|---|---|
| call_id | STRING | `call_id` | business key (unique, NOT NULL) |
| record_id | STRING | `id` | FreJun's internal numeric record id |
| creator | STRING | `recruiter` | agent email |
| creator_number | STRING | `creator_number` | agent phone number |
| call_status | STRING | `status` | answered / not-answered / not_available / user-busy / blocked / DND / ... |
| call_type | STRING | `call_type` | outgoing / incoming |
| call_start | TIMESTAMP | `call_start_time` | UTC |
| call_end | TIMESTAMP | `call_end_time` | UTC |
| duration_seconds | FLOAT64 | `call_duration` | |
| phone_number | STRING | `candidate_number` | counterparty number |
| contact_name | STRING | `candidate_name` | |
| call_reason | STRING | `call_reason` | |
| call_outcome | STRING | `call_outcome` | |
| notes | STRING | `recruiter_notes` | |
| job_id / transaction_id / candidate_id / campaign_name | STRING | same names | caller-supplied metadata |
| recording_url | STRING | `recording_url` | |
| sharable_url | STRING | `link` | |
| cost | FLOAT64 | `cost` | if returned |
| virtual_number | STRING | `virtual_number` | phone number used for the call |
| tags | JSON | `tags` | raw tags array |
| call_transcript | STRING | `call_transcript` | |
| insights | JSON | `ai_insights` | AI summary/sentiment/talk-ratio/Q&A block |
| raw_response | JSON | (whole object) | full raw call object — safety net for anything not modeled above |
| source_synced_at | TIMESTAMP | | when this row was fetched |
| _ingested_at / _updated_at | TIMESTAMP | | row bookkeeping |

Partitioned by `DATE(call_start)`, clustered by `call_id, call_status`.
`raw_response` guarantees no field is ever lost even if the live API adds
fields beyond what's modeled above.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/test/secret` | confirms Secret Manager access (returns key length only) |
| GET | `/test/auth` | 1-record probe against the live FreJun API |
| GET | `/test/sample?limit=5` | fetch N records, return field names + redacted sample |
| POST | `/ingest` | full run; body `{"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD"}` or `START_DATE`/`END_DATE` env vars |
| POST | `/ingest/incremental` | run from the stored watermark (minus a 15-min overlap) to now |

## Deploy

```bash
cd frejun-call-log-api
./deploy.sh
```

Creates the dataset/tables, deploys the Cloud Run service (private —
requires an identity token), and grants the service's own runtime SA
`secretAccessor` on `frejun-api-key` only, plus BigQuery editor/jobUser on
the project (same pattern as every other `*-api` service in this repo).

## Test

```bash
URL="$(gcloud run services describe frejun-call-log-ingestion --region=asia-south1 --format='value(status.url)')"
TOKEN="$(gcloud auth print-identity-token)"

curl -s -H "Authorization: Bearer $TOKEN" "$URL/health"
curl -s -H "Authorization: Bearer $TOKEN" "$URL/test/secret"
curl -s -H "Authorization: Bearer $TOKEN" "$URL/test/auth"
curl -s -H "Authorization: Bearer $TOKEN" "$URL/test/sample?limit=5"

# First historical load
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"start_date":"2026-09-01","end_date":"2026-09-24"}' "$URL/ingest"

# Re-run the same window — call_ids must NOT duplicate (row count should not grow)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"start_date":"2026-09-01","end_date":"2026-09-24"}' "$URL/ingest"
```

## Validation SQL

```sql
-- Row count + duplicate check (should return 0 rows)
SELECT call_id, COUNT(*) c
FROM `lucirajewelry-prod.frejun_data.frejun_call_log`
GROUP BY call_id HAVING c > 1;

SELECT COUNT(*) AS total_calls,
       MIN(call_start) AS earliest,
       MAX(call_start) AS latest
FROM `lucirajewelry-prod.frejun_data.frejun_call_log`;
```

## Future 30-minute scheduler (not created yet, by design)

```bash
gcloud scheduler jobs create http frejun-call-log-sync \
  --location=asia-south1 --schedule="*/30 * * * *" \
  --uri="$URL/ingest/incremental" --http-method=POST \
  --oidc-service-account-email="<the Cloud Run runtime SA from deploy.sh output>" \
  --attempt-deadline=900s
```

## Env vars

See `.env.example`. `START_DATE`/`END_DATE` are only used as a fallback when
`/ingest` is called with no body — pass dates explicitly for the historical
load instead of relying on env vars long-term.
