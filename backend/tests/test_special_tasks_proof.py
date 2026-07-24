"""Backend tests for iteration 21 — Special Tasks screenshot-proof requirement."""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://spiloveure-deploy.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PWD = "@Emma91972006"


def _login(email, pwd):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": pwd}, timeout=30)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    return r.json()["access_token"]


def _headers(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PWD)


@pytest.fixture(scope="module")
def test_user():
    """Register a fresh test user with sponsor=admin."""
    stamp = uuid.uuid4().hex[:8]
    payload = {
        "username": f"tst_{stamp}",
        "email": f"tst_{stamp}@example.com",
        "password": "TestPass123!",
        "password_confirm": "TestPass123!",
        "country": "TG",
        "phone": f"+22890{stamp[:6]}",
        "sponsor": "admin",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=30)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    tok = _login(payload["email"], payload["password"])
    return {"token": tok, "email": payload["email"], "username": payload["username"]}


# ---------- validation ----------

class TestCompletePayloadValidation:
    def test_no_body_returns_422(self, admin_token):
        r = requests.post(f"{API}/special-tasks/fake-id/complete", headers=_headers(admin_token), timeout=30)
        assert r.status_code == 422, r.text
        # pydantic reports missing body when nothing provided
        assert "missing" in r.text.lower()

    def test_proof_url_too_short_422(self, admin_token):
        r = requests.post(
            f"{API}/special-tasks/fake-id/complete",
            headers=_headers(admin_token),
            json={"proof_url": "x"},
            timeout=30,
        )
        assert r.status_code == 422, r.text

    def test_valid_proof_unknown_task_404(self, admin_token):
        r = requests.post(
            f"{API}/special-tasks/does-not-exist/complete",
            headers=_headers(admin_token),
            json={"proof_url": "/api/uploads/proof.jpg"},
            timeout=30,
        )
        assert r.status_code == 404, r.text
        assert "introuvable" in r.text.lower()


# ---------- happy path ----------

class TestSpecialTaskFullFlow:
    """Ensure config → create → audience → quantity → publish → confirm → complete with proof."""

    @pytest.fixture(scope="class")
    def cfg(self, admin_token):
        payload = {
            "action_types": {
                "video": {"enabled": True, "price_per_action": 10, "reward_per_action": 5, "min_qty": 1, "max_qty": 100}
            }
        }
        r = requests.put(f"{API}/admin/special-tasks/config", headers=_headers(admin_token), json=payload, timeout=30)
        assert r.status_code == 200, r.text
        return r.json()

    @pytest.fixture(scope="class")
    def active_task(self, admin_token, cfg):
        # 1. create
        r = requests.post(
            f"{API}/special-tasks",
            headers=_headers(admin_token),
            json={"action_type": "video", "network": "tiktok", "link": "https://tiktok.com/@spilo/video/123", "description": "test"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        tid = r.json()["id"]
        # 2. audience
        r = requests.put(
            f"{API}/special-tasks/{tid}/audience",
            headers=_headers(admin_token),
            json={"target_countries": ["TG"], "target_age_min": 18, "target_age_max": 60, "target_gender": "both"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # 3. quantity
        r = requests.put(
            f"{API}/special-tasks/{tid}/quantity",
            headers=_headers(admin_token),
            json={"quantity": 2},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # 4. publish
        r = requests.post(f"{API}/special-tasks/{tid}/publish", headers=_headers(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        # 5. confirm payment
        r = requests.post(f"{API}/special-tasks/{tid}/confirm-payment", headers=_headers(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "active"
        return tid

    def test_complete_happy_path(self, test_user, active_task):
        # Fetch user balance before
        me_before = requests.get(f"{API}/auth/me", headers=_headers(test_user["token"]), timeout=30).json()
        bal_before = float(me_before.get("balance_profit") or 0)

        r = requests.post(
            f"{API}/special-tasks/{active_task}/complete",
            headers=_headers(test_user["token"]),
            json={"proof_url": "/api/uploads/proof.jpg"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["credited"] == 5
        assert data["task_status"] in ("active", "completed")

        me_after = requests.get(f"{API}/auth/me", headers=_headers(test_user["token"]), timeout=30).json()
        bal_after = float(me_after.get("balance_profit") or 0)
        assert bal_after - bal_before == 5, f"balance did not increment by 5: {bal_before}->{bal_after}"

    def test_complete_second_time_400(self, test_user, active_task):
        r = requests.post(
            f"{API}/special-tasks/{active_task}/complete",
            headers=_headers(test_user["token"]),
            json={"proof_url": "/api/uploads/proof2.jpg"},
            timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "déjà" in r.text.lower() or "deja" in r.text.lower()

    def test_owner_can_list_completions_with_proof(self, admin_token, active_task):
        r = requests.get(
            f"{API}/special-tasks/{active_task}/completions",
            headers=_headers(admin_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        items = r.json().get("items") or []
        assert len(items) >= 1
        assert any(c.get("proof_url") == "/api/uploads/proof.jpg" for c in items)

    def test_non_owner_cannot_list_completions_403(self, test_user, active_task):
        r = requests.get(
            f"{API}/special-tasks/{active_task}/completions",
            headers=_headers(test_user["token"]),
            timeout=30,
        )
        assert r.status_code == 403, r.text

    def test_admin_completions_endpoint(self, admin_token, active_task):
        r = requests.get(
            f"{API}/admin/special-tasks/{active_task}/completions",
            headers=_headers(admin_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        items = r.json().get("items") or []
        assert any(c.get("proof_url") for c in items)

    def test_commission_entry_recorded(self, test_user, active_task):
        # Check unified transactions endpoint for special_task_reward
        r = requests.get(f"{API}/transactions", headers=_headers(test_user["token"]), timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        items = data.get("items") if isinstance(data, dict) else data
        assert items, f"no transactions returned: {data}"
        assert any(
            (c.get("type") == "commission_special_task_reward" or (c.get("meta") or {}).get("kind") == "special_task_reward")
            and c.get("amount") == 5.0
            for c in items
        ), f"no special_task_reward transaction in {items[:3]}"


# ---------- landing regression ----------

class TestLandingRegression:
    def test_landing_reachable_unauth(self):
        r = requests.get(BASE_URL + "/", timeout=30)
        assert r.status_code == 200
