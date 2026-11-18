"""v27az (2026-03-05) — Burkina Faso complete pay-in + pay-out integration
from the official BTP documentation (https://biz-transppayy.com/integration/docs).

Key insights from the doc, section by section :

  1. "Moov Money Burkina — dépôt automatique"
     Code dépôt usuel : `moov_bf`. Devise XOF. Après initiation, le client
     doit composer `*555*6#` sur son téléphone. Pas d'OTP avant soumission.

  2. "Orange Money Burkina — dépôt avec OTP"
     Code dépôt usuel : `orange_bf`. Devise XOF. L'absence d'OTP renvoie
     HTTP 400 avec `detail.code = OTP_REQUIRED` et `detail.payment_flow`
     avant toute soumission. Le client doit composer
     `*144*4*6*{amount}#`, générer le code OTP, puis soumettre avec ce
     code et la même Idempotency-Key.

  3. "Moov et Orange Burkina — retrait automatique"
     Les codes de RETRAIT diffèrent des codes de dépôt :
       • `moov-burkina-faso`    (kebab-case, nom pays complet)
       • `orange-money-burkina` (kebab-case)
     Pas d'OTP ni USSD. Scope `payouts:write` + KYC + autorisation retrait.

Changes in v27az :
  • Added `provider_codes_payout` field (distinct from `provider_codes`)
    on BF Moov, BF Orange, and TG Moov (where the deposit code `moov_tg`
    differs from the payout code `moov-togo`).
  • Added `requires_otp` + `otp_ussd_template` to BF Orange so the
    frontend can prompt the user with the exact USSD code to dial.
  • Split the `btp_learned_operator_code` cache key by direction so a
    successful deposit doesn't poison the payout cache (and vice versa).
  • Pre-seeded the DB with the three officially confirmed codes so the
    first retrait after v27az hits BTP with the winner on attempt #1.
  • `BtpActivationIn` now accepts an optional `otp` field forwarded to
    BTP for Orange BF (ignored by other operators).
  • When BTP returns HTTP 400 OTP_REQUIRED, the backend bubbles up a
    structured 400 response with `code=OTP_REQUIRED`, the rendered USSD
    code (with {amount} substituted), and the full `payment_flow` so the
    frontend can display precise instructions.
"""
import os
import pathlib

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from biztranspay import OPERATORS, _build_candidate_codes, _learned_code_key


def test_bf_moov_payout_code_official():
    """Moov BF payout → `moov-burkina-faso` must be the FIRST probe."""
    moov = next(o for o in OPERATORS["BF"]["operators"] if o["code"] == "moov_bf")
    pc_payout = moov["provider_codes_payout"]
    assert pc_payout[0] == "moov-burkina-faso", (
        f"Expected moov-burkina-faso first, got {pc_payout[0]}"
    )
    # Fallback kept
    assert "moov_bf" in pc_payout


def test_bf_orange_payout_code_official():
    """Orange BF payout → `orange-money-burkina` must be the FIRST probe."""
    o = next(x for x in OPERATORS["BF"]["operators"] if x["code"] == "orange_bf")
    pc_payout = o["provider_codes_payout"]
    assert pc_payout[0] == "orange-money-burkina"
    assert "orange_bf" in pc_payout


def test_bf_orange_requires_otp_for_deposits():
    """BF Orange deposit requires an OTP; frontend must render the USSD."""
    o = next(x for x in OPERATORS["BF"]["operators"] if x["code"] == "orange_bf")
    assert o.get("requires_otp") is True
    assert o.get("otp_ussd_template") == "*144*4*6*{amount}#"


def test_bf_moov_deposit_code_is_moov_bf():
    """BF Moov deposit must still use `moov_bf` (per BTP doc example)."""
    moov = next(o for o in OPERATORS["BF"]["operators"] if o["code"] == "moov_bf")
    assert moov["provider_codes"][0] == "moov_bf"


def test_build_candidate_codes_direction_aware():
    """`_build_candidate_codes` must prefer `provider_codes_payout` when
    called in payout direction, and `provider_codes` otherwise."""
    moov = next(o for o in OPERATORS["BF"]["operators"] if o["code"] == "moov_bf")
    deposit_codes = _build_candidate_codes(moov, "moov_bf", direction="deposit")
    payout_codes = _build_candidate_codes(moov, "moov_bf", direction="payout")
    assert deposit_codes[0] == "moov_bf"
    assert payout_codes[0] == "moov-burkina-faso"
    assert deposit_codes != payout_codes


def test_tg_moov_direction_aware_too():
    """TG Moov deposit stays `moov_tg`, payout starts with `moov-togo`."""
    moov = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "moov_tg")
    d = _build_candidate_codes(moov, "moov_tg", direction="deposit")
    p = _build_candidate_codes(moov, "moov_tg", direction="payout")
    assert d[0] == "moov_tg"
    assert p[0] == "moov-togo"


def test_learned_key_scoped_by_direction():
    """Deposit and payout keys MUST differ."""
    kd = _learned_code_key("deposit", "TG", "moov_tg")
    kp = _learned_code_key("payout", "TG", "moov_tg")
    assert kd != kp
    assert "deposit" in kd and "payout" in kp


def test_dispatcher_uses_payout_direction():
    """The payout dispatcher must call `_build_candidate_codes(..., direction=\"payout\")`
    and `_learned_code_key(\"payout\", ...)`. Static check."""
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    disp_start = src.index("async def dispatch_biztranspay_withdrawal(")
    disp_end = src.index("\n\n\nasync def ", disp_start)
    body = src[disp_start:disp_end]
    assert 'direction="payout"' in body
    assert '_learned_code_key("payout"' in body


def test_deposit_endpoint_uses_deposit_direction_and_forwards_otp():
    """The deposit endpoint must use direction=deposit AND forward the
    `otp` field to BTP when the client provides it (Orange BF)."""
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    dep_start = src.index("async def biztranspay_activation(")
    dep_end = src.index("\n\n\n", dep_start)
    body = src[dep_start:dep_end]
    assert 'direction="deposit"' in body
    assert 'data.otp' in body, "deposit endpoint must forward data.otp"
    assert 'OTP_REQUIRED' in body, "deposit endpoint must bubble up OTP_REQUIRED to frontend"


def test_btp_activation_in_has_optional_otp():
    """BtpActivationIn must accept an optional `otp` field."""
    from biztranspay import BtpActivationIn
    ok = BtpActivationIn(country_code="BF", operator="orange_bf", phone="70000000", otp="12345")
    assert ok.otp == "12345"
    ok2 = BtpActivationIn(country_code="TG", operator="moov_tg", phone="90000000")
    assert ok2.otp is None


# ─── DB seed regression ───────────────────────────────────────────────
@pytest.fixture
def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return client[os.environ["DB_NAME"]]


@pytest.mark.asyncio
async def test_db_seed_bf_payout_codes(db):
    for cc, op, expected in [
        ("BF", "moov_bf",   "moov-burkina-faso"),
        ("BF", "orange_bf", "orange-money-burkina"),
        ("TG", "moov_tg",   "moov-togo"),
    ]:
        key = f"btp_learned_operator_code:payout:{cc}:{op}"
        doc = await db.app_settings.find_one({"key": key})
        assert doc is not None, f"missing seed {key}"
        assert doc.get("value") == expected, (
            f"expected {expected}, got {doc.get('value')}"
        )


@pytest.mark.asyncio
async def test_legacy_direction_less_key_cleaned(db):
    """The pre-v27az shared key must be cleaned up by the migration."""
    doc = await db.app_settings.find_one(
        {"key": "btp_learned_operator_code:TG:moov_tg"},
    )
    assert doc is None, "legacy direction-less key must be gone"
