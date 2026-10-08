"""AshtecPay Direct API v1 client — 100% compliant with the official skill.

Source of truth: https://doc.ashtechpay.com (fetched 2026-03-05).

Key compliance points vs the previous implementation :

  1. **`user_id` is REQUIRED** in the JSON body of every /v1/collect call AND
     in the query string of every /v1/transaction/:id read. We now surface
     it as an explicit parameter (loaded from `app_settings.payment_gateway.
     ashtec_user_id` or `ASHTECH_USER_ID` env). Missing user_id → caller
     will receive a clear 400 error from AshTech.

  2. **OTP session reference**. When AshTech responds `400 otp_required`,
     the body contains a `reference` that identifies the OTP session (NOT
     our merchant reference). On OTP confirmation, we MUST send back that
     exact session reference, NOT a new one — per the doc:
       « Ne remplacez pas la référence de session OTP par votre référence
         de commande. Une session expirée renvoie 400 otp_expired. »

  3. **Wave flow**. On `202` with `flow: "wave"`, the response contains
     `wave_url`. The caller must open that URL (or render a button that
     opens it) and wait for the webhook. We bubble it up as-is.

  4. **Status values** per /v1/transaction response: `pending`, `success`,
     `failed`. We map `success` → canonical internal `paid`.

  5. **Error codes** surfaced verbatim so the caller can match on them :
     `otp_required`, `otp_expired`, `invalid_otp`,
     `otp_confirmation_in_progress`, `user_id_required`, `user_id_mismatch`.

  6. **Base URL**: `https://www.ashtechpay.com`. Overridable via
     `ASHTECPAY_BASE_URL` for staging/sandbox.
"""
from __future__ import annotations
import logging
import os
from typing import Optional

import httpx

log = logging.getLogger("ashtecpay")

BASE_URL = os.environ.get("ASHTECPAY_BASE_URL") or "https://www.ashtechpay.com"
_TIMEOUT = 30.0


def _headers(api_key: str) -> dict:
    """Direct API Bearer auth per
    https://doc.ashtechpay.com/docs/authentication → `ak_...` keys."""
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _extract_error(data, status_code: int, raw_text: str) -> tuple[str, str]:
    """Return `(error_code, human_message)` — never raises.

    AshTech returns `{"error": "code", "message": "human text"}` per
    https://doc.ashtechpay.com/docs/errors. We also handle legacy
    pydantic-style arrays and non-JSON HTML gracefully.
    """
    err_code = "error"
    err_msg = ""
    if isinstance(data, dict):
        _e = data.get("error")
        if isinstance(_e, str) and _e:
            err_code = _e
        elif isinstance(_e, dict):
            if isinstance(_e.get("code"), str):
                err_code = _e["code"]
            for k in ("message", "detail"):
                v = _e.get(k)
                if isinstance(v, str) and v.strip():
                    err_msg = v.strip()
                    break
        for k in ("message", "detail", "description"):
            if err_msg:
                break
            v = data.get(k)
            if isinstance(v, str) and v.strip():
                err_msg = v.strip()
        if not err_msg:
            errs = data.get("errors")
            if isinstance(errs, list) and errs:
                first = errs[0]
                if isinstance(first, dict):
                    for k in ("message", "detail", "msg"):
                        v = first.get(k)
                        if isinstance(v, str) and v.strip():
                            err_msg = v.strip(); break
                elif isinstance(first, str):
                    err_msg = first
    if not err_msg and raw_text:
        trimmed = raw_text.strip()[:200]
        if trimmed:
            err_msg = f"[HTTP {status_code}] {trimmed}"
    if not err_msg:
        err_msg = f"AshtecPay a refusé la requête (HTTP {status_code})."
    return err_code, err_msg


async def initiate_payment(
    *,
    api_key: str,
    user_id: str,
    amount: float,
    currency: str,
    phone: str,
    operator: str,
    country_code: str,
    reference: Optional[str] = None,
    notify_url: Optional[str] = None,
    otp: Optional[str] = None,
) -> dict:
    """POST /v1/collect — Mobile Money collect, direction PAYIN.

    Behaviour maps 1-to-1 with the four flows documented in
    https://doc.ashtechpay.com/docs/direct-api/payment-flows :

      * **USSD Push**  → HTTP 202, `status: "pending"`. Caller waits for
                         the webhook. The user confirms on his phone.
      * **Wave**       → HTTP 202, `flow: "wave"`, `wave_url: "https://..."`.
                         Caller must open the URL (or hand it to the
                         frontend) and wait for the webhook.
      * **OTP SMS**    → HTTP 400 `error: "otp_required"` with the SESSION
                         `reference` (overrides our own). Caller re-calls
                         this function with `otp` + the EXACT session ref.
      * **OTP USSD**   → HTTP 400 `error: "otp_required"` with
                         `ussd_code` + session `reference`. Caller shows
                         the USSD, collects the OTP, then re-calls.

    Returns a normalized dict (never raises for HTTP errors):
      {
        "success": bool,
        "status_code": int,
        # on success:
        "transaction_id": str, "reference": str, "status": str,
        "flow": "ussd"|"wave"|...,  "wave_url": str?, "ussd_code": str?,
        "amount", "currency", "operator", "phone", "country_code",
        # on error (any 4xx):
        "error": "otp_required"|"otp_expired"|"invalid_otp"|...,
        "message": str,
        "session_reference": str?,  # when error == "otp_required"
        "ussd_code": str?,
        "raw": ...,
      }
    """
    if not api_key:
        return {"success": False, "status_code": 0, "error": "missing_key",
                "message": "Clé API AshtecPay non configurée."}
    if not user_id:
        return {"success": False, "status_code": 0, "error": "user_id_required",
                "message": ("`user_id` AshTech Pay non configuré. Ouvrez le "
                            "dashboard → Clé API → Direct API et renseignez-le "
                            "dans l'admin SPILOVEURE.")}

    payload: dict = {
        "user_id": str(user_id),
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
        async with httpx.AsyncClient(timeout=_TIMEOUT) as cli:
            r = await cli.post(url, json=payload, headers=_headers(api_key))
    except Exception as e:
        return {"success": False, "status_code": 0, "error": "network",
                "message": f"Erreur réseau AshtecPay: {e}"}
    raw = r.text
    try:
        data = r.json()
    except Exception:
        data = None

    # ─ Success path: 202 pending for USSD Push / Wave / OTP confirm ───
    if r.status_code == 202 and isinstance(data, dict):
        return {
            "success": True, "status_code": 202,
            "transaction_id": data.get("transaction_id"),
            "reference": data.get("reference"),
            "status": data.get("status") or "pending",
            # `flow` is `"wave"` for Wave redirections; absent for standard
            # USSD Push. See /docs/direct-api/payment-flows §2.
            "flow": data.get("flow"),
            "wave_url": data.get("wave_url"),
            "ussd_code": data.get("ussd_code"),
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

    # ─ 2xx but unknown shape — surface it to caller as a soft error.
    if 200 <= r.status_code < 300:
        return {"success": False, "status_code": r.status_code,
                "error": "invalid_response",
                "message": "AshtecPay a répondu 2xx mais le corps est inconnu.",
                "raw": data if data is not None else raw[:500]}

    # ─ Error path — extract code + human message.
    err_code, err_msg = _extract_error(data, r.status_code, raw)
    out: dict = {
        "success": False, "status_code": r.status_code,
        "error": err_code,
        "message": err_msg,
        "raw": data if data is not None else raw[:500],
    }
    # Attach OTP-flow specific fields if present (otp_required session).
    if isinstance(data, dict):
        if data.get("ussd_code"):
            out["ussd_code"] = data["ussd_code"]
        # The session reference comes BACK from AshTech in the 400 body.
        # Caller MUST reuse it on the OTP confirmation attempt.
        if data.get("reference"):
            out["session_reference"] = data["reference"]
    # Log without the OTP (sensitive).
    log.warning(
        "AshtecPay /v1/collect refused: status=%s error=%s payload=%s response=%s",
        r.status_code, err_code,
        {k: v for k, v in payload.items() if k != "otp"},
        raw[:500],
    )
    return out


async def confirm_otp(
    *,
    api_key: str,
    user_id: str,
    amount: float,
    currency: str,
    phone: str,
    operator: str,
    country_code: str,
    session_reference: str,
    otp: str,
    notify_url: Optional[str] = None,
) -> dict:
    """OTP confirmation sugar wrapper. Posts to /v1/collect again with the
    SAME `amount/currency/phone/operator/country_code` as the first call
    AND the `session_reference` returned by the `otp_required` response.

    Per https://doc.ashtechpay.com/docs/direct-api/payment-flows §4 :
      « Ne remplacez pas la référence de session OTP par votre référence
        de commande. »

    Possible outcomes:
      * HTTP 202 → paiement en attente de confirmation opérateur (normal).
      * HTTP 400 invalid_otp → caller peut réessayer avec la même session.
      * HTTP 400 otp_expired → caller doit relancer un NOUVEAU `collect`.
      * HTTP 409 otp_confirmation_in_progress → une autre confirmation est
        en cours; attendre et poll /v1/transaction.
    """
    return await initiate_payment(
        api_key=api_key, user_id=user_id, amount=amount, currency=currency,
        phone=phone, operator=operator, country_code=country_code,
        reference=session_reference, notify_url=notify_url, otp=otp,
    )


async def verify_payment(
    *,
    api_key: str,
    transaction_id: str,
    user_id: str,
) -> dict:
    """GET /v1/transaction/{id}?user_id=...  per
    https://doc.ashtechpay.com/docs/reference/transaction.

    `user_id` is REQUIRED in the query string (was missing in the
    previous implementation → always 400 user_id_required).
    """
    if not api_key:
        return {"success": False, "status_code": 0, "error": "missing_key",
                "message": "Clé API AshtecPay non configurée."}
    if not user_id:
        return {"success": False, "status_code": 0, "error": "user_id_required",
                "message": "`user_id` AshTech Pay non configuré."}
    url = f"{BASE_URL}/v1/transaction/{transaction_id}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as cli:
            r = await cli.get(url, params={"user_id": str(user_id)},
                              headers=_headers(api_key))
    except Exception as e:
        return {"success": False, "status_code": 0, "error": "network",
                "message": f"Erreur réseau AshtecPay: {e}"}
    try:
        data = r.json()
    except Exception:
        return {"success": False, "status_code": r.status_code,
                "error": "invalid_response", "message": "Réponse invalide AshtecPay"}
    if r.status_code != 200:
        err_code, err_msg = _extract_error(data, r.status_code, r.text)
        return {"success": False, "status_code": r.status_code,
                "error": err_code, "message": err_msg, "raw": data}
    return {
        "success": True, "status_code": 200,
        "transaction_id": data.get("transaction_id"),
        "reference": data.get("reference"),
        "status": data.get("status") or "pending",  # pending|success|failed
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
    """Map AshtecPay status (`pending`|`success`|`failed`) → our internal
    canonical `paid`|`failed`|`pending`. Per
    https://doc.ashtechpay.com/docs/reference/transaction only three
    values are valid for the status field; we keep a lenient alias list
    for robustness."""
    s = (raw or "").strip().lower()
    if s in ("success", "completed", "paid", "ok"):
        return "paid"
    if s in ("failed", "refused", "expired", "cancelled", "canceled", "error"):
        return "failed"
    return "pending"


async def list_countries(api_key: str) -> list[dict]:
    """GET /v1/countries — live catalog, authoritative source of truth
    for the countries, currencies and operator labels.

    Per the doc, the operator value sent to /v1/collect MUST be byte-for-
    byte identical to what this endpoint returns (ex: "MTN Money",
    "Mixx By Yas", "Orange Money (OTP)"), case-sensitive.
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
        log.warning("AshtecPay /v1/countries HTTP %s: %s",
                    r.status_code, r.text[:200])
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
