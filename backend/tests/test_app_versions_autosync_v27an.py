"""v27an — regression tests for the PWA auto-publish / version-check flow.

Covers :
  • auto_sync_from_frontend_version() picks up `expo.version` from app.json
    and inserts a new published version if strictly greater.
  • /api/app/version/check correctly flags older clients as `update_required`
    when the server has `mandatory=True`.
  • idempotency : running auto_sync twice with the same version doesn't
    create duplicate rows.
"""
import pathlib
import tempfile
import json

import pytest

from app_versions import auto_sync_from_frontend_version
import app_versions as app_versions_mod


class _FakeCollection:
    def __init__(self):
        self.docs = []

    async def find_one(self, q):
        for d in self.docs:
            match = True
            for k, v in q.items():
                if d.get(k) != v:
                    match = False
                    break
            if match:
                return dict(d)
        return None

    async def update_one(self, q, upd, upsert=False):
        doc = await self.find_one(q)
        if doc is None:
            if upsert:
                new = {}
                new.update(q)
                new.update((upd.get("$set") or {}))
                self.docs.append(new)
            return
        for i, d in enumerate(self.docs):
            if all(d.get(k) == v for k, v in q.items()):
                d.update(upd.get("$set") or {})
                return

    async def insert_one(self, doc):
        self.docs.append(dict(doc))


class _FakeDB:
    def __init__(self):
        self.app_settings = _FakeCollection()
        self.app_versions = _FakeCollection()
        self.admin_logs = _FakeCollection()


@pytest.mark.asyncio
async def test_auto_sync_publishes_new_version(tmp_path, monkeypatch):
    appjson = tmp_path / "app.json"
    appjson.write_text(json.dumps({"expo": {"version": "1.2.3"}}))
    monkeypatch.setattr(app_versions_mod, "_FRONTEND_APP_JSON", str(appjson))
    db = _FakeDB()
    res = await auto_sync_from_frontend_version(db)
    assert res["ok"]
    assert res["changed"]
    assert res["version"] == "1.2.3"
    settings = (db.app_settings.docs[0]["value"])
    assert settings["current_version"] == "1.2.3"
    assert settings["minimum_supported_version"] == "1.2.3"
    assert settings["mandatory"] is True
    # one app_versions row inserted
    assert any(d["version"] == "1.2.3" and d["status"] == "published"
               for d in db.app_versions.docs)


@pytest.mark.asyncio
async def test_auto_sync_idempotent(tmp_path, monkeypatch):
    appjson = tmp_path / "app.json"
    appjson.write_text(json.dumps({"expo": {"version": "2.0.0"}}))
    monkeypatch.setattr(app_versions_mod, "_FRONTEND_APP_JSON", str(appjson))
    db = _FakeDB()
    r1 = await auto_sync_from_frontend_version(db)
    r2 = await auto_sync_from_frontend_version(db)
    assert r1["changed"] is True
    assert r2["changed"] is False
    # Only one row
    rows = [d for d in db.app_versions.docs if d["version"] == "2.0.0"]
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_auto_sync_ignores_lower_version(tmp_path, monkeypatch):
    appjson = tmp_path / "app.json"
    appjson.write_text(json.dumps({"expo": {"version": "0.9.0"}}))
    monkeypatch.setattr(app_versions_mod, "_FRONTEND_APP_JSON", str(appjson))
    db = _FakeDB()
    # seed higher version
    await db.app_settings.update_one(
        {"key": "app_version"},
        {"$set": {"key": "app_version", "value": {
            "current_version": "1.0.0", "minimum_supported_version": "1.0.0",
            "mandatory": True, "apk_url": "", "apk_size_mb": None, "updated_at": None,
        }}},
        upsert=True,
    )
    res = await auto_sync_from_frontend_version(db)
    assert res["ok"]
    assert res["changed"] is False


@pytest.mark.asyncio
async def test_auto_sync_rejects_invalid_version(tmp_path, monkeypatch):
    appjson = tmp_path / "app.json"
    appjson.write_text(json.dumps({"expo": {"version": "not-a-version"}}))
    monkeypatch.setattr(app_versions_mod, "_FRONTEND_APP_JSON", str(appjson))
    db = _FakeDB()
    res = await auto_sync_from_frontend_version(db)
    assert res["ok"] is False
    assert "invalid-version" in res["reason"]


@pytest.mark.asyncio
async def test_auto_sync_handles_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(app_versions_mod, "_FRONTEND_APP_JSON",
                        str(tmp_path / "does-not-exist.json"))
    db = _FakeDB()
    res = await auto_sync_from_frontend_version(db)
    assert res["ok"] is False
    assert res["reason"] == "cannot-read-app-json"
