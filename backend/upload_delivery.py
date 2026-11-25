"""Shared delivery behavior for admin-uploaded media."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response

from apk_validation import APK_CONTENT_TYPE, apk_download_headers


def serve_uploaded_file(filename: str, uploads_dir: Path, storage) -> Response:
    """Serve from object storage, the persistent volume, then legacy local disk."""
    if not filename or Path(filename).name != filename or filename in {".", ".."}:
        raise HTTPException(status_code=404, detail="Fichier introuvable.")
    is_apk = filename.lower().endswith(".apk")
    headers = apk_download_headers(filename) if is_apk else {}

    if storage.is_enabled():
        try:
            data, content_type = storage.get_upload(filename)
            return Response(
                content=data,
                media_type=APK_CONTENT_TYPE if is_apk else content_type,
                headers=headers,
            )
        except FileNotFoundError:
            pass
        except Exception as error:  # noqa: BLE001
            import logging
            logging.getLogger("uploads").warning(
                "object storage GET failed for %s: %s", filename, error,
            )

    local_candidates = [Path(uploads_dir) / filename]
    persistent_uploads = (os.environ.get("UPLOADS_DIR") or "").strip()
    if persistent_uploads:
        persistent_path = Path(persistent_uploads)
        if persistent_path.resolve() != Path(uploads_dir).resolve():
            local_candidates.append(persistent_path / filename)
    legacy_path = Path(__file__).resolve().parent / "uploads"
    if legacy_path.resolve() not in {Path(candidate).parent.resolve() for candidate in local_candidates}:
        local_candidates.append(legacy_path / filename)
    for local in local_candidates:
        if local.is_file():
            return FileResponse(
                str(local),
                media_type=APK_CONTENT_TYPE if is_apk else None,
                filename=filename if is_apk else None,
                headers=headers,
            )

    raise HTTPException(
        status_code=410,
        detail=(
            "Ce fichier n'est plus disponible sur le serveur. "
            "Veuillez contacter l'administration pour qu'il soit ré-uploadé."
        ),
    )
