/* ─────────────────────────────────────────────────────────────────────────
   gcp-cost-config.example.js  —  deploy-time override reference (docs only)
   ─────────────────────────────────────────────────────────────────────────
   This file is documentation of the override OBJECT SHAPE. It is NOT loaded by
   the dashboard. The GitHub Actions workflow
   (.github/workflows/deploy-gcp-cost-dashboard.yml) builds this object from
   GitHub repo Variables and injects it INLINE into the published index.html —
   it replaces the "GCP_COST_CONFIG_INJECT" marker line (just before the
   dashboard's main <script>) with:

       <script>window.__GCP_COST_CONFIG__ = { ...only the set keys... };</script>

   The dashboard then merges window.__GCP_COST_CONFIG__ over its built-in
   defaults at load — so you can repoint it (e.g. at a live billing-export API)
   WITHOUT editing the 1,900-line HTML. Inline (not an external file) on purpose:
   the source file keeps working on plain file:// with no extra fetch.

   Hosting WITHOUT this CI (a plain static host, or opening locally)? You have
   two options: (a) edit the CONFIG block directly in the dashboard HTML, or
   (b) paste an inline <script> like the one above in place of the marker line.

   With this CI, set values via GitHub repo Variables instead of editing code:
     Settings → Secrets and variables → Actions → Variables
       GCP_COST_API_BASE      → API_BASE
       GCP_MONTHLY_BUDGET     → MONTHLY_BUDGET
       GCP_BILLING_CURRENCY   → BILLING_CURRENCY
       GCP_USD_FX             → USD_FX
   ───────────────────────────────────────────────────────────────────────── */
window.__GCP_COST_CONFIG__ = {
  // Live billing-export endpoint (the deployed gcp-cost-api Cloud Function/Run
  // URL). Leave unset/empty to run on the built-in sample data + manual CSV.
  API_BASE: "", // e.g. "https://asia-south1-lucira-prod.cloudfunctions.net/gcp-cost-data"

  // Total monthly budget, in your billing currency (drives budget/forecast tiles).
  MONTHLY_BUDGET: 20000,

  // The currency your GCP billing account bills in.
  BILLING_CURRENCY: "INR",

  // INR per 1 USD — used only to render the $ toggle from INR-denominated data.
  USD_FX: 83,
};
