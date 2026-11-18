"""Local unit tests for preserving and serving APK uploads."""
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import FastAPI, HTTPException
from starlette.datastructures import Headers, UploadFile
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import digital_content
from upload_delivery import serve_uploaded_file
from apk_validation import (
    APK_CONTENT_TYPE,
    InvalidApk,
    apk_download_headers,
    validate_apk,
)


def make_signed_apk() -> bytes:
    """Build a tiny synthetic package fixture; it is not a real installable app."""
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00" + b"\x00" * 8)
        archive.writestr("classes.dex", b"dex\n035\x00" + b"\x00" * 16)
        archive.writestr("META-INF/CERT.RSA", b"synthetic signature marker")
    return output.getvalue()


class FakeMediaUploads:
    def __init__(self):
        self.rows = []

    async def insert_one(self, row):
        self.rows.append(dict(row))


@pytest.mark.asyncio
async def test_admin_upload_keeps_apk_bytes_and_normalizes_metadata(tmp_path, monkeypatch):
    original = make_signed_apk()
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    db = SimpleNamespace(media_uploads=FakeMediaUploads())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db)))
    stored = {}
    monkeypatch.setattr(digital_content, "UPLOADS_DIR", upload_dir)

    import object_storage
    monkeypatch.setattr(object_storage, "is_enabled", lambda: True)
    monkeypatch.setattr(
        object_storage,
        "put_upload",
        lambda name, data, content_type: stored.update({
            "name": name, "data": data, "content_type": content_type,
        }),
    )

    file = UploadFile(
        filename="build.apk",
        file=BytesIO(original),
        headers=Headers({"content-type": "application/zip"}),
    )
    result = await digital_content.admin_upload_file(
        request,
        file,
        admin={"username": "admin"},
    )

    assert stored["data"] == original
    assert stored["content_type"] == APK_CONTENT_TYPE
    assert (upload_dir / stored["name"]).read_bytes() == original
    assert result["content_type"] == APK_CONTENT_TYPE
    assert result["apk_validated"] is True
    assert db.media_uploads.rows[0]["apk_validated"] is True


@pytest.mark.asyncio
async def test_admin_upload_rejects_regular_zip_renamed_to_apk(tmp_path, monkeypatch):
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("readme.txt", "not an Android package")
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db=SimpleNamespace(media_uploads=FakeMediaUploads())))
    )
    monkeypatch.setattr(digital_content, "UPLOADS_DIR", upload_dir)

    file = UploadFile(
        filename="renamed.apk",
        file=BytesIO(output.getvalue()),
        headers=Headers({"content-type": "application/zip"}),
    )
    with pytest.raises(HTTPException) as exc:
        await digital_content.admin_upload_file(request, file, admin={"username": "admin"})

    assert exc.value.status_code == 415
    assert "manifeste Android" in exc.value.detail
    assert not list(upload_dir.iterdir())


def test_apk_validation_rejects_unsigned_package():
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00" + b"\x00" * 8)
        archive.writestr("classes.dex", b"dex\n035\x00" + b"\x00" * 16)
    with pytest.raises(InvalidApk, match="n’est pas signé"):
        validate_apk(output.getvalue())


def test_apk_download_headers_force_installable_filename_and_nosniff():
    headers = apk_download_headers("abc123.apk")
    assert headers["Content-Disposition"] == 'attachment; filename="abc123.apk"'
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert apk_download_headers("../../unsafe.zip")["Content-Disposition"] == (
        'attachment; filename="SPILOVEURE.apk"'
    )


@pytest.mark.parametrize("use_object_storage", [True, False])
def test_download_route_serves_apk_bytes_with_android_headers(tmp_path, use_object_storage):
    apk_bytes = make_signed_apk()

    class FakeStorage:
        def is_enabled(self):
            return use_object_storage

        def get_upload(self, filename):
            assert filename == "release.apk"
            return apk_bytes, "application/zip"

    (tmp_path / "release.apk").write_bytes(apk_bytes)
    app = FastAPI()

    @app.get("/api/uploads/{filename}")
    async def download(filename: str):
        return serve_uploaded_file(filename, tmp_path, FakeStorage())

    response = TestClient(app).get("/api/uploads/release.apk")

    assert response.status_code == 200
    assert response.content == apk_bytes
    assert response.headers["content-type"].split(";")[0] == APK_CONTENT_TYPE
    assert response.headers["content-disposition"] == 'attachment; filename="release.apk"'
    assert response.headers["x-content-type-options"] == "nosniff"
