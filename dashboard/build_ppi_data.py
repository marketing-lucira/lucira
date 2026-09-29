# Refresh the Product Pricing Intelligence dashboard's data snapshot.
#
# Usage:
#   1. Ask Claude to re-read the "Product Pricing" Google Sheet (gid=0) and update
#      AS_OF_DATE / RATE_CARD_RAW / G2D_CARD_RAW / SLAB_CARD_RAW below to match A1 and
#      the "Metal Rate" / "G2D Making Charges" / "Diamond Slab" blocks.
#      (No headless Sheets credential exists for this sheet -- see project memory
#      "Lucira Product Pricing Intelligence (DELETED)" for why. Reading it interactively
#      via Claude's connected Drive access works fine; that's the intended refresh path.)
#   2. Run:  python build_ppi_data.py
#      This re-runs the exact BigQuery query in sql/product_pricing_config.sql via the
#      `bq` CLI (needs gcloud/bq on PATH, tech@lucirajewelry.com auth), re-joins the
#      Gold Rate, and rewrites ppi_data.js in this same directory.
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_PATH = os.path.join(HERE, "sql", "product_pricing_config.sql")
OUT_JS_PATH = os.path.join(HERE, "ppi_data.js")

# Sourced directly from the "Product Pricing" Google Sheet (gid=0), read 2026-08-31.
# A1 = as-of date. Rows below are the "Metal Rate" block (columns B:E: Metal | KT | Purity% | Rate),
# transcribed verbatim -- no formula invented, no rates recalculated.
AS_OF_DATE = "31/08/2026"
RATE_CARD_RAW = [
    # (Metal column raw text, KT, Purity%, Rate)
    ("GOLD", "24K", "pure", 15782.46),
    ("GOLD", "22K", "92", 14519.86),
    ("GOLD", "18K", "76", 11994.67),
    ("GOLD", "14K", "59", 9311.65),
    ("GOLD", "9K", "40", 6312.98),
    ("SILVER", "999", "999", 265.00),
    ("SILVER", "92.5", "92.5", 245.13),
    ("PLATINUM 95.5", "PLATINUM", "95.5", 8315.12),
]

# Same sheet's "Diamond Slab" block (columns L:O: Code | Rate | Cost | Disc%), transcribed verbatim.
# Code matches the metafields' stone pricing_id (Stone 1/2/3 Pricing ID) directly -- no join key
# transformation needed here, unlike the Metal Rate block.
SLAB_CARD_RAW = [
    # (Code, Rate, Cost, Disc%)
    ("E-F", 43000, 15000, 25),
    ("CD", 50000, 20000, 25),
    ("RB", 10500, 3000, 25),
    ("SC", 50000, 20000, 25),
    ("Round", 125, 125, 0),
    ("TQ", 1800, 400, 0),
    ("Other", 1000, 400, 0),
]
SLAB_CARD = [{"code": c, "rate": r, "cost": cost, "discPct": d} for (c, r, cost, d) in SLAB_CARD_RAW]

# Same sheet's "G2D Making Charges" block (columns G:J: G2D Range | G2D Band | Making Charges | Dis%),
# transcribed verbatim. G2D Band matches the metafields' `remarks` field (e.g. "Medium") -- the actual
# data has a few spelling variants (Jewelry/Jewellery, Super/Supper Ultra High) which are normalized
# case-insensitively for matching only; the rate/charge values themselves are never touched.
G2D_CARD_RAW = [
    # (G2D Range, G2D Band, Making Charges, Dis%)
    ("0 to 0.049", "Supper Ultra Low", "3500/gm", 30),
    ("0.05 to 0.099", "Ultra Low", "3500/gm", 30),
    ("0.10 to 0.199", "Low", "3000/gm", 30),
    ("0.20 to 0.299", "Medium", "2500/gm", 50),
    ("0.30 to 0.499", "High", "2500/gm", 50),
    ("0.50 to 0.999", "Ultra High", "2500/gm", 50),
    ("1.00 and Above", "Supper Ultra High", "2500/gm", 50),
    ("Plain Gold Jewellery", "Plain Gold Jewellery", "3500/gm", 25),
]
G2D_CARD = [{"range": rg, "band": b, "makingCharges": mc, "discPct": d} for (rg, b, mc, d) in G2D_CARD_RAW]

def norm_metal(raw_metal_col):
    # The sheet's "Metal" column is a single token for GOLD/SILVER, but "PLATINUM 95.5" for
    # platinum (metal name + purity glued together). Normalize to just the metal name so it
    # joins against metafields' metal_type (gold/silver/platinum) after upper-casing.
    return raw_metal_col.split()[0].strip().upper()

RATE_CARD = [
    {"metal": norm_metal(m), "kt": kt.strip().upper(), "purityPct": p, "rate": r}
    for (m, kt, p, r) in RATE_CARD_RAW
]

def gold_rate_for(metal_type, purity):
    metal = (metal_type or "").strip().upper()
    purity_key = (purity or "").strip().upper()
    rows_for_metal = [r for r in RATE_CARD if r["metal"] == metal]
    if not rows_for_metal:
        return None, "no_rate_row_for_metal"
    if purity_key:
        for r in rows_for_metal:
            if r["kt"] == purity_key:
                return r["rate"], None
        # purity given but didn't match any KT for this metal
        if len(rows_for_metal) == 1:
            return rows_for_metal[0]["rate"], None
        return None, "purity_not_matched"
    # purity blank in product data
    if len(rows_for_metal) == 1:
        return rows_for_metal[0]["rate"], None  # unambiguous (covers Platinum)
    return rows_for_metal[0]["rate"], "purity_missing_defaulted"  # ambiguous (covers Silver), flagged

def s(v):
    return v if v not in (None, "") else None

def f(v):
    if v in (None, ""):
        return None
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None

def i(v):
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None

class Dict_:
    def __init__(self):
        self.values = []
        self.index = {}
    def get(self, v):
        if v is None:
            return None
        if v not in self.index:
            self.index[v] = len(self.values)
            self.values.append(v)
        return self.index[v]

def fetch_raw():
    with open(SQL_PATH, "r", encoding="utf-8") as fh:
        sql = fh.read()
    bq_exe = "bq.cmd" if os.name == "nt" else "bq"
    proc = subprocess.run(
        [bq_exe, "query", "--use_legacy_sql=false", "--format=json", "--max_rows=200000",
         "--project_id=lucirajewelry-prod"],
        input=sql, capture_output=True, text=True, shell=(os.name == "nt")
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        sys.exit(1)
    return json.loads(proc.stdout)

def main():
    raw = fetch_raw()

    d_metal = Dict_(); d_purity = Dict_(); d_remarks = Dict_()
    d_stone_type = Dict_(); d_stone_pid = Dict_()

    rows = []
    flag_counts = {}
    metal_purity_counts = {}

    for r in raw:
        metal_type = s(r.get("metal_type"))
        purity = s(r.get("purity"))
        rate, flag = gold_rate_for(metal_type, purity)
        if flag:
            flag_counts[flag] = flag_counts.get(flag, 0) + 1
        key = (metal_type or "?", purity or "")
        metal_purity_counts[key] = metal_purity_counts.get(key, 0) + 1

        rows.append([
            r.get("item_code"),
            d_metal.get(metal_type),
            d_purity.get(purity),
            f(r.get("metal_weight")),
            rate,
            f(r.get("making_charges")),
            d_remarks.get(s(r.get("remarks"))),
            d_stone_type.get(s(r.get("stone_1_type"))), d_stone_pid.get(s(r.get("stone_1_pricing_id"))),
            i(r.get("stone_1_quantity")), f(r.get("stone_1_weight")),
            d_stone_type.get(s(r.get("stone_2_type"))), d_stone_pid.get(s(r.get("stone_2_pricing_id"))),
            i(r.get("stone_2_quantity")), f(r.get("stone_2_weight")),
            d_stone_type.get(s(r.get("stone_3_type"))), d_stone_pid.get(s(r.get("stone_3_pricing_id"))),
            i(r.get("stone_3_quantity")), f(r.get("stone_3_weight")),
            f(r.get("making_charges_discount")),
            f(r.get("diamond_discount")),
            1 if flag else 0,
        ])

    out = {
        "asOfDate": AS_OF_DATE,
        "rateCard": RATE_CARD,
        "slabCard": SLAB_CARD,
        "g2dCard": G2D_CARD,
        "dict": {
            "metal_type": d_metal.values,
            "purity": d_purity.values,
            "remarks": d_remarks.values,
            "stone_type": d_stone_type.values,
            "stone_pricing_id": d_stone_pid.values,
        },
        "columns": [
            "item_code", "metal_type_i", "purity_i", "metal_weight", "gold_rate", "making_charges", "remarks_i",
            "stone_1_type_i", "stone_1_pricing_id_i", "stone_1_quantity", "stone_1_weight",
            "stone_2_type_i", "stone_2_pricing_id_i", "stone_2_quantity", "stone_2_weight",
            "stone_3_type_i", "stone_3_pricing_id_i", "stone_3_quantity", "stone_3_weight",
            "making_charges_discount", "diamond_discount", "rate_flagged"
        ],
        "rowCount": len(rows),
        "rows": rows,
    }

    compact = json.dumps(out, separators=(",", ":"), ensure_ascii=False)

    with open(OUT_JS_PATH, "w", encoding="utf-8") as fh:
        fh.write("window.PPI_DATA=")
        fh.write(compact)
        fh.write(";")

    print("rows:", len(rows))
    print("flag_counts:", flag_counts)
    print("metal/purity distribution:", metal_purity_counts)
    print("ppi_data.js bytes:", os.path.getsize(OUT_JS_PATH))

if __name__ == "__main__":
    main()
