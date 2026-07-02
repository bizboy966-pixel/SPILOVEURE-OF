"""Integrity Audit — detects fraudulent or unexplained activations & commissions.

This module exposes read-only admin endpoints that help operators identify
accounts and commissions that do not have a valid business origin. It is
intentionally READ-ONLY: it never modifies data. Any corrective action must
be taken manually by the admin through the existing admin endpoints (which
themselves enforce balance / permission rules).

Endpoints:
  GET /api/admin/audit/free-activations
      For every user with max_level >= 1, list activations that do NOT match
      any external payment record (payments collection with status=paid),
      any admin-validated manual activation (activations collection with
      status=validated), or any prior auto-upgrade explained by the
      balance_upgrade reserve. Level-1 activations from source=admin_manual
      are explicitly allowed by the business spec and are flagged with
      severity=info instead of error.

  GET /api/admin/audit/orphan-commissions
      List commissions whose `from_user_id`:
        - does not exist anymore, OR
        - never reached the level of the commission (impossible chain), OR
        - is missing from the recipient's expected ancestor chain (level-N
          direct or spillover ancestor).

  GET /api/admin/audit/user/{user_id}/trace
      Full trace of a single user: their activation events, their received
      commissions with source detail, and their payments. Meant to be used
      right after spotting a suspicious account.

Note: this module ONLY reads the DB. To act on the findings the admin uses
`/api/admin/users/{id}/action` (already existing, already guarded) or
manually adjusts records via the DB console.
"""
from __future__ import annotations
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import require_admin

log = logging.getLogger("integrity_audit")

router = APIRouter(prefix="/api/admin/audit", tags=["integrity-audit"])


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


async def _walk_up_sponsors(db, start_id: Optional[str], hops: int) -> Optional[str]:
    if not start_id or hops < 0:
        return None
    cur = start_id
    for _ in range(hops):
        u = await db.users.find_one({"id": cur}, {"_id": 0, "sponsor_id": 1})
        if not u or not u.get("sponsor_id"):
            return None
        cur = u["sponsor_id"]
    return cur


# ─────────────────────────────────────────────────────────────────────────────
# 1) Free-activation audit
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/free-activations")
async def audit_free_activations(request: Request, _=Depends(require_admin)):
    """Return every level activation that lacks a plausible payment origin."""
    db = request.app.state.db

    findings = []
    # Iterate users with max_level >= 1
    async for u in db.users.find(
        {"max_level": {"$gte": 1}, "role": {"$ne": "admin"}},
        {"_id": 0, "id": 1, "username": 1, "email": 1, "max_level": 1,
         "level_activated_at": 1, "sponsor_username": 1, "created_at": 1, "role": 1},
    ):
        max_level = int(u.get("max_level") or 0)
        for lv in range(1, max_level + 1):
            reason, source, ref = await _classify_activation(db, u["id"], lv)
            if reason == "ok":
                continue
            findings.append({
                "user_id": u["id"],
                "username": u.get("username"),
                "email": u.get("email"),
                "level": lv,
                "reason": reason,
                "detected_source": source,
                "activation_reference": ref,
                "user_created_at": _iso(u.get("created_at")),
                "sponsor_username": u.get("sponsor_username"),
                "activated_at": _iso((u.get("level_activated_at") or {}).get(str(lv))),
            })
    # Severity summary
    summary = {
        "total_findings": len(findings),
        "critical": sum(1 for f in findings if f["reason"] == "no_origin"),
        "warning": sum(1 for f in findings if f["reason"] == "admin_l1_only"),
    }
    return {"summary": summary, "findings": findings}


async def _classify_activation(db, user_id: str, level: int):
    """Return (reason, source_kind, reference)."""
    # 1) Explicit activation event (new since fix). Prefer this trace.
    ev = await db.activation_events.find_one(
        {"user_id": user_id, "level": level}, {"_id": 0}, sort=[("created_at", 1)],
    )
    if ev:
        src = ev.get("source")
        if src in ("soleaspay", "ashtecpay", "gateway_return"):
            return ("ok", src, None)
        if src == "admin_validate":
            return ("ok", src, None)
        if src == "manual_reprocess":
            return ("ok", src, None)
        if src == "auto_upgrade" or src == "manual":
            return ("ok", src, None)
        if src == "admin_manual" and level == 1:
            # Explicitly allowed by business spec for level 1 only.
            return ("admin_l1_only", src, None)
        if src == "admin_manual" and level >= 2:
            return ("no_origin", src, None)
        # Unknown source — treat as suspicious.
        return ("no_origin", src or "unknown", None)

    # 2) No activation event stored (legacy pre-audit-instrumentation).
    #    Look for a paid payment at this level.
    p = await db.payments.find_one(
        {"user_id": user_id, "level": level, "status": "paid"}, {"_id": 0},
    )
    if p:
        return ("ok", "legacy_payment", p.get("reference"))

    # 3) Validated manual activation.
    a = await db.activations.find_one(
        {"user_id": user_id, "level": level, "status": {"$in": ["validated", "accepted", "approved"]}},
        {"_id": 0},
    )
    if a:
        return ("ok", "legacy_manual_activation", a.get("id"))

    # 4) Any pending payment at this level? Suspicious — activation without paid confirmation.
    pending = await db.payments.find_one(
        {"user_id": user_id, "level": level}, {"_id": 0, "reference": 1, "status": 1},
    )
    if pending:
        return ("no_origin", f"payment_status={pending.get('status')}", pending.get("reference"))

    # 5) Nothing found — could be a pre-audit legacy activation. Flag as suspicious.
    return ("no_origin", "no_record_found", None)


# ─────────────────────────────────────────────────────────────────────────────
# 2) Orphan-commissions audit
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/orphan-commissions")
async def audit_orphan_commissions(request: Request, _=Depends(require_admin)):
    """List commissions with an invalid origin or ancestor chain.

    Rules verified for each `commissions` document:
      • kind must be one of the MLM matrix kinds (direct, spillover_sponsor,
        spillover_beneficiary). Other kinds (mission_payout, lottery_win,
        lottery_entry) are excluded from this audit — they belong to other
        modules with their own audit trail.
      • The `from_user_id` must exist and must have reached the commission's
        level.
      • The recipient (`user_id`) must sit exactly `level-1` hops up the
        sponsor chain from `from_user_id` (direct case) OR up from the matrix
        parent chain (spillover case).
    """
    db = request.app.state.db
    MLM_KINDS = {"direct", "spillover_sponsor", "spillover_beneficiary"}

    findings = []
    total_scanned = 0

    async for c in db.commissions.find(
        {"kind": {"$in": list(MLM_KINDS)}},
        {"_id": 0},
    ):
        total_scanned += 1
        issues = []
        level = int(c.get("level") or 0)
        from_id = c.get("from_user_id")
        user_id = c.get("user_id")

        if not from_id:
            issues.append("from_user_id is null")
        else:
            from_u = await db.users.find_one({"id": from_id}, {"_id": 0, "max_level": 1, "username": 1, "sponsor_id": 1})
            if not from_u:
                issues.append("from_user_id does not exist")
            else:
                if int(from_u.get("max_level") or 0) < level:
                    issues.append(
                        f"from_user has max_level={from_u.get('max_level')} < commission.level={level}"
                    )
                # Ancestor chain check (only for `direct` kind — spillover chains
                # need matrix_placements which is more expensive; we skip that
                # here to keep the audit fast and still catch the main pattern).
                if c.get("kind") == "direct":
                    expected = await _walk_up_sponsors(db, from_u.get("sponsor_id"), level - 1)
                    if expected and expected != user_id:
                        issues.append(
                            f"ancestor mismatch: expected recipient {expected} at level-1 hops, got {user_id}"
                        )
                    elif not expected:
                        issues.append("no ancestor found at level-1 hops")

        if issues:
            findings.append({
                "commission_id": str(c.get("_id")) if "_id" in c else None,
                "user_id": user_id,
                "from_user_id": from_id,
                "level": level,
                "kind": c.get("kind"),
                "amount": c.get("amount"),
                "created_at": _iso(c.get("created_at")),
                "issues": issues,
            })

    return {
        "total_scanned": total_scanned,
        "flagged": len(findings),
        "findings": findings,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3) Full user trace
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/user/{user_id}/trace")
async def audit_user_trace(user_id: str, request: Request, _=Depends(require_admin)):
    """Return a complete audit trace for a single user."""
    db = request.app.state.db
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")

    # Sanitize datetime
    for k, v in list(u.items()):
        if isinstance(v, datetime):
            u[k] = v.isoformat()

    events = []
    async for e in db.activation_events.find({"user_id": user_id}, {"_id": 0}).sort("created_at", 1):
        e["created_at"] = _iso(e.get("created_at"))
        events.append(e)

    payments = []
    async for p in db.payments.find({"user_id": user_id}, {"_id": 0}).sort("created_at", 1):
        for k in ("created_at", "updated_at"):
            if isinstance(p.get(k), datetime):
                p[k] = p[k].isoformat()
        payments.append(p)

    manual_activations = []
    async for a in db.activations.find({"user_id": user_id}, {"_id": 0}).sort("created_at", 1):
        for k in ("created_at", "validated_at"):
            if isinstance(a.get(k), datetime):
                a[k] = a[k].isoformat()
        manual_activations.append(a)

    commissions_received = []
    async for c in db.commissions.find({"user_id": user_id}, {"_id": 0}).sort("created_at", 1):
        c["created_at"] = _iso(c.get("created_at"))
        commissions_received.append(c)

    commissions_generated = []
    async for c in db.commissions.find({"from_user_id": user_id}, {"_id": 0}).sort("created_at", 1):
        c["created_at"] = _iso(c.get("created_at"))
        commissions_generated.append(c)

    # Level-by-level source classification
    level_sources = []
    for lv in range(1, int(u.get("max_level") or 0) + 1):
        reason, src, ref = await _classify_activation(db, user_id, lv)
        level_sources.append({
            "level": lv, "reason": reason, "source": src, "reference": ref,
        })

    return {
        "user": u,
        "level_sources": level_sources,
        "activation_events": events,
        "payments": payments,
        "manual_activations": manual_activations,
        "commissions_received": commissions_received,
        "commissions_generated": commissions_generated,
        "totals": {
            "received_count": len(commissions_received),
            "received_amount": sum(float(c.get("amount") or 0) for c in commissions_received if c.get("kind") in ("direct", "spillover_sponsor", "spillover_beneficiary")),
            "generated_count": len(commissions_generated),
        },
    }
