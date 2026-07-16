"""Regression tests for the Challenge module.

Business rules (2026-07-08):
- Progress = count of direct referrals (sponsor_id == me) whose L1 activation
  (`level_activated_at.1`) falls within [start_at, end_at].
- Accounts activated BEFORE start_at are excluded (Cas 3).
- Accounts registered BEFORE start_at but activated during the window count (Cas 1).
- Accounts registered & activated during the window count (Cas 2).
- Only ONE active challenge at a time.

Run: cd /app/backend && python tests/test_challenges.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from motor.motor_asyncio import AsyncIOMotorClient
from types import SimpleNamespace

from challenges import (  # type: ignore
    current_challenge,
    create_challenge,
    list_challenges,
    challenge_participants,
    ChallengeCreate,
)


TEST_DB_NAME = "spilivere_test_challenges"


async def _mk_user(db, username, sponsor_id=None, registered_at=None, activated_at=None):
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "username": username,
        "sponsor_id": sponsor_id,
        "status": "active" if activated_at else "pending",
        "max_level": 1 if activated_at else 0,
        "created_at": registered_at or datetime.now(timezone.utc),
        "level_activated_at": {"1": activated_at} if activated_at else {},
    }
    await db.users.insert_one(doc)
    return uid


async def _call(handler, db, user_doc=None, **kw):
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    if user_doc is not None:
        return await handler(request=req, user=user_doc, **kw)
    return await handler(request=req, **kw)


async def run_tests():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[TEST_DB_NAME]
    for coll in ("users", "challenges"):
        await db[coll].delete_many({})

    me = await _mk_user(db, "me")

    # Timeline: use dates around `now` so the window is currently active.
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=10)   # window started 10 days ago
    end = now + timedelta(days=30)     # ends in 30 days
    before_window = now - timedelta(days=20)   # exclusion boundary
    in_window_1 = now - timedelta(days=5)
    in_window_2 = now - timedelta(days=1)

    print("=" * 70)
    print("SETUP: challenge & 4 direct referrals")
    print("=" * 70)
    payload = ChallengeCreate(
        name="Test", target=100, reward_amount=30000, reward_currency="FCFA",
        start_at=start, end_at=end, active=True,
    )
    ch = await _call(create_challenge, db, data=payload)
    print(f"  Challenge id={ch['id']}, active={ch['active']}")

    # Cas 1 — registered before window, activated in window → COUNTS
    u1 = await _mk_user(
        db, "cas1", sponsor_id=me,
        registered_at=now - timedelta(days=40),
        activated_at=in_window_1,
    )
    # Cas 2 — registered & activated in window → COUNTS
    u2 = await _mk_user(
        db, "cas2", sponsor_id=me,
        registered_at=now - timedelta(days=3),
        activated_at=in_window_2,
    )
    # Cas 3 — activated BEFORE window → EXCLUDED
    u3 = await _mk_user(
        db, "cas3", sponsor_id=me,
        registered_at=now - timedelta(days=60),
        activated_at=before_window,
    )
    # Cas 4 — registered in window, still pending → EXCLUDED
    u4 = await _mk_user(
        db, "cas4", sponsor_id=me,
        registered_at=now - timedelta(days=2),
        activated_at=None,
    )
    # Outsider — not our direct → EXCLUDED
    outsider = await _mk_user(
        db, "outsider", sponsor_id=None,
        activated_at=in_window_1,
    )
    print("  Directs of me: 4 (cas1..cas4). Outsider (no sponsor): 1.")

    print("\n" + "=" * 70)
    print("TEST 1: `now` inside window → challenge visible, progress = 2 (cas1 + cas2)")
    print("=" * 70)
    res = await _call(current_challenge, db, user_doc={"id": me})
    assert res["challenge"] is not None, res
    assert res["progress"] == 2, res
    assert res["completed"] is False, res
    print(f"  ✅ PASS — progress={res['progress']}/100, completed={res['completed']}")

    print("\n" + "=" * 70)
    print("TEST 2: participants aggregation → only `me` with count=2")
    print("=" * 70)
    res = await _call(challenge_participants, db, challenge_id=ch["id"])
    assert res["winners_count"] == 0
    # me + outsider is also aggregated (outsider has no sponsor so filtered out)
    me_row = [p for p in res["participants"] if p["user_id"] == me]
    assert len(me_row) == 1 and me_row[0]["progress"] == 2, res
    print(f"  ✅ PASS — participants: {len(res['participants'])}, me.progress={me_row[0]['progress']}")

    print("\n" + "=" * 70)
    print("TEST 3: target reached → completed=True, still no auto reward")
    print("=" * 70)
    # Shrink target so `me` becomes a winner with 2 activations.
    await db.challenges.update_one({"id": ch["id"]}, {"$set": {"target": 2}})
    res = await _call(current_challenge, db, user_doc={"id": me})
    assert res["completed"] is True, res
    # Ensure NO commission / reward has been credited.
    user = await db.users.find_one({"id": me})
    assert (user.get("balance_profit") or 0) == 0, "No auto reward must be credited"
    print(f"  ✅ PASS — target reached, no auto credit (balance_profit={user.get('balance_profit', 0)})")

    print("\n" + "=" * 70)
    print("TEST 4: create a 2nd active challenge → previous is de-activated")
    print("=" * 70)
    p2 = ChallengeCreate(
        name="C2", target=50, reward_amount=1000, reward_currency="FCFA",
        start_at=now - timedelta(days=1), end_at=now + timedelta(days=30),
        active=True,
    )
    await _call(create_challenge, db, data=p2)
    all_ch = await _call(list_challenges, db)
    active = [c for c in all_ch["items"] if c["active"]]
    assert len(active) == 1, f"Only 1 active allowed, got {len(active)}"
    assert active[0]["name"] == "C2"
    print(f"  ✅ PASS — only 1 active challenge remains: {active[0]['name']}")

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED ✅")
    print("=" * 70 + "\n")

    await client.drop_database(TEST_DB_NAME)
    client.close()


if __name__ == "__main__":
    asyncio.run(run_tests())
