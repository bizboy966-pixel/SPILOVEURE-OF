"""Feature Flags — end-to-end backend tests.

Covers:
- GET /api/features (public)
- GET/PUT /api/admin/feature-flags (admin only)
- 503 guards on POST /api/ads, /api/special-tasks, /api/marketplace
- Empty-list behaviour on GET /api/ads when disabled
- Persistence across supervisor restart
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://spiloveure-deploy.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"

ALL_KEYS = {
    "landing_page", "ads", "ads_create_video", "ads_create_poster",
    "special_tasks", "marketplace", "marketplace_publish",
    "service_request", "paid_tasks",
}


# ─── Fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=15)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"No token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def user_token():
    """Register a fresh test user (or reuse). Needed for user-scoped endpoints."""
    import uuid as _u
    suffix = _u.uuid4().hex[:8]
    email = f"TEST_ff_{suffix}@example.com"
    password = "Passw0rd!"
    payload = {
        "username": f"testff{suffix}",
        "email": email,
        "password": password,
        "password_confirm": password,
        "country": "TG",
        "phone": f"+228{suffix[:8]}",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    if r.status_code not in (200, 201):
        pytest.skip(f"Register failed: {r.status_code} {r.text[:200]}")
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"User login failed: {r.status_code} {r.text[:200]}")
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def user_headers(user_token):
    return {"Authorization": f"Bearer {user_token}"}


def _set_flag(admin_headers, key, enabled):
    r = requests.put(f"{API}/admin/feature-flags/{key}",
                     json={"enabled": enabled}, headers=admin_headers, timeout=10)
    assert r.status_code == 200, f"Set flag {key}={enabled} failed: {r.status_code} {r.text}"
    return r.json()


def _get_flag(key):
    r = requests.get(f"{API}/features", timeout=10)
    assert r.status_code == 200
    return r.json()["features"][key]


# ─── Public catalog ──────────────────────────────────────────────────────────
class TestPublicFeatures:
    def test_public_features_returns_all_keys(self):
        r = requests.get(f"{API}/features", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert "features" in body
        feats = body["features"]
        assert set(feats.keys()) == ALL_KEYS
        for k, v in feats.items():
            assert isinstance(v, bool), f"{k} value not bool"

    def test_public_features_no_auth_required(self):
        # Must work without an Authorization header
        r = requests.get(f"{API}/features", timeout=10)
        assert r.status_code == 200


# ─── Admin catalog & auth ────────────────────────────────────────────────────
class TestAdminFeatureFlags:
    def test_unauthenticated_gets_401_or_403(self):
        r = requests.get(f"{API}/admin/feature-flags", timeout=10)
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"

    def test_non_admin_gets_403(self, user_headers):
        r = requests.get(f"{API}/admin/feature-flags", headers=user_headers, timeout=10)
        assert r.status_code == 403

    def test_admin_lists_all_flags(self, admin_headers):
        r = requests.get(f"{API}/admin/feature-flags", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        items = r.json()["items"]
        keys = {it["key"] for it in items}
        assert keys == ALL_KEYS
        # Every item has expected fields
        for it in items:
            assert "label" in it and "category" in it and "enabled" in it
            assert isinstance(it["enabled"], bool)

    def test_put_unknown_key_returns_404(self, admin_headers):
        r = requests.put(f"{API}/admin/feature-flags/does_not_exist",
                         json={"enabled": True}, headers=admin_headers, timeout=10)
        assert r.status_code == 404

    def test_toggle_persists(self, admin_headers):
        # Toggle service_request ON then verify via GET, then OFF
        _set_flag(admin_headers, "service_request", True)
        assert _get_flag("service_request") is True
        _set_flag(admin_headers, "service_request", False)
        assert _get_flag("service_request") is False


# ─── Enforcement: Ads ────────────────────────────────────────────────────────
class TestAdsGuards:
    def test_ads_off_post_returns_503(self, admin_headers, user_headers):
        _set_flag(admin_headers, "ads", False)
        r = requests.post(f"{API}/ads", headers=user_headers,
                          json={"cover_image_url": "http://x/y.jpg",
                                "description": "test",
                                "media_type": "video"},
                          timeout=10)
        assert r.status_code == 503
        assert "Publicité" in r.text or "publicit" in r.text.lower()

    def test_ads_off_get_returns_empty_list(self, admin_headers, user_headers):
        _set_flag(admin_headers, "ads", False)
        r = requests.get(f"{API}/ads", headers=user_headers, timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body.get("items") == [] or body.get("items") is not None
        assert body["items"] == []

    def test_ads_on_but_video_off_returns_503(self, admin_headers, user_headers):
        _set_flag(admin_headers, "ads", True)
        _set_flag(admin_headers, "ads_create_video", False)
        r = requests.post(f"{API}/ads", headers=user_headers,
                          json={"cover_image_url": "http://x/y.jpg",
                                "description": "test",
                                "video_url": "http://x/y.mp4",
                                "media_type": "video"},
                          timeout=10)
        assert r.status_code == 503
        assert "vidéo" in r.text.lower() or "video" in r.text.lower()

    def test_ads_on_and_video_on_creates_draft(self, admin_headers, user_headers):
        _set_flag(admin_headers, "ads", True)
        _set_flag(admin_headers, "ads_create_video", True)
        r = requests.post(f"{API}/ads", headers=user_headers,
                          json={"cover_image_url": "http://x/y.jpg",
                                "description": "test draft",
                                "video_url": "http://x/y.mp4",
                                "media_type": "video"},
                          timeout=10)
        assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
        data = r.json()
        assert data.get("status") == "draft"
        assert data.get("id")


# ─── Enforcement: Special Tasks ──────────────────────────────────────────────
class TestSpecialTasksGuard:
    def test_special_tasks_off_returns_503(self, admin_headers, user_headers):
        _set_flag(admin_headers, "special_tasks", False)
        r = requests.post(f"{API}/special-tasks", headers=user_headers,
                          json={"action_type": "video", "network": "tiktok",
                                "link": "https://tiktok.com/abcd",
                                "description": "d"},
                          timeout=10)
        assert r.status_code == 503


# ─── Enforcement: Marketplace ────────────────────────────────────────────────
class TestMarketplaceGuards:
    def test_marketplace_off_returns_503(self, admin_headers, user_headers):
        _set_flag(admin_headers, "marketplace", False)
        _set_flag(admin_headers, "marketplace_publish", False)
        r = requests.post(f"{API}/marketplace", headers=user_headers,
                          json={"images": ["http://x/a.jpg"], "name": "Prod",
                                "category": "Elec", "price": 1000,
                                "city": "Lome", "whatsapp": "+22890000000",
                                "description": "d"},
                          timeout=10)
        assert r.status_code == 503

    def test_marketplace_publish_off_returns_503(self, admin_headers, user_headers):
        _set_flag(admin_headers, "marketplace", True)
        _set_flag(admin_headers, "marketplace_publish", False)
        r = requests.post(f"{API}/marketplace", headers=user_headers,
                          json={"images": ["http://x/a.jpg"], "name": "Prod",
                                "category": "Elec", "price": 1000,
                                "city": "Lome", "whatsapp": "+22890000000",
                                "description": "d"},
                          timeout=10)
        assert r.status_code == 503


# ─── Persistence across restart ──────────────────────────────────────────────
class TestPersistenceAcrossRestart:
    def test_flags_survive_restart(self, admin_headers):
        # Set a distinctive combo
        _set_flag(admin_headers, "paid_tasks", True)
        _set_flag(admin_headers, "landing_page", True)
        # Restart backend via supervisor
        import subprocess, time
        subprocess.run(["sudo", "supervisorctl", "restart", "backend"],
                       check=False, capture_output=True)
        # Wait for it to come back up
        deadline = time.time() + 40
        ok = False
        while time.time() < deadline:
            try:
                r = requests.get(f"{API}/features", timeout=3)
                if r.status_code == 200:
                    ok = True
                    break
            except Exception:
                pass
            time.sleep(1.5)
        assert ok, "Backend did not come back up after restart"
        # Now assert the flags are still what we set
        r = requests.get(f"{API}/features", timeout=10)
        feats = r.json()["features"]
        assert feats["paid_tasks"] is True
        assert feats["landing_page"] is True


# ─── Cleanup: LEAVE all flags OFF at end of testing (per request) ───────────
@pytest.fixture(scope="module", autouse=True)
def _reset_flags_at_end(admin_headers):
    yield
    for k in ALL_KEYS:
        try:
            requests.put(f"{API}/admin/feature-flags/{k}",
                         json={"enabled": False}, headers=admin_headers, timeout=10)
        except Exception:
            pass
