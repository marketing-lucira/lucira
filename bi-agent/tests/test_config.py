from bi_agent.config import load_metrics, load_rules, load_sources, settings


def test_metrics_load():
    metrics = load_metrics()
    keys = {m.key for m in metrics}
    # the brief's KPI list must all be present
    for required in ["revenue", "orders", "aov", "conversion", "store_target_attainment",
                     "return_rate", "deals", "calls", "marketing_roi", "inventory_health",
                     "pending_mto", "dispatch", "new_customers", "repeat_customers"]:
        assert required in keys, f"missing KPI {required}"


def test_rules_load():
    rules = load_rules()
    ids = {r["id"] for r in rules}
    assert "deal_no_call_30m" in ids
    assert "store_target_below_70" in ids
    assert "revenue_drop_15" in ids
    for r in rules:  # every rule must name a known evaluator
        assert "evaluator" in r and "severity" in r


def test_sources_map_to_reporting_tables():
    src = load_sources()
    assert src["sales"]["table"].endswith("sales_reporting")
    # the agent must only read reporting/summary tables, never raw
    assert "sales_dashboard" in src["sales"]["table"]


def test_settings_load():
    s = settings()
    assert s.project == "lucirajewelry-prod"
    assert s.timezone == "Asia/Kolkata"
