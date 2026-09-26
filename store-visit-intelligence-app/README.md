# Store Visit & Sales Conversion Intelligence -- live service

Standalone Cloud Run service serving the `store-visit-sales-conversion-intelligence.html`
dashboard (built in `../dashboard/`) behind HTTP Basic Auth. Deliberately separate
from `zoho-login-dashboard` -- its own service, its own credential, not merged.

Credentials are set as Cloud Run env vars (`DASH_USER` / `DASH_PASS`), never
committed here. Ask whoever deployed it for the login, or regenerate below.

## Deploy / redeploy

```bash
gcloud run deploy store-visit-intelligence --source . \
  --project=lucirajewelry-prod --region=asia-south1 \
  --allow-unauthenticated \
  --set-env-vars DASH_USER=<username>,DASH_PASS=<password> \
  --memory=512Mi --timeout=300
```

`--allow-unauthenticated` is at the Cloud Run IAM layer only (so the URL is
reachable without a Google/gcloud identity) -- the real gate is the app-level
Basic Auth in `main.py`, same pattern as `zoho-login-dashboard`.

## Refreshing the data

The ~36MB `svci_data.js` is a static snapshot copied in at deploy time, not
fetched live. To update it:

```bash
cd ../dashboard
python build_svci_data.py            # or --source live for current Zoho CRM data
cp svci_data.js ../store-visit-intelligence-app/svci_data.js
cd ../store-visit-intelligence-app
gcloud run deploy store-visit-intelligence --source . \
  --project=lucirajewelry-prod --region=asia-south1
```
(Omit `--set-env-vars`/`--allow-unauthenticated` on redeploy -- Cloud Run keeps
prior env vars and IAM settings unless you explicitly change them.)

## Known limits

- Each redeploy re-uploads the full ~36MB build context (source-based Cloud
  Run build). Acceptable at this size/frequency; if data updates become much
  larger or more frequent, consider hosting `svci_data.js` on the existing
  public `lucira-dashboards` GCS bucket (pattern used by `walkin-source-api`)
  and having the page `fetch()` it at runtime instead.
- No auto-refresh/scheduler wired up -- this is a manual "rebuild, copy, redeploy"
  flow, matching how the dashboard's data is refreshed locally.
