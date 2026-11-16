"""Per-user saved chat stickers and safe reuse in conversations."""
from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

from messenger_core import administrator, chat_user, identifier, member, now
from messenger_files import MAX_DAILY, MAX_BYTES, upload_root

api = APIRouter()
MAX_SAVED_STICKERS = 200


def attachment(file: dict) -> dict:
    return {key: file[key] for key in ("id", "name", "mime", "size", "url")}


class CopyStickerIn(BaseModel):
    conversation_id: str


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


@api.post("/conversations/{cid}/messages/{mid}/stickers/{fid}/save")
async def save_sticker(cid: str, mid: str, fid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await member(db, cid, user)
    message = await db.spv_messages.find_one({
        "id": mid, "conversation_id": cid, "deleted": False, "attachments.id": fid,
    })
    file = await db.spv_files.find_one({"id": fid, "scope": cid})
    if not message or not file or not file.get("name", "").lower().startswith("sticker-"):
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


@api.post("/stickers/{fid}/copy")
async def copy_sticker(fid: str, body: CopyStickerIn, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    conv = await member(db, body.conversation_id, user)
    if conv["kind"] == "channel" or (
        conv["kind"] == "group" and (conv.get("permissions") or {}).get("send_messages") == "admins"
    ):
        administrator(conv, user)
    if not await db.spv_stickers.find_one({"user_id": user["id"], "file_id": fid}):
        raise HTTPException(404, "Sticker enregistré introuvable.")
    source = await db.spv_files.find_one({"id": fid})
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

    source_path = upload_root() / source["id"]
    if not source_path.is_file():
        raise HTTPException(404, "Le fichier de ce sticker n’est plus disponible.")
    new_id = identifier()
    target_path = upload_root() / new_id
    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, target_path)
        name = Path(source.get("name") or "sticker.png").name[:180]
        if not name.lower().startswith("sticker-"):
            name = "sticker-" + name
        copied = {
            "id": new_id, "owner_id": user["id"], "scope": body.conversation_id,
            "name": name, "size": size, "mime": source["mime"],
            "url": "/api/messenger/files/" + new_id, "created_at": now(),
        }
        await db.spv_files.insert_one(copied)
    except Exception:
        target_path.unlink(missing_ok=True)
        raise
    return attachment(copied)
