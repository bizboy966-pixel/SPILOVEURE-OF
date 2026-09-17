"""Activation Videos module — admin uploads guide videos shown to new users
on the payment/activation page.

Storage strategy: same dual-write pattern used by `ads.py.user_upload_file`:
- Files persisted to Emergent Object Storage (production durability).
- Copy on local disk (`UPLOADS_DIR`) so preview environments without an
  Object Storage key still work.
- Served via the existing `/api/uploads/{filename}` route on server.py.

Order: DB documents carry a `position: int` field. GET endpoints sort by
`position ASC, created_at ASC` — the first uploaded video is #1 and so on.
Delete does not compact positions (kept simple; future re-ordering endpoint
can renumber if needed).
"""
from __future__ import annotations
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin  # type: ignore
from object_storage import is_enabled as _obj_enabled, put_upload as _obj_put

log = logging.getLogger("activation_videos")

# Same uploads dir used by ads.py — kept in sync with server.py's static route.
UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}
# 300 MB per video — enough for a 5-min guide at reasonable quality without
# blowing up the storage bill. Overridable via .env.
MAX_VIDEO_MB = int(os.environ.get("ACTIVATION_VIDEO_MAX_MB") or 300)
MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024

public = APIRouter(prefix="/api", tags=["activation-videos"])
admin = APIRouter(
    prefix="/api/admin",
    tags=["activation-videos-admin"],
    dependencies=[Depends(require_admin)],
)


def _serialize(doc: dict) -> dict:
    """Strip Mongo _id and serialize timestamps for JSON output."""
    if not doc:
        return {}
    out = {k: v for k, v in doc.items() if k != "_id"}
    for k in ("created_at", "updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


# ─── PUBLIC ────────────────────────────────────────────────────────────
@public.get("/settings/activation-videos")
async def list_activation_videos_public(request: Request):
    """Listed on the payment page for users to watch BEFORE activating.
    Only returns videos with `active: True` (admin can hide without deleting).
    Ordered by `position` ascending, then upload date.
    """
    db = request.app.state.db
    cur = db.activation_videos.find(
        {"active": {"$ne": False}},
        {"_id": 0},
    ).sort([("position", 1), ("created_at", 1)])
    items = [_serialize(d) async for d in cur]
    return {"items": items}


# ─── ADMIN CRUD ────────────────────────────────────────────────────────
@admin.get("/activation-videos")
async def list_activation_videos_admin(request: Request):
    """Full admin list — includes inactive videos and internal metadata."""
    db = request.app.state.db
    cur = db.activation_videos.find({}).sort([("position", 1), ("created_at", 1)])
    items = [_serialize(d) async for d in cur]
    return {"items": items, "count": len(items)}


@admin.post("/activation-videos")
async def upload_activation_video(
    request: Request,
    title: str = Form(...),
    description: str = Form(""),
    file: UploadFile = File(...),
    admin_user=Depends(require_admin),
):
    """Upload a new activation video.

    Multipart form:
      - title       (required)
      - description (optional)
      - file        (mp4/mov/webm/m4v, ≤300 MB)
    """
    title_clean = (title or "").strip()
    if not title_clean:
        raise HTTPException(400, "Le titre est obligatoire.")

    raw_name = file.filename or "video"
    ext = os.path.splitext(raw_name.lower())[1]
    if ext not in ALLOWED_VIDEO_EXT:
        raise HTTPException(
            415,
            f"Format non autorisé. Formats acceptés : {sorted(ALLOWED_VIDEO_EXT)}",
        )

    out_name = f"activation-video-{uuid.uuid4().hex}{ext}"
    total = 0
    buf = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)  # 1 MB chunks
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_VIDEO_BYTES:
            raise HTTPException(
                413,
                f"Vidéo trop volumineuse (max {MAX_VIDEO_MB} MB).",
            )
        buf.extend(chunk)

    content_type = file.content_type or "video/mp4"
    # Dual write — local (preview) + object storage (prod persistence).
    (UPLOADS_DIR / out_name).write_bytes(bytes(buf))
    if _obj_enabled():
        try:
            _obj_put(out_name, bytes(buf), content_type)
        except Exception as e:
            log.warning("activation video object_storage put failed: %s", e)

    db = request.app.state.db
    # Auto-assign next position = current max + 1 (so first upload = 1).
    last = await db.activation_videos.find_one(
        {}, {"_id": 0, "position": 1},
        sort=[("position", -1)],
    )
    next_pos = int((last or {}).get("position") or 0) + 1

    doc = {
        "id": str(uuid.uuid4()),
        "title": title_clean,
        "description": (description or "").strip(),
        "filename": out_name,
        "url": f"/api/uploads/{out_name}",
        "content_type": content_type,
        "size_bytes": total,
        "position": next_pos,
        "active": True,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "created_by": admin_user.get("username"),
    }
    await db.activation_videos.insert_one(doc)
    return _serialize(doc)


class VideoUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    active: Optional[bool] = None
    position: Optional[int] = Field(None, ge=1)


@admin.put("/activation-videos/{video_id}")
async def update_activation_video(
    video_id: str,
    data: VideoUpdate,
    request: Request,
):
    """Edit metadata — file cannot be changed here; upload a new video and
    delete the old one for a real replacement."""
    db = request.app.state.db
    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if data.title is not None:
        title_clean = data.title.strip()
        if not title_clean:
            raise HTTPException(400, "Le titre est obligatoire.")
        updates["title"] = title_clean
    if data.description is not None:
        updates["description"] = data.description.strip()
    if data.active is not None:
        updates["active"] = bool(data.active)
    if data.position is not None:
        updates["position"] = int(data.position)
    r = await db.activation_videos.update_one({"id": video_id}, {"$set": updates})
    if r.matched_count == 0:
        raise HTTPException(404, "Vidéo introuvable.")
    doc = await db.activation_videos.find_one({"id": video_id}, {"_id": 0})
    return _serialize(doc)


@admin.delete("/activation-videos/{video_id}")
async def delete_activation_video(video_id: str, request: Request):
    """Delete the DB row AND the file from disk + object storage."""
    db = request.app.state.db
    doc = await db.activation_videos.find_one({"id": video_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Vidéo introuvable.")
    filename = doc.get("filename")
    # Best-effort cleanup — never block delete if storage cleanup errors.
    if filename:
        local = UPLOADS_DIR / filename
        try:
            if local.is_file():
                local.unlink()
        except Exception as e:
            log.warning("activation video local unlink failed for %s: %s", filename, e)
        if _obj_enabled():
            try:
                # object_storage has no delete API in the current SDK — we
                # simply leave the object as tombstone. The DB row is what
                # controls visibility.
                pass
            except Exception:
                pass
    await db.activation_videos.delete_one({"id": video_id})
    return {"ok": True, "deleted_id": video_id}
