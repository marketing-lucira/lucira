-- ============================================================================
-- bi.alerts_log + bi.insights_log — audit trail for every rule firing and every
-- LLM narrative/recommendation. Idempotent creates.
-- ============================================================================
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.bi.alerts_log` (
  run_id        STRING,
  fired_at      TIMESTAMP,
  rule_id       STRING,
  severity      STRING,         -- info|warn|critical
  domain        STRING,
  entity        STRING,         -- dimension name, e.g. 'store'
  entity_value  STRING,
  metric        FLOAT64,
  threshold     FLOAT64,
  message       STRING,
  owner         STRING,
  status        STRING          -- open|ack|resolved
)
PARTITION BY DATE(fired_at)
CLUSTER BY rule_id, severity
OPTIONS (description = 'Every rule-engine firing. Trend + acknowledgement tracking.');

CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.bi.insights_log` (
  run_id          STRING,
  generated_at    TIMESTAMP,
  domain          STRING,
  kpi_key         STRING,
  headline        STRING,
  what            STRING,
  why             STRING,
  impact          STRING,
  confidence      STRING,
  recommendation  STRING,
  priority        STRING,       -- P1|P2|P3
  owner           STRING,
  eta_days        INT64,
  est_value_inr   FLOAT64,
  model           STRING,
  prompt_version  STRING
)
PARTITION BY DATE(generated_at)
CLUSTER BY domain
OPTIONS (description = 'LLM-generated insights + recommendations, cached and auditable.');
