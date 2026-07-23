"""Ads module — user-published video advertisements campaign.

Flow (2026-07-24):
    1. User creates draft ad (upload cover + video via /api/uploads/upload).
    2. User sets targeting (countries, age, gender) & picks a duration.
    3. Backend computes price from admin-configured pricing, sets ad status=`pending_payment`.
    4. Payment (SoleasPay/AshtechPay) — reuses existing gateway; on success,
       ad status flips to `pending_admin_review`.
    5. Admin approves → status=`published`, `expires_at = published_at + duration_days`.
    6. Public feed lists only ads with status=`published` and non-expired.
    7. Users can view / like / comment / share each ad.

Pricing is fully managed via `db.ads_pricing` (single doc). No hardcoded values.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin
from object_storage import is_enabled as _obj_enabled, put_upload as _obj_put


ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
ALLOWED_VIDEO = {".mp4", ".mov", ".webm", ".m4v"}
ALLOWED_UPLOAD = ALLOWED_IMAGE | ALLOWED_VIDEO
MAX_UPLOAD_MB = 100
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR") or "/app/backend/uploads")
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


public = APIRouter(prefix="/api", tags=["ads"])
admin = APIRouter(prefix="/api/admin", tags=["ads_admin"], dependencies=[Depends(require_admin)])


# ---------- Models ----------
class AdCreate(BaseModel):
    cover_image_url: str = Field(..., min_length=1)
    video_url: str = Field(..., min_length=1)
    description: str = Field(..., min_length=1, max_length=2000)


class AdAudience(BaseModel):
    target_countries: List[str] = Field(..., min_length=1)
    target_age_min: int = Field(..., ge=13, le=99)
    target_age_max: int = Field(..., ge=13, le=99)
    target_gender: str = Field(..., pattern="^(male|female|both)$")


class AdDuration(BaseModel):
    duration_days: int = Field(..., ge=1, le=365)


class AdPricingUpdate(BaseModel):
    price_per_day: float = Field(..., ge=0)
    currency: str = Field(default="FCFA", max_length=8)
    available_durations: List[int] = Field(..., min_length=1)


class AdComment(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)


class AdRejectReason(BaseModel):
    reason: str = Field(default="", max_length=500)


# ---------- Helpers ----------
def _serialize(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    for k in ("created_at", "updated_at", "published_at", "expires_at",
              "admin_reviewed_at", "payment_confirmed_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.astimezone(timezone.utc).isoformat()
    for c in out.get("comments") or []:
        if isinstance(c.get("at"), datetime):
            c["at"] = c["at"].astimezone(timezone.utc).isoformat()
    return out


async def _get_pricing(db) -> dict:
    doc = await db.ads_pricing.find_one({"key": "singleton"}) or {}
    return {
        "price_per_day": float(doc.get("price_per_day") or 0),
        "currency": doc.get("currency") or "FCFA",
        "available_durations": doc.get("available_durations") or [],
        "configured": bool(doc.get("price_per_day")) and bool(doc.get("available_durations")),
    }


async def _get_ad(db, ad_id: str, user_id: Optional[str] = None) -> dict:
    q: dict = {"id": ad_id}
    if user_id:
        q["user_id"] = user_id
    ad = await db.ads.find_one(q)
    if not ad:
        raise HTTPException(404, "Publicité introuvable.")
    return ad


# ---------- USER endpoints ----------
@public.post("/user/uploads")
async def user_upload_file(
    request: Request,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """User-facing upload endpoint restricted to images and videos.
    Persists into Emergent Object Storage (with local fallback for preview).
    Returns `{"url": "/api/uploads/<name>", "filename", "size", "content_type"}`.
    """
    raw_name = file.filename or "upload"
    ext = os.path.splitext(raw_name.lower())[1]
    if ext not in ALLOWED_UPLOAD:
        raise HTTPException(415, f"Format non autorisé. Autorisés : {sorted(ALLOWED_UPLOAD)}")

    out_name = f"{uuid.uuid4().hex}{ext}"
    total = 0
    buf = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"Fichier trop volumineux (max {MAX_UPLOAD_MB} MB)")
        buf.extend(chunk)

    content_type = file.content_type or "application/octet-stream"
    # Dual write: local (dev preview) + object storage (prod persistence).
    (UPLOADS_DIR / out_name).write_bytes(bytes(buf))
    if _obj_enabled():
        try:
            _obj_put(out_name, bytes(buf), content_type)
        except Exception:
            pass
    return {
        "url": f"/api/uploads/{out_name}",
        "filename": out_name,
        "size": total,
        "content_type": content_type,
    }


@public.get("/ads/pricing")
async def ads_pricing_public(request: Request, user=Depends(get_current_user)):
    """Return the current pricing so the wizard can show costs."""
    return await _get_pricing(request.app.state.db)


@public.post("/ads")
async def create_draft(data: AdCreate, request: Request, user=Depends(get_current_user)):
    """Step 1 → save the draft with cover + video + description. Status=draft."""
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "cover_image_url": data.cover_image_url,
        "video_url": data.video_url,
        "description": data.description,
        # Targeting fields — filled at step 2.
        "target_countries": [],
        "target_age_min": None,
        "target_age_max": None,
        "target_gender": None,
        # Duration & pricing — filled at step 3.
        "duration_days": None,
        "price_amount": 0.0,
        "currency": "FCFA",
        "status": "draft",
        # Interactions (published state).
        "views_count": 0,
        "shares_count": 0,
        "likes": [],
        "comments": [],
        "created_at": now,
        "updated_at": now,
    }
    await db.ads.insert_one(doc)
    return _serialize(doc)


@public.put("/ads/{ad_id}/audience")
async def set_audience(ad_id: str, data: AdAudience, request: Request, user=Depends(get_current_user)):
    """Step 2 → attach targeting."""
    if data.target_age_max < data.target_age_min:
        raise HTTPException(400, "L'âge maximum doit être supérieur au minimum.")
    db = request.app.state.db
    ad = await _get_ad(db, ad_id, user["id"])
    if ad["status"] not in ("draft",):
        raise HTTPException(400, "Cette publicité n'est plus modifiable.")
    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {
            "target_countries": [c.upper() for c in data.target_countries],
            "target_age_min": data.target_age_min,
            "target_age_max": data.target_age_max,
            "target_gender": data.target_gender,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    return _serialize(await db.ads.find_one({"id": ad_id}))


@public.put("/ads/{ad_id}/duration")
async def set_duration(ad_id: str, data: AdDuration, request: Request, user=Depends(get_current_user)):
    """Step 3 → pick a duration from admin-configured list; server computes price."""
    db = request.app.state.db
    ad = await _get_ad(db, ad_id, user["id"])
    if ad["status"] not in ("draft",):
        raise HTTPException(400, "Cette publicité n'est plus modifiable.")

    pricing = await _get_pricing(db)
    if not pricing["configured"]:
        raise HTTPException(503, "La tarification des publicités n'est pas encore configurée par l'administrateur.")
    if data.duration_days not in pricing["available_durations"]:
        raise HTTPException(400, f"Durée invalide. Durées disponibles : {pricing['available_durations']}.")

    price = float(pricing["price_per_day"]) * int(data.duration_days)
    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {
            "duration_days": data.duration_days,
            "price_amount": price,
            "currency": pricing["currency"],
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    return _serialize(await db.ads.find_one({"id": ad_id}))


@public.post("/ads/{ad_id}/publish")
async def publish_ad(ad_id: str, request: Request, user=Depends(get_current_user)):
    """Step 4 → move ad to `pending_payment` and return the amount to be paid.
    The actual payment happens through the existing SoleasPay/AshtechPay flow —
    the frontend redirects to the payment page carrying `ad_id` in metadata.
    """
    db = request.app.state.db
    ad = await _get_ad(db, ad_id, user["id"])
    if ad["status"] != "draft":
        raise HTTPException(400, "Publicité déjà soumise.")
    missing = []
    if not ad.get("cover_image_url"): missing.append("cover_image_url")
    if not ad.get("video_url"): missing.append("video_url")
    if not ad.get("target_countries"): missing.append("target_countries")
    if not ad.get("duration_days"): missing.append("duration_days")
    if missing:
        raise HTTPException(400, f"Champs manquants : {', '.join(missing)}.")

    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {"status": "pending_payment", "updated_at": datetime.now(timezone.utc)}},
    )
    return _serialize(await db.ads.find_one({"id": ad_id}))


@public.post("/ads/{ad_id}/confirm-payment")
async def confirm_payment_manual(ad_id: str, request: Request, user=Depends(get_current_user)):
    """Simulated payment confirmation — flips ad to `pending_admin_review`.

    In production, this should be called by the payment gateway webhook after
    the amount has been credited. For now, it accepts a manual mark from the
    frontend after the checkout redirect returns "success". Idempotent.
    """
    db = request.app.state.db
    ad = await _get_ad(db, ad_id, user["id"])
    if ad["status"] not in ("pending_payment", "pending_admin_review"):
        raise HTTPException(400, "Statut inattendu pour confirmation de paiement.")
    if ad["status"] == "pending_payment":
        await db.ads.update_one(
            {"id": ad_id, "status": "pending_payment"},
            {"$set": {
                "status": "pending_admin_review",
                "payment_confirmed_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }},
        )
    return _serialize(await db.ads.find_one({"id": ad_id}))


@public.get("/ads/mine")
async def my_ads(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = []
    async for a in db.ads.find({"user_id": user["id"]}).sort("created_at", -1):
        items.append(_serialize(a))
    return {"items": items}


@public.get("/ads")
async def public_feed(request: Request, user=Depends(get_current_user)):
    """Public ad feed — only approved + not expired."""
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    items = []
    async for a in db.ads.find({
        "status": "published",
        "$or": [{"expires_at": None}, {"expires_at": {"$gt": now}}],
    }).sort("published_at", -1):
        items.append(_serialize(a))
    return {"items": items}


@public.post("/ads/{ad_id}/view")
async def register_view(ad_id: str, request: Request, user=Depends(get_current_user)):
    """Increment view counter — idempotent per user via unique `viewers` array."""
    db = request.app.state.db
    r = await db.ads.update_one(
        {"id": ad_id, "status": "published", "viewers": {"$ne": user["id"]}},
        {"$addToSet": {"viewers": user["id"]}, "$inc": {"views_count": 1}},
    )
    return {"ok": True, "counted": r.modified_count > 0}


@public.post("/ads/{ad_id}/like")
async def toggle_like(ad_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    ad = await db.ads.find_one({"id": ad_id, "status": "published"})
    if not ad:
        raise HTTPException(404, "Publicité introuvable ou non publiée.")
    if user["id"] in (ad.get("likes") or []):
        await db.ads.update_one({"id": ad_id}, {"$pull": {"likes": user["id"]}})
        return {"liked": False, "likes_count": len((ad.get("likes") or [])) - 1}
    await db.ads.update_one({"id": ad_id}, {"$addToSet": {"likes": user["id"]}})
    return {"liked": True, "likes_count": len((ad.get("likes") or [])) + 1}


@public.post("/ads/{ad_id}/comment")
async def add_comment(ad_id: str, data: AdComment, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    ad = await db.ads.find_one({"id": ad_id, "status": "published"})
    if not ad:
        raise HTTPException(404, "Publicité introuvable ou non publiée.")
    comment = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "text": data.text,
        "at": datetime.now(timezone.utc),
    }
    await db.ads.update_one({"id": ad_id}, {"$push": {"comments": comment}})
    comment["at"] = comment["at"].isoformat()
    return {"comment": comment}


@public.post("/ads/{ad_id}/share")
async def share_ad(ad_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    r = await db.ads.update_one(
        {"id": ad_id, "status": "published"},
        {"$inc": {"shares_count": 1}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Publicité introuvable ou non publiée.")
    return {"ok": True}


# ---------- ADMIN endpoints ----------
@admin.get("/ads/pricing")
async def admin_get_pricing(request: Request):
    return await _get_pricing(request.app.state.db)


@admin.put("/ads/pricing")
async def admin_set_pricing(data: AdPricingUpdate, request: Request):
    db = request.app.state.db
    await db.ads_pricing.update_one(
        {"key": "singleton"},
        {"$set": {
            "key": "singleton",
            "price_per_day": data.price_per_day,
            "currency": data.currency,
            "available_durations": sorted(set(int(d) for d in data.available_durations)),
            "updated_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    return await _get_pricing(db)


@admin.get("/ads")
async def admin_list_ads(request: Request, status: Optional[str] = None):
    db = request.app.state.db
    q: dict = {}
    if status:
        q["status"] = status
    items = []
    async for a in db.ads.find(q).sort("created_at", -1).limit(500):
        items.append(_serialize(a))
    return {"items": items}


@admin.post("/ads/{ad_id}/approve")
async def admin_approve(ad_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    ad = await db.ads.find_one({"id": ad_id})
    if not ad:
        raise HTTPException(404, "Publicité introuvable.")
    if ad["status"] != "pending_admin_review":
        raise HTTPException(400, "Cette publicité n'est pas en attente de validation.")
    now = datetime.now(timezone.utc)
    duration = int(ad.get("duration_days") or 0)
    expires_at = now + timedelta(days=duration) if duration else None
    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {
            "status": "published",
            "published_at": now,
            "expires_at": expires_at,
            "admin_reviewed_at": now,
            "admin_reviewed_by": user["id"],
            "updated_at": now,
        }},
    )
    return _serialize(await db.ads.find_one({"id": ad_id}))


@admin.post("/ads/{ad_id}/reject")
async def admin_reject(ad_id: str, data: AdRejectReason, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    ad = await db.ads.find_one({"id": ad_id})
    if not ad:
        raise HTTPException(404, "Publicité introuvable.")
    if ad["status"] != "pending_admin_review":
        raise HTTPException(400, "Cette publicité n'est pas en attente de validation.")
    now = datetime.now(timezone.utc)
    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {
            "status": "rejected",
            "reject_reason": data.reason,
            "admin_reviewed_at": now,
            "admin_reviewed_by": user["id"],
            "updated_at": now,
        }},
    )
    return _serialize(await db.ads.find_one({"id": ad_id}))
