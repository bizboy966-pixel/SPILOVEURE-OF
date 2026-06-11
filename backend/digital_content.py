"""Digital content modules: formations, e-books, premium apps, trading link.

All admin endpoints require admin role. Public endpoints filter to enabled
items only. Storage is URL-based (external CDN / Google Drive / etc.) — admins
can also upload files directly via POST /api/admin/uploads which returns a
relative URL like /api/uploads/<uuid>.<ext> served by FastAPI StaticFiles.
"""
from __future__ import annotations
import uuid
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin


ROOT_DIR = Path(__file__).parent
UPLOADS_DIR = ROOT_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}
ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}
ALLOWED_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".aac"}
ALLOWED_DOC_EXT = {".pdf"}
ALLOWED_APP_EXT = {".apk"}
ALLOWED_UPLOAD_EXT = (
    ALLOWED_IMAGE_EXT | ALLOWED_VIDEO_EXT | ALLOWED_AUDIO_EXT
    | ALLOWED_DOC_EXT | ALLOWED_APP_EXT
)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB


public_router = APIRouter(prefix="/api", tags=["digital_content"])
admin_router = APIRouter(prefix="/api/admin", tags=["digital_content_admin"])


@admin_router.post("/uploads")
async def admin_upload_file(
    request: Request,
    file: UploadFile = File(...),
    admin=Depends(require_admin),
):
    """Receive a single file from the admin and persist it on disk.

    Returns `{"url": "/api/uploads/<uuid>.<ext>", "filename", "size", "content_type"}`.
    The frontend then stores this URL inside the relevant content field
    (image_url, video_url, pdf_url, audio_url, apk_url, …).
    """
    raw_name = file.filename or "upload"
    _, ext = os.path.splitext(raw_name.lower())
    if not ext or ext not in ALLOWED_UPLOAD_EXT:
        raise HTTPException(
            status_code=415,
            detail=(
                "Extension non autorisée. Formats acceptés : "
                + ", ".join(sorted(ALLOWED_UPLOAD_EXT))
            ),
        )

    # Read & enforce size limit by streaming chunks
    out_name = f"{uuid.uuid4().hex}{ext}"
    out_path = UPLOADS_DIR / out_name
    total = 0
    try:
        with out_path.open("wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1 MB chunks
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    f.close()
                    out_path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"Fichier trop volumineux (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        out_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Échec d'upload: {e}")

    # Persist a thin row in MongoDB so admins can audit uploads
    db = request.app.state.db
    record = {
        "id": str(uuid.uuid4()),
        "filename": raw_name,
        "stored_as": out_name,
        "url": f"/api/uploads/{out_name}",
        "size": total,
        "content_type": file.content_type or "",
        "uploaded_by": admin.get("username"),
        "uploaded_at": datetime.now(timezone.utc),
    }
    try:
        await db.media_uploads.insert_one(dict(record))
    except Exception:
        pass

    return {
        "url": record["url"],
        "filename": raw_name,
        "size": total,
        "content_type": record["content_type"],
    }


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class FormationIn(BaseModel):
    title: str
    description: Optional[str] = ""
    image_url: Optional[str] = ""
    video_url: Optional[str] = ""
    pdf_url: Optional[str] = ""
    audio_url: Optional[str] = ""
    category: Optional[str] = ""
    enabled: bool = True
    order: int = 0


class EbookIn(BaseModel):
    title: str
    description: Optional[str] = ""
    image_url: Optional[str] = ""
    pdf_url: Optional[str] = ""
    enabled: bool = True
    order: int = 0


class PremiumAppIn(BaseModel):
    name: str
    description: Optional[str] = ""
    image_url: Optional[str] = ""
    apk_url: Optional[str] = ""
    download_url: Optional[str] = ""
    version: Optional[str] = ""
    enabled: bool = True
    order: int = 0


class TradingSettingsIn(BaseModel):
    telegram_url: Optional[str] = ""
    enabled: bool = True
    label: Optional[str] = "Trading"
    description: Optional[str] = ""


class AvatarIn(BaseModel):
    avatar_url: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _serialize(doc: dict) -> dict:
    doc = dict(doc)
    doc.pop("_id", None)
    for k in ("created_at", "updated_at"):
        if isinstance(doc.get(k), datetime):
            doc[k] = doc[k].isoformat()
    return doc


async def _list(db, coll: str, only_enabled: bool) -> List[dict]:
    q = {"enabled": True} if only_enabled else {}
    docs = await db[coll].find(q, {"_id": 0}).sort([("order", 1), ("created_at", -1)]).to_list(500)
    return [_serialize(d) for d in docs]


async def _crud_create(db, coll: str, payload: dict, admin: dict) -> dict:
    doc = {
        "id": str(uuid.uuid4()),
        **payload,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "created_by": admin.get("username"),
    }
    await db[coll].insert_one(doc)
    return _serialize(doc)


async def _crud_update(db, coll: str, item_id: str, payload: dict) -> dict:
    payload["updated_at"] = datetime.now(timezone.utc)
    res = await db[coll].update_one({"id": item_id}, {"$set": payload})
    if res.matched_count == 0:
        raise HTTPException(404, "Élément introuvable")
    doc = await db[coll].find_one({"id": item_id}, {"_id": 0})
    return _serialize(doc) if doc else {}


async def _crud_delete(db, coll: str, item_id: str) -> dict:
    res = await db[coll].delete_one({"id": item_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Élément introuvable")
    return {"ok": True, "deleted_id": item_id}


# ---------------------------------------------------------------------------
# PUBLIC user endpoints — return only enabled items
# ---------------------------------------------------------------------------
@public_router.get("/formations")
async def list_formations(request: Request, user=Depends(get_current_user)):  # noqa: ARG001 — auth-gated
    return await _list(request.app.state.db, "formations", only_enabled=True)


@public_router.get("/ebooks")
async def list_ebooks(request: Request, user=Depends(get_current_user)):  # noqa: ARG001
    return await _list(request.app.state.db, "ebooks", only_enabled=True)


@public_router.get("/premium-apps")
async def list_premium_apps(request: Request, user=Depends(get_current_user)):  # noqa: ARG001
    return await _list(request.app.state.db, "premium_apps", only_enabled=True)


@public_router.get("/settings/trading")
async def get_trading_settings(request: Request, user=Depends(get_current_user)):  # noqa: ARG001
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "trading"}, {"_id": 0}) or {}
    return {
        "enabled": bool(doc.get("enabled", False)),
        "telegram_url": doc.get("telegram_url") or "",
        "label": doc.get("label") or "Trading",
        "description": doc.get("description") or "",
    }


# ---------------------------------------------------------------------------
# Avatar update (user self-service)
# ---------------------------------------------------------------------------
@public_router.put("/users/me/avatar")
async def update_my_avatar(
    payload: AvatarIn, request: Request, user=Depends(get_current_user),
):
    db = request.app.state.db
    url = (payload.avatar_url or "").strip()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"avatar_url": url, "updated_at": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "avatar_url": url}


# ---------------------------------------------------------------------------
# ADMIN endpoints
# ---------------------------------------------------------------------------
# Formations
@admin_router.get("/formations")
async def admin_list_formations(request: Request, admin=Depends(require_admin)):  # noqa: ARG001
    return await _list(request.app.state.db, "formations", only_enabled=False)


@admin_router.post("/formations")
async def admin_create_formation(
    data: FormationIn, request: Request, admin=Depends(require_admin),
):
    return await _crud_create(request.app.state.db, "formations", data.model_dump(), admin)


@admin_router.put("/formations/{item_id}")
async def admin_update_formation(
    item_id: str, data: FormationIn, request: Request, admin=Depends(require_admin),  # noqa: ARG001
):
    return await _crud_update(request.app.state.db, "formations", item_id, data.model_dump())


@admin_router.delete("/formations/{item_id}")
async def admin_delete_formation(
    item_id: str, request: Request, admin=Depends(require_admin),  # noqa: ARG001
):
    return await _crud_delete(request.app.state.db, "formations", item_id)


# E-books
@admin_router.get("/ebooks")
async def admin_list_ebooks(request: Request, admin=Depends(require_admin)):  # noqa: ARG001
    return await _list(request.app.state.db, "ebooks", only_enabled=False)


@admin_router.post("/ebooks")
async def admin_create_ebook(
    data: EbookIn, request: Request, admin=Depends(require_admin),
):
    return await _crud_create(request.app.state.db, "ebooks", data.model_dump(), admin)


@admin_router.put("/ebooks/{item_id}")
async def admin_update_ebook(
    item_id: str, data: EbookIn, request: Request, admin=Depends(require_admin),  # noqa: ARG001
):
    return await _crud_update(request.app.state.db, "ebooks", item_id, data.model_dump())


@admin_router.delete("/ebooks/{item_id}")
async def admin_delete_ebook(
    item_id: str, request: Request, admin=Depends(require_admin),  # noqa: ARG001
):
    return await _crud_delete(request.app.state.db, "ebooks", item_id)


# Premium apps
@admin_router.get("/premium-apps")
async def admin_list_premium_apps(request: Request, admin=Depends(require_admin)):  # noqa: ARG001
    return await _list(request.app.state.db, "premium_apps", only_enabled=False)


@admin_router.post("/premium-apps")
async def admin_create_premium_app(
    data: PremiumAppIn, request: Request, admin=Depends(require_admin),
):
    return await _crud_create(request.app.state.db, "premium_apps", data.model_dump(), admin)


@admin_router.put("/premium-apps/{item_id}")
async def admin_update_premium_app(
    item_id: str, data: PremiumAppIn, request: Request, admin=Depends(require_admin),  # noqa: ARG001
):
    return await _crud_update(request.app.state.db, "premium_apps", item_id, data.model_dump())


@admin_router.delete("/premium-apps/{item_id}")
async def admin_delete_premium_app(
    item_id: str, request: Request, admin=Depends(require_admin),  # noqa: ARG001
):
    return await _crud_delete(request.app.state.db, "premium_apps", item_id)


# Trading settings (single document)
@admin_router.get("/settings/trading")
async def admin_get_trading(request: Request, admin=Depends(require_admin)):  # noqa: ARG001
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "trading"}, {"_id": 0}) or {}
    return {
        "enabled": bool(doc.get("enabled", False)),
        "telegram_url": doc.get("telegram_url") or "",
        "label": doc.get("label") or "Trading",
        "description": doc.get("description") or "",
        "updated_at": doc.get("updated_at"),
        "updated_by": doc.get("updated_by"),
    }


@admin_router.put("/settings/trading")
async def admin_update_trading(
    data: TradingSettingsIn, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    payload = {
        "enabled": bool(data.enabled),
        "telegram_url": (data.telegram_url or "").strip(),
        "label": (data.label or "Trading").strip(),
        "description": (data.description or "").strip(),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "trading"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}
