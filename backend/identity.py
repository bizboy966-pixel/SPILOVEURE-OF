"""Email verification, onboarding and independent Chat identity endpoints."""
from __future__ import annotations

import asyncio
import os
import re
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from auth import create_access_token, hash_password, verify_password
from email_delivery import MailUnavailable, VerificationEmailSender
from identity_core import (
    COOKIE, bearer_identity, check_origin, cookie_identity, cookie_secure, digest,
    establish_chat, identity, now, rate_limit, remote_key, renew_chat, require_chat,
    safe_user, state,
)
from identity_policy import activated, chat_access_allowed, password_created, email_verified
from levels import COUNTRIES
from push_notifications import TokenIn, register_push_token
from referral_defaults import registration_sponsor
from password_recovery import router as recovery_router

def no_store(response: Response):
    response.headers["Cache-Control"] = "no-store, private"


router = APIRouter(prefix="/api/identity", dependencies=[Depends(check_origin), Depends(no_store)])
router.include_router(recovery_router, prefix="")


async def register_account(data, request):
    check_origin(request)
    db = request.app.state.db
    await rate_limit(db, "register:" + remote_key(request), 30, 600)
    sender = getattr(request.app.state, "email_sender", None) or VerificationEmailSender()
    if os.getenv("IDENTITY_REGISTRATION_ENABLED", "1") != "1" or not await asyncio.to_thread(sender.configured):
        # Do not take a new user to payment if email ownership cannot then
        # be verified and their paid dashboard would remain inaccessible.
        raise HTTPException(503, "Les nouvelles inscriptions sont temporairement indisponibles : le service de vérification e-mail doit être configuré.")
    if not data.accept_terms:
        raise HTTPException(400, "Vous devez accepter les conditions.")
    if data.password != data.password_confirm:
        raise HTTPException(400, "Les mots de passe ne correspondent pas.")
    email = str(data.email).strip().lower()
    if not any(c["code"] == data.country for c in COUNTRIES):
        raise HTTPException(400, "Pays invalide.")
    sponsor = await registration_sponsor(db, data.sponsor_username)
    email_query = {"email": {"$regex": "^" + re.escape(email) + "$", "$options": "i"}}
    username_query = {"username": {"$regex": "^" + re.escape(data.username) + "$", "$options": "i"}}
    if await db.users.find_one(email_query):
        raise HTTPException(409, "Un compte existe déjà avec cet e-mail. Connectez-vous ou récupérez votre accès au Chat.")
    if await db.users.find_one(username_query):
        raise HTTPException(409, "Ce nom d’utilisateur est déjà pris.")
    password_hash = await asyncio.to_thread(hash_password, data.password)
    uid = str(uuid.uuid4())
    try:
        for reservation in [
            {"key": "email:" + email, "owner": uid},
            {"key": "username:" + data.username.lower(), "owner": uid},
        ]:
            await db.identity_registration_keys.insert_one(reservation)
        if await db.users.find_one(email_query) or await db.users.find_one(username_query):
            raise HTTPException(409, "Un compte utilise déjà ces informations.")
        user = {
            "id": uid, "username": data.username, "email": email, "country": data.country,
            "phone": data.phone, "role": "user", "status": "pending", "max_level": 0,
            "sponsor_id": sponsor["id"], "sponsor_username": sponsor["username"],
            "balance_profit": 0, "balance_upgrade": 0, "commission_direct": 0,
            "commission_spillover": 0, "total_earned": 0, "total_withdrawn": 0,
            "withdrawals_disabled": False, "earnings_per_level": {}, "level_activated_at": {},
            "created_at": now(), "auth_flow_version": 2,
            "main_password_created": True, "password_hash": password_hash,
            "password_created_at": now(), "email_verified": False,
        }
        await db.users.insert_one(user)
    except Exception as exc:
        await db.identity_registration_keys.delete_many({"owner": uid})
        if isinstance(exc, DuplicateKeyError):
            raise HTTPException(409, "Un compte utilise déjà ces informations.") from None
        raise
    return {"access_token": create_access_token(uid, "user", scope="main_onboarding"),
            "token_type": "bearer", "user": {**safe_user(user), "session_scope": "onboarding"}}


@router.get("/registration-sponsor")
async def resolve_registration_sponsor(request: Request, ref: str | None = None):
    if ref and len(ref) > 100:
        raise HTTPException(400, "Code parrain invalide.")
    sponsor = await registration_sponsor(request.app.state.db, ref)
    return {"username": sponsor["username"], "source": "invitation" if (ref or "").strip() else "official"}


@router.get("/state")
async def identity_state(request: Request):
    user, claims = await identity(request)
    return await state(request, user, claims)


class EmailRequest(BaseModel):
    email: EmailStr | None = None


@router.post("/email/request", status_code=202)
async def request_code(data: EmailRequest, request: Request):
    db = request.app.state.db
    await rate_limit(db, "email-ip:" + remote_key(request), 30, 600)
    try:
        user, _ = await identity(request)
    except HTTPException:
        user = None
    if user:
        email = user["email"].lower()
        if data.email and str(data.email).lower() != email:
            raise HTTPException(400, "Utilisez l’adresse e-mail associée à ce compte.")
    elif data.email:
        email = str(data.email).strip().lower()
        matches = await db.users.find({
            "email": {"$regex": "^" + re.escape(email) + "$", "$options": "i"},
            "status": {"$nin": ["banned", "blocked", "deleted"]},
        }).limit(2).to_list(2)
        # Ambiguous legacy email records must never be silently associated.
        user = matches[0] if len(matches) == 1 else None
    else:
        raise HTTPException(422, "Saisissez votre adresse e-mail.")
    await rate_limit(db, "email:" + email, 5, 3600)
    try:
        await db.identity_rate_limits.find_one_and_update(
            {"_id": "cooldown:" + digest(email), "next_at": {"$lte": now()}},
            {"$set": {"next_at": now() + timedelta(seconds=60), "expires_at": now() + timedelta(hours=1)}},
            upsert=True, return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        raise HTTPException(429, "Patientez 60 secondes avant de demander un nouveau code.") from None
    sender = getattr(request.app.state, "email_sender", None) or VerificationEmailSender()
    if not await asyncio.to_thread(sender.configured):
        raise HTTPException(503, "L’envoi des e-mails n’est pas configuré. Veuillez contacter l’administration.")
    challenge, code = secrets.token_urlsafe(24), f"{secrets.randbelow(1_000_000):06d}"
    await db.identity_email_codes.insert_one({
        "id": challenge, "user_id": user["id"] if user else None,
        "email_digest": digest(email), "code_digest": digest(challenge + ":" + code),
        "attempts": 0, "used": False, "status": "pending", "created_at": now(),
        "expires_at": now() + timedelta(minutes=10),
    })
    if user:
        try:
            await asyncio.to_thread(sender.send_verification, email, code)
        except Exception:
            await db.identity_email_codes.update_one({"id": challenge}, {"$set": {"status": "failed"}})
            raise HTTPException(503, "L’e-mail n’a pas pu être envoyé. Veuillez réessayer plus tard.") from None
    await db.identity_email_codes.update_one({"id": challenge}, {"$set": {"status": "sent"}})
    if user:
        await db.identity_email_codes.update_many(
            {"user_id": user["id"], "id": {"$ne": challenge}, "used": False},
            {"$set": {"status": "superseded"}},
        )
    return {"challenge_id": challenge, "expires_in": 600, "resend_after": 60}


class CodeIn(BaseModel):
    challenge_id: str = Field(min_length=20, max_length=100)
    code: str = Field(pattern=r"^[0-9]{6}$")


@router.post("/email/verify")
async def verify_code(data: CodeIn, request: Request, response: Response):
    db = request.app.state.db
    await rate_limit(db, "verify-ip:" + remote_key(request), 60, 600)
    row = await db.identity_email_codes.find_one_and_update(
        {"id": data.challenge_id, "status": "sent", "used": False,
         "attempts": {"$lt": 5}, "expires_at": {"$gt": now()}},
        {"$inc": {"attempts": 1}}, return_document=ReturnDocument.AFTER,
    )
    error = HTTPException(400, "Code incorrect, expiré ou déjà utilisé. Demandez un nouveau code si nécessaire.")
    if not row or not secrets.compare_digest(row["code_digest"], digest(data.challenge_id + ":" + data.code)):
        raise error
    user = await db.users.find_one({"id": row["user_id"], "status": {"$nin": ["banned", "blocked", "deleted"]}})
    if not user or digest(user["email"].lower()) != row["email_digest"]:
        raise error
    consumed = await db.identity_email_codes.update_one(
        {"id": row["id"], "used": False, "status": "sent"}, {"$set": {"used": True}},
    )
    if consumed.modified_count != 1:
        raise error
    await db.users.update_one({"id": user["id"], "email": user["email"]}, {
        "$set": {"email_verified": True, "email_verified_address": user["email"].lower()},
        "$min": {"email_verified_at": now()},
    })
    user["email_verified"] = True
    user["email_verified_address"] = user["email"].lower()
    await establish_chat(request, response, user)
    return {**await state(request, user), "chat_authenticated": True}


@router.post("/chat/open")
async def open_chat(request: Request, response: Response):
    principal = await bearer_identity(request)
    if not principal:
        raise HTTPException(401, "Connectez-vous ou vérifiez votre adresse e-mail.")
    user, claims = principal
    if not chat_access_allowed(user):
        raise HTTPException(403, "EMAIL_VERIFICATION_REQUIRED")
    cookie = await cookie_identity(request)
    if claims.get("scope") in ("onboarding", "main_onboarding") and not (cookie and cookie[1]["id"] == user["id"]):
        # Knowing an address at registration is not proof of ownership.
        # Another device may have verified that address in the meantime.
        raise HTTPException(403, "Vérifiez votre e-mail sur cet appareil pour ouvrir le Chat.")
    await establish_chat(request, response, user)
    return {**await state(request, user, claims), "chat_authenticated": True}


@router.get("/chat/session")
async def chat_session(request: Request, response: Response, user=Depends(require_chat)):
    row, full_user = await cookie_identity(request)
    await renew_chat(request, response, row)
    return await state(request, full_user)


@router.get("/chat/sessions")
async def chat_sessions(request: Request, user=Depends(require_chat)):
    rows = await request.app.state.db.identity_chat_sessions.find({
        "user_id": user["id"], "revoked": False, "expires_at": {"$gt": now()},
        "absolute_expires_at": {"$gt": now()},
    }).sort("created_at", -1).limit(50).to_list(50)
    return [{k: row[k] for k in ("id", "device", "created_at", "last_seen", "expires_at")} |
            {"current": row["id"] == request.state.chat_session_id} for row in rows]


@router.delete("/chat/sessions/{session_id}")
async def revoke_session(session_id: str, request: Request, response: Response, user=Depends(require_chat)):
    result = await request.app.state.db.identity_chat_sessions.update_one(
        {"id": session_id, "user_id": user["id"]}, {"$set": {"revoked": True}},
    )
    if result.matched_count != 1:
        raise HTTPException(404, "Session introuvable.")
    await request.app.state.db.push_tokens.delete_many({"user_id": user["id"], "chat_session_id": session_id})
    if session_id == request.state.chat_session_id:
        response.delete_cookie(COOKIE, path="/api/", secure=cookie_secure(request), httponly=True, samesite="lax")
    return {"ok": True}


@router.post("/chat/logout")
async def logout_chat(request: Request, response: Response):
    cookie = await cookie_identity(request)
    if cookie:
        await request.app.state.db.identity_chat_sessions.update_one(
            {"id": cookie[0]["id"]}, {"$set": {"revoked": True}},
        )
        await request.app.state.db.push_tokens.delete_many({
            "user_id": cookie[1]["id"], "chat_session_id": cookie[0]["id"],
        })
    response.delete_cookie(COOKIE, path="/api/", secure=cookie_secure(request), httponly=True, samesite="lax")
    return {"ok": True}


@router.post("/chat/push-token")
async def register_chat_push(body: TokenIn, request: Request, user=Depends(require_chat)):
    result = await register_push_token(body, request, user)
    await request.app.state.db.push_tokens.update_one(
        {"user_id": user["id"], "device_id": body.device_id},
        {"$set": {"chat_session_id": request.state.chat_session_id}},
    )
    return result


@router.post("/onboarding-session")
async def onboarding_session(request: Request):
    user, _ = await identity(request)
    return {"access_token": create_access_token(user["id"], user.get("role", "user"), scope="main_onboarding", auth_version=user.get("auth_version", 0)),
            "user": {**safe_user(user), "session_scope": "onboarding"}, "token_type": "bearer"}


class PasswordIn(BaseModel):
    password: str = Field(min_length=8, max_length=128)
    password_confirm: str

    @field_validator("password")
    @classmethod
    def bounded_password(cls, value):
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Le mot de passe ne doit pas dépasser 72 octets.")
        return value


class UnlockIn(BaseModel):
    password: str = Field(min_length=1, max_length=128)


def main_token(user):
    return {"access_token": create_access_token(user["id"], user.get("role", "user"), auth_version=user.get("auth_version", 0)),
            # Preserve the original main-account response (balances, referral,
            # levels, etc.). The Chat state continues to use its minimal view.
            "token_type": "bearer", "user": {
                **{key: value for key, value in user.items() if key not in ("_id", "password_hash")},
                "main_password_created": password_created(user), "session_scope": "main",
            }}


@router.post("/password")
async def create_password(data: PasswordIn, request: Request):
    user, _ = await identity(request)
    await rate_limit(request.app.state.db, "password-create:" + user["id"], 10, 600)
    if not activated(user):
        raise HTTPException(403, "ACTIVATION_REQUIRED")
    if not email_verified(user):
        raise HTTPException(403, "EMAIL_VERIFICATION_REQUIRED")
    cookie = await cookie_identity(request)
    if not cookie or cookie[1]["id"] != user["id"]:
        raise HTTPException(403, "Vérifiez votre e-mail sur cet appareil avant de créer le mot de passe.")
    if password_created(user):
        raise HTTPException(409, "Le mot de passe est déjà créé. Connectez-vous avec votre mot de passe.")
    if data.password != data.password_confirm:
        raise HTTPException(400, "Les mots de passe ne correspondent pas.")
    hashed = await asyncio.to_thread(hash_password, data.password)
    result = await request.app.state.db.users.update_one({
        "id": user["id"], "auth_flow_version": 2, "main_password_created": False,
        "email_verified": True, "status": "active", "max_level": {"$gte": 1},
    }, {"$set": {"password_hash": hashed, "main_password_created": True, "password_created_at": now()}})
    if result.modified_count != 1:
        raise HTTPException(409, "L’état du compte a changé. Veuillez réessayer.")
    user["main_password_created"] = True
    return main_token(user)


@router.post("/unlock")
async def unlock(data: UnlockIn, request: Request):
    user, _ = await identity(request)
    db = request.app.state.db
    await rate_limit(db, "unlock:" + user["id"], 8, 900)
    await rate_limit(db, "unlock-ip:" + remote_key(request), 40, 900)
    if not activated(user):
        raise HTTPException(403, "ACTIVATION_REQUIRED")
    if not password_created(user):
        raise HTTPException(403, "PASSWORD_CREATION_REQUIRED")
    if not await asyncio.to_thread(verify_password, data.password, user.get("password_hash", "")):
        raise HTTPException(401, "Mot de passe incorrect.")
    return main_token(user)
