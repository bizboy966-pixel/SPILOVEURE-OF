"""v27x regression — la tâche du jour redevient DISPONIBLE chaque nouveau jour.

Bug d'origine : `completed_by_user` et l'idempotence de `complete_mission`
filtraient uniquement par `mission_id`. Si l'admin gardait la MÊME mission
active du lundi au vendredi, une complétion de lundi bloquait mardi :
l'utilisateur voyait "Mission déjà validée" dès 08h00 sans avoir rien fait.

Correction v27x : les deux checks incluent maintenant le `period_key` (date
ISO du jour courant en TZ locale). Chaque nouveau jour = nouvelle fenêtre
de validation, même si le `mission_id` reste identique.
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))


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
async def test_daily_reset_completed_by_user(db):
    """Un utilisateur ayant validé HIER doit voir la mission AVAILABLE
    aujourd'hui (period_key différent), même si le mission_id est identique.
    """
    from missions import (
        list_missions, _today_mission_type, _load_schedule,
        _window_open_for_schedule, _current_period_key,
    )
    cfg = await _load_schedule(db)
    if not _window_open_for_schedule(cfg):
        pytest.skip("window closed — cannot test live realtime")
    today_type = _today_mission_type(cfg)
    if not today_type:
        pytest.skip("no mission type configured today")

    now = datetime.now(timezone.utc)
    mission = {
        "id": f"test-daily-{uuid.uuid4().hex[:8]}",
        "title": "Daily reset test v27x",
        "type": today_type,
        "active": True,
        "reward": 50,
        "duration_seconds": 10,
        "created_at": now - timedelta(minutes=1),
    }
    await db.missions.insert_one(mission)

    userA = {"id": f"u27x-{uuid.uuid4().hex[:8]}"}
    # Simulate: user A completed the SAME mission YESTERDAY
    today_key = _current_period_key(cfg)
    yesterday_key = (datetime.fromisoformat(today_key) - timedelta(days=1)).date().isoformat()
    await db.mission_completions.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": userA["id"],
        "mission_id": mission["id"],
        "mission_type": today_type,
        "reward": 50,
        "period_key": yesterday_key,       # ← key = yesterday
        "completed_at": now - timedelta(days=1),
    })

    try:
        class Req:
            def __init__(self, db):
                self.app = type("A", (), {"state": type("S", (), {"db": db})()})()
        res = await list_missions(Req(db), user=userA)
        assert len(res["items"]) == 1, res
        m = res["items"][0]
        # v27x fix : despite yesterday's completion, today the mission must
        # be AVAILABLE (completed_by_user = False).
        assert m["completed_by_user"] is False, (
            f"BUG v27x : yesterday's completion still blocks today "
            f"(mission_id={mission['id']}, today={today_key}, yesterday={yesterday_key})"
        )
        assert m["id"] == mission["id"]

        # Now simulate a TODAY completion → check must flip to True.
        await db.mission_completions.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": userA["id"],
            "mission_id": mission["id"],
            "mission_type": today_type,
            "reward": 50,
            "period_key": today_key,
            "completed_at": now,
        })
        res2 = await list_missions(Req(db), user=userA)
        assert res2["items"][0]["completed_by_user"] is True
    finally:
        await db.missions.delete_many({"id": mission["id"]})
        await db.mission_completions.delete_many({"user_id": userA["id"]})


@pytest.mark.asyncio
async def test_available_when_never_completed(db):
    """Un utilisateur qui n'a JAMAIS validé cette mission voit
    `completed_by_user = False` — c'est le cas nominal de 08h00."""
    from missions import (
        list_missions, _today_mission_type, _load_schedule,
        _window_open_for_schedule,
    )
    cfg = await _load_schedule(db)
    if not _window_open_for_schedule(cfg):
        pytest.skip("window closed")
    today_type = _today_mission_type(cfg)
    if not today_type:
        pytest.skip("no type today")

    mission = {
        "id": f"test-fresh-{uuid.uuid4().hex[:8]}",
        "title": "Fresh mission",
        "type": today_type,
        "active": True,
        "reward": 50,
        "duration_seconds": 10,
        "created_at": datetime.now(timezone.utc) - timedelta(minutes=1),
    }
    await db.missions.insert_one(mission)
    userFresh = {"id": f"fresh-{uuid.uuid4().hex[:8]}"}
    try:
        class Req:
            def __init__(self, db):
                self.app = type("A", (), {"state": type("S", (), {"db": db})()})()
        res = await list_missions(Req(db), user=userFresh)
        assert len(res["items"]) == 1
        assert res["items"][0]["completed_by_user"] is False
    finally:
        await db.missions.delete_many({"id": mission["id"]})
