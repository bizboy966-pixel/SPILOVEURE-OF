"""Spec 2026-02 (clarification) — Le Spillover 50/50 s'applique
UNIQUEMENT au Niveau 1.

Toutes les commissions des Niveaux 2 → 12 sont payées à 100 % au N-hop
ancêtre dans la chaîne de parrainage, indépendamment du placement matrice.
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
from matrix import distribute_commission  # noqa: E402
from levels import LEVELS_BY_NUM  # noqa: E402


def _mk_user(uid, sponsor_id, sponsor_username, username, max_level=0):
    return {
        "id": uid, "username": username, "email": f"{username}@x.com",
        "phone": "+228x", "country": "TG",
        "password_hash": _auth.hash_password("x"),
        "role": "user", "status": "active" if max_level > 0 else "pending",
        "max_level": max_level,
        "sponsor_id": sponsor_id, "sponsor_username": sponsor_username,
        "balance_profit": 0, "balance_upgrade": 0,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }


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


def test_L2_spillover_pays_100pct_no_split():
    """Spec 2026-02 : quand un descendant activate le NIVEAU 2 avec une
    placement spillover à L2, la commission doit aller à 100 % à l'ancêtre
    N-hops (level-1=1) du sponsor, aucun partage 50/50."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})

        # Chain sponsor : admin -> grand -> sp -> inv
        grand_id = str(uuid.uuid4())
        sp_id = str(uuid.uuid4())
        inv_id = str(uuid.uuid4())
        # Matrix parent used to simulate a spillover placement at L2.
        # (Different user, unrelated in sponsor chain to `sp`.)
        matrix_parent_id = str(uuid.uuid4())

        await db.users.insert_one(_mk_user(grand_id, admin["id"], "admin",
                                           f"gr_{grand_id[:6]}", max_level=2))
        await db.users.insert_one(_mk_user(sp_id, grand_id, f"gr_{grand_id[:6]}",
                                           f"sp_{sp_id[:6]}", max_level=2))
        await db.users.insert_one(_mk_user(inv_id, sp_id, f"sp_{sp_id[:6]}",
                                           f"iv_{inv_id[:6]}"))
        # Matrix parent unrelated (sponsor=admin) so spillover_ancestor != direct_ancestor.
        await db.users.insert_one(_mk_user(matrix_parent_id, admin["id"], "admin",
                                           f"mp_{matrix_parent_id[:6]}", max_level=2))

        # Reset ancestors' balances to make the measurement clear.
        await db.users.update_many(
            {"id": {"$in": [grand_id, sp_id, matrix_parent_id]}},
            {"$set": {"balance_profit": 0, "balance_upgrade": 0,
                      "commission_direct": 0, "commission_spillover": 0,
                      "total_earned": 0, "earnings_per_level": {}}},
        )

        # Trigger a spillover distribution at L2. Under OLD rule → 500/500 to
        # grand_id (sponsor chain) and to matrix_parent's ancestor.
        # Under NEW spec 2026-02 → 100 % (1000) to grand_id, nothing to
        # the matrix ancestor.
        level = 2
        commission = LEVELS_BY_NUM[level]["commission_per_invite"]  # 1000

        await distribute_commission(
            db, new_user_id=inv_id, sponsor_id=sp_id,
            parent_id=matrix_parent_id, level=level, is_spillover=True,
        )

        gr = await db.users.find_one({"id": grand_id}, {"_id": 0})
        mp = await db.users.find_one({"id": matrix_parent_id}, {"_id": 0})

        # Direct ancestor (grand_id) receives 100 % of L2 commission.
        gr_gain = gr["balance_profit"] + gr["balance_upgrade"]
        assert gr_gain == commission, \
            f"grand should receive full commission={commission}, got {gr_gain}"

        # Matrix parent should get NOTHING at L2 — no spillover_beneficiary
        # commission is emitted above L1.
        mp_gain = mp["balance_profit"] + mp["balance_upgrade"]
        assert mp_gain == 0, \
            f"matrix parent should get NOTHING at L2, got {mp_gain}"

        # No commission row of kind 'spillover_beneficiary' at L2 for anyone.
        bene = await db.commissions.find_one({
            "from_user_id": inv_id, "level": level,
            "kind": "spillover_beneficiary",
        })
        assert bene is None, "no spillover_beneficiary commission should exist at L2"

        # No commission row of kind 'spillover_sponsor' at L2 either.
        sp_kind = await db.commissions.find_one({
            "from_user_id": inv_id, "level": level,
            "kind": "spillover_sponsor",
        })
        assert sp_kind is None, "no spillover_sponsor commission should exist at L2"

        # Direct commission row exists.
        direct = await db.commissions.find_one({
            "from_user_id": inv_id, "level": level, "kind": "direct",
        })
        assert direct is not None and direct["amount"] == commission
        assert direct["user_id"] == grand_id

        await _cleanup(db, [grand_id, sp_id, inv_id, matrix_parent_id])
        cli.close()
    _run(run())


def test_L1_spillover_still_splits_50_50():
    """Régression : la règle du split 50/50 doit encore s'appliquer AU
    NIVEAU 1 (moment du placement Spillover initial)."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        sp_id = str(uuid.uuid4())
        benef_id = str(uuid.uuid4())
        inv_id = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(sp_id, admin["id"], "admin",
                                           f"sp_{sp_id[:6]}", max_level=1))
        await db.users.insert_one(_mk_user(benef_id, admin["id"], "admin",
                                           f"bn_{benef_id[:6]}", max_level=1))
        await db.users.insert_one(_mk_user(inv_id, sp_id, f"sp_{sp_id[:6]}",
                                           f"iv_{inv_id[:6]}"))

        commission = LEVELS_BY_NUM[1]["commission_per_invite"]  # 2000
        half = commission // 2  # 1000

        await distribute_commission(
            db, new_user_id=inv_id, sponsor_id=sp_id,
            parent_id=benef_id, level=1, is_spillover=True,
        )

        # sponsor row exists with 'spillover_sponsor' kind and 100 % profit.
        sp_row = await db.commissions.find_one({
            "user_id": sp_id, "from_user_id": inv_id, "level": 1,
        })
        assert sp_row is not None
        assert sp_row["kind"] == "spillover_sponsor"
        assert sp_row["amount"] == half
        assert sp_row["upgrade_share"] == 0
        assert sp_row["profit_share"] == half

        # beneficiary row exists with 'spillover_beneficiary' kind.
        bn_row = await db.commissions.find_one({
            "user_id": benef_id, "from_user_id": inv_id, "level": 1,
        })
        assert bn_row is not None
        assert bn_row["kind"] == "spillover_beneficiary"
        assert bn_row["amount"] == half

        await _cleanup(db, [sp_id, benef_id, inv_id])
        cli.close()
    _run(run())


def test_L3_and_L5_spillover_pay_100pct_no_split():
    """Vérifie que le même comportement s'applique aussi à des niveaux
    plus élevés (L3, L5) — pas de split au-dessus du L1."""
    async def run():
        db, cli = _fresh_db()
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})

        for level in (3, 5):
            # Long sponsor chain so walk_up(sponsor, level-1) reaches someone.
            chain = [str(uuid.uuid4()) for _ in range(level + 1)]
            # chain[0] = topmost eligible ancestor at level N.
            await db.users.insert_one(
                _mk_user(chain[0], admin["id"], "admin",
                         f"c0_{chain[0][:6]}", max_level=level)
            )
            prev_uid = chain[0]
            prev_username = f"c0_{chain[0][:6]}"
            for i in range(1, level + 1):
                uname = f"c{i}_{chain[i][:6]}"
                await db.users.insert_one(
                    _mk_user(chain[i], prev_uid, prev_username, uname,
                             max_level=level if i < level else 0)
                )
                prev_uid, prev_username = chain[i], uname

            invitee_id = chain[level]
            sponsor_id = chain[level - 1]

            # Unrelated matrix parent to simulate spillover.
            mp_id = str(uuid.uuid4())
            await db.users.insert_one(
                _mk_user(mp_id, admin["id"], "admin",
                         f"mp{level}_{mp_id[:6]}", max_level=level)
            )

            # Reset upstream ancestor balances so we measure this event.
            await db.users.update_many(
                {"id": {"$in": chain + [mp_id]}},
                {"$set": {"balance_profit": 0, "balance_upgrade": 0,
                          "commission_direct": 0, "commission_spillover": 0,
                          "total_earned": 0, "earnings_per_level": {}}},
            )

            commission = LEVELS_BY_NUM[level]["commission_per_invite"]

            await distribute_commission(
                db, new_user_id=invitee_id, sponsor_id=sponsor_id,
                parent_id=mp_id, level=level, is_spillover=True,
            )

            # Recipient is N-hops up sponsor chain from `sponsor_id` = chain[0].
            recipient_id = chain[0]
            rec = await db.users.find_one({"id": recipient_id}, {"_id": 0})
            gain = rec["balance_profit"] + rec["balance_upgrade"]
            assert gain == commission, (
                f"L{level}: recipient should get FULL {commission}, "
                f"got {gain}"
            )

            # No spillover_* commissions at L>=2.
            bad = await db.commissions.find_one({
                "from_user_id": invitee_id, "level": level,
                "kind": {"$in": ["spillover_sponsor", "spillover_beneficiary"]},
            })
            assert bad is None, f"L{level}: no split rows should exist"

            await _cleanup(db, chain + [mp_id])
        cli.close()
    _run(run())
