"""Top-up / Recharge module — adds a `balance_recharge` wallet to users.

The recharge wallet is used as fallback when `balance_profit` is insufficient
(e.g. joining a Lottery draw). It also keeps a clean separation between MLM
commissions and user-driven deposits.

Two deposit methods:
  1. MANUAL — user fills in their mobile money phone + a transaction ref ;
     admin reviews and validates, which credits `balance_recharge`.
  2. AUTOMATIC — routed through the active payment gateway dispatcher used by
     `/payments/soleaspay/initiate` (SoleasPay or AshtecPay). Credit happens
     when the polling endpoint receives a "paid" status from the gateway.

Collections:
  * `recharges` — every request (manual + automatic), with status and audit.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from auth import get_current_user, require_admin

public = APIRouter(prefix="/api", tags=["recharge"])
admin = APIRouter(prefix="/api/admin", tags=["recharge_admin"])


class ManualRechargeIn(BaseModel):
    amount: float = Field(gt=0)
    operator: str = Field(min_length=1, max_length=40)
    phone: str = Field(min_length=4, max_length=30)
    transaction_ref: str = Field(min_length=2, max_length=80)
    note: str = ""


@public.get("/me/recharge-balance")
async def my_recharge_balance(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "balance_recharge": 1}) or {}
    return {"balance_recharge": float(u.get("balance_recharge") or 0)}


@public.post("/me/recharge/manual")
async def request_manual_recharge(body: ManualRechargeIn, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "username": user.get("username"),
        "amount": float(body.amount),
        "method": "manual",
        "operator": body.operator,
        "phone": body.phone,
        "transaction_ref": body.transaction_ref.strip(),
        "note": (body.note or "").strip(),
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
    }
    await db.recharges.insert_one(dict(doc))
    doc["created_at"] = doc["created_at"].isoformat()
    return {"ok": True, "recharge": doc}


@public.get("/me/recharge-history")
async def my_recharge_history(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    items = []
    async for r in db.recharges.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).limit(200):
        if isinstance(r.get("created_at"), datetime):
            r["created_at"] = r["created_at"].isoformat()
        if isinstance(r.get("validated_at"), datetime):
            r["validated_at"] = r["validated_at"].isoformat()
        if isinstance(r.get("rejected_at"), datetime):
            r["rejected_at"] = r["rejected_at"].isoformat()
        items.append(r)
    return items


@admin.get("/recharges")
async def admin_list_recharges(request: Request, _=Depends(require_admin), status_filter: Optional[str] = None):
    db = request.app.state.db
    q: dict = {}
    if status_filter:
        q["status"] = status_filter
    items = []
    async for r in db.recharges.find(q, {"_id": 0}).sort("created_at", -1).limit(500):
        if isinstance(r.get("created_at"), datetime):
            r["created_at"] = r["created_at"].isoformat()
        if isinstance(r.get("validated_at"), datetime):
            r["validated_at"] = r["validated_at"].isoformat()
        if isinstance(r.get("rejected_at"), datetime):
            r["rejected_at"] = r["rejected_at"].isoformat()
        items.append(r)
    return items


@admin.post("/recharges/{rid}/validate")
async def admin_validate_recharge(rid: str, request: Request, who=Depends(require_admin)):
    db = request.app.state.db
    r = await db.recharges.find_one({"id": rid}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Recharge introuvable.")
    if r["status"] != "pending":
        raise HTTPException(400, f"Recharge déjà {r['status']}.")
    await db.users.update_one({"id": r["user_id"]}, {"$inc": {"balance_recharge": float(r["amount"])}})
    await db.recharges.update_one(
        {"id": rid},
        {"$set": {"status": "validated", "validated_at": datetime.now(timezone.utc), "validated_by": who.get("username")}},
    )
    # Notify user
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": r["user_id"],
        "kind": "recharge_validated",
        "title": "✅ Recharge validée",
        "body": f"Votre recharge de {int(r['amount']):,} FCFA a été créditée sur votre compte.".replace(",", " "),
        "read": False,
        "created_at": datetime.now(timezone.utc),
    })
    return {"ok": True}


@admin.post("/recharges/{rid}/reject")
async def admin_reject_recharge(rid: str, body: dict, request: Request, who=Depends(require_admin)):
    db = request.app.state.db
    r = await db.recharges.find_one({"id": rid}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Recharge introuvable.")
    if r["status"] != "pending":
        raise HTTPException(400, f"Recharge déjà {r['status']}.")
    reason = (body or {}).get("reason") or ""
    await db.recharges.update_one(
        {"id": rid},
        {"$set": {"status": "rejected", "rejected_at": datetime.now(timezone.utc), "rejected_by": who.get("username"), "reject_reason": reason}},
    )
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": r["user_id"],
        "kind": "recharge_rejected",
        "title": "❌ Recharge refusée",
        "body": f"Votre recharge de {int(r['amount']):,} FCFA a été refusée. Motif : {reason or 'Non précisé'}".replace(",", " "),
        "read": False,
        "created_at": datetime.now(timezone.utc),
    })
    return {"ok": True}
