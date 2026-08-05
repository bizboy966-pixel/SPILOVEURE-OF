"""Marketplace videos + audio media — backend tests (iteration 23).

Covers:
- POST /api/marketplace with images only → videos=[] audio=null
- POST /api/marketplace with 2 videos + 1 audio → persisted
- POST /api/marketplace with 6 videos → 422 validation error
- POST /api/user/uploads: .mp3 accepted, .txt rejected (415)
- GET /api/marketplace and GET /api/admin/marketplace return media fields
"""
import io
import os
import uuid as _u

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"

FLAGS_TO_ENABLE = ["marketplace", "marketplace_publish"]


# ─── Fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"Admin login: {r.status_code} {r.text[:200]}"
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def user_headers():
    suffix = _u.uuid4().hex[:8]
    email = f"TEST_mkm_{suffix}@example.com"
    password = "Passw0rd!"
    payload = {
        "username": f"testmkm{suffix}", "email": email,
        "password": password, "password_confirm": password,
        "country": "TG", "phone": f"+228{suffix[:8]}",
        "sponsor_username": "admin", "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=15)
    if r.status_code not in (200, 201):
        pytest.skip(f"Register failed: {r.status_code} {r.text[:200]}")
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200
    tok = r.json().get("access_token") or r.json().get("token")
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module", autouse=True)
def enable_flags(admin_headers):
    """Turn marketplace flags ON before, OFF after."""
    for k in FLAGS_TO_ENABLE:
        requests.put(f"{API}/admin/feature-flags/{k}",
                     json={"enabled": True}, headers=admin_headers, timeout=10)
    yield
    for k in FLAGS_TO_ENABLE:
        requests.put(f"{API}/admin/feature-flags/{k}",
                     json={"enabled": False}, headers=admin_headers, timeout=10)


# ─── /api/user/uploads accepts audio ─────────────────────────────────────────
class TestUploadAudioExtensions:
    def test_upload_mp3_returns_url(self, user_headers):
        buf = io.BytesIO(b"ID3\x03\x00\x00\x00fakeaudio" * 50)
        files = {"file": ("clip.mp3", buf, "audio/mpeg")}
        r = requests.post(f"{API}/user/uploads", files=files, headers=user_headers, timeout=20)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["url"].startswith("/api/uploads/") and j["url"].endswith(".mp3")
        assert j["filename"].endswith(".mp3")

    @pytest.mark.parametrize("ext,mime", [("m4a", "audio/mp4"), ("aac", "audio/aac"),
                                          ("ogg", "audio/ogg"), ("wav", "audio/wav")])
    def test_upload_other_audio_formats(self, user_headers, ext, mime):
        buf = io.BytesIO(b"fake" * 20)
        r = requests.post(f"{API}/user/uploads",
                          files={"file": (f"a.{ext}", buf, mime)},
                          headers=user_headers, timeout=20)
        assert r.status_code == 200, f".{ext} rejected: {r.text[:200]}"
        assert r.json()["url"].endswith(f".{ext}")

    def test_upload_txt_returns_415(self, user_headers):
        buf = io.BytesIO(b"hello world")
        r = requests.post(f"{API}/user/uploads",
                          files={"file": ("bad.txt", buf, "text/plain")},
                          headers=user_headers, timeout=20)
        assert r.status_code == 415, f"expected 415, got {r.status_code}: {r.text[:200]}"


# ─── Marketplace media persistence ───────────────────────────────────────────
def _base_listing(**over):
    p = {
        "images": ["/api/uploads/dummy1.jpg"],
        "name": "TEST_MediaListing",
        "category": "electronics",
        "price": 1000.0,
        "city": "Lomé",
        "whatsapp": "+22890000001",
        "description": "TEST listing media",
    }
    p.update(over)
    return p


class TestMarketplaceCreateMedia:
    def test_create_with_images_only_defaults(self, user_headers):
        r = requests.post(f"{API}/marketplace", json=_base_listing(),
                          headers=user_headers, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("videos") == [] and j.get("audio") is None
        assert "id" in j
        # GET back and confirm persistence
        g = requests.get(f"{API}/marketplace/{j['id']}", headers=user_headers, timeout=15)
        assert g.status_code == 200
        assert g.json().get("videos") == [] and g.json().get("audio") is None

    def test_create_with_videos_and_audio(self, user_headers):
        payload = _base_listing(
            videos=["/api/uploads/v1.mp4", "/api/uploads/v2.mp4"],
            audio="/api/uploads/track.mp3",
        )
        r = requests.post(f"{API}/marketplace", json=payload,
                          headers=user_headers, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["videos"] == payload["videos"]
        assert j["audio"] == payload["audio"]
        # Persisted via GET-by-id
        g = requests.get(f"{API}/marketplace/{j['id']}", headers=user_headers, timeout=15).json()
        assert g["videos"] == payload["videos"] and g["audio"] == payload["audio"]

    def test_create_with_too_many_videos_returns_422(self, user_headers):
        payload = _base_listing(videos=[f"/api/uploads/v{i}.mp4" for i in range(6)])
        r = requests.post(f"{API}/marketplace", json=payload,
                          headers=user_headers, timeout=15)
        assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text[:200]}"


# ─── Admin marketplace review includes media ─────────────────────────────────
class TestAdminMarketplaceMedia:
    def test_admin_list_returns_media_fields(self, admin_headers, user_headers):
        # Create a listing with media
        payload = _base_listing(
            name="TEST_AdminReviewMedia",
            videos=["/api/uploads/rvid.mp4"],
            audio="/api/uploads/raudio.mp3",
        )
        cr = requests.post(f"{API}/marketplace", json=payload,
                           headers=user_headers, timeout=15)
        assert cr.status_code == 200, cr.text
        listing_id = cr.json()["id"]

        r = requests.get(f"{API}/admin/marketplace", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        items = r.json().get("items", [])
        mine = next((x for x in items if x.get("id") == listing_id), None)
        assert mine, f"Newly created listing {listing_id} not returned in admin list"
        assert "videos" in mine and "audio" in mine
        assert mine["videos"] == payload["videos"]
        assert mine["audio"] == payload["audio"]


# ─── Public feed after approval ──────────────────────────────────────────────
class TestPublicFeedMedia:
    def test_public_feed_preserves_media_after_approval(self, admin_headers, user_headers):
        payload = _base_listing(
            name="TEST_FeedMedia",
            videos=["/api/uploads/fvid.mp4"],
            audio="/api/uploads/faudio.mp3",
        )
        cr = requests.post(f"{API}/marketplace", json=payload,
                           headers=user_headers, timeout=15)
        assert cr.status_code == 200
        listing_id = cr.json()["id"]
        ap = requests.post(f"{API}/admin/marketplace/{listing_id}/approve",
                           headers=admin_headers, timeout=15)
        assert ap.status_code == 200, ap.text

        feed = requests.get(f"{API}/marketplace", headers=user_headers, timeout=15)
        assert feed.status_code == 200
        items = feed.json().get("items", [])
        mine = next((x for x in items if x.get("id") == listing_id), None)
        assert mine, "Approved listing not in public feed"
        assert mine.get("videos") == payload["videos"]
        assert mine.get("audio") == payload["audio"]
