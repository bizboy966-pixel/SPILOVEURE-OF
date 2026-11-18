"""Audit script — commission routing integrity check.

Spec finale (2026-08-27):
  ▸ Level 1 spillover : 50/50 sponsor / parent (placement L1 dit is_spillover=True).
  ▸ Level 1 direct    : 100 % au sponsor direct.
  ▸ Level ≥ 2         : 100 % à l'ancêtre situé exactement `level` sauts
                        au-dessus dans l'arbre `matrix_placements` de niveau 1
                        (chaîne `parent_id`). Le flag spillover est IGNORÉ.

Ce script est READ-ONLY : il n'écrit rien, il compare l'existant à la
règle. Utile pour détecter les commissions historiques mal routées par
l'ancienne logique (pre-fix "spillover à tous les niveaux").

Usage (n'importe quel environnement) :
    MONGO_URL=... DB_NAME=... python3 audit_commissions_mismatch.py
"""
import os
from pymongo import MongoClient

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


def _walk_up_l1(db, user_id, hops):
    """Walk up the level-1 placement tree by `hops` steps. Returns ancestor
    user_id or None if the chain is broken/reaches root."""
    if hops <= 0 or not user_id:
        return user_id
    current = user_id
    for _ in range(hops):
        p = db.matrix_placements.find_one(
            {"user_id": current, "level": 1}, {"_id": 0, "parent_id": 1}
        )
        if not p or not p.get("parent_id"):
            return None
        current = p["parent_id"]
    return current


def main():
    cli = MongoClient(MONGO_URL)
    db = cli[DB_NAME]

    mismatched = []      # commission paid to wrong recipient
    missing = []         # commission that should exist but doesn't
    illegal_split = []   # L2+ commission tagged as spillover_* (invalid per new spec)
    scanned = 0

    # ─────────── Level 1 audit ───────────
    for c in db.commissions.find({"level": 1}):
        scanned += 1
        activator = c.get("from_user_id")
        paid_to = c.get("user_id")
        kind = c.get("kind")
        p = db.matrix_placements.find_one({"user_id": activator, "level": 1})
        if not p:
            mismatched.append({
                "level": 1, "reason": "no L1 placement",
                "commission_id": str(c["_id"]),
                "activator": activator, "paid_to": paid_to,
            })
            continue
        sponsor = p.get("sponsor_id")
        parent = p.get("parent_id")
        is_spill = bool(p.get("is_spillover") and parent and parent != sponsor)
        if is_spill:
            if paid_to not in (sponsor, parent):
                mismatched.append({
                    "level": 1, "reason": "L1 spillover, wrong recipient",
                    "commission_id": str(c["_id"]),
                    "activator": activator, "paid_to": paid_to,
                    "expected_sponsor": sponsor, "expected_parent": parent,
                })
        else:
            if paid_to != sponsor:
                mismatched.append({
                    "level": 1, "reason": "L1 direct, wrong recipient",
                    "commission_id": str(c["_id"]),
                    "activator": activator, "paid_to": paid_to,
                    "expected_sponsor": sponsor,
                })

    # ─────────── Level ≥ 2 audit (new spec: single recipient, L1-tree ancestor) ───────────
    for c in db.commissions.find({"level": {"$gte": 2}}):
        scanned += 1
        activator = c.get("from_user_id")
        level = c.get("level")
        paid_to = c.get("user_id")
        kind = c.get("kind")

        # New spec: no spillover_* kinds allowed at L2+.
        if kind in ("spillover_sponsor", "spillover_beneficiary"):
            illegal_split.append({
                "level": level, "kind": kind,
                "commission_id": str(c["_id"]),
                "activator": activator, "paid_to": paid_to,
                "amount": c.get("amount"),
            })
            continue

        expected = _walk_up_l1(db, activator, level)
        if expected is None:
            # No ancestor at depth N — commission shouldn't have been paid.
            mismatched.append({
                "level": level, "reason": "L1 tree too shallow, commission should not exist",
                "commission_id": str(c["_id"]),
                "activator": activator, "paid_to": paid_to,
                "amount": c.get("amount"),
            })
            continue
        if paid_to != expected:
            mismatched.append({
                "level": level, "reason": "wrong ancestor (not N-hop in L1 tree)",
                "commission_id": str(c["_id"]),
                "activator": activator, "paid_to": paid_to,
                "expected": expected, "amount": c.get("amount"),
            })

    print(f"Scanned {scanned} commissions in DB `{DB_NAME}`.\n")
    print(f"✗ Mis-routed        : {len(mismatched)} line(s) paid to wrong recipient")
    print(f"⚠ Illegal L2+ split : {len(illegal_split)} line(s) tagged spillover_* at L≥2 (new spec forbids)")
    print(f"⁻ Missing           : {len(missing)} share(s) never emitted\n")

    if mismatched:
        print("── Mis-routed (top 30) ──")
        for m in mismatched[:30]:
            print("  ", m)
    if illegal_split:
        print("\n── Illegal L2+ splits (top 30) ──")
        for m in illegal_split[:30]:
            print("  ", m)


if __name__ == "__main__":
    main()
