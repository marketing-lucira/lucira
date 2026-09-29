"""Review count + average rating via the (still-active, v4) reviews API.

GET https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews

The ListReviewsResponse carries `averageRating` and `totalReviewCount` at
the top level (Google pre-aggregates these), so we don't need to paginate
through every individual review just to get the two numbers the main table
needs -- we only paginate fully when validating (storing individual review
rows), per the "don't assume one page has everything" requirement.
"""
from app import config
from app.logging_utils import request_with_retry, log_api_call


def get_review_summary(access_token: str, account_id: str, location_id: str) -> dict:
    """Returns {"review_count": int, "average_rating": float|None}.

    A location with 0 reviews returns totalReviewCount absent/0 and no
    averageRating -- we store 0 / NULL rather than guessing.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    resp = request_with_retry(
        "GET",
        f"{config.REVIEWS_BASE}/accounts/{account_id}/locations/{location_id}/reviews",
        headers=headers, params={"pageSize": 1},  # summary fields don't need full pagination
    )
    if resp.status_code == 404:
        return {"review_count": None, "average_rating": None, "not_found": True}
    if resp.status_code >= 400:
        raise RuntimeError(f"reviews.list failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    return {
        "review_count": data.get("totalReviewCount", 0),
        "average_rating": data.get("averageRating"),
        "not_found": False,
    }


def get_all_reviews(access_token: str, account_id: str, location_id: str) -> list[dict]:
    """Full paginated fetch of individual reviews -- used only for validation
    snapshots, not the daily reporting table.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    reviews, page_token = [], None
    while True:
        params = {"pageSize": 50}
        if page_token:
            params["pageToken"] = page_token
        resp = request_with_retry(
            "GET",
            f"{config.REVIEWS_BASE}/accounts/{account_id}/locations/{location_id}/reviews",
            headers=headers, params=params,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"reviews.list failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        reviews.extend(data.get("reviews", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return reviews


STAR_RATING_MAP = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5, "STAR_RATING_UNSPECIFIED": None}
