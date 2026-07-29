"""Official SPILOVEURE compensation plan (2026-07-30) — regression tests.

These tests codify the exact scenarios described in the product owner's spec
so that any future refactor cannot silently break the commission logic.
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
from matrix import activate_level  # noqa: E402


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


# ────────────────────────────────────────────────────────────────────────────
# LEVEL 1 — spec §2
# ────────────────────────────────────────────────────────────────────────────

def test_L1_first_invite_splits_1000_reserve_and_1000_profit():
    """Spec §2 : commission 2000 sur 1re invitation → 1000 réserve + 1000 profit."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        sponsor_id = str(uuid.uuid4())
        invitee_id = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(sponsor_id, admin["id"], "admin", f"spx_{sponsor_id[:6]}"))
        await db.users.insert_one(_mk_user(invitee_id, sponsor_id, f"spx_{sponsor_id[:6]}", f"inv_{invitee_id[:6]}"))
        # Sponsor already at level 1 (activated by admin), reserve = 0.
        await _pay(db, sponsor_id, 1)
        await activate_level(db, sponsor_id, 1, source="soleaspay")
        # Now invitee activates L1.
        await _pay(db, invitee_id, 1)
        await activate_level(db, invitee_id, 1, source="soleaspay")

        u = await db.users.find_one({"id": sponsor_id}, {"_id": 0})
        # Expect exactly 1000 upgrade + 1000 profit from this single commission.
        # (Prior L1 commissions received before this invite: none.)
        assert u["balance_upgrade"] == 1000, f"expected reserve=1000, got {u['balance_upgrade']}"
        assert u["balance_profit"] == 1000, f"expected profit=1000, got {u['balance_profit']}"
        assert u["commission_direct"] == 2000
        await _cleanup(db, [sponsor_id, invitee_id])
        cli.close()
    _run(run())


def test_L1_second_invite_all_to_profit_when_reserve_full():
    """Spec §2 : 2e invitation → 0 réserve + 2000 profit (reserve déjà pleine)."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        sponsor_id = str(uuid.uuid4())
        inv1_id = str(uuid.uuid4())
        inv2_id = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(sponsor_id, admin["id"], "admin", f"spy_{sponsor_id[:6]}"))
        await db.users.insert_one(_mk_user(inv1_id, sponsor_id, f"spy_{sponsor_id[:6]}", f"iv1_{inv1_id[:6]}"))
        await db.users.insert_one(_mk_user(inv2_id, sponsor_id, f"spy_{sponsor_id[:6]}", f"iv2_{inv2_id[:6]}"))
        for u in (sponsor_id, inv1_id, inv2_id):
            await _pay(db, u, 1)
        await activate_level(db, sponsor_id, 1, source="soleaspay")
        # First invitation.
        await activate_level(db, inv1_id, 1, source="soleaspay")
        state1 = await db.users.find_one({"id": sponsor_id}, {"_id": 0})
        # Spec §2 : après la 1re invitation le parrain n'est PAS encore
        # promu à L2 — il faut 2 invitations directes ET la réserve remplie.
        # Ici seulement 1 invitation → il reste à L1 avec réserve=1000.
        assert state1["max_level"] == 1
        assert state1["balance_upgrade"] == 1000
        assert state1["balance_profit"] == 1000

        # Second invitation — the 2nd direct fills the last slot and the
        # commission triggers auto-upgrade to L2 (reserve full, 2 direct
        # invitees). Auto-upgrade debits the reserve by 1000 (L2 price).
        await activate_level(db, inv2_id, 1, source="soleaspay")
        state2 = await db.users.find_one({"id": sponsor_id}, {"_id": 0})
        # Reserve had 1000 (full), so 2nd L1 commission is 100 % profit → +2000.
        # Then auto-upgrade to L2 debits the 1000 reserve.
        assert state2["max_level"] == 2, f"sponsor should be L2 after both invites, got L{state2['max_level']}"
        assert state2["balance_upgrade"] == 0, f"reserve should be 0 after L2 upgrade, got {state2['balance_upgrade']}"
        # Profit gained = 1000 (from 1st) + 2000 (from 2nd) = 3000.
        assert state2["balance_profit"] == 3000, f"profit should be 3000, got {state2['balance_profit']}"
        await _cleanup(db, [sponsor_id, inv1_id, inv2_id])
        cli.close()
    _run(run())


# ────────────────────────────────────────────────────────────────────────────
# SPILLOVER — spec §9
# ────────────────────────────────────────────────────────────────────────────

def test_L1_spillover_splits_50_50_between_sponsor_and_beneficiary():
    """Spec §9 : à partir du 3ᵉ filleul direct, 50 % au parrain / 50 % au bénéficiaire."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        sponsor_id = str(uuid.uuid4())
        d1 = str(uuid.uuid4()); d2 = str(uuid.uuid4()); d3 = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(sponsor_id, admin["id"], "admin", f"sp_{sponsor_id[:6]}"))
        for x, name in [(d1, "d1"), (d2, "d2"), (d3, "d3")]:
            await db.users.insert_one(_mk_user(x, sponsor_id, f"sp_{sponsor_id[:6]}", f"{name}_{x[:6]}"))
            await _pay(db, x, 1)
        await _pay(db, sponsor_id, 1)
        await activate_level(db, sponsor_id, 1, source="soleaspay")
        # Two direct invitees fill sponsor's left/right slots.
        await activate_level(db, d1, 1, source="soleaspay")
        await activate_level(db, d2, 1, source="soleaspay")
        sponsor_state_before = await db.users.find_one({"id": sponsor_id}, {"_id": 0})
        # 3rd invitee will spill under d1 (leftmost).
        await activate_level(db, d3, 1, source="soleaspay")
        placement_d3 = await db.matrix_placements.find_one({"user_id": d3, "level": 1}, {"_id": 0})
        assert placement_d3["is_spillover"] is True
        assert placement_d3["parent_id"] != sponsor_id  # under a descendant

        # Sponsor should have gained 1000 (half of L1 commission) on this event.
        sponsor_state = await db.users.find_one({"id": sponsor_id}, {"_id": 0})
        gain = (sponsor_state["balance_profit"] - sponsor_state_before["balance_profit"]
                + sponsor_state["balance_upgrade"] - sponsor_state_before["balance_upgrade"])
        assert gain == 1000, f"sponsor should have gained 1000 total, got {gain}"
        # And a spillover_sponsor commission row must exist.
        c = await db.commissions.find_one({
            "user_id": sponsor_id, "from_user_id": d3,
            "kind": "spillover_sponsor",
        })
        assert c is not None, "spillover_sponsor commission missing"
        assert c["amount"] == 1000
        # Cleanup
        await _cleanup(db, [sponsor_id, d1, d2, d3])
        cli.close()
    _run(run())


# ────────────────────────────────────────────────────────────────────────────
# ANCESTOR GATE — spec §10
# ────────────────────────────────────────────────────────────────────────────

def test_commission_skipped_when_ancestor_not_at_level_N():
    """Spec §10 : si l'ancêtre destinataire n'a pas atteint le niveau N, la
    commission de niveau N est ignorée (pas versée rétroactivement)."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        sponsor_id = str(uuid.uuid4())
        invitee_id = str(uuid.uuid4())
        # Sponsor is at level 0 (never activated).
        await db.users.insert_one(_mk_user(sponsor_id, admin["id"], "admin", f"nn_{sponsor_id[:6]}"))
        await db.users.insert_one(_mk_user(invitee_id, sponsor_id, f"nn_{sponsor_id[:6]}", f"nv_{invitee_id[:6]}"))
        await _pay(db, invitee_id, 1)
        # Try to activate the invitee — commission targets sponsor (max_level=0).
        # It must be skipped and sponsor's balances stay at 0.
        await activate_level(db, invitee_id, 1, source="soleaspay")
        u = await db.users.find_one({"id": sponsor_id}, {"_id": 0})
        assert u["balance_profit"] == 0
        assert u["balance_upgrade"] == 0
        assert u["commission_direct"] == 0
        # No commission doc created for the sponsor.
        c = await db.commissions.find_one({"user_id": sponsor_id, "from_user_id": invitee_id})
        assert c is None
        await _cleanup(db, [sponsor_id, invitee_id])
        cli.close()
    _run(run())
