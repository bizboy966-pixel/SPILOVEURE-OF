"""v27ao — regression tests for per-item Marketplace seen tracking.

Validates :
  • /marketplace/unread-count returns 0 when every approved listing has
    an entry in marketplace_views for the user.
  • /marketplace/unread-ring returns per-item seen flags.
  • /marketplace/{id}/mark-seen is idempotent and decrements the count.
  • Owner never counts as unread for their own listing.
  • The compact 9+ variant triggers when unread_count exceeds _RING_MAX.
"""
from datetime import datetime, timezone, timedelta

import pytest
import pytest_asyncio

# Reuse the test harness pattern from the project's other backend tests.
import os
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "spilivere_test_v27ao")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


@pytest_asyncio.fixture
async def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    database = client[os.environ["DB_NAME"]]
    # Wipe test collections.
    for col in ("marketplace_listings", "marketplace_views", "users", "feature_flags"):
        await database[col].delete_many({})
    # Enable the marketplace feature flag so the endpoints don't short-circuit.
    await database.feature_flags.insert_many([
        {"key": "marketplace", "enabled": True, "updated_at": datetime.now(timezone.utc)},
    ])
    yield database
    for col in ("marketplace_listings", "marketplace_views", "users", "feature_flags"):
        await database[col].delete_many({})


async def _seed_user(db, uid="u1", role="active"):
    await db.users.insert_one({
        "id": uid, "email": f"{uid}@test.io", "username": uid,
        "status": "active", "max_level": 1, "role": role,
    })


async def _seed_listing(db, lid, seller_id="seller1", approved=True, approved_at=None):
    now = datetime.now(timezone.utc)
    doc = {
        "id": lid, "seller_id": seller_id, "status": "approved" if approved else "pending_admin_review",
        "name": lid, "category": "test", "city": "Lomé", "whatsapp": "+22890000000",
        "images": ["img"], "price": 1000, "created_at": now,
    }
    if approved:
        doc["approved_at"] = approved_at or now
        doc["expires_at"] = now + timedelta(days=14)
    await db.marketplace_listings.insert_one(doc)


async def _mock_auth(monkeypatch, uid="u1"):
    """Patch `get_current_user` to return a fake user."""
    import auth as auth_mod
    async def fake(request):
        u = await request.app.state.db.users.find_one({"id": uid})
        return u
    monkeypatch.setattr(auth_mod, "get_current_user", fake)
    # Also force the require_active_user path.
    async def fake_active(request):
        u = await request.app.state.db.users.find_one({"id": uid})
        return u
    monkeypatch.setattr(auth_mod, "require_active_user", fake_active)


@pytest.mark.asyncio
async def test_unread_ring_segments_reflect_per_item_seen(db, monkeypatch):
    """3 approved listings → ring returns 3 segments, all seen=false.
    After marking one seen, only 2 segments stay unread.
    """
    await _seed_user(db, "u1")
    for i in range(3):
        await _seed_listing(db, f"L{i}", seller_id="otherseller",
                            approved_at=datetime.now(timezone.utc) - timedelta(minutes=i))
    await _mock_auth(monkeypatch, "u1")

    # Bypass auth decorator on routers by directly calling the collection
    # queries used by the endpoint.
    from marketplace import marketplace_unread_ring, marketplace_mark_listing_seen
    class _Req:
        class _App:
            class _State: pass
        app = _App()
        app.state = _App._State()
        app.state.db = db
    req = _Req()
    u = await db.users.find_one({"id": "u1"})
    out = await marketplace_unread_ring(req, user=u)
    assert out["unread_count"] == 3
    assert len(out["segments"]) == 3
    assert all(not s["seen"] for s in out["segments"])
    assert out["has_more"] is False

    # Mark L1 seen.
    r = await marketplace_mark_listing_seen("L1", req, user=u)
    assert r["ok"] is True
    assert r["unread"] == 2

    out2 = await marketplace_unread_ring(req, user=u)
    assert out2["unread_count"] == 2
    seen_map = {s["id"]: s["seen"] for s in out2["segments"]}
    assert seen_map["L1"] is True
    assert seen_map["L0"] is False
    assert seen_map["L2"] is False


@pytest.mark.asyncio
async def test_owner_never_counted(db, monkeypatch):
    """A user's OWN listings must never appear in their unread ring."""
    await _seed_user(db, "u1")
    await _seed_listing(db, "mine", seller_id="u1")
    await _seed_listing(db, "theirs", seller_id="other")
    await _mock_auth(monkeypatch, "u1")

    from marketplace import marketplace_unread_ring
    class _Req:
        class _App:
            class _State: pass
        app = _App(); app.state = _App._State(); app.state.db = db
    req = _Req()
    u = await db.users.find_one({"id": "u1"})
    out = await marketplace_unread_ring(req, user=u)
    assert out["unread_count"] == 1
    assert len(out["segments"]) == 1
    assert out["segments"][0]["id"] == "theirs"


@pytest.mark.asyncio
async def test_mark_seen_idempotent(db, monkeypatch):
    await _seed_user(db, "u1")
    await _seed_listing(db, "L1", seller_id="other")
    await _mock_auth(monkeypatch, "u1")

    from marketplace import marketplace_mark_listing_seen, marketplace_unread_ring
    class _Req:
        class _App:
            class _State: pass
        app = _App(); app.state = _App._State(); app.state.db = db
    req = _Req()
    u = await db.users.find_one({"id": "u1"})
    r1 = await marketplace_mark_listing_seen("L1", req, user=u)
    r2 = await marketplace_mark_listing_seen("L1", req, user=u)
    assert r1["unread"] == 0 == r2["unread"]
    # Only ONE row in marketplace_views
    cnt = await db.marketplace_views.count_documents({"user_id": "u1", "listing_id": "L1"})
    assert cnt == 1


@pytest.mark.asyncio
async def test_has_more_triggers_above_ring_max(db, monkeypatch):
    """15 unread listings → has_more=True, segments len == _RING_MAX."""
    from marketplace import _RING_MAX, marketplace_unread_ring
    await _seed_user(db, "u1")
    for i in range(_RING_MAX + 5):
        await _seed_listing(db, f"L{i}", seller_id="other",
                            approved_at=datetime.now(timezone.utc) - timedelta(minutes=i))
    await _mock_auth(monkeypatch, "u1")
    class _Req:
        class _App:
            class _State: pass
        app = _App(); app.state = _App._State(); app.state.db = db
    req = _Req()
    u = await db.users.find_one({"id": "u1"})
    out = await marketplace_unread_ring(req, user=u)
    assert out["unread_count"] == _RING_MAX + 5
    assert len(out["segments"]) == _RING_MAX
    assert out["has_more"] is True


@pytest.mark.asyncio
async def test_per_user_isolation(db, monkeypatch):
    """User A seeing all items shouldn't affect User B's ring."""
    await _seed_user(db, "A")
    await _seed_user(db, "B")
    for i in range(3):
        await _seed_listing(db, f"L{i}", seller_id="seller1")
    # A marks everything seen.
    now = datetime.now(timezone.utc)
    for i in range(3):
        await db.marketplace_views.insert_one(
            {"user_id": "A", "listing_id": f"L{i}", "seen_at": now},
        )
    from marketplace import marketplace_unread_ring
    class _Req:
        class _App:
            class _State: pass
        app = _App(); app.state = _App._State(); app.state.db = db
    req = _Req()
    uA = await db.users.find_one({"id": "A"})
    uB = await db.users.find_one({"id": "B"})
    outA = await marketplace_unread_ring(req, user=uA)
    outB = await marketplace_unread_ring(req, user=uB)
    assert outA["unread_count"] == 0
    assert outB["unread_count"] == 3
