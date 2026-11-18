"""Ashtech Pay Direct v1.2 compliance tests — catalog + HMAC webhook."""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import json
import os
import pytest

import ashtec_activation


def _hmac(secret: str, timestamp: str, raw: bytes) -> str:
    payload = f"{timestamp}.".encode("utf-8") + raw
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


# ─── Catalog v1.2 conformance ──────────────────────────────────────────
def test_catalog_version_bumped_to_v12():
    assert ashtec_activation.CATALOG_VERSION.startswith("2026-09-03-v4")


def test_catalog_has_exactly_10_official_countries():
    assert set(ashtec_activation.COUNTRIES.keys()) == {
        "BJ", "BF", "CM", "CI", "GA", "ML", "NE", "CD", "SN", "TG",
    }


def test_mali_operator_is_orange_money_not_otp():
    """PDF v1.2: Mali uses `Orange Money` (no OTP). Previously we had
    `Orange Money (OTP)` which Ashtech rejected with 422 in production."""
    assert ashtec_activation.COUNTRIES["ML"]["operators"] == [
        "Moov Money", "Orange Money",
    ]


def test_bj_operators_byte_for_byte():
    assert ashtec_activation.COUNTRIES["BJ"]["operators"] == [
        "Celtiis Money", "Coris Money", "Moov Money", "MTN Money",
    ]


def test_ci_operators_include_orange_otp():
    assert "Orange (OTP)" in ashtec_activation.COUNTRIES["CI"]["operators"]
    assert "Wave Money" in ashtec_activation.COUNTRIES["CI"]["operators"]


def test_sn_operators_include_orange_otp_and_wave():
    ops = ashtec_activation.COUNTRIES["SN"]["operators"]
    assert "Orange Money (OTP)" in ops
    assert "Wave Money" in ops


def test_cd_uses_cdf_currency():
    assert ashtec_activation.COUNTRIES["CD"]["currency"] == "CDF"


def test_activation_amount_by_currency_covers_xof_xaf_cdf():
    m = ashtec_activation.ACTIVATION_AMOUNT_BY_CURRENCY
    assert m["XOF"] == 2500
    assert m["XAF"] == 2500
    assert m["CDF"] == 12500


# ─── HMAC-SHA256 webhook signature verification ────────────────────────
def test_hmac_verify_accepts_valid_sha256_prefixed_signature():
    secret = "whsec_topsecret"
    ts = "1738713600"
    body = b'{"event":"payment.completed","transaction_id":"tx-1"}'
    sig = f"sha256={_hmac(secret, ts, body)}"
    assert ashtec_activation._verify_ashtec_signature(secret, ts, body, sig)


def test_hmac_verify_accepts_bare_hex_signature():
    secret = "whsec_x"
    ts = "1738713600"
    body = b"{}"
    sig = _hmac(secret, ts, body)  # no "sha256=" prefix
    assert ashtec_activation._verify_ashtec_signature(secret, ts, body, sig)


def test_hmac_verify_rejects_wrong_signature():
    secret = "whsec_x"
    ts = "1738713600"
    body = b"{}"
    assert not ashtec_activation._verify_ashtec_signature(
        secret, ts, body, "sha256=deadbeef" * 8,
    )


def test_hmac_verify_rejects_missing_timestamp():
    assert not ashtec_activation._verify_ashtec_signature(
        "whsec", "", b"{}", "sha256=abc",
    )


def test_hmac_verify_rejects_when_body_tampered():
    secret = "whsec_x"
    ts = "1738713600"
    body = b'{"amount":100}'
    sig = f"sha256={_hmac(secret, ts, body)}"
    tampered = b'{"amount":999999}'
    assert not ashtec_activation._verify_ashtec_signature(
        secret, ts, tampered, sig,
    )


def test_hmac_verify_rejects_when_no_secret_configured():
    assert not ashtec_activation._verify_ashtec_signature(
        "", "ts", b"{}", "sha256=abc",
    )
