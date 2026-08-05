"""SPILIVERE backend tests — Admin User Management (iteration 2).

Covers the new endpoints / actions:
  - GET  /api/admin/users/{user_id}            (detail + placements + notes + wallet + activations + withdrawals)
  - GET  /api/admin/users/{user_id}/tree       (layers)
  - GET  /api/admin/activations/{activation_id}
  - POST /api/admin/users/{user_id}/action     (credit_wallet, debit_wallet, make/remove admin,
                                                make/remove promoter, activate_level, deactivate_level,
                                                add_note, move_matrix, 403 for non-admin)
"""
from __future__ import annotations
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "bizlintl91@gmail.com"
ADMIN_PASSWORD = "@Emma9197"

SUFFIX = uuid.uuid4().hex[:6]


def _auth(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_token(session):
    r = session.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def carol(session):
    """Fresh regular user under admin used for mutation tests."""
    payload = {
        "username": f"carol{SUFFIX}",
        "email": f"carol{SUFFIX}@test.io",
        "country": "TG",
        "phone": "+22890000333",
        "password": "Passw0rd!cc",
        "password_confirm": "Passw0rd!cc",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = session.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    return {"token": data["access_token"], "user": data["user"], "creds": payload}


@pytest.fixture(scope="module")
def dave(session):
    """Second fresh user (sponsored by carol) used as alternate matrix parent."""
    payload = {
        "username": f"dave{SUFFIX}",
        "email": f"dave{SUFFIX}@test.io",
        "country": "TG",
        "phone": "+22890000444",
        "password": "Passw0rd!dd",
        "password_confirm": "Passw0rd!dd",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = session.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    return {"token": data["access_token"], "user": data["user"], "creds": payload}


# =============================================================================
# GET /admin/users/{id}
# =============================================================================

class TestAdminUserDetail:
    def test_user_detail_full_shape(self, session, admin_token, carol):
        r = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        data = r.json()
        # required keys
        for k in ("user", "placements", "notes", "wallet", "activations", "withdrawals"):
            assert k in data, f"missing key {k}"
        assert data["user"]["id"] == carol["user"]["id"]
        assert data["user"]["username"] == carol["user"]["username"]
        assert "password_hash" not in data["user"]
        assert isinstance(data["placements"], list)
        assert isinstance(data["notes"], list)
        assert isinstance(data["activations"], list)
        assert isinstance(data["withdrawals"], list)

    def test_user_detail_404(self, session, admin_token):
        r = session.get(f"{API}/admin/users/{uuid.uuid4()}", headers=_auth(admin_token))
        assert r.status_code == 404

    def test_user_detail_forbidden_for_non_admin(self, session, carol):
        r = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(carol["token"]))
        assert r.status_code == 403


# =============================================================================
# GET /admin/users/{id}/tree
# =============================================================================

class TestAdminUserTree:
    def test_tree_layers_structure(self, session, admin_token, carol):
        r = session.get(f"{API}/admin/users/{carol['user']['id']}/tree?level=1", headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["root_user_id"] == carol["user"]["id"]
        assert data["level"] == 1
        assert isinstance(data["layers"], list)


# =============================================================================
# POST /admin/users/{id}/action  -- wallet credit/debit
# =============================================================================

class TestAdminWallet:
    def test_credit_profit_bucket(self, session, admin_token, carol):
        before = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        bp_before = before.get("balance_profit", 0)
        r = session.post(
            f"{API}/admin/users/{carol['user']['id']}/action",
            json={"action": "credit_wallet", "amount": 5000, "bucket": "profit"},
            headers=_auth(admin_token),
        )
        assert r.status_code == 200, r.text
        after = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        assert after["balance_profit"] == bp_before + 5000

    def test_credit_upgrade_bucket(self, session, admin_token, carol):
        before = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        bu_before = before.get("balance_upgrade", 0)
        r = session.post(
            f"{API}/admin/users/{carol['user']['id']}/action",
            json={"action": "credit_wallet", "amount": 12000, "bucket": "upgrade"},
            headers=_auth(admin_token),
        )
        assert r.status_code == 200, r.text
        after = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        assert after["balance_upgrade"] == bu_before + 12000

    def test_debit_insufficient_funds(self, session, admin_token, carol):
        r = session.post(
            f"{API}/admin/users/{carol['user']['id']}/action",
            json={"action": "debit_wallet", "amount": 9_999_999, "bucket": "profit"},
            headers=_auth(admin_token),
        )
        assert r.status_code == 400

    def test_debit_sufficient_funds(self, session, admin_token, carol):
        before = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        bp_before = before.get("balance_profit", 0)
        assert bp_before >= 1000
        r = session.post(
            f"{API}/admin/users/{carol['user']['id']}/action",
            json={"action": "debit_wallet", "amount": 1000, "bucket": "profit"},
            headers=_auth(admin_token),
        )
        assert r.status_code == 200, r.text
        after = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        assert after["balance_profit"] == bp_before - 1000


# =============================================================================
# Privileges
# =============================================================================

class TestAdminPrivileges:
    def test_make_admin_then_remove_admin(self, session, admin_token, dave):
        uid = dave["user"]["id"]
        r = session.post(f"{API}/admin/users/{uid}/action",
                         json={"action": "make_admin"}, headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        u = session.get(f"{API}/admin/users/{uid}", headers=_auth(admin_token)).json()["user"]
        assert u["role"] == "admin"
        r = session.post(f"{API}/admin/users/{uid}/action",
                         json={"action": "remove_admin"}, headers=_auth(admin_token))
        assert r.status_code == 200
        u = session.get(f"{API}/admin/users/{uid}", headers=_auth(admin_token)).json()["user"]
        assert u["role"] == "user"

    def test_make_promoter_then_remove_promoter(self, session, admin_token, dave):
        uid = dave["user"]["id"]
        r = session.post(f"{API}/admin/users/{uid}/action",
                         json={"action": "make_promoter"}, headers=_auth(admin_token))
        assert r.status_code == 200
        u = session.get(f"{API}/admin/users/{uid}", headers=_auth(admin_token)).json()["user"]
        assert u.get("is_promoter") is True
        r = session.post(f"{API}/admin/users/{uid}/action",
                         json={"action": "remove_promoter"}, headers=_auth(admin_token))
        assert r.status_code == 200
        u = session.get(f"{API}/admin/users/{uid}", headers=_auth(admin_token)).json()["user"]
        assert u.get("is_promoter") is False


# =============================================================================
# Levels (activate / deactivate)
# =============================================================================

class TestAdminLevels:
    def test_activate_level_wrong_next(self, session, admin_token, carol):
        # carol has max_level=0; level=5 (not next=1) -> 400
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "activate_level", "level": 5}, headers=_auth(admin_token))
        assert r.status_code == 400

    def test_activate_level_one(self, session, admin_token, carol):
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "activate_level", "level": 1}, headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        u = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        assert u["max_level"] == 1
        assert u["status"] == "active"

    def test_activate_level_two_uses_upgrade_balance(self, session, admin_token, carol):
        # carol has upgrade balance from earlier test_credit_upgrade_bucket (12000).
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "activate_level", "level": 2}, headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        u = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        assert u["max_level"] == 2

    def test_deactivate_top_level(self, session, admin_token, carol):
        # carol max_level should now be 2; deactivate L2 -> max_level=1
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "deactivate_level", "level": 2}, headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        u = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()["user"]
        assert u["max_level"] == 1

    def test_deactivate_non_top_level_rejected(self, session, admin_token, carol):
        # max_level is 1; trying to deactivate level=5 should fail.
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "deactivate_level", "level": 5}, headers=_auth(admin_token))
        assert r.status_code == 400


# =============================================================================
# Notes
# =============================================================================

class TestAdminNotes:
    def test_add_note_appears_in_detail(self, session, admin_token, carol):
        note_text = f"TEST_note_{SUFFIX}"
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "add_note", "note": note_text}, headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        detail = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()
        notes = detail.get("notes", [])
        assert any(n.get("note") == note_text for n in notes), f"Note not persisted: {notes}"

    def test_add_empty_note_rejected(self, session, admin_token, carol):
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "add_note", "note": ""}, headers=_auth(admin_token))
        assert r.status_code == 400


# =============================================================================
# Matrix move
# =============================================================================

class TestAdminMatrixMove:
    def test_move_matrix_to_dave_as_parent(self, session, admin_token, carol, dave):
        # Activate dave at L1 so he becomes a valid parent in matrix.
        # (Use admin action for speed — credits/activate)
        # Ensure dave is at level 1
        d = session.get(f"{API}/admin/users/{dave['user']['id']}", headers=_auth(admin_token)).json()["user"]
        if d.get("max_level", 0) < 1:
            r = session.post(f"{API}/admin/users/{dave['user']['id']}/action",
                             json={"action": "activate_level", "level": 1}, headers=_auth(admin_token))
            assert r.status_code == 200, r.text
        # Move carol under dave at level 1, leg=left
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "move_matrix", "level": 1,
                               "new_parent_username": dave["user"]["username"], "new_leg": "left"},
                         headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        # Verify placement updated
        detail = session.get(f"{API}/admin/users/{carol['user']['id']}", headers=_auth(admin_token)).json()
        l1 = [p for p in detail["placements"] if p["level"] == 1]
        assert l1, "No L1 placement after move"
        assert l1[0]["parent_id"] == dave["user"]["id"]
        assert l1[0]["leg"] == "left"

    def test_move_matrix_to_occupied_slot(self, session, admin_token, carol, dave):
        # Now slot (dave, level=1, leg=left) is occupied by carol. Trying to move *another* user
        # (we'll create eve) into that same slot must 400.
        eve_payload = {
            "username": f"eve{SUFFIX}",
            "email": f"eve{SUFFIX}@test.io",
            "country": "TG",
            "phone": "+22890000555",
            "password": "Passw0rd!ee",
            "password_confirm": "Passw0rd!ee",
            "sponsor_username": "admin",
            "accept_terms": True,
        }
        r = session.post(f"{API}/auth/register", json=eve_payload)
        assert r.status_code == 200, r.text
        eve_id = r.json()["user"]["id"]
        # activate eve to L1 so she has a placement to move
        r = session.post(f"{API}/admin/users/{eve_id}/action",
                         json={"action": "activate_level", "level": 1}, headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        # try to move eve into occupied (dave, left)
        r = session.post(f"{API}/admin/users/{eve_id}/action",
                         json={"action": "move_matrix", "level": 1,
                               "new_parent_username": dave["user"]["username"], "new_leg": "left"},
                         headers=_auth(admin_token))
        assert r.status_code == 400


# =============================================================================
# GET /admin/activations/{id}
# =============================================================================

class TestAdminActivationDetail:
    def test_activation_detail_includes_user(self, session, admin_token, carol):
        # Need at least one activation in DB tied to carol. The "activate_level" admin action
        # uses matrix.activate_level which may or may not push to the activations collection.
        # Easiest reliable way: trigger a level-1 pending request for a brand-new user.
        eve2_payload = {
            "username": f"frank{SUFFIX}",
            "email": f"frank{SUFFIX}@test.io",
            "country": "TG",
            "phone": "+22890000666",
            "password": "Passw0rd!ff",
            "password_confirm": "Passw0rd!ff",
            "sponsor_username": "admin",
            "accept_terms": True,
        }
        r = session.post(f"{API}/auth/register", json=eve2_payload)
        assert r.status_code == 200, r.text
        tok = r.json()["access_token"]
        # confirm password
        c = session.post(f"{API}/auth/confirm-password", json={"password": eve2_payload["password"]},
                         headers=_auth(tok))
        assert c.status_code == 200, c.text
        confirm = c.json()["confirm_token"]
        headers = _auth(tok)
        headers["X-Password-Confirm"] = confirm
        r = session.post(f"{API}/activations/request",
                         json={"level": 1, "payment_method": "mobile_money",
                               "operator": "Mixx By Yas", "payment_phone": "+22890000666",
                               "transaction_ref": "TX-FRANK"},
                         headers=headers)
        assert r.status_code == 200, r.text
        act_id = r.json()["activation_id"]
        # admin fetches detail
        r = session.get(f"{API}/admin/activations/{act_id}", headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        data = r.json()
        assert "activation" in data and "user" in data
        assert data["activation"]["id"] == act_id
        assert data["activation"]["payment_method"] == "mobile_money"
        assert data["activation"]["operator"] == "Mixx By Yas"
        assert data["activation"]["payment_phone"] == "+22890000666"
        assert data["activation"]["transaction_ref"] == "TX-FRANK"
        assert data["user"]["username"] == eve2_payload["username"]

    def test_activation_detail_404(self, session, admin_token):
        r = session.get(f"{API}/admin/activations/{uuid.uuid4()}", headers=_auth(admin_token))
        assert r.status_code == 404


# =============================================================================
# Non-admin guard
# =============================================================================

class TestAdminGuard:
    def test_non_admin_cannot_call_action(self, session, carol):
        r = session.post(f"{API}/admin/users/{carol['user']['id']}/action",
                         json={"action": "ban"}, headers=_auth(carol["token"]))
        assert r.status_code == 403
