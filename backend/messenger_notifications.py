"""Chat-only notification preferences, previews and personal unread markers."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from messenger_core import allowed_pair, chat_user, event, get_message, member, person, rate_limit

api = APIRouter()
DEFAULTS = {
    "enabled": True, "sound_enabled": True, "preview": True,
    "sound": "default", "custom_name": "",
}


class NotificationSettingsIn(BaseModel):
    enabled: bool | None = None
    sound_enabled: bool | None = None
    preview: bool | None = None
    sound: Literal["default", "chime", "bell", "custom"] | None = None
    custom_name: str | None = Field(default=None, max_length=120)
    inherit: bool | None = None


async def notification_settings(db, uid, cid=None):
    global_row = await db.spv_settings.find_one({"user_id": uid}) or {}
    general = DEFAULTS | global_row.get("notifications", {})
    if not cid:
        return general
    pref = await db.spv_preferences.find_one({"user_id": uid, "conversation_id": cid}) or {}
    custom = pref.get("notifications", {})
    inherited = custom.get("inherit", True)
    effective = general if inherited else DEFAULTS | custom
    return {**effective, "inherit": inherited}


async def effective_notifications(db, uid, cid):
    global_settings = await notification_settings(db, uid)
    settings = await notification_settings(db, uid, cid)
    pref = await db.spv_preferences.find_one({"user_id": uid, "conversation_id": cid}) or {}
    # A global off switch and legacy conversation mute always take precedence.
    settings["enabled"] = global_settings["enabled"] and settings["enabled"] and not pref.get("muted", False)
    settings["scope"] = "global" if settings.get("inherit", True) else cid
    return settings


@api.get("/notification-settings")
async def get_settings(request: Request, user=Depends(chat_user)):
    return await notification_settings(request.app.state.db, user["id"])


@api.patch("/notification-settings")
async def patch_settings(body: NotificationSettingsIn, request: Request, user=Depends(chat_user)):
    changes = body.model_dump(exclude_none=True, exclude={"inherit"})
    db, uid = request.app.state.db, user["id"]
    if changes:
        await db.spv_settings.update_one({"user_id": uid}, {
            "$set": {f"notifications.{key}": value for key, value in changes.items()},
        }, upsert=True)
        await event(db, [uid], {"type": "notification_preferences"})
    return await notification_settings(db, uid)


@api.get("/conversations/{cid}/notification-settings")
async def get_conversation_settings(cid: str, request: Request, user=Depends(chat_user)):
    await member(request.app.state.db, cid, user)
    return await notification_settings(request.app.state.db, user["id"], cid)


@api.patch("/conversations/{cid}/notification-settings")
async def patch_conversation_settings(cid: str, body: NotificationSettingsIn, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    await member(db, cid, user)
    changes = body.model_dump(exclude_none=True)
    if changes:
        await db.spv_preferences.update_one({"user_id": uid, "conversation_id": cid}, {
            "$set": {f"notifications.{key}": value for key, value in changes.items()},
        }, upsert=True)
        await event(db, [uid], {"type": "notification_preferences", "conversation_id": cid})
    return await notification_settings(db, uid, cid)


@api.get("/conversations/{cid}/messages/{mid}/notification")
async def notification_preview(cid: str, mid: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    conv = await member(db, cid, user)
    message = await get_message(db, conv, mid)
    if message.get("deleted") or message["sender_id"] == uid or message.get("silent"):
        raise HTTPException(404, "Notification indisponible.")
    await allowed_pair(db, uid, message["sender_id"])
    settings = await effective_notifications(db, uid, cid)
    if not settings["enabled"]:
        return {"enabled": False}
    sender = await db.users.find_one({"id": message["sender_id"]})
    if not sender:
        raise HTTPException(404, "Notification indisponible.")
    profile = await person(db, sender)
    attachments = message.get("attachments") or []
    text = message.get("text") or ("Message vocal" if any(
        file.get("mime", "").startswith("audio/") for file in attachments
    ) else "Photo" if any(file.get("mime", "").startswith("image/") for file in attachments)
        else "Pièce jointe" if attachments else "Nouveau message")
    return {
        "enabled": True, "conversation_id": cid, "message_id": mid,
        "title": profile["username"] if settings["preview"] else "SPILOVEURE Chat",
        "body": text[:300] if settings["preview"] else "Vous avez reçu un nouveau message.",
        "avatar": profile.get("avatar") if settings["preview"] else None,
        "conversation_title": conv.get("title") if conv["kind"] != "private" and settings["preview"] else None,
        "settings": settings,
    }


@api.post("/conversations/{cid}/unread")
async def mark_unread(cid: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    await member(db, cid, user)
    await rate_limit(db, uid, "spv_unread", 60)
    await db.spv_preferences.update_one({"user_id": uid, "conversation_id": cid}, {
        "$set": {"force_unread": True},
    }, upsert=True)
    # Personal reminder only: never revoke the recipient's actual read receipts.
    await event(db, [uid], {"type": "updated", "conversation_id": cid})
    return {"ok": True}
