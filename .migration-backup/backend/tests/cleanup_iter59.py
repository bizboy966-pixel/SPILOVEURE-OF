"""Post-test cleanup for iteration 59 — removes TEST users created for the
/payments/activate + /pay UI tests (users, matrix nodes, payments)."""
import asyncio

from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient

benv = dotenv_values("/app/backend/.env")
PATTERN = {"$regex": "^test_(ui59|iter59)_"}


async def main():
    db = AsyncIOMotorClient(benv["MONGO_URL"])[benv["DB_NAME"]]
    users = await db.users.find({"email": PATTERN}, {"_id": 0, "id": 1, "email": 1}).to_list(200)
    ids = [u["id"] for u in users]
    print("test users found:", [u["email"] for u in users])
    if ids:
        for coll in ("matrix_nodes", "payments", "notifications", "transactions"):
            try:
                r = await db[coll].delete_many({"user_id": {"$in": ids}})
                print(f"{coll}: deleted {r.deleted_count}")
            except Exception as exc:  # collection may not exist
                print(f"{coll}: skipped ({exc})")
        r = await db.users.delete_many({"id": {"$in": ids}})
        print("users deleted:", r.deleted_count)


asyncio.run(main())
