"""Regression — 2026-03-04 (v27ae) : cohérence totale du panel admin
retraits/activations — search, filtres et statistiques.

Cause utilisateur (verbatim) :
> Retraits validés automatiquement introuvables dans "Validés"
> Recherche par référence prestataire ne marche pas
> Statistique "Retraits en attente" reste à 5 même quand la liste montre 0

Fixes v27ae :
  1. `admin_list_withdrawals` — `?status=pending` matche pending|dispatched|processing,
     `?status=validated` matche validated|completed, `?status=rejected` matche
     rejected|failed. Une seule source de vérité MongoDB.
  2. Search haystack retrait — inclut payout_id, transaction_id, reference,
     gateway, gateway_status, gateway_error_code, easychange_transaction_id
     et le montant numérique.
  3. Search haystack activations — inclut provider_intent_id, provider,
     gateway_status, amount.
  4. Carte retrait admin — nouvelle KvRow "Mode" (Automatique • BTP / Manuel)
     et "Traitement" (Validé automatiquement / Rejeté / Virement en cours)
     affichées en HAUT de la carte pour visibilité immédiate.
"""
import re
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "server.py"
ADMIN_UI = Path(__file__).resolve().parents[2] / "frontend" / "app" / "(admin)" / "index.tsx"


def test_admin_list_withdrawals_expands_status_filter():
    src = SERVER.read_text()
    # Locate the mapping block.
    m = re.search(
        r'async def admin_list_withdrawals\(.*?if\s+status_filter\s*==\s*"pending":\s*'
        r'q\s*=\s*\{"status":\s*\{"\$in":\s*\[(.*?)\]\}\}',
        src, re.S,
    )
    assert m, "pending mapping in admin_list_withdrawals not found"
    pending_list = m.group(1)
    for s in ("pending", "dispatched", "processing"):
        assert f'"{s}"' in pending_list, f"'{s}' missing from pending filter"

    # validated → validated|completed
    m2 = re.search(
        r'elif\s+status_filter\s*==\s*"validated":\s*q\s*=\s*\{"status":\s*\{"\$in":\s*\[(.*?)\]\}\}',
        src, re.S,
    )
    assert m2 and '"validated"' in m2.group(1) and '"completed"' in m2.group(1)

    # rejected → rejected|failed
    m3 = re.search(
        r'elif\s+status_filter\s*==\s*"rejected":\s*q\s*=\s*\{"status":\s*\{"\$in":\s*\[(.*?)\]\}\}',
        src, re.S,
    )
    assert m3 and '"rejected"' in m3.group(1) and '"failed"' in m3.group(1)


def test_frontend_withdrawal_search_includes_gateway_refs():
    src = ADMIN_UI.read_text()
    # Locate the withdrawal-search haystack.
    m = re.search(
        r'w\.wallet_address, w\.operator, w\.country,\s*.*?filter\(Boolean\)\.join',
        src, re.S,
    )
    assert m, "withdrawal haystack not found"
    block = m.group(0)
    for field in ("payout_id", "transaction_id", "reference", "gateway",
                  "gateway_status", "gateway_error_code",
                  "easychange_transaction_id"):
        assert f"w.{field}" in block, f"search haystack missing w.{field}"


def test_frontend_activation_search_includes_provider_refs():
    src = ADMIN_UI.read_text()
    # Locate the activation-search haystack.
    m = re.search(
        r'a\.easychange_transaction_id,\s*.*?filter\(Boolean\)\.join',
        src, re.S,
    )
    assert m, "activation haystack not found"
    block = m.group(0)
    for field in ("provider_intent_id", "provider", "gateway_status"):
        assert f"a.{field}" in block, f"activation haystack missing a.{field}"


def test_frontend_withdrawal_card_shows_mode_and_traitement():
    src = ADMIN_UI.read_text()
    # New KvRows at the top of the withdrawal card.
    assert 'k="Mode"' in src
    assert 'Automatique • ${gwLabel' in src
    assert 'Manuel (validation admin)' in src
    assert 'Validé automatiquement' in src
    assert 'Virement en cours (passerelle)' in src
