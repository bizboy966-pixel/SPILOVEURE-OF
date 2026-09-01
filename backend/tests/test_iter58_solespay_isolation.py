"""Iteration 58 — SolesPay ISOLATED admin surface + unified /payments/*.

Covers the review request:
  - /api/admin/soleaspay/config  (GET masked / auth guard / PUT partial)
  - /api/admin/soleaspay/country-matrix
  - /api/admin/soleaspay/test
  - /api/payments/catalog (public, no gateway name leak)
  - /api/payments/activate (pwd-confirm gate + server routing, NO real
    gateway call is ever triggered — all payloads fail before the HTTP call)
  - /api/webhooks/soleaspay hybrid verification
  - non-regression: /api/settings/payments, /api/admin/payment-gateways

State is snapshotted and restored at module teardown.
"""
import hashlib
import hmac
import json
import os
import time
import uuid

import pytest
import requests
from dotenv import dotenv_values

_env = dotenv_values("/app/frontend/.env")
BASE = (os.environ.get("REACT_APP_BACKEND_URL") or _env.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
if not BASE:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")
API = f"{BASE}/api"

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PWD = "@Emma91972006"
GATEWAY_NAMES = ("soleaspay", "soleas", "biztranspay", "ashtec")


# ── fixtures ──────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=20)
    if r.status_code != 200:
        pytest.fail(f"admin login failed {r.status_code}: {r.text[:300]}")
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def ah(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module", autouse=True)
def restore(ah):
    snap = requests.get(f"{API}/admin/soleaspay/config", headers=ah, timeout=20).json()
    orig = {
        "enabled": snap.get("enabled"),
        "pout_enabled": snap.get("pout_enabled"),
        "countries": {c["code"]: c["enabled"] for c in snap.get("countries", [])},
    }
    yield
    requests.put(f"{API}/admin/soleaspay/config", headers=ah,
                 json={"enabled": bool(orig["enabled"]), "pout_enabled": bool(orig["pout_enabled"])}, timeout=20)
    # restore matrix: only persist explicit False entries; True == default
    requests.put(f"{API}/admin/soleaspay/country-matrix", headers=ah,
                 json={"matrix": {k: v for k, v in orig["countries"].items() if v is False}}, timeout=20)


@pytest.fixture(scope="module")
def new_user():
    """Fresh, non-activated user (max_level=0) for /payments/activate."""
    uid = uuid.uuid4().hex[:8]
    payload = {
        "username": f"test_{uid}",
        "email": f"TEST_iter58_{uid}@example.com",
        "country": "TG",
        "phone": f"9{uid[:7]}",
        "password": "TestPwd#2026",
        "password_confirm": "TestPwd#2026",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=25)
    if r.status_code != 200:
        pytest.fail(f"register failed {r.status_code}: {r.text[:300]}")
    data = r.json()
    yield {"token": data["access_token"], "password": payload["password"], "id": data["user"]["id"]}


@pytest.fixture(scope="module")
def user_headers(new_user):
    return {"Authorization": f"Bearer {new_user['token']}"}


@pytest.fixture(scope="module")
def pwd_confirm_token(new_user, user_headers):
    r = requests.post(f"{API}/auth/confirm-password", headers=user_headers,
                      json={"password": new_user["password"]}, timeout=20)
    if r.status_code != 200:
        pytest.fail(f"confirm-password failed {r.status_code}: {r.text[:300]}")
    return r.json()["confirm_token"]


# ── /admin/soleaspay/config ───────────────────────────────────────────
class TestAdminConfig:
    def test_requires_auth(self):
        assert requests.get(f"{API}/admin/soleaspay/config", timeout=20).status_code in (401, 403)

    def test_non_admin_forbidden(self, user_headers):
        r = requests.get(f"{API}/admin/soleaspay/config", headers=user_headers, timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_get_masks_secrets(self, ah):
        r = requests.get(f"{API}/admin/soleaspay/config", headers=ah, timeout=20)
        assert r.status_code == 200, r.text
        b = r.json()
        for k in ("enabled", "public_key", "secret_key", "webhook_hash",
                  "webhook_secret", "countries", "pout_enabled", "pout_country_matrix"):
            assert k in b, f"missing key {k}"
        for k in ("public_key", "secret_key", "webhook_hash", "webhook_secret"):
            v = b.get(k) or ""
            if b.get(f"{k}_set"):
                assert "\u2022" in v, f"{k} not masked: {v!r}"
        assert isinstance(b["countries"], list) and len(b["countries"]) > 0
        assert {c["code"] for c in b["countries"]} >= {"TG", "BJ", "CI", "BF", "CM"}
        for c in b["countries"]:
            assert isinstance(c["enabled"], bool)
            assert isinstance(c["operators"], list)
        assert "_id" not in json.dumps(b)

    def test_put_partial_and_delete_semantics(self, ah):
        # set a throwaway webhook_hash, verify it is stored (masked) then DELETE it
        r = requests.put(f"{API}/admin/soleaspay/config", headers=ah,
                         json={"webhook_hash": "TESTHASH_iter58_abcdef"}, timeout=20)
        assert r.status_code == 200, r.text
        assert r.json()["webhook_hash_set"] is True
        assert "TESTHASH_iter58_abcdef" not in json.dumps(r.json())
        # empty string = no-op
        r2 = requests.put(f"{API}/admin/soleaspay/config", headers=ah,
                          json={"webhook_hash": ""}, timeout=20)
        assert r2.json()["webhook_hash_set"] is True
        # DELETE clears
        r3 = requests.put(f"{API}/admin/soleaspay/config", headers=ah,
                          json={"webhook_hash": "DELETE"}, timeout=20)
        assert r3.json()["webhook_hash_set"] is False
        assert (r3.json()["webhook_hash"] or "") == ""

    def test_pout_toggle_roundtrip(self, ah):
        for want in (True, False):
            r = requests.put(f"{API}/admin/soleaspay/config", headers=ah,
                             json={"pout_enabled": want}, timeout=20)
            assert r.status_code == 200 and r.json()["pout_enabled"] is want
            g = requests.get(f"{API}/admin/soleaspay/config", headers=ah, timeout=20).json()
            assert g["pout_enabled"] is want

    def test_country_matrix_persists(self, ah):
        r = requests.put(f"{API}/admin/soleaspay/country-matrix", headers=ah,
                         json={"matrix": {"TG": True, "BJ": False, "ci": 0}}, timeout=20)
        assert r.status_code == 200, r.text
        assert r.json()["matrix"] == {"TG": True, "BJ": False, "CI": False}
        by = {c["code"]: c["enabled"]
              for c in requests.get(f"{API}/admin/soleaspay/config", headers=ah, timeout=20).json()["countries"]}
        assert by["TG"] is True and by["BJ"] is False and by["CI"] is False
        # reset
        requests.put(f"{API}/admin/soleaspay/country-matrix", headers=ah, json={"matrix": {}}, timeout=20)

    def test_country_matrix_bad_payload(self, ah):
        r = requests.put(f"{API}/admin/soleaspay/country-matrix", headers=ah,
                         json={"matrix": "nope"}, timeout=20)
        assert r.status_code in (400, 422), r.text

    def test_admin_test_endpoint(self, ah):
        r = requests.post(f"{API}/admin/soleaspay/test", headers=ah, timeout=45)
        assert r.status_code == 200, r.text
        b = r.json()
        assert "ok" in b and "detail" in b


# ── isolation from the legacy gateway surface ─────────────────────────
class TestIsolation:
    def test_both_admin_surfaces_respond(self, ah):
        a = requests.get(f"{API}/admin/soleaspay/config", headers=ah, timeout=20)
        b = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=20)
        assert a.status_code == 200 and b.status_code == 200
        pg = b.json()
        assert "soleaspay_pout_enabled" in pg
        assert isinstance(pg.get("ashtec"), dict) and "enabled" in pg["ashtec"]
        assert isinstance(pg.get("soleas"), dict) and "enabled" in pg["soleas"]

    def test_master_toggle_shared_storage(self, ah):
        requests.put(f"{API}/admin/soleaspay/config", headers=ah, json={"enabled": False}, timeout=20)
        pg = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=20).json()
        assert pg["soleas"]["enabled"] is False
        requests.put(f"{API}/admin/soleaspay/config", headers=ah, json={"enabled": True}, timeout=20)
        pg = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=20).json()
        assert pg["soleas"]["enabled"] is True

    def test_soleaspay_config_does_not_alter_other_gateways(self, ah):
        before = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=20).json()
        requests.put(f"{API}/admin/soleaspay/config", headers=ah, json={"pout_enabled": False}, timeout=20)
        after = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=20).json()
        assert before.get("ashtec") == after.get("ashtec")
        assert before.get("active") == after.get("active")


# ── public catalog ────────────────────────────────────────────────────
class TestCatalog:
    def test_public_no_auth(self):
        r = requests.get(f"{API}/payments/catalog", timeout=20)
        assert r.status_code == 200, r.text
        b = r.json()
        assert {m["code"] for m in b["methods"]} == {"mobile", "crypto"}
        for m in b["methods"]:
            assert isinstance(m["available"], bool) and m.get("label")

    def test_no_gateway_name_leak(self):
        raw = json.dumps(requests.get(f"{API}/payments/catalog", timeout=20).json()).lower()
        for name in GATEWAY_NAMES:
            assert name not in raw, f"gateway name '{name}' leaked in /payments/catalog"

    def test_reflects_master_off(self, ah):
        requests.put(f"{API}/admin/soleaspay/config", headers=ah, json={"enabled": False}, timeout=20)
        time.sleep(0.3)
        mobile = next(m for m in requests.get(f"{API}/payments/catalog", timeout=20).json()["methods"]
                      if m["code"] == "mobile")
        assert mobile["available"] is False or not mobile.get("countries")
        requests.put(f"{API}/admin/soleaspay/config", headers=ah, json={"enabled": True}, timeout=20)
        time.sleep(0.3)
        mobile = next(m for m in requests.get(f"{API}/payments/catalog", timeout=20).json()["methods"]
                      if m["code"] == "mobile")
        assert mobile["available"] is True and len(mobile["countries"]) > 0
        c0 = mobile["countries"][0]
        assert c0["operators"] and isinstance(c0["operators"][0]["code"], str)

    def test_reflects_country_matrix(self, ah):
        requests.put(f"{API}/admin/soleaspay/country-matrix", headers=ah,
                     json={"matrix": {"BJ": False}}, timeout=20)
        mobile = next(m for m in requests.get(f"{API}/payments/catalog", timeout=20).json()["methods"]
                      if m["code"] == "mobile")
        assert "BJ" not in {c["code"] for c in mobile["countries"]}
        requests.put(f"{API}/admin/soleaspay/country-matrix", headers=ah, json={"matrix": {}}, timeout=20)
        mobile = next(m for m in requests.get(f"{API}/payments/catalog", timeout=20).json()["methods"]
                      if m["code"] == "mobile")
        assert "BJ" in {c["code"] for c in mobile["countries"]}


# ── /payments/activate (never reaches the real gateway) ───────────────
class TestActivate:
    def test_requires_auth(self):
        r = requests.post(f"{API}/payments/activate", json={"method": "mobile"}, timeout=20)
        assert r.status_code in (401, 403)

    def test_requires_password_confirm_header(self, user_headers):
        r = requests.post(f"{API}/payments/activate", headers=user_headers,
                          json={"method": "mobile", "country": "TG", "operator": "37", "phone": "90000000"},
                          timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_raw_password_rejected_as_confirm(self, user_headers, new_user):
        """The header must be a pwd_confirm JWT, not the raw password."""
        h = dict(user_headers); h["X-Password-Confirm"] = new_user["password"]
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "TG", "operator": "37", "phone": "90000000"},
                          timeout=20)
        assert r.status_code in (401, 403), r.text

    def test_bad_method(self, user_headers, pwd_confirm_token):
        h = dict(user_headers); h["X-Password-Confirm"] = pwd_confirm_token
        r = requests.post(f"{API}/payments/activate", headers=h, json={"method": "carrier_pigeon"}, timeout=20)
        assert r.status_code == 400, r.text
        assert "invalide" in (r.json().get("detail") or "").lower()

    def test_missing_operator_fails_before_gateway(self, user_headers, pwd_confirm_token):
        h = dict(user_headers); h["X-Password-Confirm"] = pwd_confirm_token
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "TG", "phone": "90000000"}, timeout=20)
        assert r.status_code == 400, r.text

    def test_unsupported_country_fails_before_gateway(self, user_headers, pwd_confirm_token):
        h = dict(user_headers); h["X-Password-Confirm"] = pwd_confirm_token
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "ZZ", "operator": "37", "phone": "90000000"},
                          timeout=20)
        assert r.status_code == 400, r.text

    def test_bad_operator_id_fails_before_gateway(self, user_headers, pwd_confirm_token):
        h = dict(user_headers); h["X-Password-Confirm"] = pwd_confirm_token
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "TG", "operator": "999999", "phone": "90000000"},
                          timeout=20)
        assert r.status_code == 400, r.text

    def test_already_activated_user_blocked(self, ah, admin_token):
        r = requests.post(f"{API}/auth/confirm-password", headers=ah, json={"password": ADMIN_PWD}, timeout=20)
        assert r.status_code == 200, r.text
        h = dict(ah); h["X-Password-Confirm"] = r.json()["confirm_token"]
        r2 = requests.post(f"{API}/payments/activate", headers=h,
                           json={"method": "mobile", "country": "TG", "operator": "37", "phone": "90000000"},
                           timeout=20)
        assert r2.status_code == 400, r2.text
        assert "niveau 1" in (r2.json().get("detail") or "").lower()


# ── frontend contract: status polling path used by /(app)/pay.tsx ─────
class TestStatusPollingContract:
    def test_frontend_polling_path_matches_backend(self, user_headers):
        """iter59: pay.tsx was fixed to poll GET /payments/{ref}/status, which
        is the only route the backend exposes. The old buggy path must 404."""
        src = open("/app/frontend/app/(app)/pay.tsx", encoding="utf-8").read()
        assert "/payments/${ref}/status" in src
        r = requests.get(f"{API}/payments/status/FAKE-REF-123", headers=user_headers, timeout=20)
        assert r.status_code in (404, 422)

    def test_documented_status_route(self, user_headers):
        r = requests.get(f"{API}/payments/FAKE-REF-123/status", headers=user_headers, timeout=20)
        assert r.status_code == 404 and "introuvable" in (r.json().get("detail") or "").lower()


# ── non-regression ────────────────────────────────────────────────────
class TestNonRegression:
    def test_settings_payments(self):
        r = requests.get(f"{API}/settings/payments", timeout=20)
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), dict) and len(r.json()) > 0

    def test_admin_payment_gateways(self, ah):
        r = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=20)
        assert r.status_code == 200
        b = r.json()
        assert "soleaspay_pout_enabled" in b and "ashtec" in b
        assert "soleas_countries" in b and isinstance(b["soleas_countries"], list)

    def test_biztranspay_public_status_still_works(self, user_headers):
        # NB: despite its name this route requires a JWT (pre-existing behaviour).
        r = requests.get(f"{API}/payments/biztranspay/public/status", headers=user_headers, timeout=20)
        assert r.status_code == 200, r.text


# ── webhook (HTTP level, invalid signature must be refused) ───────────
class TestWebhookHttp:
    def test_invalid_signature_refused(self):
        payload = {"reference": f"NOPE-{uuid.uuid4().hex[:6]}", "status": "SUCCESS", "operation": "PAYIN"}
        r = requests.post(f"{API}/webhooks/soleaspay", json=payload,
                          headers={"x-signature": "deadbeef"}, timeout=20)
        assert r.status_code in (401, 403), f"{r.status_code} {r.text[:200]}"

    def test_valid_hmac_accepted_unknown_reference(self):
        secret = os.environ.get("SOLEASPAY_WEBHOOK_SECRET") \
            or dotenv_values("/app/backend/.env").get("SOLEASPAY_WEBHOOK_SECRET") or ""
        if not secret:
            pytest.skip("no SOLEASPAY_WEBHOOK_SECRET configured")
        body = json.dumps({"reference": f"UNKNOWN-{uuid.uuid4().hex[:8]}",
                           "status": "SUCCESS", "operation": "PAYIN"}).encode()
        sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        r = requests.post(f"{API}/webhooks/soleaspay", data=body,
                          headers={"Content-Type": "application/json", "x-signature": sig}, timeout=20)
        assert r.status_code in (200, 202, 404), f"{r.status_code} {r.text[:200]}"


# ── webhook hybrid verifier (unit) ────────────────────────────────────
class TestWebhookUnit:
    def test_hmac_ok(self):
        import soleaspay
        body = b'{"reference":"A","status":"SUCCESS"}'
        sig = hmac.new(b"s3cr3t", body, hashlib.sha256).hexdigest()
        ok, m = soleaspay.verify_webhook_hybrid(raw_body=body, event=json.loads(body),
                                                headers={"x-signature": sig},
                                                hmac_secret="s3cr3t", webhook_hash="")
        assert ok and m == "hmac"

    def test_hash_body_and_header(self):
        import soleaspay
        p = {"hash": "tok-1"}
        ok, m = soleaspay.verify_webhook_hybrid(raw_body=json.dumps(p).encode(), event=p,
                                                headers={}, hmac_secret="", webhook_hash="tok-1")
        assert ok and m == "hash"
        ok2, m2 = soleaspay.verify_webhook_hybrid(raw_body=b"{}", event={},
                                                   headers={"verif-hash": "tok-2"},
                                                   hmac_secret="", webhook_hash="tok-2")
        assert ok2 and m2 == "hash"

    def test_rejects_bad(self):
        import soleaspay
        ok, _ = soleaspay.verify_webhook_hybrid(raw_body=b"{}", event={"hash": "WRONG"},
                                                 headers={}, hmac_secret="", webhook_hash="right")
        assert not ok
        ok2, _ = soleaspay.verify_webhook_hybrid(raw_body=b'{"a":1}', event={"a": 1},
                                                  headers={"x-signature": "bad"},
                                                  hmac_secret="right", webhook_hash="")
        assert not ok2
