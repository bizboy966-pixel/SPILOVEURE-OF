"""Wallet deposits, routed sends, and provider/country fee schedules.

No provider route is made available by default: an administrator must enable
both the existing provider route and its fee row before a quote can be created.
All provider submissions are one-shot; an uncertain response is reconciled,
never retried automatically.
"""
from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin

log = logging.getLogger("wallet_finance")
router = APIRouter()

QUOTE_TTL = timedelta(minutes=10)
ZERO_DECIMAL = {
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
    "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
}


class QuoteIn(BaseModel):
    direction: str
    route_id: str
    amount: float = Field(gt=0, le=1_000_000_000)
    fee_payer: str
    wallet_asset: Optional[str] = None


class FeeUpdateIn(BaseModel):
    enabled: bool = False
    rate_percent: float = Field(ge=0, le=100)


class SubmitIn(BaseModel):
    quote_id: str
    phone: Optional[str] = Field(default=None, max_length=40)
    email: Optional[str] = Field(default=None, max_length=254)
    full_name: Optional[str] = Field(default=None, max_length=160)
    recipient_address: Optional[str] = Field(default=None, max_length=256)
    otp: Optional[str] = Field(default=None, max_length=32)
    ussd_authorized: bool = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    # Hex-only IDs are safe as MongoDB subdocument path segments.
    return uuid.uuid4().hex


def _asset_key(asset: str) -> str:
    key = re.sub(r"[^A-Za-z0-9_]", "_", str(asset or "").upper()).strip("_")
    return key[:80] or "UNKNOWN"


def _wallet_field(asset: str) -> str:
    code = str(asset or "").upper()
    return "wallet_deposit_balance" if code == "XOF" else f"wallet_balances.{_asset_key(code)}"


def _decimals(code: str) -> int:
    code = str(code or "").upper()
    return 6 if "." in code or "_" in code or code.startswith(("USDT", "USDC", "BTC", "ETH")) else (
        0 if code in ZERO_DECIMAL else 2
    )


def _money(value: Any, code: str) -> float:
    amount = Decimal(str(value))
    if not amount.is_finite():
        raise ValueError("Montant invalide.")
    quantum = Decimal(1).scaleb(-_decimals(code))
    return float(amount.quantize(quantum, rounding=ROUND_HALF_UP))


def calculate_fee_quote(
    amount: float, rate_percent: float, fee_payer: str, direction: str, currency: str,
) -> dict:
    """Pure percent-fee calculation used by both quote routes and regression tests."""
    if direction not in {"deposit", "send"}:
        raise ValueError("Sens de paiement invalide.")
    if fee_payer not in {"client", "sender"}:
        raise ValueError("Choisissez qui paie les frais.")
    base = Decimal(str(amount))
    rate = Decimal(str(rate_percent))
    if not base.is_finite() or base <= 0 or not rate.is_finite() or rate < 0 or rate > 100:
        raise ValueError("Montant ou pourcentage invalide.")
    base = Decimal(str(_money(base, currency)))
    quantum = Decimal(1).scaleb(-_decimals(currency))
    fee = (base * rate / Decimal(100)).quantize(quantum, rounding=ROUND_HALF_UP)
    if fee_payer == "client":
        total = base + fee
        recipient = base
    else:
        total = base
        recipient = base - fee
    if recipient <= 0:
        raise ValueError("Les frais sont supérieurs ou égaux au montant.")
    return {
        "amount": float(base),
        "fee_amount": float(fee),
        "total_amount": float(total),
        "recipient_amount": float(recipient),
        "wallet_debit": float(total) if direction == "send" else 0.0,
        "provider_amount": float(recipient) if direction == "send" else float(total),
        "wallet_credit": float(recipient) if direction == "deposit" else 0.0,
    }


def _route_id(provider: str, direction: str, route_type: str, country: str,
              operator: str = "", asset: str = "") -> str:
    key = "|".join([
        provider.lower(), direction.lower(), route_type.lower(),
        (country or "*").upper(), operator.strip(), asset.strip().upper(),
    ])
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def _country_name(code: str, fallback: str = "") -> str:
    try:
        from levels import COUNTRIES
        return next((str(row["name"]) for row in COUNTRIES if row["code"] == code), fallback or code)
    except Exception:
        return fallback or code


async def _provider_runtime_ready(db, provider_id: str, direction: str, route_type: str) -> bool:
    try:
        if provider_id == "moneyfusion":
            from moneyfusion import _valid_payin_api_url, load_config, load_credentials
            cfg = await load_config(db)
            credentials = await load_credentials(db)
            if direction == "deposit":
                return bool(
                    route_type == "mobile" and cfg.get("payin_enabled")
                    and cfg.get("mobile_money_only_confirmed")
                    and cfg.get("payin_local_currency_confirmed")
                    and _valid_payin_api_url(credentials.get("payin_api_url") or "")
                )
            return bool(cfg.get("payout_enabled") and credentials.get("payout_private_key"))
        if provider_id == "biztranspay":
            from biztranspay import is_crypto_enabled, is_payout_enabled, is_payin_enabled
            if route_type == "crypto":
                return bool(direction == "deposit" and await is_crypto_enabled(db))
            if direction == "deposit":
                return bool(await is_payin_enabled(db))
            return bool(await is_payout_enabled(db))
    except Exception as exc:
        log.info("%s %s runtime readiness unavailable: %s",
                 provider_id, direction, type(exc).__name__)
    return False


async def initialize(db) -> None:
    """Create only new indexes; no existing payment records are rewritten."""
    await db.wallet_fee_schedules.create_index("route_id", unique=True, name="wallet_fee_route_unique")
    await db.wallet_quotes.create_index("id", unique=True, name="wallet_quote_id_unique")
    await db.wallet_sends.create_index("id", unique=True, name="wallet_send_id_unique")
    await db.wallet_sends.create_index("quote_id", unique=True, name="wallet_send_quote_unique")
    await db.wallet_operations.create_index("reference", unique=True, name="wallet_operation_reference_unique")
    await db.wallet_sends.create_index([("user_id", 1), ("created_at", -1)])
    await db.wallet_sends.create_index([("status", 1), ("provider", 1), ("updated_at", 1)])


async def _fee_map(db) -> dict[str, dict]:
    rows = await db.wallet_fee_schedules.find({}, {"_id": 0}).to_list(5000)
    return {str(row.get("route_id")): row for row in rows}


async def _provider_route_rows(db, direction: str) -> list[dict]:
    """Build fee routes from provider catalogs; do not invent operators."""
    kind = "payin" if direction == "deposit" else "payout"
    provider_country = db.payment_provider_countries if kind == "payin" else db.payment_provider_payout_countries
    provider_operator = db.payment_provider_operators if kind == "payin" else db.payment_provider_payout_operators
    catalog_by_provider: dict[str, list[dict]] = {}

    try:
        from moneyfusion import refresh_catalog
        catalog_by_provider["moneyfusion"] = await refresh_catalog(db)
    except Exception as exc:
        log.info("MoneyFusion fee catalog unavailable: %s", type(exc).__name__)
        cached = await db.app_settings.find_one({"key": "moneyfusion_catalog"}) or {}
        catalog_by_provider["moneyfusion"] = cached.get("value") or []

    try:
        from btp_catalog import fetch_catalog
        catalog_by_provider["biztranspay"] = await fetch_catalog(
            db, "deposit" if direction == "deposit" else "payout",
        )
    except Exception as exc:
        log.info("Biz-transPay fee catalog unavailable: %s", type(exc).__name__)
        cached = await db.app_settings.find_one(
            {"key": f"btp_catalog:{'deposit' if direction == 'deposit' else 'payout'}"}
        ) or {}
        catalog_by_provider["biztranspay"] = cached.get("value") or []

    all_routes: list[dict] = []
    for provider_id, catalog in catalog_by_provider.items():
        provider = await db.payment_providers.find_one({"id": provider_id}, {"_id": 0}) or {}
        provider_name = provider.get("name") or (
            "MoneyFusion" if provider_id == "moneyfusion" else "Biz-transPay"
        )
        runtime_ready = await _provider_runtime_ready(db, provider_id, direction, "mobile")
        for country in catalog or []:
            if provider_id == "moneyfusion":
                cc = str(country.get("country_code") or "").upper()
                currency = str(country.get("currency") or "").upper()
                country_label = country.get("country") or _country_name(cc, cc)
                operators = country.get("operators") or []
            else:
                cc = str(country.get("country") or country.get("country_code") or "").upper()
                currency = str(country.get("currency") or "").upper()
                country_label = _country_name(cc, cc)
                operators = [{
                    "code": country.get("code"),
                    "label": country.get("label") or country.get("code"),
                }]
            if not cc or not currency:
                continue
            country_row = await provider_country.find_one(
                {"provider_id": provider_id, "country_code": cc}, {"_id": 0},
            ) or {}
            for operator in operators:
                code = str(operator.get("code") or "").strip()
                label = str(operator.get("label") or code).strip()
                if not code:
                    continue
                operator_row = await provider_operator.find_one(
                    {"provider_id": provider_id, "country_code": cc, "operator_code": code},
                    {"_id": 0},
                ) or {}
                rid = _route_id(provider_id, direction, "mobile", cc, code)
                all_routes.append({
                    "route_id": rid, "provider": provider_id, "provider_name": provider_name,
                    "direction": direction, "route_type": "mobile", "country_code": cc,
                    "country_name": country_label, "currency": currency,
                    "operator_code": code, "operator_name": label,
                    "country_enabled": country_row.get("status") == "active",
                    "operator_enabled": operator_row.get("status") == "active",
                    "provider_enabled": (
                        provider.get("status") == "active"
                        and bool(provider.get("auto_deposit" if direction == "deposit" else "auto_withdrawal"))
                        and runtime_ready
                    ),
                    "hosted_operator_selection_required": (
                        provider_id == "moneyfusion" and len(operators) != 1
                    ),
                })
    return all_routes


async def _crypto_catalog(db, direction: str) -> list[dict]:
    try:
        from btp_catalog import fetch_crypto_assets
        return await fetch_crypto_assets(db, direction)
    except Exception as exc:
        log.info("Biz-transPay crypto %s catalog unavailable: %s", direction, type(exc).__name__)
        cached = await db.app_settings.find_one(
            {"key": f"btp_catalog:crypto_assets_{direction}"}
        ) or {}
        return cached.get("value") or []


async def _catalog_rows(db) -> list[dict]:
    fees = await _fee_map(db)
    rows = []
    for direction in ("deposit", "send"):
        routes = await _provider_route_rows(db, direction)
        for row in routes:
            fee = fees.get(row["route_id"]) or {}
            available = (
                row["country_enabled"] and row["operator_enabled"] and row["provider_enabled"]
                and bool(fee.get("enabled"))
                and not row["hosted_operator_selection_required"]
            )
            reason = ""
            if not fee.get("enabled"):
                reason = "Frais non configurés ou désactivés."
            elif row["hosted_operator_selection_required"]:
                reason = "MoneyFusion ne permet pas de présélectionner cet opérateur."
            elif not row["country_enabled"] or not row["operator_enabled"]:
                reason = "Pays ou opérateur désactivé dans le catalogue prestataire."
            elif not row["provider_enabled"]:
                reason = "Prestataire désactivé, sans clés valides ou sans accord de devise confirmé."
            if available:
                from payment_router import pick_provider
                selected = await pick_provider(
                    db, kind="payin" if direction == "deposit" else "payout",
                    country=row["country_code"], operator=row["operator_code"],
                )
                if not selected or selected.get("provider_id") != row["provider"]:
                    available = False
                    reason = "Cette route n’est pas celle sélectionnée par le routage prestataire."
            rows.append({
                **row, "fee_enabled": bool(fee.get("enabled")),
                "fee_percent": float(fee.get("rate_percent") or 0),
                "available": available, "unavailable_reason": reason,
            })

    # Crypto is surfaced only when the merchant's live account catalog returns
    # the asset. Crypto payouts remain unavailable unless the payout catalog and
    # an implemented, verified payout contract both exist.
    for direction, catalog_direction in (("deposit", "deposit"), ("send", "payout")):
        assets = await _crypto_catalog(db, catalog_direction)
        for entry in assets:
            code = str(entry.get("code") or entry.get("asset_code") or "").strip()
            if not code:
                continue
            coin = str(entry.get("coin") or entry.get("symbol") or code.split(".")[0]).upper()
            network = str(entry.get("network") or entry.get("chain") or (
                code.split(".", 1)[1] if "." in code else ""
            )).upper()
            rid = _route_id("biztranspay", direction, "crypto", "*", asset=code)
            fee = fees.get(rid) or {}
            enabled_crypto = await _provider_runtime_ready(db, "biztranspay", direction, "crypto")
            # Crypto payout creation is intentionally closed until its exact
            # provider request contract is confirmed; webhook event names alone
            # are not enough to safely submit an irreversible transfer.
            available = bool(
                direction == "deposit" and enabled_crypto and fee.get("enabled")
            )
            reason = ""
            if direction == "send":
                reason = "Le retrait crypto Biz-transPay n’est pas activé tant que son contrat API n’est pas vérifié."
            elif not fee.get("enabled"):
                reason = "Frais crypto non configurés ou désactivés."
            elif not enabled_crypto:
                reason = "Biz-transPay Crypto est désactivé ou incomplet."
            rows.append({
                "route_id": rid, "provider": "biztranspay",
                "provider_name": "Biz-transPay", "direction": direction,
                "route_type": "crypto", "country_code": "*",
                "country_name": "Tous les pays", "currency": code,
                "asset_code": code, "coin": coin, "network": network,
                "operator_code": "", "operator_name": "",
                "country_enabled": True, "operator_enabled": True,
                "provider_enabled": enabled_crypto, "fee_enabled": bool(fee.get("enabled")),
                "fee_percent": float(fee.get("rate_percent") or 0),
                "available": available, "unavailable_reason": reason,
            })
    return rows


def _wallet_balance(user: dict, asset: str) -> float:
    if str(asset).upper() == "XOF":
        return float(user.get("wallet_deposit_balance") or 0)
    return float((user.get("wallet_balances") or {}).get(_asset_key(asset), 0) or 0)


async def _active_route(db, route_id: str, direction: str) -> dict:
    row = next((r for r in await _catalog_rows(db)
                if r.get("route_id") == route_id and r.get("direction") == direction), None)
    if not row:
        raise HTTPException(400, "Cette route n’existe pas dans le catalogue des prestataires.")
    if not row.get("available"):
        raise HTTPException(503, row.get("unavailable_reason") or "Cette route est indisponible.")
    return row


def _assert_transaction_user(user: dict) -> None:
    if user.get("role") == "admin":
        return
    if user.get("status") != "active" or int(user.get("max_level") or 0) < 1:
        raise HTTPException(403, "ACTIVATION_REQUIRED")


@router.get("/api/wallet-operations/catalog")
async def wallet_operations_catalog(
    request: Request, direction: str = "deposit", user=Depends(get_current_user),
):
    if direction not in {"deposit", "send"}:
        raise HTTPException(400, "Sens invalide.")
    rows = await _catalog_rows(request.app.state.db)
    selected = [row for row in rows if row["direction"] == direction]
    countries: dict[str, dict] = {}
    for row in selected:
        if row["route_type"] != "mobile":
            continue
        code = row["country_code"]
        country = countries.setdefault(code, {
            "code": code, "name": row["country_name"], "currency": row["currency"],
            "operators": [],
        })
        country["operators"].append({
            "route_id": row["route_id"], "code": row["operator_code"],
            "name": row["operator_name"], "provider": row["provider"],
            "provider_name": row["provider_name"], "available": row["available"],
            "unavailable_reason": row["unavailable_reason"],
            "currency": row["currency"], "fee_percent": row["fee_percent"],
        })
    if direction == "deposit":
        try:
            from levels import COUNTRIES
            for entry in COUNTRIES:
                code = str(entry.get("code") or "").upper()
                if code:
                    countries.setdefault(code, {
                        "code": code, "name": entry.get("name") or code,
                        "currency": "", "operators": [],
                    })
        except Exception:
            pass
    return {
        "direction": direction,
        "countries": sorted(countries.values(), key=lambda item: item["name"]),
        "crypto_assets": [row for row in selected if row["route_type"] == "crypto"],
        "wallets": [
            {"asset_code": "XOF", "balance": _wallet_balance(user, "XOF")},
            *[
                {"asset_code": (user.get("wallet_asset_codes") or {}).get(code, code.replace("_", ".")),
                 "balance": float(amount or 0)}
                for code, amount in sorted((user.get("wallet_balances") or {}).items())
            ],
        ],
    }


@router.post("/api/wallet-operations/quote")
async def create_wallet_quote(data: QuoteIn, request: Request, user=Depends(get_current_user)):
    _assert_transaction_user(user)
    db = request.app.state.db
    if data.direction not in {"deposit", "send"}:
        raise HTTPException(400, "Sens invalide.")
    if data.fee_payer not in {"client", "sender"}:
        raise HTTPException(400, "Choisissez qui paie les frais.")
    route = await _active_route(db, data.route_id, data.direction)
    if data.direction == "send" and route["route_type"] != "mobile":
        raise HTTPException(503, "Les envois crypto ne sont pas activés pour ce contrat prestataire.")
    asset = route.get("asset_code") or route["currency"]
    if data.direction == "send":
        wallet_asset = str(data.wallet_asset or "").upper()
        if wallet_asset != str(route["currency"]).upper():
            raise HTTPException(400, "Le portefeuille choisi doit être dans la devise du pays destinataire.")
        if _wallet_balance(user, wallet_asset) <= 0:
            raise HTTPException(400, f"Le portefeuille {wallet_asset} ne contient aucun solde disponible.")
    rate = float(route.get("fee_percent") or 0)
    try:
        amounts = calculate_fee_quote(
            data.amount, rate, data.fee_payer, data.direction, asset,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if data.direction == "send":
        amounts["wallet_debit"] = amounts["total_amount"]
        available = _wallet_balance(user, str(data.wallet_asset))
        if available < amounts["wallet_debit"]:
            raise HTTPException(400, "Solde insuffisant pour couvrir le montant et les frais.")
    quote_id = _new_id()
    now = _now()
    quote = {
        "id": quote_id, "user_id": user["id"], "direction": data.direction,
        "route_id": route["route_id"], "route_type": route["route_type"],
        "provider": route["provider"], "country_code": route["country_code"],
        "operator_code": route.get("operator_code") or "",
        "asset_code": asset, "currency": route["currency"],
        "wallet_asset": str(data.wallet_asset or asset).upper(),
        "fee_payer": data.fee_payer, "fee_percent": rate,
        **amounts, "status": "quoted",
        "expires_at": now + QUOTE_TTL, "created_at": now, "updated_at": now,
    }
    await db.wallet_quotes.insert_one(quote)
    return {
        "quote_id": quote_id, "direction": data.direction,
        "provider": route["provider_name"], "country": route["country_name"],
        "operator": route.get("operator_name") or route.get("asset_code"),
        "currency": asset, "fee_percent": rate,
        "fee_payer": data.fee_payer, **amounts,
        "expires_at": quote["expires_at"],
    }


@router.get("/api/admin/wallet-fees/catalog")
async def admin_wallet_fee_catalog(request: Request, _=Depends(require_admin)):
    return {"routes": await _catalog_rows(request.app.state.db)}


@router.get("/api/admin/wallet-fees")
async def admin_wallet_fees(request: Request, _=Depends(require_admin)):
    db = request.app.state.db
    rows = await _catalog_rows(db)
    fee_rows = await _fee_map(db)
    return {"routes": [
        {**row, "enabled": bool(fee_rows.get(row["route_id"], {}).get("enabled")),
         "rate_percent": float(fee_rows.get(row["route_id"], {}).get("rate_percent") or 0)}
        for row in rows
    ]}


@router.put("/api/admin/wallet-fees/{route_id}")
async def update_wallet_fee(
    route_id: str, data: FeeUpdateIn, request: Request, actor=Depends(require_admin),
):
    db = request.app.state.db
    route = next((r for r in await _catalog_rows(db) if r["route_id"] == route_id), None)
    if not route:
        raise HTTPException(404, "Cette route n’existe plus dans le catalogue fournisseur.")
    now = _now()
    await db.wallet_fee_schedules.update_one(
        {"route_id": route_id},
        {"$set": {
            "route_id": route_id, "provider": route["provider"],
            "direction": route["direction"], "route_type": route["route_type"],
            "country_code": route["country_code"],
            "operator_code": route.get("operator_code") or "",
            "asset_code": route.get("asset_code") or "",
            "enabled": bool(data.enabled), "rate_percent": float(data.rate_percent),
            "updated_at": now, "updated_by": actor.get("id"),
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    await db.admin_logs.insert_one({
        "id": _new_id(), "admin_id": actor.get("id"),
        "action": "wallet_fee_updated", "target_id": route_id,
        "details": {"enabled": bool(data.enabled), "rate_percent": float(data.rate_percent)},
        "created_at": now,
    })
    return {"ok": True, "route_id": route_id, "enabled": bool(data.enabled),
            "rate_percent": float(data.rate_percent)}


async def _claim_quote(db, quote_id: str, user_id: str, direction: str) -> dict:
    quote = await db.wallet_quotes.find_one({"id": quote_id, "user_id": user_id}, {"_id": 0})
    if not quote:
        raise HTTPException(404, "Devis introuvable.")
    if quote.get("direction") != direction:
        raise HTTPException(400, "Le devis ne correspond pas à cette opération.")
    if quote.get("expires_at") and quote["expires_at"] < _now():
        raise HTTPException(410, "Le devis a expiré. Créez-en un nouveau.")
    return quote


def _valid_email(value: str) -> bool:
    return bool(re.fullmatch(r"[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{2,30}", value or ""))


def _valid_phone(value: str) -> bool:
    digits = re.sub(r"\D", "", value or "")
    return 6 <= len(digits) <= 15


async def _moneyfusion_deposit(db, user: dict, quote: dict, data: SubmitIn, reference: str) -> dict:
    from moneyfusion import (
        PAYIN_PROVIDER, _amount_from_xof, _now as mf_now, _rate_for,
        _safe_checkout_url, _valid_payin_api_url, automatic_fx_rates,
        load_config, load_credentials, refresh_catalog,
    )
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    api_url = credentials.get("payin_api_url") or ""
    if not (cfg.get("payin_enabled") and cfg.get("payin_local_currency_confirmed")
            and cfg.get("mobile_money_only_confirmed") and _valid_payin_api_url(api_url)):
        raise HTTPException(503, "MoneyFusion Pay-in est désactivé ou incomplet.")
    methods = await refresh_catalog(db)
    country = next((row for row in methods if row["country_code"] == quote["country_code"]), None)
    if not country or len(country.get("operators") or []) != 1:
        raise HTTPException(503, "MoneyFusion doit proposer un seul opérateur dans ce pays pour garantir le routage demandé.")
    operator = country["operators"][0]
    if operator["code"] != quote["operator_code"]:
        raise HTTPException(409, "Le catalogue MoneyFusion a changé. Recommencez le devis.")
    if not _valid_phone(data.phone or ""):
        raise HTTPException(400, "Numéro Mobile Money invalide.")
    if not _valid_email(data.email or ""):
        raise HTTPException(400, "Adresse e-mail invalide.")
    from payment_router import pick_provider
    selected = await pick_provider(
        db, kind="payin", country=quote["country_code"], operator=quote["operator_code"],
    )
    if not selected or selected.get("provider_id") != PAYIN_PROVIDER:
        raise HTTPException(503, "MoneyFusion n’est plus le prestataire actif pour cet opérateur.")
    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    if not public_url.startswith("https://"):
        raise HTTPException(503, "PUBLIC_APP_URL doit contenir l’adresse HTTPS publique du site.")
    cc = quote["country_code"]
    currency = quote["currency"]
    fx = await automatic_fx_rates(db, [currency])
    fx_cfg = {**cfg, "rates_per_xof": fx.get("rates_per_xof") or {}}
    fx_rate = _rate_for(fx_cfg, currency) or (1.0 if currency in {"XOF", "XAF"} else None)
    if not fx_rate:
        raise HTTPException(503, f"Taux automatique {currency}/XOF indisponible.")
    amount_xof = float(Decimal(str(quote["provider_amount"])) / Decimal(str(fx_rate)))
    amount = _amount_from_xof(fx_cfg, amount_xof, currency)
    if amount is None or abs(amount - float(quote["provider_amount"])) > (0.01 if currency not in ZERO_DECIMAL else 1):
        raise HTTPException(503, "Le montant converti par MoneyFusion ne correspond pas au devis.")
    local_phone = re.sub(r"\D", "", data.phone or "")
    payment = {
        "reference": reference, "provider": PAYIN_PROVIDER, "kind": "wallet_deposit",
        "wallet_quote_id": quote["id"], "wallet_fee_amount": quote["fee_amount"],
        "wallet_credit_amount": quote["wallet_credit"],
        "wallet_asset_code": quote["asset_code"], "user_id": user["id"],
        "username": user.get("username"), "amount": amount, "currency": currency,
        "base_amount_xof": amount_xof, "fx_rate_per_xof": fx_rate,
        "fx_rate_date": (fx.get("rate_dates") or {}).get(currency, "parité fixe"),
        "fx_source": fx.get("source"), "phone": local_phone,
        "country_code": cc, "operator": quote["operator_code"],
        "payer_email": data.email, "status": "submitting",
        "activation_done": False, "created_at": mf_now(), "updated_at": mf_now(),
        "moneyfusion_active_key": f"{user['id']}:wallet_deposit:{quote['id']}",
    }
    await db.payments.insert_one(payment)
    payload = {
        "totalPrice": amount, "article": [{"Dépôt portefeuille SPILOVEURE": amount}],
        "numeroSend": local_phone,
        "nomclient": str(user.get("full_name") or user.get("username") or "SPILOVEURE")[:120],
        "personal_Info": [{"userId": user["id"], "orderId": reference,
                           "country": cc, "currency": currency, "email": data.email}],
        "return_url": f"{public_url}/purchase-payment?reference={reference}",
        "webhook_url": f"{public_url}/api/webhooks/moneyfusion/payin",
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(api_url, json=payload,
                                         headers={"Content-Type": "application/json"})
    except Exception as exc:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "unknown", "activation_error": "Soumission incertaine; vérifier avant toute nouvelle demande.",
                      "updated_at": mf_now()}},
        )
        log.warning("MoneyFusion wallet deposit submission uncertain ref=%s (%s)", reference, type(exc).__name__)
        return {
            "reference": reference, "status": "unknown", "provider": PAYIN_PROVIDER,
            "message": "Résultat incertain. Utilisez Actualiser le statut avant toute autre action.",
        }
    if response.status_code >= 400:
        uncertain = response.status_code >= 500 or response.status_code in (408, 409, 429)
        try:
            error_body = response.json()
        except Exception:
            error_body = {}
        detail = str(error_body.get("message") or error_body.get("detail")
                     or "MoneyFusion a refusé le dépôt.")[:300]
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "unknown" if uncertain else "failed",
                      "activation_error": detail, "updated_at": mf_now()},
             "$unset": {} if uncertain else {"moneyfusion_active_key": ""}},
        )
        if uncertain:
            return {"reference": reference, "status": "unknown", "provider": PAYIN_PROVIDER,
                    "message": "Résultat incertain. Utilisez Actualiser le statut avant toute autre action."}
        raise HTTPException(400, detail)
    try:
        result = response.json()
    except Exception:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "unknown", "activation_error": "Réponse illisible.",
                      "updated_at": mf_now()}},
        )
        return {
            "reference": reference, "status": "unknown", "provider": PAYIN_PROVIDER,
            "message": "Réponse illisible. Utilisez Actualiser le statut avant toute autre action.",
        }
    token = str(result.get("token") or "").strip()
    url = str(result.get("url") or "").strip()
    if result.get("statut") is False:
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "failed", "activation_error": "Réponse MoneyFusion invalide",
                      "updated_at": mf_now()},
             "$unset": {"moneyfusion_active_key": ""}},
        )
        raise HTTPException(400, "MoneyFusion a refusé le dépôt.")
    if result.get("statut") is not True or not token or not _safe_checkout_url(url):
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "unknown", "activation_error": "Réponse MoneyFusion non confirmée.",
                      "updated_at": mf_now()}},
        )
        return {
            "reference": reference, "status": "unknown", "provider": PAYIN_PROVIDER,
            "message": "Réponse non confirmée. Utilisez Actualiser le statut avant toute autre action.",
        }
    await db.payments.update_one(
        {"reference": reference},
        {"$set": {"provider_token": token, "payment_url": url,
                  "status": "pending", "updated_at": mf_now()}},
    )
    return {"reference": reference, "status": "pending", "redirect_url": url,
            "amount": amount, "currency": currency, "provider": PAYIN_PROVIDER}


async def _btp_mobile_deposit(db, user: dict, quote: dict, data: SubmitIn, reference: str) -> dict:
    from biztranspay import (
        _get_public_key, _get_secret_key, _load_cfg, _post, _toggle_on,
        _btp_error_detail, _new_ref,
    )
    from btp_catalog import e164, fetch_catalog, flow_steps, find_entry, render_ussd
    cc, op = quote["country_code"], quote["operator_code"]
    await fetch_catalog(db, "deposit", force=True, strict=True)
    entry = await find_entry(db, "deposit", cc, op)
    if not entry or entry["currency"] != quote["currency"]:
        raise HTTPException(409, "Le catalogue Biz-transPay a changé. Recommencez le devis.")
    route = await _active_route(db, quote["route_id"], "deposit")
    if route["provider"] != "biztranspay":
        raise HTTPException(409, "Biz-transPay n’est plus le prestataire actif pour cet opérateur.")
    secret, public = await _get_secret_key(db), await _get_public_key(db)
    if not secret or not public:
        raise HTTPException(503, "Clés Biz-transPay manquantes.")
    phone = e164(data.phone or "", cc)
    if not _valid_email(data.email or ""):
        raise HTTPException(400, "Adresse e-mail invalide.")
    amount = float(quote["provider_amount"])
    body = {"amount": amount, "country": cc, "operator": entry["code"],
            "currency": entry["currency"], "fee_bearer": "receiver"}
    try:
        q = await _post("/deposits/quote", body, secret, public, idempotency_key=_new_ref())
        if q.status_code >= 400:
            raise HTTPException(503, "Le devis Biz-transPay est indisponible; aucun dépôt n’a été lancé.")
        qj = q.json()
        flow = dict(entry.get("flow") or {})
        flow.update({k: v for k, v in (qj.get("payment_flow") or {}).items() if v is not None})
        charged = float(qj.get("charged_amount") or amount)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("BTP wallet deposit quote failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Impossible de vérifier le montant Biz-transPay; aucun dépôt n’a été lancé.")
    if abs(charged - amount) > (0.01 if entry["currency"] not in ZERO_DECIMAL else 1):
        raise HTTPException(503, "Le devis Biz-transPay ne correspond pas au résumé affiché.")
    ussd = qj.get("code_to_enter") or (qj.get("payment_flow") or {}).get("ussd_code") or render_ussd(flow, charged)
    amount_label = f"{charged:,.2f} {entry['currency']}"
    if flow.get("kind") == "ussd" and flow.get("before_submit") and not data.ussd_authorized:
        return {"status": "ussd_authorization_required", "reference": None,
                "ussd": ussd, "steps": flow_steps(flow, amount_label, ussd),
                "message": "Composez le code USSD et autorisez le paiement avant de continuer."}
    if flow.get("otp_required") and not data.otp:
        if flow.get("otp_request_before_submit"):
            otp_response = await _post(
                "/deposits", {**body, "phone_number": phone,
                              "full_name": (user.get("full_name") or user.get("username") or "SPILOVEURE")[:160],
                              "email": data.email, "request_otp": True},
                secret, public, idempotency_key=f"wallet-otp-{quote['id']}",
            )
            if otp_response.status_code >= 400:
                raise HTTPException(400, f"Biz-transPay : {_btp_error_detail(otp_response)[0]}")
            return {"status": "otp_sent", "reference": None,
                    "message": "Un code a été envoyé. Saisissez-le pour continuer.",
                    "steps": flow_steps(flow, amount_label, ussd)}
        return {"status": "otp_required", "reference": None,
                "ussd": ussd, "message": "Saisissez le code OTP fourni par votre opérateur.",
                "steps": flow_steps(flow, amount_label, ussd)}

    payer = {
        "phone_number": phone,
        "full_name": str(data.full_name or user.get("full_name") or user.get("username") or "SPILOVEURE")[:160].ljust(2, "."),
        "email": data.email,
    }
    if flow.get("address_required"):
        payer["address"] = user.get("city") or user.get("country_name") or cc
    payment = {
        "reference": reference, "provider": "biztranspay", "kind": "wallet_deposit",
        "wallet_quote_id": quote["id"], "wallet_fee_amount": quote["fee_amount"],
        "wallet_credit_amount": quote["wallet_credit"], "wallet_asset_code": quote["asset_code"],
        "user_id": user["id"], "username": user.get("username"),
        "amount": amount, "charged_amount": charged, "currency": entry["currency"],
        "country_code": cc, "operator": entry["code"], "phone": phone,
        "payer_email": data.email, "payment_flow": flow,
        "status": "submitting", "activation_done": False,
        "created_at": _now(), "updated_at": _now(),
    }
    await db.payments.insert_one(payment)
    submit_body = {**body, **payer, "reference": reference}
    if flow.get("kind") == "ussd" and flow.get("before_submit"):
        submit_body["ussd_authorized"] = True
    if data.otp:
        submit_body["otp"] = data.otp
    try:
        response = await _post("/deposits", submit_body, secret, public, idempotency_key=reference)
    except Exception as exc:
        await db.payments.update_one(
            {"reference": reference}, {"$set": {
                "status": "unknown", "activation_error": "Résultat de soumission incertain.",
                "updated_at": _now()}},
        )
        log.warning("BTP wallet deposit submission uncertain ref=%s (%s)", reference, type(exc).__name__)
        return {
            "reference": reference, "status": "unknown", "provider": "biztranspay",
            "message": "Résultat incertain. Actualisez le statut avant toute autre action.",
        }
    if response.status_code >= 400:
        detail, payload = _btp_error_detail(response)
        uncertain = response.status_code >= 500 or response.status_code in (408, 409, 429)
        await db.payments.update_one(
            {"reference": reference},
            {"$set": {"status": "unknown" if uncertain else "failed",
                      "activation_error": detail[:300], "updated_at": _now()}},
        )
        if uncertain:
            return {
                "reference": reference, "status": "unknown", "provider": "biztranspay",
                "message": "Résultat incertain. Actualisez le statut avant toute autre action.",
            }
        raise HTTPException(400, f"Biz-transPay : {detail or 'paiement refusé'}")
    payload = response.json() if response.content else {}
    deposit = payload.get("deposit") or {}
    provider_id = payload.get("id") or deposit.get("id")
    status = str(payload.get("status") or deposit.get("status") or "pending").lower()
    redirect_url = deposit.get("redirect_url") or (deposit.get("payment_flow") or {}).get("redirect_url")
    if redirect_url and not str(redirect_url).startswith("https://"):
        redirect_url = None
    await db.payments.update_one(
        {"reference": reference}, {"$set": {
            "provider_intent_id": provider_id, "biztranspay_status": status,
            "redirect_url": redirect_url, "status": "pending",
            "updated_at": _now()}},
    )
    if status in {"completed", "paid", "success", "approved"}:
        from ashtec_activation import _apply_payment_success
        stored = await db.payments.find_one({"reference": reference}, {"_id": 0})
        await _apply_payment_success(db, stored, "paid", source="biztranspay")
    return {
        "reference": reference, "status": status, "provider": "biztranspay",
        "currency": entry["currency"], "amount": charged, "redirect_url": redirect_url,
        "ussd": ussd if flow.get("kind") == "ussd" else "",
        "message": "Validez la demande sur votre téléphone.",
    }


async def _btp_crypto_deposit(db, user: dict, quote: dict, data: SubmitIn, reference: str) -> dict:
    from biztranspay import _get_public_key, _get_secret_key, _load_cfg, _post, is_crypto_enabled
    from btp_catalog import fetch_crypto_assets
    if not await is_crypto_enabled(db):
        raise HTTPException(503, "Biz-transPay Crypto est désactivé ou incomplet.")
    live_assets = await fetch_crypto_assets(db, "deposit", force=True, strict=True)
    asset = quote["asset_code"]
    if not any(str(item.get("code") or item.get("asset_code") or "") == asset for item in live_assets):
        raise HTTPException(409, "Cet actif n’est plus présent dans le catalogue crypto Biz-transPay.")
    secret, public = await _get_secret_key(db), await _get_public_key(db)
    if not secret or not public:
        raise HTTPException(503, "Clés Biz-transPay manquantes.")
    cfg = await _load_cfg(db)
    refund_address = str(cfg.get("biztranspay_crypto_refund_address") or "").strip()
    if not refund_address:
        raise HTTPException(503, "Adresse de remboursement crypto non configurée par l’administrateur.")
    if not _valid_email(data.email or ""):
        raise HTTPException(400, "Adresse e-mail invalide.")
    full_name = str(data.full_name or user.get("full_name") or user.get("username") or "SPILOVEURE")[:160].ljust(2, ".")
    payment = {
        "reference": reference, "provider": "biztranspay", "kind": "wallet_deposit",
        "wallet_quote_id": quote["id"], "wallet_fee_amount": quote["fee_amount"],
        "wallet_credit_amount": quote["wallet_credit"], "wallet_asset_code": asset,
        "user_id": user["id"], "username": user.get("username"),
        "amount": float(quote["provider_amount"]), "currency": asset,
        "asset_code": asset, "country_code": "*", "payer_email": data.email,
        "status": "submitting", "activation_done": False,
        "created_at": _now(), "updated_at": _now(),
    }
    await db.payments.insert_one(payment)
    payload = {
        "amount": float(quote["provider_amount"]), "asset_code": asset,
        "full_name": full_name, "email": data.email,
        "refund_address": refund_address, "reference": reference,
    }
    try:
        response = await _post("/crypto/deposits", payload, secret, public, idempotency_key=reference)
    except Exception as exc:
        await db.payments.update_one(
            {"reference": reference}, {"$set": {
                "status": "unknown", "activation_error": "Résultat de soumission incertain.",
                "updated_at": _now()}},
        )
        log.warning("BTP crypto deposit submission uncertain ref=%s (%s)", reference, type(exc).__name__)
        return {
            "reference": reference, "status": "unknown", "provider": "biztranspay",
            "asset_code": asset,
            "message": "Résultat incertain. Actualisez le statut avant toute autre action.",
        }
    if response.status_code >= 400:
        detail, _ = _btp_error_detail(response)
        uncertain = response.status_code >= 500 or response.status_code in (408, 409, 429)
        await db.payments.update_one(
            {"reference": reference}, {"$set": {
                "status": "unknown" if uncertain else "failed",
                "activation_error": detail[:300], "updated_at": _now()}},
        )
        if uncertain:
            return {
                "reference": reference, "status": "unknown", "provider": "biztranspay",
                "asset_code": asset,
                "message": "Résultat incertain. Actualisez le statut avant toute autre action.",
            }
        raise HTTPException(400, f"Biz-transPay : {detail or 'dépôt refusé'}")
    result = response.json() if response.content else {}
    deposit = result.get("deposit") if isinstance(result.get("deposit"), dict) else result
    instructions = deposit.get("instructions") if isinstance(deposit.get("instructions"), dict) else {}
    payment_flow = deposit.get("payment_flow") if isinstance(deposit.get("payment_flow"), dict) else {}
    address = (
        deposit.get("payment_address") or deposit.get("deposit_address") or deposit.get("address")
        or deposit.get("wallet_address") or deposit.get("pay_address")
        or instructions.get("address") or instructions.get("deposit_address")
        or instructions.get("wallet_address") or payment_flow.get("address")
        or payment_flow.get("deposit_address")
    )
    if not address:
        await db.payments.update_one(
            {"reference": reference}, {"$set": {
                "status": "unknown", "activation_error": "Adresse crypto absente de la réponse.",
                "updated_at": _now()}},
        )
        return {
            "reference": reference, "status": "unknown", "provider": "biztranspay",
            "asset_code": asset,
            "message": "Adresse absente de la réponse. Actualisez le statut avant toute autre action.",
        }
    provider_id = result.get("id") or deposit.get("id")
    amount_to_send = float(deposit.get("amount_to_send") or instructions.get("amount") or deposit.get("amount") or quote["provider_amount"])
    memo = deposit.get("memo") or instructions.get("memo") or payment_flow.get("memo")
    expires = deposit.get("expires_at") or deposit.get("pending_expires_at")
    await db.payments.update_one(
        {"reference": reference}, {"$set": {
            "status": "pending", "provider_intent_id": provider_id,
            "deposit_address": address, "amount_to_send": amount_to_send,
            "memo": memo, "expires_at": expires, "updated_at": _now()}},
    )
    return {
        "reference": reference, "status": "pending", "provider": "biztranspay",
        "deposit_address": address, "amount_to_send": amount_to_send,
        "asset_code": asset, "memo": memo, "expires_at": expires,
    }


async def _reserve_wallet(db, user_id: str, send: dict) -> bool:
    ref = send["id"]
    marker = f"wallet_send_reservations.{ref}"
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if user and (user.get("wallet_send_reservations") or {}).get(ref) is not None:
        return True
    field = _wallet_field(send["wallet_asset"])
    amount = float(send["wallet_debit"])
    result = await db.users.update_one(
        {"id": user_id, field: {"$gte": amount}, marker: {"$exists": False}},
        {"$inc": {field: -amount},
         "$set": {marker: amount, "wallet_updated_at": _now()}},
    )
    return bool(result.modified_count)


async def _refund_wallet_once(db, send: dict) -> None:
    ref = send["id"]
    marker = f"wallet_refund_refs.{ref}"
    field = _wallet_field(send["wallet_asset"])
    amount = float(send.get("wallet_debit") or 0)
    result = await db.users.update_one(
        {"id": send["user_id"], marker: {"$ne": True}},
        {"$inc": {field: amount}, "$set": {marker: True, "wallet_updated_at": _now()}},
    )
    if result.modified_count == 0:
        user = await db.users.find_one({"id": send["user_id"]}, {"_id": 0, marker: 1})
        if not user or not (user.get("wallet_refund_refs") or {}).get(ref):
            raise RuntimeError("Envoi remboursé sans marqueur idempotent.")


async def settle_wallet_send(
    db, send_doc: dict, target_status: str, gateway_status: str = "",
    *, source: str = "provider", provider_id: Optional[str] = None,
) -> dict:
    """Settle one provider payout; refunds only on a definitive failure."""
    if target_status not in {"completed", "rejected"}:
        await db.wallet_sends.update_one(
            {"id": send_doc.get("id"), "status": {"$nin": ["completed", "rejected"]}},
            {"$set": {"gateway_status": gateway_status, "updated_at": _now()}},
        )
        return {"ok": True, "status": "pending", "changed": False}
    ref = str(send_doc.get("id") or "")
    if not ref:
        return {"ok": False, "reason": "missing_reference"}
    finalizing = f"settling_{target_status}"
    claim = await db.wallet_sends.update_one(
        {"id": ref, "status": {"$nin": ["completed", "rejected", "settling_completed", "settling_rejected"]}},
        {"$set": {
            "status": finalizing, "gateway_status": gateway_status,
            "settlement_source": source, "provider_intent_id": provider_id or send_doc.get("provider_intent_id"),
            "updated_at": _now(),
        }},
    )
    current = await db.wallet_sends.find_one({"id": ref}, {"_id": 0}) or send_doc
    if current.get("status") in {"completed", "rejected"}:
        return {"ok": True, "status": current["status"], "changed": False}
    if not claim.modified_count and current.get("status") != finalizing:
        return {"ok": False, "reason": "conflicting_terminal_status"}
    if target_status == "rejected":
        await _refund_wallet_once(db, current)
    now = _now()
    update = await db.wallet_sends.update_one(
        {"id": ref, "status": finalizing},
        {"$set": {"status": target_status, "settled_at": now, "updated_at": now}},
    )
    notification_id = f"wallet-send:{ref}:{target_status}"
    title = "Envoi effectué" if target_status == "completed" else "Envoi refusé"
    body = (
        f"Votre envoi de {current.get('provider_amount')} {current.get('currency')} est confirmé."
        if target_status == "completed"
        else f"Votre envoi a été refusé; {current.get('wallet_debit')} {current.get('wallet_asset')} ont été recrédités."
    )
    await db.notifications.update_one(
        {"_id": notification_id},
        {"$setOnInsert": {
            "id": notification_id, "user_id": current["user_id"], "kind": "wallet_send_status",
            "title": title, "body": body, "meta": {"reference": ref, "status": target_status},
            "read": False, "created_at": now,
        }}, upsert=True,
    )
    await db.wallet_operations.update_one(
        {"reference": ref},
        {"$set": {
            "reference": ref, "id": ref, "user_id": current["user_id"],
            "kind": "send", "provider": current.get("provider"),
            "asset_code": current.get("wallet_asset"),
            "amount": current.get("amount"), "fee_amount": current.get("fee_amount"),
            "wallet_debit": current.get("wallet_debit"), "currency": current.get("currency"),
            "status": target_status, "created_at": current.get("created_at"),
            "updated_at": now,
        }}, upsert=True,
    )
    if update.modified_count:
        try:
            from push_helper import push_to_user
            await push_to_user(
                db, current["user_id"], title=title, body=body,
                link="/(app)/envoyer",
                data={"kind": "wallet_send_status", "reference": ref, "status": target_status},
                tag=notification_id,
            )
        except Exception:
            pass
    return {"ok": True, "status": target_status, "changed": bool(update.modified_count)}


async def _dispatch_btp_send(db, send: dict) -> dict:
    from biztranspay import (
        _get_public_key, _get_secret_key, _post, _btp_error_detail, _btp_error_code,
        _resolve_live_payout_entry,
    )
    from btp_catalog import e164, fetch_catalog
    entry = _resolve_live_payout_entry(
        await fetch_catalog(db, "payout", force=True, strict=True),
        send["country_code"], send["operator_code"],
    )
    if not entry or entry["currency"] != send["currency"]:
        await settle_wallet_send(db, send, "rejected", "route_changed", source="preflight")
        return {"status": "rejected", "message": "Le catalogue Pay-out a changé."}
    secret, public = await _get_secret_key(db), await _get_public_key(db)
    body = {
        "amount": float(send["provider_amount"]), "currency": send["currency"],
        "country": send["country_code"], "operator": entry["code"],
        "recipient": e164(send["phone"], send["country_code"]),
        "fee_bearer": "sender", "reference": send["id"],
    }
    await db.wallet_sends.update_one(
        {"id": send["id"], "status": "submitting"},
        {"$set": {"provider_request": {
            "amount": body["amount"], "currency": body["currency"],
            "country": body["country"], "operator": body["operator"],
            "recipient": body["recipient"], "fee_bearer": body["fee_bearer"],
        }, "updated_at": _now()}},
    )
    try:
        response = await _post("/payouts", body, secret, public, idempotency_key=f"send-{send['id']}")
    except Exception as exc:
        await db.wallet_sends.update_one(
            {"id": send["id"], "status": "submitting"},
            {"$set": {"status": "unknown", "gateway_status": "unknown",
                      "gateway_error": "Réponse incertaine; rapprochement fournisseur requis.",
                      "updated_at": _now()}},
        )
        log.warning("BTP wallet send uncertain ref=%s (%s)", send["id"], type(exc).__name__)
        return {"status": "unknown"}
    if response.status_code >= 400:
        detail, payload = _btp_error_detail(response)
        uncertain = response.status_code >= 500 or response.status_code in (408, 409, 429)
        if uncertain:
            await db.wallet_sends.update_one(
                {"id": send["id"], "status": "submitting"},
                {"$set": {"status": "unknown", "gateway_status": "unknown",
                          "gateway_error": detail[:300], "updated_at": _now()}},
            )
            return {"status": "unknown"}
        await settle_wallet_send(db, send, "rejected", _btp_error_code(payload) or "refused", source="provider")
        return {"status": "rejected", "message": detail}
    payload = response.json() if response.content else {}
    payout = payload.get("payout") if isinstance(payload.get("payout"), dict) else {}
    provider_id = payload.get("id") or payout.get("id")
    remote = str(payload.get("status") or payout.get("status") or "pending").lower()
    await db.wallet_sends.update_one(
        {"id": send["id"], "status": {"$nin": ["completed", "rejected"]}},
        {"$set": {"status": "dispatched", "gateway_status": remote,
                  "payout_id": provider_id, "provider_intent_id": provider_id,
                  "gateway_fee": payout.get("fee") or payout.get("total_fee"),
                  "dispatched_at": _now(), "updated_at": _now()}},
    )
    stored = await db.wallet_sends.find_one({"id": send["id"]}, {"_id": 0}) or send
    if remote in {"completed", "succeeded", "paid", "success", "sent", "delivered", "approved"}:
        await settle_wallet_send(db, stored, "completed", remote, source="dispatch", provider_id=provider_id)
    elif remote in {"failed", "declined", "canceled", "expired", "rejected", "error"}:
        await settle_wallet_send(db, stored, "rejected", remote, source="dispatch", provider_id=provider_id)
    return {"status": remote, "provider_id": provider_id}


async def _dispatch_moneyfusion_send(db, send: dict) -> dict:
    from moneyfusion import PAYIN_PROVIDER, PAYOUT_URL, _local_phone, _now as mf_now
    # Keep imports local so the wallet module can be imported without loading
    # optional gateway dependencies in unit tests.
    from moneyfusion import load_config, load_credentials
    cfg = await load_config(db)
    credentials = await load_credentials(db)
    private_key = credentials.get("payout_private_key") or ""
    if not cfg.get("payout_enabled") or not private_key:
        await settle_wallet_send(db, send, "rejected", "payout_disabled", source="preflight")
        return {"status": "rejected", "message": "MoneyFusion Pay-out est désactivé ou incomplet."}
    from payment_router import pick_provider
    selected = await pick_provider(
        db, kind="payout", country=send["country_code"], operator=send["operator_code"],
    )
    if not selected or selected.get("provider_id") != PAYIN_PROVIDER:
        await settle_wallet_send(db, send, "rejected", "route_changed", source="preflight")
        return {"status": "rejected", "message": "MoneyFusion n’est plus le prestataire actif pour cet opérateur."}
    from moneyfusion import refresh_catalog
    catalog = await refresh_catalog(db)
    country = next((row for row in catalog if row["country_code"] == send["country_code"]), None)
    method = next((row for row in (country or {}).get("operators", [])
                   if row["code"] == send["operator_code"]), None)
    if not country or not method or country["currency"] != send["currency"]:
        await settle_wallet_send(db, send, "rejected", "route_changed", source="preflight")
        return {"status": "rejected", "message": "L’opérateur n’est plus disponible chez MoneyFusion."}
    public_url = (os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or "").rstrip("/")
    if not public_url.startswith("https://"):
        await settle_wallet_send(db, send, "rejected", "public_url_missing", source="preflight")
        return {"status": "rejected", "message": "L’adresse HTTPS des notifications MoneyFusion n’est pas configurée."}
    payload = {
        "countryCode": send["country_code"].lower(),
        "phone": _local_phone(send["phone"], send["country_code"]),
        "amount": float(send["provider_amount"]),
        "withdraw_mode": method["code"],
        "webhook_url": f"{public_url}/api/webhooks/moneyfusion/payout",
    }
    payout_record = {
        "wd_id": send["id"], "wallet_operation": True,
        "amount": float(send["provider_amount"]), "currency": send["currency"],
        "country_code": send["country_code"], "operator_code": method["code"],
        "phone": payload["phone"], "status": "submitting",
        "created_at": mf_now(), "updated_at": mf_now(),
    }
    await db.moneyfusion_payouts.insert_one(payout_record)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                PAYOUT_URL, json=payload,
                headers={"moneyfusion-private-key": private_key,
                         "Content-Type": "application/json"},
            )
    except Exception as exc:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": send["id"]}, {"$set": {"status": "unknown", "updated_at": mf_now()}},
        )
        await db.wallet_sends.update_one(
            {"id": send["id"], "status": "submitting"},
            {"$set": {"status": "unknown", "gateway_status": "unknown",
                      "gateway_error": "Résultat de soumission incertain; ne pas renvoyer.",
                      "updated_at": _now()}},
        )
        log.warning("MoneyFusion wallet send uncertain ref=%s (%s)", send["id"], type(exc).__name__)
        return {"status": "unknown"}
    if response.status_code >= 400:
        uncertain = response.status_code >= 500 or response.status_code in (408, 409, 429)
        try:
            result = response.json()
        except Exception:
            result = {}
        detail = str(result.get("message") or result.get("detail") or "MoneyFusion a refusé l’envoi.")[:300]
        if uncertain:
            await db.moneyfusion_payouts.update_one(
                {"wd_id": send["id"]}, {"$set": {"status": "unknown", "error": detail, "updated_at": mf_now()}},
            )
            await db.wallet_sends.update_one(
                {"id": send["id"], "status": "submitting"},
                {"$set": {"status": "unknown", "gateway_status": "unknown",
                          "gateway_error": detail, "updated_at": _now()}},
            )
            return {"status": "unknown"}
        await db.moneyfusion_payouts.update_one(
            {"wd_id": send["id"]}, {"$set": {"status": "refused", "error": detail, "updated_at": mf_now()}},
        )
        await settle_wallet_send(db, send, "rejected", "refused", source="provider")
        return {"status": "rejected", "message": detail}
    try:
        result = response.json()
    except Exception:
        result = {}
    token = str(result.get("tokenPay") or "").strip()
    if result.get("statut") is False:
        detail = str(result.get("message") or "MoneyFusion a refusé l’envoi.")[:300]
        await db.moneyfusion_payouts.update_one(
            {"wd_id": send["id"]},
            {"$set": {"status": "refused", "error": detail, "updated_at": mf_now()}},
        )
        await settle_wallet_send(db, send, "rejected", "refused", source="provider")
        return {"status": "rejected", "message": detail}
    if result.get("statut") is not True or not token or len(token) > 256:
        await db.moneyfusion_payouts.update_one(
            {"wd_id": send["id"]},
            {"$set": {"status": "unknown", "error": "Réponse acceptée sans tokenPay confirmé.",
                      "updated_at": mf_now()}},
        )
        await db.wallet_sends.update_one(
            {"id": send["id"], "status": "submitting"},
            {"$set": {"status": "unknown", "gateway_status": "unknown",
                      "gateway_error": "Réponse MoneyFusion non confirmée; ne pas renvoyer.",
                      "updated_at": _now()}},
        )
        return {"status": "unknown"}
    await db.moneyfusion_payouts.update_one(
        {"wd_id": send["id"]},
        {"$set": {"status": "dispatched", "tokenPay": token, "updated_at": mf_now(),
                  "next_reconcile_at": mf_now() + timedelta(seconds=30),
                  "reconcile_attempts": 0}},
    )
    await db.wallet_sends.update_one(
        {"id": send["id"], "status": {"$nin": ["completed", "rejected"]}},
        {"$set": {"status": "dispatched", "gateway": PAYIN_PROVIDER,
                  "gateway_status": "pending", "provider_intent_id": token,
                  "dispatched_at": _now(), "updated_at": _now()}},
    )
    return {"status": "pending", "provider_id": token}


@router.post("/api/wallet-operations/submit")
async def submit_wallet_operation(data: SubmitIn, request: Request, user=Depends(get_current_user)):
    _assert_transaction_user(user)
    db = request.app.state.db
    quote = await db.wallet_quotes.find_one({"id": data.quote_id, "user_id": user["id"]}, {"_id": 0})
    if not quote:
        raise HTTPException(404, "Devis introuvable.")
    direction = quote.get("direction")
    if direction not in {"deposit", "send"}:
        raise HTTPException(400, "Devis invalide.")
    if quote.get("expires_at") and quote["expires_at"] < _now():
        raise HTTPException(410, "Le devis a expiré. Recommencez.")
    if quote.get("status") not in {"quoted", "submitting"}:
        if quote.get("transaction_reference"):
            return await wallet_transaction_status(quote["transaction_reference"], request, user)
        raise HTTPException(409, "Ce devis a déjà été traité; vérifiez son statut.")

    if direction == "deposit":
        if not data.email or not _valid_email(data.email):
            raise HTTPException(400, "Adresse e-mail invalide.")
        if quote["route_type"] == "mobile" and not _valid_phone(data.phone or ""):
            raise HTTPException(400, "Numéro Mobile Money invalide.")
        reference = quote.get("transaction_reference") or f"SPV-WALLET-{_new_id().upper()}"
        claimed = await db.wallet_quotes.update_one(
            {"id": quote["id"], "status": "quoted"},
            {"$set": {"status": "submitting", "transaction_reference": reference, "updated_at": _now()}},
        )
        if not claimed.modified_count:
            latest = await db.wallet_quotes.find_one({"id": quote["id"]}, {"_id": 0}) or {}
            if latest.get("transaction_reference"):
                raise HTTPException(409, "Ce dépôt est déjà en cours ou incertain. Vérifiez son statut.")
            raise HTTPException(409, "Ce devis a déjà été utilisé.")
        try:
            route = await _active_route(db, quote["route_id"], "deposit")
            if route["route_type"] == "crypto":
                result = await _btp_crypto_deposit(db, user, quote, data, reference)
            elif quote["provider"] == "moneyfusion":
                result = await _moneyfusion_deposit(db, user, quote, data, reference)
            elif quote["provider"] == "biztranspay":
                result = await _btp_mobile_deposit(db, user, quote, data, reference)
            else:
                raise HTTPException(503, "Prestataire Pay-in non pris en charge.")
        except HTTPException as exc:
            if exc.status_code not in (400, 422, 503):
                await db.wallet_quotes.update_one(
                    {"id": quote["id"]}, {"$set": {"status": "unknown", "updated_at": _now()}},
                )
            else:
                await db.wallet_quotes.update_one(
                    {"id": quote["id"]}, {"$set": {"status": "failed", "updated_at": _now()}},
                )
            raise
        await db.wallet_quotes.update_one(
            {"id": quote["id"]}, {"$set": {
                "status": (
                    "quoted" if result.get("status") in {
                        "otp_sent", "otp_required", "ussd_authorization_required",
                    } else result.get("status") or "pending"
                ),
                **({} if result.get("status") in {
                    "otp_sent", "otp_required", "ussd_authorization_required",
                } else {"transaction_reference": reference}),
                "updated_at": _now()}},
        )
        return result

    if quote["route_type"] != "mobile":
        raise HTTPException(503, "Les envois crypto restent désactivés tant que le contrat API n’est pas vérifié.")
    if not data.phone or not _valid_phone(data.phone):
        raise HTTPException(400, "Numéro du bénéficiaire invalide.")
    if not data.full_name or len(data.full_name.strip()) < 2:
        raise HTTPException(400, "Saisissez le nom complet du bénéficiaire.")
    existing = await db.wallet_sends.find_one({"quote_id": quote["id"]}, {"_id": 0})
    if existing:
        return _public_send(existing)
    reference = f"SPV-SEND-{_new_id().upper()}"
    quote_claim = await db.wallet_quotes.update_one(
        {"id": quote["id"], "status": "quoted"},
        {"$set": {
            "status": "submitting", "transaction_reference": reference,
            "updated_at": _now(),
        }},
    )
    if not quote_claim.modified_count:
        existing = await db.wallet_sends.find_one({"quote_id": quote["id"]}, {"_id": 0})
        if existing:
            return _public_send(existing)
        raise HTTPException(409, "Ce devis est déjà en cours. Vérifiez son statut avant de réessayer.")
    send = {
        "id": reference, "quote_id": quote["id"], "user_id": user["id"],
        "username": user.get("username"), "kind": "send",
        "provider": quote["provider"], "route_id": quote["route_id"],
        "country_code": quote["country_code"], "operator_code": quote["operator_code"],
        "currency": quote["currency"], "asset_code": quote["asset_code"],
        "wallet_asset": quote["wallet_asset"], "amount": quote["amount"],
        "fee_amount": quote["fee_amount"], "fee_percent": quote["fee_percent"],
        "fee_payer": quote["fee_payer"], "wallet_debit": quote["wallet_debit"],
        "provider_amount": quote["provider_amount"], "phone": data.phone.strip(),
        "full_name": data.full_name.strip()[:160], "status": "created",
        "created_at": _now(), "updated_at": _now(),
    }
    try:
        await db.wallet_sends.insert_one(send)
    except Exception:
        existing = await db.wallet_sends.find_one({"quote_id": quote["id"]}, {"_id": 0})
        if existing:
            return _public_send(existing)
        raise HTTPException(409, "La demande est déjà en cours. Vérifiez son statut.")
    if not await _reserve_wallet(db, user["id"], send):
        await db.wallet_sends.update_one(
            {"id": reference}, {"$set": {"status": "failed", "gateway_error": "Solde insuffisant.",
                                          "updated_at": _now()}},
        )
        await db.wallet_quotes.update_one(
            {"id": quote["id"]}, {"$set": {"status": "failed", "updated_at": _now()}},
        )
        raise HTTPException(400, "Solde insuffisant pour couvrir le montant et les frais.")
    await db.wallet_sends.update_one(
        {"id": reference, "status": "created"},
        {"$set": {"status": "submitting", "reservation_at": _now(), "updated_at": _now()}},
    )
    await db.wallet_quotes.update_one(
        {"id": quote["id"]}, {"$set": {
            "status": "submitted", "transaction_reference": reference, "updated_at": _now()}},
    )
    send = await db.wallet_sends.find_one({"id": reference}, {"_id": 0}) or send
    if quote["provider"] == "biztranspay":
        outcome = await _dispatch_btp_send(db, send)
    elif quote["provider"] == "moneyfusion":
        outcome = await _dispatch_moneyfusion_send(db, send)
    else:
        await settle_wallet_send(db, send, "rejected", "provider_unsupported", source="preflight")
        raise HTTPException(503, "Ce prestataire n’est pas disponible pour les envois.")
    latest = await db.wallet_sends.find_one({"id": reference}, {"_id": 0}) or send
    return {**_public_send(latest), "message": outcome.get("message") or ""}


def _public_send(send: dict) -> dict:
    return {
        "reference": send.get("id"), "status": send.get("status"),
        "provider": send.get("provider"), "currency": send.get("currency"),
        "amount": send.get("amount"), "fee_amount": send.get("fee_amount"),
        "wallet_debit": send.get("wallet_debit"), "provider_amount": send.get("provider_amount"),
        "gateway_status": send.get("gateway_status"),
    }


async def wallet_transaction_status(reference: str, request: Request, user: dict):
    db = request.app.state.db
    payment = await db.payments.find_one(
        {"reference": reference, "user_id": user["id"], "kind": "wallet_deposit"},
        {"_id": 0},
    )
    if payment:
        return await _reconcile_deposit(db, payment)
    send = await db.wallet_sends.find_one({"id": reference, "user_id": user["id"]}, {"_id": 0})
    if not send:
        raise HTTPException(404, "Opération introuvable.")
    if send.get("status") in {"completed", "rejected"}:
        return _public_send(send)
    if send.get("provider") == "biztranspay" and send.get("payout_id"):
        from biztranspay import reconcile_withdrawal
        await reconcile_withdrawal(db, send)
    elif send.get("provider") == "moneyfusion":
        payout = await db.moneyfusion_payouts.find_one({"wd_id": reference}, {"_id": 0})
        if payout and payout.get("tokenPay"):
            from moneyfusion import reconcile_withdrawal
            try:
                await reconcile_withdrawal(db, reference, schedule_next=False)
            except Exception:
                pass
    latest = await db.wallet_sends.find_one({"id": reference}, {"_id": 0}) or send
    return _public_send(latest)


@router.get("/api/wallet-operations/transactions/{reference}")
async def wallet_transaction_status_route(
    reference: str, request: Request, user=Depends(get_current_user),
):
    return await wallet_transaction_status(reference, request, user)


async def _reconcile_deposit(db, payment: dict) -> dict:
    ref = payment["reference"]
    if payment.get("activation_done"):
        return {"reference": ref, "status": "paid", "activation_done": True}
    provider = payment.get("provider")
    try:
        if provider == "moneyfusion":
            from moneyfusion import _apply_paid_activation, _verify_payin
            if payment.get("provider_token"):
                verified = await _verify_payin(db, payment)
                outcome = await _apply_paid_activation(db, payment, verified)
                latest = await db.payments.find_one({"reference": ref}, {"_id": 0}) or payment
                return {"reference": ref, "status": latest.get("status") or outcome.get("status"),
                        "activation_done": bool(latest.get("activation_done"))}
        elif provider == "biztranspay" and payment.get("provider_intent_id"):
            from biztranspay import _get, _get_public_key, _get_secret_key
            crypto = bool(payment.get("asset_code"))
            path = f"/crypto/deposits/{payment['provider_intent_id']}" if crypto else f"/deposits/{payment['provider_intent_id']}"
            response = await _get(path, await _get_secret_key(db), await _get_public_key(db))
            if response.status_code < 400:
                body = response.json()
                envelope = body.get("data") if isinstance(body.get("data"), dict) else body
                nested = envelope.get("deposit") if isinstance(envelope.get("deposit"), dict) else {}
                remote = str(envelope.get("status") or nested.get("status") or "").lower()
                if remote in {"paid", "completed", "approved", "success", "confirmed"}:
                    from ashtec_activation import _apply_payment_success
                    await _apply_payment_success(db, payment, "paid", source="biztranspay")
                elif remote in {"failed", "declined", "canceled", "cancelled", "expired", "rejected"}:
                    await db.payments.update_one(
                        {"reference": ref, "activation_done": {"$ne": True}},
                        {"$set": {"status": "failed", "biztranspay_status": remote, "updated_at": _now()}},
                    )
        latest = await db.payments.find_one({"reference": ref}, {"_id": 0}) or payment
        return {"reference": ref, "status": latest.get("status") or "pending",
                "activation_done": bool(latest.get("activation_done")),
                "activation_error": latest.get("activation_error"),
                "deposit_address": latest.get("deposit_address"),
                "amount_to_send": latest.get("amount_to_send"),
                "asset_code": latest.get("asset_code")}
    except Exception as exc:
        log.info("wallet deposit status check failed ref=%s (%s)", ref, type(exc).__name__)
    latest = await db.payments.find_one({"reference": ref}, {"_id": 0}) or payment
    return {"reference": ref, "status": latest.get("status") or "pending",
            "activation_done": bool(latest.get("activation_done")),
            "message": "Vérification en attente; aucun paiement ne sera renvoyé automatiquement.",
            "deposit_address": latest.get("deposit_address"),
            "amount_to_send": latest.get("amount_to_send"),
            "asset_code": latest.get("asset_code")}


@router.get("/api/wallet-operations/mine")
async def my_wallet_operations(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    payments = await db.payments.find(
        {"user_id": user["id"], "kind": "wallet_deposit"}, {"_id": 0},
    ).sort("created_at", -1).limit(30).to_list(30)
    sends = await db.wallet_sends.find(
        {"user_id": user["id"]}, {"_id": 0},
    ).sort("created_at", -1).limit(30).to_list(30)
    items = [{
        "reference": row.get("reference"), "kind": "deposit",
        "status": row.get("status"), "provider": row.get("provider"),
        "currency": row.get("wallet_asset_code") or row.get("currency"),
        "amount": row.get("wallet_credit_amount"), "fee_amount": row.get("wallet_fee_amount"),
        "created_at": row.get("created_at"), "deposit_address": row.get("deposit_address"),
        "amount_to_send": row.get("amount_to_send"), "asset_code": row.get("asset_code"),
    } for row in payments]
    items.extend({
        "reference": row.get("id"), "kind": "send", "status": row.get("status"),
        "provider": row.get("provider"), "currency": row.get("currency"),
        "amount": row.get("amount"), "fee_amount": row.get("fee_amount"),
        "created_at": row.get("created_at"),
    } for row in sends)
    items.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return {"items": items[:50]}


async def settle_wallet_deposit(db, payment: dict, *, source: str = "provider") -> dict:
    """Credit the chosen currency exactly once in one atomic user update."""
    ref = str(payment.get("reference") or "")
    user_id = str(payment.get("user_id") or "")
    asset = str(payment.get("wallet_asset_code") or payment.get("asset_code") or payment.get("currency") or "XOF").upper()
    amount = float(payment.get("wallet_credit_amount") or 0)
    if not ref or not user_id or not math.isfinite(amount) or amount <= 0:
        raise ValueError("Données de crédit portefeuille invalides.")
    field = _wallet_field(asset)
    marker = f"wallet_credit_refs.{ref}"
    asset_code_marker = f"wallet_asset_codes.{_asset_key(asset)}"
    result = await db.users.update_one(
        {"id": user_id, marker: {"$ne": True}},
        {"$inc": {field: amount},
         "$set": {
             marker: True, "wallet_updated_at": _now(),
             **({asset_code_marker: asset} if asset != "XOF" else {}),
         }},
    )
    if result.modified_count == 0:
        user = await db.users.find_one({"id": user_id}, {"_id": 0, marker: 1})
        if not user or not (user.get("wallet_credit_refs") or {}).get(ref):
            raise RuntimeError("Utilisateur introuvable ou crédit non enregistré.")
    now = _now()
    await db.payments.update_one(
        {"reference": ref, "kind": "wallet_deposit"},
        {"$set": {"status": "paid", "activation_done": True,
                  "wallet_credited_at": now, "wallet_settlement_source": source,
                  "updated_at": now}, "$unset": {"activation_error": ""}},
    )
    await db.wallet_operations.update_one(
        {"reference": ref},
        {"$set": {
            "reference": ref, "id": ref, "user_id": user_id,
            "kind": "deposit", "provider": payment.get("provider"),
            "asset_code": asset, "amount": amount,
            "fee_amount": float(payment.get("wallet_fee_amount") or 0),
            "currency": asset, "status": "paid",
            "created_at": payment.get("created_at") or now, "updated_at": now,
        }}, upsert=True,
    )
    notification_id = f"wallet-deposit:{ref}:paid"
    await db.notifications.update_one(
        {"_id": notification_id},
        {"$setOnInsert": {
            "id": notification_id, "user_id": user_id,
            "kind": "wallet_deposit_status", "title": "Dépôt confirmé",
            "body": f"Votre portefeuille {asset} a été crédité de {amount:g} {asset}.",
            "meta": {"reference": ref, "asset_code": asset, "amount": amount},
            "read": False, "created_at": now,
        }}, upsert=True,
    )
    return {"status": "paid", "activation_done": True, "wallet_credited": True}
