"""Marketplace module — free product listings with admin review + auto-expiry.

Rules (2026-07-24):
    - Anyone authenticated can publish a listing (no payment required).
    - Admin approves → visible in feed for `duration_days` (default 14) then expires.
    - Buyers contact seller directly via WhatsApp (no in-app checkout).
    - Buyers can leave a rating + review after contact.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin
from feature_flags import is_enabled as feature_enabled


public = APIRouter(prefix="/api", tags=["marketplace"])
admin = APIRouter(prefix="/api/admin", tags=["marketplace_admin"], dependencies=[Depends(require_admin)])

DEFAULT_DURATION_DAYS = 14


class ListingCreate(BaseModel):
    images: List[str] = Field(..., min_length=1, max_length=10)
    videos: List[str] = Field(default_factory=list, max_length=5)
    audio: Optional[str] = Field(default=None, max_length=500)
    name: str = Field(..., min_length=2, max_length=200)
    category: str = Field(..., min_length=1, max_length=100)
    price: float = Field(..., ge=0)
    promo_price: Optional[float] = Field(default=None, ge=0)
    city: str = Field(..., min_length=1, max_length=100)
    whatsapp: str = Field(..., min_length=6, max_length=25)
    description: str = Field(default="", max_length=2000)


class Review(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    comment: str = Field(default="", max_length=500)


class ConfigUpdate(BaseModel):
    duration_days: int = Field(..., ge=1, le=365)
    enabled: bool = True


def _serialize(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    for k in ("created_at", "approved_at", "expires_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.astimezone(timezone.utc).isoformat()
    for r in out.get("reviews") or []:
        if isinstance(r.get("at"), datetime):
            r["at"] = r["at"].astimezone(timezone.utc).isoformat()
    return out


async def _config(db) -> dict:
    doc = await db.marketplace_config.find_one({"key": "singleton"}) or {}
    return {
        "duration_days": int(doc.get("duration_days") or DEFAULT_DURATION_DAYS),
        "enabled": doc.get("enabled") if doc.get("enabled") is not None else True,
    }


# ---------- USER ----------
@public.get("/marketplace/config")
async def cfg(request: Request, user=Depends(get_current_user)):
    return await _config(request.app.state.db)


@public.post("/marketplace")
async def create_listing(data: ListingCreate, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    if not await feature_enabled(db, "marketplace"):
        raise HTTPException(503, "Marketplace momentanément désactivé par l'administrateur.")
    if not await feature_enabled(db, "marketplace_publish"):
        raise HTTPException(503, "Publication d'articles momentanément désactivée par l'administrateur.")
    c = await _config(db)
    if not c["enabled"]:
        raise HTTPException(503, "La publication est momentanément désactivée par l'administrateur.")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "seller_id": user["id"],
        "seller_username": user.get("username"),
        "images": data.images,
        "videos": data.videos,
        "audio": data.audio,
        "name": data.name,
        "category": data.category,
        "price": data.price,
        "promo_price": data.promo_price,
        "currency": "FCFA",
        "city": data.city,
        "whatsapp": data.whatsapp,
        "description": data.description,
        "status": "pending_admin_review",
        "views": 0,
        "reviews": [],
        "created_at": now,
    }
    await db.marketplace_listings.insert_one(doc)
    return _serialize(doc)


@public.get("/marketplace")
async def public_feed(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    if not await feature_enabled(db, "marketplace"):
        return {"items": []}
    now = datetime.now(timezone.utc)
    # Auto-expire past-due listings on read (lazy expiration).
    await db.marketplace_listings.update_many(
        {"status": "approved", "expires_at": {"$lte": now}},
        {"$set": {"status": "expired"}},
    )
    items = []
    async for l in db.marketplace_listings.find({"status": "approved"}).sort("approved_at", -1).limit(500):
        items.append(_serialize(l))
    return {"items": items}


# ---------- "Nouveauté" badge for the bottom-nav Marketplace icon ----------
# NOTE: these static routes MUST come before `/marketplace/{listing_id}` so
# that FastAPI doesn't interpret "unread-count" / "mark-seen" as a listing id.
@public.get("/marketplace/unread-count")
async def marketplace_unread_count(request: Request, user=Depends(get_current_user)):
    """Return how many approved listings the user hasn't seen yet.

    Same semantics as /api/ads/unread-count: an item counts as "new" when its
    `approved_at` is strictly greater than `users.last_marketplace_seen_at`.
    Listings owned by the caller are excluded (seller doesn't get a badge
    for their own newly-approved article) and expired items are ignored.
    """
    db = request.app.state.db
    if not await feature_enabled(db, "marketplace"):
        return {"unread": 0}
    u = await db.users.find_one({"id": user["id"]}, {"last_marketplace_seen_at": 1}) or {}
    seen = u.get("last_marketplace_seen_at")
    q: dict = {
        "status": "approved",
        "seller_id": {"$ne": user["id"]},
    }
    if seen:
        q["approved_at"] = {"$gt": seen}
    unread = await db.marketplace_listings.count_documents(q)
    return {"unread": int(unread)}


@public.post("/marketplace/mark-seen")
async def marketplace_mark_seen(request: Request, user=Depends(get_current_user)):
    """Reset the unread-marketplace badge (fires when the user opens /marketplace)."""
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_marketplace_seen_at": now}},
    )
    return {"ok": True, "at": now.isoformat()}


@public.get("/marketplace/{listing_id}")
async def get_listing(listing_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    l = await db.marketplace_listings.find_one({"id": listing_id})
    if not l:
        raise HTTPException(404, "Annonce introuvable.")
    if l["status"] != "approved":
        # Sellers can still see their own
        if l["seller_id"] != user["id"] and (user.get("role") or "") != "admin":
            raise HTTPException(404, "Annonce indisponible.")
    return _serialize(l)


@public.post("/marketplace/{listing_id}/view")
async def register_view(listing_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    await db.marketplace_listings.update_one(
        {"id": listing_id, "status": "approved", "viewers": {"$ne": user["id"]}},
        {"$addToSet": {"viewers": user["id"]}, "$inc": {"views": 1}},
    )
    return {"ok": True}


@public.post("/marketplace/{listing_id}/review")
async def add_review(listing_id: str, data: Review, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    l = await db.marketplace_listings.find_one({"id": listing_id, "status": "approved"})
    if not l:
        raise HTTPException(404, "Annonce introuvable.")
    if l["seller_id"] == user["id"]:
        raise HTTPException(400, "Vous ne pouvez pas noter votre propre annonce.")
    if any((r.get("user_id") == user["id"]) for r in (l.get("reviews") or [])):
        raise HTTPException(400, "Vous avez déjà laissé un avis.")
    review = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "rating": data.rating,
        "comment": data.comment,
        "at": datetime.now(timezone.utc),
    }
    await db.marketplace_listings.update_one({"id": listing_id}, {"$push": {"reviews": review}})
    review["at"] = review["at"].isoformat()
    return {"review": review}


@public.get("/marketplace/mine")
async def my_listings(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = []
    async for l in db.marketplace_listings.find({"seller_id": user["id"]}).sort("created_at", -1):
        items.append(_serialize(l))
    return {"items": items}


# ---------- ADMIN ----------
@admin.get("/marketplace/config")
async def admin_cfg(request: Request):
    return await _config(request.app.state.db)


@admin.put("/marketplace/config")
async def admin_set_cfg(data: ConfigUpdate, request: Request):
    db = request.app.state.db
    await db.marketplace_config.update_one(
        {"key": "singleton"},
        {"$set": {"key": "singleton", "duration_days": data.duration_days, "enabled": data.enabled}},
        upsert=True,
    )
    return await _config(db)


@admin.get("/marketplace")
async def admin_list(request: Request, status: Optional[str] = None):
    db = request.app.state.db
    q: dict = {}
    if status:
        q["status"] = status
    items = []
    async for l in db.marketplace_listings.find(q).sort("created_at", -1).limit(500):
        items.append(_serialize(l))
    return {"items": items}


@admin.post("/marketplace/{listing_id}/approve")
async def admin_approve(listing_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    l = await db.marketplace_listings.find_one({"id": listing_id})
    if not l:
        raise HTTPException(404, "Annonce introuvable.")
    if l["status"] != "pending_admin_review":
        raise HTTPException(400, "Cette annonce n'est pas en attente.")
    c = await _config(db)
    now = datetime.now(timezone.utc)
    await db.marketplace_listings.update_one(
        {"id": listing_id},
        {"$set": {
            "status": "approved",
            "approved_at": now,
            "expires_at": now + timedelta(days=c["duration_days"]),
            "admin_reviewed_by": user["id"],
        }},
    )
    return _serialize(await db.marketplace_listings.find_one({"id": listing_id}))


@admin.post("/marketplace/{listing_id}/reject")
async def admin_reject(listing_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    r = await db.marketplace_listings.update_one(
        {"id": listing_id, "status": "pending_admin_review"},
        {"$set": {"status": "rejected", "admin_reviewed_by": user["id"]}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Annonce introuvable ou déjà traitée.")
    return {"ok": True}


@admin.delete("/marketplace/{listing_id}")
async def admin_delete(listing_id: str, request: Request):
    db = request.app.state.db
    r = await db.marketplace_listings.delete_one({"id": listing_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Annonce introuvable.")
    return {"ok": True}
