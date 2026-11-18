"""Regression — activation grace window (v16 revision, 2026-02-14).

The v16 spec removed the auto-redirect-to-`/pay` for pending users. As
a consequence:
  1. Every payment-success handler MUST still drop a `just_activated`
     flag in localStorage before the hard-reload — the dashboard uses
     it to poll `/auth/me` until max_level converges.
  2. The layout itself no longer redirects pending users, so the old
     `readJustActivated` / `ACTIVATION_GRACE_MS` helpers on the layout
     are intentionally gone.
  3. The Dashboard MUST still poll aggressively (every 500 ms) during
     the 60-second grace window.

If any of these guards regress, the "compte s'active puis se
désactive" bug reappears. These tests catch that in CI.
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


def test_layout_no_longer_redirects_pending_to_pay():
    """v16 (2026-02-14): pending users are NEVER auto-redirected to /pay
    anymore. They land on the dashboard and see the activation modal
    only when they trigger a protected action."""
    src = (ROOT / "_layout.tsx").read_text(encoding="utf-8")
    assert 'router.replace("/(app)/pay")' not in src, (
        "Layout must NOT auto-redirect pending users to /pay (v16 spec)."
    )


def test_dashboard_polls_during_grace_window():
    src = (ROOT / "dashboard.tsx").read_text(encoding="utf-8")
    assert 'just_activated' in src, "Dashboard must still consume the grace flag."
    assert '500' in src, "Dashboard must poll every 500 ms during grace."
    assert 'setInterval' in src
