"""Iteration 50 — Ads comment REPLY (creator quote-reply), admin delete of
comment/reply, anti-spam ignores replies, push broadcasts on ad + marketplace
approval.

Push notifications are fire-and-forget — we only verify that endpoints do
NOT raise even when firebase has no real tokens (there are none in this
env). This validates the try/except wrap around push_helper.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

# Load from frontend/.env since REACT_APP_BACKEND_URL isn't in the shell env
def _load_backend_url():
    if os.environ.get("REACT_APP_BACKEND_URL"):
        return os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not found")


BASE_URL = _load_backend_url()
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"

MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "spilivere"


# ── Fixtures ─────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def admin(s):
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    return {"token": d["access_token"], "user": d["user"]}


@pytest.fixture(scope="module")
def normal_user(s):
    uname = f"tst{uuid.uuid4().hex[:8]}"
    payload = {
        "username": uname,
        "email": f"{uname}@example.com",
        "country": "TG",
        "phone": f"+228{uuid.uuid4().int % 100000000:08d}",
        "password": "Passw0rd!TST",
        "password_confirm": "Passw0rd!TST",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = s.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    d = r.json()
    return {"token": d["access_token"], "user": d["user"], "raw": payload}


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(scope="module")
def db():
    client = AsyncIOMotorClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture(scope="module")
def seeded_ad(db, admin):
    """Insert a published ad owned by admin so we can test comment/reply."""
    ad_id = f"TESTAD-{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc)
    doc = {
        "id": ad_id,
        "user_id": admin["user"]["id"],
        "username": admin["user"].get("username") or "admin",
        "cover_image_url": "https://example.com/cover.jpg",
        "video_url": None,
        "description": "TEST ad iter50",
        "title": "TEST_ITER50",
        "media_type": "poster",
        "target_countries": ["TG"],
        "target_age_min": 18,
        "target_age_max": 60,
        "target_gender": "all",
        "duration_days": 1,
        "price_amount": 500.0,
        "currency": "FCFA",
        "status": "published",
        "views_count": 0, "shares_count": 0, "likes": [], "comments": [],
        "created_at": now, "updated_at": now, "published_at": now,
    }
    _run(db.ads.insert_one(doc))
    yield ad_id
    _run(db.ads.delete_one({"id": ad_id}))


@pytest.fixture(scope="module")
def seeded_ad_pending(db, admin):
    """Ad in pending_admin_review — used to test admin approve broadcast."""
    ad_id = f"TESTADP-{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc)
    doc = {
        "id": ad_id, "user_id": admin["user"]["id"],
        "username": admin["user"].get("username") or "admin",
        "cover_image_url": "https://example.com/cover.jpg", "video_url": None,
        "description": "TEST pending ad", "title": "TEST_ITER50_PENDING",
        "media_type": "poster", "target_countries": ["TG"],
        "target_age_min": 18, "target_age_max": 60, "target_gender": "all",
        "duration_days": 1, "price_amount": 500.0, "currency": "FCFA",
        "status": "pending_admin_review",
        "views_count": 0, "shares_count": 0, "likes": [], "comments": [],
        "created_at": now, "updated_at": now,
    }
    _run(db.ads.insert_one(doc))
    yield ad_id
    _run(db.ads.delete_one({"id": ad_id}))


@pytest.fixture(scope="module")
def seeded_listing_pending(db, admin):
    lid = f"TESTLST-{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc)
    doc = {
        "id": lid, "user_id": admin["user"]["id"],
        "username": admin["user"].get("username") or "admin",
        "title": "TEST_ITER50_LST",
        "description": "test", "price": 1000, "currency": "FCFA",
        "cover_image_url": "https://example.com/cover.jpg",
        "images": [], "status": "pending_admin_review",
        "created_at": now, "viewers": [],
    }
    _run(db.marketplace_listings.insert_one(doc))
    yield lid
    _run(db.marketplace_listings.delete_one({"id": lid}))


# ── Tests: reply endpoint ───────────────────────────────────────────────
class TestReplyEndpoint:
    def test_normal_user_can_post_root_comment(self, s, seeded_ad, normal_user):
        r = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment",
                   headers=_hdr(normal_user["token"]),
                   json={"text": "Super publicité, bravo !"}, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["comment"]["text"] == "Super publicité, bravo !"
        assert not d["comment"].get("is_reply")
        # normal user is pending (max_level=0) so should NOT be rewarded.
        # reward may be None — but field must exist per contract.
        assert "reward" in d
        # Save id for later tests
        pytest.root_comment_id = d["comment"]["id"]

    def test_non_creator_cannot_reply(self, s, seeded_ad, normal_user):
        r = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment/reply",
                   headers=_hdr(normal_user["token"]),
                   json={"text": "hack", "reply_to_comment_id": pytest.root_comment_id},
                   timeout=30)
        assert r.status_code == 403, r.text

    def test_reply_to_missing_comment_404(self, s, seeded_ad, admin):
        r = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment/reply",
                   headers=_hdr(admin["token"]),
                   json={"text": "hi", "reply_to_comment_id": "does-not-exist"},
                   timeout=30)
        assert r.status_code == 404, r.text

    def test_creator_can_reply(self, s, seeded_ad, admin):
        r = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment/reply",
                   headers=_hdr(admin["token"]),
                   json={"text": "Merci beaucoup !",
                         "reply_to_comment_id": pytest.root_comment_id},
                   timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "reward" not in d, "Reply must NOT include reward field"
        rep = d["reply"]
        assert rep["is_reply"] is True
        assert rep["reply_to_comment_id"] == pytest.root_comment_id
        assert rep["reply_to_username"]  # user who wrote root
        assert rep["reply_to_text"]  # snippet
        assert len(rep["reply_to_text"]) <= 200
        pytest.reply_id = rep["id"]

    def test_antispam_ignores_replies(self, s, seeded_ad, admin, normal_user):
        """Creator can reply with the SAME text as the parent — proving the
        reply endpoint doesn't run anti-spam heuristic."""
        r = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment/reply",
                   headers=_hdr(admin["token"]),
                   json={"text": "Super publicité, bravo !",
                         "reply_to_comment_id": pytest.root_comment_id},
                   timeout=30)
        assert r.status_code == 200, r.text
        # Now user tries to post a NEW root comment that only matches the
        # REPLY (unique words the root doesn't have) — must succeed because
        # spam heuristic only considers root comments.
        r2 = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment",
                    headers=_hdr(normal_user["token"]),
                    json={"text": "Merci beaucoup pour cette information"},
                    timeout=30)
        assert r2.status_code == 200, r2.text

    def test_duplicate_root_comment_still_blocked(self, s, seeded_ad, normal_user):
        """Even with replies present, an exact duplicate of a ROOT comment
        must still be blocked by anti-spam."""
        r = s.post(f"{BASE_URL}/api/ads/{seeded_ad}/comment",
                   headers=_hdr(normal_user["token"]),
                   json={"text": "Super publicité, bravo !"}, timeout=30)
        assert r.status_code == 400, r.text


# ── Tests: admin delete ─────────────────────────────────────────────────
class TestAdminDelete:
    def test_admin_delete_reply(self, s, seeded_ad, admin):
        r = s.delete(f"{BASE_URL}/api/admin/ads/{seeded_ad}/comments/{pytest.reply_id}",
                     headers=_hdr(admin["token"]), timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ok"] is True and d["deleted"] is True

    def test_admin_delete_root_comment(self, s, seeded_ad, admin):
        r = s.delete(f"{BASE_URL}/api/admin/ads/{seeded_ad}/comments/{pytest.root_comment_id}",
                     headers=_hdr(admin["token"]), timeout=30)
        assert r.status_code == 200, r.text

    def test_admin_delete_missing_404(self, s, seeded_ad, admin):
        r = s.delete(f"{BASE_URL}/api/admin/ads/{seeded_ad}/comments/does-not-exist",
                     headers=_hdr(admin["token"]), timeout=30)
        assert r.status_code == 404, r.text

    def test_normal_user_cannot_delete(self, s, seeded_ad, normal_user):
        r = s.delete(f"{BASE_URL}/api/admin/ads/{seeded_ad}/comments/whatever",
                     headers=_hdr(normal_user["token"]), timeout=30)
        # Admin-only route ⇒ 401/403
        assert r.status_code in (401, 403), r.text


# ── Tests: admin approve → broadcast (verify no crash) ──────────────────
class TestApproveBroadcast:
    def test_admin_approve_ad_triggers_push(self, s, admin, seeded_ad_pending, db):
        r = s.post(f"{BASE_URL}/api/admin/ads/{seeded_ad_pending}/approve",
                   headers=_hdr(admin["token"]), timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "published"
        assert d.get("published_at")

    def test_admin_approve_marketplace_triggers_push(self, s, admin, seeded_listing_pending):
        r = s.post(f"{BASE_URL}/api/admin/marketplace/{seeded_listing_pending}/approve",
                   headers=_hdr(admin["token"]), timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "approved"


# ── Tests: add_comment triggers push_to_user (no crash) ─────────────────
class TestCommentPushNoCrash:
    def test_comment_flow_survives_push(self, s, admin, normal_user, db):
        # Fresh ad so we don't hit anti-spam collisions.
        ad_id = f"TESTAD2-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        _run(db.ads.insert_one({
            "id": ad_id, "user_id": admin["user"]["id"],
            "username": "admin",
            "cover_image_url": "https://example.com/x.jpg", "video_url": None,
            "description": "d", "title": "T", "media_type": "poster",
            "target_countries": ["TG"], "duration_days": 1,
            "price_amount": 100.0, "currency": "FCFA",
            "status": "published", "views_count": 0, "shares_count": 0,
            "likes": [], "comments": [], "created_at": now, "updated_at": now,
        }))
        try:
            r = s.post(f"{BASE_URL}/api/ads/{ad_id}/comment",
                       headers=_hdr(normal_user["token"]),
                       json={"text": "commentaire push test unique 123"}, timeout=30)
            assert r.status_code == 200, r.text
            assert "comment" in r.json()
        finally:
            _run(db.ads.delete_one({"id": ad_id}))
