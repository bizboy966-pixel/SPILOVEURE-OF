"""Backend tests for biz-transPay crypto auto-activation feature.

Covers:
  * Feature flag `crypto_auto` catalog + admin toggle
  * POST /api/activations/crypto-auto/create (503 when flag off, 400 already
    activated, 200/502 when flag on and user pending)
  * Webhook signature enforcement (missing/invalid → 401)
  * Webhook happy path + idempotency + underpayment
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import datetime, timezone

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
WEBHOOK_SECRET = os.environ.get("BIZ_TRANSPAY_WEBHOOK_SECRET",
                                "sk_live_dGWquLqO7Sm-IS5fKS7r8Zm5ufNqltJDk81f-ZqVnSI")

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


# ─── Shared fixtures ──────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def admin_token(s):
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def pending_user(s):
    """Register a fresh pending user under 'admin' sponsor."""
    suffix = uuid.uuid4().hex[:8]
    username = f"tst_crypto_{suffix}"
    email = f"{username}@example.com"
    password = "Passw0rd!"
    r = s.post(f"{BASE_URL}/api/auth/register", json={
        "username": username, "email": email, "password": password,
        "password_confirm": password, "sponsor_username": "admin",
        "country": "TG", "phone": f"+228900{suffix[:5]}", "accept_terms": True,
    }, timeout=15)
    assert r.status_code in (200, 201), f"register: {r.status_code} {r.text}"
    lr = s.post(f"{BASE_URL}/api/auth/login",
                json={"email": email, "password": password}, timeout=15)
    assert lr.status_code == 200, lr.text
    data = lr.json()
    tok = data.get("access_token") or data.get("token")
    return {"email": email, "username": username, "password": password,
            "token": tok, "id": data["user"]["id"],
            "headers": {"Authorization": f"Bearer {tok}"}}


# ─── Feature flag toggling helpers ────────────────────────────────────────────
def _set_flag(s, admin_headers, key, enabled):
    r = s.put(f"{BASE_URL}/api/admin/feature-flags/{key}",
              headers=admin_headers, json={"enabled": enabled}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


# ─── Feature flag catalog test ────────────────────────────────────────────────
class TestFeatureFlagCatalog:
    def test_crypto_auto_present_in_catalog(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/admin/feature-flags", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        items = {i["key"]: i for i in r.json()["items"]}
        assert "crypto_auto" in items
        f = items["crypto_auto"]
        assert f["label"] == "Auto-activation Crypto (USDT BEP20)"
        assert f["category"] == "activation"

    def test_public_features_lists_crypto_auto(self, s):
        r = s.get(f"{BASE_URL}/api/features", timeout=10)
        assert r.status_code == 200
        assert "crypto_auto" in r.json()["features"]

    def test_admin_can_toggle_crypto_auto(self, s, admin_headers):
        # off
        _set_flag(s, admin_headers, "crypto_auto", False)
        r = s.get(f"{BASE_URL}/api/features", timeout=10)
        assert r.json()["features"]["crypto_auto"] is False
        # on
        _set_flag(s, admin_headers, "crypto_auto", True)
        r = s.get(f"{BASE_URL}/api/features", timeout=10)
        assert r.json()["features"]["crypto_auto"] is True


# ─── Create charge endpoint ───────────────────────────────────────────────────
class TestCreateCharge:
    def test_503_when_flag_off(self, s, admin_headers, pending_user):
        _set_flag(s, admin_headers, "crypto_auto", False)
        r = s.post(f"{BASE_URL}/api/activations/crypto-auto/create",
                   headers=pending_user["headers"], json={"level": 1}, timeout=15)
        assert r.status_code == 503, f"expected 503, got {r.status_code} {r.text}"

    def test_flag_on_pending_user_hits_gateway(self, s, admin_headers, pending_user):
        _set_flag(s, admin_headers, "crypto_auto", True)
        r = s.post(f"{BASE_URL}/api/activations/crypto-auto/create",
                   headers=pending_user["headers"], json={"level": 1}, timeout=45)
        # Either 200 with valid payload OR 502 (gateway unreachable in test env).
        assert r.status_code in (200, 502), f"unexpected {r.status_code} {r.text}"
        if r.status_code == 200:
            body = r.json()
            for k in ("reference", "deposit_address", "amount_to_send", "coin", "network"):
                assert k in body, f"missing {k}"
            assert body["coin"] == "USDT"
            assert body["network"] == "BEP20"
            # Bug P0 regression: deposit_address must never be null/empty.
            assert isinstance(body["deposit_address"], str) and body["deposit_address"].strip(), \
                f"deposit_address must be non-empty string, got {body['deposit_address']!r}"
            assert body["amount_to_send"] not in (None, "", 0)
            assert body["reference"].startswith("SPLV_CRYPTO_")

    def test_level_not_1_rejected(self, s, admin_headers, pending_user):
        _set_flag(s, admin_headers, "crypto_auto", True)
        r = s.post(f"{BASE_URL}/api/activations/crypto-auto/create",
                   headers=pending_user["headers"], json={"level": 2}, timeout=15)
        assert r.status_code == 400
        assert "niveau 1" in r.text.lower() or "level" in r.text.lower()

    def test_400_when_already_activated(self, s, admin_headers):
        """Admin (max_level=12) should always be refused with 400."""
        _set_flag(s, admin_headers, "crypto_auto", True)
        r = s.post(f"{BASE_URL}/api/activations/crypto-auto/create",
                   headers=admin_headers, json={"level": 1}, timeout=15)
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"


# ─── Webhook signature enforcement ────────────────────────────────────────────
class TestWebhookAuth:
    URL = None

    @pytest.fixture(autouse=True)
    def _url(self):
        TestWebhookAuth.URL = f"{BASE_URL}/api/webhooks/biz-transppayy"

    def test_missing_headers_401(self, s):
        r = s.post(self.URL, data="{}", headers={"Content-Type": "application/json"}, timeout=10)
        assert r.status_code == 401, f"expected 401, got {r.status_code} {r.text}"

    def test_invalid_signature_401(self, s):
        ts = str(int(time.time()))
        r = s.post(self.URL, data="{}",
                   headers={"Content-Type": "application/json",
                            "X-BizTransPay-Timestamp": ts,
                            "X-BizTransPay-Signature": "sha256=deadbeef"}, timeout=10)
        assert r.status_code == 401


# ─── Webhook full flow via direct db.payments seeding ─────────────────────────
def _sign(raw_body: bytes, ts: str) -> str:
    payload = f"{ts}.{raw_body.decode()}".encode()
    return hmac.new(WEBHOOK_SECRET.encode(), payload, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_webhook_full_flow(pending_user, admin_headers):
    """End-to-end: seed a pending db.payments row, POST valid webhook →
    user must be activated. Replay must be idempotent. Underpayment must
    NOT activate.
    """
    s = requests.Session()
    _set_flag(s, admin_headers, "crypto_auto", True)

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    try:
        # ── 1) Seed pending payment for OUR pending user
        ref = f"SPLV_TEST_{uuid.uuid4().hex[:8]}"
        now = datetime.now(timezone.utc)
        await db.payments.insert_one({
            "reference": ref, "provider": "biz_transpay",
            "user_id": pending_user["id"], "level": 1,
            "amount": 5, "currency": "USDT", "network": "BEP20",
            "status": "pending", "created_at": now, "updated_at": now,
        })
        await db.activations.insert_one({
            "id": str(uuid.uuid4()), "user_id": pending_user["id"],
            "username": pending_user["username"], "level": 1, "status": "pending",
            "payment_method": "crypto_auto", "reference": ref,
            "amount": 5, "currency": "USDT", "created_at": now,
        })

        # ── 2) POST valid webhook → 200 activated
        body = json.dumps({
            "event_type": "payment.completed",
            "payload": {"reference": ref, "status": "completed", "amount_paid": 5}
        }).encode()
        ts = str(int(time.time()))
        sig = _sign(body, ts)
        evt_id = f"evt_{uuid.uuid4().hex}"
        url = f"{BASE_URL}/api/webhooks/biz-transppayy"
        r = s.post(url, data=body,
                   headers={"Content-Type": "application/json",
                            "X-BizTransPay-Timestamp": ts,
                            "X-BizTransPay-Signature": f"sha256={sig}",
                            "X-BizTransPay-Event-Id": evt_id}, timeout=20)
        assert r.status_code == 200, f"webhook: {r.status_code} {r.text}"
        j = r.json()
        assert j.get("ok") is True and j.get("activated") is True, j

        # Verify user activated
        u = await db.users.find_one({"id": pending_user["id"]}, {"_id": 0, "status": 1, "max_level": 1})
        assert u["max_level"] >= 1
        assert u["status"] == "active"

        # ── 3) Replay → duplicate
        r2 = s.post(url, data=body,
                    headers={"Content-Type": "application/json",
                             "X-BizTransPay-Timestamp": ts,
                             "X-BizTransPay-Signature": f"sha256={sig}",
                             "X-BizTransPay-Event-Id": evt_id}, timeout=15)
        assert r2.status_code == 200
        j2 = r2.json()
        assert j2.get("duplicate") is True or j2.get("already_activated") is True, j2

        # ── 4) Underpayment scenario with a fresh pending user
        suffix = uuid.uuid4().hex[:8]
        username = f"tst_under_{suffix}"
        email = f"{username}@example.com"
        pwd = "Passw0rd!"
        rr = s.post(f"{BASE_URL}/api/auth/register", json={
            "username": username, "email": email, "password": pwd,
            "password_confirm": pwd, "sponsor_username": "admin",
            "country": "TG", "phone": f"+228900{suffix[:5]}", "accept_terms": True,
        }, timeout=15)
        assert rr.status_code in (200, 201), rr.text
        lr = s.post(f"{BASE_URL}/api/auth/login",
                    json={"email": email, "password": pwd}, timeout=15)
        under_user = lr.json()["user"]

        ref2 = f"SPLV_TEST_{uuid.uuid4().hex[:8]}"
        await db.payments.insert_one({
            "reference": ref2, "provider": "biz_transpay",
            "user_id": under_user["id"], "level": 1,
            "amount": 5, "currency": "USDT", "network": "BEP20",
            "status": "pending",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })
        body_u = json.dumps({
            "event_type": "payment.completed",
            "payload": {"reference": ref2, "status": "completed", "amount_paid": 2}
        }).encode()
        ts_u = str(int(time.time()))
        sig_u = _sign(body_u, ts_u)
        evt_u = f"evt_{uuid.uuid4().hex}"
        r3 = s.post(url, data=body_u,
                    headers={"Content-Type": "application/json",
                             "X-BizTransPay-Timestamp": ts_u,
                             "X-BizTransPay-Signature": f"sha256={sig_u}",
                             "X-BizTransPay-Event-Id": evt_u}, timeout=15)
        assert r3.status_code == 200, r3.text
        j3 = r3.json()
        assert j3.get("ok") is False and j3.get("reason") == "underpaid", j3

        # Verify under-user still pending
        u2 = await db.users.find_one({"id": under_user["id"]},
                                     {"_id": 0, "status": 1, "max_level": 1})
        assert u2.get("max_level", 0) == 0
        assert u2.get("status") != "active"
    finally:
        client.close()


# ─── Cleanup — reset flag to false per policy ─────────────────────────────────
def test_zzz_reset_flag(s, admin_headers):
    _set_flag(s, admin_headers, "crypto_auto", False)
    r = s.get(f"{BASE_URL}/api/features", timeout=10)
    assert r.json()["features"]["crypto_auto"] is False
