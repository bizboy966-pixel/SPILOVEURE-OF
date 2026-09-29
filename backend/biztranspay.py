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
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin  # type: ignore

log = logging.getLogger("biztranspay")


# R3 (2026-03-04) — defense-in-depth: redact anything that looks like a
# Biz-transPay secret or a Bearer token before it hits the log/error store.
# Applied on gateway response bodies, HTTP text, and exception messages so
# a misbehaving provider echoing our own header cannot leak the key.
_REDACT_PATTERNS = [
    re.compile(r"sk_(?:test|live)_[A-Za-z0-9_\-]{4,}"),
    re.compile(r"whsec_[A-Za-z0-9_\-]{4,}"),
    re.compile(r"(?i)Bearer\s+[A-Za-z0-9._\-]{6,}"),
    re.compile(r"(?i)\"?(?:authorization|x-public-key|api[_-]?key|secret[_-]?key|webhook[_-]?secret)\"?\s*[:=]\s*\"?[^\"\s,}]+"),
]


def _redact(s) -> str:
    """Return `s` as a str with sensitive tokens replaced by ***REDACTED***.
    Public keys (pk_*) are intentionally NOT redacted — they are, by design,
    safe to expose (like Stripe pk_*)."""
    try:
        out = str(s) if not isinstance(s, str) else s
    except Exception:
        return "<unloggable>"
    for pat in _REDACT_PATTERNS:
        out = pat.sub("***REDACTED***", out)
    return out

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
            # v27z (2026-03-04) — rebrand awareness.
            # T-Money (TogoCom) est désormais commercialisé sous "Mixx By Yas"
            # au Togo (Togocom fait partie du groupe Yas). Moov Money est en
            # cours de rebrand global mais reste "Moov Money" au Togo.
            {"code": "tmoney_tg", "label": "Mixx By Yas (T-Money)",
             "default_active": True,
             "aliases": ["t-money", "tmoney", "togocom",
                         "mixx", "mixx by yas", "mixx yas", "yas",
                         "yas t-money", "yas tmoney"]},
            {"code": "moov_tg",   "label": "Moov Money (Flooz)",
             "default_active": True,
             "aliases": ["moov", "moov money", "flooz", "moov africa"]},
        ],
    },
    "BJ": {
        "name": "Bénin",
        "currency": "XOF",
        "dial": "229",
        "operators": [
            {"code": "tmoney_bj",  "label": "MTN Mobile Money",
             "default_active": True,
             "aliases": ["mtn", "mtn momo", "momo", "tmoney bj"]},
            {"code": "moov_bj",    "label": "Moov Money (Flooz)",
             "default_active": True,
             "aliases": ["moov", "moov money", "flooz", "moov africa"]},
            {"code": "celtiis_bj", "label": "Celtiis Cash",
             "default_active": True,
             "aliases": ["celtiis", "celtiis cash"]},
        ],
    },
    "BF": {
        "name": "Burkina Faso",
        "currency": "XOF",
        "dial": "226",
        "operators": [
            {"code": "orange_bf", "label": "Orange Money",
             "default_active": True,
             "aliases": ["orange", "orange money", "om"]},
            {"code": "moov_bf",   "label": "Moov Money",
             "default_active": True,
             "aliases": ["moov", "moov money", "moov africa"]},
            {"code": "coris_bf",  "label": "Coris Money",
             "default_active": True,
             "aliases": ["coris", "coris money", "coris bank"]},
        ],
    },
}


def _resolve_operator_code(country: str, raw_label: str) -> Optional[str]:
    """v27z — robust operator resolution.

    Accepts (in order):
      1. exact `operator_code` match (e.g. "moov_tg")
      2. `label` case-insensitive contains match
      3. any registered `alias` — the alias matches if the normalized label
         either equals or contains the alias (so "Mixx By Yas" and "yas"
         both resolve to `moov_tg` on TG).

    Returns the canonical `operator_code` or None if nothing matches.
    """
    cc = (country or "").upper()
    if cc not in OPERATORS:
        return None
    catalog = OPERATORS[cc]["operators"]
    if not raw_label:
        return None
    norm = " ".join(str(raw_label).strip().lower().split())
    # 1) code exact
    for o in catalog:
        if norm == o["code"].lower():
            return o["code"]
    # 2) label contains
    for o in catalog:
        lbl = o["label"].lower()
        if norm == lbl or norm in lbl or lbl in norm:
            return o["code"]
    # 3) alias match
    for o in catalog:
        for alias in o.get("aliases", []):
            a = alias.lower().strip()
            if not a:
                continue
            if norm == a or a in norm or norm in a:
                return o["code"]
    return None


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
        log.exception("biztranspay /deposits call failed ref=%s: %s", ref, _redact(e))
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "failed", "activation_error": _redact(str(e)[:400]),
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(502, "Impossible de contacter Biz-transPay. Réessayez.")

    if resp.status_code >= 400:
        detail = ""
        try:
            detail = str(resp.json())[:400]
        except Exception:
            detail = resp.text[:400]
        detail = _redact(detail)
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
async def _persist_dispatch_failure(db, wd_id: str, reason: str, detail: str = "") -> None:
    """v27z — every early-abort in the dispatcher now leaves a trace on the
    withdrawals doc so admins can see WHY the retrait didn't auto-dispatch
    instead of it silently staying `pending`."""
    try:
        await db.withdrawals.update_one(
            {"id": wd_id},
            {"$set": {
                "gateway": "biztranspay",
                "auto_dispatched": False,
                "gateway_error_code": reason,
                "gateway_error": detail or reason,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
    except Exception:
        pass


async def dispatch_biztranspay_withdrawal(db, wd_doc: dict) -> dict:
    """Dispatch an auto-payout via Biz-transPay Integration v1 /payouts.

    v27s (2026-02-24) — migrated to Integration API v1:
      • Endpoint : POST /api/integration/v1/payouts
      • Body : {amount, currency, country, operator, recipient, reference, fee_bearer}
      • Auth : Authorization Bearer secret + X-Public-Key + Idempotency-Key
      • Country coverage: TG + BJ + BF (admin-toggle-gated)

    v27z (2026-03-04) — persist `gateway_error*` on every early abort so
    unresolved rebrands ("Mixx By Yas", "Yas Togo", …) surface immediately
    in the admin panel instead of silently leaving the retrait pending.
    """
    wd_id = wd_doc.get("id") or ""
    if not await is_payout_enabled(db):
        await _persist_dispatch_failure(db, wd_id, "disabled",
                                        "Auto-payout Biz-transPay désactivé (clés manquantes ou switch OFF).")
        return {"auto_dispatched": False, "reason": "disabled"}
    country = (wd_doc.get("country") or "").upper()
    if country not in OPERATORS:
        await _persist_dispatch_failure(db, wd_id, "country_not_supported",
                                        f"Pays {country} non supporté par Biz-transPay.")
        return {"auto_dispatched": False, "reason": "country_not_supported"}
    secret_key = await _get_secret_key(db)
    public_key = await _get_public_key(db)
    if not secret_key or not public_key:
        await _persist_dispatch_failure(db, wd_id, "no_api_key",
                                        "Clés Biz-transPay manquantes.")
        return {"auto_dispatched": False, "reason": "no_api_key"}

    # v27z — Operator resolution with alias support (handles "Mixx By Yas"
    # rebrand of Moov Money across TG/BJ/BF).
    raw_op = (wd_doc.get("operator") or "").strip()
    op_code = _resolve_operator_code(country, raw_op)
    if not op_code:
        await _persist_dispatch_failure(
            db, wd_id, "operator_not_supported",
            f"Opérateur '{raw_op}' non reconnu pour {country}. "
            f"Codes acceptés : {', '.join(o['code'] for o in OPERATORS[country]['operators'])}.",
        )
        return {"auto_dispatched": False, "reason": "operator_not_supported",
                "operator_raw": raw_op}

    # Router-level check : is this exact (provider, country, operator)
    # actually enabled in payment_provider_operators?
    op_row = await db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "country_code": country,
         "operator_code": op_code, "status": "active"},
    )
    if not op_row:
        await _persist_dispatch_failure(
            db, wd_id, "operator_disabled_by_admin",
            f"L'opérateur {op_code} ({country}) est désactivé côté admin BTP.",
        )
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
        log.exception("biztranspay /payouts failed wd=%s: %s", wd_doc["id"], _redact(e))
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
        detail = _redact(detail)
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
            # v27ad (2026-03-04) — status stays "pending" until the BTP
            # webhook confirms with push.succeeded (→ "completed") or
            # push.failed (→ "rejected" + refund). Previously we flipped to
            # "dispatched", which was invisible from all admin sub-tabs
            # (they check pending / validated | completed / rejected only).
            # `auto_dispatched=True` + `dispatched_at` + `payout_id` are
            # already enough to identify the row as an auto-payout in
            # progress.
            "status": "pending",
            "auto_dispatched": True,
            "gateway": "biztranspay",
            "payout_id": payout_id,
            "gateway_status": payout_status,
            "gateway_fee": payout_env.get("fee"),
            "gateway_total_debit": payout_env.get("total_debit"),
            "dispatched_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        },
         # Clear any prior early-abort error (retry path)
         "$unset": {"gateway_error": "", "gateway_error_code": "",
                    "gateway_status_code": ""}},
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
    PAID_EVENTS = {"payment.completed", "mobile_money.payment.approved", "push.succeeded",
                   # v27w — crypto success events
                   "crypto_deposit.success", "crypto_deposit.confirmed", "crypto_payout.success"}
    FAIL_EVENTS = {"payment.failed", "payment.expired",
                   "mobile_money.payment.declined", "mobile_money.payment.canceled",
                   "push.failed",
                   # v27w — crypto failure events
                   "crypto_deposit.failed", "crypto_payout.failed"}
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
            log.exception("biztranspay webhook activation failed ref=%s: %s", ref, _redact(e))
            await db.payments.update_one(
                {"reference": p["reference"]},
                {"$set": {"activation_error": _redact(str(e)[:400]),
                          "updated_at": datetime.now(timezone.utc)}},
            )
    elif internal_status == "failed":
        await db.payments.update_one(
            {"reference": p["reference"]},
            {"$set": {"status": "failed", "biztranspay_status": status_raw or event,
                      "updated_at": datetime.now(timezone.utc)}},
        )
    return {"ok": True, "status": internal_status}


# ═══════════════════════════════════════════════════════════════════════
# v27w (2026-02-24) — USDT.BEP20 crypto pay-in (parallel to izichange)
# ═══════════════════════════════════════════════════════════════════════
#
# Endpoints (all under /api/activations/biztranspay-crypto/*) :
#   POST /create   → creates a crypto deposit intent on BTP, returns the
#                    payment address + QR + amount (fixed 5 USDT.BEP20).
#   POST /verify   → user pastes the on-chain tx_hash; we GET the intent
#                    status; if "confirmed" → activate L1 immediately.
#
# The webhook `crypto_deposit.success` also triggers activation (see the
# webhook handler below). Both paths converge on _apply_payment_success.
#
# Nothing in this block modifies the existing Mobile Money code paths.

BTP_CRYPTO_ASSET = os.environ.get("BIZTRANSPAY_CRYPTO_ASSET", "USDT.BEP20")
BTP_CRYPTO_AMOUNT = float(os.environ.get("BIZTRANSPAY_CRYPTO_AMOUNT", "5"))


async def is_crypto_enabled(db) -> bool:
    """Master + crypto sub-toggle."""
    if not await is_enabled(db):
        return False
    cfg = await _load_cfg(db)
    return bool(cfg.get("biztranspay_crypto_enabled", True))


class BtpCryptoCreate(BaseModel):
    level: int = 1  # activation is always L1


@api.post("/activations/biztranspay-crypto/create")
async def biztranspay_crypto_create(
    _data: BtpCryptoCreate, request: Request, user=Depends(get_current_user),
):
    """Create a fresh USDT.BEP20 deposit intent on BTP for account activation.

    Mirrors izichange.create_crypto_charge, returning the same normalized
    shape so the frontend pay.tsx can reuse its existing crypto UI.
    """
    db = request.app.state.db
    from ashtec_activation import ACTIVATION_LEVEL

    if int(user.get("max_level") or 0) >= ACTIVATION_LEVEL:
        raise HTTPException(400, "Votre compte est déjà activé.")
    if not await is_crypto_enabled(db):
        raise HTTPException(503, "Biz-transPay Crypto n'est pas disponible actuellement.")

    secret_key = await _get_secret_key(db)
    public_key = await _get_public_key(db)
    if not secret_key or not public_key:
        raise HTTPException(503, "Biz-transPay non configuré (clés API manquantes).")

    # Dedupe : reuse a fresh pending crypto deposit (< 10 min) to avoid
    # multiplying addresses on repeated taps.
    from datetime import timedelta
    fresh_cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
    existing = await db.payments.find_one({
        "user_id": user["id"], "provider": "biztranspay",
        "kind": "activation_crypto",
        "status": {"$in": ["pending", "processing"]},
        "activation_done": {"$ne": True},
        "created_at": {"$gte": fresh_cutoff},
    }, {"_id": 0})
    if existing:
        return {
            "reference": existing["reference"],
            "deposit_address": existing.get("deposit_address"),
            "qr_data": existing.get("deposit_address"),
            "amount": existing.get("amount_to_send") or BTP_CRYPTO_AMOUNT,
            "amount_to_send": existing.get("amount_to_send") or BTP_CRYPTO_AMOUNT,
            "asset_code": BTP_CRYPTO_ASSET, "coin": "USDT", "network": "BEP20",
            "memo": existing.get("memo"),
            "expires_at": existing.get("expires_at"),
        }

    ref = _new_ref()
    payload = {
        "amount": BTP_CRYPTO_AMOUNT,
        "asset_code": BTP_CRYPTO_ASSET,
        "full_name": (user.get("full_name") or user.get("username") or "SPILOVEURE User"),
        "email": user.get("email") or f"{user['id']}@spiloveure.internal",
        # BTP requires a refund_address on the same network. We don't have one
        # for the payer, so we send a well-known burn address as a placeholder;
        # BTP allows this because refunds are only triggered on overpayment
        # and are a manual admin action.
        "refund_address": os.environ.get(
            "BIZTRANSPAY_CRYPTO_REFUND_ADDRESS",
            "0x000000000000000000000000000000000000dEaD",
        ),
        "reference": ref,
    }
    try:
        r = await _post("/crypto/deposits", payload, secret_key, public_key, idempotency_key=ref)
    except Exception as e:
        log.exception("btp crypto /crypto/deposits failed ref=%s: %s", ref, _redact(e))
        raise HTTPException(502, "Impossible de contacter Biz-transPay. Réessayez.")
    if r.status_code >= 400:
        detail = ""
        try:
            detail = str(r.json())[:400]
        except Exception:
            detail = r.text[:400]
        detail = _redact(detail)
        log.warning("btp crypto create %s ref=%s body=%s", r.status_code, ref, detail)
        raise HTTPException(400, "Biz-transPay a refusé la création du dépôt crypto.")
    jd = {}
    try:
        jd = r.json()
    except Exception:
        pass
    dep = jd.get("deposit") or jd
    address = (
        dep.get("payment_address")
        or dep.get("deposit_address")
        or dep.get("address")
        or (dep.get("payment_flow") or {}).get("address")
    )
    amount_to_send = float(
        dep.get("amount_to_send") or dep.get("amount") or BTP_CRYPTO_AMOUNT
    )
    memo = dep.get("memo") or (dep.get("payment_flow") or {}).get("memo")
    expires_at = dep.get("pending_expires_at") or dep.get("expires_at")
    provider_id = jd.get("id") or dep.get("id")

    if not address:
        log.error("btp crypto: no address in response ref=%s body=%s", ref, _redact(str(jd)[:400]))
        raise HTTPException(502, "Biz-transPay n'a pas fourni d'adresse de paiement. Réessayez.")

    now = datetime.now(timezone.utc)
    await db.payments.insert_one({
        "reference": ref,
        "provider": "biztranspay",
        "kind": "activation_crypto",
        "user_id": user["id"],
        "username": user.get("username"),
        "amount": BTP_CRYPTO_AMOUNT,
        "amount_to_send": amount_to_send,
        "currency": "USDT",
        "asset_code": BTP_CRYPTO_ASSET,
        "network": "BEP20",
        "deposit_address": address,
        "memo": memo,
        "expires_at": expires_at,
        "provider_intent_id": provider_id,
        "level": 1,
        "status": "pending",
        "activation_done": False,
        "created_at": now,
        "updated_at": now,
    })
    # Also mirror to activations table for the admin dashboard.
    await db.activations.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "reference": ref,
        "level": 1,
        "amount": BTP_CRYPTO_AMOUNT,
        "currency": "USDT",
        "payment_method": "crypto_auto",
        "gateway": "biztranspay",
        "status": "pending",
        "created_at": now,
    })
    return {
        "reference": ref,
        "deposit_address": address,
        "qr_data": address,
        "amount": amount_to_send,
        "amount_to_send": amount_to_send,
        "asset_code": BTP_CRYPTO_ASSET, "coin": "USDT", "network": "BEP20",
        "memo": memo,
        "expires_at": expires_at,
    }


class BtpCryptoVerifyIn(BaseModel):
    reference: str
    tx_hash: str


@api.post("/activations/biztranspay-crypto/verify")
async def biztranspay_crypto_verify(
    inp: BtpCryptoVerifyIn, request: Request, user=Depends(get_current_user),
):
    """User pasted the on-chain tx_hash — poll BTP for confirmation.

    v27w — mirrors izichange.crypto_auto_verify:
      • ownership check
      • tx_hash uniqueness across payments
      • GET /crypto/deposits/{id} — accept only "confirmed"/"completed"/"success"
      • on success → _apply_payment_success (which calls activate_level)
    """
    db = request.app.state.db
    ref = (inp.reference or "").strip()
    tx = (inp.tx_hash or "").strip()
    if not ref or not tx:
        raise HTTPException(400, "Référence et hash requis.")
    if len(tx) < 10:
        raise HTTPException(400, "Hash de transaction invalide.")

    p = await db.payments.find_one({"reference": ref, "provider": "biztranspay",
                                    "kind": "activation_crypto"})
    if not p:
        raise HTTPException(404, "Demande de paiement introuvable.")
    if p.get("user_id") != user["id"]:
        raise HTTPException(403, "Vous ne pouvez pas vérifier cette activation.")
    if p.get("activation_done"):
        return {"ok": True, "already_activated": True, "message": "Compte déjà activé."}

    dupe = await db.payments.find_one({"tx_hash": tx, "reference": {"$ne": ref}})
    if dupe:
        await db.payments.update_one(
            {"reference": ref},
            {"$set": {"status": "rejected", "tx_hash": tx,
                      "activation_error": "tx_hash_reused",
                      "updated_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(409, "Ce hash de transaction est déjà utilisé pour une autre activation.")

    intent_id = p.get("provider_intent_id")
    if not intent_id:
        raise HTTPException(500, "Identifiant passerelle manquant. Contactez le support.")
    secret_key = await _get_secret_key(db)
    public_key = await _get_public_key(db)
    try:
        r = await _get(f"/crypto/deposits/{intent_id}", secret_key, public_key)
    except Exception as e:
        log.exception("btp crypto verify GET failed ref=%s: %s", ref, _redact(e))
        raise HTTPException(400, "Impossible de contacter la passerelle. Réessayez.")
    if r.status_code == 404:
        raise HTTPException(404, "Paiement introuvable côté passerelle.")
    if r.status_code >= 400:
        log.error("btp crypto verify %s ref=%s: %s", r.status_code, ref, _redact(r.text[:400]))
        raise HTTPException(400, "La passerelle a refusé la vérification. Réessayez plus tard.")

    remote = {}
    try:
        remote = r.json()
    except Exception:
        pass
    remote_status = str(remote.get("status") or "").lower()

    if remote_status not in ("confirmed", "completed", "success", "paid"):
        # Still on-chain / not yet confirmed.
        friendly = {
            "pending": "Paiement pas encore reçu. Réessayez dans 1 à 5 minutes.",
            "pending_manual": "Confirmation manuelle en cours. Réessayez dans quelques minutes.",
            "confirming": "Paiement détecté, en attente de confirmation on-chain.",
        }.get(remote_status, "Paiement pas encore confirmé. Réessayez dans 1 à 5 minutes.")
        return {"ok": False, "status": remote_status or "pending", "message": friendly}

    # Confirmed → activate.
    upd = await db.payments.update_one(
        {"reference": ref, "activation_done": {"$ne": True}},
        {"$set": {"status": "paid", "activation_done": True,
                  "paid_at": datetime.now(timezone.utc),
                  "tx_hash": tx, "biztranspay_status": remote_status,
                  "updated_at": datetime.now(timezone.utc)},
         "$unset": {"activation_error": ""}},
    )
    if upd.modified_count == 0:
        return {"ok": True, "already_activated": True, "message": "Compte déjà activé."}
    await db.activations.update_one(
        {"reference": ref, "status": "pending"},
        {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc),
                  "validated_by": "user_tx_hash_verify_btp", "tx_hash": tx}},
    )
    try:
        from ashtec_activation import _apply_payment_success
        p = await db.payments.find_one({"reference": ref}, {"_id": 0}) or p
        await _apply_payment_success(db, p, "paid", source="biztranspay")
    except Exception as e:
        log.exception("btp crypto activation failed ref=%s: %s", ref, _redact(e))
        raise HTTPException(500, "Activation impossible. Contactez le support.")

    log.info("btp crypto verify OK ref=%s tx=%s user=%s", ref, tx[:16], user["id"])
    return {"ok": True, "activated": True,
            "message": "Paiement confirmé. Votre compte est activé au Niveau 1 !"}


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
        # v27w — crypto deposits use a different status endpoint.
        is_crypto = (p.get("kind") == "activation_crypto")
        status_path = f"/crypto/deposits/{intent_id}" if is_crypto else f"/deposits/{intent_id}"
        try:
            r = await _get(status_path, secret_key, public_key)
            if r.status_code >= 400:
                continue
            jd = r.json()
        except Exception as e:
            log.debug("btp poll error ref=%s: %s", p.get("reference"), _redact(e))
            continue
        remote = str(jd.get("status") or "").lower()
        # v1: only completed/approved/paid/success/confirmed are terminal success.
        if remote in ("paid", "completed", "approved", "success", "confirmed"):
            try:
                from ashtec_activation import _apply_payment_success
                await _apply_payment_success(db, p, "paid", source="biztranspay")
                activated += 1
            except Exception as e:
                log.exception("btp poll activation failed ref=%s: %s", p.get("reference"), _redact(e))
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
            log.exception("btp polling loop error: %s", _redact(e))
        await _a.sleep(4)
