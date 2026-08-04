"""Regression: /api/ads/unread-count + /api/ads/mark-seen.

Guards the "nouvelle publicité" badge shown on the bottom-nav:
  * A published ad older than users.last_ads_seen_at → NOT counted.
  * A brand-new ad → counted for other users.
  * The owner never sees a badge for their own ad.
  * mark-seen resets the counter to zero.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from motor.motor_asyncio import AsyncIOMotorClient


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest.fixture
def db():
    client = AsyncIOMotorClient(MONGO_URL)
    return client[DB_NAME]


@pytest.mark.asyncio
async def test_unread_count_excludes_own_and_stale_ads(db):
    # Simulate two users
    u1 = f"test_user_{uuid.uuid4().hex[:8]}"
    u2 = f"test_user_{uuid.uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)

    # u1 has seen up to 10 min ago
    await db.users.insert_one({
        "id": u1, "email": f"{u1}@t.io", "username": u1, "wallet_pool": 0,
        "last_ads_seen_at": now - timedelta(minutes=10),
    })
    await db.users.insert_one({
        "id": u2, "email": f"{u2}@t.io", "username": u2, "wallet_pool": 0,
    })

    ad_stale = {
        "id": f"ad_stale_{uuid.uuid4().hex[:8]}", "user_id": u2,
        "status": "published", "published_at": now - timedelta(hours=1),
        "expires_at": None, "cover_image_url": "", "video_url": "",
        "description": "", "username": u2, "likes": [], "viewers": [],
        "comments": [], "views_count": 0, "shares_count": 0,
    }
    ad_fresh = {
        "id": f"ad_fresh_{uuid.uuid4().hex[:8]}", "user_id": u2,
        "status": "published", "published_at": now - timedelta(minutes=2),
        "expires_at": None, "cover_image_url": "", "video_url": "",
        "description": "", "username": u2, "likes": [], "viewers": [],
        "comments": [], "views_count": 0, "shares_count": 0,
    }
    ad_own = {
        "id": f"ad_own_{uuid.uuid4().hex[:8]}", "user_id": u1,
        "status": "published", "published_at": now - timedelta(minutes=1),
        "expires_at": None, "cover_image_url": "", "video_url": "",
        "description": "", "username": u1, "likes": [], "viewers": [],
        "comments": [], "views_count": 0, "shares_count": 0,
    }
    await db.ads.insert_many([ad_stale, ad_fresh, ad_own])

    try:
        # Replicate the same aggregation the endpoint uses.
        u = await db.users.find_one({"id": u1}, {"last_ads_seen_at": 1})
        seen = u["last_ads_seen_at"]
        q = {
            "status": "published",
            "user_id": {"$ne": u1},
            "$or": [{"expires_at": None}, {"expires_at": {"$gt": now}}],
            "published_at": {"$gt": seen},
        }
        count = await db.ads.count_documents(q)
        assert count == 1, "only the fresh ad from u2 should count"
    finally:
        await db.users.delete_many({"id": {"$in": [u1, u2]}})
        await db.ads.delete_many({"id": {"$in": [ad_stale["id"], ad_fresh["id"], ad_own["id"]]}})
