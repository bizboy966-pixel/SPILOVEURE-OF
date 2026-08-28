"""Iteration 55 — Telegram-style chat upgrade.

Covers:
  ▸ POST /api/chat/me/messages           (text message creation)
  ▸ GET  /api/chat/me                    (new `deleted` field)
  ▸ DELETE /api/chat/me/messages/{id}    (soft-delete, 403/404)
  ▸ DELETE /api/chat/admin/conversations/{cid}/messages/{id}
  ▸ GET  /api/support/chat-enabled  +  POST /api/admin/support/chat-status
  ▸ read receipts : admin msg becomes status='read' after user mark-read
"""
import os
import uuid

import pytest
import requests
from dotenv import dotenv_values

_env = dotenv_values("/app/frontend/.env")
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _env.get("REACT_APP_BACKEND_URL", "")).rstrip("/")
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


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
    uname = f"TESTchat{uuid.uuid4().hex[:8]}"
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


@pytest.fixture(scope="module")
def user_b(s):
    return _register(s)


# ── Module: chat.py — user send / list / deleted flag ──────────────────
class TestUserMessages:
    def test_send_text_message(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/chat/me/messages",
                   json={"text": "TEST_hello support"}, headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["text"] == "TEST_hello support"
        assert d["sender_role"] == "user"
        assert d["deleted"] is False
        assert isinstance(d["id"], str) and d["id"]
        user_a["msg_id"] = d["id"]

    def test_get_me_returns_deleted_field(self, s, user_a):
        r = s.get(f"{BASE_URL}/api/chat/me", headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "conversation" in d and "messages" in d
        user_a["conv_id"] = d["conversation"]["id"]
        msgs = d["messages"]
        assert len(msgs) >= 1
        target = [m for m in msgs if m["id"] == user_a["msg_id"]]
        assert target, "sent message not returned by GET /api/chat/me"
        assert target[0]["deleted"] is False
        assert target[0]["text"] == "TEST_hello support"
        # no mongo _id leaked
        assert all("_id" not in m for m in msgs)

    def test_empty_message_rejected(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "   "},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 400, r.text

    def test_unauthenticated_rejected(self, s):
        r = requests.get(f"{BASE_URL}/api/chat/me", timeout=30)
        assert r.status_code in (401, 403)


# ── Module: chat.py — DELETE /me/messages/{id} soft delete ────────────
class TestUserSoftDelete:
    def test_delete_unknown_id_404(self, s, user_a):
        r = s.delete(f"{BASE_URL}/api/chat/me/messages/{uuid.uuid4()}",
                     headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 404, r.text

    def test_delete_other_users_message_403(self, s, user_a, user_b):
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_from_b"},
                   headers=_hdr(user_b["token"]), timeout=30)
        assert r.status_code == 200, r.text
        b_msg = r.json()["id"]
        r = s.delete(f"{BASE_URL}/api/chat/me/messages/{b_msg}",
                     headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 403, r.text

    def test_delete_own_message_and_verify_redaction(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/chat/me/messages",
                   json={"text": "TEST_to_delete",
                         "images": ["data:image/png;base64,iVBORw0KGgo="]},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text
        mid = r.json()["id"]

        d = s.delete(f"{BASE_URL}/api/chat/me/messages/{mid}",
                     headers=_hdr(user_a["token"]), timeout=30)
        assert d.status_code == 200, d.text
        assert d.json().get("deleted") is True

        g = s.get(f"{BASE_URL}/api/chat/me", headers=_hdr(user_a["token"]), timeout=30)
        assert g.status_code == 200
        m = [x for x in g.json()["messages"] if x["id"] == mid]
        assert m, "deleted message id should remain in the list"
        m = m[0]
        assert m["deleted"] is True
        assert m["text"] == ""
        assert m["images"] == []
        assert m["audio"] is None

    def test_delete_twice_idempotent(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_twice"},
                   headers=_hdr(user_a["token"]), timeout=30)
        mid = r.json()["id"]
        assert s.delete(f"{BASE_URL}/api/chat/me/messages/{mid}",
                        headers=_hdr(user_a["token"]), timeout=30).status_code == 200
        r2 = s.delete(f"{BASE_URL}/api/chat/me/messages/{mid}",
                      headers=_hdr(user_a["token"]), timeout=30)
        assert r2.status_code == 200
        assert r2.json().get("already_deleted") is True


# ── Module: chat.py — admin delete route + read receipts ──────────────
class TestAdminDeleteAndReadReceipts:
    def test_admin_can_list_conversation(self, s, admin_token, user_a):
        r = s.get(f"{BASE_URL}/api/chat/admin/conversations",
                  headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        ids = [c["id"] for c in r.json()["conversations"]]
        assert user_a["conv_id"] in ids

    def test_admin_reply_then_user_mark_read_sets_read_status(self, s, admin_token, user_a):
        cid = user_a["conv_id"]
        r = s.post(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages",
                   json={"text": "TEST_admin_reply"}, headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        amid = r.json()["id"]
        assert r.json()["status"] == "delivered"
        user_a["admin_msg_id"] = amid

        mr = s.post(f"{BASE_URL}/api/chat/me/mark-read", headers=_hdr(user_a["token"]), timeout=30)
        assert mr.status_code == 200, mr.text
        assert mr.json()["ok"] is True

        g = s.get(f"{BASE_URL}/api/chat/me", headers=_hdr(user_a["token"]), timeout=30)
        m = [x for x in g.json()["messages"] if x["id"] == amid][0]
        assert m["status"] == "read", m
        assert m["read_at"] is not None
        assert g.json()["conversation"]["user_unread"] == 0

    def test_admin_mark_read_sets_user_msgs_read(self, s, admin_token, user_a):
        cid = user_a["conv_id"]
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_for_read_tick"},
                   headers=_hdr(user_a["token"]), timeout=30)
        umid = r.json()["id"]
        mr = s.post(f"{BASE_URL}/api/chat/admin/conversations/{cid}/mark-read",
                    headers=_hdr(admin_token), timeout=30)
        assert mr.status_code == 200, mr.text
        g = s.get(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages",
                  headers=_hdr(admin_token), timeout=30)
        m = [x for x in g.json()["messages"] if x["id"] == umid][0]
        assert m["status"] == "read"
        assert m["read_at"] is not None

    def test_user_cannot_use_admin_delete_route(self, s, user_a):
        cid = user_a["conv_id"]
        r = s.delete(
            f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages/{user_a['admin_msg_id']}",
            headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 403, r.text

    def test_admin_cannot_delete_user_message(self, s, admin_token, user_a):
        cid = user_a["conv_id"]
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"text": "TEST_user_msg_admin_try"},
                   headers=_hdr(user_a["token"]), timeout=30)
        umid = r.json()["id"]
        d = s.delete(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages/{umid}",
                     headers=_hdr(admin_token), timeout=30)
        assert d.status_code == 403, d.text

    def test_admin_delete_unknown_id_404(self, s, admin_token, user_a):
        cid = user_a["conv_id"]
        r = s.delete(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages/{uuid.uuid4()}",
                     headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 404, r.text

    def test_admin_deletes_own_message(self, s, admin_token, user_a):
        cid = user_a["conv_id"]
        r = s.post(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages",
                   json={"text": "TEST_admin_to_delete"}, headers=_hdr(admin_token), timeout=30)
        amid = r.json()["id"]
        d = s.delete(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages/{amid}",
                     headers=_hdr(admin_token), timeout=30)
        assert d.status_code == 200, d.text
        g = s.get(f"{BASE_URL}/api/chat/admin/conversations/{cid}/messages",
                  headers=_hdr(admin_token), timeout=30)
        m = [x for x in g.json()["messages"] if x["id"] == amid][0]
        assert m["deleted"] is True
        assert m["text"] == ""
        # user side sees it as deleted too
        gu = s.get(f"{BASE_URL}/api/chat/me", headers=_hdr(user_a["token"]), timeout=30)
        mu = [x for x in gu.json()["messages"] if x["id"] == amid][0]
        assert mu["deleted"] is True


# ── Module: support.py — global chat ON/OFF toggle ────────────────────
class TestGlobalChatToggle:
    def test_chat_enabled_default_true(self, s):
        r = s.get(f"{BASE_URL}/api/support/chat-enabled", timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["enabled"] is True

    def test_non_admin_cannot_toggle(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/admin/support/chat-status", json={"enabled": False},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code in (401, 403), r.text
        assert s.get(f"{BASE_URL}/api/support/chat-enabled", timeout=30).json()["enabled"] is True

    def test_admin_toggle_off_then_on(self, s, admin_token):
        try:
            r = s.post(f"{BASE_URL}/api/admin/support/chat-status", json={"enabled": False},
                       headers=_hdr(admin_token), timeout=30)
            assert r.status_code == 200, r.text
            assert r.json()["enabled"] is False
            assert s.get(f"{BASE_URL}/api/support/chat-enabled", timeout=30).json()["enabled"] is False
            g = s.get(f"{BASE_URL}/api/admin/support/chat-status",
                      headers=_hdr(admin_token), timeout=30)
            assert g.status_code == 200 and g.json()["enabled"] is False
        finally:
            back = s.post(f"{BASE_URL}/api/admin/support/chat-status", json={"enabled": True},
                          headers=_hdr(admin_token), timeout=30)
            assert back.status_code == 200
            assert s.get(f"{BASE_URL}/api/support/chat-enabled", timeout=30).json()["enabled"] is True


# ── Regression: support status endpoints still work ───────────────────
class TestRegression:
    def test_chat_support_status(self, s, user_a):
        r = s.get(f"{BASE_URL}/api/chat/support/status", headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text
        assert isinstance(r.json()["online"], bool)

    def test_audio_validation_rejects_bad_payload(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/chat/me/messages", json={"audio": "notadataurl"},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 400, r.text

    def test_audio_data_url_accepted(self, s, user_a):
        r = s.post(f"{BASE_URL}/api/chat/me/messages",
                   json={"audio": "data:audio/webm;base64,AAAAAAAA"},
                   headers=_hdr(user_a["token"]), timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["audio"].startswith("data:audio/webm")
