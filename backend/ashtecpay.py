"""AshtecPay V1 — second automatic payment gateway alongside SoleasPay.

Same interface as `soleaspay.py` (initiate_payment, verify_payment, normalize_status)
so the dispatcher in server.py can call either implementation interchangeably.

The API key is admin-configured via `app_settings.payment_gateway.ashtec_api_key`
and passed explicitly at every call — never imported from .env.
"""
from __future__ import annotations
import os
from typing import Optional
import httpx

# Base URL is fixed per the API spec. Allow override via .env for staging/sandbox.
BASE_URL = os.environ.get("ASHTECPAY_BASE_URL") or "https://ashtechpay.top"


def _headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def initiate_payment(
    *,
    api_key: str,
    amount: float,
    currency: str,
    phone: str,
    operator: str,
    country_code: str,
    reference: Optional[str] = None,
    notify_url: Optional[str] = None,
    otp: Optional[str] = None,
) -> dict:
    """POST /v1/collect — returns a normalized dict :
        {success, status_code, transaction_id?, status?, flow?, wave_url?,
         error?, message?, ussd_code?, raw}
    """
    if not api_key:
        return {"success": False, "status_code": 0, "error": "missing_key",
                "message": "Clé API AshtecPay non configurée."}
    payload: dict = {
        "amount": float(amount),
        "currency": currency,
        "phone": phone,
        "operator": operator,
        "country_code": country_code,
    }
    if reference:
        payload["reference"] = reference
    if notify_url:
        payload["notify_url"] = notify_url
    if otp:
        payload["otp"] = otp
    url = f"{BASE_URL}/v1/collect"
    try:
        async with httpx.AsyncClient(timeout=30.0) as cli:
            r = await cli.post(url, json=payload, headers=_headers(api_key))
    except Exception as e:
        return {"success": False, "status_code": 0, "error": "network",
                "message": f"Erreur réseau AshtecPay: {e}"}
    raw = r.text
    try:
        data = r.json()
    except Exception:
        return {"success": False, "status_code": r.status_code,
                "error": "invalid_response", "message": "Réponse invalide AshtecPay",
                "raw": raw}
    # Map response shape into our normalized format
    if r.status_code == 202:
        return {
            "success": True, "status_code": 202,
            "transaction_id": data.get("transaction_id"),
            "reference": data.get("reference"),
            "status": data.get("status") or "pending",
            "flow": data.get("flow"),
            "wave_url": data.get("wave_url"),
            "amount": data.get("amount"),
            "credited_amount": data.get("credited_amount"),
            "fee_amount": data.get("fee_amount"),
            "currency": data.get("currency"),
            "operator": data.get("operator"),
            "phone": data.get("phone"),
            "country_code": data.get("country_code"),
            "created_at": data.get("created_at"),
            "message": data.get("message")
                       or "Confirmez le paiement sur votre téléphone.",
            "raw": data,
        }
    # Error or otp_required
    return {
        "success": False, "status_code": r.status_code,
        "error": data.get("error") or "error",
        "message": data.get("message") or f"Erreur HTTP {r.status_code}",
        "ussd_code": data.get("ussd_code"),
        "raw": data,
    }


async def verify_payment(*, api_key: str, transaction_id: str) -> dict:
    """GET /v1/transaction/{id} — returns normalized dict."""
    if not api_key:
        return {"success": False, "status_code": 0, "error": "missing_key",
                "message": "Clé API AshtecPay non configurée."}
    url = f"{BASE_URL}/v1/transaction/{transaction_id}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as cli:
            r = await cli.get(url, headers=_headers(api_key))
    except Exception as e:
        return {"success": False, "status_code": 0, "error": "network",
                "message": f"Erreur réseau AshtecPay: {e}"}
    try:
        data = r.json()
    except Exception:
        return {"success": False, "status_code": r.status_code,
                "error": "invalid_response", "message": "Réponse invalide AshtecPay"}
    if r.status_code != 200:
        return {"success": False, "status_code": r.status_code,
                "error": data.get("error") or "error",
                "message": data.get("message") or f"Erreur HTTP {r.status_code}",
                "raw": data}
    return {
        "success": True, "status_code": 200,
        "transaction_id": data.get("transaction_id"),
        "reference": data.get("reference"),
        "status": data.get("status") or "pending",
        "amount": data.get("amount"),
        "credited_amount": data.get("credited_amount"),
        "fee_amount": data.get("fee_amount"),
        "currency": data.get("currency"),
        "phone": data.get("phone"),
        "created_at": data.get("created_at"),
        "confirmed_at": data.get("confirmed_at"),
        "raw": data,
    }


def normalize_status(raw: str | None) -> str:
    """Map AshtecPay status → our internal {paid, failed, pending}."""
    s = (raw or "").strip().lower()
    if s in ("success", "completed", "paid", "ok"):
        return "paid"
    if s in ("failed", "refused", "expired", "cancelled", "canceled", "error"):
        return "failed"
    return "pending"
