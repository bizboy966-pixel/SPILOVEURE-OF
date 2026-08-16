"""BizTransPay integration — USDT.BEP20 auto-activation.

Docs: https://biz-transppayy.com/api/v1
Auth: `Authorization: Bearer sk_live_XXX` (production) or `sk_test_XXX` (sandbox)

Design notes
────────────
1. Config is stored in `db.app_settings` under key `biztranspay`, NOT in env
   vars — the admin can rotate keys / toggle test↔live from the admin panel.
2. NO webhooks (per BizTransPay doc). The client polls
   `GET /api/payments/biztranspay/activation/status/{ref}` every 15 s; the
   server calls BizTransPay `GET /payments/{id}/status` on every hit.
3. All money moves are idempotent via `find_one_and_update({activation_done:
   {$ne: true}})` — concurrent webhooks/polls cannot double-credit.
4. `Idempotency-Key` header is set on every POST to BizTransPay to protect
   against network retries.
5. Amount tolerance: ±0.05 USDT to absorb network fees (chosen by user).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user
from matrix import activate_level

log = logging.getLogger("biztranspay")

DEFAULTS = {
    "enabled": False,
    "api_key": "",                             # sk_test_* or sk_live_*
    "mode": "live",                            # "test" or "live" — informative
    "base_url": "https://biz-transppayy.com/api/v1",
    "amount_usdt": 5.0,
    "network": "BEP20",
    "tolerance_usdt": 0.05,                    # ±0.05 (user requirement)
}


async def _load_config(db) -> dict:
    row = await db.app_settings.find_one({"key": "biztranspay"}, {"_id": 0})
    cfg = (row or {}).get("value") or {}
    return {**DEFAULTS, **cfg}


api = APIRouter(prefix="/api", tags=["biztranspay"])
admin = APIRouter(prefix="/api/admin", tags=["biztranspay-admin"])


# ────────────────────────────────────────────────────────────────────────
# HTTP helpers
# ────────────────────────────────────────────────────────────────────────
async def _http(method: str, cfg: dict, path: str, *,
                json_body: dict | None = None,
                idempotency_key: str | None = None,
                timeout: int = 25):
    if not cfg.get("api_key"):
        raise HTTPException(503, "Passerelle BizTransPay non configurée (clé API manquante).")
    url = f"{cfg['base_url'].rstrip('/')}{path}"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(method, url, headers=headers, json=json_body)


def _extract_deposit_details(payment_data: dict) -> dict:
    """BizTransPay's response shape isn't fully public — probe MANY common
    paths. Deposit-address gateways typically nest it under one of these."""
    def _first(*paths: str) -> Any:
        for p in paths:
            v = payment_data
            for k in p.split("."):
                if isinstance(v, dict) and k in v:
                    v = v[k]
                else:
                    v = None
                    break
            if v not in (None, ""):
                return v
        return None
    addr = _first(
        # Top-level candidates
        "deposit_address", "address", "payment_address", "wallet_address",
        "pay_address", "receive_address", "crypto_address", "recipient_address",
        # data.* nesting (common in RESTful payment providers)
        "data.deposit_address", "data.address", "data.pay_address",
        "data.payment_address", "data.wallet_address", "data.crypto_address",
        # payment_intent.* nesting
        "payment_intent.deposit_address", "payment_intent.address",
        "payment_intent.pay_address", "payment_intent.wallet_address",
        # crypto.* nesting
        "crypto.address", "crypto.deposit_address", "crypto.pay_address",
        # payment_method / details
        "payment_details.address", "payment_details.deposit_address",
        "payment_method.address", "payment_method.deposit_address",
        # attributes.* (JSON:API style)
        "attributes.deposit_address", "attributes.address", "attributes.pay_address",
        # intent.* nesting
        "intent.deposit_address", "intent.address", "intent.pay_address",
        # pay_currency object (some gateways return currency-specific info)
        "pay_currency.address", "pay_currency.deposit_address",
    )
    network = _first(
        "network", "chain", "blockchain",
        "data.network", "crypto.network", "payment_intent.network",
        "attributes.network", "pay_currency.network",
    ) or "BEP20"
    coin = _first(
        "coin", "currency", "pay_currency.symbol",
        "data.coin", "data.currency", "attributes.coin",
    ) or "USDT"
    amount_to_send = _first(
        "amount_to_send", "amount", "expected_amount",
        "crypto.amount", "data.amount", "payment_intent.amount",
        "attributes.amount", "pay_amount", "pay_currency.amount",
    )
    return {
        "deposit_address": addr,
        "network": str(network).upper(),
        "coin": str(coin).upper(),
        "amount_to_send": float(amount_to_send) if amount_to_send is not None else None,
    }


@api.get("/payments/biztranspay/public/status")
async def biztranspay_public_status(request: Request, user=Depends(get_current_user)):
    """Lightweight status probe for the activation UI. Non-admin: returns
    only what a normal user needs to know — `enabled` + `amount_usdt`. The
    API key is never returned here."""
    cfg = await _load_config(request.app.state.db)
    return {
        "enabled": bool(cfg.get("enabled") and cfg.get("api_key")),
        "amount_usdt": float(cfg.get("amount_usdt") or 5),
        "network": cfg.get("network") or "BEP20",
    }


# ────────────────────────────────────────────────────────────────────────
# User endpoints
# ────────────────────────────────────────────────────────────────────────
class InitiateIn(BaseModel):
    level: int = 1


@api.post("/payments/biztranspay/activation/initiate")
async def biztranspay_initiate(body: InitiateIn, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await _load_config(db)
    if not cfg.get("enabled"):
        raise HTTPException(503, "Auto-activation BizTransPay désactivée par l'administrateur.")
    if body.level != 1:
        raise HTTPException(400, "Cette méthode ne supporte que le niveau 1.")
    if int(user.get("max_level", 0)) >= 1:
        raise HTTPException(400, "Votre compte est déjà activé.")

    # Dedupe: return an existing < 30-min-old pending intent instead of new.
    fresh_cutoff_ts = datetime.now(timezone.utc).timestamp() - 30 * 60
    existing = await db.payments.find_one({
        "user_id": user["id"], "provider": "biztranspay", "status": "pending",
    }, sort=[("created_at", -1)])
    if existing and existing.get("deposit_address") \
            and existing.get("created_at") \
            and existing["created_at"].timestamp() > fresh_cutoff_ts:
        return {
            "reference": existing["reference"],
            "provider_intent_id": existing.get("provider_intent_id"),
            "deposit_address": existing["deposit_address"],
            "amount_to_send": existing.get("amount_to_send") or cfg["amount_usdt"],
            "coin": "USDT", "network": existing.get("network") or cfg["network"],
            "payment_url": existing.get("payment_url"),
            "expires_at": existing.get("expires_at"),
        }

    reference = f"SPLV_BTP_{user['id'][:8]}_{uuid.uuid4().hex[:8]}"
    payload = {
        "amount": cfg["amount_usdt"],
        "coin": "USDT",
        "reference": reference,
        "customer_email": user.get("email") or "user@spiloveure.com",
        "accepted_networks": [cfg["network"]],
    }
    try:
        r = await _http("POST", cfg, "/payments", json_body=payload, idempotency_key=reference)
    except Exception as e:
        log.exception("biztranspay create failed: %s", e)
        raise HTTPException(400, "Impossible de contacter BizTransPay. Réessayez.")
    if r.status_code >= 400:
        log.error("biztranspay create %s: %s", r.status_code, r.text[:400])
        raise HTTPException(400, "BizTransPay a refusé la demande. Réessayez plus tard.")
    intent = r.json() or {}
    intent_id = intent.get("id")
    if not intent_id:
        raise HTTPException(400, "Réponse invalide de BizTransPay.")
    payment_url = intent.get("payment_url")
    expires_at = intent.get("expires_at")

    # Immediately fetch full details to try to extract the deposit address.
    # Retry up to 3× with 1.5s backoff — some gateways expose the deposit
    # address a moment after the intent is created (async wallet gen).
    import asyncio
    details: dict = {}
    raw_last: dict = {}
    for attempt in range(3):
        try:
            d = await _http("GET", cfg, f"/payments/{intent_id}")
            if d.status_code < 400:
                raw_last = d.json() or {}
                details = _extract_deposit_details(raw_last)
                if details.get("deposit_address"):
                    break
        except Exception as e:
            log.warning("biztranspay details fetch failed (try %s): %s", attempt + 1, e)
        await asyncio.sleep(1.5)

    if not details.get("deposit_address"):
        # Log the raw response so the admin can inspect the actual field names
        # BizTransPay uses. This is invaluable if the API shape differs from
        # the 20+ paths already probed in `_extract_deposit_details`.
        log.warning(
            "biztranspay: no deposit_address extracted for intent %s. Raw keys: %s. Snippet: %s",
            intent_id, list(raw_last.keys()) if isinstance(raw_last, dict) else "n/a",
            str(raw_last)[:600],
        )

    deposit_address = details.get("deposit_address")
    amount_to_send = details.get("amount_to_send") or cfg["amount_usdt"]
    network = details.get("network") or cfg["network"]

    now = datetime.now(timezone.utc)
    await db.payments.insert_one({
        "reference": reference,
        "provider": "biztranspay",
        "provider_intent_id": intent_id,
        "user_id": user["id"], "level": 1,
        "kind": "activation",
        "status": "pending",
        "amount": float(cfg["amount_usdt"]),
        "currency": "USDT", "network": network,
        "deposit_address": deposit_address,
        "amount_to_send": amount_to_send,
        "payment_url": payment_url,
        "expires_at": expires_at,
        "activation_done": False,
        "created_at": now, "updated_at": now,
    })
    await db.activations.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "username": user.get("username"),
        "email": user.get("email"),
        "level": 1, "status": "pending", "payment_method": "biztranspay",
        "reference": reference, "amount": float(cfg["amount_usdt"]),
        "currency": "USDT", "provider_intent_id": intent_id,
        "created_at": now,
    })
    return {
        "reference": reference,
        "provider_intent_id": intent_id,
        "deposit_address": deposit_address,
        "amount_to_send": amount_to_send,
        "coin": "USDT", "network": network,
        "payment_url": payment_url,
        "expires_at": expires_at,
    }


class VerifyIn(BaseModel):
    reference: str
    tx_hash: str | None = None


async def _try_confirm(db, cfg: dict, pay: dict, tx_hash_hint: str = "") -> dict:
    """Poll BizTransPay for the payment status; on `paid` + amount OK,
    atomically credit the activation. Idempotent."""
    intent_id = pay.get("provider_intent_id")
    if not intent_id:
        return {"ok": False, "status": "pending", "message": "Identifiant passerelle manquant."}
    try:
        r = await _http("GET", cfg, f"/payments/{intent_id}/status")
    except Exception as e:
        log.exception("biztranspay status GET failed: %s", e)
        return {"ok": False, "status": "pending", "message": "Passerelle injoignable."}
    if r.status_code >= 400:
        log.error("biztranspay status %s: %s", r.status_code, r.text[:200])
        return {"ok": False, "status": "pending", "message": "Passerelle indisponible."}
    status = str((r.json() or {}).get("status") or "").lower()
    if status in ("paid",):
        # Fetch full details to grab the real amount + tx_hash reported.
        try:
            d = await _http("GET", cfg, f"/payments/{intent_id}")
            data = d.json() if d.status_code < 400 else {}
        except Exception:
            data = {}
        received = data.get("amount_received") or data.get("amount") or pay.get("amount")
        tx = data.get("tx_hash") or data.get("transaction_hash") or tx_hash_hint or ""
        expected = float(pay.get("amount") or cfg["amount_usdt"])
        tol = float(cfg.get("tolerance_usdt") or 0.05)
        try:
            received_f = float(received)
        except (TypeError, ValueError):
            received_f = expected
        if received_f + tol < expected:
            return {"ok": False, "status": "underpaid",
                    "message": f"Montant reçu insuffisant ({received_f} < {expected} USDT)."}
        # Prevent tx_hash reuse across activations (when hash known).
        if tx:
            dupe = await db.payments.find_one(
                {"tx_hash": tx, "reference": {"$ne": pay["reference"]}, "provider": "biztranspay"},
                {"_id": 1},
            )
            if dupe:
                await db.payments.update_one(
                    {"reference": pay["reference"]},
                    {"$set": {"status": "rejected",
                              "activation_error": "tx_hash déjà utilisé.",
                              "updated_at": datetime.now(timezone.utc)}},
                )
                return {"ok": False, "status": "rejected",
                        "message": "Ce hash de transaction est déjà utilisé."}
        # Atomic single-shot flip.
        claimed = await db.payments.find_one_and_update(
            {"reference": pay["reference"], "activation_done": {"$ne": True}},
            {"$set": {"status": "paid", "activation_done": True,
                      "paid_at": datetime.now(timezone.utc),
                      "amount_paid": received_f,
                      "tx_hash": tx or None,
                      "updated_at": datetime.now(timezone.utc)}},
            return_document=True,
        )
        if not claimed:
            return {"ok": True, "activated": True, "already_activated": True,
                    "message": "Compte déjà activé."}
        await db.activations.update_one(
            {"reference": pay["reference"], "status": "pending"},
            {"$set": {"status": "validated",
                      "validated_at": datetime.now(timezone.utc),
                      "validated_by": "auto:biztranspay",
                      "tx_hash": tx or None}},
        )
        try:
            await activate_level(db, pay["user_id"], 1, source="biztranspay")
        except Exception as e:
            log.exception("activate_level failed for ref=%s: %s", pay["reference"], e)
            raise HTTPException(500, "Activation impossible. Contactez le support.")
        # 🔔 Push notif to the user
        try:
            from push_helper import push_to_user
            await push_to_user(
                db, pay["user_id"],
                title="🎉 Paiement crypto confirmé",
                body="Votre compte SPILOVEURE est maintenant activé. Bienvenue !",
                link="/(app)/dashboard",
                data={"kind": "activation_completed", "reference": pay["reference"]},
                tag=f"btp-act-{pay['reference']}",
            )
        except Exception:
            pass
        return {"ok": True, "activated": True,
                "message": "Paiement confirmé. Votre compte est activé au Niveau 1 !"}
    if status in ("expired", "failed", "canceled"):
        await db.payments.update_one(
            {"reference": pay["reference"], "status": "pending"},
            {"$set": {"status": "failed",
                      "activation_error": f"BizTransPay: {status}",
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"ok": False, "status": status,
                "message": f"Paiement {status}. Recommencez si nécessaire."}
    # initiated / confirming
    return {"ok": False, "status": status or "pending",
            "message": "Paiement pas encore confirmé. Réessayez dans 15-30s."}


@api.post("/payments/biztranspay/activation/verify")
async def biztranspay_verify(body: VerifyIn, request: Request, user=Depends(get_current_user)):
    """User pastes the tx_hash and clicks Verify. Server polls once."""
    db = request.app.state.db
    cfg = await _load_config(db)
    ref = (body.reference or "").strip()
    if not ref:
        raise HTTPException(400, "Référence requise.")
    pay = await db.payments.find_one({"reference": ref, "provider": "biztranspay"})
    if not pay:
        raise HTTPException(404, "Demande de paiement introuvable.")
    if pay.get("user_id") != user["id"]:
        raise HTTPException(403, "Vous ne pouvez pas vérifier cette activation.")
    if pay.get("activation_done"):
        return {"ok": True, "activated": True, "already_activated": True,
                "message": "Compte déjà activé."}
    return await _try_confirm(db, cfg, pay, tx_hash_hint=(body.tx_hash or "").strip())


@api.get("/payments/biztranspay/activation/status/{reference}")
async def biztranspay_status(reference: str, request: Request, user=Depends(get_current_user)):
    """Polling endpoint (called every 15s by the frontend)."""
    db = request.app.state.db
    cfg = await _load_config(db)
    pay = await db.payments.find_one({"reference": reference, "provider": "biztranspay"})
    if not pay:
        raise HTTPException(404, "Demande introuvable.")
    if pay.get("user_id") != user["id"]:
        raise HTTPException(403, "Interdit.")
    if pay.get("activation_done"):
        return {"ok": True, "status": "paid", "activated": True}
    # If we still don't have a deposit_address, retry to fetch it — some
    # gateways generate the address asynchronously after the intent is
    # created. Update the payment row so the next call sees the fresh value.
    if not pay.get("deposit_address") and pay.get("provider_intent_id"):
        try:
            d = await _http("GET", cfg, f"/payments/{pay['provider_intent_id']}")
            if d.status_code < 400:
                details = _extract_deposit_details(d.json() or {})
                if details.get("deposit_address"):
                    await db.payments.update_one(
                        {"reference": reference},
                        {"$set": {"deposit_address": details["deposit_address"],
                                  "amount_to_send": details.get("amount_to_send") or pay.get("amount"),
                                  "network": details.get("network") or pay.get("network"),
                                  "updated_at": datetime.now(timezone.utc)}},
                    )
                    pay = await db.payments.find_one({"reference": reference})
        except Exception as e:
            log.warning("biztranspay late-address fetch failed: %s", e)
    result = await _try_confirm(db, cfg, pay)
    # Expose the deposit_address in the status payload so the client can
    # display it even if it appeared late (post-initiate).
    result["deposit_address"] = pay.get("deposit_address")
    result["amount_to_send"] = pay.get("amount_to_send") or pay.get("amount")
    result["network"] = pay.get("network")
    return result


# ────────────────────────────────────────────────────────────────────────
# Admin config endpoints (API keys never exposed to non-admin)
# ────────────────────────────────────────────────────────────────────────
def _mask(k: str) -> str:
    if not k or len(k) < 12:
        return "" if not k else "•" * len(k)
    return f"{k[:8]}…{k[-4:]}"


class ConfigIn(BaseModel):
    enabled: bool | None = None
    api_key: str | None = None       # send empty string to leave unchanged
    mode: str | None = None          # "test" | "live"
    base_url: str | None = None
    amount_usdt: float | None = None
    network: str | None = None
    tolerance_usdt: float | None = None


@admin.get("/payments/biztranspay/config")
async def admin_get_biztranspay_config(request: Request):
    # Auth handled at router level in server.py (require_admin dependency).
    cfg = await _load_config(request.app.state.db)
    return {
        "enabled": cfg["enabled"],
        "api_key_masked": _mask(cfg.get("api_key") or ""),
        "api_key_set": bool(cfg.get("api_key")),
        "mode": cfg["mode"],
        "base_url": cfg["base_url"],
        "amount_usdt": cfg["amount_usdt"],
        "network": cfg["network"],
        "tolerance_usdt": cfg["tolerance_usdt"],
    }


@admin.put("/payments/biztranspay/config")
async def admin_set_biztranspay_config(body: ConfigIn, request: Request):
    db = request.app.state.db
    current = await _load_config(db)
    upd = dict(current)
    if body.enabled is not None:
        upd["enabled"] = bool(body.enabled)
    if body.api_key is not None and body.api_key.strip():
        upd["api_key"] = body.api_key.strip()
    if body.mode in ("test", "live"):
        upd["mode"] = body.mode
    if body.base_url and body.base_url.strip():
        upd["base_url"] = body.base_url.strip().rstrip("/")
    if body.amount_usdt is not None and body.amount_usdt > 0:
        upd["amount_usdt"] = float(body.amount_usdt)
    if body.network and body.network.strip():
        upd["network"] = body.network.strip().upper()
    if body.tolerance_usdt is not None and body.tolerance_usdt >= 0:
        upd["tolerance_usdt"] = float(body.tolerance_usdt)
    await db.app_settings.update_one(
        {"key": "biztranspay"}, {"$set": {"value": upd}}, upsert=True,
    )
    return {"ok": True, "config": {**upd, "api_key": _mask(upd.get("api_key") or "")}}
