"""Regression — admin withdrawal actions and server-side reconciliation.

Cause reportée par l'utilisateur :
> Certaines requêtes sont validées automatiquement mais toujours dans "En
> attente" — et pire, elles n'ont même pas de bouton Rejeter. Il faut
> corriger. Peu importe la manière (manuelle/auto), elles doivent
> respecter les mêmes règles.

Fixes :
  1. Frontend : boutons Valider / Rejeter + "🔄 Vérifier statut" visibles
     pour statuts pending/dispatched/processing (avant : pending seul).
  2. Backend : /reject accepte pending/dispatched/processing.
  3. Backend : /validate accepte pending/dispatched/processing. Cas spécial
     auto-dispatched BTP → override sans re-dispatch, status→completed.
   4. Backend : provider pollers reconcile withdrawals in the background;
      opening a repeatedly refreshed admin tab must not launch extra sweeps.
"""
import re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "server.py"
ADMIN_UI = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(admin)" / "index.tsx"


def test_reject_accepts_lifecycle_statuses():
    src = SERVER.read_text()
    # Find the reject endpoint's status guard.
    m = re.search(
        r"async def admin_reject_withdrawal\(.*?wd\[\"status\"\]\s+not in\s+\(([^)]+)\)",
        src, re.S,
    )
    assert m, "reject endpoint status guard not found"
    guard = m.group(1)
    for s in ("pending", "dispatched", "processing"):
        assert f'"{s}"' in guard, f"reject guard missing '{s}'"


def test_validate_accepts_lifecycle_statuses():
    src = SERVER.read_text()
    m = re.search(
        r"async def admin_validate_withdrawal\(.*?wd\[\"status\"\]\s+not in\s+\(([^)]+)\)",
        src, re.S,
    )
    assert m, "validate endpoint status guard not found"
    guard = m.group(1)
    for s in ("pending", "dispatched", "processing"):
        assert f'"{s}"' in guard, f"validate guard missing '{s}'"


def test_validate_btp_auto_override_path():
    src = SERVER.read_text()
    assert 'wd.get("auto_dispatched") and wd.get("gateway") == "biztranspay"' in src
    assert '"validation_source": "admin_override"' in src


def test_frontend_shows_buttons_for_lifecycle_statuses():
    src = ADMIN_UI.read_text()
    m = re.search(
        r'w\.status === "pending" \|\| w\.status === "dispatched" \|\| w\.status === "processing"',
        src,
    )
    assert m, "Frontend must show action buttons for pending/dispatched/processing"
    # The new reconcile button
    assert '🔄 Vérifier statut' in src
    assert 'admin-reconcile-wd-' in src


def test_reconciliation_runs_in_backend_not_on_every_panel_refresh():
    ui = ADMIN_UI.read_text()
    server = SERVER.read_text()
    moneyfusion = (SERVER.parent / "moneyfusion.py").read_text()
    assert 'api.post("/admin/withdrawals/reconcile-all")' not in ui
    assert "payout_polling_loop" in server
    assert "async def polling_loop(db)" in (SERVER.parent / "biztranspay.py").read_text()
    assert "async def reconcile_all_dispatched" in moneyfusion
