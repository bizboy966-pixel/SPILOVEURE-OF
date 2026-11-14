"""Create two explicitly named test accounts in the isolated local DB only."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from auth import hash_password

if os.environ.get("DB_NAME") != "spiloveure_local_development" or os.environ.get("MONGO_URL") != "mongodb://127.0.0.1:27017":
    raise SystemExit("Local test database required.")
data = json.load(sys.stdin)
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
for name in ("alice", "bob"):
    uid = "messenger_test_" + name
    db.users.update_one({"id": uid}, {"$set": {
        "id": uid, "username": uid, "email": uid + "@example.com",
        "password_hash": hash_password(data["password"]), "phone": "00000000",
        "country": "TG", "role": "user", "status": "active", "max_level": 1,
        "email_verified": True,
        "email_verified_address": uid + "@example.com",
        "balance_profit": 0, "balance_upgrade": 0, "commission_direct": 0,
        "commission_spillover": 0, "total_earned": 0, "total_withdrawn": 0,
        "created_at": datetime.now(timezone.utc),
    }}, upsert=True)
