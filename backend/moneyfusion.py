"""MoneyFusion Mobile Money integration.

Pay-in and payout stay disabled until an administrator configures the
merchant credentials, confirms the pay-in currency behavior, and enables
the relevant countries/operators. Provider callbacks are only hints: final
states are always fetched from MoneyFusion before applying account changes.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import math
import os
import re
import uuid
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
import httpx as fx_httpx
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
FX_API_URL = "https://api.frankfurter.dev/v2/rates"
FX_CACHE_KEY = "moneyfusion_fx_cache"
FX_REFRESH_SECONDS = 12 * 60 * 60
FX_MAX_RATE_AGE_DAYS = 5
FX_SOURCE = "Frankfurter (taux de référence, pas un cours instantané)"

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
}


def _now():
    return datetime.now(timezone.utc)


async def load_config(db) -> dict:
    doc = await db.app_settings.find_one({"key": "moneyfusion_config"}) or {}
    stored = doc.get("value") if isinstance(doc.get("value"), dict) else {}
    cfg = {**DEFAULT_CONFIG, **stored}
    # Legacy manually-entered rates are intentionally not loaded into runtime
    # configuration; payment paths must use automatic reference rates.
    cfg.pop("rates_per_xof", None)
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
    code = currency.upper()
    zero_decimal = {"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
                    "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"}
    three_decimal = {"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"}
    digits = 0 if code in zero_decimal else 3 if code in three_decimal else 2
    unit = Decimal(1).scaleb(-digits)
    amount = (Decimal(str(amount_xof)) * Decimal(str(rate))).quantize(unit, rounding=ROUND_HALF_UP)
    return float(amount) if amount > 0 else None


def _fx_cache_is_usable(cache: dict, currencies: set[str], *, require_recent: bool = True) -> bool:
    if not cache:
        return False
    rates = cache.get("rates_per_xof") or {}
    dates = cache.get("rate_dates") or {}
    fetched_at_by_currency = cache.get("fetched_at_by_currency") or {}
    today = _now().date()
    now = _now()
    for code in currencies - {"XOF", "XAF"}:
        try:
            rate = float(rates[code])
            rate_date = datetime.strptime(str(dates[code]), "%Y-%m-%d").date()
            fetched_at = fetched_at_by_currency[code]
            if isinstance(fetched_at, str):
                fetched_at = datetime.fromisoformat(fetched_at)
        except (KeyError, TypeError, ValueError):
            return False
        if not isinstance(fetched_at, datetime):
            return False
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=timezone.utc)
        if require_recent and (now - fetched_at).total_seconds() > FX_REFRESH_SECONDS:
            return False
        if not math.isfinite(rate) or rate <= 0:
            return False
        if (today - rate_date).days < 0 or (today - rate_date).days > FX_MAX_RATE_AGE_DAYS:
            return False
    return True


async def automatic_fx_rates(db, currencies, *, force: bool = False) -> dict:
    """Get daily reference rates against XOF, with a bounded, fail-closed cache."""
    codes = {str(code or "").strip().upper() for code in currencies}
    codes.discard("")
    if any(not re.fullmatch(r"[A-Z]{3}", code) for code in codes):
        raise HTTPException(400, "Code devise invalide.")
    if codes <= {"XOF", "XAF"}:
        return {
            "rates_per_xof": {"XOF": 1.0, "XAF": 1.0},
            "rate_dates": {"XOF": "parité fixe", "XAF": "parité fixe"},
            "rate_date": None,
            "source": FX_SOURCE,
        }
    requested = codes | {"XOF", "XAF"}
    doc = await db.app_settings.find_one({"key": FX_CACHE_KEY}) or {}
    cache = doc.get("value") if isinstance(doc.get("value"), dict) else {}
    if not force and _fx_cache_is_usable(cache, requested):
        return cache

    foreign = sorted(requested - {"XOF", "XAF"})
    updated = {
        "rates_per_xof": {
            **(cache.get("rates_per_xof") or {}),
            "XOF": 1.0,
            "XAF": 1.0,
        },
        "rate_dates": {
            **(cache.get("rate_dates") or {}),
            "XOF": "parité fixe",
            "XAF": "parité fixe",
        },
        "fetched_at_by_currency": cache.get("fetched_at_by_currency") or {},
    }
    if foreign:
        try:
            async with fx_httpx.AsyncClient(timeout=8.0) as client:
                response = await client.get(
                    FX_API_URL,
                    params={"base": "XOF", "quotes": ",".join(foreign)},
                )
            response.raise_for_status()
            rows = response.json()
            received = set()
            for row in rows if isinstance(rows, list) else []:
                code = str(row.get("quote") or "").upper()
                if code not in foreign or str(row.get("base") or "").upper() != "XOF":
                    continue
                rate = float(row.get("rate"))
                rate_date = datetime.strptime(str(row.get("date")), "%Y-%m-%d").date()
                age_days = (_now().date() - rate_date).days
                if not math.isfinite(rate) or rate <= 0 or age_days < 0 or age_days > FX_MAX_RATE_AGE_DAYS:
                    continue
                updated["rates_per_xof"][code] = rate
                updated["rate_dates"][code] = rate_date.isoformat()
                updated["fetched_at_by_currency"][code] = _now()
                received.add(code)
            missing = [code for code in foreign if code not in received]
            if missing:
                raise ValueError("Missing FX quotes")
        except Exception:
            if _fx_cache_is_usable(cache, requested, require_recent=False):
                return cache
            log.warning("MoneyFusion automatic FX rates unavailable; refusing conversion.")
            raise HTTPException(
                503,
                "Le taux de conversion automatique est momentanément indisponible. Aucun paiement n’a été lancé.",
            ) from None

    updated["rate_date"] = max(
        (value for value in updated["rate_dates"].values() if value != "parité fixe"),
        default=None,
    )
    updated["fetched_at"] = _now()
    updated["source"] = FX_SOURCE
    await db.app_settings.update_one(
        {"key": FX_CACHE_KEY},
        {"$set": {"key": FX_CACHE_KEY, "value": updated, "updated_at": _now()}},
        upsert=True,
    )
    return updated


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
    """Keep the existing catalog for Pay-in and copy it into separate Pay-out routes."""
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
        await db.payment_provider_payout_countries.update_one(
            {"provider_id": PAYIN_PROVIDER, "country_code": cc},
            {"$setOnInsert": {
                "provider_id": PAYIN_PROVIDER, "country_code": cc,
                "status": "inactive",
                "mode": "automatic", "priority": 4,
                "source": "moneyfusion_payout_methods", "created_at": now,
            }, "$set": {"country_name": country["country"],
                        "currency": country["currency"], "updated_at": now,
                        "catalog_direction": "payout"}},
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
            await db.payment_provider_payout_operators.update_one(
                {"provider_id": PAYIN_PROVIDER, "country_code": cc,
                 "operator_code": operator["code"]},
                {"$setOnInsert": {
                    "provider_id": PAYIN_PROVIDER, "country_code": cc,
                    "operator_code": operator["code"],
                    "status": "inactive",
                    "source": "moneyfusion_payout_methods", "created_at": now,
                }, "$set": {"operator_label": operator["label"], "updated_at": now,
                            "catalog_direction": "payout"}},
                upsert=True,
            )
    # Retire removed methods without re-enabling previously disabled ones.
    country_codes = [c["country_code"] for c in entries]
    await db.payment_provider_countries.update_many(
        {"provider_id": PAYIN_PROVIDER, "country_code": {"$nin": country_codes}},
        {"$set": {"status": "inactive", "updated_at": now}},
    )
    await db.payment_provider_payout_countries.update_many(
        {"provider_id": PAYIN_PROVIDER, "country_code": {"$nin": country_codes}},
        {"$set": {"status": "inactive", "updated_at": now}},
    )
    for country in entries:
        await db.payment_provider_operators.update_many(
            {"provider_id": PAYIN_PROVIDER, "country_code": country["country_code"],
             "operator_code": {"$nin": [op["code"] for op in country["operators"]]}},
            {"$set": {"status": "inactive", "updated_at": now}},
        )
        await db.payment_provider_payout_operators.update_many(
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
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now, "priority": 4}},
        upsert=True,
    )
    cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    if isinstance(cached.get("value"), list):
        await sync_catalog(db, cached["value"], cache_snapshot=False)


async def sync_enabled_payin_countries(db) -> list[str]:
    """Keep the hosted Pay-in country allowlist aligned with admin catalog toggles.

    MoneyFusion's hosted checkout cannot be forced to one operator. A country
    is therefore offered only when its country and every method in the
    configured catalog are active, so the chosen provider owns the whole set.
    """
    cfg = await load_config(db)
    cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    entries = cached.get("value") if isinstance(cached.get("value"), list) else []
    enabled: list[str] = []
    for entry in entries:
        cc = str(entry.get("country_code") or "").upper()
        operators = entry.get("operators") if isinstance(entry.get("operators"), list) else []
        if not cc or not operators:
            continue
        country = await db.payment_provider_countries.find_one(
            {"provider_id": PAYIN_PROVIDER, "country_code": cc, "status": "active"},
            {"_id": 0},
        )
        if not country:
            continue
        codes = [str(operator.get("code") or "") for operator in operators]
        active_count = await db.payment_provider_operators.count_documents({
            "provider_id": PAYIN_PROVIDER,
            "country_code": cc,
            "operator_code": {"$in": codes},
            "status": "active",
        })
        if active_count == len(codes):
            enabled.append(cc)

    enabled = sorted(set(enabled))
    if sorted(set(cfg.get("payin_country_codes") or [])) != enabled:
        cfg["payin_country_codes"] = enabled
        await db.app_settings.update_one(
            {"key": "moneyfusion_config"},
            {"$set": {"key": "moneyfusion_config", "value": cfg, "updated_at": _now()}},
            upsert=True,
        )
    return enabled


def _normalize_operator(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def _catalog_route_collections(db, kind: str = "payin"):
    if kind == "payout":
        return db.payment_provider_payout_countries, db.payment_provider_payout_operators
    return db.payment_provider_countries, db.payment_provider_operators


async def _active_catalog_country(
    db, country_code: str, *, kind: str = "payin",
) -> Optional[dict]:
    countries, _ = _catalog_route_collections(db, kind)
    return await countries.find_one(
        {"provider_id": PAYIN_PROVIDER, "country_code": country_code.upper(),
         "status": "active"}, {"_id": 0},
    )


async def _active_operator_for_label(
    db, country: str, label: str, methods: list[dict], *, kind: str = "payin",
) -> Optional[dict]:
    _, operators = _catalog_route_collections(db, kind)
    norm = _normalize_operator(label)
    catalog = next((c for c in methods if c["country_code"] == country.upper()), None)
    if not catalog:
        return None
    # No fuzzy substring match: a wrong operator can send funds incorrectly.
    operator = next((o for o in catalog["operators"]
                     if norm and norm in {_normalize_operator(o["code"]), _normalize_operator(o["label"])}), None)
    if not operator:
        return None
    return await operators.find_one(
        {"provider_id": PAYIN_PROVIDER, "country_code": country.upper(),
         "operator_code": operator["code"], "status": "active"},
        {"_id": 0},
    )


async def manual_withdrawal_action_allowed(db, wd_id: str) -> bool:
    payout = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    return bool(payout and payout.get("status") in ("refused", "not_submitted"))


_PAYOUT_FAILURE_MESSAGES = {
    "not_configured": "Les retraits MoneyFusion ne sont pas configurés.",
    "country_disabled": "Ce pays est désactivé dans le catalogue des retraits MoneyFusion.",
    "operator_disabled_or_unmapped": "Cet opérateur n’est pas actif dans le catalogue réel des retraits MoneyFusion.",
    "country_unsupported": "Ce pays n’existe pas dans le catalogue de retraits MoneyFusion.",
    "fx_rate_unavailable": "Le taux de conversion du retrait est indisponible.",
    "phone_missing": "Le numéro Mobile Money du portefeuille est invalide.",
    "public_url_missing": "L’adresse HTTPS publique du serveur n’est pas configurée pour le webhook.",
    "submission_reserved": "Une tentative de retrait existe déjà; vérifiez son statut avant toute action.",
    "withdrawal_already_processed": "Le retrait a déjà changé de statut et n’a pas été envoyé.",
}


async def _record_dispatch_failure(db, wd_id: str, reason: str, detail: str = "") -> dict:
    message = (detail or _PAYOUT_FAILURE_MESSAGES.get(reason) or
               "Le retrait automatique MoneyFusion n’a pas été lancé.")
    definitely_not_submitted = reason not in (
        "submission_reserved", "withdrawal_already_processed",
    )
    try:
        await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$nin": ["completed", "failed", "rejected", "validated"]}},
            {"$set": {
                "gateway": PAYIN_PROVIDER,
                "gateway_status": "not_submitted" if definitely_not_submitted else "unknown",
                "auto_dispatched": False,
                "auto_dispatch_reason": message[:300],
                "gateway_error_code": f"moneyfusion_{reason}"[:80],
                "gateway_error": message[:300],
                "updated_at": _now(),
            }},
        )
    except Exception:
        log.exception("MoneyFusion payout failure reason could not be persisted wd=%s", wd_id)
    return {"auto_dispatched": False, "not_submitted": definitely_not_submitted,
            "reason": reason, "detail": message}


def _payout_poll_delay(attempts: int) -> int:
    """Start at 30 seconds and back off to at most 15 minutes per payout."""
    return min(30 * (2 ** min(max(int(attempts) - 1, 0), 5)), 900)


@api.get("/payout-catalog")
async def payout_catalog(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    if not cfg.get("payout_enabled") or not credentials["payout_private_key"]:
        return {"enabled": False, "countries": []}
    try:
        entries = await refresh_catalog(db)
    except Exception:
        raise HTTPException(503, "Catalogue des retraits MoneyFusion indisponible.")
    countries = []
    for country in entries:
        if not await _active_catalog_country(db, country["country_code"], kind="payout"):
            continue
        currency = str(country["currency"]).upper()
        try:
            fx = await automatic_fx_rates(db, [currency])
        except HTTPException:
            continue
        fx_cfg = {**cfg, "rates_per_xof": fx.get("rates_per_xof") or {}}
        if not _rate_for(fx_cfg, currency):
            continue
        enabled = []
        for op in country["operators"]:
            active = await db.payment_provider_payout_operators.find_one({
                "provider_id": PAYIN_PROVIDER, "country_code": country["country_code"],
                "operator_code": op["code"], "status": "active",
            })
            if active:
                enabled.append(op)
        if enabled:
            countries.append({
                **country,
                "operators": enabled,
                "fx_rate_date": (fx.get("rate_dates") or {}).get(currency, "parité fixe"),
            })
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
        return {
            "status": "review",
            "message": "Paiement reçu, mais sa référence n’a pas pu être rapprochée automatiquement. Ne payez pas une seconde fois ; contactez le support.",
        }
    try:
        provider_amount = Decimal(str(data.get("Montant")))
        expected_amount = Decimal(str(payment.get("amount")))
        provider_fees = Decimal(str(data.get("frais", 0)))
    except (ArithmeticError, TypeError, ValueError):
        return {"status": "pending"}
    # MoneyFusion documents both a gross Montant and a net Montant with
    # separate frais. Fees are included in the customer's checkout total:
    # never compare only the merchant's net credit or accept arbitrary shortfalls.
    valid_amounts = (
        provider_amount.is_finite() and expected_amount.is_finite()
        and provider_fees.is_finite()
        and provider_amount > 0 and expected_amount > 0 and provider_fees >= 0
        and provider_fees < expected_amount
        and (
            abs(provider_amount - expected_amount) <= Decimal("0.01")
            or abs(provider_amount + provider_fees - expected_amount) <= Decimal("0.01")
        )
    )
    if not valid_amounts:
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "review", "verification_error": "amount_mismatch",
                      "updated_at": _now()}},
        )
        return {
            "status": "review",
            "message": "Le montant reçu ne correspond pas à la demande. Ne payez pas une seconde fois ; contactez le support avec la référence.",
        }

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
        return {
            "status": "review",
            "message": "Le numéro de paiement ne correspond pas à la demande. Ne payez pas une seconde fois ; contactez le support avec la référence.",
        }

    # Wallet deposits use a currency-specific atomic credit marker rather than
    # the purchase dispatcher. The user balance marker and increment happen in
    # one Mongo update, so webhook/poll retries cannot double-credit.
    if (payment.get("kind") or "activation") == "wallet_deposit":
        try:
            from wallet_finance import settle_wallet_deposit
            outcome = await settle_wallet_deposit(db, payment, source="moneyfusion")
            return {
                "status": "paid", "activation_done": True,
                "wallet_credited": True, **outcome,
            }
        except Exception as exc:
            log.exception("MoneyFusion wallet deposit settlement failed ref=%s", payment["reference"])
            await db.payments.update_one(
                {"reference": payment["reference"]},
                {"$set": {"status": "paid", "activation_error": str(exc)[:300],
                          "updated_at": _now()}},
            )
            return {
                "status": "paid", "activation_done": False,
                "message": "Paiement reçu; le crédit du portefeuille sera réessayé. Ne payez pas une seconde fois.",
            }

    claim = await db.payments.update_one(
        {"reference": payment["reference"], "activation_done": {"$ne": True},
         "activation_claimed": {"$ne": True}},
        {"$set": {"status": "paid", "activation_claimed": True,
                  "provider_reported_amount": float(provider_amount),
                  "provider_reported_fees": float(provider_fees),
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
                 "$unset": {"activation_error": "", "verification_error": ""}},
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
            return {
                "status": "paid", "activation_done": False,
                "message": "Paiement reçu, finalisation de l’achat en cours. Ne payez pas une seconde fois.",
            }
    try:
        await activate_level(db, payment["user_id"], int(payment.get("level") or 1),
                             source="moneyfusion")
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "paid", "activation_done": True,
                      "activation_claimed": False, "paid_at": _now(), "updated_at": _now()},
             "$unset": {"activation_error": "", "verification_error": ""}},
        )
        return {"status": "paid", "activation_done": True}
    except Exception as exc:
        log.exception("MoneyFusion activation failed for reference=%s", payment["reference"])
        await db.payments.update_one(
            {"reference": payment["reference"]},
            {"$set": {"status": "paid", "activation_claimed": False,
                      "activation_error": str(exc)[:300], "updated_at": _now()}},
        )
        return {
            "status": "paid", "activation_done": False,
            "message": "Paiement reçu, mais l’activation n’a pas encore abouti. Ne payez pas une seconde fois ; le statut sera revérifié.",
        }


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
                try:
                    fx = await automatic_fx_rates(db, [entry["currency"]])
                except HTTPException:
                    continue
                fx_cfg = {**cfg, "rates_per_xof": fx.get("rates_per_xof") or {}}
                amount = _amount_from_xof(fx_cfg, ACTIVATION_FEE_XOF, entry["currency"])
                if amount is not None:
                    countries.append({
                        "country_code": entry["country_code"],
                        "country": entry["country"], "currency": entry["currency"],
                        "amount": amount, "operators": entry["operators"],
                        "fx_rate_date": (fx.get("rate_dates") or {}).get(str(entry["currency"]).upper(), "parité fixe"),
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
    currency = str(country_methods["currency"]).upper()
    kind = (data.kind or "activation").strip().lower()
    if kind not in ("activation", "ads", "special_task", "lottery_entry"):
        raise HTTPException(400, "Type de paiement MoneyFusion non pris en charge.")
    amount_xof = ACTIVATION_FEE_XOF if kind == "activation" else float(data.amount_xof or 0)
    if not math.isfinite(amount_xof) or amount_xof <= 0:
        raise HTTPException(400, "Montant de paiement invalide.")
    fx = await automatic_fx_rates(db, [currency])
    fx_cfg = {**cfg, "rates_per_xof": fx.get("rates_per_xof") or {}}
    amount = _amount_from_xof(fx_cfg, amount_xof, currency)
    if amount is None:
        raise HTTPException(503, f"Le taux de conversion automatique {currency}/XOF est indisponible.")
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
        "fx_rate_per_xof": _rate_for(fx_cfg, currency),
        "fx_rate_date": (fx.get("rate_dates") or {}).get(currency, "parité fixe"),
        "fx_source": fx.get("source") or FX_SOURCE,
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
        "return_url": (
            f"{public_url}/pay?moneyfusion_reference={reference}"
            if kind == "activation"
            else f"{public_url}/purchase-payment?reference={reference}"
        ),
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
    kind = payment.get("kind") or "activation"
    if payment.get("activation_done"):
        return {"status": "paid", "activation_done": True, "kind": kind}
    if not payment.get("provider_token"):
        return {"status": payment.get("status") or "pending", "kind": kind}
    try:
        verified = await _verify_payin(db, payment)
    except Exception:
        return {
            "status": "pending", "kind": kind,
            "message": "Vérification MoneyFusion en attente.",
        }
    outcome = await _apply_paid_activation(db, payment, verified)
    data = (verified or {}).get("data") or {}
    provider_status = str(data.get("statut") or "").lower()
    if (outcome.get("status") == "pending" and verified.get("statut") is True
            and str(data.get("tokenPay") or "") == payment["provider_token"]
            and provider_status in ("failure", "cancelled")):
        await db.payments.update_one(
            {"reference": reference, "status": "pending"},
            {"$set": {"status": "failed", "updated_at": _now()},
             "$unset": {"moneyfusion_active_key": ""}},
        )
        return {"status": "failed", "kind": kind}
    return {**outcome, "kind": kind}


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
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "not_configured")
    if (withdrawal.get("method") or "").lower() not in ("mobile", "mobile_money", "mm"):
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "not_mobile", "Ce retrait n’est pas un retrait Mobile Money.")
    cc = str(withdrawal.get("country") or "").upper()
    country = await _active_catalog_country(db, cc, kind="payout")
    if not country:
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "country_disabled")
    methods = await refresh_catalog(db)
    selected = await _active_operator_for_label(
        db, cc, str(withdrawal.get("operator") or ""), methods, kind="payout",
    )
    if not selected:
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "operator_disabled_or_unmapped")
    from payment_exclusivity import assert_assignment
    await assert_assignment(db, PAYIN_PROVIDER, cc, selected["operator_code"],
                            selected.get("operator_label", ""), kind="payout")
    catalog_country = next((c for c in methods if c["country_code"] == cc), None)
    if not catalog_country:
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "country_unsupported")
    currency = str(catalog_country["currency"]).upper()
    net_xof = float(withdrawal.get("net_payout") or withdrawal.get("amount") or 0)
    try:
        fx = await automatic_fx_rates(db, [currency])
    except HTTPException:
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "fx_rate_unavailable")
    fx_cfg = {**cfg, "rates_per_xof": fx.get("rates_per_xof") or {}}
    amount = _amount_from_xof(fx_cfg, net_xof, currency)
    if amount is None:
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "fx_rate_unavailable")
    phone = _local_phone(str(withdrawal.get("phone") or ""), cc)
    if not re.fullmatch(r"\d{6,15}", phone):
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "phone_missing")
    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    if not public_url.startswith("https://"):
        return await _record_dispatch_failure(db, str(withdrawal.get("id") or ""),
                                              "public_url_missing")

    wd_id = str(withdrawal["id"])
    existing = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    if existing:
        return {"auto_dispatched": bool(existing.get("tokenPay")),
                "reason": "already_submitted", "tokenPay": existing.get("tokenPay"),
                "detail": "Une tentative MoneyFusion existe déjà; vérifiez son statut sans la renvoyer."}
    payout_row = {
        "_id": wd_id,
        "wd_id": wd_id, "user_id": withdrawal.get("user_id"),
        "amount": amount, "amount_xof": net_xof, "currency": currency,
        "fx_rate_per_xof": _rate_for(fx_cfg, currency),
        "fx_rate_date": (fx.get("rate_dates") or {}).get(currency, "parité fixe"),
        "fx_source": fx.get("source") or FX_SOURCE,
        "country_code": cc, "operator_code": selected["operator_code"],
        "phone": phone, "status": "submitting", "created_at": _now(),
    }
    try:
        await db.moneyfusion_payouts.insert_one(payout_row)
    except Exception:
        return await _record_dispatch_failure(
            db, wd_id, "submission_reserved",
            "Une tentative MoneyFusion existe déjà; vérifiez son statut sans la renvoyer.",
        )

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
    except fx_httpx.HTTPStatusError as exc:
        status_code = int(getattr(exc.response, "status_code", 0) or 0)
        if 400 <= status_code < 500 and status_code not in (408, 409, 429):
            try:
                error_body = exc.response.json()
            except Exception:
                error_body = {}
            detail = str(
                error_body.get("message") or error_body.get("detail")
                or "MoneyFusion a refusé le retrait."
            )[:300] if isinstance(error_body, dict) else "MoneyFusion a refusé le retrait."
            error_code = str(
                error_body.get("code") or error_body.get("error_code")
                or f"http_{status_code}"
            )[:80] if isinstance(error_body, dict) else f"http_{status_code}"
            await db.moneyfusion_payouts.update_one(
                {"wd_id": wd_id, "status": "submitting"},
                {"$set": {"status": "refused", "error": detail,
                          "updated_at": _now()}},
            )
            await db.withdrawals.update_one(
                {"id": wd_id, "status": "processing", "gateway_status": "submitting"},
                {"$set": {
                    "status": "pending", "gateway_status": "refused",
                    "auto_dispatch_error": detail, "auto_dispatch_reason": detail,
                    "gateway_error_code": error_code, "gateway_error": detail,
                    "auto_dispatched": False,
                }},
            )
            return {"auto_dispatched": False, "not_submitted": True,
                    "reason": "gateway_refused", "detail": detail}
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id, "status": "submitting"},
            {"$set": {"status": "unknown", "updated_at": _now()}},
        )
        await db.withdrawals.update_one(
            {"id": wd_id},
            {"$set": {"gateway_status": "unknown",
                      "auto_dispatch_attempted": True,
                      "auto_dispatch_error": "MoneyFusion a répondu sans confirmer l’issue du retrait.",
                      "auto_dispatch_reason": "Résultat incertain; vérification nécessaire avant toute action.",
                      "auto_dispatch_at": _now()}},
        )
        return {"auto_dispatched": False, "reason": "unknown_result",
                "detail": "Résultat MoneyFusion incertain; ne renvoyez pas le retrait."}
    except Exception:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id, "status": "submitting"},
            {"$set": {"status": "unknown", "updated_at": _now()}},
        )
        await db.withdrawals.update_one(
            {"id": wd_id},
            {"$set": {"gateway_status": "unknown",
                      "auto_dispatch_attempted": True,
                      "auto_dispatch_error": "MoneyFusion: résultat inconnu; vérifiez le token du retrait sans le renvoyer.",
                      "auto_dispatch_reason": "Résultat de la soumission incertain; vérification MoneyFusion nécessaire avant toute action.",
                      "auto_dispatch_at": _now()}},
        )
        return {"auto_dispatched": False, "reason": "unknown_result",
                "detail": "Résultat de la soumission incertain; ne renvoyez pas le retrait."}
    token = str(result.get("tokenPay") or "").strip()
    if result.get("statut") is not True:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "refused", "error": str(result.get("message") or "Requête refusée")[:300],
                      "updated_at": _now()}},
        )
        await db.withdrawals.update_one(
            {"id": wd_id, "status": "processing", "gateway_status": "submitting"},
            {"$set": {"status": "pending", "gateway_status": "refused",
                      "auto_dispatch_error": "MoneyFusion a refusé la demande.",
                      "auto_dispatch_reason": str(result.get("message") or "MoneyFusion a refusé la demande.")[:300],
                      "gateway_error_code": str(result.get("code") or "moneyfusion_refused")[:80],
                      "gateway_error": str(result.get("message") or "MoneyFusion a refusé la demande.")[:300],
                      "auto_dispatched": False}},
        )
        return {"auto_dispatched": False, "not_submitted": True,
                "reason": "gateway_refused",
                "detail": str(result.get("message") or "MoneyFusion a refusé la demande.")[:300]}
    if not _valid_token(token):
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id, "status": "submitting"},
            {"$set": {"status": "unknown", "error": "Réponse acceptée sans tokenPay valide.",
                      "updated_at": _now()}},
        )
        await db.withdrawals.update_one(
            {"id": wd_id, "status": "processing"},
            {"$set": {"gateway_status": "unknown", "auto_dispatch_attempted": True,
                      "auto_dispatch_error": "MoneyFusion a peut-être accepté le retrait mais n’a pas renvoyé un token valide.",
                      "auto_dispatch_reason": "Réponse MoneyFusion incertaine; vérifiez le tableau MoneyFusion sans renvoyer le retrait.",
                      "gateway_error_code": "moneyfusion_token_missing",
                      "gateway_error": "Réponse acceptée sans tokenPay valide."}},
        )
        return {"auto_dispatched": False, "reason": "unknown_result",
                "detail": "Réponse MoneyFusion incertaine; ne renvoyez pas le retrait."}

    await db.moneyfusion_payouts.update_one(
        {"wd_id": wd_id},
        {"$set": {"status": "dispatched", "tokenPay": token,
                  "provider_message": str(result.get("message") or "")[:200],
                  "dispatched_at": _now(), "updated_at": _now(),
                  "next_reconcile_at": _now() + timedelta(seconds=30),
                  "reconcile_attempts": 0}},
    )
    await db.withdrawals.update_one(
        {"id": wd_id},
        {"$set": {"status": "dispatched", "gateway": PAYIN_PROVIDER,
                  "gateway_channel": "mobile", "gateway_intent_id": token,
                  "gateway_status": "pending", "dispatched_at": _now(),
                  "dispatched_by": "auto:moneyfusion", "auto_dispatched": True,
                  "auto_dispatch_attempted": True,
                  "auto_dispatch_reason": None, "gateway_error": None,
                  "gateway_error_code": None}},
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


def _verified_payout_data(verified: dict) -> Optional[dict]:
    """Accept MoneyFusion's French `statut` envelope and legacy `success`."""
    if not isinstance(verified, dict):
        return None
    if verified.get("statut") is not True and verified.get("success") is not True:
        return None
    data = verified.get("data")
    return data if isinstance(data, dict) else None


def _payout_status_value(data: dict) -> str:
    """MoneyFusion uses `statut` in its native API; keep legacy `status` support."""
    for key in ("statut", "status"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return ""


def _payout_field(data: dict, *keys: str):
    for key in keys:
        value = data.get(key)
        if value is not None and value != "":
            return value
    return None


def _payout_details_match(payout: dict, data: dict) -> bool:
    try:
        amount = float(_payout_field(data, "amount", "Montant"))
        if not math.isfinite(amount) or abs(amount - float(payout["amount"])) > 0.01:
            return False
    except (KeyError, ValueError, TypeError):
        return False
    return (
        str(_payout_field(data, "method", "withdraw_mode", "operator") or "")
        == payout["operator_code"]
        and _local_phone(
            str(_payout_field(data, "phone", "numero", "numeroSend") or ""),
            payout["country_code"],
        ) == payout["phone"]
    )


async def _notify_payout_terminal(db, withdrawal: dict, status: str, *, push: bool) -> None:
    wd_id = str(withdrawal.get("id") or "")
    user_id = withdrawal.get("user_id")
    if not wd_id or not user_id:
        return
    amount = int(float(withdrawal.get("amount") or 0))
    if status == "completed":
        title = "Retrait validé"
        body = f"Votre retrait de {amount:,} FCFA a été validé.".replace(",", " ")
    else:
        title = "Retrait rejeté"
        body = f"Votre retrait de {amount:,} FCFA a été refusé et remboursé.".replace(",", " ")
    notification_id = f"withdrawal:{wd_id}:{status}"
    try:
        await db.notifications.update_one(
            {"_id": notification_id},
            {"$setOnInsert": {
                "id": notification_id, "user_id": user_id,
                "kind": "withdrawal_status", "title": title, "body": body,
                "meta": {"withdrawal_id": wd_id, "status": status,
                         "gateway": PAYIN_PROVIDER},
                "read": False, "created_at": _now(),
            }},
            upsert=True,
        )
    except Exception:
        log.exception("MoneyFusion withdrawal notification persistence failed wd=%s", wd_id)
    if push:
        try:
            from push_helper import push_to_user
            await push_to_user(
                db, user_id, title=title, body=body,
                link="/(app)/withdrawal",
                data={"kind": "withdrawal_status", "withdrawal_id": wd_id,
                      "status": status},
                tag=notification_id,
            )
        except Exception:
            log.debug("MoneyFusion withdrawal push notification failed wd=%s", wd_id)


async def _apply_payout_status(db, payout: dict, status: str, event_data: dict) -> dict:
    wd_id = payout.get("wd_id")
    wallet_sends = getattr(db, "wallet_sends", None)
    wallet_send = await wallet_sends.find_one({"id": wd_id}, {"_id": 0}) if wallet_sends else None
    if wallet_send:
        normalized = str(status or "").lower()
        if normalized in {"success", "completed", "paid", "confirmed"}:
            outcome = await __import__("wallet_finance").settle_wallet_send(
                db, wallet_send, "completed", normalized,
                source="moneyfusion", provider_id=payout.get("tokenPay"),
            )
            terminal = "completed"
        elif normalized in {"failed", "rejected", "declined", "canceled", "cancelled", "expired"}:
            outcome = await __import__("wallet_finance").settle_wallet_send(
                db, wallet_send, "rejected", normalized,
                source="moneyfusion", provider_id=payout.get("tokenPay"),
            )
            terminal = "failed"
        else:
            await __import__("wallet_finance").settle_wallet_send(
                db, wallet_send, "pending", normalized,
                source="moneyfusion", provider_id=payout.get("tokenPay"),
            )
            terminal = ""
            outcome = {"ok": True, "status": "pending", "changed": False}
        if terminal:
            await db.moneyfusion_payouts.update_one(
                {"wd_id": wd_id},
                {"$set": {
                    "status": terminal, "verified_status": normalized,
                    "verified_data": event_data, "updated_at": _now(),
                    f"{terminal}_at": _now(),
                }},
            )
        else:
            await db.moneyfusion_payouts.update_one(
                {"wd_id": wd_id},
                {"$set": {"verified_status": normalized,
                          "verified_data": event_data, "updated_at": _now()}},
            )
        return {
            "handled": bool(outcome.get("ok")),
            "outcome": outcome.get("status") or ("failed" if terminal else "pending"),
            "changed": bool(outcome.get("changed")),
        }
    wd = await db.withdrawals.find_one({"id": wd_id})
    if not wd:
        return {"handled": False, "reason": "withdrawal_not_found"}
    status = status.lower()
    if status in {"success", "completed", "paid", "confirmed"}:
        status = "success"
    elif status in {"failed", "rejected", "declined", "canceled", "cancelled", "expired"}:
        status = "failed"
    now = _now()
    if status == "success":
        result = await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$nin": ["completed", "failed", "rejected", "validated"]}},
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
        await _notify_payout_terminal(db, settled, "completed",
                                      push=bool(result.modified_count))
        return {"handled": True, "outcome": "completed", "changed": result.modified_count > 0}
    if status == "failed":
        result = await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$nin": ["completed", "failed", "rejected", "validated"]}},
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
        await _notify_payout_terminal(db, settled, "rejected",
                                      push=bool(result.modified_count))
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
    data = _verified_payout_data(verified)
    if data is None or str(data.get("tokenPay") or "") != token:
        return {"received": True, "verified": False}
    if not _payout_details_match(payout, data):
        return {"received": True, "verified": False}
    outcome = await _apply_payout_status(db, payout, _payout_status_value(data), data)
    return {"received": True, "verified": True, "status": outcome.get("outcome")}


class PayoutReconcileRequest(BaseModel):
    token: Optional[str] = None


async def _schedule_next_payout_check(db, payout: dict) -> None:
    attempts = int(payout.get("reconcile_attempts") or 0) + 1
    now = _now()
    await db.moneyfusion_payouts.update_one(
        {"wd_id": payout.get("wd_id"), "status": {"$in": ["dispatched", "unknown"]}},
        {"$set": {
            "last_reconcile_attempt_at": now,
            "next_reconcile_at": now + timedelta(seconds=_payout_poll_delay(attempts)),
            "reconcile_attempts": attempts,
        }},
    )


async def reconcile_withdrawal(
    db, wd_id: str, *, token: Optional[str] = None, schedule_next: bool = True,
) -> dict:
    """Verify the original MoneyFusion payout; this function never submits one."""
    payout = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
    if not payout:
        raise HTTPException(404, "Retrait MoneyFusion introuvable.")
    if payout.get("status") in ("completed", "failed", "refused", "not_submitted"):
        return {"ok": True, "status": payout.get("status"), "changed": False}

    stored_token = str(payout.get("tokenPay") or "")
    supplied_token = str(token or "").strip()
    if stored_token and supplied_token and stored_token != supplied_token:
        raise HTTPException(409, "Un token est déjà associé à cette demande. Il ne peut pas être remplacé.")
    verify_token = stored_token or supplied_token
    if not _valid_token(verify_token):
        return {
            "ok": False, "reason": "token_required",
            "message": "Token MoneyFusion manquant. Récupérez le token du retrait initial; ne soumettez pas une nouvelle demande.",
        }

    if not stored_token:
        try:
            await db.moneyfusion_payouts.update_one(
                {"wd_id": wd_id, "$or": [
                    {"tokenPay": {"$exists": False}}, {"tokenPay": None}, {"tokenPay": ""},
                ]},
                {"$set": {"tokenPay": verify_token, "updated_at": _now()}},
            )
        except Exception:
            raise HTTPException(409, "Ce token MoneyFusion est déjà lié à un autre retrait.")
        payout = await db.moneyfusion_payouts.find_one({"wd_id": wd_id}, {"_id": 0})
        if not payout or payout.get("tokenPay") != verify_token:
            raise HTTPException(409, "Le token n’a pas pu être associé à cette demande.")

    if schedule_next:
        await _schedule_next_payout_check(db, payout)
    credentials = await load_credentials(db, strict=True)
    if not credentials.get("payout_private_key"):
        raise HTTPException(503, "Clé privée MoneyFusion manquante.")
    try:
        verified = await _verify_payout(verify_token, credentials["payout_private_key"])
    except Exception:
        log.warning("MoneyFusion payout status check failed wd=%s", wd_id)
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"last_reconcile_error": "status_check_unavailable",
                      "last_reconcile_error_at": _now()}},
        )
        raise HTTPException(502, "Vérification MoneyFusion indisponible. Ne renvoyez pas le retrait.")
    data = _verified_payout_data(verified)
    if (data is None or str(data.get("tokenPay") or "") != verify_token
            or not _payout_details_match(payout, data)):
        await db.moneyfusion_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"last_reconcile_error": "verified_details_mismatch",
                      "last_reconcile_error_at": _now()}},
        )
        raise HTTPException(400, "Le token ne correspond pas au montant, numéro et opérateur du retrait.")
    outcome = await _apply_payout_status(db, payout, _payout_status_value(data), data)
    return {"ok": bool(outcome.get("handled")),
            "status": outcome.get("outcome") or outcome.get("reason"),
            "changed": outcome.get("changed", False)}


async def reconcile_all_dispatched(db, max_docs: int = 50) -> dict:
    """Verify due payouts with known tokens; never resubmit a payout."""
    now = _now()
    stale_before = now - timedelta(minutes=3)
    stale_count = 0
    async for payout in db.moneyfusion_payouts.find({
        "status": "submitting", "created_at": {"$lte": stale_before},
    }).limit(max_docs):
        changed = await db.moneyfusion_payouts.update_one(
            {"wd_id": payout.get("wd_id"), "status": "submitting"},
            {"$set": {"status": "unknown", "updated_at": now,
                      "error": "Soumission interrompue; résultat non confirmé."}},
        )
        if changed.modified_count:
            stale_count += 1
            wallet_sends = getattr(db, "wallet_sends", None)
            if wallet_sends:
                await wallet_sends.update_one(
                    {"id": payout.get("wd_id"), "status": "submitting"},
                    {"$set": {
                        "status": "unknown", "gateway_status": "unknown",
                        "gateway_error": "Soumission interrompue; résultat non confirmé. Aucun nouvel envoi automatique.",
                        "updated_at": now,
                    }},
                )
            await db.withdrawals.update_one(
                {"id": payout.get("wd_id"),
                 "status": {"$in": ["pending", "dispatched", "processing"]}},
                {"$set": {
                    "status": "processing", "gateway": PAYIN_PROVIDER,
                    "gateway_status": "unknown", "auto_dispatch_attempted": True,
                    "auto_dispatch_reason": "Soumission interrompue; vérifiez le tableau MoneyFusion avant toute action.",
                    "auto_dispatch_error": "Le résultat de la soumission n’a pas été confirmé. Aucun nouvel envoi ne sera fait automatiquement.",
                    "gateway_error_code": "moneyfusion_submission_unknown",
                    "updated_at": now,
                }},
            )

    query = {
        "status": {"$in": ["dispatched", "unknown"]},
        "tokenPay": {"$type": "string", "$nin": ["", None]},
        "$or": [{"next_reconcile_at": {"$exists": False}},
                {"next_reconcile_at": {"$lte": now}}],
    }
    results = {"scanned": 0, "updated": 0, "errors": 0,
               "stale_marked_unknown": stale_count}
    async for payout in db.moneyfusion_payouts.find(query).sort("created_at", 1).limit(max_docs):
        attempts = int(payout.get("reconcile_attempts") or 0) + 1
        next_at = now + timedelta(seconds=_payout_poll_delay(attempts))
        claim = await db.moneyfusion_payouts.update_one(
            {"wd_id": payout["wd_id"], "status": payout.get("status"),
             "$or": [{"next_reconcile_at": {"$exists": False}},
                     {"next_reconcile_at": {"$lte": now}}]},
            {"$set": {"last_reconcile_attempt_at": now,
                      "next_reconcile_at": next_at,
                      "reconcile_attempts": attempts}},
        )
        if not claim.modified_count:
            continue
        results["scanned"] += 1
        try:
            outcome = await reconcile_withdrawal(
                db, payout["wd_id"], schedule_next=False,
            )
            if outcome.get("changed"):
                results["updated"] += 1
        except Exception:
            results["errors"] += 1
    return results


async def payout_polling_loop(db, *, interval_seconds: int = 30) -> None:
    """Background status reconciliation with bounded batches and backoff."""
    while True:
        try:
            outcome = await reconcile_all_dispatched(db, max_docs=50)
            if outcome.get("updated") or outcome.get("stale_marked_unknown"):
                log.info("MoneyFusion payout reconciliation: %s", outcome)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("MoneyFusion payout polling worker failed")
        await asyncio.sleep(max(10, int(interval_seconds)))


@admin.post("/payouts/{wd_id}/check")
async def admin_check_payout(wd_id: str, body: PayoutReconcileRequest, request: Request,
                            actor=Depends(require_admin)):
    """Recover the original submission without ever sending a second payout."""
    db = request.app.state.db
    outcome = await reconcile_withdrawal(db, wd_id, token=body.token)
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()), "admin_id": actor["id"],
        "action": "moneyfusion_reconcile_payout", "target": wd_id, "at": _now(),
    })
    return outcome


class AdminConfigUpdate(BaseModel):
    payin_enabled: Optional[bool] = None
    payout_enabled: Optional[bool] = None
    payin_local_currency_confirmed: Optional[bool] = None
    mobile_money_only_confirmed: Optional[bool] = None
    payout_ip_confirmed: Optional[bool] = None
    payin_country_codes: Optional[list[str]] = None
    payin_api_url: Optional[str] = None
    payout_private_key: Optional[str] = None
    # Accepted for older admin clients, but never used to set exchange rates.
    rates_per_xof: Optional[dict[str, float]] = None


@admin.get("")
async def admin_get(request: Request):
    db = request.app.state.db
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    catalog_doc = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
    fx_doc = await db.app_settings.find_one({"key": FX_CACHE_KEY}) or {}
    fx_cache = fx_doc.get("value") if isinstance(fx_doc.get("value"), dict) else {}
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
        "rates_per_xof": fx_cache.get("rates_per_xof") or {"XOF": 1.0, "XAF": 1.0},
        "fx_rate_date": fx_cache.get("rate_date"),
        "fx_source": fx_cache.get("source") or FX_SOURCE,
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
    if body.payin_enabled is True:
        # The account owner confirmed the merchant-side Pay-in contract. The
        # exact country allowlist is maintained by the enabled catalog routes.
        if body.payin_local_currency_confirmed is None:
            cfg["payin_local_currency_confirmed"] = True
        if body.mobile_money_only_confirmed is None:
            cfg["mobile_money_only_confirmed"] = True
    if cfg.get("payin_enabled") and (
        not cred.get("payin_api_url") or not cfg.get("payin_local_currency_confirmed")
        or not cfg.get("mobile_money_only_confirmed")
    ):
        raise HTTPException(400, "Pour activer les dépôts, renseignez l’URL API MoneyFusion.")
    if cfg.get("payout_enabled") and not cred.get("payout_private_key"):
        raise HTTPException(400, "Pour activer les retraits, renseignez la clé privée MoneyFusion.")
    cfg["payin_country_codes"] = await sync_enabled_payin_countries(db)
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
