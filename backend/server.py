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
    # indexes
    await db.users.create_index("id", unique=True)
    await db.users.create_index("email", unique=True)
    await db.users.create_index("username", unique=True)
    await db.users.create_index("sponsor_id")
    await db.users.create_index("status")
    await db.matrix_placements.create_index([("level", 1), ("parent_id", 1)])
    await db.matrix_placements.create_index([("user_id", 1), ("level", 1)], unique=True)
    await db.matrix_placements.create_index([("parent_id", 1), ("is_spillover", 1)])
    await db.matrix_placements.create_index("sponsor_id")
    await db.commissions.create_index("user_id")
    await db.withdrawals.create_index("user_id")
    await db.activations.create_index("user_id")
    await db.payments.create_index("user_id")
    await db.payments.create_index("reference")
    await db.payments.create_index("transaction_id")
    # FCM push tokens — one row per (user_id, device_id)
    await db.push_tokens.create_index([("user_id", 1), ("device_id", 1)], unique=True)
    await db.push_tokens.create_index("token")
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
    return user


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
    total_profit = float(user.get("commission_direct", 0) or 0) + float(user.get("commission_spillover", 0) or 0)
    return {
        "user": user,
        "balance_total": user.get("balance_profit", 0) + user.get("balance_upgrade", 0),
        "balance_profit": user.get("balance_profit", 0),
        "balance_upgrade": user.get("balance_upgrade", 0),
        "commission_direct": user.get("commission_direct", 0),
        "commission_spillover": user.get("commission_spillover", 0),
        "total_profit": total_profit,
        "total_withdrawn": float(user.get("total_withdrawn", 0) or 0),
        "direct_count": direct_count,
        "direct_active": direct_active,
        "direct_inactive": direct_count - direct_active,
        "spillover_count": spillover_count,
        "spillover_active": spillover_active,
        "spillover_inactive": spillover_count - spillover_active,
        "current_level": level_info,
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
    if user.get("withdrawals_disabled"):
        raise HTTPException(403, "Retraits désactivés par l’administrateur.")
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

    # ── BizTransPay auto-dispatch (Phase 5) ──────────────────────────────
    # If the admin has toggled auto-withdrawal ON for this channel and all
    # gateway prerequisites are met, we send the payout to BizTransPay
    # immediately. On failure the withdrawal stays "pending" so an admin
    # can still validate manually (coexistence guaranteed).
    auto_result = {"auto_dispatched": False}
    try:
        from biztranspay import dispatch_auto_withdrawal
        auto_result = await dispatch_auto_withdrawal(db, wd_doc)
    except Exception as e:
        import logging as _lg
        _lg.getLogger("biztranspay").exception(
            "auto-dispatch failed for wd_id=%s: %s", wd_id, e)

    resp = {"id": wd_id, "status": "dispatched" if auto_result.get("auto_dispatched") else "pending",
            "amount": data.amount, "fee": fee, "net_payout": net}
    if auto_result.get("auto_dispatched"):
        resp["auto_dispatched"] = True
        resp["gateway"] = "biztranspay"
    elif auto_result.get("error"):
        # Silent: user just sees "pending" — admin will see the error tag.
        pass
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
    if not k or not isinstance(k, str):
        return ""
    if len(k) <= 8:
        return "*" * len(k)
    return k[:4] + "*" * (len(k) - 8) + k[-4:]


# Payment gateway admin endpoints — declared right after the helper, before any
# of the legacy /settings/manual-payment routes to avoid the duplicate handler
# loaded later in the file from masking them.
from pydantic import BaseModel as _PGBaseModel  # noqa: E402


class PaymentGatewayUpdate(_PGBaseModel):
    active: Optional[str] = None              # "soleas" | "ashtec"
    soleas_enabled: Optional[bool] = None
    ashtec_enabled: Optional[bool] = None
    ashtec_api_key: Optional[str] = None      # new key, or "" to keep, "DELETE" to clear


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
                "api_key_masked": _mask_key(cfg.get("ashtec_api_key") or ""),
            },
            "country_matrix": cfg.get("country_matrix") or {},
            "soleas_countries": list(soleaspay.SUPPORTED.keys()),
        }

    @router.post("/payment-gateways/soleaspay/test")
    async def admin_test_soleaspay(request: Request, admin=Depends(require_admin)):
        """Real connection test: probe verif-pay with a bogus order — a valid
        key returns a well-formed JSON error, an invalid key returns 401/403."""
        if not soleaspay.is_configured():
            return {"ok": False, "step": "config", "detail": "SOLEASPAY_API_KEY manquante côté serveur."}
        try:
            data = await soleaspay.verify_payment("SPV-CONN-TEST", "test", service_id=1)
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
        return await admin_get_payment_gateways(request)
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
    """User-facing status check + auto-activation on return from gateway.

    Called by the frontend `/services?ref=…` redirect handler. If the
    payment is `paid` but activation hasn't run yet (e.g. webhook delay or
    initial bug), this endpoint forces the activation now so the user
    doesn't have to wait or contact support.
    """
    db = request.app.state.db
    p = await db.payments.find_one({"reference": reference}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Paiement introuvable")
    if p.get("user_id") != user.get("id"):
        raise HTTPException(403, "Ce paiement n'appartient pas à votre compte")
    out = {
        "reference": reference,
        "status": p.get("status"),
        "level": p.get("level"),
        "activation_done": bool(p.get("activation_done")),
        "amount": p.get("amount"),
        "currency": p.get("currency"),
    }
    if p.get("status") == "paid" and not p.get("activation_done"):
        try:
            await activate_level(db, p["user_id"], int(p["level"]), source="gateway_return")
            await db.payments.update_one(
                {"reference": reference},
                {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
            )
            out["activation_done"] = True
            out["activated_now"] = True
        except Exception as exc:
            out["activation_error"] = str(exc)
    return out


# ────────────────────────────────────────────────────────────────────────
# SoleasPay webhook — HMAC-SHA256 signed, idempotent, activates payments.
# ────────────────────────────────────────────────────────────────────────
import hmac as _hmac
import hashlib as _hashlib
import json as _json


async def _soleaspay_webhook_secret(db) -> str:
    env = (os.environ.get("SOLEASPAY_WEBHOOK_SECRET") or "").strip()
    if env:
        return env
    cfg = await _load_payment_gateway(db)
    return (cfg.get("soleaspay_webhook_secret") or "").strip()


def _verify_soleaspay_signature(secret: str, raw: bytes, sig_header: str) -> bool:
    if not secret or not sig_header:
        return False
    computed = _hmac.new(secret.encode(), raw, _hashlib.sha256).hexdigest()
    return (_hmac.compare_digest(computed, sig_header) or
            _hmac.compare_digest(f"sha256={computed}", sig_header))


async def pick_gateway_for_country(db, country: str) -> Optional[str]:
    """Cascade Soleas → Ashtec based on global enable + per-country matrix."""
    cfg = await _load_payment_gateway(db)
    matrix = cfg.get("country_matrix") or {}
    for gw in ("soleas", "ashtec"):
        if not bool(cfg.get(f"{gw}_enabled")):
            continue
        gw_matrix = matrix.get(gw) or {}
        if country in gw_matrix and gw_matrix[country] is False:
            continue
        return gw
    return None


@api.post("/webhooks/soleaspay")
async def soleaspay_webhook(request: Request):
    db = request.app.state.db
    raw = await request.body()
    hdr_name = (os.environ.get("SOLEASPAY_WEBHOOK_HEADER") or "x-signature").lower()
    sig = (request.headers.get(hdr_name)
           or request.headers.get("x-soleaspay-signature")
           or request.headers.get("signature") or "")
    secret = await _soleaspay_webhook_secret(db)
    if not _verify_soleaspay_signature(secret, raw, sig):
        raise HTTPException(401, "Signature invalide.")
    try:
        event = _json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(400, "Payload invalide.")
    data = event.get("data") if isinstance(event.get("data"), dict) else event
    event_id = event.get("id") or event.get("event_id") or data.get("event_id") or data.get("reference")
    order_id = data.get("order_id") or data.get("orderId") or data.get("reference")
    status_raw = str(data.get("status") or event.get("status") or "").upper()
    if event_id and await db.soleaspay_webhook_events.find_one({"event_id": event_id}):
        return {"received": True, "idempotent": True}
    if not order_id:
        await db.soleaspay_webhook_events.insert_one({
            "event_id": event_id, "raw": event,
            "at": datetime.now(timezone.utc), "ignored": "no_order_id"})
        return {"received": True, "ignored": "no_order_id"}
    pay = await db.payments.find_one({"reference": order_id})
    if not pay:
        await db.soleaspay_webhook_events.insert_one({
            "event_id": event_id, "raw": event, "order_id": order_id,
            "at": datetime.now(timezone.utc), "ignored": "unknown_order"})
        return {"received": True, "unknown_order": True}
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
    if status_raw in ("SUCCESS", "SUCCEEDED", "COMPLETED", "PAID"):
        upd = await db.payments.update_one(
            {"reference": order_id, "activation_done": {"$ne": True}},
            {"$set": {"status": "paid", "updated_at": datetime.now(timezone.utc),
                      "webhook_at": datetime.now(timezone.utc), "webhook_raw": event}},
        )
        if upd.modified_count > 0:
            try:
                await activate_level(db, pay["user_id"], int(pay["level"]), source=f"webhook:{order_id}")
                await db.payments.update_one(
                    {"reference": order_id},
                    {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
                )
                activated = True
            except Exception as e:
                await db.payments.update_one(
                    {"reference": order_id}, {"$set": {"activation_error": str(e)}})
    else:
        await db.payments.update_one(
            {"reference": order_id},
            {"$set": {"status": status_raw.lower() or "pending",
                      "webhook_at": datetime.now(timezone.utc), "webhook_raw": event,
                      "updated_at": datetime.now(timezone.utc)}},
        )
    await db.soleaspay_webhook_events.insert_one({
        "event_id": event_id, "raw": event, "order_id": order_id,
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
    gw = await pick_gateway_for_country(request.app.state.db, country.upper())
    return {"country": country.upper(), "gateway": gw, "available": gw is not None}



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
    # Ashtech key can come from either env var (preferred) or DB fallback.
    ashtec_api_key = (os.environ.get("ASHTECPAY_API_KEY") or "").strip() \
                     or (gw.get("ashtec_api_key") or "").strip()
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
    amount = LEVELS_BY_NUM[1]["price"]
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
        "provider": {"$in": ["soleaspay", "ashtecpay"]},
        "$or": [
            {"status": "pending"},
            {"status": "paid", "activation_done": {"$ne": True}},
        ],
    })
    activations_pending = activations_pending_manual + activations_pending_auto
    withdrawals_pending = await db.withdrawals.count_documents({"status": "pending"})
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
            "provider": {"$in": ["soleaspay", "ashtecpay"]},
            "activation_done": True,
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    total_activations_auto = total_auto_agg[0]["total"] if total_auto_agg else 0
    total_activations = (total_activations_manual or 0) + (total_activations_auto or 0)
    total_wd_agg = await db.withdrawals.aggregate([
        {"$match": {"status": "validated"}},
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
        await db.users.update_one({"id": user_id}, {"$inc": {field: int(data.amount)}})
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
        await db.users.update_one({"id": user_id}, {"$inc": {field: -int(data.amount)}})
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

    # Merge automatic payments (SoleasPay legacy + AshtecPay current).
    # Both providers store their payment docs in `db.payments` with the same
    # basic shape, so we can iterate them uniformly.
    #
    # When the caller asks for a specific status we push the equivalent
    # filter into the MongoDB query so `.limit(500)` doesn't silently
    # truncate the result — this was the root cause of the "dashboard
    # says 108 pending, list only shows 4" discrepancy in prod.
    payment_query: dict = {"provider": {"$in": ["soleaspay", "ashtecpay"]}}
    if status_filter == "pending":
        payment_query["$or"] = [
            {"status": "pending"},
            {"status": "paid", "activation_done": {"$ne": True}},
        ]
    elif status_filter == "validated":
        payment_query["status"] = "paid"
        payment_query["activation_done"] = True
    elif status_filter == "rejected":
        payment_query["status"] = "failed"
    auto_cursor = db.payments.find(payment_query, {"_id": 0}).sort("created_at", -1).limit(500)
    async for p in auto_cursor:
        raw_status = p.get("status") or "pending"
        if raw_status == "paid":
            mapped_status = "validated" if p.get("activation_done") else "pending"
        elif raw_status == "failed":
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
    if p.get("activation_done"):
        return {"ok": True, "already_activated": True, "level": p.get("level")}
    # If user is already at-or-above this level, just reconcile the flag
    u_now = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1}) or {}
    if int(u_now.get("max_level") or 0) >= int(p["level"]):
        await db.payments.update_one(
            {"reference": activation_id},
            {"$set": {"status": "paid", "activation_done": True,
                      "validated_at": datetime.now(timezone.utc), "validated_by": admin["id"],
                      "updated_at": datetime.now(timezone.utc)},
             "$unset": {"activation_error": ""}},
        )
        return {"ok": True, "already_activated": True, "level": p["level"]}
    try:
        await activate_level(db, p["user_id"], int(p["level"]), source="admin_validate")
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
    return {"ok": True, "level": p["level"]}


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
    """
    db = request.app.state.db
    q = {"status": status_filter} if status_filter else {}
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
        if wd["status"] != "pending":
            raise HTTPException(400, "Déjà traité.")

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
        if wd["status"] != "pending":
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
    if p.get("activation_done"):
        return {"ok": True, "already_activated": True, "level": p.get("level")}
    # If the underlying user is already at-or-above this level, just mark the
    # payment as activated without calling activate_level again (which would
    # raise "Vous devez activer les niveaux dans l'ordre"). This handles the
    # case where a previous activation succeeded but the activation_done flag
    # was not set due to a downstream error.
    u = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1}) or {}
    if int(u.get("max_level") or 0) >= int(p["level"]):
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
        )
        return {"ok": True, "already_activated": True, "level": p["level"], "reconciled": True}
    try:
        await activate_level(db, p["user_id"], int(p["level"]), source="manual_reprocess")
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_done": True}, "$unset": {"activation_error": ""}},
        )
        return {"ok": True, "level": p["level"], "user_id": p["user_id"]}
    except Exception as exc:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_error": str(exc)}},
        )
        raise HTTPException(500, f"Activation échouée: {exc}")


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
    api_key = (gw.get("ashtec_api_key") or "").strip()
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

    resp = await soleaspay.verify_payment(order_id, pay_id, service_id=p.get("service_id", 1))
    sp_status = resp.get("status") or ""
    new_status = soleaspay.normalize_status(sp_status, resp.get("success"), resp.get("code"))
    log.info("soleaspay status poll ref=%s sp_status=%r success=%r code=%r → %s",
             order_id, sp_status, resp.get("success"), resp.get("code"), new_status)

    if new_status == "paid" and not p.get("activation_done"):
        u_now = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1, "status": 1}) or {}
        if int(u_now.get("max_level") or 0) >= int(p["level"]):
            if u_now.get("status") != "active":
                await db.users.update_one({"id": p["user_id"]}, {"$set": {"status": "active"}})
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_done": True,
                          "soleaspay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": "paid", "activation_done": True, "level": p["level"], "reconciled": True}
        try:
            await activate_level(db, p["user_id"], int(p["level"]), source="soleaspay")
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
            return {"status": "paid", "activation_done": True, "level": p["level"]}
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
    gw = await _load_payment_gateway(db)
    api_key = (gw.get("ashtec_api_key") or "").strip()
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
        u_now = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "max_level": 1, "status": 1}) or {}
        if int(u_now.get("max_level") or 0) >= int(p["level"]):
            if u_now.get("status") != "active":
                await db.users.update_one({"id": p["user_id"]}, {"$set": {"status": "active"}})
            await db.payments.update_one(
                {"reference": order_id},
                {"$set": {"status": "paid", "activation_done": True,
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": "paid", "activation_done": True, "level": p["level"], "reconciled": True}
        try:
            await activate_level(db, p["user_id"], int(p["level"]), source="ashtecpay")
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
            return {"status": "paid", "activation_done": True, "level": p["level"]}
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

# Marketplace — free listings, admin review, WhatsApp contact.
from marketplace import public as mk_public, admin as mk_admin  # noqa: E402
app.include_router(mk_public)
app.include_router(mk_admin)

# In-app notifications API — read / mark-read / unread-count.
from notifications_api import router as notifications_router  # noqa: E402
app.include_router(notifications_router)

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

# BizTransPay AUTO-ACTIVATION — v2 API (Mobile Money + Crypto + Webhooks + Auto-Withdrawals).
from biztranspay import (  # noqa: E402
    api as biztranspay_api,
    admin as biztranspay_admin,
    webhook as biztranspay_webhook,
)
app.include_router(biztranspay_api)
app.include_router(biztranspay_webhook)  # public (HMAC-verified inside handler)
# Admin config router is protected via require_admin.
app.include_router(biztranspay_admin, dependencies=[Depends(require_admin)])

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
