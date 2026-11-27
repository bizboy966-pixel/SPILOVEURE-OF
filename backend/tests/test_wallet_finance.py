import pytest
import time
from fastapi import HTTPException

import btp_catalog
import biztranspay
import feature_flags
import wallet_finance
from mongomock_motor import AsyncMongoMockClient
from wallet_finance import (
    _wallet_field, calculate_fee_quote, settle_wallet_deposit, settle_wallet_send,
)


def test_client_pays_fee_adds_fee_to_total_for_deposit():
    quote = calculate_fee_quote(1000, 5, "client", "deposit", "XOF")
    assert quote == {
        "amount": 1000.0,
        "fee_amount": 50.0,
        "total_amount": 1050.0,
        "recipient_amount": 1000.0,
        "wallet_debit": 0.0,
        "provider_amount": 1050.0,
        "wallet_credit": 1000.0,
    }


def test_sender_pays_fee_deducts_fee_from_deposit_credit():
    quote = calculate_fee_quote(1000, 5, "sender", "deposit", "XOF")
    assert quote["total_amount"] == 1000
    assert quote["provider_amount"] == 1000
    assert quote["wallet_credit"] == 950


def test_send_fee_is_charged_to_selected_wallet_and_provider_receives_net():
    quote = calculate_fee_quote(1000, 2.5, "sender", "send", "XOF")
    assert quote["fee_amount"] == 25
    assert quote["wallet_debit"] == 1000
    assert quote["provider_amount"] == 975


def test_crypto_quote_rounds_to_six_decimals():
    quote = calculate_fee_quote(1.23456789, 1, "client", "deposit", "USDT.TRC20")
    assert quote["amount"] == 1.234568
    assert quote["fee_amount"] == 0.012346
    assert quote["wallet_credit"] == 1.234568


def test_wallet_fields_cannot_create_mongo_path_segments():
    assert _wallet_field("XOF") == "wallet_deposit_balance"
    assert _wallet_field("USDT.TRC20") == "wallet_balances.USDT_TRC20"
    assert "." not in _wallet_field("USDT.TRC20").split(".", 1)[1]


def test_fee_cannot_consume_the_whole_sender_amount():
    with pytest.raises(ValueError, match="supérieurs ou égaux"):
        calculate_fee_quote(100, 100, "sender", "send", "XOF")


@pytest.mark.parametrize("direction", ["deposit", "send"])
def test_invalid_fee_payer_is_rejected(direction):
    with pytest.raises(ValueError, match="Choisissez qui paie"):
        calculate_fee_quote(100, 5, "unknown", direction, "XOF")


@pytest.mark.asyncio
async def test_crypto_asset_list_does_not_replace_legacy_single_activation_asset(monkeypatch):
    class Settings:
        async def find_one(self, *_args, **_kwargs):
            return {}

    class Database:
        app_settings = Settings()

    monkeypatch.setattr(biztranspay, "_get_secret_key", lambda _db: _empty_secret())
    monkeypatch.setattr(biztranspay, "_get_public_key", lambda _db: _empty_secret())
    btp_catalog._CATALOG.pop("crypto_assets_deposit", None)
    btp_catalog._CATALOG["crypto_deposit"] = (time.time(), "USDT.BEP20")

    assets = await btp_catalog.fetch_crypto_assets(Database(), "deposit")

    assert assets == []
    assert btp_catalog._CATALOG["crypto_deposit"][1] == "USDT.BEP20"


async def _empty_secret():
    return ""


@pytest.mark.asyncio
async def test_confirmed_deposit_credits_currency_wallet_once():
    db = AsyncMongoMockClient().wallet_finance_deposit
    await db.users.insert_one({"id": "user-1", "wallet_deposit_balance": 0})
    payment = {
        "reference": "SPV-WALLET-ONE", "user_id": "user-1", "provider": "biztranspay",
        "wallet_asset_code": "XOF", "wallet_credit_amount": 2500,
        "wallet_fee_amount": 0, "status": "pending", "created_at": 1,
    }
    await db.payments.insert_one({**payment, "kind": "wallet_deposit"})

    first = await settle_wallet_deposit(db, payment, source="test")
    second = await settle_wallet_deposit(db, payment, source="test")

    user = await db.users.find_one({"id": "user-1"})
    assert first["wallet_credited"] is True
    assert second["wallet_credited"] is True
    assert user["wallet_deposit_balance"] == 2500


@pytest.mark.asyncio
async def test_definitive_send_failure_refunds_reserved_wallet_once():
    db = AsyncMongoMockClient().wallet_finance_send
    await db.users.insert_one({
        "id": "user-1", "wallet_deposit_balance": 0,
        "wallet_send_reservations": {"SPV-SEND-ONE": 110},
    })
    send = {
        "id": "SPV-SEND-ONE", "user_id": "user-1", "kind": "send",
        "provider": "biztranspay", "wallet_asset": "XOF", "wallet_debit": 110,
        "provider_amount": 100, "currency": "XOF", "amount": 100, "fee_amount": 10,
        "status": "submitting", "created_at": 1,
    }
    await db.wallet_sends.insert_one(send)

    first = await settle_wallet_send(db, send, "rejected", "failed", source="test")
    second = await settle_wallet_send(db, send, "rejected", "failed", source="test")

    user = await db.users.find_one({"id": "user-1"})
    saved = await db.wallet_sends.find_one({"id": "SPV-SEND-ONE"})
    assert first["changed"] is True
    assert second["changed"] is False
    assert user["wallet_deposit_balance"] == 110
    assert saved["status"] == "rejected"


@pytest.mark.asyncio
async def test_public_catalog_hides_disabled_routes_and_provider_names(monkeypatch):
    db = AsyncMongoMockClient().wallet_public_catalog
    await feature_flags.ensure_default_flags(db)
    request = type("Request", (), {"app": type("App", (), {"state": type("State", (), {"db": db})()})()})()
    user = {"id": "user-1", "role": "user", "status": "active", "max_level": 1}
    rows = [
        {
            "route_id": "disabled", "direction": "deposit", "route_type": "mobile",
            "country_code": "TG", "country_name": "Togo", "currency": "XOF",
            "operator_code": "disabled-op", "operator_name": "Moov",
            "provider": "biztranspay", "provider_name": "Biz-transPay",
            "route_enabled": False, "available": False, "fee_enabled": False,
            "fee_percent": 0, "unavailable_reason": "Pays ou opérateur désactivé.",
        },
        {
            "route_id": "unreadable", "direction": "deposit", "route_type": "mobile",
            "country_code": "TG", "country_name": "Togo", "currency": "XOF",
            "operator_code": "undefined-op", "operator_name": "undefined",
            "provider": "biztranspay", "provider_name": "Biz-transPay",
            "route_enabled": True, "available": False, "fee_enabled": False,
            "fee_percent": 0, "unavailable_reason": "Frais non configurés ou désactivés.",
        },
        {
            "route_id": "enabled-no-fees", "direction": "deposit", "route_type": "mobile",
            "country_code": "TG", "country_name": "Togo", "currency": "XOF",
            "operator_code": "tmoney", "operator_name": "T-Money",
            "provider": "biztranspay", "provider_name": "Biz-transPay",
            "route_enabled": True, "available": False, "fee_enabled": False,
            "fee_percent": 0, "unavailable_reason": "Frais non configurés ou désactivés.",
        },
        *[
            {
                "route_id": f"crypto-{asset}", "direction": "deposit",
                "route_type": "crypto", "country_code": "*", "country_name": "Tous les pays",
                "currency": asset, "asset_code": asset, "coin": asset.split(".")[0],
                "network": asset.split(".")[1], "provider": "biztranspay",
                "provider_name": "Biz-transPay", "route_enabled": True,
                "available": False, "fee_enabled": False, "fee_percent": 0,
                "unavailable_reason": "Frais crypto non configurés.",
            }
            for asset in ("USDT.BEP20", "USDC.ERC20")
        ],
    ]
    monkeypatch.setattr(wallet_finance, "_catalog_rows", lambda _db: _async_value(rows))

    result = await wallet_finance.wallet_operations_catalog(request, "deposit", user)

    assert [country["code"] for country in result["countries"]] == ["TG"]
    operators = result["countries"][0]["operators"]
    assert [operator["name"] for operator in operators] == ["T-Money"]
    assert operators[0]["available"] is False
    assert "provider" not in operators[0] and "provider_name" not in operators[0]
    assert [asset["asset_code"] for asset in result["crypto_assets"]] == [
        "USDT.BEP20", "USDC.ERC20",
    ]
    assert all(asset["country_code"] == "*" for asset in result["crypto_assets"])
    assert all("provider_name" not in asset and "provider" not in asset for asset in result["crypto_assets"])
    assert "Biz-transPay" not in repr(result)


@pytest.mark.asyncio
async def test_wallet_profile_catalog_includes_gabon_and_congo_without_provider_names(monkeypatch):
    db = AsyncMongoMockClient().wallet_payout_profile_catalog
    await feature_flags.ensure_default_flags(db)
    request = type("Request", (), {
        "app": type("App", (), {"state": type("State", (), {"db": db})()})(),
    })()
    await feature_flags.update_flag(
        "wallet_send", feature_flags.FlagUpdate(enabled=False), request,
    )
    user = {"id": "user-1", "role": "user", "status": "active", "max_level": 1}
    rows = [
        {
            "route_id": "ga-airtel", "direction": "send", "route_type": "mobile",
            "country_code": "GA", "country_name": "Gabon", "currency": "XAF",
            "operator_code": "airtel_ga", "operator_name": "Airtel Money",
            "provider": "biztranspay", "provider_name": "Biz-transPay",
            "route_enabled": True, "available": True, "fee_enabled": True,
            "fee_percent": 2, "unavailable_reason": "",
        },
        {
            "route_id": "ga-disabled", "direction": "send", "route_type": "mobile",
            "country_code": "GA", "country_name": "Gabon", "currency": "XAF",
            "operator_code": "inactive_ga", "operator_name": "Opérateur désactivé",
            "provider": "moneyfusion", "provider_name": "MoneyFusion",
            "route_enabled": False, "available": False, "fee_enabled": False,
            "fee_percent": 0, "unavailable_reason": "Pays désactivé.",
        },
        {
            "route_id": "cg-mtn", "direction": "send", "route_type": "mobile",
            "country_code": "CG", "country_name": "Congo", "currency": "XAF",
            "operator_code": "mtn_cg", "operator_name": "MTN Mobile Money",
            "provider": "biztranspay", "provider_name": "Biz-transPay",
            "route_enabled": True, "available": True, "fee_enabled": True,
            "fee_percent": 2, "unavailable_reason": "",
        },
        {
            "route_id": "crypto-usdt", "direction": "send", "route_type": "crypto",
            "asset_code": "USDT.BEP20", "coin": "USDT", "network": "BEP20",
            "provider": "biztranspay", "provider_name": "Biz-transPay",
            "available": False,
        },
    ]
    monkeypatch.setattr(wallet_finance, "_catalog_rows", lambda _db: _async_value(rows))

    result = await wallet_finance.wallet_profile_catalog(request, user)

    countries = {item["code"]: item for item in result["countries"]}
    assert set(countries) == {"GA", "CG"}
    assert [item["code"] for item in countries["GA"]["operators"]] == ["airtel_ga"]
    assert [item["code"] for item in countries["CG"]["operators"]] == ["mtn_cg"]
    assert [item["asset_code"] for item in result["crypto_assets"]] == ["USDT.BEP20"]
    assert "provider" not in repr(result)
    assert "provider_name" not in repr(result)
    assert "Biz-transPay" not in repr(result)
    assert "MoneyFusion" not in repr(result)


async def _async_value(value):
    return value


@pytest.mark.asyncio
async def test_fee_warning_is_attached_only_to_an_admin_enabled_route(monkeypatch):
    db = AsyncMongoMockClient().wallet_route_activation
    routes = [
        {
            "route_id": "inactive-route", "provider": "biztranspay",
            "provider_name": "Biz-transPay", "direction": "deposit",
            "route_type": "mobile", "country_code": "TG", "country_name": "Togo",
            "currency": "XOF", "operator_code": "moov", "operator_name": "Moov",
            "country_enabled": False, "operator_enabled": True, "provider_enabled": True,
            "hosted_operator_selection_required": False,
        },
        {
            "route_id": "active-route", "provider": "biztranspay",
            "provider_name": "Biz-transPay", "direction": "deposit",
            "route_type": "mobile", "country_code": "TG", "country_name": "Togo",
            "currency": "XOF", "operator_code": "tmoney", "operator_name": "T-Money",
            "country_enabled": True, "operator_enabled": True, "provider_enabled": True,
            "hosted_operator_selection_required": False,
        },
    ]

    async def route_rows(_db, direction):
        return [row for row in routes if row["direction"] == direction]

    async def crypto_assets(_db, _direction):
        return []

    async def selected_route(_db, *, kind, country, operator):
        return {"provider_id": "biztranspay"} if operator == "tmoney" else None

    monkeypatch.setattr(wallet_finance, "_provider_route_rows", route_rows)
    monkeypatch.setattr(wallet_finance, "_crypto_catalog", crypto_assets)
    monkeypatch.setattr("payment_router.pick_provider", selected_route)

    catalog = await wallet_finance._catalog_rows(db)
    mobile = [row for row in catalog if row["route_type"] == "mobile" and row["direction"] == "deposit"]
    inactive = next(row for row in mobile if row["route_id"] == "inactive-route")
    active = next(row for row in mobile if row["route_id"] == "active-route")
    assert inactive["route_enabled"] is False
    assert "Frais" not in inactive["unavailable_reason"]
    assert active["route_enabled"] is True
    assert active["unavailable_reason"] == "Frais non configurés ou désactivés."


@pytest.mark.asyncio
async def test_admin_fee_catalog_uses_direction_catalogs_and_keeps_crypto_payout_closed(monkeypatch):
    db = AsyncMongoMockClient().wallet_admin_catalog
    await feature_flags.ensure_default_flags(db)
    request = type("Request", (), {"app": type("App", (), {"state": type("State", (), {"db": db})()})()})()
    actor = {"id": "admin-1"}

    async def no_mobile_routes(_db, _direction):
        return []

    async def crypto_catalog(_db, direction):
        assets = {
            "deposit": ["USDT.BEP20", "BTC.BTC"],
            "payout": ["USDT.TRC20", "USDC.ERC20"],
        }
        return [{"code": code, "asset_code": code} for code in assets[direction]]

    async def ready(_db, _provider, _direction, _route_type):
        return True

    monkeypatch.setattr(wallet_finance, "_provider_route_rows", no_mobile_routes)
    monkeypatch.setattr(wallet_finance, "_crypto_catalog", crypto_catalog)
    monkeypatch.setattr(wallet_finance, "_provider_runtime_ready", ready)

    before = await wallet_finance.admin_wallet_fees(request, actor)
    rows = before["routes"]
    assert {(row["direction"], row["asset_code"]) for row in rows} == {
        ("deposit", "USDT.BEP20"), ("deposit", "BTC.BTC"),
        ("send", "USDT.TRC20"), ("send", "USDC.ERC20"),
    }
    payout = next(row for row in rows if row["direction"] == "send")
    assert payout["available"] is False
    await wallet_finance.update_wallet_fee(
        payout["route_id"],
        wallet_finance.FeeUpdateIn(enabled=True, rate_percent=2.5, fixed_amount=0.75),
        request,
        actor,
    )
    after = await wallet_finance.admin_wallet_fees(request, actor)
    saved = next(row for row in after["routes"] if row["route_id"] == payout["route_id"])
    assert saved["enabled"] is True
    assert saved["rate_percent"] == 2.5
    assert saved["fixed_amount"] == 0.75
    assert saved["available"] is False
    await db.users.insert_one({
        "id": "user-1", "role": "user", "status": "active", "max_level": 1,
        "wallet_deposit_balance": 100, "wallet_balances": {},
    })
    with pytest.raises(HTTPException) as error:
        await wallet_finance.create_wallet_quote(
            wallet_finance.QuoteIn(
                direction="send", route_id=payout["route_id"], amount=1,
                fee_payer="client", wallet_asset="USDT.TRC20",
            ),
            request,
            {"id": "user-1", "role": "user", "status": "active", "max_level": 1},
        )
    assert error.value.status_code == 503
    assert await db.wallet_quotes.count_documents({}) == 0
