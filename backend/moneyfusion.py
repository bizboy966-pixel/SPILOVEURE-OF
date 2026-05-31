"""Money Fusion (FusionPay) payment gateway integration.

Docs: https://docs.moneyfusion.net/en/webapi
Hosted payment URL pattern: https://pay.moneyfusion.net/<MerchantName>/<AppToken>/pay/

This module exposes:
- initiate_payment()      : POST to Money Fusion to create a Pay-In; returns a hosted URL.
- check_payment_status()  : GET status of a payment by tokenPay.
- normalize_status()      : map Money Fusion statuses to our canonical statuses.

Environment variables (set in /app/backend/.env):
- MONEYFUSION_API_URL   : The full POST URL of your Money Fusion application
                          (e.g. https://pay.moneyfusion.net/Spiloveure/<token>/pay/)
- SITE_URL              : Public site URL used for return_url + webhook_url.

Webhook security note: Money Fusion does NOT sign webhook payloads. The doc
recommends using `tokenPay` to look up the payment record locally — that's the
only acceptable proof that the event refers to a real payment we created.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional
from urllib.parse import urljoin

import httpx

log = logging.getLogger("moneyfusion")

API_URL = os.environ.get("MONEYFUSION_API_URL", "").rstrip("/") + "/" if os.environ.get("MONEYFUSION_API_URL") else ""
SITE_URL = os.environ.get("SITE_URL", "https://spiloveure.com").rstrip("/")

# Base host used for status checks: https://www.pay.moneyfusion.net/paiementNotif/<token>
STATUS_BASE = "https://www.pay.moneyfusion.net"


class MoneyFusionError(Exception):
    """Raised when Money Fusion rejects a request or returns an error."""


# ---------------------------------------------------------------------------
# URLs returned to Money Fusion
# ---------------------------------------------------------------------------
def webhook_url() -> str:
    return f"{SITE_URL}/api/payments/moneyfusion/webhook"


def return_url() -> str:
    # Customer is redirected here after paying (token is appended by Money Fusion).
    return f"{SITE_URL}/payment/success"


# ---------------------------------------------------------------------------
# Status normalisation
# ---------------------------------------------------------------------------
def normalize_status(raw: Optional[str], event: Optional[str] = None) -> str:
    """Translate Money Fusion status / event into our canonical status.

    Money Fusion statuses: pending | failure | no paid | paid
    Money Fusion webhook events:
        payin.session.pending | payin.session.completed | payin.session.cancelled
    Returns one of: pending | paid | failed.
    """
    s = (raw or "").lower().strip()
    e = (event or "").lower().strip()
    if s == "paid" or e == "payin.session.completed":
        return "paid"
    if s in {"failure", "no paid"} or e == "payin.session.cancelled":
        return "failed"
    return "pending"


# ---------------------------------------------------------------------------
# Pay-In: create a hosted Money Fusion payment
# ---------------------------------------------------------------------------
async def initiate_payment(
    *,
    total_price: float,
    article: list[dict[str, Any]],
    customer_name: str,
    customer_phone: str,
    user_id: str,
    order_id: str,
    level: int,
) -> dict[str, Any]:
    """POST to the Money Fusion application URL to create a payment session.

    Returns the parsed JSON: {statut, token, message, url}. The customer should
    be redirected to `url` to complete the payment.
    """
    if not API_URL:
        raise MoneyFusionError("MONEYFUSION_API_URL is not configured")

    payload = {
        "totalPrice": total_price,
        "article": article,
        "personal_Info": [
            {"userId": user_id, "orderId": order_id, "level": level},
        ],
        "numeroSend": customer_phone,
        "nomclient": customer_name,
        "return_url": return_url(),
        "webhook_url": webhook_url(),
    }
    headers = {"Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.post(API_URL, headers=headers, json=payload)
        except httpx.RequestError as exc:
            log.exception("Money Fusion network error")
            raise MoneyFusionError(f"Network error: {exc.__class__.__name__}") from exc

    try:
        data = r.json()
    except Exception as exc:
        raise MoneyFusionError(f"Invalid JSON response (HTTP {r.status_code})") from exc

    if r.status_code not in (200, 201) or not data.get("statut"):
        msg = data.get("message") or f"Money Fusion returned HTTP {r.status_code}"
        raise MoneyFusionError(msg)

    return data


# ---------------------------------------------------------------------------
# Status check (used for polling / manual reconciliation)
# ---------------------------------------------------------------------------
async def check_payment_status(token: str) -> dict[str, Any]:
    """GET /paiementNotif/<token> — query the latest status from Money Fusion."""
    if not token:
        raise MoneyFusionError("Missing tokenPay")
    url = urljoin(STATUS_BASE + "/", f"paiementNotif/{token}")
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get(url)
        except httpx.RequestError as exc:
            raise MoneyFusionError(f"Network error: {exc.__class__.__name__}") from exc
    try:
        return r.json()
    except Exception as exc:
        raise MoneyFusionError("Invalid JSON response from Money Fusion") from exc
