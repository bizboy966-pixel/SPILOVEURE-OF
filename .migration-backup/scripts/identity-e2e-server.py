"""Isolated browser-test server. Never imported by the application or deployed backend.

Mail is captured in a private test file, not sent. Payment confirmation is
simulated only by the --activate command against a disposable local test DB.
"""
import json
import os
import re
import secrets
import sys
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
name = os.environ.get("DB_NAME", "")
if not re.fullmatch(r"spiloveure_identity_e2e_[a-zA-Z0-9_]+", name):
    raise SystemExit("Disposable identity test database required.")
if os.environ.get("MONGO_URL") != "mongodb://127.0.0.1:27017":
    raise SystemExit("Loopback test MongoDB required.")

if len(sys.argv) > 1:
    from pymongo import MongoClient
    mongo = MongoClient(os.environ["MONGO_URL"])
    if sys.argv[1] == "--cleanup":
        mongo.drop_database(name)
    elif sys.argv[1] == "--activate" and re.fullmatch(r"e2e_[0-9]+@example.com", sys.argv[2]):
        result = mongo[name].users.update_one(
            {"email": sys.argv[2], "auth_flow_version": 2},
            {"$set": {"status": "active", "max_level": 1}},
        )
        if result.matched_count != 1:
            raise SystemExit("Test account not found.")
    else:
        raise SystemExit("Invalid test command.")
    mongo.close()
    raise SystemExit(0)

os.environ["JWT_SECRET"] = secrets.token_urlsafe(48)
os.environ["ADMIN_PASSWORD"] = secrets.token_urlsafe(30)
os.environ["UPLOADS_DIR"] = str(Path(os.environ["IDENTITY_TEST_OUTBOX"]).parent / "uploads")
from motor.motor_asyncio import AsyncIOMotorClient
from server import app
from auth import hash_password
from identity_core import initialize
from messenger_core import initialize as initialize_chat


class TestMailbox:
    def configured(self):
        return True

    def send_verification(self, recipient, code):
        descriptor = os.open(os.environ["IDENTITY_TEST_OUTBOX"], os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "a") as stream:
            stream.write(json.dumps({"recipient": recipient, "code": code}) + "\n")


@asynccontextmanager
async def test_lifespan(application):
    client = AsyncIOMotorClient(os.environ["MONGO_URL"], tz_aware=True)
    application.state.mongo = client
    application.state.db = client[name]
    application.state.email_sender = TestMailbox()
    await initialize(application.state.db)
    await initialize_chat(application.state.db)
    await application.state.db.users.insert_one({
        "id": "e2e_sponsor", "username": "E2E_SPONSOR", "email": "sponsor@example.com",
        "country": "TG", "phone": "+22890000000", "role": "user", "status": "active",
        "max_level": 1, "password_hash": hash_password(os.environ["IDENTITY_TEST_PASSWORD"]),
    })
    yield
    client.close()


app.router.lifespan_context = test_lifespan
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8002, log_level="warning", access_log=False)
