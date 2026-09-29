-- FreJun Call Log pipeline — dataset + table DDL
-- Dataset: lucirajewelry-prod.frejun_data (new, dedicated to this pipeline only)
-- Safe to re-run: CREATE ... IF NOT EXISTS everywhere. Never touches any other dataset.

CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.frejun_data`
OPTIONS (location = 'asia-south1');

-- Production table: one current row per FreJun call_id (business key).
-- Column set verified 2026-09-24 against the LIVE FreJun API response (GET
-- /integrations/calls/), not just the docs — real field names are:
-- ai_insights, call_duration, call_end_time, call_id, call_outcome,
-- call_reason, call_start_time, call_transcript, call_type, campaign_name,
-- candidate_id, candidate_name, candidate_number, cost, creator_number, id,
-- job_id, link, recording_url, recruiter, recruiter_notes, status, tags,
-- transaction_id, virtual_number (a plain phone-number string, not nested).
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.frejun_data.frejun_call_log` (
  call_id           STRING    NOT NULL OPTIONS(description = 'FreJun call_id — business/primary key, unique per call'),
  record_id         STRING    OPTIONS(description = 'FreJun internal numeric record id ("id" field)'),
  creator           STRING    OPTIONS(description = 'FreJun user/agent email ("recruiter" field)'),
  creator_number    STRING    OPTIONS(description = 'FreJun user/agent phone number'),
  call_status       STRING    OPTIONS(description = 'FreJun "status" field, e.g. answered, not-answered, not_available, user-busy, blocked, DND ...'),
  call_type         STRING    OPTIONS(description = 'Call direction, e.g. outgoing / incoming'),
  call_start        TIMESTAMP OPTIONS(description = 'Call start time (UTC) — "call_start_time"'),
  call_end          TIMESTAMP OPTIONS(description = 'Call end time (UTC) — "call_end_time"'),
  duration_seconds  FLOAT64   OPTIONS(description = 'Call duration in seconds — "call_duration"'),
  phone_number      STRING    OPTIONS(description = 'Counterparty phone number — "candidate_number"'),
  contact_name      STRING    OPTIONS(description = 'Counterparty name — "candidate_name"'),
  call_reason       STRING,
  call_outcome      STRING,
  notes             STRING    OPTIONS(description = '"recruiter_notes"'),
  job_id            STRING,
  transaction_id    STRING,
  candidate_id      STRING,
  campaign_name     STRING,
  recording_url     STRING,
  sharable_url      STRING    OPTIONS(description = '"link" field'),
  cost              FLOAT64   OPTIONS(description = 'Call cost, if returned by FreJun'),
  virtual_number    STRING    OPTIONS(description = 'FreJun virtual number used for this call (plain phone number string)'),
  tags              JSON      OPTIONS(description = 'Raw tags array as returned by FreJun'),
  call_transcript   STRING    OPTIONS(description = '"call_transcript" — full text transcript, if generated'),
  insights          JSON      OPTIONS(description = '"ai_insights" — summary, sentiment, talk ratio, Q&A pairs, as returned by FreJun'),
  raw_response      JSON      OPTIONS(description = 'Full raw FreJun call object for this record, verbatim — safety net for fields not modeled above'),
  source_synced_at  TIMESTAMP OPTIONS(description = 'Wall-clock time this row was fetched from the FreJun API'),
  _ingested_at      TIMESTAMP OPTIONS(description = 'First time this call_id was written to this table'),
  _updated_at       TIMESTAMP OPTIONS(description = 'Last time this row was updated by the MERGE')
)
PARTITION BY DATE(call_start)
CLUSTER BY call_id, call_status
OPTIONS (description = 'FreJun Call Logs — one current record per call_id, upserted via staging+MERGE. Owned by frejun-call-log-ingestion Cloud Run service.');

-- Staging table: truncated + reloaded every run, then MERGEd into frejun_call_log.
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.frejun_data.frejun_call_log_stg` (
  call_id           STRING,
  record_id         STRING,
  creator           STRING,
  creator_number    STRING,
  call_status       STRING,
  call_type         STRING,
  call_start        TIMESTAMP,
  call_end          TIMESTAMP,
  duration_seconds  FLOAT64,
  phone_number      STRING,
  contact_name      STRING,
  call_reason       STRING,
  call_outcome      STRING,
  notes             STRING,
  job_id            STRING,
  transaction_id    STRING,
  candidate_id      STRING,
  campaign_name     STRING,
  recording_url     STRING,
  sharable_url      STRING,
  cost              FLOAT64,
  virtual_number    STRING,
  tags              JSON,
  call_transcript   STRING,
  insights          JSON,
  raw_response      JSON,
  source_synced_at  TIMESTAMP
)
OPTIONS (description = 'Scratch staging table for FreJun ingestion. Truncated + reloaded every run.');

-- Sync-state control table: tracks the incremental-load watermark.
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.frejun_data.frejun_sync_state` (
  sync_key          STRING    NOT NULL OPTIONS(description = 'Constant "frejun_calls"'),
  last_synced_at    TIMESTAMP OPTIONS(description = 'High-water mark: end of the last successfully processed window'),
  updated_at        TIMESTAMP
)
OPTIONS (description = 'Single-row control table for the FreJun incremental sync watermark.');
