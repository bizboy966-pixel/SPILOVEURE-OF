"""Idempotent bootstrap for the deployment's initial administrator."""
from datetime import datetime, timezone
import uuid

from auth import hash_password


async def ensure_bootstrap_admin(db, environment):
    admin_email = environment["ADMIN_EMAIL"].strip().lower()
    existing = await db.users.find_one({"email": admin_email})
    if existing:
        # Credentials changed through the account UI must survive backend
        # restarts. Environment credentials seed only a newly created account.
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {"role": "admin", "status": "active"}},
        )
        return existing["id"]

    admin_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": admin_id,
        "username": environment.get("ADMIN_USERNAME", "admin"),
        "email": admin_email,
        "phone": environment.get("ADMIN_PHONE", "+22890000000"),
        "country": environment.get("ADMIN_COUNTRY", "TG"),
        "password_hash": hash_password(environment["ADMIN_PASSWORD"]),
        "role": "admin",
        "status": "active",
        "max_level": 12,
        "sponsor_id": None,
        "sponsor_username": None,
        "balance_profit": 0,
        "balance_upgrade": 0,
        "commission_direct": 0,
        "commission_spillover": 0,
        "total_earned": 0,
        "total_withdrawn": 0,
        "withdrawals_disabled": False,
        "created_at": datetime.now(timezone.utc),
    })
    for level in range(1, 13):
        await db.matrix_placements.insert_one({
            "user_id": admin_id,
            "level": level,
            "parent_id": None,
            "leg": None,
            "sponsor_id": None,
            "is_spillover": False,
            "created_at": datetime.now(timezone.utc),
        })
    return admin_id
