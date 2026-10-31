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
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

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
    db = AsyncIOMotorClient(os.environ["MONGO_URL"], io_loop=loop)["spv_btp_test"]
    loop.run_until_complete(db.client.drop_database("spv_btp_test"))
    loop.run_until_complete(db.app_settings.insert_one({"key": "payment_gateway", "value": {
        "biztranspay_enabled": True, "biztranspay_payin_enabled": True, "biztranspay_payout_enabled": True,
        "biztranspay_secret_key": "sk_live_x", "biztranspay_public_key": "pk_live_x",
        "biztranspay_webhook_secret": "whsec"}}))
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
    assert ("TG", "tmoney_tg") not in codes  # already covered by the static list (Mixx/T-Money)
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
