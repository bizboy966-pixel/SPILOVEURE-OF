"""HTTP-level test for the ads badge endpoints via the public backend URL.

Verifies:
  * GET  /api/ads/unread-count returns {"unread": int} (static route wins over /{ad_id}).
  * POST /api/ads/mark-seen resets the counter to 0.
  * The static routes are NOT shadowed by /api/ads/{ad_id} (used to 404 as ad_id).
"""
from __future__ import annotations
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://spiloveure-deploy.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, r.json()
    return tok


def test_unread_count_route_not_shadowed(admin_token):
    r = requests.get(f"{BASE_URL}/api/ads/unread-count",
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=20)
    assert r.status_code == 200, f"unexpected: {r.status_code} {r.text}"
    body = r.json()
    assert "unread" in body and isinstance(body["unread"], int), body


def test_mark_seen_resets_counter(admin_token):
    h = {"Authorization": f"Bearer {admin_token}"}
    r = requests.post(f"{BASE_URL}/api/ads/mark-seen", headers=h, timeout=20)
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    body = r.json()
    assert body.get("ok") is True and body.get("at")
    # After mark-seen the unread count must be 0.
    r2 = requests.get(f"{BASE_URL}/api/ads/unread-count", headers=h, timeout=20)
    assert r2.status_code == 200
    assert r2.json()["unread"] == 0


def test_unread_count_requires_auth():
    r = requests.get(f"{BASE_URL}/api/ads/unread-count", timeout=20)
    # Must NOT be a 404 (would mean the static route is being matched as {ad_id}).
    assert r.status_code in (401, 403), f"expected auth error, got {r.status_code}: {r.text[:200]}"
