"""Google OAuth 2.0 user-consent flow for Business Profile APIs.

Mirrors the pattern already used in zoho-login-dashboard/main.py: the
long-lived refresh token is persisted in GCS (instance-independent, no
Secret Manager write access needed from Cloud Run at runtime), and a fresh
access token is minted from it on every call. No client secret or token is
ever hardcoded or logged.
"""
import datetime as dt
import json
import secrets

import requests
from google.cloud import storage

from app import config

_gcs = storage.Client(project=config.PROJECT)


def build_authorization_url(state: str) -> str:
    params = {
        "client_id": config.GOOGLE_CLIENT_ID,
        "redirect_uri": config.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": config.OAUTH_SCOPES,
        "access_type": "offline",
        "prompt": "consent",  # forces a refresh_token even on repeat consent
        "state": state,
    }
    query = "&".join(f"{k}={requests.utils.quote(v)}" for k, v in params.items())
    return f"{config.GOOGLE_AUTH_URL}?{query}"


def new_state() -> str:
    return secrets.token_urlsafe(24)


def exchange_code_for_tokens(code: str) -> dict:
    resp = requests.post(
        config.GOOGLE_TOKEN_URL,
        data={
            "code": code,
            "client_id": config.GOOGLE_CLIENT_ID,
            "client_secret": config.GOOGLE_CLIENT_SECRET,
            "redirect_uri": config.GOOGLE_REDIRECT_URI,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    data = resp.json()
    if "refresh_token" not in data:
        raise RuntimeError(
            "Token exchange did not return a refresh_token. Google said: "
            f"{data}. If you've authorized this app before, revoke access at "
            "https://myaccount.google.com/permissions and retry so Google "
            "issues a new refresh_token."
        )
    return data


def _save_refresh_token(token: str) -> None:
    blob = _gcs.bucket(config.GCS_BUCKET).blob(config.REFRESH_BLOB)
    blob.upload_from_string(
        json.dumps({"refresh_token": token,
                    "saved_at": dt.datetime.utcnow().isoformat() + "Z"}),
        content_type="application/json",
    )


def _load_refresh_token() -> str | None:
    blob = _gcs.bucket(config.GCS_BUCKET).blob(config.REFRESH_BLOB)
    if not blob.exists():
        return None
    return json.loads(blob.download_as_text()).get("refresh_token")


def save_tokens_from_callback(token_response: dict) -> None:
    _save_refresh_token(token_response["refresh_token"])


def is_connected() -> bool:
    try:
        return _load_refresh_token() is not None
    except Exception:
        return False


def get_access_token() -> str:
    """Exchange the stored refresh token for a fresh access token."""
    rt = _load_refresh_token()
    if not rt:
        raise RuntimeError(
            "Not connected to Google Business Profile yet. "
            "Visit /oauth/login and complete consent as tech@lucirajewelry.com."
        )
    resp = requests.post(
        config.GOOGLE_TOKEN_URL,
        data={
            "refresh_token": rt,
            "client_id": config.GOOGLE_CLIENT_ID,
            "client_secret": config.GOOGLE_CLIENT_SECRET,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    data = resp.json()
    if "access_token" not in data:
        raise RuntimeError(f"Access token refresh failed: {data}")
    return data["access_token"]
