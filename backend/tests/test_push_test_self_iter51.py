"""Iteration 51 — validate the push URL absolute-normalisation fix.

Focus:
  1. `_absolute_link` unit behaviour
  2. POST /api/push/tokens (register a fake invalid token)
  3. POST /api/push/test-self returns {requested>=1, failure>=1, removed_invalid>=1}
  4. Fake token is deleted from Mongo after test-self
  5. No 'WebpushFCMOptions.link must be a HTTPS URL' error appears in the
     backend logs after the flow.
"""
from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"

# ────────────────────────── unit test for _absolute_link ──────────────────────
def test_absolute_link_unit(monkeypatch):
    # Force PUBLIC_APP_URL to the production value the backend actually uses
    # (loaded from /app/backend/.env at runtime). Our pytest process does
    # NOT auto-load that file, so we set it explicitly here.
    monkeypatch.setenv("PUBLIC_APP_URL", "https://spiloveure.com")
    import sys
    sys.path.insert(0, "/app/backend")
    if "push_helper" in sys.modules:
        del sys.modules["push_helper"]
    import push_helper  # noqa
    assert push_helper._absolute_link(None) is None
    assert push_helper._absolute_link("") is None
    assert push_helper._absolute_link("/(app)/ads") == "https://spiloveure.com/(app)/ads"
    # Missing leading slash still normalised
    assert push_helper._absolute_link("(app)/ads") == "https://spiloveure.com/(app)/ads"
    # Already absolute → unchanged
    assert push_helper._absolute_link("https://example.com/x") == "https://example.com/x"
    assert push_helper._absolute_link("http://example.com/x") == "http://example.com/x"


# ─────────────────────────── HTTP fixtures ────────────────────────────────────
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=15)
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:200]}")
    return r.json()["access_token"] if "access_token" in r.json() else r.json().get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    assert admin_token, "no token returned by /auth/login"
    return {"Authorization": f"Bearer {admin_token}"}


# ─────────────────────────── HTTP tests ───────────────────────────────────────
FAKE_TOKEN = "fake_test_token_" + "x" * 40  # length >=20 required by TokenIn
DEVICE_ID = f"test-dev-{uuid.uuid4().hex[:10]}"


def test_register_fake_token(admin_headers):
    r = requests.post(f"{BASE_URL}/api/push/tokens",
                      headers=admin_headers,
                      json={"token": FAKE_TOKEN, "device_id": DEVICE_ID,
                            "platform": "web"},
                      timeout=15)
    assert r.status_code == 200, r.text
    assert r.json().get("ok") is True


def _read_backend_log_tail(bytes_from_end: int = 200_000) -> str:
    logs = []
    for p in Path("/var/log/supervisor").glob("backend.*.log"):
        try:
            with p.open("rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - bytes_from_end))
                logs.append(f.read().decode("utf-8", "ignore"))
        except OSError:
            pass
    return "\n".join(logs)


def test_push_test_self_prunes_fake_token(admin_headers):
    # Snapshot the log offset BEFORE calling the endpoint so we only search
    # the new lines produced by this specific request.
    log_before = _read_backend_log_tail(500_000)
    marker_offset = len(log_before)

    r = requests.post(f"{BASE_URL}/api/push/test-self",
                      headers=admin_headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("requested", 0) >= 1, data
    # At least one failure (invalid token) and it should be pruned.
    assert data.get("failure", 0) >= 1, data
    assert data.get("removed_invalid", 0) >= 1, data

    # Give supervisor a moment to flush logs, then re-read.
    time.sleep(1.5)
    log_after = _read_backend_log_tail(500_000)
    new_slice = log_after[marker_offset:] if len(log_after) >= marker_offset else log_after
    forbidden = "WebpushFCMOptions.link must be a HTTPS URL"
    assert forbidden not in new_slice, \
        f"Regression: forbidden error still present in backend logs after fix. Slice:\n{new_slice[-2000:]}"


def test_fake_token_removed_from_db_via_second_call(admin_headers):
    """After the previous test, the fake token was pruned — a second
    test-self should either report requested=0 (no tokens left) OR at
    least NOT re-include our fake token."""
    r = requests.post(f"{BASE_URL}/api/push/test-self",
                      headers=admin_headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    # Whatever real tokens the admin also has, our fake one should be
    # gone → removed_invalid for THIS second call should be 0 unless
    # another fake token was registered concurrently.
    assert data.get("removed_invalid", 0) == 0, data
