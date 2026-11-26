"""Isolated payout lifecycle regressions. Provider requests are mocked."""
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
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
        return {"statut": True, "data": {
            "tokenPay": token, "Montant": 2650, "phone": "90123456",
            "withdraw_mode": "tmoney-tg", "statut": "paid",
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


def test_moneyfusion_webhook_applies_native_confirmation_format(monkeypatch):
    db = _db()
    _moneyfusion_rows(db)

    class Request:
        app = SimpleNamespace(state=SimpleNamespace(db=db))

        async def json(self):
            return {"tokenPay": "mf-token"}

    monkeypatch.setattr(moneyfusion, "load_credentials",
                        AsyncMock(return_value={"payout_private_key": "test-only"}))

    async def verified(token, private_key):
        return {"statut": True, "data": {
            "tokenPay": token, "Montant": 2650, "phone": "90123456",
            "withdraw_mode": "tmoney-tg", "statut": "paid",
        }}

    monkeypatch.setattr(moneyfusion, "_verify_payout", verified)
    result = run(moneyfusion.payout_webhook(Request()))
    withdrawal = run(db.withdrawals.find_one({"id": "wd-mf"}))
    assert result == {"received": True, "verified": True, "status": "completed"}
    assert withdrawal["status"] == "completed"


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


def test_unsubmitted_mobile_withdrawal_is_rejected_and_refunded_once():
    import server

    db = _db()
    withdrawal = {
        "id": "wd-unavailable", "user_id": "member", "amount": 3000,
        "status": "pending", "gateway": "biztranspay",
        "gateway_status": "not_submitted",
        "auto_dispatch_reason": "Opérateur indisponible dans le catalogue.",
    }

    async def seed():
        await db.users.insert_one({"id": "member", "balance_profit": 0})
        await db.withdrawals.insert_one(withdrawal)

    run(seed())
    first = run(server._reject_unsubmitted_withdrawal(
        db, withdrawal, withdrawal["auto_dispatch_reason"],
    ))
    second = run(server._reject_unsubmitted_withdrawal(
        db, withdrawal, withdrawal["auto_dispatch_reason"],
    ))

    current = run(db.withdrawals.find_one({"id": withdrawal["id"]}))
    user = run(db.users.find_one({"id": "member"}))
    assert first is True and second is False
    assert current["status"] == "rejected"
    assert user["balance_profit"] == 3000
    assert run(db.notifications.count_documents({"user_id": "member"})) == 1


def test_uncertain_provider_result_is_never_automatically_refunded():
    import server

    db = _db()
    withdrawal = {
        "id": "wd-unknown", "user_id": "member", "amount": 3000,
        "status": "processing", "gateway": "moneyfusion",
        "gateway_status": "unknown", "auto_dispatched": True,
        "payout_id": "provider-ref",
    }

    async def seed():
        await db.users.insert_one({"id": "member", "balance_profit": 0})
        await db.withdrawals.insert_one(withdrawal)

    run(seed())
    result = run(server._reject_unsubmitted_withdrawal(
        db, withdrawal, "Statut inconnu",
    ))
    assert result is False
    assert run(db.withdrawals.find_one({"id": withdrawal["id"]}))["status"] == "processing"
    assert run(db.users.find_one({"id": "member"}))["balance_profit"] == 0


def test_biztranspay_preflight_failure_is_marked_not_submitted():
    db = _db()
    async def seed():
        await db.withdrawals.insert_one({
            "id": "wd-btp-unavailable", "status": "pending",
        })
    run(seed())
    run(biztranspay._persist_dispatch_failure(
        db, "wd-btp-unavailable", "operator_not_supported",
        "Opérateur indisponible pour les retraits.",
    ))
    withdrawal = run(db.withdrawals.find_one({"id": "wd-btp-unavailable"}))
    assert withdrawal["gateway_status"] == "not_submitted"
    assert withdrawal["gateway_error"] == "Opérateur indisponible pour les retraits."


def test_verified_biztranspay_withdrawal_can_be_rejected_locally_without_resubmission(monkeypatch):
    import server
    monkeypatch.setattr(
        biztranspay, "reconcile_withdrawal",
        AsyncMock(side_effect=AssertionError("manual verification must not contact the provider")),
    )

    db = _db()
    withdrawal = {
        "id": "wd-btp-verified", "user_id": "member", "amount": 3000,
        "status": "processing", "gateway": "biztranspay",
        "gateway_status": "pending", "auto_dispatched": True,
        "payout_id": "btp-reference",
        "admin_provider_verified_at": datetime.now(timezone.utc),
        "admin_provider_verified_by": "admin",
    }

    async def seed():
        await db.users.insert_one({"id": "member", "balance_profit": 0})
        await db.withdrawals.insert_one(withdrawal)

    run(seed())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    result = run(server.admin_reject_withdrawal(
        withdrawal["id"], request, admin={"id": "admin"},
        body={"reason": "Vérifié auprès du prestataire"},
    ))
    current = run(db.withdrawals.find_one({"id": withdrawal["id"]}))
    assert result["ok"] is True
    assert current["status"] == "rejected"
    assert run(db.users.find_one({"id": "member"}))["balance_profit"] == 3000
    assert run(db.admin_logs.count_documents({
        "action": "reconcile_biztranspay_withdrawal_reject",
    })) == 0
    biztranspay.reconcile_withdrawal.assert_not_awaited()


def test_biztranspay_sweep_reconciles_legacy_payout_without_auto_flag(monkeypatch):
    db = _db()

    async def seed():
        await db.users.insert_one({
            "id": "member", "balance_profit": 0, "total_withdrawn": 0,
        })
        await db.withdrawals.insert_one({
            "id": "wd-legacy-btp", "user_id": "member", "amount": 3000,
            "status": "pending", "gateway": "biztranspay", "payout_id": "btp-po-1",
            # Older transfers may lack auto_dispatched=True despite having a payout ID.
        })

    run(seed())

    async def provider_status(path, secret_key, public_key):
        assert path == "/payouts/btp-po-1"
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"data": {"payout": {"id": "btp-po-1", "status": "completed"}}},
        )

    monkeypatch.setattr(biztranspay, "_get", provider_status)
    monkeypatch.setattr(biztranspay, "_get_secret_key", AsyncMock(return_value="test-secret"))
    monkeypatch.setattr(biztranspay, "_get_public_key", AsyncMock(return_value="test-public"))

    result = run(biztranspay.reconcile_all_dispatched(db, max_docs=5))
    withdrawal = run(db.withdrawals.find_one({"id": "wd-legacy-btp"}))
    user = run(db.users.find_one({"id": "member"}))

    assert result["scanned"] == result["updated"] == 1
    assert withdrawal["status"] == "completed"
    assert user["total_withdrawn"] == 3000


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
