CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_api_log` (
  run_id             STRING NOT NULL,
  run_timestamp      TIMESTAMP NOT NULL,
  report_date        DATE,
  location_id        STRING,
  store_code         STRING,
  api_name           STRING,   -- accounts.list | locations.list | reviews.list | performance.fetch
  status             STRING,   -- SUCCESS | FAILED | SKIPPED
  records_processed  INT64,
  error_message       STRING,
  execution_seconds  FLOAT64
)
PARTITION BY DATE(run_timestamp);
