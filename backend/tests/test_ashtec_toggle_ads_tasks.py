"""When ashtec_enabled=False, ads and special-tasks mobile_money payments
must also propagate 503 (they delegate to create_ashtec_payment).
Also asserts /api/settings/payments exposes both ashtec_enabled + soleas_enabled.
"""
from __future__ import annotations
import os, uuid, pytest, requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def db():
    with open("/app/backend/.env") as f:
        env = dict(l.strip().split("=", 1) for l in f
                   if "=" in l and not l.strip().startswith("#"))
    c = MongoClient(env["MONGO_URL"])
    yield c[env["DB_NAME"]]


@pytest.fixture(scope="module", autouse=True)
def _restore(db):
    yield
    db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"value.ashtec_enabled": True,
                  "value.ashtec_api_key": "ak_4f0ad8d22b219201d07040dfe5074bbc8839e457d65e99c1",
                  "key": "payment_gateway"}},
        upsert=True,
    )


def _set_ashtec(db, enabled: bool):
    db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"value.ashtec_enabled": enabled,
                  "value.ashtec_api_key": "ak_test_dummy",
                  "key": "payment_gateway"}},
        upsert=True,
    )


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={
        "email": "kossikotokou4@gmail.com", "password": "@Emma91972006",
    }, timeout=15)
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def new_user():
    s = uuid.uuid4().hex[:8]
    r = requests.post(f"{API}/auth/register", json={
        "username": f"togad{s}", "email": f"TEST_togad_{s}@example.com",
        "password": "Passw0rd!123", "password_confirm": "Passw0rd!123",
        "phone": f"+228902{s[:5]}", "country": "TG",
        "sponsor_username": "admin", "accept_terms": True,
    }, timeout=15)
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def draft_ad(new_user, admin_headers):
    for flag in ("ads", "ads_create_poster"):
        requests.put(f"{API}/admin/feature-flags/{flag}",
                     json={"enabled": True}, headers=admin_headers, timeout=15)
    requests.put(f"{API}/admin/ads/pricing",
                 json={"price_per_day": 500, "min_days": 1, "max_days": 30},
                 headers=admin_headers, timeout=15)
    r = requests.post(f"{API}/ads", headers=new_user, json={
        "media_type": "poster", "cover_image_url": "https://example.com/x.jpg",
        "description": "toggle test",
    }, timeout=15)
    ad_id = r.json()["id"]
    requests.put(f"{API}/ads/{ad_id}/audience", headers=new_user, json={
        "target_countries": ["TG"], "target_age_min": 18, "target_age_max": 60,
        "target_gender": "any"}, timeout=15)
    requests.put(f"{API}/ads/{ad_id}/duration", headers=new_user,
                 json={"duration_days": 3}, timeout=15)
    requests.post(f"{API}/ads/{ad_id}/publish", headers=new_user, timeout=15)
    return ad_id


@pytest.fixture(scope="module")
def draft_task(new_user, admin_headers):
    requests.put(f"{API}/admin/feature-flags/special_tasks",
                 json={"enabled": True}, headers=admin_headers, timeout=15)
    requests.put(f"{API}/admin/special-tasks/config",
                 json={"action_types": {"video": {
                     "enabled": True, "reward_per_action": 10,
                     "min_qty": 5, "max_qty": 100}},
                     "distribution_percentage": 50},
                 headers=admin_headers, timeout=15)
    r = requests.post(f"{API}/special-tasks", headers=new_user, json={
        "action_type": "video", "network": "tiktok",
        "link": "https://tiktok.com/@x/video/9", "description": "t"}, timeout=15)
    tid = r.json()["id"]
    requests.put(f"{API}/special-tasks/{tid}/audience", headers=new_user, json={
        "target_countries": ["TG"], "target_age_min": 18, "target_age_max": 60,
        "target_gender": "both"}, timeout=15)
    requests.put(f"{API}/special-tasks/{tid}/quantity", headers=new_user,
                 json={"quantity": 10}, timeout=15)
    requests.post(f"{API}/special-tasks/{tid}/publish", headers=new_user, timeout=15)
    return tid


def test_ads_mobile_money_blocked_when_ashtec_off(db, new_user, draft_ad):
    _set_ashtec(db, False)
    r = requests.post(f"{API}/ads/{draft_ad}/pay", headers=new_user, json={
        "method": "mobile_money", "country_code": "TG",
        "operator": "T-Money", "phone": "70000000"}, timeout=15)
    assert r.status_code == 503, r.text[:200]
    assert "désactivé" in r.json()["detail"].lower()


def test_task_mobile_money_blocked_when_ashtec_off(db, new_user, draft_task):
    _set_ashtec(db, False)
    r = requests.post(f"{API}/special-tasks/{draft_task}/pay",
                      headers=new_user,
                      json={"method": "mobile_money", "country_code": "TG",
                            "operator": "T-Money", "phone": "70000000"},
                      timeout=15)
    assert r.status_code == 503, r.text[:200]
    assert "désactivé" in r.json()["detail"].lower()


def test_settings_payments_exposes_soleas_enabled(db):
    _set_ashtec(db, True)
    r = requests.get(f"{API}/settings/payments", timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert "ashtec_enabled" in d
    assert "soleas_enabled" in d
    assert isinstance(d["ashtec_enabled"], bool)
    assert isinstance(d["soleas_enabled"], bool)
