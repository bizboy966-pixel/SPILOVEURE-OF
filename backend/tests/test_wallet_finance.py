import pytest
import time

import btp_catalog
import biztranspay
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
