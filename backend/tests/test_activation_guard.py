"""Security regression — matrix.activate_level() MUST refuse to activate a
user for external-payment sources when no matching payment record exists.

This closes the loophole flagged by the product owner:
    « Sans paiement valide = aucune activation du compte. »
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from matrix import activate_level  # noqa: E402
import auth as _auth  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


def _mk_user(uid: str, admin_id: str) -> dict:
    return {
        "id": uid, "username": f"guard_{uid[:6]}", "email": f"guard_{uid[:6]}@x.com",
        "phone": "+228x", "country": "TG",
        "password_hash": _auth.hash_password("x"),
        "role": "user", "status": "pending", "max_level": 0,
        "sponsor_id": admin_id, "sponsor_username": "admin",
        "balance_profit": 0, "balance_upgrade": 0,
        "commission_direct": 0, "commission_spillover": 0,
        "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }


async def _cleanup(db, uid):
    await db.users.delete_one({"id": uid})
    await db.payments.delete_many({"user_id": uid})
    await db.activations.delete_many({"user_id": uid})
    await db.matrix_placements.delete_many({"user_id": uid})
    await db.commissions.delete_many({"$or": [{"user_id": uid}, {"from_user_id": uid}]})


def test_activate_level_refuses_unknown_source():
    """Calling with a random source string must be rejected before touching DB."""
    async def run():
        cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        db = cli[os.environ.get("DB_NAME", "spilivere")]
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        uid = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(uid, admin["id"]))
        try:
            with pytest.raises(ValueError, match="Source d'activation invalide"):
                await activate_level(db, uid, 1, source="hacker_input")
            u = await db.users.find_one({"id": uid}, {"_id": 0})
            assert u["status"] == "pending"
            assert u["max_level"] == 0
        finally:
            await _cleanup(db, uid)
            cli.close()

    asyncio.get_event_loop().run_until_complete(run())


def test_activate_level_refuses_external_source_without_payment():
    """Even a WHITELISTED external source (soleaspay/ashtecpay/…) must fail if
    no matching payment or activation record exists."""
    async def run():
        cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        db = cli[os.environ.get("DB_NAME", "spilivere")]
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        uid = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(uid, admin["id"]))
        try:
            for src in ("soleaspay", "ashtecpay", "sendavapay",
                        "gateway_return", "admin_validate", "manual_reprocess"):
                with pytest.raises(ValueError, match="aucun paiement ou demande"):
                    await activate_level(db, uid, 1, source=src)
            u = await db.users.find_one({"id": uid}, {"_id": 0})
            assert u["status"] == "pending", f"account was activated without payment: {u}"
            assert u["max_level"] == 0
        finally:
            await _cleanup(db, uid)
            cli.close()

    asyncio.get_event_loop().run_until_complete(run())


def test_activate_level_accepts_when_payment_row_exists():
    """The very same call succeeds once a paid payment row is inserted first."""
    async def run():
        cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        db = cli[os.environ.get("DB_NAME", "spilivere")]
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        uid = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(uid, admin["id"]))
        await db.payments.insert_one({
            "reference": f"OK_{uid[:6]}",
            "user_id": uid, "level": 1,
            "status": "paid", "amount": 5000,
            "created_at": datetime.now(timezone.utc),
        })
        try:
            await activate_level(db, uid, 1, source="soleaspay")
            u = await db.users.find_one({"id": uid}, {"_id": 0})
            assert u["status"] == "active"
            assert u["max_level"] == 1
        finally:
            await _cleanup(db, uid)
            cli.close()

    asyncio.get_event_loop().run_until_complete(run())


def test_admin_manual_still_works_at_l1_without_payment():
    """`admin_manual` is the documented exempt path (admin grants complimentary
    L1 activation). Must keep working. All other exempts (auto_upgrade/manual)
    only apply from L2 upwards and require a funded balance_upgrade."""
    async def run():
        cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        db = cli[os.environ.get("DB_NAME", "spilivere")]
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        uid = str(uuid.uuid4())
        await db.users.insert_one(_mk_user(uid, admin["id"]))
        try:
            await activate_level(db, uid, 1, source="admin_manual")
            u = await db.users.find_one({"id": uid}, {"_id": 0})
            assert u["status"] == "active"
            assert u["max_level"] == 1
        finally:
            await _cleanup(db, uid)
            cli.close()

    asyncio.get_event_loop().run_until_complete(run())
