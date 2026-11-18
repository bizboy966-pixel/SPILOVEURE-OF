"""Regression v23 (2026-02-14) — protected-action guard on all critical
write endpoints. Pending users must NEVER be able to publish an ad,
create a marketplace listing, post a special-task campaign, comment on
an ad, review a listing, or request a mission withdrawal.

Backend enforcement is essential — the frontend guardAction() is only
a UX enhancement; a curl / Postman bypass must still be blocked.
"""
from __future__ import annotations
import os
import uuid
import requests

API = (
    os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"
    if "REACT_APP_BACKEND_URL" in os.environ
    else "http://localhost:8001/api"
)


def _new_pending_user() -> tuple[str, str]:
    uid = uuid.uuid4().hex[:6]
    email = f"pu_{uid}@test.com"
    password = "Pending123!"
    r = requests.post(f"{API}/auth/register", json={
        "username": f"pu{uid}",
        "email": email,
        "password": password,
        "password_confirm": password,
        "phone": f"+22890000{uid[:3]}",
        "country": "TG",
        "sponsor_username": "admin",
        "accept_terms": True,
    }, timeout=15)
    assert r.status_code == 200, r.text
    return r.json().get("access_token") or r.json().get("token"), email


def test_pending_user_cannot_create_ad():
    token, _ = _new_pending_user()
    hdr = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{API}/ads", json={
        "title": "Bypass?", "description": "x", "action_type": "video", "network": "tiktok",
        "media_url": "https://x", "action_link": "https://x", "reward_per_action": 100,
        "target_actions": 10, "duration_days": 1,
    }, headers=hdr, timeout=15)
    assert r.status_code == 403, r.text
    assert "ACTIVATION_REQUIRED" in r.text


def test_pending_user_cannot_create_marketplace_listing():
    token, _ = _new_pending_user()
    hdr = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{API}/marketplace", json={
        "title": "Bypass?", "description": "x", "price": 100, "category": "autre",
        "images": [], "contact": "+22800000000",
    }, headers=hdr, timeout=15)
    assert r.status_code == 403, r.text
    assert "ACTIVATION_REQUIRED" in r.text


def test_pending_user_cannot_create_special_task():
    token, _ = _new_pending_user()
    hdr = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{API}/special-tasks", json={
        "action_type": "like", "network": "tiktok", "link": "https://x",
        "reward_per_action": 50, "quantity_target": 10,
    }, headers=hdr, timeout=15)
    assert r.status_code == 403, r.text
    assert "ACTIVATION_REQUIRED" in r.text


def test_pending_user_cannot_comment_ad():
    token, _ = _new_pending_user()
    hdr = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{API}/ads/fake-id/comment", json={"text": "hi"}, headers=hdr, timeout=15)
    # Either 403 (guard fired first) or 404 (ad not found) — both prove no bypass.
    # For pending users, the guard MUST fire before the payload is even read.
    assert r.status_code == 403, r.text
    assert "ACTIVATION_REQUIRED" in r.text


def test_pending_user_cannot_request_mission_withdrawal():
    token, _ = _new_pending_user()
    hdr = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{API}/me/mission-withdrawals", json={"amount": 5000, "phone": "+22800000000", "operator": "Moov"}, headers=hdr, timeout=15)
    assert r.status_code == 403, r.text
    assert "ACTIVATION_REQUIRED" in r.text
