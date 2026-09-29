"""Central configuration for the GBP pipeline. Everything overridable via env."""
import os

PROJECT = os.environ.get("BQ_PROJECT", "lucirajewelry-prod")
REGION = os.environ.get("REGION", "asia-south1")
DATASET = os.environ.get("BQ_DATASET", "ds_imputed_reporting")

LOCATIONS_TABLE = f"{PROJECT}.{DATASET}.google_business_profile_locations"
DAILY_TABLE = f"{PROJECT}.{DATASET}.google_business_profile_daily"
LOG_TABLE = f"{PROJECT}.{DATASET}.google_business_profile_api_log"
STORE_MASTER_TABLE = f"{PROJECT}.{DATASET}.store_location_store_master"

# Refresh-token persistence (GCS), same pattern as zoho-login-dashboard.
GCS_BUCKET = os.environ.get("GCS_BUCKET", "lucira-dashboards")
REFRESH_BLOB = os.environ.get("REFRESH_BLOB", "oauth/gbp_refresh_token.json")

# Google OAuth 2.0 client (create under APIs & Services > Credentials).
# Never hardcode these — injected as env vars / Secret Manager at deploy time.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "")  # <service-url>/oauth/callback
OAUTH_SCOPES = "https://www.googleapis.com/auth/business.manage"

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

ACCOUNT_MGMT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1"
BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1"
REVIEWS_BASE = "https://mybusiness.googleapis.com/v4"  # reviews have no v1 replacement yet
PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1"

# Cloud Scheduler calls /sync/daily and /backfill with this shared token.
SYNC_TOKEN = os.environ.get("SYNC_TOKEN", "")

# Rolling reprocess window for the daily job (performance metrics can be
# revised by Google for a few days after the fact).
DAILY_REPROCESS_DAYS = int(os.environ.get("DAILY_REPROCESS_DAYS", "7"))

# Max historical window the Performance API will serve in one backfill pass.
# Google documents up to 18 months (~540 days) for daily metrics; verify the
# actual cap against a live response once API access is approved and adjust
# if Google returns a shorter range.
MAX_BACKFILL_DAYS = int(os.environ.get("MAX_BACKFILL_DAYS", "540"))

DAILY_METRICS = ["CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS"]
