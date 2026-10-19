"""
GA4 Geo Intelligence Dashboard — standalone Cloud Run static host.
Serves the self-contained city/pincode/area demand-intelligence dashboard
(dashboard/ga4-geo-intelligence-dashboard.html + geo_intel_data.js, copied
into static/ as index.html) at both "/" and "/dashboard". No backend, no
BigQuery — the data is a static pre-built snapshot, same as the GitHub
Pages deploy of this same file. Kept in its own Cloud Run service so it
never gets bundled with any other Lucira dashboard.

Gated by HTTP Basic Auth (server-side, unlike a client-side JS gate — the
credentials never ship in the page source). Set DASH_USER/DASH_PASS as
env vars on the service to change them; defaults below match what's
currently issued to the Lucira team.
"""
import hmac
import logging
import os
import threading
import time

from flask import Flask, Response, request, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="")

DASH_USER = os.environ.get("DASH_USER", "Lucira")
DASH_PASS = os.environ.get("DASH_PASS", "admin@2026")
_AUTH_EXEMPT = frozenset(("/health",))


@app.before_request
def _require_login():
    if not (DASH_USER and DASH_PASS):
        return None
    if request.path in _AUTH_EXEMPT:
        return None
    auth = request.authorization
    if (auth is not None
            and hmac.compare_digest(auth.username or "", DASH_USER)
            and hmac.compare_digest(auth.password or "", DASH_PASS)):
        return None
    return Response(
        "Authentication required.", 401,
        {"WWW-Authenticate": 'Basic realm="Lucira Dashboard"'},
    )


# ---- Daily data (2026-10-19) ----------------------------------------------------------------
# The pincode-refresh Cloud Run Job rebuilds geo_intel_data.js every morning and writes it to a
# PRIVATE bucket. Serve that copy (cached in memory for DATA_TTL seconds) so the dashboard updates
# without redeploying; fall back to the copy baked into static/ if GCS is unreachable or unset.
DATA_BUCKET = os.environ.get("DATA_BUCKET", "lucirajewelry-prod-pincode-refresh")
DATA_OBJECT = os.environ.get("DATA_OBJECT", "ga4-geo/geo_intel_data.js")
DATA_TTL = int(os.environ.get("DATA_TTL", "600"))
_cache = {"body": None, "at": 0.0, "generation": None}
_lock = threading.Lock()


def _live_data():
    if not DATA_BUCKET:
        return None
    with _lock:
        if _cache["body"] is not None and time.time() - _cache["at"] < DATA_TTL:
            return _cache["body"]
        try:
            from google.cloud import storage  # imported lazily: local runs need no GCP libs
            blob = storage.Client().bucket(DATA_BUCKET).get_blob(DATA_OBJECT)
            if blob is None:
                return _cache["body"]
            if blob.generation != _cache["generation"]:
                _cache["body"] = blob.download_as_bytes()
                _cache["generation"] = blob.generation
            _cache["at"] = time.time()
        except Exception:  # keep serving the last good copy (or the static one) on any GCS error
            logging.exception("geo_intel_data.js fetch from GCS failed")
        return _cache["body"]


@app.route("/geo_intel_data.js")
def geo_data():
    body = _live_data()
    if body is None:
        return send_from_directory(app.static_folder, "geo_intel_data.js")
    return Response(body, mimetype="application/javascript", headers={"Cache-Control": "no-cache"})


@app.route("/health")
def health():
    return "ok"


@app.route("/")
@app.route("/dashboard")
def dashboard():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
