"""SPILIVERE backend integration tests.

Covers: health, config, auth (register/login/me/change_password/confirm_password),
activation (level 1 pending + admin validate), commission to admin sponsor,
matrix tree placement, wallet, withdrawal guards, admin announcements/channels CRUD,
admin role enforcement.
"""
from __future__ import annotations
import os
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "bizlintl91@gmail.com"
ADMIN_PASSWORD = "@Emma9197"

# unique suffix to dodge collisions across runs
SUFFIX = uuid.uuid4().hex[:6]


@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(session, email, password):
    r = session.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    data = r.json()
    return data["access_token"], data["user"]


def _auth(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _confirm(session, token, password):
    r = session.post(f"{API}/auth/confirm-password", json={"password": password}, headers=_auth(token))
    assert r.status_code == 200, r.text
    return r.json()["confirm_token"]


@pytest.fixture(scope="session")
def admin_creds(session):
    token, user = _login(session, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert user["role"] == "admin"
    return {"token": token, "user": user}


# ============ HEALTH + CONFIG ============

class TestHealth:
    def test_root(self, session):
        r = session.get(f"{API}/")
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_config(self, session):
        r = session.get(f"{API}/config")
        assert r.status_code == 200
        data = r.json()
        assert len(data["levels"]) == 12
        assert len(data["countries"]) == 12
        assert "TG" in data["operators_by_country"]


# ============ AUTH ============

class TestAuth:
    user_a = {
        "username": f"alice{SUFFIX}",
        "email": f"alice{SUFFIX}@test.io",
        "country": "TG",
        "phone": "+22890000111",
        "password": "Passw0rd!aa",
        "password_confirm": "Passw0rd!aa",
        "sponsor_username": "admin",
        "accept_terms": True,
    }

    def test_register_alice(self, session):
        r = session.post(f"{API}/auth/register", json=self.user_a)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "access_token" in data
        assert data["user"]["sponsor_username"] == "admin"
        assert data["user"]["status"] == "pending"
        assert data["user"]["max_level"] == 0
        TestAuth.alice_token = data["access_token"]
        TestAuth.alice_id = data["user"]["id"]

    def test_register_duplicate_email(self, session):
        r = session.post(f"{API}/auth/register", json=self.user_a)
        assert r.status_code == 400

    def test_register_bad_sponsor(self, session):
        bad = dict(self.user_a)
        bad["username"] = f"bob{SUFFIX}"
        bad["email"] = f"bob{SUFFIX}@test.io"
        bad["sponsor_username"] = "doesnotexist_xyz"
        r = session.post(f"{API}/auth/register", json=bad)
        assert r.status_code == 400

    def test_login(self, session):
        token, user = _login(session, self.user_a["email"], self.user_a["password"])
        assert user["username"] == self.user_a["username"]

    def test_me(self, session):
        r = session.get(f"{API}/auth/me", headers=_auth(TestAuth.alice_token))
        assert r.status_code == 200
        assert r.json()["email"] == self.user_a["email"]

    def test_confirm_password_ok(self, session):
        tok = _confirm(session, TestAuth.alice_token, self.user_a["password"])
        assert isinstance(tok, str) and len(tok) > 10

    def test_confirm_password_wrong(self, session):
        r = session.post(f"{API}/auth/confirm-password",
                         json={"password": "wrong"}, headers=_auth(TestAuth.alice_token))
        assert r.status_code == 400

    def test_change_password_and_revert(self, session):
        new = "NewPassw0rd!!"
        r = session.post(f"{API}/auth/change-password",
                         json={"current_password": self.user_a["password"],
                               "new_password": new, "new_password_confirm": new},
                         headers=_auth(TestAuth.alice_token))
        assert r.status_code == 200
        # login with new
        tok, _ = _login(session, self.user_a["email"], new)
        # revert
        r = session.post(f"{API}/auth/change-password",
                         json={"current_password": new,
                               "new_password": self.user_a["password"],
                               "new_password_confirm": self.user_a["password"]},
                         headers=_auth(tok))
        assert r.status_code == 200


# ============ ACTIVATIONS / MATRIX / COMMISSIONS ============

class TestActivation:
    def test_activation_requires_confirm_header(self, session):
        # Use Alice's token without X-Password-Confirm -> 401
        r = session.post(f"{API}/activations/request",
                         json={"level": 1, "payment_method": "mobile_money",
                               "operator": "Mixx By Yas", "payment_phone": "+22890000111",
                               "transaction_ref": "TX-TEST"},
                         headers=_auth(TestAuth.alice_token))
        assert r.status_code == 401

    def test_alice_request_level1(self, session):
        confirm = _confirm(session, TestAuth.alice_token, TestAuth.user_a["password"])
        headers = _auth(TestAuth.alice_token)
        headers["X-Password-Confirm"] = confirm
        r = session.post(f"{API}/activations/request",
                         json={"level": 1, "payment_method": "mobile_money",
                               "operator": "Mixx By Yas", "payment_phone": "+22890000111",
                               "transaction_ref": "TX-TEST"},
                         headers=headers)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "pending"
        TestActivation.activation_id = data["activation_id"]

    def test_user_cannot_access_admin(self, session):
        r = session.get(f"{API}/admin/stats", headers=_auth(TestAuth.alice_token))
        assert r.status_code == 403

    def test_admin_login_and_stats(self, session, admin_creds):
        r = session.get(f"{API}/admin/stats", headers=_auth(admin_creds["token"]))
        assert r.status_code == 200
        data = r.json()
        for k in ("users_total", "users_active", "activations_pending",
                  "withdrawals_pending", "total_activations_amount", "total_withdrawals_amount"):
            assert k in data
        assert data["activations_pending"] >= 1

    def test_admin_validate_activation(self, session, admin_creds):
        # admin balance before
        before = session.get(f"{API}/auth/me", headers=_auth(admin_creds["token"])).json()
        bp_before = before.get("balance_profit", 0)
        bu_before = before.get("balance_upgrade", 0)

        r = session.post(f"{API}/admin/activations/{TestActivation.activation_id}/validate",
                         headers=_auth(admin_creds["token"]))
        assert r.status_code == 200, r.text

        # alice should now be active with max_level 1
        me = session.get(f"{API}/auth/me", headers=_auth(TestAuth.alice_token)).json()
        assert me["status"] == "active"
        assert me["max_level"] == 1

        # admin should have received commission since admin at level 12
        after = session.get(f"{API}/auth/me", headers=_auth(admin_creds["token"])).json()
        assert (after.get("balance_profit", 0) + after.get("balance_upgrade", 0)) > (bp_before + bu_before), \
            f"Admin did not receive commission. before={bp_before}+{bu_before} after={after.get('balance_profit')}+{after.get('balance_upgrade')}"


# ============ MATRIX placement ============

class TestMatrix:
    user_b = {
        "username": f"bob{SUFFIX}",
        "email": f"bob{SUFFIX}@test.io",
        "country": "TG",
        "phone": "+22890000222",
        "password": "Passw0rd!bb",
        "password_confirm": "Passw0rd!bb",
        "sponsor_username": f"alice{SUFFIX}",  # sponsor is Alice (not admin)
        "accept_terms": True,
    }

    def test_register_bob_under_alice(self, session):
        r = session.post(f"{API}/auth/register", json=self.user_b)
        assert r.status_code == 200, r.text
        TestMatrix.bob_token = r.json()["access_token"]
        TestMatrix.bob_id = r.json()["user"]["id"]

    def test_matrix_tree_admin_root_contains_alice(self, session, admin_creds):
        r = session.get(f"{API}/matrix/tree?level=1", headers=_auth(admin_creds["token"]))
        assert r.status_code == 200
        data = r.json()
        # admin root, alice should be in layer 0 at level 1 after validation
        layer_users = []
        for layer in data["layers"]:
            for node in layer:
                if node.get("user"):
                    layer_users.append(node["user"]["username"])
        assert f"alice{SUFFIX}" in layer_users, f"Alice not under admin in matrix L1: {layer_users}"


# ============ WALLET + WITHDRAWAL ============

class TestWalletWithdrawal:
    def test_wallet_save_and_get(self, session):
        # Alice saves wallet
        r = session.post(f"{API}/wallet",
                         json={"country": "TG", "operator": "Mixx By Yas",
                               "phone": "+22890000111", "full_name": "Alice T"},
                         headers=_auth(TestAuth.alice_token))
        assert r.status_code == 200
        r = session.get(f"{API}/wallet", headers=_auth(TestAuth.alice_token))
        assert r.status_code == 200
        w = r.json()
        assert w and w["phone"] == "+22890000111"

    def test_withdrawal_requires_confirm(self, session):
        r = session.post(f"{API}/withdrawals", json={"amount": 100},
                         headers=_auth(TestAuth.alice_token))
        assert r.status_code == 401

    def test_withdrawal_insufficient_balance(self, session):
        confirm = _confirm(session, TestAuth.alice_token, TestAuth.user_a["password"])
        headers = _auth(TestAuth.alice_token)
        headers["X-Password-Confirm"] = confirm
        # huge amount > balance
        r = session.post(f"{API}/withdrawals", json={"amount": 9_999_999_999}, headers=headers)
        assert r.status_code == 400

    def test_withdrawal_no_wallet_for_bob(self, session):
        confirm = _confirm(session, TestMatrix.bob_token, TestMatrix.user_b["password"])
        headers = _auth(TestMatrix.bob_token)
        headers["X-Password-Confirm"] = confirm
        r = session.post(f"{API}/withdrawals", json={"amount": 100}, headers=headers)
        # bob has no wallet AND no balance: should return 400
        assert r.status_code == 400


# ============ ADMIN CRUD: announcements + channels ============

class TestAdminCRUD:
    def test_announcements_crud(self, session, admin_creds):
        h = _auth(admin_creds["token"])
        r = session.post(f"{API}/admin/announcements",
                         json={"title": f"TEST_anc_{SUFFIX}", "message": "Hello", "priority": "normale"},
                         headers=h)
        assert r.status_code == 200, r.text
        aid = r.json()["id"]
        r = session.get(f"{API}/admin/announcements", headers=h)
        assert any(a["id"] == aid for a in r.json())
        r = session.post(f"{API}/admin/announcements/{aid}/toggle", headers=h)
        assert r.status_code == 200
        r = session.delete(f"{API}/admin/announcements/{aid}", headers=h)
        assert r.status_code == 200

    def test_channels_crud(self, session, admin_creds):
        h = _auth(admin_creds["token"])
        r = session.post(f"{API}/admin/channels",
                         json={"name": f"TEST_ch_{SUFFIX}", "url": "https://t.me/x",
                               "platform": "telegram", "description": "x"},
                         headers=h)
        assert r.status_code == 200, r.text
        cid = r.json()["id"]
        r = session.get(f"{API}/admin/channels", headers=h)
        assert any(c["id"] == cid for c in r.json())
        r = session.delete(f"{API}/admin/channels/{cid}", headers=h)
        assert r.status_code == 200

    def test_non_admin_cannot_crud_announcements(self, session):
        r = session.post(f"{API}/admin/announcements",
                         json={"title": "x", "message": "y"},
                         headers=_auth(TestAuth.alice_token))
        assert r.status_code == 403
