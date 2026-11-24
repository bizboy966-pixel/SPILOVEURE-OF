"""Password login with email, username or the account's telephone number."""
import asyncio
import re

from fastapi import HTTPException

from auth import create_access_token, verify_password
from identity_core import digest, now, rate_limit
from identity_policy import main_ready
from models import TokenOut

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

    users = []
    for query in login_queries(identifier):
        users = await db.users.find(query).limit(2).to_list(2)
        if users:
            break
    # Never select an arbitrary owner when historical phone numbers are shared.
    if len(users) != 1:
        await _check_login_limits(db, attempt_keys)
        await _record_invalid_login(db, attempt_keys)
    user = users[0]
    # Switching between email, username and phone must not bypass the same
    # account's failure threshold.
    user_attempt_key = "login-failed-user:" + user["id"]
    if not await asyncio.to_thread(verify_password, data.password, user.get("password_hash", "")):
        await _check_login_limits(db, [user_attempt_key])
        await _record_invalid_login(db, [user_attempt_key])
    # A previously accumulated failure lock must not reject the account owner
    # after they provide the correct password. Reset the account-wide counter.
    await _clear_login_failures(db, [user_attempt_key])
    if user.get("status") == "banned":
        raise HTTPException(403, "Compte banni.")
    scope = "main_onboarding" if user.get("auth_flow_version") == 2 and not main_ready(user) else None
    token = create_access_token(user["id"], user.get("role", "user"), scope=scope, auth_version=user.get("auth_version", 0))
    user.pop("password_hash", None)
    user.pop("_id", None)
    user["session_scope"] = scope or "main"
    return TokenOut(access_token=token, user=user)
