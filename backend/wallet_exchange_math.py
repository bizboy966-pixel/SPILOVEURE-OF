"""Dependency-free exchange arithmetic shared by wallet routes and tests."""
from __future__ import annotations

import math
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


ZERO_DECIMAL = {
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
    "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
}


def round_asset_amount(value: float | Decimal, asset_code: str) -> float:
    try:
        amount = Decimal(str(value))
        if not amount.is_finite():
            raise ValueError("Montant invalide.")
        code = str(asset_code or "").upper()
        decimals = 6 if "." in code or "_" in code or code.startswith(
            ("USDT", "USDC", "BTC", "ETH"),
        ) else (0 if code in ZERO_DECIMAL else 2)
        quantum = Decimal(1).scaleb(-decimals)
        return float(amount.quantize(quantum, rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("Montant invalide.") from exc


def calculate_exchange_amount(
    direction: str,
    amount: float,
    rate: float,
    asset_code: str,
    *,
    destination_asset_code: str | None = None,
    destination_rate: float | None = None,
) -> dict:
    """Calculate the user-entered source and rounded destination amount.

    Admin rates mean XOF per one crypto unit:
    buy = XOF spent for one crypto unit; sell = XOF credited for one crypto unit.
    Crypto-to-crypto uses the source sell rate and destination buy rate.
    """
    if direction not in {"xof_to_crypto", "crypto_to_xof", "crypto_to_crypto"}:
        raise ValueError("Sens d’échange invalide.")
    if not math.isfinite(float(amount)) or amount <= 0:
        raise ValueError("Montant invalide.")
    if not math.isfinite(float(rate)) or rate <= 0:
        raise ValueError("Taux invalide.")
    if direction == "crypto_to_crypto":
        source_code = str(asset_code or "").strip().upper()
        destination_code = str(destination_asset_code or "").strip().upper()
        if not source_code or not destination_code or source_code == destination_code:
            raise ValueError("Choisissez deux actifs crypto différents.")
        if destination_rate is None or not math.isfinite(float(destination_rate)) or destination_rate <= 0:
            raise ValueError("Taux de destination invalide.")
        source_rate = Decimal(str(rate))
        target_rate = Decimal(str(destination_rate))
        effective_rate = source_rate / target_rate
        amount_in = round_asset_amount(amount, source_code)
        raw_out = Decimal(str(amount_in)) * effective_rate
        amount_out = round_asset_amount(raw_out, destination_code)
        if amount_in <= 0 or amount_out <= 0:
            raise ValueError("Le montant est trop faible après arrondi.")
        return {
            "source_code": source_code,
            "destination_code": destination_code,
            "amount_in": amount_in,
            "amount_out": amount_out,
            "rate": float(effective_rate),
            "source_rate": float(source_rate),
            "destination_rate": float(target_rate),
        }

    is_buy = direction == "xof_to_crypto"
    source_code, destination_code = ("XOF", asset_code) if is_buy else (asset_code, "XOF")
    amount_in = round_asset_amount(amount, source_code)
    raw_out = (
        Decimal(str(amount_in)) / Decimal(str(rate))
        if is_buy else Decimal(str(amount_in)) * Decimal(str(rate))
    )
    amount_out = round_asset_amount(raw_out, destination_code)
    if amount_in <= 0 or amount_out <= 0:
        raise ValueError("Le montant est trop faible après arrondi.")
    return {
        "source_code": source_code,
        "destination_code": destination_code,
        "amount_in": amount_in,
        "amount_out": amount_out,
        "rate": float(rate),
    }
