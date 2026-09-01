"""Tests for SoleasPay P-Out (automatic Mobile Money disbursement).

Covers:
- Feature-flag gates (master switch, per-country matrix, method must be mobile).
- Operator-label → service_id resolution.
- Idempotency via unique index on soleaspay_payouts.wd_id.
- HTTP dispatch happy path (mocked httpx) + refused path.
- Webhook reconciliation for WITHDRAW events (completed, failed w/ refund).
"""
from __future__ import annotations
import asyncio
import importlib
import os
import uuid

import pytest
from unittest.mock import patch, AsyncMock

os.environ.setdefault("SOLEASPAY_API_KEY", "test-key-abcd")

import soleaspay  # noqa: E402


class _FakeAsyncCollection:
    def __init__(self):
        self._store: list = []
        self._unique_field = None

    def create_index(self, field, unique=False):
        if unique:
            self._unique_field = field
        return None

    async def insert_one(self, doc):
        if self._unique_field:
            key = doc.get(self._unique_field)
            for existing in self._store:
                if existing.get(self._unique_field) == key:
                    raise Exception("E11000 duplicate key")
        self._store.append(dict(doc))
        return type("R", (), {"inserted_id": len(self._store)})

    async def find_one(self, filt):
        for doc in self._store:
            if self._match(doc, filt):
                return dict(doc)
        return None

    async def update_one(self, filt, upd):
        for doc in self._store:
            if self._match(doc, filt):
                if "$set" in upd:
                    doc.update(upd["$set"])
                if "$inc" in upd:
                    for k, v in upd["$inc"].items():
                        doc[k] = (doc.get(k) or 0) + v
                return type("R", (), {"modified_count": 1})()
        return type("R", (), {"modified_count": 0})()

    async def find_one_and_update(self, filt, upd, return_document=None):
        for doc in self._store:
            if self._match(doc, filt):
                if "$set" in upd:
                    doc.update(upd["$set"])
                return dict(doc)
        return None

    @staticmethod
    def _match(doc, filt):
        for k, v in filt.items():
            if k == "$or":
                if not any(_FakeAsyncCollection._match(doc, sub) for sub in v):
                    return False
                continue
            if isinstance(v, dict):
                if "$ne" in v and doc.get(k) == v["$ne"]:
                    return False
                if "$nin" in v and doc.get(k) in v["$nin"]:
                    return False
            else:
                if doc.get(k) != v:
                    return False
        return True


class _FakeDB:
    def __init__(self):
        self.soleaspay_payouts = _FakeAsyncCollection()
        self.soleaspay_payouts.create_index("wd_id", unique=True)
        self.withdrawals = _FakeAsyncCollection()
        self.users = _FakeAsyncCollection()


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _wd(**overrides):
    base = {
        "id": f"wd_{uuid.uuid4().hex[:10]}",
        "user_id": "user_1",
        "username": "alice",
        "amount": 5000, "fee": 100, "net_payout": 4900,
        "method": "mobile",
        "operator": "T-Money", "phone": "+22890123456",
        "country": "TG", "full_name": "Alice",
        "status": "pending",
    }
    base.update(overrides)
    return base


def _pg(**overrides):
    base = {
        "soleas_enabled": True,
        "soleaspay_pout_enabled": True,
        "soleaspay_pout_country_matrix": {},
    }
    base.update(overrides)
    return base


# ─── Feature-flag gates ────────────────────────────────────────────────

def test_pout_gate_master_off():
    r = _run(soleaspay.dispatch_soleaspay_withdrawal(
        _FakeDB(), _wd(), _pg(soleaspay_pout_enabled=False)))
    assert r == {"auto_dispatched": False, "reason": "pout_globally_off"}


def test_pout_gate_soleas_disabled():
    r = _run(soleaspay.dispatch_soleaspay_withdrawal(
        _FakeDB(), _wd(), _pg(soleas_enabled=False)))
    assert r == {"auto_dispatched": False, "reason": "soleas_disabled"}


def test_pout_gate_country_off():
    pg = _pg(soleaspay_pout_country_matrix={"TG": False})
    r = _run(soleaspay.dispatch_soleaspay_withdrawal(_FakeDB(), _wd(), pg))
    assert r == {"auto_dispatched": False, "reason": "pout_country_off"}


def test_pout_gate_country_unsupported():
    r = _run(soleaspay.dispatch_soleaspay_withdrawal(
        _FakeDB(), _wd(country="US"), _pg()))
    assert r["auto_dispatched"] is False
    assert r["reason"] == "country_unsupported"


def test_pout_gate_method_not_mobile():
    r = _run(soleaspay.dispatch_soleaspay_withdrawal(
        _FakeDB(), _wd(method="crypto"), _pg()))
    assert r["reason"] == "not_mobile"


def test_pout_gate_operator_unmapped():
    r = _run(soleaspay.dispatch_soleaspay_withdrawal(
        _FakeDB(), _wd(operator="Random Bank"), _pg()))
    assert r["reason"] == "operator_unmapped"


# ─── Operator label matcher ────────────────────────────────────────────

def test_find_service_by_operator_label_matches_variants():
    assert soleaspay.find_service_by_operator_label("TG", "T-Money")["id"] == 37
    assert soleaspay.find_service_by_operator_label("TG", "t money")["id"] == 37
    assert soleaspay.find_service_by_operator_label("TG", "MOOV")["id"] == 38
    assert soleaspay.find_service_by_operator_label("CI", "Wave Money")["id"] == 32
    assert soleaspay.find_service_by_operator_label("TG", "Unknown") is None


# ─── HTTP dispatch happy + refused paths ───────────────────────────────

def test_pout_dispatch_success_updates_state():
    db = _FakeDB()
    wd = _wd()

    async def fake_initiate_payout(**kwargs):
        return {
            "success": True, "code": 201, "status": "PROCESSING",
            "data": {"reference": "MLS-PROC-1", "transaction_reference": kwargs["order_id"]},
            "message": "withdraw saved to queue",
        }

    _run(db.withdrawals.insert_one(wd))
    with patch.object(soleaspay, "initiate_payout", side_effect=fake_initiate_payout):
        r = _run(soleaspay.dispatch_soleaspay_withdrawal(db, wd, _pg()))

    assert r["auto_dispatched"] is True
    assert r["gateway_intent_id"] == "MLS-PROC-1"

    payout = _run(db.soleaspay_payouts.find_one({"wd_id": wd["id"]}))
    assert payout["status"] == "dispatched"
    assert payout["provider_reference"] == "MLS-PROC-1"

    updated_wd = _run(db.withdrawals.find_one({"id": wd["id"]}))
    assert updated_wd["status"] == "dispatched"
    assert updated_wd["gateway"] == "soleaspay"
    assert updated_wd["gateway_intent_id"] == "MLS-PROC-1"


def test_pout_dispatch_idempotent_on_retry():
    """Calling dispatch twice with same wd must not fire two HTTP calls."""
    db = _FakeDB()
    wd = _wd()
    _run(db.withdrawals.insert_one(wd))

    async def fake_ok(**kwargs):
        return {"success": True, "code": 201, "status": "PROCESSING",
                "data": {"reference": "MLS-1"}, "message": "ok"}

    call_count = {"n": 0}

    async def counted(**kwargs):
        call_count["n"] += 1
        return await fake_ok(**kwargs)

    with patch.object(soleaspay, "initiate_payout", side_effect=counted):
        _run(soleaspay.dispatch_soleaspay_withdrawal(db, wd, _pg()))
        r2 = _run(soleaspay.dispatch_soleaspay_withdrawal(db, wd, _pg()))

    assert call_count["n"] == 1
    assert r2["reason"] == "already_dispatched"
    assert r2["auto_dispatched"] is True  # existing dispatched row


def test_pout_dispatch_refused_by_gateway():
    db = _FakeDB()
    wd = _wd()
    _run(db.withdrawals.insert_one(wd))

    async def fake_refused(**kwargs):
        return {"success": False, "code": 400, "status": "FAILED",
                "message": "Invalid wallet"}

    with patch.object(soleaspay, "initiate_payout", side_effect=fake_refused):
        r = _run(soleaspay.dispatch_soleaspay_withdrawal(db, wd, _pg()))

    assert r["auto_dispatched"] is False
    assert r["reason"] == "gateway_refused"
    payout = _run(db.soleaspay_payouts.find_one({"wd_id": wd["id"]}))
    assert payout["status"] == "refused"
    updated_wd = _run(db.withdrawals.find_one({"id": wd["id"]}))
    assert "auto_dispatch_error" in updated_wd


# ─── Webhook reconciliation ────────────────────────────────────────────

def test_apply_payout_webhook_success_marks_completed():
    db = _FakeDB()
    wd = _wd(status="dispatched", gateway="soleaspay",
             gateway_intent_id="MLS-1")
    _run(db.withdrawals.insert_one(wd))
    _run(db.soleaspay_payouts.insert_one({
        "wd_id": wd["id"], "user_id": wd["user_id"],
        "provider_reference": "MLS-1", "status": "dispatched",
    }))
    payout_row = _run(db.soleaspay_payouts.find_one({"wd_id": wd["id"]}))
    r = _run(soleaspay.apply_payout_webhook(db, payout_row, "SUCCESS", {}))
    assert r["outcome"] == "completed"
    updated = _run(db.withdrawals.find_one({"id": wd["id"]}))
    assert updated["status"] == "completed"


def test_apply_payout_webhook_failure_refunds_balance():
    db = _FakeDB()
    wd = _wd(status="dispatched", amount=5000, gateway="soleaspay")
    _run(db.users.insert_one({"id": wd["user_id"], "balance_profit": 0,
                              "total_withdrawn": 5000}))
    _run(db.withdrawals.insert_one(wd))
    _run(db.soleaspay_payouts.insert_one({
        "wd_id": wd["id"], "user_id": wd["user_id"],
        "provider_reference": "MLS-2", "status": "dispatched",
    }))
    payout_row = _run(db.soleaspay_payouts.find_one({"wd_id": wd["id"]}))
    r = _run(soleaspay.apply_payout_webhook(db, payout_row, "FAILED", {}))
    assert r["outcome"] == "failed"
    updated = _run(db.withdrawals.find_one({"id": wd["id"]}))
    assert updated["status"] == "failed"
    user = _run(db.users.find_one({"id": wd["user_id"]}))
    assert user["balance_profit"] == 5000
    assert user["total_withdrawn"] == 0


# ─── normalize_payout_status ───────────────────────────────────────────

def test_normalize_payout_status():
    assert soleaspay.normalize_payout_status("SUCCESS") == "completed"
    assert soleaspay.normalize_payout_status("COMPLETED") == "completed"
    assert soleaspay.normalize_payout_status("FAILED") == "failed"
    assert soleaspay.normalize_payout_status("FAILURE") == "failed"
    assert soleaspay.normalize_payout_status("PROCESSING") == "pending"
    assert soleaspay.normalize_payout_status("PENDING") == "pending"
    assert soleaspay.normalize_payout_status("weird_state") == "pending"
    assert soleaspay.normalize_payout_status("weird_state", success_flag=False) == "failed"
