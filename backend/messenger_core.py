"""Isolated community messenger. Never reads/writes legacy support collections."""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from identity_core import require_chat


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier():
    return str(uuid.uuid4())


async def chat_user(user=Depends(require_chat)):
    # Verified-email Chat sessions are independent of paid activation.
    return user


def clean(document):
    if document is None:
        return None
    return {key: value for key, value in document.items() if key != "_id"}


async def initialize(db):
    """Idempotent indexes, all limited to new collections."""
    await db.spv_conversations.create_index("id", unique=True)
    await db.spv_conversations.create_index("private_key", unique=True, sparse=True)
    await db.spv_conversations.create_index([("members", 1), ("updated_at", -1)])
    await db.spv_posts.create_index([("is_official", 1), ("created_at", -1)])
    await db.spv_messages.create_index("id", unique=True)
    await db.spv_messages.create_index(
        [("conversation_id", 1), ("sender_id", 1), ("client_id", 1)], unique=True
    )
    await db.spv_messages.create_index([("conversation_id", 1), ("created_at", -1)])
    await db.spv_messages.create_index("expires_at", expireAfterSeconds=0)
    await db.spv_contacts.create_index([("user_id", 1), ("peer_id", 1)], unique=True)
    await db.users.create_index("chat_username_normalized", unique=True, sparse=True)
    await db.spv_blocks.create_index([("user_id", 1), ("peer_id", 1)], unique=True)
    await db.spv_preferences.create_index([("user_id", 1), ("conversation_id", 1)], unique=True)
    await db.spv_settings.create_index("user_id", unique=True)
    await db.spv_chat_lists.create_index("id", unique=True)
    await db.spv_chat_lists.create_index([("owner_id", 1), ("name_key", 1)], unique=True)
    await db.spv_chat_lists.create_index([("owner_id", 1), ("updated_at", -1)])
    await db.spv_presence.create_index("user_id", unique=True)
    await db.spv_tickets.create_index("digest", unique=True)
    await db.spv_tickets.create_index("expires_at", expireAfterSeconds=0)
    await db.spv_events.create_index("expires_at", expireAfterSeconds=0)
    await db.spv_events.create_index([("recipients", 1), ("_id", 1)])
    await db.spv_comment_limits.create_index("expires_at", expireAfterSeconds=0)
    await db.spv_files.create_index("id", unique=True)
    await db.spv_files.create_index("expires_at")
    await db.spv_stickers.create_index([("user_id", 1), ("file_id", 1)], unique=True)
    await db.spv_sticker_pack_items.create_index([("user_id", 1), ("file_id", 1)], unique=True)
    await db.spv_sticker_pack_items.create_index([("user_id", 1), ("added_at", -1)])
    await db.spv_posts.create_index("id", unique=True)
    await db.spv_statuses.create_index("id", unique=True)
    await db.spv_statuses.create_index([("author_id", 1), ("expires_at", 1)])
    await db.spv_statuses.create_index("expires_at", expireAfterSeconds=0)
    await db.spv_feed_reads.create_index("user_id", unique=True)
    await db.spv_invite_links.create_index("token_hash", unique=True)
    await db.spv_invite_links.create_index([("conversation_id", 1), ("revoked", 1)])
    await db.spv_scheduled.create_index("id", unique=True)
    await db.spv_scheduled.create_index(
        [("conversation_id", 1), ("sender_id", 1), ("client_id", 1)], unique=True,
    )
    await db.spv_scheduled.create_index([("status", 1), ("scheduled_at", 1)])
    await db.spv_push_outbox.create_index("id", unique=True)
    await db.spv_push_outbox.create_index("expires_at", expireAfterSeconds=0)


async def event(db, recipients, payload):
    await db.spv_events.insert_one({
        "recipients": list(set(recipients)), "payload": payload,
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=24),
    })


async def notify(db, conversation, kind="updated", **extra):
    await event(db, conversation["members"], {
        "type": kind, "conversation_id": conversation["id"], **extra,
    })


async def member(db, cid, user):
    conv = await db.spv_conversations.find_one({"id": cid, "members": user["id"]})
    if not conv:
        raise HTTPException(404, "Conversation introuvable.")
    return conv


def administrator(conv, user):
    if user["id"] not in conv["admins"]:
        raise HTTPException(403, "Action réservée aux administrateurs de cette discussion.")


def default_permissions(kind):
    return {
        "send_messages": "admins" if kind == "channel" else "all",
        "add_members": False,
        "edit_info": False,
    }


async def allowed_pair(db, uid, peer):
    if await db.spv_blocks.find_one({"$or": [
        {"user_id": uid, "peer_id": peer}, {"user_id": peer, "peer_id": uid},
    ]}):
        raise HTTPException(403, "Échange indisponible : un blocage est actif.")


async def person(db, user):
    return (await people_views(db, [user]))[0]


def display_name(user):
    return user.get("chat_username") or user.get("username", "Membre")


async def people_views(db, users):
    ids = [user["id"] for user in users]
    settings = {row["user_id"]: row async for row in db.spv_settings.find({"user_id": {"$in": ids}})}
    presence = {row["user_id"]: row async for row in db.spv_presence.find({"user_id": {"$in": ids}})}
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=70)).isoformat()
    result = []
    for user in users:
        seen = presence.get(user["id"], {}).get("last_seen")
        visible = settings.get(user["id"], {}).get("show_presence", True)
        connections = presence.get(user["id"], {}).get("online_count", 1)
        result.append({
            "id": user["id"], "username": display_name(user),
            "avatar": user.get("profile_photo") or user.get("avatar_url", ""),
            "online": bool(visible and connections > 0 and seen and seen > cutoff),
            "last_seen": seen if visible else None,
        })
    return result


async def conversation_view(db, conv, uid):
    pref = await db.spv_preferences.find_one({"user_id": uid, "conversation_id": conv["id"]}) or {}
    users = await db.users.find(
        {"id": {"$in": conv["members"]}},
        {"id": 1, "username": 1, "chat_username": 1, "avatar_url": 1, "profile_photo": 1},
    ).to_list(200)
    profiles = await people_views(db, users)
    expiry_filter = {"$or": [
        {"expires_at": {"$exists": False}}, {"expires_at": None},
        {"expires_at": {"$gt": datetime.now(timezone.utc)}},
    ]}
    last = await db.spv_messages.find_one(
        {"conversation_id": conv["id"], "deleted": False, "hidden_for": {"$nin": [uid]}, **expiry_filter},
        sort=[("created_at", -1), ("id", -1)],
    )
    unread = await db.spv_messages.count_documents({
        "conversation_id": conv["id"], "sender_id": {"$ne": uid},
        "created_at": {"$gt": pref.get("read_at", "")}, "deleted": False,
        "hidden_for": {"$nin": [uid]},
        **expiry_filter,
    })
    is_saved = bool(conv.get("is_saved") or conv.get("kind") == "saved")
    title = "Messages enregistrés" if is_saved else conv["title"]
    if conv["kind"] == "private" and not is_saved:
        title = next((p["username"] for p in profiles if p["id"] != uid), "Conversation privée")
    return {
        **clean(conv), "kind": "private" if is_saved else conv["kind"],
        "is_saved": is_saved, "title": title, "member_profiles": profiles,
        "permissions": conv.get("permissions") or default_permissions(conv["kind"]),
        "disappearing_seconds": conv.get("disappearing_seconds", 0),
        "last_message": clean(last), "unread": max(unread, 1) if pref.get("force_unread") else unread,
        **{key: pref.get(key, default) for key, default in [
            ("muted", False), ("archived", False), ("pinned", False), ("draft", ""), ("read_at", ""),
        ]},
    }


async def get_message(db, conv, mid):
    msg = await db.spv_messages.find_one({"id": mid, "conversation_id": conv["id"]})
    if not msg:
        raise HTTPException(404, "Message introuvable.")
    return msg


class ConversationIn(BaseModel):
    kind: str = Field(pattern="^(private|group|channel|saved)$")
    title: str = Field(default="", max_length=120)
    member_ids: list[str] = Field(default_factory=list, max_length=200)
    is_public: bool = False


class ConversationPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    photo: str | None = Field(default=None, max_length=400)
    muted: bool | None = None
    archived: bool | None = None
    pinned: bool | None = None
    draft: str | None = Field(default=None, max_length=8000)
    is_public: bool | None = None
    permissions: dict[str, str | bool] | None = None
    disappearing_seconds: int | None = Field(default=None, ge=0, le=7776000)


class Attachment(BaseModel):
    id: str
    name: str = ""
    mime: str = ""
    size: int = 0
    url: str = ""
    duration_seconds: float | None = Field(default=None, ge=0, le=7200)
    view_once: bool = False
    view_once_opened: bool = False


class MessageIn(BaseModel):
    text: str = Field(default="", max_length=8000)
    client_id: str = Field(min_length=1, max_length=120)
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)
    reply_to: str | None = None
    status_reply_id: str | None = Field(default=None, max_length=100)
    forwarded_from: str | None = None
    silent: bool = False


class ChatListIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    conversation_ids: list[str] = Field(default_factory=list, max_length=50)


class BroadcastIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


class MemberIn(BaseModel):
    user_id: str
    action: str = Field(pattern="^(add|remove|promote|demote)$")


async def attachments_checked(db, supplied, user, scope):
    """Trust persisted metadata only, not URLs/mime/size supplied by a client."""
    result = []
    for item in supplied:
        stored = await db.spv_files.find_one({"id": item.id, "owner_id": user["id"], "scope": scope})
        if not stored:
            raise HTTPException(400, "Pièce jointe non autorisée.")
        keys = ["id", "name", "mime", "size", "url"]
        if stored.get("sticker"):
            keys.append("sticker")
        if "duration_seconds" in stored:
            keys.append("duration_seconds")
        if stored.get("view_once"):
            keys.append("view_once")
        result.append({key: stored[key] for key in keys})
    return result


async def message_views(db, messages, user_id):
    """Expose only the current member's one-time voice playback state."""
    views = [clean(message) for message in messages]
    file_ids = [
        attachment["id"]
        for message in views
        for attachment in message.get("attachments", [])
        if attachment.get("view_once")
    ]
    if not file_ids:
        return views
    file_rows = await db.spv_files.find(
        {"id": {"$in": file_ids}, "view_once": True},
        {"id": 1, "view_once_opened_by": 1},
    ).to_list(len(file_ids))
    opened_by_file = {
        row["id"]: set(row.get("view_once_opened_by") or [])
        for row in file_rows
    }
    for message in views:
        for attachment in message.get("attachments", []):
            if attachment.get("view_once"):
                attachment["view_once_opened"] = user_id in opened_by_file.get(attachment["id"], set())
    return views


async def rate_limit(db, uid, collection="spv_messages", maximum=60):
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    if await db[collection].count_documents({"sender_id": uid, "created_at": {"$gte": cutoff}}) >= maximum:
        raise HTTPException(429, "Trop d'envois. Réessayez dans une minute.")


async def ticket(db, uid, session_id=None):
    value = secrets.token_urlsafe(32)
    await db.spv_tickets.insert_one({
        "digest": hashlib.sha256(value.encode()).hexdigest(), "user_id": uid,
        "session_id": session_id,
        "expires_at": datetime.now(timezone.utc) + timedelta(seconds=30),
    })
    return value
