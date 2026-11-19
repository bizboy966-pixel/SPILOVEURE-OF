import asyncio
import socket
from pathlib import Path

import pytest
from mongomock_motor import AsyncMongoMockClient

import telegram_moderation as telegram


BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk"


class _TelegramResponse:
    status_code = 200

    def __init__(self, result):
        self.result = result

    def json(self):
        return {"ok": True, "result": self.result}


class _RecordingTelegramClient:
    calls = []
    failing_methods = set()

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, json=None, data=None, files=None):
        method = url.rsplit("/", 1)[-1]
        self.calls.append({"method": method, "json": json, "data": data, "files": files})
        if method in self.failing_methods:
            response = _TelegramResponse({})
            response.status_code = 400
            response.json = lambda: {"ok": False, "description": "Rejected"}
            return response
        return _TelegramResponse({"message_id": len(self.calls)})


def _setup(monkeypatch, tmp_path):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", BOT_TOKEN)
    monkeypatch.setenv("SITE_URL", "https://spiloveure.org")
    monkeypatch.delenv("TELEGRAM_PUBLIC_URL", raising=False)
    monkeypatch.delenv("PUBLIC_APP_URL", raising=False)
    _RecordingTelegramClient.calls = []
    _RecordingTelegramClient.failing_methods = set()
    monkeypatch.setattr(telegram.httpx, "AsyncClient", _RecordingTelegramClient)
    monkeypatch.setattr(telegram, "UPLOADS_DIR", Path(tmp_path))
    db = AsyncMongoMockClient().telegram_media_test
    asyncio.run(telegram._store_config(db, {"notification_chat_id": "-100123"}))
    return db


@pytest.mark.parametrize(
    ("kind", "collection", "item"),
    [
        ("marketplace", "marketplace_listings", {
            "name": "Chaussures", "images": ["/api/uploads/listing.jpg"],
            "seller_username": "vendeur", "category": "Mode", "price": 12000,
            "currency": "FCFA", "city": "Lomé",
        }),
        ("ads", "ads", {
            "title": "Campagne", "cover_image_url": "/api/uploads/cover.jpg",
            "video_url": "/api/uploads/ad.mp4", "username": "annonceur",
            "media_type": "video", "duration_days": 3,
        }),
        ("special_task", "special_tasks", {
            "title": "Tâche vidéo", "videos": ["/api/uploads/task.mp4"],
            "username": "createur", "network": "youtube", "action_type": "video",
            "quantity_target": 20, "price_amount": 500,
        }),
    ],
)
def test_stored_photo_and_video_files_arrive_before_voting(kind, collection, item, monkeypatch, tmp_path):
    db = _setup(monkeypatch, tmp_path)
    for filename in ("listing.jpg", "cover.jpg", "ad.mp4", "task.mp4"):
        (tmp_path / filename).write_bytes(f"bytes:{filename}".encode())
    item.update({"id": "pending-1", "status": "pending_admin_review"})
    asyncio.run(db[collection].insert_one(item))

    assert asyncio.run(telegram.notify_submission(db, kind, "pending-1")) is True

    calls = _RecordingTelegramClient.calls
    media_calls = [call for call in calls if call["method"] in {"sendPhoto", "sendVideo"}]
    vote_message = next(call for call in calls if call["method"] == "sendMessage")
    expected_media_count = 2 if kind == "ads" else 1
    assert len(media_calls) == expected_media_count
    assert all(call["files"] for call in media_calls)
    assert all(call["data"]["chat_id"] == "-100123" for call in media_calls)
    assert all(call["json"] is None for call in media_calls)
    assert calls.index(media_calls[-1]) < calls.index(vote_message)
    assert "reply_markup" in vote_message["json"]
    assert "Valider" in vote_message["json"]["reply_markup"]["inline_keyboard"][0][0]["text"]
    assert {
        "marketplace": "Marketplace",
        "ads": "Publicité",
        "special_task": "Tâche spéciale",
    }[kind] in vote_message["json"]["text"]
    action = asyncio.run(db.telegram_moderation_actions.find_one({"subject_key": f"{kind}:pending-1"}))
    assert action["status"] == "pending"
    assert action["message_id"] == calls.index(vote_message) + 1
    assert action["chat_id"] == "-100123"


def test_first_party_upload_uses_persistent_storage_bytes(monkeypatch, tmp_path):
    db = _setup(monkeypatch, tmp_path)
    import object_storage

    monkeypatch.setattr(object_storage, "is_enabled", lambda: True)
    monkeypatch.setattr(object_storage, "get_upload", lambda _filename: (b"persistent image", "image/jpeg"))
    asyncio.run(db.marketplace_listings.insert_one({
        "id": "persistent-image", "status": "pending_admin_review",
        "name": "Objet", "images": ["/api/uploads/persistent.jpg"],
    }))

    assert asyncio.run(telegram.notify_submission(db, "marketplace", "persistent-image")) is True

    photo = next(call for call in _RecordingTelegramClient.calls if call["method"] == "sendPhoto")
    field_name, file_data = next(iter(photo["files"].items()))
    assert field_name == "photo"
    assert file_data[1] == b"persistent image"
    assert file_data[2] == "image/jpeg"
    assert photo["data"] == {"chat_id": "-100123"}


@pytest.mark.asyncio
async def test_external_media_url_is_only_forwarded_after_public_dns_validation(monkeypatch):
    calls = []

    async def fake_public_check(url):
        calls.append(url)
        return False

    monkeypatch.setattr(telegram, "_external_media_url_is_public", fake_public_check)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", BOT_TOKEN)
    db = AsyncMongoMockClient().telegram_media_external_test
    await telegram._store_config(db, {"notification_chat_id": "-100123"})
    await db.marketplace_listings.insert_one({
        "id": "external-image", "status": "pending_admin_review",
        "name": "Objet", "images": ["https://cdn.example.org/private.jpg"],
    })
    _RecordingTelegramClient.calls = []
    monkeypatch.setattr(telegram.httpx, "AsyncClient", _RecordingTelegramClient)

    assert await telegram.notify_submission(db, "marketplace", "external-image") is True

    assert calls == ["https://cdn.example.org/private.jpg"]
    assert not any(call["method"] == "sendPhoto" for call in _RecordingTelegramClient.calls)
    vote_message = next(call for call in _RecordingTelegramClient.calls if call["method"] == "sendMessage")
    assert "URL non sûre" in vote_message["json"]["text"]
    assert "reply_markup" in vote_message["json"]


def test_external_host_validation_rejects_private_dns_answers(monkeypatch):
    monkeypatch.setattr(
        telegram.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 443)),
        ],
    )
    assert telegram._host_resolves_only_public_ips("cdn.example.org") is False


def test_external_host_validation_accepts_public_dns_answers(monkeypatch):
    monkeypatch.setattr(
        telegram.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
        ],
    )
    assert telegram._host_resolves_only_public_ips("cdn.example.org") is True


def test_missing_media_keeps_vote_buttons_and_explains_failure(monkeypatch, tmp_path):
    db = _setup(monkeypatch, tmp_path)
    asyncio.run(db.ads.insert_one({
        "id": "missing-ad", "status": "pending_admin_review",
        "title": "Vidéo", "video_url": "/api/uploads/missing.mp4",
    }))

    assert asyncio.run(telegram.notify_submission(db, "ads", "missing-ad")) is True

    calls = _RecordingTelegramClient.calls
    assert not any(call["method"] == "sendVideo" for call in calls)
    vote_message = next(call for call in calls if call["method"] == "sendMessage")
    assert "Publicité" in vote_message["json"]["text"]
    assert "fichier inaccessible" in vote_message["json"]["text"]
    assert "reply_markup" in vote_message["json"]
    action = asyncio.run(db.telegram_moderation_actions.find_one({"subject_key": "ads:missing-ad"}))
    assert action["status"] == "pending"


def test_oversized_stored_photo_is_skipped_with_clear_warning(monkeypatch, tmp_path):
    db = _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(
        telegram, "_read_stored_upload",
        lambda _filename: (b"x" * (telegram.MAX_TELEGRAM_PHOTO_BYTES + 1), "image/jpeg"),
    )
    asyncio.run(db.marketplace_listings.insert_one({
        "id": "large-image", "status": "pending_admin_review",
        "name": "Image trop lourde", "images": ["/api/uploads/large.jpg"],
    }))

    assert asyncio.run(telegram.notify_submission(db, "marketplace", "large-image")) is True

    calls = _RecordingTelegramClient.calls
    assert not any(call["method"] == "sendPhoto" for call in calls)
    vote_message = next(call for call in calls if call["method"] == "sendMessage")
    assert "limite de taille Telegram" in vote_message["json"]["text"]
    assert "reply_markup" in vote_message["json"]


def test_external_media_send_failure_does_not_remove_decision_controls(monkeypatch, tmp_path):
    db = _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(telegram, "_external_media_url_is_public", lambda _url: asyncio.sleep(0, result=True))
    _RecordingTelegramClient.failing_methods = {"sendVideo"}
    asyncio.run(db.special_tasks.insert_one({
        "id": "external-video", "status": "pending_admin_review",
        "title": "Vidéo", "videos": ["https://cdn.example.org/task.mp4"],
        "network": "youtube", "action_type": "video",
    }))

    assert asyncio.run(telegram.notify_submission(db, "special_task", "external-video")) is True

    calls = _RecordingTelegramClient.calls
    vote_message = next(call for call in calls if call["method"] == "sendMessage")
    assert "Tâche spéciale" in vote_message["json"]["text"]
    assert "Un ou plusieurs médias" in vote_message["json"]["text"]
    assert "reply_markup" in vote_message["json"]
    action = asyncio.run(db.telegram_moderation_actions.find_one({"subject_key": "special_task:external-video"}))
    assert action["status"] == "pending"
