"""Regression tests for the Team section endpoints (/team/direct, /team/indirect).

Business rules (2026-07-07):
    - "Équipe directe" = users where sponsor_id == me (regardless of matrix
      spillover placement).
    - "Équipe indirecte" = the rest of my network:
        * all descendants of my directs down the sponsor chain (transitively),
        * PLUS users placed under me via Spillover (parent_id == me and
          is_spillover == True).
    - The two lists must never overlap.

Run: cd /app/backend && python tests/test_team_endpoints.py
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

# We call the underlying endpoint bodies via a fake Request object.
from types import SimpleNamespace
from server import team_direct, team_indirect  # type: ignore


TEST_DB_NAME = "spilivere_test_team_endpoints"


async def _mk_user(db, username: str, sponsor_id: str | None = None, status: str = "active") -> str:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid,
        "username": username,
        "sponsor_id": sponsor_id,
        "status": status,
        "max_level": 1 if status == "active" else 0,
        "created_at": datetime.now(timezone.utc),
    })
    return uid


async def _spillover_placement(db, user_id: str, parent_id: str, level: int = 1):
    await db.matrix_placements.insert_one({
        "user_id": user_id,
        "parent_id": parent_id,
        "level": level,
        "is_spillover": True,
        "created_at": datetime.now(timezone.utc),
    })


async def _call(handler, db, user_doc):
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    return await handler(req, user=user_doc)


async def run_tests():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[TEST_DB_NAME]
    for coll in ("users", "matrix_placements"):
        await db[coll].delete_many({})

    print("=" * 70)
    print("TEST 1: direct = sponsor_id==me (Spillover placement irrelevant)")
    print("=" * 70)
    me = await _mk_user(db, "me")
    b = await _mk_user(db, "B", sponsor_id=me)
    c = await _mk_user(db, "C", sponsor_id=me)
    # B was spillover-placed under someone else, doesn't matter for direct list
    other = await _mk_user(db, "other")
    await _spillover_placement(db, b, other)
    res = await _call(team_direct, db, {"id": me})
    assert res["total"] == 2, res
    assert {m["username"] for m in res["members"]} == {"B", "C"}, res
    print(f"  ✅ PASS — direct={res['total']} (B, C)")

    print("\n" + "=" * 70)
    print("TEST 2: indirect = sponsor tree descendants of my directs")
    print("=" * 70)
    # b → d (indirect via sponsor chain)
    d = await _mk_user(db, "D", sponsor_id=b)
    e = await _mk_user(db, "E", sponsor_id=d)  # deeper descendant
    res = await _call(team_indirect, db, {"id": me})
    assert res["total"] == 2, res
    assert {m["username"] for m in res["members"]} == {"D", "E"}, res
    print(f"  ✅ PASS — indirect={res['total']} (D, E)")

    print("\n" + "=" * 70)
    print("TEST 3: indirect += Spillover placements from OUTSIDE my sponsor tree")
    print("=" * 70)
    # Someone else (not my sponsor descendant) is spillover-placed under me
    outsider = await _mk_user(db, "outsider", sponsor_id=other)
    await _spillover_placement(db, outsider, me)
    res = await _call(team_indirect, db, {"id": me})
    names = {m["username"] for m in res["members"]}
    assert "outsider" in names, res
    assert names == {"D", "E", "outsider"}, res
    print(f"  ✅ PASS — indirect={res['total']} (D, E, outsider)")

    print("\n" + "=" * 70)
    print("TEST 4: direct ∩ indirect == ∅ (even if a direct is spillover'd under me)")
    print("=" * 70)
    # Force a Spillover placement of a DIRECT filleul (B) under me.
    await _spillover_placement(db, b, me)
    direct = await _call(team_direct, db, {"id": me})
    indirect = await _call(team_indirect, db, {"id": me})
    direct_ids = {m["id"] for m in direct["members"]}
    indirect_ids = {m["id"] for m in indirect["members"]}
    overlap = direct_ids & indirect_ids
    assert overlap == set(), f"Overlap detected: {overlap}"
    assert b in direct_ids and b not in indirect_ids
    print(f"  ✅ PASS — direct={len(direct_ids)}, indirect={len(indirect_ids)}, overlap=0")

    print("\n" + "=" * 70)
    print("TEST 5: active/inactive counters")
    print("=" * 70)
    # Make one user inactive
    await db.users.update_one({"id": d}, {"$set": {"status": "pending", "max_level": 0}})
    direct = await _call(team_direct, db, {"id": me})
    indirect = await _call(team_indirect, db, {"id": me})
    assert direct["active"] + direct["inactive"] == direct["total"]
    assert indirect["active"] + indirect["inactive"] == indirect["total"]
    assert indirect["inactive"] >= 1  # D is pending
    print(f"  ✅ PASS — direct(A/I)={direct['active']}/{direct['inactive']}, "
          f"indirect(A/I)={indirect['active']}/{indirect['inactive']}")

    print("\n" + "=" * 70)
    print("ALL TESTS PASSED ✅")
    print("=" * 70 + "\n")

    await client.drop_database(TEST_DB_NAME)
    client.close()


if __name__ == "__main__":
    asyncio.run(run_tests())
