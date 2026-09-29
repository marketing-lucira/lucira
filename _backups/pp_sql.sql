
        WITH g2d_dedup AS (
          SELECT item_code, diamond_weight, net_weight AS g2d_net_weight,
                 ROW_NUMBER() OVER (
                   PARTITION BY item_code ORDER BY COALESCE(modified_date, creation_date) DESC
                 ) AS rn
          FROM `lucirajewelry-prod.ds_imputed_reporting.items`
        ),
        
        stone_rate_rows AS (
          SELECT
            LOWER(TRIM(b.item_group_name)) AS ig,
            LOWER(TRIM(b.shape_name)) AS sh,
            LOWER(TRIM(b.quality_name)) AS ql,
            LOWER(TRIM(b.stone_color_name)) AS sc,
            a.from_weight, a.to_weight, a.purchase_rate
          FROM `lucirajewelry-prod.Lucira_Prod.stone_rates` a
          LEFT JOIN `lucirajewelry-prod.ornaverse_erp_administration.common_attributes` b ON a.item_attribute_id = b.item_attribute_id
          WHERE CURRENT_DATE('Asia/Kolkata') BETWEEN DATE(a.from_date) AND DATE(a.to_date)
        )
    ,
        joined AS (
          SELECT p.`item_code`, p.`item_name`, p.`weight`, p.`pieces`, p.`net_weight`, p.`purity`, p.`pure_weight`, p.`bom_rate`, p.`bom_base_amount`, p.`center_stone`, p.`item_group_name`, p.`base_item`, p.`type_code`, p.`metal_name`, p.`karat_code`, p.`metal_color_code`, p.`collection_name`, p.`super_type_name`, p.`shape_name`, p.`stone_size_id`, p.`stone_size_name`, p.`quality_name`, p.`stone_color_name`, p.`type_name`, p.`metal_amount`, p.`sp_ct`, p.`Diamond_type`, p.`Saleing_price`, ROW_NUMBER() OVER () AS _prowid,
            CASE WHEN p.item_group_name = 'Diamond' AND p.pieces IS NOT NULL AND p.pieces > 0
                 THEN p.net_weight / p.pieces END AS carat_weight,
            CASE WHEN g.diamond_weight IS NOT NULL AND g.diamond_weight > 0
                      AND g.g2d_net_weight IS NOT NULL AND g.g2d_net_weight > 0
                 THEN ROUND(g.diamond_weight / g.g2d_net_weight, 4) END AS raw_g2d_ratio
          FROM `lucirajewelry-prod.Pos.Product_price` AS p
          LEFT JOIN g2d_dedup g ON g.item_code = p.item_code AND g.rn = 1
        ),
        priced AS (
          SELECT j.*, sr.purchase_rate,
            ROW_NUMBER() OVER (
              PARTITION BY j._prowid
              ORDER BY (sr.to_weight - sr.from_weight) ASC
            ) AS _rate_rn
          FROM joined j
          LEFT JOIN stone_rate_rows sr
            ON sr.ig = LOWER(TRIM(j.item_group_name)) AND sr.sh = LOWER(TRIM(j.shape_name))
           AND sr.ql = LOWER(TRIM(j.quality_name)) AND sr.sc = LOWER(TRIM(j.stone_color_name))
           AND j.carat_weight IS NOT NULL
           AND j.carat_weight >= sr.from_weight AND j.carat_weight <= sr.to_weight
        ),
        priced_final AS (
          SELECT * EXCEPT(_rate_rn) FROM priced WHERE _rate_rn = 1
        ),
        ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY item_name
              ORDER BY CASE WHEN raw_g2d_ratio IS NOT NULL THEN 0 ELSE 1 END, item_code
            ) AS variant_rank
          FROM priced_final
        ),
        with_g2d AS (
          SELECT `item_code`, `item_name`, `weight`, `pieces`, `net_weight`, `purity`, `pure_weight`, `bom_rate`, `bom_base_amount`, `center_stone`, `item_group_name`, `base_item`, `type_code`, `metal_name`, `karat_code`, `metal_color_code`, `collection_name`, `super_type_name`, `shape_name`, `stone_size_id`, `stone_size_name`, `quality_name`, `stone_color_name`, `type_name`, `metal_amount`, `sp_ct`, `Diamond_type`, `Saleing_price`, carat_weight, purchase_rate,
            CASE WHEN carat_weight IS NOT NULL AND purchase_rate IS NOT NULL
                 THEN carat_weight * purchase_rate END AS purchase_amount,
            CASE WHEN carat_weight IS NOT NULL AND purchase_rate IS NOT NULL AND pieces IS NOT NULL
                 THEN carat_weight * purchase_rate * pieces END AS diamond_cp,
            CASE
              WHEN IFNULL(item_group_name, '') != 'Diamond' THEN 0
              WHEN raw_g2d_ratio IS NOT NULL AND variant_rank = 1 THEN raw_g2d_ratio
              ELSE NULL
            END AS g2d_ratio,
            raw_g2d_ratio
          FROM ranked
        )
        SELECT * EXCEPT(raw_g2d_ratio),
          
        CASE
          WHEN REGEXP_CONTAINS(item_code, r'PG-[0-9.]+$') THEN 3500.0
          WHEN g2d_ratio IS NULL OR g2d_ratio <= 0 THEN NULL
          WHEN g2d_ratio <= 0.049 THEN 3500.0
          WHEN g2d_ratio <= 0.099 THEN 3500.0
          WHEN g2d_ratio <= 0.199 THEN 3000.0
          WHEN g2d_ratio <= 0.299 THEN 2500.0
          WHEN g2d_ratio <= 0.499 THEN 2500.0
          WHEN g2d_ratio <= 0.999 THEN 2500.0
          ELSE 2500.0
        END AS making_charge_per_g
    ,
          
        CASE item_group_name
          WHEN 'Gold' THEN 0.0
          WHEN 'Diamond' THEN 0.0
          ELSE 0.0
        END AS discount_pct
    ,
          
        CASE
          WHEN Diamond_type IS NULL OR TRIM(Diamond_type) = '' THEN NULL
          WHEN Diamond_type NOT IN ('CD', 'E-F', 'RB', 'SC') THEN 0
          WHEN raw_g2d_ratio IS NULL THEN 0
          WHEN raw_g2d_ratio <= 0.049 THEN 0.0
WHEN raw_g2d_ratio <= 0.099 THEN 0.0
WHEN raw_g2d_ratio <= 0.199 THEN 15.0
WHEN raw_g2d_ratio <= 0.299 THEN 20.0
WHEN raw_g2d_ratio <= 0.499 THEN 0.0
WHEN raw_g2d_ratio <= 0.999 THEN 0.0
          ELSE 0.0
        END AS diamond_disc_pct
    
        FROM with_g2d
        WHERE TRUE
    
LIMIT 50