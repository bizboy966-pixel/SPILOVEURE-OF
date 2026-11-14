"""MoneyFusion Mobile Money integration.

Pay-in and payout stay disabled until an administrator configures the
merchant credentials, confirms the pay-in currency behavior, and enables
the relevant countries/operators. Provider callbacks are only hints: final
states are always fetched from MoneyFusion before applying account changes.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin
from matrix import activate_level

log = logging.getLogger("moneyfusion")

API_ROOT = "https://pay.moneyfusion.net"
METHODS_URL = f"{API_ROOT}/api/v1/withdraw/methods"
PAYOUT_URL = f"{API_ROOT}/api/v1/withdraw"
PAYIN_STATUS_URL = f"{API_ROOT}/paiementNotif"
PAYOUT_STATUS_URL = f"{API_ROOT}/api/v1/payout/check-status"
CATALOG_CACHE_SECONDS = 3600
ACTIVATION_FEE_XOF = 2650
PAYIN_PROVIDER = "moneyfusion"

api = APIRouter(prefix="/api/payments/moneyfusion", tags=["moneyfusion"])
webhooks = APIRouter(prefix="/api/webhooks/moneyfusion", tags=["moneyfusion-webhooks"])
admin = APIRouter(
    prefix="/api/admin/payment-gateways/moneyfusion",
    tags=["moneyfusion-admin"],
    dependencies=[Depends(require_admin)],
)

# Only required when formatting a country-local number for the MoneyFusion
# examples, which accept a local phone number rather than an E.164 value.
DIAL_CODES = {
    "BF": "226", "BJ": "229", "CD": "243", "CF": "236", "CG": "242",
    "CI": "225", "CM": "237", "GA": "241", "GH": "233", "GN": "224",
    "GW": "245", "KE": "254", "ML": "223", "NE": "227", "SN": "221",
    "TD": "235", "TG": "228",
}

DEFAULT_CONFIG = {
    "payin_enabled": False,
    "payout_enabled": False,
    # MoneyFusion's pay-in documentation exposes no currency parameter.
    # Require an explicit merchant-side confirmation before accepting charges.
    "payin_local_currency_confirmed": False,
    "rates_per_xof": {"XOF": 1.0, "XAF": 1.0},
}


def _now():
    return datetime.now(timezone.utc)


async def load_config(db) -> dict:
    doc = await db.app_settings.find_one({"key": "moneyfusion_config"}) or {}
    stored = doc.get("value") if isinstance(doc.get("value"), dict) else {}
    cfg = {**DEFAULT_CONFIG, **stored}
    rates = dict(DEFAULT_CONFIG["rates_per_xof"])
    rates.update(cfg.get("rates_per_xof") or {})
    cfg["rates_per_xof"] = rates
    return cfg


def _encryption_key() -> bytes:
    secret = (os.environ.get("SESSION_SECRET") or "").encode("utf-8")
    if len(secret) < 24:
        raise RuntimeError("SESSION_SECRET must be configured to store MoneyFusion credentials securely.")
    return hashlib.sha256(b"spiloveure-moneyfusion-v1:" + secret).digest()


def _encrypt(value: str) -> str:
    nonce = os.urandom(12)
    ciphertext = AESGCM(_encryption_key()).encrypt(nonce, value.encode("utf-8"), b"moneyfusion-v1")
    return "v1:" + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def _decrypt(value: str) -> str:
    if not value or not value.startswith("v1:"):
        return ""
    raw = base64.urlsafe_b64decode(value[3:].encode("ascii"))
    plaintext = AESGCM(_encryption_key()).decrypt(raw[:12], raw[12:], b"moneyfusion-v1")
    return plaintext.decode("utf-8")


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    return "••••••••" + value[-4:] if len(value) > 4 else "••••"


async def load_credentials(db) -> dict:
    doc = await db.app_settings.find_one({"key": "moneyfusion_credentials"}) or {}
    value = doc.get("value") if isinstance(doc.get("value"), dict) else {}
    try:
        return {
            "payin_api_url": _decrypt(value.get("payin_api_url_enc") or ""),
            "payout_private_key": _decrypt(value.get("payout_private_key_enc") or ""),
        }
    except Exception:
        log.error("MoneyFusion credentials cannot be decrypted; verify SESSION_SECRET.")
        return {"payin_api_url": "", "payout_private_key": ""}


def _valid_payin_api_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return parsed.scheme == "https" and (
            host == "pay.moneyfusion.net" or host.endswith(".moneyfusion.net")
        )
    except Exception:
        return False


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", str(phone or ""))


def _local_phone(phone: str, country: str) -> str:
    digits = _digits(phone)
    dial = DIAL_CODES.get(country.upper(), "")
    if dial and digits.startswith(dial):
        digits = digits[len(dial):]
    return digits.lstrip("0") if digits.startswith("00") else digits


def _rate_for(cfg: dict, currency: str) -> Optional[float]:
    try:
        rate = float((cfg.get("rates_per_xof") or {}).get(currency.upper()))
        return rate if 0 < rate < 1_000_000 else None
    except (TypeError, ValueError):
        return None


def _amount_from_xof(cfg: dict, amount_xof: float, currency: str) -> Optional[int]:
    rate = _rate_for(cfg, currency)
    if rate is None:
        return None
    amount = int(round(float(amount_xof) * rate))
    return amount if amount > 0 else None


def _safe_checkout_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return parsed.scheme == "https" and host in {
            "payin.moneyfusion.net", "pay.moneyfusion.net",
        }
    except Exception:
        return False


async def fetch_methods() -> list[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(METHODS_URL, headers={"User-Agent": "SPILOVEURE-MoneyFusion/1.0"})
        response.raise_for_status()
        payload = response.json()
    if payload.get("success") is not True or not isinstance(payload.get("data"), list):
        raise RuntimeError("MoneyFusion returned an invalid methods catalogue.")
    result = []
    for country in payload["data"]:
        cc = str(country.get("code") or "").upper()
        currency = str(country.get("currency") or "").upper()
        if not cc or not currency:
            continue
        operators = []
        for method in country.get("paymentMethods") or []:
            key = str(method.get("key") or "").strip()
            name = str(method.get("name") or key).strip()
            if key:
                operators.append({"code": key, "label": name})
        result.append({
            "country_code": cc,
            "country": str(country.get("country") or cc),
            "currency": currency,
            "operators": operators,
        })
    return result


async def sync_catalog(db, entries: list[dict]) -> None:
    """Persist live payout methods; newly discovered methods default OFF."""
    now = _now()
    for country in entries:
        cc = country["country_code"]
        await db.payment_provider_countries.update_one(
            {"provider_id": PAYIN_PROVIDER, "country_code": cc},
            {"$setOnInsert": {
                "provider_id": PAYIN_PROVIDER, "country_code": cc,
                "country_name": country["country"], "currency": country["currency"],
                "status": "inactive", "mode": "automatic", "priority": 4,
                "source": "moneyfusion_live_methods", "created_at": now,
            }, "$set": {"country_name": country["country"],
                        "currency": country["currency"], "updated_at": now}},
            upsert=True,
        )
        for operator in country["operators"]:
            await db.payment_provider_operators.update_one(
                {"provider_id": PAYIN_PROVIDER, "country_code": cc,
                 "operator_code": operator["code"]},
                {"$setOnInsert": {
                    "provider_id": PAYIN_PROVIDER, "country_code": cc,
                    "operator_code": operator["code"],
                    "operator_label": operator["label"], "status": "inactive",
                    "source": "moneyfusion_live_methods", "created_at": now,
                }, "$set": {"operator_label": operator["label"], "updated_at": now}},
                upsert=True,
            )
    await db.app_settings.update_one(
        {"key": "moneyfusion_catalog"},
        {"$set": {"key": "moneyfusion_catalog", "value": entries,
                  "updated_at": now}},
        upsert=True,
    )


async def refresh_catalog(db, *, force: bool = False) -> list[dict]:
    cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    updated = cached.get("updated_at")
    if not force and isinstance(updated, datetime) and (_now() - updated).total_seconds() < CATALOG_CACHE_SECONDS:
        value = cached.get("value")
        if isinstance(value, list) and value:
            return value
    entries = await fetch_methods()
    await sync_catalog(db, entries)
    return entries


async def sync_provider(db) -> None:
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    enabled_payin = bool(cfg.get("payin_enabled") and cfg.get("payin_local_currency_confirmed")
                         and credentials.get("payin_api_url"))
    enabled_payout = bool(cfg.get("payout_enabled") and credentials.get("payout_private_key"))
    now = _now()
    await db.payment_providers.update_one(
        {"id": PAYIN_PROVIDER},
        {"$set": {
            "id": PAYIN_PROVIDER, "name": "MoneyFusion",
            "type": "mobile_money",
            "status": "active" if enabled_payin or enabled_payout else "inactive",
            "auto_deposit": enabled_payin,
            "auto_withdrawal": enabled_payout,
            "priority": 4, "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    if isinstance(cached.get("value"), list):
        await sync_catalog(db, cached["value"])


def _normalize_operator(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


async def _active_catalog_country(db, country_code: str) -> Optional[dict]:
    return await db.payment_provider_countries.find_one(
        {"provider_id": PAYIN_PROVIDER, "country_code": country_code.upper(),
         "status": "active"}, {"_id": 0},
    )


async def _active_operator_for_label(db, country: str, label: str, methods: list[dict]) -> Optional[dict]:
    norm = _normalize_operator(label)
    catalog = next((c for c in methods if c["country_code"] == country.upper()), None)
    if not catalog:
        return None
    operator = next((o for o in catalog["operators"]
                     if norm in {_normalize_operator(o["code"]), _normalize_operator(o["label"])}
                     or _normalize_operator(o["label"]) in norm), None)
    if not operator:
        return None
    return await db.payment_provider_operators.find_one(
        {"provider_id": PAYIN_PROVIDER, "country_code": country.upper(),
         "operator_code": operator["code"], "status": "active"},
        {"_id": 0},
    )


async def _verify_payin(db, payment: dict) -> dict:
    token = payment.get("provider_token")
    if not token:
        return {}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{PAYIN_STATUS_URL}/{token}")
        response.raise_for_status()
        return response.json()


async def _apply_paid_activation(db, payment: dict, verified: dict) -> dict:
    data = (verified or {}).get("data") or {}
    provider_status = str(data.get("statut") or "").strip().lower()
    if provider_status != "paid":
        return {"status": "pending"}
    if str(data.get("tokenPay") or "") != str(payment.get("provider_token") or ""):
        return {"status": "pending"}
    try:
        provider_amount = float(data.get("Montant"))
        expected_amount = float(payment.get("amount"))
    except (TypeError, ValueError):
        return {"status": "pending"}
    if abs(provider_amount - expected_amount) > 0.01:
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "review", "verification_error": "amount_mismatch",
                      "updated_at": _now()}},
        )
        return {"status": "review"}

    # Compare the submitted and verified phone numbers without requiring the
    # provider to preserve punctuation or a leading country prefix.
    expected_phone = _digits(payment.get("phone") or "")
    received_phone = _digits(data.get("numeroSend") or "")
    if expected_phone and received_phone and not (
        expected_phone.endswith(received_phone) or received_phone.endswith(expected_phone)
    ):
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "review", "verification_error": "phone_mismatch",
                      "updated_at": _now()}},
        )
        return {"status": "review"}

    claim = await db.payments.update_one(
        {"reference": payment["reference"], "activation_done": {"$ne": True},
         "activation_claimed": {"$ne": True}},
        {"$set": {"status": "paid", "activation_claimed": True,
                  "updated_at": _now()}},
    )
    if claim.modified_count == 0:
        latest = await db.payments.find_one({"reference": payment["reference"]}, {"_id": 0})
        return {"status": "paid" if latest and latest.get("activation_done") else "pending"}
    try:
        await activate_level(db, payment["user_id"], int(payment.get("level") or 1),
                             source="moneyfusion")
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "validated", "activation_done": True,
                      "activation_claimed": False, "paid_at": _now(), "updated_at": _now()},
             "$unset": {"activation_error": ""}},
        )
        return {"status": "paid", "activation_done": True}
    except Exception as exc:
        log.exception("MoneyFusion activation failed for reference=%s", payment["reference"])
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "paid", "activation_claimed": False,
                      "activation_error": str(exc)[:300], "updated_at": _now()}},
        )
        return {"status": "paid", "activation_done": False}


class PayInRequest(BaseModel):
    level: int = 1
    phone: str = Field(min_length=6, max_length=32)
    country_code: str = Field(min_length=2, max_length=3)


@api.get("/catalog")
async def public_catalog(request: Request):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    enabled = bool(cfg.get("payin_enabled") and cfg.get("payin_local_currency_confirmed")
                   and credentials.get("payin_api_url"))
    try:
        methods = await refresh_catalog(db)
    except Exception:
        methods = (await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}).get("value") or []
    countries = []
    if enabled:
        for entry in methods:
            country = await _active_catalog_country(db, entry["country_code"])
            if not country:
                continue
            ops = []
            async for op in db.payment_provider_operators.find(
                {"provider_id": PAYIN_PROVIDER, "country_code": entry["country_code"],
                 "status": "active"}, {"_id": 0},
            ):
                ops.append(op)
            # The hosted checkout does not accept an operator field. Do not
            # expose a country unless every listed operator remains enabled.
            if ops and len(ops) == len(entry["operators"]):
                rate = _rate_for(cfg, entry["currency"])
                amount = _amount_from_xof(cfg, ACTIVATION_FEE_XOF, entry["currency"])
                if amount is not None:
                    countries.append({
                        "country_code": entry["country_code"],
                        "country": entry["country"], "currency": entry["currency"],
                        "amount": amount, "operators": entry["operators"],
                    })
    return {
        "enabled": bool(countries),
        "currency_confirmed": bool(cfg.get("payin_local_currency_confirmed")),
        "countries": countries,
    }


@api.post("/initiate")
async def initiate_payin(data: PayInRequest, request: Request,
                         user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    if not cfg.get("payin_enabled") or not cfg.get("payin_local_currency_confirmed"):
        raise HTTPException(503, "MoneyFusion Pay-in est désactivé : la devise locale doit d’abord être confirmée dans le panneau administrateur.")
    api_url = credentials.get("payin_api_url") or ""
    if not _valid_payin_api_url(api_url):
        raise HTTPException(503, "L’adresse API Pay-in MoneyFusion n’est pas configurée.")
    country_code = data.country_code.upper()
    country = await _active_catalog_country(db, country_code)
    if not country:
        raise HTTPException(400, "Ce pays n’est pas activé pour MoneyFusion.")
    methods = await refresh_catalog(db)
    country_methods = next((c for c in methods if c["country_code"] == country_code), None)
    if not country_methods:
        raise HTTPException(400, "MoneyFusion ne propose aucun opérateur pour ce pays.")
    enabled_ops = await db.payment_provider_operators.count_documents(
        {"provider_id": PAYIN_PROVIDER, "country_code": country_code, "status": "active"}
    )
    if enabled_ops != len(country_methods["operators"]) or enabled_ops == 0:
        raise HTTPException(400, "Activez tous les opérateurs du pays dans le panneau administrateur : le choix final se fait sur la page MoneyFusion.")
    currency = country_methods["currency"]
    amount = _amount_from_xof(cfg, ACTIVATION_FEE_XOF, currency)
    if amount is None:
        raise HTTPException(400, f"Le taux de conversion {currency}/XOF n’est pas configuré.")
    level = int(data.level)
    if level != 1:
        raise HTTPException(400, "MoneyFusion est configuré uniquement pour l’activation du Niveau 1.")
    if level <= int(user.get("max_level") or 0):
        raise HTTPException(400, "Ce niveau est déjà activé.")
    if not _local_phone(data.phone, country_code):
        raise HTTPException(400, "Numéro Mobile Money invalide.")
    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    if not public_url.startswith("https://"):
        raise HTTPException(503, "PUBLIC_APP_URL doit contenir l’adresse HTTPS publique du site.")

    reference = f"SPV-MF-{uuid.uuid4().hex[:12].upper()}"
    now = _now()
    payment = {
        "reference": reference, "provider": PAYIN_PROVIDER,
        "user_id": user["id"], "username": user.get("username"),
        "level": level, "amount": amount, "currency": currency,
        "base_amount_xof": ACTIVATION_FEE_XOF,
        "fx_rate_per_xof": _rate_for(cfg, currency),
        "phone": _local_phone(data.phone, country_code),
        "country_code": country_code, "status": "pending",
        "activation_done": False, "created_at": now, "updated_at": now,
    }
    await db.payments.insert_one(payment)
    payload = {
        "totalPrice": amount,
        "article": [{"Activation SPILOVEURE Niveau 1": amount}],
        "numeroSend": payment["phone"],
        "nomclient": str(user.get("full_name") or user.get("username") or "SPILOVEURE user")[:120],
        "personal_Info": [{"userId": user["id"], "orderId": reference,
                           "country": country_code, "currency": currency}],
        "return_url": f"{public_url}/activation",
        "webhook_url": f"{public_url}/api/webhooks/moneyfusion/payin",
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(api_url, json=payload,
                                         headers={"Content-Type": "application/json"})
        response.raise_for_status()
        result = response.json()
    except Exception:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "failed", "activation_error": "MoneyFusion initiation indisponible",
                      "updated_at": _now()}},
        )
        raise HTTPException(502, "Impossible de joindre MoneyFusion. Aucun paiement n’a été confirmé.")
    token = str(result.get("token") or "").strip()
    checkout_url = str(result.get("url") or "").strip()
    if result.get("statut") is not True or not token or not _safe_checkout_url(checkout_url):
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "failed", "activation_error": "Réponse MoneyFusion invalide",
                      "updated_at": _now()}},
        )
        raise HTTPException(502, "MoneyFusion n’a pas fourni une page de paiement valide.")
    await db.payments.update_one(
        {"reference": reference},
        {"$set": {"provider_token": token, "payment_url": checkout_url,
                  "provider_message": str(result.get("message") or "")[:200],
                  "updated_at": _now()}},
    )
    return {"reference": reference, "url": checkout_url, "amount": amount,
            "currency": currency, "status": "pending"}


@api.get("/status/{reference}")
async def payin_status(reference: str, request: Request,
                       user=Depends(get_current_user)):
    db = request.app.state.db
    payment = await db.payments.find_one(
        {"reference": reference, "provider": PAYIN_PROVIDER, "user_id": user["id"]},
        {"_id": 0},
    )
    if not payment:
        raise HTTPException(404, "Paiement introuvable.")
    if payment.get("activation_done"):
        return {"status": "paid", "activation_done": True}
    if not payment.get("provider_token"):
        return {"status": payment.get("status") or "pending"}
    try:
        verified = await _verify_payin(db, payment)
    except Exception:
        return {"status": "pending", "message": "Vérification MoneyFusion en attente."}
    outcome = await _apply_paid_activation(db, payment, verified)
    data = (verified or {}).get("data") or {}
    provider_status = str(data.get("statut") or "").lower()
    if outcome.get("status") == "pending" and provider_status in ("failure", "no paid", "cancelled"):
        await db.payments.update_one(
            {"reference": reference, "status": "pending"},
            {"$set": {"status": "failed", "updated_at": _now()}},
        )
        return {"status": "failed"}
    return outcome


async def _handle_payin_webhook(request: Request, body: dict) -> dict:
    db = request.app.state.db
    token = _find_token(body)
    if not token:
        return {"received": True, "ignored": True}
    payment = await db.payments.find_one(
        {"provider": PAYIN_PROVIDER, "provider_token": token}, {"_id": 0},
    )
    if not payment:
        return {"received": True, "ignored": True}
    try:
        verified = await _verify_payin(db, payment)
    except Exception:
        return {"received": True, "verified": False}
    result = await _apply_paid_activation(db, payment, verified)
    return {"received": True, "verified": True, "status": result.get("status")}


def _find_token(value) -> str:
    if isinstance(value, dict):
        for key in ("tokenPay", "token", "token_pay"):
            if isinstance(value.get(key), (str, int)):
                return str(value[key])
        for child in value.values():
            token = _find_token(child)
            if token:
                return token
    elif isinstance(value, list):
        for child in value:
            token = _find_token(child)
            if token:
                return token
    return ""


@webhooks.post("/payin")
async def payin_webhook(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    return await _handle_payin_webhook(request, body if isinstance(body, dict) else {})


async def dispatch_withdrawal(db, withdrawal: dict) -> dict:
    """Submit an approved-by-policy Mobile Money withdrawal exactly once.

    A timeout after submission is recorded as unknown; it is never retried
    automatically because the provider API documents no idempotency key.
    """
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    if not cfg.get("payout_enabled") or not credentials.get("payout_private_key"):
        return {"auto_dispatched": False, "reason": "not_configured"}
    if (withdrawal.get("method") or "").lower() not in ("mobile", "mobile_money", "mm"):
        return {"auto_dispatched": False, "reason": "not_mobile"}
    cc = str(withdrawal.get("country") or "").upper()
    country = await _active_catalog_country(db, cc)
    if not country:
        return {"auto_dispatched": False, "reason": "country_disabled"}
    methods = await refresh_catalog(db)
    selected = await _active_operator_for_label(
        db, cc, str(withdrawal.get("operator") or ""), methods,
    )
    if not selected:
        return {"auto_dispatched": False, "reason": "operator_disabled_or_unmapped"}
    catalog_country = next((c for c in methods if c["country_code"] == cc), None)
    if not catalog_country:
        return {"auto_dispatched": False, "reason": "country_unsupported"}
    currency = catalog_country["currency"]
    net_xof = float(withdrawal.get("net_payout") or withdrawal.get("amount") or 0)
    amount = _amount_from_xof(cfg, net_xof, currency)
    if amount is None:
        return {"auto_dispatched": False, "reason": "currency_rate_missing"}
    phone = _local_phone(str(withdrawal.get("phone") or ""), cc)
    if not phone:
        return {"auto_dispatched": False, "reason": "phone_missing"}

    wd_id = str(withdrawal["id"])
    existing = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    if existing:
        return {"auto_dispatched": bool(existing.get("tokenPay")),
                "reason": "already_submitted",
                "tokenPay": existing.get("tokenPay")}
    payout_row = {
        "wd_id": wd_id, "user_id": withdrawal.get("user_id"),
        "amount": amount, "amount_xof": net_xof, "currency": currency,
        "fx_rate_per_xof": _rate_for(cfg, currency),
        "country_code": cc, "operator_code": selected["operator_code"],
        "phone": phone, "status": "submitting", "created_at": _now(),
    }
    try:
        await db.moneyfusion_payouts.insert_one(payout_row)
    except Exception:
        return {"auto_dispatched": False, "reason": "submission_reserved"}

    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    payload = {
        "countryCode": cc.lower(), "phone": phone, "amount": amount,
        "withdraw_mode": selected["operator_code"],
        "webhook_url": f"{public_url}/api/webhooks/moneyfusion/payout" if public_url else "",
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                PAYOUT_URL, json=payload,
                headers={"moneyfusion-private-key": credentials["payout_private_key"],
                         "Content-Type": "application/json"},
            )
        response.raise_for_status()
        result = response.json()
    except Exception:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id, "status": "submitting"},
            {"$set": {"status": "unknown", "updated_at": _now()}},
        )
        await db.withdrawals.update_one(
            {"id": wd_id},
            {"$set": {"auto_dispatch_error": "MoneyFusion: résultat inconnu; vérification manuelle requise",
                      "auto_dispatch_at": _now()}},
        )
        return {"auto_dispatched": False, "reason": "unknown_result"}
    token = str(result.get("tokenPay") or "").strip()
    if result.get("statut") is not True or not token:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "refused", "error": str(result.get("message") or "Requête refusée")[:300],
                      "updated_at": _now()}},
        )
        return {"auto_dispatched": False, "reason": "gateway_refused"}

    await db.moneyfusion_payouts.update_one(
        {"wd_id": wd_id},
        {"$set": {"status": "dispatched", "tokenPay": token,
                  "provider_message": str(result.get("message") or "")[:200],
                  "dispatched_at": _now(), "updated_at": _now()}},
    )
    await db.withdrawals.update_one(
        {"id": wd_id},
        {"$set": {"status": "dispatched", "gateway": PAYIN_PROVIDER,
                  "gateway_channel": "mobile", "gateway_intent_id": token,
                  "gateway_status": "pending", "dispatched_at": _now(),
                  "dispatched_by": "auto:moneyfusion"}},
    )
    await db.users.update_one(
        {"id": withdrawal["user_id"]},
        {"$inc": {"total_withdrawn": float(withdrawal.get("amount") or 0)}},
    )
    return {"auto_dispatched": True, "gateway_intent_id": token,
            "gateway_status": "pending"}


async def _verify_payout(token: str, private_key: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(
            f"{PAYOUT_STATUS_URL}/{token}",
            headers={"moneyfusion-private-key": private_key},
        )
        response.raise_for_status()
        return response.json()


async def _apply_payout_status(db, payout: dict, status: str, event_data: dict) -> dict:
    wd_id = payout.get("wd_id")
    wd = await db.withdrawals.find_one({"id": wd_id})
    if not wd:
        return {"handled": False, "reason": "withdrawal_not_found"}
    status = status.lower()
    now = _now()
    if status == "success":
        result = await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$nin": ["completed", "failed", "rejected"]}},
            {"$set": {"status": "completed", "gateway_status": "success",
                      "completed_at": now, "gateway": PAYIN_PROVIDER}},
        )
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "completed", "verified_status": status,
                      "verified_data": event_data, "completed_at": now, "updated_at": now}},
        )
        return {"handled": True, "outcome": "completed", "changed": result.modified_count > 0}
    if status == "failed":
        result = await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$nin": ["completed", "failed", "rejected"]}},
            {"$set": {"status": "failed", "gateway_status": "failed",
                      "failed_at": now, "gateway": PAYIN_PROVIDER}},
        )
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "failed", "verified_status": status,
                      "verified_data": event_data, "failed_at": now, "updated_at": now}},
        )
        if result.modified_count:
            await db.users.update_one(
                {"id": wd["user_id"]},
                {"$inc": {"balance_profit": float(wd.get("amount") or 0),
                          "total_withdrawn": -float(wd.get("amount") or 0)}},
            )
        return {"handled": True, "outcome": "failed", "changed": result.modified_count > 0}
    await db.moneyfusion_payouts.update_one(
        {"wd_id": wd_id},
        {"$set": {"verified_status": status, "verified_data": event_data,
                  "updated_at": now}},
    )
    return {"handled": True, "outcome": "pending"}


@webhooks.post("/payout")
async def payout_webhook(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    token = _find_token(body if isinstance(body, dict) else {})
    if not token:
        return {"received": True, "ignored": True}
    db = request.app.state.db
    payout = await db.moneyfusion_payouts.find_one({"tokenPay": token}, {"_id": 0})
    if not payout:
        return {"received": True, "ignored": True}
    credentials = await load_credentials(db)
    if not credentials.get("payout_private_key"):
        return {"received": True, "verified": False}
    try:
        verified = await _verify_payout(token, credentials["payout_private_key"])
    except Exception:
        return {"received": True, "verified": False}
    data = (verified or {}).get("data") or {}
    if verified.get("success") is not True or str(data.get("tokenPay") or "") != token:
        return {"received": True, "verified": False}
    outcome = await _apply_payout_status(db, payout, str(data.get("status") or ""), data)
    return {"received": True, "verified": True, "status": outcome.get("outcome")}


class AdminConfigUpdate(BaseModel):
    payin_enabled: Optional[bool] = None
    payout_enabled: Optional[bool] = None
    payin_local_currency_confirmed: Optional[bool] = None
    payin_api_url: Optional[str] = None
    payout_private_key: Optional[str] = None
    rates_per_xof: Optional[dict[str, float]] = None


@admin.get("")
async def admin_get(request: Request):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    catalog_doc = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    return {
        "payin_enabled": bool(cfg.get("payin_enabled")),
        "payout_enabled": bool(cfg.get("payout_enabled")),
        "payin_local_currency_confirmed": bool(cfg.get("payin_local_currency_confirmed")),
        "payin_api_configured": bool(credentials.get("payin_api_url")),
        "payin_api_masked": _mask_secret(credentials.get("payin_api_url") or ""),
        "payout_key_configured": bool(credentials.get("payout_private_key")),
        "payout_key_masked": _mask_secret(credentials.get("payout_private_key") or ""),
        "rates_per_xof": cfg.get("rates_per_xof") or {},
        "catalog_updated_at": catalog_doc.get("updated_at").isoformat()
            if isinstance(catalog_doc.get("updated_at"), datetime) else None,
        "public_app_url": os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "",
        "payin_webhook_path": "/api/webhooks/moneyfusion/payin",
        "payout_webhook_path": "/api/webhooks/moneyfusion/payout",
        "payout_ip_notice": "L’IP publique fixe du serveur qui envoie les retraits doit être enregistrée dans MoneyFusion.",
    }


@admin.put("")
async def admin_update(request: Request, body: AdminConfigUpdate):
    db = request.app.state.db
    cfg = await load_config(db)
    cred = await load_credentials(db)
    if body.payin_api_url is not None:
        value = body.payin_api_url.strip()
        if value == "DELETE":
            cred["payin_api_url"] = ""
        elif value:
            if not _valid_payin_api_url(value):
                raise HTTPException(400, "L’URL Pay-in doit être HTTPS et appartenir à moneyfusion.net.")
            cred["payin_api_url"] = value
    if body.payout_private_key is not None:
        value = body.payout_private_key.strip()
        if value == "DELETE":
            cred["payout_private_key"] = ""
        elif value:
            cred["payout_private_key"] = value
    if body.rates_per_xof is not None:
        rates = {"XOF": 1.0, "XAF": 1.0}
        for currency, rate in body.rates_per_xof.items():
            code = str(currency).upper()
            try:
                value = float(rate)
            except (TypeError, ValueError):
                raise HTTPException(400, f"Taux invalide pour {code}.")
            if not re.fullmatch(r"[A-Z]{3}", code) or value <= 0 or value > 1_000_000:
                raise HTTPException(400, f"Taux invalide pour {code}.")
            rates[code] = value
        cfg["rates_per_xof"] = rates
    if body.payin_local_currency_confirmed is not None:
        cfg["payin_local_currency_confirmed"] = bool(body.payin_local_currency_confirmed)
    if body.payin_enabled is not None:
        cfg["payin_enabled"] = bool(body.payin_enabled)
    if body.payout_enabled is not None:
        cfg["payout_enabled"] = bool(body.payout_enabled)
    if cfg.get("payin_enabled") and (
        not cred.get("payin_api_url") or not cfg.get("payin_local_currency_confirmed")
    ):
        raise HTTPException(400, "Pour activer le Pay-in, configurez l’URL API et confirmez la devise locale auprès de MoneyFusion.")
    if cfg.get("payout_enabled") and not cred.get("payout_private_key"):
        raise HTTPException(400, "Configurez la clé privée MoneyFusion avant d’activer les retraits.")
    try:
        enc_doc = {
            "payin_api_url_enc": _encrypt(cred["payin_api_url"]) if cred.get("payin_api_url") else "",
            "payout_private_key_enc": _encrypt(cred["payout_private_key"]) if cred.get("payout_private_key") else "",
        }
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    await db.app_settings.update_one(
        {"key": "moneyfusion_credentials"},
        {"$set": {"key": "moneyfusion_credentials", "value": enc_doc, "updated_at": _now()}},
        upsert=True,
    )
    await db.app_settings.update_one(
        {"key": "moneyfusion_config"},
        {"$set": {"key": "moneyfusion_config", "value": cfg, "updated_at": _now()}},
        upsert=True,
    )
    await sync_provider(db)
    return await admin_get(request)


@admin.post("/catalog/refresh")
async def admin_refresh_catalog(request: Request):
    db = request.app.state.db
    try:
        entries = await refresh_catalog(db, force=True)
    except Exception:
        log.exception("MoneyFusion catalogue refresh failed")
        raise HTTPException(502, "Impossible de récupérer le catalogue MoneyFusion.")
    await sync_provider(db)
    return {"countries": len(entries),
            "operators": sum(len(c["operators"]) for c in entries)}
