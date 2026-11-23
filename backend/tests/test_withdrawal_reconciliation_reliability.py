"""Isolated payout lifecycle regressions. Provider requests are mocked."""
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

from mongomock_motor import AsyncMongoMockClient

import biztranspay
import moneyfusion


def run(coro):
    return asyncio.run(coro)


def _db():
    return AsyncMongoMockClient(tz_aware=True).withdrawal_reliability


def _moneyfusion_rows(db, *, status="dispatched", token="mf-token", withdrawal_status="processing"):
    async def seed():
        await db.users.insert_one({
            "id": "member", "balance_profit": 100, "total_withdrawn": 0,
        })
        await db.withdrawals.insert_one({
            "id": "wd-mf", "user_id": "member", "amount": 3000, "net_payout": 2650,
            "country": "TG", "operator": "tmoney-tg", "phone": "90123456",
            "status": withdrawal_status, "gateway": "moneyfusion",
        })
        await db.moneyfusion_payouts.insert_one({
            "wd_id": "wd-mf", "user_id": "member", "amount": 2650,
            "amount_xof": 3000, "currency": "XOF", "country_code": "TG",
            "operator_code": "tmoney-tg", "phone": "90123456",
            "status": status, "tokenPay": token,
        })
    run(seed())


def test_moneyfusion_poll_reconciles_success_once_without_submission(monkeypatch):
    db = _db()
    _moneyfusion_rows(db)
    calls = []

    async def verified(token, private_key):
        calls.append((token, private_key))
        return {"success": True, "data": {
            "tokenPay": token, "amount": 2650, "phone": "90123456",
            "method": "tmoney-tg", "status": "success",
        }}

    monkeypatch.setattr(moneyfusion, "load_credentials",
                        AsyncMock(return_value={"payout_private_key": "test-only"}))
    monkeypatch.setattr(moneyfusion, "_verify_payout", verified)

    first = run(moneyfusion.reconcile_all_dispatched(db, max_docs=5))
    second = run(moneyfusion.reconcile_all_dispatched(db, max_docs=5))

    withdrawal = run(db.withdrawals.find_one({"id": "wd-mf"}))
    user = run(db.users.find_one({"id": "member"}))
    assert first["updated"] == 1
    assert second["scanned"] == 0
    assert withdrawal["status"] == "completed"
    assert user["total_withdrawn"] == 3000
    assert len(calls) == 1
    assert run(db.notifications.count_documents({"user_id": "member"})) == 1


def test_moneyfusion_failure_refunds_once_and_appears_as_terminal_failure(monkeypatch):
    db = _db()
    _moneyfusion_rows(db)

    async def verified(token, private_key):
        return {"success": True, "data": {
            "tokenPay": token, "amount": 2650, "phone": "90123456",
            "method": "tmoney-tg", "status": "failed",
        }}

    monkeypatch.setattr(moneyfusion, "load_credentials",
                        AsyncMock(return_value={"payout_private_key": "test-only"}))
    monkeypatch.setattr(moneyfusion, "_verify_payout", verified)
    run(moneyfusion.reconcile_all_dispatched(db, max_docs=5))
    payout = run(db.moneyfusion_payouts.find_one({"wd_id": "wd-mf"}))
    run(moneyfusion._apply_payout_status(db, payout, "failed", {}))

    withdrawal = run(db.withdrawals.find_one({"id": "wd-mf"}))
    user = run(db.users.find_one({"id": "member"}))
    assert withdrawal["status"] == "failed"
    assert user["balance_profit"] == 3100
    assert user["total_withdrawn"] == 0
    assert run(db.notifications.count_documents({"user_id": "member"})) == 1


def test_moneyfusion_unknown_without_token_is_not_polled_or_resubmitted(monkeypatch):
    db = _db()
    _moneyfusion_rows(db, status="unknown", token="")
    verify = AsyncMock()
    monkeypatch.setattr(moneyfusion, "_verify_payout", verify)

    outcome = run(moneyfusion.reconcile_withdrawal(db, "wd-mf"))
    sweep = run(moneyfusion.reconcile_all_dispatched(db, max_docs=5))

    assert outcome["ok"] is False
    assert outcome["reason"] == "token_required"
    assert sweep["scanned"] == 0
    verify.assert_not_awaited()
    assert run(db.withdrawals.find_one({"id": "wd-mf"}))["status"] == "processing"


def test_biztranspay_settlement_accounts_and_notifies_once():
    db = _db()

    async def seed():
        await db.users.insert_one({
            "id": "member", "balance_profit": 100, "total_withdrawn": 0,
        })
        return {
            "id": "wd-btp", "user_id": "member", "amount": 3000,
            "status": "dispatched", "gateway": "biztranspay",
        }

    withdrawal = run(seed())
    run(db.withdrawals.insert_one(dict(withdrawal)))
    first = run(biztranspay._settle_withdrawal_status(
        db, withdrawal, "completed", "completed", source="test",
    ))
    second = run(biztranspay._settle_withdrawal_status(
        db, withdrawal, "completed", "completed", source="test",
    ))

    assert first["changed"] is True
    assert second["changed"] is False
    assert run(db.users.find_one({"id": "member"}))["total_withdrawn"] == 3000
    assert run(db.notifications.count_documents({"user_id": "member"})) == 1


def test_biztranspay_nested_error_code_is_preserved():
    assert biztranspay._btp_error_code({
        "detail": {"code": 1001, "message": "Operator unavailable"},
    }) == "1001"


def test_admin_withdrawal_actions_keep_the_selected_status_tab():
    root = Path(__file__).resolve().parents[2]
    source = (root / "frontend" / "app" / "(admin)" / "index.tsx").read_text()
    assert "autoSwitchTo" not in source
    assert 'w.status === "failed"' in source
    assert 'w.gateway === "moneyfusion"' in source
