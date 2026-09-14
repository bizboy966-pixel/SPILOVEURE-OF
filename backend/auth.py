"""JWT auth utilities + dependencies."""
from __future__ import annotations
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_ACCESS_EXP_MINUTES = int(os.environ.get("JWT_ACCESS_EXP_MINUTES", "720"))
JWT_PWD_CONFIRM_EXP_MINUTES = int(os.environ.get("JWT_PWD_CONFIRM_EXP_MINUTES", "10"))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "role": role,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=JWT_ACCESS_EXP_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_pwd_confirm_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "type": "pwd_confirm",
        "iat": now,
        "exp": now + timedelta(minutes=JWT_PWD_CONFIRM_EXP_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


async def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
) -> dict:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token manquant.")
    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expirée.")
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token invalide.")
    if payload.get("type") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Type de token invalide.")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token invalide.")
    db = request.app.state.db
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Utilisateur introuvable.")
    if user.get("status") == "banned":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Compte banni.")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès réservé à l’administrateur.")
    return user


async def require_active_user(user: dict = Depends(get_current_user)) -> dict:
    """v23 (2026-02-14) — protected-action gate.

    Blocks any pending user (status != "active" AND max_level < 1) from
    executing an action that requires an activated account (publish an
    ad, create a listing, post a job, comment, participate to a campaign,
    withdraw, etc.). Admin bypass — admin is always considered active.

    Frontend catches the 403 payload `ACTIVATION_REQUIRED` and shows the
    activation modal (see `src/components/ActivationGuard.tsx`).

    Exceptions listed by the product spec (Dépôt, Envoyer, Échange,
    consulter / participer à une tâche, recevoir un gain de tâche) MUST
    NOT wire this dependency — they stay open to pending users.
    """
    if user.get("role") == "admin":
        return user
    is_pending = (user.get("status") != "active") and (int(user.get("max_level") or 0) < 1)
    if is_pending:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "ACTIVATION_REQUIRED")
    return user


async def require_pwd_confirm(
    user: dict = Depends(get_current_user),
    x_password_confirm: Optional[str] = Header(default=None, alias="X-Password-Confirm"),
) -> dict:
    if not x_password_confirm:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Confirmation de mot de passe requise.")
    try:
        payload = decode_token(x_password_confirm)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Confirmation expirée, veuillez recommencer.")
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token de confirmation invalide.")
    if payload.get("type") != "pwd_confirm" or payload.get("sub") != user["id"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Confirmation invalide.")
    return user
