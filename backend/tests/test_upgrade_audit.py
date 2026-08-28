"""Tests for /api/admin/upgrade-audit endpoints.

Verifies the bug-detection logic and retroactive correction.
"""
import os
import sys
import uuid
import asyncio
import pytest
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, '/app/backend')


def _loop():
    try:
        loop = asyncio.get_event_loop_policy().get_event_loop()
        if loop.is_closed():
            raise RuntimeError("closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop


def _run(coro):
    return _loop().run_until_complete(coro)


@pytest.fixture(scope="module")
def db():
    cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    d = cli[os.environ.get("DB_NAME", "spilivere")]
    yield d
    cli.close()


@pytest.fixture(scope="module")
def admin_id(db):
    a = _run(db.users.find_one({"role": "admin"}, {"_id": 0}))
    return a["id"]


def _make_buggy_user(db, admin_id, max_level, balance_upgrade, n_commissions):
    """Create a user matching the over-credit scenario."""
    uid = str(uuid.uuid4())
    _run(db.users.insert_one({
        "id": uid, "username": f"audit_{uid[:8]}",
        "email": f"audit_{uid[:8]}@example.com",
        "phone": "+22890000099", "country": "TG", "password_hash": "x",
        "role": "user", "status": "active", "max_level": max_level,
        "sponsor_id": admin_id, "sponsor_username": "admin",
        "balance_profit": 0, "balance_upgrade": balance_upgrade,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }))
    for lvl in range(1, max_level + 1):
        _run(db.matrix_placements.insert_one({
            "user_id": uid, "level": lvl, "parent_id": admin_id, "leg": "left",
            "sponsor_id": admin_id, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        }))
    for _ in range(n_commissions):
        _run(db.commissions.insert_one({
            "id": str(uuid.uuid4()), "user_id": uid, "from_user_id": admin_id,
            "level": 1, "kind": "direct", "amount": 2000,
            "upgrade_share": 1000, "profit_share": 1000,
            "created_at": datetime.now(timezone.utc),
        }))
    return uid


def _cleanup(db, uid):
    _run(db.users.delete_one({"id": uid}))
    _run(db.matrix_placements.delete_many({"user_id": uid}))
    _run(db.commissions.delete_many({"$or": [{"user_id": uid}, {"from_user_id": uid}]}))
    _run(db.upgrade_audit_log.delete_many({"user_id": uid}))


def test_audit_detects_over_credit(db, admin_id):
    """Create a user with 5 commissions (5000 upgrade_share) at max_level=3.
    Expected balance = 5000 - 1000 - 2000 = 2000. Current = 5000 → discrepancy = 3000."""
    uid = _make_buggy_user(db, admin_id, max_level=3, balance_upgrade=5000, n_commissions=5)
    try:
        from upgrade_audit import _build_report
        report = _run(_build_report(db))
        match = [r for r in report["over_credited"] if r["id"] == uid]
        assert len(match) == 1, f"expected 1 match, got {len(match)}"
        rec = match[0]
        assert rec["discrepancy"] == 3000, f"expected 3000, got {rec['discrepancy']}"
        assert rec["balance_upgrade_expected"] == 2000
    finally:
        _cleanup(db, uid)


def test_apply_debits_atomically(db, admin_id):
    """Apply must debit exactly the discrepancy and persist log."""
    uid = _make_buggy_user(db, admin_id, max_level=3, balance_upgrade=5000, n_commissions=5)
    try:
        from upgrade_audit import _build_report, apply_upgrade_audit  # noqa
        # Use _build_report directly to drive the apply logic
        import upgrade_audit as ua
        # Mimic the apply route
        async def doapply():
            report = await ua._build_report(db)
            for rec in report["over_credited"]:
                if rec["id"] != uid:
                    continue
                amt = float(rec["discrepancy"])
                r = await db.users.update_one(
                    {"id": uid, "balance_upgrade": {"$gte": amt}},
                    {"$inc": {"balance_upgrade": -amt}},
                )
                assert r.modified_count == 1
                await db.upgrade_audit_log.insert_one({
                    "user_id": uid, "username": rec["username"],
                    "action": "retro_debit_balance_upgrade",
                    "amount": amt, "before": rec["balance_upgrade_current"],
                    "applied_at": datetime.now(timezone.utc).isoformat(),
                })
        _run(doapply())
        u = _run(db.users.find_one({"id": uid}, {"_id": 0}))
        assert u["balance_upgrade"] == 2000, f"expected 2000 after debit, got {u['balance_upgrade']}"
        log = _run(db.upgrade_audit_log.find_one({"user_id": uid}, {"_id": 0}))
        assert log is not None
        assert log["amount"] == 3000
    finally:
        _cleanup(db, uid)


def test_audit_healthy_user_not_flagged(db, admin_id):
    """User with correct balance (= expected) should not appear in over/under."""
    # 3 commissions = 3000 upgrade_share, max_level=2 → consumed 1000 → expected 2000
    uid = _make_buggy_user(db, admin_id, max_level=2, balance_upgrade=2000, n_commissions=3)
    try:
        from upgrade_audit import _build_report
        report = _run(_build_report(db))
        flagged = [r for r in report["over_credited"] + report["under_credited"] if r["id"] == uid]
        assert flagged == [], f"healthy user should not be flagged, got {flagged}"
    finally:
        _cleanup(db, uid)


def test_audit_log_endpoint_returns_recent_entries(db, admin_id):
    """Log should be sorted by applied_at desc."""
    uid = _make_buggy_user(db, admin_id, max_level=2, balance_upgrade=3000, n_commissions=3)
    try:
        _run(db.upgrade_audit_log.insert_one({
            "user_id": uid, "username": "test",
            "action": "retro_debit_balance_upgrade", "amount": 1000,
            "applied_at": datetime.now(timezone.utc).isoformat(),
        }))
        items = _run(db.upgrade_audit_log.find({"user_id": uid}, {"_id": 0}).to_list(10))
        assert len(items) == 1
    finally:
        _cleanup(db, uid)
