"""Retry/backoff HTTP helper + BigQuery API-run logging.

Every Business Profile API call for every location goes through
`request_with_retry` so failures are uniformly retried and, if still
failing, uniformly logged to google_business_profile_api_log instead of
silently dropped.
"""
import time
import uuid
import datetime as dt

import requests
from google.cloud import bigquery

from app import config

_bq = bigquery.Client(project=config.PROJECT)

RETRYABLE_STATUS = {429, 500, 503}
TERMINAL_STATUS = {401, 403, 404}


def new_run_id() -> str:
    return uuid.uuid4().hex


def request_with_retry(method: str, url: str, *, max_retries: int = 5, **kwargs) -> requests.Response:
    """GET/POST with exponential backoff on 429/500/503.

    Raises for 401/403/404 immediately (not retryable — bad/expired token or
    a location that no longer exists) so callers can log a clean FAILED/SKIPPED
    row instead of burning retries on a request that will never succeed.
    """
    delay = 1.0
    last_exc = None
    for attempt in range(max_retries):
        try:
            resp = requests.request(method, url, timeout=60, **kwargs)
        except requests.RequestException as exc:
            last_exc = exc
            time.sleep(delay)
            delay *= 2
            continue

        if resp.status_code < 400:
            return resp
        if resp.status_code in TERMINAL_STATUS:
            return resp  # let the caller decide how to log this
        if resp.status_code in RETRYABLE_STATUS and attempt < max_retries - 1:
            time.sleep(delay)
            delay *= 2
            continue
        return resp

    if last_exc:
        raise last_exc
    return resp  # last non-2xx response after exhausting retries


def log_api_call(
    run_id: str,
    report_date,
    location_id: str,
    store_code: str,
    api_name: str,
    status: str,
    records_processed: int = 0,
    error_message: str = "",
    execution_seconds: float = 0.0,
) -> None:
    row = {
        "run_id": run_id,
        "run_timestamp": dt.datetime.utcnow().isoformat(),
        "report_date": report_date.isoformat() if report_date else None,
        "location_id": location_id,
        "store_code": store_code or "",
        "api_name": api_name,
        "status": status,
        "records_processed": records_processed,
        "error_message": (error_message or "")[:2000],
        "execution_seconds": execution_seconds,
    }
    errors = _bq.insert_rows_json(config.LOG_TABLE, [row])
    if errors:
        # Logging itself must never crash the pipeline — print so it still
        # surfaces in Cloud Run logs.
        print(f"[log_api_call] failed to write log row: {errors}")
