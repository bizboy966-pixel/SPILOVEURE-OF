"""Idempotency test for the AshtecPay auto-recharge credit path.

Simulates a paid recharge and calls the `_apply_payment_success` dispatcher
TWICE (as would happen if both the webhook AND the polling endpoint fired
before the first one flipped the `activation_done` flag). Verifies the user
wallet is credited EXACTLY ONCE.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from ashtec_activation import _apply_payment_success  # noqa: E402

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


@pytest.mark.asyncio
async def test_recharge_credits_once_even_with_double_dispatch():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    try:
        # Prepare a synthetic user with a known starting balance.
        uid = f"TEST-RECHARGE-{uuid.uuid4().hex[:8]}"
        await db.users.insert_one({
            "id": uid,
            "username": f"test_{uid[-6:]}",
            "email": f"{uid}@test.local",
            "balance_recharge": 100.0,
            "role": "user",
            "status": "active",
        })
        ref = f"TEST-REF-{uuid.uuid4().hex[:8]}"
        # Payment row as it would exist right after Ashtech's /v1/collect success.
        await db.payments.insert_one({
            "reference": ref,
            "provider": "ashtecpay",
            "kind": "recharge",
            "user_id": uid,
            "amount": 500.0,
            "currency": "XOF",
            "operator": "T-Money",
            "phone": "+22890000001",
            "country_code": "TG",
            "status": "pending",
            "activation_done": False,
            "created_at": datetime.now(timezone.utc),
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
            "transaction_id": f"tx-{uuid.uuid4().hex[:8]}",
        })
        payment = await db.payments.find_one({"reference": ref}, {"_id": 0})

        # Fire the dispatcher CONCURRENTLY twice — mimics webhook + poller.
        await asyncio.gather(
            _apply_payment_success(db, payment, "success", source="test"),
            _apply_payment_success(db, payment, "success", source="test"),
        )

        # Assertions
        u = await db.users.find_one({"id": uid}, {"_id": 0, "balance_recharge": 1})
        assert u["balance_recharge"] == pytest.approx(600.0), (
            f"expected 100 + 500 = 600, got {u['balance_recharge']} (double credit?)"
        )
        p = await db.payments.find_one({"reference": ref}, {"_id": 0})
        assert p["status"] == "paid"
        assert p["activation_done"] is True

        # A recharges row must exist EXACTLY once.
        n = await db.recharges.count_documents({"reference": ref})
        assert n == 1, f"expected 1 recharges row, got {n}"

    finally:
        await db.users.delete_one({"id": uid})
        await db.payments.delete_many({"reference": ref})
        await db.recharges.delete_many({"reference": ref})
        client.close()
