"""v27aw (2026-03-05) — three fixes.

#1 (critical) : auto-dispatched BTP withdrawals that are already `completed`
   at the gateway stay stuck in the admin "En attente" tab until an admin
   opens the panel. The polling_loop sweeps `payments` every 4 s but never
   touches `withdrawals`. Fix : also run `reconcile_all_dispatched` on every
   polling tick so stuck withdrawals flip to `completed` within 4 s.

#2 & #3 : extend `provider_codes` fallback to every TG/BJ/BF operator so
   Moov Money (Flooz) TG + MTN CI (and any other alias mismatch) retry
   through alternative BTP codes instead of silently refusing.
"""
import pathlib

from biztranspay import OPERATORS


def test_all_operators_have_provider_codes():
    """TG + BJ + BF + CI every operator must ship a provider_codes list."""
    for cc in ("TG", "BJ", "BF", "CI"):
        for op in OPERATORS[cc]["operators"]:
            codes = op.get("provider_codes") or []
            assert isinstance(codes, list) and len(codes) >= 1, (
                f"{cc}/{op['code']} must expose provider_codes list"
            )
            assert op["code"] in codes, (
                f"{cc}/{op['code']} primary code must be inside provider_codes"
            )


def test_moov_tg_candidate_variants():
    """Moov Money Togo (Flooz) must offer multiple provider codes."""
    moov = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "moov_tg")
    codes = moov["provider_codes"]
    assert "moov_tg" in codes
    assert "flooz_tg" in codes
    assert "moov_money_tg" in codes


def test_mixx_by_yas_candidate_variants():
    """Mixx By Yas (T-Money) kept working — regression check."""
    tm = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "tmoney_tg")
    codes = tm["provider_codes"]
    assert "tmoney_tg" in codes
    assert "mixx_by_yas_tg" in codes
    assert "yas_tg" in codes


def test_mtn_ci_candidate_variants_v27av_preserved():
    """v27av fallback for MTN CI remains in place."""
    mtn = next(o for o in OPERATORS["CI"]["operators"] if o["code"] == "mtn_ci")
    codes = mtn["provider_codes"]
    assert "mtn_ci" in codes
    assert "mtn_momo_ci" in codes
    assert "mtn_mobile_money_ci" in codes


def test_polling_loop_reconciles_withdrawals():
    """polling_loop must call reconcile_all_dispatched every tick so
    completed BTP payouts flip to `completed` within 4 s without admin
    needing to open the retraits panel."""
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    loop_start = src.index("async def polling_loop(")
    # Find the next top-level `async def` to bound the function body.
    next_def = src.index("\nasync def ", loop_start + 1)
    loop_body = src[loop_start:next_def]
    assert "reconcile_all_dispatched" in loop_body, (
        "polling_loop MUST call reconcile_all_dispatched so withdrawals "
        "auto-flip from pending to completed without admin intervention."
    )
    assert "max_docs=" in loop_body, "reconcile call should cap batch size"


def test_poll_once_still_handles_activations_only():
    """`_poll_once` keeps its original activation-only responsibility
    (no scope creep). Withdrawals are reconciled by a separate call."""
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    poll_start = src.index("async def _poll_once(")
    poll_end = src.index("\nasync def polling_loop", poll_start)
    body = src[poll_start:poll_end]
    assert "db.payments.find(" in body
    assert "db.withdrawals" not in body, (
        "_poll_once should stay focused on activations; withdrawals belong "
        "to reconcile_all_dispatched"
    )
