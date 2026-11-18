import pytest
from mongomock_motor import AsyncMongoMockClient

from payment_purchases import complete_paid_purchase


@pytest.mark.asyncio
async def test_direct_jackpot_payment_registers_once():
    db = AsyncMongoMockClient().spiloveure
    await db.lottery_draws.insert_one({
        "id": "draw-1", "name": "Test Jackpot", "status": "open",
        "entry_amount": 2650, "participants_count": 0, "pending_payment_count": 1,
    })
    await db.lottery_participants.insert_one({
        "id": "entry-1", "draw_id": "draw-1", "user_id": "user-1",
        "status": "pending_payment", "paid_amount": 2650,
    })
    payment = {
        "reference": "pay-1", "kind": "lottery_entry", "draw_id": "draw-1",
        "user_id": "user-1", "provider": "ashtecpay",
        "base_amount_xof": 2650,
    }

    first = await complete_paid_purchase(db, payment, source="ashtecpay")
    second = await complete_paid_purchase(db, payment, source="ashtecpay")

    participant = await db.lottery_participants.find_one({"id": "entry-1"})
    draw = await db.lottery_draws.find_one({"id": "draw-1"})
    assert first["registered"] is True
    assert second["already_registered"] is True
    assert participant["status"] == "joined"
    assert draw["participants_count"] == 1
    assert draw["pending_payment_count"] == 0
    assert await db.commissions.count_documents({"payment_reference": "pay-1"}) == 1


@pytest.mark.asyncio
async def test_paid_ticket_for_closed_draw_is_flagged_for_manual_refund():
    db = AsyncMongoMockClient().spiloveure
    await db.lottery_draws.insert_one({
        "id": "draw-2", "name": "Closed Jackpot", "status": "running",
        "entry_amount": 2650, "pending_payment_count": 1,
    })
    await db.lottery_participants.insert_one({
        "id": "entry-2", "draw_id": "draw-2", "user_id": "user-2",
        "status": "pending_payment",
    })
    await db.payments.insert_one({"reference": "pay-2", "status": "paid"})

    result = await complete_paid_purchase(db, {
        "reference": "pay-2", "kind": "lottery_entry", "draw_id": "draw-2",
        "user_id": "user-2", "base_amount_xof": 2650,
    }, source="test")

    payment = await db.payments.find_one({"reference": "pay-2"})
    participant = await db.lottery_participants.find_one({"id": "entry-2"})
    assert result["manual_refund_required"] is True
    assert payment["status"] == "refund_required"
    assert participant["status"] == "refund_required"
