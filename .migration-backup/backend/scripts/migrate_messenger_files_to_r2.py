"""Copy legacy local Chat files to R2 and update metadata after verification.

The default mode is read-only. Run with --apply on the VPS after configuring
R2 and taking the usual backup. This script never deletes local files.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from botocore.exceptions import ClientError
from motor.motor_asyncio import AsyncIOMotorClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
import messenger_r2 as r2  # noqa: E402

UPLOAD_ROOT = Path(
    os.environ.get("UPLOADS_DIR", str(BACKEND_DIR / "uploads"))
) / "messenger"


def local_file_path(file_id: str) -> Path:
    # Validate database IDs before using them as disk paths.
    r2.object_key(file_id)
    return UPLOAD_ROOT / file_id


async def migrate(apply: bool) -> int:
    mongo_url = os.environ.get("MONGO_URL")
    if not mongo_url:
        raise RuntimeError("MONGO_URL must be configured on the VPS.")
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ.get("DB_NAME", "spilivere")]
    try:
        rows = await db.spv_files.find(
            {"storage_backend": {"$ne": "r2"}},
            {"_id": 0, "id": 1, "size": 1, "mime": 1, "name": 1},
        ).to_list(100_000)
        eligible = [row for row in rows if local_file_path(row["id"]).is_file()]
        missing = len(rows) - len(eligible)
        print(f"Found {len(eligible)} local files to copy; {missing} metadata rows have no local file.")
        if not apply:
            print("Read-only dry run; no R2 or MongoDB changes made. Use --apply to copy and update metadata.")
            return 0
        if not r2.is_configured():
            raise RuntimeError("Configure the R2 environment variables on the VPS before running --apply.")

        copied = 0
        for row in eligible:
            file_id = row["id"]
            path = local_file_path(file_id)
            size = path.stat().st_size
            if size != int(row.get("size") or 0):
                raise RuntimeError(f"Size mismatch for a local Chat file; migration stopped before updating it.")
            try:
                head = await asyncio.to_thread(r2.head_upload, file_id)
                exists = True
            except ClientError as error:
                code = str(error.response.get("Error", {}).get("Code", ""))
                if code not in {"404", "NoSuchKey", "NotFound"}:
                    raise
                exists = False
                head = {}
            if not exists or int(head.get("ContentLength") or -1) != size:
                with path.open("rb") as content:
                    await asyncio.to_thread(r2.put_upload, file_id, content, row["mime"], size)
                head = await asyncio.to_thread(r2.head_upload, file_id)
            if int(head.get("ContentLength") or -1) != size:
                raise RuntimeError("R2 size verification failed; migration stopped before updating metadata.")
            await db.spv_files.update_one(
                {"id": file_id, "storage_backend": {"$ne": "r2"}},
                {"$set": {
                    "storage_backend": "r2",
                    "storage_key": r2.object_key(file_id),
                    "status": "ready",
                }},
            )
            copied += 1
        print(f"Copied and verified {copied} Chat files. Local copies were retained.")
        return 0
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Copy files and update MongoDB metadata.")
    args = parser.parse_args()
    return asyncio.run(migrate(args.apply))


if __name__ == "__main__":
    raise SystemExit(main())
