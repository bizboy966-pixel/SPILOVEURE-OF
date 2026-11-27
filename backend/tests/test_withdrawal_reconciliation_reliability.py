"""Isolated payout lifecycle regressions. Provider requests are mocked."""
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from mongomock_motor import AsyncMongoMockClient

import biztranspay
import izichange
import moneyfusion


def run(coro):
    return asyncio.run(coro)


def _db():
    return AsyncMongoMockClient(tz_aware=True).withdrawal_reliability


class _MongoCollectionWithoutTruthiness:
    """Mirror PyMongo collections, which reject boolean evaluation."""

    def __init__(self, collection):
        self._collection = collection

    def __bool__(self):
        raise NotImplementedError("Collection objects do not support truth testing")

    def __getattr__(self, name):
        return getattr(self._collection, name)


def _db_with_non_truthy_wallet_sends(db):
    return SimpleNamespace(
        moneyfusion_payouts=db.moneyfusion_payouts,
        withdrawals=db.withdrawals,
        wallet_sends=_MongoCollectionWithoutTruthiness(db.wallet_sends),
    )


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


def test_moneyfusion_stale_submission_handles_non_truthy_wallet_sends_collection():
    db = _db()
    stale_created_at = datetime.now(timezone.utc) - timedelta(minutes=10)

    async def seed():
        await db.moneyfusion_payouts.insert_one({
            "wd_id": "wd-stale-mf", "status": "submitting",
            "created_at": stale_created_at,
        })
        await db.withdrawals.insert_one({
            "id": "wd-stale-mf", "status": "processing",
            "gateway": "moneyfusion",
        })
        await db.wallet_sends.insert_one({
            "id": "wd-stale-mf", "status": "submitting",
        })

    run(seed())
    result = run(moneyfusion.reconcile_all_dispatched(
        _db_with_non_truthy_wallet_sends(db), max_docs=5,
    ))

    payout = run(db.moneyfusion_payouts.find_one({"wd_id": "wd-stale-mf"}))
    wallet_send = run(db.wallet_sends.find_one({"id": "wd-stale-mf"}))
    assert result["stale_marked_unknown"] == 1
    assert payout["status"] == "unknown"
    assert wallet_send["status"] == "unknown"


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


def test_biztranspay_sweep_handles_non_truthy_wallet_sends_collection():
    db = _db()

    result = run(biztranspay.reconcile_all_dispatched(
        _db_with_non_truthy_wallet_sends(db), max_docs=5,
    ))

    assert result == {"scanned": 0, "updated": 0, "errors": 0, "changes": []}


def test_crypto_withdrawal_uses_idempotent_payout_and_refunds_final_failure_once(monkeypatch):
    import server
    from models import WithdrawalIn

    db = _db()
    run(db.users.insert_one({"id": "member", "balance_crypto": 3.0}))
    monkeypatch.setattr(
        izichange, "withdrawal_assets",
        AsyncMock(return_value=[{"asset_code": "USDT.BEP20"}]),
    )
    submit = AsyncMock(return_value={"id": "izi-po-1", "status": "pending"})
    monkeypatch.setattr(izichange, "create_payout", submit)
    wallet = {
        "country": "TG", "full_name": "Member", "method": "crypto",
        "asset_code": "USDT.BEP20", "wallet_address": "0x" + "a" * 40,
    }
    data = WithdrawalIn(
        amount=1.25, method="crypto", asset_code="USDT.BEP20",
        request_id="client-request-1",
    )
    settings = {"crypto_min_amount": 0, "crypto_fee_percent": 0, "crypto_fee_flat": 0}

    first = run(server._request_crypto_withdrawal(
        db, {"id": "member", "username": "member"}, wallet, data, settings,
    ))
    duplicate = run(server._request_crypto_withdrawal(
        db, {"id": "member", "username": "member"}, wallet, data, settings,
    ))
    user = run(db.users.find_one({"id": "member"}))
    wd = run(db.withdrawals.find_one({"id": first["id"]}))

    assert first["status"] == duplicate["status"] == "dispatched"
    assert user["balance_crypto"] == 1.75
    assert wd["payout_id"] == "izi-po-1"
    assert submit.await_count == 1

    event = {"merchantReference": wd["id"], "id": "izi-po-1", "status": "failed"}
    first_failure = run(izichange._handle_payout_event(db, "payout.failed", event))
    second_failure = run(izichange._handle_payout_event(db, "payout.failed", event))
    current = run(db.withdrawals.find_one({"id": wd["id"]}))
    user = run(db.users.find_one({"id": "member"}))
    assert first_failure["status"] == second_failure["status"] == "rejected"
    assert current["status"] == "rejected"
    assert user["balance_crypto"] == 3.0


def test_crypto_withdrawal_uncertain_submission_is_not_refunded_or_retried(monkeypatch):
    import server
    from models import WithdrawalIn

    db = _db()
    run(db.users.insert_one({"id": "member", "balance_crypto": 3.0}))
    monkeypatch.setattr(
        izichange, "withdrawal_assets",
        AsyncMock(return_value=[{"asset_code": "USDT.BEP20"}]),
    )
    submit = AsyncMock(side_effect=izichange.PayoutSubmissionError(
        "uncertain", uncertain=True,
    ))
    monkeypatch.setattr(izichange, "create_payout", submit)
    wallet = {
        "country": "GA", "full_name": "Member", "method": "crypto",
        "asset_code": "USDT.BEP20", "wallet_address": "0x" + "b" * 40,
    }
    data = WithdrawalIn(
        amount=1, method="crypto", asset_code="USDT.BEP20",
        request_id="uncertain-request",
    )
    settings = {"crypto_min_amount": 0, "crypto_fee_percent": 0, "crypto_fee_flat": 0}

    result = run(server._request_crypto_withdrawal(
        db, {"id": "member"}, wallet, data, settings,
    ))
    replay = run(server._request_crypto_withdrawal(
        db, {"id": "member"}, wallet, data, settings,
    ))
    wd = run(db.withdrawals.find_one({"id": result["id"]}))
    user = run(db.users.find_one({"id": "member"}))

    assert result["status"] == replay["status"] == "unknown"
    assert wd["gateway_status"] == "unknown"
    assert user["balance_crypto"] == 2.0
    assert submit.await_count == 1


def test_crypto_withdrawal_resumes_unclaimed_record_without_double_debit(monkeypatch):
    import uuid
    import server
    from models import WithdrawalIn

    db = _db()
    run(db.users.insert_one({"id": "member", "balance_crypto": 3.0}))
    request_id = "resume-request"
    wd_id = str(uuid.uuid5(
        uuid.NAMESPACE_URL, f"spiloveure:crypto-withdrawal:member:{request_id}",
    ))
    run(db.withdrawals.insert_one({
        "_id": wd_id, "id": wd_id, "client_request_id": request_id,
        "user_id": "member", "amount": 1.0, "wallet_debit": 1.0,
        "fee": 0.0, "net_payout": 1.0, "asset_code": "USDT.BEP20",
        "method": "crypto", "wallet_address": "0x" + "d" * 40,
        "gateway": "izichange", "status": "pending",
    }))
    monkeypatch.setattr(
        izichange, "withdrawal_assets",
        AsyncMock(return_value=[{"asset_code": "USDT.BEP20"}]),
    )
    submit = AsyncMock(return_value={"id": "izi-resume-1", "status": "pending"})
    monkeypatch.setattr(izichange, "create_payout", submit)

    result = run(server._request_crypto_withdrawal(
        db, {"id": "member"}, {
            "country": "TG", "method": "crypto", "asset_code": "USDT.BEP20",
            "wallet_address": "0x" + "d" * 40,
        }, WithdrawalIn(
            amount=1.0, method="crypto", asset_code="USDT.BEP20",
            request_id=request_id,
        ), {"crypto_min_amount": 0, "crypto_fee_percent": 0, "crypto_fee_flat": 0},
    ))
    user = run(db.users.find_one({"id": "member"}))

    assert result["status"] == "dispatched"
    assert user["balance_crypto"] == 2.0
    assert submit.await_count == 1


def test_crypto_withdrawal_status_poll_resolves_uncertain_reference_until_final(monkeypatch):
    import server

    db = _db()
    run(db.users.insert_one({
        "id": "member", "balance_crypto": 2.0,
        "crypto_withdrawal_debits": ["wd-crypto-poll"],
    }))
    wd = {
        "id": "wd-crypto-poll", "user_id": "member", "method": "crypto",
        "gateway": "izichange", "status": "unknown", "gateway_status": "unknown",
        "asset_code": "USDT.BEP20", "amount": 1.0, "wallet_debit": 1.0,
        "net_payout": 0.98,
    }
    run(db.withdrawals.insert_one(wd))
    find_by_reference = AsyncMock(return_value={
        "id": "izi-poll-1", "merchantReference": "wd-crypto-poll", "status": "pending",
    })
    get_by_id = AsyncMock(return_value={
        "id": "izi-poll-1", "merchantReference": "wd-crypto-poll", "status": "confirmed",
        "txid": "0xconfirmed",
    })
    monkeypatch.setattr(izichange, "get_payout_by_reference", find_by_reference)
    monkeypatch.setattr(izichange, "get_payout", get_by_id)

    first = run(server._reconcile_izichange_withdrawal(db, wd))
    saved = run(db.withdrawals.find_one({"id": wd["id"]}))
    second = run(server._reconcile_izichange_withdrawal(db, saved))
    final = run(db.withdrawals.find_one({"id": wd["id"]}))
    user = run(db.users.find_one({"id": "member"}))

    assert first["gateway_status"] == "pending"
    assert saved["payout_id"] == "izi-poll-1"
    assert second["status"] == "completed"
    assert final["status"] == "completed"
    assert user["balance_crypto"] == 2.0
    assert user["total_withdrawn_crypto"] == 1.0
    find_by_reference.assert_awaited_once()
    get_by_id.assert_awaited_once_with("izi-poll-1")


def test_izichange_payout_request_matches_documented_payload_without_network(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(izichange, "API_KEY", "test-only")
    calls = []

    async def fake_post(path, body, *, timeout, idempotency_key):
        calls.append((path, body, idempotency_key))
        return SimpleNamespace(status_code=201, json=lambda: {
            "id": "payout-test", "status": "pending",
        })

    monkeypatch.setattr(izichange, "_api_post", fake_post)
    result = run(izichange.create_payout(
        None, reference="withdrawal-test", amount_usdt=1.25,
        destination_address="0x" + "c" * 40, asset_code="USDT.BEP20",
    ))

    assert result["id"] == "payout-test"
    assert calls[0][0] == "/v1/payouts"
    assert calls[0][1]["amount"] == "1.25"
    assert calls[0][1]["amountType"] == "crypto"
    assert calls[0][1]["assetCode"] == "USDT.BEP20"
    assert calls[0][1]["destinationAddress"] == "0x" + "c" * 40
    assert calls[0][1]["merchantReference"] == "withdrawal-test"
    assert calls[0][1]["feeBearer"] == "merchant"
    assert calls[0][2] == "payout-withdrawal-test"


def test_izichange_withdrawal_assets_use_active_merchant_assets_only(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(izichange, "API_KEY", "test-only")
    monkeypatch.setattr(izichange, "feature_enabled", AsyncMock(return_value=True))
    response = SimpleNamespace(
        status_code=200,
        json=lambda: {"data": [
            {"assetCode": "USDT.BEP20", "coinCode": "USDT", "network": "BEP20", "isActive": True},
            {"assetCode": "USDT.ERC20", "coinCode": "USDT", "network": "ERC20", "isActive": False},
        ]},
    )
    get = AsyncMock(return_value=response)
    monkeypatch.setattr(izichange, "_api_get", get)

    assets = run(izichange.withdrawal_assets(None))

    assert [item["asset_code"] for item in assets] == ["USDT.BEP20"]
    assert assets[0]["network"] == "BEP20"
    get.assert_awaited_once_with("/v1/merchant-assets")


def test_izichange_uncertain_payout_can_be_found_by_reference_with_get_only(monkeypatch):
    from types import SimpleNamespace

    response = SimpleNamespace(
        status_code=200,
        json=lambda: {"data": [{
            "id": "payout-lookup",
            "merchantReference": {"reference": "withdrawal-lookup"},
            "status": "pending",
        }]},
    )
    get = AsyncMock(return_value=response)
    monkeypatch.setattr(izichange, "_api_get", get)

    payout = run(izichange.get_payout_by_reference("withdrawal-lookup"))

    assert payout["id"] == "payout-lookup"
    assert payout["status"] == "pending"
    get.assert_awaited_once_with(
        "/v1/payouts?payoutType=crypto&merchantReference=withdrawal-lookup",
    )


def test_user_withdrawal_history_does_not_expose_provider_names():
    import server

    db = _db()
    run(db.withdrawals.insert_one({
        "id": "mobile-wd", "user_id": "member", "amount": 1000,
        "method": "mobile", "status": "pending", "gateway": "moneyfusion",
        "provider_name": "MoneyFusion", "created_at": datetime.now(timezone.utc),
    }))
    run(db.withdrawals.insert_one({
        "id": "crypto-wd", "user_id": "member", "amount": 1.25, "fee": 0.02,
        "net_payout": 1.23, "method": "crypto", "asset_code": "USDT.BEP20",
        "status": "unknown", "gateway": "izichange", "provider_name": "IziChange",
        "created_at": datetime.now(timezone.utc),
    }))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))

    history = run(server.my_withdrawals(request, {"id": "member"}))
    transactions = run(server._build_transaction_history(db, "member"))
    crypto_transaction = next(item for item in transactions if item.get("ref") == "crypto-wd")

    assert len(history) == 2
    mobile_history = next(item for item in history if item["id"] == "mobile-wd")
    assert "gateway" not in mobile_history
    assert "provider_name" not in mobile_history
    assert "MoneyFusion" not in repr(history)
    assert "IziChange" not in repr(history)
    assert crypto_transaction["currency"] == "USDT.BEP20"
    assert crypto_transaction["label"] == "Retrait crypto"
    assert crypto_transaction["amount"] == 1.25
    assert crypto_transaction["net"] == 1.23
    assert crypto_transaction["meta"]["withdrawal_type"] == "crypto"


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
