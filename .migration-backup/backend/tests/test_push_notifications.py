"""FCM push notifications backend tests (iteration 48)."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


# ─── Fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=15)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def user_headers():
    """Register a fresh normal user and return auth headers + id."""
    uniq = uuid.uuid4().hex[:8]
    payload = {
        "username": f"TEST_push_{uniq}",
        "email": f"TEST_push_{uniq}@example.com",
        "password": "Testpass123!",
        "country": "TG",
        "phone": f"+228{uniq[:8]}",
        "sponsor_username": "admin",
        "password_confirm": "Testpass123!",
        "accept_terms": True,
    }
    r = requests.post(f"{BASE_URL}/auth/register", json=payload, timeout=15)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    data = r.json()
    tok = data.get("access_token") or data.get("token")
    if not tok:
        # fallback login
        r2 = requests.post(f"{BASE_URL}/auth/login",
                           json={"email": payload["email"], "password": payload["password"]},
                           timeout=15)
        tok = r2.json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}, data.get("user", {}).get("id")


# ─── Token registration ──────────────────────────────────────────────────────
class TestPushTokens:
    def test_register_token_upsert(self, user_headers):
        headers, _ = user_headers
        device_id = f"dev-{uuid.uuid4().hex}"
        payload = {
            "token": "fMockToken_" + "x" * 60,
            "device_id": device_id,
            "platform": "web",
            "user_agent": "pytest-agent/1.0",
        }
        r = requests.post(f"{BASE_URL}/push/tokens", json=payload, headers=headers, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        # Second call → update, not duplicate
        payload["user_agent"] = "pytest-agent/2.0"
        r2 = requests.post(f"{BASE_URL}/push/tokens", json=payload, headers=headers, timeout=15)
        assert r2.status_code == 200

        # Delete
        r3 = requests.delete(f"{BASE_URL}/push/tokens/{device_id}", headers=headers, timeout=15)
        assert r3.status_code == 200
        assert r3.json().get("deleted") == 1

    def test_register_requires_auth(self):
        r = requests.post(f"{BASE_URL}/push/tokens",
                          json={"token": "x" * 40, "device_id": "dev-anon-x", "platform": "web"},
                          timeout=15)
        assert r.status_code in (401, 403), r.status_code


# ─── Admin endpoints ─────────────────────────────────────────────────────────
class TestAdminPush:
    def test_stats_requires_admin(self, user_headers):
        headers, _ = user_headers
        r = requests.get(f"{BASE_URL}/admin/push/stats", headers=headers, timeout=15)
        assert r.status_code in (401, 403), r.status_code

    def test_stats_ok(self, admin_headers):
        r = requests.get(f"{BASE_URL}/admin/push/stats", headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("total_users_with_token", "total_devices", "per_level", "per_country"):
            assert k in d, f"missing {k} in {d}"
        assert isinstance(d["total_devices"], int)

    def test_push_all_no_crash(self, admin_headers):
        payload = {"title": "TEST", "body": "hello", "link": "/"}
        r = requests.post(f"{BASE_URL}/admin/push/all", json=payload, headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("requested", "success", "failure", "removed_invalid"):
            assert k in d
        assert d["requested"] >= 0

    def test_push_user_404(self, admin_headers):
        payload = {"title": "T", "body": "b"}
        r = requests.post(f"{BASE_URL}/admin/push/user/does-not-exist-xyz",
                          json=payload, headers=admin_headers, timeout=15)
        assert r.status_code == 404, r.text

    def test_push_user_exists(self, admin_headers):
        # Fetch admin's own id
        me = requests.get(f"{BASE_URL}/auth/me", headers=admin_headers, timeout=15).json()
        uid = me["id"]
        payload = {"title": "T", "body": "b"}
        r = requests.post(f"{BASE_URL}/admin/push/user/{uid}",
                          json=payload, headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        assert "requested" in r.json()

    def test_push_group_no_filter_400(self, admin_headers):
        payload = {"title": "T", "body": "b"}
        r = requests.post(f"{BASE_URL}/admin/push/group",
                          json=payload, headers=admin_headers, timeout=15)
        assert r.status_code == 400, r.text

    def test_push_group_with_filter(self, admin_headers):
        payload = {"title": "T", "body": "b", "max_level_min": 1, "country": "TG"}
        r = requests.post(f"{BASE_URL}/admin/push/group",
                          json=payload, headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        assert "requested" in r.json()

    def test_admin_endpoints_reject_user(self, user_headers):
        headers, _ = user_headers
        payload = {"title": "T", "body": "b"}
        for path in ("/admin/push/all", "/admin/push/group", "/admin/push/user/xxx"):
            r = requests.post(f"{BASE_URL}{path}", json=payload, headers=headers, timeout=15)
            assert r.status_code in (401, 403), f"{path} → {r.status_code}"


# ─── Service worker file served by frontend ──────────────────────────────────
def test_service_worker_served():
    root = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
    r = requests.get(f"{root}/firebase-messaging-sw.js", timeout=15)
    assert r.status_code == 200, r.status_code
    body = r.text
    assert "firebase.initializeApp" in body
    assert "onBackgroundMessage" in body
