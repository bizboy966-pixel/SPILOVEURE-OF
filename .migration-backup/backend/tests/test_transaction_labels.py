"""Regression tests for the user-facing labels of transaction history commissions.

Rule (2026-07-07):
    - "Commission directe" = commission where the from_user was sponsored (via
      `users.sponsor_id`) by the recipient, regardless of activation level or
      matrix spillover placement.
    - "Commission niveau X" = MLM commission where the recipient is NOT the
      direct sponsor of the from_user (matrix ancestor or higher hop up sponsor
      chain).
    - Lottery kinds keep dedicated labels.
    - No jargon (Spillover / Parrain / Bénéficiaire) must ever appear.

Run: cd /app/backend && python tests/test_transaction_labels.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from motor.motor_asyncio import AsyncIOMotorClient

from server import _build_transaction_history


TEST_DB_NAME = "spilivere_test_labels"


async def _seed_user(db, username: str, sponsor_id: str | None = None) -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({"id": uid, "username": username, "sponsor_id": sponsor_id})
    return uid


async def _seed_commission(db, user_id, from_user_id, level, kind, amount=1000):
    await db.commissions.insert_one({
        "user_id": user_id,
        "from_user_id": from_user_id,
        "level": level,
        "kind": kind,
        "amount": amount,
        "upgrade_share": 0,
        "profit_share": amount,
        "created_at": datetime.now(timezone.utc),
    })


def _mlm_labels(history):
    return [t["label"] for t in history if t["type"].startswith("commission_")]


async def run_tests():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[TEST_DB_NAME]
    # Fresh state
    for coll in ("users", "commissions", "activations", "payments", "withdrawals",
                 "mission_wallet", "mission_credits", "missions", "mission_withdrawals"):
        await db[coll].delete_many({})

    print("=" * 70)
    print("TEST 1: direct referral (any kind at L1) → 'Commission directe'")
    print("=" * 70)
    sponsor_id = await _seed_user(db, "sponsor1")
    new_uid = await _seed_user(db, "new1", sponsor_id=sponsor_id)
    await _seed_commission(db, sponsor_id, new_uid, level=1, kind="direct")
    await _seed_commission(db, sponsor_id, new_uid, level=1, kind="spillover_sponsor")
    history = await _build_transaction_history(db, sponsor_id)
    labels = _mlm_labels(history)
    assert labels == ["Commission directe", "Commission directe"], labels
    assert not any(j in l for l in labels for j in ("Spillover", "Parrain", "Bénéficiaire"))
    print("  ✅ PASS")

    print("\n" + "=" * 70)
    print("TEST 2: matrix ancestor (not direct sponsor) → 'Commission niveau X'")
    print("=" * 70)
    root = await _seed_user(db, "root2")
    mid = await _seed_user(db, "mid2", sponsor_id=root)
    child = await _seed_user(db, "child2", sponsor_id=mid)
    # root receives a spillover_beneficiary commission at level 2 from `child`
    # (child's sponsor is `mid`, not `root`) → "Commission niveau 2"
    await _seed_commission(db, root, child, level=2, kind="spillover_beneficiary")
    history = await _build_transaction_history(db, root)
    labels = _mlm_labels(history)
    assert labels == ["Commission niveau 2"], labels
    print("  ✅ PASS")

    print("\n" + "=" * 70)
    print("TEST 3: deleted from_user, level=1 fallback → 'Commission directe'")
    print("=" * 70)
    sponsor_id = await _seed_user(db, "sponsor3")
    ghost_uid = str(uuid.uuid4())  # not in db.users
    await _seed_commission(db, sponsor_id, ghost_uid, level=1, kind="direct")
    await _seed_commission(db, sponsor_id, ghost_uid, level=1, kind="spillover_sponsor")
    await _seed_commission(db, sponsor_id, ghost_uid, level=3, kind="spillover_beneficiary")
    history = await _build_transaction_history(db, sponsor_id)
    labels = sorted(_mlm_labels(history))
    assert labels == ["Commission directe", "Commission directe", "Commission niveau 3"], labels
    print("  ✅ PASS")

    print("\n" + "=" * 70)
    print("TEST 4: lottery kinds → dedicated labels")
    print("=" * 70)
    user_id = await _seed_user(db, "player4")
    await _seed_commission(db, user_id, None, level=None, kind="lottery_entry", amount=-500)
    await _seed_commission(db, user_id, None, level=None, kind="lottery_win", amount=2000)
    await _seed_commission(db, user_id, None, level=None, kind="lottery_loss", amount=0)
    history = await _build_transaction_history(db, user_id)
    labels = sorted(_mlm_labels(history))
    assert labels == ["Gain Loterie", "Participation Loterie", "Perte Loterie"], labels
    print("  ✅ PASS")

    print("\n" + "=" * 70)
    print("TEST 5: no MLM jargon anywhere in any label")
    print("=" * 70)
    jargon = ("Spillover", "Parrain", "Bénéficiaire")
    all_history = []
    for uid in {sponsor_id, root, mid, child, user_id}:
        all_history.extend(await _build_transaction_history(db, uid))
    for t in all_history:
        assert not any(j in (t.get("label") or "") for j in jargon), f"Jargon in {t}"
    print(f"  ✅ PASS ({len(all_history)} transactions scanned)")

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED ✅")
    print("=" * 70 + "\n")

    await client.drop_database(TEST_DB_NAME)
    client.close()


if __name__ == "__main__":
    asyncio.run(run_tests())
