"""Regression — 2026-03-04 (v27ac) : activations automatiques Biz-transPay
visibles dans le panel admin + comptées dans les stats.

Demande utilisateur (verbatim) :
> Tu fais pareil aussi pour les dépôts automatiques. Tous les dépôts
> automatiques là doivent être comptabilisés sur la statistique comme il le
> faut et aussi dans les parties activation, valider, rejeter et en attente
> selon son statut.

Cause : `admin_list_activations` et `admin_stats` filtraient uniquement les
providers `soleaspay` et `ashtecpay` — donc TOUTES les activations
Biz-transPay (Mobile Money + Crypto USDT.BEP20) étaient invisibles côté
admin et absentes du total.

Ce test verrouille :
  1. `admin_list_activations` inclut `biztranspay` dans la merge query.
  2. `admin_stats.activations_pending_auto` et `total_auto_agg` incluent
     biztranspay.
  3. Le mapping `status="expired"` (BTP timeout 10 min) tombe dans le
     bucket `rejected` du panel admin.
  4. Le panel admin frontend enrichit le badge AUTO avec le provider.
"""
import re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "server.py"
ADMIN_UI = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(admin)" / "index.tsx"


def test_admin_list_activations_includes_biztranspay():
    src = SERVER.read_text()
    # Locate the payment_query definition inside admin_list_activations.
    m = re.search(
        r"async def admin_list_activations\(.*?payment_query:\s*dict\s*=\s*\{[^}]*\}",
        src, re.S,
    )
    assert m, "payment_query in admin_list_activations not found"
    block = m.group(0)
    for prov in ("soleaspay", "ashtecpay", "biztranspay"):
        assert f'"{prov}"' in block, (
            f"admin_list_activations: provider '{prov}' missing from merge query"
        )


def test_admin_stats_activations_includes_biztranspay():
    src = SERVER.read_text()
    # activations_pending_auto — count query.
    m = re.search(
        r"activations_pending_auto\s*=\s*await\s+db\.payments\.count_documents\(\s*\{.*?\}\s*\)",
        src, re.S,
    )
    assert m, "activations_pending_auto not found"
    assert '"biztranspay"' in m.group(0), "biztranspay missing from pending count"

    # total_auto_agg — aggregate.
    m = re.search(
        r"total_auto_agg\s*=\s*await\s+db\.payments\.aggregate\(\[.*?\]\)",
        src, re.S,
    )
    assert m, "total_auto_agg not found"
    assert '"biztranspay"' in m.group(0), "biztranspay missing from total aggregate"


def test_admin_list_activations_rejected_includes_expired():
    """BTP expires stuck payments after 10 minutes with status='expired'.
    They must be routed to the `rejected` bucket, not stay invisible."""
    src = SERVER.read_text()
    m = re.search(
        r'elif status_filter == "rejected":\s*payment_query\["status"\]\s*=\s*(.+?)\n',
        src, re.S,
    )
    assert m, "rejected mapping not found"
    payload = m.group(1)
    assert '"failed"' in payload and '"expired"' in payload, (
        "Rejected filter must include both 'failed' and 'expired' statuses."
    )


def test_admin_ui_method_badge_shows_provider():
    src = ADMIN_UI.read_text()
    # New badge signature accepts a provider param and renders "AUTO • BTP" etc.
    assert 'provider === "biztranspay"' in src
    assert 'AUTO • ' in src or 'autoLabel' in src
    # "Mode de paiement" line must know biztranspay too.
    assert "Automatique (Biz-transPay)" in src
    assert "BTP Crypto USDT.BEP20" in src
