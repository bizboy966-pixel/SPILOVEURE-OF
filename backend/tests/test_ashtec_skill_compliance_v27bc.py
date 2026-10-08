"""v27bc (2026-03-05) — AshTech Pay Direct API v1 skill compliance.

Validates the integration against the OFFICIAL documentation at
https://doc.ashtechpay.com :

  • /docs/authentication        → Bearer `ak_...` key, mandatory `user_id`
  • /docs/direct-api/mobile-money → POST /v1/collect body schema
  • /docs/direct-api/payment-flows → USSD Push / Wave / OTP SMS / OTP USSD
  • /docs/direct-api/webhooks    → HMAC-SHA256(secret, ts + "." + raw)
  • /docs/reference/transaction  → GET /v1/transaction/:id?user_id=...
  • /docs/errors                 → 400/401/403/404/409/429/500 codes
"""
import hashlib
import hmac
import inspect
import pathlib

import ashtecpay
import ashtec_activation


def test_base_url_is_official_production_host():
    """Base URL MUST be `https://www.ashtechpay.com` per the doc."""
    assert ashtecpay.BASE_URL == "https://www.ashtechpay.com"


def test_initiate_payment_signature_includes_user_id():
    """`user_id` must be an explicit keyword-only parameter — the skill
    requires it in every /v1/collect body."""
    sig = inspect.signature(ashtecpay.initiate_payment)
    assert "user_id" in sig.parameters, (
        "initiate_payment MUST accept user_id (mandatory per skill)"
    )
    assert sig.parameters["user_id"].kind == inspect.Parameter.KEYWORD_ONLY


def test_initiate_payment_rejects_missing_user_id():
    """Caller forgetting user_id must get a clear error, not a silent fail."""
    import asyncio
    r = asyncio.get_event_loop().run_until_complete(
        ashtecpay.initiate_payment(
            api_key="ak_test", user_id="", amount=100, currency="XOF",
            phone="+22891000000", operator="MTN Money", country_code="TG",
        )
    )
    assert r["success"] is False
    assert r["error"] == "user_id_required"


def test_verify_payment_signature_includes_user_id():
    """GET /v1/transaction/:id?user_id=... — user_id REQUIRED by the skill."""
    sig = inspect.signature(ashtecpay.verify_payment)
    assert "user_id" in sig.parameters


def test_confirm_otp_helper_exists():
    """New helper function for OTP confirmation that reuses the session
    reference instead of our merchant reference."""
    assert hasattr(ashtecpay, "confirm_otp")
    sig = inspect.signature(ashtecpay.confirm_otp)
    for required in ("api_key", "user_id", "session_reference", "otp"):
        assert required in sig.parameters, f"confirm_otp missing {required}"


def test_webhook_signature_algorithm_matches_skill():
    """HMAC-SHA256 over `timestamp + "." + raw_body` using whsec_... secret.
    Verified against the exact algorithm in /docs/direct-api/webhooks."""
    secret = "whsec_test_secret_12345"
    timestamp = "1735643554"
    raw_body = b'{"event":"payment.completed","transaction_id":"txn_123"}'
    expected = hmac.new(
        secret.encode(),
        f"{timestamp}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()
    assert ashtec_activation._verify_ashtec_signature(
        secret, timestamp, raw_body, f"sha256={expected}"
    ) is True
    # Wrong secret → rejected
    assert ashtec_activation._verify_ashtec_signature(
        "whsec_wrong_secret", timestamp, raw_body, f"sha256={expected}"
    ) is False
    # Tampered body → rejected
    assert ashtec_activation._verify_ashtec_signature(
        secret, timestamp, b'{"tampered":true}', f"sha256={expected}"
    ) is False
    # Missing secret → rejected
    assert ashtec_activation._verify_ashtec_signature(
        "", timestamp, raw_body, f"sha256={expected}"
    ) is False


def test_normalize_status_maps_success_to_paid():
    """Per the doc, /v1/transaction returns `pending|success|failed`.
    We canonicalize `success` → `paid` internally."""
    assert ashtecpay.normalize_status("success") == "paid"
    assert ashtecpay.normalize_status("pending") == "pending"
    assert ashtecpay.normalize_status("failed") == "failed"


def test_user_id_resolver_prefers_db_over_env():
    """_get_user_id must prioritize the admin-set value over env fallback."""
    src = pathlib.Path("/app/backend/ashtec_activation.py").read_text(encoding="utf-8")
    assert "async def _get_user_id(db)" in src
    assert 'cfg.get("ashtec_user_id")' in src
    assert "ASHTECH_USER_ID" in src


def test_server_payment_gateway_config_exposes_user_id():
    """ashtec_user_id must be a persisted field in app_settings and the
    admin can update it via PATCH /admin/payment-gateways."""
    src = pathlib.Path("/app/backend/server.py").read_text(encoding="utf-8")
    assert '"ashtec_user_id"' in src
    assert "ashtec_user_id: Optional[str] = None" in src


def test_activation_endpoint_passes_user_id_to_collect():
    """The server-side activation flow MUST pass user_id to initiate_payment."""
    src = pathlib.Path("/app/backend/ashtec_activation.py").read_text(encoding="utf-8")
    assert "user_id=await _get_user_id(db)" in src, (
        "activation flow must pass user_id to ashtecpay.initiate_payment"
    )


def test_otp_confirm_reuses_session_reference():
    """Per the doc §4 : the OTP confirmation MUST send the exact session
    reference returned by the first otp_required response, NOT our own
    merchant reference."""
    src = pathlib.Path("/app/backend/ashtec_activation.py").read_text(encoding="utf-8")
    assert "ashtecpay_session_reference" in src, (
        "The persisted OTP session reference must be reused on confirm"
    )
    assert "ashtecpay.confirm_otp" in src


def test_verify_payment_passes_user_id():
    """Both the user polling flow and the webhook re-verification MUST
    include user_id (query string per the skill)."""
    src = pathlib.Path("/app/backend/ashtec_activation.py").read_text(encoding="utf-8")
    # Count occurrences of verify_payment with user_id argument
    verify_calls_with_uid = src.count("user_id=await _get_user_id(db)")
    assert verify_calls_with_uid >= 3, (
        f"Expected ≥3 user_id injections (collect + 2 verify), got "
        f"{verify_calls_with_uid}"
    )
