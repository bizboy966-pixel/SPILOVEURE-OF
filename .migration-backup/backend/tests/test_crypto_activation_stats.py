"""Regression test — Ensure the admin dashboard `total_activations_amount`
stat converts USDT crypto activations to their FCFA equivalent
(1 USDT = 500 FCFA → 5 USDT = 2 500 FCFA).

Prior to the 2026-08 fix, `SUM($amount)` was applied unconditionally so a
5 USDT activation contributed 5 to the FCFA total instead of 2 500.
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
USDT_TO_FCFA = 500  # canonical business rate


@pytest.fixture()
def admin_headers():
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    b = r.json()
    tok = b.get("access_token") or b.get("token")
    return {"Authorization": f"Bearer {tok}"}


@pytest.mark.asyncio
async def test_crypto_activation_counts_as_fcfa_in_stats(admin_headers):
    """A validated USDT activation of 5 must add 2 500 FCFA to the total."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    # Baseline
    baseline = requests.get(f"{API}/admin/stats", headers=admin_headers, timeout=15).json()
    before = float(baseline.get("total_activations_amount") or 0)

    # Seed a validated crypto activation
    ref = f"CRYPTO-STAT-TEST-{uuid.uuid4().hex[:6]}"
    await db.activations.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": "seed-crypto-user",
        "level": 1,
        "status": "validated",
        "payment_method": "crypto_auto",
        "reference": ref,
        "amount": 5,
        "currency": "USDT",
        "validated_at": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc),
    })

    try:
        after = float(
            requests.get(f"{API}/admin/stats", headers=admin_headers, timeout=15).json()
            .get("total_activations_amount") or 0
        )
        # Business rule: 5 USDT × 500 = 2 500 FCFA
        expected_delta = 5 * USDT_TO_FCFA
        assert after - before == pytest.approx(expected_delta, abs=1), (
            f"USDT activation not converted correctly: delta={after - before}, "
            f"expected {expected_delta}"
        )
    finally:
        await db.activations.delete_many({"reference": ref})
        client.close()


@pytest.mark.asyncio
async def test_fcfa_activation_unchanged(admin_headers):
    """Non-USDT activations must keep counting at face value (regression)."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    baseline = requests.get(f"{API}/admin/stats", headers=admin_headers, timeout=15).json()
    before = float(baseline.get("total_activations_amount") or 0)

    ref = f"FCFA-STAT-TEST-{uuid.uuid4().hex[:6]}"
    await db.activations.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": "seed-fcfa-user",
        "level": 1,
        "status": "validated",
        "payment_method": "manual",
        "reference": ref,
        "amount": 2500,
        "currency": "FCFA",
        "validated_at": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc),
    })
    try:
        after = float(
            requests.get(f"{API}/admin/stats", headers=admin_headers, timeout=15).json()
            .get("total_activations_amount") or 0
        )
        assert after - before == pytest.approx(2500, abs=1)
    finally:
        await db.activations.delete_many({"reference": ref})
        client.close()
