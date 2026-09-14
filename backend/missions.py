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

from auth import get_current_user, require_admin, require_active_user

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
    # Weekly mapping: which mission TYPE is allowed on which weekday.
    # 0=Mon → youtube, 1=Tue → tiktok, … 4=Fri → questionnaire.
    # Use the string "" to mark a day with no associated type.
    "day_type_map": {
        "0": "youtube",
        "1": "tiktok",
        "2": "instagram",
        "3": "facebook",
        "4": "questionnaire",
        "5": "",
        "6": "",
    },
}

# Defaults for the withdrawal config — admin-overridable.
DEFAULT_PAYOUT = {
    "min_withdrawal": 500.0,   # FCFA
    "fee_percent": 10.0,       # 0..100
}


async def _load_payout_config(db) -> dict:
    """Read admin-configured payout settings from `app_settings.mission_payout`."""
    doc = await db.app_settings.find_one({"key": "mission_payout"}, {"_id": 0})
    cfg = dict(DEFAULT_PAYOUT)
    if doc and isinstance(doc.get("value"), dict):
        for k in ("min_withdrawal", "fee_percent"):
            if k in doc["value"]:
                try:
                    cfg[k] = float(doc["value"][k])
                except Exception:
                    pass
    return cfg


async def _load_schedule(db) -> dict:
    """Read admin-configured mission schedule from `app_settings.mission_schedule`.
    Returns DEFAULT_SCHEDULE merged with any overrides found in DB.
    """
    doc = await db.app_settings.find_one({"key": "mission_schedule"}, {"_id": 0})
    cfg = {**DEFAULT_SCHEDULE, "day_type_map": dict(DEFAULT_SCHEDULE["day_type_map"])}
    if doc and isinstance(doc.get("value"), dict):
        for k in ("allowed_days", "open_time", "close_time", "timezone", "enabled"):
            if k in doc["value"]:
                cfg[k] = doc["value"][k]
        if isinstance(doc["value"].get("day_type_map"), dict):
            # Normalize keys to str and values to str (lowercased)
            cfg["day_type_map"] = {
                str(k): (str(v).strip().lower() if v is not None else "")
                for k, v in doc["value"]["day_type_map"].items()
            }
    return cfg


def _today_mission_type(cfg: dict) -> str:
    """Return the mission TYPE allowed on the current weekday (or "" if none)."""
    tz = _tz(cfg.get("timezone") or "Africa/Lome")
    wd = str(datetime.now(tz).weekday())
    mp = cfg.get("day_type_map") or {}
    val = mp.get(wd, "")
    if val and val not in MISSION_TYPES:
        return ""
    return val


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


TYPE_LABEL = {
    "youtube": "📺 YouTube",
    "tiktok": "🎵 TikTok",
    "instagram": "📸 Instagram",
    "facebook": "📘 Facebook",
    "questionnaire": "📝 Questionnaire",
}


def _today_label(cfg: dict) -> str:
    tz = _tz(cfg.get("timezone") or "Africa/Lome")
    days_map = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
    wd = datetime.now(tz).weekday()
    today_type = _today_mission_type(cfg)
    type_lbl = TYPE_LABEL.get(today_type, "Aucune catégorie") if today_type else "Aucune catégorie programmée"
    return f"{days_map[wd]} → {type_lbl}"


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
    """Returns AT MOST ONE mission — the next one in the auto-rotation queue
    for today's configured mission type. Each day maps to exactly one type
    (Mon→YouTube, Tue→TikTok, …). Once a user completes a mission, it never
    reappears for them (one-shot lifetime); the rotation auto-advances to
    the next-oldest unfinished mission of the same type.
    """
    db = request.app.state.db
    cfg = await _load_schedule(db)
    open_now = _window_open_for_schedule(cfg)
    today_type = _today_mission_type(cfg)
    today_lbl = _today_label(cfg)
    if not open_now:
        return {
            "window_open": False,
            "today_type": today_type,
            "today_label": today_lbl,
            "schedule": cfg,
            "window_label": _window_human_label(cfg),
            "message": "🚫 Missions actuellement indisponibles.\n" + _window_human_label(cfg),
            "items": [],
        }
    if not today_type:
        return {
            "window_open": True,
            "today_type": "",
            "today_label": today_lbl,
            "schedule": cfg,
            "window_label": _window_human_label(cfg),
            "message": f"🚫 Aucune catégorie de mission programmée pour aujourd'hui.\n{today_lbl}",
            "items": [],
        }
    # Build the set of mission_ids the user already completed (lifetime).
    completed_ids = set()
    async for c in db.mission_completions.find(
        {"user_id": user["id"]}, {"_id": 0, "mission_id": 1}
    ):
        completed_ids.add(c.get("mission_id"))
    # Find the oldest active mission of today's type not yet completed by user.
    now_iso = datetime.now(timezone.utc).isoformat()
    cur = db.missions.find({"active": True, "type": today_type}, {"_id": 0}).sort("created_at", 1)
    next_mission = None
    queue_remaining = 0
    async for m in cur:
        if m.get("expires_at") and m["expires_at"] < now_iso:
            continue
        if m["id"] in completed_ids:
            continue
        if next_mission is None:
            next_mission = m
        queue_remaining += 1
    items = []
    if next_mission:
        next_mission["completed_by_user"] = False
        # Enrich with participants_count so the UI card can display it.
        next_mission["participants_count"] = await db.mission_completions.count_documents(
            {"mission_id": next_mission["id"]}
        )
        items.append(next_mission)
    return {
        "window_open": True,
        "today_type": today_type,
        "today_label": today_lbl,
        "schedule": cfg,
        "window_label": _window_human_label(cfg),
        "period_key": _current_period_key(cfg),
        "queue_remaining": queue_remaining,
        "items": items,
        "message": "🎉 Aucune mission disponible pour vous aujourd'hui — revenez à la prochaine période programmée."
                   if not next_mission else "",
    }


@public.post("/missions/{mission_id}/watch/start")
async def start_watch_session(mission_id: str, request: Request, user=Depends(get_current_user)):
    """Open a server-tracked watch session for anti-fraud validation.

    Client must call this BEFORE opening the video, then send periodic
    heartbeats (`/watch/heartbeat`) while playing, and finally call
    `/complete` (which auto-validates when heartbeats prove the video was
    fully watched — see logic in `complete_mission`).
    """
    db = request.app.state.db
    cfg = await _load_schedule(db)
    if not _window_open_for_schedule(cfg):
        raise HTTPException(403, "Missions indisponibles. " + _window_human_label(cfg))
    m = await db.missions.find_one({"id": mission_id, "active": True}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Mission introuvable ou désactivée")
    today_type = _today_mission_type(cfg)
    if today_type and m.get("type") != today_type:
        raise HTTPException(403, f"Cette mission n'est pas active aujourd'hui. Catégorie du jour : {TYPE_LABEL.get(today_type, today_type)}.")
    # Prevent starting a new session if the mission is already completed
    existing = await db.mission_completions.find_one(
        {"user_id": user["id"], "mission_id": mission_id}, {"_id": 1}
    )
    if existing:
        raise HTTPException(409, "Mission déjà validée.")
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    await db.mission_watch_sessions.insert_one({
        "id": session_id,
        "user_id": user["id"],
        "mission_id": mission_id,
        "duration_required": int(m.get("duration_seconds") or 0),
        "started_at": now,
        "last_heartbeat_at": now,
        "heartbeats": [{"at": now, "elapsed": 0}],
        "max_elapsed": 0,
        "completed": False,
    })
    return {
        "session_id": session_id,
        "duration_required": int(m.get("duration_seconds") or 0),
        "started_at": now.isoformat(),
    }


@public.post("/missions/{mission_id}/watch/heartbeat")
async def watch_heartbeat(mission_id: str, body: dict, request: Request, user=Depends(get_current_user)):
    """Report the current playback position (elapsed seconds since play).
    Body: {session_id, elapsed_seconds}.
    """
    db = request.app.state.db
    session_id = str(body.get("session_id") or "")
    elapsed = int(body.get("elapsed_seconds") or 0)
    if not session_id:
        raise HTTPException(400, "session_id manquant")
    sess = await db.mission_watch_sessions.find_one(
        {"id": session_id, "user_id": user["id"], "mission_id": mission_id},
        {"_id": 0},
    )
    if not sess:
        raise HTTPException(404, "Session de visionnage introuvable")
    now = datetime.now(timezone.utc)
    # Reject heartbeats that fake a jump-ahead (elapsed grew faster than
    # real time since the session started).
    started = sess.get("started_at")
    if isinstance(started, datetime):
        real_elapsed = (now - started.replace(tzinfo=timezone.utc) if started.tzinfo is None else now - started).total_seconds()
        # Allow 3s of jitter for network delay
        if elapsed > real_elapsed + 3:
            raise HTTPException(400, "Heartbeat rejeté (progression incohérente).")
    new_max = max(int(sess.get("max_elapsed") or 0), elapsed)
    await db.mission_watch_sessions.update_one(
        {"id": session_id},
        {"$set": {"last_heartbeat_at": now, "max_elapsed": new_max},
         "$push": {"heartbeats": {"at": now, "elapsed": elapsed}}},
    )
    return {"ok": True, "max_elapsed": new_max, "required": int(sess.get("duration_required") or 0)}


@public.post("/missions/{mission_id}/complete")
async def complete_mission(mission_id: str, body: dict, request: Request, user=Depends(get_current_user)):
    """Auto-validation endpoint — called by the client when the embedded
    player fires its `ended` event (video watched to the end).
    Body: { session_id: str, answer?: str }.

    Server-side enforcement:
    - A valid `mission_watch_sessions` row must exist for (user, mission).
    - The session's `max_elapsed` (from heartbeats) must be ≥ duration.
    - The session's real wall-clock elapsed time must be ≥ duration.
    - Idempotent — a completed mission cannot be re-credited (ONE-SHOT lifetime).
    """
    import logging
    log = logging.getLogger("missions")
    db = request.app.state.db
    cfg = await _load_schedule(db)
    if not _window_open_for_schedule(cfg):
        raise HTTPException(403, "Missions indisponibles. " + _window_human_label(cfg))
    today_type = _today_mission_type(cfg)
    if not today_type:
        raise HTTPException(403, f"Aucune catégorie programmée pour aujourd'hui. {_today_label(cfg)}")
    m = await db.missions.find_one({"id": mission_id, "active": True}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Mission introuvable ou désactivée")
    if m.get("type") != today_type:
        raise HTTPException(403, f"Cette mission n'est pas active aujourd'hui. Catégorie du jour : {TYPE_LABEL.get(today_type, today_type)}.")
    if m.get("expires_at") and m["expires_at"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(410, "Mission expirée")

    mtype = m["type"]
    if mtype not in MISSION_TYPES:
        raise HTTPException(400, "Type de mission invalide")

    # Questionnaire path — no video, verify answer only.
    if mtype == "questionnaire":
        if m.get("question") and m.get("correct_answer"):
            ans = str(body.get("answer") or "").strip().lower()
            if ans != str(m["correct_answer"]).strip().lower():
                raise HTTPException(400, "Réponse incorrecte. Réessayez.")
    else:
        # Video path — enforce a valid watch session with proven duration.
        session_id = str(body.get("session_id") or "")
        if not session_id:
            log.warning("complete_mission %s user=%s: missing session_id", mission_id, user.get("id"))
            raise HTTPException(400, "Session de visionnage requise. Rechargez la page et réessayez.")
        sess = await db.mission_watch_sessions.find_one(
            {"id": session_id, "user_id": user["id"], "mission_id": mission_id},
            {"_id": 0},
        )
        if not sess:
            log.warning("complete_mission %s user=%s: session %s not found", mission_id, user.get("id"), session_id)
            raise HTTPException(404, "Session de visionnage introuvable.")
        required = int(m.get("duration_seconds") or 0)
        max_elapsed = int(sess.get("max_elapsed") or 0)
        started = sess.get("started_at")
        real_elapsed = 0
        if isinstance(started, datetime):
            if started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
            real_elapsed = int((datetime.now(timezone.utc) - started).total_seconds())
        if max_elapsed < required:
            log.info("complete_mission %s user=%s: elapsed %s < required %s", mission_id, user.get("id"), max_elapsed, required)
            raise HTTPException(400, f"Vidéo non terminée ({max_elapsed}s / {required}s). Visionnez jusqu'à la fin pour valider.")
        if real_elapsed < required:
            log.info("complete_mission %s user=%s: wall_elapsed %s < required %s", mission_id, user.get("id"), real_elapsed, required)
            raise HTTPException(400, "Visionnage trop rapide — attendez la fin de la vidéo.")
        # Anti-fraud: at least 2 heartbeats spaced out
        hbs = sess.get("heartbeats") or []
        if len(hbs) < 2:
            log.info("complete_mission %s user=%s: only %d heartbeats", mission_id, user.get("id"), len(hbs))
            raise HTTPException(400, "Trop peu de signaux de lecture. Rechargez et réessayez.")

    # ONE-SHOT lifetime idempotency
    existing = await db.mission_completions.find_one(
        {"user_id": user["id"], "mission_id": mission_id},
        {"_id": 1},
    )
    if existing:
        raise HTTPException(409, "Mission déjà validée. La prochaine sera disponible automatiquement.")
    reward = float(m.get("reward") or 0)
    bal_field = BALANCE_FIELD[mtype]
    cnt_field = COMPLETED_FIELD[mtype]
    period_key = _current_period_key(cfg)
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
    # 🔔 Send an FCM push notification confirming the credit (in addition to the returned payload).
    try:
        from push_helper import push_to_user
        await push_to_user(
            db, user["id"],
            title="✅ Mission validée",
            body=f"Bravo ! +{int(reward)} FCFA crédités sur votre solde {TYPE_LABEL.get(mtype, mtype)}.",
            link="/(app)/missions",
            data={"kind": "mission_completed", "mission_id": mission_id, "reward": reward},
            tag=f"mission-completed-{mission_id}",
        )
    except Exception:
        pass
    log.info("complete_mission %s user=%s OK reward=%s", mission_id, user.get("id"), reward)
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
async def request_mission_withdrawal(body: MissionWithdrawalIn, request: Request, user=Depends(require_active_user)):
    """Submit a withdrawal request from ONE specific mission wallet.
    Applies admin-configured min withdrawal and fee_percent.
    Reuses the user's registered `wallets` entry (same one used by the
    classic withdrawal flow) so the admin sees a single, unified view.
    """
    if body.wallet not in MISSION_TYPES:
        raise HTTPException(400, f"Portefeuille invalide. Autorisés: {MISSION_TYPES}")
    db = request.app.state.db
    # Require the user's classic wallet (same as /api/withdrawals). This is
    # what "réutiliser les mêmes portefeuilles" means from the user story.
    wallet = await db.wallets.find_one({"user_id": user["id"]})
    if not wallet:
        raise HTTPException(400, "Veuillez d'abord enregistrer votre portefeuille de retrait dans votre profil.")
    payout = await _load_payout_config(db)
    amount = float(body.amount)
    if amount < payout["min_withdrawal"]:
        raise HTTPException(400, f"Montant minimum requis : {int(payout['min_withdrawal'])} FCFA.")
    fee_percent = float(payout["fee_percent"])
    fee = round(amount * fee_percent / 100.0, 2)
    net_payout = round(amount - fee, 2)
    bal_field = BALANCE_FIELD[body.wallet]
    # Atomic conditional decrement — avoids read-then-write race on concurrent requests.
    r = await db.users.update_one(
        {"id": user["id"], bal_field: {"$gte": amount}},
        {"$inc": {bal_field: -amount}},
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
        "amount": amount,
        "fee": fee,
        "fee_percent": fee_percent,
        "net_payout": net_payout,
        "status": "pending",
        "withdrawal_type": "mission",
        # Copy the classic wallet's payout details so the admin sees a
        # complete, unified view without needing to cross-reference.
        "method": wallet.get("method") or ("crypto" if wallet.get("wallet_address") else "mobile"),
        "operator": wallet.get("operator", ""),
        "phone": wallet.get("phone", ""),
        "network": wallet.get("network", ""),
        "wallet_address": wallet.get("wallet_address", ""),
        "full_name": wallet.get("full_name", ""),
        "country": wallet.get("country", ""),
        "created_at": datetime.now(timezone.utc),
    }
    await db.mission_withdrawals.insert_one(dict(doc))
    doc["created_at"] = doc["created_at"].isoformat()
    return {"ok": True, "withdrawal": doc}


@public.get("/me/mission-payout-config")
async def my_mission_payout_config(request: Request, _user=Depends(get_current_user)):
    """User-facing endpoint: return current min + fee so the UI can show
    the net amount preview before submitting a withdrawal.
    """
    db = request.app.state.db
    cfg = await _load_payout_config(db)
    return cfg


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
    # 🔔 Broadcast push to activated users when a mission is created & active.
    if doc.get("active"):
        try:
            from push_helper import push_to_activated
            snippet = (doc.get("title") or "")[:60].strip() or "Nouvelle mission"
            reward = int(float(doc.get("reward") or 0))
            type_label = TYPE_LABEL.get(doc.get("type", ""), doc.get("type", ""))
            await push_to_activated(
                db,
                title=f"📢 Nouvelle mission {type_label} disponible !",
                body=f"{snippet} — Regardez la vidéo et gagnez {reward} FCFA. 🚀",
                link="/(app)/missions",
                data={"kind": "mission_published", "mission_id": doc["id"]},
                tag=f"mission-{doc['id']}",
            )
        except Exception:
            pass
    return doc


@admin.put("/missions/{mission_id}")
async def admin_update_mission(mission_id: str, body: MissionIn, request: Request, _=Depends(require_admin)):
    if body.type not in MISSION_TYPES:
        raise HTTPException(400, f"Type invalide. Autorisés: {MISSION_TYPES}")
    db = request.app.state.db
    prev = await db.missions.find_one({"id": mission_id}, {"_id": 0, "active": 1})
    upd = body.dict()
    upd["updated_at"] = datetime.now(timezone.utc).isoformat()
    r = await db.missions.update_one({"id": mission_id}, {"$set": upd})
    if not r.matched_count:
        raise HTTPException(404, "Mission introuvable")
    doc = await db.missions.find_one({"id": mission_id}, {"_id": 0})
    # 🔔 If the mission was just activated (transition from inactive → active),
    # broadcast a push notification to all activated users.
    if doc and doc.get("active") and not (prev or {}).get("active"):
        try:
            from push_helper import push_to_activated
            snippet = (doc.get("title") or "")[:60].strip() or "Nouvelle mission"
            reward = int(float(doc.get("reward") or 0))
            type_label = TYPE_LABEL.get(doc.get("type", ""), doc.get("type", ""))
            await push_to_activated(
                db,
                title=f"📢 Nouvelle mission {type_label} disponible !",
                body=f"{snippet} — Regardez la vidéo et gagnez {reward} FCFA. 🚀",
                link="/(app)/missions",
                data={"kind": "mission_published", "mission_id": mission_id},
                tag=f"mission-{mission_id}",
            )
        except Exception:
            pass
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
    """body: { action: 'validate' | 'reject', reason?: str }"""
    action = (body or {}).get("action")
    reason = (body or {}).get("reason") or ""
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
        upd["reject_reason"] = reason
        # Refund the wallet
        bal_field = BALANCE_FIELD.get(w["wallet"])
        if bal_field:
            await db.users.update_one({"id": w["user_id"]}, {"$inc": {bal_field: float(w["amount"])}})
    await db.mission_withdrawals.update_one({"id": wid}, {"$set": upd})
    return {"ok": True, "status": new_status}


class PayoutConfigIn(BaseModel):
    min_withdrawal: float = Field(ge=0)
    fee_percent: float = Field(ge=0, le=100)


@admin.get("/mission-payout")
async def admin_get_payout(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    cfg = await _load_payout_config(db)
    # Aggregate stats too — useful right next to the config form.
    total_count = await db.mission_withdrawals.count_documents({})
    pending = await db.mission_withdrawals.count_documents({"status": "pending"})
    validated = await db.mission_withdrawals.count_documents({"status": "validated"})
    rejected = await db.mission_withdrawals.count_documents({"status": "rejected"})
    sum_agg = await db.mission_withdrawals.aggregate([
        {"$group": {
            "_id": "$status",
            "amount_total": {"$sum": "$amount"},
            "fee_total": {"$sum": "$fee"},
            "net_total": {"$sum": "$net_payout"},
        }}
    ]).to_list(10)
    by_status = {s["_id"]: s for s in sum_agg}
    return {
        "config": cfg,
        "stats": {
            "total_count": total_count,
            "pending_count": pending,
            "validated_count": validated,
            "rejected_count": rejected,
            "total_amount": float((by_status.get("validated") or {}).get("amount_total") or 0)
                          + float((by_status.get("pending") or {}).get("amount_total") or 0)
                          + float((by_status.get("rejected") or {}).get("amount_total") or 0),
            "validated_amount": float((by_status.get("validated") or {}).get("amount_total") or 0),
            "validated_net": float((by_status.get("validated") or {}).get("net_total") or 0),
            "validated_fee": float((by_status.get("validated") or {}).get("fee_total") or 0),
            "pending_amount": float((by_status.get("pending") or {}).get("amount_total") or 0),
            "rejected_amount": float((by_status.get("rejected") or {}).get("amount_total") or 0),
        },
    }


@admin.put("/mission-payout")
async def admin_update_payout(body: PayoutConfigIn, request: Request, who=Depends(require_admin)):
    db = request.app.state.db
    value = {"min_withdrawal": float(body.min_withdrawal), "fee_percent": float(body.fee_percent)}
    await db.app_settings.update_one(
        {"key": "mission_payout"},
        {"$set": {
            "key": "mission_payout",
            "value": value,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": who.get("username"),
        }},
        upsert=True,
    )
    cfg = await _load_payout_config(db)
    return {"ok": True, "config": cfg}


class ScheduleIn(BaseModel):
    allowed_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    open_time: str = "08:00"
    close_time: str = "16:00"
    timezone: str = "Africa/Lome"
    enabled: bool = True
    day_type_map: Optional[dict] = None  # {"0":"youtube", "1":"tiktok", ...}


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
        "today_type": _today_mission_type(cfg),
        "today_label": _today_label(cfg),
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
    # Validate day_type_map
    if body.day_type_map is not None:
        for k, v in body.day_type_map.items():
            try:
                day = int(k)
            except Exception:
                raise HTTPException(400, f"day_type_map clé invalide: {k}")
            if not (0 <= day <= 6):
                raise HTTPException(400, f"day_type_map clé invalide (0..6): {k}")
            if v and str(v).strip().lower() not in MISSION_TYPES:
                raise HTTPException(400, f"day_type_map: type invalide '{v}'. Autorisés: {MISSION_TYPES} ou chaîne vide.")
    db = request.app.state.db
    value = body.dict(exclude_none=False)
    # Normalize day_type_map keys to str
    if value.get("day_type_map"):
        value["day_type_map"] = {str(k): str(v).strip().lower() for k, v in value["day_type_map"].items()}
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
        "today_type": _today_mission_type(cfg),
        "today_label": _today_label(cfg),
    }
