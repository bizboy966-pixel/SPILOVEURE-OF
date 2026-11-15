import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from identity_core import digest, initialize as identity_initialize, now
from messenger import api as messenger_api
from messenger_core import initialize as messenger_initialize
from messenger_files import api as files_api
from messenger_social import api as social_api


@pytest.fixture
def messenger_app(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOADS_DIR", str(tmp_path))
    app = FastAPI()
    app.state.db = AsyncMongoMockClient(tz_aware=True).messenger_status_tests
    app.include_router(messenger_api)
    app.include_router(files_api, prefix="/api/messenger")
    app.include_router(social_api, prefix="/api/messenger")

    async def seed():
        db = app.state.db
        await messenger_initialize(db)
        await identity_initialize(db)
        for uid, name in [("alice", "Alice"), ("bob", "Bob"), ("eve", "Eve")]:
            await db.users.insert_one({
                "id": uid, "username": name, "email": f"{uid}@example.com",
                "role": "user", "status": "active", "max_level": 1,
                "email_verified": True, "email_verified_address": f"{uid}@example.com",
            })
            await db.identity_chat_sessions.insert_one({
                "id": "session_" + uid, "digest": digest("chat_" + uid),
                "user_id": uid, "email_digest": digest(f"{uid}@example.com"),
                "revoked": False, "expires_at": now() + timedelta(days=1),
                "absolute_expires_at": now() + timedelta(days=30), "last_seen": now(),
            })
        for first, second in [("alice", "bob"), ("bob", "alice")]:
            await db.spv_contacts.insert_one({
                "user_id": first, "peer_id": second, "status": "accepted",
            })

    asyncio.run(seed())
    with TestClient(app) as client:
        yield client, app.state.db


def call(messenger_app, method, path, uid="alice", **kwargs):
    client = messenger_app[0]
    return getattr(client, method)(
        "/api/messenger" + path,
        headers={"Cookie": "spv_chat_session=chat_" + uid},
        **kwargs,
    )


def test_saved_messages_is_a_private_self_conversation(messenger_app):
    response = call(messenger_app, "post", "/conversations", json={"kind": "saved"})
    assert response.status_code == 200, response.text
    conversation = response.json()
    assert conversation["kind"] == "private"
    assert conversation["is_saved"] is True
    assert conversation["title"] == "Messages enregistrés"
    assert conversation["members"] == ["alice"]


def test_statuses_are_contact_only_expire_and_track_views(messenger_app):
    published = call(messenger_app, "post", "/statuses", json={"text": "Bonjour les contacts"})
    assert published.status_code == 200, published.text
    status = published.json()
    assert status["expires_at"] > status["created_at"]

    for uid in ("alice", "bob"):
        response = call(messenger_app, "get", "/statuses", uid)
        assert response.status_code == 200
        assert status["id"] in {row["id"] for row in response.json()}
    assert call(messenger_app, "get", "/statuses", "eve").json() == []
    assert call(messenger_app, "post", f"/statuses/{status['id']}/view", "eve").status_code == 404
    assert call(messenger_app, "post", f"/statuses/{status['id']}/view", "bob").status_code == 200
    own = call(messenger_app, "get", "/statuses").json()[0]
    assert own["views_count"] == 1
    assert "bob" in own["viewed_by"]

    asyncio.run(messenger_app[1].spv_statuses.insert_one({
        "id": "expired", "author_id": "alice", "author_name": "Alice",
        "text": "Ancien statut", "attachments": [], "viewed_by": [],
        "created_at": now(), "expires_at": datetime.now(timezone.utc) - timedelta(seconds=1),
    }))
    assert "expired" not in {row["id"] for row in call(messenger_app, "get", "/statuses").json()}


def test_chat_profile_photo_can_be_updated_in_chat_session(messenger_app):
    pixel_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4n8AAAAASUVORK5CYII="
    response = call(messenger_app, "post", "/profile-photo", json={"data": f"data:image/png;base64,{pixel_png}"})
    assert response.status_code == 200, response.text
    stored = asyncio.run(messenger_app[1].users.find_one({"id": "alice"}))
    assert stored["profile_photo"] == response.json()["profile_photo"]


def test_contact_can_open_status_media_but_noncontact_cannot(messenger_app):
    uploaded = call(
        messenger_app, "post", "/feed/files",
        files={"file": ("status.png", b"\x89PNG\r\n\x1a\nstatus-image", "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    attachment = uploaded.json()
    published = call(messenger_app, "post", "/statuses", json={
        "text": "Photo de statut", "attachments": [attachment],
    })
    assert published.status_code == 200, published.text
    file_path = f"/files/{attachment['id']}"
    assert call(messenger_app, "get", file_path, "bob").status_code == 200
    assert call(messenger_app, "get", file_path, "eve").status_code == 404
