"""Correctness of commission routing at ALL levels (bug fix 2026-08-20).

Historical bug: `distribute_commission` used `_walk_up_sponsors(sponsor_id,
level-1)` which walked up `users.sponsor_id` — this ignored the actual
placement record in `matrix_placements` at level N and either paid the
wrong ancestor (N-1 hops off) or dropped the 50/50 spillover split at
level ≥ 2.

Fix: route strictly by the `matrix_placements` record for (activator, N).
- `is_spillover=false` OR sponsor_id == parent_id → 100 % to sponsor_id.
- `is_spillover=true` AND parent_id != sponsor_id → 50/50 split
  (sponsor_id = spillover_sponsor, parent_id = spillover_beneficiary).
- This applies at EVERY level (L1 through L12), not just L1.

The three cases below reproduce the scenarios reported by the user.
"""
from __future__ import annotations
import asyncio, os, sys, uuid
from datetime import datetime, timezone
from pathlib import Path
import pytest
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
from matrix import distribute_commission  # noqa: E402
from levels import LEVELS_BY_NUM          # noqa: E402


async def _seed_user(db, uid: str, sponsor_id: str | None, max_level: int):
    await db.users.insert_one({
        "id": uid, "username": f"t_{uid[:6]}", "email": f"{uid}@t.local",
        "role": "user", "status": "active",
        "sponsor_id": sponsor_id, "max_level": max_level,
        "balance_profit": 0.0, "balance_upgrade": 0.0, "balance_reserve": 0.0,
        "created_at": datetime.now(timezone.utc),
    })


async def _cleanup(db, uids: list[str]):
    await db.users.delete_many({"id": {"$in": uids}})
    await db.commissions.delete_many({"user_id": {"$in": uids}})


@pytest.mark.asyncio
async def test_L2_spillover_splits_50_50_between_placement_sponsor_and_parent():
    """Reproduce nassar235's case: L2 spillover, sponsor=okah515, parent=theodor09
    → 50 % to sponsor, 50 % to parent (was: 100 % to sponsor's sponsor)."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        sponsor = f"t-sp-{uuid.uuid4().hex[:8]}"
        parent  = f"t-pr-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, sponsor, None, max_level=2)
        await _seed_user(db, parent,  None, max_level=2)
        await _seed_user(db, activator, sponsor, max_level=1)
        credits = await distribute_commission(
            db, activator, sponsor_id=sponsor, parent_id=parent,
            level=2, is_spillover=True,
        )
        commission = LEVELS_BY_NUM[2]["commission_per_invite"]
        expected_half = commission // 2
        recipients = {c["user_id"]: (c["amount"], c["kind"]) for c in credits}
        assert sponsor in recipients, f"sponsor missing: {recipients}"
        assert parent in recipients,  f"parent (spillover beneficiary) missing: {recipients}"
        assert recipients[sponsor] == (expected_half, "spillover_sponsor")
        assert recipients[parent]  == (commission - expected_half, "spillover_beneficiary")
    finally:
        await _cleanup(db, [sponsor, parent, activator])
        cli.close()


@pytest.mark.asyncio
async def test_L2_non_spillover_pays_placement_sponsor_fully():
    """Reproduce ae9b8ae5's L2 non-spillover case: sponsor==parent==Bizboy91
    → 100 % to Bizboy91 (was: 100 % to Bizboy91's sponsor)."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        bizboy = f"t-bb-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, bizboy, None, max_level=2)
        await _seed_user(db, activator, bizboy, max_level=1)
        credits = await distribute_commission(
            db, activator, sponsor_id=bizboy, parent_id=bizboy,
            level=2, is_spillover=False,
        )
        commission = LEVELS_BY_NUM[2]["commission_per_invite"]
        assert len(credits) == 1
        assert credits[0]["user_id"] == bizboy
        assert credits[0]["amount"] == commission
        assert credits[0]["kind"] == "direct"
    finally:
        await _cleanup(db, [bizboy, activator])
        cli.close()


@pytest.mark.asyncio
async def test_L3_spillover_credits_both_placement_sponsor_and_parent():
    """Reproduce ae9b8ae5's L3 spillover: sponsor=Bizboy91, parent=dbac9d5f...
    → both must be credited. Historical bug: spillover_sponsor share missing."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        sponsor = f"t-sp-{uuid.uuid4().hex[:8]}"
        parent  = f"t-pr-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, sponsor, None, max_level=3)
        await _seed_user(db, parent,  None, max_level=3)
        await _seed_user(db, activator, sponsor, max_level=2)
        credits = await distribute_commission(
            db, activator, sponsor_id=sponsor, parent_id=parent,
            level=3, is_spillover=True,
        )
        recipients = {c["user_id"]: c["kind"] for c in credits}
        assert sponsor in recipients, "spillover_sponsor share missing (historical bug)"
        assert parent in recipients,  "spillover_beneficiary share missing"
        assert recipients[sponsor] == "spillover_sponsor"
        assert recipients[parent]  == "spillover_beneficiary"
    finally:
        await _cleanup(db, [sponsor, parent, activator])
        cli.close()
