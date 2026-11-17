from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import messenger_core
import messenger_files


class FileCollection:
    def __init__(self, rows=None):
        self.rows = {row["id"]: dict(row) for row in (rows or [])}

    def find(self, query, projection=None):
        class Cursor:
            async def to_list(self, limit):
                return []
        return Cursor()

    async def insert_one(self, row):
        self.rows[row["id"]] = dict(row)

    async def find_one(self, query):
        row = self.rows.get(query.get("id"))
        if row is None:
            return None
        for key, value in query.items():
            if key != "id" and row.get(key) != value:
                return None
        return dict(row)

    async def update_one(self, query, update):
        row = self.rows.get(query.get("id"))
        if row is None:
            return SimpleNamespace(modified_count=0)
        for key, value in query.items():
            if key == "id":
                continue
            if isinstance(value, dict) and "$ne" in value:
                if value["$ne"] in (row.get(key) or []):
                    return SimpleNamespace(modified_count=0)
            elif row.get(key) != value:
                return SimpleNamespace(modified_count=0)
        row.update(update.get("$set", {}))
        for key, value in update.get("$addToSet", {}).items():
            row.setdefault(key, [])
            if value not in row[key]:
                row[key].append(value)
        for key in update.get("$unset", {}):
            row.pop(key, None)
        return SimpleNamespace(modified_count=1)

    async def delete_one(self, query):
        if query.get("id") in self.rows:
            del self.rows[query["id"]]


class FakeDB:
    def __init__(self, rows=None):
        self.spv_files = FileCollection(rows)


def _request(db):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))


@pytest.mark.asyncio
async def test_upload_intent_records_pending_metadata_and_returns_direct_put(monkeypatch):
    db = FakeDB()
    user = {"id": "user-1"}
    monkeypatch.setattr(messenger_files, "_daily_quota", _quota)
    monkeypatch.setattr(messenger_files, "identifier", lambda: "file-1")
    monkeypatch.setattr(messenger_files.r2, "create_upload_url", lambda *args: "https://r2.example/put")

    ticket = await messenger_files._create_upload(
        _request(db), user, "conversation-1",
        messenger_files.UploadIntent(name="photo.png", size=12, mime="image/png"),
    )

    assert ticket == {
        "id": "file-1",
        "upload_url": "https://r2.example/put",
        "method": "PUT",
        "headers": {"Content-Type": "image/png"},
        "expires_in": messenger_files.UPLOAD_URL_TTL_SECONDS,
    }
    row = db.spv_files.rows["file-1"]
    assert row["status"] == "pending"
    assert row["storage_backend"] == "r2"
    assert row["storage_key"] == "messenger/file-1"
    assert row["scope"] == "conversation-1"
    assert row["reserved_size"] == 12
    assert row.get("view_once") is not True


async def _quota(_db, _owner_id):
    return messenger_files.MAX_DAILY, 0


@pytest.mark.asyncio
async def test_complete_upload_checks_r2_object_before_marking_ready(monkeypatch):
    db = FakeDB([{
        "id": "file-1", "owner_id": "user-1", "scope": "conversation-1",
        "name": "photo.png", "mime": "image/png", "url": "/api/messenger/files/file-1",
        "size": 12, "reserved_size": 12, "storage_backend": "r2", "status": "pending",
        "pending_until": datetime.now(timezone.utc) + timedelta(minutes=10),
    }])
    monkeypatch.setattr(messenger_files.r2, "head_upload", lambda _fid: {
        "ContentLength": 12, "ContentType": "image/png",
    })

    attachment = await messenger_files._complete_upload(_request(db), {"id": "user-1"}, "file-1")

    assert attachment == {
        "id": "file-1", "name": "photo.png", "mime": "image/png",
        "size": 12, "url": "/api/messenger/files/file-1",
    }
    assert db.spv_files.rows["file-1"]["status"] == "ready"
    assert "pending_until" not in db.spv_files.rows["file-1"]


@pytest.mark.asyncio
async def test_complete_upload_rejects_size_or_type_mismatch(monkeypatch):
    db = FakeDB([{
        "id": "file-1", "owner_id": "user-1", "scope": "conversation-1",
        "name": "photo.png", "mime": "image/png", "url": "/api/messenger/files/file-1",
        "size": 12, "reserved_size": 12, "storage_backend": "r2", "status": "pending",
        "pending_until": datetime.now(timezone.utc) + timedelta(minutes=10),
    }])
    deleted = []
    monkeypatch.setattr(messenger_files.r2, "head_upload", lambda _fid: {
        "ContentLength": 12, "ContentType": "image/jpeg",
    })
    monkeypatch.setattr(messenger_files.r2, "delete_upload", lambda fid: deleted.append(fid))

    with pytest.raises(HTTPException) as caught:
        await messenger_files._complete_upload(_request(db), {"id": "user-1"}, "file-1")

    assert caught.value.status_code == 400
    assert deleted == ["file-1"]
    assert "file-1" not in db.spv_files.rows


@pytest.mark.asyncio
async def test_attachments_cannot_be_sent_until_upload_is_ready(monkeypatch):
    class PendingFileCollection:
        async def find_one(self, _query):
            return {"id": "file-1", "owner_id": "user-1", "scope": "conversation-1", "status": "pending"}

    db = SimpleNamespace(spv_files=PendingFileCollection())
    supplied = [SimpleNamespace(id="file-1")]

    with pytest.raises(HTTPException) as caught:
        await messenger_core.attachments_checked(db, supplied, {"id": "user-1"}, "conversation-1")

    assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_view_once_url_check_does_not_consume_until_file_is_opened(monkeypatch):
    row = {
        "id": "voice-1", "owner_id": "sender", "scope": "conversation-1",
        "view_once": True, "view_once_opened_by": [], "status": "ready",
    }
    db = SimpleNamespace(
        spv_files=FileCollection([row]),
        spv_stickers=SimpleNamespace(find_one=_none),
        spv_sticker_pack_items=SimpleNamespace(find_one=_none),
        spv_messages=SimpleNamespace(find_one=_message_reference),
    )

    async def allow_member(*_args):
        return {"id": "conversation-1"}

    monkeypatch.setattr(messenger_files, "member", allow_member)
    user = {"id": "recipient"}

    await messenger_files._authorized_file(db, "voice-1", user)
    assert db.spv_files.rows["voice-1"]["view_once_opened_by"] == []

    await messenger_files._authorized_file(db, "voice-1", user, consume_view_once=True)
    assert db.spv_files.rows["voice-1"]["view_once_opened_by"] == ["recipient"]
    with pytest.raises(HTTPException) as caught:
        await messenger_files._authorized_file(db, "voice-1", user, consume_view_once=True)
    assert caught.value.status_code == 410


async def _none(_query):
    return None


async def _message_reference(_query, projection=None):
    return {"id": "message-1"}
