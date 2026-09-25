"""Biz-transPay (SoftPay) integration — Integration API v1 (2026-02-24).

Documentation: https://biz-transppayy.com/integration/docs
Scope: TG / BJ / BF (XOF), Mobile Money.

Endpoints (Integration v1):
  • POST /api/integration/v1/deposits            — pay-in (Mobile Money)
  • POST /api/integration/v1/payouts             — pay-out (Mobile Money)
  • GET  /api/integration/v1/deposits/{id}       — status polling (payin)
  • GET  /api/integration/v1/payouts/{id}        — status polling (payout)
  • Webhook: HMAC-SHA256 on `timestamp + "." + raw_body`

Authentication (per new doc): TWO keys required on every request
  • Authorization: Bearer <secret_key>
  • X-Public-Key: <public_key>

Config lives in `app_settings.payment_gateway.value` under keys:
  • biztranspay_enabled       (bool)  master switch
  • biztranspay_payin_enabled (bool)  activations
  • biztranspay_payout_enabled(bool)  auto-withdrawal
  • biztranspay_public_key    (str)   Public key (pk_test_* / pk_live_*)
  • biztranspay_secret_key    (str)   Secret key (sk_test_* / sk_live_*)
  • biztranspay_webhook_secret(str)   HMAC secret
  • biztranspay_countries     (dict)  per-country per-operator toggles
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

BASE_URL = os.environ.get("BIZTRANSPAY_BASE_URL", "https://biz-transppayy.com/api/integration/v1")
HTTP_TIMEOUT = 30.0

# Operator catalog for the admin toggles + user-facing /pay.
# v27p (2026-02-20) — Codes confirmés par la doc BTP v1.0 officielle.
# Tous les opérateurs sont maintenant activés par défaut car leurs codes
# proviennent de la documentation Biz-transPay (section 4 — Opérateurs
# Mobile Money supportés).
OPERATORS: dict[str, dict] = {
    "TG": {
        "name": "Togo",
        "currency": "XOF",
        "dial": "228",
        "operators": [
            {"code": "tmoney_tg", "label": "T-Money (TogoCom)", "default_active": True},
            {"code": "moov_tg",   "label": "Moov Money",         "default_active": True},
        ],
    },
    "BJ": {
        "name": "Bénin",
        "currency": "XOF",
        "dial": "229",
        "operators": [
            {"code": "tmoney_bj",  "label": "MTN Mobile Money",  "default_active": True},
            {"code": "moov_bj",    "label": "Moov Money",         "default_active": True},
            {"code": "celtiis_bj", "label": "Celtiis Cash",       "default_active": True},
        ],
    },
    "BF": {
        "name": "Burkina Faso",
        "currency": "XOF",
        "dial": "226",
        "operators": [
            {"code": "orange_bf", "label": "Orange Money", "default_active": True},
            {"code": "moov_bf",   "label": "Moov Money",    "default_active": True},
            {"code": "coris_bf",  "label": "Coris Money",   "default_active": True},
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


async def _get_public_key(db) -> str:
    cfg = await _load_cfg(db)
    return (cfg.get("biztranspay_public_key") or "").strip() \
        or (os.environ.get("BIZTRANSPAY_PUBLIC_KEY") or "").strip()


async def _get_secret_key(db) -> str:
    cfg = await _load_cfg(db)
    # v27s (2026-02-24) — new field name is `biztranspay_secret_key`.
    # Legacy `biztranspay_api_key` is still accepted for backward-compat.
    return (cfg.get("biztranspay_secret_key") or "").strip() \
        or (cfg.get("biztranspay_api_key") or "").strip() \
        or (os.environ.get("BIZTRANSPAY_SECRET_KEY") or "").strip() \
        or (os.environ.get("BIZTRANSPAY_API_KEY") or "").strip()


# Legacy alias kept for internal callers.
async def _get_api_key(db) -> str:
    return await _get_secret_key(db)


async def _get_webhook_secret(db) -> str:
    cfg = await _load_cfg(db)
    return (cfg.get("biztranspay_webhook_secret") or "").strip() \
        or (os.environ.get("BIZTRANSPAY_WEBHOOK_SECRET") or "").strip()


async def is_enabled(db) -> bool:
    cfg = await _load_cfg(db)
    return (
        bool(cfg.get("biztranspay_enabled"))
        and bool(await _get_secret_key(db))
        and bool(await _get_public_key(db))
    )


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
async def _post(path: str, body: dict, secret_key: str, public_key: str, *, idempotency_key: str) -> httpx.Response:
    """v27s — Integration API v1 requires BOTH Bearer secret AND X-Public-Key."""
    headers = {
        "Authorization": f"Bearer {secret_key}",
        "X-Public-Key": public_key,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        return await client.post(f"{BASE_URL}{path}", json=body, headers=headers)


async def _get(path: str, secret_key: str, public_key: str) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {secret_key}",
        "X-Public-Key": public_key,
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        return await client.get(f"{BASE_URL}{path}", headers=headers)


# ─── Webhook signature ───────────────────────────────────────────────
def _verify_signature(secret: str, timestamp: str, raw_body: bytes, received: str) -> bool:
    """HMAC-SHA256 over `timestamp + "." + raw_body` per the official BTP
    v2 spec. Header format: `X-BizTransPay-Signature: sha256=<hex>`.

    v27n (2026-02-20) — fixed to include the dot separator per the PDF.
    Constant-time comparison via hmac.compare_digest.
    """
    if not secret or not received:
        return False
    try:
        body_str = raw_body.decode("utf-8", errors="replace")
        signed_payload = f"{timestamp}.{body_str}".encode("utf-8")
        expected = hmac.new(
            secret.encode("utf-8"), signed_payload, hashlib.sha256,
        ).hexdigest()
    except Exception:
        return False
    got = received.split("=", 1)[1] if "=" in received else received
    return hmac.compare_digest(expected, got)


def _timestamp_fresh(ts_header: str, max_age_seconds: int = 300) -> bool:
    """Reject webhooks whose timestamp is older than 5 minutes (replay
    protection). Accepts unix seconds (int as string)."""
    try:
        ts = int(str(ts_header).strip())
    except Exception:
        return False
    now = int(datetime.now(timezone.utc).timestamp())
    return abs(now - ts) <= max_age_seconds


# ─── Public endpoints ────────────────────────────────────────────────
class BtpActivationIn(BaseModel):
    country_code: str = Field(..., min_length=2, max_length=2)
    operator: str = Field(..., min_length=1)         # e.g. "tmoney_tg"
    phone: str = Field(..., min_length=6)


@api.post("/payments/biztranspay/activation")
async def biztranspay_activation(
    data: BtpActivationIn, request: Request, user=Depends(get_current_user),
):
    """Kick off a Level-1 activation payment via Biz-transPay Integration v1.

    v27s (2026-02-24) — migrated to Integration API v1 (/deposits) with the
    dual-key auth (Bearer secret + X-Public-Key).
    """
    db = request.app.state.db
    from ashtec_activation import (
        ACTIVATION_LEVEL, ACTIVATION_AMOUNT_BY_CURRENCY, ACTIVATION_AMOUNT,
    )
    if int(user.get("max_level") or 0) >= ACTIVATION_LEVEL:
        raise HTTPException(400, "Votre compte est déjà activé.")

    cc = data.country_code.upper()
    if cc not in OPERATORS:
        raise HTTPException(400, "Biz-transPay n'est pas disponible pour ce pays.")
    if not await is_payin_enabled(db):
        raise HTTPException(503, "Biz-transPay n'est pas disponible.")
    secret_key = await _get_secret_key(db)
    public_key = await _get_public_key(db)
    if not secret_key or not public_key:
        raise HTTPException(503, "Biz-transPay non configuré (clés publique/secrète manquantes).")

    ops = await enabled_operators(db, cc)
    op_codes = {o["code"] for o in ops}
    if data.operator not in op_codes:
        raise HTTPException(400, f"Opérateur '{data.operator}' indisponible.")

    currency = OPERATORS[cc]["currency"]
    amount = int(ACTIVATION_AMOUNT_BY_CURRENCY.get(currency, ACTIVATION_AMOUNT))

    ref = _new_ref()
    e164_phone = _normalize_phone(data.phone, cc)
    now = datetime.now(timezone.utc)

    # v27s — Integration v1 body schema (POST /deposits).
    payload = {
        "amount": amount,
        "currency": currency,
        "country": cc,
        "operator": data.operator,
        "phone_number": e164_phone,
        "email": user.get("email") or "",
        "full_name": user.get("full_name") or user.get("username") or "",
        "reference": ref,
        "fee_bearer": "sender",   # SPILOVEURE covers the gateway fee
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
        resp = await _post("/deposits", payload, secret_key, public_key, idempotency_key=ref)
    except Exception as e:
        log.exception("biztranspay /deposits call failed ref=%s: %s", ref, e)
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
        log.warning("biztranspay /deposits %s ref=%s body=%s",
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
    # v1 envelope: {"id": "...", "status": "...", "deposit": {...}}
    provider_id = data_resp.get("id") or (data_resp.get("deposit") or {}).get("id")
    provider_status = str(
        data_resp.get("status") or (data_resp.get("deposit") or {}).get("status") or "pending"
    ).lower()

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
    """Poll a payin status via GET /deposits/{id}."""
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
        secret_key = await _get_secret_key(db)
        public_key = await _get_public_key(db)
        try:
            r = await _get(f"/deposits/{intent_id}", secret_key, public_key)
            if r.status_code < 400:
                jd = r.json()
                remote = str(jd.get("status") or "").lower()
                # v1 completed states: completed / approved / paid / success
                if remote in ("paid", "completed", "approved", "success") and not p.get("activation_done"):
                    from ashtec_activation import _apply_payment_success  # reuse dispatch
                    await _apply_payment_success(db, p, "paid", source="biztranspay")
                    p = await db.payments.find_one({"reference": reference}, {"_id": 0}) or p
                elif remote in ("failed", "declined", "canceled", "expired"):
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


# ─── Payout (Integration v1 /payouts) ────────────────────────────────
async def dispatch_biztranspay_withdrawal(db, wd_doc: dict) -> dict:
    """Dispatch an auto-payout via Biz-transPay Integration v1 /payouts.

    v27s (2026-02-24) — migrated to Integration API v1:
      • Endpoint : POST /api/integration/v1/payouts
      • Body : {amount, currency, country, operator, recipient, reference, fee_bearer}
      • Auth : Authorization Bearer secret + X-Public-Key + Idempotency-Key
      • Country coverage: TG + BJ + BF (admin-toggle-gated)
    """
    if not await is_payout_enabled(db):
        return {"auto_dispatched": False, "reason": "disabled"}
    country = (wd_doc.get("country") or "").upper()
    if country not in OPERATORS:
        return {"auto_dispatched": False, "reason": "country_not_supported"}
    secret_key = await _get_secret_key(db)
    public_key = await _get_public_key(db)
    if not secret_key or not public_key:
        return {"auto_dispatched": False, "reason": "no_api_key"}

    # Operator resolution — accept a code directly OR a label ("Moov", …).
    op_label = (wd_doc.get("operator") or "").strip().lower()
    catalog = OPERATORS[country]["operators"]
    known_codes = {o["code"] for o in catalog}
    op_code = None
    if op_label in known_codes:
        op_code = op_label
    else:
        for o in catalog:
            lbl = o["label"].lower()
            code = o["code"].lower()
            if op_label and (op_label in lbl or op_label in code
                              or code.split("_")[0] in op_label):
                op_code = o["code"]; break
    if not op_code:
        return {"auto_dispatched": False, "reason": "operator_not_supported"}

    # Router-level check : is this exact (provider, country, operator)
    # actually enabled in payment_provider_operators?
    op_row = await db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "country_code": country,
         "operator_code": op_code, "status": "active"},
    )
    if not op_row:
        return {"auto_dispatched": False, "reason": "operator_disabled_by_admin"}

    net = int(wd_doc.get("net_payout") or wd_doc.get("amount") or 0)
    phone = _normalize_phone(wd_doc.get("phone") or "", country)
    body = {
        "amount": net,
        "currency": OPERATORS[country]["currency"],
        "country": country,
        "operator": op_code,
        "recipient": phone,
        "reference": wd_doc["id"],
        "fee_bearer": "sender",
    }

    try:
        r = await _post("/payouts", body, secret_key, public_key,
                        idempotency_key=f"wd-{wd_doc['id']}")
    except Exception as e:
        log.exception("biztranspay /payouts failed wd=%s: %s", wd_doc["id"], e)
        return {"auto_dispatched": False, "reason": "network_error"}

    if r.status_code >= 400:
        detail = ""
        try:
            jd = r.json()
            detail = str(jd)[:400]
            code = str(jd.get("code") or "")
        except Exception:
            detail = r.text[:400]
            code = ""
        log.warning("biztranspay /payouts %s wd=%s code=%s body=%s",
                    r.status_code, wd_doc["id"], code, detail)
        await db.withdrawals.update_one(
            {"id": wd_doc["id"]},
            {"$set": {"gateway_error": detail[:400],
                      "gateway_error_code": code,
                      "gateway_status_code": r.status_code,
                      "updated_at": datetime.now(timezone.utc)}},
        )
        return {"auto_dispatched": False, "reason": "gateway_error",
                "detail": detail, "code": code}

    resp_json = {}
    try:
        resp_json = r.json()
    except Exception:
        pass
    # v1 envelope: {"id": "...", "status": "...", "payout": {...}}
    payout_env = resp_json.get("payout") or {}
    payout_id = resp_json.get("id") or (payout_env.get("transaction") or {}).get("id")
    payout_status = str(resp_json.get("status") or (payout_env.get("transaction") or {}).get("status") or "").lower()

    await db.withdrawals.update_one(
        {"id": wd_doc["id"]},
        {"$set": {
            "status": "dispatched",
            "gateway": "biztranspay",
            "payout_id": payout_id,
            "gateway_status": payout_status,
            "gateway_fee": payout_env.get("fee"),
            "gateway_total_debit": payout_env.get("total_debit"),
            "dispatched_at": datetime.now(timezone.utc),
        }},
    )
    return {"auto_dispatched": True, "id": payout_id, "status": payout_status}


# ─── Webhook ─────────────────────────────────────────────────────────
@webhook.post("/biztranspay")
async def biztranspay_webhook(request: Request):
    """Receive payment/payout events from Biz-transPay (Developer v2 spec).

    Security (per official doc):
      • `X-BizTransPay-Signature: sha256=<hex>` — HMAC of `ts + "." + body`.
      • `X-BizTransPay-Timestamp: <unix_seconds>` — reject if older than 5 min.
      • `X-BizTransPay-Event-Id: evt_...` — dedup: reject on 2nd delivery.
      • `X-BizTransPay-Event-Type: payment.completed | mobile_money.payment.approved | push.succeeded | ...`

    Supported event types (real names from the doc):
      • payment.completed, mobile_money.payment.approved   → treat as PAID
      • payment.failed,    mobile_money.payment.declined,
        mobile_money.payment.canceled                       → treat as FAILED
      • push.succeeded                                      → payout completed
      • push.failed                                         → payout failed
    """
    db = request.app.state.db
    raw = await request.body()
    sig = request.headers.get("X-BizTransPay-Signature") or request.headers.get("x-biztranspay-signature") or ""
    ts = request.headers.get("X-BizTransPay-Timestamp") or request.headers.get("x-biztranspay-timestamp") or ""
    event_id = request.headers.get("X-BizTransPay-Event-Id") or request.headers.get("x-biztranspay-event-id") or ""
    event_type_hdr = request.headers.get("X-BizTransPay-Event-Type") or request.headers.get("x-biztranspay-event-type") or ""

    secret = await _get_webhook_secret(db)
    if secret:
        if not _timestamp_fresh(ts):
            log.warning("biztranspay webhook: stale timestamp ts=%s", ts)
            raise HTTPException(400, "Stale webhook timestamp")
        if not _verify_signature(secret, ts, raw, sig):
            log.warning("biztranspay webhook: bad signature ts=%s len=%s", ts, len(raw))
            raise HTTPException(401, "Invalid webhook signature")

    # v27n — Event-Id deduplication. A same event delivered twice must NOT
    # trigger a second activation. Best-effort unique index.
    if event_id:
        try:
            await db.biztranspay_webhook_events.create_index("event_id", unique=True)
            await db.biztranspay_webhook_events.insert_one({
                "event_id": event_id,
                "event_type": event_type_hdr,
                "received_at": datetime.now(timezone.utc),
            })
        except Exception:
            # Duplicate delivery — acknowledge without re-processing.
            log.info("biztranspay webhook: duplicate event_id=%s ignored", event_id)
            return {"ok": True, "duplicate": True}

    try:
        body = await request.json()
    except Exception:
        body = {}

    await db.webhook_logs.insert_one({
        "gateway": "biztranspay",
        "event_id": event_id,
        "event_type": event_type_hdr or body.get("type") or body.get("event") or "unknown",
        "signed_ok": bool(secret),
        "payload": body,
        "received_at": datetime.now(timezone.utc),
    })

    # Payload shape (per doc): {id: evt_..., type, data: {id, reference, status, ...}}
    data_obj = body.get("data") or {}
    ref = body.get("reference") or data_obj.get("reference")
    provider_id = body.get("id") or data_obj.get("id")
    status_raw = str(body.get("status") or data_obj.get("status") or "").lower()
    event = (event_type_hdr or str(body.get("type") or body.get("event") or "")).lower()

    # v27n — Map official event types to internal PAID / FAILED buckets.
    PAID_EVENTS = {"payment.completed", "mobile_money.payment.approved", "push.succeeded"}
    FAIL_EVENTS = {"payment.failed", "payment.expired",
                   "mobile_money.payment.declined", "mobile_money.payment.canceled",
                   "push.failed"}
    if event in PAID_EVENTS or status_raw in ("paid", "completed", "approved", "succeeded"):
        internal_status = "paid"
    elif event in FAIL_EVENTS or status_raw in ("failed", "declined", "canceled", "expired"):
        internal_status = "failed"
    else:
        internal_status = "pending"

    # Locate our payment
    query: dict = {"provider": "biztranspay"}
    if ref:
        query["reference"] = ref
    elif provider_id:
        query["provider_intent_id"] = provider_id
    else:
        return {"ok": True, "ignored": "no_reference"}

    p = await db.payments.find_one(query, {"_id": 0})
    # Also try to reconcile a payout (withdrawal) by reference or payout_id
    if not p:
        wd_q = {"id": ref} if ref else {"payout_id": provider_id}
        wd = await db.withdrawals.find_one(wd_q)
        if wd:
            update = {"gateway_status": status_raw or event,
                      "updated_at": datetime.now(timezone.utc)}
            if internal_status == "paid":
                update["status"] = "completed"
                update["completed_at"] = datetime.now(timezone.utc)
            elif internal_status == "failed":
                update["status"] = "rejected"
                try:
                    await db.users.update_one(
                        {"id": wd["user_id"]},
                        {"$inc": {"balance_profit": float(wd.get("amount") or 0)}},
                    )
                except Exception:
                    pass
            await db.withdrawals.update_one({"id": wd["id"]}, {"$set": update})
            return {"ok": True, "reconciled": "withdrawal", "status": internal_status}
        return {"ok": True, "ignored": "unknown_payment"}

    if internal_status == "paid" and not p.get("activation_done"):
        try:
            from ashtec_activation import _apply_payment_success
            await _apply_payment_success(db, p, "paid", source="biztranspay")
        except Exception as e:
            log.exception("biztranspay webhook activation failed ref=%s: %s", ref, e)
            await db.payments.update_one(
                {"reference": p["reference"]},
                {"$set": {"activation_error": str(e)[:400],
                          "updated_at": datetime.now(timezone.utc)}},
            )
    elif internal_status == "failed":
        await db.payments.update_one(
            {"reference": p["reference"]},
            {"$set": {"status": "failed", "biztranspay_status": status_raw or event,
                      "updated_at": datetime.now(timezone.utc)}},
        )
    return {"ok": True, "status": internal_status}


def register(app):
    """Mount routers on the FastAPI app."""
    app.include_router(api)
    app.include_router(webhook)


# ═══════════════════════════════════════════════════════════════════════
# v27m (Phase 5) — Server-side polling worker
# ═══════════════════════════════════════════════════════════════════════
async def _poll_once(db) -> dict:
    """One sweep: look up pending Biz-transPay activations (< 10 min old),
    ask BTP for their current status, activate on `paid/completed`, mark
    `failed` on failure, expire past 10 min.

    v27s (2026-02-24) — migrated to Integration API v1: GET /deposits/{id}.
    """
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    ten_min_ago = now - timedelta(minutes=10)

    checked = activated = failed = expired = 0
    secret_key = await _get_secret_key(db)
    public_key = await _get_public_key(db)
    if not secret_key or not public_key:
        return {"checked": 0, "skipped": "no_api_key"}

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
            r = await _get(f"/deposits/{intent_id}", secret_key, public_key)
            if r.status_code >= 400:
                continue
            jd = r.json()
        except Exception as e:
            log.debug("btp poll error ref=%s: %s", p.get("reference"), e)
            continue
        remote = str(jd.get("status") or "").lower()
        # v1: only completed/approved/paid/success are terminal success states.
        if remote in ("paid", "completed", "approved", "success"):
            try:
                from ashtec_activation import _apply_payment_success
                await _apply_payment_success(db, p, "paid", source="biztranspay")
                activated += 1
            except Exception as e:
                log.exception("btp poll activation failed ref=%s: %s", p.get("reference"), e)
        elif remote in ("failed", "declined", "canceled", "expired"):
            await db.payments.update_one(
                {"reference": p["reference"]},
                {"$set": {"status": "failed", "biztranspay_status": remote,
                          "updated_at": now}},
            )
            failed += 1

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
