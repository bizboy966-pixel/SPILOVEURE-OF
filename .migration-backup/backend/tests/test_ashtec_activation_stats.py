"""Regression tests — admin dashboard `total_activations_amount` must
include validated AshtecPay payments alongside legacy SoleasPay records.

Pre-fix, `db.payments` was queried with `provider:"soleaspay"` only, so
every AshtecPay activation (which is now the primary automatic gateway)
was silently excluded from the dashboard total.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api" if "REACT_APP_BACKEND_URL" in os.environ else "http://localhost:8001/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "spilivere")


@pytest.fixture()
def admin_headers():
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    b = r.json()
    tok = b.get("access_token") or b.get("token")
    return {"Authorization": f"Bearer {tok}"}


def _stats(hdr):
    return requests.get(f"{API}/admin/stats", headers=hdr, timeout=15).json()


async def _seed_payment(provider: str, amount: float, activation_done: bool = True) -> str:
    client = AsyncIOMotorClient(MONGO_URL); db = client[DB_NAME]
    ref = f"{provider.upper()}-STATS-TEST-{uuid.uuid4().hex[:6]}"
    await db.payments.insert_one({
        "reference": ref, "provider": provider, "kind": "activation",
        "user_id": "seed-user", "username": "seed", "level": 1,
        "amount": amount, "currency": "XOF",
        "phone": "+22890000001", "country_code": "TG",
        "operator": "Flooz (Moov)",
        "status": "paid", "activation_done": activation_done,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })
    client.close()
    return ref


async def _cleanup(ref: str):
    client = AsyncIOMotorClient(MONGO_URL); db = client[DB_NAME]
    await db.payments.delete_many({"reference": ref})
    client.close()


@pytest.mark.asyncio
async def test_ashtec_validated_activation_hits_total(admin_headers):
    before = float(_stats(admin_headers).get("total_activations_amount") or 0)
    ref = await _seed_payment("ashtecpay", 2500)
    try:
        after = float(_stats(admin_headers).get("total_activations_amount") or 0)
        assert after - before == pytest.approx(2500, abs=1), \
            f"AshtecPay validated activation not counted: delta={after - before}"
    finally:
        await _cleanup(ref)


@pytest.mark.asyncio
async def test_ashtec_pending_activation_not_counted(admin_headers):
    """Only activation_done=True must contribute."""
    before = float(_stats(admin_headers).get("total_activations_amount") or 0)
    ref = await _seed_payment("ashtecpay", 2500, activation_done=False)
    try:
        after = float(_stats(admin_headers).get("total_activations_amount") or 0)
        assert after - before == pytest.approx(0, abs=1), \
            f"Pending AshtecPay wrongly counted: delta={after - before}"
    finally:
        await _cleanup(ref)


@pytest.mark.asyncio
async def test_soleas_validated_activation_still_counted(admin_headers):
    """Regression — SoleasPay path must keep working."""
    before = float(_stats(admin_headers).get("total_activations_amount") or 0)
    ref = await _seed_payment("soleaspay", 2500)
    try:
        after = float(_stats(admin_headers).get("total_activations_amount") or 0)
        assert after - before == pytest.approx(2500, abs=1)
    finally:
        await _cleanup(ref)
