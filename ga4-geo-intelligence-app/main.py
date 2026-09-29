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
import os

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


@app.route("/health")
def health():
    return "ok"


@app.route("/")
@app.route("/dashboard")
def dashboard():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
