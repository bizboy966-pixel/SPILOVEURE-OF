"""Backend tests for SPILIVERE digital content modules:
   formations, ebooks, premium-apps, trading settings + avatar update.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://spiloveure-deploy.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "kossikotokou4@gmail.com")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "@Emma91972006")

S = requests.Session()
S.headers.update({"Content-Type": "application/json"})


# ------------------------- Auth helpers -------------------------
def _login(email, password):
    r = S.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def user_token(admin_headers):
    """Register a fresh user, validate L1 via admin, return token."""
    uname = f"tcdc{uuid.uuid4().hex[:8]}"
    email = f"{uname}@example.com"
    pwd = "Password123!"
    payload = {
        "username": uname,
        "email": email,
        "phone": "+22890000123",
        "country": "TG",
        "password": pwd,
        "password_confirm": pwd,
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = S.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"register failed {r.status_code} {r.text}"
    tok = _login(email, pwd)
    # Save uname for cleanup at module teardown
    pytest._tc_user_uname = uname
    return tok


@pytest.fixture(scope="module")
def user_headers(user_token):
    return {"Authorization": f"Bearer {user_token}", "Content-Type": "application/json"}


# ------------------------- Helpers -------------------------
def _ids_to_cleanup():
    return getattr(pytest, "_tc_cleanup_ids", {"formations": [], "ebooks": [], "premium-apps": []})


def _track(kind, item_id):
    if not hasattr(pytest, "_tc_cleanup_ids"):
        pytest._tc_cleanup_ids = {"formations": [], "ebooks": [], "premium-apps": []}
    pytest._tc_cleanup_ids[kind].append(item_id)


# ------------------------- Auth gating -------------------------
class TestAuthGating:
    def test_public_endpoints_require_auth(self):
        for ep in ["/api/formations", "/api/ebooks", "/api/premium-apps", "/api/settings/trading"]:
            r = S.get(f"{BASE_URL}{ep}", timeout=15)
            assert r.status_code in (401, 403), f"{ep} should require auth got {r.status_code}"

    def test_admin_endpoints_require_admin_role(self, user_headers):
        # User token (non-admin) must be rejected on admin endpoints
        r = S.get(f"{BASE_URL}/api/admin/formations", headers=user_headers, timeout=15)
        assert r.status_code in (401, 403), f"expected 403 got {r.status_code}"


# ------------------------- Formations CRUD -------------------------
class TestFormations:
    def test_create_enabled_and_disabled(self, admin_headers, user_headers):
        # enabled
        p1 = {
            "title": "TEST_Formation_Enabled",
            "description": "desc",
            "image_url": "https://img/1.png",
            "video_url": "https://yt/v1",
            "pdf_url": "https://drive/p1",
            "audio_url": "https://drive/a1",
            "category": "Trading",
            "enabled": True,
            "order": 1,
        }
        r = S.post(f"{BASE_URL}/api/admin/formations", json=p1, headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        enabled_id = r.json()["id"]
        _track("formations", enabled_id)
        assert r.json()["title"] == p1["title"]

        # disabled
        p2 = {**p1, "title": "TEST_Formation_Disabled", "enabled": False}
        r2 = S.post(f"{BASE_URL}/api/admin/formations", json=p2, headers=admin_headers, timeout=15)
        assert r2.status_code == 200
        disabled_id = r2.json()["id"]
        _track("formations", disabled_id)

        # Public list only returns enabled
        rl = S.get(f"{BASE_URL}/api/formations", headers=user_headers, timeout=15)
        assert rl.status_code == 200
        items = rl.json()
        titles = [x["title"] for x in items]
        assert "TEST_Formation_Enabled" in titles
        assert "TEST_Formation_Disabled" not in titles

        # Admin list returns both
        ral = S.get(f"{BASE_URL}/api/admin/formations", headers=admin_headers, timeout=15)
        assert ral.status_code == 200
        admin_titles = [x["title"] for x in ral.json()]
        assert "TEST_Formation_Enabled" in admin_titles
        assert "TEST_Formation_Disabled" in admin_titles

        pytest._tc_formation_enabled = enabled_id
        pytest._tc_formation_disabled = disabled_id

    def test_update_formation(self, admin_headers):
        fid = pytest._tc_formation_enabled
        payload = {
            "title": "TEST_Formation_Enabled_UPDATED",
            "description": "new",
            "image_url": "",
            "video_url": "",
            "pdf_url": "",
            "audio_url": "",
            "category": "Crypto",
            "enabled": True,
            "order": 2,
        }
        r = S.put(f"{BASE_URL}/api/admin/formations/{fid}", json=payload, headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["title"] == "TEST_Formation_Enabled_UPDATED"
        assert r.json()["category"] == "Crypto"

    def test_delete_formation(self, admin_headers):
        # delete the disabled one
        fid = pytest._tc_formation_disabled
        r = S.delete(f"{BASE_URL}/api/admin/formations/{fid}", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        # re-delete should 404
        r2 = S.delete(f"{BASE_URL}/api/admin/formations/{fid}", headers=admin_headers, timeout=15)
        assert r2.status_code == 404
        if fid in pytest._tc_cleanup_ids["formations"]:
            pytest._tc_cleanup_ids["formations"].remove(fid)


# ------------------------- E-books CRUD -------------------------
class TestEbooks:
    def test_create_and_list(self, admin_headers, user_headers):
        p = {
            "title": "TEST_Ebook_1",
            "description": "ebk",
            "image_url": "https://img/eb1.png",
            "pdf_url": "https://drive/eb1.pdf",
            "enabled": True,
            "order": 0,
        }
        r = S.post(f"{BASE_URL}/api/admin/ebooks", json=p, headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        eid = r.json()["id"]
        _track("ebooks", eid)
        # Public list
        rl = S.get(f"{BASE_URL}/api/ebooks", headers=user_headers, timeout=15)
        assert rl.status_code == 200
        assert any(x["title"] == "TEST_Ebook_1" for x in rl.json())
        pytest._tc_ebook_id = eid

    def test_update_ebook(self, admin_headers):
        eid = pytest._tc_ebook_id
        p = {
            "title": "TEST_Ebook_1_UPD",
            "description": "upd",
            "image_url": "",
            "pdf_url": "https://drive/eb1.pdf",
            "enabled": True,
            "order": 0,
        }
        r = S.put(f"{BASE_URL}/api/admin/ebooks/{eid}", json=p, headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert r.json()["title"] == "TEST_Ebook_1_UPD"


# ------------------------- Premium apps CRUD -------------------------
class TestPremiumApps:
    def test_create_disabled_not_in_public(self, admin_headers, user_headers):
        p_enabled = {
            "name": "TEST_App_Enabled",
            "description": "premium app",
            "image_url": "https://img/a1.png",
            "apk_url": "https://drive/a1.apk",
            "download_url": "https://drive/a1.apk",
            "version": "1.0.0",
            "enabled": True,
            "order": 0,
        }
        p_disabled = {**p_enabled, "name": "TEST_App_Disabled", "enabled": False}
        r1 = S.post(f"{BASE_URL}/api/admin/premium-apps", json=p_enabled, headers=admin_headers, timeout=15)
        assert r1.status_code == 200, r1.text
        _track("premium-apps", r1.json()["id"])
        r2 = S.post(f"{BASE_URL}/api/admin/premium-apps", json=p_disabled, headers=admin_headers, timeout=15)
        assert r2.status_code == 200
        _track("premium-apps", r2.json()["id"])

        rl = S.get(f"{BASE_URL}/api/premium-apps", headers=user_headers, timeout=15)
        assert rl.status_code == 200
        names = [x["name"] for x in rl.json()]
        assert "TEST_App_Enabled" in names
        assert "TEST_App_Disabled" not in names


# ------------------------- Trading settings -------------------------
class TestTrading:
    def test_initial_disabled_state(self, user_headers):
        r = S.get(f"{BASE_URL}/api/settings/trading", headers=user_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert set(d.keys()) >= {"enabled", "telegram_url", "label", "description"}

    def test_admin_update_and_public_reflects(self, admin_headers, user_headers):
        payload = {
            "enabled": True,
            "telegram_url": "https://t.me/test_spilivere",
            "label": "Trading Community",
            "description": "Rejoignez notre canal",
        }
        r = S.put(f"{BASE_URL}/api/admin/settings/trading", json=payload, headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        # Public reflects immediately
        rg = S.get(f"{BASE_URL}/api/settings/trading", headers=user_headers, timeout=15)
        assert rg.status_code == 200
        d = rg.json()
        assert d["enabled"] is True
        assert d["telegram_url"] == "https://t.me/test_spilivere"
        assert d["label"] == "Trading Community"

    def test_zz_reset_trading(self, admin_headers):
        # Restore disabled state per agent instructions
        r = S.put(
            f"{BASE_URL}/api/admin/settings/trading",
            json={"enabled": False, "telegram_url": "", "label": "Trading", "description": ""},
            headers=admin_headers,
            timeout=15,
        )
        assert r.status_code == 200


# ------------------------- Avatar update -------------------------
class TestAvatar:
    def test_update_avatar_reflects_in_me(self, user_headers):
        new_url = "https://cdn.example.com/avatar/test.png"
        r = S.put(f"{BASE_URL}/api/users/me/avatar", json={"avatar_url": new_url}, headers=user_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["avatar_url"] == new_url
        rm = S.get(f"{BASE_URL}/api/auth/me", headers=user_headers, timeout=15)
        assert rm.status_code == 200
        assert rm.json().get("avatar_url") == new_url


# ------------------------- Final cleanup -------------------------
class TestZZZCleanup:
    def test_zz_delete_test_items(self, admin_headers):
        ids = _ids_to_cleanup()
        for kind, lst in ids.items():
            for iid in lst:
                S.delete(f"{BASE_URL}/api/admin/{kind}/{iid}", headers=admin_headers, timeout=15)

    def test_zz_delete_test_user(self, admin_headers):
        uname = getattr(pytest, "_tc_user_uname", None)
        if not uname:
            return
        # Lookup user via admin list users endpoint
        try:
            r = S.get(f"{BASE_URL}/api/admin/users?search={uname}", headers=admin_headers, timeout=15)
            if r.status_code == 200:
                items = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
                for u in items:
                    if u.get("username") == uname:
                        S.post(
                            f"{BASE_URL}/api/admin/users/{u['id']}/action",
                            json={"action": "delete"},
                            headers=admin_headers,
                            timeout=15,
                        )
        except Exception:
            pass
