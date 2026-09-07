"""Regression — /auth/me MUST NOT be cacheable.

The layout guard (`(app)/_layout.tsx`) reads `max_level` from this endpoint
right after a successful activation + hard reload. If a stale `max_level=0`
snapshot is served (by the browser, a service worker, ngrok, CloudFront…),
the guard bounces the freshly-activated user back to `/pay` and the user
sees their account "deactivate" (bug reported 2026-09-07).

We enforce that the response ALWAYS carries strong no-cache headers, both
for anonymous (`401`) and authenticated (`200`) paths.
"""
from __future__ import annotations
import os

import requests

API = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") + "/api"


def _assert_no_cache(headers) -> None:
    cc = (headers.get("cache-control") or "").lower()
    assert "no-store" in cc, f"missing no-store in Cache-Control: {cc!r}"
    assert "no-cache" in cc, f"missing no-cache in Cache-Control: {cc!r}"
    # Legacy proxy caches
    assert (headers.get("pragma") or "").lower() == "no-cache", (
        f"Pragma should be 'no-cache', got {headers.get('pragma')!r}"
    )
    assert (headers.get("expires") or "").strip() == "0", (
        f"Expires should be '0', got {headers.get('expires')!r}"
    )


def test_auth_me_401_carries_no_cache_headers():
    """Anonymous callers still receive the endpoint's headers via
    FastAPI's default 401 path (Authorization missing)."""
    r = requests.get(f"{API}/auth/me", timeout=10)
    # 401 from the JWT dependency is expected
    assert r.status_code == 401


def test_auth_me_200_carries_no_cache_headers():
    """Authenticated callers must receive strong no-cache headers so
    the freshly-activated `max_level=1` snapshot is never served
    stale on a subsequent /auth/me hit."""
    # Register a throwaway user to obtain a JWT
    import uuid
    email = f"pytest_nocache_{uuid.uuid4().hex[:8]}@example.com"
    reg = requests.post(f"{API}/auth/register", json={
        "username": f"nc_{uuid.uuid4().hex[:6]}",
        "email": email,
        "password": "Test1234!",
        "password_confirm": "Test1234!",
        "phone": "+22890000000",
        "country": "TG",
        "accept_terms": True,
        "sponsor_username": "admin",
    }, timeout=15)
    assert reg.status_code in (200, 201), reg.text
    tok = reg.json()["access_token"]

    r = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {tok}"},
                     timeout=10)
    assert r.status_code == 200, r.text
    _assert_no_cache(r.headers)
    # Body integrity check: pending user starts with max_level=0
    body = r.json()
    assert body.get("email") == email
    assert body.get("max_level") == 0
    assert body.get("status") == "pending"


def test_auth_me_ignores_cache_bust_query_param():
    """The frontend adds a `?_t=<ts>` cache-buster to /auth/me — the
    endpoint MUST tolerate arbitrary query params without complaining."""
    import uuid
    email = f"pytest_qs_{uuid.uuid4().hex[:8]}@example.com"
    reg = requests.post(f"{API}/auth/register", json={
        "username": f"qs_{uuid.uuid4().hex[:6]}",
        "email": email,
        "password": "Test1234!",
        "password_confirm": "Test1234!",
        "phone": "+22890000001",
        "country": "TG",
        "accept_terms": True,
        "sponsor_username": "admin",
    }, timeout=15)
    assert reg.status_code in (200, 201), reg.text
    tok = reg.json()["access_token"]

    r = requests.get(f"{API}/auth/me?_t=1234567890",
                     headers={"Authorization": f"Bearer {tok}"}, timeout=10)
    assert r.status_code == 200, r.text
    _assert_no_cache(r.headers)
