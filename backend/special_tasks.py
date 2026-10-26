"""Special Tasks module — paid micro-tasks (like, view, subscribe, share, comment, join).

Flow (2026-07-24):
    1. User picks an action type (video/subscribe/share/like/comment/group) + network + link.
    2. Sets audience (countries, age, gender).
    3. Picks quantity → server computes price = price_per_action × quantity.
    4. Payment (manual confirm for now — plug SoleasPay webhook later).
    5. Task goes LIVE (status=active) automatically — no admin review required.
    6. Feed shows only active tasks (quantity_completed < quantity_target).
    7. Users complete → reward credited to their balance_profit; counter increments.
    8. When quantity_completed == quantity_target → status=completed, task disappears.
    9. Task remains in DB for history.

Admin config (collection `special_tasks_config` singleton):
    - action_types: dict mapping "video"|"subscribe"|"share"|"like"|"comment"|"group"
      → { enabled, price_per_action (creator pays), reward_per_action (user earns), min_qty, max_qty }
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_active_user, require_admin
from feature_flags import is_enabled as feature_enabled


public = APIRouter(prefix="/api", tags=["special_tasks"])
admin = APIRouter(prefix="/api/admin", tags=["special_tasks_admin"], dependencies=[Depends(require_admin)])


ACTION_TYPES = ["video", "subscribe", "share", "like", "comment", "group"]
NETWORKS_STANDARD = ["tiktok", "facebook", "instagram", "youtube"]
NETWORKS_GROUP = ["whatsapp", "telegram"]


class TaskCreate(BaseModel):
    action_type: str = Field(..., pattern="^(video|subscribe|share|like|comment|group)$")
    network: str = Field(..., pattern="^(tiktok|facebook|instagram|youtube|whatsapp|telegram)$")
    link: str = Field(..., min_length=5, max_length=500)
    description: str = Field(default="", max_length=500)


class TaskAudience(BaseModel):
    target_countries: List[str] = Field(..., min_length=1)
    target_age_min: int = Field(..., ge=13, le=99)
    target_age_max: int = Field(..., ge=13, le=99)
    target_gender: str = Field(..., pattern="^(male|female|both)$")


class TaskQuantity(BaseModel):
    quantity: int = Field(..., ge=1)


class TaskComplete(BaseModel):
    proof_url: str = Field(..., min_length=5, max_length=500,
                           description="URL of the screenshot uploaded via /api/user/uploads")


class ActionTypeConfig(BaseModel):
    """Admin config for a single action type.

    The admin can supply EITHER `price_per_action` (canonical, matches the
    new UX: "quel coût pour une vue ?") OR the legacy `reward_per_action`
    (what the user earns). The server derives whichever is missing from
    the global distribution_percentage.
    """
    enabled: bool = True
    price_per_action: float | None = Field(default=None, ge=0)   # creator's cost
    reward_per_action: float | None = Field(default=None, ge=0)  # user's earning
    min_qty: int = Field(default=10, ge=1)
    max_qty: int = Field(default=10000, ge=1)


class ConfigUpdate(BaseModel):
    action_types: dict
    # % of what the creator pays that is distributed to workers.
    # (100 - this) stays with the platform. Range: 1..100.
    distribution_percentage: float = Field(default=70.0, ge=1, le=100)
    # `platform_percentage` is derived (100 - distribution_percentage) but we
    # accept it as an optional input for admin-UI convenience — if both are
    # sent and they don't sum to 100 we favour `distribution_percentage`.
    platform_percentage: float | None = Field(default=None, ge=0, le=99)


def _serialize(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    for k in ("created_at", "updated_at", "payment_confirmed_at", "activated_at", "completed_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.astimezone(timezone.utc).isoformat()
    return out


async def _get_config(db) -> dict:
    doc = await db.special_tasks_config.find_one({"key": "singleton"}) or {}
    pct = float(doc.get("distribution_percentage") or 70.0)
    platform_pct = round(100.0 - pct, 2)
    action_types = doc.get("action_types") or {}
    enriched = {}
    for at, cfg in action_types.items():
        # Support both legacy (`reward_per_action`) and new (`price_per_action`)
        # inputs. Whichever is present drives the computation of the other,
        # driven by the global distribution %.
        price = cfg.get("price_per_action")
        reward = cfg.get("reward_per_action")
        try:
            price = float(price) if price is not None else None
            reward = float(reward) if reward is not None else None
        except Exception:
            price, reward = None, None
        if price is not None and price > 0:
            derived_reward = round(price * pct / 100.0, 2)
        elif reward is not None and reward > 0 and pct > 0:
            price = round(reward / (pct / 100.0), 2)
            derived_reward = reward
        else:
            price = 0.0
            derived_reward = 0.0
        enriched[at] = {
            **cfg,
            "price_per_action": price,
            "reward_per_action": derived_reward,
        }
    return {
        "action_types": enriched,
        "distribution_percentage": pct,
        "platform_percentage": platform_pct,
        "configured": bool(action_types),
    }


async def _get_task(db, task_id: str, user_id: Optional[str] = None) -> dict:
    q: dict = {"id": task_id}
    if user_id:
        q["user_id"] = user_id
    t = await db.special_tasks.find_one(q)
    if not t:
        raise HTTPException(404, "Tâche introuvable.")
    return t


# ---------- ADMIN ----------
@admin.get("/special-tasks/config")
async def admin_get_config(request: Request):
    return await _get_config(request.app.state.db)


@admin.put("/special-tasks/config")
async def admin_set_config(data: ConfigUpdate, request: Request):
    # Validate each action_type entry — only iterate through action types
    # actually present in the payload (avoids failing on omitted entries).
    normalised: dict = {}
    provided = data.action_types or {}
    for at in ACTION_TYPES:
        if at not in provided:
            continue
        raw = provided.get(at) or {}
        try:
            cfg = ActionTypeConfig(**raw)
        except Exception:
            continue
        if cfg.max_qty < cfg.min_qty:
            raise HTTPException(400, f"max_qty < min_qty pour {at}")
        if cfg.enabled and not ((cfg.price_per_action or 0) > 0 or (cfg.reward_per_action or 0) > 0):
            raise HTTPException(400, f"Prix ou récompense manquant pour {at}")
        normalised[at] = cfg.model_dump(exclude_none=False)
    if not normalised:
        raise HTTPException(400, "Aucun type d'action valide fourni.")
    db = request.app.state.db
    await db.special_tasks_config.update_one(
        {"key": "singleton"},
        {"$set": {
            "key": "singleton",
            "action_types": normalised,
            "distribution_percentage": float(data.distribution_percentage),
            "updated_at": datetime.now(timezone.utc),
        }},
        upsert=True,
    )
    return await _get_config(db)


@admin.get("/special-tasks")
async def admin_list_tasks(request: Request, status: Optional[str] = None):
    db = request.app.state.db
    q: dict = {}
    if status:
        q["status"] = status
    items = []
    async for t in db.special_tasks.find(q).sort("created_at", -1).limit(500):
        items.append(_serialize(t))
    return {"items": items}


@admin.get("/special-tasks/{task_id}/completions")
async def admin_list_completions(task_id: str, request: Request):
    """List all completions (with proof screenshots) for a given task — admin audit."""
    db = request.app.state.db
    items = []
    async for c in db.special_task_completions.find({"task_id": task_id}).sort("at", -1):
        items.append(_serialize(c))
    return {"items": items}


# ---------- USER — config + create ----------
@public.get("/special-tasks/config")
async def user_get_config(request: Request, user=Depends(get_current_user)):
    return await _get_config(request.app.state.db)


@public.post("/special-tasks")
async def create_task(data: TaskCreate, request: Request, user=Depends(require_active_user)):
    db = request.app.state.db
    if not await feature_enabled(db, "special_tasks"):
        raise HTTPException(503, "Création de tâches spéciales momentanément désactivée par l'administrateur.")
    cfg = await _get_config(db)
    action_cfg = (cfg["action_types"] or {}).get(data.action_type)
    if not action_cfg or not action_cfg.get("enabled"):
        raise HTTPException(400, "Ce type de tâche n'est pas disponible pour le moment.")
    distribution_pct = float(cfg.get("distribution_percentage") or 70.0)
    reward = float(action_cfg.get("reward_per_action") or 0)
    price_per_action = float(action_cfg.get("price_per_action") or 0)
    if price_per_action <= 0 or reward <= 0:
        raise HTTPException(400, "Ce type de tâche n'est pas correctement configuré.")
    # Network compatibility
    if data.action_type == "group" and data.network not in NETWORKS_GROUP:
        raise HTTPException(400, "Ce réseau n'accepte pas ce type de tâche.")
    if data.action_type != "group" and data.network not in NETWORKS_STANDARD:
        raise HTTPException(400, "Ce réseau n'accepte pas ce type de tâche.")

    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "action_type": data.action_type,
        "network": data.network,
        "link": data.link,
        "description": data.description,
        "target_countries": [],
        "target_age_min": None,
        "target_age_max": None,
        "target_gender": None,
        "quantity_target": 0,
        "quantity_completed": 0,
        "price_amount": 0.0,
        "reward_per_action": reward,
        "price_per_action": price_per_action,
        "distribution_percentage": distribution_pct,
        "min_qty": int(action_cfg.get("min_qty") or 1),
        "max_qty": int(action_cfg.get("max_qty") or 10000),
        "currency": "FCFA",
        "status": "draft",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    await db.special_tasks.insert_one(doc)
    return _serialize(doc)


@public.put("/special-tasks/{task_id}/audience")
async def set_audience(task_id: str, data: TaskAudience, request: Request, user=Depends(get_current_user)):
    if data.target_age_max < data.target_age_min:
        raise HTTPException(400, "Âge max < min.")
    db = request.app.state.db
    t = await _get_task(db, task_id, user["id"])
    if t["status"] != "draft":
        raise HTTPException(400, "Tâche non modifiable.")
    await db.special_tasks.update_one(
        {"id": task_id},
        {"$set": {
            "target_countries": [c.upper() for c in data.target_countries],
            "target_age_min": data.target_age_min,
            "target_age_max": data.target_age_max,
            "target_gender": data.target_gender,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    return _serialize(await db.special_tasks.find_one({"id": task_id}))


@public.put("/special-tasks/{task_id}/quantity")
async def set_quantity(task_id: str, data: TaskQuantity, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    t = await _get_task(db, task_id, user["id"])
    if t["status"] != "draft":
        raise HTTPException(400, "Tâche non modifiable.")
    if data.quantity < t["min_qty"] or data.quantity > t["max_qty"]:
        raise HTTPException(400, f"Quantité hors bornes ({t['min_qty']}–{t['max_qty']}).")
    # ── Two-step calculation, as specified in the SPILOVEURE spec: ──
    #
    # Step 1 (COST) — the price_per_action is used ONLY to compute what
    # the creator will pay. Nothing else.
    #     total_price = price_per_action × quantity
    #
    # Step 2 (REWARD) — once paid, the platform applies the admin's
    # income-split configuration to the ACTUAL amount received, then
    # divides the participants' share by the number of requested actions.
    #     distributable_pool = total_price × distribution_percentage / 100
    #     reward_per_user    = distributable_pool / quantity
    #
    # Mathematically equivalent to `price_per_action × dist_pct/100`, but
    # implementing it this way makes the money flow explicit and matches
    # the mental model in the product spec (creator pays a lump sum → the
    # platform takes its cut → the remainder is shared equally between
    # actual participants).
    price = float(t["price_per_action"]) * int(data.quantity)
    dist_pct = float(t.get("distribution_percentage") or 0)
    distributable_pool = round(price * dist_pct / 100.0, 2)
    reward_per_user = round(distributable_pool / int(data.quantity), 2) if data.quantity > 0 else 0.0
    await db.special_tasks.update_one(
        {"id": task_id},
        {"$set": {
            "quantity_target": data.quantity,
            "price_amount": price,
            "distributable_pool": distributable_pool,
            # Overwrite the stored reward_per_action with the value
            # actually derived from the paid amount — this is what
            # /complete will credit to each participant.
            "reward_per_action": reward_per_user,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    return _serialize(await db.special_tasks.find_one({"id": task_id}))


@admin.post("/special-tasks/{task_id}/force-activate")
async def admin_force_activate_task(task_id: str, request: Request):
    """Admin override — flip a `pending_payment` task to `active` without
    a real payment (useful for tests + manual reconciliation)."""
    db = request.app.state.db
    r = await db.special_tasks.update_one(
        {"id": task_id, "status": "pending_payment"},
        {"$set": {"status": "active",
                  "payment_confirmed_at": datetime.now(timezone.utc),
                  "activated_at": datetime.now(timezone.utc),
                  "updated_at": datetime.now(timezone.utc)}},
    )
    if r.modified_count == 0:
        raise HTTPException(400, "Tâche introuvable ou déjà activée.")
    await notify_new_special_task(db, task_id)
    return _serialize(await db.special_tasks.find_one({"id": task_id}))


@admin.delete("/special-tasks/{task_id}")
async def admin_delete_task(task_id: str, request: Request):
    """Permanently delete a special task, regardless of its status.

    Deletes the task doc AND its completion audit records so the campaign
    disappears cleanly from every admin view. Reward payouts already
    credited to workers are NOT reversed — that would break trust.
    """
    db = request.app.state.db
    t = await db.special_tasks.find_one({"id": task_id})
    if not t:
        raise HTTPException(404, "Tâche introuvable.")
    await db.special_tasks.delete_one({"id": task_id})
    await db.special_task_completions.delete_many({"task_id": task_id})
    return {"ok": True, "deleted": task_id}


@public.post("/special-tasks/{task_id}/publish")
async def publish_task(task_id: str, request: Request, user=Depends(require_active_user)):
    """Mark task ready for payment. Next step: /special-tasks/{id}/pay."""
    db = request.app.state.db
    t = await _get_task(db, task_id, user["id"])
    if t["status"] != "draft":
        raise HTTPException(400, "Statut invalide.")
    missing = [k for k in ("target_countries", "quantity_target") if not t.get(k)]
    if missing:
        raise HTTPException(400, f"Champs manquants : {missing}")
    await db.special_tasks.update_one(
        {"id": task_id, "status": "draft"},
        {"$set": {"status": "pending_payment", "updated_at": datetime.now(timezone.utc)}},
    )
    return _serialize(await db.special_tasks.find_one({"id": task_id}))


class TaskPayIn(BaseModel):
    method: str = Field(default="mobile_money")  # "mobile_money" | "crypto"
    country_code: Optional[str] = None
    operator: Optional[str] = None
    phone: Optional[str] = None


@public.post("/special-tasks/{task_id}/pay")
async def pay_task(task_id: str, data: TaskPayIn, request: Request, user=Depends(get_current_user)):
    """Kick off payment for a special task — Mobile Money (Ashtech) OR
    Crypto USDT (IziChangePay). The task moves to `active` only when the
    corresponding webhook fires.
    """
    db = request.app.state.db
    t = await _get_task(db, task_id, user["id"])
    if t["status"] != "pending_payment":
        raise HTTPException(400, "Cette tâche n'est pas en attente de paiement.")
    amount = float(t.get("price_amount") or 0)
    if amount <= 0:
        raise HTTPException(400, "Montant à payer invalide.")

    method = (data.method or "mobile_money").lower()

    # ── Mobile Money via Ashtech ──────────────────────────────────────
    if method == "mobile_money":
        if not data.country_code or not data.operator or not data.phone:
            raise HTTPException(400, "country_code, operator et phone sont requis.")
        from ashtec_activation import create_ashtec_payment
        result = await create_ashtec_payment(
            db=db, user=user, kind="special_task", amount=amount,
            country_code=data.country_code, operator=data.operator, phone=data.phone,
            extra_row={"special_task_id": task_id},
        )
        await db.special_tasks.update_one(
            {"id": task_id},
            {"$set": {"payment_reference": result["reference"],
                      "payment_method": "mobile_money",
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"method": "mobile_money", **result}

    # ── Crypto USDT via IziChangePay ──────────────────────────────────
    if method == "crypto":
        import izichange
        reference = f"TSK-{task_id[:8]}-{uuid.uuid4().hex[:8]}"
        amount_usdt = round(amount / izichange.USDT_XOF_RATE, 6)
        resp = await izichange._api_post("/v1/payment-intents", {
            "requestedCurrencyType": "crypto",
            "currencyRequested": izichange.ASSET_CODE,
            "amountRequested": f"{amount_usdt:g}",
            "acceptedCoins": [izichange.ASSET_CODE],
            "merchantReference": reference,
            "customerEmail": user.get("email"),
            "metadata": {"kind": "special_task", "special_task_id": task_id, "user_id": user["id"]},
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
            "user_id": user["id"], "kind": "special_task",
            "special_task_id": task_id, "amount": amount, "currency": "XOF",
            "usdt_amount": amount_usdt, "usdt_rate": izichange.USDT_XOF_RATE,
            "deposit_address": deposit_address,
            "amount_to_send": sel.get("amountToSend") or amount_usdt,
            "network": "BEP20", "status": "pending", "activation_done": False,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })
        await db.special_tasks.update_one(
            {"id": task_id},
            {"$set": {"payment_reference": reference, "payment_method": "crypto",
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"method": "crypto", "reference": reference,
                "deposit_address": deposit_address,
                "amount_to_send": sel.get("amountToSend") or amount_usdt,
                "coin": "USDT", "network": "BEP20",
                "xof_amount": amount, "usdt_amount": amount_usdt,
                "usdt_rate": izichange.USDT_XOF_RATE}

    raise HTTPException(400, "Méthode non supportée.")


# ---------- FEED + completion ----------
@public.get("/special-tasks")
async def user_feed(request: Request, user=Depends(get_current_user)):
    """Active tasks the current user can still complete (hasn't already done).

    v27o (2026-02-20) — no country/age/gender filter is applied by design:
    every activated user, regardless of their country/age/gender, can see
    and complete any active special task (the campaign owner picks the
    audience only for their own record; the reward is paid the same way).
    A task disappears from a user's feed ONLY when:
      • its status ≠ active
      • the user IS the campaign creator (can't earn from own campaign)
      • the user has ALREADY submitted a completion (status ≠ rejected)
    """
    import logging as _log
    _slog = _log.getLogger("special_tasks")
    db = request.app.state.db
    if not await feature_enabled(db, "special_tasks"):
        _slog.info("special-tasks feed: feature flag OFF for user=%s", user.get("id"))
        return {"items": []}
    completed = await db.special_task_completions.distinct(
        "task_id", {"user_id": user["id"], "status": {"$ne": "rejected"}},
    )
    u = await db.users.find_one({"id": user["id"]}, {"last_special_tasks_seen_at": 1}) or {}
    seen_at = u.get("last_special_tasks_seen_at")
    now = datetime.now(timezone.utc)
    items = []
    async for t in db.special_tasks.find({
        "status": "active",
        "user_id": {"$ne": user["id"]},          # can't earn from your own campaign
        "id": {"$nin": completed},
    }).sort("created_at", -1).limit(200):
        activated = t.get("activated_at") or t.get("payment_confirmed_at") or t.get("created_at")
        is_new = False
        try:
            if activated:
                if seen_at and activated > seen_at:
                    is_new = True
                if (now - activated).total_seconds() <= 24 * 3600:
                    is_new = True
        except Exception:
            pass
        s = _serialize(t)
        s["is_new"] = is_new
        items.append(s)
    _slog.info("special-tasks feed: user=%s completed=%d items=%d",
               user.get("id"), len(completed), len(items))
    return {"items": items}


@public.get("/special-tasks/mine")
async def my_tasks(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = []
    async for t in db.special_tasks.find({"user_id": user["id"]}).sort("created_at", -1):
        items.append(_serialize(t))
    return {"items": items}


@public.get("/special-tasks/{task_id}/completions")
async def owner_list_completions(task_id: str, request: Request, user=Depends(get_current_user)):
    """Campaign creator can see the screenshots submitted for their own task."""
    db = request.app.state.db
    t = await db.special_tasks.find_one({"id": task_id})
    if not t:
        raise HTTPException(404, "Tâche introuvable.")
    if t["user_id"] != user["id"]:
        raise HTTPException(403, "Accès refusé.")
    items = []
    async for c in db.special_task_completions.find({"task_id": task_id}).sort("at", -1):
        items.append(_serialize(c))
    return {"items": items}


@public.post("/special-tasks/{task_id}/complete")
async def complete_task(task_id: str, data: TaskComplete, request: Request, user=Depends(get_current_user)):
    """Credit reward atomically. Requires a screenshot proof URL. Prevents
    double-claim via unique completion record. Auto-closes the campaign when
    quantity_target is reached.

    Runs an AI vision check on the screenshot first (Gemini 3 Flash via
    Emergent LLM Key). Behaviour:
        * `verified=True` and `confidence >= 0.7`  → auto-approve, credit
        * otherwise                                → auto-reject with reason
    Verification failures never crash the flow: on infra outage the
    verifier soft-approves and the completion is stored for admin audit.
    """
    db = request.app.state.db
    t = await db.special_tasks.find_one({"id": task_id})
    if not t:
        raise HTTPException(404, "Tâche introuvable.")
    if t["status"] != "active":
        raise HTTPException(400, "Cette tâche n'est plus disponible.")
    if t["user_id"] == user["id"]:
        raise HTTPException(400, "Vous ne pouvez pas gagner sur votre propre campagne.")
    existing = await db.special_task_completions.find_one({"task_id": task_id, "user_id": user["id"]})
    if existing:
        raise HTTPException(400, "Vous avez déjà complété cette tâche.")

    # ── AI verification (best-effort, never raises) ──────────────────
    from task_verification import verify_screenshot
    verdict = await verify_screenshot(
        proof_url=data.proof_url,
        action_type=t["action_type"],
        network=t["network"],
        link=t.get("link") or "",
        description=t.get("description") or "",
    )
    ai_verified = bool(verdict.get("verified"))
    ai_conf = float(verdict.get("confidence") or 0.0)
    ai_reason = str(verdict.get("reason") or "")
    APPROVE_THRESHOLD = 0.7

    # Auto-reject when the model is confident the action was NOT done.
    if not ai_verified or ai_conf < APPROVE_THRESHOLD:
        # Store the rejected attempt for admin audit — no slot consumed.
        await db.special_task_completions.insert_one({
            "id": str(uuid.uuid4()),
            "task_id": task_id,
            "user_id": user["id"],
            "username": user.get("username"),
            "reward": 0,
            "proof_url": data.proof_url,
            "status": "rejected",
            "ai_verified": ai_verified,
            "ai_confidence": ai_conf,
            "ai_reason": ai_reason,
            "at": datetime.now(timezone.utc),
        })
        raise HTTPException(400, f"Preuve non conforme : {ai_reason or 'action non détectée.'} Vous pouvez réessayer avec une meilleure capture.")

    # Atomic slot claim — only credit if there's still room.
    now = datetime.now(timezone.utc)
    reward = float(t["reward_per_action"])
    r = await db.special_tasks.update_one(
        {"id": task_id, "status": "active", "$expr": {"$lt": ["$quantity_completed", "$quantity_target"]}},
        {"$inc": {"quantity_completed": 1}, "$set": {"updated_at": now}},
    )
    if r.modified_count == 0:
        raise HTTPException(400, "La campagne est complète.")

    # Insert completion record (with screenshot proof + AI verdict)
    await db.special_task_completions.insert_one({
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "user_id": user["id"],
        "username": user.get("username"),
        "reward": reward,
        "proof_url": data.proof_url,
        "status": "approved",
        "ai_verified": ai_verified,
        "ai_confidence": ai_conf,
        "ai_reason": ai_reason,
        "at": now,
    })
    # Credit user
    await db.users.update_one({"id": user["id"]}, {"$inc": {"balance_profit": reward}})
    # Log a commission entry so it shows up in the transaction history
    await db.commissions.insert_one({
        "user_id": user["id"],
        "from_user_id": t["user_id"],
        "level": None,
        "kind": "special_task_reward",
        "amount": reward,
        "profit_share": reward,
        "upgrade_share": 0,
        "meta": {"task_id": task_id, "action_type": t["action_type"], "network": t["network"]},
        "created_at": now,
    })
    # In-app notification for the worker
    try:
        await db.notifications.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "kind": "special_task_reward",
            "title": f"+{reward:g} FCFA gagnés 🎯",
            "body": f"Vous avez complété une tâche « {t.get('action_type')} » sur {t.get('network')}.",
            "meta": {"task_id": task_id, "amount": reward},
            "read": False,
            "created_at": now,
        })
    except Exception:
        pass
    # Close campaign if reached target
    fresh = await db.special_tasks.find_one({"id": task_id})
    if fresh and fresh["quantity_completed"] >= fresh["quantity_target"]:
        await db.special_tasks.update_one(
            {"id": task_id, "status": "active"},
            {"$set": {"status": "completed", "completed_at": now, "updated_at": now}},
        )
    return {
        "credited": reward,
        "task_status": (await db.special_tasks.find_one({"id": task_id}))["status"],
        "ai": {"verified": ai_verified, "confidence": ai_conf, "reason": ai_reason},
    }


# ---------- "Nouveauté" indicator (badges on the Tasks screen) ----------
@public.get("/special-tasks/unread-count")
async def unread_count(request: Request, user=Depends(get_current_user)):
    """Return the number of active tasks the user has NOT yet seen.

    A task is considered "new" for a given user when its `activated_at`
    (fallback `payment_confirmed_at` / `created_at`) is more recent than
    that user's `last_special_tasks_seen_at`. Own tasks are excluded.
    """
    db = request.app.state.db
    if not await feature_enabled(db, "special_tasks"):
        return {"unread": 0}
    u = await db.users.find_one({"id": user["id"]}, {"last_special_tasks_seen_at": 1}) or {}
    seen = u.get("last_special_tasks_seen_at")
    completed = await db.special_task_completions.distinct(
        "task_id", {"user_id": user["id"], "status": {"$ne": "rejected"}},
    )
    q: dict = {
        "status": "active",
        "user_id": {"$ne": user["id"]},
        "id": {"$nin": completed},
    }
    if seen:
        q["$or"] = [
            {"activated_at": {"$gt": seen}},
            {"$and": [{"activated_at": {"$exists": False}},
                      {"payment_confirmed_at": {"$gt": seen}}]},
        ]
    unread = await db.special_tasks.count_documents(q)
    return {"unread": int(unread)}


class MarkSeenIn(BaseModel):
    at: str | None = None  # ISO — defaults to now server-side


@public.post("/special-tasks/mark-seen")
async def mark_seen(request: Request, user=Depends(get_current_user)):
    """Reset the unread badge for this user."""
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_special_tasks_seen_at": now}},
    )
    return {"ok": True, "at": now.isoformat()}


# ─── Notifications « nouvelle tâche spéciale » ─────────────────────────
_NOTIF_ACTION = {"video": "Regarder une vidéo", "subscribe": "S'abonner", "share": "Partager",
                 "like": "Aimer", "comment": "Commenter", "group": "Rejoindre un groupe"}
_NOTIF_NET = {"tiktok": "TikTok", "facebook": "Facebook", "instagram": "Instagram",
              "youtube": "YouTube", "whatsapp": "WhatsApp", "telegram": "Telegram"}


async def notify_new_special_task(db, task_id: str) -> int:
    """One in-app + push notification per user per task, claimed atomically via `notified_at`."""
    import logging as _l
    now = datetime.now(timezone.utc)
    t = await db.special_tasks.find_one_and_update(
        {"id": task_id, "status": "active", "notified_at": {"$exists": False}},
        {"$set": {"notified_at": now}},
    )
    if not t:
        return 0
    if not await feature_enabled(db, "special_tasks"):
        await db.special_tasks.update_one({"id": task_id}, {"$set": {"notified_skipped": "feature_off"}})
        return 0
    title = "⚡ Nouvelle tâche spéciale disponible"
    body = (f"{_NOTIF_ACTION.get(t.get('action_type'), 'Tâche')} sur {_NOTIF_NET.get(t.get('network'), t.get('network') or '')} "
            f"· {float(t.get('reward_per_action') or 0):g} FCFA à gagner. Touchez pour voir les conditions.")
    link = f"/tasks-more?task={task_id}"
    inserted, docs = 0, []
    async for u in db.users.find({"id": {"$ne": t.get("user_id")}, "status": {"$ne": "banned"}}, {"_id": 0, "id": 1}):
        docs.append({"id": str(uuid.uuid4()), "user_id": u["id"], "kind": "special_task_new",
                     "type": "special_task_new", "title": title, "body": body, "link": link,
                     "meta": {"task_id": task_id}, "read": False, "created_at": now})
        if len(docs) >= 500:
            await db.notifications.insert_many(docs)
            inserted += len(docs)
            docs = []
    if docs:
        await db.notifications.insert_many(docs)
        inserted += len(docs)
    try:
        from push_helper import push_to_all_registered
        await push_to_all_registered(db, title=title, body=body, link=link,
                                     data={"kind": "special_task_new", "task_id": task_id},
                                     tag=f"special-task-{task_id}", exclude_user_id=t.get("user_id"))
    except Exception as e:
        _l.getLogger("special_tasks").exception("special task push failed: %s", e)
    return inserted


async def special_task_notify_watcher(db):
    """Every 20 s, notify each task that became `active` (any payment path) exactly once."""
    import asyncio as _a, logging as _l
    log = _l.getLogger("special_tasks")
    marker = await db.app_settings.find_one({"key": "special_task_notif_backfill"})
    if not marker:
        await db.special_tasks.update_many(
            {"status": "active", "notified_at": {"$exists": False}},
            {"$set": {"notified_at": datetime.now(timezone.utc), "notified_skipped": "backfill"}})
        await db.app_settings.update_one({"key": "special_task_notif_backfill"},
                                         {"$set": {"done_at": datetime.now(timezone.utc)}}, upsert=True)
    while True:
        try:
            async for t in db.special_tasks.find({"status": "active", "notified_at": {"$exists": False}}, {"_id": 0, "id": 1}):
                n = await notify_new_special_task(db, t["id"])
                log.info("special task %s published → %d notifications", t["id"], n)
        except Exception as e:
            log.exception("special_task_notify_watcher error: %s", e)
        await _a.sleep(20)


@public.get("/special-tasks/{task_id}/availability")
async def task_availability(task_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    t = await db.special_tasks.find_one({"id": task_id}, {"_id": 0, "status": 1, "user_id": 1,
                                                          "quantity_completed": 1, "quantity_target": 1})
    if not t or t.get("status") in ("draft", "pending_payment"):
        return {"available": False, "status": "unavailable", "message": "Cette tâche n'existe plus ou n'est plus disponible."}
    done = await db.special_task_completions.find_one({"task_id": task_id, "user_id": user["id"], "status": {"$ne": "rejected"}})
    if done:
        return {"available": False, "status": "done", "message": "Vous avez déjà réalisé cette tâche."}
    if t.get("user_id") == user["id"]:
        return {"available": False, "status": "own", "message": "Il s'agit de votre propre campagne."}
    if t.get("status") == "completed" or (t.get("quantity_completed") or 0) >= (t.get("quantity_target") or 0):
        return {"available": False, "status": "completed", "message": "Toutes les places de cette tâche ont été prises."}
    if t.get("status") != "active":
        return {"available": False, "status": t.get("status"), "message": "Cette tâche a été désactivée."}
    return {"available": True, "status": "active", "message": "Cette tâche est disponible."}
