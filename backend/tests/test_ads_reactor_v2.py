"""New Ads Reactor Rewards features (2026-08 refonte):
    - distribution_percentage + platform_percentage (=100-dist) exposed
    - per-action rewards: like_reward, comment_reward
    - per-campaign caps: max_likes, max_comments
    - Only like + comment are rewarded (view/share no longer credit)
    - One reward per (user, action, ad)
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


@pytest.fixture(scope="module")
def admin_headers(admin_token: str) -> dict:
    return _hdrs(admin_token)


def _mk_user() -> dict:
    tag = uuid.uuid4().hex[:8]
    p = {
        "username": f"adsv2_{tag}", "email": f"adsv2_{tag}@spiloveure.com",
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


# ── 1. New fields present + platform_percentage auto-computed ─────
def test_new_fields_persisted_and_returned(admin_headers):
    r = requests.put(f"{API}/admin/ads-reactor-config", json={
        "distribution_percentage": 70,
        "like_reward": 25, "comment_reward": 50,
        "max_likes": 100, "max_comments": 50,
    }, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["distribution_percentage"] == 70.0
    assert d["platform_percentage"] == 30.0
    assert d["like_reward"] == 25.0
    assert d["comment_reward"] == 50.0
    assert d["max_likes"] == 100
    assert d["max_comments"] == 50
    # Legacy fields still returned for backward compat
    assert d["share_percentage"] == 70.0


def test_platform_pct_always_sums_to_100(admin_headers):
    for dist in (10, 25, 60, 90):
        requests.put(f"{API}/admin/ads-reactor-config",
                     json={"distribution_percentage": dist,
                           "like_reward": 5, "comment_reward": 10,
                           "max_likes": 10, "max_comments": 10},
                     headers=admin_headers, timeout=15)
        r = requests.get(f"{API}/admin/ads-reactor-config",
                         headers=admin_headers, timeout=15)
        d = r.json()
        assert d["distribution_percentage"] == dist
        assert d["platform_percentage"] == 100 - dist


# ── 2. Legacy alias still works ───────────────────────────────────
def test_legacy_share_percentage_aliases_to_distribution(admin_headers):
    r = requests.put(f"{API}/admin/ads-reactor-config", json={
        "share_percentage": 45,   # legacy field
        "min_reward": 20, "max_reward": 80,  # legacy fields
    }, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["distribution_percentage"] == 45.0
    assert d["platform_percentage"] == 55.0
    # Legacy min/max mapped to new like/comment (min→like, max→comment)
    assert d["like_reward"] == 20.0
    assert d["comment_reward"] == 80.0


# ── 3. Public config exposes new fields ───────────────────────────
def test_public_reactor_config_shape(admin_headers):
    requests.put(f"{API}/admin/ads-reactor-config", json={
        "distribution_percentage": 80,
        "like_reward": 15, "comment_reward": 30,
        "max_likes": 200, "max_comments": 100,
    }, headers=admin_headers, timeout=15)
    user = _mk_user()
    r = requests.get(f"{API}/ads-reactor-config",
                     headers=_hdrs(user["token"]), timeout=15)
    assert r.status_code == 200
    d = r.json()
    for k in ("distribution_percentage", "platform_percentage",
              "like_reward", "comment_reward",
              "max_likes", "max_comments"):
        assert k in d, f"missing {k} in public response"


# ── 4. Validation ─────────────────────────────────────────────────
def test_distribution_percentage_upper_bound(admin_headers):
    r = requests.put(f"{API}/admin/ads-reactor-config",
                     json={"distribution_percentage": 150,
                           "like_reward": 10, "comment_reward": 20,
                           "max_likes": 10, "max_comments": 10},
                     headers=admin_headers, timeout=15)
    assert r.status_code in (400, 422)


def test_max_likes_min_1(admin_headers):
    r = requests.put(f"{API}/admin/ads-reactor-config",
                     json={"distribution_percentage": 60,
                           "like_reward": 10, "comment_reward": 20,
                           "max_likes": 0, "max_comments": 5},
                     headers=admin_headers, timeout=15)
    assert r.status_code in (400, 422)


# ── 5. Feature flag not required for this test scope ──────────────
# Note: end-to-end credit test on a real ad requires a fully paid + admin-
# approved ad, which is covered by test_ashtec_ads_tasks.py. Here we only
# validate the admin-facing config surface.
