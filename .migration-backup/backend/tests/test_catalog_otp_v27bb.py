"""v27bb (2026-03-05) — activation-catalog exposes requires_otp + ussd template.

The frontend needs to know, at catalog load time, which operators require
an OTP so it can render the OTP card proactively (before the user clicks
"ACTIVER MON COMPTE"), instead of waiting for a failed submission.
"""
import pathlib

from biztranspay import OPERATORS


def test_bf_orange_in_catalog_has_otp_annotations():
    """BF Orange Money entry in OPERATORS has requires_otp + ussd template."""
    o = next(x for x in OPERATORS["BF"]["operators"] if x["code"] == "orange_bf")
    assert o.get("requires_otp") is True
    assert o.get("otp_ussd_template") == "*144*4*6*{amount}#"


def test_bf_moov_in_catalog_has_no_otp():
    """BF Moov Money does NOT require an OTP (no USSD prompt)."""
    o = next(x for x in OPERATORS["BF"]["operators"] if x["code"] == "moov_bf")
    assert not o.get("requires_otp")


def test_server_activation_catalog_propagates_otp_fields():
    """server.py `activation_catalog` must copy `requires_otp` and
    `otp_ussd_template` from the BTP OPERATORS dict into each operator
    entry it returns."""
    src = pathlib.Path("/app/backend/server.py").read_text(encoding="utf-8")
    fn_start = src.index("async def activation_catalog(")
    fn_end = src.index("\n\n\n", fn_start)
    body = src[fn_start:fn_end]
    assert '"requires_otp"' in body, (
        "activation_catalog must expose requires_otp on each operator"
    )
    assert '"otp_ussd_template"' in body, (
        "activation_catalog must expose otp_ussd_template on each operator"
    )


def test_frontend_pay_tsx_consumes_catalog_otp_fields():
    """pay.tsx must render the OTP card based on `operator.requires_otp`
    (proactive) in addition to the server-triggered otpFlow (reactive)."""
    src = pathlib.Path("/app/frontend/app/(app)/pay.tsx").read_text(encoding="utf-8")
    assert "requires_otp" in src, "frontend must read requires_otp"
    assert "operatorRequiresOtp" in src, (
        "frontend must have a derived flag to pre-render OTP card"
    )
    assert "operatorUssd" in src, (
        "frontend must compute the USSD code with {amount} substituted"
    )
