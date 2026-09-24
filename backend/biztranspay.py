"""Biz-transPay (SoftPay) integration — direct payin + BizPUSH payout.

Documentation: /app/customer_docs/Biz-transPay.pdf
Scope: Togo only (XOF), operators: T-Money (`tmoney_tg`) + Moov Flooz (`flooz_tg`).

Endpoints:
  • POST /api/v1/direct-payments        — PSR/SoftPay pay-in
  • POST /api/v1/push                   — BizPUSH pay-out
  • GET  /api/v1/payments/{id}/status   — status polling (payin)
  • GET  /api/v1/push/{id}/status       — status polling (payout)
  • Webhook: signed via HMAC-SHA256 on `timestamp + raw_body`

Config lives in `app_settings.payment_gateway.value` under keys:
  • biztranspay_enabled       (bool)  master switch
  • biztranspay_payin_enabled (bool)  activations
  • biztranspay_payout_enabled(bool)  auto-withdrawal
  • biztranspay_api_key       (str)   Bearer key (sk_test_* / sk_live_*)
  • biztranspay_webhook_secret(str)   HMAC secret
  • biztranspay_countries     (dict)  { "TG": { "tmoney_tg": True, "flooz_tg": True } }
"""
from __future__ import annotations
import hashlib
import hmac
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin  # type: ignore

log = logging.getLogger("biztranspay")

api = APIRouter(prefix="/api", tags=["biztranspay"])
webhook = APIRouter(prefix="/api/webhooks", tags=["biztranspay-webhook"])

BASE_URL = os.environ.get("BIZTRANSPAY_BASE_URL", "https://biz-transppayy.com/api/v1")
HTTP_TIMEOUT = 30.0

# Operator catalog for the admin toggles + user-facing /pay.
# Only Togo is supported per product spec 2026-02-20.
OPERATORS: dict[str, dict] = {
    "TG": {
        "name": "Togo",
        "currency": "XOF",
        "dial": "228",
        "operators": [
            {"code": "tmoney_tg", "label": "T-Money"},
            {"code": "flooz_tg",  "label": "Flooz (Moov)"},
        ],
    },
}


def _new_ref() -> str:
    return f"SPV-BTP-{uuid.uuid4().hex[:12].upper()}"


def _normalize_phone(phone: str, country_code: str) -> str:
    """Return a bare digits phone (Biz-transPay expects `22890000000` — no +)."""
    p = (phone or "").strip().replace(" ", "").replace("-", "").replace(".", "").replace("+", "")
    if not p:
        return p
    dial = OPERATORS.get((country_code or "").upper(), {}).get("dial", "")
    if dial and not p.startswith(dial):
        # Strip a leading zero (local convention "0-91-xx-xx-xx")
        if p.startswith("0"):
            p = p.lstrip("0")
        p = dial + p
    return p


# ─── Config helpers ──────────────────────────────────────────────────
async def _load_cfg(db) -> dict:
    doc = await db.app_settings.find_one({"key": "payment_gateway"}) or {}
    val = (doc.get("value") if isinstance(doc.get("value"), dict) else {}) or {}
    return val


async def _get_api_key(db) -> str:
    cfg = await _load_cfg(db)
    return (cfg.get("biztranspay_api_key") or "").strip() \
        or (os.environ.get("BIZTRANSPAY_API_KEY") or "").strip()


async def _get_webhook_secret(db) -> str:
    cfg = await _load_cfg(db)
    return (cfg.get("biztranspay_webhook_secret") or "").strip() \
        or (os.environ.get("BIZTRANSPAY_WEBHOOK_SECRET") or "").strip()


async def is_enabled(db) -> bool:
    cfg = await _load_cfg(db)
    return bool(cfg.get("biztranspay_enabled")) and bool(await _get_api_key(db))


async def is_payin_enabled(db) -> bool:
    if not await is_enabled(db):
        return False
    cfg = await _load_cfg(db)
    # Default True when the master switch is on (backward-compat)
    v = cfg.get("biztranspay_payin_enabled")
    return True if v is None else bool(v)


async def is_payout_enabled(db) -> bool:
    if not await is_enabled(db):
        return False
    cfg = await _load_cfg(db)
    return bool(cfg.get("biztranspay_payout_enabled"))


async def enabled_operators(db, country_code: str) -> list[dict]:
    """Return the list of operators enabled by the admin for a country."""
    cc = (country_code or "").upper()
    info = OPERATORS.get(cc)
    if not info:
        return []
    cfg = await _load_cfg(db)
    country_toggles = ((cfg.get("biztranspay_countries") or {}).get(cc)) or {}
    out = []
    for op in info["operators"]:
        # Default True — admin has to explicitly disable an operator
        if country_toggles.get(op["code"], True):
            out.append(op)
    return out


# ─── HTTP client ─────────────────────────────────────────────────────
async def _post(path: str, body: dict, api_key: str, *, idempotency_key: str) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        return await client.post(f"{BASE_URL}{path}", json=body, headers=headers)


async def _get(path: str, api_key: str) -> httpx.Response:
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        return await client.get(f"{BASE_URL}{path}", headers=headers)


# ─── Webhook signature ───────────────────────────────────────────────
def _verify_signature(secret: str, timestamp: str, raw_body: bytes, received: str) -> bool:
    """HMAC-SHA256 over `timestamp + raw_body`. Header format `sha256=<hex>`."""
    if not secret or not received:
        return False
    try:
        expected = hmac.new(
            secret.encode("utf-8"),
            (timestamp + raw_body.decode("utf-8", errors="replace")).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    except Exception:
        return False
    got = received.split("=", 1)[1] if "=" in received else received
    return hmac.compare_digest(expected, got)


# ─── Public endpoints ────────────────────────────────────────────────
class BtpActivationIn(BaseModel):
    country_code: str = Field(..., min_length=2, max_length=2)
    operator: str = Field(..., min_length=1)         # e.g. "tmoney_tg"
    phone: str = Field(..., min_length=6)


@api.post("/payments/biztranspay/activation")
async def biztranspay_activation(
    data: BtpActivationIn, request: Request, user=Depends(get_current_user),
):
    """Kick off a Level-1 activation payment via Biz-transPay SoftPay.

    Mirrors `ashtec_initiate` — same 2 650 FCFA amount, same activation
    downstream via `_apply_payment_success`.
    """
    db = request.app.state.db
    from ashtec_activation import (
        ACTIVATION_LEVEL, ACTIVATION_AMOUNT_BY_CURRENCY, ACTIVATION_AMOUNT,
    )
    if int(user.get("max_level") or 0) >= ACTIVATION_LEVEL:
        raise HTTPException(400, "Votre compte est déjà activé.")

    cc = data.country_code.upper()
    if cc != "TG":
        raise HTTPException(400, "Biz-transPay est disponible uniquement pour le Togo.")
    if not await is_payin_enabled(db):
        raise HTTPException(503, "Biz-transPay n'est pas disponible.")
    api_key = await _get_api_key(db)
    if not api_key:
        raise HTTPException(503, "Biz-transPay non configuré (clé API manquante).")

    ops = await enabled_operators(db, cc)
    op_codes = {o["code"] for o in ops}
    if data.operator not in op_codes:
        raise HTTPException(400, f"Opérateur '{data.operator}' indisponible.")

    currency = OPERATORS[cc]["currency"]
    amount = int(ACTIVATION_AMOUNT_BY_CURRENCY.get(currency, ACTIVATION_AMOUNT))

    ref = _new_ref()
    e164_phone = _normalize_phone(data.phone, cc)
    now = datetime.now(timezone.utc)

    payload = {
        "amount": amount,
        "currency": currency,
        "country": cc,
        "operator": data.operator,
        "customer_phone": e164_phone,
        "customer_email": user.get("email") or "",
        "reference": ref,
    }

    # Persist BEFORE the API call so a webhook cannot arrive on an unknown ref.
    await db.payments.insert_one({
        "reference": ref,
        "provider": "biztranspay",
        "kind": "activation",
        "user_id": user["id"],
        "username": user.get("username"),
        "amount": amount,
        "currency": currency,
        "phone": e164_phone,
        "phone_original": data.phone.strip(),
        "country_code": cc,
        "operator": data.operator,
        "level": ACTIVATION_LEVEL,
        "status": "pending",
        "activation_done": False,
        "created_at": now,
        "updated_at": now,
    })

    try:
        resp = await _post("/direct-payments", payload, api_key, idempotency_key=ref)
    except Exception as e:
        log.exception("biztranspay direct-payments call failed ref=%s: %s", ref, e)
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "failed", "activation_error": str(e)[:400],
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(502, "Impossible de contacter Biz-transPay. Réessayez.")

    if resp.status_code >= 400:
        detail = ""
        try:
            detail = str(resp.json())[:400]
        except Exception:
            detail = resp.text[:400]
        log.warning("biztranspay direct-payments %s ref=%s body=%s",
                    resp.status_code, ref, detail)
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "failed",
                      "biztranspay_status_code": resp.status_code,
                      "activation_error": detail,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(400, "Biz-transPay a refusé le paiement.")

    data_resp = {}
    try:
        data_resp = resp.json()
    except Exception:
        pass
    provider_id = data_resp.get("id")
    provider_status = str(data_resp.get("status") or "pending").lower()

    await db.payments.update_one(
        {"reference": ref},
        {"$set": {
            "provider_intent_id": provider_id,
            "biztranspay_status": provider_status,
            "updated_at": datetime.now(timezone.utc),
        }},
    )

    return {
        "reference": ref,
        "status": provider_status,
        "amount": amount,
        "currency": currency,
        "operator": data.operator,
        "country_code": cc,
        "provider": "biztranspay",
        "message": "Confirmez le paiement sur votre téléphone.",
    }


@api.get("/payments/biztranspay/status/{reference}")
async def biztranspay_status(reference: str, request: Request, user=Depends(get_current_user)):
    """Poll a payin status. Also triggers `_apply_payment_success` if paid."""
    db = request.app.state.db
    p = await db.payments.find_one({"reference": reference, "provider": "biztranspay"}, {"_id": 0})
    if not p or p.get("user_id") != user.get("id"):
        raise HTTPException(404, "Paiement introuvable.")
    if p.get("status") in ("paid", "failed"):
        return {"status": p["status"], "reference": reference,
                "activation_done": bool(p.get("activation_done")),
                "activation_error": p.get("activation_error")}

    intent_id = p.get("provider_intent_id")
    if intent_id:
        api_key = await _get_api_key(db)
        try:
            r = await _get(f"/payments/{intent_id}/status", api_key)
            if r.status_code < 400:
                jd = r.json()
                remote = str(jd.get("status") or "").lower()
                if remote == "paid" and not p.get("activation_done"):
                    from ashtec_activation import _apply_payment_success  # reuse dispatch
                    await _apply_payment_success(db, p, remote, source="biztranspay")
                    p = await db.payments.find_one({"reference": reference}, {"_id": 0}) or p
                elif remote == "failed":
                    await db.payments.update_one(
                        {"reference": reference},
                        {"$set": {"status": "failed", "biztranspay_status": remote,
                                  "updated_at": datetime.now(timezone.utc)}},
                    )
                    p["status"] = "failed"
        except Exception as e:
            log.warning("biztranspay status poll error ref=%s: %s", reference, e)

    return {"status": p.get("status") or "pending",
            "reference": reference,
            "activation_done": bool(p.get("activation_done")),
            "activation_error": p.get("activation_error")}


# ─── Payout (BizPUSH) ────────────────────────────────────────────────
async def dispatch_biztranspay_withdrawal(db, wd_doc: dict) -> dict:
    """Dispatch an auto-payout via Biz-transPay BizPUSH.

    Returns {"auto_dispatched": bool, "reason"?: str, "id"?: str}
    Mirrors the SoleasPay/IziChange dispatchers.
    """
    if not await is_payout_enabled(db):
        return {"auto_dispatched": False, "reason": "disabled"}
    country = (wd_doc.get("country") or "").upper()
    if country != "TG":
        return {"auto_dispatched": False, "reason": "country_not_supported"}
    api_key = await _get_api_key(db)
    if not api_key:
        return {"auto_dispatched": False, "reason": "no_api_key"}

    # Operator matching — accept the wallet operator label OR a code.
    op_label = (wd_doc.get("operator") or "").strip().lower()
    op_code = None
    if "flooz" in op_label or "moov" in op_label:
        op_code = "flooz_tg"
    elif "t-money" in op_label or "tmoney" in op_label:
        op_code = "tmoney_tg"
    else:
        # If admin passed a code directly
        if op_label in ("tmoney_tg", "flooz_tg"):
            op_code = op_label
    if not op_code:
        return {"auto_dispatched": False, "reason": "operator_not_supported"}

    net = int(wd_doc.get("net_payout") or wd_doc.get("amount") or 0)
    phone = _normalize_phone(wd_doc.get("phone") or "", country)
    body = {
        "amount": net,
        "currency": "XOF",
        "country": country,
        "operator": op_code,
        "beneficiary_phone": phone,
        "beneficiary_name": wd_doc.get("full_name") or wd_doc.get("username") or "SPILOVEURE",
        "reference": wd_doc["id"],
    }

    try:
        r = await _post("/push", body, api_key, idempotency_key=f"wd-{wd_doc['id']}")
    except Exception as e:
        log.exception("biztranspay push failed wd=%s: %s", wd_doc["id"], e)
        return {"auto_dispatched": False, "reason": "network_error"}

    if r.status_code >= 400:
        detail = ""
        try:
            detail = str(r.json())[:400]
        except Exception:
            detail = r.text[:400]
        log.warning("biztranspay push %s wd=%s body=%s", r.status_code, wd_doc["id"], detail)
        await db.withdrawals.update_one(
            {"id": wd_doc["id"]},
            {"$set": {"gateway_error": detail[:400],
                      "gateway_status_code": r.status_code,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"auto_dispatched": False, "reason": "gateway_error", "detail": detail}

    resp_json = {}
    try:
        resp_json = r.json()
    except Exception:
        pass

    await db.withdrawals.update_one(
        {"id": wd_doc["id"]},
        {"$set": {
            "status": "dispatched",
            "gateway": "biztranspay",
            "payout_id": resp_json.get("id"),
            "gateway_status": str(resp_json.get("status") or "").lower(),
            "dispatched_at": datetime.now(timezone.utc),
        }},
    )
    return {"auto_dispatched": True, "id": resp_json.get("id"),
            "status": resp_json.get("status")}


# ─── Webhook ─────────────────────────────────────────────────────────
@webhook.post("/biztranspay")
async def biztranspay_webhook(request: Request):
    """Receive payment status changes from Biz-transPay.

    Headers:
      • X-BizTransPay-Signature   sha256=<hex>
      • X-BizTransPay-Timestamp   unix ts or ISO
    """
    db = request.app.state.db
    raw = await request.body()
    sig = request.headers.get("X-BizTransPay-Signature") or request.headers.get("x-biztranspay-signature") or ""
    ts = request.headers.get("X-BizTransPay-Timestamp") or request.headers.get("x-biztranspay-timestamp") or ""

    secret = await _get_webhook_secret(db)
    if secret:
        if not _verify_signature(secret, ts, raw, sig):
            log.warning("biztranspay webhook: bad signature ts=%s len=%s", ts, len(raw))
            raise HTTPException(401, "Invalid webhook signature")

    try:
        body = await request.json()
    except Exception:
        body = {}

    await db.webhook_logs.insert_one({
        "gateway": "biztranspay",
        "event_type": body.get("event") or "unknown",
        "signed_ok": bool(secret),
        "payload": body,
        "received_at": datetime.now(timezone.utc),
    })

    # Payload shape guess (docs light): { id, reference, status: paid|failed|pending, event: "payment.completed"|... }
    ref = body.get("reference") or (body.get("data") or {}).get("reference")
    provider_id = body.get("id") or (body.get("data") or {}).get("id")
    status_raw = str(body.get("status") or (body.get("data") or {}).get("status") or "").lower()
    event = str(body.get("event") or "").lower()

    # Locate our payment
    query: dict = {"provider": "biztranspay"}
    if ref:
        query["reference"] = ref
    elif provider_id:
        query["provider_intent_id"] = provider_id
    else:
        return {"ok": True, "ignored": "no_reference"}

    p = await db.payments.find_one(query, {"_id": 0})
    # Also try to reconcile a payout (withdrawal) by reference
    if not p:
        wd = await db.withdrawals.find_one({"id": ref} if ref else {"payout_id": provider_id})
        if wd:
            new_status = None
            if status_raw == "paid" or event in ("push.completed", "payout.completed"):
                new_status = "completed"
            elif status_raw == "failed" or event in ("push.failed", "payout.failed"):
                new_status = "rejected"
            if new_status:
                update = {"gateway_status": status_raw or event,
                          "updated_at": datetime.now(timezone.utc)}
                if new_status == "completed":
                    update["status"] = "completed"
                    update["completed_at"] = datetime.now(timezone.utc)
                elif new_status == "rejected":
                    update["status"] = "rejected"
                    # Refund the balance
                    try:
                        await db.users.update_one(
                            {"id": wd["user_id"]},
                            {"$inc": {"balance_profit": float(wd.get("amount") or 0)}},
                        )
                    except Exception:
                        pass
                await db.withdrawals.update_one({"id": wd["id"]}, {"$set": update})
            return {"ok": True, "reconciled": "withdrawal"}
        return {"ok": True, "ignored": "unknown_payment"}

    if status_raw == "paid" and not p.get("activation_done"):
        try:
            from ashtec_activation import _apply_payment_success
            await _apply_payment_success(db, p, status_raw, source="biztranspay")
        except Exception as e:
            log.exception("biztranspay webhook activation failed ref=%s: %s", ref, e)
            await db.payments.update_one(
                {"reference": p["reference"]},
                {"$set": {"activation_error": str(e)[:400],
                          "updated_at": datetime.now(timezone.utc)}},
            )
    elif status_raw == "failed":
        await db.payments.update_one(
            {"reference": p["reference"]},
            {"$set": {"status": "failed", "biztranspay_status": status_raw,
                      "updated_at": datetime.now(timezone.utc)}},
        )
    return {"ok": True}


def register(app):
    """Mount routers on the FastAPI app."""
    app.include_router(api)
    app.include_router(webhook)


# ═══════════════════════════════════════════════════════════════════════
# v27m (Phase 5) — Server-side polling worker
# ═══════════════════════════════════════════════════════════════════════
async def _poll_once(db) -> dict:
    """One sweep: look up pending Biz-transPay activations (< 10 min old),
    ask BTP for their current status, activate on `paid`, mark `failed` on
    `failed`, expire past 10 min.
    """
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    ten_min_ago = now - timedelta(minutes=10)

    checked = activated = failed = expired = 0
    api_key = await _get_api_key(db)
    if not api_key:
        return {"checked": 0, "skipped": "no_api_key"}

    # 1. Poll pending payments still within the 10-min window.
    cursor = db.payments.find({
        "provider": "biztranspay",
        "status": {"$in": ["pending", "processing"]},
        "activation_done": {"$ne": True},
        "created_at": {"$gte": ten_min_ago},
    })
    async for p in cursor:
        checked += 1
        intent_id = p.get("provider_intent_id")
        if not intent_id:
            continue
        try:
            r = await _get(f"/payments/{intent_id}/status", api_key)
            if r.status_code >= 400:
                continue
            jd = r.json()
        except Exception as e:
            log.debug("btp poll error ref=%s: %s", p.get("reference"), e)
            continue
        remote = str(jd.get("status") or "").lower()
        if remote == "paid":
            # Idempotent activation via the shared _apply_payment_success.
            try:
                from ashtec_activation import _apply_payment_success
                await _apply_payment_success(db, p, remote, source="biztranspay")
                activated += 1
            except Exception as e:
                log.exception("btp poll activation failed ref=%s: %s", p.get("reference"), e)
        elif remote == "failed":
            await db.payments.update_one(
                {"reference": p["reference"]},
                {"$set": {"status": "failed", "biztranspay_status": remote,
                          "updated_at": now}},
            )
            failed += 1

    # 2. Expire anything older than 10 min still pending.
    exp = await db.payments.update_many(
        {"provider": "biztranspay",
         "status": {"$in": ["pending", "processing"]},
         "activation_done": {"$ne": True},
         "created_at": {"$lt": ten_min_ago}},
        {"$set": {"status": "expired", "expired_at": now, "updated_at": now,
                  "rejected_reason": "timeout_10min"}},
    )
    expired = exp.modified_count
    return {"checked": checked, "activated": activated,
            "failed": failed, "expired": expired}


async def polling_loop(db):
    """Background task: sweeps every 4 seconds. Started from server.lifespan."""
    import asyncio as _a
    while True:
        try:
            r = await _poll_once(db)
            if r.get("activated") or r.get("failed") or r.get("expired"):
                log.info("btp polling: %s", r)
        except Exception as e:
            log.exception("btp polling loop error: %s", e)
        await _a.sleep(4)
