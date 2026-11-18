"""Groupe d'accompagnement — each leader configures his own group link,
shown to his DIRECT, activated referrals (sponsor_id) via an invitation popup."""
from __future__ import annotations

import ipaddress
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import get_current_user

public = APIRouter(prefix="/api")

REMIND_AFTER = timedelta(hours=24)
MAX_URL_LEN = 500
_HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


class GroupIn(BaseModel):
    url: str


class InviteActionIn(BaseModel):
    version: str


def validate_group_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise HTTPException(400, "Veuillez saisir le lien de votre groupe.")
    if len(url) > MAX_URL_LEN:
        raise HTTPException(400, f"Lien trop long (max {MAX_URL_LEN} caractères).")
    if any(c.isspace() or ord(c) < 32 for c in url) or any(c in url for c in "<>\"'`\\"):
        raise HTTPException(400, "Le lien contient des caractères non autorisés.")
    p = urlparse(url)
    if p.scheme.lower() != "https":
        raise HTTPException(400, "Le lien doit commencer par https://")
    if "@" in p.netloc or not p.hostname:
        raise HTTPException(400, "Lien invalide : adresse du site introuvable.")
    host = p.hostname.lower()
    try:
        ipaddress.ip_address(host)
        raise HTTPException(400, "Les adresses IP ne sont pas acceptées, utilisez un nom de domaine.")
    except ValueError:
        pass
    if host == "localhost" or not _HOST_RE.match(host):
        raise HTTPException(400, "Lien invalide : nom de domaine incorrect.")
    return url


def _iso(d):
    return d.isoformat() if isinstance(d, datetime) else d


def _aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


@public.get("/me/support-group")
async def get_my_group(request: Request, user=Depends(get_current_user)):
    g = await request.app.state.db.support_groups.find_one({"leader_id": user["id"]}, {"_id": 0})
    if not g:
        return {"url": None, "updated_at": None}
    return {"url": g["url"], "updated_at": _iso(g.get("updated_at"))}


@public.put("/me/support-group")
async def save_my_group(data: GroupIn, request: Request, user=Depends(get_current_user)):
    url = validate_group_url(data.url)
    db = request.app.state.db
    now = datetime.now(timezone.utc)
    existing = await db.support_groups.find_one({"leader_id": user["id"]}, {"_id": 0})
    version = existing["version"] if existing and existing["url"] == url else str(uuid.uuid4())
    await db.support_groups.update_one(
        {"leader_id": user["id"]},
        {"$set": {"url": url, "version": version, "updated_at": now},
         "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    return {"ok": True, "url": url, "updated_at": now.isoformat()}


@public.delete("/me/support-group")
async def delete_my_group(request: Request, user=Depends(get_current_user)):
    await request.app.state.db.support_groups.delete_one({"leader_id": user["id"]})
    return {"ok": True}


async def _sponsor_group(db, user) -> Optional[dict]:
    if user.get("status") != "active" or (user.get("max_level") or 0) < 1:
        return None
    sponsor_id = user.get("sponsor_id")
    if not sponsor_id or sponsor_id == user["id"]:
        return None
    g = await db.support_groups.find_one({"leader_id": sponsor_id}, {"_id": 0})
    if not g:
        return None
    try:
        validate_group_url(g["url"])
    except HTTPException:
        return None
    return g


@public.get("/me/support-group/invite")
async def get_invite(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    g = await _sponsor_group(db, user)
    if not g:
        return {"show": False}
    inv = await db.support_group_invites.find_one(
        {"user_id": user["id"], "leader_id": g["leader_id"], "version": g["version"]}, {"_id": 0})
    if inv:
        if inv.get("status") == "link_opened":
            return {"show": False}
        if inv.get("status") == "postponed" and inv.get("postponed_at") and \
                datetime.now(timezone.utc) - _aware(inv["postponed_at"]) < REMIND_AFTER:
            return {"show": False}
    return {
        "show": True,
        "url": g["url"],
        "version": g["version"],
        "leader_username": user.get("sponsor_username"),
    }


async def _record(request: Request, user: dict, version: str, status: str, ts_field: str):
    db = request.app.state.db
    g = await _sponsor_group(db, user)
    if not g or g["version"] != version:
        raise HTTPException(404, "Ce groupe n'est plus disponible.")
    now = datetime.now(timezone.utc)
    key = {"user_id": user["id"], "leader_id": g["leader_id"], "version": version}
    if status == "postponed" and await db.support_group_invites.find_one({**key, "status": "link_opened"}):
        return
    await db.support_group_invites.update_one(
        key,
        {"$set": {"status": status, ts_field: now, "url": g["url"], "updated_at": now}, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )


@public.post("/me/support-group/invite/opened")
async def invite_opened(data: InviteActionIn, request: Request, user=Depends(get_current_user)):
    await _record(request, user, data.version, "link_opened", "opened_at")
    return {"ok": True, "status": "link_opened"}


@public.post("/me/support-group/invite/later")
async def invite_later(data: InviteActionIn, request: Request, user=Depends(get_current_user)):
    await _record(request, user, data.version, "postponed", "postponed_at")
    return {"ok": True, "status": "postponed", "remind_after_hours": int(REMIND_AFTER.total_seconds() // 3600)}
