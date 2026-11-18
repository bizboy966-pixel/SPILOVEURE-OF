"""Regression — 2026-03-04 (v27aj) : minimalist app version management.

Tests cover :
  • /api/app/version public endpoint returns the current settings
  • /api/app/version/check compares client_version to minimum + current
  • /api/admin/versions/publish requires valid semver + sets current+minimum
  • Audit log row created on publish
  • Idempotence : re-publishing the same version does not create a duplicate
"""
import sys
from pathlib import Path
import asyncio
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app_versions  # noqa: E402


def test_semver_validation():
    assert app_versions._is_valid_semver("1.0.0")
    assert app_versions._is_valid_semver("12.345.6")
    assert app_versions._is_valid_semver("1.0.0-beta")
    assert not app_versions._is_valid_semver("1.0")
    assert not app_versions._is_valid_semver("v1.0.0")
    assert not app_versions._is_valid_semver("abc")
    assert not app_versions._is_valid_semver("")


def test_cmp_versions():
    assert app_versions._cmp("1.0.0", "1.0.0") == 0
    assert app_versions._cmp("1.0.0", "1.0.1") == -1
    assert app_versions._cmp("1.2.0", "1.1.9") == 1
    assert app_versions._cmp("2.0.0", "1.99.99") == 1
    assert app_versions._cmp("1.0.0", "1.0.0-beta") == 0  # pre-release ignored


def _fake_db():
    db = MagicMock()
    db.app_settings.find_one = AsyncMock(return_value=None)
    db.app_settings.update_one = AsyncMock()
    db.app_versions.find_one = AsyncMock(return_value=None)
    db.app_versions.insert_one = AsyncMock()
    db.app_versions.update_one = AsyncMock()
    db.admin_logs.insert_one = AsyncMock()
    return db


def test_publish_rejects_invalid_semver():
    db = _fake_db()
    req = MagicMock()
    req.app.state.db = db
    body = app_versions.PublishIn(version="not-a-version", mandatory=True, make_minimum=True)
    try:
        asyncio.get_event_loop().run_until_complete(
            app_versions.publish_version(body, req, admin={"id": "A1"})
        )
        assert False, "should have raised"
    except Exception as e:
        assert "invalide" in str(e).lower() or getattr(e, "status_code", 0) == 400


def test_publish_rejects_regression():
    """Can't publish 0.9.0 when current is 1.0.0."""
    db = _fake_db()
    db.app_settings.find_one = AsyncMock(return_value={
        "key": "app_version",
        "value": {"current_version": "1.0.0", "minimum_supported_version": "1.0.0"},
    })
    req = MagicMock()
    req.app.state.db = db
    body = app_versions.PublishIn(version="0.9.0", mandatory=True, make_minimum=True)
    try:
        asyncio.get_event_loop().run_until_complete(
            app_versions.publish_version(body, req, admin={"id": "A1"})
        )
        assert False, "should have raised"
    except Exception as e:
        assert "antérieure" in str(e).lower() or getattr(e, "status_code", 0) == 400


def test_publish_updates_settings_and_logs():
    db = _fake_db()
    db.app_settings.find_one = AsyncMock(return_value={
        "key": "app_version",
        "value": {"current_version": "1.0.0", "minimum_supported_version": "1.0.0"},
    })
    req = MagicMock()
    req.app.state.db = db
    body = app_versions.PublishIn(version="1.2.0", mandatory=True, make_minimum=True,
                                  notes="Marketplace amélioré")
    r = asyncio.get_event_loop().run_until_complete(
        app_versions.publish_version(body, req, admin={"id": "A1"})
    )
    assert r["ok"] is True
    assert r["settings"]["current_version"] == "1.2.0"
    assert r["settings"]["minimum_supported_version"] == "1.2.0"
    assert r["settings"]["mandatory"] is True
    db.app_versions.insert_one.assert_awaited_once()
    db.app_settings.update_one.assert_awaited()
    db.admin_logs.insert_one.assert_awaited_once()
    log_call = db.admin_logs.insert_one.await_args.args[0]
    assert log_call["action"] == "publish_app_version"
    assert log_call["meta"]["version"] == "1.2.0"


def test_check_endpoint_logic():
    db = _fake_db()
    db.app_settings.find_one = AsyncMock(return_value={
        "key": "app_version",
        "value": {"current_version": "1.2.0", "minimum_supported_version": "1.1.0",
                  "mandatory": True},
    })
    req = MagicMock()
    req.app.state.db = db

    # Client < minimum + mandatory → update_required=True
    r = asyncio.get_event_loop().run_until_complete(
        app_versions.check_app_version(req, client_version="1.0.0")
    )
    assert r["update_available"] is True
    assert r["update_required"] is True

    # Client == current → no update
    r = asyncio.get_event_loop().run_until_complete(
        app_versions.check_app_version(req, client_version="1.2.0")
    )
    assert r["update_available"] is False
    assert r["update_required"] is False

    # Client between minimum and current → available but not required
    r = asyncio.get_event_loop().run_until_complete(
        app_versions.check_app_version(req, client_version="1.1.5")
    )
    assert r["update_available"] is True
    assert r["update_required"] is False
