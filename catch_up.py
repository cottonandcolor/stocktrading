"""Which lever actually moves the outcome?

Compares the four things an investor can change -- idle cash, deployment,
staying invested through a drawdown, and contribution rate -- against the
one most people spend their attention on, which is security selection.

    python catch_up.py
    python catch_up.py --years 20 --monthly 1500
"""

import argparse

# From the account data provided 2026-08-05 (Schwab) and 2026-08-07 (Fidelity).
SWEEP_IDLE = 50_779.35      # Schwab cash sweep, effectively unremunerated
MMF_TAXABLE = 107_810.77    # SWVXX
ROTH_CASH = 74_146.38       # Fidelity money market
TAXABLE_INVESTED = 17_077.00
ROTH_INVESTED = 135_781.50

SWEEP_YIELD = 0.0005
MMF_YIELD = 0.040
BALANCED_RETURN = 0.070


def fv(pv, rate, years):
    return pv * (1 + rate) ** years


def fv_stream(monthly, rate, years):
    """Future value of a monthly contribution, compounded monthly."""
    r = rate / 12
    n = int(years * 12)
    return monthly * (((1 + r) ** n - 1) / r) if r else monthly * n


def panic_cost(portfolio, drop, reentry_above_bottom):
    """Permanent shortfall from selling at the bottom and buying back higher.

    Re-entering after the market has risen off its low buys back fewer shares,
    so the loss persists even after a full recovery.
    """
    return portfolio * (1 - 1 / (1 + reentry_above_bottom))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--years", type=float, default=10)
    p.add_argument("--monthly", type=float, default=1000)
    p.add_argument("--spec", type=float, default=2000, help="speculation budget")
    a = p.parse_args()
    yrs = a.years

    cash = SWEEP_IDLE + MMF_TAXABLE + ROTH_CASH
    invested = TAXABLE_INVESTED + ROTH_INVESTED
    total = cash + invested

    print(f"Portfolio {total:>12,.0f}")
    print(f"  cash    {cash:>12,.0f}   {cash/total:>5.1%}")
    print(f"  invested{invested:>12,.0f}   {invested/total:>5.1%}\n")
    print(f"Horizon: {yrs:.0f} years\n")

    rows = []

    # 1. Idle sweep -> money market. Same risk, same liquidity, better yield.
    rows.append((
        "Sweep cash -> money market",
        SWEEP_IDLE * (MMF_YIELD - SWEEP_YIELD),
        fv(SWEEP_IDLE, MMF_YIELD, yrs) - fv(SWEEP_IDLE, SWEEP_YIELD, yrs),
        "certain",
    ))

    # 2. Deploy the cash pile into a balanced portfolio.
    rows.append((
        "Deploy cash -> balanced 7%",
        cash * (BALANCED_RETURN - MMF_YIELD),
        fv(cash, BALANCED_RETURN, yrs) - fv(cash, MMF_YIELD, yrs),
        "expected",
    ))

    # 3. Sit through one bear market instead of selling the low.
    grown = fv(total, BALANCED_RETURN, yrs)
    rows.append((
        "Avoid one panic sell",
        panic_cost(grown, 0.30, 0.20) / yrs,
        panic_cost(grown, 0.30, 0.20),
        "certain if it happens",
    ))

    # 4. Contribute.
    rows.append((
        f"Contribute ${a.monthly:,.0f}/mo",
        fv_stream(a.monthly, BALANCED_RETURN, yrs) / yrs,
        fv_stream(a.monthly, BALANCED_RETURN, yrs),
        "fully in your control",
    ))

    # 5. The lever getting all the attention.
    rows.append((
        f"Double a ${a.spec:,.0f} speculation",
        a.spec / yrs,
        a.spec,
        "unlikely, once",
    ))

    rows.sort(key=lambda r: -r[2])
    print(f"{'lever':<32}{'$/yr':>11}{'total':>13}   reliability")
    print("-" * 78)
    for name, per_yr, tot, note in rows:
        print(f"{name:<32}{per_yr:>11,.0f}{tot:>13,.0f}   {note}")

    # What return do you actually need? The antidote to "behind" is a number.
    print(f"\nRequired return to hit a target in {yrs:.0f}y "
          f"(adding ${a.monthly:,.0f}/mo):")
    print(f"{'target':>12}{'needed CAGR':>14}")
    for target in (600_000, 800_000, 1_000_000, 1_500_000):
        lo, hi = -0.05, 0.40
        for _ in range(200):
            mid = (lo + hi) / 2
            if fv(total, mid, yrs) + fv_stream(a.monthly, mid, yrs) < target:
                lo = mid
            else:
                hi = mid
        print(f"{target:>12,.0f}{(lo+hi)/2:>13.1%}")


if __name__ == "__main__":
    main()
