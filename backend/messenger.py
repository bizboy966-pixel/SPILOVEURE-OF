"""Community messenger REST API, deliberately separate from /api/chat support."""
from __future__ import annotations

import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pymongo.errors import DuplicateKeyError

from messenger_core import (
    ConversationIn, ConversationPatch, MemberIn, MessageIn, ReactionIn, TextIn,
    administrator, allowed_pair, attachments_checked, chat_user, clean,
    conversation_view, default_permissions, event, get_message, identifier, member, notify, now,
    person, rate_limit, ticket,
)

api = APIRouter(prefix="/api/messenger", tags=["messenger"])
from messenger_notifications import api as notification_api
api.include_router(notification_api)


@api.get("/people")
async def people(request: Request, q: str = Query(default="", max_length=100), user=Depends(chat_user)):
    import re
    query = q.strip()
    exact_username = False
    if query.lower().startswith("spv@"):
        query = query[4:].strip()
        exact_username = True
    elif query.startswith("@"):
        query = query[1:].strip()
        exact_username = True
    if len(query) < 2:
        return []
    username_pattern = f"^{re.escape(query)}$" if exact_username else re.escape(query)
    rows = []
    async for row in request.app.state.db.users.find({
        "id": {"$ne": user["id"]}, "status": {"$nin": ["banned", "blocked"]},
        "username": {"$regex": username_pattern, "$options": "i"},
    }, {"id": 1, "username": 1, "avatar_url": 1, "profile_photo": 1}).limit(30):
        rows.append(await person(request.app.state.db, row))
    return rows


@api.get("/conversations")
async def conversations(request: Request, archived: bool = False, user=Depends(chat_user)):
    db = request.app.state.db
    result = []
    async for conv in db.spv_conversations.find({"members": user["id"]}).sort("updated_at", -1).limit(300):
        view = await conversation_view(db, conv, user["id"])
        if view["archived"] == archived:
            result.append(view)
    return sorted(result, key=lambda c: (c["pinned"], c["updated_at"]), reverse=True)


@api.post("/conversations")
async def create_conversation(body: ConversationIn, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    ids = sorted(set(body.member_ids) - {uid})
    if body.kind == "private" and len(ids) != 1:
        raise HTTPException(400, "Choisissez un seul destinataire.")
    if body.kind in ("group", "channel") and not body.title.strip():
        raise HTTPException(400, "Le nom est obligatoire.")
    saved = body.kind == "saved"
    if saved:
        ids = []
    if ids:
        existing = await db.users.count_documents({"id": {"$in": ids}, "status": {"$nin": ["banned", "blocked"]}})
        if existing != len(ids):
            raise HTTPException(400, "Un membre est introuvable ou indisponible.")
        for peer in ids:
            await allowed_pair(db, uid, peer)
    private_key = None
    if body.kind == "private":
        private_key = ":".join(sorted([uid, *ids]))
    elif body.kind == "saved":
        private_key = "saved:" + uid
    if private_key:
        previous = await db.spv_conversations.find_one({"private_key": private_key})
        if previous:
            if saved:
                await db.spv_conversations.update_one(
                    {"id": previous["id"]},
                    {"$set": {"kind": "private", "is_saved": True, "title": "Messages enregistrés"}},
                )
                previous.update({"kind": "private", "is_saved": True, "title": "Messages enregistrés"})
            await db.spv_preferences.update_one(
                {"user_id": uid, "conversation_id": previous["id"]},
                {"$set": {"archived": False}}, upsert=True,
            )
            return await conversation_view(db, previous, uid)
    stamp = now()
    conv = {
        "id": identifier(), "kind": "private" if saved else body.kind,
        "is_saved": saved,
        "title": body.title.strip() if not saved else "Messages enregistrés",
        "photo": "", "members": [uid, *ids], "admins": [uid], "owner_id": uid,
        "created_at": stamp, "updated_at": stamp,
        "is_public": body.is_public if body.kind == "channel" else False,
        "permissions": default_permissions(body.kind),
    }
    if private_key:
        conv["private_key"] = private_key
    try:
        await db.spv_conversations.insert_one(conv)
    except DuplicateKeyError:
        conv = await db.spv_conversations.find_one({"private_key": private_key})
    await notify(db, conv)
    return await conversation_view(db, conv, uid)


@api.get("/conversations/{cid}")
async def detail(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    return await conversation_view(db, await member(db, cid, user), user["id"])


@api.patch("/conversations/{cid}")
async def update_conversation(cid: str, body: ConversationPatch, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    changes = body.model_dump(exclude_none=True)
    permission_changes = changes.pop("permissions", None)
    meta = {k: v for k, v in changes.items() if k in ("title", "photo", "is_public")}
    if permission_changes is not None:
        if conv["kind"] not in ("group", "channel"):
            raise HTTPException(400, "Les permissions sont réservées aux groupes et canaux.")
        administrator(conv, user)
        allowed_keys = {"send_messages", "add_members", "edit_info"}
        if set(permission_changes) - allowed_keys:
            raise HTTPException(400, "Permission non reconnue.")
        merged = default_permissions(conv["kind"]) | (conv.get("permissions") or {}) | permission_changes
        if merged.get("send_messages") not in ("all", "admins"):
            raise HTTPException(400, "Choisissez qui peut envoyer des messages.")
        if not isinstance(merged.get("add_members"), bool) or not isinstance(merged.get("edit_info"), bool):
            raise HTTPException(400, "Les permissions doivent être activées ou désactivées.")
        meta["permissions"] = merged
    if meta:
        if conv["kind"] not in ("group", "channel"):
            raise HTTPException(400, "Cette conversation ne peut pas être renommée.")
        is_admin = user["id"] in conv["admins"] or user["id"] == conv["owner_id"]
        can_edit_info = is_admin or (conv["kind"] == "group" and bool((conv.get("permissions") or {}).get("edit_info")))
        if not can_edit_info or (("is_public" in meta or "permissions" in meta) and not is_admin):
            administrator(conv, user)
        if "is_public" in meta and conv["kind"] != "channel":
            raise HTTPException(400, "La découverte publique est réservée aux canaux.")
        if "title" in meta and not meta["title"].strip():
            raise HTTPException(400, "Le nom est obligatoire.")
        # Only protected uploaded images, never arbitrary external tracking URLs.
        if meta.get("photo"):
            file = await db.spv_files.find_one({"url": meta["photo"], "scope": cid})
            if not file or not file["mime"].startswith("image/"):
                raise HTTPException(400, "Choisissez une image envoyée dans cette discussion.")
        await db.spv_conversations.update_one({"id": cid}, {"$set": meta})
        conv.update(meta)
        await notify(db, conv)
    pref = {k: v for k, v in changes.items() if k not in ("title", "photo", "is_public")}
    if pref:
        await db.spv_preferences.update_one({"user_id": user["id"], "conversation_id": cid}, {"$set": pref}, upsert=True)
        if "muted" in pref:
            await event(db, [user["id"]], {"type": "notification_preferences", "conversation_id": cid})
    return await conversation_view(db, conv, user["id"])


@api.post("/conversations/{cid}/invite-link")
async def create_invite_link(cid: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    conv = await member(db, cid, user)
    can_invite = uid in conv["admins"] or uid == conv["owner_id"] or bool((conv.get("permissions") or {}).get("add_members"))
    if conv["kind"] not in ("group", "channel") or not can_invite:
        raise HTTPException(403, "Vous n’avez pas le droit de créer un lien d’invitation.")
    token = secrets.token_urlsafe(24)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    await db.spv_invite_links.update_many(
        {"conversation_id": cid, "revoked": False}, {"$set": {"revoked": True}},
    )
    await db.spv_invite_links.insert_one({
        "id": identifier(), "conversation_id": cid, "token_hash": token_hash,
        "created_by": uid, "created_at": now(), "revoked": False,
    })
    return {"token": token}


@api.delete("/conversations/{cid}/invite-link")
async def revoke_invite_link(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    administrator(conv, user)
    await db.spv_invite_links.update_many(
        {"conversation_id": cid, "revoked": False}, {"$set": {"revoked": True}},
    )
    return {"ok": True}


@api.post("/invites/{token}/join")
async def join_invite(token: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    invite = await db.spv_invite_links.find_one({"token_hash": token_hash, "revoked": False})
    if not invite:
        raise HTTPException(404, "Ce lien d’invitation est invalide ou a été désactivé.")
    conv = await db.spv_conversations.find_one({"id": invite["conversation_id"]})
    if not conv or conv["kind"] not in ("group", "channel"):
        raise HTTPException(404, "Le groupe ou canal n’est plus disponible.")
    if uid not in conv["members"]:
        if len(conv["members"]) >= 200:
            raise HTTPException(400, "Ce groupe ou canal a atteint sa limite de membres.")
        await db.spv_conversations.update_one({"id": conv["id"]}, {"$addToSet": {"members": uid}})
        conv = await db.spv_conversations.find_one({"id": conv["id"]})
        await notify(db, conv)
        await event(db, conv["members"], {"type": "updated", "conversation_id": conv["id"]})
    return await conversation_view(db, conv, uid)


@api.post("/conversations/{cid}/members")
async def members(cid: str, body: MemberIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    if conv["kind"] not in ("group", "channel"):
        raise HTTPException(400, "Action réservée aux groupes et canaux.")
    is_admin = user["id"] in conv["admins"] or user["id"] == conv["owner_id"]
    if not is_admin and not (body.action == "add" and (conv.get("permissions") or {}).get("add_members")):
        administrator(conv, user)
    peer = body.user_id
    if peer == conv["owner_id"]:
        raise HTTPException(400, "Le propriétaire conserve son rôle.")
    if body.action in ("promote", "demote") and user["id"] != conv["owner_id"]:
        raise HTTPException(403, "Seul le propriétaire gère les administrateurs.")
    if peer in conv["admins"] and user["id"] != conv["owner_id"]:
        raise HTTPException(403, "Seul le propriétaire peut retirer un administrateur.")
    if body.action == "add":
        if len(conv["members"]) >= 200:
            raise HTTPException(400, "Limite de 200 membres pour cette version.")
        if not await db.users.find_one({"id": peer, "status": {"$nin": ["banned", "blocked"]}}):
            raise HTTPException(404, "Membre introuvable.")
        await allowed_pair(db, user["id"], peer)
        op = {"$addToSet": {"members": peer}}
    elif body.action == "remove":
        op = {"$pull": {"members": peer, "admins": peer}}
    else:
        if peer not in conv["members"]:
            raise HTTPException(400, "Cette personne n'est pas membre.")
        op = {("$addToSet" if body.action == "promote" else "$pull"): {"admins": peer}}
    await db.spv_conversations.update_one({"id": cid}, op)
    await notify(db, conv)
    if body.action == "add":
        await event(db, [peer], {"type": "updated", "conversation_id": cid})
    return {"ok": True}


@api.post("/conversations/{cid}/leave")
async def leave(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    if conv["kind"] not in ("group", "channel"):
        raise HTTPException(400, "Archivez plutôt cette discussion.")
    if conv["owner_id"] == user["id"]:
        raise HTTPException(400, "Le propriétaire doit supprimer le groupe plutôt que le quitter.")
    await db.spv_conversations.update_one({"id": cid}, {"$pull": {"members": user["id"], "admins": user["id"]}})
    await notify(db, conv)
    return {"ok": True}


@api.delete("/conversations/{cid}")
async def remove_conversation(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    if conv["kind"] in ("private", "saved"):
        await db.spv_preferences.update_one({"user_id": user["id"], "conversation_id": cid},
                                           {"$set": {"archived": True}}, upsert=True)
    else:
        if conv["owner_id"] != user["id"]:
            raise HTTPException(403, "Seul le propriétaire peut supprimer cette discussion.")
        await db.spv_conversations.delete_one({"id": cid})
        await db.spv_messages.delete_many({"conversation_id": cid})
        await db.spv_preferences.delete_many({"conversation_id": cid})
    await notify(db, conv)
    return {"ok": True}


@api.get("/conversations/{cid}/messages")
async def messages(cid: str, request: Request, before: str = "", q: str = Query(default="", max_length=200),
                   limit: int = Query(default=50, ge=1, le=100), user=Depends(chat_user)):
    import re
    db = request.app.state.db
    conv = await member(db, cid, user)
    query = {"conversation_id": cid}
    if before:
        anchor = await get_message(db, conv, before)
        query["$or"] = [
            {"created_at": {"$lt": anchor["created_at"]}},
            {"created_at": anchor["created_at"], "id": {"$lt": anchor["id"]}},
        ]
    if q.strip():
        query.update({"text": {"$regex": re.escape(q.strip()), "$options": "i"}, "deleted": False})
    rows = await db.spv_messages.find(query).sort([("created_at", -1), ("id", -1)]).limit(limit + 1).to_list(limit + 1)
    return {"items": [clean(x) for x in reversed(rows[:limit])], "has_more": len(rows) > limit}


@api.post("/conversations/{cid}/messages")
async def send(cid: str, body: MessageIn, request: Request, user=Depends(chat_user)):
    return await deliver_message(request.app.state.db, cid, body, user)


async def preview_auto_reply(db, conv, sender, incoming):
    """Only the local preview account can trigger replies from synthetic contacts."""
    if getattr(db, "name", "") != "spiloveure_local_development":
        return None
    if sender.get("username", "").casefold() != "preview_test_b02606":
        return None
    if conv.get("kind") != "private":
        return None
    for peer_id in conv.get("members", []):
        if peer_id == sender.get("id"):
            continue
        simulator = await db.users.find_one({
            "id": peer_id, "preview_auto_responder": True,
        })
        if not simulator:
            continue
        replies = simulator.get("preview_auto_replies") or [
            "Merci pour ton message ! Je suis bien là pour tester la discussion.",
            "J’ai bien reçu ta réponse. Tu peux aussi essayer les réactions et les pièces jointes.",
            "Oui, je te réponds automatiquement depuis ce profil de test.",
        ]
        reply_number = await db.spv_messages.count_documents({
            "conversation_id": conv["id"], "sender_id": peer_id,
            "client_id": {"$regex": "^preview-auto-"},
        })
        stamp = now()
        reply = {
            "conversation_id": conv["id"], "sender_id": peer_id,
            "client_id": f"preview-auto-{incoming['id']}",
            "id": identifier(), "sender_name": simulator.get("username", "Contact test"),
            "text": replies[reply_number % len(replies)], "attachments": [],
            "reply_to": incoming["id"], "forwarded_from": None, "silent": False,
            "created_at": stamp, "edited_at": None, "deleted": False,
            "reactions": {}, "pinned": False, "read_by": [peer_id],
        }
        await db.spv_messages.insert_one(reply)
        await db.spv_conversations.update_one(
            {"id": conv["id"]}, {"$set": {"updated_at": stamp}},
        )
        await notify(db, conv, "message", message_id=reply["id"], sender_id=peer_id)
        return reply
    return None


async def online_recipients(db, conv, sender_id):
    peer_ids = [member_id for member_id in conv.get("members", []) if member_id != sender_id]
    if not peer_ids:
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=70)
    return [
        row["user_id"] async for row in db.spv_presence.find({
            "user_id": {"$in": peer_ids},
            "online_count": {"$gt": 0},
            "last_seen": {"$gt": cutoff},
        }, {"user_id": 1})
    ]


async def deliver_message(db, cid, body, user):
    uid = user["id"]
    conv = await member(db, cid, user)
    if conv["kind"] == "channel":
        administrator(conv, user)
    if conv["kind"] == "group" and (conv.get("permissions") or {}).get("send_messages") == "admins":
        administrator(conv, user)
    if conv["kind"] == "private":
        for peer in conv["members"]:
            if peer != uid:
                await allowed_pair(db, uid, peer)
    key = {"conversation_id": cid, "sender_id": uid, "client_id": body.client_id}
    previous = await db.spv_messages.find_one(key)
    if previous:
        return clean(previous)
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Écrivez un message ou ajoutez un fichier.")
    status_reply = None
    if body.status_reply_id:
        if conv["kind"] != "private":
            raise HTTPException(400, "Une réponse de statut doit être envoyée en privé.")
        status = await db.spv_statuses.find_one({
            "id": body.status_reply_id,
            "expires_at": {"$gt": datetime.now(timezone.utc)},
        })
        author_id = status.get("author_id") if status else None
        if not status or author_id == uid or author_id not in conv["members"]:
            raise HTTPException(404, "Ce statut n’est plus disponible.")
        if not await db.spv_contacts.find_one({
            "user_id": uid, "peer_id": author_id, "status": "accepted",
        }):
            raise HTTPException(404, "Ce statut n’est plus disponible.")
        status_reply = {
            "status_id": status["id"],
            "author_id": author_id,
            "author_name": status.get("author_name", "Membre"),
            "text": status.get("text", ""),
            "attachments": status.get("attachments") or [],
            "created_at": status.get("created_at"),
        }
    await rate_limit(db, uid)
    attachments = await attachments_checked(db, body.attachments, user, cid)
    if body.reply_to:
        await get_message(db, conv, body.reply_to)
    forwarded = None
    if body.forwarded_from:
        source = await db.spv_messages.find_one({"id": body.forwarded_from, "deleted": False})
        if not source:
            raise HTTPException(404, "Message à transférer introuvable.")
        await member(db, source["conversation_id"], user)
        # Forwarded files need their own protected copies; don't bypass source permissions.
        if source["attachments"]:
            raise HTTPException(400, "Téléchargez puis joignez les fichiers pour les transférer.")
        forwarded = source["id"]
    stamp = now()
    delivered_by = await online_recipients(db, conv, uid)
    msg = {
        **key, "id": identifier(), "sender_name": user.get("username", "Membre"),
        "text": body.text.strip(), "attachments": attachments, "reply_to": body.reply_to,
        "status_reply": status_reply, "forwarded_from": forwarded,
        "silent": body.silent, "created_at": stamp,
        "edited_at": None, "deleted": False, "reactions": {}, "pinned": False, "read_by": [uid],
        "delivered_by": delivered_by,
    }
    try:
        await db.spv_messages.insert_one(msg)
    except DuplicateKeyError:
        return clean(await db.spv_messages.find_one(key))
    await db.spv_conversations.update_one({"id": cid}, {"$set": {"updated_at": stamp}})
    await db.spv_preferences.update_one(
        {"user_id": uid, "conversation_id": cid}, {"$set": {"draft": "", "archived": False}}, upsert=True,
    )
    await notify(db, conv, "message", message_id=msg["id"], sender_id=uid, silent=body.silent)
    if not body.silent:
        from messenger_delivery import enqueue_push
        await enqueue_push(db, conv, msg)
    await preview_auto_reply(db, conv, user, msg)
    return clean(msg)


@api.patch("/conversations/{cid}/messages/{mid}")
async def edit(cid: str, mid: str, body: TextIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    msg = await get_message(db, conv, mid)
    if msg["sender_id"] != user["id"] or msg["deleted"]:
        raise HTTPException(403, "Seul l'auteur peut modifier ce message.")
    if not body.text.strip():
        raise HTTPException(400, "Le message ne peut pas être vide.")
    await db.spv_messages.update_one({"id": mid}, {"$set": {"text": body.text.strip(), "edited_at": now()}})
    await notify(db, conv)
    return clean(await db.spv_messages.find_one({"id": mid}))


@api.delete("/conversations/{cid}/messages/{mid}")
async def delete_message(cid: str, mid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    msg = await get_message(db, conv, mid)
    if msg["sender_id"] != user["id"] and not (conv["kind"] in ("group", "channel") and user["id"] in conv["admins"]):
        raise HTTPException(403, "Vous ne pouvez pas supprimer ce message.")
    await db.spv_messages.update_one({"id": mid}, {"$set": {
        "text": "", "attachments": [], "deleted": True, "reactions": {}, "pinned": False,
    }})
    await notify(db, conv)
    return {"ok": True}


@api.post("/conversations/{cid}/messages/{mid}/reaction")
async def reaction(cid: str, mid: str, body: ReactionIn, request: Request, user=Depends(chat_user)):
    from messenger_social import toggle_reaction
    db = request.app.state.db
    conv = await member(db, cid, user)
    msg = await get_message(db, conv, mid)
    if msg["deleted"]:
        raise HTTPException(400, "Ce message a été supprimé.")
    result = await toggle_reaction(db.spv_messages, mid, body.emoji, user["id"])
    await notify(db, conv)
    return result


@api.post("/conversations/{cid}/messages/{mid}/pin")
async def pin(cid: str, mid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    if conv["kind"] in ("group", "channel"):
        administrator(conv, user)
    msg = await get_message(db, conv, mid)
    if msg["deleted"]:
        raise HTTPException(400, "Ce message a été supprimé.")
    await db.spv_messages.update_one({"id": mid}, {"$set": {"pinned": not msg.get("pinned", False)}})
    await notify(db, conv)
    return clean(await db.spv_messages.find_one({"id": mid}))


@api.post("/conversations/{cid}/read")
async def mark_read(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    stamp = now()
    await db.spv_preferences.update_one({"user_id": user["id"], "conversation_id": cid},
                                       {"$set": {"read_at": stamp, "force_unread": False}}, upsert=True)
    changed = await db.spv_messages.update_many({"conversation_id": cid, "created_at": {"$lte": stamp}},
                                               {"$addToSet": {
                                                   "read_by": user["id"],
                                                   "delivered_by": user["id"],
                                               }})
    if changed.modified_count:
        await notify(db, conv, "read", user_id=user["id"], read_at=stamp)
    return {"ok": True}


@api.post("/conversations/{cid}/delivered")
async def mark_delivered(cid: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    conv = await member(db, cid, user)
    result = await db.spv_messages.update_many(
        {"conversation_id": cid, "sender_id": {"$ne": uid}, "deleted": {"$ne": True},
         "delivered_by": {"$ne": uid}},
        {"$addToSet": {"delivered_by": uid}},
    )
    if result.modified_count:
        await notify(db, conv, "delivered", user_id=uid)
    return {"ok": True}


@api.post("/conversations/{cid}/typing")
async def typing(cid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, cid, user)
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=3)).isoformat()
    previous = await db.spv_presence.find_one({"user_id": user["id"]}) or {}
    if previous.get("typing_at", "") < cutoff:
        await db.spv_presence.update_one({"user_id": user["id"]}, {"$set": {"typing_at": now()}}, upsert=True)
        await notify(db, conv, "typing", user_id=user["id"], username=user.get("username", "Membre"))
    return {"ok": True}


@api.post("/socket-ticket")
async def socket_ticket(request: Request, user=Depends(chat_user)):
    return {"ticket": await ticket(request.app.state.db, user["id"], request.state.chat_session_id)}


@api.websocket("/ws")
async def socket(websocket: WebSocket, ticket: str = ""):
    db = websocket.app.state.db
    origin = websocket.headers.get("origin")
    from urllib.parse import urlsplit
    if origin and urlsplit(origin).netloc.lower() != websocket.headers.get("host", "").lower():
        await websocket.close(code=4403)
        return
    row = await db.spv_tickets.find_one_and_delete({
        "digest": hashlib.sha256(ticket.encode()).hexdigest(),
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    })
    if not row:
        await websocket.close(code=4401)
        return
    from identity_core import session_row
    if not await session_row(db, row.get("session_id")):
        await websocket.close(code=4401)
        return
    uid = row["user_id"]
    session_id = row["session_id"]
    await websocket.accept()
    cursor = ObjectId.from_datetime(datetime.now(timezone.utc))
    await db.spv_presence.update_one({"user_id": uid}, {
        "$inc": {"online_count": 1}, "$set": {"last_seen": now()},
    }, upsert=True)
    peers = {uid}
    async for conv in db.spv_conversations.find({"members": uid}).limit(300):
        peers.update(conv["members"])
    await event(db, peers, {"type": "presence"})
    try:
        while True:
            # Recheck current account access: an open socket is not permanent authorization.
            user = await db.users.find_one({"id": uid})
            if not await session_row(db, session_id):
                await websocket.close(code=4403)
                return
            await db.spv_presence.update_one({"user_id": uid}, {"$set": {"last_seen": now()}}, upsert=True)
            rows = await db.spv_events.find({"recipients": uid, "_id": {"$gt": cursor}}).sort("_id", 1).limit(100).to_list(100)
            for row in rows:
                cursor = row["_id"]
                payload = row["payload"]
                cid = payload.get("conversation_id")
                if cid and not await db.spv_conversations.find_one({"id": cid, "members": uid}):
                    # Membership revocation never leaks future messages or typing events.
                    await websocket.send_json({"type": "updated"})
                    continue
                await websocket.send_json(payload)
            try:
                packet = await asyncio.wait_for(websocket.receive_json(), timeout=1)
                if packet.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
            except asyncio.TimeoutError:
                continue
    except (WebSocketDisconnect, RuntimeError, ValueError):
        return
    finally:
        await db.spv_presence.update_one({"user_id": uid, "online_count": {"$gt": 0}}, {
            "$inc": {"online_count": -1}, "$set": {"last_seen": now()},
        })
        await event(db, peers, {"type": "presence"})


from messenger_social import api as social_api  # noqa: E402
from messenger_files import api as files_api  # noqa: E402
from messenger_delivery import api as delivery_api  # noqa: E402
api.include_router(social_api)
api.include_router(files_api)
api.include_router(delivery_api)
