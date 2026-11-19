import asyncio
import hashlib
import hmac
import logging
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

import telegram_moderation as telegram
from auth import require_admin


BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk"
REPLACEMENT_BOT_TOKEN = "987654321:abcdefghijklmnopqrstuvwxyzABCDEFGH"
STRONG_SESSION_SECRET = "telegram-settings-test-secret-long-enough"


class _TelegramResponse:
    status_code = 200

    def __init__(self, result):
        self.result = result

    def json(self):
        return {"ok": True, "result": self.result}


class _MockTelegramClient:
    calls = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, json):
        self.calls.append((url, json))
        method = url.rsplit("/", 1)[-1]
        result = {
            "getMe": {"id": 123, "is_bot": True, "first_name": "SPILOVEURE", "username": "spiloveure_bot"},
            "getWebhookInfo": {"url": "https://spiloveure.example/api/webhooks/telegram"},
            "setWebhook": True,
            "sendMessage": {"message_id": 456},
        }.get(method, {})
        return _TelegramResponse(result)


def _test_client(monkeypatch):
    db = AsyncMongoMockClient().telegram_admin_test
    app = FastAPI()
    app.state.db = db
    app.dependency_overrides[require_admin] = lambda: {"id": "admin", "role": "admin"}
    app.include_router(telegram.admin)
    app.include_router(telegram.webhook)
    _MockTelegramClient.calls = []
    monkeypatch.setattr(telegram.httpx, "AsyncClient", _MockTelegramClient)
    return TestClient(app), db


def test_admin_token_lifecycle_encrypts_secret_and_verifies_with_telegram(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", STRONG_SESSION_SECRET)
    monkeypatch.setenv("TELEGRAM_PUBLIC_URL", "https://spiloveure.example")
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    client, db = _test_client(monkeypatch)

    saved = client.post("/api/admin/telegram-bot/token", json={"token": BOT_TOKEN})
    assert saved.status_code == 200
    assert BOT_TOKEN not in saved.text
    stored = asyncio.run(db.app_settings.find_one({"key": telegram.TOKEN_SETTINGS_KEY}))
    encrypted = stored["value"]["token_enc"]
    assert BOT_TOKEN not in encrypted
    assert asyncio.run(telegram._token(db)) == BOT_TOKEN
    asyncio.run(telegram._store_config(db, {"group_chat_id": "-10042", "group_title": "SPILOVEURE"}))
    asyncio.run(db.marketplace_listings.insert_one({
        "id": "listing-1", "name": "Annonce", "seller_username": "seller",
        "status": "pending_admin_review",
    }))
    assert asyncio.run(telegram.notify_submission(db, "marketplace", "listing-1")) is True
    assert any(f"/bot{BOT_TOKEN}/sendMessage" in url for url, _payload in _MockTelegramClient.calls)

    status = client.get("/api/admin/telegram-bot")
    assert status.status_code == 200
    assert status.json()["token_configured"] is True
    assert status.json()["token_source"] == "admin"
    assert BOT_TOKEN not in status.text

    verified = client.post("/api/admin/telegram-bot/verify", json={})
    assert verified.status_code == 200
    assert verified.json()["bot_username"] == "spiloveure_bot"
    assert verified.json()["webhook_configured"] is True
    assert BOT_TOKEN not in verified.text

    configured = client.post("/api/admin/telegram-bot/configure", json={})
    assert configured.status_code == 200
    assert BOT_TOKEN not in configured.text
    set_webhook = next(payload for url, payload in _MockTelegramClient.calls if url.endswith("/setWebhook"))
    assert set_webhook["secret_token"] == hmac.new(
        BOT_TOKEN.encode(), b"spiloveure-telegram-webhook", hashlib.sha256,
    ).hexdigest()
    assert BOT_TOKEN not in repr(set_webhook)


def test_webhook_uses_saved_token_and_rejects_old_or_missing_secret(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", STRONG_SESSION_SECRET)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    client, _db = _test_client(monkeypatch)
    assert client.post("/api/admin/telegram-bot/token", json={"token": BOT_TOKEN}).status_code == 200
    webhook_secret = telegram._webhook_secret(BOT_TOKEN)

    accepted = client.post(
        "/api/webhooks/telegram",
        json={"update_id": 7},
        headers={"X-Telegram-Bot-Api-Secret-Token": webhook_secret},
    )
    assert accepted.status_code == 200
    assert accepted.json() == {"ok": True}
    rejected = client.post("/api/webhooks/telegram", json={"update_id": 8})
    assert rejected.status_code == 401
    old_secret = client.post(
        "/api/webhooks/telegram",
        json={"update_id": 9},
        headers={"X-Telegram-Bot-Api-Secret-Token": telegram._webhook_secret("old-token")},
    )
    assert old_secret.status_code == 401


def test_replacing_token_invalidates_old_webhook_secret_and_bot_status(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", STRONG_SESSION_SECRET)
    monkeypatch.setenv("TELEGRAM_PUBLIC_URL", "https://spiloveure.example")
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    client, _db = _test_client(monkeypatch)
    assert client.post("/api/admin/telegram-bot/token", json={"token": BOT_TOKEN}).status_code == 200
    assert client.post("/api/admin/telegram-bot/configure", json={}).status_code == 200

    replaced = client.post(
        "/api/admin/telegram-bot/token",
        json={"token": REPLACEMENT_BOT_TOKEN},
    )
    assert replaced.status_code == 200
    assert REPLACEMENT_BOT_TOKEN not in replaced.text
    status = client.get("/api/admin/telegram-bot").json()
    assert status["token_configured"] is True
    assert status["bot_verified"] is False
    assert status["webhook_configured"] is False

    old_secret = client.post(
        "/api/webhooks/telegram",
        json={"update_id": 10},
        headers={"X-Telegram-Bot-Api-Secret-Token": telegram._webhook_secret(BOT_TOKEN)},
    )
    new_secret = client.post(
        "/api/webhooks/telegram",
        json={"update_id": 11},
        headers={"X-Telegram-Bot-Api-Secret-Token": telegram._webhook_secret(REPLACEMENT_BOT_TOKEN)},
    )
    assert old_secret.status_code == 401
    assert new_secret.status_code == 200


def test_environment_token_remains_a_compatibility_fallback(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", STRONG_SESSION_SECRET)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", BOT_TOKEN)
    client, db = _test_client(monkeypatch)
    status = client.get("/api/admin/telegram-bot")
    assert status.status_code == 200
    assert status.json()["token_configured"] is True
    assert status.json()["token_source"] == "environment"
    assert asyncio.run(telegram._token(db)) == BOT_TOKEN
    assert BOT_TOKEN not in status.text


def test_invalid_token_is_not_echoed_and_log_filter_redacts_bot_urls():
    app = FastAPI()
    app.state.db = AsyncMongoMockClient().telegram_invalid_test
    app.dependency_overrides[require_admin] = lambda: {"id": "admin", "role": "admin"}
    app.include_router(telegram.admin)
    response = TestClient(app).post("/api/admin/telegram-bot/token", json={"token": "not-a-token"})
    assert response.status_code == 400
    assert "not-a-token" not in response.text

    record = logging.LogRecord(
        "httpx", logging.INFO, "", 0,
        f'HTTP Request: POST https://api.telegram.org/bot{BOT_TOKEN}/getMe "HTTP/1.1 200 OK"',
        (), None,
    )
    telegram._TelegramPrivacyFilter().filter(record)
    assert BOT_TOKEN not in record.getMessage()


def test_telegram_api_rejection_never_echoes_token_in_response_or_logs(monkeypatch, caplog):
    monkeypatch.setenv("SESSION_SECRET", STRONG_SESSION_SECRET)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    client, _db = _test_client(monkeypatch)
    assert client.post("/api/admin/telegram-bot/token", json={"token": BOT_TOKEN}).status_code == 200

    class _RejectedClient(_MockTelegramClient):
        async def post(self, url, json):
            self.calls.append((url, json))
            return SimpleNamespace(
                status_code=401,
                json=lambda: {"ok": False, "description": BOT_TOKEN},
            )

    monkeypatch.setattr(telegram.httpx, "AsyncClient", _RejectedClient)
    with caplog.at_level(logging.WARNING, logger="telegram_moderation"):
        response = client.post("/api/admin/telegram-bot/verify", json={})
    assert response.status_code == 502
    assert BOT_TOKEN not in response.text
    assert BOT_TOKEN not in caplog.text
