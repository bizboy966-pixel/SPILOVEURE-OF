"""Normalized payment provider registry (v27i, 2026-02-20).

Phase 1 of the multi-provider refactor. Three collections:

  • payment_providers            — one row per gateway (soleaspay, ashtec,
                                    izichange, biztranspay, …)
  • payment_provider_countries   — provider × country + mode/priority/status
  • payment_provider_operators   — provider × country × operator

The DATA source of truth remains `app_settings.payment_gateway.value`
(legacy flat config) during Phase 1 — this module only READS from it and
mirrors into the normalized collections, idempotently, at boot.

The router (`PaymentProviderRouter`) will consume these collections in
Phase 2. Nothing else in the codebase reads them yet.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("payment_providers")


# Static catalog: what each provider CAN support (operator codes come
# straight from each provider's own SDK / doc).
_PROVIDER_CATALOG: dict[str, dict] = {
    "biztranspay": {
        "name": "Biz-transPay",
        "type": "mobile_money",
        "auto_deposit": True,
        "auto_withdrawal": True,
        "default_priority": 1,   # TG owner wants BTP first
        "countries_source": "biztranspay",
    },
    "soleaspay": {
        "name": "SoleasPay",
        "type": "mobile_money",
        "auto_deposit": True,
        "auto_withdrawal": True,
        "default_priority": 2,
        "countries_source": "soleaspay",
    },
    "ashtec": {
        "name": "AshtecPay",
        "type": "mobile_money",
        "auto_deposit": True,
        "auto_withdrawal": False,
        "default_priority": 3,
        "countries_source": "ashtec",
    },
    "izichange": {
        "name": "IziChangePay",
        "type": "crypto",
        "auto_deposit": True,
        "auto_withdrawal": True,
        "default_priority": 5,
        "countries_source": "crypto_universal",
    },
}


async def _sync_provider_row(db, provider_id: str, cfg: dict) -> None:
    """Upsert one `payment_providers` row from the current flat config."""
    meta = _PROVIDER_CATALOG.get(provider_id, {})
    now = datetime.now(timezone.utc)

    # Derive enabled/auto_deposit/auto_withdrawal from the flat config,
    # honoring the current admin toggles.
    if provider_id == "biztranspay":
        enabled = bool(cfg.get("biztranspay_enabled"))
        auto_dep = bool(cfg.get("biztranspay_payin_enabled", True))
        auto_wd = bool(cfg.get("biztranspay_payout_enabled"))
    elif provider_id == "soleaspay":
        enabled = bool(cfg.get("soleas_enabled"))
        auto_dep = enabled  # SoleasPay PayIn = master switch
        auto_wd = bool(cfg.get("soleaspay_pout_enabled"))
    elif provider_id == "ashtec":
        enabled = bool(cfg.get("ashtec_enabled"))
        auto_dep = enabled
        auto_wd = False
    elif provider_id == "izichange":
        # IziChangePay is gated by the `crypto_auto` feature flag + env key
        from feature_flags import is_enabled as _flag_on
        enabled = await _flag_on(db, "crypto_auto")
        auto_dep = enabled
        auto_wd = enabled
    else:
        enabled, auto_dep, auto_wd = False, False, False

    doc = {
        "id": provider_id,
        "name": meta.get("name") or provider_id,
        "type": meta.get("type") or "mobile_money",
        "status": "active" if enabled else "inactive",
        "auto_deposit": auto_dep,
        "auto_withdrawal": auto_wd,
        "priority": meta.get("default_priority", 99),
        "updated_at": now,
    }
    await db.payment_providers.update_one(
        {"id": provider_id},
        {"$set": doc, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )


async def sync_btp_catalog_rows(db, entries: list, cfg: Optional[dict] = None) -> int:
    """Expose every live Biz-transPay catalog country/operator in the admin
    provider panel (same rows as the static list). Admin toggles are kept:
    existing rows are never re-activated; new rows follow the stored toggle (default ON)."""
    from biztranspay import OPERATORS as BTP, _resolve_operator_code
    if cfg is None:
        doc = await db.app_settings.find_one({"key": "payment_gateway"}) or {}
        cfg = doc.get("value") or {}
    toggles = cfg.get("biztranspay_countries") or {}
    now = datetime.now(timezone.utc)
    by_cc: dict = {}
    for e in entries or []:
        cc = e["country"]
        if cc in BTP and (_resolve_operator_code(cc, e["code"]) or _resolve_operator_code(cc, e["label"])):
            continue
        by_cc.setdefault(cc, {})[e["code"]] = e
    added = 0
    for cc, ops in by_cc.items():
        c_toggles = toggles.get(cc) or {}
        any_on = any(c_toggles.get(code, True) for code in ops)
        currency = next(iter(ops.values()))["currency"]
        if cc not in BTP:
            await db.payment_provider_countries.update_one(
                {"provider_id": "biztranspay", "country_code": cc},
                {"$setOnInsert": {"provider_id": "biztranspay", "country_code": cc, "currency": currency,
                                  "status": "active" if any_on else "inactive", "mode": "automatic",
                                  "priority": 1, "source": "btp_catalog", "created_at": now},
                 "$set": {"updated_at": now}},
                upsert=True)
        for code, e in ops.items():
            r = await db.payment_provider_operators.update_one(
                {"provider_id": "biztranspay", "country_code": cc, "operator_code": code},
                {"$setOnInsert": {"provider_id": "biztranspay", "country_code": cc, "operator_code": code,
                                  "status": "active" if c_toggles.get(code, True) else "inactive",
                                  "source": "btp_catalog", "created_at": now},
                 "$set": {"operator_label": e["label"], "updated_at": now}},
                upsert=True)
            added += 1 if r.upserted_id else 0
    return added


async def _sync_countries_operators(db, provider_id: str, cfg: dict) -> None:
    """Populate `payment_provider_countries` + `payment_provider_operators`
    for one provider, from the flat config's country matrix / operator toggles.
    """
    now = datetime.now(timezone.utc)

    def _upsert_country(cc: str, currency: str, enabled: bool, mode: str = "automatic"):
        return db.payment_provider_countries.update_one(
            {"provider_id": provider_id, "country_code": cc},
            {"$set": {
                "provider_id": provider_id, "country_code": cc,
                "currency": currency, "status": "active" if enabled else "inactive",
                "mode": mode, "priority": 1, "updated_at": now,
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

    def _upsert_operator(cc: str, code: str, label: str, enabled: bool):
        return db.payment_provider_operators.update_one(
            {"provider_id": provider_id, "country_code": cc, "operator_code": code},
            {"$set": {
                "provider_id": provider_id, "country_code": cc,
                "operator_code": code, "operator_label": label,
                "status": "active" if enabled else "inactive",
                "updated_at": now,
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

    if provider_id == "biztranspay":
        from biztranspay import OPERATORS as BTP
        toggles = cfg.get("biztranspay_countries") or {}
        for cc, info in BTP.items():
            c_toggles = toggles.get(cc) or {}
            # v27n — each operator carries a `default_active` flag (TG on,
            # BJ/BF off) so BJ/BF land inactive by default; admin must
            # explicitly enable them.
            any_on = False
            for op in info["operators"]:
                default = bool(op.get("default_active", True))
                if c_toggles.get(op["code"], default):
                    any_on = True; break
            await _upsert_country(cc, info["currency"], any_on)
            for op in info["operators"]:
                default = bool(op.get("default_active", True))
                on = c_toggles.get(op["code"], default)
                await _upsert_operator(cc, op["code"], op["label"], on)
        try:
            from btp_catalog import fetch_catalog
            entries = (await fetch_catalog(db, "deposit")) + (await fetch_catalog(db, "payout"))
        except Exception:
            entries = []
        await sync_btp_catalog_rows(db, entries, cfg)

    elif provider_id == "soleaspay":
        try:
            import soleaspay
        except Exception:
            return
        matrix = (cfg.get("country_matrix") or {}).get("soleas") or {}
        for cc, ops in soleaspay.SUPPORTED.items():
            if cc in soleaspay.EXCLUDED_COUNTRIES:
                continue
            enabled = matrix.get(cc, True) is not False
            # currency taken from first operator (all XOF/XAF anyway)
            currency = ops[0]["currency"] if ops else "XOF"
            await _upsert_country(cc, currency, enabled)
            for op in ops:
                await _upsert_operator(cc, str(op["id"]), op["label"], enabled)

    elif provider_id == "ashtec":
        try:
            from ashtec_activation import COUNTRIES as AC
        except Exception:
            return
        matrix = (cfg.get("country_matrix") or {}).get("ashtec") or {}
        for cc, info in AC.items():
            enabled = matrix.get(cc, True) is not False
            await _upsert_country(cc, info.get("currency") or "XOF", enabled)
            for op in (info.get("operators") or []):
                label = op if isinstance(op, str) else (op.get("label") or op.get("code"))
                code = op if isinstance(op, str) else (op.get("code") or op.get("label"))
                await _upsert_operator(cc, code, label, enabled)

    elif provider_id == "izichange":
        # Universal — no country/operator restriction. Represented as a
        # single wildcard "*" entry so the router can pick it up as a
        # fallback for every country.
        await _upsert_country("*", "USDT", True, mode="automatic")
        await _upsert_operator("*", "USDT_BEP20", "USDT BEP20", True)


async def sync_providers(db) -> dict:
    """Idempotent seed of the normalized collections from the flat config.

    Called at boot (see server.lifespan) AND whenever the admin updates
    the flat config (best-effort — future phases will make the normalized
    collections the primary source).
    """
    try:
        doc = await db.app_settings.find_one({"key": "payment_gateway"}) or {}
        cfg = (doc.get("value") if isinstance(doc.get("value"), dict) else {}) or {}

        for provider_id in _PROVIDER_CATALOG.keys():
            await _sync_provider_row(db, provider_id, cfg)
            await _sync_countries_operators(db, provider_id, cfg)

        # Indexes (idempotent)
        await db.payment_providers.create_index("id", unique=True)
        await db.payment_provider_countries.create_index(
            [("provider_id", 1), ("country_code", 1)], unique=True,
        )
        await db.payment_provider_operators.create_index(
            [("provider_id", 1), ("country_code", 1), ("operator_code", 1)], unique=True,
        )

        counts = {
            "providers": await db.payment_providers.count_documents({}),
            "countries": await db.payment_provider_countries.count_documents({}),
            "operators": await db.payment_provider_operators.count_documents({}),
        }
        log.info("payment_providers sync OK: %s", counts)
        return counts
    except Exception as e:
        log.exception("payment_providers sync failed: %s", e)
        return {"error": str(e)}
