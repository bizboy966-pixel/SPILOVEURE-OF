"""Regression tests: idempotency of activate_level / matrix placement / reprocess."""
import os, sys, asyncio, uuid, pytest, requests
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient
sys.path.insert(0, '/app/backend')


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


@pytest.fixture(scope="module")
def db():
    cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    yield cli[os.environ.get("DB_NAME", "spilivere")]
    cli.close()


@pytest.fixture(scope="module")
def admin_token():
    api = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com")
    r = requests.post(f"{api}/api/auth/login", json={
        "email": "kossikotokou4@gmail.com", "password": "@Emma91972006"
    })
    return r.json()["access_token"]


def test_place_in_matrix_is_idempotent(db):
    """Calling place_in_matrix twice for same (user_id, level) must not raise."""
    from matrix import place_in_matrix
    admin = _run(db.users.find_one({"role": "admin"}, {"_id": 0}))
    uid = str(uuid.uuid4())
    _run(db.users.insert_one({
        "id": uid, "username": f"idem_{uid[:8]}", "email": f"idem_{uid[:8]}@x.com",
        "phone": "+228x", "country": "TG", "password_hash": "x",
        "role": "user", "status": "active", "max_level": 0,
        "sponsor_id": admin["id"], "sponsor_username": "admin",
        "balance_profit": 0, "balance_upgrade": 0,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }))
    try:
        p1 = _run(place_in_matrix(db, uid, admin["id"], 1))
        p2 = _run(place_in_matrix(db, uid, admin["id"], 1))  # MUST NOT RAISE
        assert p1["user_id"] == p2["user_id"]
        assert p1["level"] == p2["level"]
        count = _run(db.matrix_placements.count_documents({"user_id": uid}))
        assert count == 1, f"only 1 placement must exist, got {count}"
    finally:
        _run(db.users.delete_one({"id": uid}))
        _run(db.matrix_placements.delete_many({"user_id": uid}))


def test_reprocess_reconciles_already_activated_user(db, admin_token):
    """If user is already at the level, reprocess must mark payment done without re-activating."""
    api = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com")
    admin = _run(db.users.find_one({"role": "admin"}, {"_id": 0}))
    uid = str(uuid.uuid4())
    # Create user already at L1
    _run(db.users.insert_one({
        "id": uid, "username": f"recon_{uid[:8]}", "email": f"recon_{uid[:8]}@x.com",
        "phone": "+228x", "country": "TG", "password_hash": "x",
        "role": "user", "status": "active", "max_level": 1,  # already activated!
        "sponsor_id": admin["id"], "sponsor_username": "admin",
        "balance_profit": 0, "balance_upgrade": 0,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }))
    _run(db.matrix_placements.insert_one({
        "user_id": uid, "level": 1, "parent_id": admin["id"], "leg": "left",
        "sponsor_id": admin["id"], "is_spillover": False,
        "created_at": datetime.now(timezone.utc),
    }))
    ref = f"SPV-RECON-{uid[:8]}"
    _run(db.payments.insert_one({
        "reference": ref, "provider": "sendavapay", "user_id": uid,
        "username": f"recon_{uid[:8]}", "level": 1, "amount": 2500.0,
        "currency": "XOF", "phone": "+228x", "country_code": "TG",
        "status": "paid", "activation_done": False,
        "activation_error": "Test: simulated stuck after successful activation",
        "created_at": datetime.now(timezone.utc),
    }))
    try:
        r = requests.post(
            f"{api}/api/admin/payments/{ref}/reprocess",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("already_activated") is True
        assert body.get("reconciled") is True
        # Payment must be marked done
        p2 = _run(db.payments.find_one({"reference": ref}, {"_id": 0}))
        assert p2["activation_done"] is True
        assert "activation_error" not in p2 or not p2["activation_error"]
    finally:
        _run(db.users.delete_one({"id": uid}))
        _run(db.matrix_placements.delete_many({"user_id": uid}))
        _run(db.payments.delete_one({"reference": ref}))
