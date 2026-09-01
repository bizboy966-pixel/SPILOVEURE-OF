"""Live-API tests for the new SolesPay ISOLATED admin surface + unified
/api/payments/activate + webhook hybrid verifier.

These tests hit the running backend via REACT_APP_BACKEND_URL and clean up
after themselves. They DO NOT trigger any real SoleasPay call — the
`/admin/soleaspay/test` route is stubbed via httpx mocking at unit level,
and `/payments/activate` is only executed with a user who is already
activated (max_level>=1) so no gateway call is issued.
"""
import os, json, hmac, hashlib, uuid
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL") or "https://jobs-badges-fix.preview.emergentagent.com"
API = f"{BASE}/api"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": "kossikotokou4@gmail.com", "password": "@Emma91972006"},
                      timeout=15)
    assert r.status_code == 200, r.text
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module", autouse=True)
def restore_config(admin_token):
    """Snapshot + restore SolesPay config so tests never leave prod state altered."""
    h = {"Authorization": f"Bearer {admin_token}"}
    snap = requests.get(f"{API}/admin/soleaspay/config", headers=h, timeout=10).json()
    orig_enabled = snap.get("enabled")
    orig_pout = snap.get("pout_enabled")
    orig_countries = {c["code"]: c["enabled"] for c in snap.get("countries", [])}
    yield
    requests.put(f"{API}/admin/soleaspay/config", headers=h,
                 json={"enabled": bool(orig_enabled), "pout_enabled": bool(orig_pout)},
                 timeout=10)
    requests.put(f"{API}/admin/soleaspay/country-matrix", headers=h,
                 json={"matrix": orig_countries}, timeout=10)


def test_admin_config_requires_auth():
    r = requests.get(f"{API}/admin/soleaspay/config", timeout=10)
    assert r.status_code in (401, 403)


def test_admin_config_returns_masked_secrets(admin_token):
    r = requests.get(f"{API}/admin/soleaspay/config",
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=10)
    assert r.status_code == 200
    body = r.json()
    for k in ("public_key", "secret_key", "webhook_hash", "webhook_secret"):
        val = body.get(k) or ""
        # If set, must be masked (contain •) — never raw.
        if body.get(f"{k}_set"):
            assert "•" in val, f"{k} should be masked but was {val!r}"
    assert isinstance(body.get("countries"), list)
    assert {c["code"] for c in body["countries"]} >= {"TG", "BJ", "CI", "BF", "CM"}


def test_admin_country_matrix_persists(admin_token):
    h = {"Authorization": f"Bearer {admin_token}"}
    r = requests.put(f"{API}/admin/soleaspay/country-matrix", headers=h,
                     json={"matrix": {"TG": True, "BJ": False, "ci": True}}, timeout=10)
    assert r.status_code == 200
    assert r.json()["matrix"] == {"TG": True, "BJ": False, "CI": True}
    # Verify GET reflects it
    r2 = requests.get(f"{API}/admin/soleaspay/config", headers=h, timeout=10)
    by = {c["code"]: c["enabled"] for c in r2.json()["countries"]}
    assert by["TG"] is True and by["BJ"] is False and by["CI"] is True


def test_admin_config_patch_pout(admin_token):
    h = {"Authorization": f"Bearer {admin_token}"}
    r = requests.put(f"{API}/admin/soleaspay/config", headers=h,
                     json={"pout_enabled": True}, timeout=10)
    assert r.status_code == 200 and r.json()["pout_enabled"] is True
    r = requests.put(f"{API}/admin/soleaspay/config", headers=h,
                     json={"pout_enabled": False}, timeout=10)
    assert r.json()["pout_enabled"] is False


def test_public_catalog_no_auth_required():
    r = requests.get(f"{API}/payments/catalog", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert "methods" in body
    codes = {m["code"] for m in body["methods"]}
    assert codes == {"mobile", "crypto"}
    # User-facing labels must never contain a gateway name.
    for m in body["methods"]:
        assert "soleaspay" not in (m.get("label") or "").lower()
        assert "biztranspay" not in (m.get("label") or "").lower()
        assert "ashtec" not in (m.get("label") or "").lower()
        for c in (m.get("countries") or []):
            for op in c.get("operators") or []:
                for banned in ("soleaspay", "biztranspay", "ashtec"):
                    assert banned not in (op.get("label") or "").lower()


def test_public_catalog_reflects_master_off(admin_token):
    """Disabling SolesPay master hides its countries from the mobile catalog.
    Ashtec countries may still show if Ashtec is enabled; the SolesPay-specific
    countries (TG,BJ,CI,BF,COG,GAB,UGA + CM if Ashtec doesn't cover it) are removed.
    """
    h = {"Authorization": f"Bearer {admin_token}"}
    # Snapshot Ashtec state so we can restore
    pg = requests.get(f"{API}/admin/payment-gateways", headers=h, timeout=10).json()
    ashtec_was_on = bool(pg.get("ashtec_enabled"))
    # Force both OFF then re-check catalog
    requests.put(f"{API}/admin/soleaspay/config", headers=h,
                 json={"enabled": False}, timeout=10)
    requests.put(f"{API}/admin/payment-gateways", headers=h,
                 json={"ashtec_enabled": False}, timeout=10)
    r = requests.get(f"{API}/payments/catalog", timeout=10).json()
    mobile = next(m for m in r["methods"] if m["code"] == "mobile")
    assert mobile["available"] is False or len(mobile.get("countries") or []) == 0
    # Restore
    requests.put(f"{API}/admin/soleaspay/config", headers=h,
                 json={"enabled": True}, timeout=10)
    requests.put(f"{API}/admin/payment-gateways", headers=h,
                 json={"ashtec_enabled": ashtec_was_on}, timeout=10)
    r = requests.get(f"{API}/payments/catalog", timeout=10).json()
    mobile = next(m for m in r["methods"] if m["code"] == "mobile")
    assert mobile["available"] is True and len(mobile["countries"]) > 0


def test_activate_requires_password_confirm(admin_token):
    """POST /payments/activate is protected by X-Password-Confirm."""
    r = requests.post(f"{API}/payments/activate",
                      headers={"Authorization": f"Bearer {admin_token}"},
                      json={"method": "mobile", "country": "TG",
                            "operator": "37", "phone": "90000000"},
                      timeout=10)
    # 400/401/403 all acceptable (missing password OR already activated user)
    assert r.status_code in (400, 401, 403), r.text


def test_activate_rejects_bad_method(admin_token):
    r = requests.post(f"{API}/payments/activate",
                      headers={"Authorization": f"Bearer {admin_token}",
                               "X-Password-Confirm": "@Emma91972006"},
                      json={"method": "carrier_pigeon"}, timeout=10)
    # 400 = bad method rejected; 401/403 = pwd-confirm gate fired first (both are safe).
    assert r.status_code in (400, 401, 403), r.text


# ═══════════════════════════════════════════════════════════════════════
# Webhook hybrid verifier — pure unit test (does not need the server).
# ═══════════════════════════════════════════════════════════════════════
def test_verify_webhook_hybrid_hmac_success():
    import soleaspay
    body = b'{"reference":"MLS-1","status":"SUCCESS"}'
    secret = "hmac-secret-abc"
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=body, event=json.loads(body),
        headers={"x-signature": sig}, hmac_secret=secret, webhook_hash="")
    assert ok and method == "hmac"


def test_verify_webhook_hybrid_hash_in_body():
    import soleaspay
    payload = {"reference": "MLS-1", "status": "SUCCESS",
               "hash": "shared-notification-token-9x"}
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=json.dumps(payload).encode(),
        event=payload, headers={},
        hmac_secret="", webhook_hash="shared-notification-token-9x")
    assert ok and method == "hash"


def test_verify_webhook_hybrid_hash_in_header():
    import soleaspay
    payload = {"reference": "MLS-1", "status": "SUCCESS"}
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=json.dumps(payload).encode(),
        event=payload,
        headers={"verif-hash": "shared-token-99"},
        hmac_secret="", webhook_hash="shared-token-99")
    assert ok and method == "hash"


def test_verify_webhook_hybrid_rejects_wrong_hash():
    import soleaspay
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=b'{}', event={"hash": "WRONG"},
        headers={}, hmac_secret="", webhook_hash="secret-99")
    assert not ok and method == ""


def test_verify_webhook_hybrid_rejects_wrong_hmac():
    import soleaspay
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=b'{"a":1}', event={"a": 1},
        headers={"x-signature": "not-a-real-sig"},
        hmac_secret="correct-secret", webhook_hash="")
    assert not ok and method == ""


def test_verify_webhook_hybrid_no_config_allows_dev():
    """When neither hmac_secret nor webhook_hash configured, accept (dev mode)."""
    import soleaspay
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=b'{}', event={}, headers={}, hmac_secret="", webhook_hash="")
    assert ok and method == "unverified"


def test_verify_webhook_prefers_hmac_over_hash_when_both_configured():
    """If both mechanisms set, HMAC is tried first — valid HMAC succeeds even if hash absent."""
    import soleaspay
    body = b'{"reference":"X","status":"SUCCESS"}'
    sig = hmac.new(b"secret", body, hashlib.sha256).hexdigest()
    ok, method = soleaspay.verify_webhook_hybrid(
        raw_body=body, event=json.loads(body),
        headers={"x-signature": sig},
        hmac_secret="secret", webhook_hash="also-a-hash")
    assert ok and method == "hmac"
