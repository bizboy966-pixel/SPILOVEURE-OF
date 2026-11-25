import unittest

from wallet_exchange_math import calculate_exchange_amount, round_asset_amount


class WalletExchangeMathTests(unittest.TestCase):
    def test_xof_to_crypto_uses_buy_rate_and_six_decimal_precision(self):
        amounts = calculate_exchange_amount("xof_to_crypto", 12000, 600, "USDT.BEP20")
        self.assertEqual(amounts["source_code"], "XOF")
        self.assertEqual(amounts["destination_code"], "USDT.BEP20")
        self.assertEqual(amounts["amount_in"], 12000)
        self.assertEqual(amounts["amount_out"], 20)

    def test_crypto_to_xof_uses_separate_sell_rate(self):
        amounts = calculate_exchange_amount("crypto_to_xof", 1.23456789, 590, "USDT.BEP20")
        self.assertEqual(amounts["source_code"], "USDT.BEP20")
        self.assertEqual(amounts["destination_code"], "XOF")
        self.assertEqual(amounts["amount_in"], 1.234568)
        self.assertEqual(amounts["amount_out"], 728)

    def test_xof_is_rounded_to_whole_francs(self):
        self.assertEqual(round_asset_amount(10.7, "XOF"), 11)

    def test_rejects_invalid_direction_or_zero_amount(self):
        with self.assertRaises(ValueError):
            calculate_exchange_amount("unsupported", 10, 2, "USDT.BEP20")
        with self.assertRaises(ValueError):
            calculate_exchange_amount("xof_to_crypto", 0, 2, "USDT.BEP20")

    def test_rejects_zero_or_nonfinite_rate(self):
        for rate in (0, float("nan"), float("inf")):
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                calculate_exchange_amount("crypto_to_xof", 1, rate, "USDT.BEP20")


if __name__ == "__main__":
    unittest.main()
