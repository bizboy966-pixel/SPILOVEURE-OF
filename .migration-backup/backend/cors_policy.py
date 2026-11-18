"""Strict CORS origin parsing for the public API."""
from __future__ import annotations

import os
from urllib.parse import urlsplit

DEFAULT_CORS_ORIGIN = "https://spiloveure.org"


def cors_origins(raw: str | None = None) -> list[str]:
    """Return exact HTTP(S) origins; never enable wildcard credentialed CORS."""
    value = os.environ.get("CORS_ORIGINS", DEFAULT_CORS_ORIGIN) if raw is None else raw
    if not value.strip():
        value = DEFAULT_CORS_ORIGIN

    origins: list[str] = []
    for entry in value.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            parsed = urlsplit(entry)
            port = parsed.port  # Force validation of malformed ports.
        except ValueError as exc:
            raise ValueError(f"Invalid CORS origin: {entry!r}") from exc
        if (
            parsed.scheme.lower() not in ("http", "https")
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or "*" in parsed.netloc
        ):
            raise ValueError(f"CORS_ORIGINS must contain exact HTTP(S) origins, not {entry!r}")
        host = parsed.hostname.lower() if parsed.hostname else ""
        if ":" in host:
            host = f"[{host}]"
        default_port = (parsed.scheme.lower() == "https" and port == 443) or (
            parsed.scheme.lower() == "http" and port == 80
        )
        normalized_netloc = f"{host}:{port}" if port and not default_port else host
        origins.append(f"{parsed.scheme.lower()}://{normalized_netloc}")

    if not origins:
        return [DEFAULT_CORS_ORIGIN]
    return list(dict.fromkeys(origins))
