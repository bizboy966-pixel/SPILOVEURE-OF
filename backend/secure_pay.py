"""Secure payment gateway integration.

Provider: AshTechPay (https://ashtechpay.top/docs/api).
This module is intentionally named `secure_pay` so that the provider name
is not exposed via filenames, route names or front-end strings.

Base URL: https://ashtechpay.top
Auth   : `Authorization: Bearer <API_KEY>` (server-side only).

This module exposes:
- initiate_collect()       : POST /v1/collect to start a Mobile Money payment.
- get_transaction_status() : GET /v1/transaction/:id to reconcile a payment.
- normalize_status()       : map provider statuses to canonical values.

Environment variables (set in /app/backend/.env):
- SECURE_PAY_BASE_URL   : default https://ashtechpay.top
- SECURE_PAY_API_KEY    : Bearer token issued by the provider.
- SITE_URL              : public site URL used for notify_url.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger("secure_pay")

BASE_URL = os.environ.get("SECURE_PAY_BASE_URL", "https://ashtechpay.top").rstrip("/")
API_KEY = os.environ.get("SECURE_PAY_API_KEY", "")
SITE_URL = os.environ.get("SITE_URL", "https://spiloveure.com").rstrip("/")


class SecurePayError(Exception):
    """Raised when the payment gateway rejects a request or returns an error."""

    def __init__(self, message: str, *, code: Optional[str] = None, ussd_code: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.ussd_code = ussd_code


# ---------------------------------------------------------------------------
# Public URLs
# ---------------------------------------------------------------------------
def webhook_url() -> str:
    return f"{SITE_URL}/api/payments/secure/webhook"


# ---------------------------------------------------------------------------
# Status normalisation
# ---------------------------------------------------------------------------
def normalize_status(raw: Optional[str], event: Optional[str] = None) -> str:
    """Translate provider status / event into our canonical status.

    Provider statuses: pending | success | failed (+ webhook events:
    payment.completed / payment.failed). Returns: pending | paid | failed.
    """
    s = (raw or "").lower().strip()
    e = (event or "").lower().strip()
    if s in {"success", "completed"} or e == "payment.completed":
        return "paid"
    if s in {"failed", "failure", "expired", "cancelled"} or e == "payment.failed":
        return "failed"
    return "pending"


# ---------------------------------------------------------------------------
# /v1/collect — initiate Mobile Money payment
# ---------------------------------------------------------------------------
async def initiate_collect(
    *,
    amount: float,
    currency: str,
    phone: str,
    operator: str,
    country_code: str,
    reference: str,
    otp: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict[str, Any]:
    key = api_key or API_KEY
    if not key:
        raise SecurePayError("Payment gateway is not configured (missing API key)")

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body: dict[str, Any] = {
        "amount": amount,
        "currency": currency,
        "phone": phone,
        "operator": operator,
        "country_code": country_code,
        "reference": reference,
        "notify_url": webhook_url(),
    }
    if otp:
        body["otp"] = otp

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.post(f"{BASE_URL}/v1/collect", headers=headers, json=body)
        except httpx.RequestError as exc:
            log.exception("secure_pay network error")
            raise SecurePayError(f"Network error: {exc.__class__.__name__}") from exc

    try:
        data = r.json()
    except Exception as exc:
        raise SecurePayError(f"Invalid JSON response (HTTP {r.status_code})") from exc

    # OTP required: provider returns 400 with structured payload
    if r.status_code == 400 and data.get("error") == "otp_required":
        raise SecurePayError(
            data.get("message") or "OTP requis",
            code="otp_required",
            ussd_code=data.get("ussd_code"),
        )

    if r.status_code not in (200, 201, 202):
        raise SecurePayError(data.get("message") or f"HTTP {r.status_code}", code=data.get("error"))

    return data


# ---------------------------------------------------------------------------
# /v1/transaction/:id — status check
# ---------------------------------------------------------------------------
async def get_transaction_status(transaction_id: str, api_key: Optional[str] = None) -> dict[str, Any]:
    key = api_key or API_KEY
    if not key:
        raise SecurePayError("Payment gateway is not configured (missing API key)")
    headers = {"Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get(f"{BASE_URL}/v1/transaction/{transaction_id}", headers=headers)
        except httpx.RequestError as exc:
            raise SecurePayError(f"Network error: {exc.__class__.__name__}") from exc
    try:
        return r.json()
    except Exception as exc:
        raise SecurePayError("Invalid JSON from gateway") from exc
