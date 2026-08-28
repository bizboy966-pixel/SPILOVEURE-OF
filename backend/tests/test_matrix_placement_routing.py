"""Commission routing — spec finale 2026-08-27 (Spillover 50/50 UNIQUEMENT au L1).

Règles :
▸ Level 1 : spillover (parent_id ≠ sponsor_id ET is_spillover=True) → 50/50
             sinon 100 % au sponsor direct.
▸ Level ≥ 2 : IGNORE is_spillover. Le bénéficiaire est l'ancêtre situé
             exactement `level` sauts au-dessus dans l'arbre de PLACEMENTS
             de niveau 1 (`matrix_placements.parent_id` où `level=1`).
             Si la racine est atteinte avant → aucune commission.
             Aucun split : 100 % à cet ancêtre.

Ces tests remplacent l'ancienne spec 2026-08-20 qui appliquait le split
50/50 à tous les niveaux — invalidée par la clarification produit du
2026-08-27.
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


async def _seed_l1_placement(db, uid: str, parent_id: str | None, sponsor_id: str | None):
    """Crée un enregistrement `matrix_placements` niveau 1 pour définir la chaîne d'ancêtres."""
    await db.matrix_placements.insert_one({
        "user_id": uid, "level": 1,
        "parent_id": parent_id, "leg": "left",
        "sponsor_id": sponsor_id,
        "is_spillover": bool(parent_id and sponsor_id and parent_id != sponsor_id),
        "created_at": datetime.now(timezone.utc),
    })


async def _cleanup(db, uids: list[str]):
    await db.users.delete_many({"id": {"$in": uids}})
    await db.matrix_placements.delete_many({"user_id": {"$in": uids}})
    await db.commissions.delete_many({"$or": [
        {"user_id": {"$in": uids}}, {"from_user_id": {"$in": uids}},
    ]})


# ─────────────────────────────────────────────────────────────────────────────
# LEVEL 1 — spillover 50/50 (spec §9)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_L1_spillover_splits_50_50_between_sponsor_and_parent():
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        sponsor = f"t-sp-{uuid.uuid4().hex[:8]}"
        parent  = f"t-pr-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, sponsor, None, max_level=1)
        await _seed_user(db, parent,  None, max_level=1)
        await _seed_user(db, activator, sponsor, max_level=0)

        credits = await distribute_commission(
            db, activator, sponsor_id=sponsor, parent_id=parent,
            level=1, is_spillover=True,
        )
        commission = LEVELS_BY_NUM[1]["commission_per_invite"]
        expected_half = commission // 2
        recipients = {c["user_id"]: (c["amount"], c["kind"]) for c in credits}
        assert sponsor in recipients, f"sponsor missing: {recipients}"
        assert parent in recipients,  f"parent missing: {recipients}"
        assert recipients[sponsor] == (expected_half, "spillover_sponsor")
        assert recipients[parent]  == (commission - expected_half, "spillover_beneficiary")
    finally:
        await _cleanup(db, [sponsor, parent, activator])
        cli.close()


@pytest.mark.asyncio
async def test_L1_non_spillover_pays_sponsor_fully():
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        sponsor = f"t-sp-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, sponsor, None, max_level=1)
        await _seed_user(db, activator, sponsor, max_level=0)
        credits = await distribute_commission(
            db, activator, sponsor_id=sponsor, parent_id=sponsor,
            level=1, is_spillover=False,
        )
        commission = LEVELS_BY_NUM[1]["commission_per_invite"]
        assert len(credits) == 1
        assert credits[0]["user_id"] == sponsor
        assert credits[0]["amount"] == commission
        assert credits[0]["kind"] == "direct"
    finally:
        await _cleanup(db, [sponsor, activator])
        cli.close()


# ─────────────────────────────────────────────────────────────────────────────
# LEVEL ≥ 2 — walk L1 tree, 100 % à l'ancêtre à N sauts (spec 2026-08-27)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_L2_pays_100pct_to_grandparent_in_L1_tree():
    """L2 → l'ancêtre à 2 sauts au-dessus dans l'arbre L1, quel que soit le
    parcours de placement de l'activateur."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        gp = f"t-gp-{uuid.uuid4().hex[:8]}"       # grandparent (target du L2)
        p  = f"t-p-{uuid.uuid4().hex[:8]}"        # parent direct
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, gp, None, max_level=2)
        await _seed_user(db, p,  gp,   max_level=1)
        await _seed_user(db, activator, p, max_level=1)
        # Arbre L1 : activator -> p -> gp
        await _seed_l1_placement(db, gp, None, None)
        await _seed_l1_placement(db, p, gp, gp)
        await _seed_l1_placement(db, activator, p, p)

        credits = await distribute_commission(
            db, activator, sponsor_id=p, parent_id=p,
            level=2, is_spillover=False,
        )
        commission = LEVELS_BY_NUM[2]["commission_per_invite"]
        assert len(credits) == 1, f"expected 1 credit at gp, got {credits}"
        assert credits[0]["user_id"] == gp
        assert credits[0]["amount"] == commission
        assert credits[0]["kind"] == "direct"
    finally:
        await _cleanup(db, [gp, p, activator])
        cli.close()


@pytest.mark.asyncio
async def test_L2_ignores_spillover_flag_no_split():
    """Spec 2026-08-27 : au L2+, le flag spillover est IGNORÉ. Peu importe si
    l'activateur est arrivé via spillover — la commission va 100 % à
    l'ancêtre à 2 sauts, sans split."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        gp = f"t-gp-{uuid.uuid4().hex[:8]}"
        p  = f"t-p-{uuid.uuid4().hex[:8]}"
        sponsor_direct = f"t-sd-{uuid.uuid4().hex[:8]}"  # sponsor original (autre chaîne)
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, gp, None, max_level=2)
        await _seed_user(db, p,  gp,   max_level=2)
        await _seed_user(db, sponsor_direct, None, max_level=2)
        await _seed_user(db, activator, sponsor_direct, max_level=1)
        # Arbre L1 : activator placé sous p (spillover), pas sous sponsor_direct
        await _seed_l1_placement(db, gp, None, None)
        await _seed_l1_placement(db, p, gp, gp)
        await _seed_l1_placement(db, activator, p, sponsor_direct)

        credits = await distribute_commission(
            db, activator, sponsor_id=sponsor_direct, parent_id=p,
            level=2, is_spillover=True,
        )
        commission = LEVELS_BY_NUM[2]["commission_per_invite"]
        # SEUL gp doit être crédité — pas de split, sponsor_direct/p ignorés au L2.
        assert len(credits) == 1, f"L2 doit être single-recipient, got {credits}"
        assert credits[0]["user_id"] == gp
        assert credits[0]["amount"] == commission
        assert credits[0]["kind"] == "direct"
        # Aucune commission "spillover_*" au L2 ne doit avoir été créée.
        spill_rows = await db.commissions.count_documents({
            "from_user_id": activator,
            "kind": {"$in": ["spillover_sponsor", "spillover_beneficiary"]},
        })
        assert spill_rows == 0, "aucun split spillover ne doit exister au L2"
    finally:
        await _cleanup(db, [gp, p, sponsor_direct, activator])
        cli.close()


@pytest.mark.asyncio
async def test_L3_pays_100pct_to_3hop_ancestor():
    """L3 → l'ancêtre à 3 sauts au-dessus dans l'arbre L1."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        ggp = f"t-ggp-{uuid.uuid4().hex[:8]}"
        gp  = f"t-gp-{uuid.uuid4().hex[:8]}"
        p   = f"t-p-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, ggp, None, max_level=3)
        await _seed_user(db, gp,  ggp,  max_level=2)
        await _seed_user(db, p,   gp,   max_level=1)
        await _seed_user(db, activator, p, max_level=2)
        # Arbre L1 : activator -> p -> gp -> ggp
        await _seed_l1_placement(db, ggp, None, None)
        await _seed_l1_placement(db, gp, ggp, ggp)
        await _seed_l1_placement(db, p, gp, gp)
        await _seed_l1_placement(db, activator, p, p)

        credits = await distribute_commission(
            db, activator, sponsor_id=p, parent_id=p,
            level=3, is_spillover=False,
        )
        commission = LEVELS_BY_NUM[3]["commission_per_invite"]
        assert len(credits) == 1
        assert credits[0]["user_id"] == ggp
        assert credits[0]["amount"] == commission
    finally:
        await _cleanup(db, [ggp, gp, p, activator])
        cli.close()


@pytest.mark.asyncio
async def test_L2_no_commission_when_ancestor_missing():
    """Si l'arbre L1 est cassé (moins de 2 hops disponibles), aucune
    commission n'est distribuée au L2."""
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    try:
        p = f"t-p-{uuid.uuid4().hex[:8]}"
        activator = f"t-ac-{uuid.uuid4().hex[:8]}"
        await _seed_user(db, p, None, max_level=2)
        await _seed_user(db, activator, p, max_level=1)
        # Arbre L1 : activator -> p (racine). Seulement 1 hop dispo.
        await _seed_l1_placement(db, p, None, None)
        await _seed_l1_placement(db, activator, p, p)

        credits = await distribute_commission(
            db, activator, sponsor_id=p, parent_id=p,
            level=2, is_spillover=False,
        )
        assert credits == [], f"aucune commission attendue, got {credits}"
    finally:
        await _cleanup(db, [p, activator])
        cli.close()
