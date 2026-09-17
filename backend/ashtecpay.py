"""AshtecPay V1 — second automatic payment gateway alongside SoleasPay.

Same interface as `soleaspay.py` (initiate_payment, verify_payment, normalize_status)
so the dispatcher in server.py can call either implementation interchangeably.

The API key is admin-configured via `app_settings.payment_gateway.ashtec_api_key`
and passed explicitly at every call — never imported from .env.
"""
from __future__ import annotations
import logging
import os
from typing import Optional
import httpx

log = logging.getLogger("ashtecpay")

# Base URL updated 2026-02-14 — Ashtechpay migrated to www.ashtechpay.com
# (previous host `ashtechpay.top` still resolves but is deprecated per the
# official docs at https://doc.ashtechpay.com/docs/introduction#base-url).
# Overridable via ASHTECPAY_BASE_URL for staging/sandbox.
BASE_URL = os.environ.get("ASHTECPAY_BASE_URL") or "https://www.ashtechpay.com"


def _headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _extract_error(data, status_code: int, raw_text: str) -> str:
    """Try hard to surface a useful error message from any Ashtech response
    shape (JSON with `message`/`error`/`detail`/`errors`, non-JSON HTML, etc.).
    """
    if isinstance(data, dict):
        # 1. Direct message field
        for k in ("message", "detail", "description"):
            v = data.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        # 2. Error as string
        err = data.get("error")
        if isinstance(err, str) and err.strip():
            return err.strip()
        # 3. Error as dict with .message
        if isinstance(err, dict):
            for k in ("message", "detail"):
                v = err.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
        # 4. Errors array (pydantic-style)
        errs = data.get("errors")
        if isinstance(errs, list) and errs:
            first = errs[0]
            if isinstance(first, dict):
                for k in ("message", "detail", "msg"):
                    v = first.get(k)
                    if isinstance(v, str) and v.strip():
                        return v.strip()
            elif isinstance(first, str):
                return first
    # 5. Fall back to raw body (trimmed) — helpful when the API returned HTML
    if raw_text:
        trimmed = raw_text.strip()[:200]
        if trimmed:
            return f"[HTTP {status_code}] {trimmed}"
    return f"AshtecPay a refusé la requête (HTTP {status_code})."


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
        data = None
    # 2xx success path
    if r.status_code == 202 and isinstance(data, dict):
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
    # Error path — extract message from all common shapes, log the raw body
    err_msg = _extract_error(data, r.status_code, raw)
    err_code = "error"
    if isinstance(data, dict):
        _e = data.get("error")
        if isinstance(_e, str) and _e:
            err_code = _e
    log.warning(
        "AshtecPay /v1/collect refused: status=%s payload=%s response=%s",
        r.status_code,
        {k: v for k, v in payload.items() if k not in ("otp",)},
        raw[:500],
    )
    return {
        "success": False, "status_code": r.status_code,
        "error": err_code,
        "message": err_msg,
        "ussd_code": (data or {}).get("ussd_code") if isinstance(data, dict) else None,
        "raw": data if data is not None else raw[:500],
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


async def list_countries(api_key: str) -> list[dict]:
    """GET /v1/countries — returns the LIVE catalog straight from AshTech Pay.

    Added 2026-02-14 after the domain migration to `www.ashtechpay.com`.
    Each item is:
        {"code": "CM", "name": "Cameroun",
         "currency": "XAF",
         "operators": ["MTN Money", "Orange Money"]}
    Returns [] on any error so callers can fall back to their cached list.
    """
    if not api_key:
        return []
    url = f"{BASE_URL}/v1/countries"
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            r = await cli.get(url, headers=_headers(api_key))
    except Exception as e:
        log.warning("AshtecPay /v1/countries network error: %s", e)
        return []
    if r.status_code != 200:
        log.warning("AshtecPay /v1/countries HTTP %s: %s", r.status_code, r.text[:200])
        return []
    try:
        data = r.json()
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        code = (item.get("code") or "").strip().upper()
        name = (item.get("name") or "").strip()
        currency = (item.get("currency") or "").strip().upper()
        operators = item.get("operators") or []
        if not code or not currency or not isinstance(operators, list):
            continue
        out.append({
            "code": code, "name": name, "currency": currency,
            "operators": [str(op) for op in operators if op],
        })
    return out
