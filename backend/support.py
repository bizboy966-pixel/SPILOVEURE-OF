"""Support Desk (Phase 3a) — chat agents workflow.

A "support agent" is a `users` document with `role="support"` and a
`status` in ("pending", "authorized", "revoked"):
  ▸ pending    : just registered via /support-desk, awaiting admin approval.
                 Cannot log in, cannot see any conversation.
  ▸ authorized : approved by an admin. Can log in and use the chat admin
                 endpoints (list, reply, mark read, heartbeat).
  ▸ revoked    : previously authorized, access removed. Cannot log in.

The dedicated /support-desk URL is a public sign-up/sign-in page that never
grants admin panel access. Roles are strictly separated:
  admin  → full admin panel + chat + support-desk
  support→ chat + support-desk only (no admin panel access)
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

from auth import (
    create_access_token, get_current_user, hash_password, require_admin,
    verify_password,
)

public = APIRouter(prefix="/api/support", tags=["support"])
admin_router = APIRouter(prefix="/api/admin/support", tags=["support-admin"])


# ────────────────────────────────────────────────────────────────────────
# Shared dependency : admin OR authorized support agent
# ────────────────────────────────────────────────────────────────────────
async def require_admin_or_support(user: dict = Depends(get_current_user)) -> dict:
    role = (user.get("role") or "").lower()
    if role == "admin":
        return user
    if role == "support" and user.get("status") == "authorized":
        return user
    raise HTTPException(403, "Accès réservé à l'équipe support autorisée.")


# ────────────────────────────────────────────────────────────────────────
# Public — chat enabled flag (used by user-side ChatBubble)
# ────────────────────────────────────────────────────────────────────────
@public.get("/chat-enabled")
async def chat_enabled(request: Request):
    row = await request.app.state.db.app_settings.find_one({"key": "chat_enabled"}, {"_id": 0})
    enabled = True if not row else bool(row.get("value", True))
    return {"enabled": enabled}


# ────────────────────────────────────────────────────────────────────────
# Support-desk : self-service register + login
# ────────────────────────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    email: EmailStr
    username: str
    password: str


class LoginIn(BaseModel):
    email: EmailStr
    password: str


@public.post("/register")
async def support_register(data: RegisterIn, request: Request):
    db = request.app.state.db
    email = data.email.strip().lower()
    username = (data.username or "").strip()
    if len(username) < 2 or len(username) > 40:
        raise HTTPException(400, "Nom d'utilisateur invalide (2 à 40 caractères).")
    if not re.match(r"^[a-zA-Z0-9_\.\- ]+$", username):
        raise HTTPException(400, "Le nom d'utilisateur contient des caractères interdits.")
    if len(data.password) < 8:
        raise HTTPException(400, "Mot de passe : 8 caractères minimum.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "Un compte existe déjà avec cet e-mail.")

    now = datetime.now(timezone.utc)
    user = {
        "id": str(uuid.uuid4()),
        "email": email,
        "username": username,
        "password_hash": hash_password(data.password),
        "role": "support",
        "status": "pending",                # AWAITING ADMIN APPROVAL
        "max_level": 0,
        "balance_profit": 0.0, "balance_upgrade": 0.0, "balance_reserve": 0.0,
        "created_at": now,
    }
    await db.users.insert_one(user)
    return {
        "ok": True,
        "status": "pending",
        "message": "Compte créé. En attente d'autorisation par un administrateur.",
    }


@public.post("/login")
async def support_login(data: LoginIn, request: Request):
    db = request.app.state.db
    email = data.email.strip().lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(data.password, user.get("password_hash", "")):
        raise HTTPException(401, "Identifiants incorrects.")
    role = (user.get("role") or "").lower()
    if role not in ("admin", "support"):
        raise HTTPException(403, "Ce compte n'est pas un compte support.")
    if role == "support":
        st = user.get("status")
        if st == "pending":
            raise HTTPException(403, "Compte en attente d'autorisation par un administrateur.")
        if st == "revoked":
            raise HTTPException(403, "Accès révoqué. Contactez l'administrateur.")
        if st != "authorized":
            raise HTTPException(403, "Compte non autorisé.")
    token = create_access_token(user["id"], role)
    return {
        "token": token, "access_token": token,
        "user": {"id": user["id"], "email": user["email"], "username": user["username"], "role": role,
                 "status": user.get("status")},
    }


# ────────────────────────────────────────────────────────────────────────
# Admin — manage support agents
# ────────────────────────────────────────────────────────────────────────
@admin_router.get("/agents")
async def admin_list_agents(request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    out = []
    async for u in db.users.find(
        {"role": "support"},
        {"_id": 0, "id": 1, "email": 1, "username": 1, "status": 1, "created_at": 1},
    ).sort("created_at", -1):
        # Last seen from admin_presence.
        pres = await db.admin_presence.find_one({"admin_id": u["id"]}, {"_id": 0, "last_seen": 1})
        out.append({
            "id": u["id"], "email": u.get("email"),
            "username": u.get("username"),
            "status": u.get("status") or "pending",
            "created_at": u["created_at"].isoformat() if u.get("created_at") else None,
            "last_seen": (pres or {}).get("last_seen").isoformat() if pres and pres.get("last_seen") else None,
        })
    return {"agents": out}


class StatusIn(BaseModel):
    reason: Optional[str] = None


@admin_router.post("/agents/{agent_id}/authorize")
async def admin_authorize(agent_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    r = await db.users.update_one(
        {"id": agent_id, "role": "support"},
        {"$set": {"status": "authorized", "authorized_at": datetime.now(timezone.utc),
                  "authorized_by": admin["id"]}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Agent introuvable.")
    return {"ok": True, "status": "authorized"}


@admin_router.post("/agents/{agent_id}/revoke")
async def admin_revoke(agent_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    r = await db.users.update_one(
        {"id": agent_id, "role": "support"},
        {"$set": {"status": "revoked", "revoked_at": datetime.now(timezone.utc),
                  "revoked_by": admin["id"]}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Agent introuvable.")
    return {"ok": True, "status": "revoked"}


@admin_router.delete("/agents/{agent_id}")
async def admin_delete_agent(agent_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    r = await db.users.delete_one({"id": agent_id, "role": "support"})
    if r.deleted_count == 0:
        raise HTTPException(404, "Agent introuvable.")
    return {"ok": True, "deleted": True}


# ────────────────────────────────────────────────────────────────────────
# Admin — chat global on/off
# ────────────────────────────────────────────────────────────────────────
class ChatStatusIn(BaseModel):
    enabled: bool


@admin_router.get("/chat-status")
async def admin_get_chat_status(request: Request, admin=Depends(require_admin)):
    row = await request.app.state.db.app_settings.find_one({"key": "chat_enabled"}, {"_id": 0})
    return {"enabled": True if not row else bool(row.get("value", True))}


@admin_router.post("/chat-status")
async def admin_set_chat_status(body: ChatStatusIn, request: Request, admin=Depends(require_admin)):
    await request.app.state.db.app_settings.update_one(
        {"key": "chat_enabled"}, {"$set": {"value": bool(body.enabled)}}, upsert=True,
    )
    return {"ok": True, "enabled": bool(body.enabled)}
