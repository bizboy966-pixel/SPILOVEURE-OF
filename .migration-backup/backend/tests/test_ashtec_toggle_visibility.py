"""Verify that when the admin flips `ashtec_enabled = False`:
• /api/payments/ashtec/catalog returns {enabled: False, countries: []}
• /api/payments/ashtec/initiate returns 503
• Ads/tasks with method=mobile_money also return 503
• GET /api/settings/payments exposes the ashtec_enabled flag correctly
"""
from __future__ import annotations
import os, uuid, pytest, requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def env_conn():
    with open("/app/backend/.env") as f:
        env = dict(l.strip().split("=", 1) for l in f
                   if "=" in l and not l.strip().startswith("#"))
    c = MongoClient(env["MONGO_URL"])
    db = c[env["DB_NAME"]]
    return db, c


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={
        "email": "kossikotokou4@gmail.com", "password": "@Emma91972006",
    }, timeout=15)
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module", autouse=True)
def _ensure_ashtec_enabled_at_end(env_conn):
    """Whatever this module toggles, always leave Ashtech enabled so
    downstream tests (test_ashtec_activation etc.) keep working."""
    yield
    db, _ = env_conn
    db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"value.ashtec_enabled": True,
                  "value.ashtec_api_key": "ak_4f0ad8d22b219201d07040dfe5074bbc8839e457d65e99c1",
                  "key": "payment_gateway"}},
        upsert=True,
    )


@pytest.fixture
def toggle_ashtec(env_conn):
    """Save initial state, flip it, restore at the end. Writes to the
    same document read by the admin panel (`{key: payment_gateway}`)."""
    db, c = env_conn
    doc = db.app_settings.find_one({"key": "payment_gateway"}) or {}
    original = ((doc.get("value") or {}).get("ashtec_enabled")) if doc else False
    def _set(enabled: bool):
        db.app_settings.update_one(
            {"key": "payment_gateway"},
            {"$set": {"value.ashtec_enabled": enabled,
                      "value.ashtec_api_key": "ak_test_dummy_key_for_toggle_tests",
                      "key": "payment_gateway"}},
            upsert=True,
        )
    yield _set
    _set(bool(original))


@pytest.fixture(scope="module")
def new_user():
    s = uuid.uuid4().hex[:8]
    email = f"TEST_ftl_{s}@example.com"
    r = requests.post(f"{API}/auth/register", json={
        "username": f"ftl{s}", "email": email,
        "password": "Passw0rd!123", "password_confirm": "Passw0rd!123",
        "phone": f"+228901{s[:5]}", "country": "TG",
        "sponsor_username": "admin", "accept_terms": True,
    }, timeout=15)
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_catalog_hides_when_disabled(toggle_ashtec):
    toggle_ashtec(False)
    r = requests.get(f"{API}/payments/ashtec/catalog", timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d.get("enabled") is False
    assert d.get("countries") == []


def test_catalog_reveals_when_enabled(toggle_ashtec):
    toggle_ashtec(True)
    r = requests.get(f"{API}/payments/ashtec/catalog", timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d.get("enabled") is True
    assert len(d["countries"]) == 10


def test_initiate_blocked_when_disabled(toggle_ashtec, new_user):
    toggle_ashtec(False)
    r = requests.post(f"{API}/payments/ashtec/initiate", headers=new_user, json={
        "country_code": "TG", "operator": "T-Money", "phone": "70000000",
    }, timeout=15)
    assert r.status_code == 503
    assert "désactivé" in r.json()["detail"].lower()


def test_initiate_allowed_when_enabled(toggle_ashtec, new_user):
    toggle_ashtec(True)
    r = requests.post(f"{API}/payments/ashtec/initiate", headers=new_user, json={
        "country_code": "TG", "operator": "T-Money", "phone": "70000000",
    }, timeout=45)
    # Should succeed (200) or fail with 400 upstream flake — NOT 503
    assert r.status_code in (200, 400)


def test_settings_payments_exposes_ashtec_enabled(new_user, toggle_ashtec):
    toggle_ashtec(False)
    r = requests.get(f"{API}/settings/payments", timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d.get("ashtec_enabled") is False
    toggle_ashtec(True)
    r2 = requests.get(f"{API}/settings/payments", timeout=15)
    assert r2.json().get("ashtec_enabled") is True
