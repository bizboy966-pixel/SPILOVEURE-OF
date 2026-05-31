"""SoleasPay V3 payment gateway integration.

Docs: https://doc.mysoleas.com/soleaspay-v3
Base URL: https://soleaspay.com

This module exposes:
- initiate_payment(): POST /api/agent/bills/v3 — create a Pay-In (Mobile Money push)
- verify_payment(): GET /api/agent/verif-pay — check a transaction status
- verify_callback_signature(): verify the x-private-key header of incoming webhooks
- normalize_status(): map SoleasPay status strings to our internal canonical status

Required environment variables (set in /app/backend/.env):
- SOLEASPAY_BASE_URL          (default: https://soleaspay.com)
- SOLEASPAY_API_KEY           (x-api-key from your SoleasPay dashboard)
- SOLEASPAY_WALLET            (the wallet/MSISDN that will RECEIVE payments)
- SOLEASPAY_CALLBACK_SECRET   (the secret hash returned by SoleasPay after you
                               configure your callback URL; we SHA-512 it and
                               compare with the x-private-key header)
- SITE_URL                    (public site URL, used for successUrl/failureUrl)
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger("soleaspay")

BASE_URL = os.environ.get("SOLEASPAY_BASE_URL", "https://soleaspay.com").rstrip("/")
API_KEY = os.environ.get("SOLEASPAY_API_KEY", "")
WALLET = os.environ.get("SOLEASPAY_WALLET", "")
CALLBACK_SECRET = os.environ.get("SOLEASPAY_CALLBACK_SECRET", "")
SITE_URL = os.environ.get("SITE_URL", "https://spiloveure.com").rstrip("/")

# SoleasPay service IDs (from GET /api/services-list)
SERVICE_MOMO = 1            # MTN Mobile Money
SERVICE_OM = 2              # Orange Money
SERVICE_EUM = 5             # Express Union Mobile

OPERATION_PAYIN = 2         # Pay-In (collect from customer)


class SoleasPayError(Exception):
    """Raised when SoleasPay rejects a request or returns an error."""


# ---------------------------------------------------------------------------
# Public URLs used by SoleasPay
# ---------------------------------------------------------------------------
def callback_url() -> str:
    return f"{SITE_URL}/api/payments/soleaspay/webhook"


def success_url(order_id: str) -> str:
    return f"{SITE_URL}/payment/success?order={order_id}"


def failure_url(order_id: str) -> str:
    return f"{SITE_URL}/payment/failure?order={order_id}"


# ---------------------------------------------------------------------------
# Status normalisation
# ---------------------------------------------------------------------------
def normalize_status(raw: Optional[str], success: Optional[bool] = None) -> str:
    """Translate SoleasPay status into our internal canonical status.

    SoleasPay statuses observed: PROCESSING, SUCCESS, FAILURE, RECEIVED, REFUND.
    Returns one of: pending | paid | failed | refunded.
    """
    s = (raw or "").upper().strip()
    if s in {"SUCCESS", "RECEIVED"} or success is True:
        return "paid"
    if s in {"FAILURE", "FAILED", "CANCELLED", "EXPIRED"} or success is False:
        return "failed"
    if s == "REFUND":
        return "refunded"
    return "pending"


# ---------------------------------------------------------------------------
# Callback signature verification
# ---------------------------------------------------------------------------
def verify_callback_signature(provided_key: Optional[str]) -> bool:
    """Verify the `x-private-key` header sent by SoleasPay with each webhook.

    According to https://doc.mysoleas.com/soleaspay-v3, the header value must
    equal `sha512(callback_secret).hexdigest()`. We use a constant-time
    comparison to avoid timing attacks.
    """
    if not provided_key or not CALLBACK_SECRET:
        return False
    expected = hashlib.sha512(CALLBACK_SECRET.encode("utf-8")).hexdigest()
    return hmac.compare_digest(expected.lower(), provided_key.strip().lower())


# ---------------------------------------------------------------------------
# Pay-In: initiate a Mobile Money transaction (USSD push)
# ---------------------------------------------------------------------------
async def initiate_payment(
    *,
    wallet: str,
    amount: float,
    currency: str,
    order_id: str,
    description: str,
    payer: str,
    payer_email: str,
    service: int = SERVICE_MOMO,
    otp: Optional[str] = None,
) -> dict[str, Any]:
    """POST /api/agent/bills/v3 — initiate a Pay-In (Mobile Money push)."""
    if not API_KEY:
        raise SoleasPayError("SOLEASPAY_API_KEY is not configured")

    headers = {
        "x-api-key": API_KEY,
        "operation": str(OPERATION_PAYIN),
        "service": str(service),
        "Content-Type": "application/json",
    }
    if otp and service == SERVICE_OM:
        headers["otp"] = str(otp)

    body = {
        "wallet": wallet,
        "amount": amount,
        "currency": currency,
        "order_id": order_id,
        "description": description,
        "payer": payer,
        "payerEmail": payer_email,
        "successUrl": success_url(order_id),
        "failureUrl": failure_url(order_id),
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.post(f"{BASE_URL}/api/agent/bills/v3", headers=headers, json=body)
        except httpx.RequestError as exc:
            log.exception("SoleasPay network error during initiate_payment")
            raise SoleasPayError(f"Network error: {exc.__class__.__name__}") from exc

    try:
        data = r.json()
    except Exception as exc:
        raise SoleasPayError(f"Invalid JSON response (HTTP {r.status_code})") from exc

    if r.status_code not in (200, 201) or not data.get("success", False):
        msg = data.get("message", f"SoleasPay returned HTTP {r.status_code}")
        raise SoleasPayError(msg)

    return data


# ---------------------------------------------------------------------------
# Verify a transaction status by order_id + pay_id
# ---------------------------------------------------------------------------
async def verify_payment(*, order_id: str, pay_id: str) -> dict[str, Any]:
    """GET /api/agent/verif-pay — check the status of a transaction."""
    if not API_KEY:
        raise SoleasPayError("SOLEASPAY_API_KEY is not configured")

    headers = {"x-api-key": API_KEY, "Content-Type": "application/json"}
    params = {"orderId": order_id, "payId": pay_id}
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get(
                f"{BASE_URL}/api/agent/verif-pay",
                headers=headers,
                params=params,
            )
        except httpx.RequestError as exc:
            raise SoleasPayError(f"Network error: {exc.__class__.__name__}") from exc

    try:
        return r.json()
    except Exception as exc:
        raise SoleasPayError("Invalid JSON response from SoleasPay") from exc
