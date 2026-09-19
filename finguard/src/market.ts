/**
 * Live market data via Yahoo Finance (yahoo-finance2).
 * Exposed to TrueForge through FinGuard MCP tools — not a direct TrueForge DB.
 */
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

export type QuoteResult = {
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  market_state?: string;
  price?: number | null;
  previous_close?: number | null;
  change?: number | null;
  change_pct?: number | null;
  day_high?: number | null;
  day_low?: number | null;
  volume?: number | null;
  market_cap?: number | null;
  fifty_two_week_high?: number | null;
  fifty_two_week_low?: number | null;
  as_of: string;
  source: "yahoo_finance";
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function fetchQuote(symbol: string): Promise<QuoteResult> {
  const sym = symbol.trim().toUpperCase();
  const q = await yahooFinance.quote(sym);
  const price = num(q.regularMarketPrice);
  const prev = num(q.regularMarketPreviousClose);
  const change = num(q.regularMarketChange);
  const changePct = num(q.regularMarketChangePercent);
  return {
    symbol: q.symbol || sym,
    name: q.shortName || q.longName || undefined,
    currency: q.currency || undefined,
    exchange: q.fullExchangeName || q.exchange || undefined,
    market_state: q.marketState || undefined,
    price,
    previous_close: prev,
    change,
    change_pct: changePct,
    day_high: num(q.regularMarketDayHigh),
    day_low: num(q.regularMarketDayLow),
    volume: num(q.regularMarketVolume),
    market_cap: num(q.marketCap),
    fifty_two_week_high: num(q.fiftyTwoWeekHigh),
    fifty_two_week_low: num(q.fiftyTwoWeekLow),
    as_of: new Date().toISOString(),
    source: "yahoo_finance",
  };
}

export async function fetchQuotes(symbols: string[]): Promise<QuoteResult[]> {
  const unique = [
    ...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ];
  const out: QuoteResult[] = [];
  for (const sym of unique.slice(0, 20)) {
    try {
      out.push(await fetchQuote(sym));
    } catch (e) {
      out.push({
        symbol: sym,
        as_of: new Date().toISOString(),
        source: "yahoo_finance",
        price: null,
        name: e instanceof Error ? `error: ${e.message}` : "error",
      });
    }
  }
  return out;
}

export type OhlcBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export async function fetchOhlcBars(
  symbol: string,
  days = 220
): Promise<{ symbol: string; as_of: string; bars: OhlcBar[] }> {
  const sym = symbol.trim().toUpperCase();
  const period2 = new Date();
  const period1 = new Date(Date.now() - Math.max(days, 30) * 86400000);
  const rows = await yahooFinance.historical(sym, {
    period1,
    period2,
    interval: "1d",
  });
  const bars: OhlcBar[] = (rows || [])
    .filter(
      (r) =>
        typeof r.close === "number" &&
        typeof r.open === "number" &&
        typeof r.high === "number" &&
        typeof r.low === "number"
    )
    .map((r) => ({
      date:
        r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date),
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      volume: typeof r.volume === "number" ? r.volume : undefined,
    }));
  return { symbol: sym, as_of: new Date().toISOString(), bars };
}

export async function fetchHistory(
  symbol: string,
  days = 30
): Promise<{
  symbol: string;
  days: number;
  as_of: string;
  source: "yahoo_finance";
  bars: Array<{ date: string; close: number; volume?: number }>;
}> {
  const { symbol: sym, as_of, bars } = await fetchOhlcBars(symbol, days);
  return {
    symbol: sym,
    days,
    as_of,
    source: "yahoo_finance",
    bars: bars.map((b) => ({
      date: b.date,
      close: b.close,
      volume: b.volume,
    })),
  };
}

export async function liveMarketSnapshot(symbols?: string[]) {
  const list = symbols?.length
    ? symbols
    : ["SPY", "QQQ", "IWM", "TLT", "GLD", "BIL"];
  const quotes = await fetchQuotes(list);
  return {
    as_of: new Date().toISOString(),
    source: "yahoo_finance",
    disclaimer:
      "Live quotes from Yahoo Finance via FinGuard MCP. Educational only — not licensed advice; verify before any real decision.",
    quotes,
  };
}
