"""Read-only official APK distribution. No download until a validated APK exists."""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response

router = APIRouter()
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
PACKAGE = "com.spilivere.app"


def releases_dir():
    return Path(os.environ.get("ANDROID_RELEASES_DIR") or
                str(Path(os.environ.get("UPLOADS_DIR", "/data/uploads")) / "android-releases")).resolve()


def official_url():
    value = os.environ.get("PUBLIC_APP_URL") or os.environ.get("SITE_URL") or ""
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        return ""
    return value.rstrip("/")


@lru_cache(maxsize=8)
def verified_hash(path: str, size: int, mtime_ns: int, ctime_ns: int):
    checksum = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def load_releases():
    root = releases_dir()
    manifest = root / "releases.json"
    if not manifest.exists():
        return []
    try:
        data = json.loads(manifest.read_text())
        if not isinstance(data, list):
            raise ValueError("Invalid release manifest")
        result = []
        for row in data:
            version = row["version"]
            if not VERSION.fullmatch(version) or row["package"] != PACKAGE:
                raise ValueError("Invalid release identity")
            if (not SHA256.fullmatch(row["sha256"]) or not SHA256.fullmatch(row["signer_sha256"])
                    or row.get("validated") is not True):
                raise ValueError("Unvalidated release")
            file = root / f"spiloveure-{version}.apk"
            if file.is_symlink() or file.resolve().parent != root:
                raise ValueError("Invalid release path")
            stat = file.stat()
            if stat.st_size != row["size_bytes"] or verified_hash(
                str(file), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
            ) != row["sha256"]:
                raise ValueError("Release integrity failed")
            result.append({
                key: row[key] for key in ("version", "version_code", "size_bytes", "published_at",
                                         "sha256", "signer_sha256", "min_android")
            })
        if len({r["version"] for r in result}) != len(result):
            raise ValueError("Duplicate release")
        result.sort(key=lambda r: r["version_code"], reverse=True)
        return [{**r, "download_url": f"/api/android/releases/{r['version']}/download"} for r in result]
    except (ValueError, KeyError, TypeError, OSError):
        raise HTTPException(503, "Les fichiers Android ne sont pas disponibles ou leur intégrité n’est pas confirmée.") from None


@router.get("/api/android/releases")
async def release_info():
    rows = load_releases()
    return {"available": bool(rows), "latest": rows[0] if rows else None, "releases": rows}


@router.get("/api/android/releases/{version}/download")
async def download_release(version: str):
    if not VERSION.fullmatch(version):
        raise HTTPException(404, "Version Android introuvable.")
    row = next((r for r in load_releases() if r["version"] == version), None)
    if not row:
        raise HTTPException(404, "Aucun APK validé n’est disponible pour cette version.")
    return FileResponse(
        releases_dir() / f"spiloveure-{version}.apk",
        media_type="application/vnd.android.package-archive",
        filename=f"SPILOVEURE-{version}.apk",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600",
                 "ETag": f'"{row["sha256"]}"'},
    )


@router.get("/telecharger", response_class=HTMLResponse)
@router.get("/telecharger/", response_class=HTMLResponse, include_in_schema=False)
async def download_page():
    url = official_url()
    template = (Path(__file__).parent / "templates" / "android-download.html").read_text()
    content = template.replace("@@CANONICAL@@", html.escape(url + "/telecharger" if url else "", quote=True))
    content = content.replace("@@ROBOTS@@", "index,follow" if url else "noindex,nofollow")
    return HTMLResponse(content, headers={"X-Content-Type-Options": "nosniff",
                                         "Referrer-Policy": "strict-origin-when-cross-origin"})


@router.get("/sitemap-android.xml")
async def android_sitemap():
    url = official_url()
    entries = f"<url><loc>{html.escape(url)}/telecharger</loc></url>" if url else ""
    return Response('<?xml version="1.0" encoding="UTF-8"?>'
                    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    + entries + "</urlset>", media_type="application/xml")


@router.get("/robots.txt", include_in_schema=False)
async def android_robots():
    url = official_url()
    content = ("User-agent: *\nAllow: /telecharger\n"
               f"Sitemap: {url}/sitemap-android.xml\n") if url else "User-agent: *\nDisallow: /telecharger\n"
    return Response(content, media_type="text/plain")
