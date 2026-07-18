import functions_framework
import requests
import psycopg2
import json
import os
from datetime import datetime


# ============================================================
# 1. ZOHO TOKEN REFRESH
# ============================================================
def get_zoho_access_token():
    """Refresh Zoho OAuth Access Token using Refresh Token"""
    url = "https://accounts.zoho.in/oauth/v2/token"
    params = {
        "refresh_token": os.environ.get("ZOHO_REFRESH_TOKEN"),
        "client_id":     os.environ.get("ZOHO_CLIENT_ID"),
        "client_secret": os.environ.get("ZOHO_CLIENT_SECRET"),
        "grant_type":    "refresh_token"
    }
    response = requests.post(url, params=params, timeout=10)
    data = response.json()

    if "access_token" not in data:
        raise Exception(f"Zoho token refresh failed: {data}")
    return data["access_token"]


# ============================================================
# 2. ZOHO COQL QUERY RUNNER
# ============================================================
def run_coql_query(access_token: str, query: str) -> dict:
    """Execute a single COQL query on Zoho CRM v8"""
    url = "https://www.zohoapis.in/crm/v8/coql"
    headers = {
        "Authorization": f"Zoho-oauthtoken {access_token}",
        "Content-Type": "application/json"
    }
    payload = {"select_query": query}
    response = requests.post(url, headers=headers, json=payload, timeout=15)
    return response.json()


# ============================================================
# 3. BUILD COQL QUERIES (2 Parameters: date & module)
# ============================================================
def build_queries(date: str, module: str) -> dict:
    """
    Build 3 COQL queries for given date and module:
      - total    : all records due on date
      - completed: records where Status = 'Completed'
      - overdue  : records where Status != 'Completed'
    """
    return {
        "total": (
            f"select Owner, COUNT(id) from {module} "
            f"where Due_Date = '{date}' "
            f"group by Owner"
        ),
        "completed": (
            f"select Owner, COUNT(id) from {module} "
            f"where (Due_Date = '{date}' and Status = 'Completed') "
            f"group by Owner"
        ),
        "overdue": (
            f"select Owner, COUNT(id) from {module} "
            f"where (Due_Date = '{date}' and Status != 'Completed') "
            f"group by Owner"
        )
    }


# ============================================================
# 4. PARSE COQL RESPONSE → {owner_name: count}
# ============================================================
def parse_response(data: dict) -> dict:
    """Extract owner → count mapping from a COQL API response"""
    result = {}
    records = data.get("data", [])
    for item in records:
        owner_field = item.get("Owner", {})
        if isinstance(owner_field, dict):
            owner_name = owner_field.get("name", "Unknown")
        else:
            owner_name = str(owner_field) if owner_field else "Unknown"
        count = item.get("COUNT(id)", 0)
        result[owner_name] = count
    return result


# ============================================================
# 5. SAVE RESULT TO CLOUD SQL (PostgreSQL)
# ============================================================
def save_to_db(json_data: dict):
    """
    Insert the result JSON into Cloud SQL table:
      zoho_task_logs(id SERIAL, json_data JSONB, created_at TIMESTAMP)
    Returns: (id, created_at)
    """
    conn = psycopg2.connect(
        host=os.environ.get("DB_HOST"),
        database=os.environ.get("DB_NAME"),
        user=os.environ.get("DB_USER"),
        password=os.environ.get("DB_PASSWORD"),
        port=int(os.environ.get("DB_PORT", 5432))
    )
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO zoho_task_logs (json_data) VALUES (%s) RETURNING id, created_at",
            (json.dumps(json_data),)
        )
        record_id, created_at = cursor.fetchone()
        conn.commit()
        cursor.close()
        return record_id, created_at
    finally:
        conn.close()


# ============================================================
# 6. MAIN CLOUD FUNCTION ENTRY POINT
# ============================================================
@functions_framework.http
def zoho_task_api(request):
    """
    HTTP Cloud Function — Zoho Task Report API

    Method : POST
    Body   : { "date": "YYYY-MM-DD", "module": "Tasks|Calls|Meetings" }

    Returns: JSON report with total, completed, overdue per owner
             + record_id and saved_at from Cloud SQL
    """

    # ------ CORS preflight ------
    cors_headers = {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json"
    }

    if request.method == "OPTIONS":
        return ("", 204, cors_headers)

    try:
        # ---- Step 1: Parse & validate request body ----
        body = request.get_json(silent=True)
        if not body:
            return (
                json.dumps({"status": "error", "message": "Request body must be JSON"}),
                400, cors_headers
            )

        date   = body.get("date")
        module = body.get("module", "Tasks")

        if not date:
            return (
                json.dumps({"status": "error", "message": "Missing required parameter: 'date'"}),
                400, cors_headers
            )

        valid_modules = ["Tasks", "Calls", "Meetings"]
        if module not in valid_modules:
            return (
                json.dumps({
                    "status": "error",
                    "message": f"Invalid module '{module}'. Must be one of: {valid_modules}"
                }),
                400, cors_headers
            )

        # ---- Step 2: Get Zoho access token ----
        access_token = get_zoho_access_token()

        # ---- Step 3: Run 3 COQL queries ----
        queries       = build_queries(date, module)
        total_map     = parse_response(run_coql_query(access_token, queries["total"]))
        completed_map = parse_response(run_coql_query(access_token, queries["completed"]))
        overdue_map   = parse_response(run_coql_query(access_token, queries["overdue"]))

        # ---- Step 4: Merge by owner ----
        all_owners = set(
            list(total_map.keys()) +
            list(completed_map.keys()) +
            list(overdue_map.keys())
        )

        report = [
            {
                "owner":     owner,
                "total":     total_map.get(owner, 0),
                "completed": completed_map.get(owner, 0),
                "overdue":   overdue_map.get(owner, 0)
            }
            for owner in sorted(all_owners)
        ]

        # ---- Step 5: Build final payload ----
        result = {
            "status": "success",
            "date":   date,
            "module": module,
            "report": report
        }

        # ---- Step 6: Save to Cloud SQL ----
        record_id, created_at = save_to_db(result)
        result["record_id"] = record_id
        result["saved_at"]  = created_at.isoformat()

        return (json.dumps(result), 200, cors_headers)

    except Exception as e:
        return (
            json.dumps({"status": "error", "message": str(e)}),
            500, cors_headers
        )
