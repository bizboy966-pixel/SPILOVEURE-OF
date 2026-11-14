"""MoneyFusion contract/security tests. All persistence and HTTP are isolated."""
import asyncio
import logging
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

import moneyfusion as mf
from auth import create_access_token
from payment_router import _provider_ready, toggle_country, toggle_operator


METHODS = [
    {"country_code": "TG", "country": "Togo", "currency": "XOF",
     "operators": [{"code": "tmoney-tg", "label": "T-Money"},
                   {"code": "moov-tg", "label": "Moov"}]},
    {"country_code": "CD", "country": "Congo RDC", "currency": "USD",
     "operators": [{"code": "airtel-cd", "label": "Airtel Money"}]},
]
PAYOUT = {"id": "wd-one", "user_id": "member", "amount": 3000,
          "net_payout": 2650, "method": "mobile", "country": "TG",
          "operator": "tmoney-tg", "phone": "+22890123456", "status": "pending"}


def run(coro):
    return asyncio.run(coro)


def headers(uid="admin", role="admin", scope=None):
    return {"Authorization": "Bearer " + create_access_token(uid, role, scope)}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "unit-tests-only-encryption-key-with-no-real-value")
    monkeypatch.setenv("PUBLIC_APP_URL", "https://example.invalid")
    db = AsyncMongoMockClient(tz_aware=True).moneyfusion_test
    app = FastAPI()
    app.state.db = db
    for router in (mf.api, mf.admin, mf.webhooks):
        app.include_router(router)

    async def seed():
        for uid, role, level in (("admin", "admin", 1), ("member", "user", 0), ("other", "user", 0)):
            await db.users.insert_one({
                "id": uid, "username": uid, "role": role, "max_level": level,
                "status": "active" if level else "pending", "phone": "+22890123456",
                "auth_flow_version": 2 if uid == "member" else 1,
                "balance_profit": 100, "total_withdrawn": 0,
            })
        await db.payments.create_index("moneyfusion_active_key", unique=True, sparse=True)
        await db.moneyfusion_payouts.create_index("wd_id", unique=True)
        await db.moneyfusion_payouts.create_index("tokenPay", unique=True, sparse=True)
        await mf.sync_catalog(db, METHODS)
        for country in METHODS:
            await toggle_country(db, "moneyfusion", country["country_code"], True)
        await db.withdrawals.insert_one(dict(PAYOUT))
    run(seed())
    client = TestClient(app)
    # Any unmocked provider request fails rather than making a real payment.
    fake_http = provider_http(monkeypatch, {})
    yield SimpleNamespace(client=client, db=db, http=fake_http, monkeypatch=monkeypatch)
    client.close()


def provider_http(monkeypatch, responses, *, fail=False):
    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            return self.reply("GET", url, kwargs)

        async def post(self, url, **kwargs):
            return self.reply("POST", url, kwargs)

        def reply(self, method, url, kwargs):
            calls.append((method, url, kwargs))
            if fail:
                raise TimeoutError("simulated lost provider response")
            assert url in responses, f"Unexpected external request: {method} {url}"
            return SimpleNamespace(raise_for_status=lambda: None,
                                   json=lambda: responses[url])

    monkeypatch.setattr(mf, "httpx", SimpleNamespace(AsyncClient=Client))
    return calls


def configure(env, **extra):
    body = {
        "payin_api_url": "https://pay.moneyfusion.net/merchant/unit-test/pay",
        "payout_private_key": "unit-test-private-key-not-real",
        "payin_enabled": True, "payout_enabled": True,
        "payin_local_currency_confirmed": True,
        "mobile_money_only_confirmed": True, "payout_ip_confirmed": True,
        "payin_country_codes": ["TG", "CD"],
    }
    body.update(extra)
    response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                              json=body, headers=headers())
    assert response.status_code == 200, response.text
    return response.json()


def initiate(env, **extra):
    body = {"phone": "+22890123456", "country_code": "TG", "level": 1}
    body.update(extra)
    return env.client.post("/api/payments/moneyfusion/initiate", json=body,
                           headers=headers("member", "user", "onboarding"))


def checkout_http(env):
    return provider_http(env.monkeypatch, {
        "https://pay.moneyfusion.net/merchant/unit-test/pay": {
            "statut": True, "token": "payin-token",
            "url": "https://payin.moneyfusion.net/payment/payin-token/merchant",
        },
    })


def verified_payin(payment, **extra):
    data = {
        "tokenPay": payment["provider_token"], "Montant": payment["amount"],
        "statut": "paid", "numeroSend": payment["phone"],
        "personal_Info": [{"userId": payment["user_id"], "orderId": payment["reference"]}],
    }
    data.update(extra)
    return {"statut": True, "data": data}


def test_admin_auth_and_onboarding_isolation(env):
    path = "/api/admin/payment-gateways/moneyfusion"
    assert env.client.get(path).status_code == 401
    assert env.client.get(path, headers=headers("other", "user")).status_code == 403
    assert env.client.post(path + "/catalog/refresh", headers=headers("other", "user")).status_code == 403
    assert initiate(env).status_code == 503
    assert env.http == []


def test_credentials_encrypted_masked_and_blank_keeps_them(env):
    result = configure(env)
    assert result["payin_api_configured"] and result["payout_key_configured"]
    assert "unit-test-private-key-not-real" not in str(result)
    doc = run(env.db.app_settings.find_one({"key": "moneyfusion_credentials"}))
    assert "unit-test-private-key-not-real" not in str(doc)
    assert "merchant/unit-test" not in str(doc)
    response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                              json={"payin_api_url": "", "payout_private_key": ""},
                              headers=headers())
    assert response.status_code == 200
    assert run(mf.load_credentials(env.db))["payout_private_key"] == "unit-test-private-key-not-real"


@pytest.mark.parametrize("url", [
    "http://pay.moneyfusion.net/a", "https://127.0.0.1/a", "https://evil.invalid/a",
    "https://pay.moneyfusion.net.evil.invalid/a", "https://user:pass@pay.moneyfusion.net/a",
    "https://pay.moneyfusion.net:8000/a", "https://pay.moneyfusion.net/",
])
def test_api_url_rejects_untrusted_destinations(env, url):
    response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                              json={"payin_api_url": url}, headers=headers())
    assert response.status_code == 400


def test_confirmations_required_and_bad_rates_rejected(env):
    for missing in ("payin_local_currency_confirmed", "mobile_money_only_confirmed", "payout_ip_confirmed"):
        response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                                  json={"payin_enabled": True, "payout_enabled": True,
                                        missing: False}, headers=headers())
        assert response.status_code == 400
    for rate in (-1, 0):
        response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                                  json={"rates_per_xof": {"USD": rate}}, headers=headers())
        assert response.status_code == 400
    response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                              json={"rates_per_xof": {"XOF": 2}}, headers=headers())
    assert response.status_code == 400


def test_secret_rotation_does_not_silently_overwrite_credentials(env):
    configure(env)
    original = run(env.db.app_settings.find_one({"key": "moneyfusion_credentials"}))["value"]
    env.monkeypatch.setenv("SESSION_SECRET", "different-unit-test-only-long-secret-value")
    response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                              json={"payin_enabled": False}, headers=headers())
    assert response.status_code == 503
    assert run(env.db.app_settings.find_one({"key": "moneyfusion_credentials"}))["value"] == original


def test_catalog_refresh_preserves_toggles_and_handles_naive_timestamp(env):
    run(toggle_operator(env.db, "moneyfusion", "TG", "tmoney-tg", False))
    run(mf.sync_catalog(env.db, METHODS))
    op = run(env.db.payment_provider_operators.find_one({"operator_code": "tmoney-tg"}))
    assert op["status"] == "inactive"
    run(env.db.app_settings.update_one({"key": "moneyfusion_catalog"},
                                      {"$set": {"updated_at": datetime.now()}}))
    assert len(run(mf.refresh_catalog(env.db))) == 2
    assert env.http == []
    run(mf.sync_catalog(env.db, [METHODS[1]]))
    country = run(env.db.payment_provider_countries.find_one({"country_code": "TG"}))
    assert country["status"] == "inactive"


def test_country_operator_and_fx_gates(env):
    configure(env)
    run(toggle_country(env.db, "moneyfusion", "TG", False))
    assert initiate(env).status_code == 400
    run(toggle_country(env.db, "moneyfusion", "TG", True))
    run(toggle_operator(env.db, "moneyfusion", "TG", "moov-tg", False))
    assert initiate(env).status_code == 400
    assert initiate(env, country_code="CD").status_code == 400
    assert env.http == []
    assert mf._amount_from_xof({"rates_per_xof": {"USD": 0.0016}}, 2650, "USD") == 4.24


def test_checkout_contract_duplicates_ownership_and_no_client_activation(env):
    configure(env)
    calls = checkout_http(env)
    response = initiate(env)
    assert response.status_code == 200, response.text
    ref = response.json()["reference"]
    assert response.json()["amount"] == 2650
    payload = calls[0][2]["json"]
    assert payload["totalPrice"] == 2650
    assert payload["return_url"] == "https://example.invalid/pay"
    assert payload["webhook_url"].endswith("/moneyfusion/payin")
    assert "currency" not in payload
    assert initiate(env).json()["reference"] == ref
    assert len(calls) == 1
    assert env.client.get("/api/payments/moneyfusion/status/" + ref,
                          headers=headers("other", "user")).status_code == 404
    assert run(env.db.users.find_one({"id": "member"}))["max_level"] == 0
    assert run(_provider_ready(env.db, "moneyfusion", "payin"))[0] is False


def test_spoofed_webhook_never_activates_without_provider_paid(env):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    response = verified_payin(payment, statut="pending")
    calls = provider_http(env.monkeypatch, {mf.PAYIN_STATUS_URL + "/payin-token": response})
    activate = AsyncMock()
    env.monkeypatch.setattr(mf, "activate_level", activate)
    webhook = env.client.post("/api/webhooks/moneyfusion/payin",
                               json={"tokenPay": "payin-token", "statut": "paid"})
    assert webhook.status_code == 200
    assert len(calls) == 1
    assert activate.await_count == 0


@pytest.mark.parametrize("changes", [
    {"Montant": 1}, {"numeroSend": "123456"}, {"personal_Info": []},
    {"tokenPay": "different-token"},
])
def test_payin_binding_rejects_mismatch(env, changes):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    activate = AsyncMock()
    env.monkeypatch.setattr(mf, "activate_level", activate)
    outcome = run(mf._apply_paid_activation(env.db, payment, verified_payin(payment, **changes)))
    assert outcome.get("activation_done") is not True
    assert activate.await_count == 0


def test_duplicate_concurrent_paid_notifications_activate_once(env):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    activate = AsyncMock()
    env.monkeypatch.setattr(mf, "activate_level", activate)

    async def notify():
        return await asyncio.gather(*[
            mf._apply_paid_activation(env.db, payment, verified_payin(payment))
            for _ in range(4)
        ])
    run(notify())
    assert activate.await_count == 1
    assert activate.call_args.kwargs["source"] == "moneyfusion"
    assert run(env.db.payments.find_one({"reference": ref}))["activation_done"] is True


def test_payout_reserves_once_and_only_verification_completes(env):
    configure(env)
    calls = provider_http(env.monkeypatch, {mf.PAYOUT_URL: {"statut": True, "tokenPay": "out-token"}})

    async def dispatch():
        return await asyncio.gather(*[mf.dispatch_withdrawal(env.db, dict(PAYOUT)) for _ in range(3)])
    run(dispatch())
    assert len(calls) == 1
    wd = run(env.db.withdrawals.find_one({"id": "wd-one"}))
    assert wd["status"] == "dispatched"
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 0
    assert run(mf.manual_withdrawal_action_allowed(env.db, "wd-one")) is False
    payout = run(env.db.moneyfusion_payouts.find_one({"wd_id": "wd-one"}))
    data = {"tokenPay": "out-token", "amount": 2650, "phone": "90123456",
            "method": "tmoney-tg", "status": "success"}
    provider_http(env.monkeypatch, {mf.PAYOUT_STATUS_URL + "/out-token": {"success": True, "data": data}})
    for _ in range(2):
        r = env.client.post("/api/webhooks/moneyfusion/payout", json={"tokenPay": "out-token"})
        assert r.json()["verified"] is True
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 3000
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "completed"
    assert mf._payout_details_match(payout, {**data, "amount": 1}) is False


def test_payout_unknown_is_not_retried_or_manually_refundable(env):
    configure(env)
    calls = provider_http(env.monkeypatch, {}, fail=True)
    assert run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))["reason"] == "unknown_result"
    assert run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))["reason"] == "already_submitted"
    assert len(calls) == 1
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "processing"
    assert run(mf.manual_withdrawal_action_allowed(env.db, "wd-one")) is False


def test_failed_payout_refund_is_idempotent_and_success_conflict_is_ignored(env):
    configure(env)
    provider_http(env.monkeypatch, {mf.PAYOUT_URL: {"statut": True, "tokenPay": "out-token"}})
    run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))
    payout = run(env.db.moneyfusion_payouts.find_one({"wd_id": "wd-one"}))
    run(mf._apply_payout_status(env.db, payout, "failed", {}))
    run(mf._apply_payout_status(env.db, payout, "failed", {}))
    user = run(env.db.users.find_one({"id": "member"}))
    assert user["balance_profit"] == 3100
    assert user["total_withdrawn"] == 0
    outcome = run(mf._apply_payout_status(env.db, payout, "success", {}))
    assert outcome["handled"] is False
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 0


def test_provider_logging_does_not_expose_merchant_url():
    record = logging.LogRecord(
        "httpx", logging.INFO, "", 0, "HTTP Request: POST %s",
        ("https://pay.moneyfusion.net/merchant/private-url-secret/pay",), None,
    )
    assert mf._MoneyFusionPrivacyFilter().filter(record)
    assert "private-url-secret" not in record.getMessage()


def test_country_local_phone_and_currency_rounding():
    assert mf._local_phone("+22890123456", "TG") == "90123456"
    assert mf._local_phone("0022890123456", "TG") == "90123456"
    assert mf._local_phone("90123456", "TG") == "90123456"
    assert mf._local_phone("0022700000", "CI") == "22700000"
    assert mf._amount_from_xof({"rates_per_xof": {"GNF": 16.1}}, 2650, "GNF") == 42665


def test_payout_catalog_enforces_operator_and_currency_gates(env):
    configure(env)
    run(toggle_operator(env.db, "moneyfusion", "TG", "moov-tg", False))
    response = env.client.get("/api/payments/moneyfusion/payout-catalog",
                              headers=headers("other", "user"))
    assert response.status_code == 200
    assert [c["country_code"] for c in response.json()["countries"]] == ["TG"]
    assert [op["code"] for op in response.json()["countries"][0]["operators"]] == ["tmoney-tg"]
    assert env.client.get("/api/payments/moneyfusion/payout-catalog").status_code == 401


def test_refused_payout_can_be_manually_processed_but_not_rebound(env):
    configure(env)
    provider_http(env.monkeypatch, {mf.PAYOUT_URL: {"statut": False, "message": "Refusé"}})
    result = run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))
    assert result["reason"] == "gateway_refused"
    assert run(mf.manual_withdrawal_action_allowed(env.db, "wd-one")) is True
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "pending"
    response = env.client.post("/api/admin/payment-gateways/moneyfusion/payouts/wd-one/check",
                               json={"token": "unrelated-token"}, headers=headers())
    assert response.status_code == 409


def test_old_provider_priority_is_retained_when_moneyfusion_config_changes(env):
    configure(env)
    run(env.db.payment_providers.update_one({"id": "moneyfusion"}, {"$set": {"priority": 1}}))
    run(mf.sync_provider(env.db))
    assert run(env.db.payment_providers.find_one({"id": "moneyfusion"}))["priority"] == 1


def test_unknown_payout_reconciles_without_resubmitting(env):
    configure(env)
    provider_http(env.monkeypatch, {}, fail=True)
    run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))
    calls = provider_http(env.monkeypatch, {
        mf.PAYOUT_STATUS_URL + "/recovered-token": {
            "success": True, "data": {"tokenPay": "recovered-token",
                                     "amount": 2650, "phone": "90123456",
                                     "method": "tmoney-tg", "status": "success"},
        },
    })
    response = env.client.post("/api/admin/payment-gateways/moneyfusion/payouts/wd-one/check",
                               json={"token": "recovered-token"}, headers=headers())
    assert response.status_code == 200
    assert response.json() == {"ok": True, "status": "completed"}
    assert len(calls) == 1 and calls[0][0] == "GET"
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 3000


def test_admin_actions_cannot_refund_or_validate_unknown_provider_submission(env):
    from server import admin_validate_withdrawal, admin_reject_withdrawal
    configure(env)
    provider_http(env.monkeypatch, {}, fail=True)
    run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=env.db)))
    for handler in (admin_validate_withdrawal, admin_reject_withdrawal):
        with pytest.raises(HTTPException) as error:
            run(handler("wd-one", request, admin={"id": "admin"}))
        assert error.value.status_code == 409
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 100


def test_legacy_manual_withdrawal_validation_and_rejection_are_preserved(env):
    from server import admin_validate_withdrawal, admin_reject_withdrawal
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=env.db)))
    assert run(admin_validate_withdrawal("wd-one", request, admin={"id": "admin"}))["ok"]
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "validated"
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 3000
    run(env.db.withdrawals.insert_one({**PAYOUT, "id": "wd-two"}))
    assert run(admin_reject_withdrawal("wd-two", request, admin={"id": "admin"}, body={}))["ok"]
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 3100
    with pytest.raises(HTTPException):
        run(admin_reject_withdrawal("wd-two", request, admin={"id": "admin"}, body={}))
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 3100
