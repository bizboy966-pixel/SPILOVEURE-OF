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
import math
import os
import re
import uuid
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from auth import get_current_user, require_admin
from matrix import activate_level

log = logging.getLogger("moneyfusion")


class _MoneyFusionPrivacyFilter(logging.Filter):
    """httpx INFO logs must never expose merchant API URLs or payment tokens."""
    def filter(self, record):
        message = record.getMessage()
        redacted = re.sub(
            r"https://(?:[A-Za-z0-9-]+\.)*moneyfusion\.net[^\s\"']*",
            "https://moneyfusion.net/[redacted]", message,
        )
        if message != redacted:
            record.msg, record.args = redacted, ()
        return True


logging.getLogger("httpx").addFilter(_MoneyFusionPrivacyFilter())

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
    "mobile_money_only_confirmed": False,
    "payout_ip_confirmed": False,
    "payin_country_codes": [],
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


async def load_credentials(db, *, strict: bool = False) -> dict:
    doc = await db.app_settings.find_one({"key": "moneyfusion_credentials"}) or {}
    value = doc.get("value") if isinstance(doc.get("value"), dict) else {}
    try:
        return {
            "payin_api_url": _decrypt(value.get("payin_api_url_enc") or ""),
            "payout_private_key": _decrypt(value.get("payout_private_key_enc") or ""),
        }
    except Exception:
        log.error("MoneyFusion credentials cannot be decrypted; verify SESSION_SECRET.")
        if strict:
            raise HTTPException(503, "Les identifiants enregistrés ne peuvent pas être déchiffrés. Restaurez le SESSION_SECRET utilisé lors de leur enregistrement.")
        return {"payin_api_url": "", "payout_private_key": ""}


def _valid_payin_api_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return (parsed.scheme == "https" and host == "www.pay.moneyfusion.net"
                or parsed.scheme == "https" and host == "pay.moneyfusion.net") and (
            not parsed.username and not parsed.password and parsed.port in (None, 443)
            and bool(parsed.path.strip("/")) and not parsed.fragment
        )
    except Exception:
        return False


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", str(phone or ""))


def _local_phone(phone: str, country: str) -> str:
    digits = _digits(phone)
    if digits.startswith("00"):
        digits = digits[2:]
    dial = DIAL_CODES.get(country.upper(), "")
    if dial and digits.startswith(dial) and (str(phone).startswith(("+", "00")) or len(digits) > 10):
        digits = digits[len(dial):]
    return digits


def _rate_for(cfg: dict, currency: str) -> Optional[float]:
    try:
        rate = float((cfg.get("rates_per_xof") or {}).get(currency.upper()))
        return rate if math.isfinite(rate) and 0 < rate < 1_000_000 else None
    except (TypeError, ValueError):
        return None


def _amount_from_xof(cfg: dict, amount_xof: float, currency: str) -> Optional[float]:
    rate = _rate_for(cfg, currency)
    if rate is None:
        return None
    if not math.isfinite(float(amount_xof)):
        return None
    unit = Decimal("0.01") if currency.upper() in ("USD", "GHS", "KES") else Decimal("1")
    amount = (Decimal(str(amount_xof)) * Decimal(str(rate))).quantize(unit, rounding=ROUND_HALF_UP)
    return float(amount) if amount > 0 else None


def _safe_checkout_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return parsed.scheme == "https" and not parsed.username and not parsed.password and parsed.port in (None, 443) and host in {
            "payin.moneyfusion.net", "pay.moneyfusion.net",
        }
    except Exception:
        return False


def _valid_token(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value))


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
        if not re.fullmatch(r"[A-Z]{2}", cc) or not re.fullmatch(r"[A-Z]{3}", currency):
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
    if not result:
        raise RuntimeError("MoneyFusion returned an empty methods catalogue.")
    return result


async def sync_catalog(db, entries: list[dict], *, cache_snapshot: bool = True) -> None:
    """Persist live payout methods; newly discovered methods default OFF."""
    now = _now()
    for country in entries:
        cc = country["country_code"]
        await db.payment_provider_countries.update_one(
            {"provider_id": PAYIN_PROVIDER, "country_code": cc},
            {"$setOnInsert": {
                "provider_id": PAYIN_PROVIDER, "country_code": cc,
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
                    "status": "inactive",
                    "source": "moneyfusion_live_methods", "created_at": now,
                }, "$set": {"operator_label": operator["label"], "updated_at": now}},
                upsert=True,
            )
    # Retire removed methods without re-enabling previously disabled ones.
    country_codes = [c["country_code"] for c in entries]
    await db.payment_provider_countries.update_many(
        {"provider_id": PAYIN_PROVIDER, "country_code": {"$nin": country_codes}},
        {"$set": {"status": "inactive", "updated_at": now}},
    )
    for country in entries:
        await db.payment_provider_operators.update_many(
            {"provider_id": PAYIN_PROVIDER, "country_code": country["country_code"],
             "operator_code": {"$nin": [op["code"] for op in country["operators"]]}},
            {"$set": {"status": "inactive", "updated_at": now}},
        )
    if cache_snapshot:
        await db.app_settings.update_one(
            {"key": "moneyfusion_catalog"},
            {"$set": {"key": "moneyfusion_catalog", "value": entries,
                      "updated_at": now}},
            upsert=True,
        )


async def refresh_catalog(db, *, force: bool = False) -> list[dict]:
    cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    updated = cached.get("updated_at")
    if isinstance(updated, datetime) and updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
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
                         and cfg.get("mobile_money_only_confirmed")
                         and credentials.get("payin_api_url"))
    enabled_payout = bool(cfg.get("payout_enabled") and cfg.get("payout_ip_confirmed")
                          and credentials.get("payout_private_key"))
    now = _now()
    await db.payment_providers.update_one(
        {"id": PAYIN_PROVIDER},
        {"$set": {
            "id": PAYIN_PROVIDER, "name": "MoneyFusion",
            "type": "mobile_money",
            "status": "active" if enabled_payin or enabled_payout else "inactive",
            "auto_deposit": enabled_payin,
            "auto_withdrawal": enabled_payout,
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now, "priority": 4}},
        upsert=True,
    )
    cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    if isinstance(cached.get("value"), list):
        await sync_catalog(db, cached["value"], cache_snapshot=False)


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
    # No fuzzy substring match: a wrong operator can send funds incorrectly.
    operator = next((o for o in catalog["operators"]
                     if norm and norm in {_normalize_operator(o["code"]), _normalize_operator(o["label"])}), None)
    if not operator:
        return None
    return await db.payment_provider_operators.find_one(
        {"provider_id": PAYIN_PROVIDER, "country_code": country.upper(),
         "operator_code": operator["code"], "status": "active"},
        {"_id": 0},
    )


async def manual_withdrawal_action_allowed(db, wd_id: str) -> bool:
    payout = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    return bool(payout and payout.get("status") in ("refused", "not_submitted"))


@api.get("/payout-catalog")
async def payout_catalog(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    if not cfg.get("payout_enabled") or not cfg.get("payout_ip_confirmed") or not credentials["payout_private_key"]:
        return {"enabled": False, "countries": []}
    try:
        entries = await refresh_catalog(db)
    except Exception:
        raise HTTPException(503, "Catalogue des retraits MoneyFusion indisponible.")
    countries = []
    for country in entries:
        if not await _active_catalog_country(db, country["country_code"]):
            continue
        if not _rate_for(cfg, country["currency"]):
            continue
        enabled = []
        for op in country["operators"]:
            active = await db.payment_provider_operators.find_one({
                "provider_id": PAYIN_PROVIDER, "country_code": country["country_code"],
                "operator_code": op["code"], "status": "active",
            })
            if active:
                enabled.append(op)
        if enabled:
            countries.append({**country, "operators": enabled})
    return {"enabled": bool(countries), "countries": countries}


async def _verify_payin(db, payment: dict) -> dict:
    token = payment.get("provider_token")
    if not token or not _valid_token(str(token)):
        return {}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"{PAYIN_STATUS_URL}/{token}")
        response.raise_for_status()
        return response.json()


async def _apply_paid_activation(db, payment: dict, verified: dict) -> dict:
    if payment.get("activation_done"):
        return {"status": "paid", "activation_done": True}
    data = (verified or {}).get("data") or {}
    provider_status = str(data.get("statut") or "").strip().lower()
    if verified.get("statut") is not True or provider_status != "paid":
        return {"status": "pending"}
    if str(data.get("tokenPay") or "") != str(payment.get("provider_token") or ""):
        return {"status": "pending"}
    infos = data.get("personal_Info")
    if not isinstance(infos, list) or not any(
        isinstance(info, dict) and str(info.get("orderId") or "") == payment["reference"]
        and str(info.get("userId") or "") == str(payment["user_id"])
        for info in infos
    ):
        return {"status": "review"}
    try:
        provider_amount = float(data.get("Montant"))
        expected_amount = float(payment.get("amount"))
    except (TypeError, ValueError):
        return {"status": "pending"}
    if not math.isfinite(provider_amount) or abs(provider_amount - expected_amount) > 0.01:
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
    if len(received_phone) < 6 or _local_phone(received_phone, payment["country_code"]) != _local_phone(expected_phone, payment["country_code"]):
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
                  "claim_started_at": _now(), "updated_at": _now()}},
    )
    if claim.modified_count == 0:
        latest = await db.payments.find_one({"reference": payment["reference"]}, {"_id": 0})
        return {"status": "paid" if latest and latest.get("activation_done") else "pending"}
    if (payment.get("kind") or "activation") != "activation":
        try:
            from payment_purchases import complete_paid_purchase
            result = await complete_paid_purchase(db, payment, source="moneyfusion")
            await db.payments.update_one(
                {"reference": payment["reference"]},
                {"$set": {"status": result.get("status", "paid"),
                          "activation_done": True, "activation_claimed": False,
                          "paid_at": _now(), "updated_at": _now()},
                 "$unset": {"activation_error": ""}},
            )
            return {"status": result.get("status", "paid"),
                    "activation_done": True, **result}
        except Exception as exc:
            log.exception("MoneyFusion purchase reconciliation failed for reference=%s",
                          payment["reference"])
            await db.payments.update_one(
                {"reference": payment["reference"]},
                {"$set": {"status": "paid", "activation_claimed": False,
                          "activation_error": str(exc)[:300], "updated_at": _now()}},
            )
            return {"status": "paid", "activation_done": False}
    try:
        await activate_level(db, payment["user_id"], int(payment.get("level") or 1),
                             source="moneyfusion")
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "paid", "activation_done": True,
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
    kind: str = "activation"
    amount_xof: Optional[float] = None
    target_id: Optional[str] = None


@api.get("/catalog")
async def public_catalog(request: Request):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    enabled = bool(cfg.get("payin_enabled") and cfg.get("payin_local_currency_confirmed")
                   and cfg.get("mobile_money_only_confirmed")
                   and credentials.get("payin_api_url"))
    if not enabled:
        return {"enabled": False, "currency_confirmed": bool(cfg.get("payin_local_currency_confirmed")),
                "countries": []}
    try:
        methods = await refresh_catalog(db)
    except Exception:
        raise HTTPException(503, "Le catalogue MoneyFusion est temporairement indisponible.")
    countries = []
    if enabled:
        for entry in methods:
            if entry["country_code"] not in cfg.get("payin_country_codes", []):
                continue
            country = await _active_catalog_country(db, entry["country_code"])
            if not country:
                continue
            ops = []
            async for op in db.payment_provider_operators.find(
                {"provider_id": PAYIN_PROVIDER, "country_code": entry["country_code"],
                 "status": "active", "operator_code": {"$in": [o["code"] for o in entry["operators"]]}}, {"_id": 0},
            ):
                ops.append(op)
            # The hosted checkout does not accept an operator field. Do not
            # expose a country unless every listed operator remains enabled.
            if ops and len(ops) == len(entry["operators"]):
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
    if not cfg.get("payin_enabled") or not cfg.get("payin_local_currency_confirmed") or not cfg.get("mobile_money_only_confirmed"):
        raise HTTPException(503, "MoneyFusion Pay-in est désactivé : la devise locale doit d’abord être confirmée dans le panneau administrateur.")
    api_url = credentials.get("payin_api_url") or ""
    if not _valid_payin_api_url(api_url):
        raise HTTPException(503, "L’adresse API Pay-in MoneyFusion n’est pas configurée.")
    country_code = data.country_code.upper()
    if country_code not in cfg.get("payin_country_codes", []):
        raise HTTPException(400, "La disponibilité du Pay-in pour ce pays n’a pas été confirmée auprès de MoneyFusion.")
    country = await _active_catalog_country(db, country_code)
    if not country:
        raise HTTPException(400, "Ce pays n’est pas activé pour MoneyFusion.")
    methods = await refresh_catalog(db)
    country_methods = next((c for c in methods if c["country_code"] == country_code), None)
    if not country_methods:
        raise HTTPException(400, "MoneyFusion ne propose aucun opérateur pour ce pays.")
    enabled_ops = await db.payment_provider_operators.count_documents(
        {"provider_id": PAYIN_PROVIDER, "country_code": country_code, "status": "active",
         "operator_code": {"$in": [o["code"] for o in country_methods["operators"]]}}
    )
    if enabled_ops != len(country_methods["operators"]) or enabled_ops == 0:
        raise HTTPException(400, "Activez tous les opérateurs du pays dans le panneau administrateur : le choix final se fait sur la page MoneyFusion.")
    from payment_exclusivity import assert_assignment
    for operator in country_methods["operators"]:
        await assert_assignment(db, PAYIN_PROVIDER, country_code, operator["code"], operator["label"])
    currency = country_methods["currency"]
    kind = (data.kind or "activation").strip().lower()
    if kind not in ("activation", "ads", "special_task", "lottery_entry"):
        raise HTTPException(400, "Type de paiement MoneyFusion non pris en charge.")
    amount_xof = ACTIVATION_FEE_XOF if kind == "activation" else float(data.amount_xof or 0)
    if not math.isfinite(amount_xof) or amount_xof <= 0:
        raise HTTPException(400, "Montant de paiement invalide.")
    amount = _amount_from_xof(cfg, amount_xof, currency)
    if amount is None:
        raise HTTPException(400, f"Le taux de conversion {currency}/XOF n’est pas configuré.")
    level = int(data.level)
    if kind == "activation" and level != 1:
        raise HTTPException(400, "MoneyFusion est configuré uniquement pour l’activation du Niveau 1.")
    if kind == "activation" and level <= int(user.get("max_level") or 0):
        raise HTTPException(400, "Ce niveau est déjà activé.")
    if not re.fullmatch(r"\d{6,15}", _local_phone(data.phone, country_code)):
        raise HTTPException(400, "Numéro Mobile Money invalide.")
    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    if not public_url.startswith("https://"):
        raise HTTPException(503, "PUBLIC_APP_URL doit contenir l’adresse HTTPS publique du site.")

    reference = f"SPV-MF-{uuid.uuid4().hex[:12].upper()}"
    now = _now()
    payment = {
        "reference": reference, "provider": PAYIN_PROVIDER,
        "user_id": user["id"], "username": user.get("username"),
        "kind": kind, "target_id": data.target_id,
        "ad_id": data.target_id if kind == "ads" else None,
        "special_task_id": data.target_id if kind == "special_task" else None,
        "draw_id": data.target_id if kind == "lottery_entry" else None,
        "level": level if kind == "activation" else None,
        "amount": amount, "currency": currency,
        "base_amount_xof": amount_xof,
        "fx_rate_per_xof": _rate_for(cfg, currency),
        "phone": _local_phone(data.phone, country_code),
        "country_code": country_code, "status": "pending",
        "activation_done": False, "created_at": now, "updated_at": now,
        "moneyfusion_active_key": (
            f"{user['id']}:1" if kind == "activation"
            else f"{user['id']}:{kind}:{data.target_id or ''}"
        ),
    }
    try:
        await db.payments.insert_one(payment)
    except DuplicateKeyError:
        existing = await db.payments.find_one(
            {"moneyfusion_active_key": payment["moneyfusion_active_key"]}, {"_id": 0},
        ) or {}
        if existing.get("payment_url") and not existing.get("activation_done"):
            return {"reference": existing["reference"], "url": existing["payment_url"],
                    "amount": existing["amount"], "currency": existing["currency"],
                    "status": existing.get("status") or "pending"}
        raise HTTPException(409, "Un paiement MoneyFusion est déjà en cours de création ou de vérification. Ne le renvoyez pas.")
    article_label = {
        "activation": "Activation SPILOVEURE Niveau 1",
        "ads": "Publicité SPILOVEURE",
        "special_task": "Tâche spéciale SPILOVEURE",
        "lottery_entry": "Ticket Jackpot SPILOVEURE",
    }[kind]
    payload = {
        "totalPrice": amount,
        "article": [{article_label: amount}],
        "numeroSend": payment["phone"],
        "nomclient": str(user.get("full_name") or user.get("username") or "SPILOVEURE user")[:120],
        "personal_Info": [{"userId": user["id"], "orderId": reference,
                           "country": country_code, "currency": currency}],
        "return_url": f"{public_url}/purchase-payment?reference={reference}",
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
            {"$set": {"status": "unknown", "activation_error": "MoneyFusion initiation indisponible : vérifier avant de renvoyer",
                      "updated_at": _now()}},
        )
        raise HTTPException(502, "La réponse MoneyFusion est inconnue. Contactez le support avant de relancer ce paiement.")
    token = str(result.get("token") or "").strip()
    checkout_url = str(result.get("url") or "").strip()
    if result.get("statut") is not True or not _valid_token(token) or not _safe_checkout_url(checkout_url):
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "failed", "activation_error": "Réponse MoneyFusion invalide",
                      "updated_at": _now()},
             "$unset": {"moneyfusion_active_key": ""}},
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
    if (outcome.get("status") == "pending" and verified.get("statut") is True
            and str(data.get("tokenPay") or "") == payment["provider_token"]
            and provider_status in ("failure", "no paid", "cancelled")):
        await db.payments.update_one(
            {"reference": reference, "status": "pending"},
            {"$set": {"status": "failed", "updated_at": _now()},
             "$unset": {"moneyfusion_active_key": ""}},
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
    if not cfg.get("payout_enabled") or not cfg.get("payout_ip_confirmed") or not credentials.get("payout_private_key"):
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
    from payment_exclusivity import assert_assignment
    await assert_assignment(db, PAYIN_PROVIDER, cc, selected["operator_code"], selected.get("operator_label", ""))
    catalog_country = next((c for c in methods if c["country_code"] == cc), None)
    if not catalog_country:
        return {"auto_dispatched": False, "reason": "country_unsupported"}
    currency = catalog_country["currency"]
    net_xof = float(withdrawal.get("net_payout") or withdrawal.get("amount") or 0)
    amount = _amount_from_xof(cfg, net_xof, currency)
    if amount is None:
        return {"auto_dispatched": False, "reason": "currency_rate_missing"}
    phone = _local_phone(str(withdrawal.get("phone") or ""), cc)
    if not re.fullmatch(r"\d{6,15}", phone):
        return {"auto_dispatched": False, "reason": "phone_missing"}
    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    if not public_url.startswith("https://"):
        return {"auto_dispatched": False, "reason": "public_url_missing"}

    wd_id = str(withdrawal["id"])
    existing = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    if existing:
        return {"auto_dispatched": bool(existing.get("tokenPay")),
                "reason": "already_submitted",
                "tokenPay": existing.get("tokenPay")}
    payout_row = {
        "_id": wd_id,
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

    # Reserve the withdrawal before the provider POST. Admin actions must not
    # refund or manually validate a possibly submitted transfer.
    reserved = await db.withdrawals.update_one(
        {"id": wd_id, "status": "pending", "gateway": {"$exists": False}},
        {"$set": {"status": "processing", "gateway": PAYIN_PROVIDER,
                  "gateway_status": "submitting", "dispatched_at": _now()}},
    )
    if not reserved.modified_count:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id}, {"$set": {"status": "not_submitted"}},
        )
        return {"auto_dispatched": False, "reason": "withdrawal_already_processed"}
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
            {"$set": {"gateway_status": "unknown",
                      "auto_dispatch_error": "MoneyFusion: résultat inconnu; vérification manuelle requise",
                      "auto_dispatch_at": _now()}},
        )
        return {"auto_dispatched": False, "reason": "unknown_result"}
    token = str(result.get("tokenPay") or "").strip()
    if result.get("statut") is not True or not _valid_token(token):
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "refused", "error": str(result.get("message") or "Requête refusée")[:300],
                      "updated_at": _now()}},
        )
        await db.withdrawals.update_one(
            {"id": wd_id, "status": "processing", "gateway_status": "submitting"},
            {"$set": {"status": "pending", "gateway_status": "refused",
                      "auto_dispatch_error": "MoneyFusion a refusé la demande."}},
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


def _payout_details_match(payout: dict, data: dict) -> bool:
    try:
        amount = float(data.get("amount"))
        if not math.isfinite(amount) or abs(amount - float(payout["amount"])) > 0.01:
            return False
    except (KeyError, ValueError, TypeError):
        return False
    return (
        str(data.get("method") or "") == payout["operator_code"]
        and _local_phone(str(data.get("phone") or ""), payout["country_code"]) == payout["phone"]
    )


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
        settled = await db.withdrawals.find_one({"id": wd_id})
        if not settled or settled.get("status") != "completed":
            return {"handled": False, "reason": "conflicting_terminal_status"}
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "completed", "verified_status": status,
                      "verified_data": event_data, "completed_at": now, "updated_at": now}},
        )
        # Per-user markers make accounting re-entrant after a worker crash.
        if wd.get("status") not in ("failed", "rejected"):
            await db.users.update_one(
                {"id": wd["user_id"], "moneyfusion_completed_withdrawals": {"$ne": wd_id}},
                {"$inc": {"total_withdrawn": float(wd.get("amount") or 0)},
                 "$addToSet": {"moneyfusion_completed_withdrawals": wd_id}},
            )
        return {"handled": True, "outcome": "completed", "changed": result.modified_count > 0}
    if status == "failed":
        result = await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$nin": ["completed", "failed", "rejected"]}},
            {"$set": {"status": "failed", "gateway_status": "failed",
                      "failed_at": now, "gateway": PAYIN_PROVIDER}},
        )
        settled = await db.withdrawals.find_one({"id": wd_id})
        if not settled or settled.get("status") != "failed":
            return {"handled": False, "reason": "conflicting_terminal_status"}
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "failed", "verified_status": status,
                      "verified_data": event_data, "failed_at": now, "updated_at": now}},
        )
        if wd.get("status") not in ("completed", "rejected"):
            await db.users.update_one(
                {"id": wd["user_id"], "moneyfusion_refunded_withdrawals": {"$ne": wd_id}},
                {"$inc": {"balance_profit": float(wd.get("amount") or 0)},
                 "$addToSet": {"moneyfusion_refunded_withdrawals": wd_id}},
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
    if not _valid_token(token):
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
    if not _payout_details_match(payout, data):
        return {"received": True, "verified": False}
    outcome = await _apply_payout_status(db, payout, str(data.get("status") or ""), data)
    return {"received": True, "verified": True, "status": outcome.get("outcome")}


class PayoutReconcileRequest(BaseModel):
    token: Optional[str] = None


@admin.post("/payouts/{wd_id}/check")
async def admin_check_payout(wd_id: str, body: PayoutReconcileRequest, request: Request,
                            actor=Depends(require_admin)):
    """Recover an ambiguous submission without ever sending a second payout."""
    db = request.app.state.db
    payout = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    if not payout:
        raise HTTPException(404, "Retrait MoneyFusion introuvable.")
    if payout.get("status") in ("refused", "not_submitted"):
        raise HTTPException(409, "Cette demande n’a pas été acceptée par MoneyFusion. Aucun token externe ne peut lui être associé.")
    token = str(payout.get("tokenPay") or body.token or "")
    if not _valid_token(token):
        raise HTTPException(400, "Saisissez le token du retrait affiché dans MoneyFusion pour vérifier la demande initiale, sans la renvoyer.")
    credentials = await load_credentials(db, strict=True)
    if not credentials["payout_private_key"]:
        raise HTTPException(503, "Clé privée MoneyFusion manquante.")
    try:
        verified = await _verify_payout(token, credentials["payout_private_key"])
    except Exception:
        raise HTTPException(502, "Vérification MoneyFusion indisponible. Ne renvoyez pas le retrait.")
    data = (verified or {}).get("data") or {}
    if (verified.get("success") is not True or str(data.get("tokenPay") or "") != token
            or not _payout_details_match(payout, data)):
        raise HTTPException(400, "Le token ne correspond pas au montant, numéro et opérateur du retrait.")
    try:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id}, {"$set": {"tokenPay": token, "updated_at": _now()}},
        )
    except Exception:
        raise HTTPException(409, "Ce token est déjà lié à un autre retrait.")
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": actor["id"],
        "action": "moneyfusion_reconcile_payout", "target": wd_id, "at": _now(),
    })
    outcome = await _apply_payout_status(db, payout, str(data.get("status") or ""), data)
    return {"ok": bool(outcome.get("handled")), "status": outcome.get("outcome") or outcome.get("reason")}


class AdminConfigUpdate(BaseModel):
    payin_enabled: Optional[bool] = None
    payout_enabled: Optional[bool] = None
    payin_local_currency_confirmed: Optional[bool] = None
    mobile_money_only_confirmed: Optional[bool] = None
    payout_ip_confirmed: Optional[bool] = None
    payin_country_codes: Optional[list[str]] = None
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
        "mobile_money_only_confirmed": bool(cfg.get("mobile_money_only_confirmed")),
        "payout_ip_confirmed": bool(cfg.get("payout_ip_confirmed")),
        "payin_country_codes": cfg.get("payin_country_codes") or [],
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


from payment_exclusivity import configuration_write


@admin.put("")
@configuration_write
async def admin_update(request: Request, body: AdminConfigUpdate):
    db = request.app.state.db
    cfg = await load_config(db)
    cred = await load_credentials(db, strict=True)
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
            if not re.fullmatch(r"[A-Z]{3}", code) or not math.isfinite(value) or value <= 0 or value > 1_000_000:
                raise HTTPException(400, f"Taux invalide pour {code}.")
            if code in ("XOF", "XAF") and value != 1:
                raise HTTPException(400, "La parité XOF/XAF doit rester égale à 1.")
            rates[code] = value
        cfg["rates_per_xof"] = rates
    if body.payin_local_currency_confirmed is not None:
        cfg["payin_local_currency_confirmed"] = bool(body.payin_local_currency_confirmed)
    if body.mobile_money_only_confirmed is not None:
        cfg["mobile_money_only_confirmed"] = bool(body.mobile_money_only_confirmed)
    if body.payout_ip_confirmed is not None:
        cfg["payout_ip_confirmed"] = bool(body.payout_ip_confirmed)
    if body.payin_country_codes is not None:
        codes = sorted({str(c).strip().upper() for c in body.payin_country_codes})
        if any(not re.fullmatch(r"[A-Z]{2}", code) for code in codes):
            raise HTTPException(400, "Codes pays Pay-in invalides.")
        cfg["payin_country_codes"] = codes
    if body.payin_enabled is not None:
        cfg["payin_enabled"] = bool(body.payin_enabled)
    if body.payout_enabled is not None:
        cfg["payout_enabled"] = bool(body.payout_enabled)
    if cfg.get("payin_enabled") and (
        not cred.get("payin_api_url") or not cfg.get("payin_local_currency_confirmed")
        or not cfg.get("mobile_money_only_confirmed") or not cfg.get("payin_country_codes")
    ):
        raise HTTPException(400, "Pour activer le Pay-in, configurez l’URL API, les pays confirmés, la devise locale et une page MoneyFusion limitée au Mobile Money.")
    if cfg.get("payout_enabled") and (not cred.get("payout_private_key") or not cfg.get("payout_ip_confirmed")):
        raise HTTPException(400, "Configurez la clé privée et confirmez l’enregistrement de l’IP du VPS dans MoneyFusion avant d’activer les retraits.")
    from payment_exclusivity import validate_change
    await validate_change(db, mf_config=cfg)
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
