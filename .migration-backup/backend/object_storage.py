"""Emergent Managed Object Storage — durable file persistence for uploads.

Solves the production bug where `/app/backend/uploads` (local disk) is
ephemeral and files disappear on container redeploy → download links return
404 `{"detail": "Not Found"}`.

Contract preserved:
  - Existing URL scheme `/api/uploads/{filename}` remains valid.
  - Frontend `resolveMediaUrl()` continues to work unchanged.
  - The FastAPI route `/api/uploads/{filename}` now streams the file from
    object storage (with fallback to legacy local disk for backward
    compatibility during the migration period).
"""
from __future__ import annotations
import logging
import os
from typing import Optional, Tuple

import requests

log = logging.getLogger("object_storage")

STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
APP_PREFIX = "spiloveure"  # bucket-scoping prefix
_KEY = os.environ.get("EMERGENT_LLM_KEY")
_storage_key: Optional[str] = None


def _ensure_key() -> str:
    """Session-scoped init. Re-init on 403 (expired key)."""
    global _storage_key
    if _storage_key:
        return _storage_key
    if not _KEY:
        raise RuntimeError("EMERGENT_LLM_KEY not set — object storage disabled.")
    r = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": _KEY}, timeout=30)
    r.raise_for_status()
    _storage_key = r.json()["storage_key"]
    return _storage_key


def _refresh_key() -> str:
    global _storage_key
    _storage_key = None
    return _ensure_key()


def is_enabled() -> bool:
    return bool(_KEY)


def object_path(filename: str) -> str:
    """Return the canonical storage path for a given upload filename."""
    return f"{APP_PREFIX}/uploads/{filename}"


def put_upload(filename: str, data: bytes, content_type: str) -> dict:
    """Upload a file to persistent object storage. Returns the storage record."""
    key = _ensure_key()
    path = object_path(filename)
    for attempt in range(2):
        r = requests.put(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key, "Content-Type": content_type},
            data=data,
            timeout=180,
        )
        if r.status_code == 403 and attempt == 0:
            key = _refresh_key()
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    return r.json()


def get_upload(filename: str) -> Tuple[bytes, str]:
    """Download a file from object storage. Returns (bytes, content_type).

    Emergent storage returns 500 (not 404) for missing objects — we convert
    that into a FileNotFoundError so the caller can silently fall through to
    the local-disk fallback without polluting the logs with warnings.
    """
    key = _ensure_key()
    path = object_path(filename)
    for attempt in range(2):
        r = requests.get(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key},
            timeout=120,
        )
        if r.status_code == 403 and attempt == 0:
            key = _refresh_key()
            continue
        if r.status_code == 404:
            raise FileNotFoundError(f"object not found: {path}")
        if r.status_code == 500:
            # Upstream returns 500 for a missing object — treat it as missing.
            body = (r.text or "").lower()
            if "not found" in body or "no such" in body or "missing" in body or len(body) < 200:
                raise FileNotFoundError(f"object not found (500): {path}")
        r.raise_for_status()
        return r.content, r.headers.get("Content-Type", "application/octet-stream")
    r.raise_for_status()
    return b"", "application/octet-stream"


def exists(filename: str) -> bool:
    """Check whether the object exists without downloading it."""
    try:
        key = _ensure_key()
        path = object_path(filename)
        r = requests.head(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key},
            timeout=15,
        )
        if r.status_code == 403:
            _refresh_key()
            return False
        return r.status_code == 200
    except Exception as e:  # noqa: BLE001
        log.warning(f"object_storage.exists({filename}) failed: {e}")
        return False
