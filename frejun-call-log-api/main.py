"""
FreJun Call Logs -> BigQuery ingestion pipeline
================================================
Cloud Run service `frejun-call-log-ingestion`. Pulls call records from the
FreJun Call Logs API (GET {FREJUN_BASE_URL}/integrations/calls/), paginates
through every page, loads them into a staging table, then MERGEs (upsert) into
the production table `lucirajewelry-prod.frejun_data.frejun_call_log`, keyed
on FreJun's call_id.

Auth: API key is read from Secret Manager (secret `frejun-api-key`) at request
time and held only in memory for the duration of the request. It is never
logged, never returned in any response body, and never written to disk.

Endpoints:
  GET  /health                 -> liveness check
  GET  /test/secret            -> confirms Secret Manager access (no value exposed)
  GET  /test/auth              -> confirms FreJun API auth works (1-record probe)
  GET  /test/sample?limit=5    -> fetch a small sample, return field names only
  POST /ingest                 -> full run. Body (optional JSON):
                                   {"start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD"}
                                   Falls back to START_DATE/END_DATE env vars.
                                   Runs fetch -> stage -> MERGE.
  POST /ingest/incremental     -> run using the stored sync watermark as the
                                   start of the window (with a small overlap),
                                   end = now. Intended for the future 30-min
                                   Cloud Scheduler job.

Deploy / test commands: see README.md.
"""
import os
import json
import time
import logging
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, request, jsonify
from google.cloud import bigquery
from google.cloud import secretmanager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("frejun-ingest")

# ---------------------------------------------------------------------------
# Config (env vars only — nothing sensitive hard-coded)
# ---------------------------------------------------------------------------
GCP_PROJECT     = os.environ.get("GCP_PROJECT", "lucirajewelry-prod")
BQ_DATASET      = os.environ.get("BQ_DATASET", "frejun_data")
BQ_TABLE        = os.environ.get("BQ_TABLE", "frejun_call_log")
BQ_STAGING      = os.environ.get("BQ_STAGING_TABLE", "frejun_call_log_stg")
BQ_STATE_TABLE  = os.environ.get("BQ_STATE_TABLE", "frejun_sync_state")

SECRET_NAME     = os.environ.get("FREJUN_SECRET_NAME", "frejun-api-key")
FREJUN_BASE_URL = os.environ.get("FREJUN_BASE_URL", "https://api.frejun.com/api/v2")
FREJUN_ENDPOINT = "/integrations/calls/"
# FreJun's API requires an `email` query param identifying which FreJun user's
# account the request acts as — this is NOT a secret, just a config value.
FREJUN_USER_EMAIL = os.environ.get("FREJUN_USER_EMAIL", "")

START_DATE_ENV  = os.environ.get("START_DATE", "")   # YYYY-MM-DD, historical load only
END_DATE_ENV    = os.environ.get("END_DATE", "")     # YYYY-MM-DD

MAX_PAGES       = int(os.environ.get("MAX_PAGES", "2000"))     # hard safety cap
HTTP_TIMEOUT    = int(os.environ.get("HTTP_TIMEOUT_SECONDS", "30"))
MAX_RETRIES     = int(os.environ.get("MAX_RETRIES", "5"))
INCREMENTAL_OVERLAP_MIN = int(os.environ.get("INCREMENTAL_OVERLAP_MINUTES", "15"))

DATASET_FQN = f"{GCP_PROJECT}.{BQ_DATASET}"
TABLE_FQN   = f"{DATASET_FQN}.{BQ_TABLE}"
STAGING_FQN = f"{DATASET_FQN}.{BQ_STAGING}"
STATE_FQN   = f"{DATASET_FQN}.{BQ_STATE_TABLE}"

app = Flask(__name__)

_bq_client = None
_secret_client = None
_api_key_cache = {"value": None, "fetched_at": 0}
_API_KEY_TTL_SECONDS = 300  # re-fetch periodically instead of caching forever


def bq():
    global _bq_client
    if _bq_client is None:
        _bq_client = bigquery.Client(project=GCP_PROJECT)
    return _bq_client


def secret_client():
    global _secret_client
    if _secret_client is None:
        _secret_client = secretmanager.SecretManagerServiceClient()
    return _secret_client


def get_api_key():
    """Fetch the FreJun API key from Secret Manager. Held only in memory,
    never logged, never included in any HTTP response."""
    now = time.time()
    if _api_key_cache["value"] and (now - _api_key_cache["fetched_at"] < _API_KEY_TTL_SECONDS):
        return _api_key_cache["value"]
    name = f"projects/{GCP_PROJECT}/secrets/{SECRET_NAME}/versions/latest"
    resp = secret_client().access_secret_version(request={"name": name})
    value = resp.payload.data.decode("utf-8").strip()
    if not value:
        raise RuntimeError(f"Secret {SECRET_NAME} exists but is empty")
    _api_key_cache["value"] = value
    _api_key_cache["fetched_at"] = now
    return value


# ---------------------------------------------------------------------------
# FreJun API client
# ---------------------------------------------------------------------------
class FreJunAPIError(Exception):
    pass


def _fmt_frejun_date(dt: datetime) -> str:
    """FreJun expects DD/MM/YY H:M:S."""
    return dt.strftime("%d/%m/%y %H:%M:%S")


def _auth_headers():
    return {"Authorization": f"Api-Key {get_api_key()}"}


def _request_with_retry(url, params=None, headers=None):
    """GET with exponential backoff on timeouts/5xx/429. Never logs headers
    or params that could contain the API key or PII values."""
    delay = 1.0
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=HTTP_TIMEOUT)
        except requests.exceptions.RequestException as exc:
            last_exc = exc
            log.warning("FreJun request attempt %d/%d failed (network): %s", attempt, MAX_RETRIES, type(exc).__name__)
            time.sleep(delay)
            delay *= 2
            continue

        if resp.status_code == 200:
            return resp
        if resp.status_code in (429, 500, 502, 503, 504):
            log.warning("FreJun request attempt %d/%d got HTTP %d, retrying", attempt, MAX_RETRIES, resp.status_code)
            time.sleep(delay)
            delay *= 2
            continue
        # Non-retryable error (4xx other than 429) — fail fast, no key/body in the error
        raise FreJunAPIError(f"FreJun API returned HTTP {resp.status_code} (non-retryable)")

    raise FreJunAPIError(f"FreJun API failed after {MAX_RETRIES} attempts: {type(last_exc).__name__ if last_exc else 'unknown'}")


def fetch_calls_page(date_start=None, date_end=None, next_url=None, page_size=None):
    """Fetch a single page. Pass next_url (verbatim from the previous
    response's pagination `next` field) to continue; otherwise starts a new
    query with date filters."""
    headers = _auth_headers()
    if next_url:
        resp = _request_with_retry(next_url, headers=headers)
    else:
        params = {"email": FREJUN_USER_EMAIL} if FREJUN_USER_EMAIL else {}
        if date_start:
            params["date"] = date_start
        if date_end:
            params["date_end"] = date_end
        if page_size:
            params["page_size"] = page_size
        resp = _request_with_retry(f"{FREJUN_BASE_URL}{FREJUN_ENDPOINT}", params=params, headers=headers)

    try:
        payload = resp.json()
    except ValueError:
        raise FreJunAPIError("FreJun API returned a non-JSON response")

    # Tolerate both a flat {count,next,previous,results} shape and a nested
    # {success,message,data:{count,next,previous,results}} shape — the live
    # /test/sample probe should be used to confirm which one is live in prod.
    container = payload.get("data", payload) if isinstance(payload, dict) else {}
    results = container.get("results", [])
    next_url_out = container.get("next")
    count = container.get("count")
    return results, next_url_out, count, payload


def fetch_all_calls(date_start=None, date_end=None, max_pages=None):
    """Full pagination loop. Continues following `next` until exhausted or
    MAX_PAGES safety cap is hit."""
    max_pages = max_pages or MAX_PAGES
    all_results = []
    next_url = None
    pages_fetched = 0
    total_count = None

    while True:
        results, next_url_out, count, _raw = fetch_calls_page(
            date_start=date_start if not next_url else None,
            date_end=date_end if not next_url else None,
            next_url=next_url,
        )
        pages_fetched += 1
        if total_count is None:
            total_count = count
        all_results.extend(results)
        log.info("FreJun page %d fetched: %d records (running total %d)", pages_fetched, len(results), len(all_results))

        if not next_url_out:
            break
        if pages_fetched >= max_pages:
            log.warning("Hit MAX_PAGES safety cap (%d) — stopping pagination early", max_pages)
            break
        next_url = next_url_out

    return all_results, pages_fetched, total_count


# ---------------------------------------------------------------------------
# Transform: FreJun call object -> BigQuery row
# ---------------------------------------------------------------------------
def _to_ts(value):
    """Best-effort parse of a FreJun timestamp string into an isoformat UTC
    string BigQuery's JSON loader accepts for a TIMESTAMP column. Returns
    None (not an empty string) on anything unparseable, rather than guessing."""
    if not value:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        except (ValueError, OSError):
            return None
    if isinstance(value, str):
        v = value.strip()
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%S.%f",
                    "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S",
                    "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S",
                    "%d/%m/%y %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
            try:
                dt = datetime.strptime(v, fmt)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat()
            except ValueError:
                continue
        return None
    return None


def _num(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def transform_call(raw: dict, synced_at_iso: str) -> dict:
    """Map one raw FreJun call object to the frejun_call_log row shape.
    Field names verified 2026-09-24 against the LIVE FreJun API response
    (not just docs): ai_insights, call_duration, call_end_time, call_id,
    call_outcome, call_reason, call_start_time, call_transcript, call_type,
    campaign_name, candidate_id, candidate_name, candidate_number, cost,
    creator_number, id, job_id, link, recording_url, recruiter,
    recruiter_notes, status, tags, transaction_id, virtual_number (a plain
    phone-number string). Everything is also preserved verbatim in
    raw_response as a safety net."""
    call_id = raw.get("call_id")
    if not call_id:
        return None  # can't upsert a record with no business key

    insights = raw.get("ai_insights")

    return {
        "call_id": str(call_id),
        "record_id": str(raw.get("id")) if raw.get("id") is not None else None,
        "creator": raw.get("recruiter"),
        "creator_number": raw.get("creator_number"),
        "call_status": raw.get("status"),
        "call_type": raw.get("call_type"),
        "call_start": _to_ts(raw.get("call_start_time")),
        "call_end": _to_ts(raw.get("call_end_time")),
        "duration_seconds": _num(raw.get("call_duration")),
        "phone_number": raw.get("candidate_number"),
        "contact_name": raw.get("candidate_name"),
        "call_reason": raw.get("call_reason"),
        "call_outcome": raw.get("call_outcome"),
        "notes": raw.get("recruiter_notes"),
        "job_id": raw.get("job_id"),
        "transaction_id": raw.get("transaction_id"),
        "candidate_id": raw.get("candidate_id"),
        "campaign_name": raw.get("campaign_name"),
        "recording_url": raw.get("recording_url"),
        "sharable_url": raw.get("link"),
        "cost": _num(raw.get("cost")),
        "virtual_number": raw.get("virtual_number"),
        # NOTE: JSON-typed BigQuery columns must receive a native object/array/
        # scalar in the NDJSON row, not a pre-serialized string — load_staging()
        # already does the one-and-only json.dumps() of the whole row. Dumping
        # here too would double-encode (JSON column holding an escaped string).
        "tags": raw.get("tags"),
        "call_transcript": raw.get("call_transcript"),
        "insights": insights,
        "raw_response": raw,
        "source_synced_at": synced_at_iso,
    }


# ---------------------------------------------------------------------------
# BigQuery load + MERGE
# ---------------------------------------------------------------------------
def ensure_schema():
    sql_path = os.path.join(os.path.dirname(__file__), "sql", "create_tables.sql")
    with open(sql_path, "r", encoding="utf-8") as fh:
        script = fh.read()
    bq().query(script).result()


def load_staging(rows):
    """Truncate + reload the staging table with this run's rows."""
    if not rows:
        job_config = bigquery.QueryJobConfig()
        bq().query(f"TRUNCATE TABLE `{STAGING_FQN}`", job_config=job_config).result()
        return 0
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
    )
    ndjson = "\n".join(json.dumps(r) for r in rows).encode("utf-8")
    import io
    job = bq().load_table_from_file(io.BytesIO(ndjson), STAGING_FQN, job_config=job_config)
    job.result()
    return len(rows)


def merge_into_production():
    sql_path = os.path.join(os.path.dirname(__file__), "sql", "merge.sql")
    with open(sql_path, "r", encoding="utf-8") as fh:
        template = fh.read()
    sql = template.replace("{dataset}", DATASET_FQN)

    before = list(bq().query(f"SELECT COUNT(*) AS n FROM `{TABLE_FQN}`").result())[0].n
    job = bq().query(sql)
    job.result()
    after = list(bq().query(f"SELECT COUNT(*) AS n FROM `{TABLE_FQN}`").result())[0].n
    inserted = max(after - before, 0)
    return {
        "rows_before": before,
        "rows_after": after,
        "inserted": inserted,
        "affected_by_dml": job.num_dml_affected_rows,
    }


def get_sync_state():
    rows = list(bq().query(
        f"SELECT last_synced_at FROM `{STATE_FQN}` WHERE sync_key = 'frejun_calls' LIMIT 1"
    ).result())
    if rows and rows[0].last_synced_at:
        return rows[0].last_synced_at
    return None


def set_sync_state(watermark_dt: datetime):
    bq().query(
        f"""
        MERGE `{STATE_FQN}` T
        USING (SELECT 'frejun_calls' AS sync_key, TIMESTAMP(@ts) AS last_synced_at) S
        ON T.sync_key = S.sync_key
        WHEN MATCHED THEN UPDATE SET last_synced_at = S.last_synced_at, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (sync_key, last_synced_at, updated_at)
          VALUES (S.sync_key, S.last_synced_at, CURRENT_TIMESTAMP())
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("ts", "STRING", watermark_dt.isoformat())
        ]),
    ).result()


# ---------------------------------------------------------------------------
# Pipeline runner
# ---------------------------------------------------------------------------
def run_pipeline(date_start_dt: datetime, date_end_dt: datetime):
    run_started = time.time()
    log.info("FreJun ingestion run START — window %s to %s", date_start_dt.isoformat(), date_end_dt.isoformat())

    ensure_schema()

    raw_calls, pages_fetched, total_count = fetch_all_calls(
        date_start=_fmt_frejun_date(date_start_dt),
        date_end=_fmt_frejun_date(date_end_dt),
    )
    log.info("FreJun records received: %d across %d pages (API reported count=%s)", len(raw_calls), pages_fetched, total_count)

    synced_at_iso = datetime.now(timezone.utc).isoformat()
    rows = []
    skipped_no_key = 0
    for raw in raw_calls:
        row = transform_call(raw, synced_at_iso)
        if row is None:
            skipped_no_key += 1
            continue
        rows.append(row)

    staged = load_staging(rows)
    merge_result = merge_into_production()
    set_sync_state(date_end_dt)

    duration_s = round(time.time() - run_started, 2)
    result = {
        "status": "ok",
        "date_start": date_start_dt.isoformat(),
        "date_end": date_end_dt.isoformat(),
        "pages_fetched": pages_fetched,
        "records_received": len(raw_calls),
        "records_skipped_no_call_id": skipped_no_key,
        "records_staged": staged,
        "rows_before_merge": merge_result["rows_before"],
        "rows_after_merge": merge_result["rows_after"],
        "rows_newly_inserted": merge_result["inserted"],
        "rows_affected_by_merge": merge_result["affected_by_dml"],
        "duration_seconds": duration_s,
    }
    log.info("FreJun ingestion run END — %s", json.dumps(result))
    return result


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "frejun-call-log-ingestion"})


@app.get("/test/secret")
def test_secret():
    try:
        key = get_api_key()
        return jsonify({"status": "ok", "secret_name": SECRET_NAME, "key_length": len(key)})
    except Exception as exc:
        log.error("Secret Manager access failed: %s", type(exc).__name__)
        return jsonify({"status": "error", "error": "secret_access_failed", "detail": type(exc).__name__}), 500


@app.get("/test/auth")
def test_auth():
    try:
        results, next_url, count, _raw = fetch_calls_page(page_size=1)
        return jsonify({
            "status": "ok",
            "auth": "success",
            "sample_record_count_in_page": len(results),
            "api_reported_total_count": count,
            "has_next_page": bool(next_url),
        })
    except FreJunAPIError as exc:
        return jsonify({"status": "error", "error": "frejun_api_error", "detail": str(exc)}), 502
    except Exception as exc:
        log.error("Auth test failed: %s", type(exc).__name__)
        return jsonify({"status": "error", "error": "unexpected", "detail": type(exc).__name__}), 500


@app.get("/test/sample")
def test_sample():
    limit = int(request.args.get("limit", 5))
    try:
        results, next_url, count, _raw = fetch_calls_page(page_size=limit)
        sample = results[:limit]
        field_names = sorted({k for rec in sample for k in rec.keys()}) if sample else []
        # Redact any obviously sensitive-looking values (phone numbers, names,
        # recording URLs) while still showing shape/field names for verification.
        redacted = []
        for rec in sample:
            r = {}
            for k, v in rec.items():
                if k in ("phone_number", "candidate_number", "name", "recording_url",
                          "sharable_url", "notes", "creator"):
                    r[k] = "<redacted>" if v not in (None, "") else v
                else:
                    r[k] = v
            redacted.append(r)
        return jsonify({
            "status": "ok",
            "field_names": field_names,
            "api_reported_total_count": count,
            "sample_redacted": redacted,
        })
    except FreJunAPIError as exc:
        return jsonify({"status": "error", "error": "frejun_api_error", "detail": str(exc)}), 502


@app.post("/ingest")
def ingest():
    body = request.get_json(silent=True) or {}
    start_str = body.get("start_date") or START_DATE_ENV
    end_str = body.get("end_date") or END_DATE_ENV
    if not start_str or not end_str:
        return jsonify({"status": "error", "error": "start_date and end_date are required (body or START_DATE/END_DATE env vars)"}), 400
    try:
        date_start_dt = datetime.strptime(start_str, "%Y-%m-%d").replace(hour=0, minute=0, second=0, tzinfo=timezone.utc)
        date_end_dt = datetime.strptime(end_str, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
    except ValueError:
        return jsonify({"status": "error", "error": "start_date/end_date must be YYYY-MM-DD"}), 400

    try:
        result = run_pipeline(date_start_dt, date_end_dt)
        return jsonify(result)
    except FreJunAPIError as exc:
        log.error("Ingestion failed (FreJun API): %s", str(exc))
        return jsonify({"status": "error", "error": "frejun_api_error", "detail": str(exc)}), 502
    except Exception as exc:
        log.error("Ingestion failed (unexpected): %s", type(exc).__name__)
        return jsonify({"status": "error", "error": "unexpected", "detail": type(exc).__name__}), 500


@app.post("/ingest/incremental")
def ingest_incremental():
    try:
        ensure_schema()
        watermark = get_sync_state()
        now = datetime.now(timezone.utc)
        if watermark:
            date_start_dt = watermark - timedelta(minutes=INCREMENTAL_OVERLAP_MIN)
        else:
            date_start_dt = now - timedelta(days=1)
        result = run_pipeline(date_start_dt, now)
        return jsonify(result)
    except FreJunAPIError as exc:
        log.error("Incremental ingestion failed (FreJun API): %s", str(exc))
        return jsonify({"status": "error", "error": "frejun_api_error", "detail": str(exc)}), 502
    except Exception as exc:
        log.error("Incremental ingestion failed (unexpected): %s", type(exc).__name__)
        return jsonify({"status": "error", "error": "unexpected", "detail": type(exc).__name__}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
