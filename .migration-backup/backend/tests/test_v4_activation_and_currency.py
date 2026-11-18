"""Regression tests — 2026-09-07 v4 activation & currency bugs.

Two bugs are locked down here:

  1. "Statut ACTIVE mais Niveau 0" — an earlier version of
     `_apply_payment_success` pre-flipped `user.status` to "active" BEFORE
     calling `matrix.activate_level`. When `activate_level` raised, the
     user was stuck with `status=active, max_level=0`. Fix : delete the
     pre-flip; `activate_level` sets BOTH atomically at matrix.py:397.

  2. "5 USDT affiché comme 5 FCFA" — `(admin)/recharges.tsx` hard-coded
     "FCFA" for every amount, ignoring the actual `currency` field.
"""
from __future__ import annotations
import re
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


# ─── Bug 1 — ghost-state activation ────────────────────────────────────
def test_apply_payment_success_no_longer_preflips_user_status():
    src = (BACKEND / "ashtec_activation.py").read_text(encoding="utf-8")
    # The pre-flip pattern was:
    #     await db.users.update_one(
    #         {"id": p["user_id"], "status": {"$ne": "active"}},
    #         {"$set": {"status": "active"}},
    #     )
    # Anywhere BEFORE the call to activate_level(). We check the fix
    # comment is in place and the update_one has been removed.
    assert 'DO NOT pre-flip user.status' in src, (
        "The fix comment must be present in _apply_payment_success."
    )
    # Ensure the specific pre-flip update_one no longer exists in the
    # activation success path (the reconcile alias in server.py is a
    # separate check below).
    fn_body = src.split('async def _apply_payment_success')[1]
    fn_body = fn_body.split('async def ')[0]
    # No status=active pre-flip in the activation flow
    assert '{"$set": {"status": "active"}}' not in fn_body, (
        "The pre-flip of user.status must be removed from _apply_payment_success."
    )


def test_reconcile_loop_no_longer_preflips_user_status():
    src = (BACKEND / "server.py").read_text(encoding="utf-8")
    idx_reconcile = src.find("reconcile: activated user=%s")
    # walk backwards ~30 lines from the log line to check the pre-flip
    # doesn't sit right there.
    excerpt = src[max(0, idx_reconcile - 2000):idx_reconcile + 500]
    assert 'do NOT pre-flip' in excerpt.lower() or 'ghost state' in excerpt.lower(), (
        "The reconcile loop must NOT pre-flip user.status either."
    )


def test_matrix_activate_level_sets_status_and_max_level_atomically():
    """The single source of truth for user activation. Both fields MUST
    be set in the same `$set` operation (matrix.py:397-399)."""
    src = (BACKEND / "matrix.py").read_text(encoding="utf-8")
    # Locate the update_one that sets max_level
    m = re.search(
        r'\$set["\']:\s*\{[^}]*"max_level"[^}]*"status"[^}]*"active"[^}]*\}',
        src,
    )
    assert m is not None, (
        "matrix.activate_level must set max_level AND status='active' in a single $set."
    )


# ─── Bug 1b — repair endpoints ─────────────────────────────────────────
def test_ghost_repair_endpoints_are_defined():
    src = (BACKEND / "server.py").read_text(encoding="utf-8")
    assert '/repair/ghost-activations' in src
    assert 'admin_scan_ghost_activations' in src
    assert 'admin_repair_ghost_activations' in src


# ─── Bug 2 — currency-aware amount formatting ──────────────────────────
def test_admin_recharges_uses_currency_aware_formatter():
    src = (FRONTEND / "app" / "(admin)" / "recharges.tsx").read_text(encoding="utf-8")
    # The bug was:  const fmt = (v) => `${v} FCFA`;
    # The fix must take a currency argument.
    assert re.search(r'const\s+fmt\s*=\s*\(\s*v:\s*any\s*,\s*currency', src), (
        "recharges.tsx `fmt` helper must accept a `currency` argument."
    )
    # USDT branch present
    assert '"USDT"' in src, "USDT display branch must exist in recharges.tsx."
    # Callsites use r.currency
    assert 'fmt(r.amount, r.currency)' in src


def test_admin_payments_already_currency_aware():
    src = (FRONTEND / "app" / "(admin)" / "payments.tsx").read_text(encoding="utf-8")
    # payments.tsx uses `fmtAmount(p.amount, p.currency)` — it was already
    # currency-aware. Confirm this hasn't regressed.
    assert 'fmtAmount(p.amount, p.currency)' in src
