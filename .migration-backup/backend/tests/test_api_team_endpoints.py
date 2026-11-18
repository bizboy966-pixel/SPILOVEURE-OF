"""API tests for SPILIVERE team/* and core non-regression endpoints.

Tests against the live preview backend using admin credentials.
"""
import os
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

# Load frontend .env for REACT_APP_BACKEND_URL
load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD,
    }, timeout=15)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "access_token" in data
    return data["access_token"]


@pytest.fixture(scope="session")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ===== Auth =====
class TestAuth:
    def test_login_success(self):
        r = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD,
        }, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["user"]["email"] == ADMIN_EMAIL
        assert d["user"]["role"] == "admin"

    def test_login_invalid(self):
        r = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL, "password": "wrong",
        }, timeout=15)
        assert r.status_code == 401

    def test_me(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        assert r.json()["email"] == ADMIN_EMAIL


# ===== Team endpoints =====
class TestTeamTree:
    def test_team_tree_admin_returns_self_root(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/tree?max_depth=4", headers=auth_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("is_self") is True
        assert d.get("username") == "admin"
        # children should be either None or an object with possibly left/right
        assert "children" in d
        children = d["children"]
        assert children is None or isinstance(children, dict)
        if isinstance(children, dict):
            for leg, node in children.items():
                assert leg in ("left", "right")
                assert "username" in node
                assert "is_spillover" in node

    def test_team_tree_default_max_depth(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/tree", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        assert r.json().get("is_self") is True


class TestTeamLevel:
    def test_team_level_valid(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/level?level=1", headers=auth_headers, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body, list)
        # if non-empty, each member should have expected keys
        for m in body:
            assert "id" in m
            assert "username" in m
            assert "is_spillover" in m

    def test_team_level_all_levels(self, auth_headers):
        for lvl in range(1, 13):
            r = requests.get(f"{BASE_URL}/api/team/level?level={lvl}", headers=auth_headers, timeout=15)
            assert r.status_code == 200, f"L{lvl}: {r.status_code} {r.text}"
            assert isinstance(r.json(), list)

    def test_team_level_invalid_zero(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/level?level=0", headers=auth_headers, timeout=15)
        # Server raises HTTPException(400). Acceptable: 400 or 422.
        assert r.status_code in (400, 404, 422), f"Got {r.status_code}: {r.text}"

    def test_team_level_invalid_13(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/level?level=13", headers=auth_headers, timeout=15)
        assert r.status_code in (400, 404, 422), f"Got {r.status_code}: {r.text}"

    def test_team_level_missing_param(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/level", headers=auth_headers, timeout=15)
        assert r.status_code == 422  # FastAPI validation for missing required query

    def test_team_level_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/team/level?level=1", timeout=15)
        assert r.status_code in (401, 403)


# ===== Non-regression =====
class TestNonRegression:
    def test_dashboard(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/dashboard", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        for k in ("balance_total", "balance_profit", "balance_upgrade",
                  "direct_count", "direct_active", "spillover_count", "user"):
            assert k in d, f"missing {k}"

    def test_team_direct(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/team/direct", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert "members" in d and isinstance(d["members"], list)
        assert "active" in d and "inactive" in d

    def test_transactions(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/transactions", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_activations_mine(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/activations/mine", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_withdrawals_mine(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/withdrawals/mine", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_config(self):
        r = requests.get(f"{BASE_URL}/api/config", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert "levels" in d and len(d["levels"]) == 12
        assert "countries" in d
