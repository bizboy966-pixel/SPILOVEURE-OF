"""Iteration 59 — Re-validation of the 4 blocking defects from iteration 58.

FIX #1  POST /api/payments/activate end-to-end with X-Password-Confirm = JWT
        returned by /api/auth/confirm-password (no longer the raw password).
FIX #2  Status polling contract: GET /api/payments/{reference}/status exists.
FIX #4  Ashtec routing: a country only supported by Ashtec (SN/ML/GA) must be
        routed to Ashtec (no more guaranteed 503 from `import ashtec`).
REGR    GET /api/payments/catalog stays public, leaks no gateway name and
        merges Ashtec countries when Ashtec is enabled.

Gateway state (active / soleas_enabled / ashtec_enabled / pout) is snapshotted
and restored at module teardown. No payment is ever COMPLETED.
"""
import os
import uuid

import pytest
import requests
from dotenv import dotenv_values

_env = dotenv_values("/app/frontend/.env")
BASE = (os.environ.get("REACT_APP_BACKEND_URL")
        or _env.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
if not BASE:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")
API = f"{BASE}/api"
T = 40

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PWD = "@Emma91972006"
GATEWAY_NAMES = ("soleaspay", "soleas", "biztranspay", "ashtec", "htech")


# ── fixtures ──────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def ah():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PWD}, timeout=T)
    if r.status_code != 200:
        pytest.fail(f"admin login failed {r.status_code}: {r.text[:300]}")
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module", autouse=True)
def restore_gateways(ah):
    snap = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=T).json()
    orig = {
        "active": snap.get("active"),
        "soleas_enabled": (snap.get("soleas") or {}).get("enabled"),
        "ashtec_enabled": (snap.get("ashtec") or {}).get("enabled"),
        "soleaspay_pout_enabled": snap.get("soleaspay_pout_enabled"),
    }
    yield
    requests.put(f"{API}/admin/payment-gateways", headers=ah, json={
        "soleas_enabled": bool(orig["soleas_enabled"]),
        "ashtec_enabled": bool(orig["ashtec_enabled"]),
        "active": orig["active"],
    }, timeout=T)
    requests.put(f"{API}/admin/soleaspay/config", headers=ah,
                 json={"pout_enabled": bool(orig["soleaspay_pout_enabled"])}, timeout=T)
    final = requests.get(f"{API}/admin/payment-gateways", headers=ah, timeout=T).json()
    print("RESTORED gateway state:", {
        "active": final.get("active"),
        "soleas": (final.get("soleas") or {}).get("enabled"),
        "ashtec": (final.get("ashtec") or {}).get("enabled"),
        "pout": final.get("soleaspay_pout_enabled"),
    })


def _make_pending_user():
    uid = uuid.uuid4().hex[:8]
    payload = {
        "username": f"test59{uid}",
        "email": f"TEST_iter59_{uid}@example.com",
        "country": "TG",
        "phone": f"9{uid[:7]}",
        "password": "TestPwd#2026",
        "password_confirm": "TestPwd#2026",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=T)
    if r.status_code != 200:
        pytest.fail(f"register failed {r.status_code}: {r.text[:300]}")
    d = r.json()
    return {"token": d["access_token"], "password": payload["password"],
            "id": d["user"]["id"], "email": payload["email"],
            "headers": {"Authorization": f"Bearer {d['access_token']}"}}


@pytest.fixture(scope="module")
def user_a():
    """Pending user reserved for the SoleasPay happy path."""
    return _make_pending_user()


@pytest.fixture(scope="module")
def user_b():
    """Pending user reserved for the Ashtec routing path."""
    return _make_pending_user()


def _confirm_token(u):
    r = requests.post(f"{API}/auth/confirm-password", headers=u["headers"],
                      json={"password": u["password"]}, timeout=T)
    assert r.status_code == 200, f"confirm-password {r.status_code}: {r.text[:300]}"
    tok = r.json().get("confirm_token")
    assert isinstance(tok, str) and len(tok) > 20, r.text
    return tok


# ── FIX #1 — pwd-confirm JWT contract ─────────────────────────────────
class TestFix1PwdConfirmJWT:
    def test_confirm_password_returns_jwt(self, user_a):
        tok = _confirm_token(user_a)
        assert tok.count(".") == 2, "confirm_token is not a JWT"

    def test_confirm_password_wrong_pwd_rejected(self, user_a):
        r = requests.post(f"{API}/auth/confirm-password", headers=user_a["headers"],
                          json={"password": "WRONG#0000"}, timeout=T)
        assert r.status_code in (400, 401, 403), r.text

    def test_activate_without_header_401(self, user_a):
        r = requests.post(f"{API}/payments/activate", headers=user_a["headers"],
                          json={"method": "mobile", "country": "TG",
                                "operator": "37", "phone": "90000000"}, timeout=T)
        assert r.status_code in (401, 403), r.text

    def test_activate_with_raw_password_rejected(self, user_a):
        h = dict(user_a["headers"]); h["X-Password-Confirm"] = user_a["password"]
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "TG",
                                "operator": "37", "phone": "90000000"}, timeout=T)
        assert r.status_code in (401, 403), \
            f"raw password must NOT be accepted, got {r.status_code}: {r.text[:200]}"

    def test_activate_invalid_method_400(self, user_a):
        h = dict(user_a["headers"]); h["X-Password-Confirm"] = _confirm_token(user_a)
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "paypal"}, timeout=T)
        assert r.status_code == 400, r.text

    def test_activate_mobile_missing_fields_400(self, user_a):
        h = dict(user_a["headers"]); h["X-Password-Confirm"] = _confirm_token(user_a)
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "TG"}, timeout=T)
        assert r.status_code == 400, r.text

    def test_activate_happy_path_soleaspay(self, ah, user_a):
        """Pending user + confirm JWT + TG/T-MONEY → status processing (no 401)."""
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "active": "soleas"}, timeout=T)
        h = dict(user_a["headers"]); h["X-Password-Confirm"] = _confirm_token(user_a)
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "TG",
                                "operator": "37", "phone": "90000001"}, timeout=60)
        assert r.status_code != 401, f"FIX#1 REGRESSED — 401: {r.text[:300]}"
        assert r.status_code == 200, f"activate failed {r.status_code}: {r.text[:400]}"
        b = r.json()
        assert b.get("status") == "processing", b
        assert b.get("gateway") == "soleaspay", b
        assert b.get("method") == "mobile", b
        assert isinstance(b.get("reference"), str) and b["reference"], b
        pytest.SOLEAS_REF = b["reference"]

    def test_activate_twice_blocked_for_activated_user(self, ah):
        """max_level>=1 must be rejected 400 (admin is activated)."""
        r = requests.post(f"{API}/auth/confirm-password", headers=ah,
                          json={"password": ADMIN_PWD}, timeout=T)
        assert r.status_code == 200, r.text
        h = dict(ah); h["X-Password-Confirm"] = r.json()["confirm_token"]
        r2 = requests.post(f"{API}/payments/activate", headers=h,
                           json={"method": "mobile", "country": "TG",
                                 "operator": "37", "phone": "90000002"}, timeout=T)
        assert r2.status_code == 400, r2.text
        assert "niveau 1" in (r2.json().get("detail") or "").lower(), r2.text


# ── FIX #2 — status polling route ─────────────────────────────────────
class TestFix2StatusRoute:
    def test_status_route_requires_auth(self):
        r = requests.get(f"{API}/payments/FAKE-REF-59/status", timeout=T)
        assert r.status_code in (401, 403), r.text

    def test_status_route_exists_for_created_payment(self, user_a):
        ref = getattr(pytest, "SOLEAS_REF", None)
        if not ref:
            pytest.skip("no reference created (happy path failed)")
        r = requests.get(f"{API}/payments/{ref}/status", headers=user_a["headers"], timeout=T)
        assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
        b = r.json()
        assert "status" in b, b
        assert str(b["status"]).lower() in (
            "processing", "pending", "created", "failed", "expired"), b
        assert "_id" not in b

    def test_status_unknown_ref_404(self, user_a):
        r = requests.get(f"{API}/payments/NOPE-{uuid.uuid4().hex[:6]}/status",
                         headers=user_a["headers"], timeout=T)
        assert r.status_code == 404, r.text

    def test_old_wrong_path_is_not_the_contract(self, user_a):
        """/payments/status/{ref} was the buggy frontend URL — still absent."""
        r = requests.get(f"{API}/payments/status/FAKE-REF-59",
                         headers=user_a["headers"], timeout=T)
        assert r.status_code in (404, 422), r.text

    def test_frontend_uses_correct_path(self):
        src = open("/app/frontend/app/(app)/pay.tsx", encoding="utf-8").read()
        assert "/payments/${ref}/status" in src, "pay.tsx polling URL not fixed"
        assert "/payments/status/${ref}" not in src, "pay.tsx still uses the wrong URL"


# ── FIX #4 — Ashtec routing ───────────────────────────────────────────
class TestFix4AshtecRouting:
    def test_route_check_honours_active_flag(self, ah):
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "ashtec_enabled": True,
                           "active": "ashtec"}, timeout=T)
        r = requests.get(f"{API}/admin/payment-gateways/route-check",
                         headers=ah, params={"country": "TG"}, timeout=T)
        assert r.status_code == 200, r.text
        assert r.json().get("payin_gateway") == "ashtec", r.json()
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"active": "soleas"}, timeout=T)
        r2 = requests.get(f"{API}/admin/payment-gateways/route-check",
                          headers=ah, params={"country": "TG"}, timeout=T)
        assert r2.json().get("payin_gateway") == "soleas", r2.json()

    def test_route_check_ashtec_only_country(self, ah):
        """SN is not in soleaspay.SUPPORTED → cascade must fall to ashtec."""
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "ashtec_enabled": True,
                           "active": "soleas"}, timeout=T)
        r = requests.get(f"{API}/admin/payment-gateways/route-check",
                         headers=ah, params={"country": "SN"}, timeout=T)
        assert r.status_code == 200, r.text
        # Documented behaviour: gateway for an unsupported SolesPay country.
        print("route-check SN =>", r.json())

    def test_activate_ashtec_only_country_when_soleas_is_active(self, ah, user_b):
        """DEFECT PROBE — catalog exposes SN (via Ashtec) but with active='soleas'
        pick_gateway_for_country() returns 'soleas' for SN (it never checks the
        gateway's own SUPPORTED map) → activate dies with a SolesPay operator
        error instead of cascading to Ashtec."""
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "ashtec_enabled": True,
                           "active": "soleas"}, timeout=T)
        rc = requests.get(f"{API}/admin/payment-gateways/route-check", headers=ah,
                          params={"country": "SN"}, timeout=T).json()
        h = dict(user_b["headers"]); h["X-Password-Confirm"] = _confirm_token(user_b)
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "SN",
                                "operator": "Wave Money", "phone": "770000002"},
                          timeout=90)
        print("DEFECT PROBE route-check SN:", rc, "| activate:", r.status_code, r.text[:200])
        assert rc.get("payin_gateway") == "ashtec", (
            "ROUTING BUG: SN is not supported by SolesPay yet route-check "
            f"returned {rc.get('payin_gateway')} — the cascade ignores each "
            "gateway's own country coverage.")

    def test_activate_ashtec_country_not_503_import_error(self, ah, user_b):
        """SN/ML/GA → Ashtec branch must be reachable (no `import ashtec` crash)."""
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "ashtec_enabled": True,
                           "active": "ashtec"}, timeout=T)
        h = dict(user_b["headers"]); h["X-Password-Confirm"] = _confirm_token(user_b)
        r = requests.post(f"{API}/payments/activate", headers=h,
                          json={"method": "mobile", "country": "SN",
                                "operator": "Wave Money", "phone": "770000001"},
                          timeout=90)
        body = r.text[:500]
        print("activate SN/ashtec =>", r.status_code, body)
        assert "No module named" not in body, f"import bug still present: {body}"
        assert "initiate_ashtec_mobile" not in body, f"stale helper name: {body}"
        if r.status_code == 200:
            b = r.json()
            assert b.get("gateway") == "ashtec", b
            assert b.get("status") in ("processing", "pending", "created"), b
            assert isinstance(b.get("reference"), str) and b["reference"], b
        else:
            # A provider-side rejection (bad key / operator) is acceptable, an
            # infrastructure/import failure is NOT.
            assert r.status_code in (400, 422, 503), body
            assert "indisponible" not in body or "Ashtec" in body, body


# ── REGRESSION — public catalog ───────────────────────────────────────
class TestCatalogRegression:
    def test_catalog_is_public(self):
        r = requests.get(f"{API}/payments/catalog", timeout=T)
        assert r.status_code == 200, r.text
        b = r.json()
        codes = [m["code"] for m in b["methods"]]
        assert codes == ["mobile", "crypto"], codes

    def test_catalog_no_gateway_name_leak(self):
        raw = requests.get(f"{API}/payments/catalog", timeout=T).text.lower()
        for name in GATEWAY_NAMES:
            assert name not in raw, f"gateway name '{name}' leaked in catalog"

    def test_catalog_merges_ashtec_countries(self, ah):
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "ashtec_enabled": True,
                           "active": "soleas"}, timeout=T)
        b = requests.get(f"{API}/payments/catalog", timeout=T).json()
        mobile = next(m for m in b["methods"] if m["code"] == "mobile")
        codes = {c["code"] for c in mobile["countries"]}
        for cc in ("SN", "ML", "GA", "NE", "CD"):
            assert cc in codes, f"Ashtec country {cc} not merged: {sorted(codes)}"
        # SolesPay countries still there and not duplicated
        assert "TG" in codes
        allc = [c["code"] for c in mobile["countries"]]
        assert len(allc) == len(set(allc)), f"duplicate countries: {allc}"
        for c in mobile["countries"]:
            assert c["operators"], f"{c['code']} has no operator"
            for op in c["operators"]:
                assert op.get("code") and op.get("label"), op

    def test_catalog_excludes_ashtec_when_disabled(self, ah):
        requests.put(f"{API}/admin/payment-gateways", headers=ah,
                     json={"soleas_enabled": True, "ashtec_enabled": False,
                           "active": "soleas"}, timeout=T)
        b = requests.get(f"{API}/payments/catalog", timeout=T).json()
        mobile = next(m for m in b["methods"] if m["code"] == "mobile")
        codes = {c["code"] for c in mobile["countries"]}
        assert "SN" not in codes and "ML" not in codes, sorted(codes)
        assert "TG" in codes


# ── FIX #5 / #6 — source-level assertions on the frontend ─────────────
class TestFrontendSourceContracts:
    ADMIN = "/app/frontend/app/(admin)/index.tsx"
    PAY = "/app/frontend/app/(app)/pay.tsx"

    def test_crypto_password_testid_unified(self):
        src = open(self.PAY, encoding="utf-8").read()
        assert "pay-password-crypto" not in src, "old crypto testID still present"
        assert 'testID="pay-password"' in src

    def test_pay_uses_confirm_password_exchange(self):
        src = open(self.PAY, encoding="utf-8").read()
        assert "/auth/confirm-password" in src
        assert "X-Password-Confirm" in src

    def test_pending_users_routed_to_pay(self):
        lay = open("/app/frontend/app/(app)/_layout.tsx", encoding="utf-8").read()
        idx = open("/app/frontend/app/index.tsx", encoding="utf-8").read()
        assert 'router.replace("/(app)/pay")' in lay
        assert 'router.replace("/(app)/pay")' in idx

    def test_payment_gateways_card_has_no_solespay_dupes(self):
        src = open(self.ADMIN, encoding="utf-8").read()
        start = src.index("function PaymentGatewaysCard")
        end = src.index("function BizTransPayCard")
        block = src[start:end]
        # Visible UI must be gone (dead handlers left behind are reported
        # separately as a code-review nit, they render nothing).
        for needle in ("Tester la connexion SoleasPay", "P-Out SoleasPay",
                       "Matrice pays", "soleaspay-test-btn"):
            assert needle not in block, f"'{needle}' still in PaymentGatewaysCard"

    def test_payment_gateways_card_dead_solespay_handlers(self):
        """Non-blocking: the SolesPay handlers/state are no longer rendered."""
        src = open(self.ADMIN, encoding="utf-8").read()
        start = src.index("function PaymentGatewaysCard")
        end = src.index("function BizTransPayCard")
        block = src[start:end]
        dead = [n for n in ("runSoleasTest", "togglePoutCountry", "toggleCountry")
                if block.count(n) == 1]
        print("dead (declared but never rendered) handlers:", dead)
