"""Phase 2 Missions: withdrawal flow + admin actions + stats."""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"

MISSION_TYPES = ["youtube", "tiktok", "instagram", "facebook", "questionnaire"]


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    data = r.json()
    tok = data.get("token") or data.get("access_token")
    assert tok, f"No token in login response: {data}"
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ============ user (admin acting as user) wallets ============
class TestMissionWallets:
    def test_get_my_mission_wallets(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/me/mission-wallets", headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "wallets" in data and "total" in data and "window_open" in data
        assert isinstance(data["wallets"], list)
        types_in_resp = {w["type"] for w in data["wallets"]}
        assert set(MISSION_TYPES).issubset(types_in_resp), types_in_resp
        for w in data["wallets"]:
            assert "balance" in w and "completed" in w
            assert isinstance(w["balance"], (int, float))

    def test_get_mission_history(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/me/mission-history", headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert "items" in r.json()

    def test_get_mission_withdrawals(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/me/mission-withdrawals", headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert "items" in r.json()


# ============ withdrawal flow ============
class TestWithdrawalFlow:
    def _get_balance(self, headers, wallet):
        r = requests.get(f"{BASE_URL}/api/me/mission-wallets", headers=headers, timeout=15)
        assert r.status_code == 200
        for w in r.json()["wallets"]:
            if w["type"] == wallet:
                return float(w["balance"])
        return 0.0

    def test_insufficient_balance_returns_400(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/me/mission-withdrawals",
                          headers=admin_headers,
                          json={"wallet": "tiktok", "amount": 999999999},
                          timeout=15)
        assert r.status_code == 400, r.text
        body = r.json()
        msg = body.get("detail", "") if isinstance(body, dict) else str(body)
        assert "insuffisant" in msg.lower() or "insufficient" in msg.lower(), msg

    def test_invalid_wallet_returns_400(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/me/mission-withdrawals",
                          headers=admin_headers,
                          json={"wallet": "bogus", "amount": 100},
                          timeout=15)
        assert r.status_code == 400, r.text

    def test_amount_validation(self, admin_headers):
        # amount must be >= 1 per pydantic Field(ge=1)
        r = requests.post(f"{BASE_URL}/api/me/mission-withdrawals",
                          headers=admin_headers,
                          json={"wallet": "youtube", "amount": 0},
                          timeout=15)
        assert r.status_code in (400, 422), r.text

    def test_create_withdrawal_and_balance_decreases(self, admin_headers):
        wallet = "youtube"
        bal_before = self._get_balance(admin_headers, wallet)
        if bal_before < 100:
            pytest.skip(f"Insufficient seed balance for {wallet}: {bal_before}")
        amount = 100
        r = requests.post(f"{BASE_URL}/api/me/mission-withdrawals",
                          headers=admin_headers,
                          json={"wallet": wallet, "amount": amount},
                          timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("ok") is True
        wd = data["withdrawal"]
        assert wd["status"] == "pending"
        assert wd["wallet"] == wallet
        assert float(wd["amount"]) == amount
        wid = wd["id"]

        # Verify balance decreased
        bal_after = self._get_balance(admin_headers, wallet)
        assert abs(bal_after - (bal_before - amount)) < 0.01, (bal_before, bal_after)

        # Verify it's in user's withdrawals list
        r2 = requests.get(f"{BASE_URL}/api/me/mission-withdrawals", headers=admin_headers, timeout=15)
        ids = [w["id"] for w in r2.json()["items"]]
        assert wid in ids

        # cleanup: reject so it is refunded
        rj = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{wid}/action",
                           headers=admin_headers, json={"action": "reject"}, timeout=15)
        assert rj.status_code == 200, rj.text
        bal_final = self._get_balance(admin_headers, wallet)
        assert abs(bal_final - bal_before) < 0.01, (bal_before, bal_final)


# ============ admin actions ============
class TestAdminWithdrawalActions:
    def _create_withdrawal(self, headers, wallet="youtube", amount=50):
        bal = 0
        r = requests.get(f"{BASE_URL}/api/me/mission-wallets", headers=headers, timeout=15)
        for w in r.json()["wallets"]:
            if w["type"] == wallet:
                bal = float(w["balance"])
        if bal < amount:
            return None
        rr = requests.post(f"{BASE_URL}/api/me/mission-withdrawals",
                           headers=headers, json={"wallet": wallet, "amount": amount}, timeout=15)
        assert rr.status_code == 200, rr.text
        return rr.json()["withdrawal"]["id"]

    def _get_balance(self, headers, wallet):
        r = requests.get(f"{BASE_URL}/api/me/mission-wallets", headers=headers, timeout=15)
        for w in r.json()["wallets"]:
            if w["type"] == wallet:
                return float(w["balance"])
        return 0.0

    def test_admin_list_withdrawals(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/mission-withdrawals",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        assert "items" in r.json()

    def test_admin_list_filtered_by_status(self, admin_headers):
        for s in ("pending", "validated", "rejected"):
            r = requests.get(f"{BASE_URL}/api/admin/mission-withdrawals?status={s}",
                             headers=admin_headers, timeout=15)
            assert r.status_code == 200
            for it in r.json()["items"]:
                assert it["status"] == s

    def test_validate_keeps_balance_reserved(self, admin_headers):
        wallet = "youtube"
        bal_before = self._get_balance(admin_headers, wallet)
        if bal_before < 50:
            pytest.skip("Insufficient balance")
        wid = self._create_withdrawal(admin_headers, wallet, 50)
        assert wid
        bal_after_req = self._get_balance(admin_headers, wallet)
        r = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{wid}/action",
                          headers=admin_headers, json={"action": "validate"}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "validated"
        # balance should remain at after-reservation (not refunded)
        bal_final = self._get_balance(admin_headers, wallet)
        assert abs(bal_final - bal_after_req) < 0.01

    def test_reject_refunds_balance(self, admin_headers):
        wallet = "youtube"
        bal_before = self._get_balance(admin_headers, wallet)
        if bal_before < 30:
            pytest.skip("Insufficient balance")
        wid = self._create_withdrawal(admin_headers, wallet, 30)
        assert wid
        r = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{wid}/action",
                          headers=admin_headers, json={"action": "reject"}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "rejected"
        bal_final = self._get_balance(admin_headers, wallet)
        assert abs(bal_final - bal_before) < 0.01

    def test_idempotency_double_action_rejected(self, admin_headers):
        wallet = "youtube"
        wid = self._create_withdrawal(admin_headers, wallet, 10)
        if not wid:
            pytest.skip("Insufficient balance")
        r1 = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{wid}/action",
                           headers=admin_headers, json={"action": "reject"}, timeout=15)
        assert r1.status_code == 200
        r2 = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{wid}/action",
                           headers=admin_headers, json={"action": "validate"}, timeout=15)
        assert r2.status_code == 400, r2.text

    def test_invalid_action(self, admin_headers):
        wid = "nonexistent-id"
        r = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{wid}/action",
                          headers=admin_headers, json={"action": "foo"}, timeout=15)
        assert r.status_code == 400, r.text

    def test_unknown_withdrawal_404(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/admin/mission-withdrawals/{uuid.uuid4()}/action",
                          headers=admin_headers, json={"action": "validate"}, timeout=15)
        assert r.status_code == 404, r.text


# ============ admin stats + missions CRUD smoke ============
class TestAdminStatsAndCrud:
    def test_stats_endpoint(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/missions/stats", headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("total_missions", "active_missions", "completions",
                  "active_users", "total_rewards", "by_type"):
            assert k in data, f"Missing key {k} in stats"
        assert isinstance(data["by_type"], dict)

    def test_mission_crud(self, admin_headers):
        created_id = None
        try:
            payload = {
                "title": "TEST_MISSION_PHASE2",
                "description": "auto-test",
                "type": "youtube",
                "url": "https://example.com/video.mp4",
                "duration_seconds": 30,
                "reward": 25,
                "active": True,
            }
            r = requests.post(f"{BASE_URL}/api/admin/missions", headers=admin_headers,
                              json=payload, timeout=15)
            assert r.status_code == 200, r.text
            created = r.json()
            assert created["title"] == payload["title"]
            created_id = created["id"]

            # update
            payload["title"] = "TEST_MISSION_PHASE2_EDIT"
            r2 = requests.put(f"{BASE_URL}/api/admin/missions/{created_id}",
                              headers=admin_headers, json=payload, timeout=15)
            assert r2.status_code == 200, r2.text
            assert r2.json()["title"] == "TEST_MISSION_PHASE2_EDIT"

            # list/search
            r3 = requests.get(f"{BASE_URL}/api/admin/missions?q=TEST_MISSION_PHASE2",
                              headers=admin_headers, timeout=15)
            assert r3.status_code == 200
            assert any(m["id"] == created_id for m in r3.json())
        finally:
            if created_id:
                rd = requests.delete(f"{BASE_URL}/api/admin/missions/{created_id}",
                                     headers=admin_headers, timeout=15)
                assert rd.status_code == 200

    def test_invalid_mission_type_rejected(self, admin_headers):
        payload = {"title": "T", "type": "badtype", "url": "", "duration_seconds": 10, "reward": 5}
        r = requests.post(f"{BASE_URL}/api/admin/missions", headers=admin_headers, json=payload, timeout=15)
        assert r.status_code == 400, r.text


# ============ auth ============
class TestAuth:
    def test_admin_endpoint_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/mission-withdrawals", timeout=15)
        assert r.status_code in (401, 403)

    def test_user_endpoint_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/me/mission-wallets", timeout=15)
        assert r.status_code in (401, 403)
