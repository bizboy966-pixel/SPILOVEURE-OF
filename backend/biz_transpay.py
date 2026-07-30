"""Biz-transPay crypto auto-activation (USDT BEP20) — INLINE deposit address.

Flow (no external redirect — user never leaves SPILIVERE):
  1. User clicks "Payer maintenant" on /(app)/activation-crypto-auto.
  2. Backend POSTs to biz-transppayy.com/api/v1/payments (Bearer secret) → returns
     { id, payment_url:"https://checkout.pay.izichange.com/pay/<publicId>?lang=fr" }.
  3. Backend extracts <publicId> from payment_url, then POSTs to
     api.pay.izichange.com/v1/public/payment-intents/<publicId>/select-crypto
     with { assetCode:"USDT.BEP20", customer:{firstName,lastName,email} } →
     returns { depositAddress:"0x…", amountToSend:"5", amountCryptoExpected:"5", memo }.
  4. Backend persists db.payments (reference=SPLV_CRYPTO_…, deposit_address filled)
     and db.activations (pending), then returns everything inline to the client.
  5. Client renders the address + QR code + amount + Copier button. NO redirect.
  6. User sends USDT.BEP20 from their wallet to the address.
  7. biz-transPay POSTs webhook payment.completed → verify HMAC signature +
     idempotency + amount, then call matrix.activate_level(source="biz_transpay").
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from feature_flags import is_enabled as feature_enabled
from matrix import activate_level

log = logging.getLogger("biz_transpay")

BASE_URL = os.environ.get("BIZ_TRANSPAY_BASE_URL", "https://biz-transppayy.com")
SECRET_KEY = os.environ.get("BIZ_TRANSPAY_SECRET_KEY", "")
WEBHOOK_SECRET = os.environ.get("BIZ_TRANSPAY_WEBHOOK_SECRET", SECRET_KEY)
AMOUNT_USDT = float(os.environ.get("BIZ_TRANSPAY_AMOUNT_USDT", "5"))
# izichange (biz-transPay's downstream partner) exposes the address-selection
# endpoint publicly for the SPA. We call it server-side to keep the whole flow
# inline in SPILIVERE.
IZICHANGE_API = os.environ.get("IZICHANGE_API_BASE", "https://api.pay.izichange.com")
ASSET_CODE = "USDT.BEP20"
_PUBLIC_ID_RE = re.compile(r"/pay/([a-f0-9-]{8,})")

api = APIRouter(prefix="/api", tags=["crypto-auto"])
webhook = APIRouter(prefix="/api", tags=["crypto-auto-webhook"])


class CryptoCreate(BaseModel):
    level: int = 1


@api.post("/activations/crypto-auto/create")
async def create_crypto_charge(data: CryptoCreate, request: Request, user=Depends(get_current_user)):
    """Create a biz-transPay charge for the user's activation. Returns the
    deposit address + amount so the client can render a QR code."""
    db = request.app.state.db
    if not await feature_enabled(db, "crypto_auto"):
        raise HTTPException(503, "Activation automatique (Crypto) momentanément désactivée par l'administrateur.")
    if data.level != 1:
        raise HTTPException(400, "Cette méthode ne supporte que l'activation au niveau 1.")
    if user.get("max_level", 0) >= 1:
        raise HTTPException(400, "Votre compte est déjà activé.")
    if not SECRET_KEY:
        raise HTTPException(500, "Passerelle Crypto non configurée.")

    reference = f"SPLV_CRYPTO_{user['id'][:8]}_{uuid.uuid4().hex[:8]}"
    body = {
        "amount": AMOUNT_USDT,
        "coin": "USDT",
        "reference": reference,
        "customer_email": user.get("email"),
        "accepted_networks": ["BEP20"],
    }
    # ── Step 1: create payment on biz-transPay (Bearer secret).
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{BASE_URL}/api/v1/payments",
                headers={"Authorization": f"Bearer {SECRET_KEY}", "Content-Type": "application/json"},
                json=body,
            )
    except Exception as e:
        log.exception(f"biz-transpay create failed: {e}")
        raise HTTPException(400, "Impossible de contacter la passerelle Crypto. Réessayez dans quelques instants.")
    if r.status_code >= 400:
        log.error(f"biz-transpay {r.status_code}: {r.text[:400]}")
        raise HTTPException(400, "La passerelle Crypto a refusé la demande. Réessayez plus tard.")
    payload = r.json()
    provider_id = payload.get("id")
    payment_url = payload.get("payment_url") or ""
    m = _PUBLIC_ID_RE.search(payment_url)
    if not m:
        log.error(f"biz-transpay create OK but no publicId in payment_url ref={reference} url={payment_url}")
        raise HTTPException(400, "Réponse invalide de la passerelle Crypto. Réessayez.")
    public_id = m.group(1)

    # ── Step 2: select USDT.BEP20 + push customer info → returns the inline
    #           deposit address so the user never leaves SPILIVERE.
    username = user.get("username") or "SPILOVEURE"
    email = user.get("email") or "user@spiloveure.com"
    # izichange requires firstName + lastName; fall back to username/USER.
    first_name = user.get("first_name") or username or "SPILOVEURE"
    last_name = user.get("last_name") or "USER"
    select_body = {
        "assetCode": ASSET_CODE,
        "customer": {
            "firstName": (first_name or "SPILOVEURE")[:32],
            "lastName": (last_name or "USER")[:32],
            "email": email,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            sr = await client.post(
                f"{IZICHANGE_API}/v1/public/payment-intents/{public_id}/select-crypto",
                headers={"Content-Type": "application/json"},
                json=select_body,
            )
    except Exception as e:
        log.exception(f"izichange select-crypto failed: {e}")
        raise HTTPException(400, "Impossible d'obtenir l'adresse de dépôt. Réessayez dans quelques instants.")
    if sr.status_code >= 400:
        log.error(f"izichange select-crypto {sr.status_code}: {sr.text[:400]}")
        raise HTTPException(400, "La passerelle Crypto n'a pas généré l'adresse. Réessayez plus tard.")
    intent = sr.json()
    deposit_address = intent.get("depositAddress")
    amount_to_send = intent.get("amountToSend") or intent.get("amountCryptoExpected") or AMOUNT_USDT
    memo = intent.get("memo")
    expires_at = intent.get("expiresAt")
    if not deposit_address:
        log.error(f"izichange select-crypto returned no depositAddress ref={reference} intent={str(intent)[:400]}")
        raise HTTPException(400, "La passerelle Crypto n'a pas retourné d'adresse. Réessayez plus tard.")
    log.info(f"biz-transpay+izichange OK ref={reference} address={deposit_address[:10]}…")

    # ── Persist a pending payment row so the webhook can reconcile it later
    # and so `activate_level` security guard finds it.
    now = datetime.now(timezone.utc)
    await db.payments.insert_one({
        "reference": reference,
        "provider": "biz_transpay",
        "provider_id": provider_id,
        "izichange_public_id": public_id,
        "user_id": user["id"], "level": 1,
        "status": "pending",
        "amount": AMOUNT_USDT,
        "currency": "USDT",
        "network": "BEP20",
        "deposit_address": deposit_address,
        "amount_to_send": amount_to_send,
        "memo": memo,
        "expires_at": expires_at,
        "created_at": now, "updated_at": now,
    })
    # Also record an activations doc so it appears in the admin panel.
    await db.activations.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "username": user.get("username"),
        "level": 1, "status": "pending", "payment_method": "crypto_auto",
        "reference": reference, "amount": AMOUNT_USDT, "currency": "USDT",
        "created_at": now,
    })

    return {
        "reference": reference,
        "deposit_address": deposit_address,
        "amount_to_send": amount_to_send,
        "coin": "USDT",
        "network": "BEP20",
        "memo": memo,
        "expires_at": expires_at,
    }


def _verify_signature(raw_body: bytes, timestamp: str, signature_header: str) -> bool:
    if not signature_header or not timestamp or not WEBHOOK_SECRET:
        return False
    # Header format: "sha256=<hex>"
    sig = signature_header.split("=", 1)[-1].strip()
    signed_payload = f"{timestamp}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = hmac.new(WEBHOOK_SECRET.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


@webhook.post("/webhooks/biz-transppayy")
async def biz_transpay_webhook(request: Request):
    """Receive payment.completed events from biz-transPay. Verifies signature,
    idempotency, amount + reference then activates the user's L1 account."""
    raw = await request.body()
    ts = request.headers.get("X-BizTransPay-Timestamp", "")
    sig = request.headers.get("X-BizTransPay-Signature", "")
    event_id = request.headers.get("X-BizTransPay-Event-Id", "")
    if not _verify_signature(raw, ts, sig):
        log.warning("biz-transpay webhook signature INVALID")
        raise HTTPException(401, "Invalid signature.")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON payload.")

    event_type = body.get("event_type") or body.get("event") or ""
    payload = body.get("payload") or body
    reference: Optional[str] = payload.get("reference")
    status = (payload.get("status") or "").lower()
    amount_paid = payload.get("amount_paid") or payload.get("amount")

    log.info(f"biz-transpay webhook: type={event_type} ref={reference} status={status} amount={amount_paid}")

    if event_type not in ("payment.completed",) or status not in ("completed", "paid", "success"):
        # We acknowledge other events (created, expired, failed) but only
        # activate on completed/paid.
        if reference:
            await request.app.state.db.payments.update_one(
                {"reference": reference},
                {"$set": {"last_event": event_type, "last_event_status": status,
                          "updated_at": datetime.now(timezone.utc)}},
            )
        return {"ok": True, "ignored": True}

    if not reference:
        raise HTTPException(400, "Missing reference in payload.")

    db = request.app.state.db

    # Idempotency: atomic guard by event_id AND by payment row activation_done flag.
    if event_id:
        seen = await db.webhook_events.find_one({"event_id": event_id, "source": "biz_transpay"})
        if seen:
            return {"ok": True, "duplicate": True}
        await db.webhook_events.insert_one({
            "source": "biz_transpay", "event_id": event_id,
            "received_at": datetime.now(timezone.utc),
        })

    pay = await db.payments.find_one({"reference": reference})
    if not pay:
        log.error(f"biz-transpay webhook — unknown reference {reference}")
        raise HTTPException(404, "Unknown reference.")
    if pay.get("activation_done"):
        return {"ok": True, "already_activated": True}

    # Amount safety — reject if user under-paid.
    expected = float(pay.get("amount") or AMOUNT_USDT)
    if amount_paid is not None:
        try:
            if float(amount_paid) + 1e-6 < expected:
                log.error(f"biz-transpay underpayment: ref={reference} paid={amount_paid} expected={expected}")
                await db.payments.update_one(
                    {"reference": reference},
                    {"$set": {"status": "underpaid", "updated_at": datetime.now(timezone.utc)}},
                )
                return {"ok": False, "reason": "underpaid"}
        except (TypeError, ValueError):
            pass

    # Atomically mark payment paid so we never double-activate.
    r = await db.payments.update_one(
        {"reference": reference, "activation_done": {"$ne": True}},
        {"$set": {"status": "paid", "activation_done": True,
                  "paid_at": datetime.now(timezone.utc),
                  "amount_paid": amount_paid,
                  "updated_at": datetime.now(timezone.utc)}},
    )
    if r.modified_count == 0:
        return {"ok": True, "race_ignored": True}

    # Update the matching pending activation.
    await db.activations.update_one(
        {"reference": reference, "status": "pending"},
        {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc),
                  "validated_by": "biz_transpay_webhook"}},
    )

    # Now unlock the account. The security guard will find the paid row.
    try:
        await activate_level(db, pay["user_id"], 1, source="biz_transpay")
        return {"ok": True, "activated": True}
    except Exception as e:
        log.exception(f"activate_level failed for ref={reference}: {e}")
        # Reset activation_done so a manual retry stays possible.
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "paid", "activation_error": str(e),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(500, f"Activation failed: {e}")
