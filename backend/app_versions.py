"""Version management — 2026-03-04 (v27aj).

Minimalist release workflow (per user spec) :
  • Admin enters a version string (e.g. "1.2.0") in the admin panel
  • Clicks "Publier la nouvelle version"
  • Backend stores it as the `current_version` + optionally as new minimum
  • All clients polling `/api/app/version` see the new published version
  • Clients whose `CLIENT_VERSION < minimum_supported_version` are prompted to
    reload (blocking overlay).

NO file upload, NO APK handling, NO release notes required. The version
string IS the publishing event — the code is already deployed, the version
number is the cache-bust / gate signal.
"""
from __future__ import annotations
import logging
import uuid
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import require_admin  # type: ignore

log = logging.getLogger("app_versions")

public_router = APIRouter(prefix="/api/app", tags=["app-version"])
admin_router = APIRouter(prefix="/api/admin/versions", tags=["app-version-admin"])


_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$")


def _is_valid_semver(v: str) -> bool:
    return bool(_SEMVER_RE.match((v or "").strip()))


def _cmp(a: str, b: str) -> int:
    """Return -1 / 0 / 1 — ignores pre-release suffix for simplicity."""
    def _nums(s: str) -> tuple[int, int, int]:
        core = s.split("-", 1)[0]
        parts = (core.split(".") + ["0", "0", "0"])[:3]
        try:
            return (int(parts[0]), int(parts[1]), int(parts[2]))
        except ValueError:
            return (0, 0, 0)
    ta, tb = _nums(a), _nums(b)
    return (ta > tb) - (ta < tb)


# ── Models ────────────────────────────────────────────────────────────
class PublishIn(BaseModel):
    version: str = Field(..., min_length=1, max_length=32,
                         description="Semver — ex: 1.2.0")
    notes: Optional[str] = Field(None, max_length=2000)
    mandatory: bool = Field(True,
                            description="If True, all older clients must reload before continuing.")
    make_minimum: bool = Field(True,
                               description="If True, this version becomes the new minimum_supported_version.")


# ── Settings helpers ──────────────────────────────────────────────────
_SETTINGS_KEY = "app_version"
_DEFAULT_SETTINGS = {
    "current_version": "1.0.0",
    "minimum_supported_version": "1.0.0",
    "mandatory": False,
    "updated_at": None,
}


async def _get_settings(db) -> dict:
    doc = await db.app_settings.find_one({"key": _SETTINGS_KEY})
    val = (doc or {}).get("value") or {}
    out = {**_DEFAULT_SETTINGS, **val}
    return out


async def _save_settings(db, patch: dict) -> dict:
    cur = await _get_settings(db)
    new = {**cur, **patch, "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.app_settings.update_one(
        {"key": _SETTINGS_KEY},
        {"$set": {"key": _SETTINGS_KEY, "value": new,
                  "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return new


# ── Public endpoints ──────────────────────────────────────────────────
@public_router.get("/version")
async def get_app_version(request: Request):
    """Public — returned to every client on app open.

    Response :
        current_version    : last published version
        minimum_supported_version : clients below this must update
        mandatory          : hint — frontend treats "below minimum" as blocking
        updated_at         : ISO ts of the last publish
    """
    db = request.app.state.db
    s = await _get_settings(db)
    return {
        "current_version": s["current_version"],
        "minimum_supported_version": s["minimum_supported_version"],
        "mandatory": bool(s.get("mandatory")),
        "updated_at": s.get("updated_at"),
    }


@public_router.get("/version/check")
async def check_app_version(request: Request, client_version: str = "1.0.0"):
    """Convenience — frontend passes its own version; backend answers whether
    an update is required and whether it's mandatory. Keeps the comparison
    logic on the server (users can't bypass by patching JS)."""
    db = request.app.state.db
    s = await _get_settings(db)
    # Validate incoming version — invalid strings = treat as outdated.
    valid = _is_valid_semver(client_version)
    is_below_min = (not valid) or _cmp(client_version, s["minimum_supported_version"]) < 0
    is_below_current = (not valid) or _cmp(client_version, s["current_version"]) < 0
    return {
        "client_version": client_version if valid else None,
        "current_version": s["current_version"],
        "minimum_supported_version": s["minimum_supported_version"],
        "update_available": is_below_current,
        "update_required": is_below_min and bool(s.get("mandatory", False)),
    }


# ── Admin endpoints ───────────────────────────────────────────────────
@admin_router.get("")
async def list_versions(request: Request, admin=Depends(require_admin)):
    """List every version ever published, newest first."""
    db = request.app.state.db
    rows = await db.app_versions.find({}, {"_id": 0}).sort("created_at", -1).to_list(200)
    current = await _get_settings(db)
    return {
        "settings": current,
        "versions": rows,
    }


@admin_router.post("/publish")
async def publish_version(body: PublishIn, request: Request, admin=Depends(require_admin)):
    """Atomic publish of a new version.

    Flow :
      1. Validate semver
      2. Check this version > previous `current_version`
      3. Insert into `app_versions` with status="published"
      4. Patch `app_settings.app_version` with new current + minimum (if asked)
      5. Audit log

    Returns the new settings dict.
    """
    db = request.app.state.db
    version = (body.version or "").strip()
    if not _is_valid_semver(version):
        raise HTTPException(400, "Format de version invalide. Attendu : X.Y.Z (ex: 1.2.0).")
    cur = await _get_settings(db)
    if _cmp(version, cur["current_version"]) < 0:
        raise HTTPException(
            400,
            f"La version {version} est antérieure à la version actuelle {cur['current_version']}.",
        )
    # Dedupe — if a doc for this version already exists AND it's already
    # published, just re-apply settings (idempotent).
    existing = await db.app_versions.find_one({"version": version})
    now = datetime.now(timezone.utc)
    if existing:
        await db.app_versions.update_one(
            {"version": version},
            {"$set": {"status": "published",
                      "published_at": now,
                      "mandatory": body.mandatory,
                      "notes": body.notes or existing.get("notes") or "",
                      "updated_at": now}},
        )
        vid = existing.get("id") or str(uuid.uuid4())
    else:
        vid = str(uuid.uuid4())
        await db.app_versions.insert_one({
            "id": vid,
            "version": version,
            "status": "published",
            "mandatory": body.mandatory,
            "notes": body.notes or "",
            "published_by": admin.get("id"),
            "created_at": now,
            "published_at": now,
            "updated_at": now,
        })

    patch = {
        "current_version": version,
        "mandatory": body.mandatory,
    }
    if body.make_minimum:
        patch["minimum_supported_version"] = version
    new_settings = await _save_settings(db, patch)

    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()),
        "admin_id": admin.get("id"),
        "action": "publish_app_version",
        "target": vid,
        "meta": {"version": version, "mandatory": body.mandatory,
                 "make_minimum": body.make_minimum},
        "at": now,
    })

    log.info("app_version published: %s mandatory=%s min=%s by admin=%s",
             version, body.mandatory, body.make_minimum, admin.get("id"))

    return {"ok": True, "settings": new_settings, "id": vid}


@admin_router.post("/draft")
async def save_draft(body: PublishIn, request: Request, admin=Depends(require_admin)):
    """Prepare a version without publishing it. The admin can review it
    (status=draft) before clicking 'Publier'. Idempotent on `version`."""
    db = request.app.state.db
    version = (body.version or "").strip()
    if not _is_valid_semver(version):
        raise HTTPException(400, "Format de version invalide. Attendu : X.Y.Z.")
    now = datetime.now(timezone.utc)
    existing = await db.app_versions.find_one({"version": version})
    if existing and existing.get("status") == "published":
        raise HTTPException(400, "Cette version est déjà publiée.")
    if existing:
        await db.app_versions.update_one(
            {"version": version},
            {"$set": {"notes": body.notes or "",
                      "mandatory": body.mandatory,
                      "updated_at": now}},
        )
        return {"ok": True, "id": existing["id"]}
    vid = str(uuid.uuid4())
    await db.app_versions.insert_one({
        "id": vid,
        "version": version,
        "status": "draft",
        "mandatory": body.mandatory,
        "notes": body.notes or "",
        "created_by": admin.get("id"),
        "created_at": now,
        "updated_at": now,
    })
    return {"ok": True, "id": vid}


@admin_router.post("/settings")
async def update_settings(body: dict, request: Request, admin=Depends(require_admin)):
    """Fine-tune settings — change minimum_supported_version or toggle
    mandatory flag without publishing a new release."""
    db = request.app.state.db
    patch: dict = {}
    if "minimum_supported_version" in body:
        v = body["minimum_supported_version"]
        if not _is_valid_semver(v):
            raise HTTPException(400, "minimum_supported_version invalide.")
        patch["minimum_supported_version"] = v
    if "mandatory" in body:
        patch["mandatory"] = bool(body["mandatory"])
    if not patch:
        raise HTTPException(400, "Aucun champ à mettre à jour.")
    s = await _save_settings(db, patch)
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()),
        "admin_id": admin.get("id"),
        "action": "update_app_version_settings",
        "meta": patch,
        "at": datetime.now(timezone.utc),
    })
    return {"ok": True, "settings": s}


def register(app):
    """Mount both routers onto the FastAPI app. Called from server.py."""
    app.include_router(public_router)
    app.include_router(admin_router)
