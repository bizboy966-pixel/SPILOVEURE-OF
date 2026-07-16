"""Challenge module — 100 direct invites campaign.

Business rules (2026-07-08):
- Admin creates challenges with: name, target (nb invites), reward_amount,
  reward_currency, start_at, end_at, active.
- Only ONE active challenge at a time (server enforces via de-activation on
  creation of a new active challenge — kept simple).
- A user's progress = number of DIRECT referrals (sponsor_id == user_id) whose
  FIRST activation date (`level_activated_at.1`) falls within the challenge
  window [start_at, end_at]. Accounts activated BEFORE start_at are excluded.
- When target is reached the challenge is marked "completed" for that user
  (client-side hint only). The reward is NEVER credited automatically — the
  user must contact customer service, per the spec.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin


public = APIRouter(prefix="/api", tags=["challenges"])
admin = APIRouter(
    prefix="/api/admin",
    tags=["challenges_admin"],
    dependencies=[Depends(require_admin)],
)


# ---------- Models ----------
class ChallengeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    target: int = Field(..., ge=1, le=100000)
    reward_amount: float = Field(..., ge=0)
    reward_currency: str = Field(default="FCFA", max_length=8)
    start_at: datetime
    end_at: datetime
    active: bool = True


class ChallengeUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    target: Optional[int] = Field(default=None, ge=1, le=100000)
    reward_amount: Optional[float] = Field(default=None, ge=0)
    reward_currency: Optional[str] = Field(default=None, max_length=8)
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    active: Optional[bool] = None


# ---------- Helpers ----------
def _serialize(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    for k in ("start_at", "end_at", "created_at", "updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.astimezone(timezone.utc).isoformat()
    return out


async def _count_progress(db, user_id: str, challenge: dict) -> int:
    """Count direct referrals of `user_id` whose L1 activation falls inside
    the challenge window. Uses `users.level_activated_at.1` as the source of
    truth for activation date.
    """
    start_at = challenge["start_at"]
    end_at = challenge["end_at"]
    return await db.users.count_documents({
        "sponsor_id": user_id,
        "level_activated_at.1": {"$gte": start_at, "$lte": end_at},
    })


async def _get_active_challenge(db) -> Optional[dict]:
    now = datetime.now(timezone.utc)
    doc = await db.challenges.find_one({
        "active": True,
        "start_at": {"$lte": now},
        "end_at": {"$gte": now},
    })
    return doc


# ---------- User endpoint ----------
@public.get("/challenges/current")
async def current_challenge(request: Request, user=Depends(get_current_user)):
    """Returns the currently-active challenge with the user's progress.
    Returns {"challenge": null} when no challenge is active.
    """
    db = request.app.state.db
    doc = await _get_active_challenge(db)
    if not doc:
        return {"challenge": None, "progress": 0, "completed": False}
    progress = await _count_progress(db, user["id"], doc)
    return {
        "challenge": _serialize(doc),
        "progress": progress,
        "completed": progress >= doc["target"],
    }


# ---------- Admin endpoints ----------
@admin.get("/challenges")
async def list_challenges(request: Request):
    db = request.app.state.db
    items = []
    async for c in db.challenges.find({}, {"_id": 0}).sort("created_at", -1):
        items.append(_serialize(c))
    return {"items": items}


@admin.post("/challenges")
async def create_challenge(data: ChallengeCreate, request: Request):
    db = request.app.state.db
    if data.end_at <= data.start_at:
        raise HTTPException(400, "La date de fin doit être postérieure à la date de début.")
    # Only one active challenge at a time — de-activate the others.
    if data.active:
        await db.challenges.update_many({"active": True}, {"$set": {"active": False}})
    doc = {
        "id": str(uuid.uuid4()),
        "name": data.name,
        "target": data.target,
        "reward_amount": data.reward_amount,
        "reward_currency": data.reward_currency,
        "start_at": data.start_at.astimezone(timezone.utc),
        "end_at": data.end_at.astimezone(timezone.utc),
        "active": data.active,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    await db.challenges.insert_one(doc)
    return _serialize(doc)


@admin.put("/challenges/{challenge_id}")
async def update_challenge(challenge_id: str, data: ChallengeUpdate, request: Request):
    db = request.app.state.db
    existing = await db.challenges.find_one({"id": challenge_id})
    if not existing:
        raise HTTPException(404, "Challenge introuvable.")

    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    if data.name is not None:
        updates["name"] = data.name
    if data.target is not None:
        updates["target"] = data.target
    if data.reward_amount is not None:
        updates["reward_amount"] = data.reward_amount
    if data.reward_currency is not None:
        updates["reward_currency"] = data.reward_currency
    if data.start_at is not None:
        updates["start_at"] = data.start_at.astimezone(timezone.utc)
    if data.end_at is not None:
        updates["end_at"] = data.end_at.astimezone(timezone.utc)
    if data.active is not None:
        updates["active"] = data.active
        if data.active:
            await db.challenges.update_many(
                {"id": {"$ne": challenge_id}, "active": True},
                {"$set": {"active": False}},
            )

    start = updates.get("start_at", existing["start_at"])
    end = updates.get("end_at", existing["end_at"])
    # Motor returns tz-naive datetimes from Mongo; normalize before compare.
    if isinstance(start, datetime) and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if isinstance(end, datetime) and end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if end <= start:
        raise HTTPException(400, "La date de fin doit être postérieure à la date de début.")

    await db.challenges.update_one({"id": challenge_id}, {"$set": updates})
    doc = await db.challenges.find_one({"id": challenge_id}, {"_id": 0})
    return _serialize(doc)


@admin.delete("/challenges/{challenge_id}")
async def delete_challenge(challenge_id: str, request: Request):
    db = request.app.state.db
    r = await db.challenges.delete_one({"id": challenge_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Challenge introuvable.")
    return {"ok": True}


@admin.get("/challenges/{challenge_id}/participants")
async def challenge_participants(challenge_id: str, request: Request):
    """Return the progress of every user who has at least one qualifying
    activation for this challenge. Winners (target reached) are highlighted.
    """
    db = request.app.state.db
    doc = await db.challenges.find_one({"id": challenge_id})
    if not doc:
        raise HTTPException(404, "Challenge introuvable.")

    # Aggregation: qualifying activations grouped by sponsor.
    pipeline = [
        {"$match": {
            "level_activated_at.1": {"$gte": doc["start_at"], "$lte": doc["end_at"]},
            "sponsor_id": {"$ne": None},
        }},
        {"$group": {"_id": "$sponsor_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    rows = []
    async for r in db.users.aggregate(pipeline):
        u = await db.users.find_one(
            {"id": r["_id"]}, {"_id": 0, "id": 1, "username": 1, "phone": 1, "country": 1},
        )
        if not u:
            continue
        count = int(r["count"])
        rows.append({
            "user_id": u["id"],
            "username": u.get("username"),
            "phone": u.get("phone"),
            "country": u.get("country"),
            "progress": count,
            "target": doc["target"],
            "completed": count >= doc["target"],
        })
    return {
        "challenge": _serialize(doc),
        "participants": rows,
        "winners_count": sum(1 for x in rows if x["completed"]),
    }
