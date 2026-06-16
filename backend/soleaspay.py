"""SoleasPay v3 — pay-in + polling verification.

Flow:
  1) POST /api/agent/bills/v3 — sends a Mobile Money request to the user's phone
  2) GET  /api/agent/verif-pay — polled until the user confirms on their phone
  3) Status becomes 'SUCCESS' -> activate user level

No webhook signature needed: we own the polling lifecycle.
RDC (COD) is intentionally excluded from supported countries.
"""
from __future__ import annotations
import os, logging
from typing import Optional
import httpx

log = logging.getLogger("soleaspay")
BASE_URL = "https://soleaspay.com"
OPERATION_PAYIN = 2

# Country -> [{service_id, label, currency}]
SUPPORTED: dict = {
    "TG":  [{"id": 37, "label": "T-MONEY", "currency": "XOF"}, {"id": 38, "label": "MOOV", "currency": "XOF"}],
    "BJ":  [{"id": 35, "label": "MTN MoMo", "currency": "XOF"}, {"id": 36, "label": "MOOV", "currency": "XOF"}],
    "CI":  [{"id": 29, "label": "Orange Money", "currency": "XOF"}, {"id": 30, "label": "MTN MoMo", "currency": "XOF"},
            {"id": 31, "label": "MOOV", "currency": "XOF"}, {"id": 32, "label": "WAVE", "currency": "XOF"}],
    "BF":  [{"id": 33, "label": "MOOV", "currency": "XOF"}, {"id": 34, "label": "Orange Money", "currency": "XOF"}],
    "CM":  [{"id": 1,  "label": "MTN MoMo", "currency": "XAF"}, {"id": 2,  "label": "Orange Money", "currency": "XAF"}],
    "COG": [{"id": 55, "label": "AIRTEL", "currency": "XAF"}, {"id": 56, "label": "MTN MoMo", "currency": "XAF"}],
    "GAB": [{"id": 57, "label": "AIRTEL", "currency": "XAF"}],
    "UGA": [{"id": 58, "label": "AIRTEL", "currency": "UGX"}, {"id": 59, "label": "MTN MoMo", "currency": "UGX"}],
}
EXCLUDED_COUNTRIES = {"COD"}  # RDC Congo - excluded per business rule


def api_key() -> str:
    return os.environ.get("SOLEASPAY_API_KEY", "")


def is_configured() -> bool:
    return bool(api_key())


def country_services(country_code: str) -> list:
    cc = (country_code or "").upper()
    if cc in EXCLUDED_COUNTRIES:
        return []
    return SUPPORTED.get(cc, [])


def find_service(country_code: str, service_id: int) -> Optional[dict]:
    for s in country_services(country_code):
        if int(s["id"]) == int(service_id):
            return s
    return None


async def initiate_payment(
    *, service_id: int, wallet: str, amount: float, currency: str,
    order_id: str, description: str, payer: str, payer_email: str,
    success_url: str, failure_url: str,
) -> dict:
    """Send a pay-in request. SoleasPay pushes a USSD prompt to `wallet`.

    Returns: {success, code, status, data:{reference, external_reference, ...}, message}
    """
    headers = {
        "x-api-key": api_key(),
        "operation": str(OPERATION_PAYIN),
        "service": str(service_id),
        "Content-Type": "application/json",
    }
    payload = {
        "wallet": str(wallet).strip(),
        "amount": float(amount),
        "currency": currency,
        "orderId": order_id,
        "description": description,
        "payer": payer,
        "payerEmail": payer_email,
        "successUrl": success_url,
        "failureUrl": failure_url,
    }
    async with httpx.AsyncClient(timeout=30.0) as cli:
        r = await cli.post(f"{BASE_URL}/api/agent/bills/v3", headers=headers, json=payload)
        try:
            data = r.json()
        except Exception:
            log.error("SoleasPay non-JSON response: %s %s", r.status_code, r.text[:300])
            return {"success": False, "code": r.status_code, "message": "Réponse invalide de SoleasPay"}
        log.info("SoleasPay initiate (%s): %s", r.status_code, data)
        return data


async def verify_payment(order_id: str, pay_id: str, service_id: int = 1) -> dict:
    """Poll SoleasPay for transaction status.

    Returns: {success, code, status:'SUCCESS'|'PROCESSING'|'FAILED'|..., data:{...}, message}
    """
    headers = {
        "x-api-key": api_key(),
        "operation": str(OPERATION_PAYIN),
        "service": str(service_id),
        "Content-Type": "application/json",
    }
    params = {"orderId": order_id, "payId": pay_id}
    async with httpx.AsyncClient(timeout=20.0) as cli:
        r = await cli.get(f"{BASE_URL}/api/agent/verif-pay", headers=headers, params=params)
        try:
            data = r.json()
        except Exception:
            log.error("SoleasPay verify non-JSON: %s %s", r.status_code, r.text[:300])
            return {"success": False, "code": r.status_code, "message": "Réponse invalide"}
        log.info("SoleasPay verify (%s) order=%s pay=%s: %s", r.status_code, order_id, pay_id, data)
        return data


def normalize_status(soleaspay_status: str) -> str:
    """Map SoleasPay status -> our internal {pending, paid, failed}."""
    s = (soleaspay_status or "").upper()
    if s in ("SUCCESS", "SUCCÈS", "VALIDATED"):
        return "paid"
    if s in ("FAILED", "ÉCHEC", "ECHEC", "CANCELLED", "REFUSED", "REJECTED"):
        return "failed"
    return "pending"
