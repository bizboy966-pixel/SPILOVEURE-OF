"""Single-use, purpose-isolated password recovery through the configured mail sender."""
import asyncio
import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from auth import hash_password
from email_delivery import VerificationEmailSender
from identity_core import check_origin, digest, now, rate_limit, remote_key
from identity_policy import password_created


def no_store(response: Response):
    response.headers["Cache-Control"] = "no-store, private"


router = APIRouter(prefix="/password-reset", dependencies=[Depends(check_origin), Depends(no_store)])
INVALID = "Code incorrect, expiré ou déjà utilisé. Demandez un nouveau code si nécessaire."
ACCOUNT_EMAIL_INCORRECT = "ACCOUNT_EMAIL_INCORRECT"


class RequestReset(BaseModel):
    email: EmailStr


class ConfirmReset(BaseModel):
    challenge_id: str = Field(min_length=20, max_length=128)
    code: str = Field(pattern=r"^\d{6}$")
    password: str = Field(min_length=8, max_length=72)
    password_confirm: str = Field(min_length=8, max_length=72)

    @field_validator("password", "password_confirm")
    @classmethod
    def bcrypt_limit(cls, value):
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Le mot de passe dépasse la limite de 72 octets.")
        return value


@router.post("/request", status_code=202)
async def request_reset(body: RequestReset, request: Request):
    db = request.app.state.db
    email = str(body.email).strip().lower()
    await rate_limit(db, "reset-ip:" + remote_key(request), 30, 600)
    await rate_limit(db, "reset-email:" + email, 5, 3600)
    try:
        await db.identity_rate_limits.find_one_and_update(
            {"_id": "reset-cooldown:" + digest(email), "next_at": {"$lte": now()}},
            {"$set": {"next_at": now() + timedelta(seconds=60), "expires_at": now() + timedelta(hours=1)}},
            upsert=True, return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        raise HTTPException(429, "Patientez 60 secondes avant de demander un nouveau code.") from None
    matches = await db.users.find({
        "email": {"$regex": "^" + re.escape(email) + "$", "$options": "i"},
        "status": {"$nin": ["banned", "blocked", "deleted"]},
    }).limit(2).to_list(2)
    # Never choose one account silently when legacy users share an address.
    if not matches or len(matches) != 1:
        raise HTTPException(400, ACCOUNT_EMAIL_INCORRECT)
    user = matches[0] if matches[0].get("password_hash") and password_created(matches[0]) else None
    if not user:
        # Keep the neutral, non-actionable response for accounts that cannot
        # yet reset a password (for example, unfinished onboarding).
        challenge, code = secrets.token_urlsafe(24), f"{secrets.randbelow(1_000_000):06d}"
        await db.identity_password_resets.insert_one({
            "id": challenge, "user_id": None,
            "email_digest": digest(email), "code_digest": digest(challenge + ":" + code),
            "password_digest": None, "attempts": 0, "used": False, "status": "sent",
            "created_at": now(), "expires_at": now() + timedelta(minutes=10),
        })
        return {"challenge_id": challenge, "expires_in": 600, "resend_after": 60}
    sender = getattr(request.app.state, "email_sender", None) or VerificationEmailSender()
    if not await asyncio.to_thread(sender.configured):
        raise HTTPException(503, "L’envoi des e-mails est indisponible. Veuillez réessayer plus tard.")
    challenge, code = secrets.token_urlsafe(24), f"{secrets.randbelow(1_000_000):06d}"
    await db.identity_password_resets.insert_one({
        "id": challenge, "user_id": user["id"],
        "email_digest": digest(email), "code_digest": digest(challenge + ":" + code),
        "password_digest": digest(user["password_hash"]),
        "attempts": 0, "used": False, "status": "pending", "created_at": now(),
        "expires_at": now() + timedelta(minutes=10),
    })
    try:
        await asyncio.to_thread(sender.send_password_reset, email, code)
    except Exception:
        await db.identity_password_resets.update_one({"id": challenge}, {"$set": {"status": "failed"}})
        raise HTTPException(503, "L’e-mail n’a pas pu être envoyé. Veuillez réessayer plus tard.") from None
    await db.identity_password_resets.update_one({"id": challenge}, {"$set": {"status": "sent"}})
    await db.identity_password_resets.update_many({
        "user_id": user["id"], "id": {"$ne": challenge}, "used": False,
    }, {"$set": {"status": "superseded"}})
    return {"challenge_id": challenge, "expires_in": 600, "resend_after": 60}


@router.post("/confirm")
async def confirm_reset(body: ConfirmReset, request: Request):
    db = request.app.state.db
    await rate_limit(db, "reset-confirm-ip:" + remote_key(request), 40, 600)
    if body.password != body.password_confirm:
        raise HTTPException(400, "Les mots de passe ne correspondent pas.")
    row = await db.identity_password_resets.find_one_and_update({
        "id": body.challenge_id, "status": "sent", "used": False,
        "attempts": {"$lt": 5}, "expires_at": {"$gt": now()},
    }, {"$inc": {"attempts": 1}}, return_document=ReturnDocument.AFTER)
    if not row or not secrets.compare_digest(row["code_digest"], digest(body.challenge_id + ":" + body.code)):
        raise HTTPException(400, INVALID)
    user = await db.users.find_one({
        "id": row["user_id"], "status": {"$nin": ["banned", "blocked", "deleted"]},
    })
    if not user or digest(str(user.get("email", "")).lower()) != row["email_digest"] \
            or digest(user.get("password_hash", "")) != row["password_digest"]:
        raise HTTPException(400, INVALID)
    claimed = await db.identity_password_resets.update_one({
        "id": row["id"], "used": False, "status": "sent", "expires_at": {"$gt": now()},
    }, {"$set": {"used": True}})
    if claimed.modified_count != 1:
        raise HTTPException(400, INVALID)
    hashed = await asyncio.to_thread(hash_password, body.password)
    result = await db.users.update_one({
        "id": user["id"], "email": user["email"], "password_hash": user["password_hash"],
        "status": {"$nin": ["banned", "blocked", "deleted"]},
    }, {"$set": {
        "password_hash": hashed, "main_password_created": True, "password_reset_at": now(),
        "email_verified": True, "email_verified_address": user["email"].lower(),
    }, "$inc": {"auth_version": 1}})
    if result.modified_count != 1:
        raise HTTPException(400, INVALID)
    await db.identity_password_resets.update_many(
        {"user_id": user["id"], "used": False}, {"$set": {"status": "superseded"}},
    )
    await db.identity_email_codes.update_many(
        {"user_id": user["id"], "used": False}, {"$set": {"status": "superseded"}},
    )
    await db.identity_chat_sessions.update_many({"user_id": user["id"]}, {"$set": {"revoked": True}})
    return {"ok": True}
