/**
 * Technical analysis from Yahoo Finance daily OHLC (via FinGuard MCP).
 * Educational indicators only — not trading advice.
 */
import { fetchOhlcBars, fetchQuote, type OhlcBar } from "./market.js";

function round(n: number | null | undefined, d = 4): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes: number[]) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? (ema12[i] as number) - (ema26[i] as number) : null
  );
  const macdVals = macdLine.map((v) => v ?? 0);
  // Signal on MACD values but only meaningful after ema26 exists
  const signalRaw = ema(
    macdVals.map((v, i) => (macdLine[i] == null ? 0 : v)),
    9
  );
  const signal: (number | null)[] = macdLine.map((v, i) =>
    v == null || signalRaw[i] == null || i < 26 + 8 ? null : signalRaw[i]
  );
  const hist: (number | null)[] = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v - (signal[i] as number) : null
  );
  return { macdLine, signal, hist };
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: (number | null)[] = Array(closes.length).fill(null);
  const lower: (number | null)[] = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i] as number;
    const variance =
      slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function atr(bars: OhlcBar[], period = 14): (number | null)[] {
  const out: (number | null)[] = Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      trs.push(bars[i].high - bars[i].low);
      continue;
    }
    const prevClose = bars[i - 1].close;
    trs.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose)
      )
    );
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  out[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    out[i] =
      ((out[i - 1] as number) * (period - 1) + trs[i]) / period;
  }
  return out;
}

function lastNonNull(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

function trendLabel(price: number, sma50: number | null, sma200: number | null) {
  if (sma50 == null || sma200 == null) return "insufficient_data";
  if (price > sma50 && sma50 > sma200) return "bullish";
  if (price < sma50 && sma50 < sma200) return "bearish";
  return "mixed";
}

function rsiLabel(v: number | null) {
  if (v == null) return "n/a";
  if (v >= 70) return "overbought";
  if (v <= 30) return "oversold";
  return "neutral";
}

export async function technicalAnalysis(
  symbol: string,
  lookbackDays = 260
) {
  // Calendar days ≠ trading days; pull extra history so SMA200 can compute.
  const needed = Math.max(Math.ceil(lookbackDays * 1.7), 420);
  const [{ bars, as_of, symbol: sym }, quote] = await Promise.all([
    fetchOhlcBars(symbol, needed),
    fetchQuote(symbol).catch(() => null),
  ]);

  if (bars.length < 35) {
    throw new Error(
      `Not enough Yahoo history for ${sym} (got ${bars.length} bars; need ~35+)`
    );
  }

  const closes = bars.map((b) => b.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const rsi14 = rsi(closes, 14);
  const { macdLine, signal, hist } = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atr14 = atr(bars, 14);

  const i = closes.length - 1;
  const price = quote?.price ?? closes[i];
  const lastSma20 = lastNonNull(sma20);
  const lastSma50 = lastNonNull(sma50);
  const lastSma200 = lastNonNull(sma200);
  const lastRsi = lastNonNull(rsi14);
  const lastMacd = lastNonNull(macdLine);
  const lastSignal = lastNonNull(signal);
  const lastHist = lastNonNull(hist);
  const lastBbUpper = lastNonNull(bb.upper);
  const lastBbMid = lastNonNull(bb.mid);
  const lastBbLower = lastNonNull(bb.lower);
  const lastAtr = lastNonNull(atr14);

  const trend = trendLabel(price as number, lastSma50, lastSma200);
  const macdBias =
    lastMacd != null && lastSignal != null
      ? lastMacd > lastSignal
        ? "bullish_cross_zone"
        : "bearish_cross_zone"
      : "n/a";

  const signals: string[] = [];
  if (trend === "bullish") signals.push("Price/SMA stack bullish (price > SMA50 > SMA200)");
  if (trend === "bearish") signals.push("Price/SMA stack bearish (price < SMA50 < SMA200)");
  if (lastRsi != null && lastRsi >= 70) signals.push("RSI(14) overbought (≥70)");
  if (lastRsi != null && lastRsi <= 30) signals.push("RSI(14) oversold (≤30)");
  if (lastHist != null && lastHist > 0) signals.push("MACD histogram positive");
  if (lastHist != null && lastHist < 0) signals.push("MACD histogram negative");
  if (lastBbUpper != null && price != null && price >= lastBbUpper)
    signals.push("Price at/above upper Bollinger band");
  if (lastBbLower != null && price != null && price <= lastBbLower)
    signals.push("Price at/below lower Bollinger band");

  return {
    symbol: sym,
    as_of,
    source: "yahoo_finance",
    timeframe: "1d",
    bars_used: bars.length,
    last_bar_date: bars[i]?.date,
    quote: quote
      ? {
          price: quote.price,
          change_pct: quote.change_pct,
          market_state: quote.market_state,
        }
      : null,
    indicators: {
      sma_20: round(lastSma20, 4),
      sma_50: round(lastSma50, 4),
      sma_200: round(lastSma200, 4),
      ema_12: round(lastNonNull(ema12), 4),
      ema_26: round(lastNonNull(ema26), 4),
      rsi_14: round(lastRsi, 2),
      rsi_regime: rsiLabel(lastRsi),
      macd: round(lastMacd, 4),
      macd_signal: round(lastSignal, 4),
      macd_hist: round(lastHist, 4),
      macd_bias: macdBias,
      bollinger_upper: round(lastBbUpper, 4),
      bollinger_mid: round(lastBbMid, 4),
      bollinger_lower: round(lastBbLower, 4),
      atr_14: round(lastAtr, 4),
      atr_pct_of_price:
        lastAtr != null && price
          ? round((lastAtr / (price as number)) * 100, 2)
          : null,
    },
    trend,
    signals,
    disclaimer:
      "Educational technical indicators from Yahoo Finance daily bars via FinGuard MCP. Not investment advice.",
  };
}
