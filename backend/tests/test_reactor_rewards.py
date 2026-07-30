"""End-to-end tests for the reactor reward engine.

Flow: admin approves a published ad → user views/likes/shares/comments
→ each first-time action credits `balance_profit` from the ad's reactor pool.
"""
from __future__ import annotations
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PWD = "@Emma91972006"


def _register(prefix: str) -> tuple[dict, str]:
    """Register a fresh, activated user and return (auth headers, user_id)."""
    suffix = uuid.uuid4().hex[:8]
    email = f"TEST_rct_{prefix}_{suffix}@example.com"
    r = requests.post(f"{API}/auth/register", json={
        "username": f"rct{prefix}{suffix}",
        "email": email,
        "password": "Passw0rd!123",
        "password_confirm": "Passw0rd!123",
        "phone": f"+228901{suffix[:5]}",
        "country": "TG",
        "sponsor_username": "admin",
        "accept_terms": True,
    }, timeout=15)
    assert r.status_code in (200, 201), r.text[:250]
    body = r.json()
    tok = body["access_token"]
    uid = body["user"]["id"]
    return {"Authorization": f"Bearer {tok}"}, uid


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=15)
    tok = r.json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def reactor_cfg(admin_headers):
    """Force a predictable config for deterministic assertions."""
    r = requests.put(f"{API}/admin/ads-reactor-config",
                     headers=admin_headers,
                     json={"share_percentage": 50.0,
                           "min_reward": 10, "max_reward": 100},
                     timeout=15)
    assert r.status_code == 200
    return r.json()


@pytest.fixture(scope="module")
def enable_ads(admin_headers):
    for f in ("ads", "ads_create_poster", "ads_create_video"):
        requests.put(f"{API}/admin/feature-flags/{f}",
                     json={"enabled": True}, headers=admin_headers, timeout=15)
    requests.put(f"{API}/admin/ads/pricing",
                 json={"price_per_day": 500, "min_days": 1, "max_days": 30},
                 headers=admin_headers, timeout=15)
    return True


@pytest.fixture(scope="module")
def published_ad(enable_ads, admin_headers, reactor_cfg):
    """Create a draft ad, publish it, and force-approve as admin. Returns
    (ad_id, creator_headers, creator_id)."""
    creator_hdrs, creator_uid = _register("creator")
    # 1. draft
    r = requests.post(f"{API}/ads", headers=creator_hdrs, json={
        "media_type": "poster",
        "cover_image_url": "https://example.com/x.jpg",
        "description": "reactor test ad",
    }, timeout=15)
    assert r.status_code == 200, r.text[:300]
    ad_id = r.json()["id"]
    # 2. audience
    requests.put(f"{API}/ads/{ad_id}/audience", headers=creator_hdrs, json={
        "target_countries": ["TG"], "target_age_min": 18, "target_age_max": 60,
        "target_gender": "both",
    }, timeout=15)
    # 3. duration → price_amount = 500 × 3 = 1500 XOF, pool at 50% = 750
    r_dur = requests.put(f"{API}/ads/{ad_id}/duration", headers=creator_hdrs,
                        json={"duration_days": 3}, timeout=15)
    assert r_dur.status_code == 200, r_dur.text[:300]
    r_pub = requests.post(f"{API}/ads/{ad_id}/publish", headers=creator_hdrs, timeout=15)
    assert r_pub.status_code == 200, r_pub.text[:300]
    # 4. force to `published` via a manual DB flip through the admin approve
    # route. First fake payment confirmation, then approve.
    requests.post(f"{API}/ads/{ad_id}/confirm-payment", headers=creator_hdrs, timeout=15)
    r = requests.post(f"{API}/admin/ads/{ad_id}/approve",
                      headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text[:300]
    return ad_id, creator_hdrs, creator_uid


def _balance(headers: dict) -> float:
    r = requests.get(f"{API}/auth/me", headers=headers, timeout=15)
    assert r.status_code == 200
    return float(r.json().get("balance_profit") or 0)


# ─── Tests ────────────────────────────────────────────────────────────
def test_first_view_credits_reactor(published_ad, reactor_cfg):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("v")
    before = _balance(hdrs)
    r = requests.post(f"{API}/ads/{ad_id}/view", headers=hdrs, timeout=15)
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert body["counted"] is True
    assert body["reward"] is not None and body["reward"] > 0
    after = _balance(hdrs)
    assert round(after - before, 2) == round(body["reward"], 2)


def test_view_is_idempotent_no_double_credit(published_ad):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("v2")
    r1 = requests.post(f"{API}/ads/{ad_id}/view", headers=hdrs, timeout=15)
    assert r1.json()["reward"] is not None
    bal1 = _balance(hdrs)
    # Second call — no double credit
    r2 = requests.post(f"{API}/ads/{ad_id}/view", headers=hdrs, timeout=15)
    assert r2.json().get("counted") is False
    assert r2.json().get("reward") is None
    assert _balance(hdrs) == bal1


def test_comment_pays_more_than_view(published_ad, reactor_cfg):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("c")
    v = requests.post(f"{API}/ads/{ad_id}/view", headers=hdrs, timeout=15).json()["reward"]
    c = requests.post(f"{API}/ads/{ad_id}/comment", headers=hdrs,
                      json={"text": "nice ad!"}, timeout=15).json()["reward"]
    assert c > v, f"comment ({c}) should pay more than view ({v})"


def test_creator_cannot_self_reward(published_ad):
    ad_id, creator_hdrs, _ = published_ad
    r = requests.post(f"{API}/ads/{ad_id}/like", headers=creator_hdrs, timeout=15)
    assert r.status_code == 200
    assert r.json().get("reward") is None


def test_share_credits_and_records_reward(published_ad):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("s")
    before = _balance(hdrs)
    r = requests.post(f"{API}/ads/{ad_id}/share", headers=hdrs, timeout=15)
    assert r.status_code == 200
    reward = r.json()["reward"]
    assert reward is not None and reward > 0
    assert round(_balance(hdrs) - before, 2) == round(reward, 2)


def test_reactor_status_reports_pool_and_earned(published_ad):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("st")
    requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)
    r = requests.get(f"{API}/ads/{ad_id}/reactor-status", headers=hdrs, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["pool"] > 0
    assert d["you_earned"] > 0
    assert d["remaining"] < d["pool"]
    assert d["is_creator"] is False


def test_my_reactor_rewards_history(published_ad):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("h")
    requests.post(f"{API}/ads/{ad_id}/view", headers=hdrs, timeout=15)
    requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)
    r = requests.get(f"{API}/me/reactor-rewards", headers=hdrs, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["total_earned"] > 0
    # Two entries (view + like) minimum
    actions = {it["action"] for it in d["items"]}
    assert "view" in actions and "like" in actions


def test_unlike_does_not_reverse_reward(published_ad):
    ad_id, _, _ = published_ad
    hdrs, _ = _register("u")
    r1 = requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)
    reward = r1.json()["reward"]
    bal_after_like = _balance(hdrs)
    r2 = requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)  # unlike
    assert r2.json()["liked"] is False
    assert r2.json()["reward"] is None
    assert _balance(hdrs) == bal_after_like  # balance NOT reversed
    # Re-like — should NOT re-pay (idempotency table remembers)
    r3 = requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)
    assert r3.json()["reward"] is None
    assert _balance(hdrs) == bal_after_like


def test_reactor_feed_public_anonymised(published_ad):
    """Live feed of an ad's reactor rewards — usernames redacted."""
    ad_id, _, _ = published_ad
    # Generate at least one reward from a fresh user
    hdrs, _ = _register("feed")
    requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)
    # Query the feed
    r = requests.get(f"{API}/ads/{ad_id}/reactor-feed", headers=hdrs, timeout=15)
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) >= 1
    for it in items:
        assert "user_id" not in it       # scrubbed
        assert "•••" in it["username"]   # anonymised
        assert it["amount"] > 0
        assert it["action"] in ("view", "like", "share", "comment")


def test_notification_emitted_on_reward(published_ad):
    """Each reactor credit produces an in-app notification for the user."""
    ad_id, _, _ = published_ad
    hdrs, _ = _register("notif")
    r = requests.post(f"{API}/ads/{ad_id}/like", headers=hdrs, timeout=15)
    assert r.json()["reward"] is not None
    # Poll the notifications feed
    notifs = requests.get(f"{API}/notifications", headers=hdrs, timeout=15)
    if notifs.status_code == 200:  # endpoint exists
        found = any(
            n.get("kind") == "reactor_reward"
            for n in (notifs.json().get("items") or notifs.json() or [])
        )
        assert found, "reactor_reward notification not found"
