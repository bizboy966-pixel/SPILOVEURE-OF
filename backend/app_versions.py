"""Website and Android APK version metadata.

Minimalist release workflow (per user spec) :
  • Admin enters a version string (e.g. "1.2.0") in the admin panel
  • Clicks "Publier la nouvelle version"
  • Backend stores it as the `current_version` + optionally as new minimum
  • All clients polling `/api/app/version` see the new published version
  • Clients whose `CLIENT_VERSION < minimum_supported_version` are prompted to
    reload (blocking overlay).

Website versions can still be auto-synced from app.json. Android APK releases
are tracked separately because they require a built, signed APK file.
"""
from __future__ import annotations
import logging
import uuid
import re
import os
import hmac
import hashlib
import shutil
import subprocess
import tempfile
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from auth import require_admin  # type: ignore
from apk_validation import InvalidApk, validate_apk, upload_content_type
from upload_paths import configured_uploads_dir, write_upload

log = logging.getLogger("app_versions")

public_router = APIRouter(prefix="/api/app", tags=["app-version"])
admin_router = APIRouter(prefix="/api/admin/versions", tags=["app-version-admin"])
release_router = APIRouter(prefix="/api/app/releases", tags=["official-android-release"])

# v27an (2026-03-04) — path to the frontend's app.json. Used by
# `auto_sync_from_frontend_version()` to detect new releases without any
# admin intervention : bump `app.json → expo.version`, redeploy, done.
import os as _os
_FRONTEND_APP_JSON = _os.environ.get(
    "FRONTEND_APP_JSON", "/app/frontend/app.json"
)


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
    "apk_url": "",
    "apk_size_mb": None,
    "apk_version": "",
    "apk_version_code": None,
    "apk_minimum_supported_version": "",
    "apk_mandatory": True,
    "apk_signer_sha256": "",
    "apk_sha256": "",
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
        "apk_url": s.get("apk_url") or "",
        "apk_size_mb": s.get("apk_size_mb"),
        "apk_version": s.get("apk_version") or "",
        "apk_version_code": s.get("apk_version_code"),
        "apk_minimum_supported_version": s.get("apk_minimum_supported_version") or "",
        "apk_mandatory": bool(s.get("apk_mandatory", False)),
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


def inspect_official_apk(apk_path: str) -> dict:
    """Cryptographically inspect a release APK using Android SDK tools."""
    apksigner = os.environ.get("ANDROID_APKSIGNER") or shutil.which("apksigner")
    aapt = os.environ.get("ANDROID_AAPT") or shutil.which("aapt")
    if not apksigner or not aapt:
        raise RuntimeError(
            "Les outils Android apksigner et aapt doivent être accessibles dans le conteneur backend."
        )
    try:
        signature = subprocess.run(
            [apksigner, "verify", "--verbose", "--print-certs", apk_path],
            check=True, capture_output=True, text=True, timeout=120,
        ).stdout
        badging = subprocess.run(
            [aapt, "dump", "badging", apk_path],
            check=True, capture_output=True, text=True, timeout=60,
        ).stdout
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ValueError("La vérification cryptographique ou la lecture du package APK a échoué.") from exc

    package_match = re.search(
        r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'",
        badging, re.MULTILINE,
    )
    signer_match = re.search(
        r"certificate SHA-256 digest:\s*([a-fA-F0-9:]+)",
        signature, re.IGNORECASE,
    )
    if not package_match or not signer_match:
        raise ValueError("Le package ou le certificat de signature de l’APK est illisible.")
    version_code = int(package_match.group(2))
    version = package_match.group(3)
    if version_code < 1 or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("La version de l’APK doit être stable au format X.Y.Z avec un code positif.")
    if package_match.group(1) != "com.spilivere.app":
        raise ValueError("L’identifiant de cette application n’est pas celui de SPILOVEURE.")
    if "application-debuggable" in badging:
        raise ValueError("Une APK débogable ne peut pas être publiée comme version officielle.")
    signer_sha256 = signer_match.group(1).replace(":", "").lower()
    if not re.fullmatch(r"[a-f0-9]{64}", signer_sha256):
        raise ValueError("L’empreinte du certificat de signature est invalide.")
    return {
        "package": package_match.group(1),
        "version": version,
        "version_code": version_code,
        "signer_sha256": signer_sha256,
        "debuggable": False,
    }


@release_router.post("/publish")
async def publish_official_apk(
    request: Request,
    file: UploadFile = File(...),
    authorization: str = Header(default=""),
):
    """Authenticated release-only upload. Validates first; updates public settings last."""
    expected_token = (os.environ.get("ANDROID_RELEASE_TOKEN") or "").strip()
    supplied_token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not expected_token:
        raise HTTPException(503, "La publication automatique APK n’est pas configurée sur le VPS.")
    if not supplied_token or not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(401, "Autorisation de publication APK invalide.")

    filename = (file.filename or "").strip()
    if not filename.lower().endswith(".apk"):
        raise HTTPException(415, "Le fichier transmis doit être une APK.")
    max_bytes = 100 * 1024 * 1024
    data = bytearray()
    try:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > max_bytes:
                raise HTTPException(413, "Fichier APK trop volumineux (maximum 100 Mo).")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Impossible de lire le fichier APK transmis.") from None
    if not data:
        raise HTTPException(400, "Le fichier APK est vide.")

    try:
        validate_apk(bytes(data))
    except InvalidApk as exc:
        raise HTTPException(415, str(exc)) from None

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as temp_file:
            temp_file.write(data)
            temp_path = temp_file.name
        inspected = await asyncio.to_thread(inspect_official_apk, temp_path)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from None
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    db = request.app.state.db
    current = await _get_settings(db)
    version = inspected["version"]
    version_code = inspected["version_code"]
    signer = inspected["signer_sha256"]
    if inspected["package"] != "com.spilivere.app":
        raise HTTPException(415, "Cette APK n’appartient pas à l’application SPILOVEURE officielle.")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not isinstance(version_code, int) or version_code < 1:
        raise HTTPException(415, "Version officielle invalide : X.Y.Z et code Android positif requis.")
    if inspected.get("debuggable") is True:
        raise HTTPException(415, "Une APK débogable ne peut pas être publiée comme version officielle.")
    if not re.fullmatch(r"[a-f0-9]{64}", signer):
        raise HTTPException(415, "L’empreinte du certificat de signature est invalide.")
    current_version = (current.get("apk_version") or "").strip()
    if current_version and _cmp(version, current_version) <= 0:
        # Allow a retry only when it is byte-for-byte the already-published release.
        current_hash = hashlib.sha256(data).hexdigest()
        if version == current_version and current.get("apk_sha256") == current_hash:
            return {
                "ok": True, "published": False, "version": version,
                "version_code": current.get("apk_version_code"),
                "url": current.get("apk_url"),
            }
        raise HTTPException(409, "La version APK doit être supérieure à la version déjà publiée.")
    current_code = current.get("apk_version_code")
    if current_code is not None and version_code <= int(current_code):
        raise HTTPException(409, "Le code de version Android doit être strictement supérieur au précédent.")
    pinned_signer = (current.get("apk_signer_sha256") or "").lower()
    if pinned_signer and not hmac.compare_digest(signer, pinned_signer):
        raise HTTPException(409, "La signature ne correspond pas à la clé officielle déjà utilisée.")

    apk_hash = hashlib.sha256(data).hexdigest()
    safe_version = version.replace(".", "-")
    stored_name = f"spiloveure-official-{safe_version}.apk"
    url = f"/api/uploads/{stored_name}"
    uploads_dir = configured_uploads_dir()
    try:
        write_upload(
            stored_name, bytes(data), uploads_dir,
            allow_existing_identical=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Official APK persistent local storage failed: %s", exc)
        raise HTTPException(
            503,
            "L’APK n’a pas pu être enregistrée dans le stockage persistant ; la version active n’a pas changé.",
        ) from None

    # Hostinger serves uploads from its persistent Docker volume. Keep object
    # storage as a best-effort mirror, not a release blocker, so the official
    # download remains available when this optional integration is unavailable.
    try:
        import object_storage
        if object_storage.is_enabled():
            await asyncio.to_thread(
                object_storage.put_upload,
                stored_name, bytes(data), upload_content_type(filename, file.content_type),
            )
        else:
            log.info("Official APK saved to persistent local storage; object storage is disabled.")
    except Exception as exc:  # noqa: BLE001
        log.warning("Official APK object-storage mirror failed; persistent local copy is available: %s", exc)

    now = datetime.now(timezone.utc)
    try:
        await db.media_uploads.insert_one({
            "id": str(uuid.uuid4()),
            "filename": filename,
            "stored_as": stored_name,
            "url": url,
            "size": len(data),
            "content_type": upload_content_type(filename, file.content_type),
            "apk_validated": True,
            "apk_package": inspected["package"],
            "apk_version": version,
            "apk_version_code": version_code,
            "apk_signer_sha256": signer,
            "apk_sha256": apk_hash,
            "official_release": True,
            "uploaded_by": "official-release-command",
            "uploaded_at": now,
        })
        settings = await _save_settings(db, {
            "apk_url": url,
            "apk_size_mb": round(len(data) / (1024 * 1024), 2),
            "apk_version": version,
            "apk_version_code": version_code,
            "apk_minimum_supported_version": version,
            "apk_mandatory": True,
            "apk_signer_sha256": signer,
            "apk_sha256": apk_hash,
        })
    except Exception as exc:  # noqa: BLE001
        log.exception("Official APK metadata was not activated: %s", exc)
        raise HTTPException(503, "L’APK est envoyée mais ses métadonnées n’ont pas été activées ; la version active n’a pas changé.") from None

    try:
        await db.admin_logs.insert_one({
            "id": str(uuid.uuid4()),
            "admin_id": "official-release-command",
            "action": "publish_official_android_apk",
            "meta": {
                "version": version, "version_code": version_code,
                "sha256": apk_hash, "size": len(data),
            },
            "at": now,
        })
    except Exception as exc:  # noqa: BLE001
        log.warning("Official APK audit log could not be written: %s", exc)
    log.info("Official Android APK %s published (code %s, sha256 %s)", version, version_code, apk_hash)
    return {
        "ok": True, "published": True, "version": version,
        "version_code": version_code, "url": url, "settings": settings,
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
    # APK release data is separate from the website version: rebuilding the
    # web app must not force native APK users to install an older binary.
    if "apk_url" in body:
        url = (body.get("apk_url") or "").strip()
        uploaded_path = (
            url.startswith("/api/uploads/")
            and url.lower().endswith(".apk")
            and ".." not in url
            and "\\" not in url
        )
        external_https = url.startswith("https://")
        if url and not (uploaded_path or external_https):
            raise HTTPException(400, "Le lien APK doit être HTTPS ou un fichier /api/uploads/ importé.")
        if uploaded_path:
            media = await request.app.state.db.media_uploads.find_one(
                {"url": url}, {"_id": 0},
            )
            if not media or media.get("apk_validated") is not True:
                raise HTTPException(
                    400,
                    "Ce fichier n’a pas été reconnu comme APK Android signé. "
                    "Réimportez un APK de production valide avant de le publier.",
                )
        patch["apk_url"] = url
    if "apk_version" in body:
        version = (body.get("apk_version") or "").strip()
        if version and not _is_valid_semver(version):
            raise HTTPException(400, "apk_version invalide. Format attendu : X.Y.Z.")
        patch["apk_version"] = version
    if "apk_minimum_supported_version" in body:
        minimum = (body.get("apk_minimum_supported_version") or "").strip()
        if minimum and not _is_valid_semver(minimum):
            raise HTTPException(400, "apk_minimum_supported_version invalide.")
        patch["apk_minimum_supported_version"] = minimum
    if "apk_mandatory" in body:
        patch["apk_mandatory"] = bool(body["apk_mandatory"])
    if "apk_size_mb" in body:
        val = body.get("apk_size_mb")
        if val is None or val == "":
            patch["apk_size_mb"] = None
        else:
            try:
                patch["apk_size_mb"] = float(val)
            except (TypeError, ValueError):
                raise HTTPException(400, "apk_size_mb doit être un nombre.")
    if not patch:
        raise HTTPException(400, "Aucun champ à mettre à jour.")
    cur = await _get_settings(db)
    effective = {**cur, **patch}
    # Publishing an APK always blocks older app versions. A version published
    # through the admin panel is the version every installed client must reach.
    if (("apk_url" in body or "apk_version" in body)
            and effective.get("apk_url") and effective.get("apk_version")):
        patch["apk_mandatory"] = True
        patch["apk_minimum_supported_version"] = effective["apk_version"]
        effective = {**cur, **patch}
    if effective.get("apk_mandatory"):
        if not effective.get("apk_url") or not effective.get("apk_version"):
            raise HTTPException(400, "Pour imposer la mise à jour, enregistrez d'abord le fichier APK et sa version.")
        minimum = effective.get("apk_minimum_supported_version") or effective["apk_version"]
        if _cmp(minimum, effective["apk_version"]) > 0:
            raise HTTPException(400, "La version minimale APK ne peut pas dépasser la version publiée.")
        patch["apk_minimum_supported_version"] = minimum
    s = await _save_settings(db, patch)
    await db.admin_logs.insert_one({
        "id": str(uuid.uuid4()),
        "admin_id": admin.get("id"),
        "action": "update_app_version_settings",
        "meta": patch,
        "at": datetime.now(timezone.utc),
    })
    return {"ok": True, "settings": s}


async def auto_sync_from_frontend_version(db) -> dict:
    """v27an — auto-publish the website version.

    Reads `/app/frontend/app.json` on backend startup and, if `expo.version`
    is strictly greater than the stored `current_version`, publishes it
    automatically (sets `current_version`, `minimum_supported_version`,
    `mandatory=True`). APK metadata is intentionally not changed here: a
    website deployment does not create or sign a new Android package.

    Idempotent — re-running with the same version does nothing.
    """
    try:
        import json as _json
        with open(_FRONTEND_APP_JSON, "r", encoding="utf-8") as f:
            cfg = _json.load(f)
        version = str(((cfg or {}).get("expo") or {}).get("version") or "").strip()
    except Exception as e:  # noqa: BLE001
        log.warning("auto_sync_from_frontend_version: cannot read %s : %s", _FRONTEND_APP_JSON, e)
        return {"ok": False, "reason": "cannot-read-app-json"}
    if not version or not _is_valid_semver(version):
        return {"ok": False, "reason": f"invalid-version:{version!r}"}
    cur = await _get_settings(db)
    if _cmp(version, cur["current_version"]) <= 0:
        return {"ok": True, "changed": False, "version": version}
    now = datetime.now(timezone.utc)
    existing = await db.app_versions.find_one({"version": version})
    if existing:
        await db.app_versions.update_one(
            {"version": version},
            {"$set": {"status": "published", "mandatory": True,
                      "published_at": now, "updated_at": now,
                      "notes": existing.get("notes") or "Publication automatique (app.json)"}},
        )
        vid = existing.get("id") or str(uuid.uuid4())
    else:
        vid = str(uuid.uuid4())
        await db.app_versions.insert_one({
            "id": vid, "version": version, "status": "published",
            "mandatory": True, "notes": "Publication automatique (app.json)",
            "published_by": "system-auto", "created_at": now,
            "published_at": now, "updated_at": now,
        })
    new_settings = await _save_settings(db, {
        "current_version": version,
        "minimum_supported_version": version,
        "mandatory": True,
    })
    log.info("auto_sync: published app version %s (previous %s)", version, cur["current_version"])
    return {"ok": True, "changed": True, "version": version, "settings": new_settings}


def register(app):
    """Mount both routers onto the FastAPI app. Called from server.py."""
    app.include_router(public_router)
    app.include_router(admin_router)
    app.include_router(release_router)
