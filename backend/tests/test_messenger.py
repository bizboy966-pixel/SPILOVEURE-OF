"""Isolated integration tests; never connects to the deployment database."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from auth import create_access_token
from messenger import api
from messenger_core import initialize
from identity_core import initialize as identity_initialize, digest, now
from datetime import timedelta


@pytest.fixture
def chat(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOADS_DIR", str(tmp_path))
    app = FastAPI()
    app.state.db = AsyncMongoMockClient(tz_aware=True).messenger_tests
    app.include_router(api)

    async def seed():
        await initialize(app.state.db)
        await identity_initialize(app.state.db)
        for uid, name in [("alice", "Alice"), ("bob", "Bob"), ("eve", "Eve"), ("pending", "Pending")]:
            await app.state.db.users.insert_one({
                "id": uid, "username": name, "email": uid + "@example.invalid",
                "role": "user", "status": "pending" if uid == "pending" else "active",
                "max_level": 0 if uid == "pending" else 1,
                "balance_profit": 1234,
                "email_verified": True,
                "email_verified_address": uid + "@example.invalid",
            })
            await app.state.db.identity_chat_sessions.insert_one({
                "id": "session_" + uid, "digest": digest("test_chat_" + uid),
                "user_id": uid, "email_digest": digest(uid + "@example.invalid"),
                "revoked": False, "expires_at": now() + timedelta(days=1),
                "absolute_expires_at": now() + timedelta(days=30), "last_seen": now(),
            })
        await app.state.db.chat_messages.insert_one({"id": "legacy", "text": "Support conservé"})
    asyncio.run(seed())
    with TestClient(app) as client:
        yield client, app.state.db


def auth(uid="alice"):
    return {"Cookie": "spv_chat_session=test_chat_" + uid}


def call(chat, method, path, uid="alice", **kwargs):
    return getattr(chat[0], method)("/api/messenger" + path, headers=auth(uid), **kwargs)


def make_admin(chat, uid="alice"):
    asyncio.run(chat[1].users.update_one({"id": uid}, {"$set": {"role": "admin"}}))


def conversation(chat, kind="private", members=None):
    result = call(chat, "post", "/conversations", json={
        "kind": kind, "title": "Équipe SPV", "member_ids": members if members is not None else ["bob"],
    })
    assert result.status_code == 200, result.text
    return result.json()["id"]


def message(chat, cid, uid="alice", client_id="one", **extra):
    return call(chat, "post", f"/conversations/{cid}/messages", uid, json={
        "text": "Bonjour", "client_id": client_id, **extra,
    })


def test_authentication_independent_of_activation(chat):
    assert chat[0].get("/api/messenger/conversations").status_code == 401
    assert call(chat, "get", "/conversations", "pending").status_code == 200
    assert chat[0].get("/api/messenger/conversations", headers={
        "Authorization": "Bearer " + create_access_token("alice", "user"),
    }).status_code == 401
    assert call(chat, "get", "/conversations", "eve").json() == []


def test_create_private_deduplicated_for_both_participants(chat):
    cid = conversation(chat)
    second = call(chat, "post", "/conversations", "bob", json={"kind": "private", "member_ids": ["alice"]})
    assert second.json()["id"] == cid
    assert call(chat, "get", "/conversations", "bob").json()[0]["title"] == "Alice"
    assert call(chat, "get", f"/conversations/{cid}", "eve").status_code == 404


def test_read_receipts_unread_and_idempotency(chat):
    cid = conversation(chat)
    sent = message(chat, cid)
    assert sent.status_code == 200
    assert message(chat, cid).json()["id"] == sent.json()["id"]
    assert len(call(chat, "get", f"/conversations/{cid}/messages").json()["items"]) == 1
    assert call(chat, "get", "/conversations", "bob").json()[0]["unread"] == 1
    assert call(chat, "post", f"/conversations/{cid}/read", "bob").status_code == 200
    assert call(chat, "get", "/conversations", "bob").json()[0]["unread"] == 0
    assert "bob" in call(chat, "get", f"/conversations/{cid}/messages").json()["items"][0]["read_by"]


def test_message_authorization_and_tombstones(chat):
    cid = conversation(chat)
    mid = message(chat, cid).json()["id"]
    path = f"/conversations/{cid}/messages/{mid}"
    assert call(chat, "patch", path, "bob", json={"text": "piraté"}).status_code == 403
    assert call(chat, "delete", path, "bob").status_code == 403
    assert call(chat, "get", f"/conversations/{cid}/messages", "eve").status_code == 404
    assert call(chat, "patch", path, json={"text": "Corrigé"}).json()["edited_at"]
    assert call(chat, "delete", path).status_code == 200
    row = call(chat, "get", f"/conversations/{cid}/messages").json()["items"][0]
    assert row["deleted"] is True and row["text"] == "" and row["attachments"] == []
    assert call(chat, "patch", path, json={"text": "Restauré"}).status_code == 403


def test_reply_cannot_reference_another_conversation(chat):
    first = conversation(chat)
    mid = message(chat, first).json()["id"]
    second = conversation(chat, "group")
    assert message(chat, second, reply_to=mid).status_code == 404


def test_reactions_and_pin(chat):
    cid = conversation(chat)
    mid = message(chat, cid).json()["id"]
    path = f"/conversations/{cid}/messages/{mid}"
    assert call(chat, "post", path + "/reaction", "bob", json={"emoji": "👍"}).json()["reactions"]["👍"] == ["bob"]
    assert call(chat, "post", path + "/reaction", "bob", json={"emoji": "👍"}).json()["reactions"]["👍"] == []
    assert call(chat, "post", path + "/reaction", json={"emoji": "$bad.path"}).status_code == 400
    assert call(chat, "post", path + "/pin").json()["pinned"] is True


def test_history_pagination_and_literal_search(chat):
    cid = conversation(chat)
    for i in range(5):
        assert message(chat, cid, client_id=str(i), text=f"Mot [{i}]").status_code == 200
    newest = call(chat, "get", f"/conversations/{cid}/messages?limit=2").json()
    older = call(chat, "get", f"/conversations/{cid}/messages?limit=2&before=" + newest["items"][0]["id"]).json()
    assert newest["has_more"] is True
    assert set(m["id"] for m in newest["items"]).isdisjoint(m["id"] for m in older["items"])
    assert len(call(chat, "get", f"/conversations/{cid}/messages", params={"q": "[2]"}).json()["items"]) == 1
    assert call(chat, "get", f"/conversations/{cid}/messages?limit=1000").status_code == 422


def test_preferences_are_per_account(chat):
    cid = conversation(chat)
    result = call(chat, "patch", f"/conversations/{cid}", json={
        "muted": True, "archived": True, "pinned": True, "draft": "À terminer",
    })
    assert result.status_code == 200
    assert call(chat, "get", "/conversations").json() == []
    assert call(chat, "get", "/conversations?archived=true").json()[0]["draft"] == "À terminer"
    bob = call(chat, "get", "/conversations", "bob").json()[0]
    assert not bob["muted"] and not bob["archived"] and bob["draft"] == ""


def test_group_roles_members_and_owner_rules(chat):
    cid = conversation(chat, "group")
    root = f"/conversations/{cid}"
    assert call(chat, "post", root + "/members", "bob", json={"user_id": "eve", "action": "add"}).status_code == 403
    assert call(chat, "post", root + "/members", json={"user_id": "bob", "action": "promote"}).status_code == 200
    assert call(chat, "post", root + "/members", "bob", json={"user_id": "eve", "action": "add"}).status_code == 200
    assert call(chat, "post", root + "/members", "bob", json={"user_id": "eve", "action": "promote"}).status_code == 403
    assert call(chat, "post", root + "/leave").status_code == 400
    assert call(chat, "delete", root, "bob").status_code == 403
    assert call(chat, "post", root + "/members", json={"user_id": "bob", "action": "remove"}).status_code == 200
    assert call(chat, "get", root + "/messages", "bob").status_code == 404
    assert call(chat, "delete", root).status_code == 200
    assert call(chat, "get", root, "eve").status_code == 404


def test_channel_subscribers_cannot_publish_or_pin(chat):
    cid = conversation(chat, "channel")
    assert message(chat, cid, "bob").status_code == 403
    mid = message(chat, cid).json()["id"]
    assert call(chat, "post", f"/conversations/{cid}/messages/{mid}/pin", "bob").status_code == 403
    assert call(chat, "get", f"/conversations/{cid}/messages", "bob").status_code == 200


def test_block_prevents_private_send_and_creation(chat):
    cid = conversation(chat)
    assert call(chat, "post", "/blocks/alice", "bob").status_code == 200
    assert message(chat, cid).status_code == 403
    assert call(chat, "post", "/conversations", json={"kind": "private", "member_ids": ["bob"]}).status_code == 403
    assert call(chat, "delete", "/blocks/alice", "bob").status_code == 200
    assert message(chat, cid).status_code == 200


def test_contact_request_accept_and_remove(chat):
    assert call(chat, "post", "/contacts/bob").status_code == 200
    assert call(chat, "get", "/contacts", "bob").json()["requests"][0]["id"] == "alice"
    assert call(chat, "post", "/contacts/alice/accept", "bob").status_code == 200
    assert call(chat, "get", "/contacts").json()["contacts"][0]["id"] == "bob"
    assert call(chat, "get", "/contacts", "bob").json()["contacts"][0]["id"] == "alice"
    assert call(chat, "delete", "/contacts/bob").status_code == 200
    assert call(chat, "get", "/contacts", "bob").json()["contacts"] == []


def test_people_privacy_settings(chat):
    rows = call(chat, "get", "/people?q=bo").json()
    assert rows[0]["id"] == "bob"
    exact_rows = call(chat, "get", "/people?q=SPV%40bOB").json()
    assert [row["id"] for row in exact_rows] == ["bob"]
    assert call(chat, "get", "/people?q=SPV%40eve").json()[0]["id"] == "eve"
    assert not {"email", "phone", "balance_profit"} & rows[0].keys()
    assert call(chat, "get", "/people?q=b").json() == []
    assert call(chat, "patch", "/settings", "bob", json={"allow_contacts": False, "show_presence": False}).status_code == 200
    assert call(chat, "post", "/contacts/bob").status_code == 403
    assert call(chat, "get", "/people?q=bo").json()[0]["last_seen"] is None


def test_files_protected_and_metadata_not_trusted(chat):
    cid = conversation(chat)
    result = call(chat, "post", f"/conversations/{cid}/files",
                  files={"file": ("notes.txt", b"bonjour", "text/plain")})
    assert result.status_code == 200
    file = result.json()
    assert chat[0].get(file["url"]).status_code == 401
    assert chat[0].get(file["url"], headers=auth("eve")).status_code == 404
    assert chat[0].get(file["url"], headers=auth("bob")).status_code == 404  # not sent yet
    spoof = {**file, "url": "https://evil.invalid/file", "mime": "text/html"}
    sent = message(chat, cid, attachments=[spoof])
    assert sent.json()["attachments"][0]["url"] == file["url"]
    assert sent.json()["attachments"][0]["mime"] == "text/plain"
    downloaded = chat[0].get(file["url"], headers=auth("bob"))
    assert downloaded.content == b"bonjour"
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert call(chat, "post", f"/conversations/{cid}/files",
                files={"file": ("evil.html", b"<script/>", "text/html")}).status_code == 400
    assert message(chat, cid, client_id="fake", attachments=[{"id": "missing"}]).status_code == 400


def test_channel_file_upload_permissions(chat):
    cid = conversation(chat, "channel")
    assert call(chat, "post", f"/conversations/{cid}/files", "bob",
                files={"file": ("notes.txt", b"hi")}).status_code == 403


def test_official_feed_comments_reactions_delete(chat):
    make_admin(chat)
    official = call(chat, "post", "/feed", json={"text": "Actualité officielle", "visibility": "contacts"}).json()
    assert official["is_official"] is True
    assert official["visibility"] == "public"
    path = "/feed/" + official["id"]
    assert call(chat, "get", "/feed", "bob").json()[0]["id"] == official["id"]
    assert call(chat, "post", path + "/comments", "bob", json={"text": "Bonjour"}).json()["comments"][0]["username"] == "Bob"
    assert call(chat, "post", path + "/reaction", "bob", json={"emoji": "❤️"}).status_code == 200
    assert call(chat, "delete", path, "bob").status_code == 404
    assert call(chat, "delete", path).status_code == 200


def test_feed_files_visibility(chat):
    make_admin(chat)
    file = call(chat, "post", "/feed/files", files={"file": ("test.txt", b"private")}).json()
    assert chat[0].get(file["url"], headers=auth("bob")).status_code == 404
    call(chat, "post", "/feed", json={"text": "Fichier", "visibility": "public", "attachments": [file]})
    assert chat[0].get(file["url"], headers=auth("bob")).content == b"private"
    call(chat, "post", "/blocks/bob")
    assert chat[0].get(file["url"], headers=auth("bob")).status_code == 200


def test_saved_messages(chat):
    cid = conversation(chat, "saved")
    assert message(chat, cid).status_code == 200
    assert call(chat, "get", f"/conversations/{cid}/messages", "bob").status_code == 404
    assert conversation(chat, "saved") == cid


def test_invalid_or_replayed_socket_ticket(chat):
    value = call(chat, "post", "/socket-ticket").json()["ticket"]
    with chat[0].websocket_connect("/api/messenger/ws?ticket=" + value) as ws:
        ws.send_json({"type": "ping"})
        packets = [ws.receive_json()]
        while packets[-1]["type"] != "pong" and len(packets) < 4:
            packets.append(ws.receive_json())
        assert packets[-1]["type"] == "pong"
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with chat[0].websocket_connect("/api/messenger/ws?ticket=" + value):
            pass


def test_realtime_message_event(chat):
    cid = conversation(chat)
    value = call(chat, "post", "/socket-ticket", "bob").json()["ticket"]
    with chat[0].websocket_connect("/api/messenger/ws?ticket=" + value) as ws:
        sent = message(chat, cid)
        ws.send_json({"type": "ping"})
        events = [ws.receive_json()]
        # First event may be the conversation creation in this same second.
        for _ in range(5):
            if any(e.get("message_id") == sent.json()["id"] for e in events):
                break
            ws.send_json({"type": "ping"})
            events.append(ws.receive_json())
        assert any(e.get("message_id") == sent.json()["id"] for e in events)


def test_reports_rate_and_preserve_existing_data(chat):
    before = asyncio.run(chat[1].users.find({}, {"_id": 0}).to_list(10))
    for _ in range(3):
        assert call(chat, "post", "/reports", json={"user_id": "bob", "reason": "Message abusif"}).status_code == 200
    assert call(chat, "post", "/reports", json={"user_id": "bob", "reason": "Message abusif"}).status_code == 429
    cid = conversation(chat)
    message(chat, cid)
    after = asyncio.run(chat[1].users.find({}, {"_id": 0}).to_list(10))
    assert before == after
    assert asyncio.run(chat[1].chat_messages.find_one({"id": "legacy"}))["text"] == "Support conservé"


def test_read_receipt_does_not_create_event_feedback_loop(chat):
    cid = conversation(chat)
    message(chat, cid)
    call(chat, "post", f"/conversations/{cid}/read", "bob")
    first = asyncio.run(chat[1].spv_events.count_documents({"payload.type": "read"}))
    for _ in range(3):
        call(chat, "post", f"/conversations/{cid}/read", "bob")
    assert asyncio.run(chat[1].spv_events.count_documents({"payload.type": "read"})) == first


def test_discover_and_join_only_public_channels(chat):
    private = conversation(chat, "channel")
    public = call(chat, "post", "/conversations", json={
        "kind": "channel", "title": "Annonces", "is_public": True,
    }).json()["id"]
    rows = call(chat, "get", "/channels", "eve").json()
    assert [row["id"] for row in rows] == [public]
    assert "members" not in rows[0] and rows[0]["joined"] is False
    assert call(chat, "post", f"/channels/{private}/join", "eve").status_code == 404
    assert call(chat, "post", f"/channels/{public}/join", "eve").status_code == 200
    assert call(chat, "post", f"/channels/{public}/join", "eve").json()["members"].count("eve") == 1
    assert call(chat, "get", f"/conversations/{public}/messages", "eve").status_code == 200
    assert message(chat, public, "eve").status_code == 403
    assert call(chat, "post", f"/conversations/{public}/leave", "eve").status_code == 200
    assert call(chat, "get", f"/conversations/{public}/messages", "eve").status_code == 404


def test_only_channel_admin_can_change_discoverability(chat):
    cid = conversation(chat, "channel")
    assert call(chat, "patch", f"/conversations/{cid}", "bob", json={"is_public": True}).status_code == 403
    assert call(chat, "patch", f"/conversations/{cid}", json={"is_public": True}).json()["is_public"] is True
    group = conversation(chat, "group")
    assert call(chat, "patch", f"/conversations/{group}", json={"is_public": True}).status_code == 400


def test_scheduled_message_delivery_and_cancellation(chat):
    from messenger_delivery import deliver_scheduled_once
    cid = conversation(chat)
    future = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    payload = {"text": "Plus tard", "client_id": "scheduled-one", "scheduled_at": future}
    response = call(chat, "post", f"/conversations/{cid}/scheduled", json=payload)
    assert response.status_code == 200
    sid = response.json()["id"]
    assert call(chat, "post", f"/conversations/{cid}/scheduled", json=payload).json()["id"] == sid
    assert call(chat, "get", f"/conversations/{cid}/messages").json()["items"] == []
    assert call(chat, "get", f"/conversations/{cid}/scheduled", "bob").json() == []
    assert asyncio.run(deliver_scheduled_once(chat[1])) is False
    asyncio.run(chat[1].spv_scheduled.update_one({"id": sid}, {"$set": {
        "scheduled_at": (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(),
    }}))
    assert asyncio.run(deliver_scheduled_once(chat[1])) is True
    assert len(call(chat, "get", f"/conversations/{cid}/messages").json()["items"]) == 1
    # Simulate a crash after insert but before acknowledging the scheduled row.
    asyncio.run(chat[1].spv_scheduled.update_one({"id": sid}, {"$set": {"status": "pending"}}))
    assert asyncio.run(deliver_scheduled_once(chat[1])) is True
    assert len(call(chat, "get", f"/conversations/{cid}/messages").json()["items"]) == 1
    other = call(chat, "post", f"/conversations/{cid}/scheduled", json={
        **payload, "client_id": "cancel-me",
    }).json()["id"]
    assert call(chat, "delete", f"/conversations/{cid}/scheduled/{other}", "bob").status_code == 409
    assert call(chat, "delete", f"/conversations/{cid}/scheduled/{other}").status_code == 200


def test_scheduled_message_rechecks_access_at_delivery(chat):
    from messenger_delivery import deliver_scheduled_once
    cid = conversation(chat, "group")
    payload = {
        "text": "Droits retirés", "client_id": "revoked", "scheduled_at":
        (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
    }
    result = call(chat, "post", f"/conversations/{cid}/scheduled", "bob", json=payload)
    assert result.status_code == 200
    call(chat, "post", f"/conversations/{cid}/members", json={"user_id": "bob", "action": "remove"})
    asyncio.run(chat[1].spv_scheduled.update_one({"id": result.json()["id"]}, {"$set": {
        "scheduled_at": (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat(),
    }}))
    asyncio.run(deliver_scheduled_once(chat[1]))
    row = asyncio.run(chat[1].spv_scheduled.find_one({"id": result.json()["id"]}))
    assert row["status"] == "failed"
    assert call(chat, "get", f"/conversations/{cid}/messages").json()["items"] == []


def test_scheduled_validation(chat):
    cid = conversation(chat)
    for invalid in ["2020-01-01T00:00:00+00:00", "2040-01-01T00:00:00+00:00", "2026-12-01T00:00:00"]:
        assert call(chat, "post", f"/conversations/{cid}/scheduled", json={
            "text": "Test", "client_id": "invalid", "scheduled_at": invalid,
        }).status_code == 400


def test_push_suppressed_for_silent_muted_and_online(chat):
    cid = conversation(chat)
    message(chat, cid, silent=True)
    assert asyncio.run(chat[1].spv_push_outbox.count_documents({})) == 0
    call(chat, "patch", f"/conversations/{cid}", "bob", json={"muted": True})
    message(chat, cid, client_id="muted")
    assert asyncio.run(chat[1].spv_push_outbox.count_documents({})) == 0
    call(chat, "patch", f"/conversations/{cid}", "bob", json={"muted": False})
    message(chat, cid, client_id="normal")
    queued = asyncio.run(chat[1].spv_push_outbox.find_one({}))
    assert queued["recipients"] == ["bob"]
    asyncio.run(chat[1].spv_presence.insert_one({"user_id": "bob", "last_seen": datetime.now(timezone.utc).isoformat()}))
    message(chat, cid, client_id="online")
    assert asyncio.run(chat[1].spv_push_outbox.count_documents({})) == 1


def test_audio_webm_metadata_and_revoked_download(chat):
    cid = conversation(chat, "group")
    file = call(chat, "post", f"/conversations/{cid}/files",
                files={"file": ("voice.webm", b"test-audio-container", "audio/webm")}).json()
    assert file["mime"] == "audio/webm"
    message(chat, cid, attachments=[file])
    call(chat, "post", f"/conversations/{cid}/members", json={"user_id": "bob", "action": "remove"})
    assert chat[0].get(file["url"], headers=auth("bob")).status_code == 404
