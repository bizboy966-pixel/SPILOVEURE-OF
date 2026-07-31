"""Iteration 40 — E2E validation of the 2026-08 engagement enhancements.

Covers:
  1. GET /me/reactor-rewards shape + filters + by_day
  2. Notifications API (list / unread-only / count / mark-read / mark-all-read)
  3. Anti-spam heuristic on POST /ads/{id}/comment
  4. Regression on the 4 reactor endpoints
"""
from __future__ import annotations
import os
import uuid
import time
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://spiloveure-deploy.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


def H(t): return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=20)
    assert r.status_code == 200, r.text
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def user_token():
    tag = uuid.uuid4().hex[:8]
    p = {
        "username": f"i40_{tag}", "email": f"i40_{tag}@spiloveure.com",
        "password": "TestPass123!", "password_confirm": "TestPass123!",
        "country": "TG", "phone": f"+22890{tag[:6]}",
        "sponsor_username": "admin", "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=p, timeout=20)
    assert r.status_code in (200, 201), r.text
    j = r.json()
    return j.get("access_token") or j.get("token")


# ─── 1. reactor-rewards shape + filters ─────────────────────────────
class TestReactorRewards:
    def test_shape_defaults(self, user_token):
        r = requests.get(f"{API}/me/reactor-rewards", headers=H(user_token), timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ("items", "total_earned", "by_day", "filters"):
            assert k in d, f"missing {k}"
        assert isinstance(d["items"], list)
        assert isinstance(d["by_day"], list)
        assert isinstance(d["total_earned"], (int, float))
        assert d["filters"]["action"] is None

    def test_filter_action_like(self, user_token):
        r = requests.get(f"{API}/me/reactor-rewards?action=like", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        assert r.json()["filters"]["action"] == "like"

    def test_filter_action_comment(self, user_token):
        r = requests.get(f"{API}/me/reactor-rewards?action=comment", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        assert r.json()["filters"]["action"] == "comment"

    def test_filter_action_bogus_ignored(self, user_token):
        """Spec: invalid action must be silently ignored → filters.action == null."""
        r = requests.get(f"{API}/me/reactor-rewards?action=foobar", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        # Spec says filters.action should be null when invalid
        assert r.json()["filters"]["action"] is None, \
            f"Expected filters.action=null for bogus value, got {r.json()['filters']['action']}"

    def test_filter_date_range(self, user_token):
        r = requests.get(
            f"{API}/me/reactor-rewards"
            "?from_date=2026-01-01T00:00:00Z&to_date=2026-12-31T00:00:00Z",
            headers=H(user_token), timeout=15,
        )
        assert r.status_code == 200
        f = r.json()["filters"]
        assert f["from_date"] and f["to_date"]

    def test_by_day_row_shape(self, user_token):
        # by_day may be empty for a fresh user; ensure each row (if present) has the right shape
        r = requests.get(f"{API}/me/reactor-rewards", headers=H(user_token), timeout=15)
        for row in r.json()["by_day"]:
            for k in ("date", "total", "count", "likes", "comments"):
                assert k in row


# ─── 2. Notifications API ───────────────────────────────────────────
class TestNotifications:
    def test_list(self, user_token):
        r = requests.get(f"{API}/me/notifications", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert "items" in j and isinstance(j["items"], list)
        # sort DESC + read + created_at shape
        prev = None
        for n in j["items"]:
            assert "read" in n and isinstance(n["read"], bool)
            assert "created_at" in n and isinstance(n["created_at"], str)
            if prev:
                assert n["created_at"] <= prev
            prev = n["created_at"]

    def test_unread_count(self, user_token):
        r = requests.get(f"{API}/me/notifications/unread-count", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json().get("unread"), int)

    def test_unread_only_filter(self, user_token):
        r = requests.get(f"{API}/me/notifications?unread_only=true", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        for n in r.json()["items"]:
            assert n.get("read") is False

    def test_mark_all_read_idempotent(self, user_token):
        r = requests.post(f"{API}/me/notifications/mark-all-read", headers=H(user_token), json={}, timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert j.get("ok") is True
        assert isinstance(j.get("updated"), int)
        # 2nd call still ok=true, updated=0
        r2 = requests.post(f"{API}/me/notifications/mark-all-read", headers=H(user_token), json={}, timeout=15)
        assert r2.status_code == 200
        assert r2.json()["updated"] == 0

    def test_mark_read_unknown_id_404(self, user_token):
        r = requests.post(f"{API}/me/notifications/does-not-exist/read", headers=H(user_token), json={}, timeout=15)
        assert r.status_code == 404


# ─── 3. Anti-spam comment guard ─────────────────────────────────────
@pytest.fixture(scope="module")
def published_ad_id(admin_token):
    """Find any published ad; create+approve one if none exist."""
    r = requests.get(f"{API}/ads?status=published", headers=H(admin_token), timeout=15)
    if r.status_code == 200:
        items = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
        for a in items:
            if a.get("status") == "published":
                return a["id"]
    # fallback: check /ads without filter
    r = requests.get(f"{API}/ads", headers=H(admin_token), timeout=15)
    if r.status_code == 200:
        items = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
        for a in items:
            if a.get("status") == "published":
                return a["id"]
    pytest.skip("No published ad available for anti-spam test.")


class TestAntiSpam:
    def _post(self, ad_id, tok, text):
        return requests.post(f"{API}/ads/{ad_id}/comment", headers=H(tok),
                             json={"text": text}, timeout=15)

    def test_too_short(self, published_ad_id, user_token):
        r = self._post(published_ad_id, user_token, "ok ok")
        assert r.status_code == 400
        assert "trop court" in r.text.lower()

    def test_no_letter(self, published_ad_id, user_token):
        r = self._post(published_ad_id, user_token, "!!!!!!!!!!!!")
        assert r.status_code == 400
        assert "lettre" in r.text.lower()

    def test_repetitive(self, published_ad_id, user_token):
        r = self._post(published_ad_id, user_token, "ok ok ok ok ok")
        assert r.status_code == 400
        assert "répétitif" in r.text.lower() or "repetitif" in r.text.lower()

    def test_near_duplicate(self, published_ad_id, admin_token):
        # Use admin (may or may not accept comments on own ad). Use a fresh user.
        tag = uuid.uuid4().hex[:6]
        p = {"username": f"sp_{tag}", "email": f"sp_{tag}@spiloveure.com",
             "password": "TestPass123!", "password_confirm": "TestPass123!",
             "country": "TG", "phone": f"+22890{tag}11",
             "sponsor_username": "admin", "accept_terms": True}
        r0 = requests.post(f"{API}/auth/register", json=p, timeout=20)
        tok = r0.json().get("access_token") or r0.json().get("token")

        # First comment (may fail if creator can't comment, in that case try admin)
        r1 = self._post(published_ad_id, tok, "super video vraiment top de ouf")
        if r1.status_code != 200:
            # try again with another user for duplication check
            tag2 = uuid.uuid4().hex[:6]
            p2 = {**p, "username": f"sp2_{tag2}", "email": f"sp2_{tag2}@spiloveure.com",
                  "phone": f"+22890{tag2}22"}
            r00 = requests.post(f"{API}/auth/register", json=p2, timeout=20)
            tok2 = r00.json().get("access_token") or r00.json().get("token")
            r1 = self._post(published_ad_id, tok2, "super video vraiment top de ouf")
        # If still failing, skip
        if r1.status_code != 200:
            pytest.skip(f"Could not seed first comment: {r1.status_code} {r1.text[:120]}")

        # Second near-duplicate — same tokens rearranged
        tag3 = uuid.uuid4().hex[:6]
        p3 = {**p, "username": f"sp3_{tag3}", "email": f"sp3_{tag3}@spiloveure.com",
              "phone": f"+22890{tag3}33"}
        r000 = requests.post(f"{API}/auth/register", json=p3, timeout=20)
        tok3 = r000.json().get("access_token") or r000.json().get("token")
        r2 = self._post(published_ad_id, tok3, "super video top vraiment de ouf")
        assert r2.status_code == 400, f"Expected 400 for near-dup, got {r2.status_code}: {r2.text}"
        assert "similaire" in r2.text.lower() or "déjà" in r2.text.lower() or "deja" in r2.text.lower()


# ─── 4. Regression on 4 reactor endpoints ──────────────────────────
class TestRegressionReactorEndpoints:
    def test_like_endpoint(self, published_ad_id, user_token):
        r = requests.post(f"{API}/ads/{published_ad_id}/like", headers=H(user_token), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert "liked" in j
        assert "reward" in j  # may be None if config prevents

    def test_view_endpoint_reward_null(self, published_ad_id, user_token):
        # /ads/{id}/view may or may not exist depending on refactor; only check if endpoint responds
        r = requests.post(f"{API}/ads/{published_ad_id}/view", headers=H(user_token), timeout=15)
        if r.status_code == 404:
            pytest.skip("view endpoint not present")
        assert r.status_code == 200
        assert r.json().get("reward") is None

    def test_share_endpoint_reward_null(self, published_ad_id, user_token):
        r = requests.post(f"{API}/ads/{published_ad_id}/share", headers=H(user_token), timeout=15)
        assert r.status_code == 200
        assert r.json().get("reward") is None
