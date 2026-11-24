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
            await toggle_country(
                db, "moneyfusion", country["country_code"], True, kind="payout",
            )
            for operator in country["operators"]:
                await toggle_operator(
                    db, "moneyfusion", country["country_code"], operator["code"],
                    True, kind="payout",
                )
        await db.withdrawals.insert_one(dict(PAYOUT))
        now = mf._now()
        rate_date = now.date().isoformat()
        await db.app_settings.insert_one({
            "key": mf.FX_CACHE_KEY,
            "value": {
                "rates_per_xof": {"XOF": 1.0, "XAF": 1.0, "USD": 0.0016},
                "rate_dates": {"XOF": "parité fixe", "XAF": "parité fixe", "USD": rate_date},
                "fetched_at_by_currency": {"USD": now},
                "fetched_at": now,
                "rate_date": rate_date,
                "source": mf.FX_SOURCE,
            },
        })
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


def test_catalog_controls_payin_countries_and_master_switch_sets_contract_confirmation(env):
    response = env.client.put(
        "/api/admin/payment-gateways/moneyfusion",
        json={"payin_enabled": True,
              "payin_api_url": "https://pay.moneyfusion.net/merchant/unit-test/pay"},
        headers=headers(),
    )
    assert response.status_code == 200, response.text
    config = run(mf.load_config(env.db))
    assert config["payin_local_currency_confirmed"] is True
    assert config["mobile_money_only_confirmed"] is True
    assert config["payin_country_codes"] == ["CD", "TG"]


def test_payout_activation_needs_only_key_and_switch(env):
    response = env.client.put(
        "/api/admin/payment-gateways/moneyfusion",
        json={"payout_enabled": True, "payout_private_key": "unit-payout-key"},
        headers=headers(),
    )
    assert response.status_code == 200, response.text
    assert run(_provider_ready(env.db, "moneyfusion", "payout")) == (True, None)


def test_manual_rates_are_ignored(env):
    response = env.client.put("/api/admin/payment-gateways/moneyfusion",
                              json={"rates_per_xof": {"USD": -1, "XOF": 12}},
                              headers=headers())
    assert response.status_code == 200, response.text
    assert response.json()["rates_per_xof"]["USD"] == 0.0016


def test_automatic_fx_uses_reference_provider_and_caches_rates(env):
    run(env.db.app_settings.delete_one({"key": mf.FX_CACHE_KEY}))
    calls = []

    class FxResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return [
                {"date": mf._now().date().isoformat(), "base": "XOF", "quote": "GHS", "rate": 0.01975},
                {"date": mf._now().date().isoformat(), "base": "XOF", "quote": "GNF", "rate": 14.9547},
            ]

    class FxClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            calls.append((url, kwargs))
            return FxResponse()

    env.monkeypatch.setattr(mf.fx_httpx, "AsyncClient", FxClient)
    rates = run(mf.automatic_fx_rates(env.db, ["GHS", "GNF"]))
    assert rates["rates_per_xof"]["XOF"] == 1
    assert rates["rates_per_xof"]["GHS"] == 0.01975
    assert rates["rates_per_xof"]["GNF"] == 14.9547
    assert mf._amount_from_xof(rates, 2650, "GHS") == 52.34
    assert mf._amount_from_xof(rates, 2650, "GNF") == 39630
    assert len(calls) == 1
    run(mf.automatic_fx_rates(env.db, ["GHS", "GNF"]))
    assert len(calls) == 1


def test_fx_outage_without_recent_reference_blocks_checkout(env):
    configure(env)
    run(env.db.app_settings.delete_one({"key": mf.FX_CACHE_KEY}))

    class FxClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            raise TimeoutError("simulated FX outage")

    env.monkeypatch.setattr(mf.fx_httpx, "AsyncClient", FxClient)
    response = initiate(env, country_code="CD")
    assert response.status_code == 503
    assert "Aucun paiement n’a été lancé" in response.json()["detail"]
    assert run(env.db.payments.count_documents({})) == 0
    assert env.http == []


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
    calls = checkout_http(env)
    response = initiate(env, country_code="CD")
    assert response.status_code == 200, response.text
    assert calls[0][2]["json"]["totalPrice"] == 4.24
    assert mf._amount_from_xof({"rates_per_xof": {"USD": 0.0016}}, 2650, "USD") == 4.24


def test_payin_allowlist_tracks_all_methods_in_each_country(env):
    assert run(toggle_operator(env.db, "moneyfusion", "TG", "moov-tg", False))
    assert run(mf.load_config(env.db))["payin_country_codes"] == ["CD"]
    assert run(toggle_operator(env.db, "moneyfusion", "TG", "moov-tg", True))
    assert run(mf.load_config(env.db))["payin_country_codes"] == ["CD", "TG"]


def test_enabled_moneyfusion_catalog_is_returned_on_activation_page(env):
    configure(env)
    from server import activation_catalog

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=env.db)))
    catalog = run(activation_catalog(request))
    togo = next(country for country in catalog["countries"] if country["code"] == "TG")
    assert {operator["gateway"] for operator in togo["operators"]} == {"moneyfusion"}


def test_checkout_contract_duplicates_ownership_and_no_client_activation(env):
    configure(env)
    calls = checkout_http(env)
    response = initiate(env)
    assert response.status_code == 200, response.text
    ref = response.json()["reference"]
    assert response.json()["amount"] == 2650
    payload = calls[0][2]["json"]
    assert payload["totalPrice"] == 2650
    assert payload["return_url"] == f"https://example.invalid/pay?moneyfusion_reference={ref}"
    assert payload["webhook_url"].endswith("/moneyfusion/payin")
    assert "currency" not in payload
    assert initiate(env).json()["reference"] == ref
    assert len(calls) == 1
    assert env.client.get("/api/payments/moneyfusion/status/" + ref,
                          headers=headers("other", "user")).status_code == 404
    assert run(env.db.users.find_one({"id": "member"}))["max_level"] == 0
    assert run(_provider_ready(env.db, "moneyfusion", "payin"))[0] is True


def test_non_activation_moneyfusion_purchase_keeps_purchase_return_route(env):
    configure(env)
    calls = checkout_http(env)
    response = initiate(env, kind="ads", amount_xof=5000, target_id="ad-test")
    assert response.status_code == 200, response.text
    ref = response.json()["reference"]
    assert calls[0][2]["json"]["return_url"] == (
        f"https://example.invalid/purchase-payment?reference={ref}"
    )


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


@pytest.mark.parametrize("amount,fees", [(2650, 0), (2650, 80), (2570, 80), ("2570.50", "79.50")])
def test_paid_total_includes_provider_fees_and_recovers_review(env, amount, fees):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    run(env.db.payments.update_one(
        {"reference": ref},
        {"$set": {"status": "review", "verification_error": "amount_mismatch"}},
    ))
    payment = run(env.db.payments.find_one({"reference": ref}))
    provider_http(env.monkeypatch, {
        mf.PAYIN_STATUS_URL + "/payin-token": verified_payin(payment, Montant=amount, frais=fees),
    })

    async def activate(db, user_id, level, **kwargs):
        await db.users.update_one({"id": user_id}, {"$set": {"max_level": level, "status": "active"}})

    activation = AsyncMock(side_effect=activate)
    env.monkeypatch.setattr(mf, "activate_level", activation)
    for _ in range(2):
        response = env.client.get(
            f"/api/payments/moneyfusion/status/{ref}",
            headers=headers("member", "user", "onboarding"),
        )
        assert response.json()["activation_done"] is True
    assert activation.await_count == 1
    assert run(env.db.users.find_one({"id": "member"}))["status"] == "active"
    stored = run(env.db.payments.find_one({"reference": ref}))
    assert "verification_error" not in stored
    assert stored["amount"] == 2650
    assert stored["provider_reported_fees"] == float(fees)


@pytest.mark.parametrize("amount,fees", [
    (2500, 80), (2700, 80), (1, 0), (2570, -80),
    ("NaN", 80), (2570, "Infinity"), (0, 2650),
])
def test_fees_do_not_allow_unverified_or_insufficient_amounts(env, amount, fees):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    activation = AsyncMock()
    env.monkeypatch.setattr(mf, "activate_level", activation)
    result = run(mf._apply_paid_activation(
        env.db, payment, verified_payin(payment, Montant=amount, frais=fees),
    ))
    assert result.get("activation_done") is not True
    activation.assert_not_awaited()


def test_net_paid_webhook_activates_only_after_server_verification(env):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    provider_http(env.monkeypatch, {
        mf.PAYIN_STATUS_URL + "/payin-token": verified_payin(payment, Montant=2570, frais=80),
    })
    activation = AsyncMock()
    env.monkeypatch.setattr(mf, "activate_level", activation)
    for _ in range(2):
        response = env.client.post(
            "/api/webhooks/moneyfusion/payin",
            json={"tokenPay": "payin-token", "Montant": 1, "frais": 0},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "paid"
    activation.assert_awaited_once()
    assert run(env.db.payments.find_one({"reference": ref}))["activation_done"] is True


def test_unpaid_checkout_is_not_failed_or_released_for_duplicate_payment(env):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    provider_http(env.monkeypatch, {
        mf.PAYIN_STATUS_URL + "/payin-token": verified_payin(payment, statut="no paid"),
    })
    response = env.client.get(
        f"/api/payments/moneyfusion/status/{ref}",
        headers=headers("member", "user", "onboarding"),
    )
    assert response.json()["status"] == "pending"
    stored = run(env.db.payments.find_one({"reference": ref}))
    assert stored["moneyfusion_active_key"]
    assert stored["activation_done"] is False


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


def test_paid_activation_error_is_visible_and_retried_by_status_poll(env):
    configure(env)
    checkout_http(env)
    ref = initiate(env).json()["reference"]
    payment = run(env.db.payments.find_one({"reference": ref}))
    provider_http(env.monkeypatch, {
        mf.PAYIN_STATUS_URL + "/payin-token": verified_payin(payment),
    })
    attempts = 0

    async def activate_after_transient_failure(db, user_id, level, *, source):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary activation failure")
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"max_level": level, "status": "active"}},
        )

    env.monkeypatch.setattr(mf, "activate_level", activate_after_transient_failure)
    path = f"/api/payments/moneyfusion/status/{ref}"
    auth = headers("member", "user", "onboarding")

    first = env.client.get(path, headers=auth)
    assert first.status_code == 200
    assert first.json()["status"] == "paid"
    assert first.json()["activation_done"] is False
    assert first.json()["kind"] == "activation"
    assert "Ne payez pas une seconde fois" in first.json()["message"]

    second = env.client.get(path, headers=auth)
    assert second.status_code == 200
    assert second.json()["activation_done"] is True
    assert second.json()["kind"] == "activation"
    assert attempts == 2
    user = run(env.db.users.find_one({"id": "member"}))
    assert user["max_level"] == 1


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
    countries = response.json()["countries"]
    assert [c["country_code"] for c in countries] == ["TG", "CD"]
    assert [op["code"] for op in countries[0]["operators"]] == ["tmoney-tg"]
    assert [op["code"] for op in countries[1]["operators"]] == ["airtel-cd"]
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


def test_moneyfusion_preflight_failure_is_marked_not_submitted(env):
    result = run(mf._record_dispatch_failure(
        env.db, "wd-one", "operator_disabled_or_unmapped",
        "Opérateur désactivé dans le catalogue de retraits.",
    ))
    withdrawal = run(env.db.withdrawals.find_one({"id": "wd-one"}))
    assert result["not_submitted"] is True
    assert withdrawal["gateway_status"] == "not_submitted"


def test_moneyfusion_duplicate_submission_is_not_marked_safe_to_refund(env):
    result = run(mf._record_dispatch_failure(
        env.db, "wd-one", "submission_reserved",
        "Une tentative existe déjà.",
    ))
    withdrawal = run(env.db.withdrawals.find_one({"id": "wd-one"}))
    assert result["not_submitted"] is False
    assert withdrawal["gateway_status"] == "unknown"


def test_definitive_moneyfusion_http_refusal_is_rejected_without_retry(env, monkeypatch):
    import httpx
    import payment_exclusivity
    import server

    monkeypatch.setattr(mf, "load_config", AsyncMock(return_value={"payout_enabled": True}))
    monkeypatch.setattr(mf, "load_credentials", AsyncMock(return_value={
        "payout_private_key": "test-only-key",
    }))
    monkeypatch.setattr(mf, "_active_catalog_country", AsyncMock(return_value={"country_code": "TG"}))
    monkeypatch.setattr(mf, "refresh_catalog", AsyncMock(return_value=[{
        "country_code": "TG", "currency": "XOF",
    }]))
    monkeypatch.setattr(mf, "_active_operator_for_label", AsyncMock(return_value={
        "operator_code": "tmoney-tg", "operator_label": "T-Money",
    }))
    monkeypatch.setattr(mf, "automatic_fx_rates", AsyncMock(return_value={
        "rates_per_xof": {"XOF": 1}, "rate_dates": {"XOF": "parité fixe"},
        "source": "test",
    }))
    monkeypatch.setattr(payment_exclusivity, "assert_assignment", AsyncMock())

    class RefusalClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            response = httpx.Response(
                400,
                json={"code": 1001, "message": "Opérateur indisponible"},
                request=httpx.Request("POST", url),
            )
            response.raise_for_status()

    monkeypatch.setattr(mf.httpx, "AsyncClient", RefusalClient)
    result = run(mf.dispatch_withdrawal(env.db, dict(PAYOUT)))
    assert result["not_submitted"] is True
    assert result["reason"] == "gateway_refused"
    withdrawal = run(env.db.withdrawals.find_one({"id": "wd-one"}))
    assert withdrawal["gateway_status"] == "refused"
    assert withdrawal["gateway_error_code"] == "1001"

    assert run(server._reject_unsubmitted_withdrawal(
        env.db, withdrawal, withdrawal["auto_dispatch_reason"],
    )) is True
    settled = run(env.db.withdrawals.find_one({"id": "wd-one"}))
    assert settled["status"] == "rejected"
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 3100


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


def test_admin_validation_is_local_and_never_resubmits_unknown_provider_payout(env):
    from server import admin_validate_withdrawal
    run(env.db.users.insert_one({
        "id": "member", "balance_profit": 100, "total_withdrawn": 0,
    }))
    run(env.db.withdrawals.update_one(
        {"id": "wd-one"},
        {"$set": {
            "status": "processing", "gateway": "moneyfusion",
            "gateway_status": "unknown", "payout_id": "already-submitted",
            "admin_provider_verified_at": datetime.now(),
            "admin_provider_verified_by": "admin",
        }},
    ))
    run(env.db.moneyfusion_payouts.insert_one({
        "wd_id": "wd-one", "user_id": "member", "status": "unknown",
        "tokenPay": "already-submitted",
    }))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=env.db)))
    result = run(admin_validate_withdrawal("wd-one", request, admin={"id": "admin"}))
    assert result == {"ok": True, "status": "validated", "provider_request_sent": False}
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "validated"
    assert env.http == []
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 100
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 3000
    assert run(admin_validate_withdrawal("wd-one", request, admin={"id": "admin"}))["already_validated"]
    assert run(env.db.users.find_one({"id": "member"}))["total_withdrawn"] == 3000
    late_failure = run(mf._apply_payout_status(
        env.db, {"wd_id": "wd-one"}, "failed", {"status": "failed"},
    ))
    assert late_failure["reason"] == "conflicting_terminal_status"
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "validated"
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 100


def test_admin_must_verify_uncertain_provider_payout_before_manual_action(env, monkeypatch):
    from server import admin_verify_withdrawal, admin_validate_withdrawal
    run(env.db.withdrawals.update_one(
        {"id": "wd-one"},
        {"$set": {
            "status": "processing", "gateway": "moneyfusion",
            "gateway_status": "unknown", "payout_id": "already-submitted",
        }},
    ))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=env.db)))
    monkeypatch.setattr(
        mf, "reconcile_withdrawal",
        AsyncMock(return_value={"ok": False, "reason": "token_required"}),
    )

    blocked = None
    try:
        run(admin_validate_withdrawal("wd-one", request, admin={"id": "admin"}))
    except HTTPException as exc:
        blocked = exc
    assert blocked is not None and blocked.status_code == 409
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "processing"

    first_check = run(admin_verify_withdrawal(
        "wd-one", request, body={}, admin={"id": "admin"},
    ))
    assert first_check["requires_manual_confirmation"] is True
    confirmed = run(admin_verify_withdrawal(
        "wd-one", request, body={"manual_confirmation": True}, admin={"id": "admin"},
    ))
    assert confirmed["manual_confirmation_recorded"] is True
    assert run(admin_validate_withdrawal("wd-one", request, admin={"id": "admin"}))["ok"]
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "validated"
    assert run(env.db.admin_logs.count_documents({
        "action": "withdrawal_provider_manually_verified", "target": "wd-one",
    })) == 1


def test_verified_moneyfusion_withdrawal_can_be_rejected_locally_once(env):
    from server import admin_reject_withdrawal
    now = datetime.now()
    run(env.db.withdrawals.update_one(
        {"id": "wd-one"},
        {"$set": {
            "status": "processing", "gateway": "moneyfusion",
            "gateway_status": "unknown", "auto_dispatched": True,
            "payout_id": "provider-ref", "admin_provider_verified_at": now,
            "admin_provider_verified_by": "admin",
        }},
    ))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=env.db)))

    result = run(admin_reject_withdrawal(
        "wd-one", request, admin={"id": "admin"}, body={"reason": "Vérifié auprès du prestataire"},
    ))
    assert result["ok"] is True
    assert run(env.db.withdrawals.find_one({"id": "wd-one"}))["status"] == "rejected"
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 3100
    with pytest.raises(HTTPException):
        run(admin_reject_withdrawal("wd-one", request, admin={"id": "admin"}, body={}))
    assert run(env.db.users.find_one({"id": "member"}))["balance_profit"] == 3100


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
