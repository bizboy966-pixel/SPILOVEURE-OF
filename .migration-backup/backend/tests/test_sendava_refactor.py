"""Tests for the SendavaPay refactor (iteration 8).

Verifies:
- All WestPay/SecurePay routes removed (404)
- SendavaPay routes alive
- /api/settings/payments schema updated
- /api/payments/sendava/initiate works (TG, fresh user) and rejects CD
- Webhook HMAC-SHA256 signature validation
"""

import hashlib
import hmac
import json
import os
import secrets
import time

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"
WEBHOOK_SECRET = "whsec_7d1cd59d560fc9e4cb38b1b3ee9a873fbe682c45fa948807"


# ---------- shared fixtures ----------

@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def fresh_user_token():
    """Register a fresh user under admin sponsor, country TG."""
    suffix = secrets.token_hex(3)
    pwd = "TestPass123!"
    payload = {
        "username": f"sendava_{suffix}",
        "email": f"sendava_{suffix}@example.com",
        "password": pwd,
        "password_confirm": pwd,
        "country": "TG",
        "phone": f"+2289{secrets.randbelow(10**8):08d}",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    body = r.json()
    token = body.get("access_token") or body.get("token")
    if not token:
        # fallback: login
        rl = requests.post(f"{API}/auth/login", json={"email": payload["email"], "password": payload["password"]}, timeout=15)
        assert rl.status_code == 200, rl.text
        token = rl.json()["access_token"]
    return token


# ---------- removed routes ----------

class TestRemovedRoutes:
    @pytest.mark.parametrize("path,method", [
        ("/payments/secure/initiate", "POST"),
        ("/payments/secure/webhook", "POST"),
        ("/payments/secure/verify/ABC123", "GET"),
        ("/payments/westpay/initiate", "POST"),
        ("/westpay-webhook", "POST"),
        ("/settings/westpay", "GET"),
        ("/admin/settings/secure-payment", "GET"),
        ("/admin/settings/westpay", "GET"),
    ])
    def test_route_returns_404(self, path, method):
        url = f"{API}{path}"
        r = requests.request(method, url, json={} if method == "POST" else None, timeout=10)
        # 404 from FastAPI for unknown routes; 405 acceptable if path exists with different method (shouldn't)
        assert r.status_code == 404, f"{method} {path} → {r.status_code} {r.text[:160]}"


# ---------- payments settings schema ----------

class TestPaymentsSettings:
    def test_schema_uses_sendava_keys(self):
        r = requests.get(f"{API}/settings/payments", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "sendava_enabled" in data
        assert "sendava_excluded_countries" in data
        assert "manual_enabled" in data
        assert "crypto_enabled" in data
        # legacy keys must NOT be present
        assert "secure_enabled" not in data, f"legacy secure_enabled present: {data}"
        assert "secure_allowed_countries" not in data
        assert "westpay_enabled" not in data

    def test_excluded_countries_contains_cd(self):
        r = requests.get(f"{API}/settings/payments", timeout=10)
        data = r.json()
        # RDC = CD must be excluded
        assert "CD" in data["sendava_excluded_countries"]


# ---------- sendava routes alive ----------

class TestSendavaRoutesAlive:
    def test_webhook_ping_get(self):
        r = requests.get(f"{API}/sendavapay-webhook", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("provider") == "sendavapay"

    def test_initiate_requires_auth(self):
        r = requests.post(f"{API}/payments/sendava/initiate", json={"phone": "22890123456", "country_code": "TG"}, timeout=10)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code} {r.text[:120]}"


# ---------- initiate with fresh user ----------

class TestSendavaInitiate:
    def test_initiate_tg_returns_payment_url(self, fresh_user_token):
        r = requests.post(
            f"{API}/payments/sendava/initiate",
            headers={"Authorization": f"Bearer {fresh_user_token}"},
            json={"phone": "22890123456", "country_code": "TG"},
            timeout=30,
        )
        assert r.status_code == 200, f"initiate failed: {r.status_code} {r.text}"
        data = r.json()
        assert "order_id" in data
        assert "payment_url" in data
        assert "transaction_id" in data
        assert data.get("status") == "pending"
        assert data.get("currency") == "XOF"
        assert isinstance(data.get("amount"), (int, float))
        assert data["payment_url"].startswith("https://sendavapay.com/"), f"unexpected URL: {data['payment_url']}"

    def test_initiate_cd_rejected(self, fresh_user_token):
        r = requests.post(
            f"{API}/payments/sendava/initiate",
            headers={"Authorization": f"Bearer {fresh_user_token}"},
            json={"phone": "243812345678", "country_code": "CD"},
            timeout=15,
        )
        assert r.status_code == 400, f"expected 400 for CD, got {r.status_code} {r.text}"
        text = r.text.lower()
        assert "pays" in text or "non disponible" in text or "unavailable" in text, r.text


# ---------- webhook signature ----------

def _sign(payload_bytes: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()


class TestSendavaWebhookSignature:
    def test_invalid_signature_rejected(self):
        body = {"event": "payment.completed", "data": {"reference": "FAKE_REF_XYZ"}}
        raw = json.dumps(body).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "X-Sendavapay-Signature": "deadbeef" * 8,
        }
        r = requests.post(f"{API}/sendavapay-webhook", data=raw, headers=headers, timeout=10)
        assert r.status_code == 401, f"expected 401 for bad signature, got {r.status_code} {r.text[:200]}"

    def test_valid_signature_accepted_unknown_ref(self):
        ref = f"NON_EXISTENT_{int(time.time())}"
        body = {"event": "payment.completed", "reference": ref, "status": "success", "data": {"reference": ref}}
        raw = json.dumps(body).encode("utf-8")
        sig = _sign(raw, WEBHOOK_SECRET)
        headers = {"Content-Type": "application/json", "X-Sendavapay-Signature": sig}
        r = requests.post(f"{API}/sendavapay-webhook", data=raw, headers=headers, timeout=10)
        # Valid signature → must NOT be 401. Could be 200 with unknown_reference, or 404, but not 401.
        assert r.status_code != 401, f"valid signature got 401: {r.text[:200]}"
        assert r.status_code in (200, 202, 404), f"unexpected status: {r.status_code} {r.text[:200]}"
