"""Google Business Profile -> BigQuery pipeline. Cloud Run entry point.

Endpoints:
  GET  /health              liveness probe
  GET  /oauth/login          starts Google OAuth consent (business.manage scope)
  GET  /oauth/callback       exchanges code, persists refresh_token to GCS
  POST /sync/locations       discovers accounts + locations, upserts mapping table
  POST /sync/daily           processes last DAILY_REPROCESS_DAYS days (default 7)
  POST /backfill?days=N      historical backfill, N up to MAX_BACKFILL_DAYS
  GET  /test/sample          returns the most recent row from the daily table (JSON)

/sync/* and /backfill are protected by a shared X-Sync-Token header (set via
SYNC_TOKEN env/secret) so only Cloud Scheduler can trigger them; /oauth/*
carries its own CSRF state check and must stay reachable for the one-time
manual consent.
"""
import datetime as dt
import os

from flask import Flask, request, redirect, session, jsonify, abort

from app import config, oauth, gbp_accounts, gbp_locations, gbp_reviews, gbp_performance, bigquery as bq
from app.logging_utils import new_run_id, log_api_call

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "change-me-in-secret-manager")

_SYNC_EXEMPT = frozenset(("/health", "/oauth/login", "/oauth/callback", "/test/sample"))


@app.before_request
def _require_sync_token():
    if request.path in _SYNC_EXEMPT or not config.SYNC_TOKEN:
        return None
    if request.headers.get("X-Sync-Token") != config.SYNC_TOKEN:
        abort(401)


@app.route("/health")
def health():
    return jsonify(status="ok", connected=oauth.is_connected())


@app.route("/oauth/login")
def oauth_login():
    if not (config.GOOGLE_CLIENT_ID and config.GOOGLE_REDIRECT_URI):
        return "GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI not configured.", 500
    state = oauth.new_state()
    session["oauth_state"] = state
    return redirect(oauth.build_authorization_url(state))


@app.route("/oauth/callback")
def oauth_callback():
    if request.args.get("state") != session.get("oauth_state"):
        return "Invalid OAuth state (CSRF check failed). Please retry /oauth/login.", 400
    code = request.args.get("code")
    if not code:
        return f"OAuth error: {request.args.get('error', 'no code returned')}", 400
    try:
        tokens = oauth.exchange_code_for_tokens(code)
        oauth.save_tokens_from_callback(tokens)
    except RuntimeError as exc:
        return str(exc), 400
    return "Connected to Google Business Profile. Refresh token saved. You can close this tab."


def _sync_locations() -> dict:
    run_id = new_run_id()
    access_token = oauth.get_access_token()
    total_locations = 0
    try:
        accounts = gbp_accounts.list_accounts(access_token)
        log_api_call(run_id, None, "", "", "accounts.list", "SUCCESS", len(accounts))
    except Exception as exc:
        log_api_call(run_id, None, "", "", "accounts.list", "FAILED", 0, str(exc))
        raise

    for acc in accounts:
        try:
            locations = gbp_locations.list_locations(access_token, acc["account_id"])
            n = gbp_locations.upsert_locations(acc["account_id"], acc["account_name"], locations)
            total_locations += n
            log_api_call(run_id, None, "", "", "locations.list", "SUCCESS", n)
        except Exception as exc:
            log_api_call(run_id, None, "", "", "locations.list", "FAILED", 0, str(exc))

    return {"run_id": run_id, "accounts": len(accounts), "locations": total_locations}


@app.route("/sync/locations", methods=["POST"])
def sync_locations():
    return jsonify(_sync_locations())


def _sync_window(start: dt.date, end: dt.date) -> dict:
    """Fetch reviews + performance for every active/mapped location across
    [start, end] and MERGE into google_business_profile_daily.
    """
    run_id = new_run_id()
    access_token = oauth.get_access_token()
    locations = bq.get_active_locations()
    rows_by_key: dict[tuple, dict] = {}
    processed, failed = 0, 0

    for loc in locations:
        location_id = loc["location_id"]
        account_id = loc["account_id"]
        store_code = loc.get("store_code")

        # Reviews: one current snapshot value, applied to every date in the
        # window (reviews aren't a per-day time series in the API).
        review_count, average_rating = None, None
        try:
            summary = gbp_reviews.get_review_summary(access_token, account_id, location_id)
            if not summary.get("not_found"):
                review_count = summary["review_count"]
                average_rating = summary["average_rating"]
            log_api_call(run_id, end, location_id, store_code, "reviews.list", "SUCCESS", 1)
        except Exception as exc:
            failed += 1
            log_api_call(run_id, end, location_id, store_code, "reviews.list", "FAILED", 0, str(exc))

        # Performance: real per-day time series.
        daily_metrics = {}
        try:
            daily_metrics = gbp_performance.get_daily_metrics(access_token, location_id, start, end)
            log_api_call(run_id, end, location_id, store_code, "performance.fetch",
                         "SUCCESS", len(daily_metrics))
        except Exception as exc:
            failed += 1
            log_api_call(run_id, end, location_id, store_code, "performance.fetch",
                         "FAILED", 0, str(exc))

        d = start
        while d <= end:
            iso = d.isoformat()
            metrics = daily_metrics.get(iso, {})
            key = (iso, location_id)
            rows_by_key[key] = {
                "report_date": iso,
                "account_id": account_id,
                "location_id": location_id,
                "store_code": store_code,
                "store_name": loc.get("store_name"),
                "location_name": loc.get("location_name"),
                "review_count": review_count,
                "average_rating": average_rating,
                "direction_requests": metrics.get("direction_requests"),
                "call_clicks": metrics.get("call_clicks"),
            }
            d += dt.timedelta(days=1)
        processed += 1

    n = bq.upsert_daily_rows(list(rows_by_key.values()))
    return {
        "run_id": run_id,
        "locations_processed": processed,
        "locations_failed": failed,
        "rows_upserted": n,
        "window": f"{start.isoformat()}..{end.isoformat()}",
    }


@app.route("/sync/daily", methods=["POST"])
def sync_daily():
    """Default: reprocess the last DAILY_REPROCESS_DAYS days, ending yesterday
    (today's data is not yet final in GBP)."""
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=config.DAILY_REPROCESS_DAYS - 1)
    return jsonify(_sync_window(start, end))


@app.route("/backfill", methods=["POST"])
def backfill():
    days = min(int(request.args.get("days", config.MAX_BACKFILL_DAYS)), config.MAX_BACKFILL_DAYS)
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=days - 1)
    return jsonify(_sync_window(start, end))


@app.route("/test/sample")
def test_sample():
    row = bq.get_sample_row()
    if not row:
        return jsonify(error="No rows in google_business_profile_daily yet. Run /sync/locations then /sync/daily."), 404
    return jsonify(row)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
