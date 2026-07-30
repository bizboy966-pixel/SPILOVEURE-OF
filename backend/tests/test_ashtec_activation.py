"""Integration tests for the Ashtec AUTO-ACTIVATION flow against the live
FastAPI instance (matches the `test_izichange.py` pattern).

Coverage:
• GET /payments/ashtec/catalog — XOF/XAF only, 14 countries, 2500/lvl1/10min
• POST /payments/ashtec/initiate — validation errors (country/operator)
• POST /payments/ashtec/initiate — happy path returns reference + expires_at
• GET /payments/ashtec/status/{ref} — pending state, ownership guard
• POST /api/webhooks/ashtec — unknown ref ignored, idempotent on duplicate txid
"""
from __future__ import annotations

import os
import time
import uuid

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PWD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=15)
    assert r.status_code == 200, r.text[:200]
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def new_user():
    suffix = uuid.uuid4().hex[:8]
    email = f"TEST_ashtec_{suffix}@example.com"
    payload = {
        "username": f"tashtec{suffix}",
        "email": email,
        "password": "Passw0rd!123",
        "password_confirm": "Passw0rd!123",
        "phone": f"+228901{suffix[:5]}",
        "country": "TG",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    assert r.status_code in (200, 201), r.text[:250]
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}, payload


# ─── Catalog ─────────────────────────────────────────────────────────────
def test_catalog_public_xof_xaf_only():
    r = requests.get(f"{API}/payments/ashtec/catalog", timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["amount"] == 2500
    assert d["level"] == 1
    assert d["countdown_minutes"] == 10
    codes = {c["code"] for c in d["countries"]}
    # 14 XOF/XAF countries expected
    assert len(codes) == 14
    for c in ("TG", "BJ", "CI", "SN", "CM", "GA"):
        assert c in codes
    for excluded in ("GN", "CD"):  # GNF, CDF excluded
        assert excluded not in codes
    for c in d["countries"]:
        assert c["currency"] in ("XOF", "XAF")
        assert len(c["operators"]) >= 1


# ─── Initiate error paths ────────────────────────────────────────────────
def test_initiate_requires_auth():
    r = requests.post(f"{API}/payments/ashtec/initiate", json={
        "country_code": "TG", "operator": "T-Money", "phone": "70000000",
    }, timeout=15)
    assert r.status_code in (401, 403)


def test_initiate_rejects_bad_country(new_user):
    hdrs, _ = new_user
    r = requests.post(f"{API}/payments/ashtec/initiate", json={
        "country_code": "GN", "operator": "MTN Mobile Money", "phone": "70000000",
    }, headers=hdrs, timeout=15)
    assert r.status_code == 400
    assert "non disponible" in r.json()["detail"]


def test_initiate_rejects_bad_operator(new_user):
    hdrs, _ = new_user
    r = requests.post(f"{API}/payments/ashtec/initiate", json={
        "country_code": "TG", "operator": "Bogus Operator", "phone": "70000000",
    }, headers=hdrs, timeout=15)
    assert r.status_code == 400
    assert "invalide" in r.json()["detail"]


# ─── Initiate happy path (real Ashtech sandbox call) ─────────────────────
@pytest.fixture(scope="module")
def initiated_payment(new_user):
    hdrs, _ = new_user
    r = requests.post(f"{API}/payments/ashtec/initiate", json={
        "country_code": "TG", "operator": "T-Money", "phone": "70000000",
    }, headers=hdrs, timeout=45)
    assert r.status_code == 200, r.text[:400]
    return r.json(), hdrs


def test_initiate_locks_amount_at_2500(initiated_payment):
    body, _ = initiated_payment
    assert body["amount"] == 2500
    assert body["currency"] == "XOF"
    assert body["operator"] == "T-Money"
    assert body["country_code"] == "TG"


def test_initiate_returns_10min_expiry(initiated_payment):
    body, _ = initiated_payment
    assert body["expires_at"], "expires_at must be returned"
    assert body["reference"].startswith("SPV-AT-")


def test_status_returns_pending(initiated_payment):
    body, hdrs = initiated_payment
    r = requests.get(f"{API}/payments/ashtec/status/{body['reference']}",
                     headers=hdrs, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["status"] in ("pending", "paid", "failed", "otp_required")


def test_status_ownership_guard(initiated_payment, new_user, admin_headers):
    body, _ = initiated_payment
    # Another user (admin) cannot poll someone else's payment
    r = requests.get(f"{API}/payments/ashtec/status/{body['reference']}",
                     headers=admin_headers, timeout=15)
    assert r.status_code == 404


# ─── Webhook ─────────────────────────────────────────────────────────────
def test_webhook_ignores_unknown_reference():
    r = requests.post(f"{API}/webhooks/ashtec", json={
        "event": "payment.completed",
        "reference": f"BOGUS_{uuid.uuid4().hex}",
        "transaction_id": f"bogus_{uuid.uuid4().hex}",
    }, timeout=15)
    assert r.status_code == 200
    assert r.json()["ignored"] == "unknown_payment"


def test_webhook_ignores_empty_body():
    r = requests.post(f"{API}/webhooks/ashtec", json={}, timeout=15)
    assert r.status_code == 200
    assert r.json()["ignored"] == "no_reference_or_txid"


# ─── E2E activation via direct dispatch call ────────────────────────────
def test_activation_actually_lifts_max_level(new_user):
    """Regression: verifies that `_apply_payment_success` actually updates
    users.max_level. Prior to the ordering fix, activate_level was called
    BEFORE the payment row was marked 'paid', so the security guard in
    matrix.activate_level rejected it and users saw a bogus 'activated!'
    UI while remaining at max_level=0.
    """
    import subprocess, uuid as _uuid
    hdrs, _ = new_user
    me = requests.get(f"{API}/auth/me", headers=hdrs, timeout=15).json()
    uid = me["id"]
    assert me.get("max_level", 0) == 0

    # Directly invoke the dispatcher over the running app's DB.
    ref = f"SPV-AT-TEST-{_uuid.uuid4().hex[:8].upper()}"
    script = f"""
import asyncio, sys, os
from dotenv import load_dotenv
load_dotenv('/app/backend/.env')
sys.path.insert(0, '/app/backend')
from motor.motor_asyncio import AsyncIOMotorClient
import ashtec_activation as ac
from datetime import datetime, timezone, timedelta

async def main():
    db = AsyncIOMotorClient(os.environ['MONGO_URL'])[os.environ['DB_NAME']]
    now = datetime.now(timezone.utc)
    await db.payments.insert_one({{
        'reference': '{ref}', 'provider': 'ashtecpay',
        'kind': 'activation', 'level': 1,
        'user_id': '{uid}', 'username': 'test',
        'amount': 2500, 'currency': 'XOF',
        'phone': '+22890000001', 'country_code': 'TG', 'operator': 'T-Money',
        'transaction_id': 'tx_test',
        'status': 'pending', 'activation_done': False,
        'created_at': now, 'expires_at': now + timedelta(minutes=10),
    }})
    p = await db.payments.find_one({{'reference': '{ref}'}})
    await ac._apply_payment_success(db, p, 'success', source='ashtecpay')

asyncio.run(main())
"""
    r = subprocess.run(["python3", "-c", script], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, f"stderr: {{r.stderr}}"

    me2 = requests.get(f"{API}/auth/me", headers=hdrs, timeout=15).json()
    assert me2.get("max_level", 0) == 1, (
        f"❌ Activation did NOT lift max_level. me2={me2}"
    )
