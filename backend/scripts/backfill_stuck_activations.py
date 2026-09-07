"""Backfill: activate every payment stuck as status=paid, activation_done=false.

Root cause (fixed alongside this script): several activation-payment code
paths read a `level` key that doesn't exist on `payments` docs created via
the generic /api/payments/activate dispatcher (no `extra_row={"level": 1}`
was passed for the AshtecPay branch), raising `KeyError: 'level'` inside a
broad except-and-store-as-`activation_error` handler. The payment stayed
"paid" (money collected) while `activation_done` stayed false.

This script re-runs activation for every affected payment, deriving the
level from the payment doc when present and defaulting to 1 otherwise
(only Level-1 auto-activation exists for these gateways today). Safe to
re-run: `activate_level` is idempotent (no-ops if user.max_level >= level).

Usage:
    MONGO_URL=... DB_NAME=... python3 backfill_stuck_activations.py [--apply]

Without --apply it only reports what it *would* do (dry run).
"""
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from matrix import activate_level  # noqa: E402


async def main():
    apply = "--apply" in sys.argv
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ.get("DB_NAME", "spilivere")]

    cur = db.payments.find({
        "status": {"$in": ["paid", "validated"]},
        "activation_done": {"$ne": True},
    })

    reconciled, activated, failed, orphaned = [], [], [], []
    async for p in cur:
        ref = p["reference"]
        level = int(p.get("level") or 1)
        user = await db.users.find_one({"id": p.get("user_id")}, {"_id": 0, "max_level": 1})
        if user is None:
            orphaned.append(ref)
            print(f"[SKIP] {ref}: user_id={p.get('user_id')} not found (orphaned payment)")
            continue

        if int(user.get("max_level") or 0) >= level:
            print(f"[RECONCILE] {ref}: user already at level {level}, flagging activation_done")
            if apply:
                await db.payments.update_one(
                    {"reference": ref},
                    {"$set": {"activation_done": True, "status": "validated",
                              "updated_at": datetime.now(timezone.utc)},
                     "$unset": {"activation_error": ""}},
                )
            reconciled.append(ref)
            continue

        print(f"[ACTIVATE] {ref}: user_id={p['user_id']} level={level}")
        if not apply:
            activated.append(ref)
            continue
        try:
            await activate_level(db, p["user_id"], level, source="manual_reprocess")
            await db.payments.update_one(
                {"reference": ref},
                {"$set": {"activation_done": True, "status": "validated",
                          "updated_at": datetime.now(timezone.utc)},
                 "$unset": {"activation_error": ""}},
            )
            activated.append(ref)
        except Exception as exc:
            print(f"  -> FAILED: {exc}")
            await db.payments.update_one(
                {"reference": ref},
                {"$set": {"activation_error": str(exc)[:400],
                          "updated_at": datetime.now(timezone.utc)}},
            )
            failed.append((ref, str(exc)))

    print()
    print(f"{'APPLIED' if apply else 'DRY RUN'} — "
          f"reconciled={len(reconciled)} activated={len(activated)} "
          f"failed={len(failed)} orphaned={len(orphaned)}")
    if failed:
        print("Failures:")
        for ref, err in failed:
            print(f"  {ref}: {err}")


if __name__ == "__main__":
    asyncio.run(main())
