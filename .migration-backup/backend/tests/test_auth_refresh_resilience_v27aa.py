"""Regression — 2026-03-04 (v27aa) auth.refresh resilience.

Root cause : the previous frontend implementation of `refresh()` had a
catch-all that wiped `user + auth_token` on ANY error thrown by
`api.get('/auth/me')`. Rapid navigation on the web bundler (Expo Router
Metro) cancels in-flight fetches on unmount → AbortError → refresh() nuked
the session → `(app)/_layout.tsx` sees `!user` → redirect to /login.

This test is a STATIC parser regression : it opens the source file and
verifies the fix is in place (impossible to regress by tree-shake or
minor refactor).
"""
from pathlib import Path


AUTH_TSX = Path(__file__).resolve().parents[2] / "frontend" / "src" / "auth.tsx"


def test_refresh_only_wipes_on_401():
    src = AUTH_TSX.read_text()
    # The old code did `catch { setUser(null); setAuthToken(null); ... }`
    # unconditionally. Verify that pattern is GONE.
    assert "catch {\n      setUser(null);\n      setAuthToken(null);" not in src, (
        "Regression : refresh() again wipes user on ANY error. This will "
        "sign users out on rapid navigation (Fetch abort → AbortError)."
    )
    # And that the new discriminated catch is in place.
    assert "if (status === 401)" in src
    assert "keep the existing user in state" in src
    assert "AbortError" in src


def test_unauthorized_handler_still_signals_signout():
    """The api.ts 401 handler stays the source of truth for genuine JWT
    expiry — it triggers setUnauthorizedHandler → window.location.assign
    → login. auth.refresh() must NOT duplicate that (it did before)."""
    src = AUTH_TSX.read_text()
    assert "setUnauthorizedHandler((message) =>" in src
