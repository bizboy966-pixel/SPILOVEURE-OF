from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

import feature_flags
import wallet_finance


def _request(db):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))


@pytest.mark.asyncio
async def test_wallet_operation_flags_default_on_and_survive_reseeding():
    db = AsyncMongoMockClient().wallet_operation_feature_flags
    request = _request(db)

    await feature_flags.ensure_default_flags(db)
    assert await feature_flags.is_enabled(db, "wallet_deposit") is True
    assert await feature_flags.is_enabled(db, "wallet_send") is True

    for key in ("wallet_deposit", "wallet_send"):
        await feature_flags.update_flag(
            key, feature_flags.FlagUpdate(enabled=False), request,
        )
    await feature_flags.ensure_default_flags(db)

    assert await feature_flags.is_enabled(db, "wallet_deposit") is False
    assert await feature_flags.is_enabled(db, "wallet_send") is False

    listed = await feature_flags.list_flags(request)
    enabled = {item["key"]: item["enabled"] for item in listed["items"]}
    assert enabled["wallet_deposit"] is False
    assert enabled["wallet_send"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("direction", "feature_key"),
    [("deposit", "wallet_deposit"), ("send", "wallet_send")],
)
async def test_wallet_operation_catalog_is_blocked_until_its_flag_is_enabled(
    direction, feature_key, monkeypatch,
):
    db = AsyncMongoMockClient().wallet_operation_catalog_flags
    request = _request(db)
    user = {"id": "user-1", "role": "user", "status": "active", "max_level": 1}
    await feature_flags.ensure_default_flags(db)
    await feature_flags.update_flag(
        feature_key, feature_flags.FlagUpdate(enabled=False), request,
    )
    catalog = AsyncMock(return_value=[])
    monkeypatch.setattr(wallet_finance, "_catalog_rows", catalog)

    with pytest.raises(HTTPException) as error:
        await wallet_finance.wallet_operations_catalog(request, direction, user)
    assert error.value.status_code == 503
    assert error.value.detail == "Bientôt disponible."
    catalog.assert_not_awaited()

    await feature_flags.update_flag(
        feature_key, feature_flags.FlagUpdate(enabled=True), request,
    )
    response = await wallet_finance.wallet_operations_catalog(request, direction, user)
    assert response["direction"] == direction
    catalog.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("direction", "feature_key"),
    [("deposit", "wallet_deposit"), ("send", "wallet_send")],
)
async def test_wallet_operation_quote_and_submit_are_blocked_when_disabled(
    direction, feature_key,
):
    db = AsyncMongoMockClient().wallet_operation_write_flags
    request = _request(db)
    user = {"id": "user-1", "role": "user", "status": "active", "max_level": 1}
    await feature_flags.ensure_default_flags(db)
    await feature_flags.update_flag(
        feature_key, feature_flags.FlagUpdate(enabled=False), request,
    )
    quote = wallet_finance.QuoteIn(
        direction=direction, route_id="route-1", amount=100,
        fee_payer="client",
    )
    with pytest.raises(HTTPException) as quote_error:
        await wallet_finance.create_wallet_quote(quote, request, user)
    assert quote_error.value.status_code == 503
    assert await db.wallet_quotes.count_documents({}) == 0

    await db.wallet_quotes.insert_one({
        "id": "existing-quote", "user_id": user["id"],
        "direction": direction, "status": "quoted",
    })
    with pytest.raises(HTTPException) as submit_error:
        await wallet_finance.submit_wallet_operation(
            wallet_finance.SubmitIn(quote_id="existing-quote"), request, user,
        )
    assert submit_error.value.status_code == 503
    saved_quote = await db.wallet_quotes.find_one({"id": "existing-quote"})
    assert saved_quote["status"] == "quoted"
    assert await db.wallet_sends.count_documents({}) == 0
