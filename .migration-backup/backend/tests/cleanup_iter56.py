"""Post-test cleanup + final state assertion for iteration 56."""
import asyncio

from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient

benv = dotenv_values("/app/backend/.env")


async def main():
    db = AsyncIOMotorClient(benv["MONGO_URL"])[benv["DB_NAME"]]
    # leftover support agents created by tests
    r = await db.users.delete_many({"role": "support", "username": {"$regex": "^TESTsup"}})
    print("deleted leftover TEST support agents:", r.deleted_count)
    for k in ("chat_enabled", "chat_message_retention_hours"):
        row = await db.app_settings.find_one({"key": k}, {"_id": 0})
        print(k, "=", row)
    print("chat_messages total:", await db.chat_messages.count_documents({}))


asyncio.run(main())
