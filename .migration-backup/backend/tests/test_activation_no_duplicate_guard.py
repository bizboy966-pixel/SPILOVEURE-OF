"""Regression test — Dashboard must not have a duplicate activation guard.

Bug reported 2026-09-07: after a successful AshtechPay activation, the
user hard-reloads to `/dashboard` and lands there briefly, then gets
bounced back to `/(app)/activation` within ~1s.

Root cause: `frontend/app/(app)/dashboard.tsx` had its OWN redirect
guard that duplicated the one in `(app)/_layout.tsx`, but pointed to
the old `/(app)/activation` route. On a brief window right after a
hard reload, the guard could fire on a stale user snapshot.

Fix: the guard MUST be centralised in `(app)/_layout.tsx`. Dashboard
must NOT contain a `router.replace(".../activation")` in a useEffect.
"""
from __future__ import annotations
import re
from pathlib import Path


DASHBOARD = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(app)" / "dashboard.tsx"
LAYOUT = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(app)" / "_layout.tsx"


def test_dashboard_has_no_router_replace_to_activation():
    src = DASHBOARD.read_text(encoding="utf-8")
    # Must NOT redirect to any legacy activation path from within dashboard.
    assert 'router.replace("/(app)/activation")' not in src, (
        "Dashboard still contains a duplicate activation guard — remove it "
        "and delegate to (app)/_layout.tsx."
    )
    assert 'router.replace("/(app)/pay")' not in src, (
        "Dashboard should not enforce the payment guard; layout owns it."
    )


def test_dashboard_polls_with_useEffect_but_no_max_level_guard():
    """The Dashboard should not gate its own render/redirect on
    (max_level < 1). Only the layout guard is allowed to do that."""
    src = DASHBOARD.read_text(encoding="utf-8")
    # We accept `(user.max_level || 0) >= 1` for conditional UI (BottomNav)
    # but reject the legacy redirect guard.
    guard_pattern = re.compile(
        r'\(user\.max_level.*<.*1\).*router\.replace',
        flags=re.DOTALL,
    )
    assert not guard_pattern.search(src), (
        "Dashboard has a max_level < 1 redirect — must be removed."
    )


def test_layout_still_holds_the_single_guard():
    src = LAYOUT.read_text(encoding="utf-8")
    assert "router.replace" in src and "/(app)/pay" in src, (
        "Layout must hold the single activation guard, redirecting "
        "pending users to /(app)/pay."
    )


def test_activation_pages_poll_at_3s():
    """User asked for the polling cadence to drop from 6s to 3s so the
    'En attente' screen reacts within seconds of the operator
    confirming the payment."""
    root = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(app)"
    for name in ("activation-ashtec.tsx", "pay-ashtec.tsx",
                 "activation-crypto-auto.tsx"):
        src = (root / name).read_text(encoding="utf-8")
        assert "setInterval(poll, 3000)" in src or "3000)" in src, (
            f"{name} should poll every 3000 ms per user spec (2026-09-07)."
        )


def test_activation_pages_redirect_to_short_dashboard_url():
    """After payment, the hard reload must target `/dashboard` (not
    `/(app)/dashboard`) so the browser doesn't re-negotiate the group
    prefix. The `(app)` group is stripped from the URL by Expo Router
    on web, so `/(app)/dashboard` == `/dashboard` semantically."""
    root = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(app)"
    for name in ("activation-ashtec.tsx", "pay.tsx", "pay-ashtec.tsx",
                 "activation-crypto-auto.tsx"):
        src = (root / name).read_text(encoding="utf-8")
        # window.location.href to legacy /(app)/dashboard is the bug
        assert 'window.location.href = "/(app)/dashboard"' not in src, (
            f"{name} still hard-reloads to /(app)/dashboard — switch to /dashboard."
        )
