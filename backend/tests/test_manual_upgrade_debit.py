"""Verify the fix: admin_manual activation debits balance_upgrade when reserve is sufficient.

Bug: previously only source='auto_upgrade' triggered the reserve debit.
When auto-upgrade failed to trigger (matrix not filled, etc.) and the admin
manually pushed the level via /api/admin/users/{id}/action, the level was
activated WITHOUT debiting the reserve — the user effectively got the upgrade
for free.

Tests are run as direct DB integration (not HTTP) because they need to
manipulate balance_upgrade pre-state which is not exposed via API.
"""
import os
import sys
import uuid
import asyncio
import pytest
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, '/app/backend')
from matrix import activate_level  # noqa: E402


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(scope="module")
def db():
    cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    d = cli[os.environ.get("DB_NAME", "spilivere")]
    yield d
    cli.close()


@pytest.fixture(scope="module")
def admin_id(db):
    a = _run(db.users.find_one({"role": "admin"}, {"_id": 0}))
    assert a, "admin must exist"
    return a["id"]


def _make_user(db, sponsor_id, balance_upgrade):
    uid = str(uuid.uuid4())
    _run(db.users.insert_one({
        "id": uid, "username": f"upgtest_{uid[:8]}",
        "email": f"upgtest_{uid[:8]}@example.com",
        "phone": "+22890000099", "country": "TG", "password_hash": "x",
        "role": "user", "status": "active", "max_level": 1,
        "sponsor_id": sponsor_id, "sponsor_username": "admin",
        "balance_profit": 0, "balance_upgrade": balance_upgrade,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }))
    _run(db.matrix_placements.insert_one({
        "user_id": uid, "level": 1, "parent_id": sponsor_id, "leg": "left",
        "sponsor_id": sponsor_id, "is_spillover": False,
        "created_at": datetime.now(timezone.utc),
    }))
    return uid


def _cleanup(db, uid):
    _run(db.users.delete_one({"id": uid}))
    _run(db.matrix_placements.delete_many({"user_id": uid}))
    _run(db.commissions.delete_many({"$or": [{"user_id": uid}, {"from_user_id": uid}]}))


def test_admin_manual_debits_reserve_when_sufficient(db, admin_id):
    """L2 price = 1000. Reserve = 1000. admin_manual MUST debit → reserve=0."""
    uid = _make_user(db, admin_id, balance_upgrade=1000)
    try:
        _run(activate_level(db, uid, 2, source="admin_manual"))
        u = _run(db.users.find_one({"id": uid}, {"_id": 0}))
        assert u["balance_upgrade"] == 0, f"reserve must be debited, got {u['balance_upgrade']}"
        assert u["max_level"] == 2
    finally:
        _cleanup(db, uid)


@pytest.mark.parametrize("src", ["secure_pay", "gateway_return", "sendavapay", "manual_reprocess", "admin_validate"])
def test_external_payment_does_not_debit_reserve(db, admin_id, src):
    """External payment sources MUST keep reserve intact."""
    uid = _make_user(db, admin_id, balance_upgrade=1500)
    try:
        _run(activate_level(db, uid, 2, source=src))
        u = _run(db.users.find_one({"id": uid}, {"_id": 0}))
        assert u["balance_upgrade"] == 1500, f"source={src} must NOT debit, got {u['balance_upgrade']}"
        assert u["max_level"] == 2
    finally:
        _cleanup(db, uid)


def test_admin_manual_insufficient_reserve_still_activates(db, admin_id):
    """admin_manual with reserve < price = admin override; level activates, reserve untouched."""
    uid = _make_user(db, admin_id, balance_upgrade=100)
    try:
        _run(activate_level(db, uid, 2, source="admin_manual"))
        u = _run(db.users.find_one({"id": uid}, {"_id": 0}))
        assert u["balance_upgrade"] == 100, "reserve must NOT be debited when insufficient"
        assert u["max_level"] == 2
    finally:
        _cleanup(db, uid)


def test_auto_upgrade_still_debits(db, admin_id):
    """Regression: auto_upgrade source still debits reserve as before."""
    uid = _make_user(db, admin_id, balance_upgrade=1000)
    try:
        _run(activate_level(db, uid, 2, source="auto_upgrade"))
        u = _run(db.users.find_one({"id": uid}, {"_id": 0}))
        assert u["balance_upgrade"] == 0
        assert u["max_level"] == 2
    finally:
        _cleanup(db, uid)


def test_auto_upgrade_with_insufficient_reserve_raises(db, admin_id):
    """Regression: auto_upgrade with reserve<price still raises ValueError."""
    uid = _make_user(db, admin_id, balance_upgrade=100)
    try:
        with pytest.raises(ValueError, match="Réserve"):
            _run(activate_level(db, uid, 2, source="auto_upgrade"))
        u = _run(db.users.find_one({"id": uid}, {"_id": 0}))
        assert u["max_level"] == 1
        assert u["balance_upgrade"] == 100
    finally:
        _cleanup(db, uid)
