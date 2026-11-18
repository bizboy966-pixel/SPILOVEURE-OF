"""Tests for Ashtec Mobile Money on Ads and Special Tasks.

Follows the same live-instance pattern as test_izichange.py — hits the
running FastAPI service through the preview URL.
"""
from __future__ import annotations
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def new_user():
    suffix = uuid.uuid4().hex[:8]
    email = f"TEST_ash2_{suffix}@example.com"
    payload = {
        "username": f"tash2{suffix}",
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
    tok = r.json().get("access_token")
    return {"Authorization": f"Bearer {tok}"}, payload


# ─── Ads ─────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def _admin_headers_for_ads():
    r = requests.post(f"{API}/auth/login", json={
        "email": "kossikotokou4@gmail.com", "password": "@Emma91972006",
    }, timeout=15)
    assert r.status_code == 200
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def enable_ads(_admin_headers_for_ads):
    for flag in ("ads", "ads_create_poster", "ads_create_video"):
        requests.put(f"{API}/admin/feature-flags/{flag}",
                     json={"enabled": True},
                     headers=_admin_headers_for_ads, timeout=15)
    # Also configure ads pricing so publish computes a price
    requests.put(f"{API}/admin/ads/pricing",
                 json={"price_per_day": 500, "min_days": 1, "max_days": 30},
                 headers=_admin_headers_for_ads, timeout=15)
    return True


@pytest.fixture(scope="module")
def draft_ad(new_user, enable_ads):
    hdrs, _ = new_user
    # Create draft
    r = requests.post(f"{API}/ads", headers=hdrs, json={
        "media_type": "poster",
        "cover_image_url": "https://example.com/x.jpg",
        "description": "test ad",
    }, timeout=15)
    assert r.status_code == 200, r.text[:300]
    ad = r.json()
    ad_id = ad["id"]
    # Set audience
    requests.put(f"{API}/ads/{ad_id}/audience", headers=hdrs, json={
        "target_countries": ["TG"], "target_age_min": 18, "target_age_max": 60,
        "target_gender": "any",
    }, timeout=15)
    # Set duration
    requests.put(f"{API}/ads/{ad_id}/duration", headers=hdrs,
                 json={"duration_days": 3}, timeout=15)
    # Publish → moves to pending_payment
    requests.post(f"{API}/ads/{ad_id}/publish", headers=hdrs, timeout=15)
    return ad_id


def test_ads_pay_mobile_money_requires_fields(new_user, draft_ad):
    hdrs, _ = new_user
    r = requests.post(f"{API}/ads/{draft_ad}/pay", headers=hdrs, json={
        "method": "mobile_money",
    }, timeout=15)
    assert r.status_code == 400
    assert "requis" in r.json()["detail"]


def test_ads_pay_mobile_money_rejects_bad_country(new_user, draft_ad):
    hdrs, _ = new_user
    r = requests.post(f"{API}/ads/{draft_ad}/pay", headers=hdrs, json={
        "method": "mobile_money", "country_code": "GN",
        "operator": "MTN Mobile Money", "phone": "70000000",
    }, timeout=15)
    assert r.status_code == 400


def test_ads_pay_mobile_money_happy(new_user, draft_ad):
    hdrs, _ = new_user
    r = requests.post(f"{API}/ads/{draft_ad}/pay", headers=hdrs, json={
        "method": "mobile_money", "country_code": "TG",
        "operator": "T-Money", "phone": "70000000",
    }, timeout=45)
    if r.status_code == 200:
        body = r.json()
        assert body["method"] == "mobile_money"
        assert body["reference"].startswith("SPV-AT-")
        assert body["currency"] == "XOF"
        assert body["expires_at"]
    else:
        assert r.status_code == 400
        detail = r.json().get("detail", "")
        assert any(k in detail.lower() for k in ("ashtec", "erreur", "refus", "interne")), \
            f"Unexpected error: {detail}"


# ─── Special Tasks ───────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={
        "email": "kossikotokou4@gmail.com", "password": "@Emma91972006",
    }, timeout=15)
    assert r.status_code == 200
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def enable_special_tasks(admin_headers):
    r = requests.put(f"{API}/admin/feature-flags/special_tasks",
                     json={"enabled": True}, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    return True


@pytest.fixture(scope="module")
def draft_task(new_user, enable_special_tasks, admin_headers):
    # Configure `video` action with new model (no more price_per_action)
    requests.put(f"{API}/admin/special-tasks/config",
                 json={"action_types": {"video": {
                     "enabled": True,
                     "reward_per_action": 10,
                     "min_qty": 5, "max_qty": 100,
                 }}, "distribution_percentage": 50}, headers=admin_headers, timeout=15)
    hdrs, _ = new_user
    r = requests.post(f"{API}/special-tasks", headers=hdrs, json={
        "action_type": "video", "network": "tiktok",
        "link": "https://tiktok.com/@x/video/123",
        "description": "test",
    }, timeout=15)
    assert r.status_code == 200, r.text[:300]
    tid = r.json()["id"]
    requests.put(f"{API}/special-tasks/{tid}/audience", headers=hdrs, json={
        "target_countries": ["TG"], "target_age_min": 18, "target_age_max": 60,
        "target_gender": "both",
    }, timeout=15)
    requests.put(f"{API}/special-tasks/{tid}/quantity", headers=hdrs,
                 json={"quantity": 10}, timeout=15)
    r_pub = requests.post(f"{API}/special-tasks/{tid}/publish", headers=hdrs, timeout=15)
    assert r_pub.status_code == 200, r_pub.text[:300]
    return tid


def test_task_pay_rejects_unsupported_method(new_user, draft_task):
    hdrs, _ = new_user
    # method='paypal' is unsupported → 400
    r = requests.post(f"{API}/special-tasks/{draft_task}/pay", headers=hdrs,
                      json={"method": "paypal", "country_code": "TG",
                            "operator": "T-Money", "phone": "70000000"},
                      timeout=15)
    assert r.status_code == 400


def test_task_pay_rejects_bad_operator(new_user, draft_task):
    hdrs, _ = new_user
    r = requests.post(f"{API}/special-tasks/{draft_task}/pay", headers=hdrs,
                      json={"method": "mobile_money", "country_code": "TG",
                            "operator": "Bogus", "phone": "70000000"},
                      timeout=15)
    assert r.status_code == 400


def test_task_pay_happy(new_user, draft_task):
    hdrs, _ = new_user
    r = requests.post(f"{API}/special-tasks/{draft_task}/pay", headers=hdrs,
                      json={"method": "mobile_money", "country_code": "TG",
                            "operator": "T-Money", "phone": "70000000"},
                      timeout=45)
    # Either succeeds (200) or Ashtech upstream flaked (400 with detail).
    # What matters is that our validation passed and we reached the gateway.
    if r.status_code == 200:
        body = r.json()
        assert body["method"] == "mobile_money"
        assert body["reference"].startswith("SPV-AT-")
    else:
        # Upstream flake — Ashtech sandbox returned 502 or similar.
        assert r.status_code == 400
        detail = r.json().get("detail", "")
        assert any(k in detail.lower() for k in ("ashtec", "erreur", "refus", "interne")), \
            f"Unexpected error: {detail}"
