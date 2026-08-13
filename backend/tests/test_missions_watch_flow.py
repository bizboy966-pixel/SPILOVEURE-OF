"""End-to-end test for the mission auto-validation flow (video kind).

Simulates the complete happy path:
1. Admin creates a video mission (YouTube URL).
2. User opens a watch session (`/watch/start`).
3. User sends heartbeats every 5 seconds while "watching".
4. Once real elapsed >= duration_seconds, `/complete` is called.
5. Verify: `balance_youtube` incremented, `mission_completions` row exists,
   no second credit possible (idempotency).
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


async def _make_open_schedule(db):
    """Force the mission schedule to be OPEN for every day/hour so tests
    can run at any time."""
    await db.app_settings.update_one(
        {"key": "mission_schedule"},
        {"$set": {"value": {
            "allowed_days": [0, 1, 2, 3, 4, 5, 6],
            "open_time": "00:00",
            "close_time": "23:59",
            "timezone": "UTC",
            "enabled": True,
            "day_type_map": {str(i): "youtube" for i in range(7)},
        }}},
        upsert=True,
    )


async def _restore_schedule(db, previous):
    if previous is None:
        await db.app_settings.delete_one({"key": "mission_schedule"})
    else:
        await db.app_settings.update_one(
            {"key": "mission_schedule"}, {"$set": {"value": previous}}
        )


@pytest.mark.asyncio
async def test_watch_session_credits_wallet_and_is_idempotent():
    """Complete happy path: session → heartbeats → complete → credit ×1."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    prev_sched = None
    try:
        # Backup and force-open schedule.
        doc = await db.app_settings.find_one({"key": "mission_schedule"}, {"_id": 0})
        prev_sched = (doc or {}).get("value")
        await _make_open_schedule(db)

        # Seed a user.
        uid = f"TEST-MISS-{uuid.uuid4().hex[:8]}"
        await db.users.insert_one({
            "id": uid,
            "username": f"test_{uid[-6:]}",
            "email": f"{uid}@test.local",
            "role": "user",
            "status": "active",
            "balance_youtube": 0.0,
            "completed_youtube": 0,
            "balance_missions_total": 0.0,
        })

        # Seed a mission (short duration so the test runs quickly).
        mission_id = str(uuid.uuid4())
        await db.missions.insert_one({
            "id": mission_id,
            "title": "TEST video mission",
            "description": "Watch this test video",
            "type": "youtube",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "duration_seconds": 3,
            "reward": 100.0,
            "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        # Import the endpoints. We call them by fabricating a minimal Request
        # object that carries `app.state.db` — matches FastAPI's signature.
        from missions import (
            start_watch_session, watch_heartbeat, complete_mission,
        )

        class FakeApp:
            def __init__(self, db):
                self.state = type("S", (), {"db": db})()

        class FakeRequest:
            def __init__(self, db):
                self.app = FakeApp(db)

        req = FakeRequest(db)
        user = await db.users.find_one({"id": uid}, {"_id": 0})

        # 1. Open session
        r = await start_watch_session(mission_id, req, user)
        session_id = r["session_id"]
        assert r["duration_required"] == 3

        # 2. Send heartbeats, waiting real time between them
        for i in range(1, 5):
            await asyncio.sleep(1)
            hb = await watch_heartbeat(mission_id, {"session_id": session_id, "elapsed_seconds": i}, req, user)
            assert hb["max_elapsed"] == i

        # 3. Complete
        done = await complete_mission(mission_id, {"session_id": session_id}, req, user)
        assert done["ok"] is True
        assert done["reward"] == 100.0
        assert done["wallet"] == "youtube"

        # 4. Verify credit
        u = await db.users.find_one({"id": uid}, {"_id": 0})
        assert u["balance_youtube"] == pytest.approx(100.0)
        assert u["completed_youtube"] == 1
        assert u["balance_missions_total"] == pytest.approx(100.0)

        # 5. Idempotency: a second call must be rejected.
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as ei:
            await complete_mission(mission_id, {"session_id": session_id}, req, user)
        assert ei.value.status_code == 409

    finally:
        # Cleanup
        await db.users.delete_one({"id": uid})
        await db.missions.delete_one({"id": mission_id})
        await db.mission_completions.delete_many({"user_id": uid})
        await db.mission_watch_sessions.delete_many({"user_id": uid})
        await _restore_schedule(db, prev_sched)
        client.close()


@pytest.mark.asyncio
async def test_watch_rejects_too_fast_completion():
    """User cannot skip the timer: elapsed=required immediately must fail."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    prev_sched = None
    try:
        doc = await db.app_settings.find_one({"key": "mission_schedule"}, {"_id": 0})
        prev_sched = (doc or {}).get("value")
        await _make_open_schedule(db)

        uid = f"TEST-MISS-{uuid.uuid4().hex[:8]}"
        await db.users.insert_one({
            "id": uid, "username": f"test_{uid[-6:]}", "email": f"{uid}@t.local",
            "role": "user", "status": "active", "balance_youtube": 0.0, "completed_youtube": 0,
        })

        mission_id = str(uuid.uuid4())
        await db.missions.insert_one({
            "id": mission_id, "title": "TEST fraud", "type": "youtube",
            "url": "https://www.youtube.com/watch?v=abc", "duration_seconds": 30,
            "reward": 100.0, "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        from missions import start_watch_session, watch_heartbeat, complete_mission

        class FakeApp:
            def __init__(self, db): self.state = type("S", (), {"db": db})()
        class FakeRequest:
            def __init__(self, db): self.app = FakeApp(db)

        req = FakeRequest(db)
        user = await db.users.find_one({"id": uid}, {"_id": 0})

        r = await start_watch_session(mission_id, req, user)
        session_id = r["session_id"]

        # Try to cheat: claim elapsed=30 immediately (impossible in reality).
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as ei:
            await watch_heartbeat(mission_id, {"session_id": session_id, "elapsed_seconds": 30}, req, user)
        assert ei.value.status_code == 400

        # Even if heartbeat somehow slipped through, complete must reject the
        # early call because wall-clock elapsed < required.
        # Simulate: fake DB directly to `max_elapsed=30` without waiting.
        await db.mission_watch_sessions.update_one(
            {"id": session_id}, {"$set": {"max_elapsed": 30}},
        )
        with pytest.raises(HTTPException) as ei:
            await complete_mission(mission_id, {"session_id": session_id}, req, user)
        assert ei.value.status_code == 400  # "Visionnage trop rapide"

        # Verify no credit
        u = await db.users.find_one({"id": uid}, {"_id": 0})
        assert u["balance_youtube"] == 0.0
        assert u["completed_youtube"] == 0

    finally:
        await db.users.delete_one({"id": uid})
        await db.missions.delete_one({"id": mission_id})
        await db.mission_completions.delete_many({"user_id": uid})
        await db.mission_watch_sessions.delete_many({"user_id": uid})
        await _restore_schedule(db, prev_sched)
        client.close()
