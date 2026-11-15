"""Protected local-volume attachments. No public static mount, no bearer in URLs."""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
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


async def store(request, user, file, scope):
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
        row = {
            "id": fid, "owner_id": user["id"], "scope": scope, "name": filename,
            "size": size, "mime": mime, "url": "/api/messenger/files/" + fid, "created_at": now(),
        }
        await db.spv_files.insert_one(row)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    return {key: row[key] for key in ["id", "name", "mime", "size", "url"]}


@api.post("/conversations/{cid}/files")
async def upload(cid: str, request: Request, file: UploadFile = File(...), user=Depends(chat_user)):
    conv = await member(request.app.state.db, cid, user)
    if conv["kind"] == "channel":
        administrator(conv, user)
    return await store(request, user, file, cid)


@api.post("/feed/files")
async def upload_feed(request: Request, file: UploadFile = File(...), user=Depends(chat_user)):
    return await store(request, user, file, "feed")


@api.get("/files/{fid}")
async def download(fid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    row = await db.spv_files.find_one({"id": fid})
    if not row:
        raise HTTPException(404, "Fichier introuvable.")
    if row.get("expires_at") and row["expires_at"] <= datetime.now(timezone.utc):
        await cleanup_expired_message_files(db)
        raise HTTPException(404, "Ce média a expiré.")
    if row["scope"] != "feed":
        await member(db, row["scope"], user)
    elif row["owner_id"] != user["id"]:
        from messenger_social import visible_post
        post = await db.spv_posts.find_one({"attachments.id": fid})
        if post:
            await visible_post(db, post["id"], user)
        else:
            status = await db.spv_statuses.find_one({"attachments.id": fid})
            if not status:
                raise HTTPException(404, "Fichier introuvable.")
            from messenger_social import visible_status
            await visible_status(db, status["id"], user)
    if row["scope"] != "feed" and row["owner_id"] != user["id"]:
        if not await db.spv_messages.find_one({
            "conversation_id": row["scope"], "attachments.id": fid, "deleted": False,
        }):
            raise HTTPException(404, "Fichier introuvable.")
    path = upload_root() / row["id"]
    if not path.is_file():
        raise HTTPException(404, "Fichier indisponible sur le serveur.")
    return FileResponse(path, media_type=row["mime"], filename=row["name"], headers={
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })
