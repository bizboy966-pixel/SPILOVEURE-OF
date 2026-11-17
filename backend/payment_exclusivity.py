"""One Mobile Money provider per physical country/operator, across API aliases.

Read-only validation is also performed immediately before financial submission:
even simultaneous administrative edits cannot cause fallback or double routing.
Existing in-flight operations keep their stored provider.
"""
import re
import unicodedata
import inspect
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

MOBILE_PROVIDERS = {"ashtec", "biztranspay", "moneyfusion"}


def configuration_write(function):
    """Serialize admin configuration changes across server processes."""
    signature = inspect.signature(function, eval_str=True)

    @wraps(function)
    async def guarded(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        db = bound.arguments.get("db")
        if db is None:
            db = bound.arguments["request"].app.state.db
        owner = uuid.uuid4().hex
        now = datetime.now(timezone.utc)
        try:
            await db.payment_configuration_locks.find_one_and_update(
                {"_id": "mobile-money", "$or": [{"expires_at": {"$lte": now}}, {"expires_at": {"$exists": False}}]},
                {"$set": {"owner": owner, "expires_at": now + timedelta(minutes=5)}},
                upsert=True, return_document=ReturnDocument.AFTER)
        except DuplicateKeyError:
            raise HTTPException(409, "Une configuration de paiement est déjà en cours. Réessayez dans quelques instants.")
        try:
            return await function(*args, **kwargs)
        finally:
            await db.payment_configuration_locks.update_one(
                {"_id": "mobile-money", "owner": owner},
                {"$set": {"expires_at": datetime.now(timezone.utc)}})
    guarded.__signature__ = signature
    return guarded


def operator_identity(country, code, label=""):
    text = unicodedata.normalize("NFKD", f"{label} {code}").encode("ascii", "ignore").decode().lower()
    tokens = re.sub(r"[^a-z0-9]+", " ", text).split()
    joined = "".join(tokens)
    brands = (
        ("moov", ("moov", "flooz")),
        ("tmoney", ("tmoney", "togocom", "mixx", "yas")),
        ("mtn", ("mtn", "momo")),
        ("orange", ("orange",)),
        ("wave", ("wave",)),
        ("celtiis", ("celtiis", "celtis")),
        ("airtel", ("airtel",)),
        ("mpesa", ("mpesa", "vodacom")),
        ("telecel", ("telecel",)),
        ("coris", ("coris",)),
        ("free", ("free",)),
    )
    for brand, aliases in brands:
        if any(alias in joined for alias in aliases):
            return brand
    ignored = {"money", "mobile", "cash", "pay", "payment", "paiement", str(country).lower()}
    meaningful = [token for token in tokens if token not in ignored]
    return "".join(meaningful) or str(code).lower()


async def mobile_routes(db, *, provider_enabled=None, country_change=None,
                        operator_change=None, flat_config=None, mf_config=None):
    providers = {p["id"]: p async for p in db.payment_providers.find(
        {"id": {"$in": list(MOBILE_PROVIDERS)}}, {"_id": 0})}
    flags = dict(provider_enabled or {})
    if flat_config is not None:
        flags.update({
            "ashtec": bool(flat_config.get("ashtec_enabled")),
            "biztranspay": bool(flat_config.get("biztranspay_enabled") and (
                flat_config.get("biztranspay_payin_enabled", True) or flat_config.get("biztranspay_payout_enabled"))),
        })
    if mf_config is not None:
        flags["moneyfusion"] = bool(mf_config.get("payin_enabled") or mf_config.get("payout_enabled"))
    else:
        stored = await db.app_settings.find_one({"key": "moneyfusion_config"}) or {}
        mf_config = stored.get("value")
    countries = {(r["provider_id"], r["country_code"]): r async for r in db.payment_provider_countries.find(
        {"provider_id": {"$in": list(MOBILE_PROVIDERS)}}, {"_id": 0})}
    routes = []
    async for op in db.payment_provider_operators.find(
        {"provider_id": {"$in": list(MOBILE_PROVIDERS)}}, {"_id": 0}
    ):
        pid, cc, code = op["provider_id"], op["country_code"], op["operator_code"]
        provider = providers.get(pid, {})
        enabled = flags.get(pid, provider.get("status") == "active" and (
            provider.get("auto_deposit") or provider.get("auto_withdrawal")))
        country_on = countries.get((pid, cc), {}).get("status") == "active"
        operator_on = op.get("status") == "active"
        if flat_config is not None:
            if pid == "ashtec":
                country_on = (flat_config.get("country_matrix") or {}).get("ashtec", {}).get(cc, country_on)
                operator_on = (flat_config.get("ashtec_operators") or {}).get(cc, {}).get(code, operator_on)
            if pid == "biztranspay":
                toggles = (flat_config.get("biztranspay_countries") or {}).get(cc, {})
                if code in toggles:
                    operator_on = bool(toggles[code])
                # Saving the legacy gateway settings re-derives this country's state.
                if toggles and any(toggles.values()):
                    country_on = True
        if country_change and country_change[:2] == (pid, cc):
            country_on = operator_on = country_change[2]
        if operator_change and operator_change[:3] == (pid, cc, code):
            operator_on = operator_change[3]
            if operator_on:
                country_on = True
        if enabled and country_on and operator_on:
            routes.append({**op, "identity": operator_identity(cc, code, op.get("operator_label", "")),
                           "provider": provider, "country_row": countries.get((pid, cc), {})})
    return routes


def conflicts(routes):
    pairs = {}
    for route in routes:
        key = (route["country_code"], route["identity"])
        pairs.setdefault(key, set()).add(route["provider_id"])
    return {key: owners for key, owners in pairs.items() if len(owners) > 1}


async def validate_change(db, **changes):
    before = conflicts(await mobile_routes(db))
    after = conflicts(await mobile_routes(db, **changes))
    for (cc, identity), owners in after.items():
        if owners != before.get((cc, identity)):
            raise HTTPException(409, f"{cc} / {identity} est déjà attribué à un autre prestataire ({', '.join(sorted(owners))}). Désactivez d’abord cet opérateur chez l’ancien prestataire.")


async def assert_assignment(db, provider_id, country, code, label=""):
    routes = await mobile_routes(db)
    identity = operator_identity(country, code, label)
    owners = {route["provider_id"] for route in routes
              if route["country_code"] == country and route["identity"] == identity}
    if len(owners) > 1:
        raise HTTPException(409, f"Conflit de prestataires pour {country} / {identity}. Aucun nouveau paiement n’a été envoyé.")
    if owners and provider_id not in owners:
        raise HTTPException(409, "Cet opérateur est attribué à un autre prestataire. Actualisez la page de paiement.")


async def available_for_new_operator(db, provider_id, country, code, label=""):
    identity = operator_identity(country, code, label)
    return not any(route["provider_id"] != provider_id and route["country_code"] == country
                   and route["identity"] == identity for route in await mobile_routes(db))
