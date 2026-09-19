"""Analyze a weekly (Friday) option chain before you trade it.

Three views, each answering a different question:

  buy     -- what am I actually getting for a "cheap" out-of-the-money option?
             Shows required move, market-implied probability of profit, and the
             bid/ask spread you pay the instant you enter.

  credit  -- defined-risk credit spreads (you collect premium instead of paying
             it). Shows max profit, max loss, and the breakeven odds you need.

  csp     -- cash-secured puts: get paid to place a limit order on something you
             want to own anyway. Sized against the cash you actually have.

Usage:
  python options_friday.py --ticker SPY --expiry 2026-08-07 --view buy
  python options_friday.py --view credit --width 5
  python options_friday.py --view csp --cash 25000
"""

import argparse
import math
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

# Annualized risk-free rate, roughly the 13-week T-bill. Barely matters at a
# 2-day horizon, but it keeps the Black-Scholes math honest.
RISK_FREE = 0.037


def norm_cdf(x):
    """Standard normal CDF via erf — avoids a scipy dependency."""
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_probabilities(spot, strike, vol, years, is_call):
    """Return (delta, prob_itm) under Black-Scholes.

    prob_itm is N(d2), the market's risk-neutral probability that the option
    finishes in the money. Using it with the breakeven price instead of the
    strike gives the probability the trade actually makes money.
    """
    if years <= 0 or vol <= 0 or spot <= 0 or strike <= 0:
        return float("nan"), float("nan")
    d1 = (math.log(spot / strike) + (RISK_FREE + vol**2 / 2) * years) / (vol * math.sqrt(years))
    d2 = d1 - vol * math.sqrt(years)
    if is_call:
        return norm_cdf(d1), norm_cdf(d2)
    return norm_cdf(d1) - 1, norm_cdf(-d2)


def load_chain(ticker, expiry):
    tk = yf.Ticker(ticker)
    expiries = tk.options
    if not expiries:
        raise SystemExit(f"no option data for {ticker}")
    if expiry is None:
        expiry = next_friday(expiries)
    if expiry not in expiries:
        raise SystemExit(f"{expiry} not listed. Available: {', '.join(expiries[:8])}")

    spot = tk.history(period="1d")["Close"].iloc[-1]
    chain = tk.option_chain(expiry)
    # Options stop trading at 4pm ET on the expiry date, i.e. 20:00 UTC.
    expiry_moment = datetime.strptime(expiry, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)
    days = (expiry_moment - datetime.now(timezone.utc)).total_seconds() / 86400
    return spot, chain, expiry, max(days, 0.01)


def next_friday(expiries):
    for e in expiries:
        if datetime.strptime(e, "%Y-%m-%d").weekday() == 4:
            return e
    return expiries[0]


def clean(df):
    """Keep strikes with real two-sided quotes and some open interest."""
    df = df.copy()
    df["mid"] = (df["bid"] + df["ask"]) / 2
    df = df[(df["bid"] > 0) & (df["ask"] > 0) & (df["mid"] > 0)]
    df["spread_pct"] = (df["ask"] - df["bid"]) / df["mid"] * 100
    return df


# ----------------------------------------------------------------------------
# View 1: what a "cheap" long option actually costs you
# ----------------------------------------------------------------------------

def view_buy(spot, chain, days, max_premium):
    years = days / 365
    rows = []
    for side, df in (("call", clean(chain.calls)), ("put", clean(chain.puts))):
        is_call = side == "call"
        otm = df[df["strike"] > spot] if is_call else df[df["strike"] < spot]
        for _, r in otm.iterrows():
            if r["mid"] > max_premium:
                continue
            breakeven = r["strike"] + r["mid"] if is_call else r["strike"] - r["mid"]
            _, prob_itm = bs_probabilities(spot, r["strike"], r["impliedVolatility"], years, is_call)
            _, prob_profit = bs_probabilities(spot, breakeven, r["impliedVolatility"], years, is_call)
            rows.append({
                "side": side,
                "strike": r["strike"],
                "cost_per_contract": r["mid"] * 100,
                "required_move_pct": (breakeven / spot - 1) * 100,
                "prob_finish_itm": prob_itm * 100,
                "prob_profit": prob_profit * 100,
                "spread_pct_of_premium": r["spread_pct"],
                "open_interest": r["openInterest"],
            })
    out = pd.DataFrame(rows).sort_values("cost_per_contract")
    return out[out["prob_profit"].notna()]


# ----------------------------------------------------------------------------
# View 2: defined-risk credit spreads (selling premium)
# ----------------------------------------------------------------------------

def view_credit(spot, chain, days, width):
    """Put credit spreads below spot, call credit spreads above.

    Sell the near strike, buy the far one `width` points away. Max loss is
    capped at the width minus the credit, so this can't blow up the account.
    """
    years = days / 365
    rows = []
    for side, df in (("put credit", clean(chain.puts)), ("call credit", clean(chain.calls))):
        is_call = "call" in side
        df = df.set_index("strike").sort_index()
        candidates = df[df.index > spot] if is_call else df[df.index < spot]
        for strike in candidates.index:
            long_strike = strike + width if is_call else strike - width
            if long_strike not in df.index:
                continue
            short_leg, long_leg = df.loc[strike], df.loc[long_strike]
            # Conservative fill: sell at the bid, buy at the ask.
            credit = short_leg["bid"] - long_leg["ask"]
            if credit <= 0:
                continue
            max_loss = width - credit
            breakeven = strike + credit if is_call else strike - credit
            _, prob_touch = bs_probabilities(
                spot, breakeven, short_leg["impliedVolatility"], years, is_call
            )
            win_rate = (1 - prob_touch) * 100
            # Break-even win rate: below this, the strategy loses money long-run.
            required = max_loss / (credit + max_loss) * 100
            rows.append({
                "type": side,
                "short_strike": strike,
                "long_strike": long_strike,
                "credit": credit * 100,
                "max_loss": max_loss * 100,
                "market_win_prob": win_rate,
                "breakeven_win_rate_needed": required,
                "edge_pct_pts": win_rate - required,
                "distance_from_spot_pct": (strike / spot - 1) * 100,
            })
    out = pd.DataFrame(rows)
    return out.sort_values("distance_from_spot_pct")


# ----------------------------------------------------------------------------
# View 3: cash-secured puts
# ----------------------------------------------------------------------------

def view_csp(spot, chain, days, cash):
    years = days / 365
    puts = clean(chain.puts)
    puts = puts[puts["strike"] < spot]
    rows = []
    for _, r in puts.iterrows():
        collateral = r["strike"] * 100
        if collateral > cash:
            continue
        credit = r["bid"] * 100
        _, prob_assigned = bs_probabilities(spot, r["strike"], r["impliedVolatility"], years, False)
        rows.append({
            "strike": r["strike"],
            "collateral_needed": collateral,
            "premium_collected": credit,
            "yield_on_cash_pct": credit / collateral * 100,
            "annualized_pct": credit / collateral * (365 / days) * 100,
            "discount_if_assigned_pct": (1 - (r["strike"] - r["bid"]) / spot) * 100,
            "prob_assigned": prob_assigned * 100,
        })
    return pd.DataFrame(rows).sort_values("strike", ascending=False)


def main():
    p = argparse.ArgumentParser(description="Weekly option chain analyzer")
    p.add_argument("--ticker", default="SPY")
    p.add_argument("--expiry", default=None, help="YYYY-MM-DD; defaults to next listed Friday")
    p.add_argument("--view", choices=["buy", "credit", "csp"], default="buy")
    p.add_argument("--max-premium", type=float, default=1.50,
                   help="buy view: only show options under this price per share")
    p.add_argument("--width", type=float, default=5, help="credit view: spread width in points")
    p.add_argument("--cash", type=float, default=25_000, help="csp view: cash available as collateral")
    args = p.parse_args()

    spot, chain, expiry, days = load_chain(args.ticker, args.expiry)
    print(f"{args.ticker} spot ${spot:,.2f} | expiry {expiry} | {days:.1f} days to expiration\n")

    pd.set_option("display.width", 200)
    pd.set_option("display.max_rows", 60)
    fmt = lambda df: df.to_string(index=False, float_format=lambda v: f"{v:,.2f}")

    if args.view == "buy":
        df = view_buy(spot, chain, days, args.max_premium)
        print(f"Long options under ${args.max_premium:.2f}/share "
              f"(${args.max_premium * 100:.0f} per contract):\n")
        print(fmt(df))
        print("\nprob_profit is the market's own implied probability that this trade "
              "makes money.\nspread_pct_of_premium is what you lose instantly on entry.")
    elif args.view == "credit":
        df = view_credit(spot, chain, days, args.width)
        print(f"{args.width:.0f}-point credit spreads (sell near strike, buy far strike):\n")
        print(fmt(df))
        print("\nedge_pct_pts = market win probability minus the win rate you need "
              "to break even.\nValues near zero mean the market is pricing this fairly — "
              "there is no free lunch here.")
    else:
        df = view_csp(spot, chain, days, args.cash)
        print(f"Cash-secured puts affordable with ${args.cash:,.0f} collateral:\n")
        print(fmt(df))
        print("\nIf assigned you buy 100 shares per contract at the strike, having "
              "kept the premium.\nOnly sell these on something you genuinely want to own.")


if __name__ == "__main__":
    main()
