"""Audit & Recompute admin endpoints tests."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://spiloveure-deploy.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- AUTH GATING ----------
class TestAuthGating:
    def test_audit_unauth(self):
        r = requests.get(f"{BASE_URL}/api/admin/audit", timeout=20)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_audit_user_unauth(self):
        r = requests.get(f"{BASE_URL}/api/admin/audit/user/admin", timeout=20)
        assert r.status_code in (401, 403)

    def test_recompute_unauth(self):
        r = requests.post(f"{BASE_URL}/api/admin/audit/recompute?dry_run=true", timeout=20)
        assert r.status_code in (401, 403)


# ---------- GET /api/admin/audit ----------
class TestAuditReport:
    def test_audit_report_structure(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/audit", headers=admin_headers, timeout=60)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "stats" in data and "summary" in data and "severity" in data and "issues" in data
        assert data["stats"]["users_total"] > 0
        assert "users_by_level" in data["stats"]
        # preview should be clean (no anomalies)
        # We don't strictly assert empty (in case env shifted), but log:
        print(f"issues_total={data['stats']['issues_total']} summary={data['summary']}")


# ---------- GET /api/admin/audit/user/{username} ----------
class TestAuditUser:
    def test_audit_user_admin(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/audit/user/admin", headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        user = data["user"]
        assert user["username"].lower() == "admin"
        # password_hash must not leak
        assert "password_hash" not in user
        assert data["sponsor"] is None
        assert isinstance(data["direct_downline"], list)
        assert isinstance(data["descendants_per_level"], dict)
        assert isinstance(data["commissions_received_per_level"], dict)
        # admin role => pending_upgrade.can_upgrade_now should be False or None
        pu = data.get("pending_upgrade")
        if pu is not None:
            assert pu.get("can_upgrade_now") is False

    def test_audit_user_case_insensitive(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/audit/user/Admin", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["user"]["username"].lower() == "admin"

    def test_audit_user_not_found(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/audit/user/xyz_nonexistent_zzz_999", headers=admin_headers, timeout=30)
        assert r.status_code == 404


# ---------- POST /api/admin/audit/recompute ----------
class TestRecompute:
    def test_recompute_dry_run(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/audit/recompute?dry_run=true",
            headers=admin_headers, timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ("counter_updates", "orphan_placements_deleted", "upgrades_triggered", "admin_placements_restored", "dry_run", "totals"):
            assert key in data, f"missing key {key}"
        assert data["dry_run"] is True
        assert "counter_updates" in data["totals"]

    def test_recompute_apply_no_ops(self, admin_headers):
        # Apply but with all fix-flags disabled — should be no-op (preview is clean)
        r = requests.post(
            f"{BASE_URL}/api/admin/audit/recompute"
            f"?dry_run=false&clean_orphan_placements=false&trigger_pending_upgrades=false&restore_admin_placements=false",
            headers=admin_headers, timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["dry_run"] is False
        # counter_updates may still apply (recompute always recalcs), but orphans/admin/upgrades should be empty
        assert data["orphan_placements_deleted"] == []
        assert data["upgrades_triggered"] == []
        assert data["admin_placements_restored"] == []

    def test_recompute_does_not_touch_balances(self, admin_headers):
        # Read admin before
        r1 = requests.get(f"{BASE_URL}/api/admin/audit/user/admin", headers=admin_headers, timeout=30)
        assert r1.status_code == 200
        u1 = r1.json()["user"]
        bp_before = float(u1.get("balance_profit") or 0)
        bu_before = float(u1.get("balance_upgrade") or 0)
        # Apply recompute (default flags)
        r2 = requests.post(
            f"{BASE_URL}/api/admin/audit/recompute?dry_run=false",
            headers=admin_headers, timeout=60,
        )
        assert r2.status_code == 200, r2.text
        # Read admin after
        r3 = requests.get(f"{BASE_URL}/api/admin/audit/user/admin", headers=admin_headers, timeout=30)
        assert r3.status_code == 200
        u2 = r3.json()["user"]
        bp_after = float(u2.get("balance_profit") or 0)
        bu_after = float(u2.get("balance_upgrade") or 0)
        assert bp_before == bp_after, f"balance_profit changed: {bp_before} -> {bp_after}"
        assert bu_before == bu_after, f"balance_upgrade changed: {bu_before} -> {bu_after}"
