"""Idempotent removal of obsolete configuration, never financial records."""
from datetime import datetime, timezone

# Identifiers occur only here for migration and in removal/history tests.
RETIRED_IDS = ("soleas", "soleaspay", "solespay")


async def retire_gateway_configuration(db):
    """Remove provider credentials/catalogues without touching transactions."""
    for collection in (
        db.payment_providers, db.payment_provider_countries,
        db.payment_provider_operators,
    ):
        await collection.delete_many({
            "$or": [{"id": {"$in": list(RETIRED_IDS)}},
                    {"provider_id": {"$in": list(RETIRED_IDS)}}],
        })
    await db.app_settings.delete_many({
        "$or": [{"key": {"$in": list(RETIRED_IDS)}},
                {"_id": {"$in": list(RETIRED_IDS)}}],
    })
    doc = await db.app_settings.find_one({"key": "payment_gateway"}) or {}
    value = doc.get("value") or {}
    if not isinstance(value, dict):
        return
    unset = {
        f"value.{key}": ""
        for key in value
        if any(key.lower().startswith(prefix) for prefix in RETIRED_IDS)
    }
    for key in (value.get("country_matrix") or {}):
        if key.lower() in RETIRED_IDS:
            unset[f"value.country_matrix.{key}"] = ""
    update = {}
    if unset:
        update["$unset"] = unset
    if value.get("active") in RETIRED_IDS:
        # This changes the selector, not another provider's enable switch.
        update["$set"] = {"value.active": "ashtec"}
    if update:
        update.setdefault("$set", {})["updated_at"] = datetime.now(timezone.utc)
        await db.app_settings.update_one({"key": "payment_gateway"}, update)
