"""BigQuery staging + MERGE for the daily reporting table."""
from google.cloud import bigquery

from app import config

_bq = bigquery.Client(project=config.PROJECT)


def get_active_locations() -> list[dict]:
    """Locations to process, joined to their store_code."""
    sql = f"""
        SELECT account_id, location_id, store_code, store_name, location_name
        FROM `{config.LOCATIONS_TABLE}`
        WHERE is_active IS TRUE OR is_active IS NULL
    """
    return [dict(r) for r in _bq.query(sql).result()]


def upsert_daily_rows(rows: list[dict]) -> int:
    """MERGE rows into google_business_profile_daily keyed on
    (report_date, location_id). rows: list of dicts matching the table schema
    (created_at/updated_at added here).
    """
    if not rows:
        return 0

    staging_table = f"{config.PROJECT}.{config.DATASET}._stg_gbp_daily"
    _bq.load_table_from_json(
        rows, staging_table,
        job_config=bigquery.LoadJobConfig(write_disposition="WRITE_TRUNCATE", autodetect=True),
    ).result()

    merge_sql = f"""
    MERGE `{config.DAILY_TABLE}` T
    USING `{staging_table}` S
    ON T.report_date = S.report_date AND T.location_id = S.location_id
    WHEN MATCHED THEN UPDATE SET
      account_id = S.account_id,
      store_code = S.store_code,
      store_name = S.store_name,
      location_name = S.location_name,
      review_count = S.review_count,
      average_rating = S.average_rating,
      direction_requests = S.direction_requests,
      call_clicks = S.call_clicks,
      updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
      report_date, account_id, location_id, store_code, store_name, location_name,
      review_count, average_rating, direction_requests, call_clicks,
      created_at, updated_at
    ) VALUES (
      S.report_date, S.account_id, S.location_id, S.store_code, S.store_name, S.location_name,
      S.review_count, S.average_rating, S.direction_requests, S.call_clicks,
      CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    )
    """
    _bq.query(merge_sql).result()
    return len(rows)


def get_sample_row() -> dict | None:
    sql = f"""
        SELECT store_name, report_date, review_count, average_rating,
               direction_requests, call_clicks
        FROM `{config.DAILY_TABLE}`
        ORDER BY report_date DESC
        LIMIT 1
    """
    rows = list(_bq.query(sql).result())
    if not rows:
        return None
    r = dict(rows[0])
    r["date"] = r.pop("report_date").isoformat()
    return r
