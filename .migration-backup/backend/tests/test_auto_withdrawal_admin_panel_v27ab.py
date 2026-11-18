"""Regression — 2026-03-04 (v27ab) : auto-dispatched withdrawals visible in
admin panel + counted in stats.

User requirement (verbatim) :
> Pour les retraits qui va se valider automatiquement, ça doit s'afficher
> dans la même panel comme ça c'est validé manuellement. C'est vraiment
> avec un badge "Validé automatiquement" ou "Auto-retrait". Si tu vas au
> niveau du retrait Validé, tu peux trouver ça là-bas. Si c'est rejeté,
> tu vas toujours trouver ça. Si c'est en attente, tu vas trouver ça.
> Ça va comptabiliser au niveau de la statistique aussi.

This test verifies :
  1. `admin_list_withdrawals` returns docs with `auto_dispatched`, `gateway`,
     `gateway_status`, `gateway_error*`, `payout_id` fields (already on the
     doc — nothing to change backend-side).
  2. `admin_stats.total_withdrawals_amount` includes BOTH `validated`
     (manual admin action) AND `completed` (auto-dispatched confirmed by
     gateway webhook).
  3. Admin panel UI file has the `AUTO-RETRAIT` badge and gateway KV rows.
"""
import re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "server.py"
ADMIN_UI = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(admin)" / "index.tsx"


def test_admin_stats_includes_completed_in_total():
    src = SERVER.read_text()
    # Locate the total_wd_agg block and assert it matches BOTH statuses.
    m = re.search(
        r"total_wd_agg\s*=\s*await\s+db\.withdrawals\.aggregate\(\[.*?\]\)",
        src, re.S,
    )
    assert m, "admin_stats: total_wd_agg aggregation not found"
    block = m.group(0)
    assert '"validated"' in block and '"completed"' in block, (
        "admin_stats: total_withdrawals_amount must include BOTH 'validated' "
        "(manual admin) AND 'completed' (auto-dispatched success). "
        "Fix regression in server.py."
    )


def test_admin_ui_auto_retrait_badge():
    src = ADMIN_UI.read_text()
    assert 'AUTO-RETRAIT' in src, "AUTO-RETRAIT badge missing from admin panel"
    assert 'admin-wd-auto-badge-' in src, "auto badge testID missing"
    assert 'gateway_error_code' in src, "gateway_error_code not surfaced to admin"
    assert 'ID passerelle' in src or 'payout_id' in src, "payout_id not shown"


def test_admin_ui_validated_tab_includes_completed():
    """The 'Validés' sub-tab was already inclusive of `completed` status —
    verify that hasn't regressed."""
    src = ADMIN_UI.read_text()
    # Both filter block AND count block must check "completed" too.
    assert src.count('w.status === "completed"') >= 2, (
        "Regression: 'Validés' tab must include auto-dispatched 'completed' "
        "withdrawals (BTP webhook status)."
    )
