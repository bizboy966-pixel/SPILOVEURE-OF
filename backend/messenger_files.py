"""Protected local-volume attachments. No public static mount, no bearer in URLs."""
from __future__ import annotations

import asyncio
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from messenger_core import administrator, chat_user, clean, identifier, member, now

api = APIRouter()
MAX_BYTES = 20 * 1024 * 1024
MAX_DAILY = 100 * 1024 * 1024
ALLOWED = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".m4v": "video/mp4", ".3gp": "video/3gpp", ".3g2": "video/3gpp2",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
    ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip", ".gz": "application/gzip", ".vcf": "text/vcard",
}


def upload_root():
    return Path(os.environ.get("UPLOADS_DIR", str(Path(__file__).parent / "uploads"))) / "messenger"


async def cleanup_expired_message_files(db):
    current = datetime.now(timezone.utc)
    expired_files = await db.spv_files.find(
        {"expires_at": {"$lte": current}}, {"_id": 0, "id": 1},
    ).to_list(500)
    for row in expired_files:
        referenced = await db.spv_messages.find_one({
            "attachments.id": row["id"], "deleted": False,
            "$or": [
                {"expires_at": {"$exists": False}}, {"expires_at": None},
                {"expires_at": {"$gt": current}},
            ],
        }, {"_id": 1})
        if referenced:
            continue
        if await db.spv_stickers.find_one({"file_id": row["id"]}):
            continue
        (upload_root() / row["id"]).unlink(missing_ok=True)
        await db.spv_files.delete_one({"id": row["id"], "expires_at": {"$lte": current}})


async def file_retention_worker(db):
    while True:
        try:
            await cleanup_expired_message_files(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A transient cleanup error must not stop the worker permanently.
            pass
        await asyncio.sleep(30)


@api.get("/storage")
async def storage_usage(request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await cleanup_expired_message_files(db)
    rows = await db.spv_files.find(
        {"owner_id": user["id"], "$or": [
            {"expires_at": {"$exists": False}}, {"expires_at": None},
            {"expires_at": {"$gt": datetime.now(timezone.utc)}},
        ]}, {"_id": 0, "size": 1},
    ).to_list(5000)
    return {
        "file_count": len(rows),
        "used_bytes": sum(max(0, int(row.get("size") or 0)) for row in rows),
        "daily_upload_limit_bytes": MAX_DAILY,
        "max_file_bytes": MAX_BYTES,
    }


async def store(request, user, file, scope, duration_seconds=None, view_once=False):
    db = request.app.state.db
    filename = Path((file.filename or "fichier").replace("\\", "/")).name[:180]
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED:
        raise HTTPException(400, "Format non autorisé. HTML, SVG et exécutables sont refusés.")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    previous = await db.spv_files.find({"owner_id": user["id"], "created_at": {"$gte": cutoff}}).to_list(1000)
    remaining = MAX_DAILY - sum(row["size"] for row in previous)
    if remaining <= 0 or len(previous) >= 100:
        raise HTTPException(429, "Quota quotidien de fichiers atteint.")
    fid = identifier()
    root = upload_root()
    root.mkdir(parents=True, exist_ok=True)
    path = root / fid
    size = 0
    try:
        with path.open("xb") as output:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > min(MAX_BYTES, remaining):
                    raise HTTPException(413, "Fichier trop volumineux (20 Mo maximum ou quota quotidien atteint).")
                output.write(chunk)
        if size == 0:
            raise HTTPException(400, "Le fichier est vide.")
        mime = ALLOWED[suffix]
        # MediaRecorder audio-only blobs commonly use the .webm container.
        if suffix == ".webm" and (file.content_type or "").split(";")[0] == "audio/webm":
            mime = "audio/webm"
        if view_once and (scope == "feed" or not mime.startswith("audio/")):
            raise HTTPException(400, "L’écoute unique est réservée aux messages vocaux.")
        row = {
            "id": fid, "owner_id": user["id"], "scope": scope, "name": filename,
            "size": size, "mime": mime, "url": "/api/messenger/files/" + fid, "created_at": now(),
        }
        if duration_seconds is not None:
            if not mime.startswith("audio/") or not math.isfinite(duration_seconds) or not 0 < duration_seconds <= 7200:
                raise HTTPException(400, "La durée du message vocal est invalide.")
            row["duration_seconds"] = duration_seconds
        if view_once:
            row.update({"view_once": True, "view_once_opened_by": []})
        await db.spv_files.insert_one(row)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    keys = ["id", "name", "mime", "size", "url"]
    if "duration_seconds" in row:
        keys.append("duration_seconds")
    if row.get("view_once"):
        keys.append("view_once")
    return {key: row[key] for key in keys}


@api.post("/conversations/{cid}/files")
async def upload(
    cid: str,
    request: Request,
    file: UploadFile = File(...),
    duration_seconds: float | None = Form(default=None, ge=0, le=7200),
    view_once: bool = Form(default=False),
    user=Depends(chat_user),
):
    conv = await member(request.app.state.db, cid, user)
    if conv["kind"] == "channel":
        administrator(conv, user)
    return await store(request, user, file, cid, duration_seconds, view_once)


@api.post("/feed/files")
async def upload_feed(request: Request, file: UploadFile = File(...), user=Depends(chat_user)):
    return await store(request, user, file, "feed")


@api.get("/files/{fid}")
async def download(fid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    row = await db.spv_files.find_one({"id": fid})
    if not row:
        raise HTTPException(404, "Fichier introuvable.")
    saved_sticker = await db.spv_stickers.find_one({"user_id": user["id"], "file_id": fid})
    if row.get("expires_at") and row["expires_at"] <= datetime.now(timezone.utc) and not saved_sticker:
        await cleanup_expired_message_files(db)
        raise HTTPException(404, "Ce média a expiré.")
    if row["scope"] != "feed" and not saved_sticker:
        await member(db, row["scope"], user)
    elif row["owner_id"] != user["id"]:
        from messenger_social import visible_post
        if row["scope"] == "feed":
            post = await db.spv_posts.find_one({"attachments.id": fid})
            if post:
                await visible_post(db, post["id"], user)
            else:
                status = await db.spv_statuses.find_one({"attachments.id": fid})
                if not status:
                    raise HTTPException(404, "Fichier introuvable.")
                from messenger_social import visible_status
                await visible_status(db, status["id"], user)
    if row["scope"] != "feed" and row["owner_id"] != user["id"] and not saved_sticker:
        if not await db.spv_messages.find_one({
            "conversation_id": row["scope"], "attachments.id": fid, "deleted": False,
        }):
            raise HTTPException(404, "Fichier introuvable.")
        if row.get("view_once"):
            consumed = await db.spv_files.update_one(
                {"id": fid, "view_once": True, "view_once_opened_by": {"$ne": user["id"]}},
                {"$addToSet": {"view_once_opened_by": user["id"]}},
            )
            if not consumed.modified_count:
                raise HTTPException(410, "Ce message vocal à écoute unique a déjà été ouvert.")
    path = upload_root() / row["id"]
    if not path.is_file():
        raise HTTPException(404, "Fichier indisponible sur le serveur.")
    return FileResponse(path, media_type=row["mime"], filename=row["name"], headers={
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })
