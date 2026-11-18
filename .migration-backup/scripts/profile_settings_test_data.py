"""Create/clean a private-contact fixture only in the local development database."""
import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def stamp():
    return datetime.now(timezone.utc).isoformat()


async def main():
    data = json.load(sys.stdin)
    owner_id = data["owner_id"]
    peer_id = data["peer_id"]
    conversation_id = data["conversation_id"]
    if not re.fullmatch(r"qa-media-[a-f0-9]{32}", owner_id):
        raise SystemExit("Disposable QA owner required")
    if not re.fullmatch(r"qa-profile-peer-[a-f0-9]{16}", peer_id):
        raise SystemExit("Disposable QA peer required")
    client = AsyncIOMotorClient("mongodb://127.0.0.1:27017")
    db = client["spiloveure_local_development"]
    try:
        if data["mode"] == "seed":
            await db.users.insert_one({
                "id": peer_id, "username": "qa_contact_" + peer_id[-8:],
                "email": peer_id + "@example.com",
                "role": "user", "status": "active", "max_level": 1,
                "profile_photo": "", "avatar_url": "",
            })
            created = stamp()
            await db.spv_contacts.insert_many([
                {"user_id": owner_id, "peer_id": peer_id, "status": "accepted", "created_at": created},
                {"user_id": peer_id, "peer_id": owner_id, "status": "accepted", "created_at": created},
            ])
            await db.spv_conversations.insert_one({
                "id": conversation_id, "kind": "private", "is_saved": False,
                "title": "QA contact", "photo": "", "members": [owner_id, peer_id],
                "admins": [owner_id], "owner_id": owner_id, "private_key": ":".join(sorted([owner_id, peer_id])),
                "created_at": created, "updated_at": created, "is_public": False,
                "permissions": {"send_messages": "all", "add_members": False, "edit_info": False},
                "qa_profile_fixture": owner_id,
            })
        elif data["mode"] == "cleanup":
            await db.spv_chat_lists.delete_many({"owner_id": owner_id})
            await db.spv_messages.delete_many({"conversation_id": conversation_id})
            await db.spv_preferences.delete_many({"conversation_id": conversation_id})
            await db.spv_conversations.delete_many({"id": conversation_id, "qa_profile_fixture": owner_id})
            await db.spv_contacts.delete_many({"$or": [
                {"user_id": owner_id, "peer_id": peer_id},
                {"user_id": peer_id, "peer_id": owner_id},
            ]})
            await db.users.delete_one({"id": peer_id, "username": "qa_contact_" + peer_id[-8:]})
            await db.spv_settings.delete_one({"user_id": owner_id})
        else:
            raise SystemExit("Unknown mode")
    finally:
        client.close()


asyncio.run(main())
