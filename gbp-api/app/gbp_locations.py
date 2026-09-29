"""Location discovery via the My Business Business Information API, plus
mapping to Lucira's store master.

We never hardcode location IDs — they're always pulled fresh from the API.
Mapping to store_code is done by best-effort fuzzy match against
store_location_store_master (name/address/pincode), written to a mapping
table rather than assumed, per the "unsafe automatic match -> config table"
instruction.
"""
import re

from google.cloud import bigquery

from app import config
from app.logging_utils import request_with_retry

_bq = bigquery.Client(project=config.PROJECT)

READ_MASK = "name,title,storefrontAddress,phoneNumbers,websiteUri,metadata,openInfo"


def list_locations(access_token: str, account_id: str) -> list[dict]:
    """GET .../v1/accounts/{account_id}/locations, paginated."""
    headers = {"Authorization": f"Bearer {access_token}"}
    locations, page_token = [], None
    while True:
        params = {"readMask": READ_MASK, "pageSize": 100}
        if page_token:
            params["pageToken"] = page_token
        resp = request_with_retry(
            "GET",
            f"{config.BUSINESS_INFO_BASE}/accounts/{account_id}/locations",
            headers=headers, params=params,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"locations.list failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        for loc in data.get("locations", []):
            addr = loc.get("storefrontAddress", {}) or {}
            phones = (loc.get("phoneNumbers", {}) or {}).get("primaryPhone", "")
            open_info = loc.get("openInfo", {}) or {}
            locations.append({
                "location_id": loc["name"].split("/")[-1],
                "location_name": loc.get("title", ""),
                "store_address": ", ".join(addr.get("addressLines", [])),
                "city": addr.get("locality", ""),
                "state": addr.get("administrativeArea", ""),
                "country": addr.get("regionCode", ""),
                "phone": phones,
                "website": loc.get("websiteUri", ""),
                "is_active": open_info.get("status", "") == "OPEN",
            })
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return locations


def _normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def match_store_code(location: dict) -> str | None:
    """Best-effort match against store_location_store_master by pincode
    (found inside the GBP address string) then by normalized name overlap.
    Returns None (never guesses) if no confident match is found -- callers
    must write the row to the mapping table either way and leave store_code
    NULL for a human to resolve.
    """
    rows = list(_bq.query(
        f"SELECT store_code, store_name, address, pincode FROM `{config.STORE_MASTER_TABLE}`"
    ).result())

    addr_blob = f"{location.get('store_address', '')} {location.get('city', '')}"
    pincode_match = re.search(r"\b(\d{6})\b", addr_blob)
    if pincode_match:
        pincode = pincode_match.group(1)
        for r in rows:
            if r["pincode"] and r["pincode"] == pincode:
                return r["store_code"]

    loc_name_norm = _normalize(location.get("location_name", ""))
    for r in rows:
        store_name_norm = _normalize(r["store_name"])
        if store_name_norm and store_name_norm in loc_name_norm:
            return r["store_code"]

    return None


def upsert_locations(account_id: str, account_name: str, locations: list[dict]) -> int:
    if not locations:
        return 0
    rows = []
    for loc in locations:
        store_code = match_store_code(loc)
        rows.append({
            "account_id": account_id,
            "account_name": account_name,
            "location_id": loc["location_id"],
            "location_name": loc["location_name"],
            "store_name": loc["location_name"],
            "store_code": store_code,
            "store_address": loc["store_address"],
            "city": loc["city"],
            "state": loc["state"],
            "country": loc["country"],
            "phone": loc["phone"],
            "website": loc["website"],
            "is_active": loc["is_active"],
        })

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ArrayQueryParameter("rows", "RECORD", rows),
        ]
    )
    # BigQuery python client can't bind RECORD arrays as query params directly;
    # stage via a temp table + MERGE instead.
    staging_table = f"{config.PROJECT}.{config.DATASET}._stg_gbp_locations"
    _bq.load_table_from_json(
        rows, staging_table,
        job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE",
            autodetect=True,
        ),
    ).result()

    merge_sql = f"""
    MERGE `{config.LOCATIONS_TABLE}` T
    USING `{staging_table}` S
    ON T.location_id = S.location_id
    WHEN MATCHED THEN UPDATE SET
      account_id = S.account_id,
      account_name = S.account_name,
      location_name = S.location_name,
      store_name = S.store_name,
      store_code = COALESCE(S.store_code, T.store_code),
      store_address = S.store_address,
      city = S.city,
      state = S.state,
      country = S.country,
      phone = S.phone,
      website = S.website,
      is_active = S.is_active,
      last_synced_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
      account_id, account_name, location_id, location_name, store_name,
      store_code, store_address, city, state, country, phone, website,
      is_active, last_synced_at
    ) VALUES (
      S.account_id, S.account_name, S.location_id, S.location_name, S.store_name,
      S.store_code, S.store_address, S.city, S.state, S.country, S.phone, S.website,
      S.is_active, CURRENT_TIMESTAMP()
    )
    """
    _bq.query(merge_sql).result()
    return len(rows)
