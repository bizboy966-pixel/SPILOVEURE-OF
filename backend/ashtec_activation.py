"""AshtecPay AUTO-ACTIVATION flow — dedicated endpoints for the 2500 FCFA
Level-1 activation with strict 10-minute countdown.

Distinct from the generic dispatcher in `server.py` — the UI is XOF/XAF only
(Guinea GNF and DR Congo CDF are intentionally excluded per product spec),
the amount is locked at 2500, and expiration is enforced on read and via
webhook.
"""
from __future__ import annotations
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import ashtecpay
from matrix import activate_level
from auth import get_current_user  # type: ignore

log = logging.getLogger("ashtec_activation")

api = APIRouter(prefix="/api", tags=["ashtec-auto"])
webhook = APIRouter(prefix="/api/webhooks", tags=["ashtec-webhook"])

# Locked activation params (product decision)
ACTIVATION_AMOUNT: float = 2500.0
ACTIVATION_LEVEL: int = 1
COUNTDOWN_MINUTES: int = 10

# XOF/XAF countries + operator catalog per Ashtech Pay Direct v1 doc.
# Guinea (GNF) and DR Congo (CDF) are excluded per product spec.
COUNTRIES: dict[str, dict] = {
    "BJ": {"name": "Bénin",         "currency": "XOF",
           "operators": ["Moov Money", "MTN Mobile Money"]},
    "BF": {"name": "Burkina Faso",  "currency": "XOF",
           "operators": ["Moov Money", "Orange Money"]},
    "CM": {"name": "Cameroun",      "currency": "XAF",
           "operators": ["MTN Mobile Money", "Orange Money"]},
    "CF": {"name": "Centrafrique",  "currency": "XAF",
           "operators": ["Orange Money"]},
    "CG": {"name": "Congo",         "currency": "XAF",
           "operators": ["Airtel Money", "MTN Mobile Money"]},
    "CI": {"name": "Côte d'Ivoire", "currency": "XOF",
           "operators": ["Moov Money", "MTN Mobile Money", "Orange Money", "Wave"]},
    "GA": {"name": "Gabon",         "currency": "XAF",
           "operators": ["Airtel Money", "Moov Money"]},
    "GQ": {"name": "Guinée équatoriale", "currency": "XAF",
           "operators": ["Orange Money"]},
    "GW": {"name": "Guinée-Bissau", "currency": "XOF",
           "operators": ["Orange Money"]},
    "ML": {"name": "Mali",          "currency": "XOF",
           "operators": ["Moov Money", "Orange Money"]},
    "NE": {"name": "Niger",         "currency": "XOF",
           "operators": ["Airtel Money"]},
    "SN": {"name": "Sénégal",       "currency": "XOF",
           "operators": ["Free Money", "Orange Money", "Wave"]},
    "TD": {"name": "Tchad",         "currency": "XAF",
           "operators": ["Airtel Money", "Moov Money"]},
    "TG": {"name": "Togo",          "currency": "XOF",
           "operators": ["Flooz", "T-Money"]},
}


def _new_ref() -> str:
    import uuid as _uuid
    return f"SPV-AT-{_uuid.uuid4().hex[:12].upper()}"


async def _get_api_key(db) -> str:
    cfg = await db.app_settings.find_one({"_id": "payment_gateway"}) or {}
    return (cfg.get("ashtec_api_key") or "").strip()


@api.get("/payments/ashtec/catalog")
async def ashtec_catalog():
    """Public catalog — country + operator list for the UI selectors."""
    countries = [
        {"code": code, "name": info["name"], "currency": info["currency"],
         "operators": info["operators"]}
        for code, info in COUNTRIES.items()
    ]
    countries.sort(key=lambda c: c["name"])
    return {
        "amount": ACTIVATION_AMOUNT,
        "level": ACTIVATION_LEVEL,
        "countdown_minutes": COUNTDOWN_MINUTES,
        "countries": countries,
    }


# ─── Shared helper (usable by ads.py + special_tasks.py) ────────────────
def validate_country_operator(cc: str, operator: str) -> dict:
    """Raise HTTPException on bad country/operator, return country info."""
    info = COUNTRIES.get(cc.upper())
    if not info:
        raise HTTPException(400, f"Pays {cc} non disponible.")
    if operator not in info["operators"]:
        raise HTTPException(400, f"Opérateur '{operator}' invalide pour {cc}.")
    return info


async def create_ashtec_payment(
    *, db, user, kind: str, amount: float, country_code: str,
    operator: str, phone: str, extra_row: dict | None = None,
) -> dict:
    """Create a payments row + call Ashtech /v1/collect. Returns a dict
    suitable to return to the frontend (reference, status, expires_at, ...).

    Used by:
    - Activation (Level 1) — kind='activation'
    - Ads          — kind='ads' (extra_row must contain ad_id)
    - Special task — kind='special_task' (extra_row must contain special_task_id)
    """
    api_key = await _get_api_key(db)
    if not api_key:
        raise HTTPException(503, "AshtecPay non configuré (clé API manquante).")
    cc = country_code.upper()
    info = validate_country_operator(cc, operator)

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=COUNTDOWN_MINUTES)
    ref = _new_ref()
    notify_url = os.environ.get("ASHTECPAY_WEBHOOK_URL") \
        or "https://spiloveure.com/api/webhooks/ashtec"

    row = {
        "reference": ref,
        "provider": "ashtecpay",
        "kind": kind,
        "user_id": user["id"],
        "username": user.get("username"),
        "amount": float(amount),
        "currency": info["currency"],
        "phone": phone.strip(),
        "country_code": cc,
        "operator": operator,
        "status": "pending",
        "activation_done": False,
        "created_at": now,
        "expires_at": expires_at,
        "updated_at": now,
    }
    if extra_row:
        row.update(extra_row)
    await db.payments.insert_one(row)

    resp = await ashtecpay.initiate_payment(
        api_key=api_key,
        amount=float(amount),
        currency=info["currency"],
        phone=phone.strip(),
        operator=operator,
        country_code=cc,
        reference=ref,
        notify_url=notify_url,
    )

    if not resp.get("success") and resp.get("error") == "otp_required":
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "otp_required",
                      "ashtecpay_ussd_code": resp.get("ussd_code"),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {
            "reference": ref, "status": "otp_required",
            "amount": float(amount), "currency": info["currency"],
            "operator": operator, "country_code": cc,
            "expires_at": expires_at.isoformat(),
            "ussd_code": resp.get("ussd_code"),
            "message": resp.get("message")
                or "Un code OTP a été envoyé sur votre téléphone.",
        }

    if not resp.get("success"):
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "failed",
                      "activation_error": resp.get("message") or "Échec initiation",
                      "ashtecpay_response": resp,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(400, resp.get("message") or "AshtecPay a refusé la requête.")

    txid = resp.get("transaction_id")
    await db.payments.update_one(
        {"reference": ref},
        {"$set": {"transaction_id": txid,
                  "ashtecpay_status": resp.get("status"),
                  "ashtecpay_flow": resp.get("flow"),
                  "ashtecpay_wave_url": resp.get("wave_url"),
                  "updated_at": datetime.now(timezone.utc)}},
    )
    return {
        "reference": ref, "transaction_id": txid,
        "status": "pending",
        "amount": float(amount), "currency": info["currency"],
        "operator": operator, "country_code": cc,
        "expires_at": expires_at.isoformat(),
        "flow": resp.get("flow"), "wave_url": resp.get("wave_url"),
        "message": resp.get("message")
            or "Confirmez le paiement sur votre téléphone.",
    }
# ────────────────────────────────────────────────────────────────────────


class AshtecInitiateIn(BaseModel):
    country_code: str = Field(..., min_length=2, max_length=2)
    operator: str = Field(..., min_length=1)
    phone: str = Field(..., min_length=6)


@api.post("/payments/ashtec/initiate")
async def ashtec_initiate(
    data: AshtecInitiateIn, request: Request, user=Depends(get_current_user),
):
    """Kick off the 2500 FCFA Level-1 auto-activation."""
    db = request.app.state.db
    if int(user.get("max_level") or 0) >= ACTIVATION_LEVEL:
        raise HTTPException(400, "Votre compte est déjà activé.")
    return await create_ashtec_payment(
        db=db, user=user, kind="activation",
        amount=ACTIVATION_AMOUNT,
        country_code=data.country_code, operator=data.operator, phone=data.phone,
        extra_row={"level": ACTIVATION_LEVEL},
    )


class AshtecOtpIn(BaseModel):
    reference: str
    otp: str = Field(..., min_length=1)


@api.post("/payments/ashtec/otp")
async def ashtec_submit_otp(
    data: AshtecOtpIn, request: Request, user=Depends(get_current_user),
):
    """Retry /v1/collect with the OTP received by SMS or via USSD."""
    db = request.app.state.db
    api_key = await _get_api_key(db)
    if not api_key:
        raise HTTPException(503, "AshtecPay non configuré.")
    p = await db.payments.find_one({"reference": data.reference}, {"_id": 0})
    if not p or p.get("user_id") != user.get("id"):
        raise HTTPException(404, "Paiement introuvable")
    if p.get("status") not in ("pending", "otp_required"):
        raise HTTPException(400, f"Statut inattendu: {p.get('status')}")
    if _is_expired(p):
        await _mark_expired(db, data.reference)
        raise HTTPException(400, "Délai de 10 minutes dépassé — recommencez.")

    resp = await ashtecpay.initiate_payment(
        api_key=api_key,
        amount=float(p["amount"]),
        currency=p["currency"],
        phone=p["phone"],
        operator=p["operator"],
        country_code=p["country_code"],
        reference=data.reference,
        otp=data.otp.strip(),
    )
    if not resp.get("success"):
        return {
            "status": "otp_error",
            "error": resp.get("error"),
            "message": resp.get("message") or "Code OTP invalide ou expiré.",
        }
    txid = resp.get("transaction_id")
    await db.payments.update_one(
        {"reference": data.reference},
        {"$set": {"transaction_id": txid,
                  "status": "pending",
                  "ashtecpay_status": resp.get("status"),
                  "updated_at": datetime.now(timezone.utc)},
         "$unset": {"ashtecpay_ussd_code": ""}},
    )
    return {"status": "pending", "transaction_id": txid,
            "message": "OTP validé. En attente de confirmation opérateur."}


def _is_expired(p: dict) -> bool:
    exp = p.get("expires_at")
    if not exp:
        return False
    if isinstance(exp, str):
        try:
            exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        except Exception:
            return False
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= exp


async def _mark_expired(db, ref: str):
    await db.payments.update_one(
        {"reference": ref, "status": {"$in": ["pending", "otp_required"]}},
        {"$set": {"status": "failed",
                  "activation_error": "Délai de 10 minutes dépassé",
                  "expired": True,
                  "updated_at": datetime.now(timezone.utc)}},
    )


@api.get("/payments/ashtec/status/{reference}")
async def ashtec_status(
    reference: str, request: Request, user=Depends(get_current_user),
):
    """Polling endpoint used by the countdown screen (every ~5s).

    Also enforces the 10-minute deadline server-side (marks the payment
    failed if the countdown elapsed) and reconciles activation state if
    the webhook fired but activation didn't apply for any reason.
    """
    db = request.app.state.db
    p = await db.payments.find_one({"reference": reference}, {"_id": 0})
    if not p or p.get("user_id") != user.get("id"):
        raise HTTPException(404, "Paiement introuvable")

    # Terminal states short-circuit
    if p.get("status") == "paid" and p.get("activation_done"):
        return {"status": "paid", "activation_done": True,
                "level": p.get("level"), "reference": reference}
    if p.get("status") == "failed":
        return {"status": "failed", "reference": reference,
                "error": p.get("activation_error") or "Paiement refusé",
                "expired": bool(p.get("expired"))}

    # Deadline expired → transition to failed
    if _is_expired(p):
        await _mark_expired(db, reference)
        return {"status": "failed", "reference": reference, "expired": True,
                "error": "Délai de 10 minutes dépassé"}

    # Pull live status from Ashtech if we have a transaction_id.
    # Grace window: for the first 30s after `created_at`, skip the remote
    # verify call and just return the DB `pending` state — the Ashtech
    # sandbox/production /v1/transaction endpoint can briefly return a
    # transient "failed" status on freshly-created transactions before the
    # user has had a chance to confirm on their phone, and that would
    # prematurely short-circuit the 10-minute countdown UI.
    api_key = await _get_api_key(db)
    txid = p.get("transaction_id")
    created_at = p.get("created_at")
    if isinstance(created_at, str):
        try:
            created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except Exception:
            created_at = None
    if created_at and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    within_grace = (
        created_at is not None
        and (datetime.now(timezone.utc) - created_at).total_seconds() < 30
    )
    if api_key and txid and not within_grace:
        resp = await ashtecpay.verify_payment(api_key=api_key, transaction_id=txid)
        sp_status = resp.get("status") or ""
        new_status = ashtecpay.normalize_status(sp_status)
        if new_status == "paid" and not p.get("activation_done"):
            await _apply_activation(db, p, sp_status, source="ashtecpay")
            return {"status": "paid", "activation_done": True,
                    "level": p.get("level"), "reference": reference}
        # NOTE: we deliberately DO NOT flip to `failed` based on a
        # verify_payment result. Ashtech's /v1/transaction endpoint can
        # return a transient "failed"/"cancelled" status while the user
        # is still confirming on their phone. Authoritative failure comes
        # only from (a) the 10-minute deadline (handled above) or
        # (b) the webhook receiving `payment.failed`.

    return {
        "status": p.get("status") or "pending",
        "reference": reference,
        "expires_at": (p.get("expires_at").isoformat()
                       if isinstance(p.get("expires_at"), datetime)
                       else p.get("expires_at")),
        "ussd_code": p.get("ashtecpay_ussd_code"),
        "flow": p.get("ashtecpay_flow"),
        "wave_url": p.get("ashtecpay_wave_url"),
    }


async def _apply_payment_success(db, p: dict, sp_status: str, *, source: str):
    """Idempotent payment-success dispatcher — called by both polling and webhook.

    Routes based on `p["kind"]`:
      • activation  → matrix.activate_level(user_id, level)
      • ads         → flip ad status to "pending_admin_review"
      • special_task → flip task status to "active"
    """
    ref = p["reference"]
    kind = p.get("kind") or "activation"

    if kind == "ads":
        try:
            await db.ads.update_one(
                {"id": p.get("ad_id"), "status": {"$ne": "active"}},
                {"$set": {
                    "status": "pending_admin_review",
                    "payment_confirmed_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                }},
            )
            await db.payments.update_one(
                {"reference": ref},
                {"$set": {"status": "paid", "activation_done": True,
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
        except Exception as exc:
            log.exception("ashtec ads confirm failed for ref=%s: %s", ref, exc)
            await db.payments.update_one(
                {"reference": ref},
                {"$set": {"status": "paid",
                          "activation_error": str(exc),
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)}},
            )
        return

    if kind == "special_task":
        try:
            await db.special_tasks.update_one(
                {"id": p.get("special_task_id"), "status": "pending_payment"},
                {"$set": {
                    "status": "active",
                    "payment_confirmed_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                }},
            )
            await db.payments.update_one(
                {"reference": ref},
                {"$set": {"status": "paid", "activation_done": True,
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
        except Exception as exc:
            log.exception("ashtec task confirm failed for ref=%s: %s", ref, exc)
            await db.payments.update_one(
                {"reference": ref},
                {"$set": {"status": "paid",
                          "activation_error": str(exc),
                          "ashtecpay_status": sp_status,
                          "updated_at": datetime.now(timezone.utc)}},
            )
        return

    # Default: activation (Level 1 or upgrade)
    # Guard: if user is already at that level, just reconcile the row.
    u_now = await db.users.find_one({"id": p["user_id"]},
                                    {"_id": 0, "max_level": 1, "status": 1}) or {}
    if int(u_now.get("max_level") or 0) >= int(p.get("level") or 1):
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "paid", "activation_done": True,
                      "ashtecpay_status": sp_status,
                      "updated_at": datetime.now(timezone.utc)},
             "$unset": {"activation_error": ""}},
        )
        return
    try:
        await activate_level(db, p["user_id"], int(p["level"]), source=source)
        await db.users.update_one(
            {"id": p["user_id"], "status": {"$ne": "active"}},
            {"$set": {"status": "active"}},
        )
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "paid", "activation_done": True,
                      "ashtecpay_status": sp_status,
                      "updated_at": datetime.now(timezone.utc)},
             "$unset": {"activation_error": ""}},
        )
    except Exception as exc:
        log.exception("ashtec _apply_payment_success failed for ref=%s: %s", ref, exc)
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "paid",  # payment IS in, but activation code failed
                      "activation_error": str(exc),
                      "ashtecpay_status": sp_status,
                      "updated_at": datetime.now(timezone.utc)}},
        )


# Backward-compat alias
_apply_activation = _apply_payment_success


@webhook.post("/ashtec")
async def ashtec_webhook(request: Request):
    """Public webhook — Ashtech Pay Direct v1 events.

    The doc does NOT specify an HMAC signature scheme, so we authenticate
    by matching the transaction (reference OR transaction_id) against our
    own DB and by re-fetching the live status through the API before
    activating. Idempotent via `db.webhook_events` keyed on transaction_id.
    """
    db = request.app.state.db
    raw = await request.body()
    try:
        body = await request.json()
    except Exception:
        body = {}
    log.info("ashtec webhook received: %s bytes, event=%s ref=%s",
             len(raw), body.get("event"), body.get("reference"))

    # Store raw payload for audit
    await db.webhook_logs.insert_one({
        "gateway": "ashtec",
        "event_type": body.get("event") or "unknown",
        "payload": body,
        "received_at": datetime.now(timezone.utc),
    })

    event = (body.get("event") or "").lower()
    ref = body.get("reference")
    txid = body.get("transaction_id")

    if not ref and not txid:
        return {"ok": True, "ignored": "no_reference_or_txid"}

    # Idempotency: skip if this exact transaction_id already processed
    if txid:
        existing = await db.webhook_events.find_one(
            {"gateway": "ashtec", "transaction_id": txid, "processed": True}
        )
        if existing:
            return {"ok": True, "duplicate": True}

    # Locate our payment row
    query = {"provider": "ashtecpay"}
    if ref:
        query["reference"] = ref
    elif txid:
        query["transaction_id"] = txid
    p = await db.payments.find_one(query, {"_id": 0})
    if not p:
        log.warning("ashtec webhook: unknown payment ref=%s txid=%s", ref, txid)
        return {"ok": True, "ignored": "unknown_payment"}

    # Re-verify status against Ashtech before trusting the webhook
    api_key = await _get_api_key(db)
    live_status: Optional[str] = None
    if api_key and (p.get("transaction_id") or txid):
        resp = await ashtecpay.verify_payment(
            api_key=api_key, transaction_id=(p.get("transaction_id") or txid),
        )
        live_status = resp.get("status") or ""
        norm = ashtecpay.normalize_status(live_status)
    else:
        # Trust the event name as a fallback
        norm = "paid" if event == "payment.completed" else \
               "failed" if event == "payment.failed" else "pending"

    if norm == "paid" and not p.get("activation_done"):
        await _apply_activation(db, p, live_status or event, source="ashtecpay")
    elif norm == "failed":
        await db.payments.update_one(
            {"reference": p["reference"]},
            {"$set": {"status": "failed",
                      "ashtecpay_status": live_status or event,
                      "activation_error": body.get("message") or "Paiement refusé",
                      "updated_at": datetime.now(timezone.utc)}},
        )

    # Mark idempotency
    if txid:
        await db.webhook_events.insert_one({
            "gateway": "ashtec",
            "transaction_id": txid,
            "reference": ref,
            "event": event,
            "processed": True,
            "processed_at": datetime.now(timezone.utc),
        })

    return {"ok": True, "status": norm}
