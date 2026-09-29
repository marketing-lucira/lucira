WITH A AS (
SELECT
*,
JSON_VALUE(value_st, '$.version') AS version,
JSON_VALUE(value_st, '$.metal_type') AS metal_type,
JSON_VALUE(value_st, '$.purity') AS purity,
SAFE_CAST(JSON_VALUE(value_st, '$.metal_weight') AS FLOAT64) AS metal_weight,
SAFE_CAST(JSON_VALUE(value_st, '$.diamond_charges') AS FLOAT64) AS diamond_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.moissanite_charges') AS FLOAT64) AS moissanite_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.stone_charges') AS FLOAT64) AS stone_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.making_charges') AS FLOAT64) AS making_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.wastage_charges') AS FLOAT64) AS wastage_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.insurance_charges') AS FLOAT64) AS insurance_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.misc_charges') AS FLOAT64) AS misc_charges,
SAFE_CAST(JSON_VALUE(value_st, '$.markup_percentage') AS FLOAT64) AS markup_percentage,
SAFE_CAST(JSON_VALUE(value_st, '$.compare_price_margin') AS FLOAT64) AS compare_price_margin,
SAFE_CAST(JSON_VALUE(value_st, '$.tax') AS FLOAT64) AS tax,
SAFE_CAST(JSON_VALUE(value_st, '$.bottom_price') AS FLOAT64) AS bottom_price,
JSON_VALUE(value_st, '$.remarks') AS remarks,

JSON_VALUE(value_st, '$.advanced_stone_config[0].stone_type') AS stone_1_type,
JSON_VALUE(value_st, '$.advanced_stone_config[0].pricing_id') AS stone_1_pricing_id,
SAFE_CAST(JSON_VALUE(value_st, '$.advanced_stone_config[0].stone_quantity') AS INT64) AS stone_1_quantity,
SAFE_CAST(JSON_VALUE(value_st, '$.advanced_stone_config[0].stone_weight') AS FLOAT64) AS stone_1_weight,

JSON_VALUE(value_st, '$.advanced_stone_config[1].stone_type') AS stone_2_type,
JSON_VALUE(value_st, '$.advanced_stone_config[1].pricing_id') AS stone_2_pricing_id,
SAFE_CAST(JSON_VALUE(value_st, '$.advanced_stone_config[1].stone_quantity') AS INT64) AS stone_2_quantity,
SAFE_CAST(JSON_VALUE(value_st, '$.advanced_stone_config[1].stone_weight') AS FLOAT64) AS stone_2_weight,

JSON_VALUE(value_st, '$.advanced_stone_config[2].stone_type') AS stone_3_type,
JSON_VALUE(value_st, '$.advanced_stone_config[2].pricing_id') AS stone_3_pricing_id,
SAFE_CAST(JSON_VALUE(value_st, '$.advanced_stone_config[2].stone_quantity') AS INT64) AS stone_3_quantity,
SAFE_CAST(JSON_VALUE(value_st, '$.advanced_stone_config[2].stone_weight') AS FLOAT64) AS stone_3_weight,

SAFE_CAST(JSON_VALUE(value_st, '$.making_charges_discount') AS FLOAT64) AS making_charges_discount,
SAFE_CAST(JSON_VALUE(value_st, '$.diamond_discount') AS FLOAT64) AS diamond_discount

FROM `lucirajewelry-prod.Lucira_Prod.Lucira_Shopify_product_variant_metafields`
WHERE key = 'variant_config'
),

Product_details AS (
SELECT
item_code,
metal_type,
a.purity,
metal_weight,
making_charges,
remarks,
stone_1_type,
stone_1_pricing_id,
stone_1_quantity,
stone_1_weight,
stone_2_type,
stone_2_pricing_id,
stone_2_quantity,
stone_2_weight,
stone_3_type,
stone_3_pricing_id,
stone_3_quantity,
stone_3_weight,
making_charges_discount,
diamond_discount,
owner_id
FROM A
LEFT JOIN `lucirajewelry-prod.ornaverse_erp_master.items` b
ON a.owner_id = b.external_variant_id
)

SELECT *
FROM Product_details
WHERE item_code IS NOT NULL
