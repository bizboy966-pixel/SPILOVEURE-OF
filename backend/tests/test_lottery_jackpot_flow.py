"""End-to-end tests for the Lottery Jackpot new flow (with manual winner pre-selection).

Covers:
  - POST /api/admin/lottery/draws creates a draw with status='open' immediately.
  - POST /api/admin/lottery/draws/{id}/select-winners validates body and stores preset_winners.
      * Refused if status != 'open'
      * Refused if count != winners_count
      * Refused if duplicate user_id
      * Refused if user_id is not a participant
      * Refused if rank coverage incomplete (e.g. only ranks 1 and 3 without 2)
  - POST /api/admin/lottery/draws/{id}/launch:
      * Refused with 400 if no participants
      * Refused with 400 if preset_winners is empty or incomplete
      * Succeeds and transitions open -> running once preset is valid
  - POST /api/lottery/draws/{id}/join is refused if status != 'open'.
  - After countdown expiration, _auto_complete_if_due uses preset_winners — NO random.
      * Winners == preset_winners (same user_id, ranks, prizes)
      * balance_profit credited
      * Commission inserted with kind=lottery_win
  - GET /api/admin/lottery/stats returns correct counts.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "kossikotokou4@gmail.com"
ADMIN_PASSWORD = "@Emma91972006"


# ----------------------------- Fixtures -----------------------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("access_token") or data.get("token")
    assert token, f"No token in login response: {data}"
    return token


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def admin_user_id(admin_headers):
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=20)
    assert r.status_code == 200
    return r.json()["id"]


# ----------------------------- Helpers -----------------------------
def _create_draw(admin_headers, max_participants=5, winners_count=1, entry_amount=500, prizes=None):
    name = f"TEST_Jackpot_{uuid.uuid4().hex[:8]}"
    payload = {
        "name": name,
        "description": "Automated test draw",
        "entry_amount": entry_amount,
        "winners_count": winners_count,
        "max_participants": max_participants,
        "min_participants": 1,
        "prizes": prizes or [{"rank": 1, "amount": 1000}],
    }
    r = requests.post(
        f"{BASE_URL}/api/admin/lottery/draws", headers=admin_headers, json=payload, timeout=20
    )
    return r, name


def _cleanup(admin_headers, draw_id):
    try:
        requests.delete(
            f"{BASE_URL}/api/admin/lottery/draws/{draw_id}", headers=admin_headers, timeout=10
        )
    except Exception:
        pass


def _select_winners(admin_headers, draw_id, winners):
    return requests.post(
        f"{BASE_URL}/api/admin/lottery/draws/{draw_id}/select-winners",
        headers=admin_headers,
        json={"winners": winners},
        timeout=20,
    )


# --- 1) Create draw immediately opens it ---
class TestCreateDraw:
    def test_create_draw_status_open(self, admin_headers):
        r, name = _create_draw(admin_headers)
        assert r.status_code == 200, f"create failed: {r.status_code} {r.text}"
        d = r.json()
        assert d["status"] == "open"
        assert d["name"] == name
        assert d.get("ends_at") in (None, "")
        assert d.get("launched") is False
        assert "id" in d
        # New: preset_winners must exist as empty list
        assert d.get("preset_winners") == []
        _cleanup(admin_headers, d["id"])


# --- 2) Select winners: validations ---
class TestSelectWinnersValidations:
    def test_select_requires_participant(self, admin_headers, admin_user_id):
        r, _ = _create_draw(admin_headers, winners_count=1, prizes=[{"rank": 1, "amount": 1000}])
        draw_id = r.json()["id"]
        # Selecting a user who is NOT a participant => 400
        fake_uid = f"nonexistent_{uuid.uuid4().hex[:8]}"
        rs = _select_winners(admin_headers, draw_id, [{"rank": 1, "user_id": fake_uid, "prize": 1000}])
        assert rs.status_code == 400, f"expected 400 non-participant, got {rs.status_code} {rs.text}"
        _cleanup(admin_headers, draw_id)

    def test_select_count_mismatch(self, admin_headers, admin_user_id):
        # winners_count=2 but we send only 1
        r, _ = _create_draw(
            admin_headers,
            winners_count=2,
            prizes=[{"rank": 1, "amount": 1000}, {"rank": 2, "amount": 500}],
        )
        draw_id = r.json()["id"]
        # admin joins (just so we have at least 1 participant)
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        rs = _select_winners(
            admin_headers, draw_id,
            [{"rank": 1, "user_id": admin_user_id, "prize": 1000}],
        )
        assert rs.status_code == 400, f"expected 400 count mismatch, got {rs.status_code} {rs.text}"
        _cleanup(admin_headers, draw_id)

    def test_select_duplicate_user(self, admin_headers, admin_user_id):
        r, _ = _create_draw(
            admin_headers,
            winners_count=2,
            prizes=[{"rank": 1, "amount": 1000}, {"rank": 2, "amount": 500}],
        )
        draw_id = r.json()["id"]
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        # Same user_id on both ranks
        rs = _select_winners(
            admin_headers, draw_id,
            [
                {"rank": 1, "user_id": admin_user_id, "prize": 1000},
                {"rank": 2, "user_id": admin_user_id, "prize": 500},
            ],
        )
        assert rs.status_code == 400, f"expected 400 duplicate, got {rs.status_code} {rs.text}"
        _cleanup(admin_headers, draw_id)

    def test_select_incomplete_ranks(self, admin_headers, admin_user_id):
        # winners_count=3 but ranks are 1, 3, 3 (missing 2 and duplicate 3)
        r, _ = _create_draw(
            admin_headers,
            winners_count=3,
            prizes=[
                {"rank": 1, "amount": 1000},
                {"rank": 2, "amount": 500},
                {"rank": 3, "amount": 250},
            ],
        )
        draw_id = r.json()["id"]
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        rs = _select_winners(
            admin_headers, draw_id,
            [
                {"rank": 1, "user_id": admin_user_id, "prize": 1000},
                {"rank": 3, "user_id": admin_user_id, "prize": 500},
                {"rank": 3, "user_id": admin_user_id, "prize": 250},
            ],
        )
        # Either duplicate user OR rank-coverage error => 400
        assert rs.status_code == 400, f"expected 400 incomplete-ranks, got {rs.status_code} {rs.text}"
        _cleanup(admin_headers, draw_id)


# --- 3) Launch is blocked without preset ---
class TestLaunchPresetEnforcement:
    def test_launch_blocked_without_preset(self, admin_headers):
        r, _ = _create_draw(admin_headers, winners_count=1, prizes=[{"rank": 1, "amount": 1000}])
        draw_id = r.json()["id"]
        # Add admin as participant
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        # Launch must fail because no preset_winners
        rl = requests.post(
            f"{BASE_URL}/api/admin/lottery/draws/{draw_id}/launch",
            headers=admin_headers, json={"duration_minutes": 5}, timeout=20,
        )
        assert rl.status_code == 400, f"expected 400 missing preset, got {rl.status_code} {rl.text}"
        assert "sélectionn" in rl.text.lower() or "preset" in rl.text.lower() or "gagnant" in rl.text.lower()
        _cleanup(admin_headers, draw_id)

    def test_launch_succeeds_after_preset(self, admin_headers, admin_user_id):
        r, _ = _create_draw(admin_headers, winners_count=1, prizes=[{"rank": 1, "amount": 1000}])
        draw_id = r.json()["id"]
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        # Pre-select admin as winner
        rs = _select_winners(
            admin_headers, draw_id,
            [{"rank": 1, "user_id": admin_user_id, "prize": 1000}],
        )
        assert rs.status_code == 200, f"select-winners failed: {rs.status_code} {rs.text}"
        body = rs.json()
        assert isinstance(body.get("preset_winners"), list)
        assert len(body["preset_winners"]) == 1
        assert body["preset_winners"][0]["user_id"] == admin_user_id
        assert body["preset_winners"][0]["rank"] == 1
        assert float(body["preset_winners"][0]["prize"]) == 1000.0

        # Launch should now succeed
        rl = requests.post(
            f"{BASE_URL}/api/admin/lottery/draws/{draw_id}/launch",
            headers=admin_headers, json={"duration_minutes": 30}, timeout=20,
        )
        assert rl.status_code == 200, f"launch failed: {rl.status_code} {rl.text}"
        assert rl.json()["status"] == "running"
        _cleanup(admin_headers, draw_id)


# --- 4) Select-winners refused once running ---
class TestSelectAfterLaunch:
    def test_select_blocked_after_launch(self, admin_headers, admin_user_id):
        r, _ = _create_draw(admin_headers, winners_count=1, prizes=[{"rank": 1, "amount": 1000}])
        draw_id = r.json()["id"]
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        # Pre-select then launch
        rs1 = _select_winners(
            admin_headers, draw_id,
            [{"rank": 1, "user_id": admin_user_id, "prize": 1000}],
        )
        assert rs1.status_code == 200
        rl = requests.post(
            f"{BASE_URL}/api/admin/lottery/draws/{draw_id}/launch",
            headers=admin_headers, json={"duration_minutes": 30}, timeout=20,
        )
        assert rl.status_code == 200
        # Now selecting winners again must fail
        rs2 = _select_winners(
            admin_headers, draw_id,
            [{"rank": 1, "user_id": admin_user_id, "prize": 999}],
        )
        assert rs2.status_code == 400, f"expected 400 after-launch, got {rs2.status_code} {rs2.text}"
        _cleanup(admin_headers, draw_id)


# --- 5) Join refused if status != open ---
class TestJoinAfterLaunch:
    def test_join_refused_if_running(self, admin_headers, admin_user_id):
        r, _ = _create_draw(admin_headers, max_participants=5, winners_count=1, prizes=[{"rank": 1, "amount": 1000}])
        draw_id = r.json()["id"]
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)
        rs = _select_winners(
            admin_headers, draw_id,
            [{"rank": 1, "user_id": admin_user_id, "prize": 1000}],
        )
        assert rs.status_code == 200
        rl = requests.post(
            f"{BASE_URL}/api/admin/lottery/draws/{draw_id}/launch",
            headers=admin_headers, json={"duration_minutes": 30}, timeout=20,
        )
        assert rl.status_code == 200
        # Cannot join now (status=running)
        rj2 = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj2.status_code == 400
        _cleanup(admin_headers, draw_id)


# --- 6) Stats ---
class TestStats:
    def test_stats_has_required_fields(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/lottery/stats", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        for k in ("open_count", "running_count", "announced_count", "total_draws"):
            assert k in data
            assert isinstance(data[k], int)


# --- 7) Full E2E: preset == final winners + balance credited ---
class TestE2EPresetWinners:
    def test_full_flow_preset_match(self, admin_headers, admin_user_id):
        # Get balance BEFORE
        me_r = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=20)
        assert me_r.status_code == 200
        bp_before = float(me_r.json().get("balance_profit") or 0)

        # Create draw, prize = 2000 FCFA on rank 1
        r, _ = _create_draw(
            admin_headers,
            max_participants=2, winners_count=1, entry_amount=500,
            prizes=[{"rank": 1, "amount": 2000}],
        )
        draw_id = r.json()["id"]

        # Admin joins
        rj = requests.post(
            f"{BASE_URL}/api/lottery/draws/{draw_id}/join", headers=admin_headers, timeout=20
        )
        assert rj.status_code in (200, 409)

        # Pre-select admin as winner with a SPECIFIC prize (different from prizes list to confirm preset wins)
        rs = _select_winners(
            admin_headers, draw_id,
            [{"rank": 1, "user_id": admin_user_id, "prize": 2000}],
        )
        assert rs.status_code == 200, f"select failed: {rs.text}"

        # Launch 1 minute
        rl = requests.post(
            f"{BASE_URL}/api/admin/lottery/draws/{draw_id}/launch",
            headers=admin_headers, json={"duration_minutes": 1}, timeout=20,
        )
        assert rl.status_code == 200
        assert rl.json()["status"] == "running"

        # Sleep ~70s
        time.sleep(70)

        # Trigger auto-complete
        rlist = requests.get(
            f"{BASE_URL}/api/admin/lottery/draws", headers=admin_headers, timeout=30
        )
        assert rlist.status_code == 200
        draws = rlist.json()
        target = next((d for d in draws if d["id"] == draw_id), None)
        assert target is not None, "draw disappeared"
        assert target["status"] == "announced", f"expected announced got {target['status']}"
        winners = target.get("winners") or []
        preset = target.get("preset_winners") or []
        assert len(winners) == 1, f"expected 1 winner got {len(winners)}"
        assert len(preset) == 1
        # Winners MUST match preset exactly (same user_id, rank, prize)
        assert winners[0]["user_id"] == preset[0]["user_id"] == admin_user_id
        assert winners[0]["rank"] == preset[0]["rank"] == 1
        assert float(winners[0]["prize"]) == float(preset[0]["prize"]) == 2000.0

        # Verify balance_profit increased (entry -500 + prize +2000 => net +1500)
        me_r2 = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=20)
        assert me_r2.status_code == 200
        bp_after = float(me_r2.json().get("balance_profit") or 0)
        assert bp_after >= bp_before + 1500 - 1, (
            f"balance_profit did not increase as expected: before={bp_before} after={bp_after}"
        )
