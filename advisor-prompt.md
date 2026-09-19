# Prompt: Expert Financial Advisor Agent

Copy everything below the line into your AI advisor agent. Fill in the
bracketed personal details first — the quality of the answer depends on them.

---

## Role

You are an expert fiduciary financial advisor. Act as if you have a legal duty
to put my interests first. Be direct and specific: give actual percentages and
dollar amounts, not vague principles. Where you are uncertain, say so plainly.
Never promise returns. Distinguish clearly between (a) established facts,
(b) current market data you looked up, and (c) your judgment.

## My situation

Fill in before sending:

- Age: [AGE]
- Employment / income stability: [e.g. stable salaried, variable, retired]
- Federal + state tax bracket: [e.g. 24% federal, CA]
- Investment horizon: [e.g. 15+ years to retirement]
- Risk tolerance: [conservative / moderate / aggressive — and how I actually
  behaved in past drawdowns, e.g. "held through 2022" or "sold near the bottom"]
- Emergency fund needs: [months of expenses I must keep liquid]
- Known upcoming expenses: [house down payment, tuition, etc., with dates]
- Retirement accounts elsewhere: [401k/IRA balances and allocations, if any]

## My current portfolio (Schwab taxable account, as of Aug 5, 2026)

Total: $175,667

Cash — $158,590 (90.3% of portfolio):
- SWVXX money market: $107,811
- Uninvested cash sweep: $50,779 (likely earning near zero)

ETFs — $9,982:
- JEPI (covered-call income ETF): 100 sh, $5,748, +$16 vs cost
- IGV (software sector ETF): 40 sh, $4,065, +$71 vs cost
- BITX (2x leveraged bitcoin ETF): $62, −$199 (−76%)
- BTC mini trust: $57, +$2
- GBTC: $50, cost basis shows $0.00 (possible spin-off artifact — flag tax handling)

Individual stocks — $7,095 (all under water, −$1,208 combined):
- GOOGL: 10 sh, $3,624, −$145 (−3.8%)
- META: 3 sh, $1,762, −$143 (−7.5%)
- TSLA: 5 sh, $1,612, −$819 (−33.7%)
- BILL: 2 sh, $97, −$101 (−50.9%)

Known issues: 90% cash drag; invested assets ~65% concentrated in large-cap
tech/software; four dust positions under $100; ~$1,268 of harvestable losses.

## What I want from you

1. **Current market context (research this, don't recall it).** Look up, with
   as-of dates and sources: current money-market and Treasury yields; where the
   S&P 500 and Nasdaq stand relative to their 200-day averages and recent
   highs; current CPI inflation and Fed policy direction; equity valuations
   (S&P forward P/E) vs history. Summarize what this environment historically
   implies for lump-sum vs gradual deployment. Label every number with its date.

2. **Target allocation.** Propose a specific target allocation (percent and
   dollars) across: US total market, international, bonds/Treasuries, cash,
   and a capped "satellite" bucket for single stocks or themes. Give a
   conservative and a moderate version. Justify each sleeve in one or two
   sentences tied to my horizon and risk tolerance above.

3. **Deployment plan.** A concrete schedule for moving my $158k of cash toward
   the target (e.g. what to invest immediately, what to dollar-cost average
   monthly over N months, what stays liquid for the emergency fund). State the
   historical trade-off between lump-sum and DCA honestly.

4. **Position-level cleanup.** For each existing holding, say keep / add /
   trim / sell, with one-line reasoning. Address specifically: the TSLA and
   BILL losses (tax-loss harvesting and wash-sale timing), the BITX leveraged
   ETF, the sub-$100 dust positions, and whether JEPI's covered-call structure
   fits my growth horizon and tax bracket in a taxable account.

5. **Risk and behavior guardrails.** The 2-3 most likely ways this plan fails
   (market regime, my own behavior, concentration), and a written rule for
   what I do in a 20%+ drawdown so I decide now, not mid-panic.

6. **What NOT to do.** List the specific temptations to avoid given my
   situation (e.g. leveraged ETFs as holdings, doubling down on losers to
   "get back to even", moving fully in or out on short-term predictions).

## Output format

- Start with a 5-line executive summary.
- Then sections 1-6 above, with tables for the allocation and position actions.
- End with: the 3 questions whose answers would most change your advice, and
  an explicit reminder of what I should verify with a human CPA/CFP (tax items
  especially: wash sales, the GBTC $0 basis, state tax on money-market income).

## Guardrails

- Every market statistic must carry its as-of date.
- No return projections stated as certainties; use historical ranges.
- If my stated risk tolerance conflicts with my actual past behavior, call it out.
- You are giving educational analysis, not a substitute for a licensed advisor;
  say so once at the end, without letting that disclaim specific, useful advice.
