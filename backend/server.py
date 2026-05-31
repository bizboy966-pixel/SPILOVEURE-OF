"""SPILIVERE FastAPI backend - main entrypoint."""
from __future__ import annotations
import os
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List

from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, status, Query
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

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
    # indexes
    await db.users.create_index("id", unique=True)
    await db.users.create_index("email", unique=True)
    await db.users.create_index("username", unique=True)
    await db.matrix_placements.create_index([("level", 1), ("parent_id", 1)])
    await db.matrix_placements.create_index([("user_id", 1), ("level", 1)], unique=True)
    await db.commissions.create_index("user_id")
    await db.withdrawals.create_index("user_id")
    await db.activations.create_index("user_id")
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
    yield
    client.close()


app = FastAPI(lifespan=lifespan, title="SPILIVERE API")

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
    # BFS down 4 layers under user
    layers = []
    current = [user["id"]]
    for depth in range(4):
        children_layer = []
        for parent in current:
            kids = await db.matrix_placements.find(
                {"level": level, "parent_id": parent}, {"_id": 0}
            ).to_list(20)
            for k in kids:
                u = await db.users.find_one(
                    {"id": k["user_id"]},
                    {"_id": 0, "username": 1, "max_level": 1, "status": 1, "created_at": 1, "id": 1},
                )
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
    # All descendants at given level
    queue = [user["id"]]
    visited = set([user["id"]])
    member_ids = []
    while queue:
        u = queue.pop(0)
        kids = await db.matrix_placements.find(
            {"level": level, "parent_id": u}, {"_id": 0, "user_id": 1}
        ).to_list(2000)
        for k in kids:
            uid = k["user_id"]
            if uid not in visited:
                visited.add(uid)
                member_ids.append(uid)
                queue.append(uid)
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


@api.get("/team/direct")
async def team_direct(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = await db.users.find(
        {"sponsor_id": user["id"]},
        {"_id": 0, "password_hash": 0},
    ).sort("created_at", -1).to_list(1000)
    direct_active = sum(1 for u in items if u.get("status") == "active")
    direct_inactive = len(items) - direct_active
    return {"members": items, "active": direct_active, "inactive": direct_inactive}


# ============ DASHBOARD ============

@api.get("/dashboard")
async def dashboard(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    direct_count = await db.users.count_documents({"sponsor_id": user["id"]})
    direct_active = await db.users.count_documents({"sponsor_id": user["id"], "status": "active"})
    spillover_count = await db.matrix_placements.count_documents({"sponsor_id": user["id"], "is_spillover": True})
    spillover_active_ids = await db.matrix_placements.distinct(
        "user_id", {"sponsor_id": user["id"], "is_spillover": True}
    )
    spillover_active = 0
    if spillover_active_ids:
        spillover_active = await db.users.count_documents({"id": {"$in": spillover_active_ids}, "status": "active"})
    cur = user.get("max_level", 0)
    level_info = LEVELS_BY_NUM.get(cur) if cur else None
    return {
        "user": user,
        "balance_total": user.get("balance_profit", 0) + user.get("balance_upgrade", 0),
        "balance_profit": user.get("balance_profit", 0),
        "balance_upgrade": user.get("balance_upgrade", 0),
        "commission_direct": user.get("commission_direct", 0),
        "commission_spillover": user.get("commission_spillover", 0),
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
    doc = {
        "user_id": user["id"],
        "country": data.country, "operator": data.operator,
        "phone": data.phone, "full_name": data.full_name,
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
    if data.amount > user.get("balance_profit", 0):
        raise HTTPException(400, "Solde profit insuffisant.")
    # Lock balance immediately
    await db.users.update_one(
        {"id": user["id"]}, {"$inc": {"balance_profit": -data.amount}},
    )
    wd_id = str(uuid.uuid4())
    await db.withdrawals.insert_one({
        "id": wd_id, "user_id": user["id"], "username": user["username"],
        "amount": data.amount, "status": "pending",
        "operator": wallet["operator"], "phone": wallet["phone"],
        "full_name": wallet["full_name"], "country": wallet["country"],
        "created_at": datetime.now(timezone.utc),
    })
    return {"id": wd_id, "status": "pending"}


@api.get("/withdrawals/mine")
async def my_withdrawals(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = await db.withdrawals.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return items


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



# ============ ADMIN ============

admin_router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])



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
    activations_pending = await db.activations.count_documents({"status": "pending"})
    withdrawals_pending = await db.withdrawals.count_documents({"status": "pending"})
    total_activation_amount_agg = await db.activations.aggregate([
        {"$match": {"status": "validated"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    total_activations = total_activation_amount_agg[0]["total"] if total_activation_amount_agg else 0
    total_wd_agg = await db.withdrawals.aggregate([
        {"$match": {"status": "validated"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    total_withdrawals = total_wd_agg[0]["total"] if total_wd_agg else 0
    return {
        "users_total": users_total,
        "users_active": users_active,
        "activations_pending": activations_pending,
        "withdrawals_pending": withdrawals_pending,
        "total_activations_amount": total_activations,
        "total_withdrawals_amount": total_withdrawals,
    }


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
    db = request.app.state.db
    q = {"status": status_filter} if status_filter else {}
    items = await db.activations.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items


@admin_router.post("/activations/{activation_id}/validate")
async def admin_validate_activation(activation_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    act = await db.activations.find_one({"id": activation_id})
    if not act:
        raise HTTPException(404, "Activation introuvable.")
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


@admin_router.post("/activations/{activation_id}/reject")
async def admin_reject_activation(activation_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    await db.activations.update_one(
        {"id": activation_id, "status": "pending"},
        {"$set": {"status": "rejected", "rejected_at": datetime.now(timezone.utc), "rejected_by": admin["id"]}},
    )
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "reject_activation",
        "target": activation_id, "at": datetime.now(timezone.utc),
    })
    return {"ok": True}


@admin_router.get("/withdrawals")
async def admin_list_withdrawals(request: Request, status_filter: Optional[str] = Query(None, alias="status")):
    db = request.app.state.db
    q = {"status": status_filter} if status_filter else {}
    items = await db.withdrawals.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items


@admin_router.post("/withdrawals/{wd_id}/validate")
async def admin_validate_withdrawal(wd_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    wd = await db.withdrawals.find_one({"id": wd_id})
    if not wd:
        raise HTTPException(404, "Retrait introuvable.")
    if wd["status"] != "pending":
        raise HTTPException(400, "Déjà traité.")
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


@admin_router.post("/withdrawals/{wd_id}/reject")
async def admin_reject_withdrawal(wd_id: str, request: Request, admin=Depends(require_admin)):
    db = request.app.state.db
    wd = await db.withdrawals.find_one({"id": wd_id})
    if not wd:
        raise HTTPException(404, "Retrait introuvable.")
    if wd["status"] != "pending":
        raise HTTPException(400, "Déjà traité.")
    # Refund balance
    await db.users.update_one({"id": wd["user_id"]}, {"$inc": {"balance_profit": wd["amount"]}})
    await db.withdrawals.update_one(
        {"id": wd_id},
        {"$set": {"status": "rejected", "rejected_at": datetime.now(timezone.utc), "rejected_by": admin["id"]}},
    )
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": admin["id"], "action": "reject_withdrawal",
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


api.include_router(admin_router)
app.include_router(api)
