"""Offline check of Variant Level's new Diamond Disc% rule (no BigQuery)."""
import sys, types, importlib.util

# Stub the cloud libraries so main.py imports without network/credentials.
for name in ("functions_framework", "google", "google.cloud", "google.cloud.bigquery", "google.cloud.storage"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["functions_framework"].http = lambda f: f
bq = sys.modules["google.cloud.bigquery"]
for attr in ("ScalarQueryParameter", "ArrayQueryParameter", "QueryJobConfig", "Client", "SchemaField",
             "LoadJobConfig", "WriteDisposition", "SourceFormat", "Table"):
    setattr(bq, attr, type(attr, (), {"__init__": lambda self, *a, **k: None}))
sys.modules["google.cloud"].bigquery = bq
sys.modules["google.cloud"].storage = sys.modules["google.cloud.storage"]
sys.modules["google.cloud.storage"].Client = bq.Client

spec = importlib.util.spec_from_file_location("main", r"C:\Users\ADMIN\.antigravity-ide\pos-price-api\main.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

discounts = {"supper_ultra_low": 5, "ultra_low": 10, "low": 15, "medium": 20, "high": 25,
             "ultra_high": 30, "supper_ultra_high": 35}
cases = [
    # (item_group, diamond_type, g2d ratio, expected %)
    ("Diamond", "E-F", 0.03, 5), ("Diamond", "CD", 0.15, 15), ("Diamond", "RB", 0.25, 20),
    ("Diamond", "SC", 1.2, 35), ("Diamond", "Round", 0.15, 0), ("Diamond", "TQ", 0.15, 0),
    ("Diamond", "Other", 0.15, 0), ("Diamond", "E-F", None, 0), ("Gold", "E-F", 0.15, 0),
]
ok = True
for grp, dtype, g2d, want in cases:
    cls_map = {"X": {"item_group": grp, "any_diamond_type": dtype, "is_consignment": False,
                     "has_diamond": True, "has_gold": True, "has_gems": False}}
    items = {"X": {"g2d": g2d, "net_weight": 2.0, "making_charge_per_g": 3000, "discount_pct": 20}}
    row = m._build_variant_row("X", cls_map, items, {}, {"X": {"metal_amount": 10000, "diamond_amount": 20000}},
                               discounts, {}, {"for_all": 0}, {}, {})
    got = row["diamond_disc_pct"]
    exp_amt = round(20000 * want / 100, 2)
    good = got == want and row["diamond_discount_amount"] == exp_amt
    ok &= good
    print(f"{'OK ' if good else 'BAD'} {grp:7} {dtype:5} g2d={g2d!s:5} -> {got}% (amount {row['diamond_discount_amount']})")
print("ALL PASSED" if ok else "FAILURES")
