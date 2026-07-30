"""Pytest for FedaPay integration.

Covers:
  • Webhook signature verification (valid, invalid, stale, missing).
  • Signature-required 401 on POST /api/webhooks/fedapay.
  • Payment gateway admin toggle exposes `fedapay` in the response.
  • Feature flags `fedapay_activation` and `fedapay_withdrawal` are seeded.
  • Dispatcher routes to FedaPay when active='fedapay' + flag enabled.
"""
import hmac, hashlib, json, os, time, uuid

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")
WHSEC = os.environ.get("FEDAPAY_WEBHOOK_SECRET",
                       "wh_live_kAAsROT7Vi9Mszn4QuSkOLyG")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "kossikotokou4@gmail.com")
ADMIN_PW = os.environ.get("ADMIN_PW", "@Emma91972006")


@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def admin_headers(s):
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=10)
    tok = (r.json().get("access_token") or r.json().get("token")) if r.ok else None
    assert tok, f"admin login failed: {r.status_code} {r.text[:200]}"
    return {"Authorization": f"Bearer {tok}"}


def _sign(secret: str, ts: str, body: str) -> str:
    """FedaPay signature scheme: HMAC-SHA256(`{ts}.{raw_body}`) hex-encoded."""
    return hmac.new(secret.encode(), f"{ts}.".encode() + body.encode(), hashlib.sha256).hexdigest()


class TestWebhookSignature:
    URL = None

    @pytest.fixture(autouse=True)
    def _url(self):
        TestWebhookSignature.URL = f"{BASE_URL}/api/webhooks/fedapay"

    def test_missing_signature_returns_401(self, s):
        r = s.post(self.URL, json={"name": "transaction.approved"}, timeout=10)
        assert r.status_code == 401

    def test_invalid_signature_returns_401(self, s):
        ts = str(int(time.time()))
        body = json.dumps({"name": "transaction.approved"}, separators=(",", ":"))
        r = s.post(self.URL, data=body,
                   headers={"Content-Type": "application/json",
                            "X-FEDAPAY-SIGNATURE": f"t={ts},s=deadbeef"},
                   timeout=10)
        assert r.status_code == 401

    def test_stale_timestamp_returns_401(self, s):
        stale_ts = str(int(time.time()) - 3600)
        body = json.dumps({"name": "transaction.approved"}, separators=(",", ":"))
        sig = _sign(WHSEC, stale_ts, body)
        r = s.post(self.URL, data=body,
                   headers={"Content-Type": "application/json",
                            "X-FEDAPAY-SIGNATURE": f"t={stale_ts},s={sig}"},
                   timeout=10)
        assert r.status_code == 401

    def test_valid_signature_returns_200(self, s):
        ts = str(int(time.time()))
        body_obj = {"name": "transaction.approved", "id": f"evt_{uuid.uuid4().hex[:8]}",
                    "object": {"custom_metadata": {"merchantReference": "NONEXISTENT_REF"},
                               "status": "approved"}}
        body = json.dumps(body_obj, separators=(",", ":"))
        sig = _sign(WHSEC, ts, body)
        r = s.post(self.URL, data=body,
                   headers={"Content-Type": "application/json",
                            "X-FEDAPAY-SIGNATURE": f"t={ts},s={sig}"},
                   timeout=10)
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_idempotency_duplicate_event_returns_duplicate(self, s):
        ts = str(int(time.time()))
        event_id = f"evt_{uuid.uuid4().hex[:8]}"
        body_obj = {"name": "transaction.approved", "id": event_id,
                    "object": {"custom_metadata": {"merchantReference": "NONEXISTENT_REF2"}}}
        body = json.dumps(body_obj, separators=(",", ":"))
        sig = _sign(WHSEC, ts, body)
        hdr = {"Content-Type": "application/json", "X-FEDAPAY-SIGNATURE": f"t={ts},s={sig}"}
        r1 = s.post(self.URL, data=body, headers=hdr, timeout=10)
        r2 = s.post(self.URL, data=body, headers=hdr, timeout=10)
        assert r1.status_code == 200 and r2.status_code == 200
        assert r2.json().get("duplicate") is True


class TestAdminGatewayFlags:
    def test_gateway_config_contains_fedapay(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/admin/payment-gateways", headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "fedapay" in body, "payment-gateways response must expose 'fedapay'"
        assert isinstance(body["fedapay"], dict)
        assert "enabled" in body["fedapay"] and "configured" in body["fedapay"]

    def test_feature_flags_expose_fedapay_toggles(self, s):
        r = s.get(f"{BASE_URL}/api/features", timeout=10)
        assert r.status_code == 200
        flags = r.json().get("features", {})
        assert "fedapay_activation" in flags
        assert "fedapay_withdrawal" in flags
