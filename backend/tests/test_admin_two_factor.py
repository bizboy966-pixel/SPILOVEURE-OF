import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from mongomock_motor import AsyncMongoMockClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import auth as auth_module
import admin_two_factor as mfa
from auth import require_admin


def test_totp_matches_rfc6238_sha1_vector():
    # RFC 6238 Appendix B, SHA-1, 8-digit vector truncated to six digits.
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert mfa._totp_at(secret, 59) == "287082"
    assert mfa.verify_totp(secret, "287082", timestamp=59)
    assert not mfa.verify_totp(secret, "287083", timestamp=59)


def test_totp_accepts_only_the_current_30_second_window_and_adjacent_window():
    secret = mfa.generate_totp_secret()
    code = mfa._totp_at(secret, 1_700_000_000)
    assert mfa.verify_totp(secret, code, timestamp=1_700_000_000)
    assert mfa.verify_totp(secret, code, timestamp=1_700_000_029)
    assert not mfa.verify_totp(secret, "１２３４５６", timestamp=1_700_000_000)


def test_totp_secret_is_encrypted_and_requires_a_strong_signing_secret(monkeypatch):
    monkeypatch.setattr(mfa, "JWT_SECRET", "unit-test-signing-secret-that-is-long-enough-123")
    secret = mfa.generate_totp_secret()
    encrypted = mfa.encrypt_totp_secret(secret)
    assert secret not in encrypted
    assert mfa.decrypt_totp_secret(encrypted) == secret
    monkeypatch.setattr(mfa, "JWT_SECRET", "dev-secret")
    with pytest.raises(RuntimeError):
        mfa.encrypt_totp_secret(secret)


def test_backup_codes_are_random_hashed_and_single_use_candidates(monkeypatch):
    monkeypatch.setattr(mfa, "JWT_SECRET", "unit-test-signing-secret-that-is-long-enough-123")
    codes, hashes = mfa.generate_backup_codes()
    assert len(codes) == len(hashes) == 10
    assert len(set(codes)) == 10
    assert codes[0] not in hashes
    assert mfa._backup_digest(codes[0]) == hashes[0]
    assert mfa._backup_digest("code invalide") == ""


def test_step_up_token_is_bound_to_admin_and_expires(monkeypatch):
    monkeypatch.setattr(mfa, "JWT_SECRET", "unit-test-signing-secret-that-is-long-enough-123")
    monkeypatch.setattr(mfa, "JWT_ALGORITHM", "HS256")
    user = {"id": "admin-1", "auth_version": 3}
    token = mfa.create_step_up_token(user["id"], user["auth_version"])
    assert mfa.validate_step_up_token(token, user)
    assert not mfa.validate_step_up_token(token, {**user, "auth_version": 4})
    monkeypatch.setattr(mfa, "STEP_UP_SECONDS", -1)
    expired = mfa.create_step_up_token(user["id"], user["auth_version"])
    assert not mfa.validate_step_up_token(expired, user)


class _MfaCollection:
    async def find_one(self, *_args, **_kwargs):
        return {"totp_enabled": True}


def _request():
    db = SimpleNamespace(admin_mfa=_MfaCollection())
    app = SimpleNamespace(state=SimpleNamespace(db=db))
    return SimpleNamespace(app=app)


def test_admin_api_requires_mfa_enrollment_and_a_matching_step_up_token(monkeypatch):
    monkeypatch.setattr(mfa, "JWT_SECRET", "unit-test-signing-secret-that-is-long-enough-123")
    monkeypatch.setattr(mfa, "JWT_ALGORITHM", "HS256")
    monkeypatch.setattr(auth_module, "JWT_SECRET", "unit-test-signing-secret-that-is-long-enough-123")
    monkeypatch.setattr(auth_module, "JWT_ALGORITHM", "HS256")
    user = {"id": "admin-1", "role": "admin", "auth_version": 4}
    token = mfa.create_step_up_token(user["id"], user["auth_version"])
    assert asyncio.run(require_admin(_request(), user, token)) == user

    with pytest.raises(HTTPException) as missing:
        asyncio.run(require_admin(_request(), user, None))
    assert missing.value.status_code == 403
    assert missing.value.detail == "ADMIN_2FA_REQUIRED"

    other = mfa.create_step_up_token("admin-2", user["auth_version"])
    with pytest.raises(HTTPException) as mismatch:
        asyncio.run(require_admin(_request(), user, other))
    assert mismatch.value.detail == "ADMIN_2FA_REQUIRED"


def test_non_admin_never_passes_admin_gate():
    user = {"id": "user-1", "role": "user"}
    with pytest.raises(HTTPException) as denied:
        asyncio.run(require_admin(_request(), user, "anything"))
    assert denied.value.status_code == 403
    assert denied.value.detail == "Accès réservé à l’administrateur."


def test_router_exposes_authenticated_admin_two_factor_endpoints():
    app = FastAPI()
    app.include_router(mfa.router, prefix="/api")
    paths = {route.path for route in app.routes}
    assert {
        "/api/auth/admin-2fa/status",
        "/api/auth/admin-2fa/setup",
        "/api/auth/admin-2fa/confirm",
        "/api/auth/admin-2fa/verify",
    }.issubset(paths)


def test_full_enrollment_step_up_and_single_use_backup_flow(monkeypatch):
    strong_secret = "unit-test-signing-secret-that-is-long-enough-123"
    monkeypatch.setattr(mfa, "JWT_SECRET", strong_secret)
    monkeypatch.setattr(mfa, "JWT_ALGORITHM", "HS256")
    monkeypatch.setattr(auth_module, "JWT_SECRET", strong_secret)
    monkeypatch.setattr(auth_module, "JWT_ALGORITHM", "HS256")

    async def flow():
        db = AsyncMongoMockClient().test_admin_mfa
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(db=db)),
            client=SimpleNamespace(host="127.0.0.1"),
        )
        user = {
            "id": "admin-flow",
            "username": "admin",
            "role": "admin",
            "auth_version": 2,
        }

        assert (await mfa.status(request, user))["enabled"] is False
        setup = await mfa.setup(request, user)
        record = await db.admin_mfa.find_one({"user_id": user["id"]})
        assert setup["secret"] not in record["pending_secret_enc"]

        code = mfa._totp_at(setup["secret"], int(mfa.time.time()))
        activated = await mfa.confirm(mfa.CodeIn(username="admin", code=code), request, user)
        record = await db.admin_mfa.find_one({"user_id": user["id"]})
        assert record["totp_enabled"] is True
        assert "pending_secret_enc" not in record
        assert setup["secret"] not in record["totp_secret_enc"]
        assert (await mfa.status(request, user))["enabled"] is True
        assert await require_admin(request, user, activated["step_up_token"]) == user

        backup = activated["backup_codes"][0]
        verified = await mfa.verify(mfa.CodeIn(username="admin", code=backup), request, user)
        assert await require_admin(request, user, verified["step_up_token"]) == user
        with pytest.raises(HTTPException) as reused:
            await mfa.verify(mfa.CodeIn(username="admin", code=backup), request, user)
        assert reused.value.status_code == 401

    asyncio.run(flow())
