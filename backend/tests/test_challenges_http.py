"""HTTP integration tests for the Challenge feature (iteration 19).

Exercises the full stack via the preview URL:
- POST /api/admin/challenges  (create + auto de-activate previous)
- PUT  /api/admin/challenges/{id}  (update + reject end<=start)
- DELETE /api/admin/challenges/{id}
- GET  /api/challenges/current  (no-challenge state + progress with time window)
- GET  /api/admin/challenges/{id}/participants

Progress counting rules are validated by directly manipulating
`users.level_activated_at.1` in Mongo (as suggested by the main agent).
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") if os.environ.get("REACT_APP_BACKEND_URL") else "https://jobs-badges-fix.preview.emergentagent.com"
# Fallback to frontend/.env if backend .env doesn't have REACT_APP_BACKEND_URL
if "preview" not in BASE_URL and "spiloveure" not in BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


# ------------------------------------------------------------------ fixtures
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def db():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


@pytest.fixture(scope="session")
def admin_user_id(db):
    u = db.users.find_one({"email": ADMIN_EMAIL})
    assert u, "admin user not found in DB"
    return u["id"]


@pytest.fixture
def cleanup_challenges(db, admin_headers):
    """Snapshot pre-existing challenges & purge TEST_ ones after each test."""
    created_ids: list[str] = []
    yield created_ids
    for cid in created_ids:
        try:
            requests.delete(f"{BASE_URL}/api/admin/challenges/{cid}",
                            headers=admin_headers, timeout=15)
        except Exception:
            pass
    # also clean any leftover TEST_ challenges just in case
    db.challenges.delete_many({"name": {"$regex": "^TEST_"}})


@pytest.fixture
def cleanup_users(db):
    ids: list[str] = []
    yield ids
    if ids:
        db.users.delete_many({"id": {"$in": ids}})


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


# ------------------------------------------------------------------ tests
class TestChallengeCRUD:
    """CRUD on /api/admin/challenges"""

    def test_create_challenge(self, admin_headers, cleanup_challenges):
        now = datetime.now(timezone.utc)
        payload = {
            "name": "TEST_create",
            "target": 100,
            "reward_amount": 30000,
            "reward_currency": "FCFA",
            "start_at": _iso(now - timedelta(days=1)),
            "end_at": _iso(now + timedelta(days=30)),
            "active": False,  # keep inactive so we don't disturb the seed one
        }
        r = requests.post(f"{BASE_URL}/api/admin/challenges",
                          json=payload, headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "id" in data
        assert data["name"] == "TEST_create"
        assert data["target"] == 100
        assert data["reward_amount"] == 30000
        assert data["reward_currency"] == "FCFA"
        assert data["active"] is False
        cleanup_challenges.append(data["id"])

    def test_create_active_deactivates_previous(self, admin_headers, cleanup_challenges, db):
        now = datetime.now(timezone.utc)
        # Snapshot currently-active challenges so we can restore them after the test.
        pre_active_ids = [d["id"] for d in db.challenges.find({"active": True})]

        # First active challenge
        p1 = {"name": "TEST_active_1", "target": 10, "reward_amount": 1000,
              "reward_currency": "FCFA",
              "start_at": _iso(now - timedelta(days=1)),
              "end_at": _iso(now + timedelta(days=10)), "active": True}
        r1 = requests.post(f"{BASE_URL}/api/admin/challenges", json=p1,
                           headers=admin_headers, timeout=15)
        assert r1.status_code == 200
        c1 = r1.json(); cleanup_challenges.append(c1["id"])
        # Second active challenge — should deactivate c1
        p2 = {**p1, "name": "TEST_active_2"}
        r2 = requests.post(f"{BASE_URL}/api/admin/challenges", json=p2,
                           headers=admin_headers, timeout=15)
        assert r2.status_code == 200
        c2 = r2.json(); cleanup_challenges.append(c2["id"])
        assert c2["active"] is True

        # Verify only one active in DB
        actives = list(db.challenges.find({"active": True}))
        active_ids = [a["id"] for a in actives]
        assert c1["id"] not in active_ids, "previous active challenge was NOT deactivated"
        assert c2["id"] in active_ids

        # Restore pre-existing active challenges (e.g. seed challenge).
        if pre_active_ids:
            db.challenges.update_many({"id": {"$in": pre_active_ids}}, {"$set": {"active": False}})
            # Only re-activate the most recent one (only-one-active rule).
            db.challenges.update_one({"id": pre_active_ids[0]}, {"$set": {"active": True}})

    def test_update_rejects_end_before_start(self, admin_headers, cleanup_challenges):
        now = datetime.now(timezone.utc)
        r = requests.post(f"{BASE_URL}/api/admin/challenges",
                          json={"name": "TEST_upd", "target": 5, "reward_amount": 100,
                                "reward_currency": "FCFA",
                                "start_at": _iso(now), "end_at": _iso(now + timedelta(days=5)),
                                "active": False},
                          headers=admin_headers, timeout=15)
        assert r.status_code == 200
        cid = r.json()["id"]; cleanup_challenges.append(cid)

        r2 = requests.put(f"{BASE_URL}/api/admin/challenges/{cid}",
                          json={"end_at": _iso(now - timedelta(days=1))},
                          headers=admin_headers, timeout=15)
        assert r2.status_code == 400, r2.text

    def test_update_ok(self, admin_headers, cleanup_challenges):
        now = datetime.now(timezone.utc)
        r = requests.post(f"{BASE_URL}/api/admin/challenges",
                          json={"name": "TEST_upd2", "target": 5, "reward_amount": 100,
                                "reward_currency": "FCFA",
                                "start_at": _iso(now), "end_at": _iso(now + timedelta(days=5)),
                                "active": False},
                          headers=admin_headers, timeout=15)
        cid = r.json()["id"]; cleanup_challenges.append(cid)
        r2 = requests.put(f"{BASE_URL}/api/admin/challenges/{cid}",
                          json={"target": 42, "name": "TEST_upd2_bis"},
                          headers=admin_headers, timeout=15)
        assert r2.status_code == 200
        assert r2.json()["target"] == 42
        assert r2.json()["name"] == "TEST_upd2_bis"

    def test_delete_challenge(self, admin_headers):
        now = datetime.now(timezone.utc)
        r = requests.post(f"{BASE_URL}/api/admin/challenges",
                          json={"name": "TEST_del", "target": 5, "reward_amount": 100,
                                "reward_currency": "FCFA",
                                "start_at": _iso(now), "end_at": _iso(now + timedelta(days=5)),
                                "active": False},
                          headers=admin_headers, timeout=15)
        cid = r.json()["id"]
        r2 = requests.delete(f"{BASE_URL}/api/admin/challenges/{cid}",
                             headers=admin_headers, timeout=15)
        assert r2.status_code == 200
        assert r2.json().get("ok") is True
        # second delete → 404
        r3 = requests.delete(f"{BASE_URL}/api/admin/challenges/{cid}",
                             headers=admin_headers, timeout=15)
        assert r3.status_code == 404


class TestCurrentEndpoint:
    """/api/challenges/current — window & counting rules."""

    def test_returns_null_when_no_active(self, admin_headers, admin_token, db, cleanup_challenges):
        # Deactivate any currently-active challenge without deleting the seed.
        active_docs = list(db.challenges.find({"active": True}))
        db.challenges.update_many({"active": True}, {"$set": {"active": False}})
        try:
            headers = {"Authorization": f"Bearer {admin_token}"}
            r = requests.get(f"{BASE_URL}/api/challenges/current",
                             headers=headers, timeout=15)
            assert r.status_code == 200
            body = r.json()
            assert body["challenge"] is None
            assert body["progress"] == 0
        finally:
            for a in active_docs:
                db.challenges.update_one({"id": a["id"]}, {"$set": {"active": True}})

    def test_progress_counting_rules(self, admin_headers, admin_token, db,
                                     admin_user_id, cleanup_challenges, cleanup_users):
        """Create a fresh active challenge, insert 4 synthetic direct referrals of
        the admin with different level_activated_at.1 values, then assert progress=2.
        """
        now = datetime.now(timezone.utc)
        start = now - timedelta(days=10)
        end = now + timedelta(days=30)
        # Deactivate seed challenge(s) temporarily so ours becomes the current one.
        previously_active = [d["id"] for d in db.challenges.find({"active": True})]
        db.challenges.update_many({"active": True}, {"$set": {"active": False}})

        p = {"name": "TEST_progress", "target": 100, "reward_amount": 500,
             "reward_currency": "FCFA",
             "start_at": _iso(start), "end_at": _iso(end), "active": True}
        r = requests.post(f"{BASE_URL}/api/admin/challenges",
                          json=p, headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        challenge = r.json()
        cleanup_challenges.append(challenge["id"])

        try:
            # Insert 4 synthetic users as direct referrals of admin.
            in_win_1 = now - timedelta(days=5)
            in_win_2 = now - timedelta(days=1)
            before = now - timedelta(days=20)

            users = [
                # Cas 1: registered before window, activated in window → COUNTS
                {"id": str(uuid.uuid4()), "username": f"TEST_cas1_{uuid.uuid4().hex[:6]}",
                 "email": f"cas1_{uuid.uuid4().hex[:6]}@t.local", "sponsor_id": admin_user_id,
                 "status": "active", "max_level": 1,
                 "created_at": now - timedelta(days=40),
                 "level_activated_at": {"1": in_win_1}},
                # Cas 2: reg & activated in window → COUNTS
                {"id": str(uuid.uuid4()), "username": f"TEST_cas2_{uuid.uuid4().hex[:6]}",
                 "email": f"cas2_{uuid.uuid4().hex[:6]}@t.local", "sponsor_id": admin_user_id,
                 "status": "active", "max_level": 1,
                 "created_at": now - timedelta(days=3),
                 "level_activated_at": {"1": in_win_2}},
                # Cas 3: activated BEFORE window → EXCLUDED
                {"id": str(uuid.uuid4()), "username": f"TEST_cas3_{uuid.uuid4().hex[:6]}",
                 "email": f"cas3_{uuid.uuid4().hex[:6]}@t.local", "sponsor_id": admin_user_id,
                 "status": "active", "max_level": 1,
                 "created_at": now - timedelta(days=60),
                 "level_activated_at": {"1": before}},
                # Cas 4: pending, never activated → EXCLUDED
                {"id": str(uuid.uuid4()), "username": f"TEST_cas4_{uuid.uuid4().hex[:6]}",
                 "email": f"cas4_{uuid.uuid4().hex[:6]}@t.local", "sponsor_id": admin_user_id,
                 "status": "pending", "max_level": 0,
                 "created_at": now - timedelta(days=2),
                 "level_activated_at": {}},
            ]
            db.users.insert_many(users)
            cleanup_users.extend([u["id"] for u in users])

            # As admin — check /current
            headers = {"Authorization": f"Bearer {admin_token}"}
            r = requests.get(f"{BASE_URL}/api/challenges/current",
                             headers=headers, timeout=15)
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["challenge"] is not None
            assert body["challenge"]["id"] == challenge["id"]
            assert body["progress"] == 2, f"expected 2, got {body}"
            assert body["completed"] is False

            # No auto reward credited
            admin_doc = db.users.find_one({"id": admin_user_id})
            # We just verify balance_profit didn't get incremented by the challenge target logic.
            # (target=100 was not reached anyway, but this is the primary assertion.)
            assert body["completed"] is False

            # ------ participants aggregation
            r2 = requests.get(f"{BASE_URL}/api/admin/challenges/{challenge['id']}/participants",
                              headers=admin_headers, timeout=15)
            assert r2.status_code == 200
            agg = r2.json()
            me_row = [p for p in agg["participants"] if p["user_id"] == admin_user_id]
            assert len(me_row) == 1
            assert me_row[0]["progress"] == 2
            assert me_row[0]["target"] == 100
            assert me_row[0]["completed"] is False
            assert agg["winners_count"] == 0

            # ------ Now shrink target to 2 → completed=True, still no auto reward
            r3 = requests.put(f"{BASE_URL}/api/admin/challenges/{challenge['id']}",
                              json={"target": 2}, headers=admin_headers, timeout=15)
            assert r3.status_code == 200

            balance_before = admin_doc.get("balance_profit") or 0

            r4 = requests.get(f"{BASE_URL}/api/challenges/current",
                              headers=headers, timeout=15)
            assert r4.status_code == 200
            assert r4.json()["completed"] is True

            admin_doc_after = db.users.find_one({"id": admin_user_id})
            assert (admin_doc_after.get("balance_profit") or 0) == balance_before, \
                "balance_profit changed — reward must NOT be auto-credited"
        finally:
            for cid in previously_active:
                db.challenges.update_one({"id": cid}, {"$set": {"active": True}})


class TestAuth:
    def test_current_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/challenges/current", timeout=15)
        assert r.status_code in (401, 403)

    def test_admin_endpoints_require_admin(self):
        r = requests.get(f"{BASE_URL}/api/admin/challenges", timeout=15)
        assert r.status_code in (401, 403)
