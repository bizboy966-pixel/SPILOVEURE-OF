from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

import wallet_finance


ASSET = "USDT.TRC20"


def _request(db):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))


async def _setup(monkeypatch, *, xof=15000, crypto=0, additional_assets=None):
    client = AsyncMongoMockClient()
    db = client.wallet_exchange_test
    await wallet_finance.initialize(db)
    await db.users.insert_one({
        "id": "user-1", "role": "user", "status": "active", "max_level": 1,
        "balance_profit": xof, "wallet_deposit_balance": 321,
        "wallet_balances": {"USDT_TRC20": crypto},
    })

    catalog_assets = [{
            "asset_code": ASSET,
            "code": ASSET,
            "label": "USDT TRC20",
            "coin": "USDT",
            "network": "TRC20",
        }, *(additional_assets or [])]

    async def fake_crypto_catalog(_db, direction):
        return catalog_assets if direction == "deposit" else []

    monkeypatch.setattr(wallet_finance, "_crypto_catalog", fake_crypto_catalog)
    request = _request(db)
    await wallet_finance.update_wallet_exchange_rate(
        ASSET,
        wallet_finance.ExchangeRateUpdateIn(
            buy_enabled=True, xof_per_unit_buy=600,
            sell_enabled=True, xof_per_unit_sell=590,
        ),
        request,
        {"id": "admin-1"},
    )
    return client, db, request, {"id": "user-1", "role": "user", "status": "active", "max_level": 1}


@pytest.mark.asyncio
async def test_xof_to_crypto_executes_once_and_keeps_deposit_wallet_separate(monkeypatch):
    _client, db, request, user = await _setup(monkeypatch)
    quote = await wallet_finance.create_wallet_exchange_quote(
        wallet_finance.ExchangeQuoteIn(
            direction="xof_to_crypto", asset_code=ASSET, amount=12000,
        ),
        request,
        user,
    )
    assert quote["amount_out"] == 20

    first = await wallet_finance.execute_wallet_exchange(
        wallet_finance.ExchangeExecuteIn(quote_id=quote["quote_id"]), request, user,
    )
    second = await wallet_finance.execute_wallet_exchange(
        wallet_finance.ExchangeExecuteIn(quote_id=quote["quote_id"]), request, user,
    )

    saved = await db.users.find_one({"id": user["id"]})
    assert first["status"] == "completed"
    assert second["already_completed"] is True
    assert saved["balance_profit"] == 3000
    assert saved["wallet_deposit_balance"] == 321
    assert saved["wallet_balances"]["USDT_TRC20"] == 20
    assert await db.wallet_operations.count_documents({"reference": quote["quote_id"]}) == 1


@pytest.mark.asyncio
async def test_crypto_to_xof_uses_sell_rate_and_credits_available_balance(monkeypatch):
    _client, db, request, user = await _setup(monkeypatch, xof=100, crypto=2)
    quote = await wallet_finance.create_wallet_exchange_quote(
        wallet_finance.ExchangeQuoteIn(
            direction="crypto_to_xof", asset_code=ASSET, amount=1,
        ),
        request,
        user,
    )
    assert quote["amount_out"] == 590
    await wallet_finance.execute_wallet_exchange(
        wallet_finance.ExchangeExecuteIn(quote_id=quote["quote_id"]), request, user,
    )
    saved = await db.users.find_one({"id": user["id"]})
    assert saved["balance_profit"] == 690
    assert saved["wallet_balances"]["USDT_TRC20"] == 1
    assert saved["wallet_deposit_balance"] == 321


@pytest.mark.asyncio
async def test_crypto_to_crypto_debits_source_and_credits_selected_crypto(monkeypatch):
    destination = {
        "asset_code": "USDC.BEP20", "code": "USDC.BEP20",
        "label": "USDC BEP20", "coin": "USDC", "network": "BEP20",
    }
    _client, db, request, user = await _setup(
        monkeypatch, xof=100, crypto=2, additional_assets=[destination],
    )
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"wallet_balances.USDC_BEP20": 0}},
    )
    await wallet_finance.update_wallet_exchange_rate(
        "USDC.BEP20",
        wallet_finance.ExchangeRateUpdateIn(
            buy_enabled=True, xof_per_unit_buy=600,
            sell_enabled=True, xof_per_unit_sell=580,
        ),
        request,
        {"id": "admin-1"},
    )

    quote = await wallet_finance.create_wallet_exchange_quote(
        wallet_finance.ExchangeQuoteIn(
            direction="crypto_to_crypto",
            source_asset_code=ASSET,
            asset_code="USDC.BEP20",
            amount=2,
        ),
        request,
        user,
    )
    assert quote["amount_out"] == 1.966667
    assert quote["source_code"] == ASSET
    assert quote["destination_code"] == "USDC.BEP20"

    await wallet_finance.execute_wallet_exchange(
        wallet_finance.ExchangeExecuteIn(quote_id=quote["quote_id"]), request, user,
    )
    saved = await db.users.find_one({"id": user["id"]})
    assert saved["wallet_balances"]["USDT_TRC20"] == 0
    assert saved["wallet_balances"]["USDC_BEP20"] == 1.966667
    assert saved["wallet_asset_codes"]["USDC_BEP20"] == "USDC.BEP20"
    assert saved["balance_profit"] == 100
    assert saved["wallet_deposit_balance"] == 321


@pytest.mark.asyncio
async def test_exchange_with_insufficient_balance_is_rejected_without_debit(monkeypatch):
    _client, db, request, user = await _setup(monkeypatch)
    quote = await wallet_finance.create_wallet_exchange_quote(
        wallet_finance.ExchangeQuoteIn(
            direction="xof_to_crypto", asset_code=ASSET, amount=12000,
        ),
        request,
        user,
    )
    await db.users.update_one({"id": user["id"]}, {"$set": {"balance_profit": 9000}})

    with pytest.raises(HTTPException) as error:
        await wallet_finance.execute_wallet_exchange(
            wallet_finance.ExchangeExecuteIn(quote_id=quote["quote_id"]), request, user,
        )

    saved = await db.users.find_one({"id": user["id"]})
    operation = await db.wallet_exchange_operations.find_one({"quote_id": quote["quote_id"]})
    assert error.value.status_code == 400
    assert saved["balance_profit"] == 9000
    assert saved["wallet_balances"].get("USDT_TRC20", 0) == 0
    assert operation["status"] == "rejected"


@pytest.mark.asyncio
async def test_disabled_direction_cannot_create_exchange_quote(monkeypatch):
    _client, db, request, user = await _setup(monkeypatch)
    await wallet_finance.update_wallet_exchange_rate(
        ASSET,
        wallet_finance.ExchangeRateUpdateIn(
            buy_enabled=False, xof_per_unit_buy=600,
            sell_enabled=True, xof_per_unit_sell=590,
        ),
        request,
        {"id": "admin-1"},
    )

    with pytest.raises(HTTPException) as error:
        await wallet_finance.create_wallet_exchange_quote(
            wallet_finance.ExchangeQuoteIn(
                direction="xof_to_crypto", asset_code=ASSET, amount=1000,
            ),
            request,
            user,
        )

    assert error.value.status_code == 503
    assert await db.wallet_exchange_quotes.count_documents({}) == 0
