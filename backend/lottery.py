"""Lottery Jackpot module — completely isolated from MLM commissions.

Collections:
  * `lottery_settings`  — single doc (key="config") with module-wide toggles.
  * `lottery_draws`     — one doc per draw, status ∈ draft/open/closed/announced.
  * `lottery_participants` — one doc per (user_id, draw_id) joining event.

Funds:
  - Joining a draw debits `users.balance_profit` (withdrawable wallet).
  - When the admin announces results, winners are credited back on
    `users.balance_profit` and an entry is added to `db.commissions` with
    `kind="lottery"` so the unified transaction history shows it cleanly.
"""
from __future__ import annotations
import csv
import io
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin

DEFAULT_SETTINGS = {
    "enabled": True,
    "results_display_duration_minutes": 60,
    "floating_icon_visible": True,
}

public = APIRouter(prefix="/api", tags=["lottery"])
admin = APIRouter(prefix="/api/admin", tags=["lottery_admin"])


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
async def _load_settings(db) -> dict:
    doc = await db.lottery_settings.find_one({"key": "config"}, {"_id": 0}) or {}
    cfg = dict(DEFAULT_SETTINGS)
    cfg.update({k: doc[k] for k in DEFAULT_SETTINGS.keys() if k in doc})
    return cfg


def _serialize_draw(d: dict) -> dict:
    """Strip Mongo internals and normalize datetimes for JSON output."""
    out = {k: v for k, v in d.items() if k != "_id"}
    for k in ("starts_at", "ends_at", "created_at", "announced_at",
              "results_visible_until"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


# ----------------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------------
class PrizeIn(BaseModel):
    rank: int = Field(ge=1)
    amount: float = Field(ge=0)


class DrawCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    starts_at: str            # ISO datetime
    ends_at: str              # ISO datetime
    entry_amount: float = Field(default=500.0, ge=0)
    winners_count: int = Field(ge=1, le=100)
    max_participants: Optional[int] = Field(default=None, ge=1)
    prizes: List[PrizeIn] = Field(default_factory=list)


class DrawUpdateIn(BaseModel):
    name: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    entry_amount: Optional[float] = Field(default=None, ge=0)
    winners_count: Optional[int] = Field(default=None, ge=1, le=100)
    max_participants: Optional[int] = Field(default=None, ge=1)
    prizes: Optional[List[PrizeIn]] = None
    status: Optional[str] = None  # draft|open|closed


class WinnerIn(BaseModel):
    rank: int = Field(ge=1)
    user_id: str
    prize: float = Field(ge=0)


class SettingsIn(BaseModel):
    enabled: Optional[bool] = None
    results_display_duration_minutes: Optional[int] = Field(default=None, ge=0)
    floating_icon_visible: Optional[bool] = None


# ----------------------------------------------------------------------------
# Public endpoints (user-facing)
# ----------------------------------------------------------------------------
@public.get("/lottery/settings")
async def public_lottery_settings(request: Request, _user=Depends(get_current_user)):
    """User-facing module toggles (no admin secrets)."""
    db = request.app.state.db
    cfg = await _load_settings(db)
    return {
        "enabled": bool(cfg["enabled"]),
        "floating_icon_visible": bool(cfg["floating_icon_visible"]),
    }


@public.get("/lottery/active")
async def get_active_lottery(request: Request, user=Depends(get_current_user)):
    """Returns the current open draw + any recently-announced draw whose
    results are still being displayed for the configured duration.
    """
    db = request.app.state.db
    cfg = await _load_settings(db)
    if not cfg["enabled"]:
        return {"enabled": False, "active": None, "announced": None}

    now = datetime.now(timezone.utc)

    # 1) Find the active (open / closed but not announced) draw.
    active_doc = await db.lottery_draws.find_one(
        {"status": {"$in": ["open", "closed"]}}, {"_id": 0}, sort=[("created_at", -1)],
    )
    active = None
    if active_doc:
        active_doc.setdefault("entry_amount", 500.0)
        participants_count = await db.lottery_participants.count_documents(
            {"draw_id": active_doc["id"]}
        )
        already_joined = await db.lottery_participants.find_one(
            {"draw_id": active_doc["id"], "user_id": user["id"]}, {"_id": 1}
        ) is not None
        active = _serialize_draw(active_doc)
        active["participants_count"] = participants_count
        active["already_joined"] = already_joined
        # Auto-flip to "closed" if past ends_at
        ends = active_doc.get("ends_at")
        if isinstance(ends, datetime) and ends < now and active_doc["status"] == "open":
            await db.lottery_draws.update_one(
                {"id": active_doc["id"]}, {"$set": {"status": "closed"}}
            )
            active["status"] = "closed"

    # 2) Find any announced draw whose results are still visible.
    announced_doc = await db.lottery_draws.find_one(
        {"status": "announced", "results_visible_until": {"$gte": now}},
        {"_id": 0},
        sort=[("announced_at", -1)],
    )
    announced = _serialize_draw(announced_doc) if announced_doc else None

    return {"enabled": True, "active": active, "announced": announced}


@public.post("/lottery/draws/{draw_id}/join")
async def join_lottery(draw_id: str, request: Request, user=Depends(get_current_user)):
    """Deduct entry_amount from balance_profit and register the user."""
    db = request.app.state.db
    cfg = await _load_settings(db)
    if not cfg["enabled"]:
        raise HTTPException(403, "Le module Lottery est désactivé.")

    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d.get("status") != "open":
        raise HTTPException(400, "Ce tirage n'accepte plus de participation.")

    now = datetime.now(timezone.utc)
    ends = d.get("ends_at")
    if isinstance(ends, datetime) and ends < now:
        await db.lottery_draws.update_one({"id": draw_id}, {"$set": {"status": "closed"}})
        raise HTTPException(400, "Ce tirage est terminé.")

    # Capacity check
    max_p = d.get("max_participants")
    if max_p:
        count = await db.lottery_participants.count_documents({"draw_id": draw_id})
        if count >= int(max_p):
            raise HTTPException(400, "Nombre maximal de participants atteint.")

    # Already joined?
    existing = await db.lottery_participants.find_one(
        {"draw_id": draw_id, "user_id": user["id"]}, {"_id": 1}
    )
    if existing:
        raise HTTPException(409, "Vous participez déjà à ce tirage.")

    entry_amount = float(d.get("entry_amount") or 0)
    if entry_amount > 0:
        # Try balance_profit first, then balance_recharge as fallback.
        debited_from = None
        r = await db.users.update_one(
            {"id": user["id"], "balance_profit": {"$gte": entry_amount}},
            {"$inc": {"balance_profit": -entry_amount}},
        )
        if r.modified_count:
            debited_from = "balance_profit"
        else:
            r2 = await db.users.update_one(
                {"id": user["id"], "balance_recharge": {"$gte": entry_amount}},
                {"$inc": {"balance_recharge": -entry_amount}},
            )
            if r2.modified_count:
                debited_from = "balance_recharge"
        if not debited_from:
            u = await db.users.find_one({"id": user["id"]}, {"_id": 0}) or {}
            bp = float(u.get("balance_profit") or 0)
            br = float(u.get("balance_recharge") or 0)
            raise HTTPException(400, f"Solde insuffisant. Disponible : {bp:.0f} FCFA (profit) + {br:.0f} FCFA (recharge). Veuillez recharger votre compte.")

    await db.lottery_participants.insert_one({
        "id": str(uuid.uuid4()),
        "draw_id": draw_id,
        "user_id": user["id"],
        "username": user.get("username"),
        "paid_amount": entry_amount,
        "debited_from": locals().get("debited_from"),
        "entered_at": now,
    })
    # Track the debit in db.commissions (kind=lottery_entry, negative profit_share)
    if entry_amount > 0:
        await db.commissions.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "from_user_id": None,
            "kind": "lottery_entry",
            "amount": -entry_amount,
            "profit_share": -entry_amount,
            "upgrade_share": 0,
            "level": None,
            "meta": {"draw_id": draw_id, "draw_name": d.get("name")},
            "created_at": now,
        })
    return {"ok": True, "draw_id": draw_id, "paid_amount": entry_amount}


# ----------------------------------------------------------------------------
# Admin endpoints
# ----------------------------------------------------------------------------
@admin.get("/lottery/settings")
async def admin_get_settings(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    return await _load_settings(db)


@admin.put("/lottery/settings")
async def admin_update_settings(body: SettingsIn, request: Request, who=Depends(require_admin)):
    db = request.app.state.db
    cur = await _load_settings(db)
    new = dict(cur)
    if body.enabled is not None:
        new["enabled"] = bool(body.enabled)
    if body.results_display_duration_minutes is not None:
        new["results_display_duration_minutes"] = int(body.results_display_duration_minutes)
    if body.floating_icon_visible is not None:
        new["floating_icon_visible"] = bool(body.floating_icon_visible)
    new["updated_at"] = datetime.now(timezone.utc)
    new["updated_by"] = who.get("username")
    await db.lottery_settings.update_one(
        {"key": "config"}, {"$set": {"key": "config", **new}}, upsert=True,
    )
    return new


def _parse_iso(v: str) -> datetime:
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(400, f"Date invalide: {v} (format attendu ISO 8601).")


@admin.get("/lottery/draws")
async def admin_list_draws(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    items = []
    async for d in db.lottery_draws.find({}, {"_id": 0}).sort("created_at", -1):
        d["participants_count"] = await db.lottery_participants.count_documents({"draw_id": d["id"]})
        items.append(_serialize_draw(d))
    return items


@admin.post("/lottery/draws")
async def admin_create_draw(body: DrawCreateIn, request: Request, who=Depends(require_admin)):
    db = request.app.state.db
    starts = _parse_iso(body.starts_at)
    ends = _parse_iso(body.ends_at)
    if ends <= starts:
        raise HTTPException(400, "ends_at doit être postérieur à starts_at.")
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "starts_at": starts,
        "ends_at": ends,
        "entry_amount": float(body.entry_amount),
        "winners_count": int(body.winners_count),
        "max_participants": int(body.max_participants) if body.max_participants else None,
        "prizes": [p.dict() for p in body.prizes],
        "winners": [],
        "status": "draft",
        "created_at": datetime.now(timezone.utc),
        "created_by": who.get("username"),
    }
    await db.lottery_draws.insert_one(dict(doc))
    return _serialize_draw(doc)


@admin.put("/lottery/draws/{draw_id}")
async def admin_update_draw(draw_id: str, body: DrawUpdateIn, request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    upd: dict = {}
    if body.name is not None:
        upd["name"] = body.name
    if body.starts_at is not None:
        upd["starts_at"] = _parse_iso(body.starts_at)
    if body.ends_at is not None:
        upd["ends_at"] = _parse_iso(body.ends_at)
    if body.entry_amount is not None:
        upd["entry_amount"] = float(body.entry_amount)
    if body.winners_count is not None:
        upd["winners_count"] = int(body.winners_count)
    if body.max_participants is not None:
        upd["max_participants"] = int(body.max_participants)
    if body.prizes is not None:
        upd["prizes"] = [p.dict() for p in body.prizes]
    if body.status is not None:
        if body.status not in ("draft", "open", "closed"):
            raise HTTPException(400, "status doit être draft/open/closed.")
        upd["status"] = body.status
    await db.lottery_draws.update_one({"id": draw_id}, {"$set": upd})
    new_doc = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    return _serialize_draw(new_doc)


@admin.delete("/lottery/draws/{draw_id}")
async def admin_delete_draw(draw_id: str, request: Request, _=Depends(require_admin)):
    """Hard delete a draft draw (refunds all participants if any)."""
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d["status"] == "announced":
        raise HTTPException(400, "Impossible de supprimer un tirage déjà annoncé.")
    # Refund participants
    async for p in db.lottery_participants.find({"draw_id": draw_id}, {"_id": 0}):
        amt = float(p.get("paid_amount") or 0)
        if amt > 0:
            await db.users.update_one(
                {"id": p["user_id"]}, {"$inc": {"balance_profit": amt}}
            )
    await db.lottery_participants.delete_many({"draw_id": draw_id})
    await db.lottery_draws.delete_one({"id": draw_id})
    return {"ok": True, "refunded": True}


@admin.get("/lottery/draws/{draw_id}/participants")
async def admin_list_participants(draw_id: str, request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    items = []
    async for p in db.lottery_participants.find({"draw_id": draw_id}, {"_id": 0}).sort("entered_at", 1):
        if isinstance(p.get("entered_at"), datetime):
            p["entered_at"] = p["entered_at"].isoformat()
        items.append(p)
    return items


@admin.post("/lottery/draws/{draw_id}/announce")
async def admin_announce_draw(
    draw_id: str, body: dict, request: Request, who=Depends(require_admin)
):
    """Body: { winners: [{rank, user_id, prize}, …] }
    Credits each winner's `balance_profit`, posts a `lottery_win` row in
    `commissions`, then transitions the draw to `announced` with a
    `results_visible_until` timestamp for the configured duration.
    """
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d["status"] == "announced":
        raise HTTPException(400, "Ce tirage a déjà été annoncé.")
    raw_winners = (body or {}).get("winners") or []
    if not isinstance(raw_winners, list) or not raw_winners:
        raise HTTPException(400, "Liste des gagnants vide.")
    winners_models = [WinnerIn(**w) for w in raw_winners]
    # Validate each winner exists and is a participant
    enriched = []
    now = datetime.now(timezone.utc)
    for w in winners_models:
        part = await db.lottery_participants.find_one(
            {"draw_id": draw_id, "user_id": w.user_id}, {"_id": 0}
        )
        if not part:
            raise HTTPException(400, f"Utilisateur {w.user_id} n'est pas un participant.")
        u = await db.users.find_one({"id": w.user_id}, {"_id": 0, "username": 1})
        if not u:
            raise HTTPException(400, f"Utilisateur {w.user_id} introuvable.")
        enriched.append({
            "rank": int(w.rank),
            "user_id": w.user_id,
            "username": u.get("username"),
            "prize": float(w.prize),
        })
    # Credit and log each winner
    for win in enriched:
        if win["prize"] > 0:
            await db.users.update_one(
                {"id": win["user_id"]}, {"$inc": {"balance_profit": win["prize"]}}
            )
            await db.commissions.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": win["user_id"],
                "from_user_id": None,
                "kind": "lottery_win",
                "amount": win["prize"],
                "profit_share": win["prize"],
                "upgrade_share": 0,
                "level": None,
                "meta": {"draw_id": draw_id, "draw_name": d.get("name"), "rank": win["rank"]},
                "created_at": now,
            })
        # Notify the winner
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": win["user_id"],
            "kind": "lottery_win",
            "title": "🎉 Vous avez remporté le Lottery Jackpot !",
            "body": f"Félicitations ! Vous êtes #{win['rank']} du tirage « {d.get('name')} » — gain : {int(win['prize']):,} FCFA crédité sur votre solde retirable.".replace(",", " "),
            "read": False,
            "created_at": now,
        })
    # Notify the losers
    winner_ids = {w["user_id"] for w in enriched}
    async for p in db.lottery_participants.find({"draw_id": draw_id}, {"_id": 0, "user_id": 1}):
        if p["user_id"] in winner_ids:
            continue
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": p["user_id"],
            "kind": "lottery_loss",
            "title": "Merci pour votre participation au Lottery Jackpot",
            "body": f"Le tirage « {d.get('name')} » est terminé. Rendez-vous au prochain Lottery Jackpot !",
            "read": False,
            "created_at": now,
        })
    # Persist the announcement
    cfg = await _load_settings(db)
    visible_until = now + _delta_minutes(int(cfg["results_display_duration_minutes"]))
    await db.lottery_draws.update_one(
        {"id": draw_id},
        {"$set": {
            "status": "announced",
            "winners": enriched,
            "announced_at": now,
            "announced_by": who.get("username"),
            "results_visible_until": visible_until,
        }},
    )
    return {"ok": True, "winners": enriched, "results_visible_until": visible_until.isoformat()}


def _delta_minutes(m: int):
    from datetime import timedelta
    return timedelta(minutes=max(0, int(m)))


@admin.get("/lottery/stats")
async def admin_lottery_stats(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    total_draws = await db.lottery_draws.count_documents({})
    open_draws = await db.lottery_draws.count_documents({"status": "open"})
    closed_draws = await db.lottery_draws.count_documents({"status": "closed"})
    announced_draws = await db.lottery_draws.count_documents({"status": "announced"})
    total_participants = await db.lottery_participants.count_documents({})
    sum_collected = await db.lottery_participants.aggregate([
        {"$group": {"_id": None, "total": {"$sum": "$paid_amount"}}}
    ]).to_list(1)
    collected = float((sum_collected[0] or {}).get("total") or 0) if sum_collected else 0
    sum_paid = await db.commissions.aggregate([
        {"$match": {"kind": "lottery_win"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]).to_list(1)
    distributed = float((sum_paid[0] or {}).get("total") or 0) if sum_paid else 0
    return {
        "total_draws": total_draws,
        "draft_count": total_draws - open_draws - closed_draws - announced_draws,
        "open_count": open_draws,
        "closed_count": closed_draws,
        "announced_count": announced_draws,
        "total_participants": total_participants,
        "total_collected": collected,
        "total_distributed": distributed,
        "net_revenue": collected - distributed,
    }


@admin.get("/lottery/draws/{draw_id}/export.csv")
async def admin_export_draw_csv(draw_id: str, request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["draw_name", d.get("name")])
    w.writerow(["status", d.get("status")])
    w.writerow(["entry_amount", d.get("entry_amount")])
    w.writerow([])
    w.writerow(["#", "username", "user_id", "paid_amount", "entered_at"])
    idx = 0
    async for p in db.lottery_participants.find({"draw_id": draw_id}, {"_id": 0}).sort("entered_at", 1):
        idx += 1
        ts = p.get("entered_at")
        ts_str = ts.isoformat() if isinstance(ts, datetime) else str(ts or "")
        w.writerow([idx, p.get("username") or "", p.get("user_id") or "", p.get("paid_amount") or 0, ts_str])
    w.writerow([])
    w.writerow(["WINNERS"])
    w.writerow(["rank", "username", "user_id", "prize"])
    for win in (d.get("winners") or []):
        w.writerow([win.get("rank"), win.get("username") or "", win.get("user_id") or "", win.get("prize") or 0])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="lottery_{draw_id}.csv"'},
    )
