"""Regression — bulletproof activation grace window (2026-09-07 v3).

Ensures the frontend implements the definitive activation-persistence
strategy demanded by the user:

  1. Every payment-success handler MUST drop a `just_activated` flag in
     localStorage BEFORE the hard-reload to /dashboard.
  2. The layout guard MUST read this flag and REFUSE to redirect to /pay
     during the 60-second grace window, while actively re-polling
     /auth/me every 500 ms until max_level converges.
  3. The Dashboard MUST also poll during the grace window.

If any of these guards regress, the bug "compte s'active puis se
désactive" reappears. These tests catch that in CI.
"""
from __future__ import annotations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(app)"


def test_activation_ashtec_sets_flag_on_success():
    src = (ROOT / "activation-ashtec.tsx").read_text(encoding="utf-8")
    assert 'localStorage.setItem("just_activated"' in src, (
        "activation-ashtec.tsx must set localStorage.just_activated on success."
    )


def test_pay_ashtec_sets_flag_on_success():
    src = (ROOT / "pay-ashtec.tsx").read_text(encoding="utf-8")
    assert 'localStorage.setItem("just_activated"' in src


def test_pay_sets_flag_on_success():
    src = (ROOT / "pay.tsx").read_text(encoding="utf-8")
    assert 'localStorage.setItem("just_activated"' in src


def test_activation_crypto_auto_sets_flag_on_success():
    src = (ROOT / "activation-crypto-auto.tsx").read_text(encoding="utf-8")
    assert 'localStorage.setItem("just_activated"' in src


def test_layout_guard_reads_flag_and_refuses_redirect():
    src = (ROOT / "_layout.tsx").read_text(encoding="utf-8")
    assert 'readJustActivated' in src, "Layout must expose a readJustActivated helper."
    assert 'ACTIVATION_GRACE_MS' in src
    # The critical rule: the redirect to /pay MUST come AFTER `if (flag) …`
    idx_flag = src.find("if (flag) {")
    idx_redirect = src.find('router.replace("/(app)/pay")')
    assert idx_flag > 0 and idx_redirect > 0
    assert idx_flag < idx_redirect, (
        "Layout guard must consult `just_activated` flag BEFORE redirecting to /pay."
    )


def test_layout_polls_refresh_during_grace_window():
    src = (ROOT / "_layout.tsx").read_text(encoding="utf-8")
    assert 'setInterval' in src, "Layout must poll refresh() during grace."
    assert 'ACTIVATION_POLL_MS' in src


def test_dashboard_polls_during_grace_window():
    src = (ROOT / "dashboard.tsx").read_text(encoding="utf-8")
    assert 'just_activated' in src
    assert '500' in src, "Dashboard must poll every 500 ms during grace."


def test_layout_uses_AND_based_pending_check():
    src = (ROOT / "_layout.tsx").read_text(encoding="utf-8")
    # After the v5 fix the pending check must use AND, so a user with
    # ANY activation marker (status=active OR max_level>=1) is treated
    # as active. Formerly this was an OR, which could bounce
    # partially-activated users.
    assert 'user.status === "pending" && (user.max_level || 0) === 0' in src, (
        "Layout must use AND-based pending check (status=pending AND max_level=0)."
    )
