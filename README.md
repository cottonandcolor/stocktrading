# Beat SPY Backtester

## Agent Harness Hackathon (FinGuard)

KYC-aware financial advisor on TrueForge: see [`HACKATHON.md`](HACKATHON.md) and [`finguard/`](finguard/).

Takes a starting capital of $25,000 and backtests several well-known systematic
strategies against buy-and-hold SPY, using real historical data from Yahoo Finance.

## Strategies

| Strategy | Rule |
|---|---|
| SPY buy & hold | The benchmark. Buy SPY, never sell. |
| 200-day SMA trend | Hold SPY while it closes above its 200-day moving average, otherwise sit in cash. |
| Leveraged trend | Same signal, but hold SSO (2x daily SPY) when risk-on. |
| Dual momentum | Monthly: hold SPY or QQQ, whichever has the better trailing 12-month return; if that return is negative, hold TLT (long bonds) instead. |

Signals are lagged one day (no look-ahead), dividends are reinvested
(adjusted prices), and a per-trade cost (default 5 bps) is charged on turnover.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
.venv/bin/python beat_spy.py                    # defaults: $25k from 2007
.venv/bin/python beat_spy.py --start 2015-01-01 --capital 25000 --cost-bps 10
```

Prints a comparison table (final value, CAGR, max drawdown, Sharpe, trades)
and saves an equity-curve chart to `results.png`.

## Weekly options analyzer

`options_friday.py` pulls a live option chain and shows what a given expiry is
actually pricing, in three views:

```bash
.venv/bin/python options_friday.py --view buy --max-premium 0.60   # cost of "cheap" long options
.venv/bin/python options_friday.py --view credit --width 5         # defined-risk credit spreads
.venv/bin/python options_friday.py --view csp --cash 80000         # cash-secured puts
```

The `buy` view is the useful one for sanity-checking a hunch: for every
out-of-the-money strike it reports the move required, the market-implied
probability of profit, and the share of your premium consumed by the bid-ask
spread on entry.

## Local paper trading platform

Browser dashboard with a persistent $25,000 paper account, stock tickets,
defined-risk debit spreads, opening-range strategy scanner, and risk lockouts.

```bash
.venv/bin/streamlit run paper_platform.py
```

Opens at `http://localhost:8501`. State is stored in `paper_platform.db`.
Nothing is sent to a broker.

### Monday morning auto-launch

`monday_morning.sh` starts the dashboard, opens the browser, and opens an
interactive Terminal running `day_trader.py --live` so you can type `YES` on
READY signals.

```bash
./monday_morning.sh          # run now
atq                          # list scheduled jobs
atrm 1                       # cancel job id 1
```

## Approval-based paper day trader

`day_trader.py` automates the Monday watchlist as a local paper simulation. It
never connects to a brokerage or places a real order.

```bash
# Start before 9:20 a.m. Eastern and leave it running through the session.
.venv/bin/python day_trader.py --live

# Inspect one scan without accepting a paper trade.
.venv/bin/python day_trader.py --once --reject

# Run deterministic tests for signals, sizing, daily limits, and exits.
.venv/bin/python -m unittest -v test_day_trader.py
```

The scanner:

- waits until 9:45 a.m. Eastern and calculates the first 15-minute range;
- requires a breakout, a later retest, VWAP confirmation, QQQ confirmation,
  and at least 1.5x cumulative relative volume;
- asks for an explicit `YES` before opening a simulated position;
- risks at most $62.50 per trade, limits notional value to 25% of the $25,000
  paper sleeve, allows two trades, and locks after a $125 realized daily loss;
- takes half off at 1R, moves the stop to breakeven, targets 2R, and closes
  remaining positions at 3:50 p.m. Eastern;
- writes its local state to `paper_trades.json`.

Yahoo one-minute quotes may be delayed and do not provide a reliable live
bid-ask spread. Before approving a paper signal, verify in the brokerage that
the spread is no more than 0.15% of the share price. The watchlist catalysts
are also entered manually and must be revalidated before each new session.

Reusable expert scan prompts:

- Equity day trades: [`prompts/day_trade_scan.md`](prompts/day_trade_scan.md)
- Short-term options: [`prompts/short_term_options.md`](prompts/short_term_options.md)
- Two-agent day trade: [`prompts/dual_agent_winning_trade.md`](prompts/dual_agent_winning_trade.md)
- Two-agent beat SPY: [`prompts/dual_agent_beat_spy.md`](prompts/dual_agent_beat_spy.md)
- Two-agent buy signals: [`prompts/dual_agent_buy_signals.md`](prompts/dual_agent_buy_signals.md)
- Two-agent finance + math buys: [`prompts/dual_agent_finance_math_buys.md`](prompts/dual_agent_finance_math_buys.md)
- Two-agent weekly options: [`prompts/dual_agent_weekly_options.md`](prompts/dual_agent_weekly_options.md)

## Disclaimer

Past performance does not predict future results. This is a research /
educational tool, not investment advice. Backtested strategies often look
better than they perform live (overfitting, regime change, slippage).
