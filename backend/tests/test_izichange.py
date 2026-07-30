"""Backend tests for the IziChangePay direct integration.

Coverage:
• admin login + feature-flag toggle for `crypto_auto` and `auto_withdrawal`
• user registration → crypto-auto/create → crypto-auto/verify happy/error paths
• Standard-Webhooks signature verification (valid / invalid / expired / unknown)
• admin activations list contains the crypto_auto row
• create_payout helper input-validation branches (unit)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid

import pytest
import requests

sys.path.insert(0, "/app/backend")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PWD = "@Emma91972006"

WHSEC_RAW = "whsec_1c84623bef87d6444f61a906ea9afbba2af706d9748335b0bde3b4c344ed40de"
WHSEC_BYTES = bytes.fromhex(WHSEC_RAW.split("whsec_")[1])


# ─── fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=15)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def enable_crypto_auto(admin_headers):
    r = requests.put(f"{API}/admin/feature-flags/crypto_auto",
                     json={"enabled": True}, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    yield True


@pytest.fixture(scope="module")
def new_user():
    """Register a fresh pending user + return (headers, user_dict)."""
    suffix = uuid.uuid4().hex[:8]
    email = f"TEST_izi_{suffix}@example.com"
    payload = {
        "username": f"testizi{suffix}",
        "email": email,
        "password": "Passw0rd!123",
        "password_confirm": "Passw0rd!123",
        "phone": f"+228900{suffix[:5]}",
        "country": "TG",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text[:250]}"
    tok = r.json().get("access_token") or r.json().get("token")
    if not tok:
        # fallback: login
        lr = requests.post(f"{API}/auth/login",
                           json={"email": email, "password": payload["password"]}, timeout=15)
        assert lr.status_code == 200, lr.text
        tok = lr.json().get("access_token") or lr.json().get("token")
    return {"Authorization": f"Bearer {tok}"}, payload, r.json()


# ─── crypto-auto/create ──────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def created_activation(enable_crypto_auto, new_user):
    hdrs, _, _ = new_user
    r = requests.post(f"{API}/activations/crypto-auto/create",
                      json={"level": 1}, headers=hdrs, timeout=45)
    assert r.status_code == 200, f"create failed: {r.status_code} {r.text[:400]}"
    body = r.json()
    return body


def test_create_returns_inline_bep20_address(created_activation):
    body = created_activation
    assert body["coin"] == "USDT"
    assert body["network"] == "BEP20"
    assert body["amount_to_send"] in (5, "5", 5.0, "5.0") or float(body["amount_to_send"]) == 5.0
    addr = body["deposit_address"]
    assert isinstance(addr, str) and addr.startswith("0x") and len(addr) == 42, f"bad addr: {addr!r}"
    assert body["reference"].startswith("SPLV_ACT_")
    assert "payment_url" not in body


def test_verify_unknown_reference_404(new_user):
    hdrs, _, _ = new_user
    r = requests.post(f"{API}/activations/crypto-auto/verify",
                      json={"reference": "SPLV_ACT_doesnotexist", "tx_hash": "0x" + "a" * 64},
                      headers=hdrs, timeout=15)
    assert r.status_code == 404, r.text


def test_verify_hash_too_short_400(new_user, created_activation):
    hdrs, _, _ = new_user
    r = requests.post(f"{API}/activations/crypto-auto/verify",
                      json={"reference": created_activation["reference"], "tx_hash": "0x123"},
                      headers=hdrs, timeout=15)
    assert r.status_code == 400, r.text


def test_verify_fake_hash_returns_pending(new_user, created_activation):
    hdrs, _, _ = new_user
    fake = "0x" + "b" * 64
    r = requests.post(f"{API}/activations/crypto-auto/verify",
                      json={"reference": created_activation["reference"], "tx_hash": fake},
                      headers=hdrs, timeout=30)
    # Should not activate: either 200 ok=false or 400 depending on gateway response.
    assert r.status_code in (200, 400), r.text
    if r.status_code == 200:
        body = r.json()
        assert body.get("ok") is False
        assert body.get("status") in ("pending", "initiated", "waiting_payment", "confirming", "")


# ─── webhook signature ───────────────────────────────────────────────────────
def _sign(body_bytes: bytes, msg_id: str, ts: str) -> str:
    signed = f"{msg_id}.{ts}.".encode() + body_bytes
    sig = base64.b64encode(hmac.new(WHSEC_BYTES, signed, hashlib.sha256).digest()).decode()
    return f"v1,{sig}"


def test_webhook_valid_signature_unknown_ref_ok():
    msg_id = f"msg_{uuid.uuid4().hex[:12]}"
    ts = str(int(time.time()))
    body = json.dumps({
        "type": "payment_intent.completed",
        "data": {"merchantReference": "SPLV_ACT_unknown_wh", "totalAmountReceived": 5,
                 "payins": [{"txHash": "0x" + "c" * 64}]},
    }).encode()
    r = requests.post(f"{API}/webhooks/izichange", data=body, timeout=15,
                      headers={"content-type": "application/json",
                               "x-izipay-id": msg_id, "x-izipay-timestamp": ts,
                               "x-izipay-signature": _sign(body, msg_id, ts)})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j.get("ok") is True


def test_webhook_invalid_signature_401():
    msg_id = f"msg_{uuid.uuid4().hex[:12]}"
    ts = str(int(time.time()))
    body = b'{"type":"payment_intent.completed","data":{}}'
    r = requests.post(f"{API}/webhooks/izichange", data=body, timeout=15,
                      headers={"content-type": "application/json",
                               "x-izipay-id": msg_id, "x-izipay-timestamp": ts,
                               "x-izipay-signature": "v1,AAAABBBBCCCCDDDDEEEE=="})
    assert r.status_code == 401, r.text


def test_webhook_stale_timestamp_401():
    msg_id = f"msg_{uuid.uuid4().hex[:12]}"
    ts = str(int(time.time()) - 3600)  # 1h old
    body = b'{"type":"payment_intent.completed","data":{}}'
    r = requests.post(f"{API}/webhooks/izichange", data=body, timeout=15,
                      headers={"content-type": "application/json",
                               "x-izipay-id": msg_id, "x-izipay-timestamp": ts,
                               "x-izipay-signature": _sign(body, msg_id, ts)})
    assert r.status_code == 401


def test_webhook_completes_real_activation(new_user, enable_crypto_auto):
    """End-to-end signed webhook drives activate_level."""
    hdrs, payload, _reg = new_user
    # Login again to get token (isolation from other test)
    lr = requests.post(f"{API}/auth/login",
                      json={"email": payload["email"], "password": payload["password"]}, timeout=15)
    assert lr.status_code == 200
    tok = lr.json().get("access_token") or lr.json().get("token")
    hh = {"Authorization": f"Bearer {tok}"}

    # Fresh user for this test to avoid conflict with previous activation
    suffix = uuid.uuid4().hex[:8]
    email = f"TEST_iziwh_{suffix}@example.com"
    reg = requests.post(f"{API}/auth/register", json={
        "username": f"testiziwh{suffix}", "email": email, "password": "Passw0rd!123",
        "password_confirm": "Passw0rd!123",
        "phone": f"+228901{suffix[:5]}", "country": "TG", "sponsor_username": "admin",
        "accept_terms": True,
    }, timeout=15)
    assert reg.status_code in (200, 201), reg.text
    tok2 = reg.json().get("access_token") or reg.json().get("token")
    hh2 = {"Authorization": f"Bearer {tok2}"}

    c = requests.post(f"{API}/activations/crypto-auto/create", json={"level": 1},
                      headers=hh2, timeout=45)
    assert c.status_code == 200, c.text
    ref = c.json()["reference"]

    msg_id = f"msg_{uuid.uuid4().hex[:12]}"
    ts = str(int(time.time()))
    body = json.dumps({
        "type": "payment_intent.completed",
        "data": {"merchantReference": ref,
                 "totalAmountReceived": 5,
                 "payins": [{"txHash": "0x" + "d" * 64}]},
    }).encode()
    r = requests.post(f"{API}/webhooks/izichange", data=body, timeout=20,
                      headers={"content-type": "application/json",
                               "x-izipay-id": msg_id, "x-izipay-timestamp": ts,
                               "x-izipay-signature": _sign(body, msg_id, ts)})
    assert r.status_code == 200, r.text
    body_j = r.json()
    assert body_j.get("activated") is True or body_j.get("ok") is True

    # Verify user max_level==1
    me = requests.get(f"{API}/auth/me", headers=hh2, timeout=10)
    assert me.status_code == 200
    assert me.json().get("max_level", 0) >= 1


# ─── admin views ─────────────────────────────────────────────────────────────
def test_admin_activations_contains_crypto_auto(admin_headers, created_activation):
    r = requests.get(f"{API}/admin/activations", headers=admin_headers, timeout=20)
    assert r.status_code == 200
    items = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
    match = [it for it in items if it.get("reference") == created_activation["reference"]]
    assert match, f"activation {created_activation['reference']} not found in admin list"
    it = match[0]
    assert it.get("provider") == "izichange"
    assert it.get("payment_method") == "crypto_auto"
    assert it.get("network") in ("BEP20", "USDT BEP20", "USDT.BEP20")
    assert it.get("deposit_address", "").startswith("0x")


def test_admin_feature_flags_lists_auto_withdrawal(admin_headers):
    r = requests.get(f"{API}/admin/feature-flags", headers=admin_headers, timeout=10)
    assert r.status_code == 200
    keys = [f["key"] for f in r.json()["items"]]
    assert "auto_withdrawal" in keys
    assert "crypto_auto" in keys


def test_toggle_auto_withdrawal_flag(admin_headers):
    for enabled in (True, False):
        r = requests.put(f"{API}/admin/feature-flags/auto_withdrawal",
                         json={"enabled": enabled}, headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["enabled"] is enabled


# ─── create_payout helper (unit) ─────────────────────────────────────────────
def test_create_payout_rejects_invalid_amount():
    import asyncio
    from izichange import create_payout
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        asyncio.run(create_payout(None, reference="x", amount_usdt=0,
                                  destination_address="0x" + "e" * 40))
    assert ei.value.status_code == 400


def test_create_payout_rejects_short_address():
    import asyncio
    from izichange import create_payout
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        asyncio.run(create_payout(None, reference="x", amount_usdt=5,
                                  destination_address="0xshort"))
    assert ei.value.status_code == 400
