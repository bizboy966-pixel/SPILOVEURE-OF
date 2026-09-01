"""SoleasPay v3 — pay-in (agent) + pay-out (automatic Mobile Money disbursement).

P-In flow:
  1) POST /api/agent/bills/v3 — sends a Mobile Money request to the user's phone
  2) GET  /api/agent/verif-pay — polled until the user confirms
  3) Signed HMAC-SHA256 webhook confirms (see server.py::soleaspay_webhook)

P-Out flow (added 2026-09-02):
  1) POST /api/action/account/withdraw with header operation=4, service=<id>
     — SoleasPay queues the payout ("PROCESSING", HTTP 201).
  2) Same signed webhook receives WITHDRAW events → mark withdrawal completed/failed.

Auth: same x-api-key as P-In (consistent with existing SoleasPay tenant). The
official docs mention Bearer JWT for /api/action/* — if that becomes required
in production, set SOLEASPAY_PAYOUT_BEARER=1 and provide the public/private
keys via env; we then fetch a token from POST /api/action/auth.

RDC (COD) is intentionally excluded from supported countries.
"""
from __future__ import annotations
import os, time, logging
from typing import Optional
import httpx

log = logging.getLogger("soleaspay")
BASE_URL = "https://soleaspay.com"
OPERATION_PAYIN = 2
OPERATION_PAYOUT = 4

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


def normalize_status(soleaspay_status: str, success_flag: Optional[bool] = None, code: Optional[int] = None) -> str:
    """Map SoleasPay status -> our internal {pending, paid, failed}.

    SoleasPay's doc lists 'SUCCESS', 'RECEIVED', 'REFUND' for callbacks but the
    verif-pay endpoint may return synonyms. We are permissive: if `success=true`
    AND `code=200` we consider it paid even with an unfamiliar status string.
    """
    s = (soleaspay_status or "").upper().strip()
    if s in ("SUCCESS", "SUCCÈS", "SUCCES", "VALIDATED", "VALIDE", "VALIDÉ",
             "COMPLETED", "CONFIRMED", "APPROVED", "PAID", "PAYE", "PAYÉ"):
        return "paid"
    if s in ("FAILED", "ECHEC", "ÉCHEC", "CANCELLED", "CANCELED", "REFUSED",
             "REJECTED", "DECLINED", "EXPIRED", "TIMEOUT", "FAILURE"):
        return "failed"
    # Permissive fallback: trust the success flag if the textual status is unknown
    if success_flag is True and (code is None or 200 <= int(code) < 300):
        return "paid"
    return "pending"


# ═══════════════════════════════════════════════════════════════════════
# PAY-OUT (automatic Mobile Money disbursement) — added 2026-09-02
# ═══════════════════════════════════════════════════════════════════════

def find_service_by_operator_label(country_code: str, label: str) -> Optional[dict]:
    """Case-insensitive fuzzy match: 'T-Money' → SUPPORTED['TG'][0]."""
    if not label:
        return None
    norm = "".join(ch for ch in label.upper() if ch.isalnum())
    for s in country_services(country_code):
        s_norm = "".join(ch for ch in s["label"].upper() if ch.isalnum())
        if norm == s_norm or norm in s_norm or s_norm in norm:
            return s
    return None


_bearer_cache: dict = {"token": None, "exp": 0.0}


async def _get_bearer_token() -> Optional[str]:
    """Fetch a JWT from POST /api/action/auth. Cached ~55 min.

    Returns None if SOLEASPAY_PUBLIC_KEY / SOLEASPAY_PRIVATE_KEY not set.
    """
    now = time.time()
    if _bearer_cache["token"] and _bearer_cache["exp"] > now + 30:
        return _bearer_cache["token"]
    pub = os.environ.get("SOLEASPAY_PUBLIC_KEY", "")
    priv = os.environ.get("SOLEASPAY_PRIVATE_KEY", "")
    if not (pub and priv):
        return None
    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            r = await cli.post(f"{BASE_URL}/api/action/auth",
                               json={"public_apikey": pub, "private_secretkey": priv})
            data = r.json() if r.status_code < 500 else {}
        tok = (data or {}).get("token") or (data or {}).get("access_token")
        if not tok:
            log.warning("SoleasPay bearer auth failed: %s %s", r.status_code, str(data)[:200])
            return None
        _bearer_cache["token"] = tok
        _bearer_cache["exp"] = now + 55 * 60
        return tok
    except Exception as e:
        log.exception("SoleasPay bearer auth error: %s", e)
        return None


async def _payout_headers(service_id: int) -> dict:
    """Build auth headers for the withdraw endpoint.

    Default: reuse x-api-key (consistent with P-In). If SOLEASPAY_PAYOUT_BEARER=1
    is set OR x-api-key is empty, fetch a bearer token.
    """
    use_bearer = os.environ.get("SOLEASPAY_PAYOUT_BEARER", "0") == "1"
    headers = {
        "operation": str(OPERATION_PAYOUT),
        "service": str(service_id),
        "Content-Type": "application/json",
    }
    if use_bearer or not api_key():
        tok = await _get_bearer_token()
        if not tok:
            raise RuntimeError("SoleasPay P-Out: bearer token unavailable")
        headers["Authorization"] = f"Bearer {tok}"
    else:
        headers["x-api-key"] = api_key()
    return headers


async def initiate_payout(
    *, service_id: int, wallet: str, amount: float, currency: str,
    order_id: str,
) -> dict:
    """POST /api/action/account/withdraw — queues a payout.

    Returns raw JSON: {success, code:201, status:"PROCESSING",
                       data:{reference, transaction_reference, ...}, message}
    """
    headers = await _payout_headers(service_id)
    payload = {
        "wallet": str(wallet).strip(),
        "amount": float(amount),
        "currency": currency,
        "orderId": order_id,
        "transaction_reference": order_id,
    }
    async with httpx.AsyncClient(timeout=30.0) as cli:
        r = await cli.post(f"{BASE_URL}/api/action/account/withdraw",
                           headers=headers, json=payload)
        try:
            data = r.json()
        except Exception:
            log.error("SoleasPay payout non-JSON: %s %s", r.status_code, r.text[:300])
            return {"success": False, "code": r.status_code,
                    "message": "Réponse invalide de SoleasPay"}
        # Attach HTTP code if provider didn't return `code`.
        if "code" not in data:
            data["code"] = r.status_code
        log.info("SoleasPay payout (%s) order=%s: %s", r.status_code, order_id, data)
        return data


def normalize_payout_status(status: str, success_flag: Optional[bool] = None,
                             code: Optional[int] = None) -> str:
    """Map SoleasPay withdraw status to internal {pending, completed, failed}."""
    s = (status or "").upper().strip()
    if s in ("SUCCESS", "COMPLETED", "PAID", "APPROVED", "VALIDATED"):
        return "completed"
    if s in ("FAILED", "FAILURE", "REJECTED", "CANCELLED", "CANCELED",
             "REFUSED", "EXPIRED", "TIMEOUT", "DECLINED", "ERROR"):
        return "failed"
    if s in ("PROCESSING", "PENDING", "QUEUED", "IN_PROGRESS"):
        return "pending"
    if success_flag is False:
        return "failed"
    return "pending"


async def dispatch_soleaspay_withdrawal(db, wd: dict, pg_cfg: dict) -> dict:
    """Dispatch a withdrawal via SoleasPay P-Out.

    Called from server.py::request_withdrawal BEFORE the BizTransPay fallback.
    Never raises — on any failure, returns {auto_dispatched:False, reason:...}
    so the caller can try the next gateway or leave the withdrawal "pending".

    Idempotency: uses wd['id'] as SoleasPay `orderId`. Also stores a row in
    `soleaspay_payouts` keyed on wd_id (unique index) to prevent double-send.
    """
    # Mobile-money only — SoleasPay does not payout crypto.
    method = (wd.get("method") or "").lower()
    if method not in ("mobile", "mobile_money", "mm"):
        return {"auto_dispatched": False, "reason": "not_mobile"}

    # Feature gates.
    if not pg_cfg.get("soleas_enabled"):
        return {"auto_dispatched": False, "reason": "soleas_disabled"}
    if not pg_cfg.get("soleaspay_pout_enabled"):
        return {"auto_dispatched": False, "reason": "pout_globally_off"}
    if not (api_key() or (os.environ.get("SOLEASPAY_PUBLIC_KEY") and
                          os.environ.get("SOLEASPAY_PRIVATE_KEY"))):
        return {"auto_dispatched": False, "reason": "no_credentials"}

    cc = (wd.get("country") or "").upper()
    if not cc:
        return {"auto_dispatched": False, "reason": "no_country"}
    if cc in EXCLUDED_COUNTRIES or cc not in SUPPORTED:
        return {"auto_dispatched": False, "reason": "country_unsupported"}

    # Per-country P-Out matrix (default = enabled if country is in SUPPORTED).
    pout_matrix = (pg_cfg.get("soleaspay_pout_country_matrix") or {})
    if cc in pout_matrix and pout_matrix[cc] is False:
        return {"auto_dispatched": False, "reason": "pout_country_off"}

    # Resolve operator → service_id.
    op_label = (wd.get("operator") or "").strip()
    svc = find_service_by_operator_label(cc, op_label)
    if not svc:
        return {"auto_dispatched": False, "reason": "operator_unmapped",
                "detail": f"Opérateur '{op_label}' non mappé pour {cc}"}

    amount = float(wd.get("net_payout") or wd.get("amount") or 0)
    if amount <= 0:
        return {"auto_dispatched": False, "reason": "invalid_amount"}

    wallet = (wd.get("phone") or "").strip()
    if not wallet:
        return {"auto_dispatched": False, "reason": "no_phone"}

    # Idempotency: reserve the payout row first. Unique index on wd_id.
    order_id = wd["id"]
    payout_doc = {
        "wd_id": order_id,
        "user_id": wd.get("user_id"),
        "amount": amount,
        "currency": svc["currency"],
        "service_id": int(svc["id"]),
        "country": cc,
        "operator_label": op_label,
        "wallet": wallet,
        "status": "created",
        "created_at": _utcnow(),
    }
    try:
        await db.soleaspay_payouts.insert_one(payout_doc)
    except Exception as e:
        # Duplicate key → already dispatched. Reuse existing row.
        existing = await db.soleaspay_payouts.find_one({"wd_id": order_id})
        if existing:
            return {"auto_dispatched": bool(existing.get("provider_reference")),
                    "reason": "already_dispatched",
                    "provider_reference": existing.get("provider_reference")}
        log.exception("soleaspay_payouts insert failed: %s", e)
        return {"auto_dispatched": False, "reason": "db_error"}

    # Call SoleasPay.
    try:
        resp = await initiate_payout(
            service_id=int(svc["id"]),
            wallet=wallet,
            amount=amount,
            currency=svc["currency"],
            order_id=order_id,
        )
    except Exception as e:
        log.exception("SoleasPay payout dispatch failed: %s", e)
        await db.soleaspay_payouts.update_one(
            {"wd_id": order_id},
            {"$set": {"status": "gateway_error", "error": str(e)[:400],
                      "updated_at": _utcnow()}},
        )
        return {"auto_dispatched": False, "reason": "gateway_unreachable"}

    code = resp.get("code")
    status_raw = str(resp.get("status") or "").upper()
    success_flag = bool(resp.get("success"))
    data = resp.get("data") or {}
    prov_ref = data.get("reference") or data.get("transaction_reference")

    # Success = HTTP 200/201 + success flag + status in {PROCESSING, SUCCESS, QUEUED, PENDING}
    is_accepted = (
        success_flag
        and (code is None or (isinstance(code, int) and 200 <= code < 300))
        and status_raw in ("PROCESSING", "SUCCESS", "QUEUED", "PENDING", "COMPLETED")
    )
    if not is_accepted:
        err_msg = (resp.get("message") or "").strip() or f"HTTP {code}"
        await db.soleaspay_payouts.update_one(
            {"wd_id": order_id},
            {"$set": {"status": "refused", "provider_response": resp,
                      "error": err_msg, "updated_at": _utcnow()}},
        )
        await db.withdrawals.update_one(
            {"id": order_id},
            {"$set": {"auto_dispatch_error": f"soleaspay: {err_msg}",
                      "auto_dispatch_at": _utcnow()}},
        )
        return {"auto_dispatched": False, "reason": "gateway_refused",
                "error": err_msg}

    now = _utcnow()
    internal_status = normalize_payout_status(status_raw, success_flag, code)
    await db.soleaspay_payouts.update_one(
        {"wd_id": order_id},
        {"$set": {
            "status": "dispatched" if internal_status == "pending" else internal_status,
            "provider_reference": prov_ref,
            "provider_response": resp,
            "provider_status": status_raw,
            "dispatched_at": now, "updated_at": now,
        }},
    )
    await db.withdrawals.update_one(
        {"id": order_id},
        {"$set": {
            "status": "completed" if internal_status == "completed" else "dispatched",
            "gateway": "soleaspay",
            "gateway_channel": "mobile",
            "gateway_intent_id": prov_ref,
            "gateway_status": status_raw.lower() or "pending",
            "dispatched_at": now, "dispatched_by": "auto:soleaspay",
        }},
    )
    if internal_status != "failed":
        await db.users.update_one(
            {"id": wd["user_id"]},
            {"$inc": {"total_withdrawn": float(wd.get("amount") or 0)}},
        )
    return {"auto_dispatched": True, "gateway_intent_id": prov_ref,
            "gateway_status": status_raw.lower() or "pending",
            "internal_status": internal_status}


def _utcnow():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)


async def apply_payout_webhook(db, payout_row: dict, event_status: str,
                                event_data: dict) -> dict:
    """Reconcile a payout from a SoleasPay WITHDRAW webhook.

    Called by server.py::soleaspay_webhook when data.operation == "WITHDRAW".
    On SUCCESS: mark withdrawal completed + push notification.
    On FAILED: refund balance_profit + mark withdrawal failed.
    """
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    wd_id = payout_row.get("wd_id")
    if not wd_id:
        return {"handled": False, "reason": "no_wd_id"}
    wd = await db.withdrawals.find_one({"id": wd_id})
    if not wd:
        return {"handled": False, "reason": "wd_not_found"}

    internal = normalize_payout_status(event_status)
    if internal == "completed":
        upd = await db.withdrawals.update_one(
            {"id": wd_id, "status": {"$ne": "completed"}},
            {"$set": {"status": "completed", "completed_at": now,
                      "gateway_status": "completed",
                      "gateway": "soleaspay"}},
        )
        await db.soleaspay_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "completed", "completed_at": now,
                      "webhook_status": event_status,
                      "webhook_data": event_data, "updated_at": now}},
        )
        if upd.modified_count > 0:
            try:
                from push_helper import push_to_user
                await push_to_user(
                    db, wd["user_id"],
                    title="✅ Retrait payé",
                    body=f"Votre retrait de {int(wd.get('net_payout') or wd.get('amount') or 0):,} FCFA a été envoyé.".replace(",", " "),
                    link="/(app)/withdrawal",
                    data={"kind": "withdrawal_completed", "wd_id": wd_id},
                )
            except Exception:
                pass
        return {"handled": True, "outcome": "completed"}
    if internal == "failed":
        already = await db.withdrawals.find_one_and_update(
            {"id": wd_id, "status": {"$nin": ["failed", "rejected", "completed"]}},
            {"$set": {"status": "failed", "failed_at": now,
                      "gateway_status": "failed", "gateway": "soleaspay"}},
            return_document=True,
        )
        await db.soleaspay_payouts.update_one(
            {"wd_id": wd_id},
            {"$set": {"status": "failed", "failed_at": now,
                      "webhook_status": event_status,
                      "webhook_data": event_data, "updated_at": now}},
        )
        if already:
            await db.users.update_one(
                {"id": wd["user_id"]},
                {"$inc": {"balance_profit": float(wd.get("amount") or 0),
                          "total_withdrawn": -float(wd.get("amount") or 0)}},
            )
        return {"handled": True, "outcome": "failed"}
    # Non-terminal update.
    await db.soleaspay_payouts.update_one(
        {"wd_id": wd_id},
        {"$set": {"webhook_status": event_status,
                  "webhook_data": event_data, "updated_at": now}},
    )
    return {"handled": True, "outcome": "pending"}
