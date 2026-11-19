"""Shared delivery behavior for admin-uploaded media."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response

from apk_validation import APK_CONTENT_TYPE, apk_download_headers


def serve_uploaded_file(filename: str, uploads_dir: Path, storage) -> Response:
    """Serve uploads from object storage first, then the legacy local directory."""
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

    local_candidates = [uploads_dir / filename]
    if is_apk and filename.startswith("spiloveure-official-"):
        persistent_uploads = (os.environ.get("UPLOADS_DIR") or "").strip()
        if persistent_uploads:
            persistent_path = Path(persistent_uploads)
            if persistent_path.resolve() != Path(uploads_dir).resolve():
                local_candidates.append(persistent_path / filename)
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
