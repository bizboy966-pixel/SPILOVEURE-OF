"""Registration and three-identifier login, with no real DB, mail or payments."""
import pytest

from auth import decode_token, hash_password
from test_identity import identity_app, register, run, verify, activate, main_header


def test_registration_requires_both_password_fields(identity_app):
    payload = {"username": "NewMember", "email": "new@example.com", "country": "TG",
               "phone": "+22891111111", "sponsor_username": "Sponsor", "accept_terms": True}
    for fields in [{}, {"password": "SignupPassword9!"}, {"password_confirm": "SignupPassword9!"}]:
        assert identity_app[1].post("/api/auth/register", json={**payload, **fields}).status_code == 422
    assert run(identity_app[0].state.db.users.count_documents({"username": "NewMember"})) == 0


@pytest.mark.parametrize("password,confirmation,status", [
    (None, None, 422),
    ("short", "short", 422),
    ("SignupPassword9!", "different", 400),
    ("é" * 37, "é" * 37, 422),
])
def test_registration_rejects_invalid_passwords_before_creating_user(identity_app, password, confirmation, status):
    response = register(identity_app, password=password, password_confirm=confirmation)
    assert response.status_code == status
    assert run(identity_app[0].state.db.users.count_documents({"username": "NewMember"})) == 0


@pytest.mark.parametrize("identifier", [
    "new@example.com", " NEW@EXAMPLE.COM ", "NewMember", "newmember",
    "+22891111111", "22891111111", "0022891111111", "+228 91 11 11 11",
])
def test_new_password_works_with_all_identifiers_without_unlocking_pending_account(identity_app, identifier):
    created = register(identity_app).json()
    result = identity_app[1].post("/api/auth/login", json={"identifier": identifier, "password": "SignupPassword9!"})
    assert result.status_code == 200
    data = result.json()
    assert data["user"]["id"] == created["user"]["id"]
    assert "password_hash" not in data["user"]
    assert decode_token(data["access_token"])["scope"] == "main_onboarding"
    assert identity_app[1].get("/api/test/protected", headers=main_header(data["access_token"])).status_code == 403


def test_verified_activated_account_uses_signup_password_without_recreation(identity_app):
    created = register(identity_app).json()
    verify(identity_app, created["access_token"])
    activate(identity_app, created["user"]["id"])
    result = identity_app[1].post("/api/auth/login", json={"identifier": "NewMember", "password": "SignupPassword9!"})
    assert result.status_code == 200
    assert result.json()["user"]["session_scope"] == "main"
    assert identity_app[1].get("/api/test/protected", headers=main_header(result.json()["access_token"])).status_code == 200


def test_old_email_login_payload_and_existing_password_still_work(identity_app):
    result = identity_app[1].post("/api/auth/login", json={"email": "legacy@example.com", "password": "LegacyPass9!"})
    assert result.status_code == 200 and result.json()["user"]["id"] == "legacy"


@pytest.mark.parametrize("identifier", ["NewMember", "new@example.com", "+22891111111", ".*", "missing"])
def test_wrong_credentials_do_not_start_a_session(identity_app, identifier):
    register(identity_app)
    result = identity_app[1].post("/api/auth/login", json={"identifier": identifier, "password": "incorrect"})
    assert result.status_code == 401


def test_duplicate_phone_is_not_assigned_to_an_arbitrary_account(identity_app):
    register(identity_app)
    register(identity_app, username="OtherMember", email="other@example.com")
    result = identity_app[1].post("/api/auth/login", json={"identifier": "+22891111111", "password": "SignupPassword9!"})
    assert result.status_code == 401
    assert identity_app[1].post("/api/auth/login", json={"identifier": "NewMember", "password": "SignupPassword9!"}).status_code == 200


def test_historical_phone_format_and_ban_are_respected(identity_app):
    data = register(identity_app).json()
    run(identity_app[0].state.db.users.update_one({"id": data["user"]["id"]}, {"$set": {"phone": "+228 91-11-11-11", "status": "banned"}}))
    result = identity_app[1].post("/api/auth/login", json={"identifier": "0022891111111", "password": "SignupPassword9!"})
    assert result.status_code == 403


def test_identifier_switching_counts_three_failed_attempts(identity_app):
    register(identity_app)
    identifiers = ["NewMember", "new@example.com", "+22891111111"]
    for n in range(3):
        result = identity_app[1].post("/api/auth/login", json={"identifier": identifiers[n % 3], "password": "incorrect"})
        assert result.status_code == (429 if n == 2 else 401)
    assert identity_app[1].post(
        "/api/auth/login",
        json={"identifier": "NewMember", "password": "SignupPassword9!"},
    ).status_code == 429


def test_successful_login_resets_consecutive_failed_attempts(identity_app):
    register(identity_app)
    for _ in range(2):
        assert identity_app[1].post(
            "/api/auth/login",
            json={"identifier": "NewMember", "password": "incorrect"},
        ).status_code == 401
    assert identity_app[1].post(
        "/api/auth/login",
        json={"identifier": "NewMember", "password": "SignupPassword9!"},
    ).status_code == 200
    assert identity_app[1].post(
        "/api/auth/login",
        json={"identifier": "NewMember", "password": "incorrect"},
    ).status_code == 401


def test_a_shared_proxy_does_not_block_a_different_users_first_login(identity_app):
    register(identity_app)
    for n in range(3):
        result = identity_app[1].post(
            "/api/auth/login",
            json={"identifier": "NewMember", "password": f"wrong-{n}"},
        )
        assert result.status_code == (429 if n == 2 else 401)
    # The test client uses one shared source IP; a different account must not
    # inherit the first account's failed-password counter.
    result = identity_app[1].post(
        "/api/auth/login",
        json={"identifier": "legacy@example.com", "password": "LegacyPass9!"},
    )
    assert result.status_code == 200


def test_email_login_is_not_confused_by_same_value_in_another_users_username(identity_app):
    run(identity_app[0].state.db.users.insert_one({
        "id": "email-like-username", "username": "legacy@example.com",
        "email": "other@example.com", "phone": "+22890000001",
        "role": "user", "status": "active", "max_level": 1,
        "password_hash": hash_password("OtherPass9!"),
    }))
    result = identity_app[1].post(
        "/api/auth/login",
        json={"identifier": "legacy@example.com", "password": "LegacyPass9!"},
    )
    assert result.status_code == 200
    assert result.json()["user"]["id"] == "legacy"
