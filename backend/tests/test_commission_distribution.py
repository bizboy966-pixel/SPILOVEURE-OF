"""Test commission distribution logic — N levels up the sponsor chain.

Run: cd /app/backend && python -m pytest tests/test_commission_distribution.py -v
Or:  cd /app/backend && python tests/test_commission_distribution.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Ensure backend modules are importable when run as a script
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from motor.motor_asyncio import AsyncIOMotorClient

from auth import hash_password
from levels import LEVELS_BY_NUM
from matrix import activate_level, distribute_commission, _walk_up_sponsors


TEST_DB_NAME = "spilivere_test_commissions"


async def _make_user(db, username: str, sponsor_id: str | None, max_level: int = 0):
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "username": username,
        "email": f"{username}@test.local",
        "country": "TG",
        "phone": "+22890000000",
        "password_hash": hash_password("password123"),
        "role": "user",
        "status": "pending",
        "max_level": max_level,
        "sponsor_id": sponsor_id,
        "sponsor_username": None,
        "balance_profit": 0,
        "balance_upgrade": 0,
        "commission_direct": 0,
        "commission_spillover": 0,
        "total_earned": 0,
        "total_withdrawn": 0,
        "withdrawals_disabled": False,
        "earnings_per_level": {},
        "level_activated_at": {},
        "created_at": datetime.now(timezone.utc),
    }
    await db.users.insert_one(doc)
    return uid


async def _reset_db(db):
    """Drop test collections to start clean."""
    for c in ["users", "matrix_placements", "commissions", "activations", "payments"]:
        await db[c].drop()


async def run_tests():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[TEST_DB_NAME]

    print("\n" + "=" * 70)
    print("TEST: Commission distribution — N levels up the sponsor chain")
    print("=" * 70)

    # ===== Scenario 1: Linear sponsor chain =====
    # admin -> A -> B -> C -> D (each sponsors next, no spillover)
    # All pre-activated at level 3.
    # When D activates level 3 → commission should go to A (3 hops above D)
    print("\n--- Scenario 1: Linear sponsor chain (no spillover) ---")
    await _reset_db(db)

    admin_id = await _make_user(db, "admin", None, max_level=12)
    # place admin at all levels in matrix as root
    for lv in range(1, 13):
        await db.matrix_placements.insert_one({
            "user_id": admin_id, "level": lv,
            "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })

    # Pre-create chain & pre-activate levels for ancestors
    a_id = await _make_user(db, "userA", admin_id, max_level=0)
    b_id = await _make_user(db, "userB", a_id, max_level=0)
    c_id = await _make_user(db, "userC", b_id, max_level=0)
    d_id = await _make_user(db, "userD", c_id, max_level=0)

    # Activate level 1 for all (admin already at 12)
    # We must follow ordering: activate L1 for A first, then B, then C, then D
    # Then push them to L2, L3 sequentially. Give each enough upgrade balance.
    for uid in [a_id, b_id, c_id, d_id]:
        await db.users.update_one({"id": uid}, {"$set": {"balance_upgrade": 100000}})

    # Activate L1 for A,B,C,D using activate_level directly (bypass admin route)
    for uid in [a_id, b_id, c_id, d_id]:
        await activate_level(db, uid, 1, source="test")
    # Activate L2 for A,B,C (D will not pre-activate L2/L3, we'll check L3 commission)
    # Actually for D to activate L3, D must first activate L2.
    for uid in [a_id, b_id, c_id, d_id]:
        await activate_level(db, uid, 2, source="test")
    # Activate L3 for A,B,C only (not D yet)
    for uid in [a_id, b_id, c_id]:
        await activate_level(db, uid, 3, source="test")

    # Clear commissions/earnings before the critical test step
    await db.commissions.delete_many({})
    await db.users.update_many({}, {"$set": {
        "balance_profit": 0, "balance_upgrade": 100000,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "earnings_per_level": {},
    }})

    # Now D activates L3 → commission should go to A (3 hops above D)
    await activate_level(db, d_id, 3, source="test")

    a_after = await db.users.find_one({"id": a_id}, {"_id": 0, "username": 1, "commission_direct": 1, "balance_profit": 1, "balance_upgrade": 1, "total_earned": 1})
    b_after = await db.users.find_one({"id": b_id}, {"_id": 0, "username": 1, "commission_direct": 1})
    c_after = await db.users.find_one({"id": c_id}, {"_id": 0, "username": 1, "commission_direct": 1})

    lv3 = LEVELS_BY_NUM[3]
    expected_commission = lv3["commission_per_invite"]
    print(f"  Level 3 commission_per_invite = {expected_commission} FCFA")
    print(f"  After D activates L3:")
    print(f"    A (3 hops up, target): commission_direct={a_after['commission_direct']}, profit={a_after['balance_profit']}, upgrade={a_after['balance_upgrade']}, earned={a_after['total_earned']}")
    print(f"    B (2 hops up):         commission_direct={b_after['commission_direct']}")
    print(f"    C (1 hop up, sponsor): commission_direct={c_after['commission_direct']}")

    assert a_after["commission_direct"] == expected_commission, f"A should have received {expected_commission}, got {a_after['commission_direct']}"
    assert b_after["commission_direct"] == 0, f"B should NOT receive commission, got {b_after['commission_direct']}"
    assert c_after["commission_direct"] == 0, f"C (direct sponsor) should NOT receive L3 commission, got {c_after['commission_direct']}"
    print("  ✅ PASS: Linear sponsor chain pays correct N-hop ancestor")

    # ===== Scenario 2: Ancestor not qualified =====
    # If A is only at max_level=2 (not L3), the L3 commission should be SKIPPED.
    print("\n--- Scenario 2: Ancestor not qualified for level N ---")
    await _reset_db(db)

    admin_id = await _make_user(db, "admin", None, max_level=12)
    for lv in range(1, 13):
        await db.matrix_placements.insert_one({
            "user_id": admin_id, "level": lv,
            "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })

    a_id = await _make_user(db, "userA", admin_id, max_level=0)
    b_id = await _make_user(db, "userB", a_id, max_level=0)
    c_id = await _make_user(db, "userC", b_id, max_level=0)
    d_id = await _make_user(db, "userD", c_id, max_level=0)

    for uid in [a_id, b_id, c_id, d_id]:
        await db.users.update_one({"id": uid}, {"$set": {"balance_upgrade": 100000}})

    # Activate L1, L2 for all, but L3 only for B, C (not A!)
    for uid in [a_id, b_id, c_id, d_id]:
        await activate_level(db, uid, 1, source="test")
    for uid in [a_id, b_id, c_id, d_id]:
        await activate_level(db, uid, 2, source="test")
    # A stays at L2; B, C go to L3
    for uid in [b_id, c_id]:
        await activate_level(db, uid, 3, source="test")

    await db.commissions.delete_many({})
    await db.users.update_many({}, {"$set": {
        "balance_profit": 0, "balance_upgrade": 100000,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "earnings_per_level": {},
    }})

    await activate_level(db, d_id, 3, source="test")
    a_after = await db.users.find_one({"id": a_id}, {"_id": 0, "commission_direct": 1, "max_level": 1})
    print(f"  A max_level={a_after['max_level']}, commission_direct={a_after['commission_direct']}")
    assert a_after["commission_direct"] == 0, f"A is only at L{a_after['max_level']} → commission should be skipped"
    print("  ✅ PASS: Commission skipped when ancestor not qualified")

    # ===== Scenario 3: Spillover 50/50 split =====
    # admin -> A -> B (B sponsored by A)
    # admin -> X -> Y (Y sponsored by X)
    # Z sponsored by B, but parent_id is Y (placed via spillover).
    # When Z activates L1, commission_per_invite must split 50/50 between
    # sponsor-chain ancestor of B (=A or admin via 0 hops) and matrix-chain
    # ancestor of Y. For L1, "N=1 hops above sponsor" = sponsor itself.
    # So 50/50 between B (direct sponsor) and Y (matrix parent).
    print("\n--- Scenario 3: Spillover 50/50 split (Level 1) ---")
    await _reset_db(db)

    admin_id = await _make_user(db, "admin", None, max_level=12)
    for lv in range(1, 13):
        await db.matrix_placements.insert_one({
            "user_id": admin_id, "level": lv,
            "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })

    a_id = await _make_user(db, "A", admin_id, 0)
    b_id = await _make_user(db, "B", a_id, 0)
    x_id = await _make_user(db, "X", admin_id, 0)
    y_id = await _make_user(db, "Y", x_id, 0)
    z_id = await _make_user(db, "Z", b_id, 0)  # Z's sponsor is B

    # Activate L1 for everyone except Z
    for uid in [a_id, b_id, x_id, y_id]:
        await db.users.update_one({"id": uid}, {"$set": {"balance_upgrade": 100000}})
        await activate_level(db, uid, 1, source="test")

    # Reset commissions and force Z to be a spillover under Y (not B)
    # Simulate spillover by directly calling distribute_commission with parent_id != sponsor_id
    await db.commissions.delete_many({})
    await db.users.update_many({}, {"$set": {
        "balance_profit": 0, "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "earnings_per_level": {},
    }})

    # For Level 1 testing: N=1, hops = level-1 = 0. So:
    #   direct_ancestor = walk_up(sponsor_id=B, hops=0) = B
    #   spillover_ancestor = walk_up(parent_id=Y, hops=0) = Y
    # Both should split 50/50.
    lv1 = LEVELS_BY_NUM[1]
    commission = lv1["commission_per_invite"]
    half = commission // 2

    await distribute_commission(
        db, new_user_id=z_id, sponsor_id=b_id, parent_id=y_id,
        level=1, is_spillover=True,
    )

    b_after = await db.users.find_one({"id": b_id}, {"_id": 0, "balance_profit": 1, "commission_direct": 1, "commission_spillover": 1, "total_earned": 1})
    y_after = await db.users.find_one({"id": y_id}, {"_id": 0, "balance_profit": 1, "commission_direct": 1, "commission_spillover": 1, "total_earned": 1})

    print(f"  Level 1 commission = {commission}, expected each = {half}")
    print(f"  B (direct sponsor):    earned={b_after['total_earned']}, direct={b_after['commission_direct']}, spillover={b_after['commission_spillover']}")
    print(f"  Y (matrix parent):     earned={y_after['total_earned']}, direct={y_after['commission_direct']}, spillover={y_after['commission_spillover']}")

    assert b_after["total_earned"] == half, f"B should get {half}, got {b_after['total_earned']}"
    assert y_after["total_earned"] == commission - half, f"Y should get {commission - half}, got {y_after['total_earned']}"
    print("  ✅ PASS: Spillover commission split 50/50 between sponsor-chain and matrix-chain ancestors")

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED ✅")
    print("=" * 70 + "\n")

    # Cleanup
    await client.drop_database(TEST_DB_NAME)
    client.close()


if __name__ == "__main__":
    asyncio.run(run_tests())
