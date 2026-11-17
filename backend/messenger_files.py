"""Protected Chat attachment metadata, direct R2 transfers and legacy disk reads."""
from __future__ import annotations

import asyncio
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from messenger_core import administrator, chat_user, clean, identifier, member, now
import messenger_r2 as r2

api = APIRouter()
MAX_BYTES = 20 * 1024 * 1024
MAX_DAILY = 100 * 1024 * 1024
PENDING_UPLOAD_TTL = timedelta(minutes=15)
UPLOAD_URL_TTL_SECONDS = 300
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


class UploadIntent(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    size: int = Field(gt=0, le=MAX_BYTES)
    mime: str = Field(default="", max_length=120)
    duration_seconds: float | None = Field(default=None, gt=0, le=7200)
    view_once: bool = False
    sticker: bool = False


def upload_root():
    return Path(os.environ.get("UPLOADS_DIR", str(Path(__file__).parent / "uploads"))) / "messenger"


def _is_expired(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    if not isinstance(value, datetime):
        return False
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value <= datetime.now(timezone.utc)


async def cleanup_expired_message_files(db):
    current = datetime.now(timezone.utc)
    expired_files = await db.spv_files.find(
        {"$or": [
            {"expires_at": {"$lte": current}},
            {"status": {"$in": ["pending", "cancelled"]}, "pending_until": {"$lte": current}},
        ]},
        {"_id": 0, "id": 1, "status": 1, "pending_until": 1, "storage_backend": 1, "expires_at": 1},
    ).to_list(500)
    for row in expired_files:
        pending = row.get("status") in ("pending", "cancelled")
        if pending:
            try:
                await asyncio.to_thread(r2.delete_upload, row["id"])
            except r2.R2NotConfigured:
                continue
            except Exception:
                continue
            await db.spv_files.delete_one({
                "id": row["id"], "status": {"$in": ["pending", "cancelled"]},
                "pending_until": {"$lte": current},
            })
            continue
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
        if await db.spv_sticker_pack_items.find_one({"file_id": row["id"]}):
            continue
        if row.get("storage_backend") == "r2":
            try:
                await asyncio.to_thread(r2.delete_upload, row["id"])
            except r2.R2NotConfigured:
                continue
            except Exception:
                continue
        else:
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


def _validated_metadata(name, size, client_mime, scope, duration_seconds, view_once, sticker):
    filename = Path((name or "fichier").replace("\\", "/")).name[:180]
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED:
        raise HTTPException(400, "Format non autorisé. HTML, SVG et exécutables sont refusés.")
    if size <= 0 or size > MAX_BYTES:
        raise HTTPException(413, "Fichier trop volumineux (20 Mo maximum).")
    mime = ALLOWED[suffix]
    if suffix == ".webm" and (client_mime or "").split(";")[0] == "audio/webm":
        mime = "audio/webm"
    if view_once and (scope == "feed" or not mime.startswith("audio/")):
        raise HTTPException(400, "L’écoute unique est réservée aux messages vocaux.")
    if sticker and not mime.startswith("image/"):
        raise HTTPException(400, "Convertissez la vidéo en sticker animé avant l’envoi.")
    if duration_seconds is not None and (
        not mime.startswith("audio/")
        or not math.isfinite(duration_seconds)
        or not 0 < duration_seconds <= 7200
    ):
        raise HTTPException(400, "La durée du message vocal est invalide.")
    return filename, mime


async def _daily_quota(db, owner_id):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    previous = await db.spv_files.find({
        "owner_id": owner_id, "created_at": {"$gte": cutoff},
    }).to_list(1000)
    used = sum(int(row.get("reserved_size", row.get("size", 0)) or 0) for row in previous)
    return MAX_DAILY - used, len(previous)


def _attachment(row):
    keys = ["id", "name", "mime", "size", "url"]
    for optional in ("duration_seconds", "view_once", "sticker"):
        if optional in row and row.get(optional):
            keys.append(optional)
    return {key: row[key] for key in keys}


async def _create_upload(request, user, scope, body: UploadIntent):
    db = request.app.state.db
    filename, mime = _validated_metadata(
        body.name, body.size, body.mime, scope, body.duration_seconds, body.view_once, body.sticker,
    )
    remaining, daily_count = await _daily_quota(db, user["id"])
    if daily_count >= 100 or remaining <= 0:
        raise HTTPException(429, "Quota quotidien de fichiers atteint.")
    if body.size > remaining:
        raise HTTPException(429, "Le fichier dépasse le quota quotidien de stockage restant.")

    fid = identifier()
    try:
        upload_url = await asyncio.to_thread(
            r2.create_upload_url, fid, mime, body.size, UPLOAD_URL_TTL_SECONDS,
        )
    except r2.R2NotConfigured:
        raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
    except Exception:
        raise HTTPException(503, "Impossible de préparer l’envoi vers le stockage du Chat.")

    row = {
        "id": fid, "owner_id": user["id"], "scope": scope, "name": filename,
        "size": body.size, "reserved_size": body.size, "mime": mime,
        "url": "/api/messenger/files/" + fid, "created_at": now(),
        "storage_backend": "r2", "storage_key": r2.object_key(fid), "status": "pending",
        "pending_until": datetime.now(timezone.utc) + PENDING_UPLOAD_TTL,
    }
    if body.sticker:
        row["sticker"] = True
    if body.duration_seconds is not None:
        row["duration_seconds"] = body.duration_seconds
    if body.view_once:
        row.update({"view_once": True, "view_once_opened_by": []})
    await db.spv_files.insert_one(row)
    return {
        "id": fid,
        "upload_url": upload_url,
        "method": "PUT",
        "headers": {"Content-Type": mime},
        "expires_in": UPLOAD_URL_TTL_SECONDS,
    }


async def _complete_upload(request, user, fid):
    db = request.app.state.db
    row = await db.spv_files.find_one({"id": fid, "owner_id": user["id"]})
    if not row:
        raise HTTPException(404, "Envoi introuvable.")
    if row.get("status") == "ready":
        return _attachment(row)
    if row.get("status") != "pending":
        raise HTTPException(409, "Cet envoi a été annulé ou a expiré.")
    pending_until = row.get("pending_until")
    if pending_until and _is_expired(pending_until):
        try:
            await asyncio.to_thread(r2.delete_upload, fid)
        except Exception:
            pass
        await db.spv_files.delete_one({"id": fid, "owner_id": user["id"], "status": "pending"})
        raise HTTPException(410, "Le lien d’envoi a expiré. Réessayez.")

    try:
        metadata = await asyncio.to_thread(r2.head_upload, fid)
    except r2.R2NotConfigured:
        raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
    except Exception:
        raise HTTPException(409, "Le transfert vers R2 n’est pas terminé.")
    actual_size = int(metadata.get("ContentLength") or 0)
    actual_mime = (metadata.get("ContentType") or "").split(";")[0]
    if actual_size != int(row.get("reserved_size") or row.get("size") or 0) or actual_mime != row["mime"]:
        try:
            await asyncio.to_thread(r2.delete_upload, fid)
        except Exception:
            pass
        await db.spv_files.delete_one({"id": fid, "owner_id": user["id"], "status": "pending"})
        raise HTTPException(400, "Le fichier reçu ne correspond pas aux informations de l’envoi.")

    await db.spv_files.update_one(
        {"id": fid, "owner_id": user["id"], "status": "pending"},
        {"$set": {"status": "ready", "size": actual_size, "uploaded_at": now()},
         "$unset": {"reserved_size": "", "pending_until": ""}},
    )
    ready = await db.spv_files.find_one({"id": fid, "owner_id": user["id"], "status": "ready"})
    if not ready:
        raise HTTPException(409, "L’envoi a été annulé avant sa validation.")
    return _attachment(ready)


@api.post("/conversations/{cid}/files/upload-url")
async def create_conversation_upload(
    cid: str, body: UploadIntent, request: Request, user=Depends(chat_user),
):
    conv = await member(request.app.state.db, cid, user)
    if conv["kind"] == "channel":
        administrator(conv, user)
    return await _create_upload(request, user, cid, body)


@api.post("/feed/files/upload-url")
async def create_feed_upload(body: UploadIntent, request: Request, user=Depends(chat_user)):
    return await _create_upload(request, user, "feed", body)


@api.post("/uploads/{fid}/complete")
async def complete_upload(fid: str, request: Request, user=Depends(chat_user)):
    return await _complete_upload(request, user, fid)


@api.delete("/uploads/{fid}")
async def cancel_upload(fid: str, request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    row = await db.spv_files.find_one({
        "id": fid, "owner_id": user["id"], "status": "pending",
    })
    if not row:
        return {"ok": True}
    # Keep the reservation until the signed PUT link expires so it cannot be
    # reused to leave an untracked object behind.
    await db.spv_files.update_one(
        {"id": fid, "owner_id": user["id"], "status": "pending"},
        {"$set": {"status": "cancelled", "cancelled_at": now()}},
    )
    return {"ok": True}


@api.get("/storage")
async def storage_usage(request: Request, user=Depends(chat_user)):
    db = request.app.state.db
    await cleanup_expired_message_files(db)
    rows = await db.spv_files.find(
        {"owner_id": user["id"], "status": {"$ne": "cancelled"}, "$or": [
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


async def store(request, user, file, scope, duration_seconds=None, view_once=False, sticker=False):
    db = request.app.state.db
    remaining, daily_count = await _daily_quota(db, user["id"])
    if remaining <= 0 or daily_count >= 100:
        raise HTTPException(429, "Quota quotidien de fichiers atteint.")
    filename, mime = _validated_metadata(
        file.filename or "fichier", MAX_BYTES, file.content_type, scope,
        duration_seconds, view_once, sticker,
    )
    fid = identifier()
    size = 0
    uploaded = False
    try:
        with tempfile.TemporaryFile(mode="w+b") as output:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > min(MAX_BYTES, remaining):
                    raise HTTPException(413, "Fichier trop volumineux (20 Mo maximum ou quota quotidien atteint).")
                output.write(chunk)
            if size == 0:
                raise HTTPException(400, "Le fichier est vide.")
            output.seek(0)
            try:
                await asyncio.to_thread(r2.put_upload, fid, output, mime, size)
            except r2.R2NotConfigured:
                raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
            uploaded = True
        row = {
            "id": fid, "owner_id": user["id"], "scope": scope, "name": filename,
            "size": size, "mime": mime, "url": "/api/messenger/files/" + fid, "created_at": now(),
            "storage_backend": "r2", "storage_key": r2.object_key(fid), "status": "ready",
        }
        if sticker:
            row["sticker"] = True
        if duration_seconds is not None:
            if not mime.startswith("audio/") or not math.isfinite(duration_seconds) or not 0 < duration_seconds <= 7200:
                raise HTTPException(400, "La durée du message vocal est invalide.")
            row["duration_seconds"] = duration_seconds
        if view_once:
            row.update({"view_once": True, "view_once_opened_by": []})
        await db.spv_files.insert_one(row)
    except BaseException:
        if uploaded:
            try:
                await asyncio.to_thread(r2.delete_upload, fid)
            except Exception:
                pass
        raise
    finally:
        await file.close()
    return _attachment(row)


@api.post("/conversations/{cid}/files")
async def upload(
    cid: str,
    request: Request,
    file: UploadFile = File(...),
    duration_seconds: float | None = Form(default=None, ge=0, le=7200),
    view_once: bool = Form(default=False),
    sticker: bool = Form(default=False),
    user=Depends(chat_user),
):
    conv = await member(request.app.state.db, cid, user)
    if conv["kind"] == "channel":
        administrator(conv, user)
    return await store(request, user, file, cid, duration_seconds, view_once, sticker)


@api.post("/feed/files")
async def upload_feed(request: Request, file: UploadFile = File(...), user=Depends(chat_user)):
    return await store(request, user, file, "feed")


async def _authorized_file(db, fid, user, consume_view_once=False):
    from messenger_sticker_pack import PACK_ROOT, pack_file
    builtin = pack_file(fid)
    if builtin:
        return {"id": fid, "builtin_path": PACK_ROOT / (fid.removeprefix("pack-") + ".png"), "mime": "image/png"}
    row = await db.spv_files.find_one({"id": fid})
    if not row:
        raise HTTPException(404, "Fichier introuvable.")
    saved_sticker = await db.spv_stickers.find_one({"user_id": user["id"], "file_id": fid})
    packed_sticker = await db.spv_sticker_pack_items.find_one({"user_id": user["id"], "file_id": fid})
    retained_sticker = bool(saved_sticker or packed_sticker)
    if _is_expired(row.get("expires_at")) and not retained_sticker:
        await cleanup_expired_message_files(db)
        raise HTTPException(404, "Ce média a expiré.")
    if row["scope"] != "feed" and not retained_sticker:
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
    if row["scope"] != "feed" and row["owner_id"] != user["id"] and not retained_sticker:
        if not await db.spv_messages.find_one({
            "conversation_id": row["scope"], "attachments.id": fid, "deleted": False,
        }):
            raise HTTPException(404, "Fichier introuvable.")
        if row.get("view_once"):
            if user["id"] in set(row.get("view_once_opened_by") or []):
                raise HTTPException(410, "Ce message vocal à écoute unique a déjà été ouvert.")
            if consume_view_once:
                consumed = await db.spv_files.update_one(
                    {"id": fid, "view_once": True, "view_once_opened_by": {"$ne": user["id"]}},
                    {"$addToSet": {"view_once_opened_by": user["id"]}},
                )
                if not consumed.modified_count:
                    raise HTTPException(410, "Ce message vocal à écoute unique a déjà été ouvert.")
    return row


@api.get("/files/{fid}/url")
async def file_url(fid: str, request: Request, download: bool = False, user=Depends(chat_user)):
    row = await _authorized_file(request.app.state.db, fid, user)
    if row.get("builtin_path"):
        return {"direct": False, "url": f"/api/messenger/files/{fid}"}
    if row.get("view_once"):
        # One-time audio is streamed through the protected endpoint so a signed
        # R2 URL cannot be replayed by reusing it before expiry.
        return {"direct": False, "url": f"/api/messenger/files/{fid}"}
    if row.get("storage_backend") == "r2":
        if row.get("status") not in (None, "ready"):
            raise HTTPException(404, "Fichier introuvable.")
        try:
            signed_url = await asyncio.to_thread(
                r2.create_download_url, fid, row["mime"], row["name"], download,
            )
        except r2.R2NotConfigured:
            raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
        except Exception:
            raise HTTPException(502, "Impossible de préparer le téléchargement du fichier.")
        return {"direct": True, "url": signed_url, "expires_in": r2.DEFAULT_URL_TTL}
    local_path = upload_root() / row["id"]
    if not local_path.is_file():
        raise HTTPException(404, "Fichier indisponible dans le stockage.")
    return {"direct": False, "url": f"/api/messenger/files/{fid}"}


@api.get("/files/{fid}")
async def download(fid: str, request: Request, download: bool = False, user=Depends(chat_user)):
    row = await _authorized_file(request.app.state.db, fid, user, consume_view_once=True)
    if row.get("builtin_path"):
        return FileResponse(row["builtin_path"], media_type=row["mime"])
    if row.get("storage_backend") == "r2":
        if row.get("status") not in (None, "ready"):
            raise HTTPException(404, "Fichier introuvable.")
        if row.get("view_once") and user["id"] != row["owner_id"]:
            try:
                obj = await asyncio.to_thread(r2.get_upload, fid)
            except r2.R2NotConfigured:
                raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
            except Exception:
                raise HTTPException(404, "Fichier indisponible dans le stockage.")

            def stream_object():
                try:
                    yield from obj["Body"].iter_chunks(chunk_size=64 * 1024)
                finally:
                    obj["Body"].close()

            return StreamingResponse(stream_object(), media_type=row["mime"], headers={
                "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
                "Content-Security-Policy": "default-src 'none'; sandbox",
            })
        try:
            signed_url = await asyncio.to_thread(
                r2.create_download_url, fid, row["mime"], row["name"], download,
            )
        except r2.R2NotConfigured:
            raise HTTPException(503, "Le stockage R2 du Chat n’est pas configuré sur le serveur.")
        except Exception:
            raise HTTPException(502, "Impossible de préparer le téléchargement du fichier.")
        return RedirectResponse(signed_url, status_code=307, headers={
            "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        })
    path = upload_root() / row["id"]
    if not path.is_file():
        raise HTTPException(404, "Fichier indisponible dans le stockage.")
    return FileResponse(path, media_type=row["mime"], filename=row["name"], headers={
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })
