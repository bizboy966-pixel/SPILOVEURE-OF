"""Iteration 56 — chat retention purge + global master-switch server enforcement.

Covers:
  ▸ GET/POST /api/chat/admin/retention (persistence, presets, validation, RBAC)
  ▸ POST /api/admin/support/chat-status → sends blocked with HTTP 423
  ▸ chat.purge_expired_messages(db) hard-delete + retention=0 no-op
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from dotenv import dotenv_values

_env = dotenv_values("/app/frontend/.env")
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _env.get("REACT_APP_BACKEND_URL", "")).rstrip("/")
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"

DISABLED_MSG_FRAGMENT = "chat direct est temporairement désactivé"


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def admin_token(s):
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    if r.status_code != 200:
        pytest.fail(f"admin login failed {r.status_code}: {r.text[:300]}")
    return r.json()["access_token"]


def _register(s):
    uname = f"TESTret{uuid.uuid4().hex[:8]}"
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
    return {"token": d["access_token"], "user": d["user"]}


@pytest.fixture(scope="module")
def user_a(s):
    return _register(s)


def _set_chat_enabled(s, admin_token, enabled: bool):
    r = s.post(f"{BASE_URL}/api/admin/support/chat-status",
               json={"enabled": enabled}, headers=_hdr(admin_token), timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _set_retention(s, admin_token, hours: int):
    return s.post(f"{BASE_URL}/api/chat/admin/retention",
                  json={"hours": hours}, headers=_hdr(admin_token), timeout=30)


@pytest.fixture(scope="module", autouse=True)
def restore_state(s, admin_token):
    """Always leave the app with chat enabled and retention disabled."""
    yield
    try:
        _set_chat_enabled(s, admin_token, True)
        _set_retention(s, admin_token, 0)
    except Exception as e:  # pragma: no cover
        print(f"cleanup failed: {e}")


# ── Module: chat.py — retention endpoints ─────────────────────────────
class TestRetentionEndpoints:
    def test_get_retention_returns_presets(self, s, admin_token):
        r = s.get(f"{BASE_URL}/api/chat/admin/retention", headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert isinstance(d["hours"], int)
        assert d["presets"] == [0, 1, 6, 12, 24, 168, 720]

    def test_post_retention_persists(self, s, admin_token):
        r = _set_retention(s, admin_token, 24)
        assert r.status_code == 200, r.text
        assert r.json()["hours"] == 24
        g = s.get(f"{BASE_URL}/api/chat/admin/retention", headers=_hdr(admin_token), timeout=30)
        assert g.status_code == 200
        assert g.json()["hours"] == 24

    def test_post_retention_other_value_persists(self, s, admin_token):
        assert _set_retention(s, admin_token, 168).status_code == 200
        assert s.get(f"{BASE_URL}/api/chat/admin/retention",
                     headers=_hdr(admin_token), timeout=30).json()["hours"] == 168

    def test_retention_above_one_year_rejected(self, s, admin_token):
        r = _set_retention(s, admin_token, 24 * 365 + 1)
        assert r.status_code == 422, r.text

    def test_retention_negative_rejected(self, s, admin_token):
        r = _set_retention(s, admin_token, -5)
        assert r.status_code == 422, r.text

    def test_retention_requires_auth(self, s):
        r = requests.get(f"{BASE_URL}/api/chat/admin/retention", timeout=30)
        assert r.status_code in (401, 403)

    def test_regular_user_cannot_read_or_write_retention(self, s, user_a):
        g = s.get(f"{BASE_URL}/api/chat/admin/retention", headers=_hdr(user_a["token"]), timeout=30)
        assert g.status_code == 403, g.text
        p = s.post(f"{BASE_URL}/api/chat/admin/retention", json={"hours": 1},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert p.status_code == 403, p.text

    def test_support_agent_can_read_but_not_write_retention(self, s, admin_token):
        uname = f"TESTsup{uuid.uuid4().hex[:6]}"
        email = f"{uname}@example.com".lower()
        reg = s.post(f"{BASE_URL}/api/support/register",
                     json={"email": email, "username": uname, "password": "Passw0rd!TST"}, timeout=30)
        assert reg.status_code in (200, 201), reg.text
        agents = s.get(f"{BASE_URL}/api/admin/support/agents", headers=_hdr(admin_token), timeout=30)
        assert agents.status_code == 200, agents.text
        rows = agents.json().get("agents") or agents.json()
        agent = next((a for a in rows if a.get("email") == email), None)
        assert agent, f"registered support agent not listed: {str(rows)[:200]}"
        auth = s.post(f"{BASE_URL}/api/admin/support/agents/{agent['id']}/authorize",
                      headers=_hdr(admin_token), timeout=30)
        assert auth.status_code == 200, auth.text
        lg = s.post(f"{BASE_URL}/api/support/login",
                    json={"email": email, "password": "Passw0rd!TST"}, timeout=30)
        assert lg.status_code == 200, lg.text
        stoken = lg.json()["access_token"]
        try:
            g = s.get(f"{BASE_URL}/api/chat/admin/retention", headers=_hdr(stoken), timeout=30)
            assert g.status_code == 200, g.text
            assert isinstance(g.json()["hours"], int)
            p = s.post(f"{BASE_URL}/api/chat/admin/retention", json={"hours": 12},
                       headers=_hdr(stoken), timeout=30)
            assert p.status_code == 403, f"support agent should NOT change retention: {p.status_code} {p.text[:200]}"
        finally:
            s.delete(f"{BASE_URL}/api/admin/support/agents/{agent['id']}",
                     headers=_hdr(admin_token), timeout=30)

    def test_reset_to_zero(self, s, admin_token):
        assert _set_retention(s, admin_token, 0).status_code == 200
        assert s.get(f"{BASE_URL}/api/chat/admin/retention",
                     headers=_hdr(admin_token), timeout=30).json()["hours"] == 0


# ── Module: chat.py — global master switch enforced server-side ───────
class TestChatDisabledEnforcement:
    def test_user_send_blocked_when_disabled(self, s, admin_token, user_a):
        # baseline: works when enabled
        _set_chat_enabled(s, admin_token, True)
        ok = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_before_lock"},
                    headers=_hdr(user_a["token"]), timeout=30)
        assert ok.status_code == 200, ok.text
        user_a["msg_id"] = ok.json()["id"]

        _set_chat_enabled(s, admin_token, False)
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_during_lock"},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 423, f"{r.status_code}: {r.text[:300]}"
        assert DISABLED_MSG_FRAGMENT in r.json().get("detail", "")

    def test_admin_send_blocked_when_disabled(self, s, admin_token, user_a):
        me = s.get(f"{BASE_URL}/api/chat/me", headers=_hdr(user_a["token"]), timeout=30)
        assert me.status_code == 200, me.text
        cid = me.json()["conversation"]["id"]
        user_a["conv_id"] = cid
        r = s.post(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages",
                   json={"text": "TEST_admin_during_lock"}, headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 423, f"{r.status_code}: {r.text[:300]}"
        assert DISABLED_MSG_FRAGMENT in r.json().get("detail", "")

    def test_reads_still_work_when_disabled(self, s, user_a):
        r = s.get(f"{BASE_URL}/api/chat/me", headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text

    def test_delete_still_works_when_disabled(self, s, user_a):
        r = s.delete(f"{BASE_URL}/api/chat/me/messages/{user_a['msg_id']}",
                     headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
        assert r.json().get("deleted") or r.json().get("already_deleted")

    def test_send_works_again_after_reenable(self, s, admin_token, user_a):
        _set_chat_enabled(s, admin_token, True)
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_after_unlock"},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["text"] == "TEST_after_unlock"
        cid = user_a.get("conv_id")
        a = s.post(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages",
                   json={"text": "TEST_admin_after_unlock"}, headers=_hdr(admin_token), timeout=30)
        assert a.status_code == 200, a.text


# ── Module: chat.purge_expired_messages ──────────────────────────────
sys.path.insert(0, "/app/backend")


def _db():
    from motor.motor_asyncio import AsyncIOMotorClient
    benv = dotenv_values("/app/backend/.env")
    mongo_url = os.environ.get("MONGO_URL") or benv.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME") or benv.get("DB_NAME")
    assert mongo_url and db_name, "MONGO_URL/DB_NAME missing in /app/backend/.env"
    return AsyncIOMotorClient(mongo_url)[db_name]


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestPurgeFunction:
    def test_purge_deletes_old_messages(self):
        import chat

        async def scenario():
            db = _db()
            old_id = f"TESTPURGE-{uuid.uuid4()}"
            recent_id = f"TESTKEEP-{uuid.uuid4()}"
            conv_id = f"TESTCONV-{uuid.uuid4()}"
            now = datetime.now(timezone.utc)
            await db.chat_messages.insert_many([
                {"id": old_id, "conversation_id": conv_id, "sender_id": "x",
                 "sender_role": "user", "text": "TEST_old", "images": [],
                 "status": "sent", "created_at": now - timedelta(hours=100)},
                {"id": recent_id, "conversation_id": conv_id, "sender_id": "x",
                 "sender_role": "user", "text": "TEST_recent", "images": [],
                 "status": "sent", "created_at": now},
            ])
            prev = await db.app_settings.find_one({"key": "chat_message_retention_hours"}, {"_id": 0})
            try:
                await db.app_settings.update_one(
                    {"key": "chat_message_retention_hours"}, {"$set": {"value": 1}}, upsert=True)
                stats = await chat.purge_expired_messages(db)
                gone = await db.chat_messages.find_one({"id": old_id})
                kept = await db.chat_messages.find_one({"id": recent_id})
                return stats, gone, kept, prev, db, recent_id
            finally:
                pass

        stats, gone, kept, prev, db, recent_id = _run(scenario())
        assert stats["skipped"] is False
        assert stats["hours"] == 1
        assert stats["purged"] >= 1
        assert gone is None, "old message was not permanently deleted"
        assert kept is not None, "recent message was wrongly purged"

        async def cleanup():
            d = _db()
            await d.chat_messages.delete_one({"id": recent_id})
            await d.app_settings.update_one(
                {"key": "chat_message_retention_hours"},
                {"$set": {"value": int((prev or {}).get("value", 0))}}, upsert=True)
        _run(cleanup())

    def test_purge_noop_when_retention_zero(self):
        import chat

        async def scenario():
            db = _db()
            mid = f"TESTNOOP-{uuid.uuid4()}"
            await db.chat_messages.insert_one({
                "id": mid, "conversation_id": f"TESTCONV-{uuid.uuid4()}", "sender_id": "x",
                "sender_role": "user", "text": "TEST_noop", "images": [], "status": "sent",
                "created_at": datetime.now(timezone.utc) - timedelta(hours=1000),
            })
            await db.app_settings.update_one(
                {"key": "chat_message_retention_hours"}, {"$set": {"value": 0}}, upsert=True)
            stats = await chat.purge_expired_messages(db)
            still = await db.chat_messages.find_one({"id": mid})
            await db.chat_messages.delete_one({"id": mid})
            return stats, still

        stats, still = _run(scenario())
        assert stats == {"purged": 0, "hours": 0, "skipped": True}
        assert still is not None, "retention=0 should be a no-op"


# ── Module: server.py — retention worker scheduled at startup ─────────
def test_retention_worker_logged_at_startup():
    import subprocess
    out = subprocess.run(
        ["bash", "-lc", "grep -h 'retention worker' /var/log/supervisor/backend*.log | tail -5"],
        capture_output=True, text=True).stdout
    assert "retention worker started" in out or "retention worker scheduled" in out.lower(), \
        f"no retention worker log found: {out[:300]}"
