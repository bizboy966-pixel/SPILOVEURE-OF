"""Spec 2026-02 — Wallet split rule for spillover_sponsor commissions.

Rule: when a sponsor invites a downline placed via SPILLOVER (from the 3rd
direct invitee onwards), the sponsor's half of the commission goes
100 % into `balance_profit`. Only the SPILLOVER-BENEFICIARY half continues
to feed the upgrade reserve (50/50 with cap).

Also verifies that direct commissions still fill the reserve as before —
we must not break the level-1 → level-2 auto-upgrade counting.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
import auth as _auth  # noqa: E402
from matrix import activate_level, distribute_commission  # noqa: E402
from levels import LEVELS_BY_NUM  # noqa: E402


def _mk_user(uid: str, sponsor_id: str | None, sponsor_username: str | None,
             username: str) -> dict:
    return {
        "id": uid, "username": username, "email": f"{username}@x.com",
        "phone": "+228x", "country": "TG",
        "password_hash": _auth.hash_password("x"),
        "role": "user", "status": "pending", "max_level": 0,
        "sponsor_id": sponsor_id, "sponsor_username": sponsor_username,
        "balance_profit": 0, "balance_upgrade": 0,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }


async def _pay(db, uid, level, amount=2500):
    await db.payments.insert_one({
        "reference": f"AUTO_{uid[:6]}_L{level}", "user_id": uid, "level": level,
        "status": "paid", "amount": amount,
        "created_at": datetime.now(timezone.utc),
    })


async def _cleanup(db, uids):
    for u in uids:
        await db.users.delete_one({"id": u})
        await db.payments.delete_many({"user_id": u})
        await db.matrix_placements.delete_many({"user_id": u})
        await db.commissions.delete_many({"$or": [{"user_id": u}, {"from_user_id": u}]})
        await db.activation_events.delete_many({"user_id": u})


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _fresh_db():
    cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    return cli[os.environ.get("DB_NAME", "spilivere")], cli


def test_spillover_sponsor_share_goes_100pct_to_profit():
    """When the spillover_sponsor already has an empty reserve, his half of the
    L1 commission must land entirely in `balance_profit`, and 0 in the
    upgrade reserve. Beneficiary's half continues to feed the reserve
    (50/50 with cap)."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})

        # Two sponsor chains meeting at admin.
        sp_id = str(uuid.uuid4())        # sponsor of the invitee
        benef_id = str(uuid.uuid4())     # spillover beneficiary (parent chain)
        inv_id = str(uuid.uuid4())       # new user placed via spillover

        await db.users.insert_one(_mk_user(sp_id, admin["id"], "admin", f"sp_{sp_id[:6]}"))
        await db.users.insert_one(_mk_user(benef_id, admin["id"], "admin", f"bn_{benef_id[:6]}"))
        await db.users.insert_one(_mk_user(inv_id, sp_id, f"sp_{sp_id[:6]}", f"iv_{inv_id[:6]}"))

        # Both ancestors already activated at L1.
        for u in (sp_id, benef_id):
            await _pay(db, u, 1)
            await activate_level(db, u, 1, source="soleaspay")

        # Reset balances so we measure only the spillover event.
        await db.users.update_many(
            {"id": {"$in": [sp_id, benef_id]}},
            {"$set": {"balance_profit": 0, "balance_upgrade": 0,
                      "commission_direct": 0, "commission_spillover": 0,
                      "total_earned": 0, "earnings_per_level": {}}},
        )
        await db.commissions.delete_many({"from_user_id": inv_id})

        # Force a spillover placement (parent_id = benef, sponsor_id = sp).
        commission = LEVELS_BY_NUM[1]["commission_per_invite"]  # 2000
        half = commission // 2                                   # 1000
        other_half = commission - half                           # 1000

        await distribute_commission(
            db, new_user_id=inv_id, sponsor_id=sp_id, parent_id=benef_id,
            level=1, is_spillover=True,
        )

        sp = await db.users.find_one({"id": sp_id}, {"_id": 0})
        bn = await db.users.find_one({"id": benef_id}, {"_id": 0})

        # Sponsor : 100 % profit, 0 reserve.
        assert sp["balance_profit"] == half, \
            f"spillover_sponsor profit expected {half}, got {sp['balance_profit']}"
        assert sp["balance_upgrade"] == 0, \
            f"spillover_sponsor reserve MUST stay 0, got {sp['balance_upgrade']}"

        # Beneficiary : 50/50 (capped by L2 price = 1000). Half=1000, half/2=500.
        next_price = LEVELS_BY_NUM[2]["price"]
        expected_bn_upgrade = min(other_half // 2, next_price)
        expected_bn_profit = other_half - expected_bn_upgrade
        assert bn["balance_upgrade"] == expected_bn_upgrade, \
            f"beneficiary reserve expected {expected_bn_upgrade}, got {bn['balance_upgrade']}"
        assert bn["balance_profit"] == expected_bn_profit, \
            f"beneficiary profit expected {expected_bn_profit}, got {bn['balance_profit']}"

        # Commission row must be tagged spillover_sponsor and match splits.
        c = await db.commissions.find_one({"user_id": sp_id, "from_user_id": inv_id})
        assert c is not None and c["kind"] == "spillover_sponsor"
        assert c["upgrade_share"] == 0 and c["profit_share"] == half

        await _cleanup(db, [sp_id, benef_id, inv_id])
        cli.close()
    _run(run())


def test_direct_commission_still_feeds_reserve():
    """Guarantee we did NOT change direct-commission behaviour: 1st direct
    invite still splits 1000/1000 (reserve/profit) at L1."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        sp_id = str(uuid.uuid4()); inv_id = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(sp_id, admin["id"], "admin", f"sd_{sp_id[:6]}"))
        await db.users.insert_one(_mk_user(inv_id, sp_id, f"sd_{sp_id[:6]}", f"id_{inv_id[:6]}"))
        await _pay(db, sp_id, 1)
        await activate_level(db, sp_id, 1, source="soleaspay")
        # Reset balances after sp's own activation (no upstream commissions
        # here so this is a no-op, but explicit).
        await db.users.update_one({"id": sp_id}, {"$set": {
            "balance_profit": 0, "balance_upgrade": 0,
            "commission_direct": 0, "total_earned": 0,
        }})
        await _pay(db, inv_id, 1)
        await activate_level(db, inv_id, 1, source="soleaspay")
        u = await db.users.find_one({"id": sp_id}, {"_id": 0})
        assert u["balance_upgrade"] == 1000
        assert u["balance_profit"] == 1000
        await _cleanup(db, [sp_id, inv_id])
        cli.close()
    _run(run())
