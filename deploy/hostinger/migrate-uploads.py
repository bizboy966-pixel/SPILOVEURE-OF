"""Copy uploads from the old container filesystem into the Docker volume.

Run this from the Hostinger checkout before rebuilding/recreating the backend:
    docker compose exec -T backend python - < ./migrate-uploads.py

The script runs inside the still-running old backend container, where both
the legacy directory and the mounted persistent volume are available.
"""
from __future__ import annotations

import filecmp
import json
import os
import shutil
import tempfile
from pathlib import Path


def migrate_uploads(source: Path, destination: Path) -> dict:
    source = Path(source)
    destination = Path(destination)
    source_resolved = source.resolve()
    destination_resolved = destination.resolve()
    if source_resolved == destination_resolved:
        return {"copied": 0, "identical": 0, "conflicts": [], "errors": []}
    if destination_resolved.is_relative_to(source_resolved):
        raise ValueError("Le volume de destination ne peut pas être dans le dossier source.")
    if not source.is_dir():
        return {
            "copied": 0, "identical": 0, "conflicts": [], "errors": [],
            "source_missing": True,
        }

    destination.mkdir(parents=True, exist_ok=True)
    report = {"copied": 0, "identical": 0, "conflicts": [], "errors": []}
    for source_file in source.rglob("*"):
        if source_file.is_symlink() or not source_file.is_file():
            continue
        if source_file.name.endswith(".uploading") or source_file.name.startswith(
            ".upload-migration-"
        ):
            continue
        relative = source_file.relative_to(source)
        target_file = destination / relative
        try:
            target_file.parent.mkdir(parents=True, exist_ok=True)
            if target_file.exists():
                if filecmp.cmp(source_file, target_file, shallow=False):
                    report["identical"] += 1
                else:
                    report["conflicts"].append(str(relative))
                continue

            temp_path = None
            try:
                fd, temp_path = tempfile.mkstemp(
                    prefix=".upload-migration-", dir=target_file.parent,
                )
                os.close(fd)
                shutil.copy2(source_file, temp_path)
                try:
                    os.link(temp_path, target_file)
                    report["copied"] += 1
                except FileExistsError:
                    if filecmp.cmp(source_file, target_file, shallow=False):
                        report["identical"] += 1
                    else:
                        report["conflicts"].append(str(relative))
            finally:
                if temp_path:
                    try:
                        os.unlink(temp_path)
                    except FileNotFoundError:
                        pass
        except OSError as error:
            report["errors"].append({"file": str(relative), "error": str(error)})
    return report


if __name__ == "__main__":
    source = Path(os.environ.get("LEGACY_UPLOADS_DIR") or "/app/backend/uploads")
    destination = Path(os.environ.get("UPLOADS_DIR") or "/data/uploads")
    try:
        result = migrate_uploads(source, destination)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))
    if result["conflicts"] or result["errors"]:
        raise SystemExit(1)
