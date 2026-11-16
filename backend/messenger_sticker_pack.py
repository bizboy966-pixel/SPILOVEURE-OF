"""Bundled Twemoji art, redistributed under CC BY 4.0."""
from pathlib import Path

PACK_ROOT = Path(__file__).parent / "sticker_assets"
PACK_NAMES = {
    "heart": "Cœur", "laugh": "Rire", "smile": "Sourire", "love": "Affection",
    "thumb": "Bravo", "party": "Fête", "wave": "Salut", "fire": "Flamme",
}


def pack_file(fid):
    key = fid.removeprefix("pack-")
    if not fid.startswith("pack-") or key not in PACK_NAMES:
        return None
    path = PACK_ROOT / (key + ".png")
    return {
        "id": fid, "name": "sticker-" + PACK_NAMES[key] + ".png",
        "mime": "image/png", "size": path.stat().st_size,
        "url": "/api/messenger/files/" + fid, "sticker": True,
    }
