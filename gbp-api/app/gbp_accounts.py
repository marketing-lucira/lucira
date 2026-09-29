"""Account discovery via the My Business Account Management API."""
from app import config
from app.logging_utils import request_with_retry


def list_accounts(access_token: str) -> list[dict]:
    """Return every GBP account accessible to the authorized user.

    GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    accounts, page_token = [], None
    while True:
        params = {"pageSize": 20}
        if page_token:
            params["pageToken"] = page_token
        resp = request_with_retry(
            "GET", f"{config.ACCOUNT_MGMT_BASE}/accounts",
            headers=headers, params=params,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"accounts.list failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        for acc in data.get("accounts", []):
            accounts.append({
                "account_id": acc["name"].split("/")[-1],
                "account_name": acc.get("accountName", ""),
                "account_type": acc.get("type", ""),
                "account_role": acc.get("role", ""),
            })
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return accounts
