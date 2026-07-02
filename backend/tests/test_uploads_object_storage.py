"""Tests for the Object Storage fix on /api/uploads/* and admin uploads."""
import os
import time
from pathlib import Path
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
UPLOADS_DIR = Path("/app/backend/uploads")

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- GET /api/uploads/{filename} ----------

class TestUploadsServe:
    def test_missing_file_returns_410_with_french_detail(self):
        r = requests.get(f"{BASE_URL}/api/uploads/definitely-not-here-TEST_{int(time.time())}.png", timeout=30)
        assert r.status_code == 410, f"expected 410, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        assert "n'est plus disponible" in detail
        assert "administration" in detail

    @pytest.mark.parametrize("filename", [
        "3624e2b9252942dcaaf285e6ffef3d25.png",
        "3b557323d71f486fb2640ca260727f8f.png",
        "f26abe9574e84b44999f2b2dce363580.png",
    ])
    def test_legacy_local_files_served_200(self, filename):
        r = requests.get(f"{BASE_URL}/api/uploads/{filename}", timeout=60)
        assert r.status_code == 200, f"{filename} -> {r.status_code}"
        assert len(r.content) > 0
        assert r.headers.get("Content-Type", "").startswith(("image/", "application/octet-stream"))


# ---------- POST /api/admin/uploads (auth) ----------

class TestUploadsAuth:
    def test_upload_without_token_returns_401_or_403(self):
        files = {"file": ("TEST_x.png", b"\x89PNG\r\n\x1a\n" + b"0" * 100, "image/png")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files, timeout=30)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_upload_with_non_admin_token_returns_403(self):
        # Register a temp non-admin user
        ts = int(time.time())
        payload = {
            "username": f"testu{ts}",
            "email": f"testu{ts}@example.com",
            "password": "TestPass!123",
            "country": "TG",
            "phone": f"+228{ts % 100000000:08d}",
            "sponsor_username": "admin",
        }
        rr = requests.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=30)
        if rr.status_code not in (200, 201):
            pytest.skip(f"cannot create non-admin user for test: {rr.status_code} {rr.text[:200]}")
        # login
        lr = requests.post(f"{BASE_URL}/api/auth/login",
                           json={"email": payload["email"], "password": payload["password"]}, timeout=30)
        assert lr.status_code == 200, lr.text
        tok = lr.json()["access_token"]
        files = {"file": ("TEST_x.png", b"\x89PNG\r\n\x1a\n" + b"0" * 100, "image/png")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files,
                          headers={"Authorization": f"Bearer {tok}"}, timeout=30)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text[:200]}"


# ---------- POST /api/admin/uploads (validation) ----------

class TestUploadsValidation:
    def test_invalid_extension_returns_415(self, admin_headers):
        files = {"file": ("TEST_evil.exe", b"MZ" + b"0" * 100, "application/octet-stream")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files, headers=admin_headers, timeout=30)
        assert r.status_code == 415, f"expected 415, got {r.status_code}: {r.text[:200]}"
        detail = r.json().get("detail", "")
        assert "Extension non autorisée" in detail
        assert "Formats acceptés" in detail

    def test_valid_png_upload_returns_storage_ok(self, admin_headers):
        payload = b"\x89PNG\r\n\x1a\n" + os.urandom(2048)
        files = {"file": ("TEST_ok.png", payload, "image/png")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files, headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["url"].startswith("/api/uploads/")
        assert data["size"] == len(payload)
        assert data["content_type"].startswith("image/")
        assert data["storage_ok"] is True, "Emergent object storage should be enabled and successful"
        # store for reuse
        TestUploadsValidation.last_url = data["url"]
        TestUploadsValidation.last_filename = data["url"].rsplit("/", 1)[-1]

    def test_valid_pdf_upload(self, admin_headers):
        payload = b"%PDF-1.4\n" + os.urandom(1024) + b"\n%%EOF"
        files = {"file": ("TEST_ok.pdf", payload, "application/pdf")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files, headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["storage_ok"] is True

    def test_valid_apk_upload(self, admin_headers):
        payload = b"PK\x03\x04" + os.urandom(2048)  # zip magic (APK is a zip)
        files = {"file": ("TEST_ok.apk", payload, "application/vnd.android.package-archive")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files, headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text


# ---------- Persistence: upload -> delete local -> GET still 200 (object storage fallback) ----------

class TestObjectStoragePersistence:
    def test_upload_then_delete_local_still_downloads(self, admin_headers):
        payload = b"\x89PNG\r\n\x1a\n" + os.urandom(4096)
        files = {"file": ("TEST_persist.png", payload, "image/png")}
        r = requests.post(f"{BASE_URL}/api/admin/uploads", files=files, headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text
        url = r.json()["url"]
        filename = url.rsplit("/", 1)[-1]
        assert r.json()["storage_ok"] is True

        # Ensure it downloads via GET
        g1 = requests.get(f"{BASE_URL}{url}", timeout=60)
        assert g1.status_code == 200
        assert g1.content == payload

        # Simulate container redeploy: delete the local file
        local = UPLOADS_DIR / filename
        assert local.exists(), "local file should exist right after upload"
        local.unlink()
        assert not local.exists()

        # Must still be servable from object storage
        g2 = requests.get(f"{BASE_URL}{url}", timeout=60)
        assert g2.status_code == 200, f"object storage fallback broken: {g2.status_code} {g2.text[:200]}"
        assert g2.content == payload, "content mismatch after local delete"


# ---------- GET /api/admin/uploads/diagnostic ----------

class TestDiagnostic:
    def test_diagnostic_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/uploads/diagnostic", timeout=30)
        assert r.status_code in (401, 403)

    def test_diagnostic_admin_ok(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/uploads/diagnostic", headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "broken_count" in data
        assert "broken" in data and isinstance(data["broken"], list)
        assert "object_storage_enabled" in data
        assert data["object_storage_enabled"] is True
        assert data["broken_count"] == len(data["broken"])
