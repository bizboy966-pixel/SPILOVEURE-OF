"""Firebase Cloud Messaging (Web Push) integration for SPILOVEURE.

The frontend registers a service worker (`/firebase-messaging-sw.js`),
calls `getToken(messaging, { vapidKey })` and posts the resulting
device token to `POST /api/push/tokens`. Tokens are indexed per
`(user_id, device_id)` so each browser is one row.

Admin can broadcast via three endpoints:
    POST /api/admin/push/all           — everyone with a registered token
    POST /api/admin/push/user/{uid}    — a single account (all its devices)
    POST /api/admin/push/group         — filtered audience (level / country / status)

All sends run through Firebase Admin's `send_each_for_multicast` with
500-token batches; expired tokens are auto-pruned on Unregistered /
SenderIdMismatch errors, per the FCM playbook.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Optional

import firebase_admin
from firebase_admin import credentials, messaging
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin


# ─────────────────────────────────────────────────────────────────────────────
# Firebase Admin bootstrap (idempotent — safe under uvicorn reload)
# ─────────────────────────────────────────────────────────────────────────────
_SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")

if _SERVICE_ACCOUNT_PATH and not firebase_admin._apps:
    try:
        firebase_admin.initialize_app(credentials.Certificate(_SERVICE_ACCOUNT_PATH))
    except Exception as e:  # pragma: no cover — startup diagnostic
        # Keep server booting even if credentials are missing during dev.
        print(f"[FCM] Firebase Admin init failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Router + models
# ─────────────────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/api", tags=["push"])


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=4096)
    device_id: str = Field(min_length=8, max_length=200)
    platform: str = Field(default="web", max_length=32)
    user_agent: Optional[str] = Field(default=None, max_length=512)


class SendIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=800)
    link: Optional[str] = Field(default=None, max_length=1024)
    data: dict[str, str] = Field(default_factory=dict)
    # Group filters — all optional, combined with AND
    max_level_min: Optional[int] = Field(default=None, ge=0, le=12)
    max_level_max: Optional[int] = Field(default=None, ge=0, le=12)
    country: Optional[str] = Field(default=None, max_length=8)
    status: Optional[str] = Field(default=None, pattern="^(active|pending)$")


# ─────────────────────────────────────────────────────────────────────────────
# Token registration (any authenticated user)
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/push/tokens")
async def register_push_token(body: TokenIn, request: Request,
                              user=Depends(get_current_user)):
    db = request.app.state.db
    now = datetime.now(timezone.utc)

    # 1) Upsert on (user_id, device_id) — one row per browser per user.
    await db.push_tokens.update_one(
        {"user_id": user["id"], "device_id": body.device_id},
        {"$set": {
            "user_id": user["id"], "device_id": body.device_id,
            "token": body.token, "platform": body.platform,
            "user_agent": body.user_agent, "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )

    # 2) A token can rotate across devices — drop any stale row that still
    #    references the same string under a different (user, device) pair.
    await db.push_tokens.delete_many({
        "token": body.token,
        "$or": [{"user_id": {"$ne": user["id"]}}, {"device_id": {"$ne": body.device_id}}],
    })
    return {"ok": True}


@router.delete("/push/tokens/{device_id}")
async def unregister_push_token(device_id: str, request: Request,
                                user=Depends(get_current_user)):
    db = request.app.state.db
    r = await db.push_tokens.delete_one({"user_id": user["id"], "device_id": device_id})
    return {"deleted": r.deleted_count}


# ─────────────────────────────────────────────────────────────────────────────
# Admin: send broadcasts
# ─────────────────────────────────────────────────────────────────────────────
async def _resolve_tokens(db, user_filter: dict) -> list[dict]:
    """Return [{user_id, token}] rows for users matching the filter."""
    # 1) resolve user ids matching the filter (empty filter = all users).
    user_ids = set()
    if user_filter:
        async for u in db.users.find(user_filter, {"_id": 0, "id": 1}):
            user_ids.add(u["id"])
    q = {"user_id": {"$in": list(user_ids)}} if user_filter else {}
    rows: list[dict] = []
    async for t in db.push_tokens.find(q, {"_id": 0, "user_id": 1, "token": 1}):
        if t.get("token"):
            rows.append(t)
    return rows


async def _send_batches(db, rows: list[dict], f: SendIn) -> dict:
    if not rows:
        return {"requested": 0, "success": 0, "failure": 0, "removed_invalid": 0}
    if not firebase_admin._apps:
        raise HTTPException(500, "Firebase Admin non initialisé côté serveur.")

    tokens = [r["token"] for r in rows]
    success = 0
    failure = 0
    dead: list[str] = []

    webpush = messaging.WebpushConfig(
        fcm_options=messaging.WebpushFCMOptions(link=f.link) if f.link else None,
        notification=messaging.WebpushNotification(
            title=f.title, body=f.body, icon="/icon-192.png",
        ),
    )
    # FCM data values MUST be strings.
    data_payload = {str(k): str(v) for k, v in (f.data or {}).items()}

    for i in range(0, len(tokens), 500):
        batch = tokens[i:i + 500]
        msg = messaging.MulticastMessage(
            tokens=batch,
            notification=messaging.Notification(title=f.title, body=f.body),
            data=data_payload,
            webpush=webpush,
        )
        resp = messaging.send_each_for_multicast(msg)
        success += resp.success_count
        failure += resp.failure_count
        for tok, r in zip(batch, resp.responses):
            if r.success:
                continue
            exc = r.exception
            if isinstance(exc, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
                dead.append(tok)

    if dead:
        await db.push_tokens.delete_many({"token": {"$in": dead}})

    return {
        "requested": len(tokens),
        "success": success,
        "failure": failure,
        "removed_invalid": len(dead),
    }


def _build_group_filter(f: SendIn) -> dict:
    q: dict = {}
    if f.max_level_min is not None or f.max_level_max is not None:
        rng: dict = {}
        if f.max_level_min is not None:
            rng["$gte"] = int(f.max_level_min)
        if f.max_level_max is not None:
            rng["$lte"] = int(f.max_level_max)
        q["max_level"] = rng
    if f.country:
        q["country"] = f.country.upper()
    if f.status:
        q["status"] = f.status
    return q


@router.post("/admin/push/all")
async def admin_push_all(body: SendIn, request: Request, _=Depends(require_admin)):
    """Broadcast to every user who has at least one registered device token."""
    db = request.app.state.db
    rows = await _resolve_tokens(db, {})  # no filter → all tokens
    return await _send_batches(db, rows, body)


@router.post("/admin/push/user/{user_id}")
async def admin_push_user(user_id: str, body: SendIn, request: Request,
                          _=Depends(require_admin)):
    """Send to every device belonging to a single user."""
    db = request.app.state.db
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1})
    if not u:
        raise HTTPException(404, "Utilisateur introuvable.")
    rows = await _resolve_tokens(db, {"id": user_id})
    return await _send_batches(db, rows, body)


@router.post("/admin/push/group")
async def admin_push_group(body: SendIn, request: Request,
                           _=Depends(require_admin)):
    """Broadcast to users matching an audience filter."""
    db = request.app.state.db
    ufilter = _build_group_filter(body)
    if not ufilter:
        raise HTTPException(400, "Fournissez au moins un critère de groupe.")
    rows = await _resolve_tokens(db, ufilter)
    return await _send_batches(db, rows, body)


# ─────────────────────────────────────────────────────────────────────────────
# Admin: quick preview stats — how many devices for each audience
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/admin/push/stats")
async def admin_push_stats(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    total_users_with_token = len(
        await db.push_tokens.distinct("user_id")
    )
    total_devices = await db.push_tokens.count_documents({})
    per_level: list[dict] = []
    async for r in db.push_tokens.aggregate([
        {"$lookup": {"from": "users", "localField": "user_id",
                     "foreignField": "id", "as": "u"}},
        {"$unwind": "$u"},
        {"$group": {"_id": "$u.max_level", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]):
        per_level.append({"level": r["_id"], "devices": r["count"]})
    per_country: list[dict] = []
    async for r in db.push_tokens.aggregate([
        {"$lookup": {"from": "users", "localField": "user_id",
                     "foreignField": "id", "as": "u"}},
        {"$unwind": "$u"},
        {"$group": {"_id": "$u.country", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]):
        per_country.append({"country": r["_id"] or "?", "devices": r["count"]})
    return {
        "total_users_with_token": total_users_with_token,
        "total_devices": total_devices,
        "per_level": per_level,
        "per_country": per_country,
    }
