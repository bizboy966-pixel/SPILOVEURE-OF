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
  4. Trie par priorité (1 = plus prioritaire).
  5. Retourne le premier match.

Fallback contrôlé : si le prestataire prioritaire est indisponible techniquement
(clé API manquante), le router essaie le suivant. Chaque tentative est loguée.
"""
from __future__ import annotations
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("payment_router")


async def _provider_ready(db, provider_id: str, kind: str) -> tuple[bool, Optional[str]]:
    """Return (ready, reason). Checks the provider's flat-config for API key
    presence + kind-specific switch. The normalized `payment_providers` row
    already carries `status/auto_deposit/auto_withdrawal` — this second check
    guards against a provider whose row says "active" but whose credentials
    are missing (e.g. admin toggled ON but never pasted the key).
    """
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
    elif provider_id == "soleaspay":
        try:
            import soleaspay
            key_ok = bool(soleaspay.is_configured() or await soleaspay.is_configured_async(db))
        except Exception:
            key_ok = False
        if not key_ok:
            return False, "missing_credentials"
        if kind == "payout" and not cfg.get("soleaspay_pout_enabled"):
            return False, "payout_disabled"
    elif provider_id == "ashtec":
        key_ok = bool((cfg.get("ashtec_api_key") or "").strip()
                      or (os.environ.get("ASHTECPAY_API_KEY") or "").strip())
        if not key_ok:
            return False, "missing_api_key"
        if kind == "payout":
            return False, "payout_unsupported"
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
    active_providers = []
    async for p in db.payment_providers.find(
        {"status": "active", cap_field: True}, {"_id": 0},
    ).sort("priority", 1):
        active_providers.append(p)

    attempts: list[dict] = []

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


async def toggle_country(db, provider_id: str, country_code: str, enabled: bool) -> bool:
    r = await db.payment_provider_countries.update_one(
        {"provider_id": provider_id, "country_code": country_code.upper()},
        {"$set": {"status": "active" if enabled else "inactive",
                  "updated_at": datetime.now(timezone.utc)}},
    )
    return r.matched_count > 0


async def toggle_operator(
    db, provider_id: str, country_code: str, operator_code: str, enabled: bool,
) -> bool:
    r = await db.payment_provider_operators.update_one(
        {"provider_id": provider_id, "country_code": country_code.upper(),
         "operator_code": operator_code},
        {"$set": {"status": "active" if enabled else "inactive",
                  "updated_at": datetime.now(timezone.utc)}},
    )
    return r.matched_count > 0


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
