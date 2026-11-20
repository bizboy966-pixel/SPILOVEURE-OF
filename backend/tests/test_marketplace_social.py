from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from mongomock_motor import AsyncMongoMockClient

from marketplace import (
    ListingComment, add_listing_comment, initialize, listing_comments,
    public_feed, toggle_listing_like,
)


@pytest.fixture
def marketplace_db():
    import asyncio

    db = AsyncMongoMockClient(tz_aware=True).marketplace_social_tests
    now = datetime.now(timezone.utc)

    async def seed():
        await initialize(db)
        await db.feature_flags.insert_one({"key": "marketplace", "enabled": True})
        await db.users.insert_many([
            {
                "id": "seller", "username": "Shop", "email": "shop@example.invalid",
                "email_verified": True, "email_verified_address": "shop@example.invalid",
                "profile_photo": "data:image/png;base64,profile",
            },
            {"id": "buyer", "username": "Buyer", "email": "buyer@example.invalid"},
        ])
        await db.marketplace_listings.insert_one({
            "id": "listing-1", "seller_id": "seller", "seller_username": "Shop",
            "status": "approved", "approved_at": now,
            "expires_at": now + timedelta(days=14), "created_at": now,
            "images": ["product.jpg"], "videos": [], "name": "Portable",
            "category": "Électronique", "price": 10000, "promo_price": None,
            "currency": "FCFA", "city": "Lomé", "whatsapp": "+22890000000",
            "description": "Ordinateur portable en bon état.", "views": 0, "reviews": [],
        })

    asyncio.run(seed())
    return db


def request_for(db):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))


@pytest.mark.asyncio
async def test_listing_likes_and_comments_work_without_mutating_saved_listing(marketplace_db):
    db = marketplace_db
    request = request_for(db)
    before = await db.marketplace_listings.find_one({"id": "listing-1"})
    before.pop("_id", None)

    liked = await toggle_listing_like("listing-1", request, user={"id": "buyer"})
    assert liked == {"liked_by_me": True, "likes_count": 1}
    unliked = await toggle_listing_like("listing-1", request, user={"id": "buyer"})
    assert unliked == {"liked_by_me": False, "likes_count": 0}

    created = await add_listing_comment(
        "listing-1", ListingComment(text="Je suis intéressé."), request,
        user={"id": "buyer", "username": "Buyer"},
    )
    assert created["text"] == "Je suis intéressé."
    assert created["username"] == "Buyer"
    assert len(await listing_comments("listing-1", request, user={"id": "buyer"})) == 1

    feed = await public_feed(request, user={"id": "buyer"})
    row = feed["items"][0]
    assert row["likes_count"] == 0 and row["liked_by_me"] is False
    assert row["comments_count"] == 1
    assert row["seller_profile"] == {
        "username": "Shop", "avatar": "data:image/png;base64,profile", "verified": True,
    }
    after = await db.marketplace_listings.find_one({"id": "listing-1"})
    after.pop("_id", None)
    assert after == before


@pytest.mark.asyncio
async def test_interactions_are_rejected_for_unavailable_listings(marketplace_db):
    request = request_for(marketplace_db)
    with pytest.raises(Exception) as error:
        await toggle_listing_like("missing", request, user={"id": "buyer"})
    assert getattr(error.value, "status_code", None) == 404
    with pytest.raises(Exception) as error:
        await add_listing_comment(
            "missing", ListingComment(text="Bonjour"), request,
            user={"id": "buyer", "username": "Buyer"},
        )
    assert getattr(error.value, "status_code", None) == 404
