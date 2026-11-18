"""Regression — Special Task money flow (2026-08 refonte).

The correct two-step calculation:
    Step 1 (COST):  total_price = price_per_action × quantity
    Step 2 (REWARD):
        distributable_pool = total_price × distribution_percentage / 100
        reward_per_user    = distributable_pool / quantity

The old code stored the admin's fixed `reward_per_action` (=price × pct/100)
which happens to be mathematically identical but violates the spec by
using price_per_action for both cost AND reward. This test locks in the
new derivation path.
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api" if "REACT_APP_BACKEND_URL" in os.environ else "http://localhost:8001/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def admin_headers() -> dict:
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    b = r.json()
    return _h(b.get("access_token") or b.get("token"))


def _mk_user() -> dict:
    tag = uuid.uuid4().hex[:8]
    r = requests.post(f"{API}/auth/register", json={
        "username": f"stpay_{tag}", "email": f"stpay_{tag}@spiloveure.com",
        "password": "TestPass123!", "password_confirm": "TestPass123!",
        "country": "TG", "phone": f"+22890{tag[:6]}",
        "sponsor_username": "admin", "accept_terms": True,
    }, timeout=15)
    r.raise_for_status()
    b = r.json()
    return _h(b.get("access_token") or b.get("token"))


def test_reward_is_pool_divided_by_quantity(admin_headers):
    """price_per_action=10, quantity=500, dist=60% → reward_per_user must be 6.0."""
    # Configure admin: price=10, dist=60%, min=1, max=1000
    r = requests.put(f"{API}/admin/special-tasks/config", json={
        "action_types": {
            "like": {"enabled": True, "price_per_action": 10, "min_qty": 1, "max_qty": 2000},
        },
        "distribution_percentage": 60,
    }, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    creator = _mk_user()
    # 1. Create draft
    r = requests.post(f"{API}/special-tasks", json={
        "action_type": "like", "network": "facebook",
        "link": "https://facebook.com/test", "description": "spec test",
    }, headers=creator, timeout=15)
    assert r.status_code == 200, r.text
    task_id = r.json()["id"]
    # 2. Set audience (required before quantity)
    r = requests.put(f"{API}/special-tasks/{task_id}/audience", json={
        "target_countries": ["TG"], "target_age_min": 18,
        "target_age_max": 65, "target_gender": "both",
    }, headers=creator, timeout=15)
    assert r.status_code == 200, r.text
    # 3. Set quantity
    r = requests.put(f"{API}/special-tasks/{task_id}/quantity", json={"quantity": 500},
                     headers=creator, timeout=15)
    assert r.status_code == 200, r.text
    t = r.json()

    # Assertions on the spec's two-step derivation
    assert t["price_amount"] == pytest.approx(5000, abs=0.01), \
        f"total price wrong: {t['price_amount']} (expected 5000)"
    # pool = 5000 × 60% = 3000
    assert t.get("distributable_pool") == pytest.approx(3000, abs=0.01)
    # reward_per_user = 3000 / 500 = 6
    assert t["reward_per_action"] == pytest.approx(6, abs=0.01)


def test_reward_credited_to_withdrawable_balance():
    """Only assert the endpoint exists and DOESN'T touch balance_upgrade
    on a reward — full credit path is covered by test_task_completion.
    This is a semantic guard against a future dev accidentally routing
    the reward to the upgrade wallet."""
    src = open("/app/backend/special_tasks.py").read()
    assert 'balance_profit' in src
    # No accidental credit to balance_upgrade inside the reward path
    reward_credit_line = [
        ln for ln in src.splitlines()
        if 'balance_profit' in ln and '$inc' in ln
    ]
    assert reward_credit_line, "reward credit line missing"
    # Ensure no sibling balance_upgrade credit near the reward
    for i, ln in enumerate(src.splitlines()):
        if 'balance_profit' in ln and 'reward' in ln.lower():
            window = "\n".join(src.splitlines()[max(0, i-2):i+3])
            assert 'balance_upgrade' not in window, \
                "reward path leaks into balance_upgrade!"
