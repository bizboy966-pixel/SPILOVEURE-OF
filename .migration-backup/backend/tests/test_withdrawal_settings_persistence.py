"""Regression: withdrawal settings (fees + days + hours) must round-trip.

Bug context: admin reported that changing allowed_days / open_time / close_time
in the Admin → Payments → Retraits form did not "save". The root cause was on
the frontend (the load function only hydrated the fee fields), but we also
had duplicated route definitions in server.py that made the codebase fragile.

This test guards the backend contract: the payload the admin form sends must
be persisted verbatim and returned by the follow-up GET.
"""
from __future__ import annotations

import os
import pytest
import httpx


API_URL = os.environ.get("REACT_APP_BACKEND_URL") \
    or "http://localhost:8001"
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


async def _login(client: httpx.AsyncClient) -> str:
    r = await client.post(
        f"{API_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    r.raise_for_status()
    body = r.json()
    return body.get("token") or body["access_token"]


@pytest.mark.asyncio
async def test_withdrawal_settings_persist_days_and_hours():
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        headers = {"Authorization": f"Bearer {token}"}

        # Snapshot current settings so we can restore them after the test.
        r = await client.get(
            f"{API_URL}/api/admin/settings/withdrawal", headers=headers,
        )
        r.raise_for_status()
        original = r.json()
        original.pop("updated_at", None)
        original.pop("updated_by", None)

        # Apply a custom window.
        payload = {
            "enabled": True,
            "fee_percent": 7,
            "fee_flat": 250,
            "min_amount": 1500,
            "max_amount": 75000,
            "allowed_days": [1, 3, 5],  # Tue, Thu, Sat
            "open_time": "08:30",
            "close_time": "18:45",
        }
        r = await client.put(
            f"{API_URL}/api/admin/settings/withdrawal",
            headers=headers, json=payload,
        )
        r.raise_for_status()
        saved = r.json()["settings"]

        # Fetch it back and make sure Mongo persisted every field.
        r = await client.get(
            f"{API_URL}/api/admin/settings/withdrawal", headers=headers,
        )
        r.raise_for_status()
        got = r.json()

        assert got["fee_percent"] == 7
        assert got["fee_flat"] == 250
        assert got["min_amount"] == 1500
        assert got["max_amount"] == 75000
        assert got["allowed_days"] == [1, 3, 5]
        assert got["open_time"] == "08:30"
        assert got["close_time"] == "18:45"
        assert got["enabled"] is True
        assert saved["allowed_days"] == [1, 3, 5]

        # Restore.
        await client.put(
            f"{API_URL}/api/admin/settings/withdrawal",
            headers=headers,
            json={
                "enabled": bool(original.get("enabled", True)),
                "fee_percent": float(original.get("fee_percent", 0)),
                "fee_flat": float(original.get("fee_flat", 0)),
                "min_amount": float(original.get("min_amount", 0)),
                "max_amount": original.get("max_amount"),
                "allowed_days": original.get("allowed_days", [0, 1, 2, 3, 4, 5, 6]),
                "open_time": original.get("open_time", "00:00"),
                "close_time": original.get("close_time", "23:59"),
            },
        )


@pytest.mark.asyncio
async def test_admin_activations_include_crypto_auto_enrichment():
    """Crypto auto activations must expose email + easychange_transaction_id
    so support can trace stuck payments on the EasyChange dashboard.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        headers = {"Authorization": f"Bearer {token}"}

        r = await client.get(
            f"{API_URL}/api/admin/activations", headers=headers,
        )
        r.raise_for_status()
        items = r.json()
        crypto_auto = [
            i for i in items if i.get("payment_method") == "crypto_auto"
        ]
        # The DB may have zero crypto_auto rows in a fresh env — skip in that case.
        if not crypto_auto:
            pytest.skip("No crypto_auto activations in DB")

        with_txid = [c for c in crypto_auto if c.get("easychange_transaction_id")]
        with_email = [c for c in crypto_auto if c.get("email")]
        # At least one crypto_auto activation must carry both fields once
        # enrichment kicks in (older rows without payment intent are OK).
        assert with_txid, "no crypto_auto activation exposes easychange_transaction_id"
        assert with_email, "no crypto_auto activation exposes email"
