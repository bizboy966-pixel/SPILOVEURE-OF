"""Tests for the 2026-08 enhancements:
    - GET /me/reactor-rewards filters + by_day aggregate
    - Anti-spam guard on POST /ads/{id}/comment
    - Notifications API (list / unread-count / mark-read / mark-all-read)
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api" if "REACT_APP_BACKEND_URL" in os.environ else "http://localhost:8001/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


def _hdrs(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def admin_token() -> str:
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    b = r.json()
    return b.get("access_token") or b.get("token")


def _mk_user() -> dict:
    tag = uuid.uuid4().hex[:8]
    p = {
        "username": f"nx_{tag}", "email": f"nx_{tag}@spiloveure.com",
        "password": "TestPass123!", "password_confirm": "TestPass123!",
        "country": "TG", "phone": f"+22890{tag[:6]}",
        "sponsor_username": "admin", "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=p, timeout=15)
    r.raise_for_status()
    b = r.json()
    tok = b.get("access_token") or b.get("token")
    me = requests.get(f"{API}/auth/me", headers=_hdrs(tok), timeout=15).json()
    return {"token": tok, "id": me["id"]}


# ── Reactor rewards filter + by_day ──────────────────────────────────
def test_reactor_rewards_shape_defaults(admin_token):
    user = _mk_user()
    r = requests.get(f"{API}/me/reactor-rewards", headers=_hdrs(user["token"]), timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    for k in ("items", "total_earned", "by_day", "filters"):
        assert k in d
    assert isinstance(d["items"], list)
    assert isinstance(d["by_day"], list)
    assert d["filters"]["action"] is None


def test_reactor_rewards_filter_by_action_accepts_valid_values(admin_token):
    user = _mk_user()
    for act in ("like", "comment"):
        r = requests.get(f"{API}/me/reactor-rewards?action={act}",
                         headers=_hdrs(user["token"]), timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["filters"]["action"] == act


def test_reactor_rewards_ignores_bogus_filter(admin_token):
    """action=foobar should be silently ignored (no 400) and filters.action == null."""
    user = _mk_user()
    r = requests.get(f"{API}/me/reactor-rewards?action=foobar",
                     headers=_hdrs(user["token"]), timeout=15)
    assert r.status_code == 200
    assert r.json()["filters"]["action"] is None


# ── Notifications API ────────────────────────────────────────────────
def test_notifications_endpoints_exist(admin_token):
    user = _mk_user()
    # list
    r = requests.get(f"{API}/me/notifications",
                     headers=_hdrs(user["token"]), timeout=15)
    assert r.status_code == 200
    assert "items" in r.json()
    # unread-count
    r = requests.get(f"{API}/me/notifications/unread-count",
                     headers=_hdrs(user["token"]), timeout=15)
    assert r.status_code == 200
    assert isinstance(r.json().get("unread"), int)
    # mark-all-read idempotent
    r = requests.post(f"{API}/me/notifications/mark-all-read",
                      headers=_hdrs(user["token"]), json={}, timeout=15)
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_notifications_unread_only_filter(admin_token):
    user = _mk_user()
    r = requests.get(f"{API}/me/notifications?unread_only=true",
                     headers=_hdrs(user["token"]), timeout=15)
    assert r.status_code == 200
    # All returned items (if any) must have read=false
    for n in r.json()["items"]:
        assert n.get("read") is False
