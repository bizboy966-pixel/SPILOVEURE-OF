"""Regression: Jobs (Emploi) CRUD contract + public read-only visibility.

Guards:
  * Admin can POST / PUT / DELETE / toggle jobs.
  * Public GET /api/jobs only returns active offers.
  * Required fields (title/description/contact/country) are enforced.
"""
from __future__ import annotations

import os
import pytest
import httpx


API_URL = os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:8001"
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


async def _login(client: httpx.AsyncClient) -> str:
    r = await client.post(
        f"{API_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    r.raise_for_status()
    body = r.json()
    return body.get("token") or body["access_token"]


@pytest.mark.asyncio
async def test_jobs_full_crud_flow():
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        h = {"Authorization": f"Bearer {token}"}

        # CREATE
        r = await client.post(f"{API_URL}/api/admin/jobs", headers=h, json={
            "title": "Test Job Auto",
            "description": "Description longue " * 20,
            "contact": "+228 90 00 00 00",
            "country": "TG",
            "salary": "150 000 FCFA",
            "active": True,
        })
        assert r.status_code == 200, r.text
        job = r.json()
        jid = job["id"]
        assert job["title"] == "Test Job Auto"
        assert job["country"] == "TG"

        try:
            # PUBLIC LIST — must include the active job
            r = await client.get(f"{API_URL}/api/jobs", headers=h)
            r.raise_for_status()
            titles = [j["title"] for j in r.json()]
            assert "Test Job Auto" in titles

            # TOGGLE (deactivate)
            r = await client.post(f"{API_URL}/api/admin/jobs/{jid}/toggle", headers=h)
            r.raise_for_status()
            assert r.json()["active"] is False

            # PUBLIC LIST — must now HIDE inactive
            r = await client.get(f"{API_URL}/api/jobs", headers=h)
            titles = [j["title"] for j in r.json()]
            assert "Test Job Auto" not in titles

            # UPDATE (reactivate + change title)
            r = await client.put(f"{API_URL}/api/admin/jobs/{jid}", headers=h, json={
                "title": "Test Job Auto v2",
                "description": "New desc",
                "contact": "jobs@example.com",
                "country": "CI",
                "salary": None,
                "active": True,
            })
            r.raise_for_status()
            updated = r.json()
            assert updated["title"] == "Test Job Auto v2"
            assert updated["country"] == "CI"
            assert updated["salary"] is None
            assert updated["active"] is True

            # ADMIN LIST always returns everything
            r = await client.get(f"{API_URL}/api/admin/jobs", headers=h)
            r.raise_for_status()
            ids = [j["id"] for j in r.json()]
            assert jid in ids
        finally:
            # DELETE (cleanup)
            r = await client.delete(f"{API_URL}/api/admin/jobs/{jid}", headers=h)
            assert r.status_code in (200, 404)


@pytest.mark.asyncio
async def test_jobs_required_fields_rejected():
    async with httpx.AsyncClient(timeout=30) as client:
        token = await _login(client)
        h = {"Authorization": f"Bearer {token}"}
        # Missing title
        r = await client.post(f"{API_URL}/api/admin/jobs", headers=h, json={
            "title": "",
            "description": "x",
            "contact": "x",
            "country": "TG",
        })
        assert r.status_code == 422
        # Empty description
        r = await client.post(f"{API_URL}/api/admin/jobs", headers=h, json={
            "title": "x",
            "description": "   ",
            "contact": "x",
            "country": "TG",
        })
        assert r.status_code == 422


@pytest.mark.asyncio
async def test_jobs_public_endpoint_requires_auth():
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{API_URL}/api/jobs")
        # Auth required (any authenticated user) — must reject anonymous.
        assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_admin_endpoints_require_admin():
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{API_URL}/api/admin/jobs")
        assert r.status_code in (401, 403)
