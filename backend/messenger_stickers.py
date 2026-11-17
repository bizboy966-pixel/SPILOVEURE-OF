"""Per-user saved chat stickers and safe reuse in conversations."""
from __future__ import annotations

import asyncio
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

from messenger_core import administrator, chat_user, identifier, member, now
from messenger_files import MAX_DAILY, MAX_BYTES, upload_root
import messenger_r2 as r2
from messenger_sticker_pack import PACK_NAMES, PACK_ROOT, pack_file

api = APIRouter()
MAX_SAVED_STICKERS = 200
MAX_STICKER_PACK_ITEMS = 200


def attachment(file: dict) -> dict:
    return {**{key: file[key] for key in ("id", "name", "mime", "size", "url")}, "sticker": True}


class CopyStickerIn(BaseModel):
    conversation_id: str


@api.get("/sticker-pack")
async def builtin_stickers(user=Depends(chat_user)):
    return [pack_file("pack-" + key) for key in PACK_NAMES]


@api.get("/stickers")
async def saved_stickers(request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    saved = await db.spv_stickers.find({"user_id": user["id"]}).sort("saved_at", -1).to_list(MAX_SAVED_STICKERS)
    result = []
    for entry in saved:
        file = await db.spv_files.find_one({"id": entry["file_id"]})
        if file and file.get("mime", "").startswith("image/") and not file.get("view_once"):
            result.append(attachment(file))
    return result


@api.get("/sticker-pack/mine")
async def my_sticker_pack(request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    entries = await db.spv_sticker_pack_items.find({"user_id": user["id"]}).sort("added_at", -1).to_list(MAX_STICKER_PACK_ITEMS)
    result = []
    for entry in entries:
        file = await db.spv_files.find_one({"id": entry["file_id"]})
        if file and file.get("mime", "").startswith("image/") and not file.get("view_once"):
            result.append(attachment(file))
    return result


@api.post("/conversations/{cid}/messages/{mid}/stickers/{fid}/pack")
async def add_to_sticker_pack(cid: str, mid: str, fid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await member(db, cid, user)
    message = await db.spv_messages.find_one({
        "id": mid, "conversation_id": cid, "deleted": False, "attachments.id": fid,
    })
    file = await db.spv_files.find_one({"id": fid, "scope": cid})
    if not message or not file or not (file.get("sticker") or file.get("name", "").lower().startswith("sticker-")):
        raise HTTPException(404, "Ce sticker n’est plus disponible.")
    if not file.get("mime", "").startswith("image/") or file.get("view_once"):
        raise HTTPException(400, "Seuls les stickers peuvent être ajoutés à un pack.")
    expires_at = file.get("expires_at")
    if expires_at and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(404, "Ce sticker a expiré.")
    existing = await db.spv_sticker_pack_items.find_one({"user_id": user["id"], "file_id": fid})
    if existing:
        return attachment(file)
    if await db.spv_sticker_pack_items.count_documents({"user_id": user["id"]}) >= MAX_STICKER_PACK_ITEMS:
        raise HTTPException(429, "Votre pack contient déjà 200 stickers.")
    try:
        await db.spv_sticker_pack_items.insert_one({
            "user_id": user["id"], "file_id": fid, "added_at": now(),
            "source_conversation_id": cid, "source_message_id": mid,
        })
    except DuplicateKeyError:
        pass
    return attachment(file)


@api.delete("/stickers/{fid}/pack")
async def remove_from_sticker_pack(fid: str, request: Request, user=Depends(chat_user)):
    await request.app.state.db.spv_sticker_pack_items.delete_one({"user_id": user["id"], "file_id": fid})
    return {"ok": True}


@api.post("/conversations/{cid}/messages/{mid}/stickers/{fid}/save")
async def save_sticker(cid: str, mid: str, fid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await member(db, cid, user)
    message = await db.spv_messages.find_one({
        "id": mid, "conversation_id": cid, "deleted": False, "attachments.id": fid,
    })
    file = await db.spv_files.find_one({"id": fid, "scope": cid})
    if not message or not file or not (file.get("sticker") or file.get("name", "").lower().startswith("sticker-")):
        raise HTTPException(404, "Ce sticker n’est plus disponible.")
    if not file.get("mime", "").startswith("image/") or file.get("view_once"):
        raise HTTPException(400, "Seuls les stickers image peuvent être enregistrés.")
    expires_at = file.get("expires_at")
    if expires_at and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(404, "Ce sticker a expiré.")
    existing = await db.spv_stickers.find_one({"user_id": user["id"], "file_id": fid})
    if existing:
        return attachment(file)
    if await db.spv_stickers.count_documents({"user_id": user["id"]}) >= MAX_SAVED_STICKERS:
        raise HTTPException(429, "La collection contient déjà 200 stickers.")
    try:
        await db.spv_stickers.insert_one({
            "user_id": user["id"], "file_id": fid, "saved_at": now(),
            "source_conversation_id": cid, "source_message_id": mid,
        })
    except DuplicateKeyError:
        pass
    return attachment(file)


@api.delete("/stickers/{fid}")
async def remove_sticker(fid: str, request: Request, user=Depends(chat_user)):
    # Removing a favorite never deletes messages or another user's collection.
    await request.app.state.db.spv_stickers.delete_one({"user_id": user["id"], "file_id": fid})
    return {"ok": True}


@api.post("/stickers/{fid}/copy")
async def copy_sticker(fid: str, body: CopyStickerIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, body.conversation_id, user)
    if conv["kind"] == "channel" or (
        conv["kind"] == "group" and (conv.get("permissions") or {}).get("send_messages") == "admins"
    ):
        administrator(conv, user)
    builtin = pack_file(fid)
    favorite = await db.spv_stickers.find_one({"user_id": user["id"], "file_id": fid})
    packed = await db.spv_sticker_pack_items.find_one({"user_id": user["id"], "file_id": fid})
    if not builtin and not favorite and not packed:
        raise HTTPException(404, "Sticker enregistré introuvable.")
    source = builtin or await db.spv_files.find_one({"id": fid})
    if not source or not source.get("mime", "").startswith("image/") or source.get("view_once"):
        raise HTTPException(404, "Sticker enregistré introuvable.")
    size = int(source.get("size") or 0)
    if size <= 0 or size > MAX_BYTES:
        raise HTTPException(413, "La taille de ce sticker n’est pas autorisée.")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    previous = await db.spv_files.find({
        "owner_id": user["id"], "created_at": {"$gte": cutoff},
    }).to_list(1000)
    used = sum(int(row.get("size") or 0) for row in previous)
    if len(previous) >= 100 or used + size > MAX_DAILY:
        raise HTTPException(429, "Le quota quotidien de fichiers est atteint.")

    new_id = identifier()
    source_path = (PACK_ROOT / (fid.removeprefix("pack-") + ".png")) if builtin else upload_root() / source["id"]
    try:
        if builtin or source.get("storage_backend") != "r2":
            if not source_path.is_file():
                raise HTTPException(404, "Le fichier de ce sticker n’est plus disponible.")
            with source_path.open("rb") as source_file:
                await asyncio.to_thread(r2.put_upload, new_id, source_file, source["mime"], size)
        else:
            def copy_r2_object():
                obj = r2.get_upload(source["id"])
                body = obj["Body"]
                try:
                    with tempfile.TemporaryFile(mode="w+b") as output:
                        copied_size = 0
                        while chunk := body.read(64 * 1024):
                            copied_size += len(chunk)
                            if copied_size > size:
                                raise ValueError("Sticker source exceeded its saved size.")
                            output.write(chunk)
                        if copied_size != size:
                            raise ValueError("Sticker source did not match its saved size.")
                        output.seek(0)
                        r2.put_upload(new_id, output, source["mime"], size)
                finally:
                    body.close()
            await asyncio.to_thread(copy_r2_object)
        name = Path(source.get("name") or "sticker.png").name[:180]
        if not name.lower().startswith("sticker-"):
            name = "sticker-" + name
        copied = {
            "id": new_id, "owner_id": user["id"], "scope": body.conversation_id,
            "name": name, "size": size, "mime": source["mime"],
            "url": "/api/messenger/files/" + new_id, "created_at": now(),
            "storage_backend": "r2", "storage_key": r2.object_key(new_id), "status": "ready",
            "sticker": True,
        }
        await db.spv_files.insert_one(copied)
    except r2.R2NotConfigured:
        raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
    except Exception:
        try:
            await asyncio.to_thread(r2.delete_upload, new_id)
        except Exception:
            pass
        raise
    return attachment(copied)
