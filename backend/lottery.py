"""Lottery Jackpot module — completely isolated from MLM commissions.

Collections:
  * `lottery_settings`  — single doc (key="config") with module-wide toggles.
  * `lottery_draws`     — one doc per draw, status ∈ open/running/announced.
  * `lottery_participants` — one doc per (user_id, draw_id) joining event.

Lifecycle (new flow):
  1) Admin crée le jackpot → statut `open` immédiatement (visible aux users).
  2) Users peuvent rejoindre tant que `status == open` ET `participants_count <
     max_participants`. Le solde est débité (balance_profit puis balance_recharge).
  3) Admin clique sur "Lancer le tirage" et choisit une durée
     (`duration_minutes`). Le statut passe à `running`, `ends_at` est posé, et le
     compte à rebours commence côté users.
  4) Quand le compte à rebours arrive à 0 (détecté à chaque appel
     `/lottery/active` ou `/admin/lottery/draws`), le tirage est complété
     automatiquement : sélection aléatoire des gagnants parmi les participants,
     crédit des gains sur `balance_profit`, notifications, statut `announced`.

Funds:
  - Joining a draw debits `users.balance_profit` (fallback: `balance_recharge`).
  - When winners are announced (manual or auto), prizes are credited back on
    `users.balance_profit` and a `lottery_win` row is inserted into
    `db.commissions` so the unified transaction history shows it cleanly.
"""
from __future__ import annotations
import csv
import io
import random
import uuid
from datetime import datetime, timedelta, timezone
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
    for k in (
        "starts_at", "ends_at", "created_at", "announced_at",
        "launched_at", "results_visible_until",
    ):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


def _delta_minutes(m: int):
    return timedelta(minutes=max(0, int(m)))


def _as_aware(dt):
    """Mongo stores naive UTC datetimes; coerce them to aware to allow safe
    comparisons with `datetime.now(timezone.utc)`."""
    if isinstance(dt, datetime) and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def _auto_complete_if_due(db, draw: dict) -> dict:
    """If a `running` draw has passed `ends_at`, auto-announce winners and
    transition the draw to `announced`. Returns the (possibly updated) draw doc.

    Winners are taken from `preset_winners` (selected manually by the admin
    before launching). If `preset_winners` is empty (legacy or edge case),
    falls back to a random pick among participants.
    """
    if draw.get("status") != "running":
        return draw
    ends = _as_aware(draw.get("ends_at"))
    if not isinstance(ends, datetime):
        return draw
    if ends > datetime.now(timezone.utc):
        return draw

    draw_id = draw["id"]
    cfg = await _load_settings(db)
    now = datetime.now(timezone.utc)

    enriched: List[dict] = []

    preset = draw.get("preset_winners") or []
    if preset:
        # Use the manually pre-selected winners. Re-resolve usernames in case
        # they changed since selection.
        for w in preset:
            u = await db.users.find_one({"id": w["user_id"]}, {"_id": 0, "username": 1}) or {}
            enriched.append({
                "rank": int(w.get("rank") or 0),
                "user_id": w["user_id"],
                "username": u.get("username") or w.get("username"),
                "prize": float(w.get("prize") or 0),
            })
        enriched.sort(key=lambda x: x["rank"])
    else:
        # Safety fallback (should not happen because /launch enforces preset
        # selection). Pick random winners among participants.
        parts: List[dict] = []
        async for p in db.lottery_participants.find({"draw_id": draw_id}, {"_id": 0}):
            parts.append(p)
        prizes = sorted(draw.get("prizes") or [], key=lambda p: int(p.get("rank") or 0))
        winners_target = min(int(draw.get("winners_count") or 0), len(prizes), len(parts))
        if winners_target > 0:
            pool = list(parts)
            random.shuffle(pool)
            chosen = pool[:winners_target]
            for i, p in enumerate(chosen):
                pr = prizes[i]
                u = await db.users.find_one({"id": p["user_id"]}, {"_id": 0, "username": 1}) or {}
                enriched.append({
                    "rank": int(pr.get("rank") or (i + 1)),
                    "user_id": p["user_id"],
                    "username": u.get("username") or p.get("username"),
                    "prize": float(pr.get("amount") or 0),
                })

    # Credit winners & log commissions
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
                "meta": {
                    "draw_id": draw_id,
                    "draw_name": draw.get("name"),
                    "rank": win["rank"],
                    "auto": True,
                },
                "created_at": now,
            })
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": win["user_id"],
            "kind": "lottery_win",
            "title": "🎉 Vous avez remporté le Lottery Jackpot !",
            "body": (
                f"Félicitations ! Vous êtes #{win['rank']} du tirage "
                f"« {draw.get('name')} » — gain : {int(win['prize']):,} FCFA "
                "crédité sur votre solde retirable."
            ).replace(",", " "),
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
            "body": (
                f"Le tirage « {draw.get('name')} » est terminé. Rendez-vous au "
                "prochain Lottery Jackpot !"
            ),
            "read": False,
            "created_at": now,
        })

    visible_until = now + _delta_minutes(int(cfg["results_display_duration_minutes"]))
    update_doc = {
        "status": "announced",
        "winners": enriched,
        "announced_at": now,
        "announced_by": "auto",
        "results_visible_until": visible_until,
    }
    await db.lottery_draws.update_one({"id": draw_id}, {"$set": update_doc})
    draw.update(update_doc)
    return draw


# ----------------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------------
class PrizeIn(BaseModel):
    rank: int = Field(ge=1)
    amount: float = Field(ge=0)


class DrawCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = None
    entry_amount: float = Field(default=500.0, ge=0)
    # No upper hardcoded cap — the admin is free to define any number of
    # winners. A logical check below enforces `winners_count ≤ max_participants`.
    winners_count: int = Field(ge=1)
    max_participants: Optional[int] = Field(default=None, ge=1)
    min_participants: Optional[int] = Field(default=None, ge=0)
    prizes: List[PrizeIn] = Field(default_factory=list)


class DrawUpdateIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    entry_amount: Optional[float] = Field(default=None, ge=0)
    winners_count: Optional[int] = Field(default=None, ge=1)
    max_participants: Optional[int] = Field(default=None, ge=1)
    min_participants: Optional[int] = Field(default=None, ge=0)
    prizes: Optional[List[PrizeIn]] = None
    status: Optional[str] = None  # open|running|announced


class LaunchIn(BaseModel):
    duration_minutes: int = Field(ge=1, le=60 * 24 * 30)  # max 30 jours


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
    """Returns the current open / running draw + any recently-announced draw
    whose results are still being displayed for the configured duration.
    """
    db = request.app.state.db
    cfg = await _load_settings(db)
    if not cfg["enabled"]:
        return {"enabled": False, "active": None, "announced": None}

    # 1) Find the current active draw (open or running).
    active_doc = await db.lottery_draws.find_one(
        {"status": {"$in": ["open", "running"]}},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    active = None
    if active_doc:
        # Auto-complete if the running countdown has expired.
        active_doc = await _auto_complete_if_due(db, active_doc)
        if active_doc.get("status") in ("open", "running"):
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

    # 2) Find any announced draw whose results are still visible.
    now = datetime.now(timezone.utc)
    announced_doc = await db.lottery_draws.find_one(
        {"status": "announced", "results_visible_until": {"$gte": now}},
        {"_id": 0},
        sort=[("announced_at", -1)],
    )
    announced = _serialize_draw(announced_doc) if announced_doc else None

    return {"enabled": True, "active": active, "announced": announced}


@public.post("/lottery/draws/{draw_id}/join")
async def join_lottery(draw_id: str, request: Request, user=Depends(get_current_user)):
    """Deduct entry_amount from balance_profit (fallback balance_recharge) and
    register the user. Joining is allowed only when status == "open"."""
    db = request.app.state.db
    cfg = await _load_settings(db)
    if not cfg["enabled"]:
        raise HTTPException(403, "Le module Lottery est désactivé.")

    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d.get("status") != "open":
        raise HTTPException(400, "Ce tirage n'accepte plus de participation (le tirage a été lancé ou est terminé).")

    # Strict capacity check
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
    debited_from: Optional[str] = None
    if entry_amount > 0:
        # Try balance_profit first, then balance_recharge as fallback.
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
            raise HTTPException(
                400,
                f"Solde insuffisant. Disponible : {bp:.0f} FCFA (profit) + {br:.0f} FCFA (recharge). Veuillez recharger votre compte.",
            )

    now = datetime.now(timezone.utc)
    await db.lottery_participants.insert_one({
        "id": str(uuid.uuid4()),
        "draw_id": draw_id,
        "user_id": user["id"],
        "username": user.get("username"),
        "paid_amount": entry_amount,
        "debited_from": debited_from,
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


@admin.get("/lottery/draws")
async def admin_list_draws(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    items = []
    async for d in db.lottery_draws.find({}, {"_id": 0}).sort("created_at", -1):
        # Auto-complete any draw whose countdown has expired before returning.
        d = await _auto_complete_if_due(db, d)
        d["participants_count"] = await db.lottery_participants.count_documents({"draw_id": d["id"]})
        items.append(_serialize_draw(d))
    return items


@admin.post("/lottery/draws")
async def admin_create_draw(body: DrawCreateIn, request: Request, who=Depends(require_admin)):
    """Create a Jackpot in `open` status immediately — no duration at this step.
    The duration is supplied later via `POST /admin/lottery/draws/{id}/launch`.
    """
    db = request.app.state.db
    # Logical guard: cannot have more winners than possible participants.
    if body.max_participants is not None and body.winners_count > body.max_participants:
        raise HTTPException(
            400,
            f"Le nombre de gagnants ({body.winners_count}) ne peut pas dépasser "
            f"le nombre maximum de participants ({body.max_participants}).",
        )
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "description": (body.description or "").strip() or None,
        "entry_amount": float(body.entry_amount),
        "winners_count": int(body.winners_count),
        "max_participants": int(body.max_participants) if body.max_participants else None,
        "min_participants": int(body.min_participants) if body.min_participants else None,
        "prizes": [p.dict() for p in body.prizes],
        "winners": [],
        "preset_winners": [],
        # Open immediately — visible to users, no countdown yet.
        "status": "open",
        "launched": False,
        "ends_at": None,
        "launched_at": None,
        "created_at": now,
        "created_by": who.get("username"),
    }
    await db.lottery_draws.insert_one(dict(doc))
    return _serialize_draw(doc)


@admin.post("/lottery/draws/{draw_id}/select-winners")
async def admin_select_winners(
    draw_id: str, body: dict, request: Request, who=Depends(require_admin)
):
    """Body: { winners: [{rank, user_id, prize}, …] }

    Pre-selects the winners for a Jackpot BEFORE the launch. Validations:
      • The draw must be in `open` status.
      • Exactly `winners_count` selections are required.
      • Ranks must cover 1..winners_count without duplicates.
      • Each `user_id` must be a participant of the draw.
      • A single user cannot occupy more than one rank.

    The selection is stored on the draw as `preset_winners` and is committed
    automatically when the countdown ends (the `_auto_complete_if_due` helper
    uses `preset_winners` directly — no random pick).
    """
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d.get("status") != "open":
        raise HTTPException(
            400,
            "Les gagnants doivent être sélectionnés avant le lancement (le tirage doit être 'open').",
        )

    raw = (body or {}).get("winners") or []
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, "Liste des gagnants vide.")

    expected = int(d.get("winners_count") or 0)
    if len(raw) != expected:
        raise HTTPException(
            400,
            f"Vous devez sélectionner exactement {expected} gagnant(s) — reçu : {len(raw)}.",
        )

    try:
        models = [WinnerIn(**w) for w in raw]
    except Exception as e:
        raise HTTPException(400, f"Format invalide : {e}")

    ranks_sorted = sorted([m.rank for m in models])
    if ranks_sorted != list(range(1, expected + 1)):
        raise HTTPException(
            400,
            f"Tous les rangs de 1 à {expected} doivent être attribués, sans doublon ni rang manquant.",
        )

    user_ids = [m.user_id for m in models]
    if len(set(user_ids)) != len(user_ids):
        raise HTTPException(
            400,
            "Un même utilisateur ne peut pas être sélectionné sur plusieurs rangs.",
        )

    enriched: List[dict] = []
    for m in models:
        part = await db.lottery_participants.find_one(
            {"draw_id": draw_id, "user_id": m.user_id}, {"_id": 0}
        )
        if not part:
            raise HTTPException(
                400,
                f"L'utilisateur {m.user_id} n'a pas participé à ce Jackpot et ne peut pas être sélectionné.",
            )
        u = await db.users.find_one({"id": m.user_id}, {"_id": 0, "username": 1}) or {}
        enriched.append({
            "rank": int(m.rank),
            "user_id": m.user_id,
            "username": u.get("username") or part.get("username"),
            "prize": float(m.prize),
        })
    enriched.sort(key=lambda x: x["rank"])

    now = datetime.now(timezone.utc)
    await db.lottery_draws.update_one(
        {"id": draw_id},
        {"$set": {
            "preset_winners": enriched,
            "winners_selected_at": now,
            "winners_selected_by": who.get("username"),
        }},
    )
    new_doc = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    return _serialize_draw(new_doc)


@admin.post("/lottery/draws/{draw_id}/launch")
async def admin_launch_draw(
    draw_id: str, body: LaunchIn, request: Request, who=Depends(require_admin)
):
    """Move an `open` Jackpot to `running` by stamping `ends_at = now + duration_minutes`.
    Once running, no more participants can join. Users see a live countdown."""
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d.get("status") != "open":
        raise HTTPException(400, f"Impossible de lancer un tirage au statut « {d.get('status')} ». Seuls les tirages 'open' peuvent être lancés.")

    participants_count = await db.lottery_participants.count_documents({"draw_id": draw_id})
    if participants_count <= 0:
        raise HTTPException(400, "Impossible de lancer un tirage sans participant.")

    preset = d.get("preset_winners") or []
    expected_winners = int(d.get("winners_count") or 0)
    if len(preset) != expected_winners:
        raise HTTPException(
            400,
            f"Vous devez d'abord sélectionner et valider les {expected_winners} gagnant(s) avant de lancer le tirage.",
        )

    # Sanity: ensure every preset winner is still a participant.
    for w in preset:
        ok = await db.lottery_participants.find_one(
            {"draw_id": draw_id, "user_id": w.get("user_id")}, {"_id": 1}
        )
        if not ok:
            raise HTTPException(
                400,
                "Un des gagnants sélectionnés n'est plus participant. Veuillez re-valider la sélection.",
            )

    now = datetime.now(timezone.utc)
    ends_at = now + timedelta(minutes=int(body.duration_minutes))
    await db.lottery_draws.update_one(
        {"id": draw_id},
        {"$set": {
            "status": "running",
            "launched": True,
            "launched_at": now,
            "launched_by": who.get("username"),
            "ends_at": ends_at,
            "duration_minutes": int(body.duration_minutes),
        }},
    )
    new_doc = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    return _serialize_draw(new_doc)


@admin.put("/lottery/draws/{draw_id}")
async def admin_update_draw(draw_id: str, body: DrawUpdateIn, request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    upd: dict = {}
    if body.name is not None:
        upd["name"] = body.name
    if body.description is not None:
        upd["description"] = body.description.strip() or None
    if body.entry_amount is not None:
        upd["entry_amount"] = float(body.entry_amount)
    if body.winners_count is not None:
        upd["winners_count"] = int(body.winners_count)
    if body.max_participants is not None:
        upd["max_participants"] = int(body.max_participants)
    if body.min_participants is not None:
        upd["min_participants"] = int(body.min_participants)
    # Same logical guard on update: keep winners_count ≤ max_participants
    # using whichever value is being applied in this call.
    effective_winners = upd.get("winners_count", d.get("winners_count"))
    effective_max = upd.get("max_participants", d.get("max_participants"))
    if effective_winners and effective_max and effective_winners > effective_max:
        raise HTTPException(
            400,
            f"Le nombre de gagnants ({effective_winners}) ne peut pas dépasser "
            f"le nombre maximum de participants ({effective_max}).",
        )
    if body.prizes is not None:
        upd["prizes"] = [p.dict() for p in body.prizes]
    if body.status is not None:
        if body.status not in ("open", "running", "announced"):
            raise HTTPException(400, "status doit être open/running/announced.")
        upd["status"] = body.status
    await db.lottery_draws.update_one({"id": draw_id}, {"$set": upd})
    new_doc = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    return _serialize_draw(new_doc)


@admin.delete("/lottery/draws/{draw_id}")
async def admin_delete_draw(draw_id: str, request: Request, _=Depends(require_admin)):
    """Hard delete a non-announced draw (refunds all participants if any)."""
    db = request.app.state.db
    d = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Tirage introuvable.")
    if d["status"] == "announced":
        raise HTTPException(400, "Impossible de supprimer un tirage déjà annoncé.")
    # Refund participants on the original wallet (best-effort)
    async for p in db.lottery_participants.find({"draw_id": draw_id}, {"_id": 0}):
        amt = float(p.get("paid_amount") or 0)
        if amt > 0:
            target = "balance_recharge" if p.get("debited_from") == "balance_recharge" else "balance_profit"
            await db.users.update_one(
                {"id": p["user_id"]}, {"$inc": {target: amt}}
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
    Manual override: lets the admin announce custom winners (e.g. to finalize a
    `running` draw before its countdown expires). Credits each winner's
    `balance_profit`, posts a `lottery_win` row in `commissions`, then
    transitions the draw to `announced`.
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


@admin.get("/lottery/stats")
async def admin_lottery_stats(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    total_draws = await db.lottery_draws.count_documents({})
    open_draws = await db.lottery_draws.count_documents({"status": "open"})
    running_draws = await db.lottery_draws.count_documents({"status": "running"})
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
        "open_count": open_draws,
        "running_count": running_draws,
        # Kept for backward compatibility with the existing admin UI.
        "closed_count": running_draws,
        "draft_count": 0,
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
