"""Secure payment gateway integration.

Provider: WestPay (RobotPay) — https://westpay.cfd
Flow: hosted-page redirection + signed webhook callback. No direct API call
is needed from our backend to initiate a payment — we simply build a redirect
URL pointing to the provider's hosted checkout page.

The provider sends back an HMAC-SHA256 signed webhook to our backend when the
payment is confirmed.

Environment variables (set in /app/backend/.env):
- WESTPAY_BASE_URL       : default http://westpay.cfd
- WESTPAY_SLUG           : merchant slug (e.g. "spiloveure")
- WESTPAY_WEBHOOK_SECRET : shared secret used to verify webhook HMAC signature
- SITE_URL               : public site URL used for the redirect-back URL
"""
from __future__ import annotations

import hmac
import hashlib
import json
import logging
import os
from typing import Any, Optional
from urllib.parse import urlencode

log = logging.getLogger("secure_pay")

BASE_URL = os.environ.get("WESTPAY_BASE_URL", "https://westpay.cfd").rstrip("/")
SLUG = os.environ.get("WESTPAY_SLUG", "spiloveure")
WEBHOOK_SECRET = os.environ.get("WESTPAY_WEBHOOK_SECRET", "")
SITE_URL = os.environ.get("SITE_URL", "https://spiloveure.com").rstrip("/")


# Map ISO country code → WestPay country name (used in `country` query param).
# Per merchant request: RDC Congo (CD) is EXCLUDED.
COUNTRY_NAME_BY_CODE = {
    "TG": "Togo",
    "BJ": "Benin",
    "BF": "Burkina Faso",
    "CI": "Cote d'Ivoire",
    "ML": "Mali",
    "SN": "Senegal",
    "CG": "Congo Brazzaville",
    "GA": "Gabon",
    "CM": "Cameroun",
}

# Countries excluded from the automatic deposit flow.
EXCLUDED_COUNTRIES = {"CD"}


class SecurePayError(Exception):
    """Raised on payment-gateway-related errors."""

    def __init__(self, message: str, *, code: Optional[str] = None, ussd_code: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.ussd_code = ussd_code


def webhook_url() -> str:
    return f"{SITE_URL}/api/payments/secure/webhook"


def normalize_status(raw: Optional[str], event: Optional[str] = None) -> str:
    """Map provider statuses / events into canonical pending|paid|failed."""
    s = (raw or "").lower().strip()
    e = (event or "").lower().strip()
    if s in {"success", "completed", "paid", "confirmed"} or e in {"payment.confirmed", "payment.completed"}:
        return "paid"
    if s in {"failed", "failure", "expired", "cancelled", "rejected"} or e in {"payment.failed", "payment.rejected"}:
        return "failed"
    return "pending"


def build_redirect_url(
    *,
    amount: float,
    country_code: str,
    reference: str,
) -> str:
    """Build the WestPay hosted-checkout URL the user must be redirected to.

    The redirect-back URL embeds the internal reference so we can match the
    transaction once the user returns.
    """
    redirect_back = f"{SITE_URL}/payment/success?ref={reference}"
    params = {
        "merchant": SLUG,
        "amount": int(round(float(amount))),
        "country": COUNTRY_NAME_BY_CODE.get(country_code.upper(), country_code),
        "ref": reference,
        "redirect": redirect_back,
    }
    return f"{BASE_URL}/pay?{urlencode(params)}"


def verify_webhook_signature(raw_body: bytes, signature_header: str) -> bool:
    """Validate the HMAC-SHA256 signature WestPay attaches to webhook payloads."""
    if not WEBHOOK_SECRET or not signature_header:
        return False
    try:
        expected = hmac.new(
            WEBHOOK_SECRET.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature_header.strip())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Legacy-compatible adapters (kept so the rest of the backend keeps compiling).
# WestPay uses a hosted redirection flow, so initiate_collect now returns a
# {wave_url, flow:"redirect"} payload instead of issuing an HTTP call.
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
    redirect_url = build_redirect_url(
        amount=amount, country_code=country_code, reference=reference,
    )
    return {
        "ok": True,
        "flow": "redirect",
        "redirect_url": redirect_url,
        "wave_url": redirect_url,  # legacy field name kept for the FE
        "transaction_id": reference,
        "reference": reference,
        "currency": currency,
        "amount": amount,
        "status": "pending",
    }


async def get_transaction_status(transaction_id: str, api_key: Optional[str] = None) -> dict[str, Any]:
    """No public endpoint for transaction lookup in WestPay's redirect flow.

    Status is delivered exclusively via the signed webhook + the redirect-back
    URL (?status=success). Return an empty dict so the caller treats it as
    "still pending — wait for webhook".
    """
    return {"status": "pending"}


def parse_webhook_event(payload: dict) -> dict:
    """Extract canonical fields from a WestPay webhook body.

    WestPay webhook body example:
      {
        "event": "payment.confirmed",
        "txId": "OP-abc123",
        "amount": 2500,
        "currency": "XOF",
        "payer": "+22890123456",
        "country": "Togo",
        "merchantSlug": "spiloveure",
        "provider": "mobile",
        "timestamp": "2026-03-01T10:30:00.000Z",
        "ref": "SPV-XXXXX"        // (echoed back from our redirect URL)
      }
    """
    event = (payload.get("event") or "").lower()
    return {
        "event": event,
        "reference": payload.get("ref") or payload.get("reference") or payload.get("txId"),
        "transaction_id": payload.get("txId") or payload.get("transaction_id"),
        "status": normalize_status(None, event),
        "amount": payload.get("amount"),
        "currency": payload.get("currency"),
        "payer": payload.get("payer"),
        "country": payload.get("country"),
        "merchant_slug": payload.get("merchantSlug") or payload.get("merchant_slug"),
        "provider": payload.get("provider"),
        "raw": payload,
    }


# Quiet unused-import warning in environments without json usage
_ = json
