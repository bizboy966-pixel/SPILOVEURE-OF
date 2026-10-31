"""SPILIVERE FastAPI backend - main entrypoint."""
from __future__ import annotations
import asyncio
import os
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List

from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, status, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# Upload directory — created on first import
UPLOADS_DIR = ROOT_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Whitelisted file extensions per type (lowercase)
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}
ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}
ALLOWED_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".aac"}
ALLOWED_DOC_EXT = {".pdf"}
ALLOWED_APP_EXT = {".apk"}
ALLOWED_UPLOAD_EXT = ALLOWED_IMAGE_EXT | ALLOWED_VIDEO_EXT | ALLOWED_AUDIO_EXT | ALLOWED_DOC_EXT | ALLOWED_APP_EXT
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB

from auth import (  # noqa: E402
    hash_password, verify_password, create_access_token, create_pwd_confirm_token,
    get_current_user, require_admin, require_pwd_confirm,
)
from levels import LEVELS, LEVELS_BY_NUM, COUNTRIES, OPERATORS_BY_COUNTRY  # noqa: E402


def _mobile_activation_amount(currency: str = "XOF") -> float:
    """v20 (2026-02-14) — mobile-money Level 1 activation fee.

    Bumped from 2 500 to 2 650 FCFA per product owner request. Crypto
    (5 USDT ≈ 2 500 FCFA) still reads `LEVELS_BY_NUM[1]["price"]` so
    the canonical matrix / commission math (invites=2, commission=2 000,
    upgrade_reserve=1 000) stays untouched. Only the entry fee grows —
    the extra 150 FCFA goes to the platform.
    """
    try:
        from ashtec_activation import ACTIVATION_AMOUNT_BY_CURRENCY  # type: ignore
        amt = ACTIVATION_AMOUNT_BY_CURRENCY.get((currency or "XOF").upper())
        if amt:
            return float(amt)
    except Exception:
        pass
    return 2650.0
from matrix import activate_level, try_auto_upgrade  # noqa: E402
from models import (  # noqa: E402
    RegisterIn, LoginIn, TokenOut, ChangePasswordIn, ConfirmPasswordIn,
    ActivationRequestIn, WalletIn, WithdrawalIn, AnnouncementIn, ChannelIn,
    UpdateProfileIn, AdminUserActionIn,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("spilivere")


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ.get("DB_NAME", "spilivere")]
    app.state.mongo = client
    app.state.db = db
    # Bind DB to modules that need it for observability (BizTransPay API logs).
    try:
        from biztranspay import _bind_db as _biztranspay_bind_db
        _biztranspay_bind_db(db)
    except Exception:
        pass
    # v27aj — minimalist app versioning: ensure defaults exist.
    try:
        from app_versions import auto_sync_from_frontend_version  # noqa: WPS433
        res = await auto_sync_from_frontend_version(db)
        log.info("app_version auto-sync result: %s", res)
    except Exception as _e:
        log.warning("app_version auto-sync skipped: %s", _e)
    await db.users.create_index("email", unique=True)
    await db.users.create_index("username", unique=True)
    await db.users.create_index("sponsor_id")
    await db.users.create_index("status")
    # v27ao (2026-03-04) — per-user per-listing seen tracking for the
    # WhatsApp-style Marketplace ring. Unique on (user_id, listing_id)
    # so repeated POSTs are naturally idempotent.
    try:
        await db.marketplace_views.create_index(
            [("user_id", 1), ("listing_id", 1)], unique=True,
            name="mk_views_user_listing_unique",
        )
    except Exception as _e:
        log.warning("marketplace_views index skipped: %s", _e)
    await db.matrix_placements.create_index([("level", 1), ("parent_id", 1)])
    await db.matrix_placements.create_index([("user_id", 1), ("level", 1)], unique=True)
    await db.matrix_placements.create_index([("parent_id", 1), ("is_spillover", 1)])
    await db.matrix_placements.create_index("sponsor_id")
    await db.commissions.create_index("user_id")
    await db.withdrawals.create_index("user_id")
    await db.activations.create_index("user_id")
    await db.payments.create_index("user_id")
    # v27l (Phase 4) — idempotency: reference must be globally unique across
    # ALL payments (activations, ads, missions, marketplace). Prevents
    # double-credit/double-activation from webhook replays or concurrent
    # dispatchers hitting the same reference. Named separately so it can
    # coexist with the legacy non-unique `reference_1` index if present.
    try:
        await db.payments.create_index("reference", unique=True, name="reference_unique")
    except Exception as _idx_e:
        # Legacy `reference_1` (non-unique) still around — best-effort drop
        # + recreate. If drop fails we keep going without the constraint.
        try:
            await db.payments.drop_index("reference_1")
            await db.payments.create_index("reference", unique=True, name="reference_unique")
        except Exception:
            log.warning("payments.reference unique index skipped: %s", _idx_e)
    await db.payments.create_index("transaction_id")
    # FCM push tokens — one row per (user_id, device_id)
    await db.push_tokens.create_index([("user_id", 1), ("device_id", 1)], unique=True)
    await db.push_tokens.create_index("token")
    # SoleasPay P-Out — one payout row per withdrawal id (idempotency).
    await db.soleaspay_payouts.create_index("wd_id", unique=True)
    await db.soleaspay_payouts.create_index("provider_reference")
    # v27i (2026-02-20) — Normalized payment provider registry (Phase 1).
    # Idempotently mirrors the flat config into normalized collections so
    # the future PaymentProviderRouter (Phase 2) can consume them.
    try:
        from payment_providers import sync_providers as _sync_pp
        await _sync_pp(db)
    except Exception as _e:
        log.warning(f"payment_providers sync failed at boot: {_e}")
    # seed admin
    admin_email = os.environ["ADMIN_EMAIL"].lower()
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        admin_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": admin_id,
            "username": os.environ.get("ADMIN_USERNAME", "admin"),
            "email": admin_email,
            "phone": os.environ.get("ADMIN_PHONE", "+22890000000"),
            "country": os.environ.get("ADMIN_COUNTRY", "TG"),
            "password_hash": hash_password(os.environ["ADMIN_PASSWORD"]),
            "role": "admin",
            "status": "active",
            "max_level": 12,  # admin pre-activated for all levels (helps as root of matrix)
            "sponsor_id": None,
            "sponsor_username": None,
            "balance_profit": 0,
            "balance_upgrade": 0,
            "commission_direct": 0,
            "commission_spillover": 0,
            "total_earned": 0,
            "total_withdrawn": 0,
            "withdrawals_disabled": False,
            "created_at": datetime.now(timezone.utc),
        })
        # Place admin at all levels as root (no parent)
        for lv in range(1, 13):
            await db.matrix_placements.insert_one({
                "user_id": admin_id, "level": lv,
                "parent_id": None, "leg": None,
                "sponsor_id": None, "is_spillover": False,
                "created_at": datetime.now(timezone.utc),
            })
        log.info(f"Admin seeded: {admin_email}")
    else:
        # ensure role/password match env (idempotent)
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {
                "role": "admin",
                "password_hash": hash_password(os.environ["ADMIN_PASSWORD"]),
                "status": "active",
            }},
        )
    # Init Emergent Object Storage session once at startup so subsequent
    # uploads/downloads use the cached storage_key. Best-effort — if it fails
    # we still boot and fall back to local disk.
    try:
        import object_storage as _obj  # noqa: WPS433
        if _obj.is_enabled():
            _obj._ensure_key()  # noqa: SLF001
            log.info("Object storage initialised")
        else:
            log.warning("EMERGENT_LLM_KEY not set — object storage disabled")
    except Exception as _e:
        log.warning(f"Object storage init failed: {_e}")
    # Seed feature flags (idempotent — new keys ship disabled by default).
    try:
        from feature_flags import ensure_default_flags as _seed_flags  # noqa: WPS433
        await _seed_flags(db)
        log.info("Feature flags seeded")
    except Exception as _e:
        log.warning(f"Feature flags seed failed: {_e}")
    # Launch chat retention background worker. It sleeps 30 min between passes
    # and permanently removes messages older than the admin-configured window.
    retention_task = None
    try:
        from chat import start_retention_worker as _start_retention  # noqa: WPS433
        retention_task = asyncio.create_task(_start_retention(db))
        # SolesPay reconciliation — safety net for lost webhooks
        asyncio.create_task(_soleaspay_reconciliation_loop(db))
        # v27m (Phase 5) — Biz-transPay server-side polling every 4s.
        try:
            from biztranspay import polling_loop as _btp_poll
            asyncio.create_task(_btp_poll(db))
            log.info("Biz-transPay polling worker scheduled (4-sec interval)")
        except Exception as _btp_e:
            log.warning(f"Biz-transPay polling worker failed to start: {_btp_e}")
        # v27o (2026-02-20) — Mission window opener notification watcher.
        try:
            from missions import mission_window_watcher as _mission_watch
            asyncio.create_task(_mission_watch(db))
            log.info("Mission window watcher scheduled (60-sec interval)")
        except Exception as _mw_e:
            log.warning(f"Mission window watcher failed to start: {_mw_e}")
        try:
            from special_tasks import special_task_notify_watcher as _st_watch
            asyncio.create_task(_st_watch(db))
            log.info("Special task notification watcher scheduled (20-sec interval)")
        except Exception as _st_e:
            log.warning(f"Special task watcher failed to start: {_st_e}")
        log.info("Chat retention worker scheduled")
    except Exception as _e:
        log.warning(f"Chat retention worker failed to start: {_e}")
    yield
    if retention_task:
        retention_task.cancel()
        try:
            await retention_task
        except Exception:
            pass
    client.close()


app = FastAPI(lifespan=lifespan, title="SPILIVERE API")

# Serve uploaded admin media at /api/uploads/<file>.
# In production the container disk is ephemeral, so we prioritize the Emergent
# Object Storage backend and only fall back to the local disk for legacy files
# still hanging around in preview / dev containers. Returning a clear French
# error message (410 Gone) instead of the default StaticFiles 404 helps admins
# understand that a file needs to be re-uploaded.
from fastapi import APIRouter as _UploadsRouter  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402
import object_storage as _obj_storage  # noqa: E402

_uploads_api = _UploadsRouter()


@_uploads_api.get("/api/uploads/{filename}")
async def _serve_upload(filename: str):
    # 1) Object storage (primary, persistent).
    if _obj_storage.is_enabled():
        try:
            data, ctype = _obj_storage.get_upload(filename)
            return Response(content=data, media_type=ctype)
        except FileNotFoundError:
            pass  # fall through to local disk
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger("uploads").warning(f"object storage GET failed for {filename}: {e}")

    # 2) Local disk (legacy fallback — dev / preview only).
    local = UPLOADS_DIR / filename
    if local.is_file():
        return FileResponse(str(local))

    # 3) File truly missing. Emit an explicit French error so admins & users
    # understand that this file was lost and needs to be re-uploaded.
    raise HTTPException(
        status_code=410,
        detail=(
            "Ce fichier n'est plus disponible sur le serveur. "
            "Veuillez contacter l'administration pour qu'il soit ré-uploadé."
        ),
    )


app.include_router(_uploads_api)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


# ============ PUBLIC ============

@api.get("/")
async def root():
    return {"app": "SPILIVERE", "ok": True}


@api.get("/config")
async def get_config():
    return {
        "levels": LEVELS,
        "countries": COUNTRIES,
        "operators_by_country": OPERATORS_BY_COUNTRY,
    }


@api.get("/sponsor/{username}")
async def get_sponsor(username: str, request: Request):
    db = request.app.state.db
    sp = await db.users.find_one({"username": username}, {"_id": 0, "username": 1, "id": 1, "max_level": 1})
    if not sp:
        raise HTTPException(404, "Parrain introuvable.")
    return sp


# ============ AUTH ============

@api.post("/auth/register", response_model=TokenOut)
async def register(data: RegisterIn, request: Request):
    db = request.app.state.db
    if not data.accept_terms:
        raise HTTPException(400, "Vous devez accepter les conditions.")
    if data.password != data.password_confirm:
        raise HTTPException(400, "Les mots de passe ne correspondent pas.")
    email = data.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Un compte existe déjà avec cet e-mail.")
    if await db.users.find_one({"username": data.username}):
        raise HTTPException(400, "Ce nom d’utilisateur est déjà pris.")
    sponsor = await db.users.find_one({"username": data.sponsor_username})
    if not sponsor:
        raise HTTPException(400, "Parrain introuvable.")
    if not any(c["code"] == data.country for c in COUNTRIES):
        raise HTTPException(400, "Pays invalide.")

    user_id = str(uuid.uuid4())
    user = {
        "id": user_id,
        "username": data.username,
        "email": email,
        "country": data.country,
        "phone": data.phone,
        "password_hash": hash_password(data.password),
        "role": "user",
        "status": "pending",  # pending activation
        "max_level": 0,
        "sponsor_id": sponsor["id"],
        "sponsor_username": sponsor["username"],
        "balance_profit": 0,
        "balance_upgrade": 0,
        "commission_direct": 0,
        "commission_spillover": 0,
        "total_earned": 0,
        "total_withdrawn": 0,
        "withdrawals_disabled": False,
        "earnings_per_level": {},
        "level_activated_at": {},
        "created_at": datetime.now(timezone.utc),
    }
    await db.users.insert_one(user)
    user.pop("password_hash", None)
    user.pop("_id", None)
    token = create_access_token(user_id, "user")
    return TokenOut(access_token=token, user=user)


@api.post("/auth/login", response_model=TokenOut)
async def login(data: LoginIn, request: Request):
    db = request.app.state.db
    email = data.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(401, "Identifiants invalides.")
    if user.get("status") == "banned":
        raise HTTPException(403, "Compte banni.")
    token = create_access_token(user["id"], user.get("role", "user"))
    user.pop("password_hash", None)
    user.pop("_id", None)
    return TokenOut(access_token=token, user=user)


@api.get("/auth/me")
async def me(user=Depends(get_current_user)):
    """Return the current authenticated user, fresh from the DB.

    Strong no-cache headers so no browser / service worker / CDN edge
    can serve a stale snapshot right after an activation write — the
    layout guard reads `max_level` from this response and any staleness
    bounces the user back to /pay (bug fix 2026-09-07).
    """
    from fastapi.responses import JSONResponse
    from fastapi.encoders import jsonable_encoder as _jenc
    return JSONResponse(
        content=_jenc(user),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@api.post("/auth/change-password")
async def change_password(data: ChangePasswordIn, request: Request, user=Depends(get_current_user)):
    if data.new_password != data.new_password_confirm:
        raise HTTPException(400, "Les nouveaux mots de passe ne correspondent pas.")
    db = request.app.state.db
    full = await db.users.find_one({"id": user["id"]})
    if not verify_password(data.current_password, full["password_hash"]):
        raise HTTPException(400, "Mot de passe actuel incorrect.")
    await db.users.update_one({"id": user["id"]}, {"$set": {"password_hash": hash_password(data.new_password)}})
    return {"ok": True}


# ─── Photo de profil (v12) ──────────────────────────────────────────────
# Stockage base64 dans le document utilisateur — simple, atomique, aucune
# dépendance externe. Limite stricte de 300 KB par photo (redimensionnement
# côté client à 512x512 JPEG q=0.85 → typiquement ~40-80 KB).

class ProfilePhotoIn(BaseModel):
    data: str  # data:image/{jpeg,png,webp};base64,<...>


@api.post("/me/profile-photo")
async def upload_profile_photo(payload: ProfilePhotoIn, request: Request,
                               user=Depends(get_current_user)):
    """Upload / remplace la photo de profil de l'utilisateur.

    Accepte un data-URI base64 (`data:image/jpeg;base64,...`). Valide le
    mime-type, la taille (max 300 KB décodés) et écrase l'ancienne photo.
    """
    raw = (payload.data or "").strip()
    if not raw.startswith("data:image/"):
        raise HTTPException(400, "Format d'image invalide (data-URI attendu).")
    try:
        header, b64 = raw.split(",", 1)
    except ValueError:
        raise HTTPException(400, "Data-URI mal formé.")
    mime = header.split(";")[0].removeprefix("data:")
    if mime not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(400, f"Type d'image non supporté : {mime}. Utilisez JPEG/PNG/WEBP.")
    import base64 as _b64
    try:
        decoded_size = len(_b64.b64decode(b64, validate=True))
    except Exception:
        raise HTTPException(400, "Base64 invalide.")
    if decoded_size > 300 * 1024:
        raise HTTPException(400, f"Photo trop lourde ({decoded_size // 1024} KB). Max 300 KB — réduisez la résolution.")
    db = request.app.state.db
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"profile_photo": raw,
                  "profile_photo_updated_at": datetime.now(timezone.utc)}},
    )
    return {"ok": True, "profile_photo": raw}


@api.delete("/me/profile-photo")
async def delete_profile_photo(request: Request, user=Depends(get_current_user)):
    """Supprime la photo de profil — revient à l'avatar générique."""
    db = request.app.state.db
    await db.users.update_one(
        {"id": user["id"]},
        {"$unset": {"profile_photo": "", "profile_photo_updated_at": ""}},
    )
    return {"ok": True}


@api.post("/auth/confirm-password")
async def confirm_password(data: ConfirmPasswordIn, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    full = await db.users.find_one({"id": user["id"]})
    if not verify_password(data.password, full["password_hash"]):
        raise HTTPException(400, "Mot de passe incorrect.")
    return {"confirm_token": create_pwd_confirm_token(user["id"]), "expires_in_minutes": 10}


@api.post("/auth/update-profile")
async def update_profile(data: UpdateProfileIn, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    updates = {}
    if data.phone:
        updates["phone"] = data.phone
    if data.email:
        new_email = data.email.lower()
        if new_email != user["email"]:
            if await db.users.find_one({"email": new_email}):
                raise HTTPException(400, "Cet e-mail est déjà utilisé.")
            updates["email"] = new_email
    if updates:
        await db.users.update_one({"id": user["id"]}, {"$set": updates})
    refreshed = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0})
    return refreshed


from pydantic import BaseModel as _LangBaseModel  # noqa: E402


class LanguageIn(_LangBaseModel):
    language: str  # "fr" | "en"


@api.put("/auth/language")
async def update_language(data: LanguageIn, request: Request, user=Depends(get_current_user)):
    """Persist the user's preferred UI language. Allowed: 'fr' or 'en'."""
    lang = (data.language or "").strip().lower()
    if lang not in ("fr", "en"):
        raise HTTPException(400, "Langue non supportée. Utilisez 'fr' ou 'en'.")
    db = request.app.state.db
    await db.users.update_one({"id": user["id"]}, {"$set": {"preferred_language": lang}})
    return {"ok": True, "preferred_language": lang}


# ============ ACTIVATIONS ============

@api.post("/activations/request")
async def request_activation(data: ActivationRequestIn, request: Request, user=Depends(require_pwd_confirm)):
    db = request.app.state.db
    if data.level < 1 or data.level > 12:
        raise HTTPException(400, "Niveau invalide.")
    expected = user.get("max_level", 0) + 1
    if data.level != expected:
        raise HTTPException(400, f"Vous devez d'abord activer le niveau {expected}.")
    # for level >= 2, must have enough upgrade balance: try auto-activate directly
    if data.level >= 2:
        try:
            await activate_level(db, user["id"], data.level, source="manual")
        except ValueError as e:
            raise HTTPException(400, str(e))
        refreshed = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0})
        return {"status": "activated", "user": refreshed}
    # Level 1: create pending activation request (admin validates)
    act_id = str(uuid.uuid4())
    await db.activations.insert_one({
        "id": act_id,
        "user_id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "level": data.level,
        "amount": LEVELS_BY_NUM[data.level]["price"],
        "payment_method": data.payment_method,
        "operator": data.operator,
        "payment_phone": data.payment_phone,
        "transaction_ref": data.transaction_ref,
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
    })
    return {"status": "pending", "activation_id": act_id}


@api.get("/activations/mine")
async def my_activations(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = await db.activations.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return items


# ============ MATRIX + TEAM ============

@api.get("/matrix/tree")
async def matrix_tree(request: Request, level: int = 1, user=Depends(get_current_user)):
    db = request.app.state.db
    # BFS down 4 layers under user — batched user lookups (avoids N+1).
    layers = []
    current = [user["id"]]
    for depth in range(4):
        children_layer = []
        if current:
            kids = await db.matrix_placements.find(
                {"level": level, "parent_id": {"$in": current}}, {"_id": 0}
            ).to_list(20 * len(current))
            uids = [k["user_id"] for k in kids]
            users_by_id: dict[str, dict] = {}
            if uids:
                async for u in db.users.find(
                    {"id": {"$in": uids}},
                    {"_id": 0, "username": 1, "max_level": 1, "status": 1, "created_at": 1, "id": 1},
                ):
                    users_by_id[u["id"]] = u
            for k in kids:
                u = users_by_id.get(k["user_id"])
                if u:
                    k["user"] = u
                children_layer.append(k)
        layers.append(children_layer)
        current = [c["user_id"] for c in children_layer]
        if not current:
            break
    return {"root": user, "layers": layers, "level": level}


@api.get("/team/details")
async def team_details(
    request: Request,
    level: int = 1,
    search: Optional[str] = None,
    sort: str = "newest",
    user=Depends(get_current_user),
):
    db = request.app.state.db
    # BFS all descendants at given level — batched per depth (avoids N+1).
    frontier = [user["id"]]
    visited = {user["id"]}
    member_ids: list[str] = []
    while frontier:
        rows = await db.matrix_placements.find(
            {"level": level, "parent_id": {"$in": frontier}}, {"_id": 0, "user_id": 1}
        ).to_list(2000 * len(frontier))
        next_frontier: list[str] = []
        for r in rows:
            uid = r["user_id"]
            if uid in visited:
                continue
            visited.add(uid)
            member_ids.append(uid)
            next_frontier.append(uid)
        frontier = next_frontier
    if not member_ids:
        return []
    q = {"id": {"$in": member_ids}}
    if search:
        q["$or"] = [
            {"username": {"$regex": search, "$options": "i"}},
            {"phone": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
        ]
    cursor = db.users.find(q, {"_id": 0, "password_hash": 0})
    order = -1 if sort == "newest" else 1
    cursor = cursor.sort("created_at", order)
    members = await cursor.to_list(5000)
    return members


@api.get("/team/tree")
async def team_tree(request: Request, max_depth: int = 4, user=Depends(get_current_user)):
    """Return the binary matrix tree (level 1 placements) rooted at the current user.

    Walks down `matrix_placements` where level=1, parent_id chain starts from user.
    Returns a nested structure: { user: {...}, left: ..., right: ..., children: [...] }.
    Depth is capped by `max_depth` to keep payload small (default 4 → up to 30 nodes).
    """
    db = request.app.state.db

    # Pre-fetch ALL placements & users in the sub-tree via BFS to avoid N+1.
    placements_by_parent: dict[str, list[dict]] = {}
    frontier = [user["id"]]
    all_user_ids: set[str] = set()
    for _ in range(max_depth):
        if not frontier:
            break
        rows = await db.matrix_placements.find(
            {"level": 1, "parent_id": {"$in": frontier}},
            {"_id": 0, "parent_id": 1, "user_id": 1, "leg": 1, "is_spillover": 1},
        ).to_list(4 * len(frontier))
        next_frontier: list[str] = []
        for r in rows:
            placements_by_parent.setdefault(r["parent_id"], []).append(r)
            uid = r["user_id"]
            if uid not in all_user_ids:
                all_user_ids.add(uid)
                next_frontier.append(uid)
        frontier = next_frontier

    users_by_id: dict[str, dict] = {}
    if all_user_ids:
        async for u in db.users.find(
            {"id": {"$in": list(all_user_ids)}},
            {"_id": 0, "id": 1, "username": 1, "status": 1, "max_level": 1, "created_at": 1},
        ):
            users_by_id[u["id"]] = u

    def build(node_id: str, depth: int) -> Optional[dict]:
        if depth > max_depth:
            return None
        kids = placements_by_parent.get(node_id, [])
        children: dict = {}
        for k in kids:
            child_doc = users_by_id.get(k["user_id"])
            if not child_doc:
                continue
            child_doc = dict(child_doc)
            child_doc["is_spillover"] = bool(k.get("is_spillover"))
            child_doc["children"] = build(k["user_id"], depth + 1)
            children[k.get("leg") or "left"] = child_doc
        return children if children else None

    root_user = {
        "id": user["id"], "username": user.get("username"),
        "status": user.get("status"), "max_level": user.get("max_level"),
        "is_spillover": False, "is_self": True,
        "children": build(user["id"], 1),
    }
    return root_user


@api.get("/team/level")
async def team_level(request: Request, level: int = Query(..., ge=1, le=12), user=Depends(get_current_user)):
    """Return all matrix-level-1 descendants at exactly tree-depth N below the user.

    N1 = 2 max members, N2 = 4 max, N3 = 8 max, ... Nk = 2^k max.
    Implements the binary forced matrix semantics: the placement chain via
    `matrix_placements.level=1` defines positions in the binary tree.
    """
    db = request.app.state.db

    # BFS down the level-1 placement tree, collecting nodes at each depth.
    current = [user["id"]]
    for _ in range(level):
        next_layer: list[str] = []
        if not current:
            break
        kids = await db.matrix_placements.find(
            {"level": 1, "parent_id": {"$in": current}},
            {"_id": 0, "user_id": 1, "parent_id": 1, "leg": 1, "is_spillover": 1},
        ).to_list(10000)
        for k in kids:
            next_layer.append(k["user_id"])
        current = next_layer

    if not current:
        return []
    docs = await db.users.find(
        {"id": {"$in": current}},
        {"_id": 0, "password_hash": 0},
    ).to_list(10000)
    by_id = {d["id"]: d for d in docs}
    spill_map = {}
    placements = await db.matrix_placements.find(
        {"user_id": {"$in": current}, "level": 1},
        {"_id": 0, "user_id": 1, "is_spillover": 1, "leg": 1},
    ).to_list(10000)
    for p in placements:
        spill_map[p["user_id"]] = {"is_spillover": p.get("is_spillover"), "leg": p.get("leg")}
    out = []
    for uid in current:
        u = by_id.get(uid)
        if not u:
            continue
        s = spill_map.get(uid, {})
        u["is_spillover"] = bool(s.get("is_spillover"))
        u["leg"] = s.get("leg")
        out.append(u)
    return out



@api.get("/team/direct")
async def team_direct(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = await db.users.find(
        {"sponsor_id": user["id"]},
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1).to_list(1000)
    direct_active = sum(1 for u in items if u.get("status") == "active")
    direct_inactive = len(items) - direct_active
    return {"members": items, "active": direct_active, "inactive": direct_inactive, "total": len(items)}


@api.get("/team/indirect")
async def team_indirect(request: Request, user=Depends(get_current_user)):
    """Return the "indirect team" — every user in my network who is NOT one of
    my direct referrals. This is the union of:
      • all descendants of my direct referrals down the sponsor chain
        (i.e. people registered via the link of my directs, transitively),
      • users placed under me via matrix Spillover (`parent_id == me.id`
        AND `is_spillover == True`), even if they were sponsored by someone
        outside my sponsor branch.
    We dedupe so a single user only appears once. Users I sponsored directly
    are excluded — they belong to /team/direct.
    """
    db = request.app.state.db
    me_id = user["id"]

    # 1) My direct referrals (excluded from indirect).
    direct_ids: set[str] = set(
        await db.users.distinct("id", {"sponsor_id": me_id})
    )

    # 2) BFS down the sponsor tree starting from my direct referrals.
    indirect_ids: set[str] = set()
    frontier = list(direct_ids)
    while frontier:
        next_frontier: list[str] = []
        chunk_ids = await db.users.distinct("id", {"sponsor_id": {"$in": frontier}})
        for uid in chunk_ids:
            if uid == me_id or uid in direct_ids or uid in indirect_ids:
                continue
            indirect_ids.add(uid)
            next_frontier.append(uid)
        frontier = next_frontier

    # 3) Spillover placements attached under me (may include users not in the
    # sponsor descendants of my directs, e.g. spillovers from above).
    spillover_meta: dict[str, dict] = {}
    async for pl in db.matrix_placements.find(
        {"parent_id": me_id, "is_spillover": True},
        {"_id": 0, "user_id": 1, "level": 1, "created_at": 1},
    ).sort("level", 1):
        uid = pl.get("user_id")
        if not uid or uid == me_id or uid in direct_ids:
            continue
        if uid not in spillover_meta:
            spillover_meta[uid] = {
                "placement_level": pl.get("level"),
                "placed_at": pl.get("created_at"),
            }
        indirect_ids.add(uid)

    if not indirect_ids:
        return {"members": [], "active": 0, "inactive": 0, "total": 0}

    members = []
    async for u in db.users.find(
        {"id": {"$in": list(indirect_ids)}},
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1):
        meta = spillover_meta.get(u["id"])
        if meta:
            u["placement_level"] = meta["placement_level"]
            u["placed_at"] = meta["placed_at"]
        members.append(u)

    active = sum(1 for u in members if u.get("status") == "active")
    return {
        "members": members,
        "active": active,
        "inactive": len(members) - active,
        "total": len(members),
    }


# ============ DASHBOARD ============

@api.get("/dashboard")
async def dashboard(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    # Safety-net auto-upgrade: rerun the cascade every time the user opens
    # their dashboard so no eligible level-up ever stays pending because a
    # past commission event missed the trigger (spec 2026-02 point 4).
    try:
        for _ in range(12):
            promoted = await try_auto_upgrade(db, user["id"])
            if not promoted:
                break
        # Refresh user document after possible upgrade.
        user = await db.users.find_one({"id": user["id"]}, {"_id": 0}) or user
    except Exception:
        pass
    direct_count = await db.users.count_documents({"sponsor_id": user["id"]})
    direct_active = await db.users.count_documents({"sponsor_id": user["id"], "status": "active"})
    spillover_count = await db.matrix_placements.count_documents({"parent_id": user["id"], "is_spillover": True})
    spillover_active_ids = await db.matrix_placements.distinct(
        "user_id", {"parent_id": user["id"], "is_spillover": True}
    )
    spillover_active = 0
    if spillover_active_ids:
        spillover_active = await db.users.count_documents({"id": {"$in": spillover_active_ids}, "status": "active"})
    cur = user.get("max_level", 0)
    level_info = LEVELS_BY_NUM.get(cur) if cur else None
    # v27h/v27i (2026-02-14) — task rewards (Special Tasks, Ads reactor,
    # paid_tasks, lottery wins) are credited to `balance_profit` but NOT
    # to the two counters `commission_direct` / `commission_spillover`.
    # Different modules log to different collections:
    #   • Special tasks & lottery & paid tasks → db.commissions with a
    #     non-commission `kind`.
    #   • Ads reactor rewards                  → db.ads_reactor_rewards.
    # We aggregate BOTH so the Dashboard "Total profit cumulé" reflects
    # every gain on the platform.
    _reward_kinds = {
        "direct", "spillover_sponsor", "spillover_beneficiary",
    }
    task_earnings = 0.0
    try:
        agg = db.commissions.aggregate([
            {"$match": {
                "user_id": user["id"],
                "kind": {"$nin": list(_reward_kinds)},
            }},
            {"$group": {"_id": None, "total": {"$sum": "$profit_share"}}},
        ])
        async for row in agg:
            task_earnings += float(row.get("total") or 0)
    except Exception:
        pass
    try:
        agg2 = db.ads_reactor_rewards.aggregate([
            {"$match": {"user_id": user["id"]}},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
        ])
        async for row in agg2:
            task_earnings += float(row.get("total") or 0)
    except Exception:
        pass

    # v27j (2026-02-14) — Missions rémunérées credit dedicated wallets
    # (balance_youtube / _tiktok / _instagram / _facebook / _questionnaire)
    # AND maintain a running total `balance_missions_total` on the user
    # document (see missions.py line 426). Include it in the cumulative
    # total profit so mission earnings surface on the Dashboard.
    mission_earnings = float(user.get("balance_missions_total", 0) or 0)
    task_earnings += mission_earnings

    # v19 (2026-02-14) — `total_profit` reflects ALL profit-side inflows,
    # not only the automatic commission attributions. Admin-side credits
    # (bucket=profit OR upgrade) are tracked in `admin_credit_total` so
    # they surface on the Profit Total card. Withdrawals never affect
    # this cumulative number (they only reduce `balance_profit`).
    total_profit = (
        float(user.get("commission_direct", 0) or 0)
        + float(user.get("commission_spillover", 0) or 0)
        + float(user.get("admin_credit_total", 0) or 0)
        + task_earnings
    )

    # ─── Daily activity trend (v14 dashboard hero) ──────────────
    # Compute the daily variation (%) between today and yesterday for
    # each of the 3 top stats + a 7-day sparkline used by the mini
    # graph inside each stat card. Any DB error is silently swallowed
    # so the dashboard endpoint always returns a stable payload.
    trend = {
        "profit_pct": 0.0, "balance_pct": 0.0, "activation_pct": 0.0,
        "profit_series": [0.0] * 7,
        "balance_series": [0.0] * 7,
        "activation_series": [0.0] * 7,
    }
    try:
        now = datetime.now(timezone.utc)
        today_start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        yesterday_start = today_start - timedelta(days=1)
        window_start = today_start - timedelta(days=6)

        async def _daily_totals(collection, date_field: str = "created_at"):
            """Return a dict {YYYY-MM-DD: sum(amount)} for the last 7 days."""
            pipeline = [
                {"$match": {"user_id": user["id"], date_field: {"$gte": window_start}}},
                {"$group": {
                    "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": f"${date_field}"}},
                    "total": {"$sum": "$amount"},
                }},
            ]
            out: dict[str, float] = {}
            async for row in collection.aggregate(pipeline):
                out[str(row["_id"])] = float(row.get("total", 0) or 0)
            return out

        comm_by_day = await _daily_totals(db.commissions)
        wd_by_day = await _daily_totals(db.withdrawals)

        # Build 7-day arrays ending today (index 6 = today).
        keys = [(window_start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
        profit_series = [comm_by_day.get(k, 0.0) for k in keys]
        balance_series = [
            comm_by_day.get(k, 0.0) - wd_by_day.get(k, 0.0) for k in keys
        ]

        # Activation series: 2650 XOF on the day the user was created /
        # activated (level 1 flat fee, v20 bump). Non-zero only on that day.
        activation_series = [0.0] * 7
        created_at = user.get("created_at")
        if created_at and (user.get("max_level") or 0) >= 1:
            if isinstance(created_at, str):
                try:
                    created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                except Exception:
                    created_at = None
            if isinstance(created_at, datetime):
                day_key = created_at.strftime("%Y-%m-%d")
                if day_key in keys:
                    activation_series[keys.index(day_key)] = 2650.0

        def _pct(today_v: float, yest_v: float) -> float:
            if yest_v == 0:
                return 100.0 if today_v > 0 else 0.0
            return round(((today_v - yest_v) / abs(yest_v)) * 100.0, 1)

        trend = {
            "profit_pct": _pct(profit_series[6], profit_series[5]),
            "balance_pct": _pct(balance_series[6], balance_series[5]),
            "activation_pct": _pct(activation_series[6], activation_series[5]),
            "profit_series": profit_series,
            "balance_series": balance_series,
            "activation_series": activation_series,
        }
    except Exception:
        pass

    _wd_agg = await db.withdrawals.aggregate([
        {"$match": {"user_id": user["id"], "status": {"$in": ["completed", "validated"]}}},
        {"$group": {"_id": None, "sum": {"$sum": "$amount"}}},
    ]).to_list(1)
    total_withdrawn_confirmed = float(_wd_agg[0]["sum"]) if _wd_agg else 0.0

    return {
        "user": user,
        "balance_total": user.get("balance_profit", 0) + user.get("balance_upgrade", 0),
        "balance_profit": user.get("balance_profit", 0),
        "balance_upgrade": user.get("balance_upgrade", 0),
        # v18 (2026-02-14) — wallet_deposit_balance is a NEW field that
        # tracks ONLY confirmed deposit/recharge amounts. It MUST stay
        # separated from commissions/rewards which live in balance_profit.
        # Default to 0 until the Dépôt flow ships.
        "wallet_deposit_balance": float(user.get("wallet_deposit_balance", 0) or 0),
        "commission_direct": user.get("commission_direct", 0),
        "commission_spillover": user.get("commission_spillover", 0),
        "admin_credit_total": float(user.get("admin_credit_total", 0) or 0),
        # v27h (2026-02-14) — cumulative task rewards (special tasks, paid
        # tasks, reactor). Frontend can display this separately if needed.
        "task_earnings": task_earnings,
        "total_profit": total_profit,
        "total_withdrawn": float(user.get("total_withdrawn", 0) or 0),
        "total_withdrawn_confirmed": total_withdrawn_confirmed,
        "direct_count": direct_count,
        "direct_active": direct_active,
        "direct_inactive": direct_count - direct_active,
        "spillover_count": spillover_count,
        "spillover_active": spillover_active,
        "spillover_inactive": spillover_count - spillover_active,
        "current_level": level_info,
        "trend": trend,
        # v27 (2026-02-14) — feed the dashboard bell badge without an extra
        # round-trip. Frontend already reads `stats.unread_notifications`.
        "unread_notifications": await db.notifications.count_documents(
            {"user_id": user["id"], "read": False}
        ),
    }


# ============ WALLET + WITHDRAWAL ============

@api.get("/wallet")
async def get_wallet(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    w = await db.wallets.find_one({"user_id": user["id"]}, {"_id": 0})
    return w


@api.post("/wallet")
async def save_wallet(data: WalletIn, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    method = (data.method or "mobile").lower()
    if method not in {"mobile", "crypto"}:
        raise HTTPException(400, "Mode de retrait invalide.")
    if not data.country or not data.full_name:
        raise HTTPException(400, "Pays et nom du titulaire requis.")
    if method == "mobile":
        if not (data.operator and data.phone):
            raise HTTPException(400, "Opérateur et numéro de téléphone requis.")
    else:  # crypto
        if not (data.wallet_address and len(data.wallet_address.strip()) >= 12):
            raise HTTPException(400, "Adresse wallet invalide.")
    doc = {
        "user_id": user["id"],
        "country": data.country,
        "full_name": data.full_name,
        "method": method,
        # Mobile Money fields (kept for backward compat — empty when crypto)
        "operator": (data.operator or "") if method == "mobile" else "",
        "phone": (data.phone or "") if method == "mobile" else "",
        # Crypto fields (empty when mobile)
        "network": (data.network or "USDT BEP20") if method == "crypto" else "",
        "wallet_address": (data.wallet_address or "").strip() if method == "crypto" else "",
        "updated_at": datetime.now(timezone.utc),
    }
    await db.wallets.update_one({"user_id": user["id"]}, {"$set": doc}, upsert=True)
    return {"ok": True}


@api.post("/withdrawals")
async def request_withdrawal(data: WithdrawalIn, request: Request, user=Depends(require_pwd_confirm)):
    db = request.app.state.db
    # ⚡ Activation guard (v16) — MLM withdrawals require an activated account.
    # Frontend shows an "Activate your account" modal for pending users, but
    # the backend enforces the rule so the endpoint can never be bypassed.
    if (user.get("status") != "active") and (int(user.get("max_level") or 0) < 1):
        raise HTTPException(403, "ACTIVATION_REQUIRED")
    if user.get("withdrawals_disabled"):
        raise HTTPException(403, "Retraits désactivés par l’administrateur.")
    # R2 (2026-03-04) — rate-limit: max 5 withdrawal attempts per rolling 5 min
    # per user. Defends against automated abuse of the Biz-transPay payout
    # gateway (each PayOut hits the provider quota + costs real money). Admin
    # accounts bypass. Applies to all users regardless of preferred gateway.
    if not user.get("is_admin"):
        _rl_since = datetime.now(timezone.utc) - timedelta(minutes=5)
        _rl_count = await db.withdrawals.count_documents({
            "user_id": user["id"],
            "created_at": {"$gte": _rl_since},
        })
        if _rl_count >= 5:
            raise HTTPException(
                429,
                "Trop de demandes de retrait. Réessayez dans quelques minutes.",
            )
    wallet = await db.wallets.find_one({"user_id": user["id"]})
    if not wallet:
        raise HTTPException(400, "Veuillez d’abord enregistrer votre portefeuille de retrait.")
    if data.amount <= 0:
        raise HTTPException(400, "Montant invalide.")

    # Load admin-configured withdrawal settings
    wd_settings = await _get_withdrawal_settings(db)
    if not wd_settings["enabled"]:
        raise HTTPException(403, "Les retraits sont actuellement désactivés.")
    window_err = _check_withdrawal_window(wd_settings)
    if window_err:
        raise HTTPException(403, window_err)
    if wd_settings["min_amount"] and data.amount < wd_settings["min_amount"]:
        raise HTTPException(400, f"Montant minimum de retrait : {wd_settings['min_amount']:.0f} FCFA.")
    if wd_settings["max_amount"] and data.amount > wd_settings["max_amount"]:
        raise HTTPException(400, f"Montant maximum de retrait : {wd_settings['max_amount']:.0f} FCFA.")
    if data.amount > user.get("balance_profit", 0):
        raise HTTPException(400, "Solde profit insuffisant.")

    fee, net = _compute_withdrawal_fee(float(data.amount), wd_settings)

    # Lock balance immediately
    await db.users.update_one(
        {"id": user["id"]}, {"$inc": {"balance_profit": -data.amount}},
    )
    wd_id = str(uuid.uuid4())
    wd_doc = {
        "id": wd_id, "user_id": user["id"], "username": user["username"],
        "amount": data.amount, "fee": fee, "net_payout": net,
        "status": "pending",
        "method": wallet.get("method") or ("crypto" if wallet.get("wallet_address") else "mobile"),
        "operator": wallet.get("operator", ""), "phone": wallet.get("phone", ""),
        "network": wallet.get("network", ""), "wallet_address": wallet.get("wallet_address", ""),
        "full_name": wallet["full_name"], "country": wallet["country"],
        "created_at": datetime.now(timezone.utc),
    }
    await db.withdrawals.insert_one(wd_doc)

    # ── Auto-dispatch cascade: SoleasPay P-Out (no fallback — BizTransPay removed).
    # If SolesPay P-Out is off or the country isn't allowed, the withdrawal
    # simply stays "pending" for manual admin validation.
    auto_result = {"auto_dispatched": False}
    dispatched_gateway = None
    country_upper = (wallet.get("country") or "").upper()
    preferred = await pick_payout_gateway_for_country(db, country_upper)
    pg_cfg_for_pout = await _load_payment_gateway(db)

    if preferred == "soleaspay" and (wd_doc.get("method") or "") in ("mobile", "mobile_money", "mm"):
        try:
            from soleaspay import dispatch_soleaspay_withdrawal
            auto_result = await dispatch_soleaspay_withdrawal(db, wd_doc, pg_cfg_for_pout)
        except Exception as e:
            import logging as _lg
            _lg.getLogger("soleaspay").exception(
                "SoleasPay P-Out dispatch failed for wd_id=%s: %s", wd_id, e)
            auto_result = {"auto_dispatched": False, "reason": "exception"}
        if auto_result.get("auto_dispatched"):
            dispatched_gateway = "soleaspay"
    elif preferred == "biztranspay" and (wd_doc.get("method") or "") in ("mobile", "mobile_money", "mm"):
        try:
            from biztranspay import dispatch_biztranspay_withdrawal
            auto_result = await dispatch_biztranspay_withdrawal(db, wd_doc)
        except Exception as e:
            import logging as _lg
            _lg.getLogger("biztranspay").exception(
                "Biz-transPay P-Out dispatch failed for wd_id=%s: %s", wd_id, e)
            auto_result = {"auto_dispatched": False, "reason": "exception"}
        if auto_result.get("auto_dispatched"):
            dispatched_gateway = "biztranspay"

    resp = {"id": wd_id, "status": "dispatched" if auto_result.get("auto_dispatched") else "pending",
            "amount": data.amount, "fee": fee, "net_payout": net}
    if auto_result.get("auto_dispatched"):
        resp["auto_dispatched"] = True
        resp["gateway"] = dispatched_gateway
    return resp


@api.get("/withdrawals/mine")
async def my_withdrawals(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = await db.withdrawals.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return items



@api.get("/transactions")
async def my_transactions(request: Request, user=Depends(get_current_user)):
    """Unified transaction history for the current user.

    Returns activations + payments + withdrawals + commissions + mission rewards,
    sorted by date (newest first), with a stable shape used by both the user UI
    and the admin "Historique" tab:
        {type, status, amount, fee?, net?, currency, label, ref, date,
         from_user_id?, from_username?, level?, meta}
    """
    db = request.app.state.db
    return await _build_transaction_history(db, user["id"])


async def _build_transaction_history(db, user_id: str) -> list[dict]:
    """Shared helper used by /transactions and /admin/users/{id}/transactions."""
    out: list[dict] = []

    # MLM commissions (level 1..12, direct or spillover)
    async for c in db.commissions.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).limit(1000):
        from_uid = c.get("from_user_id")
        from_username = None
        from_sponsor_id = None
        from_user_exists = False
        if from_uid:
            fu = await db.users.find_one({"id": from_uid}, {"_id": 0, "username": 1, "sponsor_id": 1})
            if fu:
                from_user_exists = True
                from_username = fu.get("username")
                from_sponsor_id = fu.get("sponsor_id")
        kind = c.get("kind") or "direct"
        level = c.get("level")
        # User-facing label — strip all MLM jargon (Spillover / Parrain / Bénéficiaire).
        # "Commission directe" = commission earned from a user who registered with
        # the recipient's OWN referral link, regardless of the activation level or
        # the matrix spillover placement. The sponsor relationship is defined by
        # `users.sponsor_id` (immutable).
        #   Primary check   : from_user.sponsor_id == recipient user_id.
        #   Fallback (from_user deleted from DB): matrix.py guarantees that
        #     kind ∈ {direct, spillover_sponsor} with level == 1 means the
        #     recipient IS the direct sponsor of the new user.
        #   Otherwise a level (2..12) is used → "Commission niveau X".
        #   Lottery-related kinds keep their own dedicated labels.
        is_direct_sponsor = (
            (from_user_exists and from_sponsor_id == user_id)
            or (not from_user_exists and level == 1 and kind in ("direct", "spillover_sponsor"))
        )
        if kind == "lottery_win":
            label = "Gain Loterie"
        elif kind == "lottery_entry":
            label = "Participation Loterie"
        elif kind == "lottery_loss":
            label = "Perte Loterie"
        elif is_direct_sponsor:
            label = "Commission directe"
        elif level:
            label = f"Commission niveau {level}"
        else:
            label = "Commission"
        out.append({
            "type": f"commission_{kind}",
            "status": "completed",
            "amount": float(c.get("amount", 0) or 0),
            "fee": None, "net": None, "currency": "XOF",
            "label": label,
            "ref": from_uid,
            "date": c.get("created_at"),
            "from_user_id": from_uid,
            "from_username": from_username,
            "level": level,
            "meta": {
                "kind": kind,
                "level": level,
                "upgrade_share": float(c.get("upgrade_share", 0) or 0),
                "profit_share": float(c.get("profit_share", 0) or 0),
                "from_user_id": from_uid,
                "from_username": from_username,
            },
        })

    # Activations (manual / crypto)
    async for a in db.activations.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1):
        out.append({
            "type": "activation",
            "status": a.get("status", "pending"),
            "amount": float(a.get("amount", 0) or 0),
            "fee": None, "net": None, "currency": "XOF",
            "label": f"Activation niveau {a.get('level', '?')}",
            "ref": a.get("id"),
            "date": a.get("created_at"),
            "level": a.get("level"),
            "meta": {
                "level": a.get("level"),
                "operator": a.get("operator"),
                "payment_method": a.get("payment_method"),
                "transaction_ref": a.get("transaction_ref"),
            },
        })

    # Automatic payments (SoleasPay flow)
    async for p in db.payments.find({"user_id": user_id}, {"_id": 0, "events": 0, "last_provider_payload": 0}).sort("created_at", -1):
        out.append({
            "type": "payment",
            "status": p.get("status", "pending"),
            "amount": float(p.get("amount", 0) or 0),
            "fee": None, "net": None, "currency": p.get("currency", "XOF"),
            "label": f"Paiement automatique niveau {p.get('level', '?')}",
            "ref": p.get("reference"),
            "date": p.get("created_at"),
            "level": p.get("level"),
            "meta": {
                "level": p.get("level"),
                "operator": p.get("service_label"),
                "phone": p.get("phone"),
                "country": p.get("country_code"),
                "transaction_ref": p.get("transaction_id"),
                "activation_done": p.get("activation_done"),
            },
        })

    # Withdrawals (MLM commissions)
    async for w in db.withdrawals.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1):
        out.append({
            "type": "withdrawal",
            "status": w.get("status", "pending"),
            "amount": float(w.get("amount", 0) or 0),
            "fee": float(w.get("fee", 0) or 0) if w.get("fee") is not None else None,
            "net": float(w.get("net_payout", 0) or 0) if w.get("net_payout") is not None else None,
            "currency": "XOF",
            "label": "Retrait Commissions",
            "ref": w.get("id"),
            "date": w.get("created_at"),
            "meta": {
                "withdrawal_type": "commissions",
                "operator": w.get("operator"),
                "phone": w.get("phone"),
                "country": w.get("country"),
                "network": w.get("network"),
                "wallet_address": w.get("wallet_address"),
                "full_name": w.get("full_name"),
                "reject_reason": w.get("reject_reason"),
            },
        })

    # Mission withdrawals (paid missions module — separate collection)
    try:
        async for w in db.mission_withdrawals.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1):
            out.append({
                "type": "withdrawal",
                "status": w.get("status", "pending"),
                "amount": float(w.get("amount", 0) or 0),
                "fee": float(w.get("fee", 0) or 0) if w.get("fee") is not None else None,
                "net": float(w.get("net_payout", 0) or 0) if w.get("net_payout") is not None else None,
                "currency": "XOF",
                "label": f"🎥 Retrait Mission ({w.get('wallet', '')})",
                "ref": w.get("id"),
                "date": w.get("created_at"),
                "meta": {
                    "withdrawal_type": "mission",
                    "wallet": w.get("wallet"),
                    "operator": w.get("operator"),
                    "phone": w.get("phone"),
                    "country": w.get("country"),
                    "network": w.get("network"),
                    "wallet_address": w.get("wallet_address"),
                    "full_name": w.get("full_name"),
                    "reject_reason": w.get("reject_reason"),
                },
            })
    except Exception:
        pass

    # Mission rewards (paid missions module, isolated wallet)
    try:
        async for mc in db.mission_claims.find(
            {"user_id": user_id, "status": {"$in": ["validated", "approved", "paid"]}},
            {"_id": 0},
        ).sort("created_at", -1):
            mission = None
            if mc.get("mission_id"):
                mission = await db.missions.find_one({"id": mc["mission_id"]}, {"_id": 0, "title": 1, "reward": 1})
            out.append({
                "type": "mission",
                "status": mc.get("status") or "validated",
                "amount": float(mc.get("reward") or (mission or {}).get("reward") or 0),
                "fee": None, "net": None, "currency": "XOF",
                "label": f"Mission rémunérée — {(mission or {}).get('title') or mc.get('mission_id', '')}",
                "ref": mc.get("id"),
                "date": mc.get("validated_at") or mc.get("created_at"),
                "meta": {
                    "mission_id": mc.get("mission_id"),
                    "title": (mission or {}).get("title"),
                },
            })
    except Exception:
        # mission_claims collection may not exist on older DBs
        pass

    out.sort(key=lambda r: (r.get("date") or datetime.now(timezone.utc)), reverse=True)
    return out



# ============ COMMUNITY / ANNOUNCEMENTS (public-ish to logged-in users) ============

@api.get("/announcements")
async def list_announcements(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    items = await db.announcements.find(
        {"active": True}, {"_id": 0}
    ).sort("created_at", -1).to_list(50)
    out = []
    for a in items:
        if a.get("starts_at") and a["starts_at"] > now:
            continue
        if a.get("ends_at") and a["ends_at"] < now:
            continue
        out.append(a)
    return out


@api.get("/channels")
async def list_channels(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = await db.channels.find({"active": True}, {"_id": 0}).to_list(50)
    return items



# ============ PAYMENTS (Secure Gateway) ============

import soleaspay  # noqa: E402
import ashtecpay  # noqa: E402

# ---------------------------------------------------------------------------
# Payment gateway selector — admin configurable.
#
# `db.app_settings.payment_gateway` stores:
#   {
#     "active": "soleas" | "ashtec",     # which gateway to use for new payments
#     "soleas_enabled": bool,
#     "ashtec_enabled": bool,
#     "ashtec_api_key": str,             # masked when read (last 4 chars)
#   }
# Existing SoleasPay-only deployments default to active="soleas" so behavior
# is unchanged until the admin enables AshtecPay explicitly.
# ---------------------------------------------------------------------------

_PG_DEFAULTS = {
    "active": "soleas",
    "soleas_enabled": True,
    "ashtec_enabled": False,
    "ashtec_api_key": "",
    # v27bc (2026-03-05) — AshTech Pay Direct API v1 requires a `user_id`
    # on every /v1/collect body and /v1/transaction query. It's the
    # merchant profile identifier associated with the Bearer key, visible
    # in the AshTech dashboard. Without it, every call returns 400
    # user_id_required. Loaded here with env fallback.
    "ashtec_user_id": "",
    # Ashtech Pay Direct v1.2 webhook — HMAC-SHA256 shared secret set on the
    # Ashtech merchant dashboard. Required to authenticate incoming webhooks.
    "ashtec_webhook_secret": "",
    # Country matrix for pay-IN gateway selection.
    "country_matrix": {},
    # SoleasPay webhook — hybrid verification (HMAC OR shared hash token).
    "soleaspay_webhook_secret": "",   # HMAC-SHA256 secret
    "soleaspay_webhook_hash": "",     # Shared hash token (verif-hash header / body.hash)
    # SoleasPay ISOLATED credentials (admin-managed via /admin/soleaspay/*).
    "soleaspay_public_key": "",       # x-api-key + public_apikey for bearer
    "soleaspay_secret_key": "",       # private_secretkey for bearer JWT
    # SoleasPay Pay-OUT.
    "soleaspay_pout_enabled": False,
    "soleaspay_pout_country_matrix": {},
    # v27h (2026-02-20) — Biz-transPay (SoftPay) integration, TG only.
    # v27s (2026-02-24) — migrated to Integration API v1: dual-key auth
    # (public + secret) + webhook secret.
    "biztranspay_enabled": False,
    "biztranspay_payin_enabled": True,
    "biztranspay_payout_enabled": False,
    "biztranspay_public_key": "",
    "biztranspay_secret_key": "",
    "biztranspay_api_key": "",   # legacy field, kept for backward-compat
    "biztranspay_webhook_secret": "",
    # v27w (2026-02-24) — USDT.BEP20 crypto pay-in (parallel to Mobile Money)
    "biztranspay_crypto_enabled": True,
    # { "TG": { "tmoney_tg": bool, "moov_tg": bool }, "BJ": {...}, "BF": {...} }
    "biztranspay_countries": {},
}


async def _load_payment_gateway(db) -> dict:
    doc = await db.app_settings.find_one({"key": "payment_gateway"}, {"_id": 0}) or {}
    val = (doc.get("value") if isinstance(doc.get("value"), dict) else {}) or {}
    cfg = dict(_PG_DEFAULTS)
    for k in _PG_DEFAULTS.keys():
        if k in val:
            cfg[k] = val[k]
    return cfg


def _mask_key(k: str) -> str:
    """Mask a non-sensitive key (e.g. public key) showing 4 leading + 4 trailing chars."""
    if not k or not isinstance(k, str):
        return ""
    if len(k) <= 8:
        return "*" * len(k)
    return k[:4] + "*" * (len(k) - 8) + k[-4:]


def _mask_secret_strict(k: str) -> str:
    """R1 (2026-03-04) — strict masking for SECRET material (secret_key,
    webhook_secret, api_key). Never exposes the prefix (which would leak
    whether the key is `sk_test_*` vs `sk_live_*`), only the last 4 chars.
    Returns "" if empty, otherwise a fixed 8-dot prefix + last 4 chars."""
    if not k or not isinstance(k, str):
        return ""
    if len(k) <= 4:
        return "•" * len(k)
    return "••••••••" + k[-4:]


# Payment gateway admin endpoints — declared right after the helper, before any
# of the legacy /settings/manual-payment routes to avoid the duplicate handler
# loaded later in the file from masking them.
from pydantic import BaseModel as _PGBaseModel  # noqa: E402


class PaymentGatewayUpdate(_PGBaseModel):
    active: Optional[str] = None              # "soleas" | "ashtec"
    soleas_enabled: Optional[bool] = None
    ashtec_enabled: Optional[bool] = None
    ashtec_api_key: Optional[str] = None      # new key, or "" to keep, "DELETE" to clear
    # v27bc — AshTech Pay merchant user_id (mandatory for /v1/collect body
    # and /v1/transaction query). Admin pastes it from AshTech dashboard.
    ashtec_user_id: Optional[str] = None
    ashtec_webhook_secret: Optional[str] = None  # "" to keep, "DELETE" to clear
    # SoleasPay P-Out
    soleaspay_pout_enabled: Optional[bool] = None
    soleaspay_webhook_secret: Optional[str] = None   # "" to keep, "DELETE" to clear
    soleaspay_webhook_hash: Optional[str] = None
    soleaspay_public_key: Optional[str] = None
    soleaspay_secret_key: Optional[str] = None
    # v27h — Biz-transPay (SoftPay)
    # v27s (2026-02-24) — Integration API v1 dual-key + webhook secret.
    biztranspay_enabled: Optional[bool] = None
    biztranspay_payin_enabled: Optional[bool] = None
    biztranspay_payout_enabled: Optional[bool] = None
    biztranspay_public_key: Optional[str] = None
    biztranspay_secret_key: Optional[str] = None
    biztranspay_api_key: Optional[str] = None   # legacy alias
    biztranspay_webhook_secret: Optional[str] = None
    biztranspay_crypto_enabled: Optional[bool] = None    # v27w
    biztranspay_countries: Optional[dict] = None


# Note: the actual @admin_router routes are registered later in the file
# (after admin_router is created at L1348). See `_register_payment_gateway_routes`
# right after the admin_router instantiation.


def _register_payment_gateway_routes(router):
    @router.get("/payment-gateways")
    async def admin_get_payment_gateways(request: Request):
        db = request.app.state.db
        cfg = await _load_payment_gateway(db)
        return {
            "active": cfg["active"],
            "soleas": {
                "enabled": bool(cfg["soleas_enabled"]),
                "configured": bool(soleaspay.is_configured()),
            },
            "ashtec": {
                "enabled": bool(cfg["ashtec_enabled"]),
                "configured": bool((cfg.get("ashtec_api_key") or "").strip()),
                "api_key_masked": _mask_secret_strict(cfg.get("ashtec_api_key") or ""),
                "user_id_set": bool((cfg.get("ashtec_user_id") or "").strip()
                                    or (os.environ.get("ASHTECH_USER_ID") or "").strip()),
                "user_id": _mask_secret_strict(cfg.get("ashtec_user_id") or ""),
                "webhook_secret_set": bool(
                    (os.environ.get("ASHTECPAY_WEBHOOK_SECRET") or "").strip()
                    or (cfg.get("ashtec_webhook_secret") or "").strip()
                ),
                "webhook_secret_masked": _mask_secret_strict(cfg.get("ashtec_webhook_secret") or ""),
            },
            "country_matrix": cfg.get("country_matrix") or {},
            "soleas_countries": list(soleaspay.SUPPORTED.keys()),
            "soleaspay_pout_enabled": bool(cfg.get("soleaspay_pout_enabled")),
            "soleaspay_pout_country_matrix": cfg.get("soleaspay_pout_country_matrix") or {},
            "soleaspay_webhook_secret_set": bool(
                (os.environ.get("SOLEASPAY_WEBHOOK_SECRET") or "").strip()
                or (cfg.get("soleaspay_webhook_secret") or "").strip()
            ),
            # v27h — Biz-transPay
            # v27s (2026-02-24) — expose public_key & secret_key masks; add
            # webhook_url so the admin knows where to point the BTP dashboard.
            "biztranspay": {
                "enabled": bool(cfg.get("biztranspay_enabled")),
                "payin_enabled": bool(cfg.get("biztranspay_payin_enabled", True)),
                "payout_enabled": bool(cfg.get("biztranspay_payout_enabled")),
                "configured": bool(
                    ((cfg.get("biztranspay_secret_key") or "").strip()
                     or (cfg.get("biztranspay_api_key") or "").strip())
                    and (cfg.get("biztranspay_public_key") or "").strip()
                ),
                "public_key_masked": _mask_key(cfg.get("biztranspay_public_key") or ""),
                "secret_key_masked": _mask_secret_strict(
                    (cfg.get("biztranspay_secret_key") or "")
                    or (cfg.get("biztranspay_api_key") or "")
                ),
                "webhook_secret_set": bool((cfg.get("biztranspay_webhook_secret") or "").strip()),
                "webhook_secret_masked": _mask_secret_strict(cfg.get("biztranspay_webhook_secret") or ""),
                "webhook_url": (os.environ.get("PUBLIC_APP_URL") or "").rstrip("/") + "/api/webhooks/biztranspay"
                    if os.environ.get("PUBLIC_APP_URL") else "/api/webhooks/biztranspay",
                # v27w — USDT.BEP20 crypto sub-status
                "crypto_enabled": bool(cfg.get("biztranspay_crypto_enabled", True)),
                "countries": cfg.get("biztranspay_countries") or {},
                # Catalog of supported countries+operators so the admin UI
                # renders toggles even before anything is saved.
                # v27s — 3 pays confirmés par la doc v1 : TG / BJ / BF.
                "catalog": {
                    "TG": {
                        "name": "Togo", "currency": "XOF",
                        "operators": [
                            {"code": "tmoney_tg", "label": "T-Money (TogoCom)"},
                            {"code": "moov_tg",   "label": "Moov Money"},
                        ],
                    },
                    "BJ": {
                        "name": "Bénin", "currency": "XOF",
                        "operators": [
                            {"code": "tmoney_bj",  "label": "MTN Mobile Money"},
                            {"code": "moov_bj",    "label": "Moov Money"},
                            {"code": "celtiis_bj", "label": "Celtiis Cash"},
                        ],
                    },
                    "BF": {
                        "name": "Burkina Faso", "currency": "XOF",
                        "operators": [
                            {"code": "orange_bf", "label": "Orange Money"},
                            {"code": "moov_bf",   "label": "Moov Money"},
                            {"code": "coris_bf",  "label": "Coris Money"},
                        ],
                    },
                },
            },
        }

    @router.post("/payment-gateways/soleaspay/test")
    async def admin_test_soleaspay(request: Request, admin=Depends(require_admin)):
        """Real connection test: probe verif-pay with a bogus order — a valid
        key returns a well-formed JSON error, an invalid key returns 401/403."""
        db = request.app.state.db
        # DB-first: use whatever the admin has saved (env only if DB empty).
        if not await soleaspay.resolve_api_key(db):
            return {"ok": False, "step": "config",
                    "detail": "Clé publique SoleasPay non configurée dans l'Admin Panel."}
        try:
            data = await soleaspay.verify_payment(db, "SPV-CONN-TEST", "test", service_id=1)
        except Exception as e:
            return {"ok": False, "step": "network", "detail": str(e)[:200]}
        code = data.get("code")
        if code in (401, 403):
            return {"ok": False, "step": "auth", "http": code, "detail": "Clé API SoleasPay refusée."}
        # 200 or 4xx-not-found = the API answered → key is valid, network OK.
        return {"ok": True, "http": code, "message": "Connexion SoleasPay OK",
                "countries_supported": len(soleaspay.SUPPORTED),
                "sample": {"status": data.get("status"), "code": code, "message": data.get("message")}}

    @router.put("/payment-gateways/country-matrix")
    async def admin_update_country_matrix(request: Request, admin=Depends(require_admin)):
        """Persist a per-gateway country toggle map:
           { "soleas": { "TG": true, "BJ": true, "CI": false, ... },
             "ashtec": { ... } }"""
        body = await request.json()
        matrix = body.get("country_matrix") or body
        if not isinstance(matrix, dict):
            raise HTTPException(400, "country_matrix doit être un dict.")
        db = request.app.state.db
        current = await _load_payment_gateway(db)
        current["country_matrix"] = matrix
        await db.app_settings.update_one(
            {"key": "payment_gateway"},
            {"$set": {
                "key": "payment_gateway",
                "value": current,
                "updated_at": datetime.now(timezone.utc),
                "updated_by": admin.get("username"),
            }},
            upsert=True,
        )
        return {"ok": True, "country_matrix": matrix}

    @router.put("/payment-gateways")
    async def admin_update_payment_gateways(
        body: PaymentGatewayUpdate, request: Request, admin=Depends(require_admin),
    ):
        db = request.app.state.db
        current = await _load_payment_gateway(db)
        new = dict(current)
        if body.active is not None:
            if body.active not in ("soleas", "ashtec"):
                raise HTTPException(400, "active must be 'soleas' or 'ashtec'")
            new["active"] = body.active
        if body.soleas_enabled is not None:
            new["soleas_enabled"] = bool(body.soleas_enabled)
        if body.ashtec_enabled is not None:
            new["ashtec_enabled"] = bool(body.ashtec_enabled)
        if body.ashtec_api_key is not None:
            key = body.ashtec_api_key.strip()
            if key == "DELETE":
                new["ashtec_api_key"] = ""
            elif key:
                new["ashtec_api_key"] = key
        if body.ashtec_user_id is not None:
            uid = body.ashtec_user_id.strip()
            if uid == "DELETE":
                new["ashtec_user_id"] = ""
            elif uid:
                new["ashtec_user_id"] = uid
        if body.ashtec_webhook_secret is not None:
            sec = body.ashtec_webhook_secret.strip()
            if sec == "DELETE":
                new["ashtec_webhook_secret"] = ""
            elif sec:
                new["ashtec_webhook_secret"] = sec
        if body.soleaspay_pout_enabled is not None:
            new["soleaspay_pout_enabled"] = bool(body.soleaspay_pout_enabled)
        if body.soleaspay_webhook_secret is not None:
            sec = body.soleaspay_webhook_secret.strip()
            if sec == "DELETE":
                new["soleaspay_webhook_secret"] = ""
            elif sec:
                new["soleaspay_webhook_secret"] = sec
        if body.soleaspay_webhook_hash is not None:
            h = body.soleaspay_webhook_hash.strip()
            if h == "DELETE":
                new["soleaspay_webhook_hash"] = ""
            elif h:
                new["soleaspay_webhook_hash"] = h
        if body.soleaspay_public_key is not None:
            k = body.soleaspay_public_key.strip()
            if k == "DELETE":
                new["soleaspay_public_key"] = ""
            elif k:
                new["soleaspay_public_key"] = k
        if body.soleaspay_secret_key is not None:
            k = body.soleaspay_secret_key.strip()
            if k == "DELETE":
                new["soleaspay_secret_key"] = ""
            elif k:
                new["soleaspay_secret_key"] = k
        # ── Biz-transPay ──
        if body.biztranspay_enabled is not None:
            new["biztranspay_enabled"] = bool(body.biztranspay_enabled)
        if body.biztranspay_payin_enabled is not None:
            new["biztranspay_payin_enabled"] = bool(body.biztranspay_payin_enabled)
        if body.biztranspay_payout_enabled is not None:
            new["biztranspay_payout_enabled"] = bool(body.biztranspay_payout_enabled)
        # v27s — public / secret keys (Integration API v1 dual-key auth).
        if body.biztranspay_public_key is not None:
            k = body.biztranspay_public_key.strip()
            if k == "DELETE":
                new["biztranspay_public_key"] = ""
            elif k:
                new["biztranspay_public_key"] = k
        if body.biztranspay_secret_key is not None:
            k = body.biztranspay_secret_key.strip()
            if k == "DELETE":
                new["biztranspay_secret_key"] = ""
                new["biztranspay_api_key"] = ""   # also clear legacy alias
            elif k:
                new["biztranspay_secret_key"] = k
                new["biztranspay_api_key"] = k     # keep legacy alias in sync
        # Legacy field — kept for backward compatibility with older clients.
        if body.biztranspay_api_key is not None:
            k = body.biztranspay_api_key.strip()
            if k == "DELETE":
                new["biztranspay_api_key"] = ""
                new["biztranspay_secret_key"] = ""
            elif k:
                new["biztranspay_api_key"] = k
                new["biztranspay_secret_key"] = k
        if body.biztranspay_webhook_secret is not None:
            s = body.biztranspay_webhook_secret.strip()
            if s == "DELETE":
                new["biztranspay_webhook_secret"] = ""
            elif s:
                new["biztranspay_webhook_secret"] = s
        if body.biztranspay_countries is not None:
            if isinstance(body.biztranspay_countries, dict):
                new["biztranspay_countries"] = body.biztranspay_countries
        # v27w — USDT.BEP20 crypto sub-toggle
        if body.biztranspay_crypto_enabled is not None:
            new["biztranspay_crypto_enabled"] = bool(body.biztranspay_crypto_enabled)
        # Allow any subset of gateways to be enabled — including none at all.
        act = new["active"]
        chain = [("soleas", new.get("soleas_enabled")),
                 ("ashtec", new.get("ashtec_enabled"))]
        active_enabled = next((en for k, en in chain if k == act), False)
        if not active_enabled:
            first_enabled = next((k for k, en in chain if en), None)
            if first_enabled:
                new["active"] = first_enabled
        await db.app_settings.update_one(
            {"key": "payment_gateway"},
            {"$set": {
                "key": "payment_gateway",
                "value": new,
                "updated_at": datetime.now(timezone.utc),
                "updated_by": admin.get("username"),
            }},
            upsert=True,
        )
        # v27j — re-sync the normalized `payment_providers` collections so
        # that the router immediately reflects the admin's toggle changes
        # (master, PayIn, PayOut, per-provider). Best-effort.
        try:
            from payment_providers import sync_providers as _sync_pp
            await _sync_pp(db)
        except Exception:
            pass
        return await admin_get_payment_gateways(request)

    # ─── v27j (Phase 2) — Router admin endpoints ────────────────────
    @router.get("/payment-providers")
    async def admin_list_providers(request: Request):
        """Return providers + countries + operators from the normalized
        collections (Phase 2 source of truth for the router)."""
        db = request.app.state.db
        providers = [p async for p in db.payment_providers.find({}, {"_id": 0}).sort("priority", 1)]
        for p in providers:
            p["countries"] = [
                c async for c in db.payment_provider_countries.find(
                    {"provider_id": p["id"]}, {"_id": 0}
                ).sort("country_code", 1)
            ]
            for c in p["countries"]:
                c["operators"] = [
                    o async for o in db.payment_provider_operators.find(
                        {"provider_id": p["id"], "country_code": c["country_code"]}, {"_id": 0}
                    ).sort("operator_code", 1)
                ]
        return {"providers": providers}

    @router.put("/payment-providers/{provider_id}/priority")
    async def admin_set_priority(provider_id: str, request: Request):
        body = await request.json()
        try:
            prio = int(body.get("priority"))
        except Exception:
            raise HTTPException(400, "priority must be an integer")
        from payment_router import set_priority
        ok = await set_priority(request.app.state.db, provider_id, prio)
        if not ok:
            raise HTTPException(404, "Provider not found")
        return {"ok": True, "priority": prio}

    @router.put("/payment-providers/{provider_id}/countries/{country_code}")
    async def admin_toggle_country(provider_id: str, country_code: str, request: Request):
        body = await request.json()
        enabled = bool(body.get("enabled"))
        from payment_router import toggle_country
        ok = await toggle_country(request.app.state.db, provider_id, country_code, enabled)
        if not ok:
            raise HTTPException(404, "Country not found for this provider")
        return {"ok": True, "enabled": enabled}

    @router.put("/payment-providers/{provider_id}/countries/{country_code}/mode")
    async def admin_set_country_mode(provider_id: str, country_code: str, request: Request):
        body = await request.json()
        mode = str(body.get("mode") or "").strip().lower()
        try:
            from payment_router import set_country_mode
            ok = await set_country_mode(request.app.state.db, provider_id, country_code, mode)
        except ValueError as ve:
            raise HTTPException(400, str(ve))
        if not ok:
            raise HTTPException(404, "Country not found for this provider")
        return {"ok": True, "mode": mode}

    @router.post("/activations/{reference}/validate-manual")
    async def admin_validate_manual_activation(reference: str, request: Request):
        """v27l (Phase 4) — validate a `pending_manual_review` payment
        created by the manual-mode dispatcher. Runs the same idempotent
        activation path as the automatic gateways."""
        db = request.app.state.db
        p = await db.payments.find_one({"reference": reference}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Paiement introuvable.")
        if p.get("activation_done"):
            return {"ok": True, "already_activated": True}
        if p.get("status") != "pending_manual_review":
            raise HTTPException(400, f"Ce paiement n'est pas en validation manuelle (status={p.get('status')}).")
        # Idempotent CAS: only proceed if activation_done is still not set.
        r = await db.payments.update_one(
            {"reference": reference, "activation_done": {"$ne": True}},
            {"$set": {"status": "paid", "manual_validated_at": datetime.now(timezone.utc),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        if r.modified_count == 0:
            return {"ok": True, "already_activated": True}
        try:
            await activate_level(db, p["user_id"], int(p.get("level") or 1),
                                 source="manual_review")
            await db.payments.update_one(
                {"reference": reference},
                {"$set": {"activation_done": True, "status": "validated"}},
            )
            return {"ok": True, "activated": True}
        except Exception as e:
            await db.payments.update_one(
                {"reference": reference},
                {"$set": {"activation_error": str(e)[:300]}},
            )
            raise HTTPException(500, f"Erreur activation: {e}")

    @router.post("/activations/{reference}/reject-manual")
    async def admin_reject_manual_activation(reference: str, request: Request):
        db = request.app.state.db
        body = await request.json()
        reason = str(body.get("reason") or "manual_rejected")[:300]
        r = await db.payments.update_one(
            {"reference": reference, "status": "pending_manual_review"},
            {"$set": {"status": "rejected", "rejected_reason": reason,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        if r.modified_count == 0:
            raise HTTPException(404, "Aucun paiement en attente manuelle avec cette référence.")
        return {"ok": True}

    @router.put("/payment-providers/{provider_id}/countries/{country_code}/operators/{operator_code}")
    async def admin_toggle_operator(
        provider_id: str, country_code: str, operator_code: str, request: Request,
    ):
        body = await request.json()
        enabled = bool(body.get("enabled"))
        from payment_router import toggle_operator
        ok = await toggle_operator(
            request.app.state.db, provider_id, country_code, operator_code, enabled,
        )
        if not ok:
            raise HTTPException(404, "Operator not found for this provider/country")
        return {"ok": True, "enabled": enabled}

    @router.get("/payment-router/logs")
    async def admin_router_logs(request: Request, limit: int = 50):
        db = request.app.state.db
        items = [
            l async for l in db.payment_router_logs.find({}, {"_id": 0})
            .sort("created_at", -1).limit(int(min(200, max(1, limit))))
        ]
        return {"items": items}

from pydantic import BaseModel, Field  # noqa: E402


def _new_order_id() -> str:
    return f"SPV-{uuid.uuid4().hex[:12].upper()}"


async def _record_payment_event(db, *, ref: str, new_status: str, payload: dict, source: str):
    await db.payments.update_one(
        {"reference": ref},
        {
            "$set": {
                "status": new_status,
                "updated_at": datetime.now(timezone.utc),
                "last_provider_payload": payload,
            },
            "$push": {
                "events": {
                    "status": new_status,
                    "source": source,
                    "received_at": datetime.now(timezone.utc),
                    "payload": payload,
                }
            },
        },
    )


@api.get("/payments/{reference}/status")
async def user_payment_status(reference: str, request: Request, user=Depends(get_current_user)):
    """User-facing status check + auto-activation.

    On each poll, if the payment is still `processing`/`pending`, we ACTIVELY
    re-verify against the gateway (SolesPay `verif-pay`) before returning.
    This eliminates the "stuck en attente" scenario caused by lost/rejected
    webhooks: even if no webhook ever arrives, the polling itself confirms
    the payment and triggers activation instantly.
    """
    db = request.app.state.db
    p = await db.payments.find_one({"reference": reference}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Paiement introuvable")
    if p.get("user_id") != user.get("id"):
        raise HTTPException(403, "Ce paiement n'appartient pas à votre compte")

    # ── Live re-verify for still-pending SolesPay payments ────────────────
    gw = p.get("gateway") or p.get("provider")
    current_status = str(p.get("status") or "").lower()
    if gw == "soleaspay" and current_status in ("processing", "pending"):
        pay_id = p.get("transaction_id") or p.get("provider_reference") or reference
        try:
            resp = await soleaspay.verify_payment(
                db, reference, pay_id, service_id=p.get("service_id", 1)
            )
            internal = soleaspay.normalize_status(
                resp.get("status") or "", resp.get("success"), resp.get("code")
            )
            if internal == "paid":
                await db.payments.update_one(
                    {"reference": reference, "activation_done": {"$ne": True}},
                    {"$set": {"status": "paid",
                              "updated_at": datetime.now(timezone.utc),
                              "poll_verified_at": datetime.now(timezone.utc)}},
                )
                # Reload freshly-updated doc
                p = await db.payments.find_one({"reference": reference}, {"_id": 0}) or p
            elif internal == "failed":
                await db.payments.update_one(
                    {"reference": reference},
                    {"$set": {"status": "rejected", "rejected_reason": "gateway_failed",
                              "updated_at": datetime.now(timezone.utc)}},
                )
                p = await db.payments.find_one({"reference": reference}, {"_id": 0}) or p
        except Exception as exc:
            log.warning("poll verify_payment failed ref=%s: %s", reference, exc)

    # v27h — Biz-transPay live status poll (same idea as soleaspay above).
    if gw == "biztranspay" and current_status in ("processing", "pending"):
        try:
            from biztranspay import _get_api_key as _btp_key, _get as _btp_get
            intent_id = p.get("provider_intent_id")
            key = await _btp_key(db)
            if intent_id and key:
                r = await _btp_get(f"/payments/{intent_id}/status", key)
                if r.status_code < 400:
                    jd = r.json()
                    remote = str(jd.get("status") or "").lower()
                    if remote == "paid":
                        await db.payments.update_one(
                            {"reference": reference, "activation_done": {"$ne": True}},
                            {"$set": {"status": "paid",
                                      "biztranspay_status": remote,
                                      "poll_verified_at": datetime.now(timezone.utc),
                                      "updated_at": datetime.now(timezone.utc)}},
                        )
                        p = await db.payments.find_one({"reference": reference}, {"_id": 0}) or p
                    elif remote == "failed":
                        await db.payments.update_one(
                            {"reference": reference},
                            {"$set": {"status": "rejected", "biztranspay_status": remote,
                                      "updated_at": datetime.now(timezone.utc)}},
                        )
                        p = await db.payments.find_one({"reference": reference}, {"_id": 0}) or p
        except Exception as exc:
            log.warning("poll biztranspay status failed ref=%s: %s", reference, exc)

    out = {
        "reference": reference,
        "status": p.get("status"),
        "level": p.get("level"),
        "activation_done": bool(p.get("activation_done")),
        "amount": p.get("amount"),
        "currency": p.get("currency"),
    }
    # ── Auto-activate any paid/validated payment that hasn't been activated
    #    yet (webhook lost, first-time hit, etc.).
    if (p.get("status") in ("paid", "validated")) and not p.get("activation_done"):
        try:
            # Resolve a WHITELISTED activation source for matrix.activate_level
            # (bug 2026-09-07 v7 — free-form strings like "poll_return" were
            # rejected by the security whitelist and silently blocked the
            # activation, leaving users in the ACTIVE-but-lvl-0 ghost state).
            gw_raw = str(p.get("gateway") or p.get("provider") or "").lower()
            _WL = {"soleaspay", "ashtecpay", "sendavapay", "izichange", "biztranspay"}
            src = gw_raw if gw_raw in _WL else "gateway_return"
            await activate_level(db, p["user_id"], int(p.get("level") or 1), source=src)
            await db.payments.update_one(
                {"reference": reference},
                {"$set": {"activation_done": True, "status": "validated",
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            out["status"] = "validated"
            out["activation_done"] = True
            out["activated_now"] = True
            log.info("ACTIVATION_COMPLETED source=poll user=%s ref=%s level=%s",
                     p["user_id"], reference, p.get("level"))
        except Exception as exc:
            log.exception("ACTIVATION_FAILED source=poll ref=%s: %s", reference, exc)
            out["activation_error"] = str(exc)
    return out


# ────────────────────────────────────────────────────────────────────────
# SoleasPay webhook — HMAC-SHA256 signed, idempotent, activates payments.
# ────────────────────────────────────────────────────────────────────────
import hmac as _hmac
import hashlib as _hashlib
import json as _json


async def _soleaspay_webhook_secret(db) -> str:
    """Legacy alias — resolves the HMAC secret from env or DB config."""
    return await soleaspay.resolve_webhook_secret(db)


async def pick_gateway_for_country(db, country: str) -> Optional[str]:
    """Cascade based on admin's `active` preference AND per-gateway coverage.

    v27j (Phase 2) — délègue au PaymentProviderRouter qui lit les
    collections normalisées `payment_providers` + `payment_provider_countries`.
    Le legacy `country_matrix` reste consulté en fallback si le router
    ne trouve aucun candidat (garde-fou pour les installations anciennes
    qui n'ont pas encore synchronisé les collections).
    """
    country = (country or "").upper()

    # v27j — router path (Phase 2). Any router exception falls back to the
    # legacy cascade below so we never regress a working payment flow.
    try:
        from payment_router import pick_provider, log_decision
        result = await pick_provider(db, kind="payin", country=country)
        pid = (result or {}).get("provider_id")
        await log_decision(db, kind="payin", country=country, operator=None, result=result)
        if pid:
            # Legacy dispatcher name mapping (router uses full names like
            # "soleaspay", legacy /payments/activate branches on short names).
            _LEGACY_ALIAS = {"soleaspay": "soleas"}
            return _LEGACY_ALIAS.get(pid, pid)
    except Exception as e:
        log.warning("payment_router pick_provider (payin) failed: %s", e)

    # Legacy cascade (kept as safety net — will be removed in Phase 4).
    cfg = await _load_payment_gateway(db)
    matrix = cfg.get("country_matrix") or {}
    active = cfg.get("active") or "soleas"

    # Biz-transPay TG override (legacy — router already handled this above).
    if country == "TG" and cfg.get("biztranspay_enabled") \
            and cfg.get("biztranspay_payin_enabled", True):
        api_key_ok = bool((cfg.get("biztranspay_api_key") or "").strip()
                          or (os.environ.get("BIZTRANSPAY_API_KEY") or "").strip())
        if api_key_ok:
            return "biztranspay"

    order = [active] + [g for g in ("soleas", "ashtec") if g != active]

    # Pre-load Ashtec coverage lazily.
    _ashtec_countries = None
    def _ashtec_supports(cc: str) -> bool:
        nonlocal _ashtec_countries
        if _ashtec_countries is None:
            try:
                from ashtec_activation import COUNTRIES as _AC  # type: ignore
                _ashtec_countries = set(_AC.keys())
            except Exception:
                _ashtec_countries = set()
        return cc in _ashtec_countries

    for gw in order:
        if not bool(cfg.get(f"{gw}_enabled")):
            continue
        gw_matrix = matrix.get(gw) or {}
        if country in gw_matrix and gw_matrix[country] is False:
            continue
        # NEW — coverage check: don't route to a gateway that has no operator
        # mapping for this country (otherwise activate() throws 400 later).
        if gw == "soleas":
            if country in soleaspay.EXCLUDED_COUNTRIES or country not in soleaspay.SUPPORTED:
                continue
        elif gw == "ashtec":
            if not _ashtec_supports(country):
                continue
        return gw
    return None


async def pick_payout_gateway_for_country(db, country: str) -> Optional[str]:
    """Return the P-Out gateway to use for a given country, or None.

    v27j (Phase 2) — délègue au PaymentProviderRouter. Fallback legacy si le
    router échoue.
    """
    country = (country or "").upper()

    try:
        from payment_router import pick_provider, log_decision
        result = await pick_provider(db, kind="payout", country=country)
        pid = (result or {}).get("provider_id")
        await log_decision(db, kind="payout", country=country, operator=None, result=result)
        if pid:
            _LEGACY_ALIAS = {"soleaspay": "soleaspay"}  # payout uses full name
            return _LEGACY_ALIAS.get(pid, pid)
    except Exception as e:
        log.warning("payment_router pick_provider (payout) failed: %s", e)

    # Legacy cascade
    cfg = await _load_payment_gateway(db)
    # Biz-transPay first (TG only, requires payout switch ON + api key).
    if country == "TG" and cfg.get("biztranspay_enabled") and cfg.get("biztranspay_payout_enabled"):
        if (cfg.get("biztranspay_api_key") or "").strip() \
                or (os.environ.get("BIZTRANSPAY_API_KEY") or "").strip():
            return "biztranspay"
    if (cfg.get("soleas_enabled")
            and cfg.get("soleaspay_pout_enabled")
            and country in soleaspay.SUPPORTED):
        pout_matrix = cfg.get("soleaspay_pout_country_matrix") or {}
        if not (country in pout_matrix and pout_matrix[country] is False):
            return "soleaspay"
    return None


@api.post("/webhooks/soleaspay")
async def soleaspay_webhook(request: Request):
    db = request.app.state.db
    raw = await request.body()
    hmac_secret = await soleaspay.resolve_webhook_secret(db)
    webhook_hash = await soleaspay.resolve_webhook_hash(db)
    try:
        event = _json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(400, "Payload invalide.")
    ok, method_used = soleaspay.verify_webhook_hybrid(
        raw_body=raw, event=event, headers=dict(request.headers),
        hmac_secret=hmac_secret, webhook_hash=webhook_hash,
    )
    if not ok:
        raise HTTPException(401, "Signature invalide.")
    data = event.get("data") if isinstance(event.get("data"), dict) else event
    event_id = event.get("id") or event.get("event_id") or data.get("event_id") or data.get("reference")
    order_id = data.get("order_id") or data.get("orderId") or data.get("reference")
    status_raw = str(data.get("status") or event.get("status") or "").upper()
    operation = str(data.get("operation") or event.get("operation") or "").upper()
    if event_id and await db.soleaspay_webhook_events.find_one({"event_id": event_id}):
        return {"received": True, "idempotent": True}
    if not order_id:
        await db.soleaspay_webhook_events.insert_one({
            "event_id": event_id, "raw": event, "verify_method": method_used,
            "at": datetime.now(timezone.utc), "ignored": "no_order_id"})
        return {"received": True, "ignored": "no_order_id"}

    # ── Pay-OUT branch ────────────────────────────────────────────────────
    # SoleasPay withdraw responses/callbacks carry operation="WITHDRAW". Route
    # them to the payout reconciler and return early.
    if operation == "WITHDRAW" or await db.soleaspay_payouts.find_one(
            {"$or": [{"wd_id": order_id}, {"provider_reference": order_id}]}):
        payout_row = await db.soleaspay_payouts.find_one(
            {"$or": [{"wd_id": order_id}, {"provider_reference": order_id}]})
        outcome = None
        if payout_row:
            from soleaspay import apply_payout_webhook
            outcome = await apply_payout_webhook(db, payout_row, status_raw, data)
        await db.soleaspay_webhook_events.insert_one({
            "event_id": event_id, "raw": event, "order_id": order_id,
            "operation": "WITHDRAW", "status": status_raw,
            "handled": bool(outcome and outcome.get("handled")),
            "outcome": (outcome or {}).get("outcome"),
            "at": datetime.now(timezone.utc)})
        return {"received": True, "type": "payout",
                "handled": bool(outcome and outcome.get("handled")),
                "outcome": (outcome or {}).get("outcome"), "status": status_raw}

    # Look up the payment intent — first by our internal reference (order_id),
    # then by SolesPay's OWN reference stored as `provider_reference` when we
    # initiated the payment. This closes the "webhook came back with MLS-xxx
    # instead of our SPV-xxx" gap that was silently blocking activation.
    pay = await db.payments.find_one(
        {"$or": [{"reference": order_id}, {"provider_reference": order_id}]}
    )
    if not pay:
        await db.soleaspay_webhook_events.insert_one({
            "event_id": event_id, "raw": event, "order_id": order_id,
            "at": datetime.now(timezone.utc), "ignored": "unknown_order"})
        return {"received": True, "unknown_order": True}
    lookup_ref = pay["reference"]  # our internal ref (source of truth)
    amt = data.get("amount")
    if amt is not None:
        try:
            if int(float(amt)) != int(float(pay.get("amount", 0))):
                await db.soleaspay_webhook_events.insert_one({
                    "event_id": event_id, "raw": event, "order_id": order_id,
                    "at": datetime.now(timezone.utc), "rejected": "amount_mismatch"})
                return {"received": True, "rejected": "amount_mismatch"}
        except Exception:
            pass
    activated = False
    if status_raw in ("SUCCESS", "SUCCEEDED", "COMPLETED", "PAID", "VALIDATED"):
        upd = await db.payments.update_one(
            {"reference": lookup_ref, "activation_done": {"$ne": True}},
            {"$set": {"status": "paid", "updated_at": datetime.now(timezone.utc),
                      "webhook_at": datetime.now(timezone.utc), "webhook_raw": event,
                      "provider_reference": data.get("reference") or pay.get("provider_reference")}},
        )
        if upd.modified_count > 0:
            try:
                # Resolve WHITELISTED source (bug v7 — matrix.activate_level
                # rejects free-form strings like f"webhook:{ref}").
                gw_raw = str(pay.get("gateway") or pay.get("provider") or "").lower()
                _WL = {"soleaspay", "ashtecpay", "sendavapay", "izichange", "biztranspay"}
                src = gw_raw if gw_raw in _WL else "gateway_return"
                await activate_level(db, pay["user_id"], int(pay.get("level") or 1), source=src)
                await db.payments.update_one(
                    {"reference": lookup_ref},
                    {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
                )
                activated = True
            except Exception as e:
                await db.payments.update_one(
                    {"reference": lookup_ref}, {"$set": {"activation_error": str(e)}})
    else:
        await db.payments.update_one(
            {"reference": lookup_ref},
            {"$set": {"status": status_raw.lower() or "pending",
                      "webhook_at": datetime.now(timezone.utc), "webhook_raw": event,
                      "updated_at": datetime.now(timezone.utc)}},
        )
    await db.soleaspay_webhook_events.insert_one({
        "event_id": event_id, "raw": event, "order_id": order_id,
        "resolved_reference": lookup_ref,
        "status": status_raw, "activated": activated,
        "at": datetime.now(timezone.utc)})
    return {"received": True, "activated": activated, "status": status_raw}


@api.get("/admin/payment-gateways/webhook-events")
async def admin_list_webhook_events(request: Request, admin=Depends(require_admin), limit: int = 50):
    rows = await request.app.state.db.soleaspay_webhook_events.find(
        {}, {"_id": 0}
    ).sort("at", -1).limit(min(200, max(1, limit))).to_list(length=None)
    return {"events": rows}


@api.get("/admin/payment-gateways/route-check")
async def admin_route_check(request: Request, country: str, admin=Depends(require_admin)):
    db = request.app.state.db
    cc = country.upper()
    gw_in = await pick_gateway_for_country(db, cc)
    gw_out = await pick_payout_gateway_for_country(db, cc)
    return {
        "country": cc,
        "gateway": gw_in, "available": gw_in is not None,   # legacy alias
        "payin_gateway": gw_in,
        "payout_gateway": gw_out,
    }


class SoleaspayPoutMatrixIn(_PGBaseModel):
    matrix: dict


@api.put("/admin/payment-gateways/soleaspay/pout-country-matrix")
async def admin_set_soleaspay_pout_matrix(
    body: SoleaspayPoutMatrixIn, request: Request, admin=Depends(require_admin),
):
    """Persist the per-country P-Out toggle map for SoleasPay.

    Payload: {"matrix": {"TG": true, "BJ": true, "CI": false, ...}}
    """
    db = request.app.state.db
    if not isinstance(body.matrix, dict):
        raise HTTPException(400, "matrix doit être un dict.")
    # Coerce values to bool + uppercase country codes.
    clean: dict = {}
    for k, v in body.matrix.items():
        if not isinstance(k, str):
            continue
        clean[k.upper()] = bool(v)
    current = await _load_payment_gateway(db)
    current["soleaspay_pout_country_matrix"] = clean
    await db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"key": "payment_gateway", "value": current,
                  "updated_at": datetime.now(timezone.utc),
                  "updated_by": admin.get("username")}},
        upsert=True,
    )
    return {"ok": True, "matrix": clean}


# ═══════════════════════════════════════════════════════════════════════
# SolesPay — ISOLATED admin surface (⚙️ Réglages → SolesPay)
# All /admin/soleaspay/* routes read/write ONLY SoleasPay-scoped keys from
# the shared `payment_gateway` doc. Other gateways (Ashtec/BizTransPay) are
# never touched by these endpoints.
# ═══════════════════════════════════════════════════════════════════════

def _mask(secret: str) -> str:
    s = (secret or "").strip()
    if not s:
        return ""
    if len(s) <= 6:
        return "•" * len(s)
    return s[:3] + "•" * max(4, len(s) - 6) + s[-3:]


@api.get("/admin/soleaspay/config")
async def admin_get_soleaspay_config(request: Request, admin=Depends(require_admin)):
    """Return SoleasPay's isolated config. Secrets are masked in the response
    (except for the country matrix). Priority: DB wins over env — the admin
    panel value is the source of truth."""
    db = request.app.state.db
    cfg = await _load_payment_gateway(db)
    matrix_all = cfg.get("country_matrix") or {}
    soleas_matrix = matrix_all.get("soleas") or {}
    # Countries default to True when missing from the matrix.
    resolved = {cc: (soleas_matrix.get(cc, True) is not False)
                for cc in soleaspay.SUPPORTED.keys()}

    # DB-first, env-fallback for the "set / display" fields.
    def _resolve(db_key: str, env_key: str) -> tuple[str, str]:
        db_val = (cfg.get(db_key) or "").strip()
        if db_val:
            return db_val, "db"
        env_val = (os.environ.get(env_key) or "").strip()
        if env_val:
            return env_val, "env"
        return "", ""

    pub, pub_src = _resolve("soleaspay_public_key", "SOLEASPAY_API_KEY")
    sec, sec_src = _resolve("soleaspay_secret_key", "SOLEASPAY_PRIVATE_KEY")
    wh, wh_src = _resolve("soleaspay_webhook_hash", "SOLEASPAY_WEBHOOK_HASH")
    ws, ws_src = _resolve("soleaspay_webhook_secret", "SOLEASPAY_WEBHOOK_SECRET")

    return {
        "enabled": bool(cfg.get("soleas_enabled")),
        "public_key": _mask(pub), "public_key_set": bool(pub), "public_key_source": pub_src,
        "secret_key": _mask(sec), "secret_key_set": bool(sec), "secret_key_source": sec_src,
        "webhook_hash": _mask(wh), "webhook_hash_set": bool(wh), "webhook_hash_source": wh_src,
        "webhook_secret": _mask(ws), "webhook_secret_set": bool(ws), "webhook_secret_source": ws_src,
        "countries": [{"code": cc, "enabled": resolved[cc],
                       "operators": [{"id": s["id"], "label": s["label"], "currency": s["currency"]}
                                     for s in soleaspay.SUPPORTED[cc]]}
                      for cc in sorted(soleaspay.SUPPORTED.keys())],
        # P-Out cluster (kept side-by-side, same section).
        "pout_enabled": bool(cfg.get("soleaspay_pout_enabled")),
        "pout_country_matrix": cfg.get("soleaspay_pout_country_matrix") or {},
    }


class SoleaspayConfigIn(_PGBaseModel):
    enabled: Optional[bool] = None
    public_key: Optional[str] = None       # "" no-op, "DELETE" clears, other = set
    secret_key: Optional[str] = None
    webhook_hash: Optional[str] = None
    webhook_secret: Optional[str] = None
    pout_enabled: Optional[bool] = None


@api.put("/admin/soleaspay/config")
async def admin_set_soleaspay_config(
    body: SoleaspayConfigIn, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    current = await _load_payment_gateway(db)
    new = dict(current)
    if body.enabled is not None:
        new["soleas_enabled"] = bool(body.enabled)
    for src_field, dst_field in [
        ("public_key", "soleaspay_public_key"),
        ("secret_key", "soleaspay_secret_key"),
        ("webhook_hash", "soleaspay_webhook_hash"),
        ("webhook_secret", "soleaspay_webhook_secret"),
    ]:
        v = getattr(body, src_field)
        if v is None:
            continue
        s = v.strip()
        if s == "DELETE":
            new[dst_field] = ""
        elif s:
            new[dst_field] = s
    if body.pout_enabled is not None:
        new["soleaspay_pout_enabled"] = bool(body.pout_enabled)
    await db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"key": "payment_gateway", "value": new,
                  "updated_at": datetime.now(timezone.utc),
                  "updated_by": admin.get("username")}},
        upsert=True,
    )
    await _invalidate_soleaspay_caches()
    return await admin_get_soleaspay_config(request, admin)


async def _invalidate_soleaspay_caches():
    """Called after any admin config PUT so subsequent calls pick up new keys."""
    try:
        soleaspay.invalidate_bearer_cache()
    except Exception:
        pass


class SoleaspayCountryMatrixIn(_PGBaseModel):
    matrix: dict


@api.put("/admin/soleaspay/country-matrix")
async def admin_set_soleaspay_country_matrix(
    body: SoleaspayCountryMatrixIn, request: Request, admin=Depends(require_admin),
):
    """Persist per-country PAY-IN toggle for SoleasPay only.

    Payload: {"matrix": {"TG": true, "BJ": false, ...}}.
    Missing countries default to enabled. Values coerced to bool. Codes upper.
    """
    db = request.app.state.db
    if not isinstance(body.matrix, dict):
        raise HTTPException(400, "matrix doit être un dict.")
    clean: dict = {}
    for k, v in body.matrix.items():
        if not isinstance(k, str):
            continue
        clean[k.upper()] = bool(v)
    current = await _load_payment_gateway(db)
    country_matrix = dict(current.get("country_matrix") or {})
    country_matrix["soleas"] = clean
    current["country_matrix"] = country_matrix
    await db.app_settings.update_one(
        {"key": "payment_gateway"},
        {"$set": {"key": "payment_gateway", "value": current,
                  "updated_at": datetime.now(timezone.utc),
                  "updated_by": admin.get("username")}},
        upsert=True,
    )
    return {"ok": True, "matrix": clean}


@api.post("/admin/soleaspay/test")
async def admin_soleaspay_test(request: Request, admin=Depends(require_admin)):
    """Ping SoleasPay verif-pay with a dummy order to validate credentials."""
    db = request.app.state.db
    key = await soleaspay.resolve_api_key(db)
    if not key:
        return {"ok": False, "error": "no_api_key",
                "detail": "Clé publique SoleasPay non configurée."}
    try:
        # Send a benign verify with garbage IDs to check auth reachability.
        # Any 2xx / 4xx (except 401) means credentials are OK.
        r = await soleaspay.verify_payment(db, order_id="TEST-PING", pay_id="TEST-PING")
        code = r.get("code")
        msg = r.get("message") or ""
        if code == 401 or "unauthorized" in msg.lower() or "invalid api key" in msg.lower():
            return {"ok": False, "error": "auth", "detail": "Clé publique refusée par SoleasPay.",
                    "sample": r}
        return {"ok": True, "detail": "Clé publique acceptée. La passerelle répond.",
                "sample": r, "countries_supported": len(soleaspay.SUPPORTED)}
    except Exception as e:
        return {"ok": False, "error": "network", "detail": str(e)[:200]}

def _normalize_wallet_for_soleaspay(country: str, phone: str) -> str:
    """Normalize a wallet number to the format SolesPay expects per country.

    Rules discovered from operator flows:
      - Strip spaces, dashes, parentheses, leading zeros, leading '+'.
      - If the number does NOT already start with the country's dial code,
        prepend it. This fixes activations that were silently rejected because
        we sent e.g. '90123456' where SolesPay wanted '22890123456'.
      - Keep only digits.
    """
    DIAL = {"TG": "228", "BJ": "229", "CI": "225", "BF": "226",
            "CM": "237", "COG": "242", "GAB": "241", "UGA": "256",
            "SN": "221", "ML": "223", "NE": "227"}
    p = "".join(ch for ch in (phone or "") if ch.isdigit())
    p = p.lstrip("0")
    dc = DIAL.get((country or "").upper(), "")
    if dc and not p.startswith(dc):
        p = dc + p
    return p


# ═══════════════════════════════════════════════════════════════════════
# SolesPay reconciliation background task — safety net for lost webhooks.
# Every 60s, re-verify every "processing" payment older than 90s via the
# verif-pay endpoint. When SolesPay confirms SUCCESS, we activate the user
# even if the webhook never arrived (or was rejected due to bad signature).
# ═══════════════════════════════════════════════════════════════════════

async def _soleaspay_reconcile_once(db) -> dict:
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    now = _dt.now(_tz.utc)
    cutoff = now - _td(seconds=90)
    expiration_cutoff = now - _td(minutes=30)
    stale_cutoff = now - _td(hours=24)  # older than 24h → give up

    # ── Step 1: verify all still-processing payments against the gateway.
    # Ashtec stores its ID in `provider` while SolesPay uses `gateway` — cover
    # BOTH field names or Ashtec payments never get reconciled.
    cur = db.payments.find({
        "$or": [
            {"gateway": {"$in": ["soleaspay", "ashtecpay"]}},
            {"provider": {"$in": ["soleaspay", "ashtecpay"]}},
        ],
        "status": {"$in": ["processing", "pending"]},
        "activation_done": {"$ne": True},
        "created_at": {"$lt": cutoff, "$gt": stale_cutoff},
    }).limit(50)
    checked = activated = expired = 0
    async for p in cur:
        checked += 1
        gw = p.get("gateway") or p.get("provider")
        pay_id = p.get("transaction_id") or p.get("provider_reference") or p["reference"]
        internal = None
        try:
            if gw == "soleaspay":
                resp = await soleaspay.verify_payment(
                    db, p["reference"], pay_id, service_id=p.get("service_id", 1)
                )
                internal = soleaspay.normalize_status(
                    resp.get("status") or "", resp.get("success"), resp.get("code")
                )
            elif gw == "ashtecpay":
                from ashtec_activation import _get_api_key as _ash_key  # type: ignore
                ak = await _ash_key(db)
                if ak and p.get("transaction_id"):
                    import ashtecpay as _ash  # type: ignore
                    resp = await _ash.verify_payment(api_key=ak, transaction_id=p["transaction_id"])
                    internal = _ash.normalize_status(resp.get("status") or "")
                else:
                    resp = {}
        except Exception as e:
            log.warning("reconcile: verify failed gw=%s ref=%s err=%s",
                        gw, p["reference"], e)
            continue

        if internal == "paid":
            upd = await db.payments.update_one(
                {"reference": p["reference"], "activation_done": {"$ne": True}},
                {"$set": {"status": "paid", "updated_at": now,
                          "reconcile_at": now, "reconcile_response": resp}},
            )
            if upd.modified_count > 0:
                try:
                    # Resolve WHITELISTED source (bug v7 — matrix.activate_level
                    # rejects free-form strings like f"reconcile:{ref}").
                    gw_raw = str(p.get("gateway") or p.get("provider") or "").lower()
                    _WL = {"soleaspay", "ashtecpay", "sendavapay", "izichange", "biztranspay"}
                    src = gw_raw if gw_raw in _WL else "gateway_return"
                    await activate_level(db, p["user_id"], int(p.get("level") or 1),
                                         source=src)
                    # NOTE: do NOT pre-flip `user.status` to "active" here —
                    # activate_level does both max_level AND status in a
                    # single atomic $set. Splitting them caused the
                    # "ACTIVE but max_level=0" ghost state when activate_level
                    # raised afterwards (bug 2026-09-07 v4).
                    await db.payments.update_one(
                        {"reference": p["reference"]},
                        {"$set": {"activation_done": True, "status": "validated"},
                         "$unset": {"activation_error": ""}},
                    )
                    activated += 1
                    log.info("reconcile: activated user=%s ref=%s gw=%s",
                             p["user_id"], p["reference"], gw)
                except Exception as e:
                    await db.payments.update_one(
                        {"reference": p["reference"]},
                        {"$set": {"activation_error": str(e)[:300]}},
                    )
        elif internal == "failed":
            await db.payments.update_one(
                {"reference": p["reference"]},
                {"$set": {"status": "rejected", "updated_at": now,
                          "rejected_reason": "gateway_failed",
                          "reconcile_at": now}},
            )

    # ── Step 2: expire pending payments older than 30 minutes (Ashtec + Soleas).
    exp_res = await db.payments.update_many(
        {"$or": [
            {"gateway": {"$in": ["soleaspay", "ashtecpay"]}},
            {"provider": {"$in": ["soleaspay", "ashtecpay"]}},
         ],
         "status": {"$in": ["processing", "pending"]},
         "activation_done": {"$ne": True},
         "created_at": {"$lt": expiration_cutoff}},
        {"$set": {"status": "expired", "updated_at": now,
                  "rejected_reason": "timeout_30min",
                  "expired_at": now}},
    )
    expired = exp_res.modified_count
    if expired > 0:
        log.info("reconcile: expired %d stale activations after 30 min", expired)
    return {"checked": checked, "activated": activated, "expired": expired}


# ═══════════════════════════════════════════════════════════════════════
# Unified admin activation tracker — same status buckets for ALL gateways.
# ═══════════════════════════════════════════════════════════════════════

@api.get("/admin/activations/unified")
async def admin_list_activations_unified(
    request: Request, admin=Depends(require_admin),
    bucket: str = "pending", limit: int = 100,
):
    """Return activations grouped by unified status bucket:
       - `pending`   → paiement lancé, non confirmé, non expiré (< 30 min)
       - `validated` → paiement confirmé + compte activé
       - `rejected`  → refusé, échoué, ou expiré à 30 min

    Aggregates SolesPay + AshtecPay (any auto gateway). Sorted newest first.
    """
    db = request.app.state.db
    # Ashtec uses `provider`, SolesPay uses `gateway` — cover BOTH.
    gw_filter = {"$or": [
        {"gateway": {"$in": ["soleaspay", "ashtecpay"]}},
        {"provider": {"$in": ["soleaspay", "ashtecpay"]}},
    ]}
    q_map = {
        "pending":   {**gw_filter, "status": {"$in": ["processing", "pending"]},
                      "activation_done": {"$ne": True}},
        "validated": {**gw_filter, "activation_done": True},
        "rejected":  {**gw_filter, "status": {"$in": ["failed", "rejected", "expired"]}},
    }
    q = q_map.get(bucket, q_map["pending"])
    rows = await db.payments.find(q, {"_id": 0}).sort("created_at", -1).limit(min(500, max(1, limit))).to_list(length=None)
    return {"bucket": bucket, "count": len(rows), "items": rows}


@api.post("/admin/activations/reconcile")
async def admin_activations_reconcile(request: Request, admin=Depends(require_admin)):
    """Manual sweep — verify pending, activate paid, expire >30min."""
    db = request.app.state.db
    r = await _soleaspay_reconcile_once(db)
    return {"ok": True, **r}





async def _soleaspay_reconciliation_loop(db):
    import asyncio as _a
    while True:
        try:
            r = await _soleaspay_reconcile_once(db)
            if r["activated"] > 0:
                log.info("SolesPay reconciliation: %s", r)
        except Exception as e:
            log.exception("SolesPay reconciliation loop error: %s", e)
        await _a.sleep(60)


@api.post("/admin/soleaspay/reconcile")
async def admin_soleaspay_reconcile(request: Request, admin=Depends(require_admin)):
    """Manual trigger: sweep all processing SolesPay payments now."""
    db = request.app.state.db
    r = await _soleaspay_reconcile_once(db)
    return {"ok": True, **r}


class ActivateIn(_PGBaseModel):
    method: str                     # "mobile" | "crypto"
    country: Optional[str] = None   # required for mobile
    operator: Optional[str] = None  # required for mobile — service_id (as string)
    phone: Optional[str] = None     # required for mobile
    # v27w (2026-02-24) — optional crypto provider selector: "izichange" (default)
    # or "biztranspay". Only read when method == "crypto".
    provider: Optional[str] = None
    # v27az (2026-03-05) — Orange BF deposit requires an OTP generated by
    # the user via `*144*4*6*{amount}#`. When the frontend re-submits with
    # the OTP code, we forward it to Biz-transPay.
    otp: Optional[str] = None


@api.post("/payments/activate")
async def payments_activate(
    body: ActivateIn, request: Request, user=Depends(get_current_user),
):
    """Server-side routing: given {method, country, operator, phone} the
    backend picks the correct gateway and calls its `initiate` handler.

    v27k (2026-02-14) — password confirm removed from the UX per product
    request. Auth is still enforced (JWT via `get_current_user`), and the
    real activation only happens after webhook confirmation of the actual
    payment. Removing the extra password prompt does not weaken this.
    """
    db = request.app.state.db
    method = (body.method or "").lower().strip()
    if method not in ("mobile", "crypto"):
        raise HTTPException(400, "Méthode invalide (mobile | crypto).")
    if user.get("max_level", 0) >= 1:
        raise HTTPException(400, "Votre niveau 1 est déjà activé.")

    # ── CRYPTO ── delegated to IziChangePay OR Biz-transPay (v27w).
    # The user can force a specific crypto provider via `provider` in the
    # body (frontend picks it based on the operator card tapped). If not
    # provided, we default to izichange for backward-compat.
    if method == "crypto":
        wanted_provider = (getattr(body, "provider", None) or "izichange").lower()
        if wanted_provider == "biztranspay":
            try:
                from biztranspay import biztranspay_crypto_create, BtpCryptoCreate
                r = await biztranspay_crypto_create(BtpCryptoCreate(level=1), request, user)
                return {
                    "reference": r.get("reference"),
                    "gateway": "biztranspay", "method": "crypto",
                    "status": "processing",
                    "deposit_address": r.get("deposit_address"),
                    "qr_data": r.get("qr_data") or r.get("deposit_address"),
                    "amount": r.get("amount_to_send") or r.get("amount"),
                    "asset_code": r.get("asset_code") or "USDT.BEP20",
                    "network": r.get("network") or "BEP20",
                    "memo": r.get("memo"),
                    "expires_at": r.get("expires_at"),
                }
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(503, f"Biz-transPay Crypto indisponible : {e}")
        try:
            from izichange import create_crypto_charge, CryptoCreate as _IziCryptoCreate
            r = await create_crypto_charge(_IziCryptoCreate(level=1), request, user)
            # Normalize the response to the pay.tsx contract.
            return {
                "reference": r.get("reference"),
                "gateway": "izichange", "method": "crypto",
                "status": "processing",
                "deposit_address": r.get("deposit_address"),
                "qr_data": r.get("deposit_address"),
                "amount": r.get("amount_to_send"),
                "asset_code": r.get("coin"),
                "network": r.get("network"),
                "memo": r.get("memo"),
                "expires_at": r.get("expires_at"),
            }
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(503, f"Passerelle Crypto indisponible : {e}")

    # ── MOBILE ── SoleasPay → Ashtec cascade.
    cc = (body.country or "").upper().strip()
    op = (body.operator or "").strip()
    phone = (body.phone or "").strip()
    if not cc or not op or not phone:
        raise HTTPException(400, "Pays, opérateur et numéro requis.")
    gw = await pick_gateway_for_country(db, cc)
    try:
        from biztranspay import is_payin_enabled as _btp_on
        from btp_catalog import find_entry as _btp_find
        if await _btp_on(db) and await _btp_find(db, "deposit", cc, op):
            gw = "biztranspay"
    except Exception as _e:
        log.warning("btp routing check failed: %s", _e)
    if not gw:
        raise HTTPException(400, "Aucun opérateur de paiement disponible pour ce pays.")

    # v27l (Phase 4) — Manual mode dispatch.
    # If the router picked a provider whose country_row.mode == "manual",
    # we DO NOT hit the gateway. We create a `pending_manual_review`
    # payment doc that admin then validates from the Activations tab.
    try:
        from payment_router import pick_provider as _pp
        _routed = await _pp(db, kind="payin", country=cc, operator=op)
        _mode = (_routed or {}).get("mode") or "automatic"
        _routed_pid = (_routed or {}).get("provider_id")
    except Exception:
        _mode = "automatic"
        _routed_pid = None
    if _mode == "manual" and _routed_pid:
        order_id = _new_order_id()
        now = datetime.now(timezone.utc)
        amount = _mobile_activation_amount("XOF")
        await db.payments.insert_one({
            "reference": order_id, "user_id": user["id"], "username": user["username"],
            "email": user["email"], "level": 1, "amount": amount, "currency": "XOF",
            "gateway": _routed_pid, "provider": _routed_pid,
            "country": cc, "operator": op, "phone": phone,
            "manual_mode": True,
            "status": "pending_manual_review",
            "created_at": now, "updated_at": now,
        })
        return {"reference": order_id, "gateway": _routed_pid,
                "method": "mobile", "status": "pending_manual_review",
                "manual": True,
                "message": "Paiement en attente de validation manuelle par l'administration."}

    if gw == "soleas":
        # For SoleasPay `operator` is the service_id.
        try:
            svc_id = int(op)
        except Exception:
            raise HTTPException(400, "Opérateur invalide.")
        svc = soleaspay.find_service(cc, svc_id)
        if not svc:
            raise HTTPException(400, "Opérateur non disponible pour ce pays chez SoleasPay.")
        order_id = _new_order_id()
        # v20 (2026-02-14) — Level 1 mobile-money activation is now 2 650
        # FCFA (bump from 2 500). Crypto path (5 USDT) is unchanged.
        amount = _mobile_activation_amount(svc["currency"])
        currency = svc["currency"]
        now = datetime.now(timezone.utc)
        # Persist payment intent BEFORE calling provider to close idempotency gap.
        await db.payments.insert_one({
            "reference": order_id, "user_id": user["id"], "username": user["username"],
            "email": user["email"], "level": 1, "amount": amount, "currency": currency,
            "gateway": "soleaspay", "service_id": svc_id, "country": cc,
            "operator_label": svc["label"], "phone": phone,
            "status": "processing", "created_at": now, "updated_at": now,
        })
        try:
            resp = await soleaspay.initiate_payment(
                db,
                service_id=svc_id, wallet=_normalize_wallet_for_soleaspay(cc, phone),
                amount=amount, currency=currency,
                order_id=order_id,
                description=f"Activation niveau 1 - {user['username']}",
                payer=user.get("full_name") or user["username"],
                payer_email=user["email"],
                success_url=f"{os.environ.get('PUBLIC_APP_URL', '')}/(app)/services?ref={order_id}",
                failure_url=f"{os.environ.get('PUBLIC_APP_URL', '')}/(app)/services?ref={order_id}",
            )
        except Exception as e:
            await db.payments.update_one({"reference": order_id},
                                          {"$set": {"status": "failed", "error": str(e)[:300]}})
            raise HTTPException(503, "SoleasPay indisponible pour l'instant.")
        code = resp.get("code")
        status_raw = str(resp.get("status") or "").upper()
        if not resp.get("success") or code not in (200, 201) or status_raw == "FAILURE":
            await db.payments.update_one({"reference": order_id},
                                          {"$set": {"status": "failed",
                                                    "error": resp.get("message") or "refused"}})
            raise HTTPException(400, resp.get("message") or "Requête refusée par SoleasPay.")
        # Store SolesPay's own reference (MLS-xxx) so the webhook can find the
        # payment even if it echoes their ref instead of our order_id.
        prov_ref = (resp.get("data") or {}).get("reference")
        prov_tx = (resp.get("data") or {}).get("transaction_reference")
        if prov_ref or prov_tx:
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"provider_reference": prov_ref,
                          "transaction_id": prov_tx or prov_ref,
                          "updated_at": datetime.now(timezone.utc)}},
            )
        return {"reference": order_id, "gateway": "soleaspay", "method": "mobile",
                "status": "processing", "provider_reference": prov_ref}

    if (gw == "ashtec"):
        try:
            from ashtec_activation import create_ashtec_payment  # type: ignore
            # v20 — mobile-money Level 1 activation = 2 650 FCFA.
            _svc_curr = "XOF"
            _country = COUNTRIES.get(cc) if isinstance(COUNTRIES, dict) else None
            if isinstance(_country, dict):
                _svc_curr = _country.get("currency") or "XOF"
            amount = _mobile_activation_amount(_svc_curr)
            r = await create_ashtec_payment(
                db=db, user=user, kind="activation",
                amount=amount, country_code=cc,
                operator=op, phone=phone,
                extra_row={"level": 1},
            )
            return {"reference": r.get("reference"), "gateway": "ashtec",
                    "method": "mobile", "status": r.get("status") or "processing"}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(503, f"Passerelle Ashtec indisponible : {e}")

    if gw == "biztranspay":
        # v27h — Biz-transPay SoftPay (Togo). The frontend passes the
        # operator CODE directly (`tmoney_tg` or `flooz_tg`) because the
        # activation-catalog exposes those codes.
        # v27az — forward optional `otp` so Orange BF users can confirm.
        try:
            from biztranspay import biztranspay_activation, BtpActivationIn  # type: ignore
            r = await biztranspay_activation(
                BtpActivationIn(country_code=cc, operator=op, phone=phone,
                                otp=getattr(body, "otp", None)),
                request, user,
            )
            return {"reference": r.get("reference"),
                    "gateway": "biztranspay", "method": "mobile",
                    "status": r.get("status") or "processing"}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(503, f"Passerelle Biz-transPay indisponible : {e}")

    raise HTTPException(500, "Passerelle inconnue.")


@api.get("/payments/catalog")
async def payments_catalog(request: Request):
    """Unified public catalog for the simplified /(app)/pay page.

    Returns per method the countries + operators the CURRENT gateway config
    can serve. The frontend renders ONLY this — no gateway names exposed.
    """
    db = request.app.state.db
    cfg = await _load_payment_gateway(db)
    matrix_all = cfg.get("country_matrix") or {}

    # ── Mobile catalog: aggregate SoleasPay + Ashtec (if enabled).
    mobile_countries: list = []
    seen = set()
    if cfg.get("soleas_enabled") and await soleaspay.is_configured_async(db):
        soleas_matrix = matrix_all.get("soleas") or {}
        for cc, ops in soleaspay.SUPPORTED.items():
            if cc in soleaspay.EXCLUDED_COUNTRIES:
                continue
            if soleas_matrix.get(cc, True) is False:
                continue
            seen.add(cc)
            mobile_countries.append({
                "code": cc,
                "operators": [{"code": str(op["id"]), "label": op["label"],
                               "currency": op["currency"]} for op in ops],
            })
    # Merge Ashtec countries — only for countries not already covered.
    if cfg.get("ashtec_enabled"):
        try:
            from ashtec_activation import COUNTRIES as ASHTEC_COUNTRIES  # type: ignore
        except Exception:
            ASHTEC_COUNTRIES = {}
        ashtec_matrix = matrix_all.get("ashtec") or {}
        for cc, info in ASHTEC_COUNTRIES.items():
            if cc in seen:
                continue
            if ashtec_matrix.get(cc, True) is False:
                continue
            operators = info.get("operators") or []
            if not operators:
                continue
            def _ash_op(o):
                if isinstance(o, str):
                    return {"code": o, "label": o, "currency": info.get("currency") or "XOF"}
                if isinstance(o, (list, tuple)):
                    return {"code": o[0], "label": o[1], "currency": info.get("currency") or "XOF"}
                return {"code": o.get("code"), "label": o.get("label"),
                        "currency": info.get("currency") or "XOF"}
            mobile_countries.append({
                "code": cc,
                "operators": [_ash_op(op) for op in operators],
            })

    # ── Crypto catalog: IziChangePay only, single row.
    # `available` = feature-flag `crypto_auto` ON  AND  IziChangePay API key set.
    crypto_available = False
    crypto_info = None
    try:
        from feature_flags import is_enabled as _feat_enabled
        from izichange import API_KEY as _IZI_KEY, AMOUNT_USDT as _IZI_AMOUNT
        flag_on = await _feat_enabled(db, "crypto_auto")
        crypto_available = bool(flag_on and _IZI_KEY)
        if crypto_available:
            crypto_info = {
                "amount_usdt": float(_IZI_AMOUNT or 5),
                "network": "BEP20",
                "keys_configured": True,
            }
        elif flag_on and not _IZI_KEY:
            # Flag is on but the gateway isn't configured — expose the state
            # so pay.tsx can display a friendly warning.
            crypto_available = True
            crypto_info = {"amount_usdt": 5.0, "network": "BEP20",
                           "keys_configured": False}
    except Exception:
        crypto_available = False
        crypto_info = None

    return {
        "methods": [
            {"code": "mobile", "label": "Paiement Mobile", "available": bool(mobile_countries),
             "countries": mobile_countries},
            {"code": "crypto", "label": "Crypto", "available": crypto_available,
             "info": crypto_info},
        ],
    }


@api.get("/payments/activation-catalog")
async def activation_catalog(request: Request):
    """v27k (2026-02-14) — country-centric catalog for the redesigned
    activation page.

    Returns the FULL country list from `levels.COUNTRIES` (~60 entries)
    regardless of Mobile Money availability. Each country is annotated
    with:
      • `type: "mobile"` and its available operators — when at least one
        Mobile Money operator is configured & enabled for that country.
      • `type: "crypto"` with a single "USDT BEP20" method — otherwise.

    The FCFA activation amount is fixed by backend policy (2 650 FCFA).
    """
    db = request.app.state.db
    cfg = await _load_payment_gateway(db)
    matrix_all = cfg.get("country_matrix") or {}

    # Build the mobile lookup once (cc → [{code,label,currency}]).
    mobile_lookup: dict[str, list] = {}
    if cfg.get("soleas_enabled") and await soleaspay.is_configured_async(db):
        soleas_matrix = matrix_all.get("soleas") or {}
        for cc, ops in soleaspay.SUPPORTED.items():
            if cc in soleaspay.EXCLUDED_COUNTRIES:
                continue
            if soleas_matrix.get(cc, True) is False:
                continue
            mobile_lookup[cc] = [
                {"code": str(op["id"]), "label": op["label"],
                 "currency": op["currency"], "gateway": "soleas"}
                for op in ops
            ]
    if cfg.get("ashtec_enabled"):
        try:
            from ashtec_activation import COUNTRIES as ASHTEC_COUNTRIES  # type: ignore
        except Exception:
            ASHTEC_COUNTRIES = {}
        ashtec_matrix = matrix_all.get("ashtec") or {}
        for cc, info in ASHTEC_COUNTRIES.items():
            if ashtec_matrix.get(cc, True) is False:
                continue
            operators = info.get("operators") or []
            if not operators or cc in mobile_lookup:
                continue
            currency = info.get("currency") or "XOF"
            mobile_lookup[cc] = [
                {"code": op if isinstance(op, str) else op.get("code") or op.get("label"),
                 "label": op if isinstance(op, str) else op.get("label") or op.get("code"),
                 "currency": currency, "gateway": "ashtec"}
                for op in operators
            ]

    # v27h — Biz-transPay overrides any existing Togo entry when its
    # pay-in switch is on (product owner wants BizTransPay to take over
    # activations for TG when configured).
    # v27bb (2026-03-05) — annotate each operator with `requires_otp` +
    # `otp_ussd_template` so the frontend can PROACTIVELY render the OTP
    # card (USSD code + input) as soon as Orange BF (or any op needing an
    # OTP) is selected — no need to wait for the first failed submission.
    if cfg.get("biztranspay_enabled") and cfg.get("biztranspay_payin_enabled", True):
        try:
            from biztranspay import _toggle_on as _btp_toggle_on, is_payin_enabled as _btp_payin_on
            from btp_catalog import (fetch_catalog as _btp_fetch, activation_amount_for as _btp_price,
                                     flow_steps as _btp_steps, render_ussd as _btp_ussd,
                                     currency_label as _btp_cur_label)
            _btp_entries = await _btp_fetch(db, "deposit") if await _btp_payin_on(db) else []
        except Exception as _btp_e:
            log.warning("btp catalog unavailable: %s", _btp_e)
            _btp_entries = []
        _btp_by_cc: dict = {}
        for e in _btp_entries:
            if not _btp_toggle_on(cfg, e["country"], e):
                continue
            price = await _btp_price(db, e["currency"])
            if not price:
                continue
            label_amt = f"{price:,}".replace(",", " ") + " " + _btp_cur_label(e["currency"])
            ussd = _btp_ussd(e["flow"], price)
            _btp_by_cc.setdefault(e["country"], []).append({
                "code": e["code"], "label": e["label"], "currency": e["currency"],
                "gateway": "biztranspay", "amount": price, "amount_label": label_amt,
                "flow": e["flow"],
                "requires_otp": bool(e["flow"].get("otp_required") and not e["flow"].get("otp_request_before_submit")),
                "otp_ussd_template": e["flow"].get("ussd_template") or "",
                "steps": _btp_steps(e["flow"], label_amt, ussd),
            })
        mobile_lookup.update(_btp_by_cc)

    # Crypto availability — same rule as /payments/catalog.
    crypto_available = False
    try:
        from feature_flags import is_enabled as _feat_enabled
        from izichange import API_KEY as _IZI_KEY
        flag_on = await _feat_enabled(db, "crypto_auto")
        crypto_available = bool(flag_on and _IZI_KEY)
    except Exception:
        crypto_available = False

    # v27w (2026-02-24) — Biz-transPay USDT.BEP20 sub-toggle. Independent
    # from izichange: admin can turn OFF izichange yet keep BTP crypto on
    # (or vice versa). We expose each active crypto gateway as a distinct
    # operator card so the user can pick.
    btp_crypto_available = False
    try:
        from biztranspay import is_crypto_enabled as _btp_crypto_on
        btp_crypto_available = bool(await _btp_crypto_on(db))
    except Exception:
        btp_crypto_available = False

    countries_out: list = []
    # v27l (2026-02-14) — USDT BEP20 is a UNIVERSAL payment method,
    # available in every country in addition to any Mobile Money
    # operator. Each country therefore always exposes at least the
    # USDT_BEP20 entry (as long as the crypto gateway is configured).
    crypto_row = {"code": "USDT_BEP20", "label": "USDT BEP20 (IziChange)",
                  "currency": "USDT", "gateway": "izichange"}
    btp_crypto_row = {"code": "USDT_BEP20_BTP", "label": "USDT BEP20 (Biz-transPay)",
                      "currency": "USDT", "gateway": "biztranspay_crypto"}
    for c in COUNTRIES:
        cc = c.get("code")
        if not cc:
            continue
        ops = list(mobile_lookup.get(cc) or [])
        if crypto_available:
            ops.append(dict(crypto_row))
        if btp_crypto_available:
            ops.append(dict(btp_crypto_row))
        if not ops:
            # Neither Mobile Money nor Crypto configured — hide the country
            # from the picker to avoid a dead-end.
            continue
        # `type` reflects whether the country has at least one Mobile Money
        # operator. Kept for backward-compat, but the frontend now decides
        # from `operator.gateway` (mobile vs crypto) not from this field.
        has_mobile = any(o.get("gateway") not in ("izichange", "biztranspay_crypto") for o in ops)
        countries_out.append({
            "code": cc, "name": c.get("name") or cc,
            "flag": c.get("flag"), "dial": c.get("dial"),
            "type": "mobile" if has_mobile else "crypto",
            "operators": ops,
            "currency": (ops[0].get("currency") if has_mobile else "USDT"),
            "crypto_available": crypto_available or btp_crypto_available,
        })
    countries_out.sort(key=lambda x: (x["type"] != "mobile", x.get("name") or ""))
    return {
        "amount_fcfa": 2650,
        "crypto_available": crypto_available,
        "countries": countries_out,
    }



@api.get("/settings/payments")
async def get_payment_methods_status(request: Request):
    """Returns which payment methods are currently enabled, plus extra metadata for the client.

    Automatic payment availability is derived from BOTH the new
    `payment_gateway` config (preferred) AND the legacy `soleaspay` doc.
    The user only ever sees a single "Paiement Automatique" option; the
    backend dispatcher (`/payments/soleaspay/initiate`) routes to whichever
    gateway is configured as active.
    """
    db = request.app.state.db
    soleaspay_doc = await db.app_settings.find_one({"_id": "soleaspay"}, {"_id": 0}) or {}
    manual_doc = await db.app_settings.find_one({"_id": "manual_payment"}, {"_id": 0}) or {}
    crypto_doc = await db.app_settings.find_one({"_id": "crypto_payment"}, {"_id": 0}) or {}

    # Resolve the active automatic payment gateway from admin config.
    gw = await _load_payment_gateway(db)
    active = gw.get("active", "soleas")
    if active == "soleas" and not gw.get("soleas_enabled"):
        if gw.get("ashtec_enabled"):
            active = "ashtec"
    if active == "ashtec" and not gw.get("ashtec_enabled"):
        if gw.get("soleas_enabled"):
            active = "soleas"
    soleas_ready = bool(gw.get("soleas_enabled")) and soleaspay.is_configured()
    # DB-first for Ashtech key (admin panel wins), env is bootstrap fallback.
    ashtec_api_key = (gw.get("ashtec_api_key") or "").strip() \
                     or (os.environ.get("ASHTECPAY_API_KEY") or "").strip()
    ashtec_ready = bool(gw.get("ashtec_enabled")) and bool(ashtec_api_key)
    if active == "soleas":
        auto_enabled = soleas_ready
    else:
        auto_enabled = ashtec_ready
    # Legacy override: if the admin has explicitly disabled soleaspay in the
    # `app_settings.soleaspay` doc (old switch), respect it.
    legacy_soleaspay_disabled = soleaspay_doc.get("enabled") is False
    if legacy_soleaspay_disabled and active == "soleas":
        auto_enabled = False

    return {
        # Generic, gateway-agnostic auto-payment switch (preferred for new UI):
        "auto_enabled": auto_enabled,
        "active_gateway": active if auto_enabled else None,
        # Per-gateway toggles — the source of truth for UI visibility.
        # UI must hide Ashtech / Soleas buttons when the corresponding flag
        # is False. Backend also enforces these on every initiate call.
        "ashtec_enabled": ashtec_ready,
        "soleas_enabled": soleas_ready,
        # Legacy / backward-compat fields (the existing frontend reads these):
        "soleaspay_enabled": auto_enabled,
        "soleaspay_excluded_countries": sorted(list(soleaspay.EXCLUDED_COUNTRIES)),
        "soleaspay_countries": sorted(list(soleaspay.SUPPORTED.keys())),
        "soleaspay_services_by_country": soleaspay.SUPPORTED,
        "manual_enabled": bool(manual_doc.get("enabled", False)),
        "crypto_enabled": bool(crypto_doc.get("enabled", False)),
        "crypto": {
            "network": crypto_doc.get("network") or "USDT BEP20",
            "wallet_address": crypto_doc.get("wallet_address") or "",
            "amount_usdt": crypto_doc.get("amount_usdt") or 5.0,
            "instructions": crypto_doc.get("instructions") or "",
        } if crypto_doc.get("enabled") else None,
    }


# ============ APP SETTINGS (manual payment instructions) ============

class ManualPaymentSettings(BaseModel):
    enabled: bool = False
    payment_url: Optional[str] = None
    title: Optional[str] = "Paiement manuel"
    instructions: Optional[str] = None
    phone_to_pay: Optional[str] = None
    operator_name: Optional[str] = None
    allowed_countries: List[str] = Field(default_factory=list)


class CryptoPaymentSettings(BaseModel):
    enabled: bool = False
    network: Optional[str] = "USDT BEP20"
    wallet_address: Optional[str] = ""
    amount_usdt: Optional[float] = 5.0
    instructions: Optional[str] = ""


@api.get("/settings/manual-payment")
async def get_manual_payment(request: Request):
    """Public read of manual payment settings (used by /activation manual flow)."""
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "manual_payment"}, {"_id": 0}) or {}
    # Sanitize: never expose admin-only fields.
    return {
        "enabled": bool(doc.get("enabled", False)),
        "payment_url": doc.get("payment_url") or "",
        "title": doc.get("title") or "Paiement manuel",
        "instructions": doc.get("instructions") or "",
        "phone_to_pay": doc.get("phone_to_pay") or "",
        "operator_name": doc.get("operator_name") or "",
        "allowed_countries": doc.get("allowed_countries") or [],
    }


class ManualActivationIn(BaseModel):
    country: str
    operator: str
    phone: str


class CryptoActivationIn(BaseModel):
    country: Optional[str] = ""
    tx_hash: str


@api.post("/activations/manual-request")
async def create_manual_activation(
    data: ManualActivationIn, request: Request, user=Depends(get_current_user),
):
    """Record a manual activation request and return the configured payment URL.

    The user gets redirected client-side AFTER this call succeeds. The admin
    sees the pending activation immediately and can validate it once the user
    actually pays via the external link.
    """
    db = request.app.state.db
    cfg = await db.app_settings.find_one({"_id": "manual_payment"}, {"_id": 0}) or {}
    if not cfg.get("enabled"):
        raise HTTPException(400, "Le paiement manuel n'est pas activé.")
    allowed = cfg.get("allowed_countries") or []
    if allowed and data.country not in allowed:
        raise HTTPException(400, "Le paiement manuel n'est pas disponible dans votre pays.")
    if user.get("max_level", 0) >= 1:
        raise HTTPException(400, "Votre niveau 1 est déjà activé.")

    # Avoid duplicate pending manual requests for the same user.
    existing = await db.activations.find_one({
        "user_id": user["id"], "level": 1, "status": "pending", "payment_method": "manual",
    })
    if existing:
        return {
            "ok": True,
            "activation_id": existing["id"],
            "payment_url": cfg.get("payment_url") or "",
            "already_pending": True,
        }

    act_id = str(uuid.uuid4())
    # v20 — manual mobile-money Level 1 activation = 2 650 FCFA.
    amount = _mobile_activation_amount("XOF")
    now = datetime.now(timezone.utc)
    await db.activations.insert_one({
        "id": act_id,
        "user_id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "level": 1,
        "amount": amount,
        "payment_method": "manual",
        "operator": data.operator,
        "payment_phone": data.phone,
        "payer_country": data.country,
        "status": "pending",
        "created_at": now,
    })
    return {
        "ok": True,
        "activation_id": act_id,
        "payment_url": cfg.get("payment_url") or "",
        "amount": amount,
        "currency": "FCFA",
    }


@api.post("/activations/crypto-request")
async def create_crypto_activation(
    data: CryptoActivationIn, request: Request, user=Depends(get_current_user),
):
    """Record a crypto (USDT BEP20) activation request awaiting admin validation."""
    db = request.app.state.db
    cfg = await db.app_settings.find_one({"_id": "crypto_payment"}, {"_id": 0}) or {}
    if not cfg.get("enabled"):
        raise HTTPException(400, "Le paiement crypto est désactivé.")
    if user.get("max_level", 0) >= 1:
        raise HTTPException(400, "Votre niveau 1 est déjà activé.")
    tx_hash = (data.tx_hash or "").strip()
    if len(tx_hash) < 8:
        raise HTTPException(400, "Hash de transaction invalide.")

    existing = await db.activations.find_one({
        "user_id": user["id"], "level": 1, "status": "pending", "payment_method": "crypto",
    })
    if existing:
        return {"ok": True, "activation_id": existing["id"], "already_pending": True}

    act_id = str(uuid.uuid4())
    amount = LEVELS_BY_NUM[1]["price"]
    amount_usdt = float(cfg.get("amount_usdt") or 5)
    now = datetime.now(timezone.utc)
    await db.activations.insert_one({
        "id": act_id,
        "user_id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "level": 1,
        "amount": amount,
        "amount_usdt": amount_usdt,
        "network": cfg.get("network") or "USDT BEP20",
        "payment_method": "crypto",
        "tx_hash": tx_hash,
        "payer_country": data.country or user.get("country"),
        "status": "pending",
        "created_at": now,
    })
    return {
        "ok": True,
        "activation_id": act_id,
        "amount_usdt": amount_usdt,
        "network": cfg.get("network") or "USDT BEP20",
    }


class WithdrawalSettings(BaseModel):
    fee_percent: float = Field(default=0, ge=0, le=100)   # 0 .. 100 (%)
    fee_flat: float = Field(default=0, ge=0)              # absolute amount in user currency
    min_amount: float = Field(default=0, ge=0)            # minimum withdrawal amount
    max_amount: Optional[float] = Field(default=None, ge=0)
    enabled: bool = True
    # Withdrawal time-window (Africa/Lome timezone)
    allowed_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5, 6])  # 0=Mon ... 6=Sun
    open_time: str = "07:00"   # HH:MM (24h)
    close_time: str = "20:00"  # HH:MM (24h)
    timezone: str = "Africa/Lome"


class SupportLinks(BaseModel):
    telegram_url: Optional[str] = None
    whatsapp_url: Optional[str] = None
    facebook_url: Optional[str] = None
    youtube_url: Optional[str] = None
    instagram_url: Optional[str] = None
    twitter_url: Optional[str] = None
    discord_url: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website_url: Optional[str] = None


class CommunityPopupSettings(BaseModel):
    enabled: bool = True
    title: str = "📢 COMMUNAUTÉ OFFICIELLE SPILOVEURE"
    description: str = (
        "Rejoignez notre communauté officielle pour recevoir les annonces, "
        "suivre les nouvelles formations, découvrir les nouveaux produits digitaux "
        "et ne manquer aucune opportunité."
    )
    image_url: Optional[str] = None
    telegram_url: Optional[str] = None
    button_label: str = "🚀 REJOINDRE MAINTENANT"
    auto_close_seconds: int = Field(default=5, ge=0, le=60)


class TradingSettings(BaseModel):
    """v26 (2026-02-14) — Trading Telegram channel shown on Dashboard card.

    Reused as-is on both the public read endpoint and the admin CRUD. The
    frontend `TradingCard` fetches the URL dynamically and opens it via
    `Linking.openURL` on tap. No trading logic changes — this is purely a
    community redirect.
    """
    enabled: bool = True
    telegram_url: Optional[str] = None
    title: str = "TRADING"
    description: str = (
        "Rejoignez notre canal Telegram Trading et retrouvez nos "
        "actualités, analyses et contenus liés au Trading."
    )
    button_label: str = "Accéder au canal Telegram"


def _withdrawal_defaults(doc: dict) -> dict:
    raw_days = doc.get("allowed_days")
    if isinstance(raw_days, list):
        allowed_days = [int(d) for d in raw_days if isinstance(d, (int, float, str)) and str(d).isdigit() and 0 <= int(d) <= 6]
    else:
        allowed_days = [0, 1, 2, 3, 4, 5, 6]
    return {
        "fee_percent": float(doc.get("fee_percent", 0) or 0),
        "fee_flat": float(doc.get("fee_flat", 0) or 0),
        "min_amount": float(doc.get("min_amount", 0) or 0),
        "max_amount": doc.get("max_amount"),
        "enabled": bool(doc.get("enabled", True)),
        "allowed_days": allowed_days or [0, 1, 2, 3, 4, 5, 6],
        "open_time": doc.get("open_time") or "07:00",
        "close_time": doc.get("close_time") or "20:00",
        "timezone": doc.get("timezone") or "Africa/Lome",
    }


def _parse_hhmm(s: str) -> Optional[tuple[int, int]]:
    try:
        hh, mm = s.split(":")
        h, m = int(hh), int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except Exception:
        pass
    return None


def _check_withdrawal_window(settings: dict) -> Optional[str]:
    """Return None if withdrawals are within the allowed window, else a user-facing FR error message."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(settings.get("timezone") or "Africa/Lome")
    except Exception:
        tz = timezone.utc
    now = datetime.now(tz)
    weekday = now.weekday()  # 0=Mon..6=Sun
    allowed_days = settings.get("allowed_days") or [0, 1, 2, 3, 4, 5, 6]
    open_t = _parse_hhmm(settings.get("open_time") or "07:00") or (7, 0)
    close_t = _parse_hhmm(settings.get("close_time") or "20:00") or (20, 0)
    day_labels = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
    pretty_days = ", ".join(day_labels[d] for d in sorted(set(int(d) for d in allowed_days))) or "Aucun jour"
    pretty_open = f"{open_t[0]:02d}:{open_t[1]:02d}"
    pretty_close = f"{close_t[0]:02d}:{close_t[1]:02d}"
    if weekday not in allowed_days:
        return (
            f"🚫 Retrait actuellement indisponible.\n\n"
            f"Les retraits sont autorisés :\n📅 {pretty_days}\n🕒 De {pretty_open} à {pretty_close}\n\n"
            f"Veuillez réessayer pendant les heures d'ouverture des retraits.\nMerci de votre compréhension. 🙏"
        )
    cur_min = now.hour * 60 + now.minute
    open_min = open_t[0] * 60 + open_t[1]
    close_min = close_t[0] * 60 + close_t[1]
    in_window = (open_min <= cur_min < close_min) if open_min <= close_min else (cur_min >= open_min or cur_min < close_min)
    if not in_window:
        return (
            f"🚫 Retrait actuellement indisponible.\n\n"
            f"Les retraits sont autorisés :\n📅 {pretty_days}\n🕒 De {pretty_open} à {pretty_close}\n\n"
            f"Veuillez réessayer pendant les heures d'ouverture des retraits.\nMerci de votre compréhension. 🙏"
        )
    return None


def _support_defaults(doc: dict) -> dict:
    return {
        "telegram_url": doc.get("telegram_url") or "",
        "whatsapp_url": doc.get("whatsapp_url") or "",
        "facebook_url": doc.get("facebook_url") or "",
        "youtube_url": doc.get("youtube_url") or "",
        "instagram_url": doc.get("instagram_url") or "",
        "twitter_url": doc.get("twitter_url") or "",
        "discord_url": doc.get("discord_url") or "",
        "email": doc.get("email") or "",
        "phone": doc.get("phone") or "",
        "website_url": doc.get("website_url") or "",
    }


def _community_popup_defaults(doc: dict) -> dict:
    return {
        "enabled": bool(doc.get("enabled", True)),
        "title": doc.get("title") or "📢 COMMUNAUTÉ OFFICIELLE SPILOVEURE",
        "description": doc.get("description") or (
            "Rejoignez notre communauté officielle pour recevoir les annonces, "
            "suivre les nouvelles formations, découvrir les nouveaux produits digitaux "
            "et ne manquer aucune opportunité."
        ),
        "image_url": doc.get("image_url") or "",
        "telegram_url": doc.get("telegram_url") or "",
        "button_label": doc.get("button_label") or "🚀 REJOINDRE MAINTENANT",
        "auto_close_seconds": int(doc.get("auto_close_seconds") or 5),
    }


def _trading_defaults(doc: dict) -> dict:
    return {
        "enabled": bool(doc.get("enabled", True)),
        "telegram_url": doc.get("telegram_url") or "",
        "title": doc.get("title") or "TRADING",
        "description": doc.get("description") or (
            "Rejoignez notre canal Telegram Trading et retrouvez nos "
            "actualités, analyses et contenus liés au Trading."
        ),
        "button_label": doc.get("button_label") or "Accéder au canal Telegram",
    }


async def _get_withdrawal_settings(db) -> dict:
    doc = await db.app_settings.find_one({"_id": "withdrawal_settings"}, {"_id": 0}) or {}
    return _withdrawal_defaults(doc)


def _compute_withdrawal_fee(amount: float, settings: dict) -> tuple[float, float]:
    """Return (fee, net) given gross withdrawal amount and settings."""
    pct = float(settings.get("fee_percent", 0) or 0) / 100.0
    flat = float(settings.get("fee_flat", 0) or 0)
    fee = round(amount * pct + flat, 2)
    fee = max(0.0, min(fee, amount))
    net = round(amount - fee, 2)
    return fee, net


@api.get("/settings/withdrawal")
async def get_withdrawal_settings(request: Request):
    """Public read of withdrawal fee settings (used by /withdrawal screen)."""
    db = request.app.state.db
    return await _get_withdrawal_settings(db)


@api.get("/settings/support")
async def get_support_links(request: Request):
    """Public read of support/social links (used by /settings screen)."""
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "support_links"}, {"_id": 0}) or {}
    return _support_defaults(doc)


@api.get("/settings/community-popup")
async def get_community_popup(request: Request):
    """Public read of community popup config (shown after login)."""
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "community_popup"}, {"_id": 0}) or {}
    return _community_popup_defaults(doc)


@api.get("/settings/trading")
async def get_trading_settings(request: Request):
    """v26 (2026-02-14) — public read of Trading Telegram channel config.
    Consumed by the Dashboard `TradingCard`. No auth required so the card
    can be shown even before the user is fully hydrated."""
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "trading_settings"}, {"_id": 0}) or {}
    return _trading_defaults(doc)





# ============ ADMIN ============

admin_router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
_register_payment_gateway_routes(admin_router)



@admin_router.get("/outbound-ip")
async def admin_outbound_ip():
    """Return the public outbound IP of the running backend pod.

    Useful to whitelist this IP on third-party payment providers (e.g. Money Fusion)
    that require IP-based access control on their API.
    """
    import httpx
    services = [
        "https://api.ipify.org?format=json",
        "https://ipv4.icanhazip.com",
        "https://ifconfig.me/ip",
    ]
    ips: list[str] = []
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=5.0) as client:
        for url in services:
            try:
                r = await client.get(url)
                text = r.text.strip()
                if url.endswith("json"):
                    import json as _json
                    ip = _json.loads(text).get("ip", "")
                else:
                    ip = text
                if ip:
                    ips.append(ip)
            except Exception as e:
                errors.append(f"{url}: {e.__class__.__name__}")
    unique = sorted(set(ips))
    return {
        "outbound_ip": unique[0] if unique else None,
        "all_detected": unique,
        "checked_services": services,
        "errors": errors,
        "hint": "Whitelist this IP in your Money Fusion application settings.",
    }



@admin_router.get("/stats")
async def admin_stats(request: Request):
    db = request.app.state.db
    users_total = await db.users.count_documents({"role": "user"})
    users_active = await db.users.count_documents({"role": "user", "status": "active"})
    # Pending activations include BOTH manual/crypto (db.activations) AND
    # automatic SoleasPay payments (db.payments) that are not yet activated.
    # An auto payment is "pending" if status==pending, OR status==paid but
    # activation_done is false (stuck — needs admin attention).
    activations_pending_manual = await db.activations.count_documents({"status": "pending"})
    activations_pending_auto = await db.payments.count_documents({
        # v27ac (2026-03-04) — include biztranspay (mobile + crypto)
        # in the automatic pending count so the dashboard reflects
        # every gateway, not just SoleasPay / AshtecPay.
        "provider": {"$in": ["soleaspay", "ashtecpay", "biztranspay"]},
        "$or": [
            {"status": "pending"},
            {"status": "paid", "activation_done": {"$ne": True}},
        ],
    })
    activations_pending = activations_pending_manual + activations_pending_auto
    withdrawals_pending = await db.withdrawals.count_documents({
        # v27ad (2026-03-04) — auto-dispatched withdrawals (status=dispatched)
        # from BTP payouts still live in the "En attente" bucket until the
        # gateway webhook confirms with push.succeeded/failed. Include them
        # in the badge count so admins see the real pending workload.
        "status": {"$in": ["pending", "dispatched", "processing"]},
    })
    # Total validated activation amount includes manual + crypto (db.activations)
    # AND validated automatic payments (db.payments with activation_done=true).
    #
    # ⚠️ Currency conversion — crypto (crypto_auto / crypto_manual) activations
    # are stored with `currency:"USDT"` and `amount:5`. For the FCFA dashboard
    # aggregate we count each USDT activation as its FCFA equivalent using the
    # canonical business rate 1 USDT = 500 FCFA (i.e. 5 USDT = 2 500 FCFA).
    USDT_TO_FCFA_RATE = 500  # matches the crypto activation product price
    total_activation_amount_agg = await db.activations.aggregate([
        {"$match": {"status": "validated"}},
        {"$group": {"_id": None, "total": {"$sum": {
            "$cond": [
                {"$eq": ["$currency", "USDT"]},
                {"$multiply": ["$amount", USDT_TO_FCFA_RATE]},
                "$amount",
            ]
        }}}},
    ]).to_list(1)
    total_activations_manual = total_activation_amount_agg[0]["total"] if total_activation_amount_agg else 0
    # Auto payment gateways store their activation records in `db.payments`.
    # We include BOTH SoleasPay (legacy) and AshtecPay (current) so the
    # dashboard reflects every automatic activation regardless of the
    # provider dispatched to. All amounts are in FCFA (XOF/XAF).
    total_auto_agg = await db.payments.aggregate([
        {"$match": {
            # v27ac — biztranspay activations (mobile money + crypto USDT.BEP20)
            # must be aggregated too.
            "provider": {"$in": ["soleaspay", "ashtecpay", "biztranspay"]},
            "activation_done": True,
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    total_activations_auto = total_auto_agg[0]["total"] if total_auto_agg else 0
    total_activations = (total_activations_manual or 0) + (total_activations_auto or 0)
    total_wd_agg = await db.withdrawals.aggregate([
        # v27ab (2026-03-04) — include auto-dispatched withdrawals that were
        # confirmed by the payment gateway (BTP / SoleasPay webhook sets
        # status="completed"). Previously they were invisible from the
        # aggregate total because only "validated" (manual admin action) was
        # counted.
        {"$match": {"status": {"$in": ["validated", "completed"]}}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    total_withdrawals = total_wd_agg[0]["total"] if total_wd_agg else 0
    # Mission withdrawals stats (paid missions module — separate collection)
    try:
        mw_pending = await db.mission_withdrawals.count_documents({"status": "pending"})
        mw_validated = await db.mission_withdrawals.count_documents({"status": "validated"})
        mw_rejected = await db.mission_withdrawals.count_documents({"status": "rejected"})
        mw_total = mw_pending + mw_validated + mw_rejected
        mw_amount_agg = await db.mission_withdrawals.aggregate([
            {"$match": {"status": "validated"}},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}, "net": {"$sum": "$net_payout"}}},
        ]).to_list(1)
        mw_amount = float((mw_amount_agg[0] or {}).get("total") or 0) if mw_amount_agg else 0
        mw_net = float((mw_amount_agg[0] or {}).get("net") or 0) if mw_amount_agg else 0
    except Exception:
        mw_pending = mw_validated = mw_rejected = mw_total = 0
        mw_amount = mw_net = 0
    return {
        "users_total": users_total,
        "users_active": users_active,
        "activations_pending": activations_pending,
        "activations_pending_manual": activations_pending_manual,
        "activations_pending_auto": activations_pending_auto,
        "withdrawals_pending": withdrawals_pending + mw_pending,
        "withdrawals_pending_commissions": withdrawals_pending,
        "withdrawals_pending_missions": mw_pending,
        "total_activations_amount": total_activations,
        "total_withdrawals_amount": total_withdrawals,
        "mission_withdrawals": {
            "total_count": mw_total,
            "pending_count": mw_pending,
            "validated_count": mw_validated,
            "rejected_count": mw_rejected,
            "validated_amount": mw_amount,
            "validated_net": mw_net,
        },
    }


@admin_router.get("/users/{user_id}/transactions")
async def admin_user_transactions(user_id: str, request: Request):
    """Full transaction history for a given user (admin only).
    Returns the same shape as /transactions for the current user.
    """
    db = request.app.state.db
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1})
    if not u:
        raise HTTPException(404, "Utilisateur introuvable.")
    return await _build_transaction_history(db, user_id)


@admin_router.get("/users/{user_id}")
async def admin_user_detail(user_id: str, request: Request):
    db = request.app.state.db
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not u:
        raise HTTPException(404, "Utilisateur introuvable.")
    placements = await db.matrix_placements.find({"user_id": user_id}, {"_id": 0}).to_list(20)
    notes = await db.user_notes.find({"user_id": user_id}, {"_id": 0}).sort("at", -1).to_list(100)
    wallet = await db.wallets.find_one({"user_id": user_id}, {"_id": 0})
    activations = await db.activations.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    withdrawals = await db.withdrawals.find({"user_id": user_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return {
        "user": u,
        "placements": placements,
        "notes": notes,
        "wallet": wallet,
        "activations": activations,
        "withdrawals": withdrawals,
    }


@admin_router.get("/users/{user_id}/tree")
async def admin_user_tree(user_id: str, request: Request, level: int = 1):
    db = request.app.state.db
    layers = []
    current = [user_id]
    for _depth in range(4):
        layer = []
        for parent in current:
            kids = await db.matrix_placements.find(
                {"level": level, "parent_id": parent}, {"_id": 0}
            ).to_list(20)
            for k in kids:
                cu = await db.users.find_one(
                    {"id": k["user_id"]},
                    {"_id": 0, "username": 1, "max_level": 1, "status": 1, "created_at": 1, "id": 1},
                )
                if cu:
                    k["user"] = cu
                layer.append(k)
        layers.append(layer)
        current = [c["user_id"] for c in layer]
        if not current:
            break
    return {"root_user_id": user_id, "layers": layers, "level": level}


@admin_router.get("/activations/{activation_id}")
async def admin_activation_detail(activation_id: str, request: Request):
    db = request.app.state.db
    act = await db.activations.find_one({"id": activation_id}, {"_id": 0})
    if not act:
        raise HTTPException(404, "Activation introuvable.")
    u = await db.users.find_one({"id": act["user_id"]}, {"_id": 0, "password_hash": 0})
    return {"activation": act, "user": u}


@admin_router.get("/users")
async def admin_list_users(request: Request, q: Optional[str] = None, limit: int = 100):
    db = request.app.state.db
    query = {}
    if q:
        query = {"$or": [
            {"username": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
            {"phone": {"$regex": q, "$options": "i"}},
            {"id": q},
        ]}
    items = await db.users.find(query, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(limit)
    return items


@admin_router.get("/admins")
async def admin_list_admins(request: Request, q: Optional[str] = None):
    """List every account with `role='admin'`. Used by the admin panel's
    dedicated 'Administrateurs' tab so admins are easy to audit at a glance.

    Returns username, email, phone, country, status, max_level (access-level
    proxy), created_at, is_promoter, withdrawals_disabled and a small
    activity summary."""
    db = request.app.state.db
    query: dict = {"role": "admin"}
    if q:
        query = {"$and": [query, {"$or": [
            {"username": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
            {"phone": {"$regex": q, "$options": "i"}},
        ]}]}
    items = await db.users.find(
        query,
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1).to_list(200)
    # Normalise fields so the frontend never crashes on legacy docs missing
    # some columns.
    for u in items:
        u.setdefault("phone", "")
        u.setdefault("country", "")
        u.setdefault("status", "active")
        u.setdefault("max_level", 12)  # admin bootstrap default
        u.setdefault("is_promoter", False)
        u.setdefault("withdrawals_disabled", False)
    return {"items": items, "total": len(items)}


@admin_router.post("/users/{user_id}/action")
async def admin_user_action(user_id: str, data: AdminUserActionIn, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable.")
    action = data.action
    updates = {}
    if action == "ban":
        updates["status"] = "banned"
    elif action == "unban":
        updates["status"] = "active" if target.get("max_level", 0) > 0 else "pending"
    elif action == "block":
        updates["status"] = "blocked"
    elif action == "unblock":
        updates["status"] = "active" if target.get("max_level", 0) > 0 else "pending"
    elif action == "delete":
        await db.users.delete_one({"id": user_id})
    elif action == "disable_withdrawals":
        updates["withdrawals_disabled"] = True
    elif action == "enable_withdrawals":
        updates["withdrawals_disabled"] = False
    elif action == "reset_password":
        if not data.new_password:
            raise HTTPException(400, "Nouveau mot de passe requis.")
        updates["password_hash"] = hash_password(data.new_password)
    elif action == "change_sponsor":
        if not data.new_sponsor_username:
            raise HTTPException(400, "Nouveau parrain requis.")
        sp = await db.users.find_one({"username": data.new_sponsor_username})
        if not sp:
            raise HTTPException(400, "Parrain introuvable.")
        updates["sponsor_id"] = sp["id"]
        updates["sponsor_username"] = sp["username"]
    elif action == "credit_wallet":
        if not data.amount or data.amount <= 0:
            raise HTTPException(400, "Montant invalide.")
        bucket = data.bucket or "profit"
        if bucket not in ("profit", "upgrade"):
            raise HTTPException(400, "Bucket invalide (profit ou upgrade).")
        field = "balance_profit" if bucket == "profit" else "balance_upgrade"
        # v19 (2026-02-14) — admin credits (profit OR upgrade) MUST also
        # bump `admin_credit_total` so they surface on the user's Profit
        # Total card. Without this, admin adjustments would silently
        # disappear from the cumulative profit display.
        await db.users.update_one(
            {"id": user_id},
            {"$inc": {field: int(data.amount), "admin_credit_total": int(data.amount)}},
        )
    elif action == "debit_wallet":
        if not data.amount or data.amount <= 0:
            raise HTTPException(400, "Montant invalide.")
        bucket = data.bucket or "profit"
        if bucket not in ("profit", "upgrade"):
            raise HTTPException(400, "Bucket invalide.")
        field = "balance_profit" if bucket == "profit" else "balance_upgrade"
        current = target.get(field, 0)
        if current < int(data.amount):
            raise HTTPException(400, "Solde insuffisant pour ce débit.")
        # Mirror the credit path : debits reduce the cumulative admin bump.
        await db.users.update_one(
            {"id": user_id},
            {"$inc": {field: -int(data.amount), "admin_credit_total": -int(data.amount)}},
        )
    elif action == "make_admin":
        updates["role"] = "admin"
    elif action == "remove_admin":
        updates["role"] = "user"
    elif action == "make_promoter":
        updates["is_promoter"] = True
    elif action == "remove_promoter":
        updates["is_promoter"] = False
    elif action == "activate_level":
        if not data.level or data.level < 1 or data.level > 12:
            raise HTTPException(400, "Niveau invalide.")
        from matrix import activate_level as _activate
        try:
            await _activate(db, user_id, int(data.level), source="admin_manual")
        except ValueError as e:
            raise HTTPException(400, str(e))
    elif action == "deactivate_level":
        if not data.level or data.level < 1 or data.level > 12:
            raise HTTPException(400, "Niveau invalide.")
        if target.get("max_level", 0) != int(data.level):
            raise HTTPException(400, "Vous ne pouvez désactiver que le niveau le plus haut.")
        await db.matrix_placements.delete_one({"user_id": user_id, "level": int(data.level)})
        new_max = int(data.level) - 1
        updates["max_level"] = new_max
        if new_max == 0:
            updates["status"] = "pending"
        # Drop the activation timestamp for the level being removed. Leaving
        # it behind made a deactivated account read as "activated but stuck
        # at level 0", and kept it counting towards challenge progress -
        # challenges.py keys off users.level_activated_at.1.
        await db.users.update_one(
            {"id": user_id},
            {"$unset": {"level_activated_at.%d" % int(data.level): ""}},
        )
    elif action == "move_matrix":
        if not data.level or not data.new_parent_username or data.new_leg not in ("left", "right"):
            raise HTTPException(400, "Niveau, parent et jambe (left/right) requis.")
        parent = await db.users.find_one({"username": data.new_parent_username})
        if not parent:
            raise HTTPException(400, "Parent introuvable.")
        # ensure no conflict on (parent, leg, level)
        conflict = await db.matrix_placements.find_one({
            "level": int(data.level), "parent_id": parent["id"], "leg": data.new_leg,
        })
        if conflict and conflict.get("user_id") != user_id:
            raise HTTPException(400, "Cette position est déjà occupée.")
        await db.matrix_placements.update_one(
            {"user_id": user_id, "level": int(data.level)},
            {"$set": {"parent_id": parent["id"], "leg": data.new_leg, "is_spillover": True}},
        )
    elif action == "add_note":
        if not data.note:
            raise HTTPException(400, "Note vide.")
        await db.user_notes.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "admin_id": admin["id"],
            "admin_username": admin.get("username"),
            "note": data.note,
            "at": datetime.now(timezone.utc),
        })
    else:
        raise HTTPException(400, "Action inconnue.")
    if updates:
        await db.users.update_one({"id": user_id}, {"$set": updates})
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": action,
        "target_user_id": user_id, "at": datetime.now(timezone.utc),
    })
    return {"ok": True}


@admin_router.get("/activations")
async def admin_list_activations(request: Request, status_filter: Optional[str] = Query(None, alias="status")):
    """Unified list: manual + crypto activations (db.activations) + automatic
    SoleasPay payments (db.payments). Each item exposes a `payment_method`
    field used by the UI to render an AUTO / MANUEL / CRYPTO badge.

    Status mapping for db.payments entries:
        soleaspay pending                          → "pending"
        soleaspay paid + activation_done=true      → "validated"
        soleaspay paid + activation_done=false     → "pending"  (admin can force-activate)
        soleaspay failed                           → "rejected"
    """
    db = request.app.state.db
    # ── Auto-reject sweep (12h timeout) ─────────────────────────────────
    # Any activation pending for more than 12 hours is auto-rejected here.
    # Runs lazily on every admin page load — no cron needed. Users see the
    # rejection in their history and can immediately submit a fresh request.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=12)
    swept = await db.activations.update_many(
        {"status": "pending", "created_at": {"$lt": cutoff}},
        {"$set": {
            "status": "rejected",
            "rejected_at": datetime.now(timezone.utc),
            "rejected_by": "auto:timeout-12h",
            "reject_reason": "Rejeté automatiquement après 12h sans validation.",
        }},
    )
    # Same sweep for automatic SoleasPay / IziChange payment intents that
    # never landed. Only pending, unactivated activation-kind rows are touched.
    await db.payments.update_many(
        {
            "status": "pending",
            "activation_done": {"$ne": True},
            "kind": {"$in": [None, "activation"]},
            "created_at": {"$lt": cutoff},
        },
        {"$set": {
            "status": "failed",
            "activation_error": "Rejeté automatiquement après 12h sans confirmation.",
            "rejected_at": datetime.now(timezone.utc),
            "rejected_by": "auto:timeout-12h",
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    if swept.modified_count:
        log.info("Auto-rejected %d activations older than 12h", swept.modified_count)

    q = {"status": status_filter} if status_filter else {}
    items = await db.activations.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    # Tag legacy activations rows (manual / crypto) so the UI knows for sure
    for it in items:
        it.setdefault("payment_method", "manual")
        it["source"] = "activation"

    # Enrich crypto_auto activations with the matching payment row so the admin
    # sees the deposit_address, tx_hash and gateway status inline.
    crypto_refs = [it.get("reference") for it in items if it.get("payment_method") == "crypto_auto" and it.get("reference")]
    if crypto_refs:
        pay_map = {}
        async for p in db.payments.find({"reference": {"$in": crypto_refs}, "provider": "izichange"}, {"_id": 0}):
            pay_map[p["reference"]] = p
        # Batch-fetch user emails so the admin can trace the account behind
        # each pending EasyChange (IziChange) payment intent without opening
        # a separate tab.
        user_ids = list({it.get("user_id") for it in items if it.get("payment_method") == "crypto_auto" and it.get("user_id")})
        user_map: dict = {}
        if user_ids:
            async for u in db.users.find({"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "email": 1}):
                user_map[u["id"]] = u.get("email")
        for it in items:
            if it.get("payment_method") != "crypto_auto":
                continue
            p = pay_map.get(it.get("reference"))
            if p:
                it["deposit_address"] = p.get("deposit_address")
                it["tx_hash"] = p.get("tx_hash") or it.get("tx_hash")
                it["network"] = p.get("network") or "BEP20"
                it["provider"] = "izichange"
                it["gateway_status"] = p.get("status")
                it["expires_at"] = p.get("expires_at")
                # EasyChange (IziChange) payment-intent id — this is the ID
                # the merchant sees on the EasyChange dashboard when they need
                # to trace a stuck deposit for manual support.
                it["easychange_transaction_id"] = p.get("provider_intent_id")
            # Populate email if it wasn't stored on the activation doc (older rows).
            if not it.get("email") and it.get("user_id"):
                it["email"] = user_map.get(it["user_id"])

    # Merge automatic payments (SoleasPay legacy + AshtecPay current + Biz-transPay).
    # All three providers store their payment docs in `db.payments` with the
    # same basic shape, so we can iterate them uniformly.
    #
    # When the caller asks for a specific status we push the equivalent
    # filter into the MongoDB query so `.limit(500)` doesn't silently
    # truncate the result — this was the root cause of the "dashboard
    # says 108 pending, list only shows 4" discrepancy in prod.
    #
    # v27ac (2026-03-04) — biztranspay added so mobile-money AND crypto
    # USDT.BEP20 activations dispatched through BTP land in the admin panel
    # with the same buckets (pending / validated / rejected) as SoleasPay.
    payment_query: dict = {"provider": {"$in": ["soleaspay", "ashtecpay", "biztranspay"]}}
    if status_filter == "pending":
        payment_query["$or"] = [
            {"status": "pending"},
            {"status": "paid", "activation_done": {"$ne": True}},
        ]
    elif status_filter == "validated":
        payment_query["status"] = "paid"
        payment_query["activation_done"] = True
    elif status_filter == "rejected":
        payment_query["status"] = {"$in": ["failed", "expired"]}
    auto_cursor = db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).limit(500)
    async for p in auto_cursor:
        raw_status = p.get("status") or "pending"
        if raw_status == "paid":
            mapped_status = "validated" if p.get("activation_done") else "pending"
        elif raw_status in ("failed", "expired"):
            mapped_status = "rejected"
        else:
            mapped_status = "pending"
        if status_filter and mapped_status != status_filter:
            continue
        provider_name = p.get("provider") or "soleaspay"
        merged = {
            "id": p.get("reference"),
            "user_id": p.get("user_id"),
            "username": p.get("username"),
            "email": None,  # not stored on payment doc
            "level": p.get("level"),
            "amount": p.get("amount"),
            "currency": p.get("currency") or "XOF",
            "payment_method": "automatic",
            "operator": p.get("operator") or p.get("service_label"),
            "payment_phone": p.get("phone"),
            "payer_country": p.get("country_code"),
            "status": mapped_status,
            "created_at": p.get("created_at"),
            "updated_at": p.get("updated_at"),
            "validated_at": p.get("updated_at") if mapped_status == "validated" else None,
            "rejected_at": p.get("updated_at") if mapped_status == "rejected" else None,
            "transaction_ref": p.get("transaction_id"),
            "reference": p.get("reference"),
            "activation_done": bool(p.get("activation_done")),
            "activation_error": p.get("activation_error"),
            "soleaspay_status": p.get("soleaspay_status"),
            "source": "payment",
            "provider": provider_name,
            "is_stuck": (raw_status == "paid" and not p.get("activation_done")),
        }
        items.append(merged)

    # Sort the merged list by created_at desc (handle None safely)
    def _ts(x):
        v = x.get("created_at")
        if isinstance(v, datetime):
            return v
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)
    items.sort(key=_ts, reverse=True)
    return items


@admin_router.post("/activations/{activation_id}/validate")
async def admin_validate_activation(activation_id: str, request: Request, admin=Depends(require_admin)):
    """Validate a pending activation. Works for BOTH manual/crypto activations
    (db.activations.id) AND automatic SoleasPay payments (db.payments.reference).
    """
    db = request.app.state.db
    act = await db.activations.find_one({"id": activation_id})
    if act:
        if act["status"] != "pending":
            raise HTTPException(400, "Activation déjà traitée.")
        try:
            await activate_level(db, act["user_id"], act["level"], source="admin_validate")
        except ValueError as e:
            raise HTTPException(400, str(e))
        await db.activations.update_one(
            {"id": activation_id},
            {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc), "validated_by": admin["id"]}},
        )
        await db.admin_logs.insert_one({
            "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "validate_activation",
            "target": activation_id, "at": datetime.now(timezone.utc),
        })
        return {"ok": True}

    # Fallback: look up SoleasPay payment by reference
    p = await db.payments.find_one({"reference": activation_id})
    if not p:
        raise HTTPException(404, "Activation introuvable.")
    level = int(p.get("level") or 1)
    if p.get("activation_done"):
        return {"ok": True, "already_activated": True, "level": level}
    # If user is already at-or-above this level, just reconcile the flag
    u_now = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1}) or {}
    if int(u_now.get("max_level") or 0) >= level:
        await db.payments.update_one(
            {"reference": activation_id},
            {"$set": {"status": "paid", "activation_done": True,
                      "validated_at": datetime.now(timezone.utc), "validated_by": admin["id"],
                      "updated_at": datetime.now(timezone.utc)},
             "$unset": {"activation_error": ""}},
        )
        return {"ok": True, "already_activated": True, "level": level}
    try:
        await activate_level(db, p["user_id"], level, source="admin_validate")
    except ValueError as e:
        raise HTTPException(400, str(e))
    await db.payments.update_one(
        {"reference": activation_id},
        {"$set": {"status": "paid", "activation_done": True,
                  "validated_at": datetime.now(timezone.utc), "validated_by": admin["id"],
                  "updated_at": datetime.now(timezone.utc)},
         "$unset": {"activation_error": ""}},
    )
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "validate_payment",
        "target": activation_id, "at": datetime.now(timezone.utc),
    })
    return {"ok": True, "level": level}


@admin_router.post("/activations/{activation_id}/reject")
async def admin_reject_activation(activation_id: str, request: Request, admin=Depends(require_admin)):
    """Reject a pending activation. Works for BOTH manual/crypto activations
    (db.activations.id) AND automatic SoleasPay payments (db.payments.reference).
    """
    db = request.app.state.db
    res = await db.activations.update_one(
        {"id": activation_id, "status": "pending"},
        {"$set": {"status": "rejected", "rejected_at": datetime.now(timezone.utc), "rejected_by": admin["id"]}},
    )
    if res.matched_count:
        await db.admin_logs.insert_one({
            "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "reject_activation",
            "target": activation_id, "at": datetime.now(timezone.utc),
        })
        return {"ok": True}

    # Fallback: SoleasPay payment by reference
    p = await db.payments.find_one({"reference": activation_id})
    if not p:
        raise HTTPException(404, "Activation introuvable.")
    if p.get("activation_done"):
        raise HTTPException(400, "Ce paiement a déjà été activé — impossible de rejeter.")
    await db.payments.update_one(
        {"reference": activation_id},
        {"$set": {"status": "failed",
                  "activation_error": f"Rejeté par l'admin {admin.get('username')}",
                  "rejected_at": datetime.now(timezone.utc), "rejected_by": admin["id"],
                  "updated_at": datetime.now(timezone.utc)}},
    )
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "reject_payment",
        "target": activation_id, "at": datetime.now(timezone.utc),
    })
    return {"ok": True}


@admin_router.delete("/users/{user_id}")
async def admin_delete_user(user_id: str, request: Request, admin=Depends(require_admin)):
    """Hard-delete a user and all their related data (payments, activations,
    withdrawals, mission claims). Safety guards:
      • Cannot delete admin accounts.
      • Cannot delete users with matrix positions (max_level > 0) to protect
        the binary matrix integrity. Use the audit script for those cases.
      • Children (users whose sponsor_id points to this user) are re-assigned
        to the admin to avoid orphan references.
    """
    db = request.app.state.db
    u = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not u:
        raise HTTPException(404, "Utilisateur introuvable.")
    if u.get("is_admin") or u.get("email") == os.environ.get("ADMIN_EMAIL"):
        raise HTTPException(400, "Impossible de supprimer un compte administrateur.")
    if int(u.get("max_level") or 0) > 0:
        raise HTTPException(400, f"Impossible de supprimer {u['username']} : niveau {u['max_level']} activé. Utilisez l'audit avant de supprimer.")
    # Re-assign children to the admin to avoid orphan sponsor_id references
    admin_id = admin["id"]
    children_res = await db.users.update_many(
        {"sponsor_id": user_id}, {"$set": {"sponsor_id": admin_id}},
    )
    # Hard delete all related data
    payments_del = await db.payments.delete_many({"user_id": user_id})
    activations_del = await db.activations.delete_many({"user_id": user_id})
    withdrawals_del = await db.withdrawals.delete_many({"user_id": user_id})
    matrix_del = await db.matrix.delete_many({"user_id": user_id})
    # Mission claims (if module enabled)
    try:
        mission_claims_del = await db.mission_claims.delete_many({"user_id": user_id})
        mission_claims_count = mission_claims_del.deleted_count
    except Exception:
        mission_claims_count = 0
    try:
        notifications_del = await db.notifications.delete_many({"user_id": user_id})
        notifications_count = notifications_del.deleted_count
    except Exception:
        notifications_count = 0
    # Finally, the user
    await db.users.delete_one({"id": user_id})
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin_id, "action": "delete_user",
        "target": user_id,
        "metadata": {
            "username": u.get("username"), "email": u.get("email"),
            "children_reassigned": children_res.modified_count,
            "payments_deleted": payments_del.deleted_count,
            "activations_deleted": activations_del.deleted_count,
            "withdrawals_deleted": withdrawals_del.deleted_count,
            "matrix_positions_deleted": matrix_del.deleted_count,
            "mission_claims_deleted": mission_claims_count,
            "notifications_deleted": notifications_count,
        },
        "at": datetime.now(timezone.utc),
    })
    return {
        "ok": True,
        "deleted_user": u.get("username"),
        "children_reassigned": children_res.modified_count,
        "payments_deleted": payments_del.deleted_count,
        "activations_deleted": activations_del.deleted_count,
        "withdrawals_deleted": withdrawals_del.deleted_count,
        "matrix_positions_deleted": matrix_del.deleted_count,
    }


@admin_router.get("/withdrawals")
async def admin_list_withdrawals(request: Request, status_filter: Optional[str] = Query(None, alias="status")):
    """Unified withdrawals list: MLM commissions + Paid Missions.
    Each item exposes a `withdrawal_type` ∈ {"commissions", "mission"} so the
    UI can render a distinguishing badge.

    v27ae (2026-03-04) — status_filter is expanded so gateway-lifecycle
    statuses land in the correct admin sub-tab :
        pending   ← pending | dispatched | processing
        validated ← validated | completed
        rejected  ← rejected | failed
    """
    db = request.app.state.db
    if status_filter == "pending":
        q = {"status": {"$in": ["pending", "dispatched", "processing"]}}
    elif status_filter == "validated":
        q = {"status": {"$in": ["validated", "completed"]}}
    elif status_filter == "rejected":
        q = {"status": {"$in": ["rejected", "failed"]}}
    elif status_filter:
        q = {"status": status_filter}
    else:
        q = {}
    items = await db.withdrawals.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    for it in items:
        it.setdefault("withdrawal_type", "commissions")
        it["source"] = "withdrawals"
    # Merge mission withdrawals
    try:
        async for mw in db.mission_withdrawals.find(q, {"_id": 0}).sort("created_at", -1).limit(500):
            it = {
                "id": mw.get("id"),
                "user_id": mw.get("user_id"),
                "username": mw.get("username"),
                "amount": float(mw.get("amount") or 0),
                "fee": float(mw.get("fee") or 0) if mw.get("fee") is not None else None,
                "fee_percent": mw.get("fee_percent"),
                "net_payout": float(mw.get("net_payout") or 0) if mw.get("net_payout") is not None else None,
                "status": mw.get("status", "pending"),
                "created_at": mw.get("created_at"),
                "decided_at": mw.get("decided_at"),
                "decided_by": mw.get("decided_by"),
                "reject_reason": mw.get("reject_reason"),
                "wallet": mw.get("wallet"),
                # Copied classic-wallet fields so the admin can pay from the
                # same panel without cross-referencing the users collection.
                "method": mw.get("method", ""),
                "operator": mw.get("operator", ""),
                "phone": mw.get("phone", ""),
                "network": mw.get("network", ""),
                "wallet_address": mw.get("wallet_address", ""),
                "full_name": mw.get("full_name", ""),
                "country": mw.get("country", ""),
                "withdrawal_type": "mission",
                "source": "mission_withdrawals",
            }
            items.append(it)
    except Exception:
        pass

    def _ts(x):
        v = x.get("created_at")
        if isinstance(v, datetime):
            return v
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except Exception:
            return datetime.min.replace(tzinfo=timezone.utc)
    items.sort(key=_ts, reverse=True)
    return items


@admin_router.post("/withdrawals/{wd_id}/validate")
async def admin_validate_withdrawal(wd_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    wd = await db.withdrawals.find_one({"id": wd_id})
    if wd:
        # v27ag (2026-03-04) — accept validate on gateway-lifecycle statuses
        # too (dispatched / processing). Manual validation of an auto-dispatched
        # retrait means the admin trusts the gateway succeeded even without
        # webhook — just marks it as validated + credits total_withdrawn.
        if wd["status"] not in ("pending", "dispatched", "processing"):
            raise HTTPException(400, "Déjà traité.")

        # If the retrait was already auto-dispatched to Biz-transPay, don't
        # re-dispatch — the admin's click is a manual override that just marks
        # our internal doc as validated.
        if wd.get("auto_dispatched") and wd.get("gateway") == "biztranspay":
            await db.withdrawals.update_one(
                {"id": wd_id},
                {"$set": {"status": "completed",
                          "completed_at": datetime.now(timezone.utc),
                          "validated_at": datetime.now(timezone.utc),
                          "validated_by": admin["id"],
                          "validation_source": "admin_override"}},
            )
            await db.users.update_one({"id": wd["user_id"]}, {"$inc": {"total_withdrawn": wd["amount"]}})
            await db.admin_logs.insert_one({
                "id": str(uuid.uuid4()), "admin_id": admin["id"],
                "action": "validate_auto_withdrawal_override",
                "target": wd_id, "at": datetime.now(timezone.utc),
            })
            return {"ok": True, "auto_dispatched": True, "override": True}

        # Auto-payout via IziChangePay if the withdrawal is a crypto one AND
        # the admin has enabled `auto_withdrawal`. Otherwise fall through to
        # the classic manual validation (status=validated, admin credits by
        # hand off-platform).
        from feature_flags import is_enabled as _flag_on
        from izichange import create_payout, USDT_XOF_RATE
        auto_ok = (
            wd.get("method") == "crypto"
            and wd.get("wallet_address")
            and (wd.get("network") or "").upper().replace(" ", "").endswith("BEP20")
            and await _flag_on(db, "auto_withdrawal")
        )
        if auto_ok:
            net_xof = float(wd.get("net_payout") or wd.get("amount") or 0)
            usdt_amount = round(net_xof / USDT_XOF_RATE, 6)
            try:
                payout = await create_payout(
                    db,
                    reference=wd_id,
                    amount_usdt=usdt_amount,
                    destination_address=wd["wallet_address"],
                    metadata={"user_id": wd["user_id"], "network": "BEP20",
                              "xof_amount": net_xof, "rate": USDT_XOF_RATE},
                )
            except HTTPException as e:
                # Surface the gateway error to the admin — do NOT mark validated.
                raise
            await db.withdrawals.update_one(
                {"id": wd_id},
                {"$set": {"status": "dispatched",
                          "gateway": "izichange",
                          "payout_id": payout.get("id"),
                          "gateway_status": payout.get("status"),
                          "usdt_amount": usdt_amount,
                          "usdt_rate": USDT_XOF_RATE,
                          "dispatched_at": datetime.now(timezone.utc),
                          "dispatched_by": admin["id"]}},
            )
            await db.users.update_one({"id": wd["user_id"]}, {"$inc": {"total_withdrawn": wd["amount"]}})
            await db.admin_logs.insert_one({
                "id": str(uuid.uuid4()), "admin_id": admin["id"],
                "action": "auto_dispatch_withdrawal",
                "target": wd_id, "payout_id": payout.get("id"),
                "at": datetime.now(timezone.utc),
            })
            return {"ok": True, "auto_dispatched": True,
                    "payout_id": payout.get("id"),
                    "usdt_amount": usdt_amount}

        # Classic manual path.
        await db.withdrawals.update_one(
            {"id": wd_id},
            {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc), "validated_by": admin["id"]}},
        )
        await db.users.update_one({"id": wd["user_id"]}, {"$inc": {"total_withdrawn": wd["amount"]}})
        await db.admin_logs.insert_one({
            "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "validate_withdrawal",
            "target": wd_id, "at": datetime.now(timezone.utc),
        })
        return {"ok": True}
    # Fallback: mission withdrawal (delegate to the missions module's logic)
    mw = await db.mission_withdrawals.find_one({"id": wd_id})
    if not mw:
        raise HTTPException(404, "Retrait introuvable.")
    if mw["status"] != "pending":
        raise HTTPException(400, "Déjà traité.")
    await db.mission_withdrawals.update_one(
        {"id": wd_id},
        {"$set": {"status": "validated", "decided_at": datetime.now(timezone.utc), "decided_by": admin.get("username")}},
    )
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "validate_mission_withdrawal",
        "target": wd_id, "at": datetime.now(timezone.utc),
    })
    return {"ok": True}


@admin_router.post("/withdrawals/{wd_id}/reject")
async def admin_reject_withdrawal(wd_id: str, request: Request, admin=Depends(require_admin), body: dict | None = None):
    db = request.app.state.db
    reason = ((body or {}) if isinstance(body, dict) else {}).get("reason") or ""
    wd = await db.withdrawals.find_one({"id": wd_id})
    if wd:
        # v27ag (2026-03-04) — accept reject on gateway-lifecycle statuses
        # too (dispatched / processing), not just pending. Otherwise stuck
        # auto-retraits are unrejectable from the admin panel.
        if wd["status"] not in ("pending", "dispatched", "processing"):
            raise HTTPException(400, "Déjà traité.")
        # Refund balance
        await db.users.update_one({"id": wd["user_id"]}, {"$inc": {"balance_profit": wd["amount"]}})
        await db.withdrawals.update_one(
            {"id": wd_id},
            {"$set": {"status": "rejected", "rejected_at": datetime.now(timezone.utc), "rejected_by": admin["id"], "reject_reason": reason}},
        )
        await db.admin_logs.insert_one({
            "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "reject_withdrawal",
            "target": wd_id, "at": datetime.now(timezone.utc),
        })
        return {"ok": True}
    # Fallback: mission withdrawal
    mw = await db.mission_withdrawals.find_one({"id": wd_id})
    if not mw:
        raise HTTPException(404, "Retrait introuvable.")
    if mw["status"] != "pending":
        raise HTTPException(400, "Déjà traité.")
    # Refund the mission wallet
    try:
        from missions import BALANCE_FIELD as _MBF
        bal_field = _MBF.get(mw.get("wallet"))
    except Exception:
        bal_field = None
    if bal_field:
        await db.users.update_one({"id": mw["user_id"]}, {"$inc": {bal_field: float(mw.get("amount") or 0)}})
    await db.mission_withdrawals.update_one(
        {"id": wd_id},
        {"$set": {"status": "rejected", "decided_at": datetime.now(timezone.utc), "decided_by": admin.get("username"), "reject_reason": reason}},
    )
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "reject_mission_withdrawal",
        "target": wd_id, "at": datetime.now(timezone.utc),
    })
    return {"ok": True}


@admin_router.get("/announcements")
async def admin_list_announcements(request: Request):
    db = request.app.state.db
    return await db.announcements.find({}, {"_id": 0}).sort("created_at", -1).to_list(200)


@admin_router.post("/announcements")
async def admin_create_announcement(data: AnnouncementIn, request: Request):
    db = request.app.state.db
    doc = data.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = datetime.now(timezone.utc)
    await db.announcements.insert_one(doc)
    doc.pop("_id", None)
    return doc


@admin_router.delete("/announcements/{aid}")
async def admin_delete_announcement(aid: str, request: Request):
    db = request.app.state.db
    await db.announcements.delete_one({"id": aid})
    return {"ok": True}


@admin_router.post("/announcements/{aid}/toggle")
async def admin_toggle_announcement(aid: str, request: Request):
    db = request.app.state.db
    a = await db.announcements.find_one({"id": aid})
    if not a:
        raise HTTPException(404, "Introuvable.")
    await db.announcements.update_one({"id": aid}, {"$set": {"active": not a.get("active", True)}})
    return {"ok": True}


@admin_router.get("/channels")
async def admin_list_channels(request: Request):
    db = request.app.state.db
    return await db.channels.find({}, {"_id": 0}).to_list(200)


@admin_router.post("/channels")
async def admin_create_channel(data: ChannelIn, request: Request):
    db = request.app.state.db
    doc = data.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = datetime.now(timezone.utc)
    await db.channels.insert_one(doc)
    doc.pop("_id", None)
    return doc


@admin_router.delete("/channels/{cid}")
async def admin_delete_channel(cid: str, request: Request):
    db = request.app.state.db
    await db.channels.delete_one({"id": cid})
    return {"ok": True}


@admin_router.get("/logs")
async def admin_logs_list(request: Request):
    db = request.app.state.db
    return await db.admin_logs.find({}, {"_id": 0}).sort("at", -1).to_list(200)


@admin_router.post("/withdrawals/{wd_id}/reconcile")
async def admin_reconcile_withdrawal(wd_id: str, request: Request, admin=Depends(require_admin)):
    """v27af (2026-03-04) — force-poll the payment gateway for a stuck
    auto-dispatched withdrawal. Currently supports Biz-transPay; extendable
    to other gateways by dispatching on `wd.gateway`."""
    db = request.app.state.db
    wd = await db.withdrawals.find_one({"id": wd_id}, {"_id": 0})
    if not wd:
        raise HTTPException(404, "Retrait introuvable.")
    if wd.get("gateway") != "biztranspay":
        raise HTTPException(400, f"Reconcile non supporté pour la passerelle '{wd.get('gateway')}'.")
    from biztranspay import reconcile_withdrawal as _btp_recon
    r = await _btp_recon(db, wd)
    return r


@admin_router.post("/withdrawals/reconcile-all")
async def admin_reconcile_all_withdrawals(request: Request, admin=Depends(require_admin)):
    """v27af — one-shot sweep of every stuck auto-dispatched BTP withdrawal."""
    db = request.app.state.db
    from biztranspay import reconcile_all_dispatched as _btp_recon_all
    r = await _btp_recon_all(db)
    return r


@admin_router.get("/stats/timeseries")
async def admin_timeseries(request: Request, days: int = 14):
    db = request.app.state.db
    start = datetime.now(timezone.utc) - timedelta(days=days)

    async def series(collection: str, match: dict | None = None):
        pipeline = []
        match_q = {"created_at": {"$gte": start}}
        if match:
            match_q.update(match)
        pipeline.append({"$match": match_q})
        pipeline.append({"$group": {
            "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}},
            "count": {"$sum": 1},
        }})
        pipeline.append({"$sort": {"_id": 1}})
        return await db[collection].aggregate(pipeline).to_list(60)

    return {
        "registrations": await series("users"),
        "activations": await series("activations", {"status": "validated"}),
        "withdrawals": await series("withdrawals", {"status": "validated"}),
    }


@admin_router.get("/settings/manual-payment")
async def admin_get_manual_payment(request: Request):
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "manual_payment"}, {"_id": 0}) or {}
    return {
        "enabled": bool(doc.get("enabled", False)),
        "payment_url": doc.get("payment_url") or "",
        "title": doc.get("title") or "Paiement manuel",
        "instructions": doc.get("instructions") or "",
        "phone_to_pay": doc.get("phone_to_pay") or "",
        "operator_name": doc.get("operator_name") or "",
        "allowed_countries": doc.get("allowed_countries") or [],
        "updated_at": doc.get("updated_at"),
        "updated_by": doc.get("updated_by"),
    }


@admin_router.put("/settings/manual-payment")
async def admin_update_manual_payment(
    data: ManualPaymentSettings, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    payload = {
        "enabled": data.enabled,
        "payment_url": (data.payment_url or "").strip(),
        "title": (data.title or "Paiement manuel").strip(),
        "instructions": (data.instructions or "").strip(),
        "phone_to_pay": (data.phone_to_pay or "").strip(),
        "operator_name": (data.operator_name or "").strip(),
        "allowed_countries": [c.strip().upper() for c in (data.allowed_countries or []) if c and c.strip()],
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "manual_payment"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}



# --- Withdrawal settings ---

@admin_router.get("/webhook-logs")
async def admin_webhook_logs(request: Request, limit: int = 50):
    """Return the most recent webhook hits for debugging."""
    db = request.app.state.db
    cursor = db.webhook_logs.find({}, {"_id": 0}).sort("received_at", -1).limit(min(max(1, limit), 200))
    out = []
    async for d in cursor:
        if isinstance(d.get("received_at"), datetime):
            d["received_at"] = d["received_at"].isoformat()
        out.append(d)
    return {"items": out, "count": len(out)}


@admin_router.get("/settings/crypto-payment")
async def admin_get_crypto_payment(request: Request):
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "crypto_payment"}, {"_id": 0}) or {}
    return {
        "enabled": bool(doc.get("enabled", False)),
        "network": doc.get("network") or "USDT BEP20",
        "wallet_address": doc.get("wallet_address") or "",
        "amount_usdt": doc.get("amount_usdt") or 5.0,
        "instructions": doc.get("instructions") or "",
        "updated_at": doc.get("updated_at"),
        "updated_by": doc.get("updated_by"),
    }


@admin_router.put("/settings/crypto-payment")
async def admin_update_crypto_payment(
    data: CryptoPaymentSettings, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    payload = {
        "enabled": bool(data.enabled),
        "network": (data.network or "USDT BEP20").strip(),
        "wallet_address": (data.wallet_address or "").strip(),
        "amount_usdt": float(data.amount_usdt or 5.0),
        "instructions": (data.instructions or "").strip(),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "crypto_payment"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}


@admin_router.get("/settings/withdrawal")
async def admin_get_withdrawal_settings(request: Request):
    db = request.app.state.db
    settings = await _get_withdrawal_settings(db)
    raw = await db.app_settings.find_one({"_id": "withdrawal_settings"}, {"_id": 0}) or {}
    settings["updated_at"] = raw.get("updated_at")
    settings["updated_by"] = raw.get("updated_by")
    return settings


@admin_router.put("/settings/withdrawal")
async def admin_update_withdrawal_settings(
    data: WithdrawalSettings, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    payload = {
        "fee_percent": float(data.fee_percent),
        "fee_flat": float(data.fee_flat),
        "min_amount": float(data.min_amount),
        "max_amount": float(data.max_amount) if data.max_amount is not None else None,
        "enabled": bool(data.enabled),
        "allowed_days": sorted({int(d) for d in (data.allowed_days or []) if 0 <= int(d) <= 6}),
        "open_time": data.open_time or "07:00",
        "close_time": data.close_time or "20:00",
        "timezone": data.timezone or "Africa/Lome",
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "withdrawal_settings"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}


# --- Support / Social links ---

@admin_router.get("/settings/support")
async def admin_get_support_links(request: Request):
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "support_links"}, {"_id": 0}) or {}
    out = _support_defaults(doc)
    out["updated_at"] = doc.get("updated_at")
    out["updated_by"] = doc.get("updated_by")
    return out


@admin_router.put("/settings/support")
async def admin_update_support_links(
    data: SupportLinks, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    payload = {
        "telegram_url": (data.telegram_url or "").strip(),
        "whatsapp_url": (data.whatsapp_url or "").strip(),
        "facebook_url": (data.facebook_url or "").strip(),
        "youtube_url": (data.youtube_url or "").strip(),
        "instagram_url": (data.instagram_url or "").strip(),
        "twitter_url": (data.twitter_url or "").strip(),
        "discord_url": (data.discord_url or "").strip(),
        "email": (data.email or "").strip(),
        "phone": (data.phone or "").strip(),
        "website_url": (data.website_url or "").strip(),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "support_links"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}


# --- Community Popup ---

@admin_router.get("/settings/community-popup")
async def admin_get_community_popup(request: Request):
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "community_popup"}, {"_id": 0}) or {}
    out = _community_popup_defaults(doc)
    out["updated_at"] = doc.get("updated_at")
    out["updated_by"] = doc.get("updated_by")
    return out


@admin_router.put("/settings/community-popup")
async def admin_update_community_popup(
    data: CommunityPopupSettings, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    payload = {
        "enabled": bool(data.enabled),
        "title": (data.title or "").strip(),
        "description": (data.description or "").strip(),
        "image_url": (data.image_url or "").strip(),
        "telegram_url": (data.telegram_url or "").strip(),
        "button_label": (data.button_label or "🚀 REJOINDRE MAINTENANT").strip(),
        "auto_close_seconds": int(data.auto_close_seconds or 0),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "community_popup"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}


# --- Trading Telegram channel (v26) ---

@admin_router.get("/settings/trading")
async def admin_get_trading_settings(request: Request):
    db = request.app.state.db
    doc = await db.app_settings.find_one({"_id": "trading_settings"}, {"_id": 0}) or {}
    out = _trading_defaults(doc)
    out["updated_at"] = doc.get("updated_at")
    out["updated_by"] = doc.get("updated_by")
    return out


@admin_router.put("/settings/trading")
async def admin_update_trading_settings(
    data: TradingSettings, request: Request, admin=Depends(require_admin),
):
    db = request.app.state.db
    url = (data.telegram_url or "").strip()
    if url and not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "L'URL Telegram doit commencer par http:// ou https://.")
    payload = {
        "enabled": bool(data.enabled),
        "telegram_url": url,
        "title": (data.title or "TRADING").strip(),
        "description": (data.description or "").strip(),
        "button_label": (data.button_label or "Accéder au canal Telegram").strip(),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.app_settings.update_one(
        {"_id": "trading_settings"}, {"$set": payload}, upsert=True,
    )
    return {"ok": True, "settings": payload}


# --- Withdrawal settings ---

@admin_router.get("/payments/stuck")
async def admin_stuck_payments(request: Request, limit: int = 50):
    """List payments that are paid but failed to activate the user level.
    Used by the admin dashboard to surface and re-process bug-stranded
    transactions in one click."""
    db = request.app.state.db
    cursor = db.payments.find(
        {"status": "paid", "activation_done": {"$ne": True}},
        {
            "_id": 0,
            "reference": 1, "provider": 1, "user_id": 1, "username": 1,
            "level": 1, "amount": 1, "currency": 1, "phone": 1,
            "country_code": 1, "created_at": 1, "activation_error": 1,
        },
    ).sort("created_at", -1).limit(min(max(1, limit), 200))
    items = []
    async for d in cursor:
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        items.append(d)
    return {"items": items, "count": len(items)}


@admin_router.get("/payments")
async def admin_list_payments(
    request: Request,
    status_filter: Optional[str] = Query(None, alias="status",
        description="Filter by status: pending, paid, failed"),
    stuck_only: bool = Query(False, description="Show only paid+not-activated"),
    q: Optional[str] = Query(None, description="Search reference/username/transaction_id"),
    limit: int = 100,
):
    """List all payments (SendavaPay) with optional filters for the admin UI."""
    db = request.app.state.db
    flt: dict = {}
    if stuck_only:
        flt["status"] = "paid"
        flt["activation_done"] = {"$ne": True}
    elif status_filter:
        flt["status"] = status_filter
    if q:
        flt["$or"] = [
            {"reference": {"$regex": q, "$options": "i"}},
            {"username": {"$regex": q, "$options": "i"}},
            {"transaction_id": {"$regex": q, "$options": "i"}},
        ]

    cursor = db.payments.find(flt, {
        "_id": 0, "reference": 1, "provider": 1, "user_id": 1, "username": 1,
        "level": 1, "amount": 1, "currency": 1, "phone": 1, "country_code": 1,
        "status": 1, "activation_done": 1, "activation_error": 1,
        "transaction_id": 1, "payment_url": 1, "created_at": 1, "updated_at": 1,
    }).sort("created_at", -1).limit(min(max(1, limit), 500))
    items = []
    async for d in cursor:
        for k in ("created_at", "updated_at"):
            if isinstance(d.get(k), datetime):
                d[k] = d[k].isoformat()
        items.append(d)
    # Aggregate counts for the badge UI
    counts = {
        "total": await db.payments.count_documents({}),
        "pending": await db.payments.count_documents({"status": "pending"}),
        "paid": await db.payments.count_documents({"status": "paid"}),
        "failed": await db.payments.count_documents({"status": "failed"}),
        "stuck": await db.payments.count_documents({"status": "paid", "activation_done": {"$ne": True}}),
    }
    return {"items": items, "count": len(items), "counts": counts}


@admin_router.post("/payments/{reference}/reprocess")
async def admin_reprocess_payment(reference: str, request: Request, admin=Depends(require_admin)):
    """Force-activate a paid payment whose activation step failed.

    Useful when the webhook arrived (status=paid) but `activate_level`
    raised an exception — see `activation_error` field on the payment.
    """
    db = request.app.state.db
    p = await db.payments.find_one({"reference": reference}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Paiement introuvable")
    if p.get("status") != "paid":
        raise HTTPException(400, f"Le paiement n'est pas en statut paid (actuel: {p.get('status')})")
    level = int(p.get("level") or 1)
    if p.get("activation_done"):
        return {"ok": True, "already_activated": True, "level": level}
    # If the underlying user is already at-or-above this level, just mark the
    # payment as activated without calling activate_level again (which would
    # raise "Vous devez activer les niveaux dans l'ordre"). This handles the
    # case where a previous activation succeeded but the activation_done flag
    # was not set due to a downstream error.
    u = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1}) or {}
    if int(u.get("max_level") or 0) >= level:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
        )
        return {"ok": True, "already_activated": True, "level": level, "reconciled": True}
    try:
        await activate_level(db, p["user_id"], level, source="manual_reprocess")
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
        )
        return {"ok": True, "level": level, "user_id": p["user_id"]}
    except Exception as exc:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_error": str(exc)}},
        )
        raise HTTPException(500, f"Activation échouée: {exc}")


# ─── Ghost-activation repair ────────────────────────────────────────────
# Bug 2026-09-07 v4 : some users ended up with `status="active"` while their
# `max_level` remained at 0. Root cause: an earlier version of
# `_apply_payment_success` pre-flipped the user's status BEFORE calling
# `activate_level`; when `activate_level` then raised, the status stayed
# stuck as "active" but no matrix placement / max_level bump happened.
# This endpoint scans for such ghost states and either:
#   • re-runs `activate_level` when a paid payment for L1 exists (idempotent
#     safe path via source="admin_validate"), or
#   • rolls the user back to `status="pending"` so the guard forces them
#     through the payment flow again.
@admin_router.get("/repair/ghost-activations")
async def admin_scan_ghost_activations(request: Request, _admin=Depends(require_admin)):
    """List users stuck with status=active + max_level=0 for admin review."""
    db = request.app.state.db
    items = []
    async for u in db.users.find(
        {"status": "active", "max_level": {"$lte": 0}, "role": "user"},
        {"_id": 0, "id": 1, "username": 1, "email": 1, "phone": 1, "country": 1,
         "sponsor_id": 1, "created_at": 1},
    ).sort("created_at", -1).limit(500):
        # attach the latest payment for context
        p = await db.payments.find_one(
            {"user_id": u["id"], "level": 1},
            {"_id": 0, "reference": 1, "status": 1, "amount": 1, "currency": 1,
             "activation_error": 1, "activation_done": 1, "gateway": 1,
             "provider": 1, "created_at": 1},
            sort=[("created_at", -1)],
        )
        if isinstance(u.get("created_at"), datetime):
            u["created_at"] = u["created_at"].isoformat()
        if p and isinstance(p.get("created_at"), datetime):
            p["created_at"] = p["created_at"].isoformat()
        u["latest_payment"] = p
        items.append(u)
    return {"count": len(items), "items": items}


@admin_router.post("/repair/ghost-activations")
async def admin_repair_ghost_activations(request: Request, _admin=Depends(require_admin)):
    """Repair every user with the ACTIVE-but-lvl-0 ghost state.

    Strategy per user:
      1. If a paid or validated L1 payment exists → re-run activate_level
         via source='admin_validate' (idempotent, sets max_level=1).
      2. Otherwise → roll status back to 'pending' so the layout guard
         forces the user through the payment flow again.
    """
    db = request.app.state.db
    repaired: list[dict] = []
    rolled_back: list[dict] = []
    failed: list[dict] = []
    async for u in db.users.find(
        {"status": "active", "max_level": {"$lte": 0}, "role": "user"},
        {"_id": 0, "id": 1, "username": 1, "email": 1},
    ):
        uid = u["id"]
        p = await db.payments.find_one(
            {"user_id": uid, "level": 1,
             "status": {"$in": ["paid", "validated"]}},
            {"_id": 0, "reference": 1},
            sort=[("created_at", -1)],
        )
        if p:
            try:
                await activate_level(db, uid, 1, source="admin_validate")
                await db.payments.update_one(
                    {"reference": p["reference"]},
                    {"$set": {"activation_done": True, "status": "validated"},
                     "$unset": {"activation_error": ""}},
                )
                repaired.append({"user_id": uid, "username": u.get("username"),
                                 "reference": p["reference"]})
            except Exception as exc:
                failed.append({"user_id": uid, "username": u.get("username"),
                               "error": str(exc)[:200]})
        else:
            await db.users.update_one(
                {"id": uid},
                {"$set": {"status": "pending", "ghost_rolled_back_at":
                          datetime.now(timezone.utc)}},
            )
            rolled_back.append({"user_id": uid, "username": u.get("username")})
    return {"repaired": repaired, "rolled_back": rolled_back, "failed": failed,
            "totals": {"repaired": len(repaired), "rolled_back": len(rolled_back),
                       "failed": len(failed)}}


# ============ SOLEASPAY (Mobile Money, polling-based) ============


class SoleaspayInitiateIn(BaseModel):
    level: int
    phone: str
    country_code: str
    service_id: int


@api.post("/payments/soleaspay/initiate")
async def soleaspay_initiate(
    data: SoleaspayInitiateIn,
    request: Request,
    user=Depends(get_current_user),
):
    """Initiate an automatic payment. Despite its legacy URL the endpoint now
    dispatches to the active gateway (SoleasPay OR AshtecPay) based on the
    admin configuration in `app_settings.payment_gateway.active`. The user
    only ever sees "Paiement Automatique" in the UI.
    """
    db = request.app.state.db
    gw = await _load_payment_gateway(db)
    active = gw.get("active", "soleas")
    # Fallback chain if the selected gateway is disabled.
    priority = [
        ("soleas", gw.get("soleas_enabled")),
        ("ashtec", gw.get("ashtec_enabled")),
    ]
    if not next((en for k, en in priority if k == active and en), False):
        active = next((k for k, en in priority if en), None)
    if active is None:
        raise HTTPException(503, "Aucune passerelle automatique n'est activée. Contactez l'administrateur.")
    if active == "ashtec":
        return await _initiate_via_ashtec(data, request, user, gw)
    # Default: SoleasPay (existing behavior — unchanged)
    return await _initiate_via_soleas(data, request, user)


async def _initiate_via_soleas(
    data: "SoleaspayInitiateIn", request: Request, user: dict,
) -> dict:
    """Original SoleasPay initiation flow — preserved verbatim."""
    db = request.app.state.db
    if not soleaspay.is_configured():
        raise HTTPException(503, "SoleasPay non configuré (API key manquante)")
    country = (data.country_code or "").upper()
    if country in soleaspay.EXCLUDED_COUNTRIES:
        raise HTTPException(400, f"Pays {country} non disponible sur SoleasPay")
    svc = soleaspay.find_service(country, data.service_id)
    if not svc:
        raise HTTPException(400, f"Service {data.service_id} indisponible pour {country}")

    level = int(data.level)
    if level <= (user.get("max_level") or 0):
        raise HTTPException(400, "Niveau déjà activé")
    lv = LEVELS_BY_NUM.get(level)
    if not lv:
        raise HTTPException(400, f"Niveau {level} invalide")

    order_id = _new_order_id()
    success_url = os.environ.get("SOLEASPAY_SUCCESS_URL", "https://spiloveure.com/services")
    failure_url = os.environ.get("SOLEASPAY_FAILURE_URL", "https://spiloveure.com/activation")

    # Persist the pending payment FIRST so polling can find it.
    await db.payments.insert_one({
        "reference": order_id,
        "provider": "soleaspay",
        "service_id": svc["id"],
        "service_label": svc["label"],
        "user_id": user["id"],
        "username": user.get("username"),
        "level": level,
        "amount": float(lv["price"]),
        "currency": svc["currency"],
        "phone": str(data.phone),
        "country_code": country,
        "status": "pending",
        "activation_done": False,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })

    resp = await soleaspay.initiate_payment(
        db,
        service_id=svc["id"],
        wallet=str(data.phone).strip().replace("+", ""),
        amount=float(lv["price"]),
        currency=svc["currency"],
        order_id=order_id,
        description=f"Activation niveau {level} - SPILOVEURE",
        payer=user.get("username") or "Spiloveure user",
        payer_email=user.get("email") or "",
        success_url=success_url,
        failure_url=failure_url,
    )

    if not resp.get("success"):
        await db.payments.update_one(
            {"reference": order_id},
            {"$set": {"status": "failed",
                      "activation_error": resp.get("message") or "Échec initiation",
                      "soleaspay_response": resp,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(400, resp.get("message") or "SoleasPay a refusé la requête")

    pay_id = (resp.get("data") or {}).get("reference")
    await db.payments.update_one(
        {"reference": order_id},
        {"$set": {"transaction_id": pay_id,
                  "soleaspay_status": resp.get("status"),
                  "updated_at": datetime.now(timezone.utc)}},
    )
    return {
        "order_id": order_id,
        "transaction_id": pay_id,
        "status": "pending",
        "amount": float(lv["price"]),
        "currency": svc["currency"],
        "service_label": svc["label"],
        "message": resp.get("message") or "Vérifiez votre téléphone pour confirmer le paiement",
    }


async def _initiate_via_ashtec(
    data: "SoleaspayInitiateIn", request: Request, user: dict, gw: dict,
) -> dict:
    """AshtecPay initiation flow. Reuses the same `db.payments` collection
    with provider='ashtecpay' so the polling endpoint can dispatch on read.
    """
    db = request.app.state.db
    # DB-first: use the same resolver as the rest of the Ashtech flow.
    from ashtec_activation import _get_api_key as _ash_get_key  # type: ignore
    api_key = await _ash_get_key(db)
    if not api_key:
        raise HTTPException(503, "AshtecPay non configuré (clé API manquante côté admin)")
    country = (data.country_code or "").upper()
    level = int(data.level)
    if level <= (user.get("max_level") or 0):
        raise HTTPException(400, "Niveau déjà activé")
    lv = LEVELS_BY_NUM.get(level)
    if not lv:
        raise HTTPException(400, f"Niveau {level} invalide")
    # Operator label: reuse soleaspay service catalog → user picks an "operator
    # name" via the UI which already maps to soleaspay services. Match by label
    # heuristic (uppercase, prefix). The AshtecPay API accepts the operator
    # name string directly (e.g. "MTN Mobile Money", "Orange Money").
    svc = soleaspay.find_service(country, data.service_id)
    operator_label = (svc or {}).get("label") or ""
    currency = (svc or {}).get("currency") or "XOF"

    order_id = _new_order_id()
    notify_url = os.environ.get("ASHTECPAY_WEBHOOK_URL", "")

    await db.payments.insert_one({
        "reference": order_id,
        "provider": "ashtecpay",
        "service_id": (svc or {}).get("id"),
        "service_label": operator_label,
        "user_id": user["id"],
        "username": user.get("username"),
        "level": level,
        "amount": float(lv["price"]),
        "currency": currency,
        "phone": str(data.phone),
        "country_code": country,
        "status": "pending",
        "activation_done": False,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })

    resp = await ashtecpay.initiate_payment(
        api_key=api_key,
        amount=float(lv["price"]),
        currency=currency,
        phone=str(data.phone).strip(),
        operator=operator_label,
        country_code=country,
        reference=order_id,
        notify_url=notify_url or None,
    )
    if not resp.get("success"):
        # OTP required is a special "soft failure" — still propagate the
        # ussd_code so the UI can prompt the user.
        if resp.get("error") == "otp_required":
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "pending",
                          "ashtecpay_status": "otp_required",
                          "ashtecpay_ussd_code": resp.get("ussd_code"),
                          "updated_at": datetime.now(timezone.utc)}},
            )
            return {
                "order_id": order_id,
                "transaction_id": None,
                "status": "otp_required",
                "amount": float(lv["price"]),
                "currency": currency,
                "service_label": operator_label,
                "message": resp.get("message") or "OTP requis. Composez le code USSD.",
                "ussd_code": resp.get("ussd_code"),
            }
        await db.payments.update_one(
            {"reference": order_id},
            {"$set": {"status": "failed",
                      "activation_error": resp.get("message") or "Échec initiation",
                      "ashtecpay_response": resp,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(400, resp.get("message") or "AshtecPay a refusé la requête")

    txid = resp.get("transaction_id")
    await db.payments.update_one(
        {"reference": order_id},
        {"$set": {"transaction_id": txid,
                  "ashtecpay_status": resp.get("status"),
                  "ashtecpay_flow": resp.get("flow"),
                  "ashtecpay_wave_url": resp.get("wave_url"),
                  "updated_at": datetime.now(timezone.utc)}},
    )
    return {
        "order_id": order_id,
        "transaction_id": txid,
        "status": "pending",
        "amount": float(lv["price"]),
        "currency": currency,
        "service_label": operator_label,
        "flow": resp.get("flow"),
        "wave_url": resp.get("wave_url"),
        "message": resp.get("message") or "Vérifiez votre téléphone pour confirmer le paiement",
    }


async def _verify_soleas_payment(p: dict, order_id: str, request: Request) -> dict:
    db = request.app.state.db
    pay_id = p.get("transaction_id")
    if not pay_id:
        return {"status": "pending", "message": "En attente du téléphone…"}

    resp = await soleaspay.verify_payment(db, order_id, pay_id, service_id=p.get("service_id", 1))
    sp_status = resp.get("status") or ""
    new_status = soleaspay.normalize_status(sp_status, resp.get("success"), resp.get("code"))
    log.info("soleaspay status poll ref=%s sp_status=%r success=%r code=%r → %s",
             order_id, sp_status, resp.get("success"), resp.get("code"), new_status)

    if new_status == "paid" and not p.get("activation_done"):
        level = int(p.get("level") or 1)
        u_now = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1, "status": 1}) or {}
        if int(u_now.get("max_level") or 0) >= level:
            if u_now.get("status") != "active":
                await db.users.update_one({"id": p["user_id"]}, {"$set": {"status": "active"}})
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_done": True,
                          "soleaspay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": "paid", "activation_done": True, "level": level, "reconciled": True}
        try:
            await activate_level(db, p["user_id"], level, source="soleaspay")
            await db.users.update_one(
                {"id": p["user_id"], "status": {"$ne": "active"}},
                {"$set": {"status": "active"}},
            )
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_done": True,
                          "soleaspay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": "paid", "activation_done": True, "level": level}
        except Exception as exc:
            log.exception("soleaspay activate_level failed for ref=%s: %s", order_id, exc)
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_error": str(exc),
                          "soleaspay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)}},
            )
            return {"status": "paid", "activation_done": False, "error": str(exc)}

    if new_status == "failed":
        await db.payments.update_one(
            {"reference": order_id},
            {"$set": {"status": "failed",
                      "activation_error": resp.get("message") or "Paiement refusé",
                      "soleaspay_status": sp_status,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"status": "failed", "error": resp.get("message")}

    return {"status": "pending", "soleaspay_status": sp_status,
            "message": "Confirmation en attente sur le téléphone du client…"}


async def _verify_ashtec_payment(p: dict, order_id: str, request: Request) -> dict:
    db = request.app.state.db
    from ashtec_activation import _get_api_key as _ash_get_key  # type: ignore
    api_key = await _ash_get_key(db)
    if not api_key:
        return {"status": "pending", "message": "Clé AshtecPay non configurée — contactez l'admin."}
    txid = p.get("transaction_id")
    if not txid:
        return {"status": "pending", "message": "En attente du téléphone…"}
    resp = await ashtecpay.verify_payment(api_key=api_key, transaction_id=txid)
    sp_status = resp.get("status") or ""
    new_status = ashtecpay.normalize_status(sp_status)
    log.info("ashtecpay status poll ref=%s sp_status=%r success=%r → %s",
             order_id, sp_status, resp.get("success"), new_status)

    if new_status == "paid" and not p.get("activation_done"):
        level = int(p.get("level") or 1)
        u_now = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1, "status": 1}) or {}
        if int(u_now.get("max_level") or 0) >= level:
            if u_now.get("status") != "active":
                await db.users.update_one({"id": p["user_id"]}, {"$set": {"status": "active"}})
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_done": True,
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": "paid", "activation_done": True, "level": level, "reconciled": True}
        try:
            await activate_level(db, p["user_id"], level, source="ashtecpay")
            await db.users.update_one(
                {"id": p["user_id"], "status": {"$ne": "active"}},
                {"$set": {"status": "active"}},
            )
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_done": True,
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": "paid", "activation_done": True, "level": level}
        except Exception as exc:
            log.exception("ashtecpay activate_level failed for ref=%s: %s", order_id, exc)
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_error": str(exc),
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)}},
            )
            return {"status": "paid", "activation_done": False, "error": str(exc)}

    if new_status == "failed":
        await db.payments.update_one(
            {"reference": order_id},
            {"$set": {"status": "failed",
                      "activation_error": resp.get("message") or "Paiement refusé",
                      "ashtecpay_status": sp_status,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"status": "failed", "error": resp.get("message")}

    return {"status": "pending", "ashtecpay_status": sp_status,
            "message": "Confirmation en attente sur le téléphone du client…"}


api.include_router(admin_router)
app.include_router(api)

# Digital content (formations, ebooks, premium apps, trading) — registered separately
# with their own /api prefixes (public_router) and /api/admin prefix (admin_router).
from digital_content import (  # noqa: E402
    public_router as dc_public_router,
    admin_router as dc_admin_router,
)
app.include_router(dc_public_router)
app.include_router(dc_admin_router)

# Paid Missions module — isolated wallets, no impact on MLM commissions.
from missions import public as missions_public, admin as missions_admin  # noqa: E402
app.include_router(missions_public)
app.include_router(missions_admin)

# Lottery Jackpot module (isolated from MLM commissions)
from lottery import public as lottery_public, admin as lottery_admin  # noqa: E402
app.include_router(lottery_public)
app.include_router(lottery_admin)

# Challenge (100 invites) module — no auto-payout, admin-managed.
from challenges import public as challenges_public, admin as challenges_admin  # noqa: E402
app.include_router(challenges_public)
app.include_router(challenges_admin)

# Ads module — video advertisements campaign (users publish, admin approves).
from ads import public as ads_public, admin as ads_admin  # noqa: E402
app.include_router(ads_public)
app.include_router(ads_admin)

# Special Tasks — paid micro-tasks (auto-credit on completion).
from special_tasks import public as st_public, admin as st_admin  # noqa: E402
app.include_router(st_public)
app.include_router(st_admin)

# Groupe d'accompagnement — per-leader group link shown to direct referrals.
from support_group import public as sg_public  # noqa: E402
app.include_router(sg_public)

# Marketplace — free listings, admin review, WhatsApp contact.
from marketplace import public as mk_public, admin as mk_admin  # noqa: E402
app.include_router(mk_public)
app.include_router(mk_admin)

# In-app notifications API — read / mark-read / unread-count.
from notifications_api import router as notifications_router  # noqa: E402
app.include_router(notifications_router)

# v27aj (2026-03-04) — minimalist app version management (publish-only, no APK).
from app_versions import public_router as av_public, admin_router as av_admin  # noqa: E402
app.include_router(av_public)
app.include_router(av_admin)

# v27ap (2026-03-04) — Activity stats endpoints for the Dashboard.
# Registered right after app_versions so the module exists before any
# downstream router references it. See /app/backend/activity_stats.py.
try:
    from activity_stats import register as _register_activity_stats  # noqa: E402
    _register_activity_stats(app)
    log.info("activity_stats registered")
except Exception as _e:  # pragma: no cover
    log.warning("activity_stats register failed: %s", _e)

# Feature Flags — central on/off switches for every recent module.
from feature_flags import (  # noqa: E402
    public as ff_public,
    admin as ff_admin,
    ensure_default_flags,
)
app.include_router(ff_public)
# Enforce admin auth on the whole /api/admin/feature-flags subtree at
# include-time — mutating router.dependencies after decoration is a no-op.
app.include_router(ff_admin, dependencies=[Depends(require_admin)])

# IziChangePay — direct crypto integration (deposits + payouts).
from izichange import api as izi_api, webhook as izi_webhook  # noqa: E402
app.include_router(izi_api)
app.include_router(izi_webhook)

# AshtecPay AUTO-ACTIVATION — dedicated 2500 FCFA flow with 10-min countdown.
from ashtec_activation import (api as ashtec_api, webhook as ashtec_webhook,  # noqa: E402
                                admin as ashtec_admin)
app.include_router(ashtec_api)
app.include_router(ashtec_webhook)
app.include_router(ashtec_admin)

# Activation Videos — admin uploads guide videos shown on the payment page.
from activation_videos import public as av_public, admin as av_admin  # noqa: E402
app.include_router(av_public)
app.include_router(av_admin)
app.include_router(ashtec_webhook)
app.include_router(ashtec_admin)

# Biz-transPay (SoftPay) — TG-only PayIn/PayOut, admin-managed under the
# unified "Prestataires de paiement" tab. See /app/backend/biztranspay.py.
from biztranspay import api as btp_api, webhook as btp_webhook  # noqa: E402
app.include_router(btp_api)
app.include_router(btp_webhook)

# BizTransPay integration removed 2026-09-02 — crypto activation is now
# handled by IziChangePay (routes in izichange.py), mobile activation by
# SolesPay/Ashtec (routes in server.py + ashtec_activation.py).

# Live chat — user ↔ admin support (Phase 1: text + photos + polling + read receipts).
from chat import api as chat_api, admin_router as chat_admin  # noqa: E402
app.include_router(chat_api)
app.include_router(chat_admin)

# Support desk (Phase 3a) — dedicated agent workflow + admin authorization.
from support import public as support_public, admin_router as support_admin  # noqa: E402
app.include_router(support_public)
app.include_router(support_admin)

# Recharge / Top-up module
from recharge import public as recharge_public, admin as recharge_admin  # noqa: E402
app.include_router(recharge_public)
app.include_router(recharge_admin)

# One-shot upgrade reserve audit (admin-only, no UI).
from upgrade_audit import router as upgrade_audit_router  # noqa: E402
app.include_router(upgrade_audit_router)

# Integrity audit — detects fraudulent activations & orphan commissions (admin-only).
from integrity_audit import router as integrity_audit_router  # noqa: E402
app.include_router(integrity_audit_router)

# Jobs (Emploi) — admin publishes job offers, users browse them for free.
from jobs import (  # noqa: E402
    public_router as jobs_public,
    admin_router as jobs_admin,
)
app.include_router(jobs_public)
app.include_router(jobs_admin)

# Firebase Cloud Messaging — web push notifications (register token + admin send).
from push_notifications import router as push_router  # noqa: E402
app.include_router(push_router)
