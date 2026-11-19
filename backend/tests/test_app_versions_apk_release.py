import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

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


def _request():
    db = SimpleNamespace(
        app_settings=_Collection(),
        admin_logs=_Collection(),
        media_uploads=_Collection(),
    )
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    return request, db


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
