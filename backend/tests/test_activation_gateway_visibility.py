"""
Iteration 39 — Validate the SolesPay visibility fix on /(app)/activation.
Backend contract tests for:
  - PUT /api/admin/payment-gateways toggling soleas_enabled / ashtec_enabled
  - GET /api/settings/payments returning correct per-gateway flags
    while preserving the legacy `soleaspay_enabled` = auto_enabled semantics.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
           open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()

ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _set_gw(headers, **body):
    r = requests.put(f"{BASE_URL}/api/admin/payment-gateways", json=body, headers=headers, timeout=15)
    assert r.status_code == 200, f"PUT gw failed: {r.status_code} {r.text}"
    return r.json()


def _get_settings():
    r = requests.get(f"{BASE_URL}/api/settings/payments", timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


class TestPaymentGatewayVisibility:
    def test_disable_soleas_but_keep_ashtec(self, admin_headers):
        """Case (1) — SolesPay OFF, Ashtech ON.
        Expected: soleas_enabled=False, ashtec_enabled=True,
        legacy soleaspay_enabled=True (auto_enabled=True via Ashtech).
        """
        _set_gw(admin_headers, active="ashtec", soleas_enabled=False, ashtec_enabled=True)
        s = _get_settings()
        assert s["soleas_enabled"] is False, s
        assert s["ashtec_enabled"] is True, s
        # legacy flag remains True because ashtec keeps auto payments alive
        assert s["soleaspay_enabled"] is True, s
        assert s["auto_enabled"] is True
        assert s["active_gateway"] == "ashtec"

    def test_reenable_soleas(self, admin_headers):
        _set_gw(admin_headers, active="soleas", soleas_enabled=True, ashtec_enabled=True)
        s = _get_settings()
        assert s["soleas_enabled"] is True
        assert s["ashtec_enabled"] is True
        assert s["soleaspay_enabled"] is True

    def test_disable_both_shows_no_auto(self, admin_headers):
        _set_gw(admin_headers, active="soleas", soleas_enabled=False, ashtec_enabled=False)
        s = _get_settings()
        assert s["soleas_enabled"] is False
        assert s["ashtec_enabled"] is False
        assert s["soleaspay_enabled"] is False
        assert s["auto_enabled"] is False
        assert s["active_gateway"] is None

    def test_restore_initial_state(self, admin_headers):
        """Restore initial state (both enabled)."""
        _set_gw(admin_headers, active="ashtec", soleas_enabled=True, ashtec_enabled=True)
        s = _get_settings()
        assert s["soleas_enabled"] is True
        assert s["ashtec_enabled"] is True
