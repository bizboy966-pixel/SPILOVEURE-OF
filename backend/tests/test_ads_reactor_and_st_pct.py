"""Tests for the new admin config models:
- Ads reactor pool config (share %, min/max reward per reactor)
- Special Tasks distribution % (price_per_action auto-computed from reward)
"""
from __future__ import annotations
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].splitlines()[0].strip()
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json={
        "email": "kossikotokou4@gmail.com", "password": "@Emma91972006",
    }, timeout=15)
    assert r.status_code == 200
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}


# ─── Ads reactor pool config ─────────────────────────────────────────
def test_ads_reactor_config_public_get(admin_headers):
    r = requests.get(f"{API}/ads-reactor-config", headers=admin_headers, timeout=15)
    assert r.status_code == 200
    d = r.json()
    for k in ("share_percentage", "min_reward", "max_reward"):
        assert k in d


def test_ads_reactor_config_admin_update(admin_headers):
    r = requests.put(f"{API}/admin/ads-reactor-config",
                     json={"share_percentage": 55.0,
                           "min_reward": 30, "max_reward": 400},
                     headers=admin_headers, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["share_percentage"] == 55.0
    assert d["min_reward"] == 30
    assert d["max_reward"] == 400
    # Read-back
    r2 = requests.get(f"{API}/admin/ads-reactor-config", headers=admin_headers, timeout=15)
    assert r2.json()["share_percentage"] == 55.0


def test_ads_reactor_config_rejects_max_lt_min(admin_headers):
    r = requests.put(f"{API}/admin/ads-reactor-config",
                     json={"share_percentage": 60,
                           "min_reward": 500, "max_reward": 100},
                     headers=admin_headers, timeout=15)
    assert r.status_code == 400
    assert "min_reward" in r.json()["detail"]


def test_ads_reactor_config_pct_bounded(admin_headers):
    # Pydantic Field(ge=0, le=100) should reject 150
    r = requests.put(f"{API}/admin/ads-reactor-config",
                     json={"share_percentage": 150,
                           "min_reward": 10, "max_reward": 100},
                     headers=admin_headers, timeout=15)
    assert r.status_code in (400, 422)


# ─── Special tasks distribution % ────────────────────────────────────
def test_st_config_computes_price_from_reward_and_pct(admin_headers):
    # Set: reward=100, pct=50 → price = 100/0.5 = 200
    r = requests.put(f"{API}/admin/special-tasks/config",
                     json={
                         "action_types": {
                             "like": {"enabled": True, "reward_per_action": 100,
                                      "min_qty": 1, "max_qty": 100},
                         },
                         "distribution_percentage": 50,
                     },
                     headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    assert d["distribution_percentage"] == 50
    like = d["action_types"]["like"]
    assert like["reward_per_action"] == 100
    assert like["price_per_action"] == 200.0

    # Change to pct=25 → price = 100/0.25 = 400
    r2 = requests.put(f"{API}/admin/special-tasks/config",
                      json={
                          "action_types": {
                              "like": {"enabled": True, "reward_per_action": 100,
                                       "min_qty": 1, "max_qty": 100},
                          },
                          "distribution_percentage": 25,
                      },
                      headers=admin_headers, timeout=15)
    d2 = r2.json()
    assert d2["action_types"]["like"]["price_per_action"] == 400.0


def test_st_config_public_endpoint_reflects_dist_pct(admin_headers):
    requests.put(f"{API}/admin/special-tasks/config",
                 json={"action_types": {
                     "video": {"enabled": True, "reward_per_action": 20,
                               "min_qty": 5, "max_qty": 100},
                 }, "distribution_percentage": 70},
                 headers=admin_headers, timeout=15)
    r = requests.get(f"{API}/special-tasks/config", headers=admin_headers, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["distribution_percentage"] == 70
    # price = 20 / 0.70 ≈ 28.57
    assert abs(d["action_types"]["video"]["price_per_action"] - 28.57) < 0.1


def test_st_config_rejects_pct_out_of_bounds(admin_headers):
    r = requests.put(f"{API}/admin/special-tasks/config",
                     json={"action_types": {
                         "like": {"enabled": True, "reward_per_action": 10,
                                  "min_qty": 1, "max_qty": 100},
                     }, "distribution_percentage": 0},
                     headers=admin_headers, timeout=15)
    assert r.status_code in (400, 422)
