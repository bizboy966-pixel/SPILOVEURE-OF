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

from auth import get_current_user, require_active_user, require_admin
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
async def create_listing(data: ListingCreate, request: Request, user=Depends(require_active_user)):
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


# ---------- "Nouveauté" badge + WhatsApp-style ring (v27ao) ----------
# NOTE: these static routes MUST come before `/marketplace/{listing_id}` so
# that FastAPI doesn't interpret "unread-count" / "mark-seen" / "unread-ring"
# as a listing id.
#
# v27ao (2026-03-04) — per-listing seen tracking (WhatsApp status style).
# Each (user_id, listing_id) pair that the user has consulted is stored in
# `marketplace_views` with `seen_at`. A listing counts as "unread" for a
# user when :
#   • It is `status=approved` AND
#   • `seller_id != user.id` AND
#   • No `marketplace_views` row exists for (user, listing)
# The classic `/unread-count` + `/mark-seen` endpoints are kept for backward
# compat (bottom-nav badge). The new ring UI uses `/unread-ring` which
# returns the segmented list of recent items.

# How many recent items to materialise in the ring (max). More than this
# collapses to a compact "9+" indicator on the frontend.
_RING_MAX = 9
# How many additional "already-seen" items we include so the ring also
# shows the WhatsApp-style gray tail (consumed items). Keep this small
# so the ring never looks cluttered.
_RING_SEEN_TAIL = 0  # we show ONLY unread + the current view transitions


@public.get("/marketplace/unread-count")
async def marketplace_unread_count(request: Request, user=Depends(get_current_user)):
    """Return how many approved listings the user hasn't individually
    consulted yet (v27ao — per-item tracking, not just a timestamp).

    Owned listings are excluded. Expired items are excluded.
    """
    db = request.app.state.db
    if not await feature_enabled(db, "marketplace"):
        return {"unread": 0}
    # Collect all approved listings not owned by caller.
    cursor = db.marketplace_listings.find(
        {"status": "approved", "seller_id": {"$ne": user["id"]}},
        {"id": 1},
    )
    ids = [doc["id"] async for doc in cursor]
    if not ids:
        return {"unread": 0}
    # Collect the listings this user has already consulted individually.
    seen_cur = db.marketplace_views.find(
        {"user_id": user["id"], "listing_id": {"$in": ids}},
        {"listing_id": 1},
    )
    seen_set = {d["listing_id"] async for d in seen_cur}
    unread = sum(1 for i in ids if i not in seen_set)
    return {"unread": int(unread)}


@public.get("/marketplace/unread-ring")
async def marketplace_unread_ring(request: Request, user=Depends(get_current_user)):
    """v27ao — per-item seen status for the WhatsApp-style ring on the
    dashboard Marketplace card.

    Response :
        unread_count : total number of unread approved listings
        segments     : up to `_RING_MAX` recent items, each
                       {"id": str, "seen": bool, "approved_at": iso}
                       ordered by `approved_at` desc. The frontend uses
                       these to render the segmented ring.
        has_more     : true when `unread_count > _RING_MAX` → frontend
                       shows the compact "9+" ring variant.
    """
    db = request.app.state.db
    if not await feature_enabled(db, "marketplace"):
        return {"unread_count": 0, "segments": [], "has_more": False}
    # Fetch the latest approved listings not owned by caller.
    recent_cur = db.marketplace_listings.find(
        {"status": "approved", "seller_id": {"$ne": user["id"]}},
        {"id": 1, "approved_at": 1},
    ).sort("approved_at", -1).limit(_RING_MAX + 1)
    recent = [d async for d in recent_cur]
    if not recent:
        return {"unread_count": 0, "segments": [], "has_more": False}
    # Fetch which of these the user has already consulted.
    rec_ids = [d["id"] for d in recent]
    seen_cur = db.marketplace_views.find(
        {"user_id": user["id"], "listing_id": {"$in": rec_ids}},
        {"listing_id": 1},
    )
    seen_set = {d["listing_id"] async for d in seen_cur}

    # Also compute global unread count across all approved listings.
    all_ids_cur = db.marketplace_listings.find(
        {"status": "approved", "seller_id": {"$ne": user["id"]}}, {"id": 1},
    )
    all_ids = [d["id"] async for d in all_ids_cur]
    all_seen_cur = db.marketplace_views.find(
        {"user_id": user["id"], "listing_id": {"$in": all_ids}}, {"listing_id": 1},
    )
    all_seen = {d["listing_id"] async for d in all_seen_cur}
    unread_total = sum(1 for i in all_ids if i not in all_seen)

    has_more = unread_total > _RING_MAX
    segments = []
    for d in recent[:_RING_MAX]:
        ts = d.get("approved_at")
        segments.append({
            "id": d["id"],
            "seen": d["id"] in seen_set,
            "approved_at": ts.astimezone(timezone.utc).isoformat() if isinstance(ts, datetime) else None,
        })
    return {
        "unread_count": int(unread_total),
        "segments": segments,
        "has_more": bool(has_more),
    }


@public.post("/marketplace/mark-seen")
async def marketplace_mark_seen(request: Request, user=Depends(get_current_user)):
    """v27ao — kept for backward compat with the bottom-nav badge.

    Marks EVERY currently-approved listing as individually seen by the
    caller (idempotent upsert). After this call `/unread-count` and
    `/unread-ring` both return 0.
    """
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    # Keep the legacy timestamp for anyone still reading it.
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_marketplace_seen_at": now}},
    )
    # Upsert a view row for every approved listing not owned by the user.
    cur = db.marketplace_listings.find(
        {"status": "approved", "seller_id": {"$ne": user["id"]}}, {"id": 1},
    )
    async for doc in cur:
        await db.marketplace_views.update_one(
            {"user_id": user["id"], "listing_id": doc["id"]},
            {"$setOnInsert": {"user_id": user["id"], "listing_id": doc["id"], "seen_at": now}},
            upsert=True,
        )
    return {"ok": True, "at": now.isoformat()}


@public.post("/marketplace/{listing_id}/mark-seen")
async def marketplace_mark_listing_seen(
    listing_id: str, request: Request, user=Depends(get_current_user),
):
    """v27ao — mark ONE specific listing as consulted by this user.

    Fires when the user actually views the listing (card impression in the
    feed, open-detail, etc.). Idempotent — repeated calls update nothing.
    Returns the refreshed unread count so the UI can decrement its badge
    in a single round-trip.
    """
    db = request.app.state.db
    l = await db.marketplace_listings.find_one({"id": listing_id}, {"id": 1, "seller_id": 1})
    if not l:
        raise HTTPException(404, "Annonce introuvable.")
    # Owner viewing their own listing : no-op (not counted anyway).
    if l.get("seller_id") == user["id"]:
        return {"ok": True, "unread": 0, "owned": True}
    now = datetime.now(timezone.utc)
    await db.marketplace_views.update_one(
        {"user_id": user["id"], "listing_id": listing_id},
        {"$setOnInsert": {"user_id": user["id"], "listing_id": listing_id, "seen_at": now}},
        upsert=True,
    )
    # Recompute unread count (cheap — a few hundred listings max).
    cursor = db.marketplace_listings.find(
        {"status": "approved", "seller_id": {"$ne": user["id"]}}, {"id": 1},
    )
    ids = [d["id"] async for d in cursor]
    seen_cur = db.marketplace_views.find(
        {"user_id": user["id"], "listing_id": {"$in": ids}}, {"listing_id": 1},
    )
    seen_set = {d["listing_id"] async for d in seen_cur}
    unread = sum(1 for i in ids if i not in seen_set)
    return {"ok": True, "unread": int(unread), "listing_id": listing_id}


@public.get("/marketplace/mine")
async def my_listings(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = []
    async for l in db.marketplace_listings.find({"seller_id": user["id"]}).sort("created_at", -1):
        items.append(_serialize(l))
    return {"items": items}


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
    # 🔔 Push notification for every user who opted-in (activated or not —
    # spec 2026-02 point 4). Skip the listing owner.
    try:
        from push_helper import push_to_all_registered
        listing = await db.marketplace_listings.find_one({"id": listing_id})
        title_preview = (listing or {}).get("title") or (listing or {}).get("name") or ""
        title_preview = title_preview[:60].strip() or "Nouvel article"
        await push_to_all_registered(
            db,
            title="🛍️ Nouveau produit disponible !",
            body=f"{title_preview} — Découvrez-le sur le Marketplace.",
            link=f"/(app)/marketplace?listing_id={listing_id}",
            data={"kind": "marketplace_approved", "listing_id": listing_id},
            tag=f"mk-approved-{listing_id}",
            exclude_user_id=(listing or {}).get("user_id"),
        )
    except Exception:
        pass
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
