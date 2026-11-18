"""
Backend tests for the new SendavaPay admin monitoring page.

Coverage:
  * GET  /api/admin/payments              (list + counts + filters)
  * GET  /api/admin/payments?status=...   (status filter)
  * GET  /api/admin/payments?stuck_only=true
  * GET  /api/admin/payments?q=...        (search)
  * POST /api/admin/payments/{ref}/reprocess (force-activation)
  * Auth: 401/403 without admin token
"""

import os
import time
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE, "REACT_APP_BACKEND_URL must be set"
API = f"{BASE}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


# ---------- fixtures ----------------------------------------------------------

@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"login": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    if r.status_code != 200:
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"No token in: {r.json()}"
    return tok


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def db():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "spilivere")
    cli = MongoClient(mongo_url)
    yield cli[db_name]
    cli.close()


@pytest.fixture
def stuck_payment(db):
    """Insert a synthetic paid+not-activated payment so we can test reprocess.
    A real user is required because activate_level reads users.max_level."""
    # Find any non-admin user (we'll reset their level after the test)
    user = db.users.find_one({"role": {"$ne": "admin"}, "username": {"$ne": "admin"}})
    if not user:
        pytest.skip("No non-admin user available to attach a stuck payment to")
    ref = f"TEST_STUCK_{uuid.uuid4().hex[:10]}"
    original_max = int(user.get("max_level") or 0)
    target_level = original_max + 1
    doc = {
        "reference": ref,
        "provider": "sendavapay",
        "user_id": user["_id"] if isinstance(user.get("_id"), str) else str(user["_id"]),
        "username": user.get("username") or "tester",
        "level": target_level,
        "amount": 3000,
        "currency": "XOF",
        "phone": user.get("phone") or "+22890000000",
        "country_code": user.get("country") or "TG",
        "status": "paid",
        "activation_done": False,
        "activation_error": "synthetic test failure",
        "transaction_id": f"tx_{uuid.uuid4().hex[:8]}",
        "payment_url": None,
        "created_at": __import__("datetime").datetime.utcnow(),
    }
    # Some installs key payments by `user_id`; align to schema
    if not isinstance(user.get("_id"), str):
        doc["user_id"] = user.get("id") or str(user["_id"])
    db.payments.insert_one(doc)
    yield {"reference": ref, "user_id": doc["user_id"], "level": target_level, "original_max": original_max, "username": doc["username"]}
    # ---- cleanup ----
    db.payments.delete_one({"reference": ref})
    # Roll back the level bump done by reprocess (if it succeeded)
    db.users.update_one({"_id": user["_id"]}, {"$set": {"max_level": original_max}})


@pytest.fixture
def already_activated_payment(db):
    user = db.users.find_one({"role": {"$ne": "admin"}, "username": {"$ne": "admin"}})
    if not user:
        pytest.skip("No non-admin user available")
    ref = f"TEST_OK_{uuid.uuid4().hex[:10]}"
    db.payments.insert_one({
        "reference": ref, "provider": "sendavapay",
        "user_id": user.get("id") or str(user["_id"]),
        "username": user.get("username"), "level": 1, "amount": 3000, "currency": "XOF",
        "phone": "+22890000000", "country_code": "TG",
        "status": "paid", "activation_done": True,
        "transaction_id": f"tx_{uuid.uuid4().hex[:8]}",
        "created_at": __import__("datetime").datetime.utcnow(),
    })
    yield ref
    db.payments.delete_one({"reference": ref})


# ---------- auth gating -------------------------------------------------------

class TestAuthGating:
    def test_list_payments_requires_auth(self):
        r = requests.get(f"{API}/admin/payments", timeout=15)
        assert r.status_code in (401, 403), f"Expected 401/403 got {r.status_code}: {r.text[:200]}"

    def test_reprocess_requires_auth(self):
        r = requests.post(f"{API}/admin/payments/anything/reprocess", timeout=15)
        assert r.status_code in (401, 403), f"Expected 401/403 got {r.status_code}"


# ---------- list endpoint -----------------------------------------------------

class TestListPayments:
    def test_basic_shape(self, admin_headers):
        r = requests.get(f"{API}/admin/payments", headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "items" in data and "count" in data and "counts" in data
        for k in ("total", "pending", "paid", "failed", "stuck"):
            assert k in data["counts"], f"counts missing key {k}"
            assert isinstance(data["counts"][k], int)
        assert isinstance(data["items"], list)
        assert data["count"] == len(data["items"])

    def test_status_filter_pending(self, admin_headers):
        r = requests.get(f"{API}/admin/payments?status=pending", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        for it in r.json()["items"]:
            assert it["status"] == "pending", f"non-pending row leaked: {it.get('status')}"

    def test_status_filter_paid(self, admin_headers):
        r = requests.get(f"{API}/admin/payments?status=paid", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        for it in r.json()["items"]:
            assert it["status"] == "paid"

    def test_stuck_only_filter(self, admin_headers, stuck_payment):
        r = requests.get(f"{API}/admin/payments?stuck_only=true", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        items = r.json()["items"]
        refs = [it["reference"] for it in items]
        assert stuck_payment["reference"] in refs, f"stuck row not returned. refs={refs[:5]}"
        for it in items:
            assert it["status"] == "paid"
            assert not it.get("activation_done"), f"non-stuck row leaked: {it.get('reference')}"

    def test_search_filter(self, admin_headers, stuck_payment):
        # search by partial reference (case-insensitive)
        needle = stuck_payment["reference"][:10].lower()
        r = requests.get(f"{API}/admin/payments?q={needle}", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        refs = [it["reference"] for it in r.json()["items"]]
        assert stuck_payment["reference"] in refs, f"search did not match. needle={needle} refs={refs}"

    def test_no_mongo_id_leak(self, admin_headers):
        r = requests.get(f"{API}/admin/payments?limit=5", headers=admin_headers, timeout=20)
        for it in r.json()["items"]:
            assert "_id" not in it, "Mongo _id leaked into response"


# ---------- reprocess endpoint -----------------------------------------------

class TestReprocess:
    def test_reprocess_not_found(self, admin_headers):
        r = requests.post(f"{API}/admin/payments/__no_such_ref__/reprocess",
                          headers=admin_headers, timeout=20)
        assert r.status_code == 404, f"expected 404, got {r.status_code}: {r.text}"

    def test_reprocess_already_activated(self, admin_headers, already_activated_payment):
        r = requests.post(f"{API}/admin/payments/{already_activated_payment}/reprocess",
                          headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("already_activated") is True
        assert data.get("ok") is True

    def test_reprocess_stuck_activates(self, admin_headers, stuck_payment, db):
        r = requests.post(f"{API}/admin/payments/{stuck_payment['reference']}/reprocess",
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200, f"reprocess failed: {r.status_code} {r.text}"
        data = r.json()
        assert data.get("ok") is True
        assert int(data.get("level")) == stuck_payment["level"]

        # Verify activation_done was flipped to True in DB
        time.sleep(0.5)
        doc = db.payments.find_one({"reference": stuck_payment["reference"]})
        assert doc is not None
        assert doc.get("activation_done") is True
        assert "activation_error" not in doc or not doc.get("activation_error")

        # Verify the user's max_level was bumped
        user_doc = db.users.find_one({"$or": [
            {"id": stuck_payment["user_id"]},
            {"username": stuck_payment["username"]},
        ]})
        assert user_doc is not None
        assert int(user_doc.get("max_level", 0)) >= stuck_payment["level"], \
            f"max_level not bumped: {user_doc.get('max_level')} < {stuck_payment['level']}"
