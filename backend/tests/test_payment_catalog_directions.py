"""Regression tests for independent Pay-in and Pay-out catalogs."""
import asyncio

import pytest
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

import biztranspay
import moneyfusion
from payment_exclusivity import mobile_routes
from payment_providers import sync_btp_catalog_rows
from payment_router import pick_provider, toggle_operator


def run(coro):
    return asyncio.run(coro)


def _db():
    return AsyncMongoMockClient(tz_aware=True).payment_catalog_directions


def test_biztranspay_payout_catalog_maps_live_cameroon_orange_operator():
    db = _db()

    async def seed_and_sync():
        await db.payment_providers.insert_one({
            "id": "biztranspay", "name": "Biz-transPay", "status": "active",
            "auto_deposit": True, "auto_withdrawal": True, "priority": 1,
        })
        await db.payment_provider_countries.insert_one({
            "provider_id": "biztranspay", "country_code": "CM",
            "status": "active", "currency": "XAF",
        })
        await db.payment_provider_operators.insert_one({
            "provider_id": "biztranspay", "country_code": "CM",
            "operator_code": "orange_cm", "operator_label": "Orange Money",
            "status": "active",
        })
        await sync_btp_catalog_rows(db, [{
            "country": "CM", "code": "orange-money-cm", "currency": "XAF",
            "label": "Orange Money",
        }], direction="payout")

    run(seed_and_sync())
    route = run(db.payment_provider_payout_operators.find_one({
        "provider_id": "biztranspay", "country_code": "CM",
        "operator_code": "orange-money-cm",
    }))
    assert route["status"] == "inactive"
    assert run(toggle_operator(
        db, "biztranspay", "CM", "orange-money-cm", True, kind="payout",
    ))
    route = run(db.payment_provider_payout_operators.find_one({
        "provider_id": "biztranspay", "country_code": "CM",
        "operator_code": "orange-money-cm",
    }))
    match = biztranspay._resolve_live_payout_entry(
        [{"country": "CM", "code": "orange-money-cm", "currency": "XAF",
          "label": "Orange Money"}],
        "CM", "Orange Money",
    )

    assert route["status"] == "active"
    assert match["code"] == "orange-money-cm"


def test_biztranspay_payout_toggle_persists_after_catalog_refresh():
    db = _db()
    entry = {
        "country": "TG", "code": "tmoney-tg", "currency": "XOF",
        "label": "T-Money",
    }

    async def exercise():
        await db.payment_providers.insert_one({
            "id": "biztranspay", "name": "Biz-transPay", "status": "active",
            "auto_deposit": True, "auto_withdrawal": True, "priority": 1,
        })
        await sync_btp_catalog_rows(db, [entry], direction="payout")
        assert await toggle_operator(
            db, "biztranspay", "TG", "tmoney-tg", True, kind="payout",
        )
        await sync_btp_catalog_rows(db, [entry], direction="payout")
        enabled = await db.payment_provider_payout_operators.find_one({
            "provider_id": "biztranspay", "country_code": "TG",
            "operator_code": "tmoney-tg",
        })
        assert enabled["status"] == "active"

        assert await toggle_operator(
            db, "biztranspay", "TG", "tmoney-tg", False, kind="payout",
        )
        await sync_btp_catalog_rows(db, [entry], direction="payout")
        disabled = await db.payment_provider_payout_operators.find_one({
            "provider_id": "biztranspay", "country_code": "TG",
            "operator_code": "tmoney-tg",
        })
        gateway = await db.app_settings.find_one({"key": "payment_gateway"})
        assert disabled["status"] == "inactive"
        assert gateway["value"]["biztranspay_payout_countries"]["TG"]["tmoney-tg"] is False
        assert "tmoney-tg" not in gateway["value"].get("biztranspay_countries", {}).get("TG", {})

    run(exercise())


def test_moneyfusion_payout_toggle_does_not_change_current_payin_catalog():
    db = _db()

    async def seed():
        await db.payment_providers.insert_one({
            "id": "moneyfusion", "name": "MoneyFusion", "status": "active",
            "auto_deposit": True, "auto_withdrawal": True, "priority": 4,
        })
        await db.payment_provider_countries.insert_one({
            "provider_id": "moneyfusion", "country_code": "TG",
            "status": "active", "currency": "XOF",
        })
        await db.payment_provider_operators.insert_one({
            "provider_id": "moneyfusion", "country_code": "TG",
            "operator_code": "tmoney-tg", "operator_label": "T-Money",
            "status": "active",
        })
        await moneyfusion.sync_catalog(db, [{
            "country_code": "TG", "country": "Togo", "currency": "XOF",
            "operators": [{"code": "tmoney-tg", "label": "T-Money"}],
        }])

    run(seed())
    initial_payout_operator = run(db.payment_provider_payout_operators.find_one({
        "provider_id": "moneyfusion", "country_code": "TG",
        "operator_code": "tmoney-tg",
    }))
    assert initial_payout_operator["status"] == "inactive"
    assert run(toggle_operator(
        db, "moneyfusion", "TG", "tmoney-tg", True, kind="payout",
    ))
    assert run(db.payment_provider_payout_operators.find_one({
        "provider_id": "moneyfusion", "country_code": "TG",
        "operator_code": "tmoney-tg",
    }))["status"] == "active"
    assert run(toggle_operator(
        db, "moneyfusion", "TG", "tmoney-tg", False, kind="payout",
    ))

    payin_operator = run(db.payment_provider_operators.find_one({
        "provider_id": "moneyfusion", "country_code": "TG",
        "operator_code": "tmoney-tg",
    }))
    payout_operator = run(db.payment_provider_payout_operators.find_one({
        "provider_id": "moneyfusion", "country_code": "TG",
        "operator_code": "tmoney-tg",
    }))
    assert payin_operator["status"] == "active"
    assert payout_operator["status"] == "inactive"
    assert run(db.payment_provider_countries.find_one({
        "provider_id": "moneyfusion", "country_code": "TG",
    }))["status"] == "active"


def test_provider_assignment_stays_exclusive_across_payin_and_payout(monkeypatch):
    db = _db()

    async def seed():
        await db.payment_providers.insert_many([
            {"id": "biztranspay", "name": "Biz-transPay", "status": "active",
             "auto_deposit": True, "auto_withdrawal": True, "priority": 1},
            {"id": "moneyfusion", "name": "MoneyFusion", "status": "active",
             "auto_deposit": False, "auto_withdrawal": True, "priority": 2},
        ])
        await db.payment_provider_countries.insert_one({
            "provider_id": "biztranspay", "country_code": "CM",
            "status": "active",
        })
        await db.payment_provider_operators.insert_one({
            "provider_id": "biztranspay", "country_code": "CM",
            "operator_code": "orange-cm-deposit", "operator_label": "Orange Money",
            "status": "active",
        })
        await db.payment_provider_payout_countries.insert_one({
            "provider_id": "biztranspay", "country_code": "CM",
            "status": "active",
        })
        await db.payment_provider_payout_operators.insert_one({
            "provider_id": "biztranspay", "country_code": "CM",
            "operator_code": "orange-cm-payout", "operator_label": "Orange Money",
            "status": "active",
        })
        await db.payment_provider_payout_countries.insert_one({
            "provider_id": "moneyfusion", "country_code": "CM",
            "status": "active",
        })
        await db.payment_provider_payout_operators.insert_one({
            "provider_id": "moneyfusion", "country_code": "CM",
            "operator_code": "orange-cm-misassigned", "operator_label": "Orange Money",
            "status": "inactive",
        })

    async def ready(db_arg, provider_id, kind):
        return True, None

    run(seed())
    monkeypatch.setattr("payment_router._provider_ready", ready)
    payin = run(pick_provider(db, kind="payin", country="CM", operator="Orange Money"))
    payout = run(pick_provider(db, kind="payout", country="CM", operator="Orange Money"))
    with pytest.raises(HTTPException) as conflict:
        run(toggle_operator(
            db, "moneyfusion", "CM", "orange-cm-misassigned", True, kind="payout",
        ))

    assert payin["provider_id"] == "biztranspay"
    assert payout["provider_id"] == "biztranspay"
    assert len(run(mobile_routes(db, kind="payin"))) == 1
    assert len(run(mobile_routes(db, kind="payout"))) == 1
    assert conflict.value.status_code == 409
