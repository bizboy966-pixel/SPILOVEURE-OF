"""Iteration 7 — Test mission CRUD bug fix + audit endpoints removal.

Covers:
- Admin login (admin from .env)
- Mission CRUD (POST/PUT/DELETE) with proper payload (regression for "Enregistrer" bug)
- 422 reproduction when sending empty numeric fields (matches user's original error)
- Audit endpoints must return 404 (cleanup)
- Regression: mission withdrawals admin listing works
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ---- Mission CRUD (bug fix #1) ----
class TestMissionCRUD:
    created_id = None

    def test_create_mission_valid(self, admin_headers):
        body = {
            "title": "TEST_Iter7 mission",
            "description": "Auto-test",
            "type": "youtube",
            "url": "https://youtube.com/watch?v=abc",
            "duration_seconds": 30,
            "reward": 100,
            "question": "",
            "correct_answer": "",
            "expires_at": None,
            "active": True,
        }
        r = requests.post(f"{BASE_URL}/api/admin/missions", json=body, headers=admin_headers, timeout=15)
        assert r.status_code == 200, f"POST failed: {r.status_code} {r.text}"
        data = r.json()
        assert "id" in data and data["title"] == body["title"]
        assert data["duration_seconds"] == 30 and data["reward"] == 100
        TestMissionCRUD.created_id = data["id"]

    def test_create_mission_422_when_empty_strings(self, admin_headers):
        """Reproduces the original bug: empty strings in numeric fields → 422 from Pydantic.
        Frontend fix coerces to int/float before sending, so this 422 should NOT happen anymore in UI."""
        body = {"title": "X", "type": "youtube", "duration_seconds": "", "reward": ""}
        r = requests.post(f"{BASE_URL}/api/admin/missions", json=body, headers=admin_headers, timeout=15)
        assert r.status_code == 422, f"Expected 422 got {r.status_code}: {r.text}"

    def test_update_mission(self, admin_headers):
        assert TestMissionCRUD.created_id, "no created mission to update"
        body = {
            "title": "TEST_Iter7 mission updated",
            "description": "Updated",
            "type": "tiktok",
            "url": "",
            "duration_seconds": 45,
            "reward": 75,
            "question": "",
            "correct_answer": "",
            "expires_at": None,
            "active": True,
        }
        r = requests.put(f"{BASE_URL}/api/admin/missions/{TestMissionCRUD.created_id}",
                         json=body, headers=admin_headers, timeout=15)
        assert r.status_code == 200, f"PUT failed: {r.status_code} {r.text}"
        d = r.json()
        assert d["type"] == "tiktok" and d["duration_seconds"] == 45

    def test_delete_mission(self, admin_headers):
        assert TestMissionCRUD.created_id
        r = requests.delete(f"{BASE_URL}/api/admin/missions/{TestMissionCRUD.created_id}",
                            headers=admin_headers, timeout=15)
        assert r.status_code == 200, f"DELETE failed: {r.status_code} {r.text}"
        assert r.json().get("ok") is True


# ---- Audit endpoints removal (cleanup #2) ----
class TestAuditRemoved:
    def test_audit_root_404(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/audit", headers=admin_headers, timeout=15)
        assert r.status_code == 404, f"Expected 404 got {r.status_code}: {r.text}"

    def test_audit_user_404(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/audit/user/admin", headers=admin_headers, timeout=15)
        assert r.status_code == 404

    def test_audit_recompute_404(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/admin/audit/recompute", headers=admin_headers, timeout=15)
        assert r.status_code == 404


# ---- Regression: mission withdrawals admin list ----
class TestMissionWithdrawalsRegression:
    def test_list_pending(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/mission-withdrawals?status=pending",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and isinstance(data["items"], list)
