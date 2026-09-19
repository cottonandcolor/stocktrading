"""Backtest: can $25,000 beat buy-and-hold SPY?

Downloads real historical market data and pits several well-known
systematic strategies against a SPY buy-and-hold benchmark, all
starting from the same $25,000.

Strategies:
  1. SPY buy & hold                     -- the benchmark to beat
  2. Trend following (200-day SMA)      -- hold SPY above its 200d SMA, else cash
  3. Leveraged trend (SSO, 2x SPY)      -- hold 2x SPY above the 200d SMA, else cash
  4. Dual momentum (SPY/QQQ/TLT)        -- monthly: best 12-mo performer; bonds if
                                           stock momentum is negative

Usage:
  python beat_spy.py [--capital 25000] [--start 2007-01-01] [--cost-bps 5]
"""

import argparse
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import yfinance as yf

TRADING_DAYS = 252


# ----------------------------------------------------------------------------
# Data
# ----------------------------------------------------------------------------

def fetch_prices(tickers, start):
    """Adjusted close prices (dividends reinvested), one column per ticker."""
    data = yf.download(
        tickers, start=start, auto_adjust=True, progress=False, group_by="column"
    )
    close = data["Close"] if isinstance(data.columns, pd.MultiIndex) else data[["Close"]]
    close = close.dropna(how="all")
    missing = [t for t in tickers if t not in close.columns or close[t].dropna().empty]
    if missing:
        sys.exit(f"error: no price data for {missing}; check tickers or connection")
    return close


# ----------------------------------------------------------------------------
# Strategy signals (each returns a daily portfolio-weight DataFrame)
# ----------------------------------------------------------------------------

def buy_and_hold(prices, ticker="SPY"):
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w[ticker] = 1.0
    return w


def sma_trend(prices, ticker="SPY", window=200):
    """Fully invested when price closes above its SMA, cash otherwise.
    Signal is lagged one day: we trade at the close after the signal day."""
    px = prices[ticker]
    signal = (px > px.rolling(window).mean()).shift(1, fill_value=False)
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w.loc[signal, ticker] = 1.0
    return w


def leveraged_trend(prices, signal_ticker="SPY", hold_ticker="SSO", window=200):
    """Same 200d SMA signal on SPY, but hold the 2x leveraged fund when risk-on."""
    px = prices[signal_ticker]
    signal = (px > px.rolling(window).mean()).shift(1, fill_value=False)
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w.loc[signal, hold_ticker] = 1.0
    return w


def dual_momentum(prices, stocks=("SPY", "QQQ"), defensive="TLT", lookback=252):
    """Classic dual momentum, rebalanced monthly.

    Relative momentum: pick the stock fund with the higher trailing 12-month
    return. Absolute momentum: if that return is negative, hide in bonds.
    """
    momentum = prices.pct_change(lookback)
    month_ends = prices.groupby(prices.index.to_period("M")).tail(1).index

    w = pd.DataFrame(np.nan, index=prices.index, columns=prices.columns)
    for date in month_ends:
        mom = momentum.loc[date, list(stocks)]
        if mom.isna().any():
            continue
        winner = mom.idxmax()
        pick = winner if mom[winner] > 0 else defensive
        w.loc[date] = 0.0
        w.loc[date, pick] = 1.0
    # Hold each month's pick until the next rebalance; trade lags the signal day.
    return w.ffill().shift(1).fillna(0.0)


def golden_cross(prices, ticker="SPY", fast=50, slow=200):
    """Hold SPY while the 50d SMA is above the 200d SMA, else cash.
    Slower than the price-vs-SMA rule: far fewer whipsaw trades."""
    px = prices[ticker]
    signal = (px.rolling(fast).mean() > px.rolling(slow).mean()).shift(1, fill_value=False)
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w.loc[signal, ticker] = 1.0
    return w


def rsi2_mean_reversion(prices, ticker="SPY", buy_below=10, sell_above=65, trend=200):
    """Connors RSI(2) dip-buying: in an uptrend (above 200d SMA), buy sharp
    2-day oversold dips and exit on the bounce. Short holding periods (~days)."""
    px = prices[ticker]
    delta = px.diff()
    gain = delta.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean()
    rsi = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    uptrend = px > px.rolling(trend).mean()

    holding = pd.Series(False, index=px.index)
    in_pos = False
    for i, date in enumerate(px.index):
        if in_pos and (rsi.iloc[i] > sell_above or not uptrend.iloc[i]):
            in_pos = False
        elif not in_pos and uptrend.iloc[i] and rsi.iloc[i] < buy_below:
            in_pos = True
        holding.iloc[i] = in_pos

    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w.loc[holding.shift(1, fill_value=False), ticker] = 1.0
    return w


def vol_targeting(prices, ticker="SPY", target=0.15, window=20, max_leverage=1.5):
    """Scale SPY exposure so realized volatility stays near the target.
    Sizes up in calm markets (up to 1.5x, assumes margin) and down in turmoil."""
    returns = prices[ticker].pct_change()
    realized = returns.rolling(window).std() * np.sqrt(TRADING_DAYS)
    exposure = (target / realized).clip(upper=max_leverage).shift(1).fillna(0.0)
    w = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    w[ticker] = exposure
    return w


def sixty_forty(prices, stock="SPY", bond="TLT"):
    """60% SPY / 40% TLT, rebalanced monthly. The defensive baseline."""
    month_ends = prices.groupby(prices.index.to_period("M")).tail(1).index
    w = pd.DataFrame(np.nan, index=prices.index, columns=prices.columns)
    w.loc[month_ends] = 0.0
    w.loc[month_ends, stock] = 0.6
    w.loc[month_ends, bond] = 0.4
    return w.ffill().shift(1).fillna(0.0)


# ----------------------------------------------------------------------------
# Backtest engine
# ----------------------------------------------------------------------------

def run_backtest(prices, weights, capital, cost_bps):
    """Daily-rebalanced weight-based backtest with per-trade costs."""
    daily_returns = prices.pct_change().fillna(0.0)
    portfolio_returns = (weights * daily_returns).sum(axis=1)
    turnover = (weights - weights.shift(1)).abs().sum(axis=1).fillna(0.0)
    costs = turnover * (cost_bps / 10_000)
    equity = capital * (1 + portfolio_returns - costs).cumprod()
    trades = int((turnover > 0).sum())
    return equity, trades


def metrics(equity, trades):
    returns = equity.pct_change().dropna()
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1
    drawdown = equity / equity.cummax() - 1
    vol = returns.std() * np.sqrt(TRADING_DAYS)
    sharpe = returns.mean() / returns.std() * np.sqrt(TRADING_DAYS) if returns.std() > 0 else 0.0
    return {
        "final": equity.iloc[-1],
        "cagr": cagr,
        "max_dd": drawdown.min(),
        "vol": vol,
        "sharpe": sharpe,
        "trades": trades,
    }


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Backtest $25k vs SPY buy-and-hold")
    parser.add_argument("--capital", type=float, default=25_000)
    parser.add_argument("--start", default="2007-01-01",
                        help="backtest start (needs ~1yr of earlier data for signals)")
    parser.add_argument("--cost-bps", type=float, default=5,
                        help="one-way transaction cost in basis points")
    parser.add_argument("--out", default="results.png")
    args = parser.parse_args()

    # Fetch extra history before the start date so SMA/momentum signals are
    # warm on day one of the actual backtest.
    warmup_start = (pd.Timestamp(args.start) - pd.DateOffset(months=18)).date().isoformat()
    tickers = ["SPY", "QQQ", "TLT", "SSO"]
    print(f"Downloading data for {tickers} from {warmup_start}...")
    prices = fetch_prices(tickers, warmup_start)

    strategies = {
        "SPY buy & hold (benchmark)": buy_and_hold(prices),
        "Trend: SPY above 200d SMA else cash": sma_trend(prices),
        "Leveraged trend: SSO above SPY 200d SMA": leveraged_trend(prices),
        "Dual momentum: SPY/QQQ, TLT defensive": dual_momentum(prices),
    }

    start = pd.Timestamp(args.start)
    results = {}
    for name, weights in strategies.items():
        equity, trades = run_backtest(
            prices.loc[start:], weights.loc[start:], args.capital, args.cost_bps
        )
        results[name] = (equity, metrics(equity, trades))

    first_equity = next(iter(results.values()))[0]
    period = f"{first_equity.index[0].date()} to {first_equity.index[-1].date()}"
    benchmark_final = results["SPY buy & hold (benchmark)"][1]["final"]

    print(f"\nStarting capital: ${args.capital:,.0f}   Period: {period}")
    print(f"Costs: {args.cost_bps} bps per trade\n")
    header = f"{'Strategy':<42}{'Final $':>12}{'CAGR':>8}{'MaxDD':>8}{'Sharpe':>8}{'Trades':>8}  vs SPY"
    print(header)
    print("-" * len(header))
    for name, (equity, m) in results.items():
        beat = m["final"] / benchmark_final - 1
        vs = "   --" if "benchmark" in name else f"{beat:+7.1%}"
        print(
            f"{name:<42}{m['final']:>12,.0f}{m['cagr']:>8.1%}"
            f"{m['max_dd']:>8.1%}{m['sharpe']:>8.2f}{m['trades']:>8}  {vs}"
        )

    fig, ax = plt.subplots(figsize=(12, 6.5))
    for name, (equity, m) in results.items():
        style = {"linewidth": 2.5, "color": "black"} if "benchmark" in name else {"linewidth": 1.5}
        ax.plot(equity.index, equity.values, label=f"{name} (${m['final']:,.0f})", **style)
    ax.set_yscale("log")
    ax.set_title(f"Growth of ${args.capital:,.0f}: strategies vs SPY buy & hold ({period})")
    ax.set_ylabel("Portfolio value ($, log scale)")
    ax.legend(loc="upper left", fontsize=9)
    ax.grid(True, which="both", alpha=0.3)
    fig.tight_layout()
    fig.savefig(args.out, dpi=130)
    print(f"\nChart saved to {args.out}")


if __name__ == "__main__":
    main()
