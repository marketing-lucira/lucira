# ga4-api — GA4 → Analytics Command Center data pump

An HTTP Cloud Function that reads a **GA4 property via the Google Analytics Data
API v1** and returns compact, pre-shaped analytics metrics as JSON for the
**GA4 Analytics Command Center** dashboard,
[`dashboard/ga4-dashboard.html`](../dashboard/ga4-dashboard.html).

Same thin-data-pump philosophy as [`gcp-cost-api`](../gcp-cost-api) and
[`zoho-crm-api`](../zoho-crm-api): the function only runs a handful of GA4
reports and returns named arrays — the dashboard does all charting client-side.
Until you set the URL, the dashboard renders a **deterministic seeded sample**
so the whole experience is visible; wire the URL and it goes live.

---

## What it returns

`GET https://…/ga4-data?from=2026-05-31&to=2026-07-16`

Each dimension breakdown carries the **same metric bundle** so every tab/table
in the dashboard can render from it:
`{ name, users, newUsers, sessions, engagedSessions, engagementRate, views,
   eventCount, keyEvents, purchases, items, revenue }`.

```jsonc
{
  "generated_at": "2026-07-16T…Z",
  "property": "properties/345678901",
  "currency": "INR",
  "window":  { "from": "2026-05-31", "to": "2026-07-16" },
  "metrics": { "keyEvent": "keyEvents", "revenue": "totalRevenue" },

  "totals": { "sessions": …, "users": …, "newUsers": …, "activeUsers": …,
              "pageViews": …, "engagedSessions": …, "eventCount": …, "keyEvents": …,
              "revenue": …, "engagementRate": …, "avgSessionDur": …, "avgEngTime": …,
              "purchases": …, "itemsPurchased": …, "addToCarts": …, "checkouts": … },

  "daily": [ { "date": "2026-05-31", "sessions": …, "users": …, "newUsers": …,
               "activeUsers": …, "pageViews": …, "engagedSessions": …, "eventCount": …,
               "purchases": …, "keyEvents": …, "revenue": … }, … ],

  // dimension breakdowns — all share the metric bundle above:
  "channels":      [ … ],   "sourceMedium":  [ … ],   "sources":     [ … ],
  "mediums":       [ … ],   "campaigns":     [ … ],   "landingPages":[ … ],
  "devices":       [ … ],   "browsers":      [ … ],   "operatingSystems": [ … ],
  "screenResolutions": [ … ], "platforms":   [ … ],   "countries":   [ … ],
  "regions":       [ … ],   "cities":        [ … ],   "languages":   [ … ],
  "hostnames":     [ … ],   "newReturning":  [ … ],   "contentGroups": [ … ],

  "pages":   [ { "path": "/", "title": "Home", "views": …, "users": … }, … ],
  "events":  [ { "name": "purchase", "count": …, "users": … }, … ],
  "funnel":  [ { "name": "view_item", "count": … }, … ],   // standard purchase path
  "items":   [ { "name": …, "category": …, "brand": …, "items": …, "revenue": …,
                 "views": …, "addToCart": … }, … ],
  "warnings": []
}
```

Metrics/dimensions that a given property doesn't expose are **probed and
dropped** automatically (older properties, no-ecommerce properties) — the field
is omitted or zero and noted in `warnings`, never a hard failure.

Query params: `?from=YYYY-MM-DD&to=YYYY-MM-DD` (the dashboard passes the global
date filter here), or `?days=90` (trailing window), plus `?debug=1`.

> **Live-data fidelity note.** GA4's Data API returns *aggregated* reports, not
> joined session rows. The dashboard therefore reconstructs a session fact table
> whose marginal distributions match each breakdown: **totals, daily trends and
> every single-dimension chart/table are exact**, while multi-dimension
> cross-filters are modelled. For fully-joined live analytics (true cohorts,
> item-level funnels, arbitrary cross-filters), enable the **GA4 → BigQuery
> export** and point a BigQuery-backed variant of this function at it.

---

## One-time setup (do this in your Google account)

Connecting GA4 needs three things — code alone can't do them, they require your
GA4 property and GCP project:

1. **Find your GA4 property id.** GA4 → **Admin** → *Property Settings* →
   **PROPERTY ID** (a number like `345678901`). ⚠️ Not the `G-XXXXXXX`
   measurement id.

2. **Enable the Data API.** In the GCP project you'll deploy into:
   ```bash
   gcloud services enable analyticsdata.googleapis.com
   ```

3. **Grant the runtime service account read access to the property.** Gen2
   Cloud Functions run as a service account (by default
   `PROJECT_NUMBER-compute@developer.gserviceaccount.com`, or pass your own with
   `--service-account`). Copy that email, then in **GA4 → Admin → Property
   Access Management → +**, add it with role **Viewer**.

---

## Deploy

```bash
cd ga4-api
gcloud functions deploy ga4-data \
    --gen2 --runtime=python312 --region=asia-south1 \
    --source=. --entry-point=ga4_data --trigger-http --allow-unauthenticated \
    --set-env-vars 'GA4_PROPERTY_ID=345678901,GA4_CURRENCY=INR,WINDOW_DAYS=90'
```

Copy the printed **function URL** and paste it into `CONFIG.API_BASE` near the top
of the `<script>` in
[`dashboard/ga4-dashboard.html`](../dashboard/ga4-dashboard.html). The status dot
turns green (“Live · GA4 · <date>”) and the dashboard auto-refreshes every
`CONFIG.AUTO_REFRESH_MIN` minutes.

> **Security:** `--allow-unauthenticated` makes the endpoint public (read-only,
> aggregated traffic numbers). To lock it down, drop that flag and call it with
> an ID token, or put it behind IAP / API Gateway.

---

## Run locally

```bash
cd ga4-api
python -m venv .venv && . .venv/Scripts/activate   # (Windows Git Bash)
pip install -r requirements.txt
export GA4_PROPERTY_ID=345678901
gcloud auth application-default login   # so ADC can reach the Data API as you
functions-framework --target=ga4_data --debug --port=8080
# → http://localhost:8080/?days=30&debug=1
```

For local runs your *own* Google account must have Viewer on the property (same
as step 3, but with your email instead of the SA).

---

## Notes

- **`conversions` vs `keyEvents`:** GA4 renamed the conversion metric to
  `keyEvents` in 2024. The function probes both and uses whichever the property
  accepts, so it works on old and new properties. Same for revenue
  (`totalRevenue` / `purchaseRevenue`). Anything unavailable is omitted and
  listed in `warnings` rather than failing the whole response.
- **Timezone / dates:** the `date` dimension is reported in the GA4 property's
  configured timezone — align that with the CRM's `Asia/Kolkata` for
  apples-to-apples comparisons against the Deals/Calls tabs.
- **Data freshness:** GA4 standard properties finalise data with some latency;
  the most recent 1–2 days can still be `(processing)` and shift slightly.
