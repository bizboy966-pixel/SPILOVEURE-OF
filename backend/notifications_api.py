"""Lightweight in-app notifications API.

Consumed by any frontend hook that wants to show real-time toasts /
banners for reward credits, task completions, etc. Backed by the
existing `db.notifications` collection populated by ads.py + special_tasks.py
+ ashtec_activation.py.

Endpoints:
    GET  /api/me/notifications                — paginated list
    GET  /api/me/notifications/unread-count   — cheap unread counter
    POST /api/me/notifications/{id}/read      — mark one as read
    POST /api/me/notifications/mark-all-read  — mark all as read

Pragmatic delivery model:
    Frontend polls `/unread-count` every 10 s. When count goes up, it
    fetches the top notifications, shows toasts for the unseen ones, then
    hits mark-all-read. No websockets / SSE / vendor SDK required — this
    keeps the app portable and dependency-free.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user


router = APIRouter(prefix="/api/me/notifications", tags=["notifications"])


def _serialize(n: dict) -> dict:
    out = {k: v for k, v in n.items() if k != "_id"}
    if isinstance(out.get("created_at"), datetime):
        out["created_at"] = out["created_at"].astimezone(timezone.utc).isoformat()
    return out


@router.get("")
async def list_notifications(request: Request, user=Depends(get_current_user),
                             limit: int = 50, unread_only: bool = False,
                             since: Optional[str] = None):
    """Return notifications for the current user (newest first)."""
    db = request.app.state.db
    q: dict = {"user_id": user["id"]}
    if unread_only:
        q["read"] = False
    if since:
        try:
            q["created_at"] = {"$gt": datetime.fromisoformat(since.replace("Z", "+00:00"))}
        except Exception:
            pass
    items = []
    async for n in db.notifications.find(q).sort("created_at", -1).limit(min(limit, 200)):
        items.append(_serialize(n))
    return {"items": items}


@router.get("/unread-count")
async def unread_count(request: Request, user=Depends(get_current_user)):
    """Cheap counter — the polling hook hits this every ~10 s."""
    db = request.app.state.db
    n = await db.notifications.count_documents({"user_id": user["id"], "read": False})
    return {"unread": int(n)}


@router.post("/{notif_id}/read")
async def mark_read(notif_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    r = await db.notifications.update_one(
        {"id": notif_id, "user_id": user["id"]},
        {"$set": {"read": True, "read_at": datetime.now(timezone.utc)}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Notification introuvable.")
    return {"ok": True}


@router.post("/mark-all-read")
async def mark_all_read(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    r = await db.notifications.update_many(
        {"user_id": user["id"], "read": False},
        {"$set": {"read": True, "read_at": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "updated": r.modified_count}


@router.delete("/all")
async def delete_all(request: Request, user=Depends(get_current_user)):
    """v25 (2026-02-14) — wipe every notification for the current user.
    Powers the "Tout supprimer" button in the frontend notif center.
    Historical transactions are NOT affected — they live in db.transactions."""
    db = request.app.state.db
    r = await db.notifications.delete_many({"user_id": user["id"]})
    return {"ok": True, "deleted": r.deleted_count}
