"""Regression tests for durable local uploads and pre-deploy migration."""
from __future__ import annotations

import importlib.util
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import digital_content
import activation_videos
import ads
from upload_delivery import serve_uploaded_file
from upload_paths import write_upload


def _load_migration_script():
    script = Path(__file__).resolve().parents[2] / "deploy" / "hostinger" / "migrate-uploads.py"
    spec = importlib.util.spec_from_file_location("hostinger_migrate_uploads", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeMediaUploads:
    def __init__(self):
        self.rows = []

    async def insert_one(self, row):
        self.rows.append(dict(row))


class FakeActivationVideos:
    def __init__(self):
        self.rows = []

    async def find_one(self, *_args, **_kwargs):
        return None

    async def insert_one(self, row):
        self.rows.append(dict(row))


class DisabledStorage:
    def is_enabled(self):
        return False


def test_write_upload_creates_file_atomically_without_overwriting(tmp_path):
    saved = write_upload("media.jpg", b"first", tmp_path)

    assert saved.read_bytes() == b"first"
    with pytest.raises(FileExistsError):
        write_upload("media.jpg", b"replacement", tmp_path)
    assert saved.read_bytes() == b"first"
    assert not list(tmp_path.glob("*.uploading"))


def test_upload_route_reads_the_configured_persistent_volume(tmp_path, monkeypatch):
    persistent = tmp_path / "volume"
    persistent.mkdir()
    (persistent / "listing.mp4").write_bytes(b"persistent-media")
    monkeypatch.setenv("UPLOADS_DIR", str(persistent))
    app = FastAPI()

    @app.get("/api/uploads/{filename}")
    async def download(filename: str):
        return serve_uploaded_file(filename, tmp_path / "legacy", DisabledStorage())

    response = TestClient(app).get("/api/uploads/listing.mp4")

    assert response.status_code == 200
    assert response.content == b"persistent-media"


@pytest.mark.asyncio
async def test_admin_upload_survives_new_app_instance(tmp_path, monkeypatch):
    import object_storage

    monkeypatch.setattr(digital_content, "UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(object_storage, "is_enabled", lambda: False)
    media_rows = FakeMediaUploads()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db=SimpleNamespace(media_uploads=media_rows)))
    )
    payload = b"\xff\xd8\xffpersistent-image"
    upload = UploadFile(
        filename="listing.jpg",
        file=BytesIO(payload),
        headers=Headers({"content-type": "image/jpeg"}),
    )

    result = await digital_content.admin_upload_file(
        request, upload, admin={"username": "admin"},
    )

    assert result["storage_ok"] is True
    assert result["local_storage_ok"] is True
    assert result["object_storage_ok"] is False
    filename = result["url"].rsplit("/", 1)[-1]

    # A separate app instance simulates a backend container recreated while
    # the named Docker volume remains mounted at the same path.
    app_after_restart = FastAPI()

    @app_after_restart.get("/api/uploads/{requested_filename}")
    async def download(requested_filename: str):
        return serve_uploaded_file(requested_filename, tmp_path, DisabledStorage())

    response = TestClient(app_after_restart).get(result["url"])
    assert response.status_code == 200
    assert response.content == payload
    assert media_rows.rows[0]["stored_as"] == filename


@pytest.mark.asyncio
async def test_admin_upload_fails_if_no_durable_storage_succeeds(tmp_path, monkeypatch):
    import object_storage

    monkeypatch.setattr(digital_content, "UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(object_storage, "is_enabled", lambda: False)

    def fail_write(*_args, **_kwargs):
        raise OSError("volume unavailable")

    monkeypatch.setattr(digital_content, "write_upload", fail_write)
    media_rows = FakeMediaUploads()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db=SimpleNamespace(media_uploads=media_rows)))
    )
    upload = UploadFile(
        filename="listing.png",
        file=BytesIO(b"\x89PNG\r\n\x1a\nimage"),
        headers=Headers({"content-type": "image/png"}),
    )

    with pytest.raises(HTTPException) as exc:
        await digital_content.admin_upload_file(
            request, upload, admin={"username": "admin"},
        )

    assert exc.value.status_code == 503
    assert media_rows.rows == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_marketplace_media_upload_uses_volume_when_object_mirror_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(ads, "UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(ads, "_obj_enabled", lambda: True)
    monkeypatch.setattr(
        ads, "_obj_put",
        lambda *_args: (_ for _ in ()).throw(OSError("object mirror unavailable")),
    )
    payload = b"marketplace-video"
    upload = UploadFile(
        filename="cover.jpg",
        file=BytesIO(payload),
        headers=Headers({"content-type": "image/jpeg"}),
    )

    result = await ads.user_upload_file(
        SimpleNamespace(), upload, user={"id": "user-1"},
    )

    filename = result["url"].rsplit("/", 1)[-1]
    assert (tmp_path / filename).read_bytes() == payload


@pytest.mark.asyncio
async def test_marketplace_media_upload_fails_if_both_stores_fail(tmp_path, monkeypatch):
    monkeypatch.setattr(ads, "UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(ads, "_obj_enabled", lambda: False)
    monkeypatch.setattr(
        ads, "write_upload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("volume unavailable")),
    )
    upload = UploadFile(
        filename="cover.jpg",
        file=BytesIO(b"image"),
        headers=Headers({"content-type": "image/jpeg"}),
    )

    with pytest.raises(HTTPException) as exc:
        await ads.user_upload_file(SimpleNamespace(), upload, user={"id": "user-1"})

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_activation_video_upload_uses_configured_volume(tmp_path, monkeypatch):
    monkeypatch.setattr(activation_videos, "UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(activation_videos, "_obj_enabled", lambda: False)
    rows = FakeActivationVideos()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db=SimpleNamespace(activation_videos=rows)))
    )
    payload = b"activation-video"
    upload = UploadFile(
        filename="guide.mp4",
        file=BytesIO(payload),
        headers=Headers({"content-type": "video/mp4"}),
    )

    result = await activation_videos.upload_activation_video(
        request, title="Guide", description="", file=upload,
        admin_user={"username": "admin"},
    )

    filename = result["filename"]
    assert (tmp_path / filename).read_bytes() == payload
    assert result["url"] == f"/api/uploads/{filename}"
    assert len(rows.rows) == 1


@pytest.mark.asyncio
async def test_activation_video_upload_fails_if_all_durable_stores_fail(tmp_path, monkeypatch):
    monkeypatch.setattr(activation_videos, "UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(activation_videos, "_obj_enabled", lambda: False)
    monkeypatch.setattr(
        activation_videos, "write_upload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("volume unavailable")),
    )
    upload = UploadFile(
        filename="guide.mp4",
        file=BytesIO(b"video"),
        headers=Headers({"content-type": "video/mp4"}),
    )
    rows = FakeActivationVideos()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db=SimpleNamespace(activation_videos=rows)))
    )

    with pytest.raises(HTTPException) as exc:
        await activation_videos.upload_activation_video(
            request, title="Guide", description="", file=upload,
            admin_user={"username": "admin"},
        )

    assert exc.value.status_code == 503
    assert rows.rows == []


def test_predeploy_migration_copies_nested_files_and_never_overwrites(tmp_path):
    migration = _load_migration_script()
    legacy = tmp_path / "legacy"
    persistent = tmp_path / "persistent"
    (legacy / "messenger").mkdir(parents=True)
    persistent.mkdir()
    (legacy / "same.png").write_bytes(b"same")
    (persistent / "same.png").write_bytes(b"same")
    (legacy / "messenger" / "chat-id").write_bytes(b"chat attachment")
    (legacy / ".partial.uploading").write_bytes(b"unfinished upload")
    (legacy / "collision.jpg").write_bytes(b"legacy-version")
    (persistent / "collision.jpg").write_bytes(b"volume-version")

    report = migration.migrate_uploads(legacy, persistent)

    assert report["copied"] == 1
    assert report["identical"] == 1
    assert report["conflicts"] == ["collision.jpg"]
    assert report["errors"] == []
    assert not (persistent / ".partial.uploading").exists()
    assert (persistent / "messenger" / "chat-id").read_bytes() == b"chat attachment"
    assert (persistent / "collision.jpg").read_bytes() == b"volume-version"
    assert (legacy / "collision.jpg").read_bytes() == b"legacy-version"


def test_predeploy_migration_is_safe_when_legacy_directory_is_absent(tmp_path):
    migration = _load_migration_script()
    report = migration.migrate_uploads(tmp_path / "missing", tmp_path / "persistent")

    assert report["source_missing"] is True
    assert report["copied"] == 0
