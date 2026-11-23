"""Biz-transPay new-doc integration (catalog, quote, OTP, deposit, payout, webhook) — HTTP faked."""
import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from types import SimpleNamespace

import pytest
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))
from fastapi import HTTPException  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

import biztranspay as b  # noqa: E402
import btp_catalog as bc  # noqa: E402

DEPOSIT_CAT = {"operators": [
    {"code": "tmoney_tg", "name": "Mixx By Yas", "country": "TG", "currency": "XOF",
     "payment_flow": {"kind": "push", "otp_required": False}},
    {"code": "orange-bf", "name": "Orange Money", "country": "BF", "currency": "XOF",
     "payment_flow": {"kind": "ussd", "otp_required": True, "ussd_template": "*144*4*6*{amount}#"}},
    {"code": "orange-ci", "name": "Orange Money CI", "country": "CI", "currency": "XOF",
     "payment_flow": {"kind": "push", "otp_required": True, "otp_request_before_submit": True}},
    {"code": "vodacom-cd", "name": "M-Pesa", "country": "CD", "currency": "CDF",
     "payment_flow": {"kind": "push"}},
]}
PAYOUT_CAT = [
    {"code": "moov-togo", "name": "Moov Money", "country": "TG", "currency": "XOF"},
    {"code": "tmoney_tg", "name": "Mixx By Yas", "country": "TG", "currency": "XOF"},
    {"code": "mtn-ci", "name": "MTN Mobile Money", "country": "CI", "currency": "XOF"},
]
CALLS = []


class R:
    def __init__(self, status, body):
        self.status_code, self._b = status, body
        self.text = json.dumps(body)

    def json(self):
        return self._b


async def fake_get(path, sk, pk):
    CALLS.append(("GET", path, None))
    if path.startswith("/mobile-money/operators?direction=deposit"):
        return R(200, DEPOSIT_CAT)
    if path.startswith("/mobile-money/operators?direction=payout"):
        return R(200, PAYOUT_CAT)
    if path.startswith("/exchanges/quote"):
        return R(200, {"from_currency": "XOF", "to_currency": "CDF", "amount": 2650, "to_amount": 12345.2})
    return R(404, {"detail": "nope"})


async def fake_post(path, body, sk, pk, *, idempotency_key):
    CALLS.append(("POST", path, body, idempotency_key))
    if path == "/deposits/quote":
        flow = next(o["payment_flow"] for o in DEPOSIT_CAT["operators"] if o["code"] == body["operator"])
        u = flow.get("ussd_template", "").replace("{amount}", str(body["amount"]))
        return R(200, {"amount": body["amount"], "charged_amount": body["amount"], "fee_bearer": body["fee_bearer"],
                       "code_to_enter": u, "payment_flow": flow})
    if path == "/deposits" and body.get("request_otp"):
        return R(200, {"otp_sent": True, "message": "Le code a été demandé."})
    if path == "/deposits":
        return R(200, {"id": "dep-" + uuid.uuid4().hex[:6], "status": "pending",
                       "deposit": {"status": "pending", "charged_amount": body["amount"]}})
    if path == "/payouts":
        return R(200, {"id": "po-1", "status": "pending", "payout": {"id": "po-1", "status": "pending"}})
    return R(400, {"detail": "bad"})


@pytest.fixture()
def env(monkeypatch):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    db = AsyncMongoMockClient(tz_aware=True)["spv_btp_test"]
    loop.run_until_complete(db.client.drop_database("spv_btp_test"))
    loop.run_until_complete(db.app_settings.insert_one({"key": "payment_gateway", "value": {
        "biztranspay_enabled": True, "biztranspay_payin_enabled": True, "biztranspay_payout_enabled": True,
        "biztranspay_secret_key": "sk_live_x", "biztranspay_public_key": "pk_live_x",
        "biztranspay_webhook_secret": "whsec"}}))
    # Existing catalog rows represent the preserved Pay-in setup; the first
    # separated Pay-out catalog inherits these enabled physical operators.
    loop.run_until_complete(db.payment_provider_countries.insert_one({
        "provider_id": "biztranspay", "country_code": "TG", "currency": "XOF",
        "status": "active", "mode": "automatic",
    }))
    loop.run_until_complete(db.payment_provider_operators.insert_one({
        "provider_id": "biztranspay", "country_code": "TG", "operator_code": "tmoney_tg",
        "operator_label": "Mixx By Yas", "status": "active",
    }))
    loop.run_until_complete(db.payment_provider_payout_countries.insert_one({
        "provider_id": "biztranspay", "country_code": "TG", "currency": "XOF",
        "status": "active", "mode": "automatic",
    }))
    loop.run_until_complete(db.payment_provider_payout_operators.insert_one({
        "provider_id": "biztranspay", "country_code": "TG", "operator_code": "tmoney_tg",
        "operator_label": "Mixx By Yas", "status": "active",
    }))
    monkeypatch.setattr(b, "_get", fake_get)
    monkeypatch.setattr(b, "_post", fake_post)
    bc._CATALOG.clear(); bc._RATES.clear(); CALLS.clear()
    yield db, loop
    loop.run_until_complete(db.client.drop_database("spv_btp_test"))
    loop.close()


def _req(db):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))


USER = {"id": "u1", "username": "alice", "email": "a@x.com", "max_level": 0}


def test_catalog_and_prices(env):
    db, loop = env
    items = loop.run_until_complete(bc.fetch_catalog(db, "deposit"))
    assert {i["country"] for i in items} == {"TG", "BF", "CI", "CD"}
    assert loop.run_until_complete(bc.activation_amount_for(db, "XOF")) == 2650
    assert loop.run_until_complete(bc.activation_amount_for(db, "CDF")) == 12346


def test_push_deposit_receiver_fees(env):
    db, loop = env
    r = loop.run_until_complete(b.biztranspay_activation(
        b.BtpActivationIn(country_code="TG", operator="tmoney_tg", phone="90 00 00 00"), _req(db), USER))
    dep = [c for c in CALLS if c[1] == "/deposits"][0]
    assert dep[2]["fee_bearer"] == "receiver" and dep[2]["amount"] == 2650
    assert dep[2]["phone_number"] == "+22890000000" and dep[2]["full_name"] and dep[2]["email"]
    assert dep[3] == r["reference"]
    p = loop.run_until_complete(db.payments.find_one({"reference": r["reference"]}))
    assert p["provider_intent_id"].startswith("dep-") and p["status"] == "pending"


def test_ussd_otp_required_then_submit(env):
    db, loop = env
    with pytest.raises(HTTPException) as ei:
        loop.run_until_complete(b.biztranspay_activation(
            b.BtpActivationIn(country_code="BF", operator="orange-bf", phone="70000000"), _req(db), USER))
    assert ei.value.detail["code"] == "OTP_REQUIRED" and ei.value.detail["ussd"] == "*144*4*6*2650#"
    assert loop.run_until_complete(db.payments.count_documents({})) == 0
    loop.run_until_complete(b.biztranspay_activation(
        b.BtpActivationIn(country_code="BF", operator="orange-bf", phone="70000000", otp="123456"), _req(db), USER))
    dep = [c for c in CALLS if c[1] == "/deposits"][-1]
    assert dep[2]["otp"] == "123456" and dep[2]["phone_number"] == "+22670000000"


def test_otp_request_before_submit(env):
    db, loop = env
    with pytest.raises(HTTPException) as ei:
        loop.run_until_complete(b.biztranspay_activation(
            b.BtpActivationIn(country_code="CI", operator="orange-ci", phone="0700000000"), _req(db), USER))
    assert ei.value.detail["code"] == "OTP_SENT"
    assert [c for c in CALLS if c[1] == "/deposits"][0][2]["request_otp"] is True


def test_cdf_price_equivalent(env):
    db, loop = env
    r = loop.run_until_complete(b.biztranspay_activation(
        b.BtpActivationIn(country_code="CD", operator="vodacom-cd", phone="810000000"), _req(db), USER))
    assert r["currency"] == "CDF" and r["amount"] == 12346


def test_unknown_operator_rejected(env):
    db, loop = env
    with pytest.raises(HTTPException):
        loop.run_until_complete(b.biztranspay_activation(
            b.BtpActivationIn(country_code="TG", operator="fake", phone="90000000"), _req(db), USER))


def _wd(country, op):
    return {"id": "wd-" + uuid.uuid4().hex[:6], "user_id": "u1", "country": country, "operator": op,
            "phone": "90000000", "amount": 1000, "net_payout": 950, "status": "pending"}


def test_payout_tg_moov_uses_catalog_code(env):
    db, loop = env
    loop.run_until_complete(db.payment_provider_operators.insert_one(
        {"provider_id": "biztranspay", "country_code": "TG", "operator_code": "moov_tg", "status": "active"}))
    loop.run_until_complete(db.payment_provider_payout_operators.insert_one({
        "provider_id": "biztranspay", "country_code": "TG", "operator_code": "moov-togo",
        "operator_label": "Moov Money", "status": "active",
    }))
    wd = _wd("TG", "Moov Money (Flooz)")
    loop.run_until_complete(db.withdrawals.insert_one(dict(wd)))
    r = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    po = [c for c in CALLS if c[1] == "/payouts"][0]
    assert r["auto_dispatched"] and po[2]["operator"] == "moov-togo" and po[2]["recipient"] == "+22890000000"
    assert po[3] == f"wd-{wd['id']}" and len([c for c in CALLS if c[1] == "/payouts"]) == 1


def test_payout_benin_not_supported(env):
    db, loop = env
    r = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, _wd("BJ", "MTN")))
    assert r["reason"] == "country_not_supported"


def _signed(body: dict, secret="whsec"):
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    sig = "sha256=" + hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return raw, {"X-BizTransPay-Signature": sig, "X-BizTransPay-Timestamp": ts,
                 "X-BizTransPay-Event-Id": body["id"], "X-BizTransPay-Event-Type": body["type"]}


class FakeReq:
    def __init__(self, db, raw, headers):
        self.app = SimpleNamespace(state=SimpleNamespace(db=db))
        self._raw, self.headers = raw, headers

    async def body(self):
        return self._raw


def test_webhook_payout_completed_and_dedup(env):
    db, loop = env
    loop.run_until_complete(db.withdrawals.insert_one(
        {"id": "wdX", "user_id": "u1", "status": "pending", "payout_id": "po-9", "amount": 1000}))
    body = {"id": "evt_1", "type": "payout.status_changed",
            "data": {"id": "po-9", "object": "payout", "previous_status": "pending", "status": "completed"}}
    raw, h = _signed(body)
    r = loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, raw, h)))
    assert r["reconciled"] == "withdrawal"
    assert loop.run_until_complete(db.withdrawals.find_one({"id": "wdX"}))["status"] == "completed"
    r2 = loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, raw, h)))
    assert r2.get("duplicate")


def test_webhook_bad_signature(env):
    db, loop = env
    body = {"id": "evt_2", "type": "deposit.status_changed", "data": {"id": "d", "status": "completed"}}
    raw, h = _signed(body, secret="wrong")
    with pytest.raises(HTTPException) as ei:
        loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, raw, h)))
    assert ei.value.status_code == 401


def test_webhook_deposit_failed_by_intent_id(env):
    db, loop = env
    loop.run_until_complete(db.payments.insert_one(
        {"reference": "SPV-1", "provider": "biztranspay", "provider_intent_id": "dep-77",
         "status": "pending", "activation_done": False, "user_id": "u1"}))
    body = {"id": "evt_3", "type": "deposit.status_changed", "data": {"id": "dep-77", "status": "failed"}}
    raw, h = _signed(body)
    loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, raw, h)))
    assert loop.run_until_complete(db.payments.find_one({"reference": "SPV-1"}))["status"] == "failed"


def test_crypto_asset_from_catalog_and_admin_refund(env, monkeypatch):
    db, loop = env

    async def get2(path, sk, pk):
        CALLS.append(("GET", path, None))
        if path.startswith("/crypto/assets"):
            return R(200, {"assets": [{"code": "BTC", "network": "BTC"},
                                      {"code": "usdt-bsc", "symbol": "USDT", "network": "BEP20"}]})
        return await fake_get(path, sk, pk)

    async def post2(path, body, sk, pk, *, idempotency_key):
        CALLS.append(("POST", path, body, idempotency_key))
        return R(200, {"id": "cd-1", "status": "pending",
                       "deposit": {"id": "cd-1", "instructions": {"address": "0xabc", "amount": 5.01}}})
    monkeypatch.setattr(b, "_get", get2)
    monkeypatch.setattr(b, "_post", post2)
    with pytest.raises(HTTPException) as ei:
        loop.run_until_complete(b.biztranspay_crypto_create(b.BtpCryptoCreate(level=1), _req(db), USER))
    assert ei.value.status_code == 503
    assert loop.run_until_complete(b.is_crypto_enabled(db)) is False
    loop.run_until_complete(db.app_settings.update_one(
        {"key": "payment_gateway"}, {"$set": {"value.biztranspay_crypto_refund_address": "0x" + "1" * 40}}))
    assert loop.run_until_complete(b.is_crypto_enabled(db)) is True
    r = loop.run_until_complete(b.biztranspay_crypto_create(b.BtpCryptoCreate(level=1), _req(db), USER))
    body = [c for c in CALLS if c[1] == "/crypto/deposits"][0][2]
    assert body["asset_code"] == "usdt-bsc" and body["refund_address"] == "0x" + "1" * 40
    assert r["deposit_address"] == "0xabc" and float(r["amount"]) == 5.01


def test_catalog_countries_synced_to_admin_rows(env):
    db, loop = env
    from payment_providers import sync_btp_catalog_rows
    items = loop.run_until_complete(bc.fetch_catalog(db, "deposit", force=True))
    rows = loop.run_until_complete(db.payment_provider_operators.find(
        {"provider_id": "biztranspay"}, {"_id": 0}).to_list(50))
    codes = {(r["country_code"], r["operator_code"]) for r in rows}
    assert ("CD", "vodacom-cd") in codes
    assert ("TG", "tmoney_tg") in codes  # exact official codes must all be configurable
    assert loop.run_until_complete(db.payment_provider_countries.find_one(
        {"provider_id": "biztranspay", "country_code": "CD"}))["status"] == "active"
    loop.run_until_complete(db.payment_provider_operators.update_one(
        {"country_code": "CD", "operator_code": "vodacom-cd"}, {"$set": {"status": "inactive"}}))
    loop.run_until_complete(sync_btp_catalog_rows(db, items))
    assert loop.run_until_complete(db.payment_provider_operators.find_one(
        {"country_code": "CD", "operator_code": "vodacom-cd"}))["status"] == "inactive"
    with pytest.raises(HTTPException):
        loop.run_until_complete(b.biztranspay_activation(
            b.BtpActivationIn(country_code="CD", operator="vodacom-cd", phone="810000000"), _req(db), USER))


def test_static_default_inactive_respected(env):
    cfg = {"biztranspay_countries": {"BJ": {"tmoney_bj": False}}}
    assert b._toggle_on(cfg, "BJ", {"code": "mtn-benin", "label": "MTN Mobile Money"}) is False
    assert b._toggle_on(cfg, "BJ", {"code": "moov-benin", "label": "Moov Money"}) is True


def test_admin_catalog_directions_and_preserved_toggles(env):
    db, loop = env
    from payment_router import toggle_country
    result = loop.run_until_complete(b.admin_btp_catalog(_req(db), "deposit", USER))
    assert result["count"] == 4
    assert all("enabled" in item and "country_enabled" in item for item in result["items"])
    loop.run_until_complete(toggle_country(db, "biztranspay", "CD", False))
    result = loop.run_until_complete(b.admin_btp_catalog(_req(db), "deposit", USER))
    assert next(item for item in result["items"] if item["country"] == "CD")["enabled"] is False
    payout = loop.run_until_complete(b.admin_btp_catalog(_req(db), "payout", USER))
    assert {item["code"] for item in payout["items"]} == {item["code"] for item in PAYOUT_CAT}
    assert not any(call[0] == "POST" for call in CALLS)


def test_admin_refresh_failure_is_explicit(env, monkeypatch):
    db, loop = env
    loop.run_until_complete(bc.fetch_catalog(db, "deposit"))
    async def unavailable(*args):
        return R(401, {"detail": "Unauthorized"})
    monkeypatch.setattr(b, "_get", unavailable)
    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(b.admin_btp_catalog(_req(db), "deposit", USER))
    assert exc.value.status_code == 503


def test_deposit_retry_never_creates_second_operation(env):
    db, loop = env
    data = b.BtpActivationIn(country_code="TG", operator="tmoney_tg", phone="90000000")
    first = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    second = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    assert first["reference"] == second["reference"]
    assert len([call for call in CALLS if call[1] == "/deposits"]) == 1


def test_ambiguous_deposit_is_not_replaced(env, monkeypatch):
    db, loop = env
    async def ambiguous(path, body, sk, pk, *, idempotency_key):
        if path == "/deposits":
            CALLS.append(("POST", path, body, idempotency_key))
            raise TimeoutError("uncertain")
        return await fake_post(path, body, sk, pk, idempotency_key=idempotency_key)
    monkeypatch.setattr(b, "_post", ambiguous)
    data = b.BtpActivationIn(country_code="TG", operator="tmoney_tg", phone="90000000")
    with pytest.raises(HTTPException):
        loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    result = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    assert result["status"] == "pending"
    assert loop.run_until_complete(db.payments.find_one({}))["status"] == "unknown"
    assert len([call for call in CALLS if call[1] == "/deposits"]) == 1


def test_ussd_authorization_required_before_financial_request(env, monkeypatch):
    db, loop = env
    async def ussd_quote(path, body, sk, pk, *, idempotency_key):
        if path == "/deposits/quote":
            return R(200, {"charged_amount": 2650, "payment_flow": {
                "kind": "ussd", "before_submit": True, "ussd_template": "*123*{amount}#"}})
        return await fake_post(path, body, sk, pk, idempotency_key=idempotency_key)
    monkeypatch.setattr(b, "_post", ussd_quote)
    data = dict(country_code="TG", operator="tmoney_tg", phone="90000000")
    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(b.biztranspay_activation(b.BtpActivationIn(**data), _req(db), USER))
    assert exc.value.detail["code"] == "USSD_AUTHORIZATION_REQUIRED"
    assert not any(call[1] == "/deposits" for call in CALLS)
    loop.run_until_complete(b.biztranspay_activation(b.BtpActivationIn(**data, ussd_authorized=True), _req(db), USER))
    assert next(call for call in CALLS if call[1] == "/deposits")[2]["ussd_authorized"] is True


def test_quote_failure_prevents_deposit(env, monkeypatch):
    db, loop = env
    async def failed_quote(*args, **kwargs):
        return R(503, {"detail": "unavailable"})
    monkeypatch.setattr(b, "_post", failed_quote)
    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(b.biztranspay_activation(
            b.BtpActivationIn(country_code="TG", operator="tmoney_tg", phone="90000000"), _req(db), USER))
    assert exc.value.status_code == 503
    assert loop.run_until_complete(db.payments.count_documents({})) == 0


def test_webhook_without_signature_secret_is_rejected(env, monkeypatch):
    db, loop = env
    loop.run_until_complete(db.app_settings.update_one({"key": "payment_gateway"},
        {"$set": {"value.biztranspay_webhook_secret": ""}}))
    monkeypatch.delenv("BIZTRANSPAY_WEBHOOK_SECRET", raising=False)
    raw, headers = _signed({"id": "evt-no-secret", "type": "deposit.status_changed"})
    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, raw, headers)))
    assert exc.value.status_code == 503


def test_payout_repeat_is_reserved_once(env):
    db, loop = env
    wd = _wd("TG", "tmoney_tg")
    loop.run_until_complete(db.withdrawals.insert_one(dict(wd)))
    first = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    second = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    assert first["auto_dispatched"]
    assert second["reason"] == "already_submitted"
    assert len([call for call in CALLS if call[1] == "/payouts"]) == 1


def test_ambiguous_payout_blocks_resubmit_and_manual_refund(env, monkeypatch):
    db, loop = env
    async def uncertain(path, body, sk, pk, *, idempotency_key):
        if path == "/payouts":
            CALLS.append(("POST", path, body, idempotency_key))
            raise TimeoutError("uncertain")
        return await fake_post(path, body, sk, pk, idempotency_key=idempotency_key)
    monkeypatch.setattr(b, "_post", uncertain)
    wd = _wd("TG", "tmoney_tg")
    loop.run_until_complete(db.withdrawals.insert_one(dict(wd)))
    first = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    second = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    assert first["reason"] == "network_error"
    assert second["reason"] == "already_submitted"
    assert len([call for call in CALLS if call[1] == "/payouts"]) == 1
    import server
    for action in (server.admin_validate_withdrawal, server.admin_reject_withdrawal):
        with pytest.raises(HTTPException) as exc:
            loop.run_until_complete(action(wd["id"], _req(db), {"id": "admin"}))
        assert exc.value.status_code == 409


def test_wave_redirect_and_duplicate_return_same_url(env, monkeypatch):
    db, loop = env
    async def redirected(path, body, sk, pk, *, idempotency_key):
        if path == "/deposits":
            CALLS.append(("POST", path, body, idempotency_key))
            return R(200, {"id": "wave-1", "status": "pending",
                           "deposit": {"redirect_url": "https://example.invalid/wave"}})
        return await fake_post(path, body, sk, pk, idempotency_key=idempotency_key)
    monkeypatch.setattr(b, "_post", redirected)
    data = b.BtpActivationIn(country_code="TG", operator="tmoney_tg", phone="90000000")
    first = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    second = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    assert first["redirect_url"] == second["redirect_url"] == "https://example.invalid/wave"
    assert len([call for call in CALLS if call[1] == "/deposits"]) == 1


def test_failed_webhook_different_event_ids_refunds_only_once(env):
    db, loop = env
    loop.run_until_complete(db.users.insert_one({"id": "u1", "balance_profit": 0}))
    loop.run_until_complete(db.withdrawals.insert_one({
        "id": "wd-fail", "user_id": "u1", "status": "pending", "payout_id": "po-fail", "amount": 1000}))
    async def notify(event_id):
        raw, headers = _signed({"id": event_id, "type": "payout.status_changed",
            "data": {"id": "po-fail", "status": "failed"}})
        return await b.biztranspay_webhook(FakeReq(db, raw, headers))
    async def concurrent():
        return await asyncio.gather(notify("fail-1"), notify("fail-2"))
    loop.run_until_complete(concurrent())
    assert loop.run_until_complete(db.users.find_one({"id": "u1"}))["balance_profit"] == 1000
