"""SPILOVEURE — One-shot upgrade reserve audit & correction.

Purpose: detect users whose `balance_upgrade` is inconsistent with their
actual MLM history (over-credited because past manual upgrades did NOT
debit the reserve — bug fixed 2026-06-14 in matrix.py::activate_level).

Logic:
  For each user U (non-admin, max_level >= 2):
    expected_reserve_in  = sum(commissions.upgrade_share where user_id=U)
    expected_reserve_out = sum(LEVELS_BY_NUM[lvl].price for lvl in 2..max_level)
    expected_balance     = expected_reserve_in - expected_reserve_out
    discrepancy          = current_balance_upgrade - expected_balance

  If discrepancy > 0: user was over-credited (got a free upgrade). The
  retroactive fix is to debit `discrepancy` from balance_upgrade.

  If discrepancy < 0: user was under-credited (impossible given fix code,
  but flagged for review).

  Additionally, detect "stuck" users: balance_upgrade >= next_level.price
  AND matrix conditions met for current level → auto_upgrade should fire.

Two admin-only endpoints expose this:
  GET  /api/admin/upgrade-audit               → JSON report (read-only)
  POST /api/admin/upgrade-audit/apply?dry_run=bool
                                              → applies retroactive debits
                                                and triggers stuck upgrades
"""
from __future__ import annotations
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from auth import require_admin
from levels import LEVELS_BY_NUM
from matrix import try_auto_upgrade

log = logging.getLogger("upgrade_audit")

router = APIRouter(prefix="/api/admin/upgrade-audit", tags=["upgrade-audit"])


def _u(u: dict) -> dict:
    return {
        "id": u.get("id"),
        "username": u.get("username"),
        "email": u.get("email"),
        "max_level": int(u.get("max_level") or 0),
    }


async def _count_descendants(db, root_user_id: str, level: int) -> int:
    """Total descendants in the matrix subtree rooted at user, at given level."""
    count = 0
    queue = [root_user_id]
    visited = set()
    while queue:
        uid = queue.pop(0)
        if uid in visited:
            continue
        visited.add(uid)
        async for child in db.matrix_placements.find(
            {"level": level, "parent_id": uid}, {"_id": 0, "user_id": 1}
        ):
            count += 1
            queue.append(child["user_id"])
    return count


async def _build_report(db) -> dict:
    """Pure read — computes report without writing."""
    users = await db.users.find({}, {"_id": 0}).to_list(100000)
    commissions = await db.commissions.find({}, {"_id": 0}).to_list(500000)

    upgrade_share_per_user: dict = defaultdict(float)
    for c in commissions:
        upgrade_share_per_user[c["user_id"]] += float(c.get("upgrade_share", 0) or 0)

    over_credited = []
    under_credited = []
    stuck_upgrades = []
    healthy = 0

    for u in users:
        if u.get("role") == "admin":
            continue
        uid = u["id"]
        ml = int(u.get("max_level") or 0)
        cur_balance = float(u.get("balance_upgrade") or 0)
        reserve_in = upgrade_share_per_user.get(uid, 0.0)
        reserve_out = sum(LEVELS_BY_NUM[lvl]["price"] for lvl in range(2, ml + 1))
        expected = reserve_in - reserve_out
        discrepancy = cur_balance - expected

        record = {
            **_u(u),
            "balance_upgrade_current": round(cur_balance, 2),
            "balance_upgrade_expected": round(expected, 2),
            "discrepancy": round(discrepancy, 2),
            "reserve_credited_total": round(reserve_in, 2),
            "reserve_consumed_by_levels": round(reserve_out, 2),
        }
        # 1 FCFA tolerance for float arithmetic
        if discrepancy > 1:
            over_credited.append(record)
        elif discrepancy < -1:
            under_credited.append(record)
        else:
            healthy += 1

        # Stuck upgrade detection (only for non-max users)
        if ml < 12 and ml >= 1:
            next_lv = LEVELS_BY_NUM[ml + 1]
            cur_lv = LEVELS_BY_NUM[ml]
            if cur_balance >= next_lv["price"]:
                desc = await _count_descendants(db, uid, ml)
                if desc >= cur_lv["invites_required"]:
                    stuck_upgrades.append({
                        **_u(u),
                        "current_level": ml,
                        "next_level": ml + 1,
                        "balance_upgrade": round(cur_balance, 2),
                        "next_price": next_lv["price"],
                        "descendants_current_level": desc,
                        "required_descendants": cur_lv["invites_required"],
                    })

    total_over = sum(r["discrepancy"] for r in over_credited)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "users_audited": len([u for u in users if u.get("role") != "admin"]),
            "healthy": healthy,
            "over_credited_count": len(over_credited),
            "over_credited_total_fcfa": round(total_over, 2),
            "under_credited_count": len(under_credited),
            "stuck_upgrades_count": len(stuck_upgrades),
        },
        "over_credited": sorted(over_credited, key=lambda r: -r["discrepancy"]),
        "under_credited": under_credited,
        "stuck_upgrades": stuck_upgrades,
        "methodology": {
            "formula": "expected_balance_upgrade = sum(commissions.upgrade_share) - sum(prices_of_activated_levels[2..max_level])",
            "tolerance_fcfa": 1,
            "rationale": (
                "Before 2026-06-14 fix, manual user-initiated upgrades did NOT "
                "debit balance_upgrade (only auto_upgrade did). Users who upgraded "
                "manually accumulated unconsumed reserve. The discrepancy is the "
                "exact amount that should have been debited."
            ),
        },
    }


@router.get("")
async def get_upgrade_audit(request: Request, _=Depends(require_admin)):
    """Read-only audit report. Safe to call any number of times."""
    return await _build_report(request.app.state.db)


@router.post("/apply")
async def apply_upgrade_audit(
    request: Request,
    dry_run: bool = Query(True, description="If true, returns plan without writing."),
    fix_over_credited: bool = Query(True, description="Retro-debit over-credited reserves."),
    trigger_stuck: bool = Query(True, description="Run try_auto_upgrade for stuck users."),
    _=Depends(require_admin),
):
    """Apply corrections. Defaults to dry_run=true for safety.

    SAFE: never deletes data, never touches balance_profit/commission counters.
    Each correction is logged in a new collection `upgrade_audit_log`.
    """
    db = request.app.state.db
    report = await _build_report(db)
    plan = {
        "dry_run": dry_run,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "retroactive_debits": [],
        "triggered_upgrades": [],
        "errors": [],
    }

    # 1) Retro-debit over-credited users
    if fix_over_credited:
        for rec in report["over_credited"]:
            uid = rec["id"]
            amount = float(rec["discrepancy"])
            # Atomic conditional: only debit if balance still >= amount
            entry = {
                "user_id": uid,
                "username": rec["username"],
                "action": "retro_debit_balance_upgrade",
                "amount": amount,
                "before": rec["balance_upgrade_current"],
                "expected_after": round(rec["balance_upgrade_expected"], 2),
                "reason": "over_credited_due_to_manual_upgrade_no_debit_bug",
            }
            if not dry_run:
                r = await db.users.update_one(
                    {"id": uid, "balance_upgrade": {"$gte": amount}},
                    {"$inc": {"balance_upgrade": -amount}},
                )
                if r.modified_count == 0:
                    entry["status"] = "skipped"
                    entry["error"] = "balance_upgrade < discrepancy at apply time"
                    plan["errors"].append(entry)
                    continue
                entry["status"] = "applied"
                entry["applied_at"] = datetime.now(timezone.utc).isoformat()
                await db.upgrade_audit_log.insert_one({**entry})
            else:
                entry["status"] = "planned"
            plan["retroactive_debits"].append(entry)

    # 2) Trigger stuck upgrades (after debit, balances are now correct)
    if trigger_stuck and not dry_run:
        for rec in report["stuck_upgrades"]:
            uid = rec["id"]
            from_lv = rec["current_level"]
            applied_levels = []
            try:
                # Cascade: try_auto_upgrade runs one level at a time
                for _ in range(12):
                    lv = await try_auto_upgrade(db, uid)
                    if not lv:
                        break
                    applied_levels.append(lv)
            except Exception as exc:
                plan["errors"].append({
                    "user_id": uid, "username": rec["username"],
                    "action": "trigger_stuck_upgrade",
                    "error": str(exc),
                })
                continue
            if applied_levels:
                entry = {
                    "user_id": uid,
                    "username": rec["username"],
                    "action": "trigger_stuck_upgrade",
                    "from_level": from_lv,
                    "applied_levels": applied_levels,
                    "applied_at": datetime.now(timezone.utc).isoformat(),
                }
                await db.upgrade_audit_log.insert_one(entry)
                plan["triggered_upgrades"].append(entry)
    elif trigger_stuck and dry_run:
        for rec in report["stuck_upgrades"]:
            plan["triggered_upgrades"].append({
                "user_id": rec["id"],
                "username": rec["username"],
                "action": "trigger_stuck_upgrade",
                "from_level": rec["current_level"],
                "status": "planned",
            })

    plan["summary"] = {
        "retroactive_debits": len(plan["retroactive_debits"]),
        "triggered_upgrades": len(plan["triggered_upgrades"]),
        "errors": len(plan["errors"]),
        "total_debit_amount_fcfa": round(sum(r.get("amount", 0) for r in plan["retroactive_debits"]), 2),
    }
    return plan


@router.get("/log")
async def get_audit_log(request: Request, limit: int = 200, _=Depends(require_admin)):
    """Return the audit log entries (corrections applied historically)."""
    db = request.app.state.db
    items = await db.upgrade_audit_log.find({}, {"_id": 0}).sort("applied_at", -1).to_list(limit)
    return {"items": items, "count": len(items)}
