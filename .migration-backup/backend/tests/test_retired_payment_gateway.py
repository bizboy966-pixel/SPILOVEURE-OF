"""Ensure a removed gateway cannot be restored by old configuration."""
import asyncio
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest
from mongomock_motor import AsyncMongoMockClient

from payment_providers import _PROVIDER_CATALOG
from payment_router import _provider_ready, pick_provider
from retired_payment_gateway import RETIRED_IDS, retire_gateway_configuration


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def db():
    return AsyncMongoMockClient().retirement_test


def test_configuration_cleanup_is_idempotent_and_preserves_financial_records(db):
    config = {
        "active": "soleas", "soleas_enabled": True,
        "soleaspay_public_key": "dummy-obsolete-credential",
        "soleaspay_secret_key": "dummy-obsolete-secret",
        "soleaspay_pout_enabled": True,
        "country_matrix": {"soleas": {"TG": True}, "ashtec": {"CI": False}},
        "ashtec_enabled": False, "ashtec_api_key": "dummy-other-key",
        "biztranspay_enabled": True,
    }
    run(db.app_settings.insert_one({"key": "payment_gateway", "value": config}))
    run(db.app_settings.insert_one({"_id": "soleaspay", "enabled": True}))
    run(db.app_settings.insert_one({"key": "moneyfusion", "value": {"payin_enabled": False}}))
    run(db.payment_providers.insert_many([{"id": "soleaspay"}, {"id": "moneyfusion"}]))
    run(db.payment_provider_countries.insert_many([
        {"provider_id": "soleaspay", "country_code": "TG"},
        {"provider_id": "ashtec", "country_code": "CI", "status": "inactive"},
    ]))
    run(db.payment_provider_operators.insert_one({"provider_id": "soleaspay", "operator_code": "1"}))
    historical = {"reference": "old-reference", "provider": "soleaspay", "amount": 2650, "status": "paid"}
    run(db.payments.insert_one(deepcopy(historical)))
    run(db.withdrawals.insert_one({"id": "old-withdrawal", "gateway": "soleaspay", "status": "processing"}))
    run(db.users.insert_one({"id": "member", "balance_profit": 1000, "max_level": 1}))
    before = {
        name: run(db[name].find({}).to_list(None))
        for name in ("payments", "withdrawals", "users")
    }
    for _ in range(2):
        run(retire_gateway_configuration(db))
    result = run(db.app_settings.find_one({"key": "payment_gateway"}))["value"]
    assert result["active"] == "ashtec"
    assert not any(k.startswith(("soleas", "solespay")) for k in result)
    assert result["country_matrix"] == {"ashtec": {"CI": False}}
    assert result["ashtec_enabled"] is False
    assert result["ashtec_api_key"] == "dummy-other-key"
    assert result["biztranspay_enabled"] is True
    assert run(db.app_settings.find_one({"_id": "soleaspay"})) is None
    assert run(db.app_settings.find_one({"key": "moneyfusion"}))["value"] == {"payin_enabled": False}
    assert run(db.payment_providers.find_one({"id": "moneyfusion"}))
    assert run(db.payment_provider_countries.find_one({"provider_id": "ashtec"}))["status"] == "inactive"
    assert run(db.payment_provider_operators.count_documents({})) == 0
    for name, records in before.items():
        assert run(db[name].find({}).to_list(None)) == records


@pytest.mark.parametrize("provider", RETIRED_IDS)
@pytest.mark.parametrize("kind", ["payin", "payout"])
def test_stale_normalized_rows_never_route_even_before_cleanup(db, provider, kind):
    run(db.payment_providers.insert_one({
        "id": provider, "status": "active", "auto_deposit": True,
        "auto_withdrawal": True, "priority": 0,
    }))
    run(db.payment_provider_countries.insert_one({
        "provider_id": provider, "country_code": "TG", "status": "active", "mode": "manual",
    }))
    assert provider not in _PROVIDER_CATALOG
    assert run(_provider_ready(db, provider, kind)) == (False, "unsupported_provider")
    assert run(pick_provider(db, kind=kind, country="TG")) is None


def test_removed_routes_and_sdk_are_absent():
    import server
    paths = [r.path.lower() for r in server.app.routes if hasattr(r, "path")]
    assert not any(any(name in path for name in RETIRED_IDS) for path in paths)
    assert not (Path(__file__).parents[1] / "soleaspay.py").exists()
    root = Path(__file__).parents[2]
    for file in (root / "frontend/app/(admin)/index.tsx",
                 root / "frontend/app/(admin)/payments.tsx",
                 root / "frontend/app/(app)/activation.tsx"):
        content = file.read_text().lower()
        assert not any(name in content for name in RETIRED_IDS)


def test_old_config_cannot_reappear_in_public_catalogues(db):
    import server
    run(db.app_settings.insert_one({"key": "payment_gateway", "value": {
        "active": "soleas", "soleas_enabled": True,
        "soleaspay_pout_enabled": True, "country_matrix": {"soleas": {"TG": True}},
    }}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    cfg = run(server._load_payment_gateway(db))
    assert cfg["active"] == "ashtec"
    assert not any(k.startswith(("soleas", "solespay")) for k in cfg)
    assert cfg["country_matrix"] == {}
    settings = run(server.get_payment_methods_status(request))
    assert settings["auto_enabled"] is False
    assert not any(k.startswith(("soleas", "solespay")) for k in settings)
    catalog = run(server.payments_catalog(request))
    assert next(m for m in catalog["methods"] if m["code"] == "mobile")["countries"] == []
    assert run(server.pick_gateway_for_country(db, "TG")) is None
    assert run(server.pick_payout_gateway_for_country(db, "TG")) is None


def test_removed_provider_no_longer_authorizes_activation(db):
    from matrix import activate_level
    with pytest.raises(ValueError, match="Source d'activation invalide"):
        run(activate_level(db, "member", 1, source="soleaspay"))
