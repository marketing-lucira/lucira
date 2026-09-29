CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_daily` (
  report_date         DATE NOT NULL,
  account_id          STRING,
  location_id         STRING NOT NULL,
  store_code          STRING,
  store_name          STRING,
  location_name       STRING,

  review_count        INT64,
  average_rating      FLOAT64,

  direction_requests  INT64,
  call_clicks         INT64,

  created_at          TIMESTAMP,
  updated_at          TIMESTAMP
)
PARTITION BY report_date
CLUSTER BY store_code, location_id;
