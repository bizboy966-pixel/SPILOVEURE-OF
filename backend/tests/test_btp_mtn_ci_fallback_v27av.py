"""v27av (2026-03-05) — regression: BTP MTN CI payment refused.

The BTP merchant console configures operator codes PER environment (per-user)
and the integration docs do NOT publish the exact codes for each country.
Our internal code was `mtn_ci` but the user's BTP account expected a different
code (likely `mtn_momo_ci` or `mtn_mobile_money_ci`), so every activation
returned HTTP 400 "Opérateur non disponible pour ce pays" — rendered as the
generic "Biz-transPay a refusé le paiement" with no actionable detail.

Fix v27av :
  1. Each operator now carries a `provider_codes` fallback list.
  2. The deposit/payout dispatcher tries each code until BTP accepts one.
  3. The accepted code is memoized in `app_settings` so later calls skip
     the retry loop.
  4. If BTP keeps refusing after every candidate, the user-facing error
     surfaces the exact BTP `detail` instead of a generic message.
"""
from biztranspay import OPERATORS


def test_ci_operators_have_provider_codes_fallback():
    """Every CI operator must ship a non-empty `provider_codes` list that
    includes at least the primary internal code so the dispatcher can
    retry alternative codes on an operator mismatch."""
    ci = OPERATORS["CI"]
    assert ci["currency"] == "XOF"
    for op in ci["operators"]:
        codes = op.get("provider_codes") or []
        assert isinstance(codes, list) and len(codes) >= 1, (
            f"Operator {op['code']} must expose provider_codes list"
        )
        assert op["code"] in codes, (
            f"Primary code {op['code']} must be inside its own provider_codes"
        )


def test_mtn_ci_candidate_variants():
    """MTN CI must offer multiple candidate codes so the dispatcher can
    probe `mtn_ci` → `mtn_momo_ci` → `mtn_mobile_money_ci` until BTP
    accepts one."""
    mtn = next(o for o in OPERATORS["CI"]["operators"] if o["code"] == "mtn_ci")
    codes = mtn["provider_codes"]
    assert "mtn_ci" in codes
    assert "mtn_momo_ci" in codes
    assert "mtn_mobile_money_ci" in codes
    assert len(codes) >= 3, "need at least 3 variants for a real fallback probe"


def test_deposit_dispatcher_retries_on_operator_mismatch_and_surfaces_detail():
    """Static parse: the deposit endpoint must (a) iterate over
    candidate_codes, (b) treat "Opérateur non disponible" as retriable,
    (c) surface the actual BTP `detail` in the user-facing error."""
    import pathlib
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    assert "candidate_codes" in src
    assert "learned_operator_code" in src, "must memoize the accepted code"
    assert "opérateur non disponible" in src.lower()
    assert "Biz-transPay a refusé le paiement : " in src, (
        "user-facing message must include the BTP detail suffix"
    )


def test_payout_dispatcher_also_retries():
    """Same fallback mechanism must apply to withdrawals so BJ/BF/CI
    retrait auto doesn't silently fail with a stale code."""
    import pathlib
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    # The payout branch has its own candidate_codes loop.
    assert src.count("candidate_codes") >= 4, (
        "candidate_codes should appear in both deposit and payout dispatchers"
    )


def test_other_countries_untouched():
    """TG/BJ/BF entries must still exist and resolve correctly after the
    CI-focused refactor."""
    for cc, min_ops in [("TG", 2), ("BJ", 3), ("BF", 3)]:
        assert cc in OPERATORS
        assert len(OPERATORS[cc]["operators"]) >= min_ops
