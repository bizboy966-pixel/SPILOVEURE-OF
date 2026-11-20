from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from mongomock_motor import AsyncMongoMockClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ads


@pytest.mark.asyncio
async def test_new_campaign_splits_pool_once_per_active_member():
    db = AsyncMongoMockClient(tz_aware=True).ads_equal_share_test
    assert ads._equal_active_share(7000, 3000) == 2.33
    await ads.initialize_reactor_reward_indexes(db)
    await db.ads_reactor_config.insert_one({
        "key": "singleton",
        "distribution_percentage": 70,
        "like_reward": 10,
        "comment_reward": 10,
        "max_likes": 2000,
        "max_comments": 2000,
    })
    await db.users.insert_many([
        {"id": "creator", "role": "user", "status": "active", "balance_profit": 0},
        {"id": "member-a", "role": "user", "status": "active", "balance_profit": 0},
        {"id": "member-b", "role": "user", "status": "active", "balance_profit": 0},
        {"id": "member-c", "role": "user", "status": "active", "balance_profit": 0},
        {"id": "not-active", "role": "user", "status": "pending", "balance_profit": 0},
        {"id": "admin", "role": "admin", "status": "active", "balance_profit": 0},
    ])
    ad_doc = {
        "id": "campaign-new",
        "user_id": "creator",
        "status": "published",
        "price_amount": 10000,
    }
    await db.ads.insert_one(ad_doc)
    await ads._initialise_reactor_pool(
        db, ad_doc, reward_model=ads.EQUAL_ACTIVE_SHARE_MODEL,
    )
    ad_doc = await db.ads.find_one({"id": "campaign-new"})

    assert ad_doc["reactor_pool"] == 7000
    assert ad_doc["reactor_eligible_users"] == 3
    assert ad_doc["reactor_reward_per_user"] == 2333.33

    first_action_results = await asyncio.gather(
        ads._credit_reactor(db, ad_doc, "member-a", "membera", "like"),
        ads._credit_reactor(db, ad_doc, "member-a", "membera", "comment"),
    )
    assert sorted(result is not None for result in first_action_results) == [False, True]
    assert await ads._credit_reactor(db, ad_doc, "member-a", "membera", "like") is None

    assert await ads._credit_reactor(db, ad_doc, "member-b", "memberb", "comment") == 2333.33
    assert await ads._credit_reactor(db, ad_doc, "member-c", "memberc", "like") == 2333.33
    assert await ads._credit_reactor(db, ad_doc, "creator", "creator", "like") is None
    await db.users.update_one({"id": "not-active"}, {"$set": {"status": "active"}})
    assert await ads._credit_reactor(db, ad_doc, "not-active", "pending", "like") is None

    assert (await db.users.find_one({"id": "member-a"}))["balance_profit"] == 2333.33
    assert (await db.users.find_one({"id": "member-b"}))["balance_profit"] == 2333.33
    assert (await db.users.find_one({"id": "member-c"}))["balance_profit"] == 2333.33
    assert (await db.users.find_one({"id": "not-active"}))["balance_profit"] == 0
    assert await db.ads_reactor_rewards.count_documents({
        "ad_id": "campaign-new", "status": "paid",
    }) == 3
    final_ad = await db.ads.find_one({"id": "campaign-new"})
    assert final_ad["reactor_users_awarded"] == 3
    assert final_ad["reactor_pool_remaining"] == pytest.approx(0.01)


@pytest.mark.asyncio
async def test_existing_campaign_keeps_fixed_reward_rules():
    db = AsyncMongoMockClient(tz_aware=True).ads_equal_share_legacy_test
    await ads.initialize_reactor_reward_indexes(db)
    await db.ads_reactor_config.insert_one({
        "key": "singleton",
        "distribution_percentage": 70,
        "like_reward": 10,
        "comment_reward": 10,
        "max_likes": 2000,
        "max_comments": 2000,
    })
    await db.users.insert_one({
        "id": "legacy-member", "role": "user", "status": "active", "balance_profit": 0,
    })
    legacy_ad = {
        "id": "campaign-old",
        "user_id": "old-creator",
        "status": "published",
        "price_amount": 10000,
        "reactor_pool": 7000,
        "reactor_pool_remaining": 7000,
        "reactor_max_likes": 2000,
        "reactor_max_comments": 2000,
        "reactor_likes_awarded": 0,
        "reactor_comments_awarded": 0,
    }
    await db.ads.insert_one(legacy_ad)

    assert await ads._credit_reactor(
        db, legacy_ad, "legacy-member", "legacy", "like",
    ) == 10
    assert (await db.users.find_one({"id": "legacy-member"}))["balance_profit"] == 10
    assert (await db.ads.find_one({"id": "campaign-old"}))["reactor_pool_remaining"] == 6990
