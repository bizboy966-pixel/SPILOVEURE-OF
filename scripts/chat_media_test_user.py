"""Seed/clean one disposable account, only in the local development database."""
import asyncio
import json
import re
import sys
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from auth import hash_password
from messenger_files import upload_root


async def main():
    data = json.load(sys.stdin)
    uid = data["id"]
    if not re.fullmatch(r"qa-media-[a-f0-9]{32}", uid):
        raise SystemExit("Disposable account id required")
    client = AsyncIOMotorClient("mongodb://127.0.0.1:27017")
    db = client["spiloveure_local_development"]
    try:
        if data["mode"] == "seed":
            await db.users.insert_one({
                "id": uid, "username": uid.replace("-", "_"), "email": uid + "@example.com",
                "password_hash": hash_password(data["password"]), "role": "user",
                "status": "active", "max_level": 1, "auth_flow_version": 2,
                "main_password_created": True, "email_verified": True,
                "email_verified_address": uid + "@example.com", "country": "TG",
                "balance_profit": 0, "balance_upgrade": 0, "total_earned": 0, "total_withdrawn": 0,
            })
        elif data["mode"] == "cleanup":
            owned = await db.spv_conversations.find({"private_key": "saved:" + uid}).to_list(10)
            cids = [c["id"] for c in owned]
            await db.spv_messages.delete_many({"sender_id": uid, "conversation_id": {"$in": cids}})
            await db.spv_conversations.delete_many({"id": {"$in": cids}, "private_key": "saved:" + uid})
            async for row in db.spv_files.find({"owner_id": uid}):
                if re.fullmatch(r"[a-f0-9-]{36}", row["id"]):
                    (upload_root() / row["id"]).unlink(missing_ok=True)
            await db.spv_files.delete_many({"owner_id": uid})
            for name in ("identity_chat_sessions", "spv_socket_tickets", "spv_preferences", "spv_presence"):
                await db[name].delete_many({"user_id": uid})
            await db.users.delete_one({"id": uid})
        else:
            raise SystemExit("Invalid mode")
    finally:
        client.close()

asyncio.run(main())
