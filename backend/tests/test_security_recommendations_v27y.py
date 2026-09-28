"""Regression tests — 2026-03-04 (v27y) Biz-transPay security recommendations.

Covers the 3 defense-in-depth enhancements applied post-audit:
  • R1 — strict masking of secret-material (secret_key + webhook_secret).
         The old prefix leak (`sk_test_****` vs `sk_live_****`) is gone.
  • R2 — rate-limiting on /api/withdrawals (max 5 attempts / rolling 5 min).
  • R3 — redact secrets in Biz-transPay error logs & DB error fields.
"""
import re
import sys
from pathlib import Path

# ensure /app/backend is importable when pytest is run from /app
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


# ── R1 ─────────────────────────────────────────────────────────────────────
def test_r1_secret_key_never_leaks_prefix():
    from server import _mask_secret_strict

    live = _mask_secret_strict("sk_live_ABCDEFGHIJKLMNOPQR1234")
    test = _mask_secret_strict("sk_test_ABCDEFGHIJKLMNOPQR1234")

    # Only last 4 chars visible on both — you CANNOT tell live from test.
    assert live == test
    assert live.endswith("1234")
    assert "live" not in live
    assert "test" not in test
    assert "sk_" not in live and "sk_" not in test


def test_r1_short_secret_masked_all():
    from server import _mask_secret_strict
    assert _mask_secret_strict("") == ""
    assert _mask_secret_strict("abcd") == "••••"
    # 5 chars → strict mask (dots + last 4)
    assert _mask_secret_strict("abcde").endswith("bcde")


def test_r1_public_key_keeps_prefix_visible():
    """Public keys are, by design, not sensitive — the old mask keeps its 4-4
    layout so the admin can still verify he pasted the right key."""
    from server import _mask_key
    pk = _mask_key("pk_test_ABCDEFGHIJKLMNOPQR1234")
    assert pk.startswith("pk_t")
    assert pk.endswith("1234")


# ── R3 ─────────────────────────────────────────────────────────────────────
def test_r3_redact_sk_live_and_sk_test():
    from biztranspay import _redact

    assert "sk_live_" not in _redact("sk_live_ABCDEFGH1234")
    assert "sk_test_" not in _redact("sk_test_ABCDEFGH1234")
    assert "***REDACTED***" in _redact("Authorization: Bearer sk_live_ABCDEFGH1234")


def test_r3_redact_bearer_and_whsec():
    from biztranspay import _redact

    s = 'headers = {"Authorization": "Bearer eyJhbGciOiJIUzI1NiIs.something", "x-secret": "whsec_deadbeef1234"}'
    red = _redact(s)
    assert "eyJhbGciOiJIUzI1NiIs" not in red
    assert "whsec_" not in red
    assert red.count("***REDACTED***") >= 2


def test_r3_public_key_not_redacted():
    """Public keys are safe to log."""
    from biztranspay import _redact
    pk = "pk_test_VISIBLE_1234"
    assert pk in _redact(f"config public_key={pk}")


def test_r3_exception_traceback_redacted():
    from biztranspay import _redact
    try:
        raise ValueError("failed to auth with Bearer sk_test_abcdef123456789")
    except ValueError as e:
        out = _redact(e)
        assert "sk_test_" not in out
        assert "***REDACTED***" in out


# ── R2 (static — the runtime path is exercised by curl in the smoke test) ─
def test_r2_withdrawal_route_has_rate_limit_block():
    """Guardrail: ensure a future refactor doesn't silently remove the
    rolling-window check on /api/withdrawals."""
    src = Path(__file__).resolve().parents[1].joinpath("server.py").read_text()
    m = re.search(
        r"@api\.post\(\"/withdrawals\"\).*?async def request_withdrawal\(.*?\n(?P<body>.*?)\n@api\.",
        src, re.S,
    )
    assert m, "could not locate request_withdrawal in server.py"
    body = m.group("body")
    # rolling window of 5 minutes must exist
    assert "minutes=5" in body
    # the 429 response too
    assert "429" in body
    # counter on db.withdrawals must be used
    assert "db.withdrawals.count_documents" in body
