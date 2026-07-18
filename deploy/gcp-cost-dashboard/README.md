# GCP Cost Dashboard — GitHub + CI/CD Deployment

Auto-deploys the **GCP Cost Command Center** ([`dashboard/gcp-cost-dashboard.html`](../../dashboard/gcp-cost-dashboard.html))
to **GitHub Pages** on every push, via GitHub Actions. This document is the
setup + operations guide.

---

## TL;DR

- **Hosting:** GitHub Pages (free, static). URL will be `https://marketing-lucira.github.io/lucira/gcp-cost/`
  (a repo can host only one Pages site, so both Lucira dashboards share it under
  subpaths — the GA4 dashboard is at `/ga4/`, and `/` is a hub linking to both).
- **Deploy trigger:** every push to `main` that touches a dashboard → the unified workflow
  [`.github/workflows/deploy-dashboards.yml`](../../.github/workflows/deploy-dashboards.yml)
  rebuilds and redeploys both. No manual step.
- **What gets published:** *only* the two dashboard files (under `/gcp-cost/` and
  `/ga4/`) + the hub, with each dashboard's config injected inline at deploy time.
  **Nothing else in this monorepo is exposed.**
- **Data:** see [Data path reality](#data-path-reality) — the honest version.

---

## ⚠️ Read this before making the repo / Pages public

This repository (`marketing-lucira/lucira`) is a **monorepo** containing several
projects, and at least one file — `zoho-task-function/main.py` — has a **Zoho
client secret + refresh token hardcoded**. There is also a ~5 MB CRM `data.js`.

- The Pages workflow is deliberately scoped to publish **only**
  `dashboard/gcp-cost-dashboard.html`. GitHub Pages will **not** serve the repo
  root, so the dashboard being live does not expose those files *through Pages*.
- **But** if the repository itself is public, anyone can read every file in it,
  including that hardcoded secret. **Before making this repo public:** rotate the
  Zoho credentials and move them to environment variables/Secret Manager, or keep
  the repo private (GitHub Pages can still publish from a private repo on paid
  plans; on Free, publishing Pages makes the *site* public but you can keep the
  repo private only on Pro/Team/Enterprise).

Recommended: keep the repo **private**, publish Pages from it, and rotate the
Zoho secret regardless.

---

## One-time setup

1. **Enable Pages via Actions.** GitHub → repo **Settings → Pages** →
   *Build and deployment* → **Source: GitHub Actions**.

2. **(Optional) Set deploy-time config** so you don't have to edit the HTML.
   GitHub → **Settings → Secrets and variables → Actions → Variables** tab →
   **New repository variable**:

   | Variable | Purpose | Example |
   |---|---|---|
   | `GCP_COST_API_BASE` | Live billing-export API URL (see below). Empty = sample/CSV mode. | `https://asia-south1-lucira-prod.cloudfunctions.net/gcp-cost-data` |
   | `GCP_MONTHLY_BUDGET` | Monthly budget in billing currency | `20000` |
   | `GCP_BILLING_CURRENCY` | Billing currency | `INR` |
   | `GCP_USD_FX` | INR per 1 USD (for the $ toggle) | `83` |

   Unset variables simply leave the in-file defaults untouched. **Do not put the
   API URL in a Secret** — it's not sensitive and Secrets aren't readable by the
   build step the way Variables are. (There are no actual secrets in this deploy.)

3. **Push.** Any change to the dashboard triggers a deploy. Or run it on demand:
   **Actions → Deploy GCP Cost Dashboard to Pages → Run workflow**.

After the first successful run, the site URL appears in the workflow's
`deploy` job summary and under **Settings → Pages**.

---

## How the pipeline works

```
push to main (dashboard changed)
        │
        ▼
GitHub Actions: deploy-dashboards.yml
        │  build job:
        │   • copy dashboard/gcp-cost-dashboard.html → _site/index.html,
        │     replacing the GCP_COST_CONFIG_INJECT marker line with an inline
        │     <script> that sets window.__GCP_COST_CONFIG__ from repo Variables
        │   • add .nojekyll, upload _site as the Pages artifact
        ▼
        │  deploy job:
        │   • actions/deploy-pages → GitHub Pages
        ▼
https://marketing-lucira.github.io/lucira/gcp-cost/   (always the latest committed dashboard)
```

The dashboard is a single self-contained file (no CDN, no build step, hand-rolled
SVG charts), so "build" is just assembly. The page carries a marker line —
`<!-- GCP_COST_CONFIG_INJECT … -->` — right before its main `<script>`. CI
replaces that marker with an **inline** `<script>window.__GCP_COST_CONFIG__ = {…}</script>`,
which the dashboard merges over its defaults at load. That's how CI-set Variables
reach the page without editing the HTML. The injection is inline (not an external
file) on purpose: it leaves the source file working on plain `file://` with no
extra fetch. If no Variables are set, the marker collapses to an empty line and
the built-in defaults apply. See
[`gcp-cost-config.example.js`](gcp-cost-config.example.js) for the object shape.

---

## Data path reality

The spec asks for *"always live from BigQuery, auto-refreshing."* Here's the
truthful state of that on this account:

| Path | Status | Notes |
|---|---|---|
| **Built-in sample** | ✅ works now | Deterministic seeded dataset scaled to Lucira's real service mix. What you see on first load with no config. |
| **Manual CSV import** | ✅ works now | Header button **"⤒ Load billing CSV"** parses a GCP Billing *Download CSV* (Reports cost-breakdown or the detailed Cost table). This is the **real-data path available under view-only Billing access.** |
| **Live BigQuery API** | ⛔ blocked today | Requires (a) Billing **export to BigQuery** enabled, (b) rights to query it, and (c) rights to deploy the backend. This account is currently **view-only** — none of those are available, so live auto-refresh cannot run under these credentials. |

**"Every time the URL opens it loads the latest data"** is achievable in two
forms:

- **Now:** the URL always serves the *latest committed dashboard*. Data freshness
  is whatever CSV you last loaded in-session (CSV load persists across the page's
  own Refresh).
- **When you get BigQuery access:** deploy the backend in
  [`gcp-cost-api/`](../../gcp-cost-api/) (Cloud Function `gcp_cost_data` over the
  billing-export table), set the `GCP_COST_API_BASE` Variable to its URL, and
  push. The static Pages page will then `fetch()` live billing data on load and
  auto-refresh every 30 min — no dashboard code change needed. CORS: the backend
  must return `Access-Control-Allow-Origin` for the Pages origin.

So the CI/CD here is real and complete; the only piece gated on IAM is the live
backend, and it's a drop-in the day access lands.

---

## Going live later (checklist for when access is granted)

1. Enable **Cloud Billing export → BigQuery** (detailed usage cost). *Does not
   backfill — enable ASAP.*
2. Deploy `gcp-cost-api/` (see its own `README.md`), setting `BILLING_EXPORT_TABLE`.
   Ensure the function allows CORS from `https://marketing-lucira.github.io`.
3. Set repo Variable `GCP_COST_API_BASE` to the function URL.
4. Push (or re-run the workflow). Done — the dashboard flips to **Live** mode.

---

## Troubleshooting

- **Workflow didn't run on push** — you changed a file outside the `paths` filter.
  Trigger it manually via **Actions → Run workflow**, or edit the dashboard.
- **404 at the Pages URL** — Pages source isn't set to *GitHub Actions*
  (step 1), or the first deploy hasn't finished.
- **Dashboard shows sample data despite setting `GCP_COST_API_BASE`** — the
  backend isn't reachable/CORS-blocked; the dashboard falls back to sample. Check
  the browser console and the function logs.
- **Config not applied** — confirm the Variable name matches the table above and
  that the run happened *after* you set it (Variables are read at build time).
