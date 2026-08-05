"""Backend test to verify the admin activation validate/reject flow used by the
notify() fix in the admin panel. Covers happy path (register user -> request
activation -> admin validates), reject path, and 404 error case.
"""
import os
import random
import string
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


def _rand(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"identifier": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        # try alternate field name
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"No token in admin response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _register_user():
    username = f"tst_val_{_rand()}"
    email = f"{username}@example.com"
    payload = {
        "username": username,
        "email": email,
        "password": "TestPass123!",
        "password_confirm": "TestPass123!",
        "country": "TG",
        "phone": f"+2289{random.randint(1000000, 9999999)}",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    body = r.json()
    tok = body.get("access_token") or body.get("token")
    assert tok, f"no user token: {body}"
    return username, tok


def _request_activation(user_token):
    # Get password-confirm token
    rc = requests.post(
        f"{API}/auth/confirm-password",
        json={"password": "TestPass123!"},
        headers={"Authorization": f"Bearer {user_token}"},
    )
    assert rc.status_code == 200, f"confirm-password failed: {rc.status_code} {rc.text}"
    ct = rc.json().get("confirm_token")
    r = requests.post(
        f"{API}/activations/request",
        json={"level": 1, "payment_method": "manual"},
        headers={"Authorization": f"Bearer {user_token}", "X-Password-Confirm": ct},
    )
    assert r.status_code in (200, 201), f"activation request failed: {r.status_code} {r.text}"
    return r.json()


def _find_activation_id(admin_headers, username):
    r = requests.get(f"{API}/admin/activations", headers=admin_headers)
    assert r.status_code == 200, r.text
    for a in r.json():
        if a.get("username") == username and a.get("status") == "pending":
            return a["id"]
    return None


# ---- Tests --------------------------------------------------------------

def test_admin_login(admin_headers):
    r = requests.get(f"{API}/auth/me", headers=admin_headers)
    assert r.status_code == 200
    assert r.json().get("role") == "admin"


def test_validate_flow_end_to_end(admin_headers):
    username, user_tok = _register_user()
    _request_activation(user_tok)
    act_id = _find_activation_id(admin_headers, username)
    assert act_id, f"pending activation not found for {username}"

    # Validate
    r = requests.post(f"{API}/admin/activations/{act_id}/validate", headers=admin_headers)
    assert r.status_code == 200, f"validate failed: {r.status_code} {r.text}"
    assert r.json().get("ok") is True

    # Verify user is now active with max_level>=1
    r2 = requests.get(f"{API}/admin/users", params={"q": username}, headers=admin_headers)
    assert r2.status_code == 200
    users = r2.json()
    assert users, "user not found via admin search"
    u = next((x for x in users if x["username"] == username), None)
    assert u, "user not returned"
    assert u["status"] == "active", f"user status not active: {u}"
    assert int(u.get("max_level") or 0) >= 1


def test_reject_flow(admin_headers):
    username, user_tok = _register_user()
    _request_activation(user_tok)
    act_id = _find_activation_id(admin_headers, username)
    assert act_id, f"pending activation not found for {username}"

    r = requests.post(f"{API}/admin/activations/{act_id}/reject", headers=admin_headers)
    assert r.status_code == 200, f"reject failed: {r.status_code} {r.text}"


def test_validate_404_invalid_id(admin_headers):
    r = requests.post(f"{API}/admin/activations/does-not-exist-id/validate", headers=admin_headers)
    assert r.status_code == 404, f"expected 404 got {r.status_code}: {r.text}"
