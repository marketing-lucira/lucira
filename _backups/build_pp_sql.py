"""Print the Product Price SQL (params inlined) so it can be BigQuery dry-run."""
import sys, types, importlib.util, re

for name in ("functions_framework", "google", "google.cloud", "google.cloud.bigquery", "google.cloud.storage"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["functions_framework"].http = lambda f: f
bq = sys.modules["google.cloud.bigquery"]


class P:
    def __init__(self, name=None, typ=None, value=None, *a, **k):
        self.name, self.typ, self.value = name, typ, value


for attr in ("ScalarQueryParameter", "ArrayQueryParameter"):
    setattr(bq, attr, P)
for attr in ("QueryJobConfig", "Client", "SchemaField", "LoadJobConfig", "WriteDisposition", "SourceFormat", "Table"):
    setattr(bq, attr, type(attr, (), {"__init__": lambda self, *a, **k: None}))
sys.modules["google.cloud"].bigquery = bq
sys.modules["google.cloud"].storage = sys.modules["google.cloud.storage"]
sys.modules["google.cloud.storage"].Client = bq.Client

spec = importlib.util.spec_from_file_location("main", r"C:\Users\ADMIN\.antigravity-ide\pos-price-api\main.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

where_bare, params = m._search_clause("")
mc_sql, mc_p = m._making_charge_case({})
dc_sql, dc_p = m._discount_pct_case({})
dd_sql, dd_p = m._g2d_diamond_disc_case({"low": 15, "medium": 20})
sql = m._g2d_ranked_cte(where_bare, mc_sql, dc_sql, dd_sql) + "\nLIMIT 50"
for p in params + mc_p + dc_p + dd_p:
    v = p.value
    lit = "NULL" if v is None else (f"'{v}'" if isinstance(v, str) else repr(float(v)) if isinstance(v, (int, float)) else repr(v))
    sql = re.sub(rf"@{re.escape(p.name)}\b", lit, sql)
leftover = re.findall(r"@\w+", sql)
if leftover:
    sys.exit(f"unresolved params: {set(leftover)}")
open(r"C:\Users\ADMIN\.antigravity-ide\_backups\pp_sql.sql", "w", encoding="utf-8").write(sql)
print("SQL written,", len(sql), "chars")
