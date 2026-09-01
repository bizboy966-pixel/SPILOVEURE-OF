"""Iteration 57 — SoleasPay P-Out live API integration tests.

Scope (per review request):
- Admin config surface: GET/PUT /api/admin/payment-gateways (new pout fields)
- PUT /api/admin/payment-gateways/soleaspay/pout-country-matrix (coercion)
- GET /api/admin/payment-gateways/route-check (payin_gateway + payout_gateway)
- Auth guards on /admin/payment-gateways/*
- Webhook /api/webhooks/soleaspay: signature, WITHDRAW branch, P-In regression
- POST /api/withdrawals reachability (no 500)

NOTE: the real SoleasPay withdraw API is never called here.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import uuid
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values
from pymongo import MongoClient

frontend_env = dotenv_values("/app/frontend/.env")
backend_env = dotenv_values("/app/backend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")
BASE_URL = base_url.rstrip("/")
API = f"{BASE_URL}/api"
WEBHOOK_SECRET = os.environ.get("SOLEASPAY_WEBHOOK_SECRET") or backend_env.get("SOLEASPAY_WEBHOOK_SECRET") or ""
MONGO_URL = os.environ.get("MONGO_URL") or backend_env.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME") or backend_env.get("DB_NAME")


# ── fixtures ───────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def creds():
    p = Path("/app/memory/test_credentials.md")
    if not p.exists():
        pytest.skip("missing test_credentials.md")
    txt = p.read_text(encoding="utf-8")
    em = re.search(r"(?im)^\s*-\s*\*\*Email\*\*\s*:\s*`([^`]+)`", txt)
    pw = re.search(r"(?im)^\s*-\s*\*\*Password\*\*\s*:\s*`([^`]+)`", txt)
    if not em or not pw:
        pytest.skip("credentials not parseable")
    return {"email": em.group(1), "password": pw.group(1)}


@pytest.fixture(scope="module")
def admin_token(creds):
    r = requests.post(f"{API}/auth/login", json={"email": creds["email"], "password": creds["password"]}, timeout=30)
    if r.status_code != 200:
        pytest.fail(f"admin login failed {r.status_code}: {r.text[:300]}")
    tok = r.json().get("access_token") or r.json().get("token")
    if not tok:
        pytest.fail(f"no token in login response: {r.text[:300]}")
    return tok


@pytest.fixture(scope="module")
def H(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def db():
    if not (MONGO_URL and DB_NAME):
        pytest.skip("MONGO_URL/DB_NAME missing")
    cli = MongoClient(MONGO_URL)
    yield cli[DB_NAME]
    cli.close()


@pytest.fixture(scope="module", autouse=True)
def restore_state(H):
    """Snapshot pout config, restore (and force master OFF) at teardown."""
    r = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30)
    snap = r.json() if r.status_code == 200 else {}
    yield snap
    try:
        requests.put(f"{API}/admin/payment-gateways", headers=H,
                     json={"soleaspay_pout_enabled": False}, timeout=30)
        requests.put(f"{API}/admin/payment-gateways/soleaspay/pout-country-matrix", headers=H,
                     json={"matrix": snap.get("soleaspay_pout_country_matrix") or {}}, timeout=30)
    except Exception:
        pass


def _sign(payload: dict) -> tuple[bytes, str]:
    raw = json.dumps(payload).encode()
    sig = hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, sig


def _set_pout(H, enabled: bool):
    r = requests.put(f"{API}/admin/payment-gateways", headers=H,
                     json={"soleaspay_pout_enabled": enabled}, timeout=30)
    assert r.status_code == 200, r.text[:300]
    return r


def _set_matrix(H, matrix: dict):
    r = requests.put(f"{API}/admin/payment-gateways/soleaspay/pout-country-matrix",
                     headers=H, json={"matrix": matrix}, timeout=30)
    assert r.status_code == 200, r.text[:300]
    return r.json()


# ── module: admin payment-gateways config surface ──────────────────────
class TestAdminConfigSurface:
    def test_auth_required(self):
        for url in (f"{API}/admin/payment-gateways",
                    f"{API}/admin/payment-gateways/route-check?country=TG"):
            r = requests.get(url, timeout=30)
            assert r.status_code in (401, 403), f"{url} -> {r.status_code}"
        r = requests.put(f"{API}/admin/payment-gateways", json={"soleaspay_pout_enabled": True}, timeout=30)
        assert r.status_code in (401, 403)
        r = requests.put(f"{API}/admin/payment-gateways/soleaspay/pout-country-matrix",
                         json={"matrix": {"TG": True}}, timeout=30)
        assert r.status_code in (401, 403)

    def test_get_returns_new_and_legacy_fields(self, H):
        r = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30)
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        for k in ("active", "soleas", "ashtec", "country_matrix", "soleas_countries",
                  "soleaspay_webhook_secret_set", "soleaspay_pout_enabled",
                  "soleaspay_pout_country_matrix"):
            assert k in d, f"missing field {k}"
        assert isinstance(d["soleaspay_pout_enabled"], bool)
        assert isinstance(d["soleaspay_pout_country_matrix"], dict)
        assert "TG" in d["soleas_countries"]

    def test_toggle_pout_on_off_persists(self, H):
        _set_pout(H, True)
        d = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30).json()
        assert d["soleaspay_pout_enabled"] is True
        _set_pout(H, False)
        d = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30).json()
        assert d["soleaspay_pout_enabled"] is False

    def test_pout_matrix_coercion_and_persistence(self, H):
        out = _set_matrix(H, {"tg": 1, "BJ": False, "ci": "yes", "GAB": 0})
        assert out["ok"] is True
        assert out["matrix"] == {"TG": True, "BJ": False, "CI": True, "GAB": False}
        d = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30).json()
        assert d["soleaspay_pout_country_matrix"] == {"TG": True, "BJ": False, "CI": True, "GAB": False}

    def test_pout_matrix_rejects_non_dict(self, H):
        r = requests.put(f"{API}/admin/payment-gateways/soleaspay/pout-country-matrix",
                         headers=H, json={"matrix": ["TG"]}, timeout=30)
        assert r.status_code in (400, 422), r.text[:300]

    def test_toggle_does_not_wipe_other_fields(self, H):
        before = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30).json()
        _set_pout(H, True)
        after = requests.get(f"{API}/admin/payment-gateways", headers=H, timeout=30).json()
        assert after["active"] == before["active"]
        assert after["country_matrix"] == before["country_matrix"]
        assert after["soleaspay_pout_country_matrix"] == before["soleaspay_pout_country_matrix"]
        assert after["soleas"]["enabled"] == before["soleas"]["enabled"]
        _set_pout(H, False)


# ── module: route-check decision matrix ────────────────────────────────
class TestRouteCheck:
    def _rc(self, H, country):
        r = requests.get(f"{API}/admin/payment-gateways/route-check",
                         headers=H, params={"country": country}, timeout=30)
        assert r.status_code == 200, r.text[:300]
        return r.json()

    def test_master_on_supported_country(self, H):
        _set_matrix(H, {})
        _set_pout(H, True)
        d = self._rc(H, "TG")
        assert d["country"] == "TG"
        assert "gateway" in d and "available" in d  # legacy
        assert d["payin_gateway"] == d["gateway"]
        assert d["payout_gateway"] == "soleaspay", d
        # lowercase input must be normalised
        assert self._rc(H, "tg")["payout_gateway"] == "soleaspay"
        _set_pout(H, False)

    def test_master_off_falls_back(self, H):
        _set_pout(H, False)
        d = self._rc(H, "TG")
        assert d["payout_gateway"] == "biztranspay", d

    def test_country_disabled_in_matrix(self, H):
        _set_pout(H, True)
        _set_matrix(H, {"TG": False, "BJ": True})
        assert self._rc(H, "TG")["payout_gateway"] == "biztranspay"
        assert self._rc(H, "BJ")["payout_gateway"] == "soleaspay"
        _set_matrix(H, {})
        _set_pout(H, False)

    def test_unsupported_and_excluded_countries(self, H):
        _set_pout(H, True)
        _set_matrix(H, {})
        assert self._rc(H, "US")["payout_gateway"] == "biztranspay"
        assert self._rc(H, "COD")["payout_gateway"] == "biztranspay"  # RDC excluded
        _set_pout(H, False)


# ── module: webhook branching ──────────────────────────────────────────
class TestWebhook:
    def test_bad_or_missing_signature(self):
        payload = {"data": {"order_id": "SPV-NOPE", "status": "SUCCESS"}}
        raw, _ = _sign(payload)
        r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                          headers={"Content-Type": "application/json"}, timeout=30)
        assert r.status_code == 401
        r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                          headers={"Content-Type": "application/json", "x-signature": "deadbeef"}, timeout=30)
        assert r.status_code == 401

    def test_withdraw_unknown_order_no_500(self):
        oid = f"TEST_WD_{uuid.uuid4().hex[:10]}"
        payload = {"id": f"evt_{oid}", "data": {"order_id": oid, "status": "SUCCESS", "operation": "WITHDRAW"}}
        raw, sig = _sign(payload)
        r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                          headers={"Content-Type": "application/json", "x-signature": sig}, timeout=30)
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d.get("type") == "payout", d
        assert d.get("handled") is False, d

    def test_withdraw_idempotency_same_event_id(self):
        oid = f"TEST_WD_{uuid.uuid4().hex[:10]}"
        payload = {"id": f"evt_{oid}", "data": {"order_id": oid, "status": "FAILED", "operation": "WITHDRAW"}}
        raw, sig = _sign(payload)
        hdrs = {"Content-Type": "application/json", "x-signature": sig}
        r1 = requests.post(f"{API}/webhooks/soleaspay", data=raw, headers=hdrs, timeout=30)
        r2 = requests.post(f"{API}/webhooks/soleaspay", data=raw, headers=hdrs, timeout=30)
        assert r1.status_code == 200 and r2.status_code == 200
        assert r2.json().get("idempotent") is True, r2.text[:300]

    def test_payin_unknown_order_still_routed_to_payin(self):
        oid = f"TEST_PI_{uuid.uuid4().hex[:10]}"
        payload = {"id": f"evt_{oid}", "data": {"order_id": oid, "status": "SUCCESS", "operation": "PAYMENT"}}
        raw, sig = _sign(payload)
        r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                          headers={"Content-Type": "application/json", "x-signature": sig}, timeout=30)
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d.get("unknown_order") is True, d
        assert d.get("type") != "payout", d

    def test_payin_regression_known_order_marked_paid(self, db):
        """P-In branch still processes SUCCESS events after the WITHDRAW branch."""
        ref = f"TEST_SPV_{uuid.uuid4().hex[:10]}"
        db.payments.insert_one({
            "reference": ref, "user_id": "TEST_ghost_user_iter57", "level": 1,
            "amount": 3000, "status": "pending", "gateway": "soleas",
        })
        try:
            payload = {"id": f"evt_{ref}", "data": {"order_id": ref, "status": "SUCCESS",
                                                    "operation": "PAYMENT", "amount": 3000}}
            raw, sig = _sign(payload)
            r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                              headers={"Content-Type": "application/json", "x-signature": sig}, timeout=60)
            assert r.status_code == 200, r.text[:300]
            d = r.json()
            assert d.get("type") != "payout", d
            assert d.get("status") == "SUCCESS", d
            row = db.payments.find_one({"reference": ref})
            assert row["status"] == "paid", row
            # activation attempted (ghost user -> error recorded) proves the branch ran
            assert row.get("activation_done") is True or row.get("activation_error"), row
        finally:
            db.payments.delete_one({"reference": ref})
            db.soleaspay_webhook_events.delete_many({"order_id": ref})

    def test_amount_mismatch_rejected(self, db):
        ref = f"TEST_SPV_{uuid.uuid4().hex[:10]}"
        db.payments.insert_one({
            "reference": ref, "user_id": "TEST_ghost_user_iter57", "level": 1,
            "amount": 3000, "status": "pending", "gateway": "soleas",
        })
        try:
            payload = {"id": f"evt_{ref}", "data": {"order_id": ref, "status": "SUCCESS",
                                                    "operation": "PAYMENT", "amount": 10}}
            raw, sig = _sign(payload)
            r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                              headers={"Content-Type": "application/json", "x-signature": sig}, timeout=30)
            assert r.status_code == 200
            assert r.json().get("rejected") == "amount_mismatch", r.text[:300]
            assert db.payments.find_one({"reference": ref})["status"] == "pending"
        finally:
            db.payments.delete_one({"reference": ref})
            db.soleaspay_webhook_events.delete_many({"order_id": ref})


# ── module: withdrawal reconciliation via webhook (seeded payout row) ──
class TestPayoutReconciliation:
    def test_withdraw_success_marks_completed(self, db):
        wd_id = f"TEST_WDID_{uuid.uuid4().hex[:8]}"
        uid = f"TEST_ghost_{uuid.uuid4().hex[:6]}"
        db.withdrawals.insert_one({"id": wd_id, "user_id": uid, "amount": 5000,
                                   "net_payout": 4750, "status": "dispatched",
                                   "method": "mobile", "country": "TG"})
        db.soleaspay_payouts.insert_one({"wd_id": wd_id, "user_id": uid, "amount": 4750,
                                         "status": "dispatched", "country": "TG",
                                         "provider_reference": f"REF_{wd_id}"})
        try:
            payload = {"id": f"evt_{wd_id}", "data": {"order_id": wd_id, "status": "SUCCESS",
                                                      "operation": "WITHDRAW"}}
            raw, sig = _sign(payload)
            r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                              headers={"Content-Type": "application/json", "x-signature": sig}, timeout=30)
            assert r.status_code == 200, r.text[:300]
            d = r.json()
            assert d["type"] == "payout" and d["handled"] is True, d
            assert d["outcome"] == "completed", d
            assert db.withdrawals.find_one({"id": wd_id})["status"] == "completed"
            assert db.soleaspay_payouts.find_one({"wd_id": wd_id})["status"] == "completed"
        finally:
            db.withdrawals.delete_one({"id": wd_id})
            db.soleaspay_payouts.delete_one({"wd_id": wd_id})
            db.soleaspay_webhook_events.delete_many({"order_id": wd_id})

    def test_withdraw_failed_refunds_balance(self, db):
        wd_id = f"TEST_WDID_{uuid.uuid4().hex[:8]}"
        uid = f"TEST_ghost_{uuid.uuid4().hex[:6]}"
        db.users.insert_one({"id": uid, "username": uid, "email": f"{uid}@test.local",
                             "balance_profit": 0.0, "total_withdrawn": 5000.0,
                             "status": "active", "role": "user"})
        db.withdrawals.insert_one({"id": wd_id, "user_id": uid, "amount": 5000,
                                   "net_payout": 4750, "status": "dispatched",
                                   "method": "mobile", "country": "TG"})
        db.soleaspay_payouts.insert_one({"wd_id": wd_id, "user_id": uid, "amount": 4750,
                                         "status": "dispatched", "country": "TG",
                                         "provider_reference": f"REF_{wd_id}"})
        try:
            payload = {"id": f"evt_{wd_id}", "data": {"order_id": wd_id, "status": "FAILED",
                                                      "operation": "WITHDRAW"}}
            raw, sig = _sign(payload)
            r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                              headers={"Content-Type": "application/json", "x-signature": sig}, timeout=30)
            assert r.status_code == 200, r.text[:300]
            d = r.json()
            assert d["handled"] is True and d["outcome"] == "failed", d
            assert db.withdrawals.find_one({"id": wd_id})["status"] == "failed"
            u = db.users.find_one({"id": uid})
            assert float(u["balance_profit"]) == 5000.0, u
            assert float(u["total_withdrawn"]) == 0.0, u
        finally:
            db.users.delete_one({"id": uid})
            db.withdrawals.delete_one({"id": wd_id})
            db.soleaspay_payouts.delete_one({"wd_id": wd_id})
            db.soleaspay_webhook_events.delete_many({"order_id": wd_id})

    def test_provider_reference_lookup(self, db):
        """Callback keyed on provider reference (not wd_id) must still reconcile."""
        wd_id = f"TEST_WDID_{uuid.uuid4().hex[:8]}"
        prov = f"TEST_REF_{uuid.uuid4().hex[:8]}"
        uid = f"TEST_ghost_{uuid.uuid4().hex[:6]}"
        db.withdrawals.insert_one({"id": wd_id, "user_id": uid, "amount": 2000,
                                   "net_payout": 1900, "status": "dispatched",
                                   "method": "mobile", "country": "BJ"})
        db.soleaspay_payouts.insert_one({"wd_id": wd_id, "user_id": uid, "amount": 1900,
                                         "status": "dispatched", "country": "BJ",
                                         "provider_reference": prov})
        try:
            payload = {"id": f"evt_{prov}", "data": {"order_id": prov, "status": "SUCCESS",
                                                     "operation": "WITHDRAW"}}
            raw, sig = _sign(payload)
            r = requests.post(f"{API}/webhooks/soleaspay", data=raw,
                              headers={"Content-Type": "application/json", "x-signature": sig}, timeout=30)
            assert r.status_code == 200, r.text[:300]
            assert r.json().get("outcome") == "completed", r.text[:300]
            assert db.withdrawals.find_one({"id": wd_id})["status"] == "completed"
        finally:
            db.withdrawals.delete_one({"id": wd_id})
            db.soleaspay_payouts.delete_one({"wd_id": wd_id})
            db.soleaspay_webhook_events.delete_many({"order_id": prov})


# ── module: /api/withdrawals reachability ──────────────────────────────
class TestWithdrawalEndpoint:
    def test_requires_auth(self):
        r = requests.post(f"{API}/withdrawals", json={"amount": 1000}, timeout=30)
        assert r.status_code in (401, 403), r.status_code

    def test_requires_pwd_confirm(self, H):
        r = requests.post(f"{API}/withdrawals", headers=H, json={"amount": 1000}, timeout=30)
        assert r.status_code == 401, r.text[:200]

    def test_no_500_with_confirm_token(self, H, creds):
        r = requests.post(f"{API}/auth/confirm-password", headers=H,
                          json={"password": creds["password"]}, timeout=30)
        assert r.status_code == 200, r.text[:300]
        ct = r.json()["confirm_token"]
        hdrs = dict(H)
        hdrs["X-Password-Confirm"] = ct
        r = requests.post(f"{API}/withdrawals", headers=hdrs, json={"amount": 1000000000}, timeout=60)
        assert r.status_code < 500, f"{r.status_code}: {r.text[:400]}"
        assert r.status_code in (400, 403), f"unexpected {r.status_code}: {r.text[:400]}"


# ── module: soleaspay_payouts unique index ─────────────────────────────
def test_soleaspay_payouts_unique_index(db):
    idx = db.soleaspay_payouts.index_information()
    uniques = [v for v in idx.values() if v.get("unique") and [k for k, _ in v["key"]] == ["wd_id"]]
    assert uniques, f"no unique index on wd_id: {idx}"


# ── indexes / db sanity for the payout unique constraint ───────────────
def test_index_blocks_duplicate_wd_id(db):
    wd_id = f"TEST_DUP_{uuid.uuid4().hex[:8]}"
    db.soleaspay_payouts.insert_one({"wd_id": wd_id, "status": "created"})
    try:
        from pymongo.errors import DuplicateKeyError
        with pytest.raises(DuplicateKeyError):
            db.soleaspay_payouts.insert_one({"wd_id": wd_id, "status": "created"})
    finally:
        db.soleaspay_payouts.delete_many({"wd_id": wd_id})
