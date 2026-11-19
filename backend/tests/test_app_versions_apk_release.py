import asyncio
from io import BytesIO
import sys
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app_versions


class _Collection:
    def __init__(self):
        self.doc = None
        self.rows = []

    async def find_one(self, query, projection=None):
        if query.get("key") == "app_version":
            return self.doc
        return next((row for row in self.rows if all(row.get(k) == v for k, v in query.items())), None)

    async def update_one(self, query, update, upsert=False):
        if query.get("key") == "app_version":
            self.doc = {**(self.doc or {}), **update.get("$set", {})}
            return
        for row in self.rows:
            if all(row.get(k) == v for k, v in query.items()):
                row.update(update.get("$set", {}))
                return
        if upsert:
            self.rows.append({**query, **update.get("$set", {})})

    async def insert_one(self, row):
        self.rows.append(dict(row))

class _Upload:
    def __init__(self, data=b"official-apk", filename="release.apk"):
        self.data = BytesIO(data)
        self.filename = filename
        self.content_type = "application/vnd.android.package-archive"

    async def read(self, size=-1):
        return self.data.read(size)


def _request():
    db = SimpleNamespace(
        app_settings=_Collection(),
        admin_logs=_Collection(),
        media_uploads=_Collection(),
    )
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    return request, db


def _signed_apk_fixture():
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00" + b"\x00" * 8)
        archive.writestr("classes.dex", b"dex\n035\x00" + b"\x00" * 16)
        archive.writestr("META-INF/CERT.RSA", b"signature marker")
    return output.getvalue()


def _official_metadata(**overrides):
    return {
        "package": "com.spilivere.app",
        "version": "1.1.18",
        "version_code": 19,
        "signer_sha256": "a" * 64,
        "debuggable": False,
        **overrides,
    }


def _run_official_upload(monkeypatch, request, file=None, token="release-test-token"):
    monkeypatch.setenv("ANDROID_RELEASE_TOKEN", "release-test-token")
    monkeypatch.setattr(app_versions, "validate_apk", lambda _data: None)
    monkeypatch.setattr(app_versions, "inspect_official_apk", lambda _path: _official_metadata())
    import object_storage
    monkeypatch.setattr(object_storage, "is_enabled", lambda: True)
    monkeypatch.setattr(object_storage, "put_upload", lambda *_args: {"ok": True})
    return asyncio.run(app_versions.publish_official_apk(
        request,
        file or _Upload(),
        authorization=f"Bearer {token}" if token else "",
    ))


def test_apk_release_metadata_is_public_and_mandatory():
    request, db = _request()
    db.media_uploads.rows.append({
        "url": "/api/uploads/spiloveure-1.1.4.apk",
        "apk_validated": True,
    })
    result = asyncio.run(app_versions.update_settings({
        "apk_url": "/api/uploads/spiloveure-1.1.4.apk",
        "apk_version": "1.1.4",
        "apk_mandatory": True,
    }, request, admin={"id": "admin"}))

    assert result["settings"]["apk_version"] == "1.1.4"
    assert result["settings"]["apk_minimum_supported_version"] == "1.1.4"
    assert result["settings"]["apk_mandatory"] is True

    public = asyncio.run(app_versions.get_app_version(request))
    assert public["apk_url"] == "/api/uploads/spiloveure-1.1.4.apk"
    assert public["apk_version"] == "1.1.4"
    assert public["apk_mandatory"] is True
    assert db.admin_logs.rows[0]["action"] == "update_app_version_settings"


def test_official_release_upload_publishes_signed_apk_and_pins_signer(monkeypatch):
    request, db = _request()
    result = _run_official_upload(monkeypatch, request, file=_Upload(_signed_apk_fixture()))

    assert result["ok"] is True
    assert result["published"] is True
    assert result["version"] == "1.1.18"
    assert result["version_code"] == 19
    assert result["url"] == "/api/uploads/spiloveure-official-1-1-18.apk"
    public = asyncio.run(app_versions.get_app_version(request))
    assert public["apk_url"] == result["url"]
    assert public["apk_version"] == "1.1.18"
    assert public["apk_version_code"] == 19
    assert public["apk_mandatory"] is True
    assert public["apk_minimum_supported_version"] == "1.1.18"
    assert db.app_settings.doc["value"]["apk_signer_sha256"] == "a" * 64
    assert db.media_uploads.rows[0]["official_release"] is True
    assert db.admin_logs.rows[0]["action"] == "publish_official_android_apk"


def test_official_release_rejects_missing_or_wrong_release_token(monkeypatch):
    request, db = _request()
    monkeypatch.setenv("ANDROID_RELEASE_TOKEN", "configured-token")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.publish_official_apk(
            request, _Upload(), authorization="Bearer incorrect-token",
        ))
    assert exc.value.status_code == 401
    assert db.app_settings.doc is None
    assert db.media_uploads.rows == []


@pytest.mark.parametrize(
    "metadata",
    [
        {"package": "com.spilivere.app.preview"},
        {"debuggable": True},
        {"version_code": 18},
    ],
)
def test_official_release_rejects_wrong_identity_or_nonprogressing_build(monkeypatch, metadata):
    request, db = _request()
    db.app_settings.doc = {
        "key": "app_version",
        "value": {
            **app_versions._DEFAULT_SETTINGS,
            "apk_version": "1.1.17",
            "apk_version_code": 18,
        },
    }
    monkeypatch.setenv("ANDROID_RELEASE_TOKEN", "release-test-token")
    monkeypatch.setattr(app_versions, "validate_apk", lambda _data: None)
    monkeypatch.setattr(
        app_versions, "inspect_official_apk",
        lambda _path: _official_metadata(**metadata),
    )
    import object_storage
    monkeypatch.setattr(object_storage, "is_enabled", lambda: True)
    monkeypatch.setattr(object_storage, "put_upload", lambda *_args: pytest.fail("must not upload"))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.publish_official_apk(
            request, _Upload(), authorization="Bearer release-test-token",
        ))
    assert exc.value.status_code in {409, 415}
    assert db.app_settings.doc["value"]["apk_version"] == "1.1.17"
    assert db.app_settings.doc["value"]["apk_version_code"] == 18
    assert db.media_uploads.rows == []


def test_official_release_rejects_a_changed_signing_key(monkeypatch):
    request, db = _request()
    db.app_settings.doc = {
        "key": "app_version",
        "value": {
            **app_versions._DEFAULT_SETTINGS,
            "apk_version": "1.1.17",
            "apk_version_code": 18,
            "apk_signer_sha256": "b" * 64,
        },
    }
    monkeypatch.setenv("ANDROID_RELEASE_TOKEN", "release-test-token")
    monkeypatch.setattr(app_versions, "validate_apk", lambda _data: None)
    monkeypatch.setattr(app_versions, "inspect_official_apk", lambda _path: _official_metadata())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.publish_official_apk(
            request, _Upload(), authorization="Bearer release-test-token",
        ))
    assert exc.value.status_code == 409
    assert "clé officielle" in exc.value.detail
    assert db.app_settings.doc["value"]["apk_version"] == "1.1.17"


def test_official_release_storage_failure_keeps_previous_release_unchanged(monkeypatch):
    request, db = _request()
    db.app_settings.doc = {
        "key": "app_version",
        "value": {**app_versions._DEFAULT_SETTINGS, "apk_version": "1.1.17"},
    }
    monkeypatch.setenv("ANDROID_RELEASE_TOKEN", "release-test-token")
    monkeypatch.setattr(app_versions, "validate_apk", lambda _data: None)
    monkeypatch.setattr(app_versions, "inspect_official_apk", lambda _path: _official_metadata())
    import object_storage
    monkeypatch.setattr(object_storage, "is_enabled", lambda: True)
    monkeypatch.setattr(object_storage, "put_upload", lambda *_args: (_ for _ in ()).throw(OSError("offline")))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.publish_official_apk(
            request, _Upload(), authorization="Bearer release-test-token",
        ))
    assert exc.value.status_code == 503
    assert db.app_settings.doc["value"]["apk_version"] == "1.1.17"
    assert db.media_uploads.rows == []


def test_official_release_requires_persistent_storage_before_publication(monkeypatch):
    request, db = _request()
    monkeypatch.setenv("ANDROID_RELEASE_TOKEN", "release-test-token")
    monkeypatch.setattr(app_versions, "validate_apk", lambda _data: None)
    monkeypatch.setattr(app_versions, "inspect_official_apk", lambda _path: _official_metadata())
    import object_storage
    monkeypatch.setattr(object_storage, "is_enabled", lambda: False)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.publish_official_apk(
            request, _Upload(), authorization="Bearer release-test-token",
        ))
    assert exc.value.status_code == 503
    assert db.app_settings.doc is None


def test_official_apk_inspection_requires_valid_tools_and_official_package(monkeypatch, tmp_path):
    class _Result:
        def __init__(self, stdout):
            self.stdout = stdout

    outputs = iter([
        "Verifies\nSigner #1 certificate SHA-256 digest: " + "c" * 64,
        "package: name='com.spilivere.app' versionCode='19' versionName='1.1.18'\n",
    ])
    monkeypatch.setattr(app_versions.shutil, "which", lambda _tool: f"/sdk/{_tool}")
    monkeypatch.setattr(
        app_versions.subprocess, "run",
        lambda *_args, **_kwargs: _Result(next(outputs)),
    )
    result = app_versions.inspect_official_apk(str(tmp_path / "release.apk"))
    assert result == {
        "package": "com.spilivere.app",
        "version": "1.1.18",
        "version_code": 19,
        "signer_sha256": "c" * 64,
        "debuggable": False,
    }


def test_publishing_a_new_apk_forces_mandatory_update_even_if_admin_sends_false():
    request, db = _request()
    db.app_settings.doc = {
        "key": "app_version",
        "value": {
            **app_versions._DEFAULT_SETTINGS,
            "apk_version": "1.1.15",
            "apk_minimum_supported_version": "1.1.15",
            "apk_mandatory": False,
        },
    }
    db.media_uploads.rows.append({
        "url": "/api/uploads/spiloveure-1.1.16.apk",
        "apk_validated": True,
    })

    result = asyncio.run(app_versions.update_settings({
        "apk_url": "/api/uploads/spiloveure-1.1.16.apk",
        "apk_version": "1.1.16",
        "apk_mandatory": False,
    }, request, admin={"id": "admin"}))

    assert result["settings"]["apk_mandatory"] is True
    assert result["settings"]["apk_minimum_supported_version"] == "1.1.16"


def test_unvalidated_uploaded_zip_cannot_be_published_as_apk():
    request, db = _request()
    db.media_uploads.rows.append({
        "url": "/api/uploads/not-an-apk.apk",
        "apk_validated": False,
    })
    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.update_settings({
            "apk_url": "/api/uploads/not-an-apk.apk",
            "apk_version": "1.1.4",
            "apk_mandatory": False,
        }, request, admin={"id": "admin"}))
    assert exc.value.status_code == 400
    assert "APK Android signé" in exc.value.detail
    assert db.app_settings.doc is None


def test_untracked_uploaded_apk_cannot_be_published():
    request, _ = _request()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.update_settings({
            "apk_url": "/api/uploads/unknown.apk",
            "apk_version": "1.1.4",
            "apk_mandatory": False,
        }, request, admin={"id": "admin"}))
    assert exc.value.status_code == 400


def test_mandatory_apk_cannot_be_published_without_downloadable_file():
    request, _ = _request()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.update_settings({
            "apk_version": "1.1.4",
            "apk_mandatory": True,
        }, request, admin={"id": "admin"}))
    assert exc.value.status_code == 400


def test_apk_url_rejects_arbitrary_relative_paths():
    request, _ = _request()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(app_versions.update_settings({
            "apk_url": "/outside/app.apk",
            "apk_version": "1.1.4",
            "apk_mandatory": False,
        }, request, admin={"id": "admin"}))
    assert exc.value.status_code == 400
