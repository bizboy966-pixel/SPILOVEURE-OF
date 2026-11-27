from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from mongomock_motor import AsyncMongoMockClient

import marketplace
from marketplace import (
    ListingComment, ListingCreate, add_listing_comment, create_listing, initialize,
    listing_comments, public_feed, toggle_listing_like,
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
async def test_new_listing_is_saved_without_scheduling_telegram_notification(marketplace_db, monkeypatch):
    calls = []

    async def enabled(_db, _flag):
        return True

    monkeypatch.setattr(marketplace, "feature_enabled", enabled)
    monkeypatch.setattr(marketplace, "_config", lambda _db: _enabled_config())
    import telegram_moderation
    monkeypatch.setattr(
        telegram_moderation, "schedule_submission",
        lambda *_args: calls.append("scheduled"),
    )

    listing = await create_listing(
        ListingCreate(
            images=["https://cdn.example.org/product.jpg"],
            name="Produit", category="Maison", price=2500, city="Lomé",
            whatsapp="+22890000000",
        ),
        request_for(marketplace_db),
        user={"id": "seller", "username": "Shop"},
    )

    saved = await marketplace_db.marketplace_listings.find_one({"id": listing["id"]})
    assert saved["status"] == "pending_admin_review"
    assert saved["name"] == "Produit"
    assert calls == []


async def _enabled_config():
    return {"enabled": True, "duration_days": 14}


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
    reply = await add_listing_comment(
        "listing-1",
        ListingComment(text="Je vous ai répondu.", parent_comment_id=created["id"]),
        request,
        user={"id": "seller", "username": "Shop"},
    )
    assert reply["parent_comment_id"] == created["id"]
    threads = await listing_comments("listing-1", request, user={"id": "buyer"})
    assert len(threads) == 1
    assert threads[0]["id"] == created["id"]
    assert [entry["text"] for entry in threads[0]["replies"]] == ["Je vous ai répondu."]

    feed = await public_feed(request, user={"id": "buyer"})
    row = feed["items"][0]
    assert row["likes_count"] == 0 and row["liked_by_me"] is False
    assert row["comments_count"] == 2
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


@pytest.mark.asyncio
async def test_replies_must_target_a_root_comment_on_the_same_listing(marketplace_db):
    request = request_for(marketplace_db)
    root = await add_listing_comment(
        "listing-1", ListingComment(text="Question initiale."), request,
        user={"id": "buyer", "username": "Buyer"},
    )
    reply = await add_listing_comment(
        "listing-1",
        ListingComment(text="Première réponse.", parent_comment_id=root["id"]),
        request,
        user={"id": "seller", "username": "Shop"},
    )

    with pytest.raises(Exception) as missing_parent:
        await add_listing_comment(
            "listing-1",
            ListingComment(text="Réponse invalide.", parent_comment_id="missing"),
            request,
            user={"id": "buyer", "username": "Buyer"},
        )
    assert getattr(missing_parent.value, "status_code", None) == 404
    await marketplace_db.marketplace_listing_comments.insert_one({
        "id": "comment-from-another-listing",
        "listing_id": "another-listing",
        "user_id": "buyer",
        "username": "Buyer",
        "text": "Commentaire ailleurs.",
        "created_at": datetime.now(timezone.utc),
    })
    with pytest.raises(Exception) as foreign_parent:
        await add_listing_comment(
            "listing-1",
            ListingComment(text="Réponse sur la mauvaise annonce.", parent_comment_id="comment-from-another-listing"),
            request,
            user={"id": "buyer", "username": "Buyer"},
        )
    assert getattr(foreign_parent.value, "status_code", None) == 404

    with pytest.raises(Exception) as nested_reply:
        await add_listing_comment(
            "listing-1",
            ListingComment(text="Réponse imbriquée.", parent_comment_id=reply["id"]),
            request,
            user={"id": "buyer", "username": "Buyer"},
        )
    assert getattr(nested_reply.value, "status_code", None) == 400
