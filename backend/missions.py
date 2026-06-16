"""Paid Missions module — completely isolated from MLM commissions.

5 separate wallets (`balance_youtube`, `balance_tiktok`, `balance_instagram`,
`balance_facebook`, `balance_questionnaire`) live directly on the `users`
document. Existing MLM balances (`balance_profit`, `balance_upgrade`) are
NEVER touched by mission completions.

Time-window: admin-configurable via `db.app_settings.mission_schedule`.
Each mission can be completed ONCE per period (period = calendar day in the
configured TZ). When the window reopens on the next scheduled day, the
mission becomes available again for the user — no manual republish needed.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin

# 5 mission types — each maps 1-to-1 to a user balance field.
MISSION_TYPES = ["youtube", "tiktok", "instagram", "facebook", "questionnaire"]
BALANCE_FIELD = {t: f"balance_{t}" for t in MISSION_TYPES}
COMPLETED_FIELD = {t: f"completed_{t}" for t in MISSION_TYPES}

# Defaults used when no admin config exists yet.
DEFAULT_SCHEDULE = {
    "allowed_days": [0, 1, 2, 3, 4],  # 0=Mon … 6=Sun
    "open_time": "08:00",              # HH:MM
    "close_time": "16:00",
    "timezone": "Africa/Lome",
    "enabled": True,
}


async def _load_schedule(db) -> dict:
    """Read admin-configured mission schedule from `app_settings.mission_schedule`.
    Returns DEFAULT_SCHEDULE merged with any overrides found in DB.
    """
    doc = await db.app_settings.find_one({"key": "mission_schedule"}, {"_id": 0})
    cfg = dict(DEFAULT_SCHEDULE)
    if doc and isinstance(doc.get("value"), dict):
        for k in ("allowed_days", "open_time", "close_time", "timezone", "enabled"):
            if k in doc["value"]:
                cfg[k] = doc["value"][k]
    return cfg


def _tz(name: str):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def _parse_hm(s: str) -> tuple[int, int]:
    try:
        h, m = s.split(":")
        return int(h), int(m)
    except Exception:
        return 0, 0


def _window_open_for_schedule(cfg: dict) -> bool:
    if not cfg.get("enabled", True):
        return False
    tz = _tz(cfg.get("timezone") or "Africa/Lome")
    now = datetime.now(tz)
    allowed = cfg.get("allowed_days") or []
    if now.weekday() not in allowed:
        return False
    oh, om = _parse_hm(cfg.get("open_time") or "08:00")
    ch, cm = _parse_hm(cfg.get("close_time") or "16:00")
    cur = now.hour * 60 + now.minute
    return oh * 60 + om <= cur < ch * 60 + cm


def _current_period_key(cfg: dict) -> str:
    """Period key = ISO date in the configured TZ. Resets at midnight."""
    tz = _tz(cfg.get("timezone") or "Africa/Lome")
    return datetime.now(tz).date().isoformat()


def _window_human_label(cfg: dict) -> str:
    days_map = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
    days = [days_map[d] for d in (cfg.get("allowed_days") or []) if 0 <= d <= 6]
    days_str = " / ".join(days) if days else "Aucun jour"
    return f"📅 {days_str} • 🕒 {cfg.get('open_time')} — {cfg.get('close_time')} ({cfg.get('timezone')})"


class MissionIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    type: str  # one of MISSION_TYPES
    url: str = ""                       # YouTube/TikTok/IG/FB link OR local upload URL
    duration_seconds: int = Field(default=60, ge=0, le=3600)
    reward: float = Field(default=50, ge=0)
    question: str = ""                  # optional verification question
    correct_answer: str = ""            # optional — case-insensitive compare
    expires_at: Optional[str] = None    # ISO datetime
    active: bool = True


public = APIRouter(prefix="/api", tags=["missions"])
admin = APIRouter(prefix="/api/admin", tags=["missions_admin"])


@public.get("/missions")
async def list_missions(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await _load_schedule(db)
    open_now = _window_open_for_schedule(cfg)
    if not open_now:
        return {
            "window_open": False,
            "schedule": cfg,
            "window_label": _window_human_label(cfg),
            "message": "🚫 Missions actuellement indisponibles.\n" + _window_human_label(cfg),
            "items": [],
        }
    cur = db.missions.find({"active": True}, {"_id": 0}).sort("created_at", -1)
    items = []
    now_iso = datetime.now(timezone.utc).isoformat()
    period_key = _current_period_key(cfg)
    async for m in cur:
        if m.get("expires_at") and m["expires_at"] < now_iso:
            continue
        # Mark as already completed by this user IN THE CURRENT PERIOD ONLY.
        # When the next scheduled day arrives, period_key changes and the
        # mission becomes available again automatically.
        done = await db.mission_completions.find_one(
            {"user_id": user["id"], "mission_id": m["id"], "period_key": period_key},
            {"_id": 1},
        )
        m["completed_by_user"] = bool(done)
        items.append(m)
    return {"window_open": True, "schedule": cfg, "window_label": _window_human_label(cfg), "period_key": period_key, "items": items}


@public.post("/missions/{mission_id}/complete")
async def complete_mission(mission_id: str, body: dict, request: Request, user=Depends(get_current_user)):
    """Body: { watched_seconds: int, answer: str }.
    Idempotent — one reward per (user, mission, period_key). Mission can be
    redone in the NEXT scheduled period (next allowed day).
    """
    db = request.app.state.db
    cfg = await _load_schedule(db)
    if not _window_open_for_schedule(cfg):
        raise HTTPException(403, "Missions indisponibles. " + _window_human_label(cfg))
    m = await db.missions.find_one({"id": mission_id, "active": True}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Mission introuvable ou désactivée")
    if m.get("expires_at") and m["expires_at"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(410, "Mission expirée")
    # Anti-fraud: must watch at least the configured duration
    watched = int(body.get("watched_seconds") or 0)
    if watched < int(m.get("duration_seconds") or 0):
        raise HTTPException(400, f"Veuillez visionner la vidéo entièrement (au moins {m.get('duration_seconds')}s).")
    # Verification question
    if m.get("question") and m.get("correct_answer"):
        ans = str(body.get("answer") or "").strip().lower()
        if ans != str(m["correct_answer"]).strip().lower():
            raise HTTPException(400, "Réponse incorrecte. Réessayez après avoir bien regardé la vidéo.")
    # Idempotency — per (user, mission, period)
    period_key = _current_period_key(cfg)
    existing = await db.mission_completions.find_one(
        {"user_id": user["id"], "mission_id": mission_id, "period_key": period_key},
        {"_id": 1},
    )
    if existing:
        raise HTTPException(409, "Mission déjà validée aujourd'hui. Revenez à la prochaine période programmée.")
    mtype = m["type"]
    if mtype not in MISSION_TYPES:
        raise HTTPException(400, "Type de mission invalide")
    reward = float(m.get("reward") or 0)
    bal_field = BALANCE_FIELD[mtype]
    cnt_field = COMPLETED_FIELD[mtype]
    await db.mission_completions.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "mission_id": mission_id,
        "mission_type": mtype,
        "reward": reward,
        "period_key": period_key,
        "completed_at": datetime.now(timezone.utc),
    })
    await db.users.update_one(
        {"id": user["id"]},
        {"$inc": {bal_field: reward, cnt_field: 1, "balance_missions_total": reward}},
    )
    return {"ok": True, "reward": reward, "wallet": mtype, "period_key": period_key}


@public.get("/me/mission-wallets")
async def my_mission_wallets(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await _load_schedule(db)
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0}) or {}
    wallets = []
    total = 0.0
    for t in MISSION_TYPES:
        bal = float(u.get(BALANCE_FIELD[t]) or 0)
        cnt = int(u.get(COMPLETED_FIELD[t]) or 0)
        total += bal
        wallets.append({"type": t, "balance": bal, "completed": cnt})
    return {
        "window_open": _window_open_for_schedule(cfg),
        "schedule": cfg,
        "window_label": _window_human_label(cfg),
        "total": total,
        "wallets": wallets,
    }


@public.get("/me/mission-history")
async def my_mission_history(request: Request, limit: int = 50, user=Depends(get_current_user)):
    db = request.app.state.db
    cur = db.mission_completions.find({"user_id": user["id"]}, {"_id": 0}).sort("completed_at", -1).limit(min(max(1, limit), 200))
    out = []
    async for d in cur:
        if isinstance(d.get("completed_at"), datetime):
            d["completed_at"] = d["completed_at"].isoformat()
        out.append(d)
    return {"items": out}


class MissionWithdrawalIn(BaseModel):
    wallet: str = Field(min_length=1)  # one of MISSION_TYPES
    amount: float = Field(ge=1)


@public.post("/me/mission-withdrawals")
async def request_mission_withdrawal(body: MissionWithdrawalIn, request: Request, user=Depends(get_current_user)):
    """Submit a withdrawal request from ONE specific mission wallet."""
    if body.wallet not in MISSION_TYPES:
        raise HTTPException(400, f"Portefeuille invalide. Autorisés: {MISSION_TYPES}")
    db = request.app.state.db
    bal_field = BALANCE_FIELD[body.wallet]
    # Atomic conditional decrement — avoids read-then-write race on concurrent requests.
    r = await db.users.update_one(
        {"id": user["id"], bal_field: {"$gte": float(body.amount)}},
        {"$inc": {bal_field: -float(body.amount)}},
    )
    if r.modified_count == 0:
        u = await db.users.find_one({"id": user["id"]}, {"_id": 0}) or {}
        bal = float(u.get(bal_field) or 0)
        raise HTTPException(400, f"Solde insuffisant ({bal:.0f} FCFA disponibles).")
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "wallet": body.wallet,
        "amount": float(body.amount),
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
    }
    await db.mission_withdrawals.insert_one(dict(doc))
    doc["created_at"] = doc["created_at"].isoformat()
    return {"ok": True, "withdrawal": doc}


@public.get("/me/mission-withdrawals")
async def my_mission_withdrawals(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cur = db.mission_withdrawals.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).limit(50)
    out = []
    async for d in cur:
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        out.append(d)
    return {"items": out}


# ============ ADMIN ============

@admin.get("/missions")
async def admin_list_missions(request: Request, q: str = "", _=Depends(require_admin)):
    db = request.app.state.db
    filt: dict = {}
    if q:
        filt = {"$or": [
            {"title": {"$regex": q, "$options": "i"}},
            {"id": {"$regex": q, "$options": "i"}},
            {"type": {"$regex": q, "$options": "i"}},
        ]}
    cur = db.missions.find(filt, {"_id": 0}).sort("created_at", -1).limit(200)
    out = []
    async for d in cur:
        out.append(d)
    return out


@admin.post("/missions")
async def admin_create_mission(body: MissionIn, request: Request, who=Depends(require_admin)):
    if body.type not in MISSION_TYPES:
        raise HTTPException(400, f"Type invalide. Autorisés: {MISSION_TYPES}")
    db = request.app.state.db
    doc = body.dict()
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = datetime.now(timezone.utc).isoformat()
    doc["created_by"] = who.get("username")
    await db.missions.insert_one(doc)
    doc.pop("_id", None)
    return doc


@admin.put("/missions/{mission_id}")
async def admin_update_mission(mission_id: str, body: MissionIn, request: Request, _=Depends(require_admin)):
    if body.type not in MISSION_TYPES:
        raise HTTPException(400, f"Type invalide. Autorisés: {MISSION_TYPES}")
    db = request.app.state.db
    upd = body.dict()
    upd["updated_at"] = datetime.now(timezone.utc).isoformat()
    r = await db.missions.update_one({"id": mission_id}, {"$set": upd})
    if not r.matched_count:
        raise HTTPException(404, "Mission introuvable")
    doc = await db.missions.find_one({"id": mission_id}, {"_id": 0})
    return doc


@admin.delete("/missions/{mission_id}")
async def admin_delete_mission(mission_id: str, request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    r = await db.missions.delete_one({"id": mission_id})
    if not r.deleted_count:
        raise HTTPException(404, "Mission introuvable")
    return {"ok": True}


@admin.get("/missions/stats")
async def admin_mission_stats(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    total = await db.missions.count_documents({})
    active = await db.missions.count_documents({"active": True})
    done = await db.mission_completions.count_documents({})
    agg = db.mission_completions.aggregate([
        {"$group": {"_id": "$mission_type", "rewards": {"$sum": "$reward"}, "count": {"$sum": 1}}}
    ])
    by_type = {}
    total_rewards = 0.0
    async for row in agg:
        by_type[row["_id"]] = {"rewards": float(row["rewards"]), "count": int(row["count"])}
        total_rewards += float(row["rewards"])
    active_users = len(await db.mission_completions.distinct("user_id"))
    return {
        "total_missions": total,
        "active_missions": active,
        "completions": done,
        "active_users": active_users,
        "total_rewards": total_rewards,
        "by_type": by_type,
    }


@admin.get("/mission-withdrawals")
async def admin_list_mission_withdrawals(request: Request, status: str = "", _=Depends(require_admin)):
    db = request.app.state.db
    filt = {"status": status} if status else {}
    cur = db.mission_withdrawals.find(filt, {"_id": 0}).sort("created_at", -1).limit(200)
    out = []
    async for d in cur:
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        out.append(d)
    return {"items": out}


@admin.post("/mission-withdrawals/{wid}/action")
async def admin_mission_withdrawal_action(wid: str, body: dict, request: Request, who=Depends(require_admin)):
    """body: { action: 'validate' | 'reject' }"""
    action = (body or {}).get("action")
    if action not in ("validate", "reject"):
        raise HTTPException(400, "action invalide")
    db = request.app.state.db
    w = await db.mission_withdrawals.find_one({"id": wid}, {"_id": 0})
    if not w:
        raise HTTPException(404, "Demande introuvable")
    if w.get("status") != "pending":
        raise HTTPException(400, f"Déjà traitée (statut: {w.get('status')})")
    new_status = "validated" if action == "validate" else "rejected"
    upd = {"status": new_status, "decided_at": datetime.now(timezone.utc), "decided_by": who.get("username")}
    if action == "reject":
        # Refund the wallet
        bal_field = BALANCE_FIELD.get(w["wallet"])
        if bal_field:
            await db.users.update_one({"id": w["user_id"]}, {"$inc": {bal_field: float(w["amount"])}})
    await db.mission_withdrawals.update_one({"id": wid}, {"$set": upd})
    return {"ok": True, "status": new_status}


class ScheduleIn(BaseModel):
    allowed_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    open_time: str = "08:00"
    close_time: str = "16:00"
    timezone: str = "Africa/Lome"
    enabled: bool = True


@admin.get("/missions-schedule")
async def admin_get_schedule(request: Request, _=Depends(require_admin)):
    """Return the current admin-configured schedule + computed window state."""
    db = request.app.state.db
    cfg = await _load_schedule(db)
    return {
        "schedule": cfg,
        "window_open_now": _window_open_for_schedule(cfg),
        "period_key_now": _current_period_key(cfg),
        "label": _window_human_label(cfg),
    }


@admin.put("/missions-schedule")
async def admin_update_schedule(body: ScheduleIn, request: Request, who=Depends(require_admin)):
    # Basic validation
    for d in body.allowed_days:
        if not (0 <= int(d) <= 6):
            raise HTTPException(400, "allowed_days doit contenir des entiers entre 0 (lundi) et 6 (dimanche).")
    for label, hm in (("open_time", body.open_time), ("close_time", body.close_time)):
        try:
            h, m = hm.split(":")
            if not (0 <= int(h) <= 23 and 0 <= int(m) <= 59):
                raise ValueError()
        except Exception:
            raise HTTPException(400, f"{label} doit être au format HH:MM (ex 08:00).")
    # Validate TZ
    try:
        _tz(body.timezone)
    except Exception:
        raise HTTPException(400, f"Timezone invalide: {body.timezone}")
    db = request.app.state.db
    value = body.dict()
    await db.app_settings.update_one(
        {"key": "mission_schedule"},
        {"$set": {
            "key": "mission_schedule",
            "value": value,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": who.get("username"),
        }},
        upsert=True,
    )
    cfg = await _load_schedule(db)
    return {
        "ok": True,
        "schedule": cfg,
        "window_open_now": _window_open_for_schedule(cfg),
        "label": _window_human_label(cfg),
    }
