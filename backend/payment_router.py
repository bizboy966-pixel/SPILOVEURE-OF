"""PaymentProviderRouter (v27j, Phase 2) — routage centralisé multi-prestataires.

Consomme les collections normalisées créées en Phase 1 :
  • payment_providers
  • payment_provider_countries
  • payment_provider_operators

Fournit deux points d'entrée :

  pick_provider(db, kind, country, operator=None) → {provider_id, config, ...} | None
  log_decision(db, ...)                            → écrit dans payment_router_logs

`kind` peut être 'payin' (dépôt/activation) ou 'payout' (retrait).

Le router :
  1. Cherche tous les prestataires actifs pour (country, operator).
  2. Filtre par statut du pays + statut de l'opérateur.
  3. Filtre par capacité (`auto_deposit` pour payin, `auto_withdrawal` pour payout).
  4. Refuse les affectations Mobile Money en conflit (y compris les alias).
  5. Retourne le prestataire unique du couple pays/opérateur s’il est prêt.

Aucun remplacement par un autre prestataire pour le même opérateur en cas
de configuration manquante ou de conflit. Les priorités ne servent qu’aux
diagnostics sans opérateur et aux moyens de paiement non Mobile Money.
"""
from __future__ import annotations
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional
from payment_exclusivity import configuration_write

log = logging.getLogger("payment_router")


async def _provider_ready(db, provider_id: str, kind: str) -> tuple[bool, Optional[str]]:
    """Return (ready, reason). Checks the provider's flat-config for API key
    presence + kind-specific switch. The normalized `payment_providers` row
    already carries `status/auto_deposit/auto_withdrawal` — this second check
    guards against a provider whose row says "active" but whose credentials
    are missing (e.g. admin toggled ON but never pasted the key).
    """
    from payment_providers import _PROVIDER_CATALOG
    if provider_id not in _PROVIDER_CATALOG:
        return False, "unsupported_provider"
    doc = await db.app_settings.find_one({"key": "payment_gateway"}) or {}
    cfg = (doc.get("value") if isinstance(doc.get("value"), dict) else {}) or {}
    if provider_id == "biztranspay":
        # v27s (2026-02-24) — Integration v1 requires BOTH public + secret.
        secret_ok = bool((cfg.get("biztranspay_secret_key") or "").strip()
                         or (cfg.get("biztranspay_api_key") or "").strip()
                         or (os.environ.get("BIZTRANSPAY_SECRET_KEY") or "").strip()
                         or (os.environ.get("BIZTRANSPAY_API_KEY") or "").strip())
        public_ok = bool((cfg.get("biztranspay_public_key") or "").strip()
                         or (os.environ.get("BIZTRANSPAY_PUBLIC_KEY") or "").strip())
        if not (secret_ok and public_ok):
            return False, "missing_api_key"
        if kind == "payin" and not cfg.get("biztranspay_payin_enabled", True):
            return False, "payin_disabled"
        if kind == "payout" and not cfg.get("biztranspay_payout_enabled"):
            return False, "payout_disabled"
    elif provider_id == "ashtec":
        key_ok = bool((cfg.get("ashtec_api_key") or "").strip()
                      or (os.environ.get("ASHTECPAY_API_KEY") or "").strip())
        if not key_ok:
            return False, "missing_api_key"
        if kind == "payout":
            return False, "payout_unsupported"
    elif provider_id == "moneyfusion":
        try:
            from moneyfusion import load_config, load_credentials
            mf_cfg = await load_config(db)
            credentials = await load_credentials(db)
        except Exception:
            return False, "missing_credentials"
        if kind == "payin":
            if not (mf_cfg.get("payin_enabled")
                    and mf_cfg.get("payin_local_currency_confirmed")
                    and mf_cfg.get("mobile_money_only_confirmed")
                    and credentials.get("payin_api_url")):
                return False, "payin_not_configured_or_currency_unconfirmed"
        elif not (mf_cfg.get("payout_enabled")
                  and mf_cfg.get("payout_ip_confirmed")
                  and credentials.get("payout_private_key")):
            return False, "payout_not_configured"
    elif provider_id == "izichange":
        key_ok = bool((os.environ.get("IZIPAY_SECRET_KEY") or "").strip())
        if not key_ok:
            return False, "missing_api_key"
    return True, None


async def pick_provider(
    db, *, kind: str, country: str, operator: Optional[str] = None,
) -> Optional[dict]:
    """Return the winning provider dict or None.

    Result shape:
        {
          "provider_id": "biztranspay",
          "priority": 1,
          "country_status": "active",
          "operator_status": "active",
          "mode": "automatic",
          "attempts": [
            {"provider_id": "biztranspay", "ready": True, "reason": None},
            ...
          ],
        }
    """
    kind = (kind or "").lower()
    if kind not in ("payin", "payout"):
        raise ValueError(f"Unknown kind: {kind}")
    country = (country or "").upper()

    cap_field = "auto_deposit" if kind == "payin" else "auto_withdrawal"

    # 1. Load active providers with the capability, sorted by priority.
    from payment_providers import _PROVIDER_CATALOG
    active_providers = []
    async for p in db.payment_providers.find(
        {"id": {"$in": list(_PROVIDER_CATALOG)},
         "status": "active", cap_field: True}, {"_id": 0},
    ).sort("priority", 1):
        active_providers.append(p)

    attempts: list[dict] = []
    from payment_exclusivity import mobile_routes, operator_identity, assert_assignment
    routes = await mobile_routes(db)
    target = operator_identity(country, operator or "")
    direct = [r for r in routes if r["country_code"] == country and r["operator_code"] == operator]
    if direct:
        target = direct[0]["identity"]
    matching = [r for r in routes if r["country_code"] == country and r["identity"] == target]
    if operator and matching:
        sample = matching[0]
        await assert_assignment(db, sample["provider_id"], country,
                                sample["operator_code"], sample.get("operator_label", ""))

    for prov in active_providers:
        pid = prov["id"]
        # 2. Country match — either exact code or wildcard "*" (izichange universal).
        country_row = await db.payment_provider_countries.find_one(
            {"provider_id": pid, "country_code": {"$in": [country, "*"]},
             "status": "active"},
            {"_id": 0},
        )
        if not country_row:
            attempts.append({"provider_id": pid, "ready": False, "reason": "country_not_supported_or_disabled"})
            continue
        # 3. Operator match (only if the caller provided one).
        op_row = None
        if operator:
            op_row = await db.payment_provider_operators.find_one(
                {"provider_id": pid,
                 "country_code": country_row["country_code"],
                 "operator_code": operator,
                 "status": "active"},
                {"_id": 0},
            )
            if not op_row:
                op_row = next((r for r in matching if r["provider_id"] == pid), None)
                if not op_row:
                    attempts.append({"provider_id": pid, "ready": False, "reason": "operator_not_supported_or_disabled"})
                    continue
        # 4. Runtime readiness (API key present etc.).
        ready, reason = await _provider_ready(db, pid, kind)
        attempts.append({"provider_id": pid, "ready": ready, "reason": reason})
        if not ready:
            continue

        return {
            "provider_id": pid,
            "priority": prov.get("priority", 99),
            "country_status": country_row["status"],
            "operator_status": (op_row or {}).get("status"),
            "operator_code": (op_row or {}).get("operator_code"),
            "mode": country_row.get("mode", "automatic"),
            "attempts": attempts,
        }
    return {"provider_id": None, "attempts": attempts} if attempts else None


async def log_decision(
    db, *, kind: str, country: str, operator: Optional[str],
    result: Optional[dict], user_id: Optional[str] = None,
    reference: Optional[str] = None,
) -> None:
    """Persist the routing decision for audit. Best-effort (no raise)."""
    try:
        await db.payment_router_logs.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "reference": reference,
            "kind": kind,
            "country": country,
            "operator": operator,
            "selected_provider": (result or {}).get("provider_id"),
            "attempts": (result or {}).get("attempts") or [],
            "created_at": datetime.now(timezone.utc),
        })
    except Exception as e:
        log.debug("router log failed: %s", e)


async def set_priority(db, provider_id: str, priority: int) -> bool:
    """Admin API — updates a provider's priority. Returns True on success."""
    r = await db.payment_providers.update_one(
        {"id": provider_id},
        {"$set": {"priority": int(priority),
                  "updated_at": datetime.now(timezone.utc)}},
    )
    return r.modified_count > 0


async def _mirror_btp_operator_to_legacy(db, country_code: str, operator_code: str, enabled: bool) -> None:
    """Mirror a per-operator toggle into the legacy flat config
    (`app_settings.payment_gateway.value.biztranspay_countries`) so that
    `sync_providers()` running at next boot (or after any other admin
    change) does NOT silently flip the operator back to its default.

    Fixes the "auto-reactivation" bug: admin disabled an operator via the
    new routeur card, then any save on another gateway triggered a sync
    that re-read the legacy map (where the operator was still marked
    active by default) and overwrote the admin's choice.
    """
    cc = (country_code or "").upper()
    try:
        doc = await db.app_settings.find_one({"key": "payment_gateway"}) or {}
        cfg = (doc.get("value") if isinstance(doc.get("value"), dict) else {}) or {}
        countries = dict(cfg.get("biztranspay_countries") or {})
        inner = dict(countries.get(cc) or {})
        inner[operator_code] = bool(enabled)
        countries[cc] = inner
        cfg["biztranspay_countries"] = countries
        await db.app_settings.update_one(
            {"key": "payment_gateway"},
            {"$set": {"key": "payment_gateway", "value": cfg,
                      "updated_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
    except Exception as e:
        log.warning("mirror BTP toggle legacy failed: %s", e)


@configuration_write
async def toggle_country(db, provider_id: str, country_code: str, enabled: bool) -> bool:
    cc = (country_code or "").upper()
    if enabled:
        from payment_exclusivity import validate_change
        await validate_change(db, country_change=(provider_id, cc, True))
    r = await db.payment_provider_countries.update_one(
        {"provider_id": provider_id, "country_code": cc},
        {"$set": {"status": "active" if enabled else "inactive",
                  "updated_at": datetime.now(timezone.utc)}},
    )
    if r.matched_count == 0:
        return False
    # Cascade to every operator of this country so (a) the toggle is
    # consistent (country off => no operator usable) and (b) sync won't
    # silently re-enable them.
    await db.payment_provider_operators.update_many(
        {"provider_id": provider_id, "country_code": cc},
        {"$set": {"status": "active" if enabled else "inactive",
                  "updated_at": datetime.now(timezone.utc)}},
    )
    # Mirror into legacy flat config for BTP so sync_providers() is a no-op.
    if provider_id == "biztranspay":
        try:
            from biztranspay import OPERATORS as BTP_OPS
            info = BTP_OPS.get(cc) or {}
            for op in info.get("operators") or []:
                await _mirror_btp_operator_to_legacy(db, cc, op["code"], enabled)
            async for op in db.payment_provider_operators.find(
                {"provider_id": provider_id, "country_code": cc}, {"operator_code": 1}
            ):
                await _mirror_btp_operator_to_legacy(db, cc, op["operator_code"], enabled)
        except Exception as e:
            log.warning("mirror BTP country toggle failed: %s", e)
    elif provider_id == "ashtec":
        await db.app_settings.update_one(
            {"key": "payment_gateway"},
            {"$set": {f"value.country_matrix.ashtec.{cc}": enabled}}, upsert=True)
        async for op in db.payment_provider_operators.find({"provider_id": provider_id, "country_code": cc}):
            await db.app_settings.update_one(
                {"key": "payment_gateway"},
                {"$set": {f"value.ashtec_operators.{cc}.{op['operator_code']}": enabled}})
    return True


@configuration_write
async def toggle_operator(
    db, provider_id: str, country_code: str, operator_code: str, enabled: bool,
) -> bool:
    cc = (country_code or "").upper()
    if enabled:
        from payment_exclusivity import validate_change
        await validate_change(db, operator_change=(provider_id, cc, operator_code, True))
    r = await db.payment_provider_operators.update_one(
        {"provider_id": provider_id, "country_code": cc,
         "operator_code": operator_code},
        {"$set": {"status": "active" if enabled else "inactive",
                  "updated_at": datetime.now(timezone.utc)}},
    )
    if r.matched_count == 0:
        return False
    # A physical operator can have different legacy/live spellings in the
    # same provider catalogue. Transfer all of them together, not just one row.
    from payment_exclusivity import operator_identity
    target = await db.payment_provider_operators.find_one(
        {"provider_id": provider_id, "country_code": cc, "operator_code": operator_code}) or {}
    identity = operator_identity(cc, operator_code, target.get("operator_label", ""))
    alias_codes = [
        row["operator_code"] async for row in db.payment_provider_operators.find(
            {"provider_id": provider_id, "country_code": cc})
        if operator_identity(cc, row["operator_code"], row.get("operator_label", "")) == identity
    ]
    await db.payment_provider_operators.update_many(
        {"provider_id": provider_id, "country_code": cc, "operator_code": {"$in": alias_codes}},
        {"$set": {"status": "active" if enabled else "inactive",
                  "updated_at": datetime.now(timezone.utc)}})
    # Mirror into legacy flat config for BTP so sync_providers() keeps
    # the admin's choice next time it runs. See _mirror_btp_operator_to_legacy.
    if provider_id == "biztranspay":
        for code in alias_codes:
            await _mirror_btp_operator_to_legacy(db, cc, code, enabled)
    elif provider_id == "ashtec":
        changes = {f"value.ashtec_operators.{cc}.{code}": enabled for code in alias_codes}
        if enabled:
            changes[f"value.country_matrix.ashtec.{cc}"] = True
        await db.app_settings.update_one({"key": "payment_gateway"}, {"$set": changes}, upsert=True)
    # If we just enabled an operator, the country can no longer be inactive
    # (sync_providers derives country = ANY operator active).
    if enabled:
        await db.payment_provider_countries.update_one(
            {"provider_id": provider_id, "country_code": cc, "status": "inactive"},
            {"$set": {"status": "active",
                      "updated_at": datetime.now(timezone.utc)}},
        )
    return True


async def set_country_mode(
    db, provider_id: str, country_code: str, mode: str,
) -> bool:
    """v27l (Phase 4) — flip a country between automatic and manual mode.

    In manual mode, the dispatcher creates a `pending_manual_review`
    payment instead of hitting the gateway API. Admin then validates from
    the "Activations" tab.
    """
    if mode not in ("automatic", "manual"):
        raise ValueError("mode must be 'automatic' or 'manual'")
    r = await db.payment_provider_countries.update_one(
        {"provider_id": provider_id, "country_code": country_code.upper()},
        {"$set": {"mode": mode, "updated_at": datetime.now(timezone.utc)}},
    )
    return r.matched_count > 0
