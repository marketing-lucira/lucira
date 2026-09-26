"""
Store Visit & Sales Conversion Intelligence -- standalone Cloud Run service
============================================================================
Serves the single-file dashboard (index.html + svci.js + svci_data.js) behind
HTTP Basic Auth, since deal-level drill-down shows real unmasked customer
names/mobile numbers. Deliberately separate from zoho-login-dashboard (kept
untouched, per explicit request) -- its own service, its own credential.

Auth pattern copied from zoho-login-dashboard/main.py (lines ~75-104): gate is
OFF only if DASH_USER/DASH_PASS are both unset (avoids locking out an
un-provisioned deploy); set them as Cloud Run env vars to turn it on.
"""
import os
import hmac

from flask import Flask, request, Response, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=None)

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
        {"WWW-Authenticate": 'Basic realm="Store Visit Intelligence"'},
    )


@app.route("/health")
def health():
    return {"status": "ok"}


@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory(HERE, "index.html")


@app.route("/svci.js")
def svci_js():
    return send_from_directory(HERE, "svci.js")


@app.route("/svci_data.js")
def svci_data_js():
    # The raw file (~34MB) exceeds Cloud Run's ~32MB single-response ceiling and gets a bare
    # 500 with no application-level traceback (fails at the infra proxy layer, before Flask
    # even logs anything). JSON compresses very well (34MB -> ~1.7MB here), so we serve a
    # pre-gzipped copy with an explicit Content-Encoding header; every browser decompresses
    # this transparently for a plain <script src="svci_data.js"> tag, no dashboard JS changes
    # needed. Keeping this behind the same Basic-Auth gate (unlike a public GCS object, which
    # would expose the real unmasked customer names/mobiles in this data with no login).
    resp = send_from_directory(HERE, "svci_data.js.gz")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Content-Type"] = "application/javascript; charset=utf-8"
    return resp


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
