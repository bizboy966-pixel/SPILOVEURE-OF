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
    {"code": "wave_ci", "name": "Wave CI", "country": "CI", "currency": "XOF",
     "payment_flow": {"kind": "push"}},
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
    if path == "/crypto/assets?direction=payout":
        return R(200, {"assets": [
            {"asset_code": "USDT", "network_code": "BEP20", "active": True},
            {"asset_code": "USDT", "network_code": "ERC20", "active": True},
            {"asset_code": "BTC", "network_code": "BEP20", "active": True},
        ]})
    if path == "/crypto/payouts/btp-crypto-1":
        return R(200, {"id": "btp-crypto-1", "status": "completed"})
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
    if path == "/crypto/payouts":
        return R(200, {"id": "btp-crypto-1", "status": "pending",
                       "payout": {"id": "btp-crypto-1", "status": "pending"}})
    return R(400, {"detail": "bad"})


@pytest.fixture()
def env(monkeypatch):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    db = AsyncMongoMockClient(tz_aware=True)["spv_btp_test"]
    loop.run_until_complete(db.client.drop_database("spv_btp_test"))
    loop.run_until_complete(db.app_settings.insert_one({"key": "payment_gateway", "value": {
        "biztranspay_enabled": True, "biztranspay_payin_enabled": True, "biztranspay_payout_enabled": True,
        "biztranspay_crypto_payout_enabled": True,
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
    b._CRYPTO_PAYOUT_CATALOG_CACHE = (0.0, [])
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


def test_catalog_parser_keeps_nested_countries_and_all_payout_routes():
    items = bc.parse_catalog({"data": {"countries": [
        {"code": "GA", "currency": "XAF", "operators": [
            {"code": "airtel_ga", "name": "Airtel Money Gabon"},
            {"code": "moov_ga", "name": "Moov Money Gabon"},
        ]},
        {"code": "CD", "currency": "CDF", "operators": [
            {"code": "orange_cd", "name": "Orange Money RDC"},
        ]},
    ]}})
    assert {(item["country"], item["code"], item["currency"]) for item in items} == {
        ("GA", "airtel_ga", "XAF"),
        ("GA", "moov_ga", "XAF"),
        ("CD", "orange_cd", "CDF"),
    }


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


def test_crypto_payout_uses_the_active_global_usdt_bep20_catalog(env):
    db, loop = env
    assets = loop.run_until_complete(b.crypto_withdrawal_assets(db, force=True))
    result = loop.run_until_complete(b.create_crypto_payout(
        db, reference="withdrawal-global-1", amount_usdt=1.23456789,
        destination_address="0x" + "a" * 40,
    ))
    call = next(item for item in CALLS if item[0] == "POST" and item[1] == "/crypto/payouts")
    assert assets == [{
        "asset_code": "USDT", "network_code": "BEP20", "label": "USDT BEP20",
    }]
    assert result["id"] == "btp-crypto-1" and result["status"] == "pending"
    assert call[2] == {
        "amount": 1.23456789, "asset_code": "USDT",
        "network_code": "BEP20", "wallet_address": "0x" + "a" * 40,
        "fee_bearer": "sender",
    }
    assert call[3] == "withdrawal-global-1"
    assert ("GET", "/crypto/assets?direction=payout", None) in CALLS
    assert not any("direction=deposit" in item[1] for item in CALLS if item[0] == "GET")


def test_crypto_payout_global_switch_blocks_requests_without_country_configuration(env):
    db, loop = env
    loop.run_until_complete(db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"value.biztranspay_crypto_payout_enabled": False}},
    ))
    assets = loop.run_until_complete(b.crypto_withdrawal_assets(db, force=True))
    assert assets == []
    assert not any(item[1] == "/crypto/assets?direction=payout" for item in CALLS if item[0] == "GET")


def test_public_withdrawal_settings_follow_global_crypto_payout_switch(env):
    import server

    db, loop = env
    settings = loop.run_until_complete(server.get_withdrawal_settings(_req(db)))
    assert settings["crypto_payout_available"] is True
    loop.run_until_complete(db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"value.biztranspay_crypto_payout_enabled": False}},
    ))
    settings_off = loop.run_until_complete(server.get_withdrawal_settings(_req(db)))
    assert settings_off["crypto_payout_available"] is False
    assert "Biz-transPay" not in settings_off["crypto_payout_unavailable_reason"]


def test_crypto_payout_catalog_accepts_nested_asset_and_network_fields(env, monkeypatch):
    db, loop = env
    assert not b._is_usdt_bep20_catalog_asset({
        "asset": "USDT", "network": "BSC", "is_active": 0,
    })

    async def nested_catalog_get(path, sk, pk):
        assert path == "/crypto/assets?direction=payout"
        return R(200, {"data": {"assets": [{
            "asset": {"code": "USDT", "symbol": "USDT"},
            "network": {"code": "BEP20", "name": "BNB Smart Chain"},
            "withdrawal_enabled": True,
        }]}})

    monkeypatch.setattr(b, "_get", nested_catalog_get)
    status = loop.run_until_complete(b.crypto_payout_status(db, force=True))
    assert status["available"] is True
    assert status["assets"] == [{
        "asset_code": "USDT", "network_code": "BEP20", "label": "USDT BEP20",
    }]


def test_crypto_payout_catalog_diagnostic_reports_http_failure_without_post(env, monkeypatch):
    import server

    db, loop = env

    async def forbidden_catalog_get(path, sk, pk):
        return R(403, {"detail": "scope not enabled"})

    monkeypatch.setattr(b, "_get", forbidden_catalog_get)
    status = loop.run_until_complete(b.crypto_payout_status(db, force=True))
    assert status["available"] is False
    assert status["reason_code"] == "catalog_http_error"
    assert status["http_status"] == 403
    public_settings = loop.run_until_complete(server.get_withdrawal_settings(_req(db)))
    assert public_settings["crypto_payout_available"] is False
    assert "n’a pas confirmé" in public_settings["crypto_payout_unavailable_reason"]
    assert "réseau temporairement indisponible" not in public_settings["crypto_payout_unavailable_reason"]
    assert not any(item[0] == "POST" for item in CALLS)


def test_crypto_payout_status_lookup_is_read_only(env):
    db, loop = env
    status = loop.run_until_complete(b.get_crypto_payout(db, "btp-crypto-1"))
    assert status == {
        "ok": True, "id": "btp-crypto-1", "status": "completed", "tx_hash": None,
    }
    assert ("GET", "/crypto/payouts/btp-crypto-1", None) in CALLS
    assert not any(item[0] == "POST" for item in CALLS)


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


def test_crypto_payout_webhook_refunds_failed_withdrawal_once(env):
    db, loop = env
    loop.run_until_complete(db.users.insert_one({
        "id": "crypto-user", "balance_crypto": 0.5,
        "crypto_withdrawal_debits": ["crypto-wd-1"],
    }))
    loop.run_until_complete(db.withdrawals.insert_one({
        "id": "crypto-wd-1", "user_id": "crypto-user", "method": "crypto",
        "gateway": "biztranspay_crypto", "status": "dispatched",
        "gateway_status": "pending", "payout_id": "btp-crypto-1",
        "amount": 1.0, "wallet_debit": 1.0, "net_payout": 0.98,
        "asset_code": "USDT.BEP20",
    }))
    body = {
        "id": "evt-crypto-failed",
        "type": "crypto.payout.status_changed",
        "data": {
            "id": "btp-crypto-1", "type": "crypto_payout",
            "status": "failed", "tx_hash": "0xdeadbeef",
        },
    }
    raw, headers = _signed(body)
    result = loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, raw, headers)))
    withdrawal = loop.run_until_complete(db.withdrawals.find_one({"id": "crypto-wd-1"}))
    user = loop.run_until_complete(db.users.find_one({"id": "crypto-user"}))
    assert result["reconciled"] == "crypto_withdrawal"
    assert withdrawal["status"] == "rejected"
    assert withdrawal["tx_hash"] == "0xdeadbeef"
    assert user["balance_crypto"] == 1.5

    retry_body = {**body, "id": "evt-crypto-failed-retry"}
    retry_raw, retry_headers = _signed(retry_body)
    loop.run_until_complete(b.biztranspay_webhook(FakeReq(db, retry_raw, retry_headers)))
    user_after_retry = loop.run_until_complete(db.users.find_one({"id": "crypto-user"}))
    assert user_after_retry["balance_crypto"] == 1.5


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
    assert result["count"] == 5
    assert all("enabled" in item and "country_enabled" in item for item in result["items"])
    loop.run_until_complete(toggle_country(db, "biztranspay", "CD", False))
    result = loop.run_until_complete(b.admin_btp_catalog(_req(db), "deposit", USER))
    assert next(item for item in result["items"] if item["country"] == "CD")["enabled"] is False
    payout = loop.run_until_complete(b.admin_btp_catalog(_req(db), "payout", USER))
    assert {item["code"] for item in payout["items"]} == {item["code"] for item in PAYOUT_CAT}
    assert not any(call[0] == "POST" for call in CALLS)


def test_admin_catalog_syncs_every_nested_live_payout_route(env, monkeypatch):
    db, loop = env
    response = R(200, {"data": {"countries": [
        {"code": "GA", "currency": "XAF", "operators": [
            {"code": "airtel_ga", "name": "Airtel Money Gabon"},
            {"code": "moov_ga", "name": "Moov Money Gabon"},
        ]},
        {"code": "CD", "currency": "CDF", "operators": [
            {"code": "orange_cd", "name": "Orange Money RDC"},
        ]},
    ]}})

    async def nested_catalog(path, secret_key, public_key):
        assert path == "/mobile-money/operators?direction=payout"
        return response

    monkeypatch.setattr(b, "_get", nested_catalog)
    result = loop.run_until_complete(b.admin_btp_catalog(_req(db), "payout", USER))
    assert result["count"] == 3
    assert {item["country"] for item in result["items"]} == {"GA", "CD"}
    rows = loop.run_until_complete(db.payment_provider_payout_operators.find(
        {"provider_id": "biztranspay"}, {"_id": 0, "country_code": 1, "operator_code": 1},
    ).to_list(None))
    assert {
        ("GA", "airtel_ga"), ("GA", "moov_ga"), ("CD", "orange_cd"),
    } <= {(row["country_code"], row["operator_code"]) for row in rows}


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


def test_old_pending_activation_is_reconciled_with_backoff(env, monkeypatch):
    db, loop = env
    from datetime import datetime, timedelta, timezone
    import ashtec_activation

    loop.run_until_complete(db.payments.insert_one({
        "reference": "old-btp-intent", "user_id": "u1", "kind": "activation",
        "provider": "biztranspay", "provider_intent_id": "dep-old",
        "status": "pending", "level": 1,
        "created_at": datetime.now(timezone.utc) - timedelta(hours=2),
    }))
    calls = []

    async def status(path, secret_key, public_key):
        calls.append(path)
        return R(200, {"id": "dep-old", "status": "completed"})

    async def activate(database, payment, status, *, source):
        assert source == "biztranspay"
        await database.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "paid", "activation_done": True}},
        )

    monkeypatch.setattr(b, "_get", status)
    monkeypatch.setattr(ashtec_activation, "_apply_payment_success", activate)

    result = loop.run_until_complete(b._poll_once(db))
    payment = loop.run_until_complete(db.payments.find_one({"reference": "old-btp-intent"}))
    assert result["checked"] == result["activated"] == 1
    assert calls == ["/deposits/dep-old"]
    assert payment["status"] == "paid"
    assert "biztranspay_next_poll_at" not in payment


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
    loop.run_until_complete(db.users.insert_one({"id": "u1", "total_withdrawn": 0}))
    loop.run_until_complete(db.withdrawals.insert_one(dict(wd)))
    first = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    second = loop.run_until_complete(b.dispatch_biztranspay_withdrawal(db, wd))
    assert first["reason"] == "network_error"
    assert second["reason"] == "already_submitted"
    assert len([call for call in CALLS if call[1] == "/payouts"]) == 1
    import server
    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(server.admin_reject_withdrawal(wd["id"], _req(db), {"id": "admin"}))
    assert exc.value.status_code == 409
    verification = loop.run_until_complete(server.admin_verify_withdrawal(
        wd["id"], _req(db), {"manual_confirmation": True}, {"id": "admin"},
    ))
    assert verification["manual_confirmation_recorded"] is True
    result = loop.run_until_complete(server.admin_validate_withdrawal(
        wd["id"], _req(db), {"id": "admin"}))
    assert result == {"ok": True, "status": "validated", "provider_request_sent": False}
    assert loop.run_until_complete(db.withdrawals.find_one({"id": wd["id"]}))["status"] == "validated"
    assert len([call for call in CALLS if call[1] == "/payouts"]) == 1
    assert loop.run_until_complete(db.users.find_one({"id": "u1"}))["total_withdrawn"] == 1000
    assert loop.run_until_complete(server.admin_validate_withdrawal(
        wd["id"], _req(db), {"id": "admin"},
    ))["already_validated"]
    assert loop.run_until_complete(db.users.find_one({"id": "u1"}))["total_withdrawn"] == 1000


@pytest.mark.parametrize(("response", "expected_url"), [
    (
        {"id": "wave-1", "status": "pending",
         "deposit": {"redirect_url": "https://checkout.example/wave"}},
        "https://checkout.example/wave",
    ),
    (
        {"data": {"id": "wave-2", "status": "pending",
                  "payment": {"payment_url": "https://checkout.example/wave-2"}}},
        "https://checkout.example/wave-2",
    ),
    (
        {"id": "wave-3", "status": "pending",
         "deposit": {"payment_flow": {"checkout_url": "https://checkout.example/wave-3"}}},
        "https://checkout.example/wave-3",
    ),
])
def test_wave_redirect_and_duplicate_return_same_url(env, monkeypatch, response, expected_url):
    db, loop = env
    async def redirected(path, body, sk, pk, *, idempotency_key):
        if path == "/deposits":
            CALLS.append(("POST", path, body, idempotency_key))
            return R(200, response)
        return await fake_post(path, body, sk, pk, idempotency_key=idempotency_key)
    monkeypatch.setattr(b, "_post", redirected)
    data = b.BtpActivationIn(country_code="CI", operator="wave_ci", phone="0700000000")
    first = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    second = loop.run_until_complete(b.biztranspay_activation(data, _req(db), USER))
    assert first["redirect_url"] == second["redirect_url"] == expected_url
    assert "page de paiement" in first["message"].lower()
    deposit_body = [call for call in CALLS if call[1] == "/deposits"][0][2]
    assert deposit_body["country"] == "CI"
    assert deposit_body["operator"] == "wave_ci"
    assert deposit_body["phone_number"] == "+225700000000"
    assert len([call for call in CALLS if call[1] == "/deposits"]) == 1


def test_wave_push_without_checkout_instructs_phone_confirmation(env):
    db, loop = env
    result = loop.run_until_complete(b.biztranspay_activation(
        b.BtpActivationIn(country_code="CI", operator="wave_ci", phone="0700000000"),
        _req(db), USER,
    ))
    assert result["redirect_url"] is None
    assert "wave" in result["message"].lower()
    assert "validez-la" in result["message"].lower()


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
