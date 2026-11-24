"""Password login with email, username or the account's telephone number."""
import asyncio
import logging
import re

from fastapi import HTTPException

from auth import create_access_token, verify_password
from identity_core import digest, now, rate_limit
from identity_policy import main_ready
from models import TokenOut

log = logging.getLogger("account_login")

LOGIN_FAILURE_WINDOW_SECONDS = 900
LOGIN_FAILURE_LIMIT = 3
LOGIN_LOCK_MESSAGE = "Trop de tentatives. Veuillez patienter avant de réessayer."
INVALID_CREDENTIALS_MESSAGE = "Identifiant ou mot de passe invalide."


def login_queries(identifier):
    value = identifier.strip()
    exact = {"$regex": "^" + re.escape(value) + "$", "$options": "i"}
    # Prefer the field matching the input shape. A legacy username that happens
    # to equal another member's email must not make that valid email ambiguous.
    if "@" in value:
        return [{"email": exact}, {"username": exact}]
    if re.fullmatch(r"\+?[\d\s().-]+", value):
        digits = re.sub(r"\D", "", value)
        if digits.startswith("00"):
            digits = digits[2:]
        if 6 <= len(digits) <= 15:
            # Read historical formatted numbers without rewriting stored data.
            pattern = r"^\s*(?:\+|00)?\s*" + r"[\s().-]*".join(digits) + r"\s*$"
            return [{"phone": {"$regex": pattern}}, {"username": exact}]
    return [{"username": exact}]


def _identifier_kind(identifier):
    if "@" in identifier:
        return "email"
    if re.fullmatch(r"\+?[\d\s().-]+", identifier):
        return "phone"
    return "username"


def _password_hash_format(value):
    if not value:
        return "missing"
    if re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", str(value)):
        return "bcrypt"
    return "unsupported"


def _login_bucket_id(key):
    slot = int(now().timestamp()) // LOGIN_FAILURE_WINDOW_SECONDS
    return digest(f"{key}:{slot}")


async def _check_login_limits(db, keys):
    for key in keys:
        row = await db.identity_rate_limits.find_one(
            {"_id": _login_bucket_id(key)}, {"count": 1},
        )
        if row and int(row.get("count") or 0) >= LOGIN_FAILURE_LIMIT:
            raise HTTPException(429, LOGIN_LOCK_MESSAGE)


async def _record_invalid_login(db, keys):
    blocked = False
    for key in dict.fromkeys(keys):
        try:
            # The third failed attempt starts the cooldown. Successful attempts
            # never increment these counters.
            await rate_limit(
                db, key, LOGIN_FAILURE_LIMIT - 1, LOGIN_FAILURE_WINDOW_SECONDS,
            )
        except HTTPException as exc:
            if exc.status_code == 429:
                blocked = True
            else:
                raise
    if blocked:
        raise HTTPException(429, LOGIN_LOCK_MESSAGE)
    raise HTTPException(401, INVALID_CREDENTIALS_MESSAGE)


async def _clear_login_failures(db, keys):
    for key in dict.fromkeys(keys):
        await db.identity_rate_limits.delete_one({"_id": _login_bucket_id(key)})


async def login_account(data, request):
    db = request.app.state.db
    identifier = data.identifier.strip()
    attempt_keys = ["login-failed-identifier:" + identifier.casefold()]

    users_by_id = {}
    for query in login_queries(identifier):
        matches = await db.users.find(query).limit(20).to_list(20)
        for candidate in matches:
            identity = candidate.get("id") or str(candidate.get("_id"))
            users_by_id.setdefault(identity, candidate)
    users = list(users_by_id.values())
    if not users:
        log.info(
            "login rejected reason=identifier_not_found identifier_type=%s",
            _identifier_kind(identifier),
        )
        await _check_login_limits(db, attempt_keys)
        await _record_invalid_login(db, attempt_keys)

    # Legacy databases can contain duplicate emails or phone numbers. Resolve
    # those safely by password: authenticate only when exactly one candidate
    # matches, never by whichever MongoDB happened to return first.
    matching_users = []
    for candidate in users:
        if await asyncio.to_thread(
            verify_password, data.password, candidate.get("password_hash", ""),
        ):
            matching_users.append(candidate)
    if len(matching_users) != 1:
        if len(matching_users) > 1:
            reason = "multiple_password_matches"
        else:
            formats = [_password_hash_format(candidate.get("password_hash")) for candidate in users]
            reason = (
                "password_hash_unusable"
                if any(value != "bcrypt" for value in formats)
                else "password_mismatch"
            )
        log.info(
            "login rejected reason=%s identifier_type=%s candidates=%d password_hash_formats=%s",
            reason,
            _identifier_kind(identifier),
            len(users),
            ",".join(_password_hash_format(candidate.get("password_hash")) for candidate in users),
        )
        failure_keys = attempt_keys + [
            "login-failed-user:" + candidate["id"] for candidate in users
        ]
        await _check_login_limits(db, failure_keys)
        await _record_invalid_login(db, failure_keys)
    user = matching_users[0]
    # A successful password must not be blocked by stale failed-attempt state,
    # whether previous attempts used email, username, or phone.
    await _clear_login_failures(
        db, attempt_keys + ["login-failed-user:" + user["id"]],
    )
    if user.get("status") == "banned":
        raise HTTPException(403, "Compte banni.")
    scope = "main_onboarding" if user.get("auth_flow_version") == 2 and not main_ready(user) else None
    token = create_access_token(user["id"], user.get("role", "user"), scope=scope, auth_version=user.get("auth_version", 0))
    user.pop("password_hash", None)
    user.pop("_id", None)
    user["session_scope"] = scope or "main"
    return TokenOut(access_token=token, user=user)
