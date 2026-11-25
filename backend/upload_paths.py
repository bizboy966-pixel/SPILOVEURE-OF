"""Shared paths and durable writes for first-party uploaded media."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


LEGACY_UPLOADS_DIR = Path(__file__).resolve().parent / "uploads"
UPLOADS_DIR = Path(
    os.environ.get("UPLOADS_DIR") or str(LEGACY_UPLOADS_DIR)
).expanduser()


def configured_uploads_dir() -> Path:
    """Return the upload root selected for this process."""
    return Path(
        os.environ.get("UPLOADS_DIR") or str(LEGACY_UPLOADS_DIR)
    ).expanduser()


def write_upload(
    filename: str,
    data: bytes,
    uploads_dir: Path | None = None,
    *,
    allow_existing_identical: bool = False,
) -> Path:
    """Atomically create an upload without replacing another file.

    Production sets UPLOADS_DIR to the Docker volume. The local fallback is
    retained for previews and development, where no production volume exists.
    """
    if (
        not filename
        or Path(filename).name != filename
        or filename in {".", ".."}
        or "\x00" in filename
    ):
        raise ValueError("Nom de fichier invalide.")

    root = Path(uploads_dir) if uploads_dir is not None else configured_uploads_dir()
    root.mkdir(parents=True, exist_ok=True)
    destination = root / filename
    if destination.exists():
        if allow_existing_identical and destination.is_file():
            with destination.open("rb") as existing:
                if existing.read() == data:
                    return destination
        raise FileExistsError(f"Le fichier {filename} existe déjà.")
    temp_path: str | None = None
    try:
        fd, temp_path = tempfile.mkstemp(
            prefix=f".{filename}.", suffix=".uploading", dir=root,
        )
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        # A hard link publishes the complete file atomically and fails rather
        # than overwriting a file if a generated name is ever reused.
        try:
            os.link(temp_path, destination)
        except FileExistsError:
            if allow_existing_identical and destination.is_file():
                with destination.open("rb") as existing:
                    if existing.read() == data:
                        return destination
            raise
        return destination
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
