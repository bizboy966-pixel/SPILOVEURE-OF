"""SPILOVEURE — Audit & Recompute admin endpoints.

Provides a safe, idempotent way to detect AND fix MLM data inconsistencies
without direct DB access. All write operations support `dry_run=true` to
preview changes before applying.

Endpoints (all under `/api/admin/audit`):
  GET  /                            → full read-only report (stats + issues)
  GET  /user/{username}             → deep audit for a single user (by username)
  POST /recompute?dry_run=bool      → recompute counters from commissions,
                                       clean orphan placements, trigger
                                       pending auto-upgrades. Returns the
                                       list of changes that were (or would
                                       be) applied.
"""
from __future__ import annotations
import logging
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Query

from auth import require_admin
from levels import LEVELS_BY_NUM
from matrix import try_auto_upgrade

log = logging.getLogger("audit")

router = APIRouter(prefix="/api/admin/audit", tags=["audit"])


def _u(u: dict) -> dict:
    return {
        "id": u.get("id"),
        "username": u.get("username"),
        "email": u.get("email"),
        "max_level": u.get("max_level"),
        "status": u.get("status"),
        "role": u.get("role"),
    }


async def _count_descendants(db, root_user_id: str, level: int) -> int:
    count = 0
    queue = [root_user_id]
    visited = set()
    while queue:
        u = queue.pop(0)
        if u in visited:
            continue
        visited.add(u)
        children = await db.matrix_placements.find(
            {"level": level, "parent_id": u}, {"_id": 0, "user_id": 1}
        ).to_list(2000)
        for c in children:
            count += 1
            queue.append(c["user_id"])
    return count


async def _run_audit(db) -> dict:
    """Pure read — never writes."""
    users = await db.users.find({}, {"_id": 0}).to_list(100000)
    placements = await db.matrix_placements.find({}, {"_id": 0}).to_list(100000)
    commissions = await db.commissions.find({}, {"_id": 0}).to_list(100000)
    activations = await db.activations.find({}, {"_id": 0}).to_list(100000)

    users_by_id = {u["id"]: u for u in users}
    placements_by_user: dict = defaultdict(list)
    for p in placements:
        placements_by_user[p["user_id"]].append(p)

    issues: dict = defaultdict(list)

    for u in users:
        uid = u["id"]
        ml = int(u.get("max_level") or 0)
        bal_up = float(u.get("balance_upgrade") or 0)
        bal_pr = float(u.get("balance_profit") or 0)
        sponsor_id = u.get("sponsor_id")
        role = u.get("role", "user")

        if ml < 0 or ml > 12:
            issues["levels_out_of_bounds"].append({**_u(u), "max_level": ml})
        if u.get("status") == "active" and ml == 0:
            issues["active_but_level_zero"].append(_u(u))

        my_placements = placements_by_user.get(uid, [])
        placement_levels = {p["level"] for p in my_placements}
        for lvl in range(1, ml + 1):
            if lvl not in placement_levels:
                issues["missing_placement"].append({**_u(u), "level_missing": lvl})
        for p in my_placements:
            if p["level"] > ml:
                issues["placement_beyond_max"].append({**_u(u), "placement_level": p["level"]})

        if bal_up < 0:
            issues["negative_upgrade_balance"].append({**_u(u), "balance": bal_up})
        if bal_pr < 0:
            issues["negative_profit_balance"].append({**_u(u), "balance": bal_pr})

        if ml < 12 and role != "admin":
            next_lv = LEVELS_BY_NUM[ml + 1]
            if bal_up >= next_lv["price"]:
                if ml >= 1:
                    cur_lv = LEVELS_BY_NUM[ml]
                    desc = await _count_descendants(db, uid, ml)
                    if desc >= cur_lv["invites_required"]:
                        issues["pending_auto_upgrade"].append({
                            **_u(u), "max_level": ml, "balance_upgrade": bal_up,
                            "next_price": next_lv["price"], "descendants": desc,
                            "needed": cur_lv["invites_required"],
                        })

        if role != "admin" and not sponsor_id:
            issues["user_without_sponsor"].append(_u(u))
        if sponsor_id and sponsor_id not in users_by_id:
            issues["sponsor_orphan"].append({**_u(u), "missing_sponsor_id": sponsor_id})

    direct_credit = defaultdict(float)
    spill_credit = defaultdict(float)
    earned_credit = defaultdict(float)
    earned_per_level = defaultdict(lambda: defaultdict(float))

    for c in commissions:
        uid = c["user_id"]
        lvl = int(c["level"])
        amt = float(c["amount"])
        recipient = users_by_id.get(uid)
        if not recipient:
            issues["commission_orphan_recipient"].append({"user_id": uid, "amount": amt, "level": lvl})
            continue
        if (recipient.get("max_level") or 0) < lvl:
            issues["commission_above_recipient_level"].append({
                **_u(recipient), "commission_level": lvl, "amount": amt,
            })
        expected = LEVELS_BY_NUM[lvl]["commission_per_invite"]
        if c["kind"] == "direct":
            if amt != expected:
                issues["wrong_direct_amount"].append({**_u(recipient), "level": lvl, "got": amt, "expected": expected})
            direct_credit[uid] += amt
        else:
            half = expected // 2
            other = expected - half
            if amt not in (half, other):
                issues["wrong_spillover_amount"].append({**_u(recipient), "level": lvl, "got": amt, "expected_each": [half, other]})
            spill_credit[uid] += amt
        if (c.get("upgrade_share", 0) + c.get("profit_share", 0)) != amt:
            issues["commission_split_mismatch"].append({
                **_u(recipient), "level": lvl, "upgrade": c.get("upgrade_share"),
                "profit": c.get("profit_share"), "total": amt,
            })
        earned_credit[uid] += amt
        earned_per_level[uid][lvl] += amt

    for u in users:
        uid = u["id"]
        cd = float(u.get("commission_direct") or 0)
        cs = float(u.get("commission_spillover") or 0)
        te = float(u.get("total_earned") or 0)
        if abs(cd - direct_credit[uid]) > 0.5:
            issues["commission_direct_counter_mismatch"].append({**_u(u), "stored": cd, "computed": direct_credit[uid]})
        if abs(cs - spill_credit[uid]) > 0.5:
            issues["commission_spillover_counter_mismatch"].append({**_u(u), "stored": cs, "computed": spill_credit[uid]})
        if abs(te - earned_credit[uid]) > 0.5:
            issues["total_earned_mismatch"].append({**_u(u), "stored": te, "computed": earned_credit[uid]})
        epl = u.get("earnings_per_level") or {}
        for lvl, expected_amt in earned_per_level[uid].items():
            stored = float(epl.get(str(lvl), epl.get(lvl, 0)) or 0)
            if abs(stored - expected_amt) > 0.5:
                issues["earnings_per_level_mismatch"].append({**_u(u), "level": lvl, "stored": stored, "computed": expected_amt})

    for p in placements:
        if p.get("parent_id") and p["parent_id"] not in users_by_id:
            issues["placement_orphan_parent"].append({"placement_user_id": p["user_id"], "level": p["level"], "parent": p["parent_id"]})

    seen = set()
    for p in placements:
        key = (p["user_id"], p["level"])
        if key in seen:
            issues["duplicate_placement"].append({"user_id": p["user_id"], "level": p["level"]})
        seen.add(key)

    roots_by_level: dict = defaultdict(list)
    for p in placements:
        if p.get("parent_id") is None:
            roots_by_level[p["level"]].append(p["user_id"])
    for lvl, roots in roots_by_level.items():
        if len(roots) > 1:
            issues["multiple_matrix_roots"].append({
                "level": lvl,
                "roots": [users_by_id.get(r, {}).get("username") or r for r in roots],
            })

    paid_acts_by_user_lvl: dict = defaultdict(set)
    for a in activations:
        if a.get("status") == "paid":
            paid_acts_by_user_lvl[a["user_id"]].add(int(a.get("level", 0)))
    for uid, levels in paid_acts_by_user_lvl.items():
        u = users_by_id.get(uid)
        if not u:
            continue
        ml = int(u.get("max_level") or 0)
        for lvl in levels:
            if lvl > ml:
                issues["paid_activation_not_applied"].append({**_u(u), "activation_level": lvl})

    for u in users:
        for t in ["youtube", "tiktok", "instagram", "facebook", "questionnaire"]:
            bal = float(u.get(f"balance_{t}") or 0)
            if bal < 0:
                issues["negative_mission_balance"].append({**_u(u), "wallet": t, "balance": bal})

    summary = {cat: len(rows) for cat, rows in issues.items()}
    severity_map = {
        "🔴": ["levels_out_of_bounds", "missing_placement", "placement_beyond_max",
               "negative_upgrade_balance", "negative_profit_balance",
               "commission_orphan_recipient", "commission_above_recipient_level",
               "placement_orphan_parent", "duplicate_placement",
               "paid_activation_not_applied"],
        "🟠": ["active_but_level_zero", "pending_auto_upgrade", "sponsor_orphan",
               "wrong_direct_amount", "wrong_spillover_amount", "commission_split_mismatch",
               "commission_direct_counter_mismatch", "commission_spillover_counter_mismatch",
               "total_earned_mismatch", "multiple_matrix_roots", "negative_mission_balance"],
        "🟡": ["user_without_sponsor", "earnings_per_level_mismatch"],
    }
    severity = {}
    for sev, cats in severity_map.items():
        for c in cats:
            severity[c] = sev

    stats = {
        "users_total": len(users),
        "users_active": sum(1 for u in users if u.get("status") == "active"),
        "users_by_level": {str(lvl): sum(1 for u in users if int(u.get("max_level") or 0) == lvl) for lvl in range(0, 13)},
        "placements_total": len(placements),
        "commissions_total": len(commissions),
        "activations_total": len(activations),
        "issues_total": sum(summary.values()),
    }

    return {"stats": stats, "summary": summary, "severity": severity, "issues": dict(issues)}


@router.get("")
async def audit_report(request: Request, _=Depends(require_admin)):
    return await _run_audit(request.app.state.db)


@router.get("/user/{username}")
async def audit_user(username: str, request: Request, _=Depends(require_admin)):
    """Deep audit for a specific user (search by username, case-insensitive)."""
    db = request.app.state.db
    user = await db.users.find_one(
        {"username": {"$regex": f"^{username}$", "$options": "i"}}, {"_id": 0, "password_hash": 0}
    )
    if not user:
        # try fuzzy
        user = await db.users.find_one(
            {"username": {"$regex": username, "$options": "i"}}, {"_id": 0, "password_hash": 0}
        )
    if not user:
        raise HTTPException(404, f"Utilisateur introuvable: {username}")

    uid = user["id"]
    ml = int(user.get("max_level") or 0)

    # Direct downline
    directs = await db.users.find({"sponsor_id": uid}, {"_id": 0, "username": 1, "email": 1, "max_level": 1, "status": 1}).to_list(2000)

    # Placements + descendants per level
    my_placements = await db.matrix_placements.find({"user_id": uid}, {"_id": 0}).to_list(20)
    descendants_per_level = {}
    for lvl in range(1, ml + 1):
        descendants_per_level[lvl] = await _count_descendants(db, uid, lvl)

    # Commissions received
    my_commissions = await db.commissions.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(500)
    received_per_level: dict = defaultdict(lambda: {"count": 0, "amount": 0.0})
    for c in my_commissions:
        received_per_level[int(c["level"])]["count"] += 1
        received_per_level[int(c["level"])]["amount"] += float(c["amount"])
    received_per_level = {str(k): v for k, v in received_per_level.items()}

    # Pending upgrade analysis
    pending_upgrade = None
    if ml < 12:
        next_lv = LEVELS_BY_NUM[ml + 1]
        cur_lv = LEVELS_BY_NUM[ml] if ml >= 1 else None
        bal_up = float(user.get("balance_upgrade") or 0)
        desc_cur = descendants_per_level.get(ml, 0)
        pending_upgrade = {
            "next_level": ml + 1,
            "next_price": next_lv["price"],
            "balance_upgrade": bal_up,
            "has_enough_reserve": bal_up >= next_lv["price"],
            "current_descendants": desc_cur,
            "required_descendants": cur_lv["invites_required"] if cur_lv else None,
            "matrix_ready": (cur_lv is None) or (desc_cur >= cur_lv["invites_required"]),
        }
        pending_upgrade["can_upgrade_now"] = (
            pending_upgrade["has_enough_reserve"] and pending_upgrade["matrix_ready"] and user.get("role") != "admin"
        )

    sponsor = None
    if user.get("sponsor_id"):
        sp = await db.users.find_one({"id": user["sponsor_id"]}, {"_id": 0, "username": 1, "email": 1})
        sponsor = sp

    return {
        "user": user,
        "sponsor": sponsor,
        "direct_downline_count": len(directs),
        "direct_downline": directs[:50],
        "placements": my_placements,
        "descendants_per_level": descendants_per_level,
        "commissions_received_per_level": received_per_level,
        "commissions_received_total": sum(float(c["amount"]) for c in my_commissions),
        "pending_upgrade": pending_upgrade,
        "recent_commissions": my_commissions[:20],
    }


@router.post("/recompute")
async def recompute(
    request: Request,
    dry_run: bool = Query(True, description="If true, returns planned changes without writing."),
    clean_orphan_placements: bool = Query(True),
    trigger_pending_upgrades: bool = Query(True),
    restore_admin_placements: bool = Query(True, description="Create missing root placements for admin (1..max_level)."),
    _=Depends(require_admin),
):
    """Recompute counters from commissions; optionally clean orphans + trigger pending upgrades.

    SAFE operations only — NEVER touches `balance_profit` or `balance_upgrade`
    directly (those are influenced by withdrawals/payments that are out of scope).

    Operations:
      1. Recompute per-user counters: commission_direct, commission_spillover,
         total_earned, earnings_per_level — from the `commissions` collection.
      2. Delete placements whose parent_id points to a non-existing user.
      3. For each user with enough reserve and required descendants, call
         `try_auto_upgrade` (cascaded up to 12 times per user).
      4. Restore missing root matrix placements for the ADMIN user (1..max_level)
         — safe, only applies to role=='admin' (admin is the matrix root).
    """
    db = request.app.state.db
    from datetime import datetime, timezone as _tz
    plan: dict = {"counter_updates": [], "orphan_placements_deleted": [], "upgrades_triggered": [], "admin_placements_restored": []}

    # --- 1) Recompute counters ---
    users = await db.users.find({}, {"_id": 0}).to_list(100000)
    commissions = await db.commissions.find({}, {"_id": 0}).to_list(100000)
    direct_credit: dict = defaultdict(float)
    spill_credit: dict = defaultdict(float)
    earned_credit: dict = defaultdict(float)
    earned_per_level: dict = defaultdict(lambda: defaultdict(float))
    for c in commissions:
        uid = c["user_id"]
        amt = float(c["amount"])
        lvl = int(c["level"])
        if c["kind"] == "direct":
            direct_credit[uid] += amt
        else:
            spill_credit[uid] += amt
        earned_credit[uid] += amt
        earned_per_level[uid][lvl] += amt

    for u in users:
        uid = u["id"]
        cd = float(u.get("commission_direct") or 0)
        cs = float(u.get("commission_spillover") or 0)
        te = float(u.get("total_earned") or 0)
        cd_new = direct_credit[uid]
        cs_new = spill_credit[uid]
        te_new = earned_credit[uid]
        epl_stored = {str(k): float(v) for k, v in (u.get("earnings_per_level") or {}).items()}
        epl_new = {str(k): float(v) for k, v in earned_per_level[uid].items()}
        changed = (
            abs(cd - cd_new) > 0.5 or abs(cs - cs_new) > 0.5 or abs(te - te_new) > 0.5
            or epl_stored != epl_new
        )
        if not changed:
            continue
        plan["counter_updates"].append({
            "user": _u(u),
            "before": {"commission_direct": cd, "commission_spillover": cs, "total_earned": te, "earnings_per_level": epl_stored},
            "after":  {"commission_direct": cd_new, "commission_spillover": cs_new, "total_earned": te_new, "earnings_per_level": epl_new},
        })
        if not dry_run:
            await db.users.update_one(
                {"id": uid},
                {"$set": {
                    "commission_direct": cd_new,
                    "commission_spillover": cs_new,
                    "total_earned": te_new,
                    "earnings_per_level": epl_new,
                }},
            )

    # --- 2) Clean orphan placements ---
    if clean_orphan_placements:
        user_ids = {u["id"] for u in users}
        placements = await db.matrix_placements.find({}, {"_id": 0}).to_list(100000)
        for p in placements:
            if p.get("parent_id") and p["parent_id"] not in user_ids:
                plan["orphan_placements_deleted"].append({
                    "placement_user_id": p["user_id"],
                    "level": p["level"],
                    "orphan_parent_id": p["parent_id"],
                })
                if not dry_run:
                    await db.matrix_placements.delete_one(
                        {"user_id": p["user_id"], "level": p["level"]}
                    )

    # --- 3) Trigger pending auto-upgrades ---
    if trigger_pending_upgrades and not dry_run:
        # Re-read users (counters may have changed)
        users2 = await db.users.find({}, {"_id": 0}).to_list(100000)
        for u in users2:
            if u.get("role") == "admin":
                continue
            uid = u["id"]
            ml = int(u.get("max_level") or 0)
            if ml < 1 or ml >= 12:
                continue
            bal_up = float(u.get("balance_upgrade") or 0)
            next_lv = LEVELS_BY_NUM[ml + 1]
            if bal_up < next_lv["price"]:
                continue
            cur_lv = LEVELS_BY_NUM[ml]
            desc = await _count_descendants(db, uid, ml)
            if desc < cur_lv["invites_required"]:
                continue
            # cascade
            upgraded_levels = []
            for _ in range(12):
                up = await try_auto_upgrade(db, uid)
                if not up:
                    break
                upgraded_levels.append(up)
            if upgraded_levels:
                plan["upgrades_triggered"].append({
                    "user": _u(u), "from_level": ml, "to_levels": upgraded_levels,
                })

    # --- 4) Restore missing admin root placements ---
    if restore_admin_placements:
        admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
        if admin:
            admin_id = admin["id"]
            admin_ml = int(admin.get("max_level") or 0)
            existing_levels = set()
            async for p in db.matrix_placements.find({"user_id": admin_id}, {"_id": 0, "level": 1}):
                existing_levels.add(int(p["level"]))
            for lvl in range(1, admin_ml + 1):
                if lvl in existing_levels:
                    continue
                plan["admin_placements_restored"].append({
                    "user": _u(admin), "level": lvl,
                })
                if not dry_run:
                    from datetime import datetime, timezone as _tz
                    await db.matrix_placements.insert_one({
                        "user_id": admin_id, "level": lvl,
                        "parent_id": None, "leg": None,
                        "sponsor_id": None, "is_spillover": False,
                        "created_at": datetime.now(_tz.utc),
                    })

    plan["dry_run"] = dry_run
    plan["totals"] = {
        "counter_updates": len(plan["counter_updates"]),
        "orphan_placements_deleted": len(plan["orphan_placements_deleted"]),
        "upgrades_triggered": len(plan["upgrades_triggered"]),
        "admin_placements_restored": len(plan["admin_placements_restored"]),
    }
    return plan


async def _restore_admin_placements_unused():
    pass
