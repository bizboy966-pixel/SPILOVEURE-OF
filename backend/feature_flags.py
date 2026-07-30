"""Feature Flags — centralised on/off switches for the platform's newer modules.

All new features (Landing Page, Ads, Special Tasks, Marketplace, …) are gated by a
flag stored in `db.feature_flags`. On first startup, every default flag is
inserted with `enabled=False` so that a fresh deployment ships with every new
feature turned OFF. The admin then activates them one by one via the admin panel.

Frontend calls `GET /api/features` (public) to know which entries to render.
Backend endpoints protected by `Depends(require_feature("<key>"))` return
`503 Service Unavailable` when the corresponding flag is disabled — this also
blocks direct-URL bypass attempts.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel


# ─── Default catalog ───────────────────────────────────────────────────────────
# key → (label, category). Every feature added after Feb 2026 SHOULD be listed
# here so it inherits the "disabled after next deploy" policy requested by the
# product owner.
DEFAULT_FLAGS: List[Dict[str, str]] = [
    {"key": "landing_page",       "label": "Landing Page publique",          "category": "public"},
    {"key": "crypto_auto",        "label": "Auto-activation Crypto (USDT BEP20)", "category": "activation"},
    {"key": "ads",                "label": "Publicité (module complet)",      "category": "ads"},
    {"key": "ads_create_video",   "label": "Ajouter une vidéo publicitaire",  "category": "ads"},
    {"key": "ads_create_poster",  "label": "Ajouter une affiche publicitaire","category": "ads"},
    {"key": "special_tasks",      "label": "Créer une tâche spéciale",        "category": "tasks"},
    {"key": "marketplace",        "label": "Marketplace (module complet)",    "category": "marketplace"},
    {"key": "marketplace_publish","label": "Publier un article",              "category": "marketplace"},
    {"key": "service_request",    "label": "Demande de service",              "category": "services"},
    {"key": "paid_tasks",         "label": "Tâches rémunérées",               "category": "tasks"},
]

_ALLOWED_KEYS = {f["key"] for f in DEFAULT_FLAGS}


# ─── DB helpers ────────────────────────────────────────────────────────────────
async def ensure_default_flags(db) -> None:
    """Insert any missing flag as disabled. Idempotent — safe to call at every
    startup / redeploy. We deliberately DO NOT reset flags that already exist,
    so admin's toggles survive redeploys."""
    now = datetime.now(timezone.utc)
    for f in DEFAULT_FLAGS:
        await db.feature_flags.update_one(
            {"key": f["key"]},
            {
                "$setOnInsert": {
                    "key": f["key"],
                    "label": f["label"],
                    "category": f["category"],
                    "enabled": False,
                    "created_at": now,
                    "updated_at": now,
                }
            },
            upsert=True,
        )


async def is_enabled(db, key: str) -> bool:
    doc = await db.feature_flags.find_one({"key": key}, {"enabled": 1})
    return bool(doc and doc.get("enabled"))


def require_feature(key: str):
    """FastAPI dependency — 503 if the feature is disabled. Prevents any direct
    URL / cURL bypass even if the frontend hides the entry point."""
    if key not in _ALLOWED_KEYS:
        raise RuntimeError(f"Unknown feature key: {key}")

    async def _dep(request: Request):
        db = request.app.state.db
        if not await is_enabled(db, key):
            raise HTTPException(
                status_code=503,
                detail=f"Fonctionnalité '{key}' momentanément désactivée par l'administrateur.",
            )
        return True

    return _dep


# ─── API ───────────────────────────────────────────────────────────────────────
public = APIRouter(prefix="/api", tags=["features"])
admin = APIRouter(prefix="/api/admin", tags=["admin-features"])


class FlagUpdate(BaseModel):
    enabled: bool


@public.get("/features")
async def public_features(request: Request):
    """Public snapshot used by the frontend to know which entries to render.
    Returns a plain `{ key: bool }` dict — no auth required."""
    db = request.app.state.db
    out: Dict[str, bool] = {f["key"]: False for f in DEFAULT_FLAGS}
    async for doc in db.feature_flags.find({}, {"key": 1, "enabled": 1}):
        if doc.get("key") in out:
            out[doc["key"]] = bool(doc.get("enabled"))
    return {"features": out}


@admin.get("/feature-flags")
async def list_flags(request: Request):
    """Full catalog with labels + current state — admin only."""
    db = request.app.state.db
    stored: Dict[str, dict] = {}
    async for doc in db.feature_flags.find({}):
        stored[doc["key"]] = doc

    items = []
    for f in DEFAULT_FLAGS:
        d = stored.get(f["key"], {})
        items.append({
            "key": f["key"],
            "label": f["label"],
            "category": f["category"],
            "enabled": bool(d.get("enabled")),
            "updated_at": d.get("updated_at"),
        })
    return {"items": items}


@admin.put("/feature-flags/{key}")
async def update_flag(key: str, data: FlagUpdate, request: Request):
    """Toggle a single flag. Only known keys are accepted (defence in depth
    against typos / injection)."""
    if key not in _ALLOWED_KEYS:
        raise HTTPException(404, "Fonctionnalité inconnue.")
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    await db.feature_flags.update_one(
        {"key": key},
        {"$set": {"enabled": data.enabled, "updated_at": now},
         "$setOnInsert": {"key": key, "created_at": now}},
        upsert=True,
    )
    return {"key": key, "enabled": data.enabled}
