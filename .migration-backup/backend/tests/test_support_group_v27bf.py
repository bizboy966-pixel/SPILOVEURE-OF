# Groupe d'accompagnement — leader CRUD, URL validation, invitation popup lifecycle
import os
from datetime import datetime, timezone, timedelta

import pytest
import requests
from pymongo import MongoClient


def _env(path, key):
    for line in open(path):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')


BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _env("/app/frontend/.env", "REACT_APP_BACKEND_URL")).rstrip("/")
MONGO_URL = _env("/app/backend/.env", "MONGO_URL")
DB_NAME = _env("/app/backend/.env", "DB_NAME")
db = MongoClient(MONGO_URL)[DB_NAME]

LEADER = ("testactif@spilovere.com", "TestActif2026!")
ACTIF = ("filleul.actif@spilovere.com", "Filleul2026!")
PENDING = ("filleul.attente@spilovere.com", "Filleul2026!")
ADMIN = ("kossikotokou4@gmail.com", "@Emma91972006")


def login(creds):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": creds[0], "password": creds[1]}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"login failed {creds[0]}: {r.status_code}")
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
    s.user = r.json()["user"]
    return s


@pytest.fixture(scope="module")
def leader():
    return login(LEADER)


@pytest.fixture(scope="module")
def actif():
    return login(ACTIF)


@pytest.fixture(scope="module", autouse=True)
def restore(leader):
    orig = db.support_groups.find_one({"leader_id": leader.user["id"]}, {"_id": 0})
    db.support_group_invites.delete_many({})
    yield
    db.support_group_invites.delete_many({})
    leader.put(f"{BASE_URL}/api/me/support-group", json={"url": (orig or {}).get("url") or "https://t.me/+NouveauGroupe"})


# --- auth
def test_requires_auth():
    for m, p in [("get", "/api/me/support-group"), ("put", "/api/me/support-group"), ("delete", "/api/me/support-group"),
                 ("get", "/api/me/support-group/invite")]:
        r = getattr(requests, m)(f"{BASE_URL}{p}", json={"url": "https://t.me/x"}, timeout=20)
        assert r.status_code in (401, 403), (p, r.status_code)


# --- URL validation
@pytest.mark.parametrize("bad", [
    "http://t.me/x", "javascript:alert(1)", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x",
    "https://user@t.me/x", "https://t.me/a b", "https://t.me/" + "a" * 600, "", "https://nodot", "ftp://t.me/x",
    "https://t.me/<script>",
])
def test_url_validation_rejects(leader, bad):
    r = leader.put(f"{BASE_URL}/api/me/support-group", json={"url": bad})
    assert r.status_code in (400, 422), (bad, r.status_code, r.text)


# --- CRUD + isolation
def test_crud_and_isolation(leader, actif):
    r = leader.put(f"{BASE_URL}/api/me/support-group", json={"url": "  https://chat.whatsapp.com/TEST_abc  "})
    assert r.status_code == 200 and r.json()["url"] == "https://chat.whatsapp.com/TEST_abc"
    g = leader.get(f"{BASE_URL}/api/me/support-group").json()
    assert g["url"] == "https://chat.whatsapp.com/TEST_abc" and g["updated_at"]
    # filleul sees own (none), not leader's
    assert actif.get(f"{BASE_URL}/api/me/support-group").json()["url"] is None
    assert leader.delete(f"{BASE_URL}/api/me/support-group").status_code == 200
    assert leader.get(f"{BASE_URL}/api/me/support-group").json()["url"] is None


# --- invite visibility
def test_invite_visibility(leader, actif):
    assert actif.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False  # no group
    leader.put(f"{BASE_URL}/api/me/support-group", json={"url": "https://t.me/+TEST_v1"})
    inv = actif.get(f"{BASE_URL}/api/me/support-group/invite").json()
    assert inv["show"] is True and inv["url"] == "https://t.me/+TEST_v1" and inv["leader_username"] == "testactif"
    assert isinstance(inv["version"], str)
    pend = login(PENDING)
    assert pend.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False
    # leader's own sponsor (admin) has no group
    assert leader.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False
    adm = login(ADMIN)
    assert adm.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False


def test_pending_cannot_record(leader):
    v = db.support_groups.find_one({"leader_id": leader.user["id"]})["version"]
    pend = login(PENDING)
    r = pend.post(f"{BASE_URL}/api/me/support-group/invite/opened", json={"version": v})
    assert r.status_code == 404


def test_same_url_keeps_version(leader):
    v1 = db.support_groups.find_one({"leader_id": leader.user["id"]})["version"]
    leader.put(f"{BASE_URL}/api/me/support-group", json={"url": "https://t.me/+TEST_v1"})
    assert db.support_groups.find_one({"leader_id": leader.user["id"]})["version"] == v1


def test_later_then_24h(leader, actif):
    inv = actif.get(f"{BASE_URL}/api/me/support-group/invite").json()
    r = actif.post(f"{BASE_URL}/api/me/support-group/invite/later", json={"version": inv["version"]})
    assert r.status_code == 200 and r.json()["status"] == "postponed" and r.json()["remind_after_hours"] == 24
    assert actif.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False
    db.support_group_invites.update_one({"user_id": actif.user["id"], "version": inv["version"]},
                                        {"$set": {"postponed_at": datetime.now(timezone.utc) - timedelta(hours=23)}})
    assert actif.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False
    db.support_group_invites.update_one({"user_id": actif.user["id"], "version": inv["version"]},
                                        {"$set": {"postponed_at": datetime.now(timezone.utc) - timedelta(hours=25)}})
    assert actif.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is True


def test_opened_permanent_and_new_version(leader, actif):
    inv = actif.get(f"{BASE_URL}/api/me/support-group/invite").json()
    assert actif.post(f"{BASE_URL}/api/me/support-group/invite/opened", json={"version": "wrong"}).status_code == 404
    r = actif.post(f"{BASE_URL}/api/me/support-group/invite/opened", json={"version": inv["version"]})
    assert r.status_code == 200 and r.json()["status"] == "link_opened"
    assert actif.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False
    # later after opened should not resurrect? (records postponed overriding link_opened)
    doc = db.support_group_invites.find_one({"user_id": actif.user["id"], "version": inv["version"]})
    assert doc["status"] == "link_opened" and doc["opened_at"]
    leader.put(f"{BASE_URL}/api/me/support-group", json={"url": "https://t.me/+TEST_v2"})
    inv2 = actif.get(f"{BASE_URL}/api/me/support-group/invite").json()
    assert inv2["show"] is True and inv2["version"] != inv["version"] and inv2["url"] == "https://t.me/+TEST_v2"
    assert actif.post(f"{BASE_URL}/api/me/support-group/invite/later", json={"version": inv["version"]}).status_code == 404


def test_delete_group_hides_invite(leader, actif):
    leader.delete(f"{BASE_URL}/api/me/support-group")
    assert actif.get(f"{BASE_URL}/api/me/support-group/invite").json()["show"] is False
