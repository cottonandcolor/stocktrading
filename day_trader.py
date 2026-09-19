"""Approval-based opening-range paper trader.

This never sends orders to a broker. It downloads one-minute Yahoo Finance
bars, identifies a breakout/retest setup, asks for approval, and records a
simulated position in ``paper_trades.json``.

Run on a market day:

    .venv/bin/python day_trader.py --live

Use ``--once`` to print one scan and exit. Yahoo data can be delayed, so this
is suitable for learning and paper testing, not live execution.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import asdict, dataclass
from datetime import datetime, time as clock_time
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf


ET = ZoneInfo("America/New_York")
STATE_FILE = Path(__file__).with_name("paper_trades.json")

CAPITAL = 25_000.0
RISK_PER_TRADE = 62.50
DAILY_LOSS_LIMIT = 125.0
MAX_TRADES = 2
MAX_NOTIONAL_PCT = 0.25
POLL_SECONDS = 30


@dataclass(frozen=True)
class Candidate:
    symbol: str
    side: str
    friday_level: Optional[float]
    atr: float
    reason: str
    requires_qqq_confirmation: bool = True


WATCHLIST = [
    Candidate("MNDY", "long", None, 5.20, "Monday earnings ORB continuation"),
    Candidate("TWLO", "long", 254.50, 10.00, "ORB break + VWAP reclaim (replaces dead MCHP)"),
    Candidate("TTD", "short", 14.57, 1.00, "Friday selloff ORB breakdown"),
    Candidate("DOCS", "short", 27.10, 1.85, "Friday earnings gap failure"),
    Candidate("UBER", "long", 75.42, 2.40, "Strength above Friday high / ORB"),
]


@dataclass
class Signal:
    symbol: str
    side: str
    timestamp: str
    entry: float
    stop: float
    target1: float
    target2: float
    shares: int
    trigger: float
    vwap: float
    relative_volume: float
    premarket_volume: int
    reason: str


@dataclass
class Position:
    symbol: str
    side: str
    entry_time: str
    entry: float
    stop: float
    target1: float
    target2: float
    shares: int
    remaining: int
    realized_pnl: float = 0.0
    target1_hit: bool = False
    last_checked: Optional[str] = None


def empty_state(day: str) -> dict:
    return {
        "date": day,
        "trades_taken": 0,
        "realized_pnl": 0.0,
        "positions": [],
        "closed_trades": [],
        "seen_signals": [],
    }


def load_state(day: str, path: Path = STATE_FILE) -> dict:
    if not path.exists():
        return empty_state(day)
    try:
        state = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return empty_state(day)
    return state if state.get("date") == day else empty_state(day)


def save_state(state: dict, path: Path = STATE_FILE) -> None:
    path.write_text(json.dumps(state, indent=2) + "\n")


def normalize_bars(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    if frame.empty:
        return frame
    bars = frame.copy()
    if isinstance(bars.columns, pd.MultiIndex):
        if symbol in bars.columns.get_level_values(0):
            bars = bars[symbol]
        elif symbol in bars.columns.get_level_values(1):
            bars = bars.xs(symbol, axis=1, level=1)
    bars.columns = [str(c).title() for c in bars.columns]
    needed = ["Open", "High", "Low", "Close", "Volume"]
    if any(c not in bars for c in needed):
        return pd.DataFrame(columns=needed)
    bars = bars[needed].dropna(subset=["Open", "High", "Low", "Close"])
    if bars.index.tz is None:
        bars.index = bars.index.tz_localize("UTC")
    bars.index = bars.index.tz_convert(ET)
    return bars


def download_bars(symbol: str) -> pd.DataFrame:
    raw = yf.download(
        symbol,
        period="5d",
        interval="1m",
        auto_adjust=True,
        prepost=True,
        progress=False,
        threads=False,
    )
    return normalize_bars(raw, symbol)


def volume_metrics(bars: pd.DataFrame, now: datetime) -> Tuple[float, int]:
    """Cumulative regular-session RVOL and today's premarket volume."""
    if bars.empty:
        return 0.0, 0
    same_day = bars.index.date == now.date()
    premarket = bars.loc[
        same_day
        & (bars.index.time >= clock_time(4, 0))
        & (bars.index.time < clock_time(9, 30)),
        "Volume",
    ].sum()
    elapsed_time = min(now.time(), clock_time(16, 0))
    regular_to_now = (
        (bars.index.time >= clock_time(9, 30))
        & (bars.index.time < elapsed_time)
    )
    by_day = bars.loc[regular_to_now].groupby(bars.loc[regular_to_now].index.date)[
        "Volume"
    ].sum()
    today_volume = float(by_day.get(now.date(), 0))
    history = by_day.drop(labels=[now.date()], errors="ignore")
    baseline = float(history.mean()) if not history.empty else 0.0
    rvol = today_volume / baseline if baseline > 0 else 0.0
    return rvol, int(premarket)


def session_bars(bars: pd.DataFrame, now: datetime) -> pd.DataFrame:
    if bars.empty:
        return bars
    same_day = bars.index.date == now.date()
    regular = (bars.index.time >= clock_time(9, 30)) & (
        bars.index.time < clock_time(16, 0)
    )
    completed = bars.index < now.replace(second=0, microsecond=0)
    return bars.loc[same_day & regular & completed].copy()


def add_vwap(bars: pd.DataFrame) -> pd.DataFrame:
    out = bars.copy()
    typical = (out["High"] + out["Low"] + out["Close"]) / 3
    volume = out["Volume"].fillna(0)
    cumulative_volume = volume.cumsum()
    out["VWAP"] = (typical * volume).cumsum() / cumulative_volume.replace(0, float("nan"))
    return out


def opening_range(bars: pd.DataFrame) -> Optional[Tuple[float, float]]:
    first_15 = bars[
        (bars.index.time >= clock_time(9, 30))
        & (bars.index.time < clock_time(9, 45))
    ]
    if len(first_15) < 15:
        return None
    return float(first_15["High"].max()), float(first_15["Low"].min())


def _breakout_and_retest(
    bars: pd.DataFrame, side: str, trigger: float, tolerance: float
) -> Optional[pd.Series]:
    after_open = bars[bars.index.time >= clock_time(9, 45)]
    if len(after_open) < 2:
        return None

    if side == "long":
        breakout = after_open[after_open["Close"] > trigger]
    else:
        breakout = after_open[after_open["Close"] < trigger]
    if breakout.empty:
        return None

    later = after_open.loc[after_open.index > breakout.index[0]]
    if side == "long":
        retests = later[
            (later["Low"] <= trigger + tolerance)
            & (later["Close"] > trigger)
            & (later["Close"] > later["VWAP"])
        ]
    else:
        retests = later[
            (later["High"] >= trigger - tolerance)
            & (later["Close"] < trigger)
            & (later["Close"] < later["VWAP"])
        ]
    return None if retests.empty else retests.iloc[-1]


def evaluate_candidate(
    candidate: Candidate,
    bars: pd.DataFrame,
    qqq_bars: pd.DataFrame,
    risk_per_trade: float = RISK_PER_TRADE,
    capital: float = CAPITAL,
    relative_volume: float = 0.0,
    premarket_volume: int = 0,
) -> Optional[Signal]:
    """Return a signal only after a breakout and later successful retest."""
    if len(bars) < 17:
        return None
    bars = add_vwap(bars)
    or_values = opening_range(bars)
    if or_values is None:
        return None
    or_high, or_low = or_values

    if candidate.side == "long":
        trigger = max(or_high, candidate.friday_level or or_high)
    else:
        trigger = min(or_low, candidate.friday_level or or_low)

    tolerance = max(0.02, trigger * 0.0015)
    retest = _breakout_and_retest(bars, candidate.side, trigger, tolerance)
    if retest is None:
        return None

    qqq = add_vwap(qqq_bars) if not qqq_bars.empty else qqq_bars
    if candidate.requires_qqq_confirmation:
        if qqq.empty or "VWAP" not in qqq or pd.isna(qqq["VWAP"].iloc[-1]):
            return None
        qqq_risk_on = qqq["Close"].iloc[-1] > qqq["VWAP"].iloc[-1]
        if (candidate.side == "long" and not qqq_risk_on) or (
            candidate.side == "short" and qqq_risk_on
        ):
            return None

    entry = float(retest["Close"])
    # Reject a chase beyond one quarter of the stock's daily ATR.
    if abs(entry - trigger) > 0.25 * candidate.atr:
        return None

    minimum_risk = max(0.05, candidate.atr * 0.15)
    if candidate.side == "long":
        stop = min(float(retest["Low"]) - 0.02, trigger - minimum_risk)
        risk = entry - stop
        target1, target2 = entry + risk, entry + 2 * risk
    else:
        stop = max(float(retest["High"]) + 0.02, trigger + minimum_risk)
        risk = stop - entry
        target1, target2 = entry - risk, entry - 2 * risk

    # A very wide retest defeats the point of an opening-range entry.
    if risk <= 0 or risk > 0.5 * candidate.atr:
        return None
    by_risk = math.floor(risk_per_trade / risk)
    by_notional = math.floor((capital * MAX_NOTIONAL_PCT) / entry)
    shares = min(by_risk, by_notional)
    if shares < 1:
        return None

    return Signal(
        symbol=candidate.symbol,
        side=candidate.side,
        timestamp=retest.name.isoformat(),
        entry=round(entry, 2),
        stop=round(stop, 2),
        target1=round(target1, 2),
        target2=round(target2, 2),
        shares=shares,
        trigger=round(trigger, 2),
        vwap=round(float(retest["VWAP"]), 2),
        relative_volume=round(relative_volume, 2),
        premarket_volume=premarket_volume,
        reason=candidate.reason,
    )


def approve(signal: Signal, auto_reject: bool = False) -> bool:
    planned_risk = abs(signal.entry - signal.stop) * signal.shares
    print(
        f"\nSIGNAL {signal.symbol} {signal.side.upper()}\n"
        f"  reason:  {signal.reason}\n"
        f"  RVOL:    {signal.relative_volume:.2f}x  "
        f"premarket volume: {signal.premarket_volume:,}\n"
        f"  trigger: {signal.trigger:.2f}  VWAP: {signal.vwap:.2f}\n"
        f"  entry:   {signal.entry:.2f}  stop: {signal.stop:.2f}\n"
        f"  targets: {signal.target1:.2f}, {signal.target2:.2f}\n"
        f"  size:    {signal.shares} shares  planned risk: ${planned_risk:.2f}\n"
        "  Before approval, verify the live brokerage spread is <=0.15%."
    )
    if auto_reject:
        return False
    try:
        return input("Approve PAPER trade? Type YES: ").strip() == "YES"
    except EOFError:
        return False


def open_paper_position(signal: Signal, state: dict) -> None:
    position = Position(
        symbol=signal.symbol,
        side=signal.side,
        entry_time=signal.timestamp,
        entry=signal.entry,
        stop=signal.stop,
        target1=signal.target1,
        target2=signal.target2,
        shares=signal.shares,
        remaining=signal.shares,
        last_checked=signal.timestamp,
    )
    state["positions"].append(asdict(position))
    state["trades_taken"] += 1
    state["seen_signals"].append(f"{signal.symbol}:{signal.timestamp}")
    print(f"PAPER OPEN: {signal.symbol} {signal.side} {signal.shares} @ {signal.entry:.2f}")


def _pnl(side: str, entry: float, exit_price: float, shares: int) -> float:
    multiplier = 1 if side == "long" else -1
    return multiplier * (exit_price - entry) * shares


def manage_positions(state: dict, bars_by_symbol: Dict[str, pd.DataFrame], now: datetime) -> None:
    still_open = []
    for raw in state["positions"]:
        p = Position(**raw)
        bars = bars_by_symbol.get(p.symbol, pd.DataFrame())
        if bars.empty:
            still_open.append(raw)
            continue
        checked_after = pd.Timestamp(p.last_checked or p.entry_time)
        new_bars = bars.loc[bars.index > checked_after]
        exit_price = exit_reason = None
        last_bar = bars.iloc[-1]

        for timestamp, bar in new_bars.iterrows():
            # Conservative assumption: if stop and target occur in one minute,
            # the stop happened first.
            stop_hit = (
                bar["Low"] <= p.stop if p.side == "long" else bar["High"] >= p.stop
            )
            if stop_hit:
                exit_price, exit_reason = p.stop, "stop"
                break
            if not p.target1_hit:
                target_hit = (
                    bar["High"] >= p.target1
                    if p.side == "long"
                    else bar["Low"] <= p.target1
                )
                if target_hit:
                    sold = max(1, p.shares // 2)
                    p.realized_pnl += _pnl(p.side, p.entry, p.target1, sold)
                    p.remaining -= sold
                    p.target1_hit = True
                    p.stop = p.entry
                    print(
                        f"PAPER PARTIAL: {p.symbol} {sold} @ {p.target1:.2f}; "
                        "stop -> breakeven"
                    )
            elif (
                bar["High"] >= p.target2
                if p.side == "long"
                else bar["Low"] <= p.target2
            ):
                exit_price, exit_reason = p.target2, "target2"
                break
            p.last_checked = timestamp.isoformat()

        if exit_price is None and now.time() >= clock_time(15, 50):
            exit_price, exit_reason = float(last_bar["Close"]), "end_of_day"

        if exit_price is not None:
            p.realized_pnl += _pnl(p.side, p.entry, exit_price, p.remaining)
            state["realized_pnl"] += p.realized_pnl
            closed = asdict(p)
            closed.update({"exit": round(exit_price, 2), "exit_reason": exit_reason})
            state["closed_trades"].append(closed)
            print(
                f"PAPER CLOSE: {p.symbol} @ {exit_price:.2f} "
                f"({exit_reason}); P&L ${p.realized_pnl:.2f}"
            )
        else:
            still_open.append(asdict(p))
    state["positions"] = still_open


def risk_lockout(state: dict) -> Optional[str]:
    if state["realized_pnl"] <= -DAILY_LOSS_LIMIT:
        return f"daily loss limit reached (${state['realized_pnl']:.2f})"
    if state["trades_taken"] >= MAX_TRADES:
        return f"maximum {MAX_TRADES} trades reached"
    return None


def scan_once(now: Optional[datetime] = None, auto_reject: bool = False) -> dict:
    now = now or datetime.now(ET)
    day = now.date().isoformat()
    state = load_state(day)

    symbols = sorted({c.symbol for c in WATCHLIST} | {"QQQ"})
    raw_bars = {symbol: download_bars(symbol) for symbol in symbols}
    bars_by_symbol = {
        symbol: session_bars(raw_bars[symbol], now) for symbol in symbols
    }
    manage_positions(state, bars_by_symbol, now)

    if now.weekday() >= 5:
        print("Market is closed for the weekend.")
        save_state(state)
        return state
    if now.time() < clock_time(9, 45):
        print("Observation period: no entries before 9:45 ET.")
        save_state(state)
        return state
    if now.time() >= clock_time(15, 45):
        print("Entry cutoff reached; managing exits only.")
        save_state(state)
        return state

    lockout = risk_lockout(state)
    if lockout:
        print(f"LOCKED: {lockout}")
        save_state(state)
        return state

    qqq = bars_by_symbol["QQQ"]
    for candidate in WATCHLIST:
        rvol, premarket_volume = volume_metrics(raw_bars[candidate.symbol], now)
        if rvol < 1.5:
            continue
        # Some Yahoo feeds omit extended-hours volume. Enforce the threshold
        # only when the feed supplied premarket bars.
        if premarket_volume and premarket_volume < 250_000:
            continue
        signal = evaluate_candidate(
            candidate,
            bars_by_symbol[candidate.symbol],
            qqq,
            relative_volume=rvol,
            premarket_volume=premarket_volume,
        )
        if signal is None:
            continue
        signal_id = f"{signal.symbol}:{signal.timestamp}"
        if signal_id in state["seen_signals"] or any(
            p["symbol"] == signal.symbol for p in state["positions"]
        ):
            continue
        # Mark the alert seen even when rejected so the same minute does not nag.
        state["seen_signals"].append(signal_id)
        if approve(signal, auto_reject=auto_reject):
            open_paper_position(signal, state)
        if risk_lockout(state):
            break

    if not state["positions"] and not state["seen_signals"]:
        print(f"{now:%H:%M:%S ET}: no confirmed setup.")
    save_state(state)
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="poll continuously")
    mode.add_argument("--once", action="store_true", help="scan once and exit")
    parser.add_argument(
        "--reject",
        action="store_true",
        help="print signals but automatically reject them",
    )
    parser.add_argument("--poll-seconds", type=int, default=POLL_SECONDS)
    args = parser.parse_args()

    print(
        "PAPER MODE ONLY | "
        f"risk/trade ${RISK_PER_TRADE:.2f} | daily stop ${DAILY_LOSS_LIMIT:.2f} | "
        f"max trades {MAX_TRADES}"
    )
    if not args.live:
        scan_once(auto_reject=args.reject)
        return

    try:
        while True:
            scan_once(auto_reject=args.reject)
            now = datetime.now(ET)
            if now.weekday() >= 5 or now.time() >= clock_time(16, 0):
                break
            time.sleep(max(10, args.poll_seconds))
    except KeyboardInterrupt:
        print("\nStopped. Paper state is preserved.")


if __name__ == "__main__":
    main()
