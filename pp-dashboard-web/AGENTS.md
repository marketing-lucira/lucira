# pp-dashboard-web — host of the Product Pricing dashboard

This folder only serves the page (Flask + Basic Auth). Do not edit `static/ppi.js` or
`static/product-pricing-intelligence.html` here: edit `dashboard/ppi.js` and `dashboard/product-pricing-intelligence.html`
and copy them in (the deploy script in `.agents/skills/pp-dashboard/scripts/deploy.ps1` does it).

Rules, pricing logic and the deploy runbook: `pos-price-api/AGENTS.md` and the `pp-dashboard` skill
(`.agents/skills/pp-dashboard/SKILL.md`).

Deploy with `gcloud run deploy pp-dashboard-web --source . --region=asia-south1` and no env flags, so `DASH_USER` /
`DASH_PASS` stay as they are.
