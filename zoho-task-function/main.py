import json
import uuid
import requests
import functions_framework
from datetime import date, datetime, timezone
from google.cloud import bigquery


# ─────────────────────────────────────────
#  CONFIG — Update these values
# ─────────────────────────────────────────
PROJECT_ID      = "lucirajewelry-prod"
DATASET_ID      = "zoho_crm"
TABLE_ID        = "zoho_tasks"

ZOHO_COQL_URL   = "https://www.zohoapis.in/crm/v8/coql"
ZOHO_TOKEN_URL  = "https://accounts.zoho.in/oauth/v2/token"

# Zoho OAuth credentials
CLIENT_ID       = "1000.QT3RG6U94NISXB4OYNF126BLYJVPSZ"
CLIENT_SECRET   = "99891e3171a8d96fd89f5836ab51f6fca85ef462b3"
REFRESH_TOKEN   = "1000.eacec51969130afe0a8ad8aa813dac58.d1593b595fe6c1ac4ce713c1ab1edc13"


# ─────────────────────────────────────────
#  STEP 1: Get Fresh Access Token
# ─────────────────────────────────────────
def get_access_token() -> str:
    """Generate a fresh Zoho access token using the refresh token."""
    response = requests.post(
        ZOHO_TOKEN_URL,
        data={
            "refresh_token": REFRESH_TOKEN,
            "client_id":     CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type":    "refresh_token",
        },
        timeout=30,
    )
    response.raise_for_status()
    token_data = response.json()

    if "access_token" not in token_data:
        raise Exception(f"Failed to get access token: {token_data}")

    return token_data["access_token"]


# ─────────────────────────────────────────
#  STEP 2: Run Zoho COQL Query
# ─────────────────────────────────────────
def run_coql_query(token: str, query: str) -> list:
    """Execute a COQL query and return list of records."""
    headers = {
        "Authorization": f"Zoho-oauthtoken {token}",
        "Content-Type":  "application/json",
    }
    response = requests.post(
        ZOHO_COQL_URL,
        headers=headers,
        json={"select_query": query},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("data", [])


# ─────────────────────────────────────────
#  STEP 3: Parse Results
# ─────────────────────────────────────────
def parse_results(records: list) -> dict:
    """Convert COQL records to {owner_name: count} dict."""
    result = {}
    for record in records:
        owner = record.get("Owner", {})
        owner_name = owner.get("name", str(owner)) if isinstance(owner, dict) else str(owner)
        count = record.get("COUNT(id)", 0)
        result[owner_name] = int(count)
    return result


# ─────────────────────────────────────────
#  STEP 4: Save to BigQuery
# ─────────────────────────────────────────
def save_to_bigquery(query_date: str, summary: list):
    """Insert the summary data into BigQuery zoho_tasks table."""
    client = bigquery.Client(project=PROJECT_ID)
    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{TABLE_ID}"

    row = {
        "id":   str(uuid.uuid4()),           # Unique ID
        "data": json.dumps(summary),          # Full summary as JSON string
        "date": datetime.now(timezone.utc).isoformat(),  # Current timestamp
    }

    errors = client.insert_rows_json(table_ref, [row])

    if errors:
        raise Exception(f"BigQuery insert errors: {errors}")

    print(f"✅ Saved to BigQuery: {table_ref} | date={query_date} | rows={len(summary)}")


# ─────────────────────────────────────────
#  CLOUD FUNCTION ENTRY POINT
# ─────────────────────────────────────────
@functions_framework.http
def zoho_task(request):
    """
    HTTP Cloud Function: Zoho-task
    - Fetches task data from Zoho CRM (total, completed, overdue)
    - Saves results to BigQuery
    - Returns JSON summary

    Query Param:
        date (str): YYYY-MM-DD — defaults to today
    """
    # CORS headers
    headers = {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type":                 "application/json",
    }

    if request.method == "OPTIONS":
        return ("", 204, headers)

    # ── Get date param ──
    query_date = request.args.get("date")
    if not query_date and request.is_json:
        query_date = (request.get_json() or {}).get("date")
    if not query_date:
        query_date = str(date.today())

    # Validate date format
    try:
        date.fromisoformat(query_date)
    except ValueError:
        return (
            json.dumps({"error": f"Invalid date: '{query_date}'. Use YYYY-MM-DD."}),
            400,
            headers,
        )

    # ── Step 1: Get Zoho Access Token ──
    try:
        token = get_access_token()
        print(f"✅ Access token refreshed successfully")
    except Exception as e:
        return (json.dumps({"error": f"Token error: {str(e)}"}), 500, headers)

    # ── Step 2: Run 3 COQL Queries ──
    try:
        total_records     = run_coql_query(token,
            f"select Owner, COUNT(id) from Tasks where Due_Date = '{query_date}' group by Owner")

        completed_records = run_coql_query(token,
            f"select Owner, COUNT(id) from Tasks where (Due_Date = '{query_date}' and Status = 'Completed') group by Owner")

        overdue_records   = run_coql_query(token,
            f"select Owner, COUNT(id) from Tasks where (Due_Date = '{query_date}' and Status != 'Completed') group by Owner")

    except Exception as e:
        return (json.dumps({"error": f"Zoho API error: {str(e)}"}), 502, headers)

    # ── Step 3: Parse & Merge ──
    total_data     = parse_results(total_records)
    completed_data = parse_results(completed_records)
    overdue_data   = parse_results(overdue_records)

    all_owners = set(total_data) | set(completed_data) | set(overdue_data)
    summary = []
    for owner in sorted(all_owners):
        total     = total_data.get(owner, 0)
        completed = completed_data.get(owner, 0)
        overdue   = overdue_data.get(owner, 0)
        summary.append({
            "owner":           owner,
            "total_tasks":     total,
            "completed":       completed,
            "overdue":         overdue,
            "completion_rate": f"{(completed / total * 100):.1f}%" if total > 0 else "0.0%",
        })

    # ── Step 4: Save to BigQuery ──
    try:
        save_to_bigquery(query_date, summary)
    except Exception as e:
        return (json.dumps({"error": f"BigQuery error: {str(e)}"}), 500, headers)

    # ── Return Response ──
    response_body = {
        "status":       "success",
        "date":         query_date,
        "total_owners": len(summary),
        "summary":      summary,
    }
    return (json.dumps(response_body, indent=2), 200, headers)
