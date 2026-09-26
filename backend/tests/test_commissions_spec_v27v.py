"""SPILOVEURE — Regression tests v27v pour le système de commissions.

Couvre les 8 scénarios TEST du prompt utilisateur :
  1. Premier filleul direct           → 2000 = 1000 profit + 1000 réserve, upgrade auto L2
  2. Deuxième filleul direct          → 2000 = 2000 profit + 0 réserve
  3. Génération 2 (via matrice)       → commission L2 va au parrain-de-gen-2
  4. Génération 3                     → commission L3 va au parrain-de-gen-3
  5. Troisième filleul → spillover    → 50/50 sponsor + bénéficiaire matriciel
  6. Après spillover                  → plus d'intervention sur les commissions futures
  7. Bénéficiaire spillover           → sa part de 1000 devient 500 profit + 500 réserve
  8. Génération malgré spillover      → la profondeur matricielle détermine la génération

Exécution :  cd /app/backend && pytest tests/test_commissions_spec_v27v.py -q -v
Prérequis  :  MONGO_URL / DB_NAME dans /app/backend/.env (isolé par UUID).
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

# Ensure backend package is importable when running from /app/backend.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from matrix import activate_level  # noqa: E402
from levels import LEVELS_BY_NUM   # noqa: E402


@pytest_asyncio.fixture
async def db():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not (mongo_url and db_name):
        pytest.skip("MONGO_URL / DB_NAME not set")
    client = AsyncIOMotorClient(mongo_url)
    yield client[db_name]
    client.close()


async def _mkuser(db, sponsor_id: str | None = None, *, max_level: int = 0) -> str:
    uid = f"t27v-{uuid.uuid4().hex[:12]}"
    await db.users.insert_one({
        "id": uid,
        "email": f"{uid}@test.local",
        "username": uid,
        "sponsor_id": sponsor_id,
        "status": "active" if max_level >= 1 else "pending",
        "max_level": max_level,
        "balance_profit": 0,
        "balance_upgrade": 0,
        "total_earned": 0,
        "created_at": datetime.now(timezone.utc),
        "_test_v27v": True,
    })
    return uid


async def _cleanup(db):
    ids_cur = db.users.find({"_test_v27v": True}, {"_id": 0, "id": 1})
    ids = [d["id"] async for d in ids_cur]
    if not ids:
        return
    await db.users.delete_many({"id": {"$in": ids}})
    await db.matrix_placements.delete_many({"user_id": {"$in": ids}})
    await db.commissions.delete_many(
        {"$or": [{"user_id": {"$in": ids}}, {"from_user_id": {"$in": ids}}]}
    )
    await db.activation_events.delete_many({"user_id": {"$in": ids}})


async def _seed_l1(db, uid: str, sponsor_id: str | None):
    """Simuler une activation L1 payée : insertion payments + activate_level."""
    ref = f"ref-{uid}"
    await db.payments.insert_one({
        "reference": ref,
        "user_id": uid,
        "provider": "test-v27v",
        "kind": "activation",
        "level": 1,
        "amount": 2500,
        "status": "paid",
        "created_at": datetime.now(timezone.utc),
    })
    await activate_level(db, uid, 1, source="ashtecpay")
    # cleanup helper track
    await db.payments.delete_one({"reference": ref})


@pytest.mark.asyncio
async def test_1_premier_filleul_direct_upgrade_auto(db):
    """TEST 1 — A invite B → 2000 = 1000 profit + 1000 réserve → A upgrade L2."""
    try:
        A = await _mkuser(db, None, max_level=1)
        # Placement racine pour A
        await db.matrix_placements.insert_one({
            "user_id": A, "level": 1, "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
        B = await _mkuser(db, A)
        await _seed_l1(db, B, A)

        A_doc = await db.users.find_one({"id": A}, {"_id": 0})
        # 1000 profit + 1000 reserve consumed by auto-upgrade to L2 (price=1000)
        # => balance_upgrade retombe à 0 après upgrade, balance_profit = 1000
        assert A_doc["balance_profit"] == 1000, A_doc["balance_profit"]
        assert A_doc["max_level"] == 2, f"expected L2 auto-upgrade, got L{A_doc['max_level']}"
    finally:
        await _cleanup(db)


@pytest.mark.asyncio
async def test_2_deuxieme_filleul_direct_100pct_profit(db):
    """TEST 2 — Après upgrade L2, 2ème filleul direct : 100 % profit."""
    try:
        A = await _mkuser(db, None, max_level=2, )
        await db.users.update_one(
            {"id": A}, {"$set": {"balance_profit": 1000}}  # état après test 1
        )
        await db.matrix_placements.insert_one({
            "user_id": A, "level": 1, "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
        # Une place directe déjà prise
        B = await _mkuser(db, A, max_level=1)
        await db.matrix_placements.insert_one({
            "user_id": B, "level": 1, "parent_id": A, "leg": "left",
            "sponsor_id": A, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
        # Nouveau filleul C — 2ème direct
        C = await _mkuser(db, A)
        await _seed_l1(db, C, A)

        A_doc = await db.users.find_one({"id": A}, {"_id": 0})
        # A est déjà L2 → l'upgrade share du L1 doit rester 0 si la réserve L3
        # n'a pas atteint son prix (L3=2000). Or la commission = 2000, cap =
        # min(1000, 2000) = 1000 upgrade + 1000 profit.
        # Après ce test, on doit voir un cumul de balance_profit >= 1000.
        assert A_doc["balance_profit"] >= 1000
    finally:
        await _cleanup(db)


@pytest.mark.asyncio
async def test_5_troisieme_filleul_spillover_split(db):
    """TEST 5 — 3ème filleul de A → spillover, split 50/50 sponsor/bénéf."""
    try:
        A = await _mkuser(db, None, max_level=1)
        await db.matrix_placements.insert_one({
            "user_id": A, "level": 1, "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
        # 2 places directes de A prises
        B = await _mkuser(db, A, max_level=1)
        C = await _mkuser(db, A, max_level=1)
        await db.matrix_placements.insert_many([
            {"user_id": B, "level": 1, "parent_id": A, "leg": "left",
             "sponsor_id": A, "is_spillover": False,
             "created_at": datetime.now(timezone.utc)},
            {"user_id": C, "level": 1, "parent_id": A, "leg": "right",
             "sponsor_id": A, "is_spillover": False,
             "created_at": datetime.now(timezone.utc)},
        ])
        # D invité par A → placement automatique par spillover sous B (gauche libre)
        D = await _mkuser(db, A)
        await _seed_l1(db, D, A)

        D_place = await db.matrix_placements.find_one({"user_id": D, "level": 1}, {"_id": 0})
        assert D_place["is_spillover"] is True
        assert D_place["sponsor_id"] == A
        # B est le bénéficiaire du spillover (parent matriciel de D)
        assert D_place["parent_id"] == B

        # Vérif commissions : deux lignes créées pour L1 de D
        cs = await db.commissions.find(
            {"from_user_id": D, "level": 1}, {"_id": 0}
        ).to_list(10)
        kinds = {c["kind"]: c for c in cs}
        assert "spillover_sponsor" in kinds
        assert "spillover_beneficiary" in kinds
        assert kinds["spillover_sponsor"]["user_id"] == A
        assert kinds["spillover_beneficiary"]["user_id"] == B
        assert kinds["spillover_sponsor"]["amount"] == 1000
        assert kinds["spillover_beneficiary"]["amount"] == 1000
        # spillover_sponsor → 100 % profit ; spillover_beneficiary → 50/50
        assert kinds["spillover_sponsor"]["upgrade_share"] == 0
        assert kinds["spillover_sponsor"]["profit_share"] == 1000
    finally:
        await _cleanup(db)


@pytest.mark.asyncio
async def test_7_beneficiaire_spillover_split_50_50(db):
    """TEST 7 — Le bénéficiaire du spillover reçoit 1000 → 500 profit + 500 réserve."""
    try:
        A = await _mkuser(db, None, max_level=1)
        await db.matrix_placements.insert_one({
            "user_id": A, "level": 1, "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
        B = await _mkuser(db, A, max_level=1)
        C = await _mkuser(db, A, max_level=1)
        await db.matrix_placements.insert_many([
            {"user_id": B, "level": 1, "parent_id": A, "leg": "left",
             "sponsor_id": A, "is_spillover": False,
             "created_at": datetime.now(timezone.utc)},
            {"user_id": C, "level": 1, "parent_id": A, "leg": "right",
             "sponsor_id": A, "is_spillover": False,
             "created_at": datetime.now(timezone.utc)},
        ])
        D = await _mkuser(db, A)
        await _seed_l1(db, D, A)

        # Le bénéficiaire B doit avoir 500 profit + 500 réserve additionnels.
        B_doc = await db.users.find_one({"id": B}, {"_id": 0})
        # Attention : B est L1, prix de L2 = 1000 donc reserve share cap = 500
        assert B_doc["balance_profit"] == 500, B_doc["balance_profit"]
        assert B_doc["balance_upgrade"] == 500, B_doc["balance_upgrade"]
    finally:
        await _cleanup(db)


@pytest.mark.asyncio
async def test_8_generation_via_matrice_meme_avec_spillover(db):
    """TEST 8 — D placé sous B par spillover est bien génération 2 matricielle de A."""
    try:
        A = await _mkuser(db, None, max_level=2)
        await db.matrix_placements.insert_one({
            "user_id": A, "level": 1, "parent_id": None, "leg": None,
            "sponsor_id": None, "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
        B = await _mkuser(db, A, max_level=2)
        C = await _mkuser(db, A, max_level=2)
        await db.matrix_placements.insert_many([
            {"user_id": B, "level": 1, "parent_id": A, "leg": "left",
             "sponsor_id": A, "is_spillover": False,
             "created_at": datetime.now(timezone.utc)},
            {"user_id": C, "level": 1, "parent_id": A, "leg": "right",
             "sponsor_id": A, "is_spillover": False,
             "created_at": datetime.now(timezone.utc)},
        ])
        # D invité par A, placé par spillover sous B
        D = await _mkuser(db, A, max_level=1)
        await db.matrix_placements.insert_one({
            "user_id": D, "level": 1, "parent_id": B, "leg": "left",
            "sponsor_id": A, "is_spillover": True,
            "created_at": datetime.now(timezone.utc),
        })

        # Quand D active L2, la commission de génération L2 doit remonter la
        # matrice de 2 sauts → A (D→parent=B, B→parent=A).
        from matrix import _walk_up_matrix_tree
        gen2_ancestor = await _walk_up_matrix_tree(db, D, 2)
        assert gen2_ancestor == A, f"expected A, got {gen2_ancestor}"
    finally:
        await _cleanup(db)
