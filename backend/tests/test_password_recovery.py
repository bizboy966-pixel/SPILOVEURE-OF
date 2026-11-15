"""Password recovery tests: synthetic accounts and fake mail only."""
from datetime import timedelta

import pytest

from auth import create_access_token, create_pwd_confirm_token, hash_password, verify_password, require_pwd_confirm
from fastapi import HTTPException
from identity_core import digest, now
from test_identity import identity_app, run


@pytest.fixture
def recovery(identity_app):
    app, client = identity_app
    app.state.email_sender.send_password_reset = app.state.email_sender.send_verification
    return app, client


def request_code(pair, email="legacy@example.com"):
    result = pair[1].post("/api/identity/password-reset/request", json={"email": email})
    assert result.status_code == 202, result.text
    return result.json()["challenge_id"]


def confirm(pair, challenge, code=None, **extra):
    code = code if code is not None else pair[0].state.email_sender.messages[-1][1]
    return pair[1].post("/api/identity/password-reset/confirm", json={
        "challenge_id": challenge, "code": code, "password": "NewStrongPass8!",
        "password_confirm": "NewStrongPass8!", **extra,
    })


def test_recovery_resets_password_revokes_sessions_and_preserves_account(recovery):
    app, client = recovery
    before = run(app.state.db.users.find_one({"id": "legacy"}))
    old_token = create_access_token("legacy", "user")
    assert client.get("/api/test/protected", headers={"Authorization": "Bearer " + old_token}).status_code == 200
    run(app.state.db.identity_chat_sessions.insert_one({"id": "old-session", "user_id": "legacy", "revoked": False}))
    challenge = request_code(recovery)
    row = run(app.state.db.identity_password_resets.find_one({"id": challenge}))
    code = app.state.email_sender.messages[-1][1]
    assert code not in row.values()
    result = confirm(recovery, challenge)
    assert result.status_code == 200
    assert result.json() == {"ok": True}
    assert "no-store" in result.headers["cache-control"]
    assert "set-cookie" not in result.headers
    user = run(app.state.db.users.find_one({"id": "legacy"}))
    assert verify_password("NewStrongPass8!", user["password_hash"])
    assert not verify_password("LegacyPass9!", user["password_hash"])
    for field in ["balance_profit", "status", "max_level", "role", "username"]:
        assert user[field] == before[field]
    assert user["auth_version"] == 1
    assert run(app.state.db.identity_chat_sessions.find_one({"id": "old-session"}))["revoked"]
    assert client.get("/api/test/protected", headers={"Authorization": "Bearer " + old_token}).status_code == 401
    new_token = create_access_token("legacy", "user", auth_version=user["auth_version"])
    assert client.get("/api/test/protected", headers={"Authorization": "Bearer " + new_token}).status_code == 200
    assert client.get("/api/identity/state", headers={"Authorization": "Bearer " + old_token}).status_code == 401
    assert client.get("/api/identity/state", headers={"Authorization": "Bearer " + new_token}).status_code == 200
    with pytest.raises(HTTPException):
        run(require_pwd_confirm(user, create_pwd_confirm_token(user["id"])))
    assert run(require_pwd_confirm(user, create_pwd_confirm_token(user["id"], auth_version=1)))["id"] == "legacy"
    assert confirm(recovery, challenge).status_code == 400


def test_unknown_and_ambiguous_addresses_are_rejected_without_sending_a_code(recovery):
    known = request_code(recovery)
    messages = len(recovery[0].state.email_sender.messages)
    unknown = recovery[1].post("/api/identity/password-reset/request", json={"email": "unknown@example.com"})
    assert unknown.status_code == 400
    assert unknown.json()["detail"] == "ACCOUNT_EMAIL_INCORRECT"
    assert len(recovery[0].state.email_sender.messages) == messages
    assert run(recovery[0].state.db.identity_password_resets.count_documents({})) == 1
    assert known
    run(recovery[0].state.db.users.insert_one({
        "id": "duplicate", "email": "LEGACY@example.com", "password_hash": "not-a-real-hash",
    }))
    run(recovery[0].state.db.identity_rate_limits.delete_one({"_id": "reset-cooldown:" + digest("legacy@example.com")}))
    ambiguous = recovery[1].post("/api/identity/password-reset/request", json={"email": "legacy@example.com"})
    assert ambiguous.status_code == 400
    assert ambiguous.json()["detail"] == "ACCOUNT_EMAIL_INCORRECT"
    assert len(recovery[0].state.email_sender.messages) == messages


def test_recovery_cannot_create_a_password_before_onboarding_allows_it(recovery):
    app, _ = recovery
    run(app.state.db.users.update_one({"id": "legacy"}, {"$set": {
        "auth_flow_version": 2, "main_password_created": False, "status": "pending", "max_level": 0,
    }}))
    request_code(recovery)
    assert app.state.email_sender.messages == []
    assert run(app.state.db.users.find_one({"id": "legacy"}))["main_password_created"] is False


def test_expired_and_bruteforced_codes_fail(recovery):
    challenge = request_code(recovery)
    correct = recovery[0].state.email_sender.messages[-1][1]
    wrong = "111111" if correct != "111111" else "222222"
    for _ in range(5):
        assert confirm(recovery, challenge, wrong).status_code == 400
    assert confirm(recovery, challenge, correct).status_code == 400
    run(recovery[0].state.db.identity_password_resets.update_one({"id": challenge}, {
        "$set": {"attempts": 0, "expires_at": now() - timedelta(seconds=1)},
    }))
    assert confirm(recovery, challenge, correct).status_code == 400


def test_validation_and_origin_protection(recovery):
    assert recovery[1].post("/api/identity/password-reset/request", json={"email": "invalid"}).status_code == 422
    assert recovery[1].post("/api/identity/password-reset/request", json={"email": "legacy@example.com"},
        headers={"Origin": "https://evil.example"}).status_code == 403
    challenge = request_code(recovery)
    assert confirm(recovery, challenge, password_confirm="DoesNotMatch9").status_code == 400
    assert confirm(recovery, challenge, password="short").status_code == 422
    assert confirm(recovery, challenge, password="é" * 40, password_confirm="é" * 40).status_code == 422
    assert confirm(recovery, challenge).status_code == 200


def test_resend_cooldown_supersedes_old_code(recovery):
    first = request_code(recovery)
    first_code = recovery[0].state.email_sender.messages[-1][1]
    assert recovery[1].post("/api/identity/password-reset/request", json={"email": "legacy@example.com"}).status_code == 429
    run(recovery[0].state.db.identity_rate_limits.delete_one({"_id": "reset-cooldown:" + digest("legacy@example.com")}))
    second = request_code(recovery)
    assert confirm(recovery, first, first_code).status_code == 400
    assert confirm(recovery, second).status_code == 200


@pytest.mark.parametrize("change", [
    {"email": "changed@example.com"}, {"status": "banned"},
    {"password_hash": hash_password("ChangedOutsideRecovery9")},
])
def test_changed_account_cannot_use_an_old_code(recovery, change):
    challenge = request_code(recovery)
    run(recovery[0].state.db.users.update_one({"id": "legacy"}, {"$set": change}))
    assert confirm(recovery, challenge).status_code == 400


def test_email_verification_codes_cannot_reset_password_and_vice_versa(recovery):
    challenge = request_code(recovery)
    code = recovery[0].state.email_sender.messages[-1][1]
    assert recovery[1].post("/api/identity/email/verify", json={"challenge_id": challenge, "code": code}).status_code == 400
    result = recovery[1].post("/api/identity/email/request", json={"email": "legacy@example.com"})
    assert result.status_code == 202
    assert confirm(recovery, result.json()["challenge_id"]).status_code == 400
    assert confirm(recovery, challenge, code).status_code == 200


def test_delivery_failure_is_explicit_and_code_cannot_be_used(recovery):
    def fail(*args):
        raise RuntimeError("never expose provider internals")
    recovery[0].state.email_sender.send_password_reset = fail
    result = recovery[1].post("/api/identity/password-reset/request", json={"email": "legacy@example.com"})
    assert result.status_code == 503
    assert "provider internals" not in result.text
    row = run(recovery[0].state.db.identity_password_resets.find_one({}))
    assert row["status"] == "failed"
    assert confirm(recovery, row["id"], "000000").status_code == 400


def test_reset_mail_uses_existing_transactional_delivery(monkeypatch):
    from email_delivery import VerificationEmailSender
    sent = []
    monkeypatch.setattr(VerificationEmailSender, "_send_message", lambda self, recipient, subject, text: sent.append((recipient, subject, text)))
    sender = VerificationEmailSender()
    sender.send_verification("test@example.com", "111111")
    sender.send_password_reset("test@example.com", "222222")
    assert len(sent) == 2
    assert "réinitialisation" in sent[1][1].lower()
    assert "222222" in sent[1][2] and "111111" not in sent[1][2]
