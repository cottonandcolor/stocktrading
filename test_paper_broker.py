import tempfile
import unittest
from pathlib import Path

from paper_broker import PaperBroker


class PaperBrokerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.broker = PaperBroker(Path(self.tmp.name) / "test.db", initial_cash=25_000)

    def tearDown(self):
        self.tmp.cleanup()

    def test_long_stock_round_trip(self):
        self.broker.execute_stock("SPY", "BUY", 10, 100, stop_price=99)
        self.assertEqual(self.broker.account()["cash"], 24_000)
        fill = self.broker.execute_stock("SPY", "SELL", 10, 102)
        self.assertEqual(fill.realized_pnl, 20)
        self.assertEqual(self.broker.account()["cash"], 25_020)
        self.assertEqual(self.broker.positions(), [])

    def test_short_stock_round_trip(self):
        self.broker.execute_stock("TTD", "SELL", 100, 14)
        fill = self.broker.execute_stock("TTD", "BUY", 100, 13)
        self.assertEqual(fill.realized_pnl, 100)
        self.assertEqual(self.broker.account()["cash"], 25_100)

    def test_partial_close_preserves_average_cost(self):
        self.broker.execute_stock("MCHP", "BUY", 10, 80)
        self.broker.execute_stock("MCHP", "BUY", 10, 90)
        fill = self.broker.execute_stock("MCHP", "SELL", 5, 100)
        self.assertEqual(fill.realized_pnl, 75)
        position = self.broker.positions()[0]
        self.assertEqual(position["quantity"], 15)
        self.assertEqual(position["avg_price"], 85)

    def test_debit_spread_round_trip(self):
        opened = self.broker.open_debit_spread(
            "SPY", "2026-08-14", "CALL", 775, 780, 1, 1.90
        )
        self.assertEqual(opened.instrument, "SPY 2026-08-14 CALL 775/780")
        self.assertEqual(self.broker.account()["cash"], 24_810)
        closed = self.broker.close_debit_spread(opened.instrument, 1, 3.25)
        self.assertAlmostEqual(closed.realized_pnl, 135)
        self.assertEqual(self.broker.account()["cash"], 25_135)

    def test_marks_include_short_liability(self):
        self.broker.execute_stock("ABC", "SELL", 10, 100)
        account = self.broker.mark_account({"ABC": 90})
        self.assertEqual(account["equity"], 25_100)
        self.assertEqual(account["unrealized_pnl"], 100)


if __name__ == "__main__":
    unittest.main()
