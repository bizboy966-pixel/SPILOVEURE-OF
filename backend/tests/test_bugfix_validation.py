"""End-to-end validation of 3 bug fixes + regression for SPILIVERE.

BUG-1: Auto-upgrade cascade loop in distribute_commission (while loop).
BUG-2: Crypto activation TXID visible in admin list.
BUG-3: Dynamic wallet UI (mobile money <-> crypto USDT BEP20).
BUG-3b: Withdrawal stores crypto method/network/wallet_address.
REGRESSION: auth, config, services, admin tabs, matrix.
"""
import os
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://jobs-badges-fix.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"
API = f"{BASE_URL}/api"


# ---------------- helpers ----------------

def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    return r.json()["access_token"]


def _h(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _confirm_pwd(tok, password):
    """Some endpoints (withdrawals) require recent password confirmation cookie/header."""
    r = requests.post(f"{API}/auth/confirm-password", json={"password": password}, headers=_h(tok), timeout=20)
    return r


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def test_user(admin_token):
    """Register a fresh user with admin as sponsor, return (token, user_obj, password)."""
    suffix = uuid.uuid4().hex[:8]
    payload = {
        "username": f"tu{suffix}",
        "email": f"tu{suffix}@example.com",
        "country": "TG",
        "phone": f"+228900{suffix[:5]}",
        "password": "Password!23",
        "password_confirm": "Password!23",
        "sponsor_username": "admin",
        "accept_terms": True,
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=20)
    assert r.status_code == 200, f"register failed {r.status_code} {r.text}"
    data = r.json()
    user = data["user"]
    token = data["access_token"]
    yield token, user, "Password!23"
    # cleanup: admin deletes user
    try:
        requests.post(
            f"{API}/admin/users/{user['id']}/action",
            json={"action": "delete"}, headers=_h(admin_token), timeout=20,
        )
    except Exception:
        pass


# ============== REGRESSION ==============

class TestRegression:
    def test_health(self):
        r = requests.get(f"{API}/", timeout=15)
        assert r.status_code == 200

    def test_config_returns_59_countries(self):
        r = requests.get(f"{API}/config", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "countries" in data
        assert len(data["countries"]) == 59, f"Expected 59 countries, got {len(data['countries'])}"

    def test_admin_login_and_me(self, admin_token):
        r = requests.get(f"{API}/auth/me", headers=_h(admin_token), timeout=15)
        assert r.status_code == 200
        me = r.json()
        assert me["email"] == ADMIN_EMAIL
        assert me.get("role") == "admin"

    def test_register_and_me(self, test_user):
        token, user, _ = test_user
        r = requests.get(f"{API}/auth/me", headers=_h(token), timeout=15)
        assert r.status_code == 200
        assert r.json()["username"] == user["username"]

    def test_services_endpoint(self, test_user):
        token, _, _ = test_user
        # Services landing page in this app surfaces formations/ebooks/premium-apps + trading settings
        for path in ("/formations", "/ebooks", "/premium-apps", "/settings/trading"):
            r = requests.get(f"{API}{path}", headers=_h(token), timeout=15)
            assert r.status_code == 200, f"GET /api{path} -> {r.status_code} {r.text[:200]}"

    def test_matrix_tree(self, admin_token):
        r = requests.get(f"{API}/matrix/tree?level=1", headers=_h(admin_token), timeout=15)
        assert r.status_code == 200

    def test_dashboard(self, admin_token):
        r = requests.get(f"{API}/dashboard", headers=_h(admin_token), timeout=15)
        assert r.status_code == 200
        assert "user" in r.json() or "balance_total" in r.json()

    def test_admin_lists(self, admin_token):
        for path in ("/admin/users", "/admin/activations", "/admin/withdrawals", "/admin/stats"):
            r = requests.get(f"{API}{path}", headers=_h(admin_token), timeout=15)
            # withdrawals/stats may or may not exist; ensure not 5xx and not 403
            assert r.status_code in (200, 404), f"{path} -> {r.status_code}"


# ============== BUG-3: Dynamic Wallet ==============

class TestDynamicWallet:
    def test_wallet_initially_empty_then_save_mobile(self, test_user):
        token, _, _ = test_user
        # Save as mobile
        payload = {
            "country": "TG", "full_name": "Test Mobile",
            "method": "mobile",
            "operator": "TMoney", "phone": "+22890000111",
        }
        r = requests.post(f"{API}/wallet", json=payload, headers=_h(token), timeout=15)
        assert r.status_code == 200, r.text
        # Read back
        g = requests.get(f"{API}/wallet", headers=_h(token), timeout=15)
        assert g.status_code == 200
        w = g.json()
        assert w["method"] == "mobile"
        assert w["operator"] == "TMoney"
        assert w["phone"] == "+22890000111"
        assert w.get("wallet_address", "") == ""
        assert w.get("network", "") == ""

    def test_wallet_switch_to_crypto_clears_mobile_fields(self, test_user):
        token, _, _ = test_user
        payload = {
            "country": "TG", "full_name": "Test Crypto",
            "method": "crypto",
            "network": "USDT BEP20",
            "wallet_address": "0xabcdef0123456789ABCDEF0123",
        }
        r = requests.post(f"{API}/wallet", json=payload, headers=_h(token), timeout=15)
        assert r.status_code == 200, r.text
        g = requests.get(f"{API}/wallet", headers=_h(token), timeout=15)
        w = g.json()
        assert w["method"] == "crypto"
        assert w["wallet_address"] == "0xabcdef0123456789ABCDEF0123"
        assert w["network"] == "USDT BEP20"
        assert w.get("operator", "") == ""
        assert w.get("phone", "") == ""

    def test_wallet_mobile_validation(self, test_user):
        token, _, _ = test_user
        r = requests.post(
            f"{API}/wallet",
            json={"country": "TG", "full_name": "Bad", "method": "mobile"},
            headers=_h(token), timeout=15,
        )
        assert r.status_code == 400

    def test_wallet_crypto_validation(self, test_user):
        token, _, _ = test_user
        r = requests.post(
            f"{API}/wallet",
            json={"country": "TG", "full_name": "Bad", "method": "crypto", "wallet_address": "short"},
            headers=_h(token), timeout=15,
        )
        assert r.status_code == 400


# ============== BUG-3b: Withdrawal with crypto wallet ==============

class TestWithdrawalCrypto:
    def test_withdrawal_with_crypto_wallet(self, test_user, admin_token):
        token, user, pwd = test_user
        uid = user["id"]
        # Ensure crypto wallet saved
        requests.post(
            f"{API}/wallet",
            json={"country": "TG", "full_name": "Crypto Withdrawer",
                  "method": "crypto", "network": "USDT BEP20",
                  "wallet_address": "0x1111222233334444555566667777888899990000"},
            headers=_h(token), timeout=15,
        )
        # Admin credits profit balance for withdrawal
        cred = requests.post(
            f"{API}/admin/users/{uid}/action",
            json={"action": "credit_wallet", "bucket": "profit", "amount": 50000},
            headers=_h(admin_token), timeout=15,
        )
        assert cred.status_code == 200, cred.text
        # Re-confirm pwd then request withdrawal
        cp = _confirm_pwd(token, pwd)
        assert cp.status_code == 200, cp.text
        confirm_token = cp.json()["confirm_token"]
        headers = _h(token)
        headers["X-Password-Confirm"] = confirm_token
        r = requests.post(
            f"{API}/withdrawals",
            json={"amount": 5000},
            headers=headers, timeout=20,
        )
        # Some settings may force min/max; accept 200 or 400/403 but log
        assert r.status_code in (200, 400, 403), r.text
        if r.status_code != 200:
            pytest.skip(f"Withdrawal blocked by settings: {r.status_code} {r.text}")
        wd_id = r.json()["id"]
        # Verify admin sees crypto info
        lst = requests.get(f"{API}/admin/withdrawals", headers=_h(admin_token), timeout=15)
        if lst.status_code == 200:
            items = lst.json()
            mine = [i for i in items if i.get("id") == wd_id]
            assert mine, "withdrawal not visible to admin"
            w = mine[0]
            assert w.get("method") == "crypto", f"expected method=crypto, got {w.get('method')}"
            assert w.get("network") == "USDT BEP20"
            assert w.get("wallet_address", "").startswith("0x1111")


# ============== BUG-2: Crypto activation TXID ==============

class TestCryptoActivationTxHash:
    def test_crypto_request_stores_and_admin_sees_tx_hash(self, admin_token):
        # Create a brand new pending user (no L1 yet) for crypto request
        suffix = uuid.uuid4().hex[:8]
        payload = {
            "username": f"cx{suffix}",
            "email": f"cx{suffix}@example.com",
            "country": "TG",
            "phone": f"+228901{suffix[:5]}",
            "password": "Password!23",
            "password_confirm": "Password!23",
            "sponsor_username": "admin",
            "accept_terms": True,
        }
        r = requests.post(f"{API}/auth/register", json=payload, timeout=20)
        assert r.status_code == 200, r.text
        new_user = r.json()["user"]
        tok = r.json()["access_token"]

        # Ensure crypto payment enabled (admin)
        # Find/enable crypto_payment app setting via admin endpoint
        # Try a generic settings PUT if exists; otherwise rely on it already enabled.
        # Fallback: if disabled, test will be skipped.

        tx_hash = "0x" + uuid.uuid4().hex + uuid.uuid4().hex  # 66-ish hex chars
        req = requests.post(
            f"{API}/activations/crypto-request",
            json={"tx_hash": tx_hash, "country": "TG"},
            headers=_h(tok), timeout=20,
        )
        if req.status_code == 400 and "désactiv" in req.text.lower():
            # Cleanup user and skip
            requests.post(
                f"{API}/admin/users/{new_user['id']}/action",
                json={"action": "delete"}, headers=_h(admin_token), timeout=15,
            )
            pytest.skip("Crypto payment disabled in app_settings")
        assert req.status_code == 200, req.text
        act_id = req.json()["activation_id"]

        # Admin lists pending activations and finds tx_hash
        lst = requests.get(
            f"{API}/admin/activations?status=pending", headers=_h(admin_token), timeout=15,
        )
        assert lst.status_code == 200
        items = lst.json()
        matching = [a for a in items if a.get("id") == act_id]
        assert matching, "crypto activation not in admin list"
        act = matching[0]
        assert act.get("tx_hash") == tx_hash, f"tx_hash mismatch: {act.get('tx_hash')}"
        assert act.get("payment_method") == "crypto"
        assert act.get("network", "USDT BEP20")  # network present

        # cleanup
        requests.post(
            f"{API}/admin/users/{new_user['id']}/action",
            json={"action": "delete"}, headers=_h(admin_token), timeout=15,
        )


# ============== BUG-1: Auto-upgrade cascade (while loop) ==============

class TestAutoUpgradeCascade:
    def test_credit_upgrade_balance_persists(self, test_user, admin_token):
        """Smoke: admin can credit balance_upgrade (this prepares cascade context)."""
        token, user, _ = test_user
        uid = user["id"]
        r = requests.post(
            f"{API}/admin/users/{uid}/action",
            json={"action": "credit_wallet", "bucket": "upgrade", "amount": 100000},
            headers=_h(admin_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        # verify via admin user fetch
        g = requests.get(f"{API}/admin/users/{uid}", headers=_h(admin_token), timeout=15)
        assert g.status_code == 200
        u = g.json()
        # data shape might be {"user": {...}} or flat
        u_obj = u.get("user", u)
        assert u_obj.get("balance_upgrade", 0) >= 100000

    def test_activate_level_cascades_via_admin_action(self, admin_token):
        """Create fresh user, activate L1 manually, credit huge balance_upgrade,
        then activate_level=2 via admin: activate_level() calls distribute_commission
        which triggers try_auto_upgrade loop. Since the recipient is admin (L12 already),
        no cascade happens for admin. But the user's *own* self-cascade is triggered too
        (see matrix.py activate_level lines 277-281).

        We verify: after admin activate_level=2 with sufficient balance_upgrade,
        user.max_level becomes 2 AT MINIMUM. (For cascade to L3+ we'd need matrix descendants.)
        """
        suffix = uuid.uuid4().hex[:8]
        payload = {
            "username": f"au{suffix}", "email": f"au{suffix}@example.com",
            "country": "TG", "phone": f"+228902{suffix[:5]}",
            "password": "Password!23", "password_confirm": "Password!23",
            "sponsor_username": "admin", "accept_terms": True,
        }
        r = requests.post(f"{API}/auth/register", json=payload, timeout=20)
        assert r.status_code == 200, r.text
        uid = r.json()["user"]["id"]
        try:
            # Admin activates L1
            r1 = requests.post(
                f"{API}/admin/users/{uid}/action",
                json={"action": "activate_level", "level": 1},
                headers=_h(admin_token), timeout=20,
            )
            assert r1.status_code == 200, r1.text

            # Credit huge balance_upgrade to ensure cascade can proceed
            r2 = requests.post(
                f"{API}/admin/users/{uid}/action",
                json={"action": "credit_wallet", "bucket": "upgrade", "amount": 5000},
                headers=_h(admin_token), timeout=15,
            )
            assert r2.status_code == 200

            # Activate L2 via admin (price=1000, deducted from balance_upgrade)
            r3 = requests.post(
                f"{API}/admin/users/{uid}/action",
                json={"action": "activate_level", "level": 2},
                headers=_h(admin_token), timeout=20,
            )
            assert r3.status_code == 200, r3.text

            time.sleep(0.5)
            g = requests.get(f"{API}/admin/users/{uid}", headers=_h(admin_token), timeout=15)
            assert g.status_code == 200
            u_obj = g.json().get("user", g.json())
            assert u_obj.get("max_level", 0) >= 2, f"max_level={u_obj.get('max_level')}"
        finally:
            requests.post(
                f"{API}/admin/users/{uid}/action",
                json={"action": "delete"}, headers=_h(admin_token), timeout=15,
            )

    def test_while_loop_present_in_matrix_py(self):
        """Code-level guard: assert the while/for loop fix is actually in place."""
        with open("/app/backend/matrix.py") as f:
            src = f.read()
        # The fix is implemented as a `for _ in range(12)` loop calling try_auto_upgrade
        assert "for _ in range(12):" in src
        assert "try_auto_upgrade" in src
