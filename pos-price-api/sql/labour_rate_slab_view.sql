-- Labour Rate Slab -- ERP labour master, same shape as the user's query:
--   labour_rates a LEFT JOIN ornaverse_erp_master.common_attributes b
--   ON a.item_attribute_id = b.item_attribute_id
-- One row per item group + type (Rings, Pendants, ...) + weight slab.
-- purchase_rate = the labour charge. labour_rates has no from/to date, so
-- there is no older-rate cleanup to do here (checked 2026-10-01: no duplicate
-- item_attribute_id + weight slab rows).
CREATE OR REPLACE VIEW `lucirajewelry-prod.gold_rates.labour_rate_slab` AS
SELECT
  a.labour_id, a.item_attribute_id,
  b.item_group_name, b.attribute, b.type_name,
  a.from_weight, a.to_weight,
  a.purchase_rate, a.sales_rate
FROM `lucirajewelry-prod.Lucira_Prod.labour_rates` a
LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.common_attributes` b
  ON a.item_attribute_id = b.item_attribute_id;
