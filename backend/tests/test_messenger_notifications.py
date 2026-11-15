"""Notification preferences must not leak previews or affect other users."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from identity_core import digest, initialize as identity_initialize, now
from messenger import api
from messenger_core import initialize
from messenger_notifications import effective_notifications


@pytest.fixture
def chat():
    app = FastAPI()
    app.state.db = AsyncMongoMockClient(tz_aware=True).messenger_notification_tests
    app.include_router(api)

    async def seed():
        db = app.state.db
        await initialize(db)
        await identity_initialize(db)
        for uid in ("alice", "bob", "eve"):
            await db.users.insert_one({
                "id": uid, "username": uid.title(), "email": f"{uid}@example.com",
                "role": "user", "status": "active", "email_verified": True,
                "email_verified_address": f"{uid}@example.com",
            })
            await db.identity_chat_sessions.insert_one({
                "id": uid, "digest": digest("chat_" + uid), "user_id": uid,
                "email_digest": digest(f"{uid}@example.com"), "revoked": False,
                "expires_at": now() + timedelta(days=1),
                "absolute_expires_at": now() + timedelta(days=30), "last_seen": now(),
            })
    asyncio.run(seed())
    with TestClient(app) as client:
        yield client, app.state.db


def call(chat, method, path, uid="alice", **kwargs):
    return getattr(chat[0], method)("/api/messenger" + path,
        headers={"Cookie": "spv_chat_session=chat_" + uid}, **kwargs)


def setup_message(chat, **extra):
    conv = call(chat, "post", "/conversations", json={"kind": "private", "member_ids": ["bob"]}).json()
    sent = call(chat, "post", f"/conversations/{conv['id']}/messages", json={
        "text": "Bonjour Bob", "client_id": "notification-1", **extra,
    })
    assert sent.status_code == 200, sent.text
    return conv["id"], sent.json()["id"]


def test_settings_persist_privately_and_validate_sound(chat):
    assert call(chat, "get", "/notification-settings").json()["sound"] == "default"
    saved = call(chat, "patch", "/notification-settings", json={
        "enabled": False, "preview": False, "sound": "bell",
    })
    assert saved.status_code == 200
    assert call(chat, "get", "/notification-settings").json()["preview"] is False
    assert call(chat, "get", "/notification-settings", "bob").json()["enabled"] is True
    assert call(chat, "patch", "/notification-settings", json={"sound": "invalid"}).status_code == 422
    assert call(chat, "patch", "/notification-settings", json={"sound": "pulse"}).status_code == 200
    legacy = call(chat, "get", "/notification-settings").json()
    assert legacy["sound"] == "pulse"
    assert legacy["sound_private"] == "pulse"
    assert legacy["sound_group"] == "pulse"
    assert call(chat, "patch", "/notification-settings", json={"custom_name": "x" * 121}).status_code == 422
    assert chat[0].get("/api/messenger/notification-settings").status_code == 401


def test_conversation_settings_inherit_override_and_master_off(chat):
    cid, _ = setup_message(chat)
    path = f"/conversations/{cid}/notification-settings"
    call(chat, "patch", "/notification-settings", "bob", json={"sound": "chime"})
    assert call(chat, "get", path, "bob").json()["sound"] == "chime"
    saved = call(chat, "patch", path, "bob", json={"inherit": False, "sound": "bell", "preview": False})
    assert saved.status_code == 200
    assert asyncio.run(effective_notifications(chat[1], "bob", cid))["sound"] == "bell"
    assert call(chat, "get", path, "eve").status_code == 404
    assert call(chat, "patch", path, "eve", json={"enabled": False}).status_code == 404
    call(chat, "patch", "/notification-settings", "bob", json={"enabled": False})
    assert asyncio.run(effective_notifications(chat[1], "bob", cid))["enabled"] is False
    call(chat, "patch", "/notification-settings", "bob", json={"enabled": True})
    call(chat, "patch", f"/conversations/{cid}", "bob", json={"muted": True})
    assert asyncio.run(effective_notifications(chat[1], "bob", cid))["enabled"] is False


def test_private_and_group_sounds_inherit_distinct_defaults(chat):
    private_id, _ = setup_message(chat)
    group = call(chat, "post", "/conversations", json={
        "kind": "group", "member_ids": ["bob"], "title": "Team",
    })
    assert group.status_code == 200, group.text
    group_id = group.json()["id"]

    saved = call(chat, "patch", "/notification-settings", "bob", json={
        "sound_private": "bell", "sound_group": "marimba",
    })
    assert saved.status_code == 200
    assert call(chat, "get", f"/conversations/{private_id}/notification-settings", "bob").json()["sound"] == "bell"
    assert call(chat, "get", f"/conversations/{group_id}/notification-settings", "bob").json()["sound"] == "marimba"

    call(chat, "patch", f"/conversations/{private_id}/notification-settings", "bob", json={
        "inherit": False, "sound": "bright",
    })
    assert asyncio.run(effective_notifications(chat[1], "bob", private_id))["sound"] == "bright"
    call(chat, "patch", f"/conversations/{private_id}/notification-settings", "bob", json={"inherit": True})
    assert asyncio.run(effective_notifications(chat[1], "bob", private_id))["sound"] == "bell"


def test_preview_respects_privacy_mute_and_membership(chat):
    cid, mid = setup_message(chat)
    path = f"/conversations/{cid}/messages/{mid}/notification"
    preview = call(chat, "get", path, "bob")
    assert preview.status_code == 200
    assert preview.json()["title"] == "Alice"
    assert preview.json()["body"] == "Bonjour Bob"
    assert call(chat, "get", path, "eve").status_code == 404
    assert call(chat, "get", path).status_code == 404
    call(chat, "patch", "/notification-settings", "bob", json={"preview": False})
    redacted = call(chat, "get", path, "bob").json()
    assert redacted["title"] == "SPILOVEURE Chat"
    assert "Bonjour" not in redacted["body"]
    assert redacted["avatar"] is None
    call(chat, "patch", f"/conversations/{cid}", "bob", json={"muted": True})
    assert call(chat, "get", path, "bob").json() == {"enabled": False}


def test_silent_deleted_and_blocked_messages_have_no_notification(chat):
    cid, mid = setup_message(chat, silent=True)
    path = f"/conversations/{cid}/messages/{mid}/notification"
    assert call(chat, "get", path, "bob").status_code == 404
    asyncio.run(chat[1].spv_messages.update_one({"id": mid}, {"$set": {"silent": False, "deleted": True}}))
    assert call(chat, "get", path, "bob").status_code == 404
    asyncio.run(chat[1].spv_messages.update_one({"id": mid}, {"$set": {"deleted": False}}))
    call(chat, "post", "/blocks/alice", "bob")
    assert call(chat, "get", path, "bob").status_code in (403, 404)


def test_mark_unread_keeps_real_read_receipts(chat):
    cid, mid = setup_message(chat)
    call(chat, "post", f"/conversations/{cid}/read", "bob")
    assert call(chat, "get", f"/conversations/{cid}", "bob").json()["unread"] == 0
    assert call(chat, "post", f"/conversations/{cid}/unread", "eve").status_code == 404
    assert call(chat, "post", f"/conversations/{cid}/unread", "bob").status_code == 200
    assert call(chat, "get", f"/conversations/{cid}", "bob").json()["unread"] == 1
    assert "bob" in asyncio.run(chat[1].spv_messages.find_one({"id": mid}))["read_by"]
    call(chat, "post", f"/conversations/{cid}/read", "bob")
    assert call(chat, "get", f"/conversations/{cid}", "bob").json()["unread"] == 0


def test_global_notifications_off_suppresses_background_queue(chat):
    call(chat, "patch", "/notification-settings", "bob", json={"enabled": False})
    setup_message(chat)
    assert asyncio.run(chat[1].spv_push_outbox.count_documents({})) == 0


def test_background_send_honors_preview_and_sound(chat, monkeypatch):
    from messenger_delivery import deliver_push_once
    import firebase_admin
    import push_helper
    cid, mid = setup_message(chat)
    call(chat, "patch", "/notification-settings", "bob", json={
        "preview": False, "sound_enabled": False, "sound_private": "marimba",
    })
    asyncio.run(chat[1].push_tokens.insert_one({
        "user_id": "bob", "chat_session_id": "bob", "token": "fake-token",
    }))
    monkeypatch.setattr(firebase_admin, "_apps", {"test": object()})
    sent = []

    async def fake_send(db, tokens, **kwargs):
        sent.append((tokens, kwargs))
        return {"requested": len(tokens), "success": len(tokens), "failure": 0}
    monkeypatch.setattr(push_helper, "_send", fake_send)
    asyncio.run(deliver_push_once(chat[1]))
    assert len(sent) == 1
    assert sent[0][1]["silent"] is True
    assert sent[0][1]["data_only"] is True
    assert sent[0][1]["title"] == "SPILOVEURE Chat"
    assert "Bonjour" not in sent[0][1]["body"]
    assert sent[0][1]["data"]["message_id"] == mid
    assert sent[0][1]["data"]["notification_sound"] == "marimba"
    assert cid in sent[0][1]["link"]
