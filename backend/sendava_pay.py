"""SendavaPay payment gateway — automatic deposit / activation.

Architecture mirrors the existing WestPay (RobotPay) flow:

  1. user clicks "Pay automatically"
  2. frontend → POST /api/payments/sendava/initiate
  3. backend → POST https://sendavapay.com/api/v1/create-payment
     (we attach our own `externalReference` so we can correlate later)
  4. backend stores a row in `payments` (status=pending)
  5. frontend redirects user to the returned `paymentUrl`
  6. user pays on SendavaPay; SendavaPay → POST /api/sendavapay-webhook
  7. backend verifies HMAC signature, marks payment paid, activates level

All public endpoints use HMAC-SHA256(raw_body, WEBHOOK_SECRET) hex compare.
The endpoint accepts multiple common header names so the integration keeps
working even if SendavaPay tweaks its dashboard configuration.
"""
from __future__ import annotations

import hmac
import hashlib
import os
import logging
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

API_BASE = os.environ.get("SENDAVAPAY_BASE_URL", "https://sendavapay.com/api/v1").rstrip("/")
API_KEY = os.environ.get("SENDAVAPAY_API_KEY", "")
WEBHOOK_SECRET = os.environ.get("SENDAVAPAY_WEBHOOK_SECRET", "")

# Countries explicitly excluded from the automatic flow (per merchant policy).
EXCLUDED_COUNTRIES = {"CD"}  # RDC Congo — Democratic Republic of the Congo

# Webhook signature header — try each in order (lower-case match).
SIGNATURE_HEADERS = [
    "x-sendavapay-signature",
    "sendavapay-signature",
    "sendava-signature",
    "x-signature",
    "signature",
]


def is_configured() -> bool:
    return bool(API_KEY and WEBHOOK_SECRET)


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def create_payment(
    *,
    amount: float,
    currency: str = "XOF",
    external_reference: str,
    description: str = "",
    customer_name: str = "",
    customer_email: str = "",
    customer_phone: str = "",
    return_url: str = "",
    cancel_url: str = "",
) -> dict[str, Any]:
    """Create a payment on SendavaPay. Returns the parsed `data` block.

    Raises httpx.HTTPStatusError on transport failure. Raises ValueError if
    the SendavaPay response is not `success=true`.
    """
    if not API_KEY:
        raise RuntimeError("SENDAVAPAY_API_KEY is not configured")

    payload: dict[str, Any] = {
        "amount": float(amount),
        "currency": currency,
        "externalReference": external_reference,
        "description": description or "Activation Spiloveure",
    }
    if customer_name:
        payload["customerName"] = customer_name
    if customer_email:
        payload["customerEmail"] = customer_email
    if customer_phone:
        payload["customerPhone"] = customer_phone
    if return_url:
        payload["returnUrl"] = return_url
        payload["successUrl"] = return_url
    if cancel_url:
        payload["cancelUrl"] = cancel_url

    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(f"{API_BASE}/create-payment", headers=_headers(), json=payload)
        r.raise_for_status()
        body = r.json()
    if not isinstance(body, dict) or not body.get("success"):
        raise ValueError(f"SendavaPay create-payment failed: {body}")
    # Return SendavaPay's payment URL exactly as provided — the public
    # checkout page lives at `/pay/api/pay_xxx` per their dashboard config.
    return body.get("data") or {}


async def verify_payment(reference: str) -> dict[str, Any]:
    """Fetch the latest payment status from SendavaPay (by their reference)."""
    if not API_KEY:
        raise RuntimeError("SENDAVAPAY_API_KEY is not configured")

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(
            f"{API_BASE}/verify-payment",
            headers=_headers(),
            json={"reference": reference},
        )
        r.raise_for_status()
        body = r.json()
    if not isinstance(body, dict) or not body.get("success"):
        return {}
    return body.get("data") or {}


def find_signature(headers: dict[str, str]) -> str:
    """Locate the signature header (case-insensitive)."""
    norm = {(k or "").lower(): v for k, v in headers.items()}
    for h in SIGNATURE_HEADERS:
        v = norm.get(h)
        if v:
            return str(v)
    return ""


def verify_webhook_signature(raw_body: bytes, signature: str) -> bool:
    """Constant-time compare HMAC-SHA256(raw_body, secret) against `signature`.

    Accepts three formats:
      • plain hex digest  : "abcd1234..."
      • prefixed hex      : "sha256=abcd1234..."
      • stripe-style      : "t=<ts>,v1=<hex>"
    """
    if not WEBHOOK_SECRET:
        # Fail-closed when no secret configured (prevents accidental open relay)
        return False
    if not signature:
        return False
    sig = signature.strip()
    expected = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()

    # Plain hex
    if hmac.compare_digest(expected, sig.lower()):
        return True
    # sha256=<hex>
    if sig.lower().startswith("sha256="):
        return hmac.compare_digest(expected, sig.split("=", 1)[1].lower())
    # stripe-style: t=...,v1=<hex>
    if "v1=" in sig:
        for part in sig.split(","):
            part = part.strip()
            if part.startswith("v1="):
                return hmac.compare_digest(expected, part.split("=", 1)[1].lower())
    return False


def parse_webhook_event(payload: Any) -> dict[str, Any]:
    """Normalise SendavaPay webhook payload into a uniform shape.

    SendavaPay official schema (observed):
      {
        "event":     "payment.success" | "payment.failed" | "payment.pending",
        "data": {
          "reference":          "pay_xxx",
          "externalReference":  "<our SPV-… ref>",
          "amount":             "1000.00",
          "currency":           "XOF",
          "status":             "success" | "failed" | "pending",
          "customerPhone":      "+228...",
          "paymentMethod":      "...",
          "completedAt":        "2026-..."
        }
      }
    """
    if not isinstance(payload, dict):
        return {}
    event = str(payload.get("event") or payload.get("type") or "").lower()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload

    return {
        "event": event,
        "reference": (data.get("reference") or data.get("transactionId") or ""),
        "external_reference": (
            data.get("externalReference")
            or data.get("external_reference")
            or data.get("merchantReference")
            or ""
        ),
        "status": str(data.get("status") or "").lower(),
        "amount": data.get("amount"),
        "currency": data.get("currency"),
        "customer_phone": data.get("customerPhone") or data.get("phone"),
        "customer_email": data.get("customerEmail") or data.get("email"),
        "customer_name": data.get("customerName") or data.get("name"),
        "payment_method": data.get("paymentMethod"),
        "completed_at": data.get("completedAt"),
        "raw": payload,
    }


def is_terminal_success(parsed: dict[str, Any]) -> bool:
    """Return True if the parsed event represents a confirmed payment."""
    status = (parsed.get("status") or "").lower()
    event = (parsed.get("event") or "").lower()
    return (
        status in ("success", "successful", "completed", "paid")
        or event in ("payment.success", "payment.completed", "payment.confirmed")
    )


def is_terminal_failed(parsed: dict[str, Any]) -> bool:
    status = (parsed.get("status") or "").lower()
    event = (parsed.get("event") or "").lower()
    return (
        status in ("failed", "cancelled", "canceled", "expired", "rejected")
        or event in ("payment.failed", "payment.cancelled", "payment.expired")
    )
