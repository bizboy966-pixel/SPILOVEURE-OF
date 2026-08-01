"""Regression — Ad reactor rewards MUST NEVER exceed the payment budget,
and the admin can delete ads / special-tasks in any status.
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api" if "REACT_APP_BACKEND_URL" in os.environ else "http://localhost:8001/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "spilivere")


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def admin_headers() -> dict:
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    b = r.json()
    return _h(b.get("access_token") or b.get("token"))


@pytest.mark.asyncio
async def test_admin_can_delete_ad_in_any_status(admin_headers):
    client = AsyncIOMotorClient(MONGO_URL); db = client[DB_NAME]
    try:
        # Seed a rejected ad
        ad_id = str(uuid.uuid4())
        await db.ads.insert_one({
            "id": ad_id, "user_id": "seed", "username": "seed",
            "status": "rejected", "price_amount": 0, "duration_days": 1,
        })
        r = requests.delete(f"{API}/admin/ads/{ad_id}",
                            headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True
        assert await db.ads.find_one({"id": ad_id}) is None
    finally:
        await db.ads.delete_many({"id": ad_id})
        client.close()


@pytest.mark.asyncio
async def test_admin_can_delete_special_task_in_any_status(admin_headers):
    client = AsyncIOMotorClient(MONGO_URL); db = client[DB_NAME]
    tid = str(uuid.uuid4())
    try:
        await db.special_tasks.insert_one({
            "id": tid, "user_id": "seed", "status": "completed",
            "action_type": "like", "network": "facebook",
            "quantity_target": 10, "quantity_completed": 10,
            "reward_per_action": 1, "price_per_action": 1,
            "price_amount": 10,
        })
        # Also seed one completion to verify cascade
        await db.special_task_completions.insert_one({
            "id": str(uuid.uuid4()), "task_id": tid,
            "user_id": "other", "reward": 1, "status": "approved",
        })
        r = requests.delete(f"{API}/admin/special-tasks/{tid}",
                            headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True
        assert await db.special_tasks.find_one({"id": tid}) is None
        assert await db.special_task_completions.count_documents({"task_id": tid}) == 0
    finally:
        await db.special_tasks.delete_many({"id": tid})
        await db.special_task_completions.delete_many({"task_id": tid})
        client.close()


@pytest.mark.asyncio
async def test_reactor_pool_initialised_at_approval(admin_headers):
    """After admin approve, reactor_pool + reactor_pool_remaining are set
    from `price_amount × distribution_percentage / 100`."""
    client = AsyncIOMotorClient(MONGO_URL); db = client[DB_NAME]
    ad_id = str(uuid.uuid4())
    try:
        # Set a known reactor config
        requests.put(f"{API}/admin/ads-reactor-config",
                     json={"distribution_percentage": 70,
                           "like_reward": 10, "comment_reward": 20,
                           "max_likes": 100, "max_comments": 50},
                     headers=admin_headers, timeout=15)
        # Seed a paid pending_admin_review ad with price 2000 FCFA
        await db.ads.insert_one({
            "id": ad_id, "user_id": "seed-ad", "username": "seed",
            "status": "pending_admin_review",
            "price_amount": 2000, "currency": "FCFA",
            "duration_days": 2, "cover_image_url": "https://x/y.jpg",
            "title": "Seed", "description": "Seed test ad",
            "target_countries": ["TG"], "target_age_min": 18,
            "target_age_max": 65, "target_gender": "both",
        })
        r = requests.post(f"{API}/admin/ads/{ad_id}/approve",
                          headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        fresh = await db.ads.find_one({"id": ad_id})
        # 2000 × 70% = 1400 FCFA reactor pool
        assert fresh["reactor_pool"] == pytest.approx(1400, abs=0.01)
        assert fresh["reactor_pool_remaining"] == pytest.approx(1400, abs=0.01)
    finally:
        await db.ads.delete_many({"id": ad_id})
        client.close()
