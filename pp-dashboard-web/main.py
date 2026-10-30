"""
Lucira Product Pricing Intelligence -- live dashboard host
============================================================
Serves dashboard/product-pricing-intelligence.html + ppi.js (copied into
static/ at deploy time) behind a shared username/password gate -- the
SAME pattern as zoho-login-dashboard's HTTP Basic Auth (see that
service's main.py, _require_login). No Google Console setup needed.

The dashboard's own data calls (pos-price-api, gold-rate-api) are
unchanged and stay directly reachable -- this service only gates the
HTML/JS page itself.
"""
import hmac
import os

from flask import Flask, request, send_from_directory, Response

app = Flask(__name__, static_folder="static")

# --------------------------------------------------------------------------- #
# Access control (HTTP Basic Auth) -- same pattern as zoho-login-dashboard.
# The gate is OFF until both DASH_USER and DASH_PASS are set (avoids locking
# out an un-provisioned deploy); set them as env/secret to turn it on.
# --------------------------------------------------------------------------- #
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
        {"WWW-Authenticate": 'Basic realm="Lucira Product Pricing Intelligence"'},
    )


@app.get("/health")
def health():
    return "ok", 200


# --------------------------------------------------------------------------- #
# The dashboard itself -- static files, served only once _require_login lets
# the request through.
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "product-pricing-intelligence.html")


@app.get("/ppi.js")
def ppi_js():
    return send_from_directory(app.static_folder, "ppi.js")


# The page + its script must never come from a stale browser cache -- after a
# deploy, a plain reload has to show the new version (users were seeing old
# buttons/labels). ppi_data.js (~11 MB, rarely changes) is left cacheable.
@app.after_request
def _no_stale_page(resp):
    if request.path in ("/", "/ppi.js"):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


@app.get("/ppi_data.js")
def ppi_data_js():
    return send_from_directory(app.static_folder, "ppi_data.js")
