# Product Pricing (PP) dashboard — rules for any agent changing it

The PP dashboard is three pieces that must stay in step:

| Piece | Where | Runs as |
|---|---|---|
| API (all pricing logic) | `pos-price-api/main.py` | Cloud Function gen2 `pos-price-api`, asia-south1, entry `pos_price`, public URL `https://pos-price-api-3mvv5mdr2q-el.a.run.app` |
| Page (source of truth) | `dashboard/ppi.js`, `dashboard/product-pricing-intelligence.html` | — |
| Page host | `pp-dashboard-web/` (Flask, Basic Auth via `DASH_USER`/`DASH_PASS`) | Cloud Run `pp-dashboard-web`, `https://pp-dashboard-web-385594025448.asia-south1.run.app` |

For the full change → test → deploy runbook use the `pp-dashboard` skill
(`.agents/skills/pp-dashboard/SKILL.md`).

## Must-follow rules

- Edit the page ONLY in `dashboard/ppi.js` / `dashboard/product-pricing-intelligence.html`, then copy both into
  `pp-dashboard-web/static/` before deploying the page. `dashboard/dashboard/` is an old stale copy — never edit it.
- Deploy the API WITHOUT `--set-env-vars` (it would wipe `REFRESH_TOKEN`, `EDITOR_PASSWORDS`, …). To add or change one
  variable use `--update-env-vars NAME=value`.
- Never commit passwords or tokens. `EDITOR_PASSWORDS`, `REFRESH_TOKEN`, `DASH_PASS` live only in the services' env.
- `pos_price()` has local `import json` lines, so `json` is a local name in that function: any code added to it must
  run `import json` itself first (else `UnboundLocalError`).
- Any new endpoint that CHANGES data must be added to `EDIT_PATHS`; the page must send `editHeaders()` (X-Edit-Token)
  and call `editRefused(res)` on the response. Reads stay open.
- After changing anything that affects prices (`_build_variant_row`, `_calc_on_weights`, BOM maps, slab logic), the
  published snapshots are stale until a refresh runs:
  `gcloud scheduler jobs run pricing-snapshot-refresh --location=asia-south1` (~10 min). Also update `health_check()`
  (Daily Check tab) when a formula it re-verifies changes, or it will report false ✕.
- Windows: the BigQuery CLI is `bq.cmd` (plain `bq` fails from Python subprocess).

## How the price is built (`_build_variant_row`)

- Metal = net weight × karat rate; karat rate = 24K rate (`Pos.metal_rates`, Gold row, `sales_rate × 10` per 10 g)
  × 1.00 / 0.92 / 0.76 / 0.59 / 0.40 for 24/22/18/14/9K.
- Diamond = BOM selling price (`Pos.Product_price.Saleing_price`); Making = net weight × G2D-band making /g.
- Other BOM = selling price of every BOM line that is neither metal nor diamond (colour stone, CZ, accessories).
- Before GST = metal + diamond + making + Other BOM → +3% GST → making and diamond discounts (G2D band / Slab Excel)
  → Final After GST (rounded up).
- Total CP = (diamond CP + Other BOM CP + labour CP + metal) × 1.03. Diamond/stone CP from `Lucira_Prod.stone_rates`;
  accessories CP from `Pos.items_bom` × latest `consignment_in_items_bom` rate (per piece if uoc 3, else per gram);
  labour from `gold_rates.labour_rate_slab` (≤1.5 g → fixed ₹1,500).
- Margin 1% = (With GST SP − CP)/With GST SP; Margin 2% = (Final After GST − CP)/Final; Final Margin = (Actual SP − CP)/
  Actual SP, Actual SP = Final − free coin (₹1,600 per coin, tiers from `gold_rates.slab_excel`).

## MTO Daily Margin tab

- `mto_margin_rows()`: `ds_imputed_reporting.marketing_sale`, Fullfillment `MTO` + `Online_MTO`, `cancel_order` never
  counts. `net_sale` is GST-INCLUSIVE. CP = the calculation above on the order's own weights with the gold rate of the
  order date. Blob `pricing-snapshots/mto_margin.json.gz`, rebuilt every 30 min or with `?refresh=1`.
- Extra Discount per line: `gold_rates.mto_extra_discounts` (key document_no + item_line_no), editors only, read live
  by the page; Actual SP = net_sale − free coin − extra discount.

## Who can edit from the dashboard

`EDITOR_EMAILS` (default data@, data.cat@, tech@lucirajewelry.com) sign in with their password from
`EDITOR_PASSWORDS` (`email=password;email=password`). To add or remove an editor, change those two env vars on
`pos-price-api` with `--update-env-vars`. This only governs the dashboard UI — code changes go through git + deploy.
