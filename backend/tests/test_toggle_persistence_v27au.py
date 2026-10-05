"""v27au (2026-03-05) — regression: operator/country toggles must survive sync_providers().

Previously, after an admin disabled MTN CI via the new "Routeur de prestataires" card,
`toggle_operator` wrote `status: inactive` to `payment_provider_operators` but DID NOT
touch the legacy `biztranspay_countries` flat config. On the next boot (or next admin
save that triggered `sync_providers()`), the sync re-read the legacy map (where the
operator was still default_active=True) and overwrote the admin's choice back to
`active`. End result: MTN CI silently re-enabled itself every single time.

The fix mirrors the toggle into the legacy flat config so sync_providers() becomes a
no-op for admin-overridden operators.
"""
import asyncio
import os
import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from payment_router import toggle_operator, toggle_country
from payment_providers import sync_providers


@pytest.fixture
def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return client[os.environ["DB_NAME"]]


@pytest.mark.asyncio
async def test_disable_mtn_ci_persists_through_sync(db):
    # Seed the normalized collections from the current flat config.
    await sync_providers(db)

    # Precondition : MTN CI is initially active (default_active=True).
    row_before = await db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "country_code": "CI", "operator_code": "mtn_ci"}, {"_id": 0}
    )
    assert row_before is not None, "mtn_ci must be seeded for CI"
    assert row_before["status"] == "active"

    # Admin disables MTN CI via the new routeur card endpoint.
    ok = await toggle_operator(db, "biztranspay", "CI", "mtn_ci", enabled=False)
    assert ok is True

    # Immediate state : inactive in the normalized collection AND mirrored
    # into the legacy flat config.
    row_after = await db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "country_code": "CI", "operator_code": "mtn_ci"}, {"_id": 0}
    )
    assert row_after["status"] == "inactive"
    cfg_doc = await db.app_settings.find_one({"key": "payment_gateway"})
    assert cfg_doc is not None
    legacy_map = (cfg_doc.get("value") or {}).get("biztranspay_countries") or {}
    assert legacy_map.get("CI", {}).get("mtn_ci") is False, (
        f"Legacy map should mirror the admin's toggle, got {legacy_map.get('CI')}"
    )

    # Simulate ANY action that re-triggers sync (new boot, other gateway save).
    await sync_providers(db)

    # The admin's choice MUST still be respected.
    row_after_sync = await db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "country_code": "CI", "operator_code": "mtn_ci"}, {"_id": 0}
    )
    assert row_after_sync["status"] == "inactive", (
        f"REGRESSION: sync_providers re-enabled MTN CI (status={row_after_sync['status']}). "
        "Admin toggles are not persistent."
    )

    # Cleanup : re-enable so other tests see a predictable state.
    await toggle_operator(db, "biztranspay", "CI", "mtn_ci", enabled=True)
    row_restored = await db.payment_provider_operators.find_one(
        {"provider_id": "biztranspay", "country_code": "CI", "operator_code": "mtn_ci"}, {"_id": 0}
    )
    assert row_restored["status"] == "active"


@pytest.mark.asyncio
async def test_disable_country_cascades_and_persists(db):
    """Disabling a whole country also propagates to all its operators and
    survives a sync cycle."""
    await sync_providers(db)

    # Disable all of CI.
    ok = await toggle_country(db, "biztranspay", "CI", enabled=False)
    assert ok is True

    # Country + all 4 CI operators now inactive.
    country_row = await db.payment_provider_countries.find_one(
        {"provider_id": "biztranspay", "country_code": "CI"}, {"_id": 0}
    )
    assert country_row["status"] == "inactive"
    ops = [o async for o in db.payment_provider_operators.find(
        {"provider_id": "biztranspay", "country_code": "CI"}, {"_id": 0}
    )]
    assert len(ops) >= 1
    assert all(o["status"] == "inactive" for o in ops), (
        f"Country toggle OFF should cascade to all operators, got {[(o['operator_code'], o['status']) for o in ops]}"
    )

    # Legacy map updated for every operator.
    cfg_doc = await db.app_settings.find_one({"key": "payment_gateway"})
    legacy_ci = (cfg_doc.get("value") or {}).get("biztranspay_countries", {}).get("CI") or {}
    assert all(v is False for v in legacy_ci.values()), (
        f"Legacy map should mirror country-level toggle, got {legacy_ci}"
    )

    # Sync is a no-op on admin-overridden state.
    await sync_providers(db)
    country_row2 = await db.payment_provider_countries.find_one(
        {"provider_id": "biztranspay", "country_code": "CI"}, {"_id": 0}
    )
    ops2 = [o async for o in db.payment_provider_operators.find(
        {"provider_id": "biztranspay", "country_code": "CI"}, {"_id": 0}
    )]
    assert country_row2["status"] == "inactive", "REGRESSION: country re-enabled after sync"
    assert all(o["status"] == "inactive" for o in ops2), (
        "REGRESSION: operators re-enabled after country-level sync"
    )

    # Cleanup.
    await toggle_country(db, "biztranspay", "CI", enabled=True)
