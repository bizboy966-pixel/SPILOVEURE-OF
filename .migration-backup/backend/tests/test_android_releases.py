"""Download tests use synthetic bytes, never presented as a real production APK."""
import hashlib
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from android_releases import router, verified_hash


@pytest.fixture
def releases(tmp_path, monkeypatch):
    monkeypatch.setenv("ANDROID_RELEASES_DIR", str(tmp_path))
    monkeypatch.delenv("PUBLIC_APP_URL", raising=False)
    monkeypatch.delenv("SITE_URL", raising=False)
    verified_hash.cache_clear()
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client, tmp_path


def manifest(root, *, validated=True):
    content = b"synthetic test fixture, not an APK"
    (root / "spiloveure-1.1.0.apk").write_bytes(content)
    row = {"version": "1.1.0", "version_code": 1, "package": "com.spilivere.app",
           "size_bytes": len(content), "published_at": "2026-11-14T00:00:00+00:00",
           "sha256": hashlib.sha256(content).hexdigest(), "signer_sha256": "a" * 64,
           "min_android": "API 24", "validated": validated}
    (root / "releases.json").write_text(json.dumps([row]))
    return row, content


def test_no_apk_is_not_a_fake_download(releases):
    client, _ = releases
    assert client.get("/api/android/releases").json() == {"available": False, "latest": None, "releases": []}
    assert client.get("/api/android/releases/1.1.0/download").status_code == 404
    page = client.get("/telecharger")
    assert page.status_code == 200 and 'noindex,nofollow' in page.text
    assert "@@CANONICAL@@" not in page.text


def test_download_identity_and_integrity(releases):
    client, root = releases
    row, content = manifest(root)
    response = client.get("/api/android/releases")
    assert response.status_code == 200
    assert response.json()["latest"]["sha256"] == row["sha256"]
    result = client.get(response.json()["latest"]["download_url"])
    assert result.content == content
    assert result.headers["content-type"] == "application/vnd.android.package-archive"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert "SPILOVEURE-1.1.0.apk" in result.headers["content-disposition"]


@pytest.mark.parametrize("problem", ["unvalidated", "changed", "malformed", "wrong-package", "symlink"])
def test_unverified_files_fail_closed(releases, problem):
    client, root = releases
    row, _ = manifest(root, validated=problem != "unvalidated")
    if problem == "changed":
        (root / "spiloveure-1.1.0.apk").write_bytes(b"tampered")
    if problem == "malformed":
        (root / "releases.json").write_text("{")
    if problem == "wrong-package":
        row["package"] = "another.app"
        (root / "releases.json").write_text(json.dumps([row]))
    if problem == "symlink":
        file = root / "spiloveure-1.1.0.apk"
        file.unlink()
        file.symlink_to(Path(__file__))
    assert client.get("/api/android/releases").status_code == 503
    assert client.get("/api/android/releases/1.1.0/download").status_code == 503


def test_canonical_and_sitemap_from_official_configuration(releases, monkeypatch):
    client, _ = releases
    monkeypatch.setenv("PUBLIC_APP_URL", "https://official.example")
    page = client.get("/telecharger")
    assert 'href="https://official.example/telecharger"' in page.text
    assert 'content="index,follow"' in page.text
    assert "https://official.example/telecharger" in client.get("/sitemap-android.xml").text
    assert "Sitemap: https://official.example/sitemap-android.xml" in client.get("/robots.txt").text
    monkeypatch.setenv("PUBLIC_APP_URL", 'https://official.example/?bad="value"')
    assert "noindex,nofollow" in client.get("/telecharger").text
