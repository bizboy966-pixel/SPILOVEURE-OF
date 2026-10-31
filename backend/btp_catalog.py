"""Biz-transPay live catalog helpers (doc https://biz-transpay.com/integration/docs).

Operators, currencies and payment flows (USSD / OTP / push) come from
GET /mobile-money/operators?direction=deposit|payout. Activation price in a
non-FCFA currency = BTP exchange quote of 2 650 XOF."""
from __future__ import annotations

import logging
import math
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("biztranspay.catalog")

CATALOG_TTL = 300
RATE_TTL = 3600
PAYOUT_COUNTRIES = {"TG", "BF", "CI"}
FCFA = {"XOF", "XAF"}
_CATALOG: dict[str, tuple[float, list]] = {}
_RATES: dict[str, tuple[float, int]] = {}


def _norm_flow(raw: dict) -> dict:
    pf = raw.get("payment_flow") if isinstance(raw.get("payment_flow"), dict) else {}

    def g(k):
        return pf.get(k) if k in pf else raw.get(k)

    tpl = g("ussd_template") or ""
    return {
        "kind": str(g("kind") or ("ussd" if tpl else "push")).lower(),
        "otp_required": bool(g("otp_required") or g("requires_otp")),
        "otp_request_before_submit": bool(g("otp_request_before_submit")),
        "ussd_template": tpl,
        "address_required": bool(g("address_required")),
    }


def parse_catalog(jd) -> list[dict]:
    items = jd
    if isinstance(jd, dict):
        items = next((jd[k] for k in ("operators", "data", "items", "results", "routes")
                      if isinstance(jd.get(k), list)), None)
        if items is None and isinstance(jd.get("countries"), list):
            items = []
            for c in jd["countries"]:
                for o in (c.get("operators") or []):
                    if isinstance(o, dict):
                        items.append({**o, "country": o.get("country") or c.get("code") or c.get("country"),
                                      "currency": o.get("currency") or c.get("currency")})
    out = []
    for o in items if isinstance(items, list) else []:
        if not isinstance(o, dict):
            continue
        code = o.get("code") or o.get("operator") or o.get("operator_code")
        cc = o.get("country") or o.get("country_code") or ""
        if isinstance(cc, dict):
            cc = cc.get("code") or ""
        if not code or not cc:
            continue
        if o.get("active") is False or o.get("enabled") is False or o.get("available") is False:
            continue
        out.append({
            "code": str(code),
            "country": str(cc).upper()[:2],
            "currency": str(o.get("currency") or "XOF").upper(),
            "label": str(o.get("name") or o.get("label") or o.get("operator_name")
                         or o.get("display_name") or code),
            "flow": _norm_flow(o),
        })
    return out


async def fetch_catalog(db, direction: str, force: bool = False) -> list[dict]:
    from biztranspay import _get, _get_public_key, _get_secret_key
    now = time.time()
    hit = _CATALOG.get(direction)
    if hit and not force and now - hit[0] < CATALOG_TTL:
        return hit[1]
    sk, pk = await _get_secret_key(db), await _get_public_key(db)
    if sk and pk:
        try:
            r = await _get(f"/mobile-money/operators?direction={direction}", sk, pk)
            if r.status_code < 400:
                items = parse_catalog(r.json())
                _CATALOG[direction] = (now, items)
                await db.app_settings.update_one(
                    {"key": f"btp_catalog:{direction}"},
                    {"$set": {"value": items, "raw_sample": r.text[:6000],
                              "updated_at": datetime.now(timezone.utc)}},
                    upsert=True)
                try:
                    from payment_providers import sync_btp_catalog_rows
                    await sync_btp_catalog_rows(db, items)
                except Exception as e:
                    log.warning("btp catalog admin sync failed: %s", e)
                return items
            log.warning("btp catalog %s HTTP %s: %s", direction, r.status_code, r.text[:300])
        except Exception as e:
            log.warning("btp catalog %s error: %s", direction, e)
    doc = await db.app_settings.find_one({"key": f"btp_catalog:{direction}"}) or {}
    items = doc.get("value") or []
    _CATALOG[direction] = (now - CATALOG_TTL + 60, items)
    return items


async def find_entry(db, direction: str, cc: str, code: str) -> Optional[dict]:
    cc = (cc or "").upper()
    return next((e for e in await fetch_catalog(db, direction)
                 if e["country"] == cc and e["code"] == code), None)


def _first_number(d, keys) -> Optional[float]:
    if not isinstance(d, dict):
        return None
    for k in keys:
        v = d.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
        if isinstance(v, str):
            try:
                f = float(v)
                if f > 0:
                    return f
            except ValueError:
                pass
    for nested in ("quote", "data", "exchange"):
        if isinstance(d.get(nested), dict):
            n = _first_number(d[nested], keys)
            if n:
                return n
    return None


async def activation_amount_for(db, currency: str) -> Optional[int]:
    from ashtec_activation import ACTIVATION_AMOUNT_BY_CURRENCY
    from biztranspay import _get, _get_public_key, _get_secret_key
    cur = (currency or "XOF").upper()
    base = int(ACTIVATION_AMOUNT_BY_CURRENCY["XOF"])
    if cur in FCFA:
        return base
    hit = _RATES.get(cur)
    if hit and time.time() - hit[0] < RATE_TTL:
        return hit[1]
    sk, pk = await _get_secret_key(db), await _get_public_key(db)
    if sk and pk:
        try:
            r = await _get(f"/exchanges/quote?from_currency=XOF&to_currency={cur}&amount={base}", sk, pk)
            if r.status_code < 400:
                v = _first_number(r.json(), ("to_amount", "amount_to", "converted_amount", "receive_amount",
                                             "target_amount", "output_amount", "amount_out", "result",
                                             "destination_amount", "net_amount"))
                if v:
                    amt = int(math.ceil(v))
                    _RATES[cur] = (time.time(), amt)
                    await db.app_settings.update_one(
                        {"key": f"btp_rate:{cur}"},
                        {"$set": {"value": amt, "raw": r.text[:1000], "updated_at": datetime.now(timezone.utc)}},
                        upsert=True)
                    return amt
            log.warning("btp exchange quote XOF->%s HTTP %s: %s", cur, r.status_code, r.text[:300])
        except Exception as e:
            log.warning("btp exchange quote XOF->%s error: %s", cur, e)
    doc = await db.app_settings.find_one({"key": f"btp_rate:{cur}"})
    if doc and doc.get("value"):
        return int(doc["value"])
    v = ACTIVATION_AMOUNT_BY_CURRENCY.get(cur)
    return int(v) if v else None


def render_ussd(flow: dict, amount) -> str:
    tpl = (flow or {}).get("ussd_template") or ""
    return tpl.replace("{amount}", str(int(amount))) if tpl else ""


def flow_steps(flow: dict, amount_label: str, ussd: str) -> list[str]:
    f = flow or {}
    if f.get("otp_request_before_submit"):
        return [
            "Saisissez le numéro Mobile Money à débiter puis appuyez sur « Activer mon compte ».",
            "Vous recevez un code de confirmation par SMS sur ce numéro.",
            "Saisissez ce code dans le champ prévu puis validez : le paiement de "
            f"{amount_label} est lancé.",
            "Votre compte est activé automatiquement dès la confirmation.",
        ]
    if f.get("otp_required"):
        return [
            f"Composez {ussd or 'le code USSD de votre opérateur'} sur votre téléphone.",
            "Suivez le menu de votre opérateur pour générer votre code de paiement (OTP).",
            "Saisissez votre numéro et ce code ci-dessous, puis appuyez sur « Activer mon compte ».",
            "Votre compte est activé automatiquement dès la confirmation.",
        ]
    if f.get("kind") == "ussd" and ussd:
        return [
            "Saisissez le numéro Mobile Money à débiter puis appuyez sur « Activer mon compte ».",
            f"Composez ensuite {ussd} sur votre téléphone pour confirmer le paiement de {amount_label}.",
            "Votre compte est activé automatiquement dès la confirmation.",
        ]
    return [
        "Saisissez le numéro Mobile Money à débiter puis appuyez sur « Activer mon compte ».",
        f"Une demande de paiement de {amount_label} s'affiche sur votre téléphone.",
        "Validez-la avec votre code secret Mobile Money.",
        "Votre compte est activé automatiquement dès la confirmation.",
    ]


def currency_label(cur: str) -> str:
    cur = (cur or "").upper()
    return "FCFA" if cur in FCFA else {"CDF": "FC", "GNF": "GNF"}.get(cur, cur)


def idem() -> str:
    return uuid.uuid4().hex


def e164(phone: str, cc: str) -> str:
    from levels import COUNTRIES
    p = "".join(ch for ch in (phone or "") if ch.isdigit())
    dial = next((str(c.get("dial") or "").lstrip("+") for c in COUNTRIES if c.get("code") == (cc or "").upper()), "")
    if dial and not p.startswith(dial):
        p = dial + p.lstrip("0")
    return "+" + p if p else ""
