"""BizTransPay Developer API v2 — INTÉGRATION COMPLÈTE.

Docs: https://biz-transppayy.com/api/developer/v2

Auth (double header) :
    X-BizTransPay-Public-Key: pk_btp_...
    Authorization:           Bearer sk_btp_...

Idempotence :
    Idempotency-Key: <uuid>  — obligatoire sur tout POST financier.

Webhooks HMAC-SHA256 :
    X-BizTransPay-Signature:  sha256=<HMAC(secret, timestamp + "." + raw_body)>
    X-BizTransPay-Timestamp:  <unix seconds>
    X-BizTransPay-Event-Id:   <uuid>   — protection anti-rejeu.

Événements :
    transaction.pending / transaction.completed / transaction.failed

Coexistence : ce module coexiste avec AshtecPay + Izichange sans les modifier.
Lorsqu'un admin active `auto_withdraw_mobile` ou `auto_withdraw_crypto`,
`server.py::request_withdrawal` délègue le payout via `dispatch_auto_withdrawal`.

Sécurité : aucune clé secrète n'est jamais renvoyée au frontend. `webhook_secret`
et `secret_key` sont uniquement masqués (`sk_btp_XXXXXX…YYYY`).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user
from matrix import activate_level

log = logging.getLogger("biztranspay")

# ────────────────────────────────────────────────────────────────────────
# CONFIG
# ────────────────────────────────────────────────────────────────────────
DEFAULTS: dict[str, Any] = {
    # Master switch — must be ON for anything to work.
    "enabled": False,
    # Auth
    "public_key": "",                                # pk_btp_...
    "secret_key": "",                                # sk_btp_...
    "webhook_secret": "",                            # signature verify
    "base_url": "https://biz-transppayy.com/api/developer/v2",
    "mode": "live",                                  # test | live (informational)
    # Deposits
    "activation_amount_xof": 2500.0,                 # locked mobile-money price
    "activation_amount_usdt": 5.0,                   # locked crypto price
    "activation_network": "BEP20",                   # crypto network
    "activation_asset_code": "USDT.BEP20",           # BizTransPay asset code
    # Auto-withdrawals (independent toggles)
    "auto_withdraw_mobile": False,
    "auto_withdraw_crypto": False,
    # Security
    "webhook_replay_window_sec": 300,                # reject webhooks older than 5min
}


async def _load_config(db) -> dict:
    row = await db.app_settings.find_one({"key": "biztranspay"}, {"_id": 0})
    cfg = (row or {}).get("value") or {}
    merged = {**DEFAULTS, **cfg}
    # Auto-migration: old configs may still point to the v1 endpoint.
    # v2 supersedes v1 entirely (see spec 2026-08-27).
    if "/api/v1" in (merged.get("base_url") or ""):
        merged["base_url"] = DEFAULTS["base_url"]
    return merged


# ────────────────────────────────────────────────────────────────────────
# COUNTRIES / OPERATORS catalogue (Mobile Money BizTransPay v2)
# Operator codes suivent la convention BizTransPay `<operator>_<country>`.
# Extensible : l'admin peut ajouter des lignes via `app_settings.biztranspay.operators`.
# ────────────────────────────────────────────────────────────────────────
DIAL_CODES: dict[str, str] = {
    "BJ": "229", "BF": "226", "CD": "243", "CI": "225", "CM": "237",
    "GA": "241", "ML": "223", "NE": "227", "SN": "221", "TG": "228",
}
COUNTRIES: dict[str, dict] = {
    "TG": {"name": "Togo",          "currency": "XOF",
           "operators": [("T-Money", "tmoney_tg"), ("Flooz (Moov)", "flooz_tg")]},
    "BJ": {"name": "Bénin",         "currency": "XOF",
           "operators": [("MTN Money", "mtn_bj"), ("Moov Money", "moov_bj"),
                         ("Celtiis Money", "celtiis_bj"), ("Coris Money", "coris_bj")]},
    "BF": {"name": "Burkina Faso",  "currency": "XOF",
           "operators": [("Moov Money", "moov_bf"), ("Orange Money", "orange_bf"),
                         ("Wallet LigdiCash", "ligdicash_bf")]},
    "CI": {"name": "Côte d'Ivoire", "currency": "XOF",
           "operators": [("MTN Money", "mtn_ci"), ("Moov Money", "moov_ci"),
                         ("Orange Money", "orange_ci"), ("Wave Money", "wave_ci")]},
    "CM": {"name": "Cameroun",      "currency": "XAF",
           "operators": [("MTN Money", "mtn_cm"), ("Orange Money", "orange_cm")]},
}


def _normalize_phone(phone: str, country_code: str) -> str:
    p = (phone or "").strip().replace(" ", "").replace("-", "").replace(".", "")
    if not p:
        return p
    if p.startswith("+"):
        return p
    dial = DIAL_CODES.get((country_code or "").upper(), "")
    if dial and p.startswith(dial):
        return "+" + p
    if p.startswith("0"):
        p = p.lstrip("0")
    return f"+{dial}{p}" if dial else f"+{p}"


def _mask(k: str) -> str:
    if not k or len(k) < 12:
        return "" if not k else "•" * len(k)
    return f"{k[:8]}…{k[-4:]}"


# ────────────────────────────────────────────────────────────────────────
# HTTP helpers
# ────────────────────────────────────────────────────────────────────────
def _headers(cfg: dict, idempotency_key: Optional[str] = None) -> dict:
    if not cfg.get("secret_key") or not cfg.get("public_key"):
        raise HTTPException(503, "Passerelle BizTransPay non configurée (clés manquantes).")
    h = {
        "X-BizTransPay-Public-Key": cfg["public_key"],
        "Authorization": f"Bearer {cfg['secret_key']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if idempotency_key:
        h["Idempotency-Key"] = idempotency_key
    return h


async def _http(method: str, cfg: dict, path: str, *,
                json_body: Optional[dict] = None,
                idempotency_key: Optional[str] = None,
                timeout: int = 25) -> httpx.Response:
    url = f"{cfg['base_url'].rstrip('/')}{path}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(method, url,
                                    headers=_headers(cfg, idempotency_key),
                                    json=json_body)


def _biztp_error(r: httpx.Response) -> str:
    """Extract a user-friendly FR error message from a BizTransPay error response.
    Never leaks technical details / stack traces to the caller."""
    try:
        j = r.json() or {}
        code = str(j.get("code") or j.get("error") or "").upper()
        msg = j.get("message") or j.get("detail")
    except Exception:
        code, msg = "", None
    fr = {
        "INVALID_API_CREDENTIALS": "Identifiants BizTransPay invalides.",
        "API_DISABLED": "Passerelle BizTransPay désactivée côté opérateur.",
        "DEPOSITS_DISABLED": "Dépôts BizTransPay temporairement désactivés.",
        "WITHDRAWALS_DISABLED": "Retraits BizTransPay temporairement désactivés.",
        "DEPOSITS_UNAVAILABLE": "Dépôt indisponible pour cet opérateur.",
        "WITHDRAWALS_UNAVAILABLE": "Retrait indisponible pour cette destination.",
        "RATE_LIMITED": "Trop de tentatives. Merci de réessayer dans quelques instants.",
        "IDEMPOTENCY_KEY_REQUIRED": "Erreur technique (clé d'idempotence manquante).",
        "IDEMPOTENCY_KEY_REUSED": "Cette opération est déjà en cours de traitement.",
        "REQUEST_IN_PROGRESS": "Cette opération est déjà en cours de traitement.",
        "TRANSACTION_NOT_FOUND": "Transaction introuvable côté passerelle.",
        "KYC_REQUIRED": "Vérification d'identité (KYC) requise par BizTransPay.",
        "LEDGER_INTEGRITY_FAILURE": "Erreur interne de la passerelle. Contactez le support.",
        "INSUFFICIENT_FUNDS": "Solde marchand insuffisant côté BizTransPay.",
    }.get(code)
    if fr:
        return fr
    if msg:
        return str(msg)[:200]
    if 500 <= r.status_code < 600:
        return "La passerelle de paiement rencontre un incident. Réessayez dans quelques minutes ou choisissez un autre moyen de paiement."
    if r.status_code == 400:
        return "Requête refusée par la passerelle. Vérifiez votre numéro de téléphone ou choisissez un autre opérateur."
    if r.status_code == 401 or r.status_code == 403:
        return "Passerelle non autorisée. Contactez l'administrateur du site."
    return "Paiement momentanément indisponible. Réessayez ou choisissez un autre moyen."


# ────────────────────────────────────────────────────────────────────────
# ROUTERS
# ────────────────────────────────────────────────────────────────────────
api = APIRouter(prefix="/api", tags=["biztranspay"])
admin = APIRouter(prefix="/api/admin", tags=["biztranspay-admin"])
webhook = APIRouter(prefix="/api/webhooks", tags=["biztranspay-webhook"])


# ────────────────────────────────────────────────────────────────────────
# PUBLIC STATUS (frontend uses this to know which methods are enabled)
# ────────────────────────────────────────────────────────────────────────
@api.get("/payments/biztranspay/public/status")
async def biztranspay_public_status(request: Request, user=Depends(get_current_user)):
    cfg = await _load_config(request.app.state.db)
    ready = bool(cfg.get("enabled") and cfg.get("public_key") and cfg.get("secret_key"))
    return {
        "enabled": ready,
        "activation_amount_xof": float(cfg["activation_amount_xof"]),
        "activation_amount_usdt": float(cfg["activation_amount_usdt"]),
        "network": cfg["activation_network"],
        "auto_withdraw_mobile": bool(cfg.get("auto_withdraw_mobile")) and ready,
        "auto_withdraw_crypto": bool(cfg.get("auto_withdraw_crypto")) and ready,
    }


@api.get("/payments/biztranspay/catalog")
async def biztranspay_catalog(request: Request, user=Depends(get_current_user)):
    """Return the list of countries + operators supported for Mobile Money."""
    countries = []
    for cc, info in COUNTRIES.items():
        countries.append({
            "code": cc,
            "name": info["name"],
            "currency": info["currency"],
            "dial_code": DIAL_CODES.get(cc, ""),
            "operators": [{"label": lbl, "code": code} for (lbl, code) in info["operators"]],
        })
    return {"countries": countries}


# ────────────────────────────────────────────────────────────────────────
# DEPOSITS — Mobile Money
# ────────────────────────────────────────────────────────────────────────
class MobileInitiateIn(BaseModel):
    country: str
    operator_code: str
    phone: str


@api.post("/payments/biztranspay/mobile/initiate")
async def biztranspay_mobile_initiate(
    body: MobileInitiateIn, request: Request, user=Depends(get_current_user),
):
    db = request.app.state.db
    cfg = await _load_config(db)
    if not cfg["enabled"] or not cfg["public_key"] or not cfg["secret_key"]:
        raise HTTPException(503, "Auto-activation BizTransPay désactivée par l'administrateur.")
    if int(user.get("max_level", 0)) >= 1:
        raise HTTPException(400, "Votre compte est déjà activé.")

    cc = (body.country or "").upper()
    country_info = COUNTRIES.get(cc)
    if not country_info:
        raise HTTPException(400, "Pays non supporté par BizTransPay.")
    op_codes = {code for (_lbl, code) in country_info["operators"]}
    if body.operator_code not in op_codes:
        raise HTTPException(400, "Opérateur invalide pour ce pays.")

    phone = _normalize_phone(body.phone or "", cc)
    if len(phone) < 8:
        raise HTTPException(400, "Numéro de téléphone invalide.")

    amount = float(cfg["activation_amount_xof"])
    currency = country_info["currency"]

    # Dedupe: reuse an existing pending intent < 30 min old.
    fresh_cutoff = datetime.now(timezone.utc).timestamp() - 30 * 60
    existing = await db.payments.find_one({
        "user_id": user["id"], "provider": "biztranspay",
        "channel": "mobile_money", "status": "pending",
    }, sort=[("created_at", -1)])
    if existing and existing.get("created_at") \
            and existing["created_at"].timestamp() > fresh_cutoff:
        return {
            "reference": existing["reference"],
            "provider_intent_id": existing.get("provider_intent_id"),
            "status": "pending",
            "amount": amount, "currency": currency,
        }

    reference = f"SPLV_BTPMM_{user['id'][:8]}_{uuid.uuid4().hex[:8]}"
    payload = {
        "amount": amount,
        "currency": currency,
        "email": user.get("email") or "user@spiloveure.com",
        "full_name": user.get("username") or "SPILOVEURE User",
        "country": cc,
        "operator": body.operator_code,
        "phone_number": phone,
    }
    # NB : les frais mobile money sont réglés côté BizTransPay dans les
    # paramètres marchand (option "Frais à charge marchand"). Ce n'est pas
    # un flag de requête — l'envoi de champs inconnus déclenchait un 500.
    try:
        r = await _http("POST", cfg, "/deposits/mobile-money",
                        json_body=payload, idempotency_key=reference)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("biztranspay mobile-money create failed: %s", e)
        raise HTTPException(502, "Impossible de contacter BizTransPay. Réessayez.")
    if r.status_code >= 400:
        log.error("biztranspay mobile-money %s: %s", r.status_code, r.text[:400])
        raise HTTPException(400, _biztp_error(r))
    intent = r.json() or {}
    intent_id = intent.get("transaction_id") or intent.get("id")
    if not intent_id:
        raise HTTPException(502, "Réponse invalide de BizTransPay.")

    now = datetime.now(timezone.utc)
    await db.payments.insert_one({
        "reference": reference,
        "provider": "biztranspay",
        "channel": "mobile_money",
        "provider_intent_id": intent_id,
        "user_id": user["id"], "level": 1,
        "kind": "activation",
        "status": "pending",
        "amount": amount, "currency": currency,
        "country": cc, "operator": body.operator_code, "phone": phone,
        "activation_done": False,
        "created_at": now, "updated_at": now,
    })
    await db.activations.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "username": user.get("username"),
        "email": user.get("email"),
        "level": 1, "status": "pending", "payment_method": "biztranspay_mobile",
        "reference": reference, "amount": amount, "currency": currency,
        "provider_intent_id": intent_id,
        "created_at": now,
    })
    return {
        "reference": reference,
        "provider_intent_id": intent_id,
        "status": "pending",
        "amount": amount, "currency": currency,
        "country": cc, "operator": body.operator_code, "phone": phone,
    }


# ────────────────────────────────────────────────────────────────────────
# DEPOSITS — Crypto USDT.BEP20
# ────────────────────────────────────────────────────────────────────────
@api.post("/payments/biztranspay/crypto/initiate")
async def biztranspay_crypto_initiate(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await _load_config(db)
    if not cfg["enabled"] or not cfg["public_key"] or not cfg["secret_key"]:
        raise HTTPException(503, "Auto-activation BizTransPay désactivée par l'administrateur.")
    if int(user.get("max_level", 0)) >= 1:
        raise HTTPException(400, "Votre compte est déjà activé.")

    # Dedupe: return a fresh pending intent that still has an address.
    fresh_cutoff = datetime.now(timezone.utc).timestamp() - 30 * 60
    existing = await db.payments.find_one({
        "user_id": user["id"], "provider": "biztranspay",
        "channel": "crypto", "status": "pending",
    }, sort=[("created_at", -1)])
    if existing and existing.get("deposit_address") \
            and existing.get("created_at") \
            and existing["created_at"].timestamp() > fresh_cutoff:
        return {
            "reference": existing["reference"],
            "provider_intent_id": existing.get("provider_intent_id"),
            "deposit_address": existing["deposit_address"],
            "qr_data": existing.get("qr_data"),
            "amount": existing.get("amount"),
            "asset_code": existing.get("asset_code") or cfg["activation_asset_code"],
            "network": existing.get("network") or cfg["activation_network"],
        }

    reference = f"SPLV_BTPCR_{user['id'][:8]}_{uuid.uuid4().hex[:8]}"
    payload = {
        "amount": float(cfg["activation_amount_usdt"]),
        "asset_code": cfg["activation_asset_code"],
        "full_name": user.get("username") or "SPILOVEURE User",
        "email": user.get("email") or "user@spiloveure.com",
        # `refund_address` requis par la doc — on met un placeholder générique
        # que l'utilisateur ne verra pas (les remboursements crypto passent
        # par un contact support explicite en production).
        "refund_address": "SUPPORT_REQUIRED",
    }
    try:
        r = await _http("POST", cfg, "/deposits/crypto",
                        json_body=payload, idempotency_key=reference)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("biztranspay crypto create failed: %s", e)
        raise HTTPException(502, "Impossible de contacter BizTransPay. Réessayez.")
    if r.status_code >= 400:
        log.error("biztranspay crypto %s: %s", r.status_code, r.text[:400])
        raise HTTPException(400, _biztp_error(r))

    intent = r.json() or {}
    intent_id = intent.get("transaction_id") or intent.get("id")
    address = intent.get("address") or intent.get("deposit_address")
    qr_data = intent.get("qr_data") or intent.get("qr")
    if not intent_id or not address:
        log.error("biztranspay crypto: missing intent_id/address in %s", str(intent)[:400])
        raise HTTPException(502, "Réponse invalide de BizTransPay (adresse manquante).")

    now = datetime.now(timezone.utc)
    await db.payments.insert_one({
        "reference": reference,
        "provider": "biztranspay",
        "channel": "crypto",
        "provider_intent_id": intent_id,
        "user_id": user["id"], "level": 1,
        "kind": "activation",
        "status": "pending",
        "amount": float(cfg["activation_amount_usdt"]),
        "currency": "USDT",
        "asset_code": cfg["activation_asset_code"],
        "network": cfg["activation_network"],
        "deposit_address": address,
        "qr_data": qr_data,
        "activation_done": False,
        "created_at": now, "updated_at": now,
    })
    await db.activations.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "username": user.get("username"),
        "email": user.get("email"),
        "level": 1, "status": "pending", "payment_method": "biztranspay_crypto",
        "reference": reference, "amount": float(cfg["activation_amount_usdt"]),
        "currency": "USDT", "provider_intent_id": intent_id,
        "created_at": now,
    })
    return {
        "reference": reference,
        "provider_intent_id": intent_id,
        "deposit_address": address,
        "qr_data": qr_data,
        "amount": float(cfg["activation_amount_usdt"]),
        "asset_code": cfg["activation_asset_code"],
        "network": cfg["activation_network"],
    }


# ────────────────────────────────────────────────────────────────────────
# STATUS / POLLING
# ────────────────────────────────────────────────────────────────────────
async def _fetch_transaction(cfg: dict, intent_id: str) -> Optional[dict]:
    try:
        r = await _http("GET", cfg, f"/transactions/{intent_id}")
    except Exception as e:
        log.warning("biztranspay fetch transaction failed: %s", e)
        return None
    if r.status_code >= 400:
        log.warning("biztranspay transaction GET %s: %s", r.status_code, r.text[:200])
        return None
    return r.json() or {}


async def _apply_activation(db, pay: dict, provider_tx: dict) -> dict:
    """Idempotent single-shot activation from a completed payment."""
    tx_hash = provider_tx.get("tx_hash") or provider_tx.get("hash") or None
    claimed = await db.payments.find_one_and_update(
        {"reference": pay["reference"], "activation_done": {"$ne": True}},
        {"$set": {"status": "paid", "activation_done": True,
                  "paid_at": datetime.now(timezone.utc),
                  "tx_hash": tx_hash,
                  "updated_at": datetime.now(timezone.utc)}},
        return_document=True,
    )
    if not claimed:
        return {"ok": True, "activated": True, "already_activated": True}
    await db.activations.update_one(
        {"reference": pay["reference"], "status": "pending"},
        {"$set": {"status": "validated",
                  "validated_at": datetime.now(timezone.utc),
                  "validated_by": "auto:biztranspay",
                  "tx_hash": tx_hash}},
    )
    try:
        await activate_level(db, pay["user_id"], 1, source="biztranspay")
    except Exception as e:
        log.exception("biztranspay activate_level failed for ref=%s: %s",
                      pay["reference"], e)
        return {"ok": False, "activated": False,
                "message": "Activation impossible côté SPILOVEURE. Contactez le support."}
    try:
        from push_helper import push_to_user
        await push_to_user(
            db, pay["user_id"],
            title="🎉 Paiement confirmé",
            body="Votre compte SPILOVEURE est maintenant activé. Bienvenue !",
            link="/(app)/dashboard",
            data={"kind": "activation_completed", "reference": pay["reference"]},
            tag=f"btp-act-{pay['reference']}",
        )
    except Exception:
        pass
    return {"ok": True, "activated": True,
            "message": "Paiement confirmé. Votre compte est activé au Niveau 1."}


@api.get("/payments/biztranspay/status/{reference}")
async def biztranspay_status(reference: str, request: Request, user=Depends(get_current_user)):
    """Polling endpoint (frontend calls every 15s)."""
    db = request.app.state.db
    cfg = await _load_config(db)
    pay = await db.payments.find_one({"reference": reference, "provider": "biztranspay"})
    if not pay:
        raise HTTPException(404, "Demande introuvable.")
    if pay.get("user_id") != user["id"]:
        raise HTTPException(403, "Interdit.")
    if pay.get("activation_done"):
        return {"status": "completed", "activated": True,
                "deposit_address": pay.get("deposit_address"),
                "qr_data": pay.get("qr_data")}

    intent_id = pay.get("provider_intent_id")
    if not intent_id:
        return {"status": "pending", "activated": False}
    tx = await _fetch_transaction(cfg, intent_id) or {}
    status = str(tx.get("status") or "").lower()
    if status == "completed":
        result = await _apply_activation(db, pay, tx)
        return {"status": "completed", "activated": bool(result.get("activated")),
                "message": result.get("message"),
                "deposit_address": pay.get("deposit_address"),
                "qr_data": pay.get("qr_data")}
    if status == "failed":
        await db.payments.update_one(
            {"reference": reference, "status": "pending"},
            {"$set": {"status": "failed", "updated_at": datetime.now(timezone.utc)}},
        )
        return {"status": "failed", "activated": False,
                "message": "Paiement échoué. Recommencez si nécessaire."}
    return {"status": status or "pending", "activated": False,
            "deposit_address": pay.get("deposit_address"),
            "qr_data": pay.get("qr_data")}


# ────────────────────────────────────────────────────────────────────────
# WEBHOOKS (HMAC-SHA256 signature + replay protection)
# ────────────────────────────────────────────────────────────────────────
def _verify_signature(secret: str, raw_body: bytes, timestamp: str, signature: str) -> bool:
    if not secret or not signature or not timestamp:
        return False
    try:
        # BizTransPay envoie soit "sha256=<hex>", soit "<hex>". On accepte les deux.
        provided = signature.lower().split("sha256=", 1)[-1].strip()
        payload = f"{timestamp}.".encode() + raw_body
        expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(provided, expected)
    except Exception:
        return False


@webhook.api_route("/biztranspay", methods=["GET", "HEAD", "OPTIONS"])
async def biztranspay_webhook_ping():
    """Endpoint de validation d'URL pour BizTransPay.

    De nombreux services de webhooks (dont BizTransPay) vérifient l'URL par un
    GET/HEAD/OPTIONS avant de commencer à envoyer les vrais événements. Notre
    handler principal (POST) refuse ces méthodes → 405. Le reverse-proxy K8s
    traduit parfois ce 405 en 404/403, ce qui casse la validation.

    Ce handler renvoie systématiquement 200 pour toute méthode non-POST — sans
    exposer aucune donnée interne. La sécurité reste garantie côté POST par la
    vérification HMAC-SHA256 (voir `biztranspay_webhook`).
    """
    return {"ok": True, "service": "biztranspay", "protocol": "spilv-webhook-v1"}


@webhook.post("/biztranspay")
async def biztranspay_webhook(request: Request):
    db = request.app.state.db
    cfg = await _load_config(db)
    raw_body = await request.body()

    sig = request.headers.get("X-BizTransPay-Signature") \
        or request.headers.get("x-biztranspay-signature") or ""
    ts = request.headers.get("X-BizTransPay-Timestamp") \
        or request.headers.get("x-biztranspay-timestamp") or ""
    event_id = request.headers.get("X-BizTransPay-Event-Id") \
        or request.headers.get("x-biztranspay-event-id") or ""

    if not _verify_signature(cfg.get("webhook_secret") or "", raw_body, ts, sig):
        log.warning("biztranspay webhook: signature invalide (event=%s ts=%s)", event_id, ts)
        raise HTTPException(401, "Signature invalide.")

    # Replay protection : reject old timestamps.
    try:
        drift = abs(time.time() - float(ts))
    except (TypeError, ValueError):
        drift = 999999
    window = int(cfg.get("webhook_replay_window_sec") or 300)
    if drift > window:
        log.warning("biztranspay webhook: timestamp trop ancien (drift=%.0fs)", drift)
        raise HTTPException(400, "Timestamp trop ancien.")

    # Event-Id dedupe : store & reject repeats.
    if event_id:
        already = await db.biztranspay_webhook_events.find_one({"event_id": event_id})
        if already:
            return {"ok": True, "replayed": True}
        try:
            await db.biztranspay_webhook_events.insert_one({
                "event_id": event_id, "received_at": datetime.now(timezone.utc),
            })
        except Exception:
            pass

    import json as _json
    try:
        body = _json.loads(raw_body or b"{}")
    except Exception:
        raise HTTPException(400, "JSON invalide.")

    event = str(body.get("event") or "").lower()
    data = body.get("data") or {}
    intent_id = data.get("id") or data.get("transaction_id")
    if not intent_id:
        return {"ok": True, "ignored": "no transaction id"}

    # Store the raw event for audit.
    try:
        await db.biztranspay_webhook_logs.insert_one({
            "id": str(uuid.uuid4()),
            "event": event, "event_id": event_id, "intent_id": intent_id,
            "payload": body, "received_at": datetime.now(timezone.utc),
        })
    except Exception:
        pass

    # Find our matching row (payment OR withdrawal).
    pay = await db.payments.find_one(
        {"provider_intent_id": intent_id, "provider": "biztranspay"}
    )
    if pay:
        if event == "transaction.completed":
            await _apply_activation(db, pay, data)
        elif event == "transaction.failed":
            await db.payments.update_one(
                {"provider_intent_id": intent_id, "status": "pending"},
                {"$set": {"status": "failed", "updated_at": datetime.now(timezone.utc)}},
            )
        return {"ok": True, "handled": "payment", "event": event}

    wd = await db.withdrawals.find_one(
        {"gateway_intent_id": intent_id, "gateway": "biztranspay"}
    )
    if wd:
        await _apply_withdrawal_status(db, wd, event, data)
        return {"ok": True, "handled": "withdrawal", "event": event}

    return {"ok": True, "ignored": "no match"}


# ────────────────────────────────────────────────────────────────────────
# WITHDRAWALS — auto dispatch (called from server.py::request_withdrawal)
# ────────────────────────────────────────────────────────────────────────
async def dispatch_auto_withdrawal(db, wd: dict) -> dict:
    """Automatically dispatch a withdrawal via BizTransPay.

    Called by `server.py::request_withdrawal` right after the withdrawal row
    is created, IF the admin toggle is ON for the target channel.

    Returns a status dict; the caller uses it to enrich the response.
    Never raises — on failure the withdrawal simply stays "pending" for
    manual admin validation.
    """
    cfg = await _load_config(db)
    if not (cfg.get("enabled") and cfg.get("public_key") and cfg.get("secret_key")):
        return {"auto_dispatched": False, "reason": "biztranspay_disabled"}

    method = (wd.get("method") or "").lower()
    is_mobile = method in ("mobile", "mobile_money", "mm")
    is_crypto = method == "crypto"
    if is_mobile and not cfg.get("auto_withdraw_mobile"):
        return {"auto_dispatched": False, "reason": "auto_mobile_off"}
    if is_crypto and not cfg.get("auto_withdraw_crypto"):
        return {"auto_dispatched": False, "reason": "auto_crypto_off"}
    if not (is_mobile or is_crypto):
        return {"auto_dispatched": False, "reason": "unsupported_method"}

    # Build payload. Amount = net_payout (fee already deducted).
    amount = float(wd.get("net_payout") or wd.get("amount") or 0)
    if amount <= 0:
        return {"auto_dispatched": False, "reason": "invalid_amount"}

    cc = (wd.get("country") or "").upper()
    if is_mobile:
        # Try to derive an operator code from the display name + country.
        country_info = COUNTRIES.get(cc)
        op_display = (wd.get("operator") or "").strip()
        op_code = None
        if country_info:
            for lbl, code in country_info["operators"]:
                if lbl.lower() == op_display.lower():
                    op_code = code
                    break
        if not op_code:
            # As a last-resort fallback we send the display name verbatim —
            # BizTransPay may accept it, otherwise it returns a clear error
            # that the admin sees on the manual fallback path.
            op_code = op_display.lower().replace(" ", "_") + f"_{cc.lower()}" if cc else op_display
        payload = {
            "transfer_type": "biz_to_mobile",
            "recipient": _normalize_phone(wd.get("phone") or "", cc),
            "country": cc,
            "operator": op_code,
            "amount": amount,
            "currency": "XOF" if not country_info else country_info["currency"],
            "full_name": wd.get("full_name") or "",
        }
    else:
        # crypto
        network = (wd.get("network") or "USDT BEP20").upper().replace(" ", "")
        # e.g. "USDTBEP20" → asset_code "USDT.BEP20"
        if "USDT" in network and "BEP20" in network:
            asset_code = "USDT.BEP20"
        elif "USDT" in network and "TRC20" in network:
            asset_code = "USDT.TRC20"
        else:
            asset_code = network  # send verbatim
        payload = {
            "transfer_type": "biz_to_crypto",
            "recipient": wd.get("wallet_address") or "",
            "asset_code": asset_code,
            "amount": amount,
            "currency": "USDT",
            "country": cc or "TG",
            "full_name": wd.get("full_name") or "",
        }

    idem = f"wd_{wd['id']}"
    try:
        r = await _http("POST", cfg, "/withdrawals",
                        json_body=payload, idempotency_key=idem)
    except Exception as e:
        log.exception("biztranspay withdrawal dispatch failed: %s", e)
        return {"auto_dispatched": False, "reason": "gateway_unreachable"}
    if r.status_code >= 400:
        log.error("biztranspay withdrawals %s: %s", r.status_code, r.text[:400])
        # Mark withdrawal as needing manual attention but keep pending so
        # the admin can validate/reject like before.
        await db.withdrawals.update_one(
            {"id": wd["id"]},
            {"$set": {"auto_dispatch_error": _biztp_error(r),
                      "auto_dispatch_at": datetime.now(timezone.utc)}},
        )
        return {"auto_dispatched": False, "reason": "gateway_refused",
                "error": _biztp_error(r)}

    intent = r.json() or {}
    intent_id = intent.get("transaction_id") or intent.get("id")
    now = datetime.now(timezone.utc)
    await db.withdrawals.update_one(
        {"id": wd["id"]},
        {"$set": {
            "status": "dispatched",
            "gateway": "biztranspay",
            "gateway_channel": "mobile" if is_mobile else "crypto",
            "gateway_intent_id": intent_id,
            "gateway_status": intent.get("status") or "pending",
            "dispatched_at": now, "dispatched_by": "auto:biztranspay",
        }},
    )
    await db.users.update_one(
        {"id": wd["user_id"]},
        {"$inc": {"total_withdrawn": float(wd.get("amount") or 0)}},
    )
    return {"auto_dispatched": True, "gateway_intent_id": intent_id,
            "gateway_status": intent.get("status") or "pending"}


async def _apply_withdrawal_status(db, wd: dict, event: str, data: dict):
    """Reconcile a withdrawal from a webhook payload."""
    status = str(data.get("status") or "").lower() or event.split(".")[-1]
    now = datetime.now(timezone.utc)
    if status == "completed":
        await db.withdrawals.update_one(
            {"id": wd["id"], "status": {"$ne": "completed"}},
            {"$set": {"status": "completed", "completed_at": now,
                      "gateway_status": "completed"}},
        )
        try:
            from push_helper import push_to_user
            await push_to_user(
                db, wd["user_id"],
                title="✅ Retrait payé",
                body=f"Votre retrait de {int(wd.get('net_payout') or wd.get('amount') or 0):,} FCFA a été envoyé.".replace(",", " "),
                link="/(app)/withdrawal",
                data={"kind": "withdrawal_completed", "wd_id": wd["id"]},
            )
        except Exception:
            pass
    elif status == "failed":
        # Refund the balance if not already refunded.
        already = await db.withdrawals.find_one_and_update(
            {"id": wd["id"], "status": {"$nin": ["failed", "rejected"]}},
            {"$set": {"status": "failed", "failed_at": now,
                      "gateway_status": "failed"}},
            return_document=True,
        )
        if already:
            await db.users.update_one(
                {"id": wd["user_id"]},
                {"$inc": {"balance_profit": float(wd.get("amount") or 0),
                          "total_withdrawn": -float(wd.get("amount") or 0)}},
            )
    else:
        await db.withdrawals.update_one(
            {"id": wd["id"]},
            {"$set": {"gateway_status": status, "updated_at": now}},
        )


# ────────────────────────────────────────────────────────────────────────
# ADMIN CONFIG endpoints
# ────────────────────────────────────────────────────────────────────────
class ConfigIn(BaseModel):
    enabled: Optional[bool] = None
    public_key: Optional[str] = None
    secret_key: Optional[str] = None
    webhook_secret: Optional[str] = None
    base_url: Optional[str] = None
    mode: Optional[str] = None
    activation_amount_xof: Optional[float] = None
    activation_amount_usdt: Optional[float] = None
    activation_network: Optional[str] = None
    activation_asset_code: Optional[str] = None
    auto_withdraw_mobile: Optional[bool] = None
    auto_withdraw_crypto: Optional[bool] = None


@admin.get("/payments/biztranspay/config")
async def admin_get_config(request: Request):
    cfg = await _load_config(request.app.state.db)
    return {
        "enabled": bool(cfg["enabled"]),
        "public_key": cfg.get("public_key") or "",   # public key is not secret
        "secret_key_masked": _mask(cfg.get("secret_key") or ""),
        "secret_key_set": bool(cfg.get("secret_key")),
        "webhook_secret_masked": _mask(cfg.get("webhook_secret") or ""),
        "webhook_secret_set": bool(cfg.get("webhook_secret")),
        "base_url": cfg["base_url"],
        "mode": cfg["mode"],
        "activation_amount_xof": float(cfg["activation_amount_xof"]),
        "activation_amount_usdt": float(cfg["activation_amount_usdt"]),
        "activation_network": cfg["activation_network"],
        "activation_asset_code": cfg["activation_asset_code"],
        "auto_withdraw_mobile": bool(cfg.get("auto_withdraw_mobile")),
        "auto_withdraw_crypto": bool(cfg.get("auto_withdraw_crypto")),
    }


@admin.put("/payments/biztranspay/config")
async def admin_set_config(body: ConfigIn, request: Request):
    db = request.app.state.db
    upd = await _load_config(db)
    if body.enabled is not None:
        upd["enabled"] = bool(body.enabled)
    if body.public_key is not None and body.public_key.strip():
        upd["public_key"] = body.public_key.strip()
    if body.secret_key is not None and body.secret_key.strip():
        upd["secret_key"] = body.secret_key.strip()
    if body.webhook_secret is not None and body.webhook_secret.strip():
        upd["webhook_secret"] = body.webhook_secret.strip()
    if body.base_url and body.base_url.strip():
        upd["base_url"] = body.base_url.strip().rstrip("/")
    if body.mode in ("test", "live"):
        upd["mode"] = body.mode
    if body.activation_amount_xof is not None and body.activation_amount_xof > 0:
        upd["activation_amount_xof"] = float(body.activation_amount_xof)
    if body.activation_amount_usdt is not None and body.activation_amount_usdt > 0:
        upd["activation_amount_usdt"] = float(body.activation_amount_usdt)
    if body.activation_network and body.activation_network.strip():
        upd["activation_network"] = body.activation_network.strip().upper()
    if body.activation_asset_code and body.activation_asset_code.strip():
        upd["activation_asset_code"] = body.activation_asset_code.strip().upper()
    if body.auto_withdraw_mobile is not None:
        upd["auto_withdraw_mobile"] = bool(body.auto_withdraw_mobile)
    if body.auto_withdraw_crypto is not None:
        upd["auto_withdraw_crypto"] = bool(body.auto_withdraw_crypto)
    await db.app_settings.update_one(
        {"key": "biztranspay"}, {"$set": {"value": upd}}, upsert=True,
    )
    return {"ok": True}
