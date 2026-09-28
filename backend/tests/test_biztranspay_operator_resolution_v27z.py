"""Regression — 2026-03-04 (v27z) : mapping opérateur BTP + rebrand Yas/Mixx.

Cause racine du RCA 9df45644 : un retrait Mobile Money TG avec l'opérateur
"Mixx By Yas" (rebrand Moov Africa Togo) n'était plus reconnu par le
dispatcher → aucun appel `/payouts` → retrait bloqué en `pending`.

Ce test verrouille :
  1. La table `OPERATORS` porte des aliases pour couvrir les rebrands.
  2. `_resolve_operator_code` mappe correctement les libellés admin/UI.
  3. Le dispatcher persiste `gateway_error*` sur chaque échec précoce
     (traçabilité — plus jamais de retrait pending muet).
"""
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import biztranspay  # noqa: E402


# ── Resolution ────────────────────────────────────────────────────────────
def test_resolve_mixx_by_yas_tg_maps_to_tmoney_tg():
    # "Mixx By Yas" est le rebrand de T-Money (TogoCom / groupe Yas) au Togo.
    assert biztranspay._resolve_operator_code("TG", "Mixx By Yas") == "tmoney_tg"
    assert biztranspay._resolve_operator_code("TG", "mixx by yas") == "tmoney_tg"
    assert biztranspay._resolve_operator_code("TG", "MIXX BY YAS") == "tmoney_tg"
    assert biztranspay._resolve_operator_code("TG", "Yas") == "tmoney_tg"
    assert biztranspay._resolve_operator_code("TG", "T-Money") == "tmoney_tg"
    assert biztranspay._resolve_operator_code("TG", "TogoCom") == "tmoney_tg"


def test_resolve_moov_variants_map_to_moov_tg():
    assert biztranspay._resolve_operator_code("TG", "Moov") == "moov_tg"
    assert biztranspay._resolve_operator_code("TG", "Moov Money") == "moov_tg"
    assert biztranspay._resolve_operator_code("TG", "Flooz") == "moov_tg"
    assert biztranspay._resolve_operator_code("TG", "moov_tg") == "moov_tg"


def test_resolve_bj_bf_operators():
    assert biztranspay._resolve_operator_code("BJ", "MTN") == "tmoney_bj"
    assert biztranspay._resolve_operator_code("BJ", "Moov") == "moov_bj"
    assert biztranspay._resolve_operator_code("BJ", "Flooz") == "moov_bj"
    assert biztranspay._resolve_operator_code("BJ", "Celtiis") == "celtiis_bj"
    assert biztranspay._resolve_operator_code("BF", "Orange") == "orange_bf"
    assert biztranspay._resolve_operator_code("BF", "Moov") == "moov_bf"
    assert biztranspay._resolve_operator_code("BF", "Coris") == "coris_bf"


def test_resolve_unknown_returns_none():
    assert biztranspay._resolve_operator_code("TG", "") is None
    assert biztranspay._resolve_operator_code("TG", "MonSuperOp") is None
    assert biztranspay._resolve_operator_code("XX", "Moov") is None
    assert biztranspay._resolve_operator_code("TG", "orange") is None  # pas en TG


# ── Persistence of failure trace ─────────────────────────────────────────
def _fake_db_with_wd_collection():
    """Build a MagicMock DB whose withdrawals.update_one is an AsyncMock
    we can assert against."""
    db = MagicMock()
    db.withdrawals.update_one = AsyncMock()
    db.payment_provider_operators.find_one = AsyncMock(return_value=None)
    db.app_settings.find_one = AsyncMock(return_value={
        "key": "payment_gateway",
        "value": {
            "biztranspay_enabled": True,
            "biztranspay_payout_enabled": True,
            "biztranspay_public_key": "pk_live_xxx",
            "biztranspay_secret_key": "sk_live_yyy",
        },
    })
    return db


def test_dispatch_unknown_operator_persists_gateway_error():
    db = _fake_db_with_wd_collection()
    wd = {"id": "WD-1", "country": "TG", "operator": "Mystery Op",
          "phone": "91978352", "amount": 5000, "net_payout": 4900}

    r = asyncio.get_event_loop().run_until_complete(
        biztranspay.dispatch_biztranspay_withdrawal(db, wd)
    )
    assert r["auto_dispatched"] is False
    assert r["reason"] == "operator_not_supported"
    assert r["operator_raw"] == "Mystery Op"

    # Must have called update_one on withdrawals with gateway_error* fields
    call = db.withdrawals.update_one.call_args
    assert call is not None, "gateway_error was NOT persisted — regression"
    q, upd = call.args
    assert q == {"id": "WD-1"}
    setd = upd["$set"]
    assert setd["auto_dispatched"] is False
    assert setd["gateway"] == "biztranspay"
    assert setd["gateway_error_code"] == "operator_not_supported"
    assert "Mystery Op" in setd["gateway_error"]


def test_dispatch_mixx_by_yas_would_pass_operator_gate():
    """The mapping test above proves 'Mixx By Yas' resolves to tmoney_tg
    (T-Money rebrand). We also assert the dispatcher passes the operator-
    code gate (it will still fail later at the operator_disabled_by_admin
    check with our fake DB that returns None, but the important thing is
    `operator_not_supported` is NOT the reason anymore)."""
    db = _fake_db_with_wd_collection()
    wd = {"id": "WD-2", "country": "TG", "operator": "Mixx By Yas",
          "phone": "91978352", "amount": 5000, "net_payout": 4900}

    r = asyncio.get_event_loop().run_until_complete(
        biztranspay.dispatch_biztranspay_withdrawal(db, wd)
    )
    assert r["auto_dispatched"] is False
    # Fake DB returns None on payment_provider_operators.find_one → the
    # check right AFTER operator resolution kicks in. What matters is
    # we've moved past `operator_not_supported`.
    assert r["reason"] == "operator_disabled_by_admin"
