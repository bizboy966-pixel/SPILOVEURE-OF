"""Regression — 2026-03-04 (v27af) : status terminal synchrone BTP + reconcile.

Cause visuelle (screenshot user) :
  Retrait BTP avec `Statut passerelle: completed` mais notre `status: pending`
  → toujours dans "En attente" alors que BTP a déjà payé.

Fix v27af :
  1. dispatch_biztranspay_withdrawal — si la réponse sync /payouts contient
     un status terminal (completed/succeeded/paid/...), on flip DIRECTEMENT
     status="completed" + completed_at. Idem pour rejet immédiat (+refund).
  2. Nouvelle fonction `reconcile_withdrawal(db, wd)` — poll BTP GET /payouts/{id}
     et met à jour le statut (safe, idempotent).
  3. Nouvel endpoint POST /api/admin/withdrawals/{id}/reconcile — force poll
     depuis l'admin panel pour un retrait bloqué.
  4. Nouvel endpoint POST /api/admin/withdrawals/reconcile-all — sweep global.
"""
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import asyncio
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BTP = Path(__file__).resolve().parents[1] / "biztranspay.py"
SERVER = Path(__file__).resolve().parents[1] / "server.py"


def test_dispatch_maps_terminal_sync_status_to_completed():
    src = BTP.read_text()
    m = re.search(r"_TERMINAL_OK\s*=\s*\{([^}]+)\}", src)
    assert m, "_TERMINAL_OK set not found"
    for s in ("completed", "succeeded", "paid", "success"):
        assert f'"{s}"' in m.group(1), f"terminal OK missing '{s}'"
    m2 = re.search(r"_TERMINAL_KO\s*=\s*\{([^}]+)\}", src)
    assert m2
    for s in ("failed", "declined", "canceled", "expired", "rejected"):
        assert f'"{s}"' in m2.group(1), f"terminal KO missing '{s}'"
    # The dispatcher must derive internal_status from payout_status.
    assert 'if payout_status in _TERMINAL_OK:' in src
    assert 'internal_status = "completed"' in src
    assert 'internal_status = "rejected"' in src


def test_reconcile_functions_exist():
    import biztranspay
    assert callable(getattr(biztranspay, "reconcile_withdrawal", None))
    assert callable(getattr(biztranspay, "reconcile_all_dispatched", None))


def test_admin_reconcile_route_registered():
    src = SERVER.read_text()
    assert '@admin_router.post("/withdrawals/{wd_id}/reconcile")' in src
    assert '@admin_router.post("/withdrawals/reconcile-all")' in src


def test_dispatch_success_refunds_on_sync_rejection():
    """When BTP returns a terminal-fail status synchronously, the user
    balance must be refunded (symmetric to webhook)."""
    src = BTP.read_text()
    m = re.search(
        r"if internal_status == \"rejected\":\s*try:\s*await db\.users\.update_one\(\s*"
        r"\{\"id\":\s*wd_doc\[\"user_id\"\]\},\s*\{\"\$inc\":\s*\{\"balance_profit\":",
        src, re.S,
    )
    assert m, "sync rejection refund logic missing from dispatcher"


def test_reconcile_updates_status_and_refunds_on_terminal_fail():
    import biztranspay
    db = MagicMock()
    db.withdrawals.update_one = AsyncMock()
    db.users.update_one = AsyncMock()

    # Fake httpx GET returning `{status: "failed"}`
    async def fake_get(path, sk, pk):
        r = MagicMock()
        r.status_code = 200
        r.json = lambda: {"status": "failed"}
        return r

    biztranspay._get = fake_get
    biztranspay._get_secret_key = AsyncMock(return_value="sk_test_x")
    biztranspay._get_public_key = AsyncMock(return_value="pk_test_x")

    wd = {"id": "WD-1", "user_id": "U-1", "payout_id": "pay_xxx",
          "status": "pending", "amount": 5000}
    r = asyncio.get_event_loop().run_until_complete(
        biztranspay.reconcile_withdrawal(db, wd)
    )
    assert r["ok"] is True
    assert r["changed"] is True
    assert r["to_status"] == "rejected"
    # Refund must have been triggered.
    db.users.update_one.assert_awaited_once()
    args = db.users.update_one.await_args
    assert args.args[0] == {"id": "U-1"}
    assert args.args[1]["$inc"]["balance_profit"] == 5000
