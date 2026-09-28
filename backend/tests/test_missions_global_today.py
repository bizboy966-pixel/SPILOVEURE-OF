"""v27t regression — ensures the daily mission is the SAME for every user.

We verify:
  1. Deux utilisateurs différents reçoivent la MÊME mission (même id).
  2. Un utilisateur ayant validé la mission la voit toujours dans le feed,
     avec `completed_by_user = True`.
  3. Un utilisateur non-completeur la voit avec `completed_by_user = False`.
  4. La mission renvoyée est la plus récente active du type du jour.

Nécessite : MongoDB local + variables d'env MONGO_URL / DB_NAME.
"""
from __future__ import annotations
import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient


@pytest_asyncio.fixture
async def db():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not (mongo_url and db_name):
        pytest.skip("MONGO_URL / DB_NAME not set")
    client = AsyncIOMotorClient(mongo_url)
    yield client[db_name]
    client.close()


@pytest.mark.asyncio
async def test_daily_mission_is_global_and_identical(db):
    """v27t — plusieurs users, même mission renvoyée."""
    from missions import _today_mission_type, _load_schedule, _window_open_for_schedule

    cfg = await _load_schedule(db)
    if not _window_open_for_schedule(cfg):
        pytest.skip("mission window closed right now — skip realtime test")
    today_type = _today_mission_type(cfg)
    if not today_type:
        pytest.skip("no mission type configured for today")

    # Insert two fresh missions of today's type
    now = datetime.now(timezone.utc)
    older = {
        "id": f"test-old-{uuid.uuid4().hex[:8]}",
        "title": "OLD daily",
        "type": today_type,
        "active": True,
        "reward": 50,
        "duration_seconds": 10,
        "created_at": now - timedelta(hours=6),
    }
    newer = {
        "id": f"test-new-{uuid.uuid4().hex[:8]}",
        "title": "NEW daily",
        "type": today_type,
        "active": True,
        "reward": 50,
        "duration_seconds": 10,
        "created_at": now - timedelta(minutes=5),
    }
    await db.missions.insert_many([older, newer])

    try:
        # Query the endpoint helper directly (imports work in-process)
        from starlette.testclient import TestClient
        # We can't easily boot the full FastAPI here — verify with a raw call
        # to the picking logic instead.
        from missions import list_missions  # type: ignore

        # Simulate two different users.
        userA = {"id": "user-A"}
        userB = {"id": "user-B"}
        # Pretend user A already completed the NEW mission (v27x: include period_key).
        from missions import _current_period_key, _load_schedule as _load_sched2
        _period_key = _current_period_key(await _load_sched2(db))
        await db.mission_completions.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": userA["id"],
            "mission_id": newer["id"],
            "mission_type": today_type,
            "reward": 50,
            "period_key": _period_key,
            "completed_at": now,
        })

        class Req:
            def __init__(self, db):
                class St:
                    pass
                self.app = type("A", (), {"state": type("S", (), {"db": db})()})()

        req = Req(db)
        resA = await list_missions(req, user=userA)
        resB = await list_missions(req, user=userB)

        # Both users must receive the same mission id.
        assert len(resA["items"]) == 1
        assert len(resB["items"]) == 1
        assert resA["items"][0]["id"] == resB["items"][0]["id"] == newer["id"]

        # Individual completion state differs.
        assert resA["items"][0]["completed_by_user"] is True
        assert resB["items"][0]["completed_by_user"] is False
    finally:
        # Cleanup — never leave test rows behind.
        await db.missions.delete_many({"id": {"$in": [older["id"], newer["id"]]}})
        await db.mission_completions.delete_many({"mission_id": {"$in": [older["id"], newer["id"]]}})
