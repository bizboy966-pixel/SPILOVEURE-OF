"""Private Cloudflare R2 storage for SPILOVEURE Chat attachments.

R2 credentials are runtime configuration only. Chat uploads use short-lived
presigned URLs so file bytes travel from the client directly to R2.
"""
from __future__ import annotations

from functools import lru_cache
import os
import re
from urllib.parse import quote

import boto3
from botocore.config import Config

_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
DEFAULT_URL_TTL = 300
MAX_URL_TTL = 3600


class R2NotConfigured(RuntimeError):
    """Raised when the VPS has not been configured with R2 credentials."""


def is_configured() -> bool:
    return all(os.environ.get(key, "").strip() for key in (
        "R2_ACCOUNT_ID",
        "R2_BUCKET_NAME",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
    ))


def _required(key: str) -> str:
    value = os.environ.get(key, "").strip()
    if not value:
        raise R2NotConfigured(f"{key} must be configured to use Chat R2 storage.")
    return value


@lru_cache(maxsize=1)
def _client():
    account_id = _required("R2_ACCOUNT_ID")
    access_key = _required("R2_ACCESS_KEY_ID")
    secret_key = _required("R2_SECRET_ACCESS_KEY")
    endpoint = (
        os.environ.get("R2_ENDPOINT_URL")
        or f"https://{account_id}.r2.cloudflarestorage.com"
    ).strip()
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="auto",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def _bucket() -> str:
    return _required("R2_BUCKET_NAME")


def object_key(file_id: str) -> str:
    if not _FILE_ID.fullmatch(file_id or ""):
        raise ValueError("Invalid Chat file id.")
    return f"messenger/{file_id}"


def create_upload_url(file_id: str, content_type: str, size: int, expires: int = DEFAULT_URL_TTL) -> str:
    """Sign one PUT for one object, binding its type and declared byte length."""
    if size <= 0:
        raise ValueError("Upload size must be positive.")
    ttl = max(1, min(int(expires), MAX_URL_TTL))
    return _client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": _bucket(),
            "Key": object_key(file_id),
            "ContentType": content_type,
            "ContentLength": int(size),
        },
        ExpiresIn=ttl,
        HttpMethod="PUT",
    )


def create_download_url(
    file_id: str,
    content_type: str,
    filename: str,
    download: bool = False,
    expires: int = DEFAULT_URL_TTL,
) -> str:
    """Sign a short-lived GET without making the R2 bucket public."""
    safe_name = (filename or "fichier").replace("\r", "").replace("\n", "").replace('"', "'")[:180]
    ascii_name = "".join(character if ord(character) < 128 and character not in "\\;" else "_" for character in safe_name)
    disposition = "attachment" if download else "inline"
    disposition += f'; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(safe_name, safe="")}'
    ttl = max(1, min(int(expires), MAX_URL_TTL))
    return _client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": object_key(file_id),
            "ResponseContentType": content_type,
            "ResponseContentDisposition": disposition,
            "ResponseCacheControl": "private, no-store, max-age=0",
        },
        ExpiresIn=ttl,
        HttpMethod="GET",
    )


def head_upload(file_id: str) -> dict:
    return _client().head_object(Bucket=_bucket(), Key=object_key(file_id))


def put_upload(file_id: str, body, content_type: str, size: int) -> None:
    _client().put_object(
        Bucket=_bucket(),
        Key=object_key(file_id),
        Body=body,
        ContentType=content_type,
        ContentLength=int(size),
        CacheControl="private, no-store, max-age=0",
    )


def get_upload(file_id: str):
    return _client().get_object(Bucket=_bucket(), Key=object_key(file_id))


def delete_upload(file_id: str) -> None:
    _client().delete_object(Bucket=_bucket(), Key=object_key(file_id))


def configure_bucket_cors(origins: list[str]) -> None:
    clean_origins = sorted({origin.strip().rstrip("/") for origin in origins if origin.strip()})
    if not clean_origins:
        raise ValueError("At least one allowed web origin is required.")
    _client().put_bucket_cors(
        Bucket=_bucket(),
        CORSConfiguration={"CORSRules": [{
            "AllowedOrigins": clean_origins,
            "AllowedMethods": ["GET", "HEAD", "PUT"],
            "AllowedHeaders": ["Content-Type", "Content-Length", "Range"],
            "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
            "MaxAgeSeconds": 3600,
        }]},
    )
