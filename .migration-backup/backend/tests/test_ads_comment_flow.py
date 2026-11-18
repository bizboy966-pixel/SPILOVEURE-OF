"""Regression: /api/ads/{ad_id}/comment.

Two failure modes that the frontend must handle:
  1. Anti-spam heuristic → HTTP 400 with a clear `detail` message. Previously
     `onComment` swallowed this silently, making the "Envoyer" button look
     broken. This test confirms the backend still returns 400 with a readable
     French message, so the frontend can surface it.
  2. Happy path: 200 + {comment: {...}, reward: {...} | null}. The comment
     must actually be persisted in `db.ads.comments`.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import httpx
from motor.motor_asyncio import AsyncIOMotorClient


API_URL = os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:8001"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "spilivere")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture
def db():
    return AsyncIOMotorClient(MONGO_URL)[DB_NAME]


async def _login(client: httpx.AsyncClient, email=ADMIN_EMAIL, password=ADMIN_PASSWORD) -> str:
    r = await client.post(
        f"{API_URL}/api/auth/login",
        json={"email": email, "password": password},
    )
    r.raise_for_status()
    b = r.json()
    return b.get("token") or b["access_token"]


async def _seed_ad(db) -> str:
    """Seed a published ad owned by a synthetic user (so admin can comment)."""
    ad_id = f"test_ad_{uuid.uuid4().hex[:8]}"
    owner = f"test_owner_{uuid.uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)
    await db.users.insert_one({
        "id": owner, "email": f"{owner}@t.io", "username": owner, "wallet_pool": 0,
    })
    await db.ads.insert_one({
        "id": ad_id, "user_id": owner, "username": owner,
        "status": "published",
        "published_at": now,
        "expires_at": now + timedelta(days=30),
        "cover_image_url": "https://example.com/x.png",
        "video_url": "", "media_type": "poster",
        "description": "Ad seeded for comment regression",
        "likes": [], "viewers": [],
        "comments": [], "views_count": 0, "shares_count": 0,
        "reward_config": None,
    })
    return ad_id, owner


@pytest.mark.asyncio
async def test_comment_short_input_rejected_with_readable_detail(db):
    ad_id, owner = await _seed_ad(db)
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        h = {"Authorization": f"Bearer {token}"}
        try:
            # 2-char comment triggers the min-length anti-spam rule.
            r = await client.post(
                f"{API_URL}/api/ads/{ad_id}/comment",
                headers=h, json={"text": "ok"},
            )
            assert r.status_code == 400, r.text
            body = r.json()
            # The frontend reads `.detail` — verify that path exists and is a
            # readable French sentence (not an object nor empty).
            assert isinstance(body.get("detail"), str)
            assert "Commentaire" in body["detail"] or "commentaire" in body["detail"]
        finally:
            await db.ads.delete_one({"id": ad_id})
            await db.users.delete_one({"id": owner})


@pytest.mark.asyncio
async def test_comment_happy_path_persists_and_returns_comment(db):
    ad_id, owner = await _seed_ad(db)
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        h = {"Authorization": f"Bearer {token}"}
        try:
            r = await client.post(
                f"{API_URL}/api/ads/{ad_id}/comment",
                headers=h,
                json={"text": "Super publicité, très intéressante à découvrir vraiment !"},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert "comment" in body
            c = body["comment"]
            assert c["text"].startswith("Super publicité")
            assert c["id"]
            # Round-trip check in Mongo.
            ad = await db.ads.find_one({"id": ad_id}, {"comments": 1})
            texts = [x["text"] for x in ad.get("comments") or []]
            assert any(t.startswith("Super publicité") for t in texts)
        finally:
            await db.ads.delete_one({"id": ad_id})
            await db.users.delete_one({"id": owner})
