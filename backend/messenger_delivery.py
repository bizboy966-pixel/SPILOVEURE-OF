"""Scheduled delivery, discoverable channels and notification outbox."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from messenger_core import (
    MessageIn, administrator, allowed_pair, attachments_checked, chat_user,
    clean, conversation_view, event, get_message, identifier, member, notify,
    now, rate_limit,
)

api = APIRouter()
log = logging.getLogger("messenger.delivery")


@api.get("/capabilities")
async def capabilities(user=Depends(chat_user)):
    import firebase_admin
    return {
        "scheduled_messages": True, "public_channels": True,
        "push_configured": bool(firebase_admin._apps),
        "calls": False,
        "calls_reason": "Les appels nécessitent une intégration WebRTC/TURN et des tests sur plusieurs réseaux.",
        "end_to_end_encryption": False,
    }


@api.get("/channels")
async def channels(request: Request, q: str = Query(default="", max_length=100), user=Depends(chat_user)):
    import re
    db = request.app.state.db
    query = {"kind": "channel", "is_public": True}
    if q.strip():
        query["title"] = {"$regex": re.escape(q.strip()), "$options": "i"}
    result = []
    async for row in db.spv_conversations.find(query).sort("updated_at", -1).limit(50):
        try:
            await allowed_pair(db, user["id"], row["owner_id"])
        except HTTPException:
            continue
        # Public discovery exposes only channel metadata, never membership lists.
        result.append({
            "id": row["id"], "title": row["title"], "member_count": len(row["members"]),
            "joined": user["id"] in row["members"],
        })
    return result


@api.post("/channels/{cid}/join")
async def join_channel(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await db.spv_conversations.find_one({"id": cid, "kind": "channel", "is_public": True})
    if not conv:
        raise HTTPException(404, "Canal public introuvable.")
    await allowed_pair(db, user["id"], conv["owner_id"])
    if user["id"] not in conv["members"]:
        result = await db.spv_conversations.update_one(
            {"id": cid, "is_public": True, "members.199": {"$exists": False}},
            {"$addToSet": {"members": user["id"]}},
        )
        if not result.matched_count:
            raise HTTPException(409, "Canal complet (200 membres dans cette version).")
        conv = await member(db, cid, user)
        await notify(db, conv)
    return await conversation_view(db, conv, user["id"])


class ScheduledIn(MessageIn):
    scheduled_at: datetime


@api.get("/conversations/{cid}/scheduled")
async def scheduled(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await member(db, cid, user)
    rows = await db.spv_scheduled.find({
        "conversation_id": cid, "sender_id": user["id"],
        "status": {"$in": ["pending", "processing", "failed"]},
    }).sort("scheduled_at", 1).limit(100).to_list(100)
    return [clean(row) for row in rows]


@api.post("/conversations/{cid}/scheduled")
async def schedule(cid: str, body: ScheduledIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    if conv["kind"] == "channel":
        administrator(conv, user)
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Le message est vide.")
    timestamp = body.scheduled_at
    if timestamp.tzinfo is None:
        raise HTTPException(400, "Le fuseau horaire de programmation est obligatoire.")
    timestamp = timestamp.astimezone(timezone.utc)
    current = datetime.now(timezone.utc)
    if timestamp <= current or timestamp > current + timedelta(days=365):
        raise HTTPException(400, "Choisissez une date future dans les 365 prochains jours.")
    await attachments_checked(db, body.attachments, user, cid)
    if body.reply_to:
        await get_message(db, conv, body.reply_to)
    await rate_limit(db, user["id"], "spv_scheduled", 10)
    if await db.spv_scheduled.count_documents({"sender_id": user["id"], "status": "pending"}) >= 100:
        raise HTTPException(400, "Limite de 100 messages programmés atteinte.")
    previous = await db.spv_scheduled.find_one({"sender_id": user["id"], "client_id": body.client_id, "conversation_id": cid})
    if previous:
        return clean(previous)
    row = {
        "id": identifier(), "sender_id": user["id"], "conversation_id": cid,
        "client_id": body.client_id, "payload": body.model_dump(exclude={"scheduled_at"}),
        "scheduled_at": timestamp.isoformat(), "created_at": now(), "status": "pending",
    }
    try:
        await db.spv_scheduled.insert_one(row)
    except DuplicateKeyError:
        row = await db.spv_scheduled.find_one({
            "sender_id": user["id"], "client_id": body.client_id, "conversation_id": cid,
        })
    return clean(row)


@api.delete("/conversations/{cid}/scheduled/{sid}")
async def cancel_schedule(cid: str, sid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await member(db, cid, user)
    result = await db.spv_scheduled.delete_one({
        "id": sid, "conversation_id": cid, "sender_id": user["id"], "status": {"$in": ["pending", "failed"]},
    })
    if not result.deleted_count:
        raise HTTPException(409, "Message déjà envoyé, en cours d'envoi ou introuvable.")
    return {"ok": True}


async def enqueue_push(db, conv, message):
    recipients = []
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=70)).isoformat()
    for uid in conv["members"]:
        if uid == message["sender_id"]:
            continue
        pref = await db.spv_preferences.find_one({"user_id": uid, "conversation_id": conv["id"]}) or {}
        online = await db.spv_presence.find_one({
            "user_id": uid, "last_seen": {"$gte": cutoff}, "online_count": {"$ne": 0},
        })
        if not pref.get("muted", False) and not online:
            recipients.append(uid)
    if not recipients:
        return
    await db.spv_push_outbox.update_one({"id": message["id"]}, {"$setOnInsert": {
        "recipients": recipients, "conversation_id": conv["id"], "status": "pending",
        "created_at": now(), "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
    }}, upsert=True)


async def deliver_scheduled_once(db):
    """Claim with a lease; retries reuse message client_id after a process crash."""
    from messenger import deliver_message
    current = now()
    row = await db.spv_scheduled.find_one_and_update({
        "$or": [
            {"status": "pending", "scheduled_at": {"$lte": current}},
            {"status": "processing", "lease_until": {"$lt": current}},
        ],
    }, {"$set": {
        "status": "processing", "lease_until": (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat(),
    }}, return_document=ReturnDocument.AFTER)
    if not row:
        return False
    try:
        user = await db.users.find_one({"id": row["sender_id"]})
        if not user or user.get("status") in ("banned", "blocked") or (
            user.get("role") != "admin" and user.get("status") != "active" and (user.get("max_level") or 0) < 1
        ):
            raise HTTPException(403, "Le compte ne peut plus envoyer de message.")
        await deliver_message(db, row["conversation_id"], MessageIn(**row["payload"]), user)
        await db.spv_scheduled.update_one({"id": row["id"]}, {"$set": {"status": "sent"}})
    except HTTPException as exc:
        await db.spv_scheduled.update_one({"id": row["id"]}, {"$set": {"status": "failed", "error": exc.detail}})
    return True


async def deliver_push_once(db):
    from push_helper import push_to_users
    import firebase_admin
    row = await db.spv_push_outbox.find_one({"status": "pending"})
    if not row:
        return
    if not firebase_admin._apps:
        await db.spv_push_outbox.update_one({"id": row["id"]}, {"$set": {
            "status": "unconfigured", "error": "Firebase non configuré : aucune notification envoyée.",
        }})
        return
    conv = await db.spv_conversations.find_one({"id": row["conversation_id"]})
    recipients = []
    for uid in row["recipients"]:
        if not conv or uid not in conv["members"]:
            continue
        pref = await db.spv_preferences.find_one({"user_id": uid, "conversation_id": conv["id"]}) or {}
        if not pref.get("muted", False):
            recipients.append(uid)
    result = await push_to_users(
        db, recipients, title="SPILOVEURE Chat", body="Vous avez reçu un nouveau message.",
        link="/messenger", data={"conversation_id": row["conversation_id"]}, tag="chat-" + row["conversation_id"],
    )
    await db.spv_push_outbox.update_one({"id": row["id"]}, {"$set": {
        "status": "failed" if result.get("error") or result.get("failure") else "sent",
        "result": result,
    }})


async def delivery_worker(db):
    while True:
        try:
            for _ in range(20):
                if not await deliver_scheduled_once(db):
                    break
            await deliver_push_once(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Messenger delivery iteration failed")
        await asyncio.sleep(2)
