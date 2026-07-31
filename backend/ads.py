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
from feature_flags import is_enabled as feature_enabled


ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
ALLOWED_VIDEO = {".mp4", ".mov", ".webm", ".m4v"}
ALLOWED_AUDIO = {".mp3", ".m4a", ".aac", ".ogg", ".wav"}
ALLOWED_UPLOAD = ALLOWED_IMAGE | ALLOWED_VIDEO | ALLOWED_AUDIO
MAX_UPLOAD_MB = 100
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR") or "/app/backend/uploads")
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


public = APIRouter(prefix="/api", tags=["ads"])
admin = APIRouter(prefix="/api/admin", tags=["ads_admin"], dependencies=[Depends(require_admin)])


# ---------- Models ----------
class AdCreate(BaseModel):
    cover_image_url: str = Field(..., min_length=1)
    video_url: Optional[str] = None
    description: str = Field(..., min_length=1, max_length=2000)
    media_type: str = Field(default="video", pattern="^(video|poster)$")


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
    if not await feature_enabled(db, "ads"):
        raise HTTPException(503, "Fonctionnalité 'Publicité' momentanément désactivée par l'administrateur.")
    sub_key = "ads_create_video" if data.media_type == "video" else "ads_create_poster"
    if not await feature_enabled(db, sub_key):
        label = "vidéo publicitaire" if data.media_type == "video" else "affiche publicitaire"
        raise HTTPException(503, f"Ajout d'une {label} momentanément désactivé par l'administrateur.")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "cover_image_url": data.cover_image_url,
        "video_url": data.video_url,
        "description": data.description,
        "media_type": data.media_type,
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
    if ad.get("media_type", "video") == "video" and not ad.get("video_url"):
        missing.append("video_url")
    if not ad.get("target_countries"): missing.append("target_countries")
    if not ad.get("duration_days"): missing.append("duration_days")
    if missing:
        raise HTTPException(400, f"Champs manquants : {', '.join(missing)}.")

    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {"status": "pending_payment", "updated_at": datetime.now(timezone.utc)}},
    )
    return _serialize(await db.ads.find_one({"id": ad_id}))



class AdPayIn(BaseModel):
    method: Optional[str] = None      # "mobile_money" | "crypto" | None (auto)
    country_code: Optional[str] = None
    operator: Optional[str] = None
    phone: Optional[str] = None


@public.post("/ads/{ad_id}/pay")
async def pay_ad(ad_id: str, data: AdPayIn, request: Request, user=Depends(get_current_user)):
    """Initiate payment for an ad — supports Crypto (USDT.BEP20) via
    IziChangePay OR Mobile Money via Ashtech Pay.
    """
    db = request.app.state.db
    ad = await _get_ad(db, ad_id, user["id"])
    if ad["status"] not in ("pending_payment", "draft"):
        raise HTTPException(400, "Cette publicité n'est pas en attente de paiement.")
    amount_xof = float(ad.get("price_amount") or 0)
    if amount_xof <= 0:
        raise HTTPException(400, "Montant à payer invalide (recalculez la durée).")

    method = (data.method or "crypto").lower()

    # ── Mobile Money via Ashtech Pay ──────────────────────────────────
    if method == "mobile_money":
        if not data.country_code or not data.operator or not data.phone:
            raise HTTPException(400, "country_code, operator et phone sont requis.")
        from ashtec_activation import create_ashtec_payment
        result = await create_ashtec_payment(
            db=db, user=user, kind="ads", amount=amount_xof,
            country_code=data.country_code, operator=data.operator, phone=data.phone,
            extra_row={"ad_id": ad_id},
        )
        await db.ads.update_one(
            {"id": ad_id},
            {"$set": {"status": "pending_payment",
                      "payment_reference": result["reference"],
                      "payment_method": "mobile_money",
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"method": "mobile_money", **result}

    # ── Crypto via IziChangePay ───────────────────────────────────────
    from feature_flags import is_enabled as _flag_on
    izi_ok = await _flag_on(db, "crypto_auto")
    if method != "crypto":
        raise HTTPException(400, "Méthode non supportée.")
    if not izi_ok:
        raise HTTPException(503, "Le paiement Crypto est momentanément désactivé.")

    reference = f"ADS-{ad_id[:8]}-{uuid.uuid4().hex[:8]}"
    await db.ads.update_one(
        {"id": ad_id},
        {"$set": {"status": "pending_payment", "payment_reference": reference,
                  "payment_method": method, "updated_at": datetime.now(timezone.utc)}},
    )

    # Crypto path — mirror the activation-crypto-auto flow but for ads.
    import izichange
    amount_usdt = round(amount_xof / izichange.USDT_XOF_RATE, 6)
    resp = await izichange._api_post("/v1/payment-intents", {
        "requestedCurrencyType": "crypto",
        "currencyRequested": izichange.ASSET_CODE,
        "amountRequested": f"{amount_usdt:g}",
        "acceptedCoins": [izichange.ASSET_CODE],
        "merchantReference": reference,
        "customerEmail": user.get("email"),
        "metadata": {"kind": "ads", "ad_id": ad_id, "user_id": user["id"]},
    }, idempotency_key=reference)
    if resp.status_code >= 400:
        raise HTTPException(400, "La passerelle Crypto a refusé la demande.")
    intent = resp.json()
    intent_id = intent.get("id")
    if not intent_id:
        raise HTTPException(400, "Réponse invalide de la passerelle Crypto.")
    sr = await izichange._public_post(
        f"/v1/public/payment-intents/{intent_id}/select-crypto",
        {"assetCode": izichange.ASSET_CODE,
         "customer": {"firstName": (user.get("first_name") or user.get("username") or "SPILOVEURE")[:32],
                      "lastName": (user.get("last_name") or "USER")[:32],
                      "email": user.get("email") or "user@spiloveure.com"}})
    if sr.status_code >= 400:
        raise HTTPException(400, "La passerelle Crypto n'a pas généré l'adresse.")
    sel = sr.json()
    deposit_address = sel.get("depositAddress")
    if not deposit_address:
        raise HTTPException(400, "Adresse Crypto indisponible.")
    await db.payments.insert_one({
        "reference": reference, "provider": "izichange",
        "provider_intent_id": intent_id,
        "user_id": user["id"], "kind": "ads",
        "ad_id": ad_id, "amount": amount_xof,
        "currency": ad.get("currency") or "XOF",
        "usdt_amount": amount_usdt,
        "usdt_rate": izichange.USDT_XOF_RATE,
        "deposit_address": deposit_address,
        "amount_to_send": sel.get("amountToSend") or amount_usdt,
        "network": "BEP20",
        "status": "pending", "activation_done": False,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })
    return {"method": "crypto", "reference": reference,
            "deposit_address": deposit_address,
            "amount_to_send": sel.get("amountToSend") or amount_usdt,
            "coin": "USDT", "network": "BEP20",
            "xof_amount": amount_xof, "usdt_amount": amount_usdt,
            "usdt_rate": izichange.USDT_XOF_RATE}




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


@public.get("/ads/{ad_id}")
async def get_ad_by_id(ad_id: str, request: Request, user=Depends(get_current_user)):
    """Fetch a single ad. Owners can see any of their ads; others only
    published & non-expired ones. Used by the payment page to poll status."""
    db = request.app.state.db
    a = await db.ads.find_one({"id": ad_id})
    if not a:
        raise HTTPException(404, "Publicité introuvable.")
    if a.get("user_id") != user["id"]:
        # Non-owner: only expose the ad if it's live.
        now = datetime.now(timezone.utc)
        if a.get("status") != "published" or (a.get("expires_at") and a["expires_at"] < now):
            raise HTTPException(404, "Publicité introuvable.")
    return _serialize(a)




@public.get("/ads")
async def public_feed(request: Request, user=Depends(get_current_user)):
    """Public ad feed — only approved + not expired. Returns empty if the ads
    module has been globally disabled by the admin (feature flag)."""
    db = request.app.state.db
    if not await feature_enabled(db, "ads"):
        return {"items": []}
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
    """Increment view counter — idempotent per user via unique `viewers`
    array. Views are NO LONGER rewarded (2026-08 refonte: only Like +
    Comment are rewarded)."""
    db = request.app.state.db
    r = await db.ads.update_one(
        {"id": ad_id, "status": "published", "viewers": {"$ne": user["id"]}},
        {"$addToSet": {"viewers": user["id"]}, "$inc": {"views_count": 1}},
    )
    return {"ok": True, "counted": r.modified_count > 0, "reward": None}


@public.post("/ads/{ad_id}/like")
async def toggle_like(ad_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    ad = await db.ads.find_one({"id": ad_id, "status": "published"})
    if not ad:
        raise HTTPException(404, "Publicité introuvable ou non publiée.")
    if user["id"] in (ad.get("likes") or []):
        # Unlike — do NOT reverse the reward (idempotency table already
        # blocks a second credit, so removing the like doesn't re-open it).
        await db.ads.update_one({"id": ad_id}, {"$pull": {"likes": user["id"]}})
        return {"liked": False, "likes_count": len((ad.get("likes") or [])) - 1, "reward": None}
    await db.ads.update_one({"id": ad_id}, {"$addToSet": {"likes": user["id"]}})
    reward = await _credit_reactor(db, ad, user["id"], user.get("username"), "like")
    return {"liked": True, "likes_count": len((ad.get("likes") or [])) + 1, "reward": reward}


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
    reward = await _credit_reactor(db, ad, user["id"], user.get("username"), "comment")
    comment["at"] = comment["at"].isoformat()
    return {"comment": comment, "reward": reward}


@public.post("/ads/{ad_id}/share")
async def share_ad(ad_id: str, request: Request, user=Depends(get_current_user)):
    """Increment share counter. Shares are NO LONGER rewarded (2026-08
    refonte: only Like + Comment are rewarded)."""
    db = request.app.state.db
    r = await db.ads.update_one(
        {"id": ad_id, "status": "published"},
        {"$inc": {"shares_count": 1}},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Publicité introuvable ou non publiée.")
    return {"ok": True, "reward": None}


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


# ─── Reactor pool config (refonte 2026-08) ─────────────────────────────
#
# New model — Only LIKE and COMMENT are rewarded. Admin configures:
#   - distribution_percentage   : % of ad price for users (rest = platform)
#   - like_reward, comment_reward : fixed FCFA per action
#   - max_likes, max_comments   : hard caps per campaign
#
# One reward per (user, action, campaign). No self-reward. Payments are
# credited atomically as long as the campaign has slots remaining AND the
# global reactor pool (distribution_percentage × price) is not exhausted.
class AdReactorConfig(BaseModel):
    # New canonical fields
    distribution_percentage: Optional[float] = Field(default=None, ge=0, le=100)
    platform_percentage: Optional[float] = Field(default=None, ge=0, le=100)
    like_reward: Optional[float] = Field(default=None, ge=0)
    comment_reward: Optional[float] = Field(default=None, ge=0)
    max_likes: Optional[int] = Field(default=None, ge=1)
    max_comments: Optional[int] = Field(default=None, ge=1)
    # Legacy fields (kept so older admin panels & tests keep working)
    share_percentage: Optional[float] = Field(default=None, ge=0, le=100)
    min_reward: Optional[float] = Field(default=None, ge=0)
    max_reward: Optional[float] = Field(default=None, ge=0)


async def _get_reactor_config(db) -> dict:
    doc = await db.ads_reactor_config.find_one({"key": "singleton"}) or {}
    # Prefer new field names, fall back to legacy ones for continuity.
    dist = float(doc.get("distribution_percentage",
                          doc.get("share_percentage", 70.0)))
    return {
        # New canonical fields
        "distribution_percentage": dist,
        "platform_percentage": round(100.0 - dist, 2),
        "like_reward": float(doc.get("like_reward", 25.0)),
        "comment_reward": float(doc.get("comment_reward", 50.0)),
        "max_likes": int(doc.get("max_likes", 100)),
        "max_comments": int(doc.get("max_comments", 50)),
        # Legacy fields (kept for any old client still reading them)
        "share_percentage": dist,
        "min_reward": float(doc.get("min_reward", 25.0)),
        "max_reward": float(doc.get("max_reward", 500.0)),
        "currency": "FCFA",
    }


# Rewarded action set is now strictly {like, comment}.
REWARDED_ACTIONS: set[str] = {"like", "comment"}


async def _initialise_reactor_pool(db, ad: dict) -> float:
    """Compute and persist the reactor pool for an ad. Idempotent —
    the pool is set exactly once per ad (on the first reactor action).
    Returns the pool amount in FCFA (= distribution_percentage × price).
    """
    if ad.get("reactor_pool") is not None:
        return float(ad["reactor_pool"])
    cfg = await _get_reactor_config(db)
    pool = round(float(ad.get("price_amount") or 0) * (cfg["distribution_percentage"] / 100.0), 2)
    await db.ads.update_one(
        {"id": ad["id"], "reactor_pool": {"$exists": False}},
        {"$set": {"reactor_pool": pool,
                  "reactor_pool_remaining": pool,
                  # Snapshot per-campaign caps for immutability once the
                  # pool starts filling.
                  "reactor_max_likes": cfg["max_likes"],
                  "reactor_max_comments": cfg["max_comments"],
                  "reactor_likes_awarded": 0,
                  "reactor_comments_awarded": 0,
                  "reactor_pool_initialised_at": datetime.now(timezone.utc)}},
    )
    fresh = await db.ads.find_one({"id": ad["id"]}, {"reactor_pool": 1, "_id": 0}) or {}
    return float(fresh.get("reactor_pool") or pool)


async def _credit_reactor(db, ad: dict, user_id: str, username: str,
                          action: str) -> Optional[float]:
    """Idempotently credit a reactor's balance_profit for a given (ad, user,
    action). Returns the amount credited, or None if:
    • action is not in the rewarded set {like, comment}
    • same user already rewarded for this action on this ad
    • per-campaign cap reached for that action
    • pool is exhausted
    • user is the ad's creator (no self-reward)
    • anti-fraud rate-limit tripped (>= 50 rewards / user / rolling hour)
    """
    if not ad or ad.get("status") != "published":
        return None
    if user_id == ad.get("user_id"):
        return None
    action = action.lower()
    if action not in REWARDED_ACTIONS:
        return None

    # 1) Idempotency guard: refuse if this (ad, user, action) is already paid.
    existing = await db.ads_reactor_rewards.find_one(
        {"ad_id": ad["id"], "user_id": user_id, "action": action},
        {"_id": 1},
    )
    if existing:
        return None

    # 2) Anti-fraud: cap credited rewards to 50 per rolling hour per user.
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    recent = await db.ads_reactor_rewards.count_documents(
        {"user_id": user_id, "created_at": {"$gte": one_hour_ago}}
    )
    if recent >= 50:
        return None

    cfg = await _get_reactor_config(db)
    pool = await _initialise_reactor_pool(db, ad)
    if pool <= 0:
        return None

    reward = float(cfg["like_reward"] if action == "like" else cfg["comment_reward"])
    if reward <= 0:
        return None

    cap_field = "reactor_likes_awarded" if action == "like" else "reactor_comments_awarded"
    max_field = "reactor_max_likes" if action == "like" else "reactor_max_comments"

    # 3) Read current cap snapshot (defaults on legacy ads without snapshot).
    ad_state = await db.ads.find_one(
        {"id": ad["id"]},
        {"reactor_pool_remaining": 1, cap_field: 1, max_field: 1, "_id": 0},
    ) or {}
    awarded = int(ad_state.get(cap_field) or 0)
    max_allowed = int(ad_state.get(max_field) or (cfg["max_likes"] if action == "like" else cfg["max_comments"]))
    if awarded >= max_allowed:
        return None  # per-campaign cap reached

    remaining = float(ad_state.get("reactor_pool_remaining") or 0)
    if remaining <= 0:
        return None
    reward = min(reward, remaining)

    # 4) Atomically decrement pool + increment cap counter (guards against
    #    both pool exhaustion and cap overshoot under concurrency).
    r = await db.ads.update_one(
        {
            "id": ad["id"],
            "reactor_pool_remaining": {"$gte": reward},
            f"{cap_field}": {"$lt": max_allowed},
        },
        {
            "$inc": {"reactor_pool_remaining": -reward, cap_field: 1},
        },
    )
    if r.modified_count == 0:
        return None  # someone else won the slot

    now = datetime.now(timezone.utc)
    await db.users.update_one({"id": user_id}, {"$inc": {"balance_profit": reward}})
    await db.ads_reactor_rewards.insert_one({
        "id": str(uuid.uuid4()),
        "ad_id": ad["id"],
        "user_id": user_id, "username": username,
        "action": action,
        "amount": reward,
        "currency": "FCFA",
        "created_at": now,
    })
    try:
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "kind": "reactor_reward",
            "title": f"+{reward:g} FCFA gagnés 🎯",
            "body": f"Vous avez été récompensé pour votre {action} sur une publicité.",
            "meta": {"ad_id": ad["id"], "action": action, "amount": reward},
            "read": False,
            "created_at": now,
        })
    except Exception:
        pass
    return reward


@public.get("/ads/{ad_id}/reactor-status")
async def reactor_status(ad_id: str, request: Request, user=Depends(get_current_user)):
    """Read-only helper for the reactor UI — returns the current pool state
    and, if provided, how much the calling user has already earned on this ad.
    """
    db = request.app.state.db
    ad = await db.ads.find_one({"id": ad_id}, {"_id": 0, "reactor_pool": 1,
                                                "reactor_pool_remaining": 1,
                                                "user_id": 1, "status": 1,
                                                "price_amount": 1})
    if not ad:
        raise HTTPException(404, "Publicité introuvable.")
    earned_agg = await db.ads_reactor_rewards.aggregate([
        {"$match": {"ad_id": ad_id, "user_id": user["id"]}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    earned = float(earned_agg[0]["total"]) if earned_agg else 0.0
    return {
        "pool": float(ad.get("reactor_pool") or 0),
        "remaining": float(ad.get("reactor_pool_remaining") or 0),
        "you_earned": earned,
        "is_creator": ad.get("user_id") == user["id"],
    }


@public.get("/me/reactor-rewards")
async def my_reactor_rewards(request: Request, user=Depends(get_current_user),
                             limit: int = 100):
    """Return the calling user's reactor reward history (used by the
    "Mes récompenses réacteur" tab)."""
    db = request.app.state.db
    items = []
    async for r in db.ads_reactor_rewards.find(
        {"user_id": user["id"]}, {"_id": 0}
    ).sort("created_at", -1).limit(min(limit, 500)):
        r["created_at"] = r["created_at"].astimezone(timezone.utc).isoformat() \
            if isinstance(r.get("created_at"), datetime) else r.get("created_at")
        items.append(r)
    total_agg = await db.ads_reactor_rewards.aggregate([
        {"$match": {"user_id": user["id"]}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    return {
        "items": items,
        "total_earned": float(total_agg[0]["total"]) if total_agg else 0.0,
    }


@public.get("/ads/{ad_id}/reactor-feed")
async def reactor_feed(ad_id: str, request: Request, user=Depends(get_current_user),
                       limit: int = 20):
    """Public live feed for a specific ad — anonymised (only shows the
    first 3 letters of the username) so we can display social proof
    without leaking exact identities. Used as a bottom mini-feed on the
    ad view screen: "sof••• vient de gagner 42 FCFA · like · il y a 2 min".
    """
    db = request.app.state.db
    items = []
    async for r in db.ads_reactor_rewards.find(
        {"ad_id": ad_id}, {"_id": 0, "user_id": 0}
    ).sort("created_at", -1).limit(min(limit, 100)):
        uname = r.get("username") or "anon"
        r["username"] = uname[:3] + "•••" if len(uname) > 3 else uname + "•••"
        r["created_at"] = r["created_at"].astimezone(timezone.utc).isoformat() \
            if isinstance(r.get("created_at"), datetime) else r.get("created_at")
        items.append(r)
    return {"items": items}


@public.get("/ads-reactor-config")
async def public_get_reactor_config(request: Request):
    """Public read — creators / reactors can see the split rules."""
    return await _get_reactor_config(request.app.state.db)


@admin.get("/ads-reactor-config")
async def admin_get_reactor_config(request: Request):
    return await _get_reactor_config(request.app.state.db)


@admin.put("/ads-reactor-config")
async def admin_set_reactor_config(data: AdReactorConfig, request: Request):
    db = request.app.state.db
    # Preserve existing values for any field the admin didn't send.
    current = await _get_reactor_config(db)
    # Legacy compat: `share_percentage` → `distribution_percentage`;
    # `min_reward`/`max_reward` → `like_reward`/`comment_reward` (fallback).
    dist = data.distribution_percentage
    if dist is None and data.share_percentage is not None:
        dist = data.share_percentage
    if dist is None:
        dist = current["distribution_percentage"]

    like_r = data.like_reward
    if like_r is None and data.min_reward is not None:
        like_r = data.min_reward
    if like_r is None:
        like_r = current["like_reward"]

    comment_r = data.comment_reward
    if comment_r is None and data.max_reward is not None:
        comment_r = data.max_reward
    if comment_r is None:
        comment_r = current["comment_reward"]

    max_likes = data.max_likes if data.max_likes is not None else current["max_likes"]
    max_comments = data.max_comments if data.max_comments is not None else current["max_comments"]

    # Legacy validation kept: min_reward > max_reward should still be rejected.
    if data.min_reward is not None and data.max_reward is not None \
            and data.max_reward < data.min_reward:
        raise HTTPException(400, "max_reward doit être ≥ min_reward.")

    await db.ads_reactor_config.update_one(
        {"key": "singleton"},
        {"$set": {
            "key": "singleton",
            "distribution_percentage": float(dist),
            "like_reward": float(like_r),
            "comment_reward": float(comment_r),
            "max_likes": int(max_likes),
            "max_comments": int(max_comments),
            # Preserve legacy fields so old readers keep working.
            "share_percentage": float(dist),
            "min_reward": float(like_r),
            "max_reward": float(comment_r),
            "updated_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    return await _get_reactor_config(db)


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
