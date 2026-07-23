-- ============================================================================
-- BI COPILOT semantic layer — dataset + config/log tables.  Idempotent.
-- Run:  bq query --use_legacy_sql=false --location=asia-south1 < sql/00_setup_bi_dataset.sql
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS `lucirajewelry-prod.bi`
OPTIONS (location = 'asia-south1', description = 'Lucira BI Copilot semantic + logging layer');

-- Optional runtime override of rules.yaml (edit rules without redeploy).
CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.bi.rule_config` (
  rule_id     STRING NOT NULL,
  enabled     BOOL,
  threshold   FLOAT64,
  severity    STRING,
  updated_at  TIMESTAMP,
  updated_by  STRING
) OPTIONS (description = 'Runtime overrides for config/rules.yaml. Seeded from YAML; empty = use YAML.');
