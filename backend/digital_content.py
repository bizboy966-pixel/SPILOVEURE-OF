"""Digital content modules: formations, e-books, premium apps, trading link.

All admin endpoints require admin role. Public endpoints filter to enabled
items only. Storage is URL-based (external CDN / Google Drive / etc.) — no
file upload to the server itself.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin


public_router = APIRouter(prefix="/api", tags=["digital_content"])
admin_router = APIRouter(prefix="/api/admin", tags=["digital_content_admin"])


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
