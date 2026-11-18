"""Seed only the isolated local Chat preview account; never touches the VPS."""
import os
import sys
import uuid

from pymongo import MongoClient

DATABASE_NAME = "spiloveure_local_development"
MONGO_URL = "mongodb://127.0.0.1:27017"
USERNAME = "preview_test_b02606"
USER_ID = str(uuid.uuid5(uuid.UUID("57de7a67-5056-450f-8d18-1ee4d3b5aa1d"), "preview-test-account"))

if (
    os.environ.get("SPV_PREVIEW_MODE") != "isolated"
    or os.environ.get("DB_NAME") != DATABASE_NAME
    or os.environ.get("MONGO_URL") != MONGO_URL
):
    raise SystemExit("Refus : le seed du compte exige le mode isolé et MongoDB local.")

client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
try:
    client.admin.command("ping")
    db = client[DATABASE_NAME]
    existing = db.users.find_one({"username": USERNAME})
    if existing and not existing.get("preview_test_account"):
        raise SystemExit(f"Refus : @{USERNAME} existe sans marqueur de compte de démonstration.")
    if existing and existing.get("id") != USER_ID:
        raise SystemExit(f"Refus : @{USERNAME} existe avec un identifiant inattendu.")

    db.users.update_one(
        {"id": USER_ID},
        {"$set": {
            "id": USER_ID,
            "username": USERNAME,
            "email": "preview_test_b02606@example.test",
            "phone": "00000000",
            "country": "TG",
            "role": "user",
            "status": "active",
            "max_level": 1,
            "email_verified": False,
            "preview_test_account": True,
            "profile_photo": "",
            "avatar_url": "",
        }},
        upsert=True,
    )
    print("Compte de démonstration isolé prêt.")
finally:
    client.close()
