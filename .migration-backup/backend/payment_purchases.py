"""Shared checkout for paid ads, special tasks, and Jackpot tickets."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user

router = APIRouter(prefix="/api", tags=["payment_purchases"])

PENDING_STATUSES = ["pending", "processing", "unknown", "otp_required"]
RELEASED_ENTRY_STATES = ["failed", "expired", "refund_required", "cancelled"]


class PurchasePaymentIn(BaseModel):
    kind: str = Field(..., pattern="^(ads|special_task|lottery_entry)$")
    target_id: str = Field(..., min_length=1)
    method: str = Field(..., pattern="^(mobile|mobile_money|crypto)$")
    country_code: Optional[str] = None
    operator: Optional[str] = None
    phone: Optional[str] = None
    provider: Optional[str] = None
    otp: Optional[str] = None
    ussd_authorized: bool = False


def _now():
    return datetime.now(timezone.utc)


async def _purchase_target(db, user: dict, kind: str, target_id: str) -> tuple[dict, float]:
    if kind == "ads":
        item = await db.ads.find_one({"id": target_id, "user_id": user["id"]}, {"_id": 0})
        if not item or item.get("status") not in ("draft", "pending_payment"):
            raise HTTPException(404, "Publicité introuvable ou non payable.")
        amount = float(item.get("price_amount") or 0)
    elif kind == "special_task":
        item = await db.special_tasks.find_one({"id": target_id, "user_id": user["id"]}, {"_id": 0})
        if not item or item.get("status") not in ("draft", "pending_payment"):
            raise HTTPException(404, "Tâche spéciale introuvable ou non payable.")
        amount = float(item.get("price_amount") or 0)
    else:
        from lottery import _load_settings
        settings = await _load_settings(db)
        if not settings.get("enabled"):
            raise HTTPException(403, "Le module Jackpot est désactivé.")
        item = await db.lottery_draws.find_one({"id": target_id}, {"_id": 0})
        if not item:
            raise HTTPException(404, "Tirage introuvable.")
        if item.get("status") != "open":
            raise HTTPException(400, "Ce tirage n'accepte plus de participation.")
        amount = float(item.get("entry_amount") or 0)
    if amount <= 0:
        raise HTTPException(400, "Montant à payer invalide.")
    return item, amount


async def _expire_stale_lottery_reservations(db, draw_id: str):
    now = _now()
    cursor = db.lottery_participants.find({
        "draw_id": draw_id, "status": "pending_payment",
        "reservation_expires_at": {"$lte": now},
    }, {"_id": 0, "id": 1, "user_id": 1})
    async for row in cursor:
        updated = await db.lottery_participants.update_one(
            {"id": row["id"], "status": "pending_payment"},
            {"$set": {"status": "expired", "updated_at": now}},
        )
        if updated.modified_count:
            await db.lottery_draws.update_one(
                {"id": draw_id}, {"$inc": {"pending_payment_count": -1}},
            )


async def _reserve_lottery_slot(db, draw: dict, user: dict) -> dict:
    draw_id = draw["id"]
    await _expire_stale_lottery_reservations(db, draw_id)
    existing = await db.lottery_participants.find_one(
        {"draw_id": draw_id, "user_id": user["id"]}, {"_id": 0},
    )
    if existing and existing.get("status") not in RELEASED_ENTRY_STATES:
        raise HTTPException(409, "Une participation ou un paiement est déjà en cours pour ce tirage.")

    # Backfill counters for draws created before provider-paid entries existed.
    if draw.get("participants_count") is None:
        confirmed = await db.lottery_participants.count_documents({
            "draw_id": draw_id,
            "status": {"$nin": ["pending_payment", *RELEASED_ENTRY_STATES]},
        })
        await db.lottery_draws.update_one(
            {"id": draw_id, "participants_count": {"$exists": False}},
            {"$set": {"participants_count": confirmed}},
        )
    if draw.get("pending_payment_count") is None:
        pending = await db.lottery_participants.count_documents(
            {"draw_id": draw_id, "status": "pending_payment"},
        )
        await db.lottery_draws.update_one(
            {"id": draw_id, "pending_payment_count": {"$exists": False}},
            {"$set": {"pending_payment_count": pending}},
        )

    condition: dict = {"id": draw_id, "status": "open"}
    if draw.get("max_participants"):
        condition["$expr"] = {
            "$lt": [
                {"$add": [
                    {"$ifNull": ["$participants_count", 0]},
                    {"$ifNull": ["$pending_payment_count", 0]},
                ]},
                int(draw["max_participants"]),
            ]
        }
    reserved = await db.lottery_draws.update_one(
        condition, {"$inc": {"pending_payment_count": 1}},
    )
    if not reserved.modified_count:
        raise HTTPException(409, "Le nombre maximal de participants est atteint.")

    now = _now()
    reservation = {
        "id": str(uuid.uuid4()), "draw_id": draw_id, "user_id": user["id"],
        "username": user.get("username"), "paid_amount": float(draw.get("entry_amount") or 0),
        "status": "pending_payment", "debited_from": "provider",
        "entered_at": now, "created_at": now,
        "reservation_expires_at": now + timedelta(minutes=20),
    }
    try:
        if existing:
            await db.lottery_participants.update_one(
                {"id": existing["id"], "status": {"$in": RELEASED_ENTRY_STATES}},
                {"$set": reservation},
            )
        else:
            await db.lottery_participants.insert_one(reservation)
    except Exception:
        await db.lottery_draws.update_one(
            {"id": draw_id}, {"$inc": {"pending_payment_count": -1}},
        )
        raise HTTPException(409, "Une participation est déjà en cours.")
    return reservation


async def release_lottery_reservation(db, payment: dict, status: str = "failed"):
    draw_id = payment.get("draw_id")
    if not draw_id:
        return
    ref = payment.get("reference")
    query = {
        "draw_id": draw_id, "user_id": payment.get("user_id"),
        "status": "pending_payment",
    }
    if ref:
        query["$or"] = [
            {"payment_reference": ref},
            {"payment_reference": {"$exists": False}},
            {"payment_reference": None},
        ]
    participant = await db.lottery_participants.find_one(query, {"_id": 0, "id": 1})
    if not participant:
        return
    updated = await db.lottery_participants.update_one(
        {"id": participant["id"], "status": "pending_payment"},
        {"$set": {"status": status, "updated_at": _now()}},
    )
    if updated.modified_count:
        await db.lottery_draws.update_one(
            {"id": draw_id}, {"$inc": {"pending_payment_count": -1}},
        )


async def complete_paid_purchase(db, payment: dict, *, source: str) -> dict:
    """Apply a provider-verified purchase exactly once."""
    kind = payment.get("kind")
    now = _now()
    if kind == "ads":
        ad_id = payment.get("ad_id") or payment.get("target_id")
        await db.ads.update_one(
            {"id": ad_id, "status": "pending_payment"},
            {"$set": {"status": "pending_admin_review",
                      "payment_confirmed_at": now, "updated_at": now}},
        )
        try:
            from telegram_moderation import schedule_submission
            schedule_submission(db, "ads", ad_id)
        except Exception:
            pass
        return {"status": "pending_admin_review", "ad_id": ad_id}

    if kind == "special_task":
        task_id = payment.get("special_task_id") or payment.get("target_id")
        await db.special_tasks.update_one(
            {"id": task_id, "status": "pending_payment"},
            {"$set": {"status": "pending_admin_review",
                      "payment_confirmed_at": now, "updated_at": now}},
        )
        try:
            task = await db.special_tasks.find_one(
                {"id": task_id, "status": "pending_admin_review"}, {"_id": 0},
            )
            if task:
                from telegram_moderation import schedule_submission
                schedule_submission(db, "special_task", task_id)
        except Exception:
            pass
        return {"status": "pending_admin_review", "special_task_id": task_id}

    if kind != "lottery_entry":
        raise HTTPException(400, "Type de paiement non pris en charge.")

    draw_id = payment.get("draw_id") or payment.get("target_id")
    participant = await db.lottery_participants.find_one(
        {"draw_id": draw_id, "user_id": payment.get("user_id"),
         "status": "pending_payment"},
        {"_id": 0},
    )
    if not participant:
        existing = await db.lottery_participants.find_one(
            {"draw_id": draw_id, "user_id": payment.get("user_id"),
             "status": {"$nin": RELEASED_ENTRY_STATES}},
            {"_id": 0},
        )
        if existing:
            return {"status": "paid", "already_registered": True}
        await db.payments.update_one(
            {"reference": payment.get("reference")},
            {"$set": {"status": "refund_required", "manual_refund_required": True,
                      "activation_done": True, "updated_at": now}},
        )
        return {"status": "refund_required", "manual_refund_required": True}

    draw = await db.lottery_draws.find_one({"id": draw_id}, {"_id": 0})
    if not draw or draw.get("status") != "open":
        await db.lottery_participants.update_one(
            {"id": participant["id"], "status": "pending_payment"},
            {"$set": {"status": "refund_required", "updated_at": now}},
        )
        await db.lottery_draws.update_one(
            {"id": draw_id}, {"$inc": {"pending_payment_count": -1}},
        )
        await db.payments.update_one(
            {"reference": payment.get("reference")},
            {"$set": {"status": "refund_required", "manual_refund_required": True,
                      "activation_done": True, "updated_at": now}},
        )
        return {"status": "refund_required", "manual_refund_required": True}

    updated = await db.lottery_participants.update_one(
        {"id": participant["id"], "status": "pending_payment"},
        {"$set": {"status": "joined", "payment_reference": payment.get("reference"),
                  "paid_amount": float(payment.get("base_amount_xof") or draw.get("entry_amount") or 0),
                  "provider": payment.get("provider"), "entered_at": now, "updated_at": now}},
    )
    if updated.modified_count:
        await db.lottery_draws.update_one(
            {"id": draw_id},
            {"$inc": {"pending_payment_count": -1, "participants_count": 1}},
        )
        amount = float(payment.get("base_amount_xof") or draw.get("entry_amount") or 0)
        if amount > 0:
            await db.commissions.create_index("payment_reference", unique=True, sparse=True)
            await db.commissions.update_one(
                {"payment_reference": payment.get("reference")},
                {"$setOnInsert": {
                    "id": str(uuid.uuid4()), "user_id": payment.get("user_id"),
                    "from_user_id": None, "kind": "lottery_entry",
                    "amount": -amount, "profit_share": -amount, "upgrade_share": 0,
                    "level": None,
                    "meta": {"draw_id": draw_id, "draw_name": draw.get("name"),
                             "provider": source},
                    "payment_reference": payment.get("reference"), "created_at": now,
                }},
                upsert=True,
            )
    return {"status": "paid", "draw_id": draw_id, "registered": True}


async def _existing_payment_response(payment: dict) -> dict:
    out = {
        "reference": payment.get("reference"),
        "gateway": payment.get("gateway") or payment.get("provider"),
        "method": payment.get("method") or ("crypto" if payment.get("currency") == "USDT" else "mobile"),
        "status": payment.get("status") or "pending",
        "amount": payment.get("amount"),
        "currency": payment.get("currency"),
        "redirect_url": payment.get("payment_url") or payment.get("redirect_url"),
        "deposit_address": payment.get("deposit_address"),
        "amount_to_send": payment.get("amount_to_send"),
        "asset_code": payment.get("asset_code") or payment.get("coin"),
        "network": payment.get("network"),
        "memo": payment.get("memo"),
        "expires_at": payment.get("expires_at"),
    }
    return out


async def start_purchase(request: Request, user: dict, body: PurchasePaymentIn) -> dict:
    db = request.app.state.db
    kind, target_id = body.kind, body.target_id
    target, amount_xof = await _purchase_target(db, user, kind, target_id)

    target_fields = {"target_id": target_id}
    if kind == "ads":
        target_fields["ad_id"] = target_id
    elif kind == "special_task":
        target_fields["special_task_id"] = target_id
    else:
        target_fields["draw_id"] = target_id
    pending = await db.payments.find_one({
        "user_id": user["id"], "kind": kind,
        "$or": [{key: value} for key, value in target_fields.items()],
        "status": {"$in": PENDING_STATUSES},
        "activation_done": {"$ne": True},
    }, {"_id": 0}, sort=[("created_at", -1)])
    if pending:
        return await _existing_payment_response(pending)

    reservation = None
    if kind == "lottery_entry":
        reservation = await _reserve_lottery_slot(db, target, user)

    try:
        method = "mobile" if body.method == "mobile_money" else body.method
        if method == "mobile":
            country = (body.country_code or "").upper().strip()
            operator = (body.operator or "").strip()
            phone = (body.phone or "").strip()
            if not country or not operator or not phone:
                raise HTTPException(400, "Pays, opérateur et numéro requis.")
            from payment_router import pick_provider, log_decision
            route = await pick_provider(db, kind="payin", country=country, operator=operator)
            await log_decision(db, kind="payin", country=country, operator=operator,
                               result=route, user_id=user["id"])
            gateway = (route or {}).get("provider_id")
            if not gateway:
                raise HTTPException(400, "Aucun prestataire actif et configuré pour ce pays et cet opérateur.")
            if (route or {}).get("mode") == "manual":
                raise HTTPException(409, "Ce prestataire est en mode manuel et ne peut pas lancer ce paiement automatique.")
            extra = {
                "target_id": target_id,
                "ad_id": target_id if kind == "ads" else None,
                "special_task_id": target_id if kind == "special_task" else None,
                "draw_id": target_id if kind == "lottery_entry" else None,
            }
            if gateway == "ashtec":
                from ashtec_activation import create_ashtec_payment
                result = await create_ashtec_payment(
                    db=db, user=user, kind=kind, amount=amount_xof,
                    country_code=country, operator=operator, phone=phone,
                    extra_row=extra,
                )
            elif gateway == "biztranspay":
                from biztranspay import biztranspay_activation, BtpActivationIn
                result = await biztranspay_activation(
                    BtpActivationIn(country_code=country, operator=operator,
                                   phone=phone, otp=body.otp,
                                   ussd_authorized=body.ussd_authorized,
                                   kind=kind, amount_xof=amount_xof,
                                   target_id=target_id),
                    request, user,
                )
            elif gateway == "moneyfusion":
                from moneyfusion import initiate_payin, PayInRequest
                result = await initiate_payin(
                    PayInRequest(country_code=country, phone=phone, kind=kind,
                                 amount_xof=amount_xof, target_id=target_id),
                    request, user,
                )
                if result.get("url") and not result.get("redirect_url"):
                    result["redirect_url"] = result["url"]
            else:
                raise HTTPException(503, "Ce prestataire ne prend pas en charge les paiements Mobile Money.")
        else:
            gateway = (body.provider or "").lower().strip()
            if gateway == "biztranspay_crypto":
                from biztranspay import biztranspay_crypto_create, BtpCryptoCreate
                result = await biztranspay_crypto_create(
                    BtpCryptoCreate(kind=kind, amount_xof=amount_xof,
                                    target_id=target_id),
                    request, user,
                )
                gateway = "biztranspay_crypto"
            elif gateway == "izichange":
                from izichange import create_crypto_charge, CryptoCreate
                result = await create_crypto_charge(
                    CryptoCreate(kind=kind, amount_xof=amount_xof,
                                 target_id=target_id),
                    request, user,
                )
            else:
                raise HTTPException(400, "Choisissez un prestataire crypto disponible.")

        reference = result.get("reference")
        if not reference:
            raise HTTPException(502, "Le prestataire n'a pas retourné de référence de paiement.")
        stored_gateway = "ashtecpay" if gateway == "ashtec" else gateway
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"target_id": target_id, "kind": kind, "gateway": stored_gateway,
                      "method": method, "base_amount_xof": amount_xof,
                      "ad_id": target_id if kind == "ads" else None,
                      "special_task_id": target_id if kind == "special_task" else None,
                      "draw_id": target_id if kind == "lottery_entry" else None,
                      "updated_at": _now()}},
        )
        if kind == "ads":
            await db.ads.update_one(
                {"id": target_id},
                {"$set": {"status": "pending_payment", "payment_reference": reference,
                          "payment_method": method, "updated_at": _now()}},
            )
        elif kind == "special_task":
            await db.special_tasks.update_one(
                {"id": target_id},
                {"$set": {"status": "pending_payment", "payment_reference": reference,
                          "payment_method": method, "updated_at": _now()}},
            )
        elif reservation:
            await db.lottery_participants.update_one(
                {"id": reservation["id"]},
                {"$set": {"payment_reference": reference, "provider": gateway,
                          "updated_at": _now()}},
            )
            if str(result.get("status") or "").lower() in ("failed", "rejected", "expired"):
                await release_lottery_reservation(
                    db, {"draw_id": target_id, "user_id": user["id"], "reference": reference},
                )
        return {
            **result, "reference": reference, "gateway": stored_gateway,
            "method": method, "amount_xof": amount_xof,
            "amount_due": result.get("amount") or amount_xof,
            "currency": result.get("currency") or "XOF",
            "status": result.get("status") or "pending",
        }
    except Exception:
        if reservation:
            linked = await db.payments.find_one({
                "user_id": user["id"], "kind": kind, "target_id": target_id,
                "status": {"$in": PENDING_STATUSES},
            }, {"_id": 0, "reference": 1})
            if not linked:
                await release_lottery_reservation(
                    db, {"draw_id": target_id, "user_id": user["id"]},
                )
        raise


@router.post("/payments/purchase")
async def create_purchase_payment(
    body: PurchasePaymentIn, request: Request,
    user=Depends(get_current_user),
):
    return await start_purchase(request, user, body)
