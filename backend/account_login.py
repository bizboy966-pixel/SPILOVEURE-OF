"""Password login with email, username or the account's telephone number."""
import asyncio
import re

from fastapi import HTTPException

from auth import create_access_token, verify_password
from identity_core import rate_limit, remote_key
from identity_policy import main_ready
from models import TokenOut


def login_queries(identifier):
    value = identifier.strip()
    exact = {"$regex": "^" + re.escape(value) + "$", "$options": "i"}
    queries = [{"email": exact}, {"username": exact}]
    if re.fullmatch(r"\+?[\d\s().-]+", value):
        digits = re.sub(r"\D", "", value)
        if digits.startswith("00"):
            digits = digits[2:]
        if 6 <= len(digits) <= 15:
            # Read historical formatted numbers without rewriting stored data.
            pattern = r"^\s*(?:\+|00)?\s*" + r"[\s().-]*".join(digits) + r"\s*$"
            queries.append({"phone": {"$regex": pattern}})
    return queries


async def login_account(data, request):
    db = request.app.state.db
    identifier = data.identifier.strip()
    await rate_limit(db, "login-ip:" + remote_key(request), 40, 900)
    await rate_limit(db, "login:" + identifier.lower(), 10, 900)
    users = await db.users.find({"$or": login_queries(identifier)}).limit(2).to_list(2)
    # Never select an arbitrary owner when historical phone numbers are shared.
    if len(users) != 1:
        raise HTTPException(401, "Identifiants invalides.")
    user = users[0]
    # Switching between email, username and phone must not bypass throttling.
    await rate_limit(db, "login-user:" + user["id"], 10, 900)
    if not await asyncio.to_thread(verify_password, data.password, user.get("password_hash", "")):
        raise HTTPException(401, "Identifiants invalides.")
    if user.get("status") == "banned":
        raise HTTPException(403, "Compte banni.")
    scope = "main_onboarding" if user.get("auth_flow_version") == 2 and not main_ready(user) else None
    token = create_access_token(user["id"], user.get("role", "user"), scope=scope, auth_version=user.get("auth_version", 0))
    user.pop("password_hash", None)
    user.pop("_id", None)
    user["session_scope"] = scope or "main"
    return TokenOut(access_token=token, user=user)
