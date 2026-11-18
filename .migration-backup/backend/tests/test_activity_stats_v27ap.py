"""v27ap — regression tests for the Dashboard activity statistics module.

Covers :
  • Period aggregation returns the correct bucket count and matches the
    requested period (24h = 24 buckets, 7d = 7, 30d = 30, 1y = 12 months).
  • Only REAL gains are counted (commissions, ads_reactor_rewards,
    mission_completions) — deposits / activations are never added.
  • Daily breakdown lists individual transactions per category.
  • Commission classification routes direct level-1 to "parrainage" and
    spillover_beneficiary to "equipe".
  • /activity/day returns totals equal to the sum of per-category rows.
"""
from datetime import datetime, timezone, timedelta
import os

import pytest
import pytest_asyncio

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "spilivere_test_v27ap")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
import activity_stats  # noqa: E402


class _Req:
    def __init__(self, db):
        class _App:
            class _State:
                pass
        self.app = _App()
        self.app.state = _App._State()
        self.app.state.db = db


@pytest_asyncio.fixture
async def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    database = client[os.environ["DB_NAME"]]
    for col in ("commissions", "ads_reactor_rewards", "mission_completions",
                "users", "activations", "payments"):
        await database[col].delete_many({})
    yield database
    for col in ("commissions", "ads_reactor_rewards", "mission_completions",
                "users", "activations", "payments"):
        await database[col].delete_many({})


async def _seed_user(db, uid="u1"):
    await db.users.insert_one({"id": uid, "email": f"{uid}@test.io", "username": uid, "status": "active"})


@pytest.mark.asyncio
async def test_period_bucket_counts(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    for p, expected in [("24h", 24), ("7d", 7), ("30d", 30), ("1y", 12)]:
        res = await activity_stats.activity_series(_Req(db), period=p, user=u)
        assert res["period"] == p
        assert res["summary"]["bucket_count"] == expected
        assert len(res["buckets"]) == expected


@pytest.mark.asyncio
async def test_no_gain_user_returns_zero_totals(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    res = await activity_stats.activity_series(_Req(db), period="7d", user=u)
    assert res["summary"]["total"] == 0
    assert all(b["total"] == 0 for b in res["buckets"])


@pytest.mark.asyncio
async def test_direct_commission_counts_as_parrainage(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    now = datetime.now(timezone.utc)
    await db.commissions.insert_one({
        "user_id": "u1", "from_user_id": "sponsored1", "kind": "direct",
        "level": 1, "amount": 1000, "profit_share": 1000, "created_at": now,
    })
    res = await activity_stats.activity_series(_Req(db), period="7d", user=u)
    assert res["summary"]["total"] == 1000
    today_key = now.strftime("%Y-%m-%d")
    today_bucket = next(b for b in res["buckets"] if b["key"] == today_key)
    assert today_bucket["parrainage"] == 1000
    assert today_bucket["equipe"] == 0


@pytest.mark.asyncio
async def test_two_parrainage_commissions_sum_correctly(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    now = datetime.now(timezone.utc)
    for i in range(2):
        await db.commissions.insert_one({
            "user_id": "u1", "from_user_id": f"u{i}", "kind": "direct",
            "level": 1, "amount": 1000, "profit_share": 1000, "created_at": now,
        })
    res = await activity_stats.activity_series(_Req(db), period="7d", user=u)
    assert res["summary"]["total"] == 2000
    today_key = now.strftime("%Y-%m-%d")
    day = await activity_stats.activity_day(_Req(db), date=today_key, user=u)
    assert day["grand_total"] == 2000
    assert day["totals"]["parrainage"] == 2000
    assert len(day["transactions"]["parrainage"]) == 2
    for tx in day["transactions"]["parrainage"]:
        assert tx["label"] == "Commission directe"


@pytest.mark.asyncio
async def test_multiple_categories_split(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    now = datetime.now(timezone.utc)
    # Parrainage 2000
    await db.commissions.insert_one({
        "user_id": "u1", "from_user_id": "a", "kind": "direct", "level": 1,
        "amount": 2000, "profit_share": 2000, "created_at": now,
    })
    # Equipe 1000
    await db.commissions.insert_one({
        "user_id": "u1", "from_user_id": "b", "kind": "spillover_beneficiary",
        "level": 2, "amount": 500, "profit_share": 500, "created_at": now,
    })
    await db.commissions.insert_one({
        "user_id": "u1", "from_user_id": "c", "kind": "spillover_beneficiary",
        "level": 3, "amount": 500, "profit_share": 500, "created_at": now,
    })
    # Ads 1200
    await db.ads_reactor_rewards.insert_one({
        "user_id": "u1", "amount": 600, "created_at": now, "ad_id": "ad1",
    })
    await db.ads_reactor_rewards.insert_one({
        "user_id": "u1", "amount": 600, "created_at": now, "ad_id": "ad2",
    })
    # Missions 850
    await db.mission_completions.insert_one({
        "user_id": "u1", "reward": 400, "completed_at": now,
        "mission_id": "m1", "platform": "youtube",
    })
    await db.mission_completions.insert_one({
        "user_id": "u1", "reward": 450, "completed_at": now,
        "mission_id": "m2", "platform": "tiktok",
    })
    res = await activity_stats.activity_series(_Req(db), period="7d", user=u)
    assert res["summary"]["total"] == 5050
    today_key = now.strftime("%Y-%m-%d")
    day = await activity_stats.activity_day(_Req(db), date=today_key, user=u)
    assert day["totals"]["parrainage"] == 2000
    assert day["totals"]["equipe"] == 1000
    assert day["totals"]["ads"] == 1200
    assert day["totals"]["missions"] == 850
    assert day["grand_total"] == 5050


@pytest.mark.asyncio
async def test_deposits_never_count_as_gains(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    now = datetime.now(timezone.utc)
    # A real deposit (activation) — must NOT appear in activity stats.
    await db.activations.insert_one({
        "user_id": "u1", "amount": 50_000, "level": 1, "status": "approved",
        "created_at": now,
    })
    await db.payments.insert_one({
        "user_id": "u1", "amount": 50_000, "level": 1, "status": "approved",
        "created_at": now,
    })
    res = await activity_stats.activity_series(_Req(db), period="7d", user=u)
    assert res["summary"]["total"] == 0


@pytest.mark.asyncio
async def test_period_change_recomputes(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=10)
    await db.commissions.insert_one({
        "user_id": "u1", "kind": "direct", "level": 1, "amount": 500,
        "profit_share": 500, "created_at": old,
    })
    r7 = await activity_stats.activity_series(_Req(db), period="7d", user=u)
    r30 = await activity_stats.activity_series(_Req(db), period="30d", user=u)
    assert r7["summary"]["total"] == 0  # outside 7d window
    assert r30["summary"]["total"] == 500  # inside 30d window


@pytest.mark.asyncio
async def test_day_detail_rejects_invalid_date(db):
    await _seed_user(db)
    u = await db.users.find_one({"id": "u1"})
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        await activity_stats.activity_day(_Req(db), date="not-a-date", user=u)
