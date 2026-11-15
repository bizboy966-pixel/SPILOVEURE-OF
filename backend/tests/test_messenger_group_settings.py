import asyncio
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from identity_core import digest, initialize as identity_initialize, now
from messenger import api as messenger_api
from messenger_core import initialize as messenger_initialize


@pytest.fixture
def messenger_app():
    app = FastAPI()
    app.state.db = AsyncMongoMockClient(tz_aware=True).group_settings_tests
    app.include_router(messenger_api)

    async def seed():
        db = app.state.db
        await messenger_initialize(db)
        await identity_initialize(db)
        for uid in ("alice", "bob", "eve"):
            await db.users.insert_one({
                "id": uid, "username": uid.title(), "email": f"{uid}@example.com",
                "role": "user", "status": "active", "max_level": 1,
                "email_verified": True, "email_verified_address": f"{uid}@example.com",
            })
            await db.identity_chat_sessions.insert_one({
                "id": "session_" + uid, "digest": digest("chat_" + uid),
                "user_id": uid, "email_digest": digest(f"{uid}@example.com"),
                "revoked": False, "expires_at": now() + timedelta(days=1),
                "absolute_expires_at": now() + timedelta(days=30), "last_seen": now(),
            })

    asyncio.run(seed())
    with TestClient(app) as client:
        yield client, app.state.db


def call(messenger_app, method, path, uid="alice", **kwargs):
    return getattr(messenger_app[0], method)(
        "/api/messenger" + path,
        headers={"Cookie": "spv_chat_session=chat_" + uid},
        **kwargs,
    )


def create_group(messenger_app):
    response = call(messenger_app, "post", "/conversations", json={
        "kind": "group", "title": "Équipe", "member_ids": ["bob"],
    })
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_group_permissions_control_sending_and_member_invites(messenger_app):
    cid = create_group(messenger_app)
    update = call(messenger_app, "patch", f"/conversations/{cid}", json={
        "permissions": {"send_messages": "admins", "add_members": True, "edit_info": True},
    })
    assert update.status_code == 200, update.text
    assert update.json()["permissions"]["send_messages"] == "admins"

    blocked_send = call(messenger_app, "post", f"/conversations/{cid}/messages", "bob", json={
        "text": "Je ne peux plus envoyer", "client_id": "blocked",
    })
    assert blocked_send.status_code == 403
    allowed_send = call(messenger_app, "post", f"/conversations/{cid}/messages", json={
        "text": "Message administrateur", "client_id": "admin",
    })
    assert allowed_send.status_code == 200

    added = call(messenger_app, "post", f"/conversations/{cid}/members", "bob", json={
        "user_id": "eve", "action": "add",
    })
    assert added.status_code == 200, added.text
    renamed = call(messenger_app, "patch", f"/conversations/{cid}", "bob", json={"title": "Équipe modifiée"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Équipe modifiée"


def test_group_invite_link_joins_members_and_can_be_revoked(messenger_app):
    cid = create_group(messenger_app)
    created = call(messenger_app, "post", f"/conversations/{cid}/invite-link")
    assert created.status_code == 200, created.text
    token = created.json()["token"]
    assert token

    joined = call(messenger_app, "post", f"/invites/{token}/join", "eve")
    assert joined.status_code == 200, joined.text
    assert "eve" in joined.json()["members"]

    revoked = call(messenger_app, "delete", f"/conversations/{cid}/invite-link")
    assert revoked.status_code == 200
    refused = call(messenger_app, "post", f"/invites/{token}/join", "bob")
    assert refused.status_code == 404


def test_members_cannot_invite_without_the_group_permission(messenger_app):
    cid = create_group(messenger_app)
    added = call(messenger_app, "post", f"/conversations/{cid}/members", "bob", json={
        "user_id": "eve", "action": "add",
    })
    link = call(messenger_app, "post", f"/conversations/{cid}/invite-link", "bob")
    assert added.status_code == 403
    assert link.status_code == 403
