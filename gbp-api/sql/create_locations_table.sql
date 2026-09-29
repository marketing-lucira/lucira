CREATE TABLE IF NOT EXISTS `lucirajewelry-prod.ds_imputed_reporting.google_business_profile_locations` (
  account_id     STRING,
  account_name   STRING,
  location_id    STRING NOT NULL,
  location_name  STRING,
  store_name     STRING,
  store_code     STRING,   -- NULL until matched to store_location_store_master
  store_address  STRING,
  city           STRING,
  state          STRING,
  country        STRING,
  phone          STRING,
  website        STRING,
  is_active      BOOL,
  last_synced_at TIMESTAMP
);
