"""Regression test — /dashboard exposes daily activity trend v14."""
from __future__ import annotations
import os

import requests

API = (
    os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"
    if "REACT_APP_BACKEND_URL" in os.environ
    else "http://localhost:8001/api"
)
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


def _login() -> dict:
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}


def test_dashboard_returns_trend_block():
    hdr = _login()
    r = requests.get(f"{API}/dashboard", headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "trend" in body, "dashboard payload must include a `trend` block for v14 hero card"
    t = body["trend"]
    for k in ("profit_pct", "balance_pct", "activation_pct"):
        assert k in t, f"missing {k}"
        assert isinstance(t[k], (int, float)), f"{k} must be numeric"
    for k in ("profit_series", "balance_series", "activation_series"):
        assert k in t, f"missing {k}"
        arr = t[k]
        assert isinstance(arr, list) and len(arr) == 7, f"{k} must be a 7-length list"
        assert all(isinstance(x, (int, float)) for x in arr), f"{k} must be numeric"
