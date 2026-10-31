"""v27ax (2026-03-05) — Moov TG retrait auto échoue chez BTP.

User report (vocal) : « Le retrait automatique Moov Money ne fonctionne pas
pour le Togo. Moov Money, encore appelé Flooz, mais ça ne fonctionne pas.
J'ai lancé, c'est en attente. La dame doit valider manuellement. »

BTP merchant console configure les codes opérateurs par environnement et
notre dispatcher payout avait seulement 3 variantes (`moov_tg`, `flooz_tg`,
`moov_money_tg`). Si BTP attend un code différent, toutes les tentatives
échouent silencieusement avec un message générique.

Fix v27ax :
  1. Étendre `provider_codes` de `moov_tg` à 10 variantes (bare, tirets, …)
     pour maximiser les chances de match.
  2. Après épuisement du fallback, le dispatcher persiste la LISTE
     complète des codes essayés dans `withdrawals.tried_operator_codes` +
     un message `gateway_error` actionnable qui dit à l'admin exactement
     quoi configurer dans son dashboard BTP ou quoi demander au support.
"""
import pathlib

from biztranspay import OPERATORS


def test_moov_tg_has_extensive_fallback():
    """Moov TG doit maintenant tenter au moins 8 variantes."""
    moov = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "moov_tg")
    codes = moov["provider_codes"]
    for required in ("moov_tg", "flooz_tg", "moov_money_tg", "flooz", "moov"):
        assert required in codes, f"Moov TG must probe {required}"
    assert len(codes) >= 8, (
        f"Moov TG must probe at least 8 variants, got {len(codes)}: {codes}"
    )


def test_dispatcher_persists_tried_codes_and_actionable_error():
    """Le dispatcher payout doit persister `tried_operator_codes` ET
    rendre `gateway_error` actionnable quand tous les codes échouent."""
    src = pathlib.Path("/app/backend/biztranspay.py").read_text(encoding="utf-8")
    disp_start = src.index("async def dispatch_biztranspay_withdrawal(")
    disp_end = src.index("\n\n\nasync def ", disp_start)
    body = src[disp_start:disp_end]
    assert "tried_operator_codes" in body, (
        "Dispatcher payout must persist the full list of tried codes on failure"
    )
    assert "operator_not_configured_in_btp_console" in body, (
        "Dispatcher must set an actionable error_code when BTP refuses all operator variants"
    )
    assert "console marchand BTP" in body, (
        "Admin-facing error must point to the BTP merchant console"
    )


def test_other_tg_operators_untouched():
    """Mixx By Yas regression check — toujours fonctionnel."""
    tm = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "tmoney_tg")
    assert "tmoney_tg" in tm["provider_codes"]
    assert "mixx_by_yas_tg" in tm["provider_codes"]
    assert "yas_tg" in tm["provider_codes"]
