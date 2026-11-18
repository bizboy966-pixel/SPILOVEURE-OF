"""Regression — 2026-03-04 (v27ai) : auto-switch sub-tab + polling live
pour les retraits validés après action admin.

Cause utilisateur (verbatim) :
> Le retrait automatique fonctionne, mais dès que c'est validé dans l'admin
> panel, ça reste toujours en attente là-bas. Or c'est validé déjà.

Vraie cause : après clic sur "Valider", le backend flip bien status="completed",
le reload() refetch les données, MAIS l'admin reste scotché sur l'onglet
"En attente" où le retrait n'apparaît plus → sensation que ça n'a pas marché.

Fixes v27ai :
  1. `action()` accepte `opts.autoSwitchTo` → bascule automatique du sub-tab
     après succès (Valider → Validés, Rejeter → Rejetés).
  2. Polling 20s sur withdrawals + activations tabs pour capter les flips de
     statut webhook sans que l'admin ait à recharger la page.
"""
import re
from pathlib import Path

ADMIN_UI = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(admin)" / "index.tsx"


def test_action_fn_supports_auto_switch():
    src = ADMIN_UI.read_text()
    # New signature with opts.autoSwitchTo
    assert 'opts?: { autoSwitchTo?:' in src
    assert 'setWdFilter(opts.autoSwitchTo)' in src


def test_validate_button_switches_to_validated():
    src = ADMIN_UI.read_text()
    # The Valider onPress passes autoSwitchTo: "validated"
    m = re.search(
        r'/admin/withdrawals/\$\{w\.id\}/validate.*?autoSwitchTo:\s*"validated"',
        src, re.S,
    )
    assert m, "Validate button must pass autoSwitchTo: 'validated'"


def test_reject_button_switches_to_rejected():
    src = ADMIN_UI.read_text()
    m = re.search(
        r'/admin/withdrawals/\$\{w\.id\}/reject.*?autoSwitchTo:\s*"rejected"',
        src, re.S,
    )
    assert m, "Reject button must pass autoSwitchTo: 'rejected'"


def test_live_polling_on_withdrawals_tab():
    src = ADMIN_UI.read_text()
    assert 'tab !== "withdrawals" && tab !== "activations"' in src
    assert 'setInterval' in src and '20000' in src
    assert 'clearInterval(t)' in src
