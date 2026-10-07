"""v27ay (2026-03-05) — Moov TG OFFICIAL code confirmed by user.

Le user a vérifié son dashboard BTP et confirme que le champ `operator` de la
route POST /payouts attend `moov-togo` (kebab-case, nom pays en toutes lettres).
"""
import asyncio
import os

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from biztranspay import OPERATORS


def test_moov_togo_first_in_provider_codes():
    """`moov-togo` DOIT être le premier code essayé par le dispatcher."""
    moov = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "moov_tg")
    assert moov["provider_codes"][0] == "moov-togo", (
        f"Expected moov-togo first, got {moov['provider_codes'][0]}. "
        "User confirmed BTP merchant console requires `moov-togo`."
    )


def test_moov_togo_persists_alongside_legacy_fallbacks():
    """Les anciennes variantes restent en fallback au cas où BTP change."""
    moov = next(o for o in OPERATORS["TG"]["operators"] if o["code"] == "moov_tg")
    codes = moov["provider_codes"]
    assert "moov-togo" in codes
    for legacy in ("moov_tg", "flooz_tg", "moov_money_tg"):
        assert legacy in codes


@pytest.fixture
def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return client[os.environ["DB_NAME"]]


@pytest.mark.asyncio
async def test_learned_code_preseeded_for_tg_moov(db):
    """La seed manuelle v27ay doit être présente dans app_settings pour que
    le PREMIER payout utilise `moov-togo` sans retry."""
    doc = await db.app_settings.find_one(
        {"key": "btp_learned_operator_code:TG:moov_tg"},
    )
    assert doc is not None, "learned code must be seeded"
    assert doc.get("value") == "moov-togo"
