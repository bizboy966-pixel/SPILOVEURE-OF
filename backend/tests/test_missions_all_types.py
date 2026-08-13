"""Verify the auto-validation flow works for EVERY mission type:
YouTube, TikTok, Instagram, Facebook and Questionnaire.

Runs the same happy-path assertions as `test_missions_watch_flow.py`
but parametrized across the 5 types so we lock the behaviour of each
`balance_*` wallet independently.
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

# (type, sample URL, is_video)
CASES = [
    ("youtube",    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",          True),
    ("tiktok",     "https://www.tiktok.com/@user/video/7000000000000000000", True),
    ("instagram",  "https://www.instagram.com/p/ABCDEF123/",                 True),
    ("facebook",   "https://www.facebook.com/watch/?v=1000000000000000",     True),
    ("questionnaire", "", False),
]


async def _force_open_schedule(db, today_type: str):
    await db.app_settings.update_one(
        {"key": "mission_schedule"},
        {"$set": {"value": {
            "allowed_days": [0, 1, 2, 3, 4, 5, 6],
            "open_time": "00:00", "close_time": "23:59",
            "timezone": "UTC", "enabled": True,
            "day_type_map": {str(i): today_type for i in range(7)},
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


class FakeApp:
    def __init__(self, db): self.state = type("S", (), {"db": db})()
class FakeRequest:
    def __init__(self, db): self.app = FakeApp(db)


@pytest.mark.asyncio
@pytest.mark.parametrize("mtype,url,is_video", CASES)
async def test_each_mission_type_credits_correct_wallet(mtype, url, is_video):
    """For every type, a valid completion:
      • credits ONLY the matching `balance_<type>` wallet,
      • increments the matching `completed_<type>` counter,
      • records exactly one row in `mission_completions`.
    """
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    prev_sched = None
    try:
        doc = await db.app_settings.find_one({"key": "mission_schedule"}, {"_id": 0})
        prev_sched = (doc or {}).get("value")
        await _force_open_schedule(db, mtype)

        uid = f"TEST-MT-{mtype}-{uuid.uuid4().hex[:6]}"
        # Seed the user with a zero wallet for EVERY type so we can assert
        # only the target one increases.
        user_seed = {
            "id": uid, "username": f"t_{uid[-6:]}", "email": f"{uid}@t.local",
            "role": "user", "status": "active", "balance_missions_total": 0.0,
        }
        for t, _, _v in CASES:
            user_seed[f"balance_{t}"] = 0.0
            user_seed[f"completed_{t}"] = 0
        await db.users.insert_one(user_seed)

        mission_id = str(uuid.uuid4())
        mission_doc = {
            "id": mission_id,
            "title": f"TEST {mtype} mission",
            "description": f"Test {mtype}",
            "type": mtype,
            "url": url,
            "duration_seconds": 3 if is_video else 0,
            "reward": 100.0,
            "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if not is_video:
            mission_doc["question"] = "Combien font 2+2 ?"
            mission_doc["correct_answer"] = "4"
        await db.missions.insert_one(mission_doc)

        from missions import start_watch_session, watch_heartbeat, complete_mission

        req = FakeRequest(db)
        user = await db.users.find_one({"id": uid}, {"_id": 0})

        if is_video:
            r = await start_watch_session(mission_id, req, user)
            sid = r["session_id"]
            for i in range(1, 5):
                await asyncio.sleep(1)
                await watch_heartbeat(mission_id, {"session_id": sid, "elapsed_seconds": i}, req, user)
            done = await complete_mission(mission_id, {"session_id": sid}, req, user)
        else:
            done = await complete_mission(mission_id, {"answer": "4"}, req, user)

        assert done["ok"] is True
        assert done["wallet"] == mtype
        assert done["reward"] == 100.0

        u = await db.users.find_one({"id": uid}, {"_id": 0})
        # Target wallet must be credited.
        assert u[f"balance_{mtype}"] == pytest.approx(100.0), f"{mtype} wallet not credited"
        assert u[f"completed_{mtype}"] == 1
        assert u["balance_missions_total"] == pytest.approx(100.0)
        # All OTHER wallets must remain at 0 — no cross-crediting.
        for t, _, _v in CASES:
            if t == mtype:
                continue
            assert u[f"balance_{t}"] == 0.0, f"unexpected credit on {t} wallet"
            assert u[f"completed_{t}"] == 0

        n = await db.mission_completions.count_documents({"user_id": uid, "mission_id": mission_id})
        assert n == 1
    finally:
        await db.users.delete_one({"id": uid})
        await db.missions.delete_one({"id": mission_id})
        await db.mission_completions.delete_many({"user_id": uid})
        await db.mission_watch_sessions.delete_many({"user_id": uid})
        await _restore_schedule(db, prev_sched)
        client.close()


@pytest.mark.asyncio
async def test_questionnaire_rejects_wrong_answer():
    """Questionnaire path: wrong answer → 400, no credit."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    prev_sched = None
    try:
        doc = await db.app_settings.find_one({"key": "mission_schedule"}, {"_id": 0})
        prev_sched = (doc or {}).get("value")
        await _force_open_schedule(db, "questionnaire")

        uid = f"TEST-Q-{uuid.uuid4().hex[:8]}"
        await db.users.insert_one({
            "id": uid, "username": f"t_{uid[-6:]}", "email": f"{uid}@t.local",
            "role": "user", "status": "active",
            "balance_questionnaire": 0.0, "completed_questionnaire": 0,
        })
        mid = str(uuid.uuid4())
        await db.missions.insert_one({
            "id": mid, "title": "TEST Q", "type": "questionnaire",
            "url": "", "duration_seconds": 0, "reward": 100.0, "active": True,
            "question": "Capitale de la France ?", "correct_answer": "Paris",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        from missions import complete_mission
        from fastapi import HTTPException
        req = FakeRequest(db)
        user = await db.users.find_one({"id": uid}, {"_id": 0})
        with pytest.raises(HTTPException) as ei:
            await complete_mission(mid, {"answer": "Londres"}, req, user)
        assert ei.value.status_code == 400
        u = await db.users.find_one({"id": uid}, {"_id": 0})
        assert u["balance_questionnaire"] == 0.0
    finally:
        await db.users.delete_one({"id": uid})
        await db.missions.delete_one({"id": mid})
        await db.mission_completions.delete_many({"user_id": uid})
        await _restore_schedule(db, prev_sched)
        client.close()
