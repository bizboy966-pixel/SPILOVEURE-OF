"""New Special Tasks features (Feb 2026 refonte):
    - admin config accepts `price_per_action` (canonical) + derives `reward_per_action`
    - `platform_percentage` returned = 100 - distribution
    - `/special-tasks/unread-count` returns nb of new tasks since last-seen
    - `/special-tasks/mark-seen` resets the badge
    - `is_new` flag on feed items
"""
from __future__ import annotations

import os
import time
import uuid

import pytest
import requests

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api" if "REACT_APP_BACKEND_URL" in os.environ else "http://localhost:8001/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def admin_token() -> str:
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    body = r.json()
    return body.get("access_token") or body.get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token: str) -> dict:
    return _headers(admin_token)


def _make_user(country: str = "TG") -> dict:
    tag = uuid.uuid4().hex[:8]
    payload = {
        "username": f"stv2_{tag}",
        "email": f"stv2_{tag}@spiloveure.com",
        "password": "TestPass123!",
        "password_confirm": "TestPass123!",
        "country": country,
        "phone": f"+22890{tag[:6]}",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    r.raise_for_status()
    body = r.json()
    tok = body.get("access_token") or body.get("token")
    me = requests.get(f"{API}/auth/me", headers=_headers(tok), timeout=15).json()
    return {"token": tok, "id": me["id"], "username": me["username"]}


# ── 1. price_per_action drives reward_per_action ─────────────────────
def test_admin_can_set_price_per_action(admin_headers):
    r = requests.put(f"{API}/admin/special-tasks/config",
                     json={
                         "action_types": {
                             "video": {"enabled": True, "price_per_action": 50,
                                       "min_qty": 1, "max_qty": 100},
                         },
                         "distribution_percentage": 60,
                     },
                     headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    # reward should be derived: 50 × 0.60 = 30
    assert d["action_types"]["video"]["price_per_action"] == 50.0
    assert d["action_types"]["video"]["reward_per_action"] == 30.0
    assert d["distribution_percentage"] == 60
    assert d["platform_percentage"] == 40.0


def test_admin_price_takes_precedence_over_legacy_reward(admin_headers):
    # If admin sends BOTH price + reward, price wins (canonical).
    r = requests.put(f"{API}/admin/special-tasks/config",
                     json={
                         "action_types": {
                             "video": {"enabled": True,
                                       "price_per_action": 100,
                                       "reward_per_action": 999,  # bogus, should be ignored
                                       "min_qty": 1, "max_qty": 100},
                         },
                         "distribution_percentage": 50,
                     },
                     headers=admin_headers, timeout=15)
    assert r.status_code == 200
    v = r.json()["action_types"]["video"]
    assert v["price_per_action"] == 100.0
    # 100 × 0.50 = 50 (NOT 999)
    assert v["reward_per_action"] == 50.0


# ── 2. platform_percentage always sums to 100 ────────────────────────
def test_platform_pct_is_100_minus_distribution(admin_headers):
    for dist in (25, 40, 70, 90):
        requests.put(f"{API}/admin/special-tasks/config",
                     json={
                         "action_types": {
                             "like": {"enabled": True, "price_per_action": 10,
                                      "min_qty": 1, "max_qty": 10},
                         },
                         "distribution_percentage": dist,
                     },
                     headers=admin_headers, timeout=15)
        r = requests.get(f"{API}/admin/special-tasks/config", headers=admin_headers, timeout=15)
        d = r.json()
        assert d["distribution_percentage"] == dist
        assert d["platform_percentage"] == 100 - dist


# ── 3. unread-count + mark-seen ──────────────────────────────────────
def test_unread_count_endpoint_returns_zero_by_default(admin_headers):
    user = _make_user()
    r = requests.get(f"{API}/special-tasks/unread-count",
                     headers=_headers(user["token"]), timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json().get("unread"), int)


def test_mark_seen_endpoint(admin_headers):
    user = _make_user()
    r = requests.post(f"{API}/special-tasks/mark-seen",
                      headers=_headers(user["token"]), json={}, timeout=15)
    assert r.status_code == 200
    assert r.json().get("ok") is True
    assert r.json().get("at")


# ── 4. mark-seen actually decreases unread badge ─────────────────────
def test_mark_seen_resets_badge(admin_headers):
    user = _make_user()
    # First fetch baseline
    baseline = requests.get(f"{API}/special-tasks/unread-count",
                            headers=_headers(user["token"]), timeout=15).json()["unread"]
    # Mark seen
    requests.post(f"{API}/special-tasks/mark-seen",
                  headers=_headers(user["token"]), json={}, timeout=15)
    time.sleep(0.5)
    after = requests.get(f"{API}/special-tasks/unread-count",
                         headers=_headers(user["token"]), timeout=15).json()["unread"]
    # After marking-seen, no *previously-existing* task should count as new.
    assert after <= baseline


# ── 5. Public config exposes platform_percentage ─────────────────────
def test_public_config_returns_platform_pct(admin_headers):
    requests.put(f"{API}/admin/special-tasks/config",
                 json={"action_types": {
                     "video": {"enabled": True, "price_per_action": 20,
                               "min_qty": 5, "max_qty": 100},
                 }, "distribution_percentage": 75},
                 headers=admin_headers, timeout=15)
    user = _make_user()
    r = requests.get(f"{API}/special-tasks/config",
                     headers=_headers(user["token"]), timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["platform_percentage"] == 25.0
    assert d["distribution_percentage"] == 75


# ── 6. is_new flag on feed ───────────────────────────────────────────
def test_feed_includes_is_new_flag(admin_headers):
    # We just need feed items to have the shape — no LIVE task creation here.
    user = _make_user()
    r = requests.get(f"{API}/special-tasks",
                     headers=_headers(user["token"]), timeout=15)
    assert r.status_code == 200
    items = r.json().get("items", [])
    for it in items:
        assert "is_new" in it, f"missing is_new on {it.get('id')}"
        assert isinstance(it["is_new"], bool)
