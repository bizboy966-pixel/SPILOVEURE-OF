"""IziChangePay direct integration (deposits + payouts, no proxy).

Overview
────────
This module replaces the older biz-transPay proxy. All calls now go straight to
`api.pay.izichange.com/v1/*` using our merchant `sk_live_*` key.

User-facing flows
─────────────────
1. Account activation deposit (5 USDT.BEP20):
     POST /api/activations/crypto-auto/create      → returns inline deposit address
     POST /api/activations/crypto-auto/verify      → user pastes tx_hash to activate now
     Webhook  POST /api/webhooks/izichange         → server-to-server confirmation
2. Automatic USDT.BEP20 withdrawal (payout):
     helper `create_payout()` — invoked by admin_validate_withdrawal
     Webhook payout events reconcile the wallet balance on failure.

Design notes
────────────
• Payment intents go through a 2-step public flow: create (auth) then
  select-crypto (public) — this is how izichange's own SPA operates and it is
  the ONLY way to obtain an inline deposit address (no external redirect).
• Webhook signatures follow the "Standard Webhooks" spec (Svix-style):
  header `x-izipay-signature: v1,<base64(HMAC-SHA256(msg_id.timestamp.payload, secret))>`.
  Multiple signatures may be space-separated; any match is accepted.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from feature_flags import is_enabled as feature_enabled
from matrix import activate_level

log = logging.getLogger("izichange")

BASE_URL = os.environ.get("IZIPAY_BASE_URL", "https://api.pay.izichange.com")
API_KEY = os.environ.get("IZIPAY_API_KEY", "")
# whsec_* — extracted-from-hex secret, used as-is for HMAC-SHA256.
_RAW_SECRET = os.environ.get("IZIPAY_WEBHOOK_SECRET", "")
# The Standard-Webhooks spec expects the raw bytes of the secret. When the
# dashboard displays `whsec_<hex>`, the SDK strips the prefix and hex-decodes
# the rest. We do the same, but silently fall back to the raw string if the
# format is unexpected.
if _RAW_SECRET.startswith("whsec_"):
    try:
        WEBHOOK_SECRET_BYTES = bytes.fromhex(_RAW_SECRET[len("whsec_"):])
    except ValueError:
        WEBHOOK_SECRET_BYTES = _RAW_SECRET.encode()
else:
    WEBHOOK_SECRET_BYTES = _RAW_SECRET.encode() if _RAW_SECRET else b""

AMOUNT_USDT = float(os.environ.get("IZIPAY_ACTIVATION_AMOUNT_USDT", "5"))
# Fixed conversion rate used to convert user-requested XOF withdrawals into
# USDT.BEP20 payouts (user requirement: 1 USDT = 600 XOF).
USDT_XOF_RATE = float(os.environ.get("IZIPAY_USDT_XOF_RATE", "600"))
ASSET_CODE = "USDT.BEP20"

api = APIRouter(prefix="/api", tags=["izichange"])
webhook = APIRouter(prefix="/api", tags=["izichange-webhook"])


# ═══════════════════════════════════════════════════════════════════════════
#   Helpers
# ═══════════════════════════════════════════════════════════════════════════

async def _api_post(path: str, json_body: dict, *, timeout: int = 30, idempotency_key: str | None = None):
    if not API_KEY:
        raise HTTPException(500, "Passerelle Crypto non configurée.")
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.post(f"{BASE_URL}{path}", headers=headers, json=json_body)


async def _api_get(path: str, *, timeout: int = 20):
    if not API_KEY:
        raise HTTPException(500, "Passerelle Crypto non configurée.")
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.get(f"{BASE_URL}{path}",
                                headers={"Authorization": f"Bearer {API_KEY}"})


async def _public_post(path: str, json_body: dict, *, timeout: int = 30):
    """POST to a /v1/public endpoint (no auth). Used for select-crypto."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.post(f"{BASE_URL}{path}", headers={"Content-Type": "application/json"}, json=json_body)


def _verify_webhook_signature(raw_body: bytes, headers: dict) -> tuple[bool, str, str]:
    """Verify an IziChangePay webhook using the Standard-Webhooks scheme.

    Returns (is_valid, msg_id, event_type).
    """
    msg_id = headers.get("x-izipay-id") or headers.get("webhook-id") or ""
    timestamp = headers.get("x-izipay-timestamp") or headers.get("webhook-timestamp") or ""
    signature_header = headers.get("x-izipay-signature") or headers.get("webhook-signature") or ""
    event_type = headers.get("x-izipay-event-type") or ""
    if not signature_header or not timestamp or not WEBHOOK_SECRET_BYTES:
        return False, msg_id, event_type
    # Anti-replay: reject events older than 5 minutes.
    try:
        if abs(int(time.time()) - int(timestamp)) > 300:
            log.warning(f"izichange webhook stale ts={timestamp}")
            return False, msg_id, event_type
    except ValueError:
        return False, msg_id, event_type
    signed = f"{msg_id}.{timestamp}.".encode() + raw_body
    expected = base64.b64encode(hmac.new(WEBHOOK_SECRET_BYTES, signed, hashlib.sha256).digest()).decode()
    # Header may contain "v1,<b64> v1,<b64>" — accept if any part matches.
    for candidate in signature_header.split():
        version, _, value = candidate.partition(",")
        if version == "v1" and hmac.compare_digest(expected, value):
            return True, msg_id, event_type
    return False, msg_id, event_type


async def create_payout(db, *, reference: str, amount_usdt: float, destination_address: str,
                        metadata: dict | None = None) -> dict:
    """Create a USDT.BEP20 payout on IziChangePay. Returns the payout dict.

    Raises HTTPException on API error.
    """
    if amount_usdt <= 0:
        raise HTTPException(400, "Montant de retrait invalide.")
    if not destination_address or len(destination_address) < 12:
        raise HTTPException(400, "Adresse de retrait invalide.")
    body = {
        "amount": f"{amount_usdt:.6f}".rstrip("0").rstrip("."),
        "assetCode": ASSET_CODE,
        "destinationAddress": destination_address,
        "destinationType": "blockchain_address",
        "feeBearer": "customer",
        "merchantReference": reference,
    }
    if metadata:
        body["metadata"] = metadata
    idem = f"payout-{reference}"
    try:
        r = await _api_post("/v1/payouts", body, timeout=30, idempotency_key=idem)
    except Exception as e:
        log.exception(f"izichange payout failed: {e}")
        raise HTTPException(400, "Impossible de contacter la passerelle Crypto pour le retrait.")
    if r.status_code >= 400:
        log.error(f"izichange payout {r.status_code} ref={reference}: {r.text[:300]}")
        raise HTTPException(400, "La passerelle Crypto a refusé le retrait.")
    payout = r.json()
    log.info(f"izichange payout OK ref={reference} id={payout.get('id')} status={payout.get('status')}")
    return payout


# ═══════════════════════════════════════════════════════════════════════════
#   Activation deposit
# ═══════════════════════════════════════════════════════════════════════════

class CryptoCreate(BaseModel):
    level: int = 1


@api.post("/activations/crypto-auto/create")
async def create_crypto_charge(data: CryptoCreate, request: Request, user=Depends(get_current_user)):
    """Create an IziChangePay payment intent for account activation.

    Returns the inline deposit address + amount so the client renders the QR
    code directly, keeping the user inside SPILIVERE.
    """
    db = request.app.state.db
    if not await feature_enabled(db, "crypto_auto"):
        raise HTTPException(503, "Activation automatique (Crypto) momentanément désactivée par l'administrateur.")
    if data.level != 1:
        raise HTTPException(400, "Cette méthode ne supporte que l'activation au niveau 1.")
    if user.get("max_level", 0) >= 1:
        raise HTTPException(400, "Votre compte est déjà activé.")
    if not API_KEY:
        raise HTTPException(500, "Passerelle Crypto non configurée.")

    # Dedupe: if the user already has a FRESH pending crypto_auto activation
    # (< 15 min old), return that one instead of creating a new intent.
    fresh_cutoff = datetime.now(timezone.utc).timestamp() - 15 * 60
    existing = await db.payments.find_one({
        "user_id": user["id"], "provider": "izichange", "status": "pending",
    }, sort=[("created_at", -1)])
    if existing and existing.get("deposit_address") \
            and existing.get("created_at") \
            and existing["created_at"].timestamp() > fresh_cutoff:
        return {
            "reference": existing["reference"],
            "deposit_address": existing["deposit_address"],
            "amount_to_send": existing.get("amount_to_send") or AMOUNT_USDT,
            "coin": "USDT", "network": "BEP20",
            "memo": existing.get("memo"),
            "expires_at": existing.get("expires_at"),
        }

    reference = f"SPLV_ACT_{user['id'][:8]}_{uuid.uuid4().hex[:8]}"
    email = user.get("email") or "user@spiloveure.com"
    username = user.get("username") or "SPILOVEURE"
    first_name = (user.get("first_name") or username or "SPILOVEURE")[:32]
    last_name = (user.get("last_name") or "USER")[:32]

    # ── Step 1: create payment intent (Bearer auth).
    try:
        r = await _api_post("/v1/payment-intents", {
            "requestedCurrencyType": "crypto",
            "currencyRequested": ASSET_CODE,
            "amountRequested": f"{AMOUNT_USDT:g}",
            "acceptedCoins": [ASSET_CODE],
            "merchantReference": reference,
            "customerEmail": email,
            "metadata": {
                "user_id": user["id"],
                "activation_level": 1,
                "username": username,
            },
        }, idempotency_key=reference)
    except Exception as e:
        log.exception(f"izichange intent create failed: {e}")
        raise HTTPException(400, "Impossible de contacter la passerelle Crypto. Réessayez dans quelques instants.")
    if r.status_code >= 400:
        log.error(f"izichange intent create {r.status_code}: {r.text[:400]}")
        raise HTTPException(400, "La passerelle Crypto a refusé la demande. Réessayez plus tard.")
    intent = r.json()
    intent_id = intent.get("id")
    if not intent_id:
        raise HTTPException(400, "Réponse invalide de la passerelle Crypto. Réessayez.")

    # ── Step 2: select the crypto + push customer info → inline deposit address.
    try:
        sr = await _public_post(
            f"/v1/public/payment-intents/{intent_id}/select-crypto",
            {"assetCode": ASSET_CODE,
             "customer": {"firstName": first_name, "lastName": last_name, "email": email}},
        )
    except Exception as e:
        log.exception(f"izichange select-crypto failed: {e}")
        raise HTTPException(400, "Impossible d'obtenir l'adresse de dépôt. Réessayez dans quelques instants.")
    if sr.status_code >= 400:
        log.error(f"izichange select-crypto {sr.status_code}: {sr.text[:400]}")
        raise HTTPException(400, "La passerelle Crypto n'a pas généré l'adresse. Réessayez plus tard.")
    sel = sr.json()
    deposit_address = sel.get("depositAddress")
    amount_to_send = sel.get("amountToSend") or sel.get("amountCryptoExpected") or AMOUNT_USDT
    memo = sel.get("memo")
    expires_at = sel.get("expiresAt")
    if not deposit_address:
        log.error(f"izichange no depositAddress ref={reference} sel={str(sel)[:400]}")
        raise HTTPException(400, "La passerelle Crypto n'a pas retourné d'adresse. Réessayez plus tard.")
    log.info(f"izichange intent+select OK ref={reference} address={deposit_address[:10]}…")

    # Persist a pending payment row so the webhook can reconcile it later and
    # so `activate_level` security guard finds it.
    now = datetime.now(timezone.utc)
    await db.payments.insert_one({
        "reference": reference,
        "provider": "izichange",
        "provider_intent_id": intent_id,
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
    await db.activations.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "username": user.get("username"),
        "email": user.get("email"),
        "level": 1, "status": "pending", "payment_method": "crypto_auto",
        "reference": reference, "amount": AMOUNT_USDT, "currency": "USDT",
        "provider_intent_id": intent_id,
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


# ═══════════════════════════════════════════════════════════════════════════
#   Manual verification via tx_hash
# ═══════════════════════════════════════════════════════════════════════════

class VerifyIn(BaseModel):
    reference: str
    tx_hash: str


@api.post("/activations/crypto-auto/verify")
async def crypto_auto_verify(inp: VerifyIn, request: Request, user=Depends(get_current_user)):
    """Manual verification triggered by the user pasting the on-chain tx_hash.

    Rules (all must pass): ownership, tx_hash uniqueness, gateway status
    completed, hash match (when the gateway reports one), amount ≥ 5 USDT.
    """
    db = request.app.state.db
    ref = (inp.reference or "").strip()
    tx = (inp.tx_hash or "").strip()
    if not ref or not tx:
        raise HTTPException(400, "Référence et hash requis.")
    if len(tx) < 10:
        raise HTTPException(400, "Hash de transaction invalide.")

    pay = await db.payments.find_one({"reference": ref, "provider": "izichange"})
    if not pay:
        raise HTTPException(404, "Demande de paiement introuvable.")
    if pay.get("user_id") != user["id"]:
        raise HTTPException(403, "Vous ne pouvez pas vérifier cette activation.")
    if pay.get("activation_done"):
        return {"ok": True, "already_activated": True, "message": "Compte déjà activé."}

    dupe = await db.payments.find_one({"tx_hash": tx, "reference": {"$ne": ref}})
    if dupe:
        log.warning(f"izichange verify: tx_hash reused ref={ref} tx={tx[:16]}")
        await db.activations.update_one(
            {"reference": ref, "status": "pending"},
            {"$set": {"status": "rejected", "rejected_reason": "tx_hash_reused",
                      "rejected_at": datetime.now(timezone.utc), "tx_hash": tx}},
        )
        await db.payments.update_one(
            {"reference": ref}, {"$set": {"status": "rejected", "tx_hash": tx,
                                          "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(409, "Ce hash de transaction est déjà utilisé pour une autre activation.")

    intent_id = pay.get("provider_intent_id")
    if not intent_id:
        raise HTTPException(500, "Identifiant passerelle manquant. Contactez le support.")

    try:
        r = await _api_get(f"/v1/payment-intents/{intent_id}")
    except Exception as e:
        log.exception(f"izichange verify GET failed: {e}")
        raise HTTPException(400, "Impossible de contacter la passerelle. Réessayez dans quelques instants.")
    if r.status_code == 404:
        raise HTTPException(404, "Paiement introuvable côté passerelle.")
    if r.status_code >= 400:
        log.error(f"izichange verify {r.status_code}: {r.text[:400]}")
        raise HTTPException(400, "La passerelle a refusé la vérification. Réessayez plus tard.")
    remote = r.json()
    remote_status = (remote.get("status") or "").lower()
    payins = remote.get("payins") or []
    remote_hash = ""
    remote_amount = float(remote.get("totalAmountReceived") or 0) or float(remote.get("amountCryptoExpected") or 0)
    for p in payins:
        if p.get("txHash"):
            remote_hash = p["txHash"]
            break

    if remote_status not in ("completed", "confirming"):
        return {"ok": False, "status": remote_status or "pending",
                "message": "Paiement pas encore confirmé sur la blockchain. Réessayez dans 1 à 5 minutes."}

    if remote_hash and remote_hash.lower() != tx.lower():
        log.warning(f"izichange verify hash mismatch ref={ref} user={tx[:12]} remote={remote_hash[:12]}")
        await db.activations.update_one(
            {"reference": ref, "status": "pending"},
            {"$set": {"status": "rejected", "rejected_reason": "hash_mismatch",
                      "rejected_at": datetime.now(timezone.utc), "tx_hash": tx}},
        )
        raise HTTPException(400, "Le hash de transaction ne correspond pas à cette activation.")

    if remote_amount and remote_amount + 1e-6 < float(pay.get("amount") or AMOUNT_USDT):
        await db.activations.update_one(
            {"reference": ref, "status": "pending"},
            {"$set": {"status": "rejected", "rejected_reason": "underpaid",
                      "rejected_at": datetime.now(timezone.utc), "tx_hash": tx}},
        )
        raise HTTPException(400, f"Montant reçu insuffisant ({remote_amount} < {AMOUNT_USDT} USDT).")

    if remote_status == "confirming":
        # Received on-chain but still awaiting the required confirmations.
        # We optimistically accept because the hash is proven — but the
        # webhook will fire a matching completed event shortly. Do NOT
        # activate yet; ask the user to wait.
        return {"ok": False, "status": "confirming",
                "message": "Paiement détecté, en attente de confirmation on-chain. Réessayez dans 1 à 2 minutes."}

    upd = await db.payments.update_one(
        {"reference": ref, "activation_done": {"$ne": True}},
        {"$set": {"status": "paid", "activation_done": True,
                  "paid_at": datetime.now(timezone.utc),
                  "amount_paid": remote_amount, "tx_hash": remote_hash or tx,
                  "updated_at": datetime.now(timezone.utc)}},
    )
    if upd.modified_count == 0:
        return {"ok": True, "already_activated": True, "message": "Compte déjà activé."}
    await db.activations.update_one(
        {"reference": ref, "status": "pending"},
        {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc),
                  "validated_by": "user_tx_hash_verify",
                  "tx_hash": remote_hash or tx}},
    )
    try:
        await activate_level(db, pay["user_id"], 1, source="izichange")
    except Exception as e:
        log.exception(f"activate_level failed for ref={ref}: {e}")
        raise HTTPException(500, "Activation impossible. Contactez le support.")
    log.info(f"izichange verify OK ref={ref} tx={tx[:16]}… user={pay['user_id']}")
    return {"ok": True, "activated": True,
            "message": "Paiement confirmé. Votre compte est activé au Niveau 1 !"}


# ═══════════════════════════════════════════════════════════════════════════
#   Webhook
# ═══════════════════════════════════════════════════════════════════════════

@webhook.post("/webhooks/izichange")
async def izichange_webhook(request: Request):
    """Receive IziChangePay events. Verifies signature, applies idempotency,
    then dispatches on event type:
      • payment_intent.completed → mark payment paid + activate account
      • payment_intent.expired / .cancelled → mark activation rejected
      • payout.completed / .failed → reconcile withdrawal + wallet balance
    """
    raw = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    is_valid, msg_id, event_type_hdr = _verify_webhook_signature(raw, headers)
    if not is_valid:
        log.warning(f"izichange webhook signature INVALID hdrs={list(headers.keys())[:6]}")
        raise HTTPException(401, "Invalid signature.")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON payload.")

    event_type = body.get("type") or event_type_hdr or ""
    data: dict = body.get("data") or body.get("object") or body
    db = request.app.state.db
    log.info(f"izichange webhook type={event_type} msg_id={msg_id[:16]}")

    # Persist raw event for audit.
    await db.webhook_logs.insert_one({
        "source": "izichange", "event_type": event_type, "event_id": msg_id,
        "payload_snippet": str(data)[:2000],
        "received_at": datetime.now(timezone.utc),
    })

    # Idempotency guard.
    if msg_id:
        seen = await db.webhook_events.find_one({"event_id": msg_id, "source": "izichange"})
        if seen:
            return {"ok": True, "duplicate": True}
        await db.webhook_events.insert_one({
            "source": "izichange", "event_id": msg_id, "event_type": event_type,
            "received_at": datetime.now(timezone.utc),
        })

    # ── PAYMENT INTENT events (deposits / activations) ─────────────────────
    if event_type.startswith("payment_intent."):
        return await _handle_payment_intent_event(db, event_type, data)

    # ── PAYOUT events (withdrawals) ─────────────────────────────────────────
    if event_type.startswith("payout."):
        return await _handle_payout_event(db, event_type, data)

    return {"ok": True, "ignored": True, "type": event_type}


async def _handle_payment_intent_event(db, event_type: str, data: dict):
    reference: Optional[str] = data.get("merchantReference") or data.get("reference")
    if not reference:
        # Not one of ours.
        return {"ok": True, "ignored": True, "reason": "no_reference"}
    pay = await db.payments.find_one({"reference": reference, "provider": "izichange"})
    if not pay:
        log.warning(f"izichange webhook unknown reference {reference}")
        return {"ok": True, "ignored": True, "reason": "unknown_reference"}

    if event_type in ("payment_intent.expired", "payment_intent.cancelled",
                      "payment_intent.failed", "payment_intent.rejected"):
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "rejected", "last_event": event_type,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        await db.activations.update_one(
            {"reference": reference, "status": "pending"},
            {"$set": {"status": "rejected", "rejected_reason": event_type,
                      "rejected_at": datetime.now(timezone.utc)}},
        )
        return {"ok": True, "rejected": True}

    if event_type != "payment_intent.completed":
        # confirming, waiting_payment, etc.
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"last_event": event_type,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"ok": True, "ignored": True}

    if pay.get("activation_done"):
        return {"ok": True, "already_activated": True}

    payins = data.get("payins") or []
    tx_hash = ""
    amount_paid = float(data.get("totalAmountReceived") or 0) or float(data.get("amountCryptoExpected") or 0)
    for p in payins:
        if p.get("txHash"):
            tx_hash = p["txHash"]
            break

    expected = float(pay.get("amount") or AMOUNT_USDT)
    if amount_paid and amount_paid + 1e-6 < expected:
        log.error(f"izichange underpayment ref={reference} paid={amount_paid} expected={expected}")
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "underpaid", "amount_paid": amount_paid,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"ok": False, "reason": "underpaid"}

    upd = await db.payments.update_one(
        {"reference": reference, "activation_done": {"$ne": True}},
        {"$set": {"status": "paid", "activation_done": True,
                  "paid_at": datetime.now(timezone.utc),
                  "amount_paid": amount_paid, "tx_hash": tx_hash,
                  "updated_at": datetime.now(timezone.utc)}},
    )
    if upd.modified_count == 0:
        return {"ok": True, "race_ignored": True}

    await db.activations.update_one(
        {"reference": reference, "status": "pending"},
        {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc),
                  "validated_by": "izichange_webhook", "tx_hash": tx_hash}},
    )
    # Ads payment path: skip activate_level, flip the ad status instead.
    if pay.get("kind") == "ads" and pay.get("ad_id"):
        await db.ads.update_one(
            {"id": pay["ad_id"], "status": "pending_payment"},
            {"$set": {"status": "pending_admin_review",
                      "payment_confirmed_at": datetime.now(timezone.utc),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"ok": True, "ad_paid": True, "ad_id": pay["ad_id"]}
    # Special task payment path: flip task to active.
    if pay.get("kind") == "special_task" and pay.get("special_task_id"):
        await db.special_tasks.update_one(
            {"id": pay["special_task_id"], "status": "pending_payment"},
            {"$set": {"status": "active",
                      "payment_confirmed_at": datetime.now(timezone.utc),
                      "activated_at": datetime.now(timezone.utc),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"ok": True, "task_paid": True, "task_id": pay["special_task_id"]}
    try:
        await activate_level(db, pay["user_id"], 1, source="izichange")
        return {"ok": True, "activated": True}
    except Exception as e:
        log.exception(f"activate_level failed for ref={reference}: {e}")
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"activation_error": str(e),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(500, f"Activation failed: {e}")


async def _handle_payout_event(db, event_type: str, data: dict):
    """Reconcile a withdrawal against a payout event.
    We match by the payout's `merchantReference` = withdrawal id.
    """
    ref = data.get("merchantReference") or data.get("reference")
    payout_id = data.get("id")
    if not ref:
        return {"ok": True, "ignored": True, "reason": "no_reference"}
    wd = await db.withdrawals.find_one({"id": ref})
    if not wd:
        log.warning(f"izichange payout webhook unknown wd id={ref}")
        return {"ok": True, "ignored": True, "reason": "unknown_reference"}
    now = datetime.now(timezone.utc)
    status = (data.get("status") or "").lower()
    if event_type in ("payout.completed",) or status in ("confirmed", "completed"):
        await db.withdrawals.update_one(
            {"id": ref},
            {"$set": {"status": "completed", "payout_id": payout_id,
                      "tx_hash": data.get("txHash") or data.get("tx_hash"),
                      "completed_at": now, "updated_at": now}},
        )
        return {"ok": True, "completed": True}
    if event_type in ("payout.failed", "payout.cancelled") or status in ("failed", "cancelled", "rejected"):
        # Rollback: return the wallet debit + mark rejected.
        amount = float(wd.get("amount") or 0)
        if amount and wd.get("status") in ("dispatched", "validated"):
            await db.users.update_one({"id": wd["user_id"]}, {"$inc": {"total_withdrawn": -amount}})
        await db.withdrawals.update_one(
            {"id": ref},
            {"$set": {"status": "rejected", "payout_id": payout_id,
                      "rejected_reason": data.get("failureReason") or event_type,
                      "rejected_at": now, "updated_at": now}},
        )
        return {"ok": True, "rejected": True}
    # Intermediate states (pending, processing) — just log and update status.
    await db.withdrawals.update_one(
        {"id": ref},
        {"$set": {"gateway_status": status, "payout_id": payout_id, "updated_at": now}},
    )
    return {"ok": True, "ignored": True}
