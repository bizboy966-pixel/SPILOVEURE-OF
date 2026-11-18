"""Regression — the admin activations list, when filtered by
`?status=pending`, must return exactly the same count as the dashboard's
`activations_pending` stat. Prior to the 2026-08 fix these two numbers
could diverge (108 vs 4 reported in prod) because the list endpoint
loaded up to 500 payments *without* pushing the status filter into
MongoDB, so recent VALIDATED payments dominated the window and truncated
the pending ones.
"""
from __future__ import annotations

import os
import pytest
import requests

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api" if "REACT_APP_BACKEND_URL" in os.environ else "http://localhost:8001/api"
ADMIN = {"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"}


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=15)
    r.raise_for_status()
    b = r.json()
    tok = b.get("access_token") or b.get("token")
    return {"Authorization": f"Bearer {tok}"}


def test_pending_list_matches_dashboard_counter(admin_headers):
    """`GET /admin/activations?status=pending` count == stats.activations_pending."""
    stats = requests.get(f"{API}/admin/stats", headers=admin_headers, timeout=15).json()
    expected = int(stats.get("activations_pending") or 0)

    lst = requests.get(f"{API}/admin/activations?status=pending",
                       headers=admin_headers, timeout=15).json()
    assert isinstance(lst, list)
    # Every returned row must genuinely be pending.
    for a in lst:
        assert a.get("status") == "pending", f"leak: {a.get('status')} in pending list"
    # The two counters must match exactly.
    assert len(lst) == expected, (
        f"Dashboard/list mismatch: stats={expected} vs list={len(lst)}"
    )


def test_validated_status_filter_returns_only_validated(admin_headers):
    lst = requests.get(f"{API}/admin/activations?status=validated",
                       headers=admin_headers, timeout=15).json()
    for a in lst:
        assert a.get("status") == "validated"


def test_rejected_status_filter_returns_only_rejected(admin_headers):
    lst = requests.get(f"{API}/admin/activations?status=rejected",
                       headers=admin_headers, timeout=15).json()
    for a in lst:
        assert a.get("status") == "rejected"
