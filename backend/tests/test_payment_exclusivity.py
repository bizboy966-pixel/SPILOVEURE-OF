"""Exclusive Mobile Money assignment, tested without network or real money."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from payment_exclusivity import operator_identity, validate_change, conflicts, mobile_routes
from payment_router import pick_provider, toggle_country, toggle_operator


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture
def db():
    database = AsyncMongoMockClient(tz_aware=True).exclusive_payments
    async def seed():
        await database.app_settings.insert_one({"key": "payment_gateway", "value": {
            "ashtec_enabled": True, "ashtec_api_key": "unit-only-not-real",
            "biztranspay_enabled": True, "biztranspay_payin_enabled": True,
            "biztranspay_payout_enabled": True,
            "biztranspay_public_key": "pk_live_unit_test", "biztranspay_secret_key": "sk_live_unit_test",
        }})
        for pid in ("ashtec", "biztranspay"):
            await database.payment_providers.insert_one({
                "id": pid, "status": "active", "auto_deposit": True,
                "auto_withdrawal": pid == "biztranspay", "priority": 1,
            })
            await database.payment_provider_countries.insert_one({
                "provider_id": pid, "country_code": "TG", "status": "active", "mode": "automatic"})
        for pid, code, label, enabled in (
            ("ashtec", "tmoney", "Mixx By Yas", True),
            ("ashtec", "moov", "Moov Money", False),
            ("biztranspay", "tmoney_tg", "T-Money", False),
            ("biztranspay", "moov_tg", "Flooz", True),
        ):
            await database.payment_provider_operators.insert_one({
                "provider_id": pid, "country_code": "TG", "operator_code": code,
                "operator_label": label, "status": "active" if enabled else "inactive"})
    run(seed())
    return database


@pytest.mark.parametrize("left,right", [
    (("tmoney_tg", "T-Money"), ("mixx-tg", "Mixx By Yas")),
    (("moov_tg", "Moov Money"), ("flooz-togo", "Flooz")),
    (("orange_ci", "Orange Money"), ("orange-ci", "Orange")),
    (("mtn-benin", "MTN Mobile Money"), ("mtn_bj", "MTN MoMo")),
])
def test_physical_operator_not_provider_spelling(left, right):
    assert operator_identity("TG", *left) == operator_identity("TG", *right)


def test_same_country_different_operators_coexist(db):
    assert conflicts(run(mobile_routes(db))) == {}
    mixx = run(pick_provider(db, kind="payin", country="TG", operator="tmoney_tg"))
    moov = run(pick_provider(db, kind="payin", country="TG", operator="moov_tg"))
    assert mixx["provider_id"] == "ashtec"
    assert mixx["operator_code"] == "tmoney"
    assert moov["provider_id"] == "biztranspay"


def test_enabling_conflicting_operator_is_rejected_without_writing(db):
    with pytest.raises(HTTPException) as exc:
        run(toggle_operator(db, "biztranspay", "TG", "tmoney_tg", True))
    assert exc.value.status_code == 409
    assert run(db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "operator_code": "tmoney_tg"}))["status"] == "inactive"


def test_enabling_country_checks_every_operator(db):
    with pytest.raises(HTTPException) as exc:
        run(toggle_country(db, "biztranspay", "TG", True))
    assert exc.value.status_code == 409
    assert conflicts(run(mobile_routes(db))) == {}


def test_conflict_is_blocked_even_with_priority_and_missing_credentials(db):
    run(db.payment_provider_operators.update_one(
        {"provider_id": "biztranspay", "operator_code": "tmoney_tg"}, {"$set": {"status": "active"}}))
    run(db.payment_providers.update_one({"id": "biztranspay"}, {"$set": {"priority": 999}}))
    with pytest.raises(HTTPException) as exc:
        run(pick_provider(db, kind="payin", country="TG", operator="tmoney"))
    assert exc.value.status_code == 409


def test_disabling_then_reassigning_preserves_other_operator(db):
    run(toggle_operator(db, "ashtec", "TG", "tmoney", False))
    run(toggle_operator(db, "biztranspay", "TG", "tmoney_tg", True))
    assert run(pick_provider(db, kind="payin", country="TG", operator="tmoney"))["provider_id"] == "biztranspay"
    assert run(pick_provider(db, kind="payin", country="TG", operator="moov"))["provider_id"] == "biztranspay"
    from payment_providers import _sync_countries_operators
    cfg = run(db.app_settings.find_one({"key": "payment_gateway"}))["value"]
    run(_sync_countries_operators(db, "ashtec", cfg))
    assert run(db.payment_provider_operators.find_one(
        {"provider_id": "ashtec", "operator_code": "tmoney"}))["status"] == "inactive"


def test_master_activation_checks_existing_assignments(db):
    run(db.payment_providers.update_one({"id": "biztranspay"}, {"$set": {"status": "inactive"}}))
    run(db.payment_provider_operators.update_one(
        {"provider_id": "biztranspay", "operator_code": "tmoney_tg"}, {"$set": {"status": "active"}}))
    with pytest.raises(HTTPException) as exc:
        run(validate_change(db, provider_enabled={"biztranspay": True}))
    assert exc.value.status_code == 409


def test_unavailable_owner_does_not_fallback_to_other_operator(db, monkeypatch):
    monkeypatch.delenv("ASHTECPAY_API_KEY", raising=False)
    run(db.app_settings.update_one({"key": "payment_gateway"}, {"$set": {"value.ashtec_api_key": ""}}))
    route = run(pick_provider(db, kind="payin", country="TG", operator="tmoney"))
    assert not (route or {}).get("provider_id")


def test_concurrent_admin_enables_cannot_assign_both_providers(db):
    run(db.payment_provider_operators.update_many(
        {"operator_code": {"$in": ["tmoney", "tmoney_tg"]}}, {"$set": {"status": "inactive"}}))
    async def enable_both():
        return await asyncio.gather(
            toggle_operator(db, "ashtec", "TG", "tmoney", True),
            toggle_operator(db, "biztranspay", "TG", "tmoney_tg", True),
            return_exceptions=True)
    results = run(enable_both())
    assert sum(result is True for result in results) == 1
    assert sum(isinstance(result, HTTPException) for result in results) == 1
    assert conflicts(run(mobile_routes(db))) == {}


def test_activation_dispatches_native_code_to_only_selected_provider(db, monkeypatch):
    import server
    import ashtec_activation
    import biztranspay
    ash = AsyncMock(return_value={"reference": "ash-one", "status": "pending"})
    btp = AsyncMock(return_value={"reference": "btp-one", "status": "pending"})
    monkeypatch.setattr(ashtec_activation, "create_ashtec_payment", ash)
    monkeypatch.setattr(biztranspay, "biztranspay_activation", btp)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    result = run(server.payments_activate(
        server.ActivateIn(method="mobile", country="TG", operator="tmoney_tg", phone="90000000"),
        request, {"id": "user", "username": "member", "email": "user@example.invalid", "max_level": 0}))
    assert result["gateway"] == "ashtec"
    assert ash.await_args.kwargs["operator"] == "tmoney"
    btp.assert_not_awaited()


def test_existing_intent_keeps_original_provider_after_admin_reassignment(db, monkeypatch):
    import server
    import ashtec_activation
    import biztranspay
    ash = AsyncMock()
    btp = AsyncMock()
    monkeypatch.setattr(ashtec_activation, "create_ashtec_payment", ash)
    monkeypatch.setattr(biztranspay, "biztranspay_activation", btp)
    run(db.payments.insert_one({
        "reference": "old-payment", "provider": "biztranspay", "kind": "activation",
        "user_id": "user", "status": "pending", "level": 1, "activation_done": False}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    result = run(server.payments_activate(
        server.ActivateIn(method="mobile", country="TG", operator="tmoney", phone="90000000"),
        request, {"id": "user", "username": "member", "email": "user@example.invalid", "max_level": 0}))
    assert result["reference"] == "old-payment"
    assert result["gateway"] == "biztranspay"
    ash.assert_not_awaited()
    btp.assert_not_awaited()


def test_operator_disable_cascades_to_legacy_alias_before_transfer(db):
    run(db.payment_provider_operators.insert_one({
        "provider_id": "biztranspay", "country_code": "TG",
        "operator_code": "moov-togo", "operator_label": "Moov Money (Flooz)", "status": "active"}))
    run(toggle_operator(db, "biztranspay", "TG", "moov-togo", False))
    assert run(db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "operator_code": "moov_tg"}))["status"] == "inactive"
    run(toggle_operator(db, "ashtec", "TG", "moov", True))
    assert conflicts(run(mobile_routes(db))) == {}
    assert run(pick_provider(db, kind="payin", country="TG", operator="moov_tg"))["provider_id"] == "ashtec"
