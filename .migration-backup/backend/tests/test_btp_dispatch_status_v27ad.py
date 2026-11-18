"""Regression — 2026-03-04 (v27ad) : les retraits auto-dispatchés BTP sont
visibles dans le panel admin.

Cause racine du bug reporté par l'utilisateur en prod (spiloveure.com) :
`dispatch_biztranspay_withdrawal` faisait passer le retrait à `status="dispatched"`
après un appel réussi à `/payouts`, MAIS les 3 sous-onglets admin ne connaissent
que `pending | validated/completed | rejected` → invisible partout.

Fix v27ad :
  1. Backend dispatch : garder `status="pending"` (ancien: "dispatched"). Le webhook
     BTP push.succeeded/failed continuera de le passer à completed/rejected.
  2. Frontend filtres : les retraits legacy déjà en "dispatched" sur la prod
     restent visibles dans "En attente" grâce à un filtre inclusif.
  3. Backend stats : `withdrawals_pending` compte pending + dispatched + processing.
"""
import re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "server.py"
BTP = Path(__file__).resolve().parents[1] / "biztranspay.py"
ADMIN_UI = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(admin)" / "index.tsx"


def test_btp_dispatch_no_longer_hardcodes_dispatched_status():
    """v27ad + v27af : the dispatcher must never set status='dispatched'.
    Status now comes from _TERMINAL_OK / _TERMINAL_KO mapping (v27af) or
    stays 'pending' if the sync response is non-terminal."""
    src = BTP.read_text()
    m = re.search(
        r"async def dispatch_biztranspay_withdrawal\([^)]*\).*?(?=\nasync def |\n# ─── )",
        src, re.S,
    )
    assert m, "dispatch_biztranspay_withdrawal function not found"
    block = m.group(0)
    assert '"status": "dispatched"' not in block, (
        "Regression: BTP dispatcher again sets status='dispatched'."
    )
    # New v27af logic must be present.
    assert 'internal_status' in block
    assert '"auto_dispatched": True' in block
    assert '"payout_id"' in block
    assert '"dispatched_at"' in block


def test_admin_ui_pending_filter_includes_dispatched():
    src = ADMIN_UI.read_text()
    # Both the count (badge) and the filter (list) must include "dispatched".
    m = re.search(
        r'w\.status === "pending"\s*\|\|\s*w\.status === "dispatched"\s*\|\|\s*w\.status === "processing"',
        src,
    )
    assert m, "'En attente' filter must include dispatched + processing for legacy compat"
    # 2 occurrences expected: one in tab count, one in filter block.
    n = len(re.findall(r'w\.status === "dispatched"', src))
    assert n >= 2, f"'dispatched' must appear in BOTH count AND filter (found {n})"


def test_admin_stats_withdrawals_pending_includes_dispatched():
    src = SERVER.read_text()
    m = re.search(
        r"withdrawals_pending\s*=\s*await\s+db\.withdrawals\.count_documents\(\s*\{.*?\}\s*\)",
        src, re.S,
    )
    assert m, "withdrawals_pending count not found"
    block = m.group(0)
    assert '"dispatched"' in block, "dispatched missing from pending count"
    assert '"processing"' in block, "processing missing from pending count"


def test_pill_status_supports_dispatched_and_completed():
    src = ADMIN_UI.read_text()
    assert '"Virement en cours"' in src
    assert '"Validé (auto)"' in src or 'completed:' in src
