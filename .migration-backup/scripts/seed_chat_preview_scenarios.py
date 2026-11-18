"""Create synthetic private-chat contacts in the isolated Replit preview database."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient


DATABASE_NAME = "spiloveure_local_development"
MONGO_URL = "mongodb://127.0.0.1:27017"
TEST_USERNAME = "preview_test_b02606"
NAMESPACE = uuid.UUID("57de7a67-5056-450f-8d18-1ee4d3b5aa1d")

CONTACTS = [
    ("preview_contact_01", [
        "Merci pour ta réponse ! Tu peux tester les messages et les réactions ici.",
        "J’ai bien reçu ton message. Cette conversation est un profil de démonstration.",
    ]),
    ("preview_contact_02", [
        "Salut ! Je réponds automatiquement pour t’aider à vérifier le chat.",
        "Oui, je suis toujours là. Essaie aussi une réponse à un message.",
    ]),
    ("preview_contact_03", [
        "Bien reçu. Le profil et les messages sont uniquement dans l’aperçu.",
        "Merci ! Tu peux continuer à m’écrire pour tester l’affichage.",
    ]),
    ("preview_contact_04", [
        "Message reçu. Cette réponse automatique vient du contact de test 04.",
        "Parfait, la discussion fonctionne. Tu peux essayer un autre message.",
    ]),
    ("preview_contact_05", [
        "Je t’ai lu. Ce compte sert uniquement à tester SPILOVEURE Chat.",
        "Réponse automatique du contact 05 : je suis prêt pour un autre essai.",
    ]),
]


def stable_id(value: str) -> str:
    return str(uuid.uuid5(NAMESPACE, value))


async def seed() -> None:
    client = AsyncIOMotorClient(MONGO_URL, serverSelectionTimeoutMS=3000)
    try:
        await client.admin.command("ping")
        db = client[DATABASE_NAME]
        target = await db.users.find_one({
            "username": {"$regex": f"^{TEST_USERNAME}$", "$options": "i"},
        })
        if not target or target.get("status") != "active":
            raise RuntimeError("Le compte de test actif n’existe pas dans la base locale.")
        target_id = target["id"]
        stamp = datetime.now(timezone.utc).isoformat()
        expiration = datetime.now(timezone.utc) + timedelta(hours=24)

        for index, (username, replies) in enumerate(CONTACTS, start=1):
            simulator_id = stable_id(f"user:{username}")
            current = await db.users.find_one({"username": username})
            if current and not current.get("preview_auto_responder"):
                raise RuntimeError(f"Le nom de test {username} est déjà utilisé par un autre compte.")
            if current and current.get("id") != simulator_id:
                raise RuntimeError(f"Le contact de test {username} existe déjà avec un identifiant différent.")
            profile = {
                "id": simulator_id,
                "username": username,
                "email": f"{username}@example.test",
                "role": "user",
                "status": "active",
                "email_verified": True,
                "preview_auto_responder": True,
                "preview_auto_replies": replies,
                "profile_photo": "",
                "avatar_url": "",
            }
            await db.users.update_one(
                {"id": simulator_id}, {"$set": profile}, upsert=True,
            )

            for first_id, second_id in ((target_id, simulator_id), (simulator_id, target_id)):
                await db.spv_contacts.update_one(
                    {"user_id": first_id, "peer_id": second_id},
                    {"$set": {"status": "accepted"}}, upsert=True,
                )

            private_key = ":".join(sorted((target_id, simulator_id)))
            conversation_id = stable_id(f"conversation:{private_key}")
            conversation = {
                "id": conversation_id,
                "kind": "private",
                "is_saved": False,
                "title": username,
                "photo": "",
                "members": [target_id, simulator_id],
                "admins": [target_id],
                "owner_id": target_id,
                "created_at": stamp,
                "updated_at": stamp,
                "is_public": False,
                "permissions": {"send_messages": "all", "add_members": False, "edit_info": False},
                "private_key": private_key,
            }
            await db.spv_conversations.update_one(
                {"private_key": private_key},
                {"$setOnInsert": conversation},
                upsert=True,
            )
            await db.spv_preferences.update_one(
                {"user_id": target_id, "conversation_id": conversation_id},
                {"$set": {"archived": False}}, upsert=True,
            )
            greeting_id = stable_id(f"greeting:{conversation_id}")
            await db.spv_messages.update_one(
                {"id": greeting_id},
                {"$setOnInsert": {
                    "id": greeting_id,
                    "conversation_id": conversation_id,
                    "sender_id": simulator_id,
                    "client_id": f"preview-greeting-{index}",
                    "sender_name": username,
                    "text": f"Bonjour ! Je suis {username}, un profil de démonstration. Écris-moi : je répondrai automatiquement.",
                    "attachments": [],
                    "reply_to": None,
                    "forwarded_from": None,
                    "silent": False,
                    "created_at": stamp,
                    "edited_at": None,
                    "deleted": False,
                    "reactions": {},
                    "pinned": False,
                    "read_by": [simulator_id],
                }}, upsert=True,
            )

            status_count = 2 if index == 1 else 1
            for status_number in range(status_count):
                status_id = stable_id(f"status:{username}:{status_number}")
                status = {
                    "id": status_id,
                    "author_id": simulator_id,
                    "sender_id": simulator_id,
                    "author_name": username,
                    "text": (
                        f"Statut de démonstration de @{username}."
                        if status_number == 0
                        else "Deuxième statut : le compteur et le défilement sont testables."
                    ),
                    "attachments": [],
                    "created_at": stamp,
                    "expires_at": expiration,
                    "viewed_by": [target_id] if index % 2 == 0 else [],
                    "liked_by": [],
                }
                await db.spv_statuses.update_one(
                    {"id": status_id}, {"$set": status}, upsert=True,
                )

        print(
            "Aperçu local prêt : 5 contacts synthétiques, 5 conversations privées "
            "et 6 statuts de démonstration. Les contacts ne sont pas des comptes de connexion."
        )
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(seed())
