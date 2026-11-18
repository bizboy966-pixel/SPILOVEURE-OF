"""Small, dependency-free checks for APK uploads and download headers."""
from __future__ import annotations

from io import BytesIO
from pathlib import PurePosixPath
import re
from zipfile import BadZipFile, ZipFile

APK_CONTENT_TYPE = "application/vnd.android.package-archive"
_APK_SIGNATURE_MAGIC = b"APK Sig Block 42"
_SAFE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


class InvalidApk(ValueError):
    """The upload is not structurally recognizable as an installable APK."""


def _has_v2_or_v3_signature(data: bytes, archive: ZipFile) -> bool:
    # APK Signing Blocks are placed immediately before the ZIP central
    # directory. Checking both size fields and the footer avoids accepting
    # an unrelated occurrence of the magic string elsewhere in the file.
    central_directory = archive.start_dir
    footer_start = central_directory - 24
    if footer_start < 0 or data[central_directory - 16:central_directory] != _APK_SIGNATURE_MAGIC:
        return False

    block_size = int.from_bytes(data[footer_start:central_directory - 16], "little")
    block_start = central_directory - block_size - 8
    if block_size < 24 or block_start < 0 or block_start + 8 > footer_start:
        return False
    leading_size = int.from_bytes(data[block_start:block_start + 8], "little")
    return leading_size == block_size


def validate_apk(data: bytes) -> None:
    """Raise a clear error unless bytes look like a signed Android package.

    This checks the APK ZIP structure, Android binary manifest, app code or
    native payload, and a v1/v2/v3 signing marker. It does not replace a full
    cryptographic `apksigner verify` run, which is not installed on the VPS.
    """
    if not data:
        raise InvalidApk("Le fichier APK est vide.")

    try:
        archive = ZipFile(BytesIO(data))
    except (BadZipFile, OSError, ValueError):
        raise InvalidApk("Le fichier n’est pas une archive APK valide.") from None

    with archive:
        files = {
            info.filename: info
            for info in archive.infolist()
            if not info.is_dir()
        }
        manifest = files.get("AndroidManifest.xml")
        if manifest is None or manifest.file_size < 8 or manifest.file_size > 10 * 1024 * 1024:
            raise InvalidApk("Le fichier ZIP ne contient pas de manifeste Android valide.")

        try:
            with archive.open(manifest) as stream:
                manifest_header = stream.read(8)
        except (BadZipFile, OSError, RuntimeError):
            raise InvalidApk("Le manifeste Android du fichier APK est illisible.") from None

        # Packaged APK manifests use Android binary XML (RES_XML_TYPE = 0x0003).
        if manifest_header[:2] != b"\x03\x00":
            raise InvalidApk("Le manifeste n’est pas au format Android attendu.")

        has_dex = False
        for name, info in files.items():
            base = PurePosixPath(name).name
            if not re.fullmatch(r"classes(?:\d+)?\.dex", base):
                continue
            if info.file_size < 8 or info.file_size > 100 * 1024 * 1024:
                continue
            try:
                with archive.open(info) as stream:
                    header = stream.read(8)
            except (BadZipFile, OSError, RuntimeError):
                continue
            if header[:4] == b"dex\n" and header[4:7].isdigit() and header[7:8] == b"\0":
                has_dex = True
                break

        has_native_lib = any(
            name.startswith("lib/") and name.endswith(".so")
            for name in files
        )
        has_android_payload = has_dex or has_native_lib or "resources.arsc" in files
        if not has_android_payload:
            raise InvalidApk("Le fichier ne contient ni code Android ni ressources d’application.")

        has_v1_signature = any(
            name.upper().startswith("META-INF/")
            and name.upper().endswith((".RSA", ".DSA", ".EC"))
            and info.file_size > 0
            for name, info in files.items()
        )
        if not has_v1_signature and not _has_v2_or_v3_signature(data, archive):
            raise InvalidApk("L’APK n’est pas signé. Importez le fichier APK de production signé.")


def upload_content_type(filename: str, original_content_type: str | None) -> str:
    if filename.lower().endswith(".apk"):
        return APK_CONTENT_TYPE
    return original_content_type or "application/octet-stream"


def apk_download_headers(filename: str) -> dict[str, str]:
    safe_name = PurePosixPath(filename).name
    if not _SAFE_FILENAME.fullmatch(safe_name) or not safe_name.lower().endswith(".apk"):
        safe_name = "SPILOVEURE.apk"
    return {
        "Content-Disposition": f'attachment; filename="{safe_name}"',
        "X-Content-Type-Options": "nosniff",
    }
