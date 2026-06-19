"""Backend tests for iteration 15:
- Haiti (HT) in GET /api/config countries
- PUT /api/auth/language persistence + validation
- preferred_language returned via GET /api/auth/me
- Pending user creation via POST /api/auth/register
"""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
           "https://spiloveure-deploy.preview.emergentagent.com"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# --- Haiti country in /api/config ---
def test_haiti_in_config_countries():
    r = requests.get(f"{BASE_URL}/api/config", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    countries = data.get("countries") or []
    assert isinstance(countries, list) and len(countries) > 0
    ht = [c for c in countries if c.get("code") == "HT"]
    assert len(ht) == 1, f"HT not found in countries. Got codes={[c.get('code') for c in countries]}"
    h = ht[0]
    assert h["name"] == "Haïti"
    assert h["dial"] == "+509"
    assert h["flag"] == "🇭🇹"


# --- PUT /api/auth/language ---
def test_language_no_token_returns_401():
    r = requests.put(f"{BASE_URL}/api/auth/language",
                     json={"language": "en"}, timeout=20)
    assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"


def test_language_set_en_then_fr_persisted(admin_headers):
    # Set to EN
    r = requests.put(f"{BASE_URL}/api/auth/language",
                     headers=admin_headers, json={"language": "en"}, timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert body.get("preferred_language") == "en"

    # Verify via /api/auth/me
    me = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=20)
    assert me.status_code == 200
    assert me.json().get("preferred_language") == "en"

    # Set back to FR
    r2 = requests.put(f"{BASE_URL}/api/auth/language",
                      headers=admin_headers, json={"language": "fr"}, timeout=20)
    assert r2.status_code == 200
    assert r2.json().get("preferred_language") == "fr"

    me2 = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=20)
    assert me2.json().get("preferred_language") == "fr"


@pytest.mark.parametrize("bad", [{"language": "de"}, {"language": ""}, {"language": "FR_CA"}])
def test_language_invalid_returns_400(admin_headers, bad):
    r = requests.put(f"{BASE_URL}/api/auth/language",
                     headers=admin_headers, json=bad, timeout=20)
    assert r.status_code == 400, f"Expected 400 for {bad}, got {r.status_code}: {r.text}"


def test_language_null_returns_4xx(admin_headers):
    r = requests.put(f"{BASE_URL}/api/auth/language",
                     headers=admin_headers, json={"language": None}, timeout=20)
    # Pydantic returns 422 for null on a non-Optional[str] field
    assert r.status_code in (400, 422), f"Got {r.status_code}: {r.text}"


# --- Pending user creation for gating UI test ---
@pytest.fixture(scope="module")
def pending_user():
    """Create a pending user via /api/auth/register."""
    suffix = uuid.uuid4().hex[:8]
    payload = {
        "username": f"test_{suffix}",
        "email": f"test_{suffix}@spilovtest.com",
        "password": "TestPass123!",
        "password_confirm": "TestPass123!",
        "country": "TG",
        "phone": f"+228900{int(time.time()) % 100000:05d}",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"Register failed: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("access_token") or data.get("token")
    assert token, f"No token in register response: {data}"
    yield {"email": payload["email"], "password": payload["password"], "token": token,
           "username": payload["username"]}


def test_register_creates_pending_user(pending_user):
    headers = {"Authorization": f"Bearer {pending_user['token']}"}
    me = requests.get(f"{BASE_URL}/api/auth/me", headers=headers, timeout=20)
    assert me.status_code == 200, me.text
    u = me.json()
    is_pending = u.get("status") == "pending" or (u.get("max_level") or 0) == 0
    assert is_pending, f"User not pending: status={u.get('status')}, max_level={u.get('max_level')}"


def test_pending_user_can_set_language(pending_user):
    """Even pending users should be able to set language (settings is allowed)."""
    headers = {"Authorization": f"Bearer {pending_user['token']}",
               "Content-Type": "application/json"}
    r = requests.put(f"{BASE_URL}/api/auth/language",
                     headers=headers, json={"language": "en"}, timeout=20)
    assert r.status_code == 200
    assert r.json().get("preferred_language") == "en"
