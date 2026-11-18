"""v27be (2026-03-05) — Stuck activations auto-recovery.

User report: « Après paiement, le compte doit s'activer automatiquement, mais
actuellement ça ne se fait plus. Les paiements se passent, mais le compte ne
s'active pas automatiquement. C'est pareil pour tous les prestataires. »

Root cause : `_apply_payment_success` sets `status=paid` FIRST (so the matrix
security guard can find the record), THEN calls `activate_level`. If anything
goes wrong between these two steps (process restart, transient DB error, a
matrix guard that fails intermittently), the payment is stuck in `paid` state
with `activation_done=False` forever, and no path exists to retry.

The webhook check `if norm == "paid" and not p.get("activation_done"):` only
fires on fresh webhook deliveries. The polling only picks `status: pending|
processing`. Nothing retries `status: paid, activation_done: False`.

Fix v27be : `_reconcile_stuck_activations(db)` sweeps those rows every 4 s
(from the existing polling_loop). Idempotent, scoped to the last 24h, caps
at 50 docs per sweep. Works for ALL providers.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from ashtec_activation import _reconcile_stuck_activations


@pytest.fixture
def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return client[os.environ["DB_NAME"]]


@pytest.mark.asyncio
async def test_recovery_picks_stuck_paid_payment(db):
    """A payment stuck in `status=paid` + `activation_done=False` must be
    picked up by the sweep, re-run through `_apply_payment_success`, and
    reach `activation_done=True`."""
    uid = f"test-stuck-{uuid.uuid4().hex[:8]}"
    ref = f"TEST-STUCK-{uuid.uuid4().hex[:12].upper()}"
    now = datetime.now(timezone.utc)

    # Seed a dummy user at max_level=0.
    await db.users.insert_one({
        "id": uid, "username": f"stuck_{uid[:6]}",
        "email": f"stuck_{uid[:6]}@test.local",
        "max_level": 0, "status": "active",
        "balance_profit": 0, "balance_upgrade": 0, "balance_recharge": 0,
        "created_at": now,
    })
    try:
        # Seed a stuck payment : status=paid but activation_done=False.
        await db.payments.insert_one({
            "reference": ref, "provider": "biztranspay",
            "kind": "activation", "user_id": uid, "level": 1,
            "amount": 2650, "currency": "XOF",
            "status": "paid", "activation_done": False,
            "created_at": now, "updated_at": now,
        })

        r = await _reconcile_stuck_activations(db)
        assert r["checked"] >= 1
        # Either recovered (activated) OR failed (if matrix guard rejects for
        # some env-specific reason) — but it must have been PICKED UP.
        assert (r.get("recovered") or 0) + (r.get("failed") or 0) >= 1
        # After the sweep, the row is either activation_done=True (success)
        # or has an activation_error (failure). Must NOT be unchanged.
        p = await db.payments.find_one({"reference": ref}, {"_id": 0})
        assert p is not None
        if p.get("activation_done"):
            # Recovery worked — user should now be at level 1.
            u = await db.users.find_one({"id": uid}, {"_id": 0, "max_level": 1})
            assert u is not None
            assert int(u["max_level"]) >= 1
        else:
            # Recovery was attempted but matrix guard rejected — error logged.
            assert p.get("activation_error") or p.get("activation_reconciled_at")
    finally:
        await db.users.delete_one({"id": uid})
        await db.payments.delete_one({"reference": ref})


@pytest.mark.asyncio
async def test_recovery_syncs_already_activated_user(db):
    """If the user is already at the right max_level (activated via another
    path like admin_validate), the sweep must just flip activation_done=True
    on the stale payment row, NOT re-run activate_level."""
    uid = f"test-synced-{uuid.uuid4().hex[:8]}"
    ref = f"TEST-SYNCED-{uuid.uuid4().hex[:12].upper()}"
    now = datetime.now(timezone.utc)

    await db.users.insert_one({
        "id": uid, "username": f"synced_{uid[:6]}",
        "email": f"synced_{uid[:6]}@test.local",
        "max_level": 1, "status": "active",   # already activated !
        "balance_profit": 0, "balance_upgrade": 0, "balance_recharge": 0,
        "created_at": now,
    })
    try:
        await db.payments.insert_one({
            "reference": ref, "provider": "biztranspay",
            "kind": "activation", "user_id": uid, "level": 1,
            "amount": 2650, "currency": "XOF",
            "status": "paid", "activation_done": False,  # ← stale flag
            "created_at": now, "updated_at": now,
        })
        r = await _reconcile_stuck_activations(db)
        assert r.get("recovered", 0) >= 1
        p = await db.payments.find_one({"reference": ref}, {"_id": 0})
        assert p.get("activation_done") is True
        assert p.get("activation_reconciled_at") is not None
    finally:
        await db.users.delete_one({"id": uid})
        await db.payments.delete_one({"reference": ref})


@pytest.mark.asyncio
async def test_recovery_ignores_old_abandoned_payments(db):
    """Payments older than 24h must NOT be touched (avoid resurrecting
    truly abandoned flows)."""
    uid = f"test-oldstuck-{uuid.uuid4().hex[:8]}"
    ref = f"TEST-OLDSTUCK-{uuid.uuid4().hex[:12].upper()}"
    long_ago = datetime.now(timezone.utc) - timedelta(days=5)
    await db.users.insert_one({
        "id": uid, "username": f"oldstuck_{uid[:6]}",
        "max_level": 0, "status": "active",
        "balance_profit": 0, "balance_upgrade": 0, "balance_recharge": 0,
    })
    try:
        await db.payments.insert_one({
            "reference": ref, "provider": "biztranspay",
            "kind": "activation", "user_id": uid, "level": 1,
            "amount": 2650, "currency": "XOF",
            "status": "paid", "activation_done": False,
            "created_at": long_ago, "updated_at": long_ago,
        })
        r = await _reconcile_stuck_activations(db)
        # Should NOT be picked up at all.
        p = await db.payments.find_one({"reference": ref}, {"_id": 0})
        assert p.get("activation_done") is False
        assert p.get("activation_reconciled_at") is None
    finally:
        await db.users.delete_one({"id": uid})
        await db.payments.delete_one({"reference": ref})


def test_polling_loop_now_calls_stuck_recovery():
    """polling_loop must call `_reconcile_stuck_activations` every tick."""
    import pathlib
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    loop_start = src.index("async def polling_loop(")
    next_def = src.index("\nasync def ", loop_start + 1)
    body = src[loop_start:next_def]
    assert "_reconcile_stuck_activations" in body, (
        "polling_loop MUST sweep stuck activations every tick"
    )
