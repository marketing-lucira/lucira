---
name: pp-dashboard
description: >-
  Runbook for changing the Lucira Product Pricing (PP) dashboard — pos-price-api (Cloud Function) and the
  pp-dashboard-web page: slabs, G2D making, gold rate, Variant / Product Default / Shopify / Inventory / Margin tabs,
  MTO Daily Margin, editor access. Use it whenever the user asks to change, fix, test or deploy anything on
  pp-dashboard-web or pos-price-api.
---

# Changing the PP dashboard

Read `pos-price-api/AGENTS.md` first — it has the rules and how the price is built.

## Prerequisites (one time per machine)

- `gcloud` signed in with an account that can deploy in `lucirajewelry-prod` (Cloud Functions + Cloud Run + Cloud
  Scheduler + BigQuery), e.g. `gcloud auth login` then `gcloud config set project lucirajewelry-prod`.
- `gcloud auth application-default login` so local Python can query BigQuery.
- Python 3.12+ with `pip install -r pos-price-api/requirements.txt`, and Node (for `node --check`).
- Git access to `marketing-lucira/lucira`; work on a branch, never directly on `main`.

## 1. Make the change

- API / pricing logic: `pos-price-api/main.py`.
- Page: `dashboard/ppi.js` and `dashboard/product-pricing-intelligence.html` (NOT the copies in `pp-dashboard-web/static/`).
- New write endpoint → add it to `EDIT_PATHS`; page calls it with `headers: editHeaders()` and checks `editRefused(res)`.

## 2. Check it locally

```powershell
python -c "import ast;ast.parse(open('pos-price-api/main.py',encoding='utf-8').read());print('ok')"
node --check dashboard/ppi.js
```

Run the changed function against real BigQuery before deploying, for example:

```powershell
cd pos-price-api
python -c "import main; ctx = main._calc_context(['LJ-ME0047-18YGLGD']); row, info = main._calc_on_weights('LJ-ME0047-18YGLGD', ctx); print(row['final_after_gst_overall'], row['total_cp_cost'], row['net_margin_pct'])"
```

Compare with the published row (`pricing_snapshots.variant_level_snapshot`) — numbers should only move where you meant
them to. A full `mto_margin_rows()` run takes 2–4 minutes.

## 3. Deploy

The script works from any folder; the path below is relative to the repo root (the folder with `.git`):

```powershell
cd (git rev-parse --show-toplevel)
powershell -ExecutionPolicy Bypass -File .agents/skills/pp-dashboard/scripts/deploy.ps1           # API + page
powershell -ExecutionPolicy Bypass -File .agents/skills/pp-dashboard/scripts/deploy.ps1 -Refresh  # + rebuild prices
```

`-Api` or `-Page` deploys only that part. `-SetEditorPasswords` asks for each editor's dashboard password (hidden
typing) and saves them on the API — needed once, and again whenever a password changes. Use `-Refresh` whenever prices or MTO costs change (about 10 minutes; logs
only appear when it finishes). The script copies the page files into `pp-dashboard-web/static/` itself.

## 4. Verify live

```powershell
$api = "https://pos-price-api-3mvv5mdr2q-el.a.run.app"
curl.exe -s "$api/snapshot-status"      # latest refresh SUCCESS + time
curl.exe -s "$api/editor-check"         # editors list
curl.exe -s "$api/health-check"         # every Daily Check row should be ok
```

Then open `https://pp-dashboard-web-385594025448.asia-south1.run.app` (Basic Auth), hard-reload, and check the tab you
changed. Edits need **Editor login** (top right) with an editor email + password.

## 5. Save it

Commit only the files you changed (the repo has many unrelated local files) and push your branch.
