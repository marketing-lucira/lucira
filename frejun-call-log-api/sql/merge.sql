-- Upsert staging -> production on the FreJun call_id business key.
-- {dataset} is substituted by main.py (always lucirajewelry-prod.frejun_data — never any other dataset).
MERGE `{dataset}.frejun_call_log` T
USING (
  -- de-dupe within the staging batch itself: keep the most-recently-synced row per call_id
  SELECT * EXCEPT(rn) FROM (
    SELECT s.*, ROW_NUMBER() OVER (PARTITION BY call_id ORDER BY source_synced_at DESC) AS rn
    FROM `{dataset}.frejun_call_log_stg` s
    WHERE call_id IS NOT NULL
  )
  WHERE rn = 1
) S
ON T.call_id = S.call_id
WHEN MATCHED THEN UPDATE SET
  record_id         = S.record_id,
  creator            = S.creator,
  creator_number     = S.creator_number,
  call_status        = S.call_status,
  call_type          = S.call_type,
  call_start         = S.call_start,
  call_end           = S.call_end,
  duration_seconds   = S.duration_seconds,
  phone_number       = S.phone_number,
  contact_name       = S.contact_name,
  call_reason        = S.call_reason,
  call_outcome       = S.call_outcome,
  notes              = S.notes,
  job_id             = S.job_id,
  transaction_id     = S.transaction_id,
  candidate_id       = S.candidate_id,
  campaign_name      = S.campaign_name,
  recording_url      = S.recording_url,
  sharable_url       = S.sharable_url,
  cost               = S.cost,
  virtual_number     = S.virtual_number,
  tags               = S.tags,
  call_transcript    = S.call_transcript,
  insights           = S.insights,
  raw_response       = S.raw_response,
  source_synced_at   = S.source_synced_at,
  _updated_at        = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (
  call_id, record_id, creator, creator_number, call_status, call_type, call_start, call_end,
  duration_seconds, phone_number, contact_name, call_reason, call_outcome, notes,
  job_id, transaction_id, candidate_id, campaign_name, recording_url,
  sharable_url, cost, virtual_number, tags, call_transcript, insights, raw_response,
  source_synced_at, _ingested_at, _updated_at
) VALUES (
  S.call_id, S.record_id, S.creator, S.creator_number, S.call_status, S.call_type, S.call_start, S.call_end,
  S.duration_seconds, S.phone_number, S.contact_name, S.call_reason, S.call_outcome, S.notes,
  S.job_id, S.transaction_id, S.candidate_id, S.campaign_name, S.recording_url,
  S.sharable_url, S.cost, S.virtual_number, S.tags, S.call_transcript, S.insights, S.raw_response,
  S.source_synced_at, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);
