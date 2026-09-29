-- Raw pull of marketing_sale (2,531 rows) for the mobile-only Sale join. Joined to deals in
-- Python (build_dcm_data.py) with the "first sale on/after meeting/deal date" rule — never a
-- fabricated Deal ID join (marketing_sale has no Deal ID column).
SELECT
  Transaction_Date AS transaction_date, company_code, document_no, net_sale, party_name,
  Cus_mobile AS cus_mobile, mobile1
FROM `lucirajewelry-prod.ds_imputed_reporting.marketing_sale`
