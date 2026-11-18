"""Identity state/security tests. No real email, payment or production database."""
import asyncio
from datetime import timedelta

import jwt
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from auth import JWT_SECRET, create_access_token, get_current_user, hash_password, verify_password
from identity import register_account, router
from identity_core import COOKIE, device_label, digest, initialize, now, touch_chat_session
from messenger import api as messenger_router
from messenger_core import initialize as initialize_chat
from models import LoginIn, RegisterIn
from account_login import login_account


class Outbox:
    def __init__(self):
        self.messages = []

    def configured(self):
        return True

    def send_verification(self, recipient, code):
        self.messages.append((recipient, code))


@pytest.fixture
def identity_app():
    app = FastAPI()
    app.state.db = AsyncMongoMockClient(tz_aware=True).identity_tests
    app.state.email_sender = Outbox()
    app.include_router(router)
    app.include_router(messenger_router)

    @app.post("/api/auth/register")
    async def register(data: RegisterIn, request: Request):
        return await register_account(data, request)

    @app.post("/api/auth/login")
    async def login(data: LoginIn, request: Request):
        return await login_account(data, request)

    @app.get("/api/auth/me")
    @app.get("/api/test/protected")
    async def protected(user=Depends(get_current_user)):
        return user

    @app.get("/api/payments/ref/status")
    async def payment_status(user=Depends(get_current_user)):
        return {"owner": user["id"], "status": "pending"}

    async def seed():
        await initialize(app.state.db)
        await initialize_chat(app.state.db)
        await app.state.db.users.insert_one({
            "id": "legacy", "username": "Sponsor", "email": "legacy@example.com",
            "phone": "+22890000000", "country": "TG", "status": "active",
            "max_level": 1, "role": "user", "password_hash": hash_password("LegacyPass9!"),
            "balance_profit": 12345,
        })
        await app.state.db.chat_messages.insert_one({"id": "support", "text": "untouched"})
    asyncio.run(seed())
    with TestClient(app) as client:
        yield app, client


def run(awaitable):
    return asyncio.run(awaitable)


def register(pair, **fields):
    payload = {
        "username": "NewMember", "email": "new@example.com", "country": "TG",
        "phone": "+22891111111", "sponsor_username": "Sponsor", "accept_terms": True,
        "password": "SignupPassword9!", "password_confirm": "SignupPassword9!",
        **fields,
    }
    return pair[1].post("/api/auth/register", json=payload)


def test_default_sponsor_uses_official_admin(identity_app, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "official@example.com")
    asyncio.run(identity_app[0].state.db.users.insert_one({
        "id": "official-admin", "username": "OfficialAdmin", "email": "official@example.com",
        "role": "admin", "status": "active",
    }))
    client = identity_app[1]
    resolved = client.get("/api/identity/registration-sponsor").json()
    assert resolved == {"username": "OfficialAdmin", "source": "official"}
    result = register(identity_app, sponsor_username=None)
    assert result.status_code == 200
    row = asyncio.run(identity_app[0].state.db.users.find_one({"id": result.json()["user"]["id"]}))
    assert row["sponsor_id"] == "official-admin"
    assert row["sponsor_username"] == "OfficialAdmin"


def test_default_sponsor_omitted_and_blank(identity_app, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "legacy@example.com")
    asyncio.run(identity_app[0].state.db.users.update_one({"id": "legacy"}, {"$set": {"role": "admin"}}))
    for index, code in enumerate(["", "   ", None]):
        assert register(identity_app, username=f"NoRef{index}", email=f"no-ref-{index}@example.com",
                        sponsor_username=code).status_code == 200
    payload = {"username": "OmittedRef", "email": "omitted@example.com", "country": "TG",
               "phone": "+22891111111", "accept_terms": True,
               "password": "SignupPassword9!", "password_confirm": "SignupPassword9!"}
    assert identity_app[1].post("/api/auth/register", json=payload).status_code == 200


def test_invitation_not_replaced_or_silently_corrected(identity_app, monkeypatch):
    # Even an unavailable official administrator must not affect a valid invitation.
    monkeypatch.setenv("ADMIN_EMAIL", "missing-admin@example.com")
    assert identity_app[1].get("/api/identity/registration-sponsor?ref=Sponsor").json() == {
        "username": "Sponsor", "source": "invitation",
    }
    assert register(identity_app).status_code == 200
    assert register(identity_app, username="OtherMember", email="other-ref@example.com",
                    sponsor_username="MissingSponsor").status_code == 400
    # Repeating registration with a different sponsor cannot reassign the account.
    assert register(identity_app, sponsor_username=None).status_code == 503
    row = asyncio.run(identity_app[0].state.db.users.find_one({"username": "NewMember"}))
    assert row["sponsor_id"] == "legacy"


def test_default_sponsor_unavailable_fails_explicitly(identity_app, monkeypatch):
    monkeypatch.delenv("ADMIN_EMAIL", raising=False)
    assert identity_app[1].get("/api/identity/registration-sponsor").status_code == 503
    assert register(identity_app, sponsor_username=None).status_code == 503
    monkeypatch.setenv("ADMIN_EMAIL", "legacy@example.com")
    # A normal member cannot become the official admin solely by matching an email.
    assert register(identity_app, sponsor_username=None).status_code == 503


def main_header(token):
    return {"Authorization": "Bearer " + token}


def verify(pair, token=None, email="new@example.com", client=None):
    app, default = pair
    client = client or default
    headers = main_header(token) if token else {}
    requested = client.post("/api/identity/email/request", json={"email": email}, headers=headers)
    assert requested.status_code == 202, requested.text
    code = app.state.email_sender.messages[-1][1]
    result = client.post("/api/identity/email/verify", json={
        "challenge_id": requested.json()["challenge_id"], "code": code,
    })
    assert result.status_code == 200, result.text
    return requested.json(), code, result.json()


def activate(pair, uid):
    run(pair[0].state.db.users.update_one({"id": uid}, {"$set": {"status": "active", "max_level": 1}}))


def test_registration_creates_password_without_bypassing_referral_or_activation(identity_app):
    from identity_policy import onboarding_path_allowed
    assert onboarding_path_allowed("/api/settings/activation-videos", "GET")
    assert not onboarding_path_allowed("/api/settings/activation-videos", "POST")
    response = register(identity_app)
    assert response.status_code == 200
    data = response.json()
    user = run(identity_app[0].state.db.users.find_one({"id": data["user"]["id"]}))
    assert user["sponsor_id"] == "legacy" and user["country"] == "TG"
    assert user["email_verified"] is False and user["main_password_created"] is True
    assert verify_password("SignupPassword9!", user["password_hash"])
    assert "password_hash" not in data["user"] and "password" not in user
    headers = main_header(data["access_token"])
    assert identity_app[1].get("/api/auth/me", headers=headers).status_code == 200
    assert identity_app[1].get("/api/test/protected", headers=headers).status_code == 403
    assert identity_app[1].get("/api/payments/ref/status", headers=headers).json()["status"] == "pending"
    assert identity_app[1].get("/api/messenger/conversations", headers=headers).status_code == 401


def test_duplicate_email_username_and_invalid_referral(identity_app):
    assert register(identity_app).status_code == 200
    assert register(identity_app, email="NEW@example.com", username="OtherName").status_code == 409
    assert register(identity_app, email="different@example.com", username="newmember").status_code == 409
    assert register(identity_app, email="other@example.com", username="OtherName", sponsor_username="Nobody").status_code == 400
    assert register(identity_app, email="invalid").status_code == 422
    assert register(identity_app, email="other@example.com", username="OtherName", accept_terms=False).status_code == 400


def test_verification_opens_chat_without_activation_and_is_single_use(identity_app):
    data = register(identity_app).json()
    challenge, code, state = verify(identity_app, data["access_token"])
    assert state["chat_authenticated"] and not state["activated"]
    assert identity_app[1].get("/api/messenger/conversations").json() == []
    again = identity_app[1].post("/api/identity/email/verify", json={"challenge_id": challenge["challenge_id"], "code": code})
    assert again.status_code == 400
    user = run(identity_app[0].state.db.users.find_one({"id": data["user"]["id"]}))
    assert user["email_verified"] is True and user["status"] == "pending"
    assert user["max_level"] == 0 and user["main_password_created"] is True
    row = run(identity_app[0].state.db.identity_email_codes.find_one({"id": challenge["challenge_id"]}))
    assert row["used"] and row["code_digest"] != code
    assert "code" not in row
    cookie = identity_app[1].cookies.get(COOKIE)
    session = run(identity_app[0].state.db.identity_chat_sessions.find_one({"user_id": user["id"]}))
    assert session["digest"] != cookie and "secret" not in session


def test_codes_expire_are_attempt_limited_and_cannot_be_resent_immediately(identity_app):
    data = register(identity_app).json()
    headers = main_header(data["access_token"])
    requested = identity_app[1].post("/api/identity/email/request", json={}, headers=headers).json()
    assert identity_app[1].post("/api/identity/email/request", json={}, headers=headers).status_code == 429
    actual = identity_app[0].state.email_sender.messages[-1][1]
    wrong = "999999" if actual != "999999" else "000000"
    for _ in range(5):
        assert identity_app[1].post("/api/identity/email/verify", json={
            "challenge_id": requested["challenge_id"], "code": wrong,
        }).status_code == 400
    assert identity_app[1].post("/api/identity/email/verify", json={
        "challenge_id": requested["challenge_id"], "code": actual,
    }).status_code == 400
    run(identity_app[0].state.db.identity_email_codes.update_one(
        {"id": requested["challenge_id"]}, {"$set": {"attempts": 0, "expires_at": now() - timedelta(seconds=1)}}))
    assert identity_app[1].post("/api/identity/email/verify", json={
        "challenge_id": requested["challenge_id"], "code": actual,
    }).status_code == 400


def test_unknown_email_is_neutral_and_never_associated(identity_app):
    client = identity_app[1]
    result = client.post("/api/identity/email/request", json={"email": "unknown@example.com"})
    assert result.status_code == 202
    assert identity_app[0].state.email_sender.messages == []
    assert client.post("/api/identity/email/verify", json={
        "challenge_id": result.json()["challenge_id"], "code": "000000",
    }).status_code == 400
    assert run(identity_app[0].state.db.users.count_documents({})) == 1


def test_email_sender_failure_is_explicit(identity_app):
    register(identity_app)
    identity_app[0].state.email_sender.configured = lambda: False
    result = identity_app[1].post("/api/identity/email/request", json={"email": "new@example.com"})
    assert result.status_code == 503
    assert identity_app[0].state.email_sender.messages == []
    assert run(identity_app[0].state.db.identity_email_codes.count_documents({})) == 0


def test_registration_is_paused_before_payment_if_mail_unavailable(identity_app):
    identity_app[0].state.email_sender.configured = lambda: False
    assert register(identity_app).status_code == 503
    assert run(identity_app[0].state.db.users.count_documents({})) == 1


def test_mismatched_email_cannot_be_associated(identity_app):
    data = register(identity_app).json()
    result = identity_app[1].post("/api/identity/email/request", json={"email": "legacy@example.com"},
                                  headers=main_header(data["access_token"]))
    assert result.status_code == 400 and not identity_app[0].state.email_sender.messages


def test_legacy_passwordless_account_can_set_password_only_after_activation_and_once(identity_app):
    data = register(identity_app).json()
    run(identity_app[0].state.db.users.update_one({"id": data["user"]["id"]},
        {"$unset": {"password_hash": "", "password_created_at": ""}, "$set": {"main_password_created": False}}))
    verify(identity_app, data["access_token"])
    body = {"password": "NewPassword9!", "password_confirm": "NewPassword9!"}
    client = identity_app[1]
    assert client.post("/api/identity/password", json=body).status_code == 403
    # A payment status request or success-shaped URL never activates the user.
    assert client.get("/api/payments/ref/status", headers=main_header(data["access_token"])).status_code == 200
    assert client.post("/api/identity/password", json=body).status_code == 403
    activate(identity_app, data["user"]["id"])
    assert client.post("/api/identity/password", json={**body, "password_confirm": "wrong"}).status_code == 400
    created = client.post("/api/identity/password", json=body)
    assert created.status_code == 200
    assert client.get("/api/test/protected", headers=main_header(created.json()["access_token"])).status_code == 200
    assert client.post("/api/identity/password", json=body).status_code == 409
    assert client.get("/api/test/protected", headers=main_header(data["access_token"])).status_code == 200


def test_activated_unverified_account_can_use_main_platform_but_not_chat(identity_app):
    data = register(identity_app).json()
    activate(identity_app, data["user"]["id"])
    client = identity_app[1]
    headers = main_header(data["access_token"])
    assert client.get("/api/test/protected", headers=headers).status_code == 200
    assert client.post("/api/identity/chat/open", headers=headers).status_code == 403
    assert client.get("/api/identity/chat/session").status_code == 401


def test_named_preview_test_account_can_open_chat_without_verifying_email(identity_app, monkeypatch):
    app, client = identity_app
    monkeypatch.setenv("SPV_ISOLATED_CHAT_PREVIEW", "1")
    monkeypatch.setenv("SPV_PREVIEW_MODE", "isolated")
    monkeypatch.setenv("DB_NAME", "spiloveure_local_development")
    monkeypatch.setenv("MONGO_URL", "mongodb://127.0.0.1:27017")
    user = {
        "id": "preview-test-user", "username": "preview_test_b02606",
        "email": "preview-test@example.com", "phone": "+22891112222",
        "country": "TG", "status": "active", "max_level": 1, "role": "user",
        "password_hash": hash_password("PreviewPassword9!"), "email_verified": False,
        "preview_test_account": True,
    }
    asyncio.run(app.state.db.users.insert_one(user))
    headers = main_header(create_access_token(user["id"], "user"))

    state = client.get("/api/identity/state", headers=headers).json()
    assert state["email_verified"] is False
    assert state["chat_access_allowed"] is True
    assert client.post("/api/identity/chat/open", headers=headers).status_code == 200
    assert client.get("/api/identity/chat/session").status_code == 200

    unchanged = asyncio.run(app.state.db.users.find_one({"id": user["id"]}))
    assert unchanged["email_verified"] is False


def test_preview_chat_bypass_is_unavailable_outside_isolated_environment(identity_app, monkeypatch):
    app, client = identity_app
    monkeypatch.delenv("SPV_ISOLATED_CHAT_PREVIEW", raising=False)
    monkeypatch.delenv("SPV_PREVIEW_MODE", raising=False)
    monkeypatch.delenv("DB_NAME", raising=False)
    monkeypatch.delenv("MONGO_URL", raising=False)
    user = {
        "id": "preview-test-outside", "username": "preview_test_b02606",
        "email": "preview-test-outside@example.com", "phone": "+22891114444",
        "country": "TG", "status": "active", "max_level": 1, "role": "user",
        "password_hash": hash_password("PreviewPassword9!"), "email_verified": False,
        "preview_test_account": True,
    }
    asyncio.run(app.state.db.users.insert_one(user))
    headers = main_header(create_access_token(user["id"], "user"))

    assert client.post("/api/identity/chat/open", headers=headers).status_code == 403
    assert client.post("/api/identity/preview/chat/open").status_code == 404


def test_only_exact_marked_preview_account_can_bypass_chat_email_verification(identity_app, monkeypatch):
    app, client = identity_app
    monkeypatch.setenv("SPV_ISOLATED_CHAT_PREVIEW", "1")
    monkeypatch.setenv("SPV_PREVIEW_MODE", "isolated")
    monkeypatch.setenv("DB_NAME", "spiloveure_local_development")
    monkeypatch.setenv("MONGO_URL", "mongodb://127.0.0.1:27017")
    user = {
        "id": "other-preview-user", "username": "preview_test_b02606_other",
        "email": "other-preview@example.com", "phone": "+22891113333",
        "country": "TG", "status": "active", "max_level": 1, "role": "user",
        "password_hash": hash_password("PreviewPassword9!"), "email_verified": False,
        "preview_test_account": True,
    }
    asyncio.run(app.state.db.users.insert_one(user))
    headers = main_header(create_access_token(user["id"], "user"))

    state = client.get("/api/identity/state", headers=headers).json()
    assert state["email_verified"] is False
    assert state["chat_access_allowed"] is False
    assert client.post("/api/identity/chat/open", headers=headers).status_code == 403
    assert client.get("/api/identity/chat/session").status_code == 401


def test_isolated_preview_entry_opens_only_the_seeded_demo_account(identity_app, monkeypatch):
    app, client = identity_app
    monkeypatch.setenv("SPV_ISOLATED_CHAT_PREVIEW", "1")
    monkeypatch.setenv("SPV_PREVIEW_MODE", "isolated")
    monkeypatch.setenv("DB_NAME", "spiloveure_local_development")
    monkeypatch.setenv("MONGO_URL", "mongodb://127.0.0.1:27017")
    asyncio.run(app.state.db.users.insert_one({
        "id": "preview-test-entry", "username": "preview_test_b02606",
        "email": "preview-entry@example.test", "phone": "00000000", "country": "TG",
        "status": "active", "max_level": 1, "role": "user", "email_verified": False,
        "preview_test_account": True,
    }))

    opened = client.post("/api/identity/preview/chat/open")
    assert opened.status_code == 200
    assert opened.json()["user"]["id"] == "preview-test-entry"
    assert opened.json()["email_verified"] is False
    assert client.get("/api/identity/chat/session").status_code == 200


def test_main_expiry_does_not_expire_chat_and_unlock_needs_only_password(identity_app):
    data = register(identity_app).json()
    verify(identity_app, data["access_token"])
    activate(identity_app, data["user"]["id"])
    client = identity_app[1]
    password = {"password": "SignupPassword9!"}
    assert client.post("/api/identity/password", json={**password, "password_confirm": password["password"]}).status_code == 409
    expired = jwt.encode({"sub": data["user"]["id"], "type": "access", "exp": now() - timedelta(seconds=1)},
                         JWT_SECRET, algorithm="HS256")
    client.headers.update(main_header(expired))
    assert client.get("/api/test/protected").status_code == 401
    assert client.get("/api/messenger/conversations").status_code == 200
    assert client.get("/api/identity/chat/session").status_code == 200
    assert client.post("/api/identity/unlock?source=chat", json={"password": "incorrect"}).status_code == 401
    unlocked = client.post("/api/identity/unlock?source=chat", json={"password": password["password"]})
    assert unlocked.status_code == 200
    assert client.get("/api/test/protected", headers=main_header(unlocked.json()["access_token"])).status_code == 200
    assert len(identity_app[0].state.email_sender.messages) == 1


def test_pending_chat_can_resume_only_payment(identity_app):
    data = register(identity_app).json()
    verify(identity_app, data["access_token"])
    result = identity_app[1].post("/api/identity/onboarding-session?source=chat")
    assert result.status_code == 200
    headers = main_header(result.json()["access_token"])
    assert identity_app[1].get("/api/payments/ref/status", headers=headers).status_code == 200
    assert identity_app[1].get("/api/test/protected", headers=headers).status_code == 403
    activate(identity_app, data["user"]["id"])
    assert identity_app[1].get("/api/test/protected", headers=headers).status_code == 200


def test_legacy_password_unchanged_and_verification_not_required_twice(identity_app):
    client = identity_app[1]
    headers = main_header(create_access_token("legacy", "user"))
    assert client.get("/api/test/protected", headers=headers).status_code == 200
    before = run(identity_app[0].state.db.users.find_one({"id": "legacy"}))
    assert client.post("/api/identity/chat/open", headers=headers).status_code == 403
    verify(identity_app, email="legacy@example.com", token=create_access_token("legacy", "user"))
    assert client.post("/api/identity/chat/logout").status_code == 200
    assert client.post("/api/identity/chat/open", headers=headers).status_code == 200
    assert len(identity_app[0].state.email_sender.messages) == 1
    after = run(identity_app[0].state.db.users.find_one({"id": "legacy"}))
    assert after["password_hash"] == before["password_hash"]
    assert after["balance_profit"] == before["balance_profit"]
    unlocked = client.post("/api/identity/unlock?source=chat", json={"password": "LegacyPass9!"})
    assert unlocked.json()["user"]["balance_profit"] == before["balance_profit"]
    assert run(identity_app[0].state.db.chat_messages.find_one({"id": "support"}))["text"] == "untouched"


def test_revocation_and_chat_logout_do_not_revoke_main(identity_app):
    headers = main_header(create_access_token("legacy", "user"))
    verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    client = identity_app[1]
    sessions = client.get("/api/identity/chat/sessions").json()
    assert sessions[0]["current"] and "digest" not in sessions[0]
    assert client.delete("/api/identity/chat/sessions/not-mine").status_code == 404
    assert client.delete("/api/identity/chat/sessions/" + sessions[0]["id"]).status_code == 200
    assert client.get("/api/messenger/conversations").status_code == 401
    assert client.get("/api/test/protected", headers=headers).status_code == 200
    assert client.post("/api/identity/chat/logout").status_code == 200


def test_chat_device_list_excludes_inactive_revoked_and_expired_sessions(identity_app):
    verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    db, client = identity_app[0].state.db, identity_app[1]
    current = run(db.identity_chat_sessions.find_one({"user_id": "legacy"}))
    timestamp = now()
    active = {
        "id": "active-other-device", "digest": digest("active-other-device-secret"),
        "user_id": "legacy", "email_digest": digest("legacy@example.com"),
        "device": "Autre appareil actif", "created_at": timestamp - timedelta(hours=1),
        "last_seen": timestamp - timedelta(seconds=45),
        "expires_at": timestamp + timedelta(days=10),
        "absolute_expires_at": timestamp + timedelta(days=60), "revoked": False,
    }
    inactive = {
        **active, "id": "inactive-device", "digest": digest("inactive-device-secret"),
        "device": "Ancien appareil inactif", "last_seen": timestamp - timedelta(minutes=5),
    }
    revoked = {
        **active, "id": "revoked-device", "digest": digest("revoked-device-secret"),
        "device": "Appareil déconnecté", "revoked": True,
    }
    expired = {
        **active, "id": "expired-device", "digest": digest("expired-device-secret"),
        "device": "Appareil expiré", "expires_at": timestamp - timedelta(seconds=1),
    }
    run(db.identity_chat_sessions.insert_many([active, inactive, revoked, expired]))

    response = client.get("/api/identity/chat/sessions")

    assert response.status_code == 200
    sessions = response.json()
    assert {session["id"] for session in sessions} == {current["id"], active["id"]}
    assert next(session for session in sessions if session["id"] == current["id"])["current"] is True
    assert next(session for session in sessions if session["id"] == active["id"])["current"] is False
    assert all("digest" not in session for session in sessions)


@pytest.mark.parametrize(("user_agent", "expected"), [
    ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
     "Android · Chrome"),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
     "iPhone · Safari"),
    ("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1",
     "iPad · Chrome"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/131.0.0.0",
     "Windows · Edge"),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
     "Mac · Safari"),
    ("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
     "Linux · Firefox"),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/122.0.0.0 Safari/537.36",
     "Linux · Samsung Internet"),
    ("Mozilla/5.0 (UnknownOS; UnknownDevice) UnknownBrowser/1.0",
     "Appareil inconnu · Navigateur inconnu"),
    ("UnknownBrowser/1.0", "Appareil inconnu · Navigateur inconnu"),
    ("MysteryDevice", "Appareil inconnu · Navigateur inconnu"),
    ("", "Appareil inconnu · Navigateur inconnu"),
])
def test_device_label_recognizes_common_platforms_and_falls_back(user_agent, expected):
    assert device_label(user_agent) == expected


def test_chat_sessions_format_legacy_user_agents_without_changing_revocation_target(identity_app):
    verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    db, client = identity_app[0].state.db, identity_app[1]
    current = run(db.identity_chat_sessions.find_one({"user_id": "legacy"}))
    timestamp = now()
    other = {
        "id": "legacy-android-session", "digest": digest("legacy-android-secret"),
        "user_id": "legacy", "email_digest": digest("legacy@example.com"),
        "device": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
        "created_at": timestamp - timedelta(minutes=1), "last_seen": timestamp,
        "expires_at": timestamp + timedelta(days=10),
        "absolute_expires_at": timestamp + timedelta(days=60), "revoked": False,
    }
    run(db.identity_chat_sessions.insert_one(other))

    sessions = client.get("/api/identity/chat/sessions").json()

    labeled = next(session for session in sessions if session["id"] == other["id"])
    assert labeled["device"] == "Android · Chrome"
    assert client.delete(f"/api/identity/chat/sessions/{other['id']}").status_code == 200
    assert run(db.identity_chat_sessions.find_one({"id": other["id"]}))["revoked"] is True
    assert run(db.identity_chat_sessions.find_one({"id": current["id"]}))["revoked"] is False


def test_chat_session_heartbeat_refreshes_only_valid_session(identity_app):
    verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    db = identity_app[0].state.db
    session = run(db.identity_chat_sessions.find_one({"user_id": "legacy"}))
    stale = now() - timedelta(minutes=5)
    run(db.identity_chat_sessions.update_one({"id": session["id"]}, {"$set": {"last_seen": stale}}))

    refreshed = run(touch_chat_session(db, session["id"]))
    row = run(db.identity_chat_sessions.find_one({"id": session["id"]}))
    assert refreshed.modified_count == 1
    assert row["last_seen"] > stale

    run(db.identity_chat_sessions.update_one({"id": session["id"]}, {"$set": {"revoked": True}}))
    revoked_touch = run(touch_chat_session(db, session["id"]))
    assert revoked_touch.matched_count == 0


def test_expired_and_banned_chat_sessions_are_refused(identity_app):
    verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    db, client = identity_app[0].state.db, identity_app[1]
    run(db.identity_chat_sessions.update_many({}, {"$set": {"expires_at": now() - timedelta(seconds=1)}}))
    assert client.get("/api/messenger/conversations").status_code == 401
    run(db.identity_chat_sessions.update_many({}, {"$set": {"expires_at": now() + timedelta(days=1)}}))
    run(db.users.update_one({"id": "legacy"}, {"$set": {"status": "banned"}}))
    assert client.get("/api/messenger/conversations").status_code == 401


def test_csrf_cookie_security_and_cookie_is_not_main_auth(identity_app):
    _, _, state = verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    client = identity_app[1]
    assert state["chat_authenticated"]
    assert client.get("/api/test/protected").status_code == 401
    assert client.post("/api/identity/chat/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/messenger/conversations", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/identity/chat/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/api/identity/chat/session").headers["cache-control"] == "no-store, private"


def test_registered_email_verification_on_another_device_does_not_grant_attacker_access(identity_app):
    data = register(identity_app).json()
    run(identity_app[0].state.db.users.update_one({"id": data["user"]["id"]},
        {"$unset": {"password_hash": "", "password_created_at": ""}, "$set": {"main_password_created": False}}))
    app, attacker = identity_app
    with TestClient(app) as owner:
        verify(identity_app, client=owner)
        activate(identity_app, data["user"]["id"])
        headers = main_header(data["access_token"])
        assert attacker.post("/api/identity/chat/open", headers=headers).status_code == 403
        body = {"password": "OwnerPassword9!", "password_confirm": "OwnerPassword9!"}
        assert attacker.post("/api/identity/password", json=body, headers=headers).status_code == 403
        assert owner.post("/api/identity/password?source=chat", json=body).status_code == 200
        assert attacker.get("/api/test/protected", headers=headers).status_code == 200
        assert attacker.post("/api/identity/chat/open", headers=headers).status_code == 403


def test_source_chat_never_unlocks_a_different_main_account(identity_app):
    data = register(identity_app).json()
    verify(identity_app, data["access_token"])
    client = identity_app[1]
    client.headers.update(main_header(create_access_token("legacy", "user")))
    assert client.get("/api/identity/state").json()["user"]["id"] == "legacy"
    assert client.get("/api/identity/state?source=chat").json()["user"]["id"] == data["user"]["id"]
    assert client.post("/api/identity/email/request?source=chat", json={"email": "legacy@example.com"}).status_code == 400
    assert client.post("/api/identity/unlock?source=chat", json={"password": "LegacyPass9!"}).status_code == 403


def test_cookie_renewal_handles_production_motor_naive_utc_dates(identity_app):
    verify(identity_app, token=create_access_token("legacy", "user"), email="legacy@example.com")
    from identity_core import renew_chat
    from fastapi import Response
    request = Request({"type": "http", "method": "GET", "scheme": "https",
                       "path": "/api/identity/chat/session",
                       "headers": [(b"host", b"spiloveure.org"),
                                   (b"cookie", (COOKIE + "=" + identity_app[1].cookies.get(COOKIE)).encode())],
                       "app": identity_app[0], "query_string": b""})
    row = run(identity_app[0].state.db.identity_chat_sessions.find_one({}))
    row["absolute_expires_at"] = row["absolute_expires_at"].replace(tzinfo=None)
    response = Response()
    run(renew_chat(request, response, row))
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]


def test_chat_push_registration_is_independent_and_revoked_with_device(identity_app):
    data = register(identity_app).json()
    verify(identity_app, data["access_token"])
    client, db = identity_app[1], identity_app[0].state.db
    body = {"token": "fake-browser-token-for-tests-only", "device_id": "test-device-identity", "platform": "web"}
    assert client.post("/api/identity/chat/push-token", json=body).status_code == 200
    record = run(db.push_tokens.find_one({"device_id": body["device_id"]}))
    assert record["user_id"] == data["user"]["id"] and record["chat_session_id"]
    run(db.push_tokens.insert_one({"user_id": "legacy", "device_id": "old-main-device", "token": "old-main-token"}))
    assert client.post("/api/identity/chat/logout").status_code == 200
    assert run(db.push_tokens.count_documents({"chat_session_id": record["chat_session_id"]})) == 0
    assert run(db.push_tokens.count_documents({"device_id": "old-main-device"})) == 1
    assert client.post("/api/identity/chat/push-token", json=body).status_code == 401


def test_resend_supersedes_previous_code_without_reusing_it(identity_app):
    data = register(identity_app).json()
    client, db = identity_app[1], identity_app[0].state.db
    headers = main_header(data["access_token"])
    first = client.post("/api/identity/email/request", json={}, headers=headers).json()
    old = identity_app[0].state.email_sender.messages[-1][1]
    run(db.identity_rate_limits.update_one({"_id": "cooldown:" + digest("new@example.com")},
                                         {"$set": {"next_at": now() - timedelta(seconds=1)}}))
    second = client.post("/api/identity/email/request", json={}, headers=headers).json()
    current = identity_app[0].state.email_sender.messages[-1][1]
    assert client.post("/api/identity/email/verify", json={"challenge_id": first["challenge_id"], "code": old}).status_code == 400
    assert client.post("/api/identity/email/verify", json={"challenge_id": second["challenge_id"], "code": current}).status_code == 200


def test_changed_email_does_not_inherit_verification(identity_app):
    token = create_access_token("legacy", "user")
    verify(identity_app, token=token, email="legacy@example.com")
    db, client = identity_app[0].state.db, identity_app[1]
    run(db.users.update_one({"id": "legacy"}, {"$set": {"email": "changed@example.com"}}))
    assert client.get("/api/messenger/conversations").status_code == 401
    assert client.get("/api/identity/state", headers=main_header(token)).json()["email_verified"] is False
    assert client.post("/api/identity/chat/open", headers=main_header(token)).status_code == 403
