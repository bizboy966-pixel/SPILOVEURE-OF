"""Contacts, privacy preferences and the community feed."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from messenger_core import (
    Attachment, ReactionIn, TextIn, allowed_pair, attachments_checked,
    chat_user, clean, event, identifier, now, person, rate_limit,
)

api = APIRouter()
REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "👎", "🎉", "👏"]


async def toggle_reaction(collection, mid, emoji, uid):
    if emoji not in REACTIONS:
        raise HTTPException(400, "Réaction non prise en charge.")
    key = "reactions." + emoji
    # Atomic pull/add prevents lost updates from other participants.
    result = await collection.update_one({"id": mid, key: uid}, {"$pull": {key: uid}})
    if not result.modified_count:
        await collection.update_one({"id": mid}, {"$addToSet": {key: uid}})
    return clean(await collection.find_one({"id": mid}))


async def profile_list(db, ids):
    result = []
    async for row in db.users.find({"id": {"$in": ids}}, {"id": 1, "username": 1, "avatar_url": 1}):
        result.append(await person(db, row))
    return result


@api.get("/contacts")
async def contacts(request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    own = await db.spv_contacts.find({"user_id": uid}).to_list(500)
    incoming = await db.spv_contacts.find({"peer_id": uid, "status": "pending"}).to_list(500)
    blocks = await db.spv_blocks.find({"user_id": uid}).to_list(500)
    return {
        "contacts": await profile_list(db, [r["peer_id"] for r in own if r["status"] == "accepted"]),
        "requests": await profile_list(db, [r["user_id"] for r in incoming]),
        "sent": [r["peer_id"] for r in own if r["status"] == "pending"],
        "blocked": await profile_list(db, [r["peer_id"] for r in blocks]),
    }


@api.post("/contacts/{peer}")
async def add_contact(peer: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    if peer == uid or not await db.users.find_one({"id": peer}):
        raise HTTPException(400, "Destinataire invalide.")
    await allowed_pair(db, uid, peer)
    setting = await db.spv_settings.find_one({"user_id": peer}) or {}
    if not setting.get("allow_contacts", True):
        raise HTTPException(403, "Cette personne n'accepte pas les demandes de contact.")
    await db.spv_contacts.update_one({"user_id": uid, "peer_id": peer}, {
        "$setOnInsert": {"status": "pending", "created_at": now()},
    }, upsert=True)
    await event(db, [peer], {"type": "updated"})
    return {"ok": True}


@api.post("/contacts/{peer}/accept")
async def accept_contact(peer: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    await allowed_pair(db, uid, peer)
    request_row = await db.spv_contacts.find_one({"user_id": peer, "peer_id": uid, "status": "pending"})
    if not request_row:
        raise HTTPException(404, "Demande introuvable.")
    for first, second in [(uid, peer), (peer, uid)]:
        await db.spv_contacts.update_one({"user_id": first, "peer_id": second}, {
            "$set": {"status": "accepted", "created_at": now()},
        }, upsert=True)
    await event(db, [peer, uid], {"type": "updated"})
    return {"ok": True}


@api.delete("/contacts/{peer}")
async def delete_contact(peer: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    await db.spv_contacts.delete_many({"$or": [
        {"user_id": uid, "peer_id": peer}, {"user_id": peer, "peer_id": uid},
    ]})
    await event(db, [uid, peer], {"type": "updated"})
    return {"ok": True}


@api.post("/blocks/{peer}")
async def block(peer: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    if peer == uid or not await db.users.find_one({"id": peer}):
        raise HTTPException(400, "Destinataire invalide.")
    await db.spv_blocks.update_one({"user_id": uid, "peer_id": peer}, {"$set": {"created_at": now()}}, upsert=True)
    await delete_contact(peer, request, user)
    return {"ok": True}


@api.delete("/blocks/{peer}")
async def unblock(peer: str, request: Request, user=Depends(chat_user)):
    await request.app.state.db.spv_blocks.delete_one({"user_id": user["id"], "peer_id": peer})
    return {"ok": True}


class ReportIn(BaseModel):
    user_id: str
    reason: str = Field(min_length=5, max_length=2000)


@api.post("/reports")
async def report(body: ReportIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    if body.user_id == user["id"] or not await db.users.find_one({"id": body.user_id}):
        raise HTTPException(400, "Compte à signaler invalide.")
    await rate_limit(db, user["id"], "spv_reports", 3)
    await db.spv_reports.insert_one({
        "id": identifier(), "sender_id": user["id"], "user_id": body.user_id,
        "reason": body.reason, "created_at": now(), "status": "open",
    })
    return {"ok": True}


class SettingsIn(BaseModel):
    show_presence: bool | None = None
    allow_contacts: bool | None = None


@api.get("/settings")
async def settings(request: Request, user=Depends(chat_user)):
    row = await request.app.state.db.spv_settings.find_one({"user_id": user["id"]}) or {}
    return {key: row.get(key, True) for key in ["show_presence", "allow_contacts"]}


@api.patch("/settings")
async def set_settings(body: SettingsIn, request: Request, user=Depends(chat_user)):
    changes = body.model_dump(exclude_none=True)
    if changes:
        await request.app.state.db.spv_settings.update_one({"user_id": user["id"]}, {"$set": changes}, upsert=True)
    return await settings(request, user)


class PostIn(BaseModel):
    text: str = Field(default="", max_length=8000)
    visibility: str = Field(default="contacts", pattern="^(contacts|public)$")
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)


async def visible_post(db, post_id, user):
    post = await db.spv_posts.find_one({"id": post_id})
    if not post:
        raise HTTPException(404, "Publication introuvable.")
    await allowed_pair(db, user["id"], post["author_id"])
    if post["visibility"] != "public" and post["author_id"] != user["id"]:
        if not await db.spv_contacts.find_one({
            "user_id": user["id"], "peer_id": post["author_id"], "status": "accepted",
        }):
            raise HTTPException(404, "Publication introuvable.")
    return post


@api.get("/feed")
async def feed(request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    related = await db.spv_contacts.find({"user_id": uid, "status": "accepted"}).to_list(500)
    blocked = await db.spv_blocks.find({"$or": [{"user_id": uid}, {"peer_id": uid}]}).to_list(1000)
    excluded = [r["peer_id"] if r["user_id"] == uid else r["user_id"] for r in blocked]
    rows = await db.spv_posts.find({
        "$or": [{"author_id": {"$in": [uid, *[r["peer_id"] for r in related]]}}, {"visibility": "public"}],
        "author_id": {"$nin": excluded},
    }).sort("created_at", -1).limit(100).to_list(100)
    return [clean(row) for row in rows]


@api.post("/feed")
async def publish(body: PostIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Votre publication est vide.")
    await rate_limit(db, user["id"], "spv_posts", 5)
    attachments = await attachments_checked(db, body.attachments, user, "feed")
    row = {
        "id": identifier(), "author_id": user["id"], "sender_id": user["id"],
        "author_name": user.get("username", "Membre"), "text": body.text.strip(),
        "visibility": body.visibility, "attachments": attachments, "created_at": now(),
        "reactions": {}, "comments": [],
    }
    await db.spv_posts.insert_one(row)
    # Notifications target contacts only, even for a public post.
    peers = await db.spv_contacts.find({"user_id": user["id"], "status": "accepted"}).to_list(500)
    await event(db, [user["id"], *[p["peer_id"] for p in peers]], {"type": "feed"})
    return clean(row)


@api.post("/feed/{post_id}/reaction")
async def react_post(post_id: str, body: ReactionIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    post = await visible_post(db, post_id, user)
    result = await toggle_reaction(db.spv_posts, post_id, body.emoji, user["id"])
    await event(db, [post["author_id"]], {"type": "feed"})
    return result


@api.post("/feed/{post_id}/comments")
async def comment(post_id: str, body: TextIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    post = await visible_post(db, post_id, user)
    if not body.text.strip():
        raise HTTPException(400, "Votre commentaire est vide.")
    if len(post["comments"]) >= 500:
        raise HTTPException(400, "Limite de commentaires atteinte.")
    await rate_limit(db, user["id"], "spv_comment_limits", 20)
    await db.spv_comment_limits.insert_one({
        "sender_id": user["id"], "created_at": now(),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=2),
    })
    await db.spv_posts.update_one({"id": post_id, "comments.499": {"$exists": False}}, {"$push": {"comments": {
        "id": identifier(), "user_id": user["id"], "username": user.get("username", "Membre"),
        "text": body.text.strip(), "created_at": now(),
    }}})
    await event(db, [post["author_id"]], {"type": "feed"})
    return clean(await db.spv_posts.find_one({"id": post_id}))


@api.delete("/feed/{post_id}")
async def delete_post(post_id: str, request: Request, user=Depends(chat_user)):
    result = await request.app.state.db.spv_posts.delete_one({"id": post_id, "author_id": user["id"]})
    if not result.deleted_count:
        raise HTTPException(404, "Publication introuvable.")
    return {"ok": True}


from datetime import datetime, timedelta, timezone  # noqa: E402
