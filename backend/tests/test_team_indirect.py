"""Tests for new /api/team/indirect endpoint and updated /api/team/direct."""
import os
import uuid
import time
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def admin_id(auth_headers):
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers, timeout=15)
    assert r.status_code == 200
    return r.json()["id"]


class TestTeamDirect:
    def test_direct_shape(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/direct", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        for k in ("members", "active", "inactive", "total"):
            assert k in d, f"missing {k}"
        assert isinstance(d["members"], list)
        assert d["total"] == len(d["members"])
        assert d["total"] == d["active"] + d["inactive"]

    def test_direct_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/team/direct", timeout=15)
        assert r.status_code in (401, 403)


class TestTeamIndirect:
    def test_indirect_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/team/indirect", timeout=15)
        assert r.status_code in (401, 403)

    def test_indirect_shape(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/indirect", headers=auth_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("members", "active", "inactive", "total"):
            assert k in d
        assert isinstance(d["members"], list)
        assert d["total"] == len(d["members"])
        assert d["total"] == d["active"] + d["inactive"]

    def test_indirect_excludes_direct_referrals(self, auth_headers, admin_id):
        """Any user in indirect list must NOT be sponsored directly by admin."""
        r = requests.get(f"{BASE_URL}/api/team/indirect", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        for m in r.json()["members"]:
            assert m.get("sponsor_id") != admin_id, \
                f"User {m.get('username')} is a direct referral but appears in indirect team"

    def test_indirect_member_fields(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/indirect", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        for m in r.json()["members"]:
            # required fields per spec
            assert "id" in m and "username" in m
            assert "status" in m
            assert "placement_level" in m
            assert "placed_at" in m


class TestTeamIndirectWithSeed:
    """Create a temporary placement to validate that the endpoint returns it,
    and clean up after."""

    @pytest.fixture(scope="class")
    def seeded_placement(self, auth_headers, admin_id):
        # Create a test user via register - use a random sponsor OTHER than admin.
        # Simpler: directly use Mongo via the admin API? There is no such API.
        # Instead: register 2 users, second one sponsored by first, then manually
        # insert a placement doc via direct Mongo access.
        import pymongo
        import os as _os
        from pathlib import Path as _P
        from dotenv import load_dotenv as _ld
        _ld(_P(__file__).resolve().parents[1] / ".env")
        mongo_url = _os.environ.get("MONGO_URL")
        db_name = _os.environ.get("DB_NAME")
        assert mongo_url and db_name
        client = pymongo.MongoClient(mongo_url)
        db = client[db_name]

        # Register sponsor and downline users
        suffix = uuid.uuid4().hex[:8]
        sponsor_email = f"TESTsp{suffix}@example.com"
        downline_email = f"TESTdn{suffix}@example.com"

        sp = requests.post(f"{BASE_URL}/api/auth/register", json={
            "username": f"TESTsp{suffix}", "email": sponsor_email,
            "password": "Password123!", "password_confirm": "Password123!",
            "accept_terms": True, "country": "TG",
            "phone": f"+2289000{suffix[:4]}", "sponsor_username": "admin"
        }, timeout=15)
        # If registration API differs, fallback: skip
        if sp.status_code not in (200, 201):
            pytest.skip(f"Cannot register test sponsor: {sp.status_code} {sp.text[:200]}")
        sp_data = sp.json()
        sp_id = (sp_data.get("user") or {}).get("id") or sp_data.get("id")

        dn = requests.post(f"{BASE_URL}/api/auth/register", json={
            "username": f"TESTdn{suffix}", "email": downline_email,
            "password": "Password123!", "password_confirm": "Password123!",
            "accept_terms": True, "country": "TG",
            "phone": f"+2289001{suffix[:4]}", "sponsor_username": f"TESTsp{suffix}"
        }, timeout=15)
        if dn.status_code not in (200, 201):
            pytest.skip(f"Cannot register downline: {dn.status_code} {dn.text[:200]}")
        dn_data = dn.json()
        dn_id = (dn_data.get("user") or {}).get("id") or dn_data.get("id")

        assert sp_id and dn_id

        # Insert a spillover placement: downline is placed under admin as spillover
        placement = {
            "id": str(uuid.uuid4()),
            "user_id": dn_id,
            "parent_id": admin_id,
            "level": 1,
            "leg": "left",
            "is_spillover": True,
            "sponsor_id": sp_id,   # sponsor is NOT admin -> qualifies as indirect
            "created_at": __import__("datetime").datetime.utcnow(),
        }
        # Remove existing placement at level 1 for this user (unique index)
        db.matrix_placements.delete_many({"user_id": dn_id, "level": 1})
        db.matrix_placements.insert_one(placement)

        yield {"downline_id": dn_id, "sponsor_id": sp_id, "downline_email": downline_email,
               "sponsor_email": sponsor_email, "placement_id": placement["id"]}

        # Teardown
        db.matrix_placements.delete_one({"id": placement["id"]})
        db.users.delete_many({"email": {"$in": [sponsor_email, downline_email]}})
        db.matrix_placements.delete_many({"user_id": {"$in": [sp_id, dn_id]}})
        client.close()

    def test_indirect_includes_spillover(self, auth_headers, seeded_placement):
        r = requests.get(f"{BASE_URL}/api/team/indirect", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        ids = [m["id"] for m in r.json()["members"]]
        assert seeded_placement["downline_id"] in ids, \
            f"Seeded spillover downline not returned. Members: {ids}"
        # Total should be >= 1
        assert r.json()["total"] >= 1
        # It should be counted as inactive (fresh user, status=pending)
        assert r.json()["inactive"] >= 1
