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


async def notify_active_chat_users(db):
    active_users = await db.identity_chat_sessions.distinct("user_id", {
        "revoked": {"$ne": True}, "expires_at": {"$gt": datetime.now(timezone.utc)},
    })
    if active_users:
        await event(db, active_users, {"type": "feed"})


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
    async for row in db.users.find({"id": {"$in": ids}}, {"id": 1, "username": 1, "avatar_url": 1, "profile_photo": 1}):
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

class FeedReadIn(BaseModel):
    post_id: str = Field(min_length=1, max_length=100)

class StatusIn(BaseModel):
    text: str = Field(default="", max_length=800)
    attachments: list[Attachment] = Field(default_factory=list, max_length=1)


class ChatProfilePhotoIn(BaseModel):
    data: str = Field(min_length=20, max_length=500_000)


async def visible_post(db, post_id, user):
    post = await db.spv_posts.find_one({"id": post_id})
    if not post:
        raise HTTPException(404, "Publication introuvable.")
    if not post.get("is_official"):
        await allowed_pair(db, user["id"], post["author_id"])
    if post["visibility"] != "public" and post["author_id"] != user["id"]:
        if not await db.spv_contacts.find_one({
            "user_id": user["id"], "peer_id": post["author_id"], "status": "accepted",
        }):
            raise HTTPException(404, "Publication introuvable.")
    return post


@api.get("/feed")
async def feed(request: Request, user=Depends(chat_user)):
    rows = await request.app.state.db.spv_posts.find({"is_official": True}).sort("created_at", -1).limit(100).to_list(100)
    return [clean(row) for row in rows]


async def feed_unread_count(db, uid):
    read = await db.spv_feed_reads.find_one({"user_id": uid})
    query = {"is_official": True}
    if read and read.get("created_at") is not None:
        query["created_at"] = {"$gt": read["created_at"]}
    return await db.spv_posts.count_documents(query)


@api.get("/feed/unread-count")
async def unread_feed_count(request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    return {
        "count": await feed_unread_count(db, uid),
        "can_publish": user.get("role") == "admin",
    }


@api.post("/feed/read")
async def mark_feed_read(body: FeedReadIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    post = await db.spv_posts.find_one({"id": body.post_id, "is_official": True})
    if not post:
        raise HTTPException(404, "Actualité introuvable.")
    await db.spv_feed_reads.update_one(
        {"user_id": user["id"]}, {"$max": {"created_at": post["created_at"]}}, upsert=True,
    )
    return {"count": await feed_unread_count(db, user["id"])}


@api.post("/feed")
async def publish(body: PostIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    if user.get("role") != "admin":
        raise HTTPException(403, "Seuls les administrateurs peuvent publier une actualité SPILOVEURE.")
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Votre publication est vide.")
    await rate_limit(db, user["id"], "spv_posts", 5)
    attachments = await attachments_checked(db, body.attachments, user, "feed")
    row = {
        "id": identifier(), "author_id": user["id"], "sender_id": user["id"],
        "author_name": "SPILOVEURE", "text": body.text.strip(),
        "visibility": "public", "is_official": True,
        "attachments": attachments, "created_at": now(),
        "reactions": {}, "comments": [],
    }
    await db.spv_posts.insert_one(row)
    await notify_active_chat_users(db)
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
    db = request.app.state.db
    post = await db.spv_posts.find_one({"id": post_id, "author_id": user["id"]})
    if not post:
        raise HTTPException(404, "Publication introuvable.")
    await db.spv_posts.delete_one({"id": post_id, "author_id": user["id"]})
    if post.get("is_official"):
        await notify_active_chat_users(db)
    return {"ok": True}


@api.get("/statuses")
async def statuses(request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    contacts = await db.spv_contacts.find({"user_id": uid, "status": "accepted"}).to_list(500)
    blocked = await db.spv_blocks.find({"$or": [{"user_id": uid}, {"peer_id": uid}]}).to_list(1000)
    excluded = {row["peer_id"] if row["user_id"] == uid else row["user_id"] for row in blocked}
    authors = {uid, *(row["peer_id"] for row in contacts)} - excluded
    expires_after = datetime.now(timezone.utc)
    rows = await db.spv_statuses.find({
        "author_id": {"$in": list(authors)}, "expires_at": {"$gt": expires_after},
    }).sort("created_at", -1).limit(500).to_list(500)
    rows = [
        row for row in rows
        if all((attachment.get("mime") or "").startswith("image/") for attachment in row.get("attachments", []))
    ]
    profile_rows = await profile_list(db, list({row["author_id"] for row in rows}))
    profiles = {profile["id"]: profile for profile in profile_rows}
    result = []
    own_statuses = [row for row in rows if row["author_id"] == uid]
    viewer_ids = {
        viewer_id
        for row in own_statuses
        for viewer_id in (row.get("viewed_by") or [])
        if viewer_id != uid
    }
    viewer_profiles = await profile_list(db, list(viewer_ids))
    viewers_by_id = {profile["id"]: profile for profile in viewer_profiles}
    for row in rows:
        item = clean(row)
        profile = profiles.get(row["author_id"], {})
        viewers = row.get("viewed_by") or []
        likes = row.get("liked_by") or []
        item.update({
            "author_name": profile.get("username") or row.get("author_name", "Membre"),
            "author_avatar": profile.get("avatar", ""),
            "viewed_by_me": uid in viewers,
            "views_count": len(viewers),
            "likes_count": len(likes),
            "liked_by_me": uid in likes,
        })
        if row["author_id"] == uid:
            item["viewers"] = [
                viewers_by_id[viewer_id]
                for viewer_id in viewers
                if viewer_id != uid and viewer_id in viewers_by_id
            ]
        else:
            item.pop("viewed_by", None)
            item.pop("viewers", None)
        item.pop("liked_by", None)
        result.append(item)
    return result


async def visible_status(db, status_id, user):
    row = await db.spv_statuses.find_one({
        "id": status_id, "expires_at": {"$gt": datetime.now(timezone.utc)},
    })
    if not row:
        raise HTTPException(404, "Statut introuvable ou expiré.")
    if row["author_id"] != user["id"]:
        await allowed_pair(db, user["id"], row["author_id"])
        if not await db.spv_contacts.find_one({
            "user_id": user["id"], "peer_id": row["author_id"], "status": "accepted",
        }):
            raise HTTPException(404, "Statut introuvable ou expiré.")
    return row


@api.post("/statuses")
async def publish_status(body: StatusIn, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "Ajoutez un texte ou une photo.")
    if any(not item.mime.startswith("image/") for item in body.attachments):
        raise HTTPException(400, "Les statuts acceptent uniquement des photos, pas de vidéos.")
    await rate_limit(db, uid, "spv_statuses", 10)
    attachments = await attachments_checked(db, body.attachments, user, "feed")
    stamp = now()
    row = {
        "id": identifier(), "author_id": uid, "sender_id": uid,
        "author_name": user.get("username", "Membre"), "text": body.text.strip(),
        "attachments": attachments, "created_at": stamp,
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=24),
        "viewed_by": [], "liked_by": [],
    }
    await db.spv_statuses.insert_one(row)
    peers = await db.spv_contacts.find({"user_id": uid, "status": "accepted"}).to_list(500)
    await event(db, [uid, *[item["peer_id"] for item in peers]], {"type": "status"})
    result = clean(row)
    result.update({
        "author_avatar": user.get("profile_photo", ""), "viewed_by_me": False,
        "views_count": 0, "likes_count": 0, "liked_by_me": False, "viewers": [],
    })
    return result


@api.post("/statuses/{status_id}/like")
async def toggle_status_like(status_id: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    row = await visible_status(db, status_id, user)
    if row["author_id"] == uid:
        raise HTTPException(400, "Vous ne pouvez pas aimer votre propre statut.")
    await rate_limit(db, uid, "spv_status_likes", 60)
    result = await db.spv_statuses.update_one(
        {"id": status_id, "liked_by": uid}, {"$pull": {"liked_by": uid}},
    )
    liked = not bool(result.modified_count)
    if liked:
        await db.spv_statuses.update_one({"id": status_id}, {"$addToSet": {"liked_by": uid}})
    updated = await db.spv_statuses.find_one({"id": status_id})
    await event(db, [row["author_id"]], {"type": "status"})
    return {"liked_by_me": liked, "likes_count": len(updated.get("liked_by") or [])}


@api.post("/statuses/{status_id}/view")
async def view_status(status_id: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    row = await visible_status(db, status_id, user)
    if row["author_id"] != uid:
        await db.spv_statuses.update_one({"id": status_id}, {"$addToSet": {"viewed_by": uid}})
        row = await db.spv_statuses.find_one({"id": status_id})
        await event(db, [row["author_id"]], {"type": "status"})
    return {"ok": True, "views_count": len(row.get("viewed_by") or [])}


@api.delete("/statuses/{status_id}")
async def delete_status(status_id: str, request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    result = await db.spv_statuses.delete_one({"id": status_id, "author_id": uid})
    if not result.deleted_count:
        raise HTTPException(404, "Statut introuvable.")
    peers = await db.spv_contacts.find({"user_id": uid, "status": "accepted"}).to_list(500)
    await event(db, [uid, *[item["peer_id"] for item in peers]], {"type": "status"})
    return {"ok": True}


@api.post("/profile-photo")
async def upload_chat_profile_photo(body: ChatProfilePhotoIn, request: Request, user=Depends(chat_user)):
    raw = body.data.strip()
    if not raw.startswith("data:image/"):
        raise HTTPException(400, "Format d'image invalide.")
    try:
        header, encoded = raw.split(",", 1)
        mime = header.split(";")[0].removeprefix("data:")
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            raise ValueError("unsupported image")
        import base64
        decoded = base64.b64decode(encoded, validate=True)
    except Exception:
        raise HTTPException(400, "Image invalide. Utilisez JPEG, PNG ou WEBP.") from None
    if len(decoded) > 300 * 1024:
        raise HTTPException(400, "Photo trop lourde. La limite est de 300 Ko.")
    db, uid = request.app.state.db, user["id"]
    await db.users.update_one({"id": uid}, {"$set": {
        "profile_photo": raw, "profile_photo_updated_at": now(),
    }})
    peers = await db.spv_contacts.find({"user_id": uid, "status": "accepted"}).to_list(500)
    await event(db, [uid, *[item["peer_id"] for item in peers]], {"type": "profile"})
    return {"ok": True, "profile_photo": raw}


@api.delete("/profile-photo")
async def delete_chat_profile_photo(request: Request, user=Depends(chat_user)):
    db, uid = request.app.state.db, user["id"]
    await db.users.update_one({"id": uid}, {"$unset": {"profile_photo": "", "profile_photo_updated_at": ""}})
    peers = await db.spv_contacts.find({"user_id": uid, "status": "accepted"}).to_list(500)
    await event(db, [uid, *[item["peer_id"] for item in peers]], {"type": "profile"})
    return {"ok": True}


from datetime import datetime, timedelta, timezone  # noqa: E402
