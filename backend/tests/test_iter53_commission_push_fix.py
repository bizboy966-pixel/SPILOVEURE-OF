"""Iteration 53 — verify matrix.distribute_commission now writes 'id' UUID
into commission_doc and push_to_user is actually invoked (previously the
tag=f"commission-{commission_doc['id']}" raised KeyError silently).
"""
import os
import sys
import uuid
import asyncio
import pytest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
import matrix as matrix_mod  # noqa: E402


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "spilivere")


@pytest.fixture
def db():
    client = AsyncIOMotorClient(MONGO_URL)
    return client[DB_NAME]


@pytest.mark.asyncio
async def test_commission_doc_has_id_uuid_field(db):
    """Seed a sponsor at level>=2 and a new invitee, call distribute_commission
    for level 2, then read the persisted commission_doc back — it MUST have
    an 'id' field that is a valid UUID string.
    """
    sponsor_id = f"TEST_iter53_sp_{uuid.uuid4().hex[:8]}"
    invitee_id = f"TEST_iter53_inv_{uuid.uuid4().hex[:8]}"

    # Seed sponsor at max_level=2 with empty reserve so upgrade_share stays 0
    await db.users.insert_one({
        "id": sponsor_id, "email": f"{sponsor_id}@t.local",
        "username": sponsor_id,
        "max_level": 2, "balance_upgrade": 0, "balance_profit": 0,
        "sponsor_id": None,
    })
    await db.users.insert_one({
        "id": invitee_id, "email": f"{invitee_id}@t.local",
        "username": invitee_id,
        "max_level": 2, "balance_upgrade": 0, "balance_profit": 0,
        "sponsor_id": sponsor_id,
    })

    try:
        # Patch push_to_user so we can assert it was called with `tag=...`
        push_mock = AsyncMock()
        with patch("push_helper.push_to_user", push_mock):
            credits = await matrix_mod.distribute_commission(
                db, invitee_id, sponsor_id, None, level=1, is_spillover=False,
            )

        assert len(credits) == 1, f"expected 1 credit, got {credits}"
        credit = credits[0]

        # 1) commission_doc has an 'id' field with valid UUID
        assert "id" in credit, f"commission_doc missing 'id' field: {credit}"
        uuid.UUID(credit["id"])  # raises if not a valid UUID

        # 2) Persisted in Mongo with the same id
        stored = await db.commissions.find_one({"id": credit["id"]}, {"_id": 0})
        assert stored is not None, "commission not found in db.commissions"
        assert stored["id"] == credit["id"]
        assert stored["user_id"] == sponsor_id
        assert stored["level"] == 1
        assert stored["kind"] == "direct"

        # 3) push_to_user was actually invoked (previously KeyError swallowed it)
        assert push_mock.await_count >= 1, "push_to_user was never awaited"
        call_kwargs = push_mock.await_args_list[0].kwargs
        assert call_kwargs.get("tag") == f"commission-{credit['id']}", \
            f"unexpected tag: {call_kwargs.get('tag')}"
        assert call_kwargs.get("title", "").startswith("💰")
    finally:
        # Cleanup
        await db.users.delete_many({"id": {"$in": [sponsor_id, invitee_id]}})
        await db.commissions.delete_many({"from_user_id": invitee_id})


@pytest.mark.asyncio
async def test_upgrade_share_profit_share_unchanged(db):
    """Regression: upgrade_share / profit_share values must be unchanged
    after adding the 'id' field. Sponsor at level 1 (needs 4000 for L2),
    empty reserve → half of L1 commission goes to upgrade_share.
    """
    from levels import LEVELS_BY_NUM
    lv1 = LEVELS_BY_NUM[1]
    commission = lv1["commission_per_invite"]
    lv2_price = LEVELS_BY_NUM[2]["price"]

    sponsor_id = f"TEST_iter53_sp2_{uuid.uuid4().hex[:8]}"
    invitee_id = f"TEST_iter53_inv2_{uuid.uuid4().hex[:8]}"

    await db.users.insert_one({
        "id": sponsor_id, "email": f"{sponsor_id}@t.local",
        "username": sponsor_id,
        "max_level": 1, "balance_upgrade": 0, "balance_profit": 0,
        "sponsor_id": None,
    })
    await db.users.insert_one({
        "id": invitee_id, "email": f"{invitee_id}@t.local",
        "username": invitee_id,
        "max_level": 1, "balance_upgrade": 0, "balance_profit": 0,
        "sponsor_id": sponsor_id,
    })

    try:
        with patch("push_helper.push_to_user", AsyncMock()):
            credits = await matrix_mod.distribute_commission(
                db, invitee_id, sponsor_id, None, level=1, is_spillover=False,
            )
        assert len(credits) == 1
        c = credits[0]
        expected_upgrade = min(commission // 2, max(0, lv2_price - 0))
        assert c["upgrade_share"] == expected_upgrade, \
            f"upgrade_share regressed: got {c['upgrade_share']} expected {expected_upgrade}"
        assert c["profit_share"] == commission - expected_upgrade
        assert c["amount"] == commission
    finally:
        await db.users.delete_many({"id": {"$in": [sponsor_id, invitee_id]}})
        await db.commissions.delete_many({"from_user_id": invitee_id})
