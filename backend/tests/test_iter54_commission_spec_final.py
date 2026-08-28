"""ITER-54 — Independent verification of the FINAL MLM commission spec (2026-08-27).

Module under test: matrix.py :: distribute_commission / activate_level

Covers (written by the QA agent, independent of the dev-authored tests):
  1. L1 direct  → 100 % to sponsor, kind=direct, reserve/profit split w/ cap.
  2. L1 spillover → 50/50 split; spillover_sponsor share is 100 % profit.
  3. L2+ → 100 % to the ancestor `level` hops up the LEVEL-1 placement chain.
  4. L2+ → is_spillover flag totally ignored, never any spillover_* row.
  5. Guard §10 → recipient with max_level < N is skipped (no row, no balance).
  6. Broken/short L1 tree at L2 → no commission at all.
  7. End-to-end activate_level(source='soleaspay') at L1 and L2.
  8. Balance persistence assertions on db.users after each distribution.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from matrix import distribute_commission, activate_level  # noqa: E402
from levels import LEVELS_BY_NUM  # noqa: E402

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


# ── helpers ────────────────────────────────────────────────────────────────
def _uid(tag: str) -> str:
    return f"TEST_i54-{tag}-{uuid.uuid4().hex[:8]}"


async def seed_user(db, uid, sponsor_id=None, max_level=0, balance_upgrade=0.0):
    await db.users.insert_one({
        "id": uid, "username": f"TEST_{uid[-8:]}", "email": f"{uid}@test.local",
        "role": "user", "status": "active", "sponsor_id": sponsor_id,
        "max_level": max_level, "balance_profit": 0.0,
        "balance_upgrade": float(balance_upgrade), "balance_reserve": 0.0,
        "total_earned": 0.0, "created_at": datetime.now(timezone.utc),
    })
    return uid


async def seed_l1(db, uid, parent_id, sponsor_id=None):
    await db.matrix_placements.insert_one({
        "user_id": uid, "level": 1, "parent_id": parent_id, "leg": "left",
        "sponsor_id": sponsor_id,
        "is_spillover": bool(parent_id and sponsor_id and parent_id != sponsor_id),
        "created_at": datetime.now(timezone.utc),
    })


async def cleanup(db, uids):
    await db.users.delete_many({"id": {"$in": uids}})
    await db.matrix_placements.delete_many({"user_id": {"$in": uids}})
    await db.matrix_placements.delete_many({"parent_id": {"$in": uids}})
    await db.commissions.delete_many({"$or": [{"user_id": {"$in": uids}},
                                              {"from_user_id": {"$in": uids}}]})
    await db.payments.delete_many({"user_id": {"$in": uids}})
    await db.activations.delete_many({"user_id": {"$in": uids}})
    await db.activation_events.delete_many({"user_id": {"$in": uids}})


@pytest_asyncio.fixture
async def db():
    cli = AsyncIOMotorClient(MONGO_URL)
    yield cli[DB_NAME]
    cli.close()


# ── 1. L1 direct ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_L1_direct_full_to_sponsor_with_reserve_cap(db):
    sponsor, activator = _uid("sp"), _uid("ac")
    try:
        await seed_user(db, sponsor, max_level=1)
        await seed_user(db, activator, sponsor_id=sponsor, max_level=0)

        credits = await distribute_commission(db, activator, sponsor, sponsor, 1, False)
        amount = LEVELS_BY_NUM[1]["commission_per_invite"]  # 2000
        assert len(credits) == 1
        assert credits[0]["kind"] == "direct"
        assert credits[0]["user_id"] == sponsor
        assert credits[0]["amount"] == amount

        # upgrade_share = min(amount//2, next_price - reserve) = min(1000, 1000)
        next_price = LEVELS_BY_NUM[2]["price"]
        assert credits[0]["upgrade_share"] == min(amount // 2, next_price)
        assert credits[0]["upgrade_share"] + credits[0]["profit_share"] == amount

        # Persistence: balances credited on db.users
        u = await db.users.find_one({"id": sponsor}, {"_id": 0})
        assert u["total_earned"] == amount
        assert u.get("commission_direct") == amount
        assert u.get("earnings_per_level", {}).get("1") == amount
        # reserve may have been consumed by the auto-upgrade cascade;
        # in that case max_level went up. Assert consistency either way.
        if u["max_level"] == 1:
            assert u["balance_upgrade"] == credits[0]["upgrade_share"]
        assert u["balance_profit"] == credits[0]["profit_share"]

        # Exactly one commission row persisted
        rows = await db.commissions.count_documents({"from_user_id": activator})
        assert rows == 1
    finally:
        await cleanup(db, [sponsor, activator])


# ── 2. L1 spillover 50/50 ──────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_L1_spillover_split_and_sponsor_share_is_profit_only(db):
    sponsor, parent, activator = _uid("sp"), _uid("pr"), _uid("ac")
    try:
        await seed_user(db, sponsor, max_level=1)
        await seed_user(db, parent, max_level=1)
        await seed_user(db, activator, sponsor_id=sponsor, max_level=0)

        credits = await distribute_commission(db, activator, sponsor, parent, 1, True)
        amount = LEVELS_BY_NUM[1]["commission_per_invite"]
        by_uid = {c["user_id"]: c for c in credits}
        assert set(by_uid) == {sponsor, parent}
        assert by_uid[sponsor]["kind"] == "spillover_sponsor"
        assert by_uid[parent]["kind"] == "spillover_beneficiary"
        assert by_uid[sponsor]["amount"] + by_uid[parent]["amount"] == amount
        assert by_uid[sponsor]["amount"] == amount // 2

        # spillover_sponsor → 100 % profit, no reserve
        assert by_uid[sponsor]["upgrade_share"] == 0
        assert by_uid[sponsor]["profit_share"] == by_uid[sponsor]["amount"]
        s = await db.users.find_one({"id": sponsor}, {"_id": 0})
        assert s["balance_upgrade"] == 0
        assert s["balance_profit"] == amount // 2
        assert s.get("commission_spillover") == amount // 2

        # beneficiary → reserve gets min(half, need)
        half = by_uid[parent]["amount"] // 2
        assert by_uid[parent]["upgrade_share"] == min(half, LEVELS_BY_NUM[2]["price"])
    finally:
        await cleanup(db, [sponsor, parent, activator])


# ── 3./4. L2 ancestor, spillover ignored ───────────────────────────────────
@pytest.mark.asyncio
async def test_L2_pays_ancestor_2_hops_and_ignores_spillover(db):
    gp, p, other_sponsor, activator = _uid("gp"), _uid("p"), _uid("os"), _uid("ac")
    try:
        await seed_user(db, gp, max_level=2)
        await seed_user(db, p, sponsor_id=gp, max_level=2)
        await seed_user(db, other_sponsor, max_level=2)
        await seed_user(db, activator, sponsor_id=other_sponsor, max_level=1)
        await seed_l1(db, gp, None)
        await seed_l1(db, p, gp, gp)
        await seed_l1(db, activator, p, other_sponsor)  # arrived via spillover

        credits = await distribute_commission(db, activator, other_sponsor, p, 2, True)
        amount = LEVELS_BY_NUM[2]["commission_per_invite"]
        assert len(credits) == 1, credits
        assert credits[0]["user_id"] == gp
        assert credits[0]["amount"] == amount
        assert credits[0]["kind"] == "direct"

        # neither the sponsor nor the direct parent got anything
        for uid in (p, other_sponsor):
            u = await db.users.find_one({"id": uid}, {"_id": 0})
            assert u["balance_profit"] == 0 and u["balance_upgrade"] == 0

        spill = await db.commissions.count_documents({
            "from_user_id": activator,
            "kind": {"$in": ["spillover_sponsor", "spillover_beneficiary"]},
        })
        assert spill == 0
    finally:
        await cleanup(db, [gp, p, other_sponsor, activator])


@pytest.mark.asyncio
async def test_L3_pays_ancestor_3_hops(db):
    ggp, gp, p, activator = _uid("ggp"), _uid("gp"), _uid("p"), _uid("ac")
    try:
        await seed_user(db, ggp, max_level=3)
        await seed_user(db, gp, sponsor_id=ggp, max_level=3)
        await seed_user(db, p, sponsor_id=gp, max_level=3)
        await seed_user(db, activator, sponsor_id=p, max_level=2)
        await seed_l1(db, ggp, None)
        await seed_l1(db, gp, ggp, ggp)
        await seed_l1(db, p, gp, gp)
        await seed_l1(db, activator, p, p)

        credits = await distribute_commission(db, activator, p, p, 3, False)
        assert len(credits) == 1
        assert credits[0]["user_id"] == ggp
        assert credits[0]["amount"] == LEVELS_BY_NUM[3]["commission_per_invite"]
    finally:
        await cleanup(db, [ggp, gp, p, activator])


# ── 5. Guard §10 ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_guard_section10_skips_recipient_below_level(db):
    gp, p, activator = _uid("gp"), _uid("p"), _uid("ac")
    try:
        await seed_user(db, gp, max_level=1)      # < 2 → must be skipped
        await seed_user(db, p, sponsor_id=gp, max_level=2)
        await seed_user(db, activator, sponsor_id=p, max_level=1)
        await seed_l1(db, gp, None)
        await seed_l1(db, p, gp, gp)
        await seed_l1(db, activator, p, p)

        credits = await distribute_commission(db, activator, p, p, 2, False)
        assert credits == [], credits
        assert await db.commissions.count_documents({"from_user_id": activator}) == 0
        u = await db.users.find_one({"id": gp}, {"_id": 0})
        assert u["balance_profit"] == 0 and u["balance_upgrade"] == 0
    finally:
        await cleanup(db, [gp, p, activator])


# ── 6. short tree ──────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_L2_short_tree_no_commission(db):
    p, activator = _uid("p"), _uid("ac")
    try:
        await seed_user(db, p, max_level=5)
        await seed_user(db, activator, sponsor_id=p, max_level=1)
        await seed_l1(db, p, None)
        await seed_l1(db, activator, p, p)
        credits = await distribute_commission(db, activator, p, p, 2, False)
        assert credits == []
        assert await db.commissions.count_documents({"from_user_id": activator}) == 0
    finally:
        await cleanup(db, [p, activator])


# ── 7. End-to-end activate_level via soleaspay (L1 + L2) ──────────────────
@pytest.mark.asyncio
async def test_activate_level_soleaspay_L1_then_L2_end_to_end(db):
    root, a, b = _uid("root"), _uid("a"), _uid("b")
    try:
        await seed_user(db, root, max_level=5)
        await seed_l1(db, root, None)
        await seed_user(db, a, sponsor_id=root, max_level=0)
        await seed_user(db, b, sponsor_id=a, max_level=0)

        for uid, lvl in ((a, 1), (b, 1), (b, 2)):
            await db.payments.insert_one({
                "id": str(uuid.uuid4()), "user_id": uid, "level": lvl,
                "status": "paid", "reference": f"TEST_i54-{uid}-{lvl}",
                "created_at": datetime.now(timezone.utc),
            })

        assert await activate_level(db, a, 1, source="soleaspay") == 1
        assert await activate_level(db, b, 1, source="soleaspay") == 1

        # L1 rows must reference the actual sponsor/parent of the placement
        rows_b1 = await db.commissions.find(
            {"from_user_id": b, "level": 1}, {"_id": 0}).to_list(10)
        assert rows_b1, "no L1 commission created for b"
        assert all(r["kind"] in ("direct", "spillover_sponsor",
                                "spillover_beneficiary") for r in rows_b1)
        assert sum(r["amount"] for r in rows_b1) <= LEVELS_BY_NUM[1]["commission_per_invite"]

        # Now L2 for b — expected recipient = 2 hops up the L1 chain
        chain = []
        cur = b
        for _ in range(2):
            pl = await db.matrix_placements.find_one({"user_id": cur, "level": 1},
                                                     {"_id": 0, "parent_id": 1})
            if not pl or not pl.get("parent_id"):
                cur = None
                break
            cur = pl["parent_id"]
            chain.append(cur)
        expected_ancestor = cur

        assert await activate_level(db, b, 2, source="soleaspay") == 2
        rows_b2 = await db.commissions.find(
            {"from_user_id": b, "level": 2}, {"_id": 0}).to_list(10)
        if expected_ancestor:
            anc = await db.users.find_one({"id": expected_ancestor},
                                          {"_id": 0, "max_level": 1})
            if anc and anc.get("max_level", 0) >= 2:
                assert len(rows_b2) == 1, rows_b2
                assert rows_b2[0]["user_id"] == expected_ancestor
                assert rows_b2[0]["amount"] == LEVELS_BY_NUM[2]["commission_per_invite"]
                assert rows_b2[0]["kind"] == "direct"
            else:
                assert rows_b2 == []
        else:
            assert rows_b2 == []

        # No spillover_* row may exist at level >= 2 for this flow
        illegal = await db.commissions.count_documents({
            "from_user_id": {"$in": [a, b]}, "level": {"$gte": 2},
            "kind": {"$in": ["spillover_sponsor", "spillover_beneficiary"]},
        })
        assert illegal == 0
    finally:
        await cleanup(db, [root, a, b])
