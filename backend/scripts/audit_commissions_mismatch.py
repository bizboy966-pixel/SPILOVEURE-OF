"""Audit script — commissions mis-routed by the pre-2026-08-20 bug.

Usage (on ANY environment, preview or prod):
    MONGO_URL=... DB_NAME=... python3 audit_commissions_mismatch.py

For every commission at level ≥ 2, compares the actual recipient against
what the `matrix_placements` record for (activator, level=N) says should
have been paid. Prints two lists:

  ✗ Mis-routed  — a commission line paid to someone NOT in the placement
                  (wrong beneficiary).
  ⁻ Missing     — a spillover split share that was NEVER emitted
                  (typically the spillover_beneficiary share dropped by
                  the pre-fix "L1-only spillover" logic).

Read-only: does NOT modify any data. Use the output to decide whether to
retro-correct the affected users (manual admin operation).
"""
import os
from pymongo import MongoClient

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


def main():
    cli = MongoClient(MONGO_URL)
    db = cli[DB_NAME]

    mismatched = []
    missing_split = []
    scanned = 0

    for c in db.commissions.find({"level": {"$gte": 2}}):
        scanned += 1
        activator = c.get("from_user_id")
        level = c.get("level")
        paid_to = c.get("user_id")
        p = db.matrix_placements.find_one({"user_id": activator, "level": level})
        if not p:
            mismatched.append({
                "reason": "no placement record",
                "commission_id": str(c["_id"]),
                "activator": activator, "level": level, "paid_to": paid_to,
                "amount": c.get("amount"),
            })
            continue
        expected_sponsor = p.get("sponsor_id")
        expected_parent = p.get("parent_id")
        is_spill = bool(
            p.get("is_spillover")
            and expected_parent
            and expected_parent != expected_sponsor
        )
        if is_spill:
            siblings = list(db.commissions.find({"from_user_id": activator, "level": level}))
            got = {s.get("user_id") for s in siblings}
            if expected_sponsor not in got:
                missing_split.append({
                    "activator": activator, "level": level,
                    "missing": "spillover_sponsor share",
                    "expected_recipient": expected_sponsor,
                })
            if expected_parent not in got:
                missing_split.append({
                    "activator": activator, "level": level,
                    "missing": "spillover_beneficiary share",
                    "expected_recipient": expected_parent,
                })
            if paid_to not in (expected_sponsor, expected_parent):
                mismatched.append({
                    "reason": "spillover, wrong recipient",
                    "commission_id": str(c["_id"]),
                    "activator": activator, "level": level, "paid_to": paid_to,
                    "expected_sponsor": expected_sponsor,
                    "expected_parent": expected_parent,
                    "amount": c.get("amount"),
                })
        else:
            if paid_to != expected_sponsor:
                mismatched.append({
                    "reason": "non-spillover, wrong recipient",
                    "commission_id": str(c["_id"]),
                    "activator": activator, "level": level, "paid_to": paid_to,
                    "expected_sponsor": expected_sponsor,
                    "amount": c.get("amount"),
                })

    print(f"Scanned {scanned} L≥2 commissions in DB `{DB_NAME}`.\n")
    print(f"✗ Mis-routed         : {len(mismatched)} commission line(s) paid to the wrong recipient")
    print(f"⁻ Missing split share : {len(missing_split)} share(s) never emitted\n")

    if mismatched:
        print("── Mis-routed (top 30) ──")
        for m in mismatched[:30]:
            print("  ", m)
    if missing_split:
        print("\n── Missing shares (top 30) ──")
        for m in missing_split[:30]:
            print("  ", m)

if __name__ == "__main__":
    main()
