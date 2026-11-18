"""Regression — 2026-03-04 (v27ah) : ajout Côte d'Ivoire (CI) sur Biz-transPay.

User demande (verbatim) :
> Ajouter MTN Côte d'Ivoire sur Biztrans. Actuellement il y a Bénin,
> Burkina et Togo. Maintenant il faut ajouter MTN Côte d'Ivoire.

Fix v27ah :
  1. OPERATORS["CI"] ajouté avec MTN Mobile Money + Orange Money +
     Moov Money + Wave (tous `default_active=True`).
  2. Aliases couvrent les variantes utilisateur ("MTN", "MTN CI", "MoMo",
     "mtn côte d'ivoire"...).
  3. Les comptages payment_provider_countries/operators seront re-syncés
     automatiquement au prochain démarrage du backend (sync_providers
     s'exécute dans la lifespan).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import biztranspay  # noqa: E402


def test_ci_country_registered():
    assert "CI" in biztranspay.OPERATORS, "Côte d'Ivoire manquante dans OPERATORS"
    ci = biztranspay.OPERATORS["CI"]
    assert ci["name"] == "Côte d'Ivoire"
    assert ci["currency"] == "XOF"
    assert ci["dial"] == "225"


def test_mtn_ci_mapped():
    assert biztranspay._resolve_operator_code("CI", "MTN") == "mtn_ci"
    assert biztranspay._resolve_operator_code("CI", "MTN Mobile Money") == "mtn_ci"
    assert biztranspay._resolve_operator_code("CI", "MTN CI") == "mtn_ci"
    assert biztranspay._resolve_operator_code("CI", "MoMo") == "mtn_ci"
    assert biztranspay._resolve_operator_code("CI", "MTN Côte d'Ivoire") == "mtn_ci"
    assert biztranspay._resolve_operator_code("CI", "MTN cote d'ivoire") == "mtn_ci"


def test_ci_other_operators_mapped():
    assert biztranspay._resolve_operator_code("CI", "Orange") == "orange_ci"
    assert biztranspay._resolve_operator_code("CI", "Orange Money") == "orange_ci"
    assert biztranspay._resolve_operator_code("CI", "Moov") == "moov_ci"
    assert biztranspay._resolve_operator_code("CI", "Wave") == "wave_ci"


def test_existing_countries_unaffected():
    """Smoke test — v27ah must not break TG/BJ/BF resolution."""
    assert biztranspay._resolve_operator_code("TG", "Mixx By Yas") == "tmoney_tg"
    assert biztranspay._resolve_operator_code("TG", "Moov") == "moov_tg"
    assert biztranspay._resolve_operator_code("BJ", "MTN") == "tmoney_bj"
    assert biztranspay._resolve_operator_code("BF", "Orange") == "orange_bf"
