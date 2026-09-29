"""
Hourly Deals vs Orders Dashboard — standalone Cloud Run static host.
Serves dashboard/hourly-deals-orders.html + hdo.js (copied into static/ as
index.html + hdo.js) at both "/" and "/dashboard". No backend of its own --
the page pulls live data client-side from zoho-crm-bundle-public (Deals) and
hourly-deals-orders-api (Orders, BigQuery marketing_sale). Kept in its own
Cloud Run service, same pattern as ga4-geo-intelligence-app, so it can be
shared as one link with the whole team.

Gated by HTTP Basic Auth (server-side, credentials never ship in page
source) -- set DASH_USER/DASH_PASS env vars on the Cloud Run service to
whatever you want the team's login to be (see deploy.sh).
"""
import hmac
import os

from flask import Flask, Response, request, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="")

DASH_USER = os.environ.get("DASH_USER", "")
DASH_PASS = os.environ.get("DASH_PASS", "")
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
