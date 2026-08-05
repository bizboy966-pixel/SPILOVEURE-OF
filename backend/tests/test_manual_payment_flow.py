"""Test the new manual-payment flow:
- GET /api/settings/manual-payment returns allowed_countries
- PUT /api/admin/settings/manual-payment persists allowed_countries
- POST /api/activations/manual-request: enabled+country gating + activation creation
- Admin sees pending manual activation in GET /api/admin/activations

Run: pytest /app/backend/tests/test_manual_payment_flow.py -v
"""
from __future__ import annotations
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://jobs-badges-fix.preview.emergentagent.com",
).rstrip("/")

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


# ===== Helpers / Fixtures =====

@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


def _register_test_user(country: str = "TG") -> tuple[str, str]:
    """Create a fresh test user; returns (user_id, access_token)."""
    suffix = uuid.uuid4().hex[:8]
    username = f"tst_{suffix}"
    payload = {
        "username": username,
        "email": f"TEST_{suffix}@example.com",
        "phone": f"+228900{suffix[:5]}",
        "country": country,
        "password": "Password!123",
        "password_confirm": "Password!123",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{BASE_URL}/api/auth/register", json=payload)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    data = r.json()
    return data["user"]["id"], data["access_token"]


@pytest.fixture
def test_user_tg():
    uid, token = _register_test_user("TG")
    yield uid, token
    # cleanup
    admin_r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    if admin_r.status_code == 200:
        atok = admin_r.json()["access_token"]
        requests.post(
            f"{BASE_URL}/api/admin/users/{uid}/action",
            json={"action": "delete"},
            headers={"Authorization": f"Bearer {atok}"},
        )


# ===== Public settings endpoint =====

class TestManualPaymentSettings:
    def test_public_get_includes_allowed_countries(self):
        r = requests.get(f"{BASE_URL}/api/settings/manual-payment")
        assert r.status_code == 200
        data = r.json()
        assert "allowed_countries" in data
        assert isinstance(data["allowed_countries"], list)
        assert "enabled" in data
        assert "payment_url" in data

    def test_admin_put_persists_allowed_countries(self, admin_headers):
        payload = {
            "enabled": True,
            "payment_url": "https://pay.example.com/test",
            "title": "Paiement manuel TEST",
            "instructions": "Test instructions",
            "phone_to_pay": "+22890000001",
            "operator_name": "TMoney",
            "allowed_countries": ["TG", "BJ", "BF"],
        }
        r = requests.put(
            f"{BASE_URL}/api/admin/settings/manual-payment",
            json=payload, headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        # Verify persistence via PUBLIC endpoint
        get_r = requests.get(f"{BASE_URL}/api/settings/manual-payment")
        assert get_r.status_code == 200
        got = get_r.json()
        assert got["enabled"] is True
        assert got["payment_url"] == "https://pay.example.com/test"
        assert sorted(got["allowed_countries"]) == ["BF", "BJ", "TG"]

    def test_admin_put_normalizes_country_codes(self, admin_headers):
        payload = {
            "enabled": True,
            "payment_url": "https://pay.example.com/test",
            "allowed_countries": ["tg", " bj ", "CI"],
        }
        r = requests.put(
            f"{BASE_URL}/api/admin/settings/manual-payment",
            json=payload, headers=admin_headers,
        )
        assert r.status_code == 200
        get_r = requests.get(f"{BASE_URL}/api/settings/manual-payment").json()
        # should be uppercased and stripped
        assert sorted(get_r["allowed_countries"]) == ["BJ", "CI", "TG"]


# ===== Manual activation flow =====

class TestManualActivationFlow:
    def test_disabled_returns_400(self, admin_headers, test_user_tg):
        # Disable manual payment
        requests.put(
            f"{BASE_URL}/api/admin/settings/manual-payment",
            json={"enabled": False, "payment_url": "https://x", "allowed_countries": ["TG"]},
            headers=admin_headers,
        )
        uid, tok = test_user_tg
        r = requests.post(
            f"{BASE_URL}/api/activations/manual-request",
            json={"country": "TG", "operator": "TMoney", "phone": "+22890000099"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 400

    def test_country_not_allowed_returns_400(self, admin_headers, test_user_tg):
        requests.put(
            f"{BASE_URL}/api/admin/settings/manual-payment",
            json={"enabled": True, "payment_url": "https://pay.example.com",
                  "allowed_countries": ["BJ", "BF"]},  # TG NOT allowed
            headers=admin_headers,
        )
        uid, tok = test_user_tg
        r = requests.post(
            f"{BASE_URL}/api/activations/manual-request",
            json={"country": "TG", "operator": "TMoney", "phone": "+22890000099"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 400

    def test_create_pending_and_visible_in_admin(self, admin_headers, test_user_tg):
        requests.put(
            f"{BASE_URL}/api/admin/settings/manual-payment",
            json={"enabled": True, "payment_url": "https://pay.example.com/redirect",
                  "allowed_countries": ["TG", "BJ", "BF"]},
            headers=admin_headers,
        )
        uid, tok = test_user_tg
        r = requests.post(
            f"{BASE_URL}/api/activations/manual-request",
            json={"country": "TG", "operator": "TMoney", "phone": "+22890000099"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["payment_url"] == "https://pay.example.com/redirect"
        assert body["amount"] == 2500
        act_id = body["activation_id"]

        # Already pending → reuse
        r2 = requests.post(
            f"{BASE_URL}/api/activations/manual-request",
            json={"country": "TG", "operator": "TMoney", "phone": "+22890000099"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r2.status_code == 200
        body2 = r2.json()
        assert body2["already_pending"] is True
        assert body2["activation_id"] == act_id

        # Admin sees it in /api/admin/activations
        adm = requests.get(
            f"{BASE_URL}/api/admin/activations?status=pending",
            headers=admin_headers,
        )
        assert adm.status_code == 200
        items = adm.json()
        match = [a for a in items if a.get("id") == act_id]
        assert len(match) == 1, f"Activation {act_id} not found in admin pending list"
        a = match[0]
        assert a["user_id"] == uid
        assert a["payment_method"] == "manual"
        assert a["payer_country"] == "TG"
        assert a["operator"] == "TMoney"
        assert a["payment_phone"] == "+22890000099"
        assert a["amount"] == 2500
        assert a["status"] == "pending"
        assert a["level"] == 1

    def test_already_activated_returns_400(self, admin_headers, test_user_tg):
        requests.put(
            f"{BASE_URL}/api/admin/settings/manual-payment",
            json={"enabled": True, "payment_url": "https://x", "allowed_countries": ["TG"]},
            headers=admin_headers,
        )
        uid, tok = test_user_tg
        # admin activates level 1 for this user
        r0 = requests.post(
            f"{BASE_URL}/api/admin/users/{uid}/action",
            json={"action": "activate_level", "level": 1},
            headers=admin_headers,
        )
        assert r0.status_code == 200, r0.text
        # Now manual request should be refused (max_level >= 1)
        r = requests.post(
            f"{BASE_URL}/api/activations/manual-request",
            json={"country": "TG", "operator": "TMoney", "phone": "+22890000099"},
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 400


# ===== Cleanup / restore default settings =====

def test_zz_restore_default_settings(admin_headers):
    """Last test: restore manual payment settings to a sane default."""
    requests.put(
        f"{BASE_URL}/api/admin/settings/manual-payment",
        json={
            "enabled": True,
            "payment_url": "https://pay.example.com",
            "title": "Paiement manuel",
            "instructions": "",
            "phone_to_pay": "",
            "operator_name": "",
            "allowed_countries": ["TG", "BJ", "BF"],
        },
        headers=admin_headers,
    )
