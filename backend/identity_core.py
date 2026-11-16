"""Scoped identity and revocable HttpOnly Chat sessions, independent of main JWTs."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response
from pymongo import ReturnDocument

from auth import JWT_SECRET, decode_token
from identity_policy import activated, chat_access_allowed, main_ready, password_created, email_verified

COOKIE = "spv_chat_session"
DAY = timedelta(days=1)


def now():
    return datetime.now(timezone.utc)


def digest(value):
    return hmac.new(JWT_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()


def safe_user(user):
    fields = ("id", "username", "chat_username", "email", "country", "phone", "role", "status",
              "max_level", "profile_photo", "preferred_language", "auth_flow_version")
    return {**{k: user[k] for k in fields if k in user},
            "email_verified": email_verified(user),
            "main_password_created": password_created(user)}


def available(user):
    return user and user.get("status") not in ("banned", "blocked", "deleted")


def check_origin(request: Request):
    """Cookie mutations must originate from this site, not arbitrary CORS callers."""
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Origine de la demande refusée.")
    origin = request.headers.get("origin")
    if origin:
        expected = request.headers.get("host", "")
        if urlsplit(origin).netloc.lower() != expected.lower():
            raise HTTPException(403, "Origine de la demande refusée.")


def cookie_secure(request):
    # Local test browsers may use loopback HTTP. Every non-loopback host
    # requires HTTPS cookies, regardless of untrusted forwarded headers.
    return request.url.hostname not in ("localhost", "127.0.0.1", "::1", "testserver")


async def initialize(db):
    for collection in ("identity_chat_sessions", "identity_email_codes", "identity_rate_limits", "identity_password_resets"):
        await db[collection].create_index("expires_at", expireAfterSeconds=0)
    await db.identity_chat_sessions.create_index("digest", unique=True)
    await db.identity_chat_sessions.create_index([("user_id", 1), ("revoked", 1)])
    await db.identity_email_codes.create_index("id", unique=True)
    await db.identity_password_resets.create_index("id", unique=True)
    # A normalized identifier reservation prevents concurrent registration
    # without rewriting or indexing potentially inconsistent legacy users.
    await db.identity_registration_keys.create_index("key", unique=True)


async def rate_limit(db, key, limit, seconds):
    timestamp = int(now().timestamp())
    slot = timestamp // seconds
    row = await db.identity_rate_limits.find_one_and_update(
        {"_id": digest(f"{key}:{slot}")},
        {"$inc": {"count": 1},
         "$setOnInsert": {"expires_at": datetime.fromtimestamp((slot + 1) * seconds, timezone.utc)}},
        upsert=True, return_document=ReturnDocument.AFTER,
    )
    if row["count"] > limit:
        raise HTTPException(429, "Trop de tentatives. Veuillez patienter avant de réessayer.")


def remote_key(request):
    # Do not trust arbitrary X-Forwarded-For as a rate-limit bypass.
    return request.client.host if request.client else "unknown"


async def bearer_identity(request):
    token = request.headers.get("authorization", "")
    if not token.startswith("Bearer "):
        return None
    try:
        claims = decode_token(token[7:])
        if claims.get("type") != "access":
            return None
        user = await request.app.state.db.users.find_one({"id": claims.get("sub")})
        if not available(user):
            return None
        if claims.get("auth_version", 0) != user.get("auth_version", 0):
            return None
        return user, claims
    except Exception:
        return None


async def session_row(db, session_id):
    row = await db.identity_chat_sessions.find_one({
        "id": session_id, "revoked": False, "expires_at": {"$gt": now()},
        "absolute_expires_at": {"$gt": now()},
    })
    if not row:
        return None
    user = await db.users.find_one({"id": row["user_id"]})
    if not available(user) or not chat_access_allowed(user) or digest(user["email"].lower()) != row["email_digest"]:
        return None
    return row, user


async def cookie_identity(request):
    secret = request.cookies.get(COOKIE, "")
    if not secret or len(secret) > 128:
        return None
    db = request.app.state.db
    row = await db.identity_chat_sessions.find_one({"digest": digest(secret)})
    return await session_row(db, row["id"]) if row else None


async def identity(request):
    if request.query_params.get("source") == "chat":
        cookie = await cookie_identity(request)
        if cookie:
            return cookie[1], None
    else:
        bearer = await bearer_identity(request)
        if bearer:
            return bearer
        cookie = await cookie_identity(request)
        if cookie:
            return cookie[1], None
    raise HTTPException(401, "Identité non disponible. Veuillez vous identifier.")


async def require_chat(request: Request):
    check_origin(request)
    cookie = await cookie_identity(request)
    if not cookie:
        raise HTTPException(401, "Session Chat expirée. Veuillez vous reconnecter au Chat.")
    row, user = cookie
    request.state.chat_session_id = row["id"]
    await request.app.state.db.identity_chat_sessions.update_one(
        {"id": row["id"]}, {"$set": {"last_seen": now()}},
    )
    return safe_user(user)


async def state(request, user, claims=None):
    cookie = await cookie_identity(request)
    return {
        "user": safe_user(user), "email_verified": email_verified(user),
        "chat_access_allowed": chat_access_allowed(user),
        "activated": activated(user), "password_created": password_created(user),
        "chat_authenticated": bool(cookie and cookie[1]["id"] == user["id"]),
        "main_authenticated": bool(
            claims and claims.get("scope") != "onboarding" and
            (user.get("auth_flow_version") != 2 or main_ready(user))
        ),
    }


async def establish_chat(request, response: Response, user):
    check_origin(request)
    db = request.app.state.db
    current = await cookie_identity(request)
    if current and current[1]["id"] == user["id"]:
        return
    if current:
        await db.identity_chat_sessions.update_one({"id": current[0]["id"]}, {"$set": {"revoked": True}})
    secret, timestamp = secrets.token_urlsafe(32), now()
    await db.identity_chat_sessions.insert_one({
        "id": secrets.token_urlsafe(18), "digest": digest(secret),
        "user_id": user["id"], "email_digest": digest(user["email"].lower()),
        "device": request.headers.get("user-agent", "Appareil inconnu")[:240],
        "created_at": timestamp, "last_seen": timestamp,
        "expires_at": timestamp + 30 * DAY, "absolute_expires_at": timestamp + 90 * DAY,
        "revoked": False,
    })
    response.set_cookie(COOKIE, secret, max_age=30 * 86400, httponly=True,
                        secure=cookie_secure(request), samesite="lax", path="/api/")


async def renew_chat(request, response, row):
    absolute = row["absolute_expires_at"]
    if absolute.tzinfo is None:
        absolute = absolute.replace(tzinfo=timezone.utc)
    expiry = min(now() + 30 * DAY, absolute)
    await request.app.state.db.identity_chat_sessions.update_one(
        {"id": row["id"], "revoked": False}, {"$set": {"expires_at": expiry, "last_seen": now()}},
    )
    response.set_cookie(COOKIE, request.cookies[COOKIE],
                        max_age=max(0, int((expiry - now()).total_seconds())),
                        httponly=True, secure=cookie_secure(request), samesite="lax", path="/api/")
