"""Live chat module — user ↔ admin support (Phase 1).

Features:
  ▸ One private conversation per user (created lazily on first message).
  ▸ Text + image attachments (base64 data-URLs, max 800 KB per image, up to 4 per msg).
  ▸ Delivery ticks : sent → delivered → read (blue).
  ▸ Admin presence : heartbeat every 30s, "online" if last_seen < 90s.
  ▸ Push notifications to every admin on new user message; to the user on admin reply.
  ▸ Strict authorization : a user only sees their own conversation; admins see all.

Collections:
  chat_conversations : { id, user_id, username, last_message_at,
                         user_unread, admin_unread, created_at }
  chat_messages      : { id, conversation_id, sender_id, sender_role ("user"|"admin"),
                         text, images [data-urls], status ("sent"|"delivered"|"read"),
                         reply_to?, created_at, delivered_at?, read_at? }
  admin_presence     : { admin_id, username, last_seen }
"""
from __future__ import annotations

import base64
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin

log = logging.getLogger("chat")

api = APIRouter(prefix="/api/chat", tags=["chat"])
admin_router = APIRouter(prefix="/api/chat/admin", tags=["chat-admin"])


# Allow either admin OR an authorized support agent to reach admin endpoints.
async def require_admin_or_support(user: dict = Depends(get_current_user)) -> dict:
    role = (user.get("role") or "").lower()
    if role == "admin":
        return user
    if role == "support" and user.get("status") == "authorized":
        return user
    raise HTTPException(403, "Accès réservé à l'équipe support autorisée.")

MAX_TEXT_LEN = 4000
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 800 * 1024        # 800 KB per image after base64 decode
MAX_AUDIO_BYTES = 2 * 1024 * 1024   # 2 MB per voice note after base64 decode
RATE_LIMIT_WINDOW_SECS = 60
RATE_LIMIT_MAX_MSGS = 15            # per user per window (both roles)
ONLINE_WINDOW_SECS = 90


# ────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────
def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _get_or_create_conversation(db, user: dict) -> dict:
    conv = await db.chat_conversations.find_one({"user_id": user["id"]}, {"_id": 0})
    if conv:
        return conv
    now = _now()
    conv = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username") or user.get("email", ""),
        "email": user.get("email") or "",
        "last_message_at": now,
        "user_unread": 0,
        "admin_unread": 0,
        "created_at": now,
    }
    await db.chat_conversations.insert_one(conv)
    return conv


DATA_URL_RE = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$")
AUDIO_URL_RE = re.compile(r"^data:audio/(webm|mp3|mp4|mpeg|ogg|wav|x-m4a|aac);base64,([A-Za-z0-9+/=]+)$")


def _validate_images(images: List[str]) -> List[str]:
    """Return cleaned data-urls. Rejects invalid formats and oversized payloads."""
    out: List[str] = []
    for idx, du in enumerate((images or [])[:MAX_IMAGES]):
        m = DATA_URL_RE.match(du.strip())
        if not m:
            raise HTTPException(400, f"Image {idx + 1} : format invalide (attendu data:image/*;base64,...).")
        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except Exception:
            raise HTTPException(400, f"Image {idx + 1} : encodage base64 invalide.")
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(400, f"Image {idx + 1} : taille max 800 KB dépassée.")
        out.append(du)
    return out


def _validate_audio(audio: Optional[str]) -> Optional[str]:
    if not audio:
        return None
    m = AUDIO_URL_RE.match(audio.strip())
    if not m:
        raise HTTPException(400, "Message vocal : format invalide (attendu data:audio/*;base64,...).")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        raise HTTPException(400, "Message vocal : encodage base64 invalide.")
    if len(raw) > MAX_AUDIO_BYTES:
        raise HTTPException(400, "Message vocal : taille max 2 MB dépassée.")
    return audio.strip()


async def _enforce_rate_limit(db, sender_id: str):
    cutoff = _now() - timedelta(seconds=RATE_LIMIT_WINDOW_SECS)
    n = await db.chat_messages.count_documents({
        "sender_id": sender_id, "created_at": {"$gte": cutoff},
    })
    if n >= RATE_LIMIT_MAX_MSGS:
        raise HTTPException(429, f"Ralentissez : maximum {RATE_LIMIT_MAX_MSGS} messages par minute.")


async def _reply_preview(db, reply_to_id: Optional[str]) -> Optional[dict]:
    if not reply_to_id:
        return None
    doc = await db.chat_messages.find_one(
        {"id": reply_to_id}, {"_id": 0, "text": 1, "sender_role": 1,
                              "sender_username": 1, "images": 1, "audio": 1},
    )
    if not doc:
        return None
    txt = (doc.get("text") or "").strip()
    if not txt:
        if doc.get("audio"):
            txt = "🎤 Message vocal"
        elif doc.get("images"):
            txt = "📷 Photo"
    return {
        "id": reply_to_id,
        "sender_role": doc.get("sender_role") or "",
        "sender_username": doc.get("sender_username") or "",
        "preview": txt[:120],
    }


def _serialize_message(m: dict) -> dict:
    deleted = bool(m.get("deleted_at"))
    return {
        "id": m["id"],
        "conversation_id": m["conversation_id"],
        "sender_id": m["sender_id"],
        "sender_role": m["sender_role"],
        "sender_username": m.get("sender_username"),
        "text": "" if deleted else (m.get("text") or ""),
        "images": [] if deleted else (m.get("images") or []),
        "audio": None if deleted else (m.get("audio") or None),
        "status": m.get("status") or "sent",
        "reply_to": m.get("reply_to"),
        "reply_preview": None if deleted else m.get("reply_preview"),
        "created_at": m["created_at"].isoformat(),
        "read_at": m["read_at"].isoformat() if m.get("read_at") else None,
        "deleted": deleted,
    }


async def _admins_online_count(db) -> int:
    cutoff = _now() - timedelta(seconds=ONLINE_WINDOW_SECS)
    return await db.admin_presence.count_documents({"last_seen": {"$gte": cutoff}})


async def _support_online_effective(db) -> bool:
    """Effective online = force override, else schedule + heartbeat."""
    row = await db.app_settings.find_one({"key": "chat_schedule"}, {"_id": 0})
    sched = (row or {}).get("value") or {}
    mode = sched.get("mode") or "auto"
    if mode == "force_online":
        return True
    if mode == "force_offline":
        return False
    # auto: schedule check + at least one live heartbeat.
    if sched.get("schedule_enabled"):
        from datetime import datetime as _dt
        now = _dt.now(timezone.utc)
        # Monday=0 per Python weekday()
        if now.weekday() not in (sched.get("days") or [0, 1, 2, 3, 4]):
            return False
        h = now.hour
        s = int(sched.get("start_hour", 8)); e = int(sched.get("end_hour", 18))
        if not (s <= h < e):
            return False
    return (await _admins_online_count(db)) > 0


async def _notify_admins_of_new_message(db, conv: dict, msg: dict):
    """Push notification to every admin on new user message."""
    try:
        from push_helper import push_to_users
        admins = await db.users.find(
            {"role": "admin"}, {"_id": 0, "id": 1}
        ).to_list(200)
        preview = (msg.get("text") or "").strip()
        if not preview:
            if msg.get("audio"):
                preview = "🎤 Message vocal"
            elif msg.get("images"):
                preview = "📷 Photo"
            else:
                preview = "Nouveau message"
        await push_to_users(
            db, [a["id"] for a in admins],
            title=f"💬 {conv.get('username') or 'Utilisateur'}",
            body=preview[:120],
            link="/(admin)",
            data={"kind": "chat_new", "conversation_id": conv["id"]},
            tag=f"chat-{conv['id']}",
        )
    except Exception as e:
        log.warning("chat notify admins failed: %s", e)


async def _notify_user_of_admin_reply(db, conv: dict, msg: dict):
    try:
        from push_helper import push_to_user
        preview = (msg.get("text") or "").strip()
        if not preview:
            if msg.get("audio"):
                preview = "🎤 Message vocal"
            elif msg.get("images"):
                preview = "📷 Photo"
            else:
                preview = "Nouveau message"
        await push_to_user(
            db, conv["user_id"],
            title="💬 Support SPILOVEURE",
            body=preview[:120],
            link="/(app)/dashboard",
            data={"kind": "chat_reply", "conversation_id": conv["id"]},
            tag=f"chat-user-{conv['id']}",
        )
    except Exception as e:
        log.warning("chat notify user failed: %s", e)


# ────────────────────────────────────────────────────────────────────────
# USER endpoints
# ────────────────────────────────────────────────────────────────────────
class SendMessageIn(BaseModel):
    text: Optional[str] = ""
    images: Optional[List[str]] = None
    audio: Optional[str] = None
    reply_to: Optional[str] = None


@api.get("/support/status")
async def chat_support_status(request: Request, user=Depends(get_current_user)):
    """Public status : is support effectively online right now?"""
    db = request.app.state.db
    online = await _support_online_effective(db)
    return {"online": online, "online_count": await _admins_online_count(db)}


@api.get("/me")
async def chat_me(request: Request, user=Depends(get_current_user), limit: int = 100):
    """Return user's conversation + latest messages (oldest → newest)."""
    db = request.app.state.db
    conv = await _get_or_create_conversation(db, user)
    limit = max(1, min(limit, 500))
    cursor = db.chat_messages.find(
        {"conversation_id": conv["id"]}, {"_id": 0}
    ).sort("created_at", -1).limit(limit)
    msgs = [_serialize_message(m) async for m in cursor]
    msgs.reverse()
    return {
        "conversation": {
            "id": conv["id"],
            "user_unread": int(conv.get("user_unread") or 0),
            "last_message_at": conv["last_message_at"].isoformat()
                if conv.get("last_message_at") else None,
        },
        "support_online": await _support_online_effective(db),
        "messages": msgs,
    }


@api.post("/me/messages")
async def chat_send_user(body: SendMessageIn, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    await _enforce_rate_limit(db, user["id"])
    text = (body.text or "").strip()[:MAX_TEXT_LEN]
    images = _validate_images(body.images or [])
    audio = _validate_audio(body.audio)
    if not text and not images and not audio:
        raise HTTPException(400, "Message vide : ajoutez du texte, une image ou un vocal.")

    conv = await _get_or_create_conversation(db, user)
    reply_preview = await _reply_preview(db, body.reply_to)
    now = _now()
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conv["id"],
        "sender_id": user["id"],
        "sender_role": "user",
        "sender_username": user.get("username") or "",
        "text": text,
        "images": images,
        "audio": audio,
        "status": "delivered",
        "reply_to": body.reply_to if reply_preview else None,
        "reply_preview": reply_preview,
        "created_at": now,
    }
    await db.chat_messages.insert_one(msg)
    await db.chat_conversations.update_one(
        {"id": conv["id"]},
        {"$set": {"last_message_at": now, "username": msg["sender_username"] or conv.get("username", "")},
         "$inc": {"admin_unread": 1}},
    )
    await _notify_admins_of_new_message(db, conv, msg)
    return _serialize_message(msg)


@api.post("/me/mark-read")
async def chat_user_mark_read(request: Request, user=Depends(get_current_user)):
    """Mark all admin messages in this conversation as read by the user."""
    db = request.app.state.db
    conv = await db.chat_conversations.find_one({"user_id": user["id"]}, {"_id": 0})
    if not conv:
        return {"ok": True, "marked": 0}
    now = _now()
    r = await db.chat_messages.update_many(
        {"conversation_id": conv["id"], "sender_role": "admin", "read_at": None},
        {"$set": {"status": "read", "read_at": now}},
    )
    await db.chat_conversations.update_one({"id": conv["id"]}, {"$set": {"user_unread": 0}})
    return {"ok": True, "marked": r.modified_count}


@api.delete("/me/messages/{msg_id}")
async def chat_user_delete_message(msg_id: str, request: Request, user=Depends(get_current_user)):
    """User can delete only their own messages. Content is redacted, id kept."""
    db = request.app.state.db
    msg = await db.chat_messages.find_one({"id": msg_id}, {"_id": 0})
    if not msg:
        raise HTTPException(404, "Message introuvable.")
    if msg.get("sender_id") != user["id"]:
        raise HTTPException(403, "Vous ne pouvez supprimer que vos propres messages.")
    if msg.get("deleted_at"):
        return {"ok": True, "already_deleted": True}
    await db.chat_messages.update_one(
        {"id": msg_id},
        {"$set": {"deleted_at": _now(), "text": "", "images": [], "audio": None,
                  "reply_preview": None}},
    )
    return {"ok": True, "deleted": True}


# ────────────────────────────────────────────────────────────────────────
# ADMIN endpoints
# ────────────────────────────────────────────────────────────────────────
@admin_router.post("/heartbeat")
async def admin_heartbeat(request: Request, admin=Depends(require_admin_or_support)):
    db = request.app.state.db
    now = _now()
    await db.admin_presence.update_one(
        {"admin_id": admin["id"]},
        {"$set": {
            "admin_id": admin["id"],
            "username": admin.get("username") or admin.get("email", ""),
            "last_seen": now,
        }},
        upsert=True,
    )
    return {"ok": True, "now": now.isoformat()}


@admin_router.get("/conversations")
async def admin_list_conversations(request: Request, admin=Depends(require_admin_or_support)):
    """List all conversations, most recently active first."""
    db = request.app.state.db
    convs = []
    async for c in db.chat_conversations.find({}, {"_id": 0}).sort("last_message_at", -1).limit(200):
        # last message preview
        last = await db.chat_messages.find_one(
            {"conversation_id": c["id"]}, {"_id": 0, "text": 1, "images": 1, "sender_role": 1, "created_at": 1},
            sort=[("created_at", -1)],
        )
        preview = ""
        if last:
            preview = (last.get("text") or "").strip()
            if not preview and last.get("images"):
                preview = "📷 Photo"
        convs.append({
            "id": c["id"],
            "user_id": c["user_id"],
            "username": c.get("username") or "",
            "email": c.get("email") or "",
            "last_message_at": c["last_message_at"].isoformat() if c.get("last_message_at") else None,
            "admin_unread": int(c.get("admin_unread") or 0),
            "preview": preview[:120],
            "last_sender_role": (last or {}).get("sender_role", ""),
        })
    return {"conversations": convs}


@admin_router.get("/conversations/{conversation_id}/messages")
async def admin_get_messages(conversation_id: str, request: Request,
                              admin=Depends(require_admin_or_support), limit: int = 200):
    db = request.app.state.db
    conv = await db.chat_conversations.find_one({"id": conversation_id}, {"_id": 0})
    if not conv:
        raise HTTPException(404, "Conversation introuvable.")
    limit = max(1, min(limit, 500))
    cursor = db.chat_messages.find({"conversation_id": conversation_id}, {"_id": 0}) \
        .sort("created_at", -1).limit(limit)
    msgs = [_serialize_message(m) async for m in cursor]
    msgs.reverse()
    return {
        "conversation": {
            "id": conv["id"],
            "user_id": conv["user_id"],
            "username": conv.get("username") or "",
            "email": conv.get("email") or "",
        },
        "messages": msgs,
    }


@admin_router.post("/conversations/{conversation_id}/messages")
async def admin_send_message(conversation_id: str, body: SendMessageIn, request: Request,
                              admin=Depends(require_admin_or_support)):
    db = request.app.state.db
    conv = await db.chat_conversations.find_one({"id": conversation_id}, {"_id": 0})
    if not conv:
        raise HTTPException(404, "Conversation introuvable.")
    await _enforce_rate_limit(db, admin["id"])
    text = (body.text or "").strip()[:MAX_TEXT_LEN]
    images = _validate_images(body.images or [])
    audio = _validate_audio(body.audio)
    if not text and not images and not audio:
        raise HTTPException(400, "Message vide.")

    reply_preview = await _reply_preview(db, body.reply_to)
    now = _now()
    msg = {
        "id": str(uuid.uuid4()),
        "conversation_id": conversation_id,
        "sender_id": admin["id"],
        "sender_role": "admin",
        "sender_username": admin.get("username") or "Support",
        "text": text,
        "images": images,
        "audio": audio,
        "status": "delivered",
        "reply_to": body.reply_to if reply_preview else None,
        "reply_preview": reply_preview,
        "created_at": now,
    }
    await db.chat_messages.insert_one(msg)
    await db.chat_conversations.update_one(
        {"id": conversation_id},
        {"$set": {"last_message_at": now}, "$inc": {"user_unread": 1}},
    )
    # Refresh admin presence — they're clearly online right now.
    await db.admin_presence.update_one(
        {"admin_id": admin["id"]},
        {"$set": {"admin_id": admin["id"], "last_seen": now,
                  "username": admin.get("username") or admin.get("email", "")}},
        upsert=True,
    )
    await _notify_user_of_admin_reply(db, conv, msg)
    return _serialize_message(msg)


@admin_router.post("/conversations/{conversation_id}/mark-read")
async def admin_mark_read(conversation_id: str, request: Request, admin=Depends(require_admin_or_support)):
    db = request.app.state.db
    now = _now()
    r = await db.chat_messages.update_many(
        {"conversation_id": conversation_id, "sender_role": "user", "read_at": None},
        {"$set": {"status": "read", "read_at": now}},
    )
    await db.chat_conversations.update_one({"id": conversation_id}, {"$set": {"admin_unread": 0}})
    return {"ok": True, "marked": r.modified_count}


@admin_router.delete("/conversations/{conversation_id}/messages/{msg_id}")
async def admin_delete_message(conversation_id: str, msg_id: str, request: Request,
                                admin=Depends(require_admin_or_support)):
    """Admin/support can delete only their own outgoing messages."""
    db = request.app.state.db
    msg = await db.chat_messages.find_one(
        {"id": msg_id, "conversation_id": conversation_id}, {"_id": 0},
    )
    if not msg:
        raise HTTPException(404, "Message introuvable.")
    if msg.get("sender_id") != admin["id"]:
        raise HTTPException(403, "Vous ne pouvez supprimer que vos propres messages.")
    if msg.get("deleted_at"):
        return {"ok": True, "already_deleted": True}
    await db.chat_messages.update_one(
        {"id": msg_id},
        {"$set": {"deleted_at": _now(), "text": "", "images": [], "audio": None,
                  "reply_preview": None}},
    )
    return {"ok": True, "deleted": True}
