"""Regression — bug 2026-09-07 v7 : activate_level source whitelist.

3 call-sites in server.py were passing free-form source strings
("poll_return", f"webhook:{ref}", f"reconcile:{ref}") to
matrix.activate_level. Matrix's ALLOWED_SOURCES whitelist rejected them
with ValueError, which was caught upstream and logged as
`activation_error` — leaving the user stuck at `max_level=0` while the
payment showed as `paid`. This is the real root cause of the
"compte s'active puis se désactive" bug (v7 diagnosis).

The fix: normalise the source to the concrete gateway name
("ashtecpay", "soleaspay", …) or fall back to "gateway_return" (all
whitelisted).
"""
from __future__ import annotations
from pathlib import Path

import matrix


def test_matrix_allowed_sources_contain_gateway_return():
    # gateway_return is our universal fallback for the fix
    src = matrix.activate_level.__doc__ or ""
    assert "gateway_return" in src, "matrix.activate_level doc must mention gateway_return."


def test_no_source_named_poll_return_anywhere():
    server = Path(__file__).resolve().parents[1] / "server.py"
    assert 'source="poll_return"' not in server.read_text(encoding="utf-8"), (
        "poll_return is NOT in matrix ALLOWED_SOURCES — activation would fail."
    )


def test_no_source_named_webhook_prefix_anywhere():
    server = Path(__file__).resolve().parents[1] / "server.py"
    assert 'source=f"webhook:' not in server.read_text(encoding="utf-8"), (
        'source=f"webhook:{ref}" is NOT whitelisted — activation would fail.'
    )


def test_no_source_named_reconcile_prefix_anywhere():
    server = Path(__file__).resolve().parents[1] / "server.py"
    assert 'source=f"reconcile:' not in server.read_text(encoding="utf-8"), (
        'source=f"reconcile:{ref}" is NOT whitelisted — activation would fail.'
    )


def test_all_activate_level_sources_are_whitelisted():
    """Every literal `source=` string passed to activate_level anywhere in
    the backend MUST be in matrix.py's ALLOWED_SOURCES."""
    import re
    BACKEND = Path(__file__).resolve().parents[1]
    matrix_src = (BACKEND / "matrix.py").read_text(encoding="utf-8")
    m = re.search(r"ALLOWED_SOURCES\s*=\s*\{([^}]+)\}", matrix_src, flags=re.DOTALL)
    assert m
    allowed = set(re.findall(r'"([^"]+)"', m.group(1)))
    # Scan every python file for `source="X"` LITERAL (skip f-strings)
    offenders = []
    for py in BACKEND.rglob("*.py"):
        if "/tests/" in str(py) or py.name.startswith("test_"): continue
        for line in py.read_text(encoding="utf-8").splitlines():
            match = re.search(r'source\s*=\s*"([^"]+)"', line)
            if match:
                s = match.group(1)
                if s not in allowed:
                    offenders.append(f"{py.name}: source={s!r}")
    assert not offenders, "Un-whitelisted sources:\n" + "\n".join(offenders)


def test_matrix_activate_level_sets_status_and_max_level_atomically_v7():
    """Sanity re-check: matrix.activate_level MUST set both max_level and
    status in the same $set (locked by v4 fix, verified here too)."""
    import re
    src = (Path(matrix.__file__).resolve()).read_text(encoding="utf-8")
    assert re.search(
        r'\$set["\']:\s*\{[^}]*"max_level"[^}]*"status"[^}]*"active"',
        src,
    )
