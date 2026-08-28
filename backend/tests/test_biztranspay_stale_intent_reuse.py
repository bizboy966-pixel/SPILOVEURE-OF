"""Regression — a deposit BizTransPay has already closed must never be handed
back to the user as if it were still open.

BizTransPay expires an unpaid deposit after ~11 minutes, but the initiate
routes dedupe on any locally-`pending` row younger than 30 minutes. In that
gap the routes used to return the stored reference WITHOUT calling the gateway
again, so pressing "Activer" produced a 200 and no operator prompt at all:

    « Tu lances l'activation, aucune requete ne lance. »  (ticket 238988)

`_reuse_verdict` closes that gap by asking the gateway for the intent's real
status before reuse.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import biztranspay as btp  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

CFG = {"base_url": "https://example.invalid/api/developer/v2",
       "public_key": "pk_x", "secret_key": "sk_x"}


def _db():
    cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    return cli[os.environ.get("DB_NAME", "spilivere")]


async def _seed(db, ref: str, intent_id: str, age_min: int = 15) -> dict:
    created = datetime.now(timezone.utc) - timedelta(minutes=age_min)
    pay = {"reference": ref, "provider": "biztranspay", "channel": "mobile_money",
           "provider_intent_id": intent_id, "user_id": "stale-test-user",
           "level": 1, "kind": "activation", "status": "pending",
           "amount": 2500, "currency": "XOF", "activation_done": False,
           "created_at": created, "updated_at": created}
    await db.payments.insert_one(dict(pay))
    await db.activations.insert_one({
        "id": str(uuid.uuid4()), "user_id": "stale-test-user", "level": 1,
        "status": "pending", "payment_method": "biztranspay_mobile",
        "reference": ref, "created_at": created})
    return pay


async def _clean(db, ref: str):
    await db.payments.delete_many({"reference": ref})
    await db.activations.delete_many({"reference": ref})


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_gateway_closed_intent_is_stale_and_closed_locally():
    async def body():
        db = _db()
        ref = f"TEST_STALE_{uuid.uuid4().hex[:8]}"
        pay = await _seed(db, ref, "intent-failed")
        orig = btp._fetch_transaction
        btp._fetch_transaction = lambda cfg, iid: _ok({"status": "failed"})
        try:
            verdict = await btp._reuse_verdict(db, CFG, pay)
        finally:
            btp._fetch_transaction = orig
        assert verdict == "stale", verdict
        row = await db.payments.find_one({"reference": ref})
        act = await db.activations.find_one({"reference": ref})
        await _clean(db, ref)
        # The dead row must be closed, otherwise it keeps winning the dedupe.
        assert row["status"] == "failed", row["status"]
        assert row["provider_status"] == "failed"
        assert act["status"] == "rejected", act["status"]
    _run(body())


def test_still_pending_intent_is_reused():
    async def body():
        db = _db()
        ref = f"TEST_LIVE_{uuid.uuid4().hex[:8]}"
        pay = await _seed(db, ref, "intent-pending", age_min=2)
        orig = btp._fetch_transaction
        btp._fetch_transaction = lambda cfg, iid: _ok({"status": "pending"})
        try:
            verdict = await btp._reuse_verdict(db, CFG, pay)
        finally:
            btp._fetch_transaction = orig
        row = await db.payments.find_one({"reference": ref})
        await _clean(db, ref)
        assert verdict == "live", verdict
        assert row["status"] == "pending", row["status"]
    _run(body())


def test_unreachable_gateway_reuses_rather_than_double_charging():
    async def body():
        db = _db()
        ref = f"TEST_DOWN_{uuid.uuid4().hex[:8]}"
        pay = await _seed(db, ref, "intent-unknown")
        orig = btp._fetch_transaction
        btp._fetch_transaction = lambda cfg, iid: _ok(None)
        try:
            verdict = await btp._reuse_verdict(db, CFG, pay)
        finally:
            btp._fetch_transaction = orig
        await _clean(db, ref)
        assert verdict == "live", verdict
    _run(body())


def test_paid_intent_is_settled_not_discarded():
    async def body():
        db = _db()
        ref = f"TEST_PAID_{uuid.uuid4().hex[:8]}"
        pay = await _seed(db, ref, "intent-completed")
        seen = {}
        orig_f, orig_a = btp._fetch_transaction, btp._apply_activation
        btp._fetch_transaction = lambda cfg, iid: _ok({"status": "completed"})

        async def _spy(db_, p, tx):
            seen["ref"] = p["reference"]
            return {"ok": True, "activated": True}
        btp._apply_activation = _spy
        try:
            verdict = await btp._reuse_verdict(db, CFG, pay)
        finally:
            btp._fetch_transaction, btp._apply_activation = orig_f, orig_a
        await _clean(db, ref)
        assert verdict == "completed", verdict
        # A deposit that was actually paid must be activated, never dropped.
        assert seen.get("ref") == ref
    _run(body())


async def _ok(value):
    return value


class _FakeState:
    def __init__(self, db):
        self.db = db


class _FakeApp:
    def __init__(self, db):
        self.state = _FakeState(db)


class _FakeRequest:
    def __init__(self, db):
        self.app = _FakeApp(db)


class _FakeResp:
    status_code = 200

    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


def test_initiate_fires_a_new_gateway_call_when_stored_intent_is_dead():
    """The user-visible bug, end to end.

    A dead pending intent 15 minutes old (inside the 30-minute dedupe window,
    past BizTransPay's ~11-minute expiry). Pressing "Activer" must now produce
    a real POST /deposits/mobile-money instead of silently echoing the corpse.
    """
    async def body():
        db = _db()
        ref = f"TEST_E2E_{uuid.uuid4().hex[:8]}"
        uid = "stale-test-user"
        await _seed(db, ref, "intent-dead")
        calls = []

        async def _http(method, cfg, path, **kw):
            calls.append((method, path))
            if method == "GET":                      # status lookup on the old intent
                return _FakeResp({"status": "failed"})
            return _FakeResp({"transaction_id": "brand-new-intent",
                              "status": "pending"})

        async def _cfg(_db):
            return {**btp.DEFAULTS, "enabled": True, "public_key": "pk_x",
                    "secret_key": "sk_x", "base_url": CFG["base_url"]}

        orig_http, orig_cfg = btp._http, btp._load_config
        btp._http, btp._load_config = _http, _cfg
        try:
            out = await btp.biztranspay_mobile_initiate(
                btp.MobileInitiateIn(country="TG", operator_code="tmoney_tg",
                                     phone="90000000"),
                _FakeRequest(db),
                {"id": uid, "max_level": 0, "username": "t", "email": "t@x.com"},
            )
        finally:
            btp._http, btp._load_config = orig_http, orig_cfg

        old = await db.payments.find_one({"reference": ref})
        await _clean(db, ref)
        await db.payments.delete_many({"user_id": uid})
        await db.activations.delete_many({"user_id": uid})

        posts = [c for c in calls if c[0] == "POST"]
        assert posts, f"no new gateway request was sent; calls={calls}"
        assert posts[0][1] == "/deposits/mobile-money", posts
        # A fresh reference, not the dead one echoed back.
        assert out["reference"] != ref, out
        assert out["provider_intent_id"] == "brand-new-intent", out
        # And the corpse was closed on the way through.
        assert old["status"] == "failed", old["status"]
    _run(body())
