import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from day_trader import (
    Candidate,
    ET,
    Position,
    DAILY_LOSS_LIMIT,
    empty_state,
    evaluate_candidate,
    load_state,
    manage_positions,
    risk_lockout,
    save_state,
)


def bars(prices, start="2026-08-10 09:30"):
    index = pd.date_range(start, periods=len(prices), freq="1min", tz=ET)
    rows = []
    for item in prices:
        if isinstance(item, tuple):
            open_, high, low, close = item
        else:
            open_, high, low, close = item, item + 0.10, item - 0.10, item
        rows.append([open_, high, low, close, 100_000])
    return pd.DataFrame(rows, index=index, columns=["Open", "High", "Low", "Close", "Volume"])


class SignalTests(unittest.TestCase):
    def setUp(self):
        opening = [(99.5, 100.0, 99.0, 99.6)] * 15
        self.stock = bars(
            opening
            + [
                (99.9, 100.7, 99.9, 100.5),  # breakout
                (100.4, 100.6, 99.98, 100.3),  # retest and hold
            ]
        )
        self.qqq = bars([500 + i * 0.05 for i in range(17)])
        self.candidate = Candidate("TEST", "long", None, 4.0, "test")

    def test_long_signal_requires_breakout_then_retest(self):
        signal = evaluate_candidate(self.candidate, self.stock, self.qqq)
        self.assertIsNotNone(signal)
        self.assertEqual(signal.side, "long")
        self.assertEqual(signal.trigger, 100.0)
        self.assertLessEqual(
            (signal.entry - signal.stop) * signal.shares,
            62.50 + 0.01,
        )
        self.assertAlmostEqual(
            signal.target2 - signal.entry,
            2 * (signal.entry - signal.stop),
            places=2,
        )

    def test_no_retest_means_no_signal(self):
        no_retest = self.stock.iloc[:-1]
        self.assertIsNone(evaluate_candidate(self.candidate, no_retest, self.qqq))

    def test_qqq_below_vwap_blocks_long(self):
        falling_qqq = bars([500 - i * 0.05 for i in range(17)])
        self.assertIsNone(
            evaluate_candidate(self.candidate, self.stock, falling_qqq)
        )


class StateAndExitTests(unittest.TestCase):
    def test_state_resets_on_a_new_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            old = empty_state("2026-08-10")
            old["trades_taken"] = 2
            save_state(old, path)
            new = load_state("2026-08-11", path)
            self.assertEqual(new["trades_taken"], 0)

    def test_daily_loss_lockout(self):
        state = empty_state("2026-08-10")
        state["realized_pnl"] = -DAILY_LOSS_LIMIT
        self.assertIn("daily loss", risk_lockout(state))

    def test_stop_has_priority_when_stop_and_target_share_bar(self):
        state = empty_state("2026-08-10")
        state["positions"] = [
            Position(
                symbol="TEST",
                side="long",
                entry_time="2026-08-10T10:00:00-04:00",
                entry=100.0,
                stop=99.0,
                target1=101.0,
                target2=102.0,
                shares=10,
                remaining=10,
            ).__dict__
        ]
        both_touched = bars([(100.0, 101.5, 98.5, 100.5)], "2026-08-10 10:01")
        manage_positions(
            state,
            {"TEST": both_touched},
            datetime(2026, 8, 10, 10, 2, tzinfo=ET),
        )
        self.assertEqual(len(state["positions"]), 0)
        self.assertEqual(state["closed_trades"][0]["exit_reason"], "stop")
        self.assertEqual(state["realized_pnl"], -10.0)


if __name__ == "__main__":
    unittest.main()
