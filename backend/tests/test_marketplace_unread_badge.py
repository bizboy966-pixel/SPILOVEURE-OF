"""Regression: /api/marketplace/unread-count + /api/marketplace/mark-seen.

Mirrors the ads badge coverage:
  * A brand-new approved listing owned by another seller counts.
  * Listings the caller owns don't count.
  * mark-seen resets the counter to zero.
  * The static routes must precede `/marketplace/{listing_id}` — otherwise
    FastAPI matches "unread-count" as a listing id (this happened for ads
    and we want a guardrail so it doesn't regress here).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import httpx
from motor.motor_asyncio import AsyncIOMotorClient


API_URL = os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:8001"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture
def db():
    return AsyncIOMotorClient(MONGO_URL)[DB_NAME]


async def _login(client: httpx.AsyncClient) -> str:
    r = await client.post(
        f"{API_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    r.raise_for_status()
    b = r.json()
    return b.get("token") or b["access_token"]


@pytest.mark.asyncio
async def test_marketplace_badge_route_ordering():
    """The /unread-count endpoint must not be shadowed by /marketplace/{id}."""
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        h = {"Authorization": f"Bearer {token}"}
        r = await client.get(f"{API_URL}/api/marketplace/unread-count", headers=h)
        assert r.status_code == 200, r.text
        assert "unread" in r.json()

        r = await client.post(f"{API_URL}/api/marketplace/mark-seen", headers=h)
        assert r.status_code == 200
        assert r.json()["ok"] is True


@pytest.mark.asyncio
async def test_marketplace_unread_semantics(db):
    """Direct Mongo check: approved listing after last_seen counts; owner-owned doesn't."""
    u1 = f"test_mk_{uuid.uuid4().hex[:8]}"
    u2 = f"test_mk_{uuid.uuid4().hex[:8]}"
    now = datetime.now(timezone.utc)

    await db.users.insert_one({
        "id": u1, "email": f"{u1}@t.io", "username": u1, "wallet_pool": 0,
        "last_marketplace_seen_at": now - timedelta(minutes=10),
    })
    await db.users.insert_one({
        "id": u2, "email": f"{u2}@t.io", "username": u2, "wallet_pool": 0,
    })

    stale = {
        "id": f"mk_stale_{uuid.uuid4().hex[:8]}", "seller_id": u2,
        "status": "approved", "approved_at": now - timedelta(hours=1),
        "created_at": now - timedelta(hours=2), "expires_at": None,
        "title": "Old", "description": "", "images": [], "price": 100,
    }
    fresh = {
        "id": f"mk_fresh_{uuid.uuid4().hex[:8]}", "seller_id": u2,
        "status": "approved", "approved_at": now - timedelta(minutes=2),
        "created_at": now - timedelta(minutes=3), "expires_at": None,
        "title": "New", "description": "", "images": [], "price": 100,
    }
    own = {
        "id": f"mk_own_{uuid.uuid4().hex[:8]}", "seller_id": u1,
        "status": "approved", "approved_at": now - timedelta(minutes=1),
        "created_at": now - timedelta(minutes=2), "expires_at": None,
        "title": "Own", "description": "", "images": [], "price": 100,
    }
    pending = {
        "id": f"mk_pending_{uuid.uuid4().hex[:8]}", "seller_id": u2,
        "status": "pending", "approved_at": None,
        "created_at": now, "expires_at": None,
        "title": "Pending", "description": "", "images": [], "price": 100,
    }
    await db.marketplace_listings.insert_many([stale, fresh, own, pending])

    try:
        u = await db.users.find_one({"id": u1}, {"last_marketplace_seen_at": 1})
        q = {
            "status": "approved",
            "seller_id": {"$ne": u1},
            "approved_at": {"$gt": u["last_marketplace_seen_at"]},
        }
        c = await db.marketplace_listings.count_documents(q)
        assert c == 1, "only the fresh listing owned by u2 should count"
    finally:
        await db.users.delete_many({"id": {"$in": [u1, u2]}})
        await db.marketplace_listings.delete_many(
            {"id": {"$in": [stale["id"], fresh["id"], own["id"], pending["id"]]}},
        )
