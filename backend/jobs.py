"""Jobs (Emploi) module — admin-only publication, public read-only access.

Business rules
--------------
* Only admins can create / update / delete / toggle a job offer.
* Any authenticated user can list active jobs (activated OR pending, since
  the platform explicitly wants job hunting to be free).
* Description is stored as a plain string with no size cap so the UI can
  render it in full without a "voir plus" affordance.
* Image is optional — jobs can be published text-only.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from auth import get_current_user, require_admin

log = logging.getLogger("jobs")


# ============ Pydantic models ============

class JobIn(BaseModel):
    """Payload accepted by both POST (create) and PUT (update).

    All non-optional fields are trimmed on the server and rejected if empty,
    which mirrors the "obligatoire" contract described in the product spec.
    """

    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    contact: str = Field(min_length=1, max_length=500)
    country: str = Field(min_length=2, max_length=3)  # ISO alpha-2/3 code
    salary: Optional[str] = Field(default=None, max_length=200)
    image_url: Optional[str] = Field(default=None, max_length=2000)
    active: bool = True

    @field_validator("title", "description", "contact", "country")
    @classmethod
    def _strip_required(cls, v: str) -> str:
        s = (v or "").strip()
        if not s:
            raise ValueError("Ce champ est obligatoire.")
        return s

    @field_validator("salary", "image_url")
    @classmethod
    def _strip_optional(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip()
        return s or None


# ============ Routers ============

# Note: the `dependencies` on admin_router is inherited from server.py where
# require_admin is applied. Here we still add `require_admin` explicitly for
# safety in case the module is imported standalone.
public_router = APIRouter(prefix="/api", tags=["jobs"])
admin_router = APIRouter(prefix="/api/admin", tags=["jobs_admin"])


def _serialize(doc: dict) -> dict:
    """Strip Mongo internals and coerce dates to isoformat strings."""
    if not doc:
        return doc
    doc.pop("_id", None)
    for k in ("created_at", "updated_at"):
        if isinstance(doc.get(k), datetime):
            doc[k] = doc[k].isoformat()
    return doc


# ---------- Public endpoints ----------

@public_router.get("/jobs")
async def list_jobs(request: Request, user=Depends(get_current_user)) -> List[dict]:
    """Return every ACTIVE job offer sorted by most recent first.

    Any authenticated user can call this, activated or not. The admin panel
    calls the /admin variant which also returns inactive offers.
    """
    db = request.app.state.db
    items = await db.jobs.find({"active": True}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [_serialize(it) for it in items]


# NOTE: static routes must be declared BEFORE the dynamic /jobs/{job_id}
# param routes so FastAPI doesn't interpret "unread-count" as an id.
@public_router.get("/jobs/unread-count")
async def jobs_unread_count(request: Request, user=Depends(get_current_user)):
    """Count active jobs whose `created_at` is newer than the caller's
    `last_jobs_seen_at`. Used by the BottomNav badge."""
    db = request.app.state.db
    u = await db.users.find_one({"id": user["id"]}, {"last_jobs_seen_at": 1}) or {}
    seen = u.get("last_jobs_seen_at")
    q: dict = {"active": True}
    if seen:
        if isinstance(seen, datetime) and seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        q["created_at"] = {"$gt": seen}
    unread = await db.jobs.count_documents(q)
    return {"unread": int(unread)}


@public_router.post("/jobs/mark-seen")
async def jobs_mark_seen(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_jobs_seen_at": now}},
    )
    return {"ok": True, "seen_at": now.isoformat()}


# ---------- Admin endpoints ----------

@admin_router.get("/jobs")
async def admin_list_jobs(
    request: Request, admin=Depends(require_admin),
) -> List[dict]:
    """Return ALL job offers (active + inactive) for the admin panel."""
    db = request.app.state.db
    items = await db.jobs.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [_serialize(it) for it in items]


@admin_router.post("/jobs")
async def admin_create_job(
    data: JobIn, request: Request, admin=Depends(require_admin),
) -> dict:
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "title": data.title,
        "description": data.description,
        "contact": data.contact,
        "country": data.country.upper(),
        "salary": data.salary,
        "image_url": data.image_url,
        "active": bool(data.active),
        "created_at": now,
        "updated_at": now,
        "created_by": admin.get("username"),
    }
    await db.jobs.insert_one(doc)
    # 🔔 Broadcast push to activated users when job is directly published.
    if doc["active"]:
        try:
            from push_helper import push_to_activated
            snippet = (data.title or "")[:60].strip() or "Nouvelle offre"
            await push_to_activated(
                db,
                title="💼 Nouvelle offre d'emploi disponible !",
                body=f"{snippet} — Consultez-la maintenant sur SPILOVEURE. 🚀",
                link=f"/(app)/emploi?job_id={doc['id']}",
                data={"kind": "job_published", "job_id": doc["id"]},
                tag=f"job-{doc['id']}",
            )
        except Exception:
            pass
    return _serialize({**doc})


@admin_router.put("/jobs/{job_id}")
async def admin_update_job(
    job_id: str, data: JobIn, request: Request, admin=Depends(require_admin),
) -> dict:
    db = request.app.state.db
    existing = await db.jobs.find_one({"id": job_id})
    if not existing:
        raise HTTPException(404, "Offre introuvable.")
    update = {
        "title": data.title,
        "description": data.description,
        "contact": data.contact,
        "country": data.country.upper(),
        "salary": data.salary,
        "image_url": data.image_url,
        "active": bool(data.active),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": admin.get("username"),
    }
    await db.jobs.update_one({"id": job_id}, {"$set": update})
    fresh = await db.jobs.find_one({"id": job_id}, {"_id": 0})
    return _serialize(fresh or {})


@admin_router.delete("/jobs/{job_id}")
async def admin_delete_job(
    job_id: str, request: Request, admin=Depends(require_admin),
) -> dict:
    db = request.app.state.db
    r = await db.jobs.delete_one({"id": job_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Offre introuvable.")
    return {"ok": True}


@admin_router.post("/jobs/{job_id}/toggle")
async def admin_toggle_job(
    job_id: str, request: Request, admin=Depends(require_admin),
) -> dict:
    """Flip the active flag. Used by the admin to (de)activate a job in one click."""
    db = request.app.state.db
    j = await db.jobs.find_one({"id": job_id})
    if not j:
        raise HTTPException(404, "Offre introuvable.")
    new_active = not bool(j.get("active", True))
    await db.jobs.update_one(
        {"id": job_id},
        {"$set": {"active": new_active, "updated_at": datetime.now(timezone.utc),
                  "updated_by": admin.get("username")}},
    )
    # 🔔 Fire push only on transition inactive → active (publication).
    if new_active:
        try:
            from push_helper import push_to_activated
            snippet = (j.get("title") or "")[:60].strip() or "Nouvelle offre"
            await push_to_activated(
                db,
                title="💼 Nouvelle offre d'emploi disponible !",
                body=f"{snippet} — Consultez-la maintenant sur SPILOVEURE. 🚀",
                link=f"/(app)/emploi?job_id={job_id}",
                data={"kind": "job_published", "job_id": job_id},
                tag=f"job-{job_id}",
            )
        except Exception:
            pass
    return {"ok": True, "active": new_active}
