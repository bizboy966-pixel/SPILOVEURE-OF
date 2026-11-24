"""Bootstrap admin credentials are initialized once, not reset every boot."""
import asyncio

from auth import hash_password, verify_password
from mongomock_motor import AsyncMongoMockClient

from admin_bootstrap import ensure_bootstrap_admin


def run(awaitable):
    return asyncio.run(awaitable)


def test_existing_admin_password_survives_repeated_startup():
    db = AsyncMongoMockClient(tz_aware=True).bootstrap_tests
    app_password = "ChangedInsideApp_9!"
    environment = {
        "ADMIN_EMAIL": "admin@example.test",
        "ADMIN_PASSWORD": "BootstrapSeed_9!",
    }

    async def exercise():
        await db.users.insert_one({
            "id": "admin-1",
            "email": environment["ADMIN_EMAIL"],
            "username": "Admin",
            "password_hash": hash_password(app_password),
            "role": "user",
            "status": "active",
        })
        before = await db.users.find_one({"id": "admin-1"})
        await ensure_bootstrap_admin(db, environment)
        await ensure_bootstrap_admin(db, environment)
        after = await db.users.find_one({"id": "admin-1"})
        return before, after

    before, after = run(exercise())
    assert verify_password(app_password, after["password_hash"])
    assert not verify_password(environment["ADMIN_PASSWORD"], after["password_hash"])
    assert after["password_hash"] == before["password_hash"]
    assert after["role"] == "admin"


def test_new_admin_is_created_with_environment_password_and_matrix_root():
    db = AsyncMongoMockClient(tz_aware=True).bootstrap_tests
    environment = {
        "ADMIN_EMAIL": "new-admin@example.test",
        "ADMIN_PASSWORD": "InitialAdmin_9!",
        "ADMIN_USERNAME": "RootAdmin",
    }

    async def exercise():
        admin_id = await ensure_bootstrap_admin(db, environment)
        user = await db.users.find_one({"id": admin_id})
        placements = await db.matrix_placements.count_documents({"user_id": admin_id})
        return user, placements

    user, placements = run(exercise())
    assert verify_password(environment["ADMIN_PASSWORD"], user["password_hash"])
    assert user["role"] == "admin"
    assert placements == 12
