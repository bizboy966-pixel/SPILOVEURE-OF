"""FedaPay integration — Mobile Money gateway.

Docs: https://docs.fedapay.com/  (openapi at /api-reference/openapi.json)

Flow
────
1. `create_transaction(...)`  → POST /v1/transactions      → returns {id, reference, status:"pending", …}
2. `generate_token(tx_id)`    → POST /v1/transactions/{id}/token  → {token, url}
3. `send_mobile_money(mode, token, phone, country)` → POST /v1/transactions/{mode}  → USSD prompt to the payer
4. `verify_transaction(tx_id)` → GET /v1/transactions/{id} for polling
5. FedaPay webhook `POST /api/webhooks/fedapay` — signature header `X-FEDAPAY-SIGNATURE:
   t=<unix_ts>,s=<hex(HMAC-SHA256("{ts}.{raw_body}", webhook_secret))>`.

Payouts (auto-withdrawal)
─────────────────────────
`create_payout(...)` → POST /v1/payouts → returns payout id, then `start_payouts([id])`
via PUT /v1/payouts/start to actually dispatch it.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from typing import Any, Optional

import httpx

log = logging.getLogger("fedapay")

BASE_URL = os.environ.get("FEDAPAY_BASE_URL", "https://api.fedapay.com/v1")
API_KEY = os.environ.get("FEDAPAY_SECRET_KEY", "")
WEBHOOK_SECRET = os.environ.get("FEDAPAY_WEBHOOK_SECRET", "")

# ISO-3166 alpha-2 → known FedaPay mobile-money "mode" slug used for
# `POST /v1/transactions/{mode}`. This list follows FedaPay's supported
# operators for West-African MoMo (per doc): mtn, moov, celtiis, togocom, etc.
# For most West-African XOF countries "mtn" and "moov" cover 95% of users.
COUNTRY_MODES: dict[str, list[str]] = {
    "BJ": ["mtn", "moov", "celtiis"],
    "CI": ["mtn", "moov", "wave"],
    "SN": ["mtn", "orange", "wave", "free"],
    "TG": ["togocom", "moov"],
    "BF": ["mtn", "moov", "orange"],
    "ML": ["orange", "moov"],
    "NE": ["airtel", "moov"],
    "GN": ["orange", "mtn"],
}
DEFAULT_MODES = ["mtn", "moov"]


def is_configured() -> bool:
    return bool(API_KEY) and bool(WEBHOOK_SECRET)


def modes_for_country(country_code: str) -> list[str]:
    return COUNTRY_MODES.get((country_code or "").upper(), DEFAULT_MODES)


def _headers() -> dict:
    return {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


# ═══════════════════════════════════════════════════════════════════════════
#   HTTP client
# ═══════════════════════════════════════════════════════════════════════════

async def create_transaction(*, amount: int, currency_iso: str, description: str,
                             callback_url: str, email: str, firstname: str,
                             lastname: str, phone_number: str, country_iso: str,
                             merchant_reference: str) -> dict:
    """Create a FedaPay transaction. `amount` must be an integer in the currency's
    smallest unit (for XOF this is the francs value — no decimals).
    """
    payload = {
        "description": description,
        "amount": int(amount),
        "currency": {"iso": currency_iso},
        "callback_url": callback_url,
        "customer": {
            "email": email,
            "firstname": firstname or "SPILOVEURE",
            "lastname": lastname or "USER",
            "phone_number": {
                "number": str(phone_number),
                "country": (country_iso or "BJ").upper(),
            },
        },
        "custom_metadata": {"merchantReference": merchant_reference},
    }
    async with httpx.AsyncClient(timeout=30.0) as cli:
        r = await cli.post(f"{BASE_URL}/transactions", headers=_headers(), json=payload)
    try:
        data = r.json()
    except Exception:
        log.error("FedaPay create_transaction non-JSON %s: %s", r.status_code, r.text[:300])
        return {"error": "non_json", "status_code": r.status_code}
    if r.status_code >= 400:
        log.error("FedaPay create_transaction %s: %s", r.status_code, data)
        return {"error": "http", "status_code": r.status_code, "detail": data}
    log.info("FedaPay tx created ref=%s id=%s", merchant_reference, (data.get("v1", {}).get("transaction") or data.get("transaction") or data).get("id") if isinstance(data, dict) else None)
    return data


async def generate_token(tx_id: int | str) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.post(f"{BASE_URL}/transactions/{tx_id}/token", headers=_headers())
    try:
        data = r.json()
    except Exception:
        return {"error": "non_json", "status_code": r.status_code}
    if r.status_code >= 400:
        log.error("FedaPay token %s: %s", r.status_code, data)
        return {"error": "http", "status_code": r.status_code, "detail": data}
    return data


async def send_mobile_money(*, mode: str, token: str, phone: str, country: str) -> dict:
    """Ask FedaPay to push the USSD/MoMo prompt to the payer's phone."""
    payload = {"token": token, "phone_number": {"number": str(phone), "country": country.upper()}}
    async with httpx.AsyncClient(timeout=30.0) as cli:
        r = await cli.post(f"{BASE_URL}/transactions/{mode}", headers=_headers(), json=payload)
    try:
        data = r.json()
    except Exception:
        return {"error": "non_json", "status_code": r.status_code}
    if r.status_code >= 400:
        log.error("FedaPay send %s %s: %s", mode, r.status_code, data)
        return {"error": "http", "status_code": r.status_code, "detail": data}
    return data


async def verify_transaction(tx_id: int | str) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.get(f"{BASE_URL}/transactions/{tx_id}", headers=_headers())
    try:
        data = r.json()
    except Exception:
        return {"error": "non_json", "status_code": r.status_code}
    if r.status_code >= 400:
        log.warning("FedaPay verify %s %s: %s", tx_id, r.status_code, data)
        return {"error": "http", "status_code": r.status_code, "detail": data}
    return data


# ═══════════════════════════════════════════════════════════════════════════
#   Payouts (auto-withdrawal)
# ═══════════════════════════════════════════════════════════════════════════

async def create_payout(*, amount: int, currency_iso: str, firstname: str,
                        lastname: str, email: str, phone: str, country_iso: str,
                        mode: str = "mobile_money", merchant_reference: str = "") -> dict:
    payload = {
        "amount": int(amount),
        "currency": {"iso": currency_iso},
        "customer": {
            "firstname": firstname or "SPILOVEURE",
            "lastname": lastname or "USER",
            "email": email or "user@spiloveure.com",
            "phone_number": {"number": str(phone), "country": country_iso.upper()},
        },
        "mode": mode,
        "custom_metadata": {"merchantReference": merchant_reference},
    }
    async with httpx.AsyncClient(timeout=30.0) as cli:
        r = await cli.post(f"{BASE_URL}/payouts", headers=_headers(), json=payload)
    try:
        data = r.json()
    except Exception:
        return {"error": "non_json", "status_code": r.status_code}
    if r.status_code >= 400:
        log.error("FedaPay payout create %s: %s", r.status_code, data)
        return {"error": "http", "status_code": r.status_code, "detail": data}
    return data


async def start_payouts(payout_ids: list[int]) -> dict:
    """Actually dispatch payouts previously created in scheduled/pending state."""
    payload = {"items": [{"id": int(pid)} for pid in payout_ids]}
    async with httpx.AsyncClient(timeout=30.0) as cli:
        r = await cli.put(f"{BASE_URL}/payouts/start", headers=_headers(), json=payload)
    try:
        data = r.json()
    except Exception:
        return {"error": "non_json", "status_code": r.status_code}
    if r.status_code >= 400:
        log.error("FedaPay payout start %s: %s", r.status_code, data)
        return {"error": "http", "status_code": r.status_code, "detail": data}
    return data


# ═══════════════════════════════════════════════════════════════════════════
#   Webhook signature verification (Stripe-like scheme)
# ═══════════════════════════════════════════════════════════════════════════

def verify_webhook_signature(raw_body: bytes, sig_header: str, secret: str | None = None,
                             tolerance_seconds: int = 300) -> tuple[bool, str]:
    """Verify `X-FEDAPAY-SIGNATURE: t=<ts>,s=<hex_hmac>`.

    Returns (is_valid, reason). `reason` is empty on success or a short
    machine-readable code otherwise.
    """
    sec = secret if secret is not None else WEBHOOK_SECRET
    if not sec:
        return False, "no_secret_configured"
    if not sig_header:
        return False, "missing_header"
    parts = {}
    for chunk in sig_header.split(","):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    ts = parts.get("t")
    sig = parts.get("s") or parts.get("v1")
    if not ts or not sig:
        return False, "malformed_header"
    try:
        ts_int = int(ts)
    except ValueError:
        return False, "bad_timestamp"
    if abs(int(time.time()) - ts_int) > tolerance_seconds:
        return False, "stale_timestamp"
    signed = f"{ts}.".encode() + raw_body
    expected = hmac.new(sec.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return False, "signature_mismatch"
    return True, ""


def normalize_status(status: str) -> str:
    """FedaPay statuses → our internal status."""
    s = (status or "").lower()
    if s in ("approved", "transferred", "success"):
        return "paid"
    if s in ("declined", "canceled", "cancelled", "failed", "refunded"):
        return "failed"
    return "pending"
