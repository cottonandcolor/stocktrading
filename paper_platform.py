"""Local Streamlit paper-trading platform.

Start with:
    .venv/bin/streamlit run paper_platform.py
"""

from __future__ import annotations

from datetime import datetime, time as clock_time
from typing import Dict, Optional

import pandas as pd
import streamlit as st
import yfinance as yf

from day_trader import (
    DAILY_LOSS_LIMIT,
    ET,
    MAX_TRADES,
    RISK_PER_TRADE,
    WATCHLIST,
    download_bars,
    evaluate_candidate,
    session_bars,
    volume_metrics,
)
from paper_broker import PaperBroker


st.set_page_config(page_title="Local Paper Trader", page_icon=None, layout="wide")
broker = PaperBroker()


def money(value: float, decimals: int = 2) -> str:
    """Format currency for Streamlit without triggering KaTeX math mode."""
    return f"\\${value:,.{decimals}f}"


def _last_history(symbol: str, period: str, interval: str) -> pd.DataFrame:
    history = yf.Ticker(symbol).history(
        period=period, interval=interval, auto_adjust=True, prepost=True
    )
    if history is None or history.empty:
        raise ValueError(f"No quote data returned for {symbol} ({interval})")
    return history


@st.cache_data(ttl=15, show_spinner=False)
def stock_quote(symbol: str) -> dict:
    symbol = symbol.upper().strip()
    # Prefer one-minute bars; fall back to daily when the market is closed
    # or Yahoo's intraday feed is unavailable.
    try:
        history = _last_history(symbol, "5d", "1m")
    except Exception:
        history = _last_history(symbol, "5d", "1d")
    row = history.iloc[-1]
    timestamp = history.index[-1]
    if getattr(timestamp, "tzinfo", None) is None:
        timestamp = timestamp.tz_localize("UTC")
    timestamp = timestamp.tz_convert(ET)
    volume = row["Volume"] if "Volume" in history.columns else 0
    return {
        "symbol": symbol,
        "price": float(row["Close"]),
        "timestamp": timestamp.isoformat(),
        "volume": int(volume or 0),
    }


@st.cache_data(ttl=60, show_spinner=False)
def price_history(symbol: str) -> pd.DataFrame:
    data = _last_history(symbol.upper(), "3mo", "1d")
    return data[["Close"]].rename(columns={"Close": symbol.upper()})


@st.cache_data(ttl=30, show_spinner=False)
def listed_expiries(symbol: str) -> list:
    options = yf.Ticker(symbol.upper()).options
    if not options:
        raise ValueError(f"No listed expirations for {symbol.upper()}")
    return list(options)


@st.cache_data(ttl=15, show_spinner=False)
def spread_quote(
    symbol: str,
    expiry: str,
    option_type: str,
    long_strike: float,
    short_strike: float,
) -> dict:
    chain = yf.Ticker(symbol.upper()).option_chain(expiry)
    frame = chain.calls if option_type == "CALL" else chain.puts
    if frame is None or frame.empty:
        raise ValueError("Option chain is empty")
    rows = frame.set_index("strike")
    if long_strike not in rows.index or short_strike not in rows.index:
        raise ValueError("Selected strike is missing from the live chain")
    long_leg, short_leg = rows.loc[long_strike], rows.loc[short_strike]
    long_mid = (float(long_leg["bid"]) + float(long_leg["ask"])) / 2
    short_mid = (float(short_leg["bid"]) + float(short_leg["ask"])) / 2
    width = abs(long_strike - short_strike)
    mark = max(0.0, min(width, long_mid - short_mid))
    opening_debit = max(0.0, float(long_leg["ask"]) - float(short_leg["bid"]))
    closing_credit = max(0.0, float(long_leg["bid"]) - float(short_leg["ask"]))
    return {
        "mark": mark,
        "opening_debit": opening_debit,
        "closing_credit": closing_credit,
        "width": width,
        "long_bid": float(long_leg["bid"]),
        "long_ask": float(long_leg["ask"]),
        "short_bid": float(short_leg["bid"]),
        "short_ask": float(short_leg["ask"]),
        "long_oi": int(long_leg["openInterest"] or 0) if "openInterest" in long_leg else 0,
        "short_oi": int(short_leg["openInterest"] or 0) if "openInterest" in short_leg else 0,
    }


def is_market_open(now: Optional[datetime] = None) -> bool:
    now = now or datetime.now(ET)
    return (
        now.weekday() < 5
        and clock_time(9, 30) <= now.time() < clock_time(16, 0)
    )


def position_marks(positions: list) -> tuple:
    marks: Dict[str, float] = {}
    errors = []
    for position in positions:
        try:
            if position["asset_type"] == "stock":
                marks[position["instrument"]] = stock_quote(position["symbol"])["price"]
            else:
                meta = position["metadata"]
                quote = spread_quote(
                    position["symbol"],
                    meta["expiry"],
                    meta["option_type"],
                    meta["long_strike"],
                    meta["short_strike"],
                )
                marks[position["instrument"]] = quote["mark"]
        except Exception as exc:
            marks[position["instrument"]] = position["avg_price"]
            errors.append(f"{position['instrument']}: {exc}")
    return marks, errors


def process_stock_exits(positions: list, marks: Dict[str, float]) -> list:
    if not is_market_open():
        return []
    messages = []
    for position in positions:
        if position["asset_type"] != "stock":
            continue
        mark = marks.get(position["instrument"])
        if mark is None:
            continue
        qty = int(abs(position["quantity"]))
        long_position = position["quantity"] > 0
        stop = position["stop_price"]
        target = position["target_price"]
        reason = None
        if stop is not None and (
            (long_position and mark <= stop) or (not long_position and mark >= stop)
        ):
            reason = "automatic stop"
        elif target is not None and (
            (long_position and mark >= target) or (not long_position and mark <= target)
        ):
            reason = "automatic target"
        if reason:
            side = "SELL" if long_position else "BUY"
            fill = broker.execute_stock(
                position["symbol"], side, qty, mark, strategy="day", notes=reason
            )
            messages.append(
                f"{reason}: {fill.side} {qty} {fill.instrument} @ ${fill.price:.2f}"
            )
    return messages


def day_risk_locked() -> Optional[str]:
    today = datetime.now(ET).date().isoformat()
    pnl = broker.realized_pnl(today, "day")
    if pnl <= -DAILY_LOSS_LIMIT:
        return f"Daily loss lockout is active: ${pnl:,.2f}"
    if broker.opening_trades(today, "day") >= MAX_TRADES:
        return f"Maximum {MAX_TRADES} opening day trades reached"
    return None


positions = broker.positions()
marks, mark_errors = position_marks(positions)
for message in process_stock_exits(positions, marks):
    st.toast(message)
positions = broker.positions()
marks, mark_errors = position_marks(positions)
account = broker.mark_account(marks)

st.title("Local Paper Trader")
st.caption(
    "Local simulation only · Yahoo quotes may be delayed · no brokerage connection or real orders"
)

with st.sidebar:
    st.subheader("Risk controls")
    st.write(f"Starting capital: **{money(account['initial_cash'], 0)}**")
    st.write(f"Day-trade risk: **{money(RISK_PER_TRADE)}**")
    st.write(f"Daily stop: **{money(DAILY_LOSS_LIMIT, 0)}**")
    st.write(f"Maximum day trades: **{MAX_TRADES}**")
    st.write("Weekly spread max loss: **\\$250**")
    if is_market_open():
        st.success("US regular session is open")
    else:
        st.info("US regular session is closed")
    if st.button("Refresh quotes", use_container_width=True):
        st.cache_data.clear()
        st.rerun()
    with st.expander("Reset account"):
        reset_confirmed = st.checkbox("I understand this deletes all paper history")
        if st.button("Reset to $25,000", disabled=not reset_confirmed):
            broker.reset(25_000)
            st.cache_data.clear()
            st.rerun()

summary = st.columns(5)
summary[0].metric("Equity", f"${account['equity']:,.2f}")
summary[1].metric("Cash", f"${account['cash']:,.2f}")
summary[2].metric("Market value", f"${account['market_value']:,.2f}")
summary[3].metric("Unrealized P&L", f"${account['unrealized_pnl']:,.2f}")
summary[4].metric(
    "Total P&L",
    f"${account['total_pnl']:,.2f}",
    f"{account['total_pnl'] / account['initial_cash']:.2%}",
)
# Metrics accept plain text; only markdown writers need escaped dollar signs.

if mark_errors:
    st.warning("Some positions use their entry price because a quote failed: " + "; ".join(mark_errors))

dashboard_tab, stock_tab, option_tab, scanner_tab, activity_tab = st.tabs(
    ["Dashboard", "Stock ticket", "Option spreads", "Strategy scanner", "Activity"]
)

with dashboard_tab:
    st.subheader("Open positions")
    if not positions:
        st.info("No paper positions yet.")
    else:
        rows = []
        for position in positions:
            mark = marks.get(position["instrument"], position["avg_price"])
            multiplier = 100 if position["asset_type"] == "spread" else 1
            unrealized = (
                (mark - position["avg_price"])
                * position["quantity"]
                * multiplier
            )
            rows.append(
                {
                    "Instrument": position["instrument"],
                    "Type": position["asset_type"],
                    "Quantity": position["quantity"],
                    "Average": position["avg_price"],
                    "Mark": mark,
                    "Market value": mark * position["quantity"] * multiplier,
                    "Unrealized P&L": unrealized,
                    "Stop": position["stop_price"],
                    "Target": position["target_price"],
                }
            )
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

    history = pd.DataFrame(broker.equity_history())
    if len(history) > 1:
        history["timestamp"] = pd.to_datetime(history["timestamp"])
        st.subheader("Account equity")
        st.line_chart(history.set_index("timestamp")[["equity"]])

    st.subheader("Watchlist")
    watch_symbols = ["SPY", "QQQ", "MNDY", "TWLO", "TTD", "DOCS", "UBER"]
    quote_rows = []
    for symbol in watch_symbols:
        try:
            quote = stock_quote(symbol)
            quote_rows.append(
                {
                    "Symbol": symbol,
                    "Price": quote["price"],
                    "Quote time": quote["timestamp"],
                }
            )
        except Exception as exc:
            quote_rows.append({"Symbol": symbol, "Price": None, "Quote time": str(exc)})
    st.dataframe(pd.DataFrame(quote_rows), use_container_width=True, hide_index=True)

with stock_tab:
    st.subheader("Stock paper order")
    lockout = day_risk_locked()
    if lockout:
        st.error(lockout)
    with st.form("stock_order"):
        first = st.columns([1.2, 1, 1])
        symbol = first[0].text_input("Symbol", "SPY").upper().strip()
        side = first[1].selectbox("Side", ["BUY", "SELL"])
        quantity = first[2].number_input("Shares", min_value=1, value=1, step=1)
        try:
            quote = stock_quote(symbol)
            live_price = quote["price"]
            st.caption(f"Latest quote: {money(live_price)} at {quote['timestamp']}")
        except Exception as exc:
            live_price = 0.0
            st.error(str(exc))
        second = st.columns(3)
        fill_price = second[0].number_input(
            "Paper fill price", min_value=0.01, value=max(0.01, round(live_price, 2))
        )
        default_stop = (
            max(0.01, fill_price * 0.99) if side == "BUY" else fill_price * 1.01
        )
        stop = second[1].number_input(
            "Stop price", min_value=0.01, value=round(default_stop, 2)
        )
        default_target = (
            fill_price + 2 * abs(fill_price - stop)
            if side == "BUY"
            else fill_price - 2 * abs(fill_price - stop)
        )
        target = second[2].number_input(
            "Target price", min_value=0.01, value=round(max(0.01, default_target), 2)
        )
        risk = abs(fill_price - stop) * quantity
        st.write(
            f"Planned risk: **{money(risk)}** · "
            f"Notional: **{money(fill_price * quantity)}**"
        )
        approved = st.checkbox("Approve this PAPER order")
        submit_stock = st.form_submit_button("Fill paper order", type="primary")

    if submit_stock:
        opening = not any(
            p["instrument"] == symbol
            and p["quantity"] * (1 if side == "BUY" else -1) < 0
            for p in positions
        )
        error = None
        if not approved:
            error = "Approval checkbox is required."
        elif opening and lockout:
            error = lockout
        elif opening and risk > RISK_PER_TRADE + 0.01:
            error = f"Planned risk exceeds ${RISK_PER_TRADE:.2f}."
        elif opening and fill_price * quantity > account["initial_cash"] * 0.25:
            error = "Opening notional exceeds 25% of starting capital."
        elif side == "BUY" and opening and stop >= fill_price:
            error = "A new long position requires a stop below entry."
        elif side == "SELL" and opening and stop <= fill_price:
            error = "A new short position requires a stop above entry."
        if error:
            st.error(error)
        else:
            try:
                fill = broker.execute_stock(
                    symbol,
                    side,
                    int(quantity),
                    float(fill_price),
                    stop_price=float(stop),
                    target_price=float(target),
                    strategy="day",
                    notes="manual dashboard order",
                )
                st.success(
                    f"Filled {fill.side} {fill.quantity:g} {fill.instrument} "
                    f"at {money(fill.price)} in paper mode."
                )
                st.rerun()
            except Exception as exc:
                st.error(str(exc))

    st.subheader("Price chart")
    try:
        st.line_chart(price_history(symbol))
    except Exception as exc:
        st.warning(str(exc))

with option_tab:
    st.subheader("Defined-risk debit spread")
    st.caption(
        "Only long call and long put verticals are supported. Maximum opening loss is \\$250."
    )
    symbol_o = st.text_input("Underlying", "SPY", key="option_symbol").upper().strip()
    try:
        expiries = listed_expiries(symbol_o)
    except Exception as exc:
        expiries = []
        st.error(str(exc))
    if expiries:
        expiry = st.selectbox("Expiration", expiries)
        option_type = st.radio("Type", ["CALL", "PUT"], horizontal=True)
        try:
            chain = yf.Ticker(symbol_o).option_chain(expiry)
            frame = chain.calls if option_type == "CALL" else chain.puts
            strikes = [float(v) for v in frame["strike"].tolist()]
        except Exception as exc:
            strikes = []
            st.error(str(exc))
        if strikes:
            spot = stock_quote(symbol_o)["price"]
            nearest = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
            long_default = nearest
            short_default = min(len(strikes) - 1, nearest + 5)
            if option_type == "PUT":
                short_default = max(0, nearest - 5)
            spread_cols = st.columns(3)
            long_strike = spread_cols[0].selectbox(
                "Long strike", strikes, index=long_default
            )
            short_strike = spread_cols[1].selectbox(
                "Short strike", strikes, index=short_default
            )
            contracts = spread_cols[2].number_input(
                "Contracts", min_value=1, value=1, step=1
            )
            valid_shape = (
                option_type == "CALL" and long_strike < short_strike
            ) or (option_type == "PUT" and long_strike > short_strike)
            if not valid_shape:
                st.error("Call debit: long strike must be lower. Put debit: long strike must be higher.")
            else:
                try:
                    oq = spread_quote(
                        symbol_o, expiry, option_type, long_strike, short_strike
                    )
                    st.write(
                        f"Conservative opening debit: **{money(oq['opening_debit'])}** · "
                        f"Midpoint mark: **{money(oq['mark'])}** · "
                        f"Width: **{money(oq['width'])}**"
                    )
                    st.caption(
                        f"Long {oq['long_bid']:.2f} × {oq['long_ask']:.2f}, "
                        f"OI {oq['long_oi']:,} · Short {oq['short_bid']:.2f} × "
                        f"{oq['short_ask']:.2f}, OI {oq['short_oi']:,}"
                    )
                    max_debit = st.number_input(
                        "Approved debit", min_value=0.01, value=round(oq["opening_debit"], 2)
                    )
                    max_loss = max_debit * contracts * 100
                    max_profit = (oq["width"] - max_debit) * contracts * 100
                    st.write(
                        f"Maximum loss: **{money(max_loss)}** · "
                        f"Maximum profit: **{money(max_profit)}**"
                    )
                    option_approved = st.checkbox("Approve this PAPER spread")
                    if st.button("Open paper spread", type="primary"):
                        if not option_approved:
                            st.error("Approval checkbox is required.")
                        elif max_loss > 250:
                            st.error("Maximum loss exceeds the \\$250 weekly-options limit.")
                        elif oq["long_oi"] < 1000 or oq["short_oi"] < 1000:
                            st.error("Both legs must have at least 1,000 contracts of open interest.")
                        else:
                            fill = broker.open_debit_spread(
                                symbol_o,
                                expiry,
                                option_type,
                                long_strike,
                                short_strike,
                                int(contracts),
                                float(max_debit),
                                notes="manual dashboard order",
                            )
                            st.success(
                                f"Opened {fill.instrument} for {money(fill.price)} debit in paper mode."
                            )
                            st.rerun()
                except Exception as exc:
                    st.error(str(exc))

    spreads = [p for p in positions if p["asset_type"] == "spread"]
    if spreads:
        st.divider()
        st.subheader("Close an open spread")
        close_instrument = st.selectbox(
            "Position", [p["instrument"] for p in spreads], key="close_spread"
        )
        selected = next(p for p in spreads if p["instrument"] == close_instrument)
        close_qty = st.number_input(
            "Contracts to close",
            min_value=1,
            max_value=int(selected["quantity"]),
            value=1,
            step=1,
        )
        meta = selected["metadata"]
        close_quote = spread_quote(
            selected["symbol"],
            meta["expiry"],
            meta["option_type"],
            meta["long_strike"],
            meta["short_strike"],
        )
        close_credit = st.number_input(
            "Closing credit",
            min_value=0.0,
            value=round(close_quote["closing_credit"], 2),
        )
        close_approved = st.checkbox("Approve closing this PAPER spread")
        if st.button("Close paper spread"):
            if not close_approved:
                st.error("Approval checkbox is required.")
            else:
                fill = broker.close_debit_spread(
                    close_instrument, int(close_qty), float(close_credit)
                )
                st.success(
                    f"Closed for {money(fill.price)}; realized P&L {money(fill.realized_pnl)}."
                )
                st.rerun()

with scanner_tab:
    st.subheader("Opening-range strategy scanner")
    st.write(
        "Checks the five-candidate plan for a breakout, later retest, VWAP confirmation, "
        "QQQ confirmation, and at least 1.5× cumulative relative volume."
    )
    if st.button("Run scanner now", type="primary"):
        now = datetime.now(ET)
        if not is_market_open(now) or now.time() < clock_time(9, 45):
            st.info("Signals are evaluated only during regular hours after 9:45 ET.")
        else:
            with st.spinner("Downloading one-minute bars..."):
                qqq_raw = download_bars("QQQ")
                qqq = session_bars(qqq_raw, now)
                results = []
                for candidate in WATCHLIST:
                    raw = download_bars(candidate.symbol)
                    current = session_bars(raw, now)
                    rvol, premarket = volume_metrics(raw, now)
                    signal = evaluate_candidate(
                        candidate,
                        current,
                        qqq,
                        relative_volume=rvol,
                        premarket_volume=premarket,
                    )
                    results.append(
                        {
                            "Symbol": candidate.symbol,
                            "Side": candidate.side,
                            "RVOL": rvol,
                            "Signal": "READY" if signal and rvol >= 1.5 else "WAIT",
                            "Entry": signal.entry if signal and rvol >= 1.5 else None,
                            "Stop": signal.stop if signal and rvol >= 1.5 else None,
                            "Target 1": signal.target1 if signal and rvol >= 1.5 else None,
                            "Target 2": signal.target2 if signal and rvol >= 1.5 else None,
                            "Shares": signal.shares if signal and rvol >= 1.5 else None,
                        }
                    )
                st.dataframe(pd.DataFrame(results), use_container_width=True, hide_index=True)
                st.caption(
                    "A READY row is still an approval request, not a real order. Enter it through "
                    "the stock ticket after checking the live spread."
                )

with activity_tab:
    st.subheader("Order history")
    orders = pd.DataFrame(broker.orders())
    if orders.empty:
        st.info("No paper fills yet.")
    else:
        st.dataframe(orders, use_container_width=True, hide_index=True)
        st.download_button(
            "Download fills as CSV",
            orders.to_csv(index=False),
            file_name="paper_trades.csv",
            mime="text/csv",
        )
    today = datetime.now(ET).date().isoformat()
    risk_cols = st.columns(3)
    risk_cols[0].metric(
        "Day realized P&L", f"${broker.realized_pnl(today, 'day'):,.2f}"
    )
    risk_cols[1].metric("Opening day trades", broker.opening_trades(today, "day"))
    risk_cols[2].metric(
        "Weekly-options realized P&L",
        f"${broker.realized_pnl(strategy='weekly'):,.2f}",
    )
