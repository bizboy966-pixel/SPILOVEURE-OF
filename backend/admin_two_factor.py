"""TOTP enrollment and step-up authentication for administrator routes."""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import struct
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import JWT_ALGORITHM, JWT_SECRET, get_current_user
from identity_core import rate_limit, remote_key

router = APIRouter(prefix="/auth/admin-2fa", tags=["admin-two-factor"])
ISSUER = "SPILOVEURE"
STEP_UP_SECONDS = 8 * 60 * 60
PENDING_SECONDS = 10 * 60
AAD = b"SPILOVEURE-admin-totp-v1"


class CodeIn(BaseModel):
    username: str = Field(min_length=1, max_length=30)
    code: str = Field(min_length=6, max_length=32)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _secret_key() -> bytes:
    # Reuse the existing private JWT secret with domain separation instead
    # of adding a second credential that could drift between the VPS and app.
    if JWT_SECRET == "dev-secret" or len(JWT_SECRET.encode("utf-8")) < 32:
        raise RuntimeError("A strong JWT_SECRET is required for administrator 2FA.")
    return hashlib.sha256(AAD + b"\0" + JWT_SECRET.encode("utf-8")).digest()


def encrypt_totp_secret(secret: str) -> str:
    nonce = secrets.token_bytes(12)
    encrypted = AESGCM(_secret_key()).encrypt(nonce, secret.encode("ascii"), AAD)
    return base64.urlsafe_b64encode(nonce + encrypted).decode("ascii").rstrip("=")


def decrypt_totp_secret(value: str) -> str:
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    nonce, encrypted = raw[:12], raw[12:]
    return AESGCM(_secret_key()).decrypt(nonce, encrypted, AAD).decode("ascii")


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _totp_at(secret: str, timestamp: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    counter = int(timestamp // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{value:06d}"


def verify_totp(secret: str, code: str, timestamp: int | None = None) -> bool:
    candidate = (code or "").strip()
    if len(candidate) != 6 or not candidate.isdigit():
        return False
    current = int(time.time()) if timestamp is None else int(timestamp)
    try:
        return any(
            hmac.compare_digest(_totp_at(secret, current + offset * 30), candidate)
            for offset in (-1, 0, 1)
        )
    except (ValueError, TypeError):
        return False


def provisioning_uri(secret: str, username: str) -> str:
    label = quote(f"{ISSUER}:{username}", safe="")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(ISSUER)}&algorithm=SHA1&digits=6&period=30"


def _backup_digest(code: str) -> str:
    normalized = (code or "").replace("-", "").replace(" ", "").upper()
    if not re.fullmatch(r"[0-9A-F]{16}", normalized):
        return ""
    return hmac.new(JWT_SECRET.encode("utf-8"), normalized.encode("ascii"), hashlib.sha256).hexdigest()


def generate_backup_codes() -> tuple[list[str], list[str]]:
    codes = [secrets.token_hex(8).upper() for _ in range(10)]
    hashes = [_backup_digest(code) for code in codes]
    display = ["-".join(code[index:index + 4] for index in range(0, len(code), 4)) for code in codes]
    return display, hashes


def create_step_up_token(user_id: str, auth_version: int) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": user_id,
            "type": "admin_step_up",
            "auth_version": auth_version,
            "iat": now,
            "exp": now + timedelta(seconds=STEP_UP_SECONDS),
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def validate_step_up_token(token: str, user: dict) -> bool:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return (
            payload.get("type") == "admin_step_up"
            and payload.get("sub") == user.get("id")
            and payload.get("auth_version", 0) == user.get("auth_version", 0)
        )
    except Exception:
        return False


def _assert_admin(user: dict) -> None:
    if user.get("role") != "admin":
        raise HTTPException(403, "Accès réservé à l’administrateur.")


async def _limit(request: Request, user_id: str, action: str, limit: int) -> None:
    db = request.app.state.db
    await rate_limit(db, f"admin-2fa-{action}-user:{user_id}", limit, 300)
    await rate_limit(db, f"admin-2fa-{action}-ip:{remote_key(request)}", limit * 3, 300)


@router.get("/status")
async def status(request: Request, user: dict = Depends(get_current_user)):
    _assert_admin(user)
    record = await request.app.state.db.admin_mfa.find_one(
        {"user_id": user["id"]}, {"_id": 0, "totp_enabled": 1}
    )
    return {"enabled": bool(record and record.get("totp_enabled"))}


@router.post("/setup")
async def setup(request: Request, user: dict = Depends(get_current_user)):
    _assert_admin(user)
    await _limit(request, user["id"], "setup", 5)
    db = request.app.state.db
    record = await db.admin_mfa.find_one({"user_id": user["id"]}, {"_id": 0, "totp_enabled": 1})
    if record and record.get("totp_enabled"):
        raise HTTPException(409, "La double authentification est déjà activée.")
    try:
        secret = generate_totp_secret()
        encrypted = encrypt_totp_secret(secret)
    except RuntimeError:
        raise HTTPException(503, "La configuration de sécurité du serveur doit être renforcée.")
    expiry = _now() + timedelta(seconds=PENDING_SECONDS)
    await db.admin_mfa.update_one(
        {"user_id": user["id"]},
        {"$set": {"pending_secret_enc": encrypted, "pending_expires_at": expiry},
         "$setOnInsert": {"user_id": user["id"], "totp_enabled": False}},
        upsert=True,
    )
    return {
        "secret": secret,
        "issuer": ISSUER,
        "account": user["username"],
        "provisioning_uri": provisioning_uri(secret, user["username"]),
        "expires_in": PENDING_SECONDS,
    }


@router.post("/confirm")
async def confirm(payload: CodeIn, request: Request, user: dict = Depends(get_current_user)):
    _assert_admin(user)
    await _limit(request, user["id"], "confirm", 5)
    if payload.username.strip().casefold() != str(user.get("username", "")).casefold():
        raise HTTPException(401, "Nom d’utilisateur ou code incorrect.")
    db = request.app.state.db
    record = await db.admin_mfa.find_one({"user_id": user["id"]})
    if record and record.get("totp_enabled"):
        raise HTTPException(409, "La double authentification est déjà activée.")
    expiry = record.get("pending_expires_at") if record else None
    if expiry and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if not record or not record.get("pending_secret_enc") or not expiry or expiry <= _now():
        raise HTTPException(410, "La configuration a expiré. Recommencez l’activation.")
    try:
        secret = decrypt_totp_secret(record["pending_secret_enc"])
    except Exception:
        raise HTTPException(503, "La configuration de sécurité du serveur est indisponible.")
    if not verify_totp(secret, payload.code):
        raise HTTPException(401, "Code incorrect. Vérifiez l’heure de votre appareil.")

    backup_codes, backup_hashes = generate_backup_codes()
    saved = await db.admin_mfa.update_one(
        {"user_id": user["id"], "pending_secret_enc": record["pending_secret_enc"]},
        {
            "$set": {
                "totp_enabled": True,
                "totp_secret_enc": record["pending_secret_enc"],
                "backup_code_hashes": backup_hashes,
                "updated_at": _now(),
            },
            "$unset": {"pending_secret_enc": "", "pending_expires_at": ""},
        },
    )
    if saved.modified_count != 1:
        raise HTTPException(409, "La configuration a changé. Recommencez l’activation.")
    return {
        "step_up_token": create_step_up_token(user["id"], user.get("auth_version", 0)),
        "expires_in": STEP_UP_SECONDS,
        "backup_codes": backup_codes,
    }


@router.post("/verify")
async def verify(payload: CodeIn, request: Request, user: dict = Depends(get_current_user)):
    _assert_admin(user)
    await _limit(request, user["id"], "verify", 5)
    if payload.username.strip().casefold() != str(user.get("username", "")).casefold():
        raise HTTPException(401, "Nom d’utilisateur ou code incorrect.")
    db = request.app.state.db
    record = await db.admin_mfa.find_one({"user_id": user["id"]})
    if not record or not record.get("totp_enabled") or not record.get("totp_secret_enc"):
        raise HTTPException(403, "ADMIN_2FA_SETUP_REQUIRED")
    try:
        secret = decrypt_totp_secret(record["totp_secret_enc"])
    except Exception:
        raise HTTPException(503, "La configuration de sécurité du serveur est indisponible.")

    valid = verify_totp(secret, payload.code)
    if not valid:
        backup_hash = _backup_digest(payload.code)
        if backup_hash in record.get("backup_code_hashes", []):
            consumed = await db.admin_mfa.update_one(
                {"user_id": user["id"], "backup_code_hashes": backup_hash},
                {"$pull": {"backup_code_hashes": backup_hash}},
            )
            valid = consumed.modified_count == 1
    if not valid:
        raise HTTPException(401, "Nom d’utilisateur ou code incorrect.")

    return {
        "step_up_token": create_step_up_token(user["id"], user.get("auth_version", 0)),
        "expires_in": STEP_UP_SECONDS,
    }
