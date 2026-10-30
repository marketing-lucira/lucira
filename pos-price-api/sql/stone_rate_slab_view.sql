-- Stone Rate Slab -- latest-rate-only view over the ERP stone rate master.
--
-- Source = the user's query:
--   stone_rates a LEFT JOIN ornaverse_erp_master.common_attributes b
--   ON a.item_attribute_id = b.item_attribute_id
--
-- One row per stone (item_attribute_id = group + shape + colour + quality + type)
-- per weight slab (from_weight -> to_weight). Old rates are removed:
--   * when the same stone + same weight slab has several rate entries, only the
--     NEWEST from_date is kept (ties -> highest stone_rate_id);
--   * rows with no from_date / to_date are dropped (no validity window);
--   * rows not valid today (to_date already passed, or from_date in the future)
--     are dropped BEFORE picking the newest, so an expired newer entry never
--     knocks out a rate that is still valid today.
-- It is a VIEW, so a new rate entered in the ERP appears here automatically and
-- the rate it replaces drops out -- nothing to refresh.
CREATE OR REPLACE VIEW `lucirajewelry-prod.gold_rates.stone_rate_slab` AS
WITH base AS (
  SELECT
    a.stone_rate_id, a.item_attribute_id,
    b.item_group_name, b.attribute,
    b.type_code, b.type_name, b.shape_code, b.shape_name,
    b.quality_name, b.stone_color_name,
    a.from_weight, a.to_weight, a.from_date, a.to_date,
    a.purchase_rate, a.sales_rate
  FROM `lucirajewelry-prod.Lucira_Prod.stone_rates` a
  LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.common_attributes` b
    ON a.item_attribute_id = b.item_attribute_id
  WHERE a.from_date IS NOT NULL AND a.to_date IS NOT NULL
    AND CURRENT_DATE('Asia/Kolkata') BETWEEN DATE(a.from_date) AND DATE(a.to_date)
)
SELECT * EXCEPT(rn)
FROM (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY item_attribute_id, from_weight, to_weight
      ORDER BY from_date DESC, stone_rate_id DESC
    ) AS rn
  FROM base
)
WHERE rn = 1;
