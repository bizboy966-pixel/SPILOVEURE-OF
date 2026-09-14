"""Regression v19 (2026-02-14) — admin credit reflects on total_profit.

The user reported that admin `credit_wallet` actions were silently ignored
by the Profit Total card (only commission_direct + commission_spillover
counted). v19 introduces `admin_credit_total` which is incremented on
every admin credit AND included in `total_profit`. This test verifies
that behaviour end-to-end via the public API.
"""
from __future__ import annotations
import os
import requests

API = (
    os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"
    if "REACT_APP_BACKEND_URL" in os.environ
    else "http://localhost:8001/api"
)
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


def _login(creds: dict) -> str:
    r = requests.post(f"{API}/auth/login", json=creds, timeout=15)
    r.raise_for_status()
    return r.json().get("access_token") or r.json().get("token")


def test_admin_credit_wallet_updates_total_profit():
    admin_token = _login(ADMIN)
    hdr = {"Authorization": f"Bearer {admin_token}"}

    # Baseline: read admin's own dashboard (admin is his own target).
    d0 = requests.get(f"{API}/dashboard", headers=hdr, timeout=15).json()
    baseline_total = float(d0.get("total_profit", 0))

    # Admin credits himself 500 FCFA on the profit bucket.
    payload = {"action": "credit_wallet", "amount": 500, "bucket": "profit"}
    me = requests.get(f"{API}/auth/me", headers=hdr, timeout=15).json()
    admin_user_id = me["id"]
    r = requests.post(
        f"{API}/admin/users/{admin_user_id}/action",
        json=payload,
        headers=hdr,
        timeout=15,
    )
    assert r.status_code == 200, r.text

    # New dashboard: total_profit must have gone up by 500.
    d1 = requests.get(f"{API}/dashboard", headers=hdr, timeout=15).json()
    new_total = float(d1.get("total_profit", 0))
    assert new_total - baseline_total == 500, (
        f"total_profit must include admin credit: baseline={baseline_total} new={new_total}"
    )
    assert d1.get("admin_credit_total", 0) >= 500

    # Cleanup: debit it back so the test is idempotent.
    requests.post(
        f"{API}/admin/users/{admin_user_id}/action",
        json={"action": "debit_wallet", "amount": 500, "bucket": "profit"},
        headers=hdr,
        timeout=15,
    )
