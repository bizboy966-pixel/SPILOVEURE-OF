"""SPILOVEURE — Read-only platform audit.

Detects (does NOT fix) inconsistencies in:
  1. Level assignments (max_level vs activations vs balances)
  2. Auto-upgrade pending (enough reserve but not upgraded)
  3. Direct commission amounts
  4. Spillover placements / commission pairs
  5. Multi-level: commission level <= recipient.max_level
  6. Upgrade-reserve negative / impossible balances
  7. Dashboard totals (total_earned, commission_direct, commission_spillover)
  8. Team / matrix integrity (orphan parents, multiple roots)
  9. Mission wallets (negative / impossible)
 10. General sanity (users without sponsor, missing fields)

Run:  python3 -m audit            (full report to stdout)
      python3 -m audit --json     (machine-readable JSON)
"""
from __future__ import annotations
import os, sys, json, asyncio
from collections import defaultdict
from motor.motor_asyncio import AsyncIOMotorClient
from levels import LEVELS_BY_NUM


def _u(u: dict) -> str:
    return f"{u.get('username') or '?'} ({u.get('email') or u.get('id')})"


async def audit():
    cli = AsyncIOMotorClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    db = cli[os.environ.get("DB_NAME", "spilivere")]

    issues: dict = defaultdict(list)

    # --- 0) Load everything ---
    users = await db.users.find({}, {"_id": 0}).to_list(100000)
    placements = await db.matrix_placements.find({}, {"_id": 0}).to_list(100000)
    commissions = await db.commissions.find({}, {"_id": 0}).to_list(100000)
    activations = await db.activations.find({}, {"_id": 0}).to_list(100000)
    withdrawals = await db.withdrawals.find({}, {"_id": 0}).to_list(100000)

    users_by_id = {u["id"]: u for u in users}

    stats = {
        "users_total": len(users),
        "users_active": sum(1 for u in users if u.get("status") == "active"),
        "placements_total": len(placements),
        "commissions_total": len(commissions),
        "activations_total": len(activations),
        "withdrawals_total": len(withdrawals),
    }

    # --- 1) Per-user audit ---
    placements_by_user: dict = defaultdict(list)
    for p in placements:
        placements_by_user[p["user_id"]].append(p)

    for u in users:
        uid = u["id"]
        ml = int(u.get("max_level") or 0)
        bal_up = float(u.get("balance_upgrade") or 0)
        bal_pr = float(u.get("balance_profit") or 0)
        sponsor_id = u.get("sponsor_id")
        role = u.get("role", "user")

        # 1a) Bounds
        if ml < 0 or ml > 12:
            issues["levels_out_of_bounds"].append({"user": _u(u), "max_level": ml})

        # 1b) Active but level 0
        if u.get("status") == "active" and ml == 0:
            issues["active_but_level_zero"].append({"user": _u(u)})

        # 1c) Level activated but no matrix placement
        my_placements = placements_by_user.get(uid, [])
        placement_levels = {p["level"] for p in my_placements}
        for lvl in range(1, ml + 1):
            if lvl not in placement_levels:
                issues["missing_placement"].append({"user": _u(u), "level": lvl, "max_level": ml})

        # 1d) Matrix placements above max_level (shouldn't happen)
        for p in my_placements:
            if p["level"] > ml:
                issues["placement_beyond_max"].append({"user": _u(u), "placement_level": p["level"], "max_level": ml})

        # 1e) Negative balances
        if bal_up < 0:
            issues["negative_upgrade_balance"].append({"user": _u(u), "balance": bal_up})
        if bal_pr < 0:
            issues["negative_profit_balance"].append({"user": _u(u), "balance": bal_pr})

        # 1f) Pending auto-upgrade — has enough reserve and matrix slot filled, but not upgraded
        if ml < 12 and role != "admin":
            next_lv = LEVELS_BY_NUM[ml + 1]
            if bal_up >= next_lv["price"]:
                # check current matrix fill
                if ml >= 1:
                    cur_lv = LEVELS_BY_NUM[ml]
                    desc = await _count_descendants(db, uid, ml)
                    if desc >= cur_lv["invites_required"]:
                        issues["pending_auto_upgrade"].append({
                            "user": _u(u), "max_level": ml, "balance_upgrade": bal_up,
                            "next_price": next_lv["price"], "descendants": desc, "needed": cur_lv["invites_required"],
                        })
                # ml == 0 cannot auto-upgrade (needs to manually pay L1)

        # 1g) Sponsor presence
        if role != "admin" and not sponsor_id:
            issues["user_without_sponsor"].append({"user": _u(u)})
        if sponsor_id and sponsor_id not in users_by_id:
            issues["sponsor_orphan"].append({"user": _u(u), "missing_sponsor_id": sponsor_id})

    # --- 2) Commission integrity ---
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
            issues["commission_orphan_recipient"].append({"commission_id": c.get("id"), "user_id": uid, "amount": amt})
            continue
        # Recipient must have been at level >= lvl when received — we can only check current
        if (recipient.get("max_level") or 0) < lvl:
            issues["commission_above_recipient_level"].append({
                "user": _u(recipient), "commission_level": lvl, "current_max_level": recipient.get("max_level") or 0,
                "amount": amt,
            })
        # Amount must match LEVELS_BY_NUM[lvl].commission_per_invite OR half of it (spillover)
        expected = LEVELS_BY_NUM[lvl]["commission_per_invite"]
        if c["kind"] == "direct":
            if amt != expected:
                issues["wrong_direct_amount"].append({"user": _u(recipient), "level": lvl, "got": amt, "expected": expected})
            direct_credit[uid] += amt
        else:
            half = expected // 2
            other = expected - half
            if amt not in (half, other):
                issues["wrong_spillover_amount"].append({"user": _u(recipient), "level": lvl, "got": amt, "expected_each": [half, other]})
            spill_credit[uid] += amt
        # upgrade_share + profit_share == amount
        if (c.get("upgrade_share", 0) + c.get("profit_share", 0)) != amt:
            issues["commission_split_mismatch"].append({"user": _u(recipient), "level": lvl,
                "upgrade": c.get("upgrade_share"), "profit": c.get("profit_share"), "total": amt})
        earned_credit[uid] += amt
        earned_per_level[uid][lvl] += amt

    # 2b) Dashboard counters consistency
    for u in users:
        uid = u["id"]
        cd = float(u.get("commission_direct") or 0)
        cs = float(u.get("commission_spillover") or 0)
        te = float(u.get("total_earned") or 0)
        if abs(cd - direct_credit[uid]) > 0.5:
            issues["commission_direct_counter_mismatch"].append({"user": _u(u), "stored": cd, "computed": direct_credit[uid]})
        if abs(cs - spill_credit[uid]) > 0.5:
            issues["commission_spillover_counter_mismatch"].append({"user": _u(u), "stored": cs, "computed": spill_credit[uid]})
        if abs(te - earned_credit[uid]) > 0.5:
            issues["total_earned_mismatch"].append({"user": _u(u), "stored": te, "computed": earned_credit[uid]})
        # earnings_per_level keys must be strings
        epl = u.get("earnings_per_level") or {}
        for lvl, expected_amt in earned_per_level[uid].items():
            stored = float(epl.get(str(lvl), epl.get(lvl, 0)) or 0)
            if abs(stored - expected_amt) > 0.5:
                issues["earnings_per_level_mismatch"].append({"user": _u(u), "level": lvl, "stored": stored, "computed": expected_amt})

    # --- 3) Matrix integrity ---
    parent_set = {p["user_id"] for p in placements}
    for p in placements:
        if p.get("parent_id") and p["parent_id"] not in users_by_id:
            issues["placement_orphan_parent"].append({"placement": {"user_id": p["user_id"], "level": p["level"], "parent": p["parent_id"]}})
        # each (user_id, level) must be unique
    seen = set()
    for p in placements:
        key = (p["user_id"], p["level"])
        if key in seen:
            issues["duplicate_placement"].append({"user_id": p["user_id"], "level": p["level"]})
        seen.add(key)

    # Multiple roots per level
    roots_by_level = defaultdict(list)
    for p in placements:
        if p.get("parent_id") is None:
            roots_by_level[p["level"]].append(p["user_id"])
    for lvl, roots in roots_by_level.items():
        if len(roots) > 1:
            issues["multiple_matrix_roots"].append({"level": lvl, "roots": [users_by_id.get(r, {}).get("username", r) for r in roots]})

    # --- 4) Activations sanity ---
    paid_acts_by_user_lvl = defaultdict(set)
    for a in activations:
        if a.get("status") == "paid":
            paid_acts_by_user_lvl[a["user_id"]].add(int(a.get("level", 0)))
    # Stuck: activation paid but user max_level < that level
    for uid, levels in paid_acts_by_user_lvl.items():
        u = users_by_id.get(uid)
        if not u:
            continue
        ml = int(u.get("max_level") or 0)
        for lvl in levels:
            if lvl > ml:
                issues["paid_activation_not_applied"].append({"user": _u(u), "activation_level": lvl, "current_max_level": ml})

    # --- 5) Mission wallets ---
    for u in users:
        for t in ["youtube", "tiktok", "instagram", "facebook", "questionnaire"]:
            bal = float(u.get(f"balance_{t}") or 0)
            if bal < 0:
                issues["negative_mission_balance"].append({"user": _u(u), "wallet": t, "balance": bal})

    return {"stats": stats, "issues": dict(issues)}


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


def _print_report(report: dict):
    print("=" * 70)
    print(" SPILOVEURE — Audit Read-Only Report")
    print("=" * 70)
    print("\n📊 STATS")
    for k, v in report["stats"].items():
        print(f"  • {k}: {v}")
    issues = report["issues"]
    if not issues:
        print("\n✅ Aucun problème détecté. La plateforme est cohérente.")
        return
    print(f"\n⚠️  {len(issues)} CATÉGORIES D'ANOMALIES DÉTECTÉES :\n")
    severity = {
        "levels_out_of_bounds": "🔴 CRITIQUE",
        "active_but_level_zero": "🟠 MAJEUR",
        "missing_placement": "🔴 CRITIQUE",
        "placement_beyond_max": "🔴 CRITIQUE",
        "negative_upgrade_balance": "🔴 CRITIQUE",
        "negative_profit_balance": "🔴 CRITIQUE",
        "pending_auto_upgrade": "🟠 MAJEUR",
        "user_without_sponsor": "🟡 MINEUR",
        "sponsor_orphan": "🟠 MAJEUR",
        "commission_orphan_recipient": "🔴 CRITIQUE",
        "commission_above_recipient_level": "🔴 CRITIQUE",
        "wrong_direct_amount": "🟠 MAJEUR",
        "wrong_spillover_amount": "🟠 MAJEUR",
        "commission_split_mismatch": "🟠 MAJEUR",
        "commission_direct_counter_mismatch": "🟠 MAJEUR",
        "commission_spillover_counter_mismatch": "🟠 MAJEUR",
        "total_earned_mismatch": "🟠 MAJEUR",
        "earnings_per_level_mismatch": "🟡 MINEUR",
        "placement_orphan_parent": "🔴 CRITIQUE",
        "duplicate_placement": "🔴 CRITIQUE",
        "multiple_matrix_roots": "🟠 MAJEUR",
        "paid_activation_not_applied": "🔴 CRITIQUE",
        "negative_mission_balance": "🟠 MAJEUR",
    }
    for cat, rows in issues.items():
        tag = severity.get(cat, "🟡 INFO")
        print(f"--- {tag}  {cat} ({len(rows)} cas) ---")
        for r in rows[:20]:
            print(f"  • {r}")
        if len(rows) > 20:
            print(f"  … (+{len(rows) - 20} autres)")
        print()


if __name__ == "__main__":
    rep = asyncio.run(audit())
    if "--json" in sys.argv:
        print(json.dumps(rep, indent=2, default=str))
    else:
        _print_report(rep)
