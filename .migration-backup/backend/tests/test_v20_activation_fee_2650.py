"""Regression v20 (2026-02-14) — activation fee bumped to 2 650 FCFA.

Product owner decision: mobile-money activation is now 2 650 FCFA (was
2 500). Crypto side (5 USDT) is unaffected because it reads
`LEVELS_BY_NUM[1]["price"]` for canonical matrix math, not the mobile
override. This test locks the new value in and prevents accidental
regressions.
"""
from __future__ import annotations
import importlib


def test_ashtec_activation_defaults_to_2650_xof_xaf():
    mod = importlib.import_module("ashtec_activation")
    importlib.reload(mod)
    assert mod.ACTIVATION_AMOUNT_BY_CURRENCY["XOF"] == 2650.0, (
        "Mobile-money XOF activation must be 2 650 FCFA (v20 bump)."
    )
    assert mod.ACTIVATION_AMOUNT_BY_CURRENCY["XAF"] == 2650.0, (
        "Mobile-money XAF activation must be 2 650 FCFA (v20 bump)."
    )


def test_server_mobile_activation_helper():
    from server import _mobile_activation_amount  # type: ignore
    assert _mobile_activation_amount("XOF") == 2650.0
    assert _mobile_activation_amount("XAF") == 2650.0
    # CDF unchanged
    assert _mobile_activation_amount("CDF") == 12500.0


def test_levels_module_unchanged_for_crypto():
    """Crypto flow keys off LEVELS_BY_NUM[1]['price'] for the FCFA
    equivalent it stores next to the 5 USDT amount. The commissions
    per invite (2 000), upgrade_reserve (1 000) and matrix math stay
    strictly untouched — only the platform_fee absorbs the +150 FCFA.
    """
    from levels import LEVELS_BY_NUM  # type: ignore
    lv1 = LEVELS_BY_NUM[1]
    assert lv1["commission_per_invite"] == 2000
    assert lv1["upgrade_reserve"] == 1000
    assert lv1["invites_required"] == 2
