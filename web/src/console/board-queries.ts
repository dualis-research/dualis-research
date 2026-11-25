import { cache } from "react";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SignalCall, SignalStrength } from "@/content/signal-words";
import { getDb } from "@/db/client";
import { fairValues, signals, type ThesisSide } from "@/db/schema/analysis";
import { consensus } from "@/db/schema/consensus";
import { companyProfiles, priceBars, quotes, tickers } from "@/db/schema/gold";

/**
 * The 3 console levels (Kevin 2026-11-05): A) the Signals board, B) one ticker's analysis (panel or page),
 * C) one item's detail with its sources. Gold only. Signal, strength and fair value are the analysis objects
 * (gold.signals, built by the `signals` dimension); a ticker not analysed yet shows no call and Noise.
 */

export type BoardRow = {
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  position: string;
  inPortfolio: boolean;
  /** In the analysis scope; false = Inactive tab (name and quote only, nothing analysed). */
  analysed: boolean;
  fairValue: number | null;
  fairValueMethod: string | null;
  /** The method in a few words ("5.9x EV/EBITDA, 4-year median"); the full calculation stays in the item panel. */
  fairValueLabel: string | null;
  fairValueCurrency: string | null;
  close: number | null;
  currency: string | null;
  quoteDate: string | null;
  gap: { pct: number; side: "below" | "above" } | null;
  call: SignalCall | null;
  strength: SignalStrength;
  /** The ticker's tag as shown (Kevin 2026-11-06: "Weak BUY", never a bare "Weak"): the signal's reversal, else its narrative's reading. */
  tag: { effect: string; strength: string } | null;
  /** The narrative's side the tag reads on (long = Inflection, short = Crack); null when no narrative is written yet. */
  side: ThesisSide | null;
  since: Date | null;
};

async function readBoard(symbol?: string): Promise<BoardRow[]> {
  const rows = await getDb()
    .select({
      symbol: tickers.symbol,
      position: tickers.position,
      inPortfolio: tickers.inPortfolio,
      analysed: tickers.analysed,
      name: companyProfiles.name,
      logoUrl: companyProfiles.logoUrl,
      profileCurrency: companyProfiles.currency,
      close: quotes.close,
      quoteCurrency: quotes.currency,
      quoteDate: quotes.date,
      signal: signals,
    })
    .from(tickers)
    .leftJoin(companyProfiles, eq(companyProfiles.symbol, tickers.symbol))
    .leftJoin(quotes, eq(quotes.symbol, tickers.symbol))
    .leftJoin(signals, eq(signals.symbol, tickers.symbol))
    .where(symbol ? eq(tickers.symbol, symbol) : undefined)
    .orderBy(asc(tickers.symbol));
  return rows.map((r) => {
    const s = r.signal;
    // The quote the signal was judged on, so the call, the gap and the price shown always agree.
    const close = s?.quote ?? r.close;
    const only = s && s.theses.length === 1 ? s.theses[0] : null;
    return {
      symbol: r.symbol,
      name: r.name,
      logoUrl: r.logoUrl,
      position: r.position,
      inPortfolio: r.inPortfolio,
      analysed: r.analysed,
      fairValue: s?.fairValue ?? null,
      fairValueMethod: s?.fairValueMethod ?? null,
      fairValueLabel: s?.fairValueLabel ?? null,
      fairValueCurrency: s?.currency ?? r.quoteCurrency ?? r.profileCurrency,
      close,
      currency: s?.currency ?? r.quoteCurrency ?? r.profileCurrency,
      quoteDate: s?.quoteDate ?? r.quoteDate,
      gap: s?.gapPct === null || s?.gapPct === undefined ? null : { pct: Math.abs(s.gapPct), side: s.gapPct < 0 ? "below" : "above" },
      call: s && s.signal !== "none" ? s.signal : null,
      strength: s?.strength ?? "noise",
      tag: s && s.signal !== "none" ? { effect: "reversal", strength: s.strength } : only ? { effect: only.effect, strength: only.strength } : null,
      side: s?.side ?? only?.side ?? null,
      since: s?.since ?? null,
    };
  });
}

const ORDER: Record<SignalStrength, number> = { strong: 0, weak: 1, noise: 2 };

/** Level A: every analysed ticker, portfolio names included (Kevin 2026-11-09), strongest first. */
export async function signalBoard(): Promise<BoardRow[]> {
  const rows = (await readBoard()).filter((r) => r.analysed);
  return rows.sort((a, b) => ORDER[a.strength] - ORDER[b.strength] || Number(b.call !== null) - Number(a.call !== null) || a.symbol.localeCompare(b.symbol));
}

/** Inactive tab: watchlist tickers outside the analysis scope, for information only (name, quote; nothing analysed). */
export async function inactiveBoard(): Promise<BoardRow[]> {
  return (await readBoard()).filter((r) => !r.analysed);
}

/** Level A's row for one ticker (header of the panel and of the Analysis page). */
export const boardRowOf = cache(async (symbol: string): Promise<BoardRow | null> => (await readBoard(symbol))[0] ?? null);

/** Level C: one KPI vs consensus over every period. */
export async function kpiDetail(symbol: string, metric: string) {
  return getDb()
    .select()
    .from(consensus)
    .where(and(eq(consensus.symbol, symbol), eq(consensus.metric, metric)))
    .orderBy(asc(consensus.periodType), asc(consensus.periodEnd));
}

/** Level C: the price history behind the quote (one year), oldest first. */
export async function priceDetail(symbol: string) {
  return getDb().select().from(priceBars).where(eq(priceBars.symbol, symbol)).orderBy(asc(priceBars.date));
}

/**
 * The price vs fair value chart above the Narrative: every daily close (gold.price_bars, oldest first) and the current
 * Fair Value (gold.fair_values: Thierry's number when he typed one, Claude's kept beside it). Gold keeps no past fair
 * values, so the line starts at the date the current one was set.
 */
export const priceVsFairValue = cache(async (symbol: string) => {
  const db = getDb();
  // What the chart draws, nothing more (Workers free plan: every row parsed and every point serialised costs CPU,
  // 2026-11-17): daily closes for the last 14 months (6M / 1Y views), one close a week (the week's last) back to
  // 5 years (5Y view), and the sources as one distinct list instead of one array per bar.
  const [bars, sourceRows, [fair]] = await Promise.all([
    db.execute(sql`
      select date, close from (
        select date, close, max(date) over () as last,
               row_number() over (partition by date_trunc('week', date::date) order by date desc) as week_rank
        from ${priceBars} where ${priceBars.symbol} = ${symbol}
      ) b
      where date::date >= last::date - interval '61 months'
        and (week_rank = 1 or date::date >= last::date - interval '14 months')
      order by date`),
    db.execute(sql`select distinct unnest(${priceBars.sources}) as source from ${priceBars} where ${priceBars.symbol} = ${symbol} order by 1`),
    db.select().from(fairValues).where(eq(fairValues.symbol, symbol)),
  ]);
  return {
    bars: (bars as unknown as { date: string; close: number }[]).map((b) => ({ date: b.date, close: b.close })),
    sources: (sourceRows as unknown as { source: string }[]).map((r) => r.source),
    fair:
      fair && fair.value !== null
        ? {
            value: fair.value,
            currency: fair.currency,
            author: fair.author,
            since: fair.asOf ? fair.asOf.toISOString().slice(0, 10) : null,
            claudeValue: null,
            low: fair.low,
            high: fair.high,
          }
        : null,
  };
});
export type PriceVsFairValue = Awaited<ReturnType<typeof priceVsFairValue>>;

/** Level C: how the fair value was set (gold.fair_values): who, the method, every input. */
export async function fairValueDetail(symbol: string) {
  const [row] = await getDb().select().from(fairValues).where(eq(fairValues.symbol, symbol));
  return row ?? null;
}

/** Every watchlist ticker's tag as the board shows it (Tickers list). */
export async function tickerTags(): Promise<Map<string, BoardRow>> {
  return new Map((await readBoard()).map((r) => [r.symbol, r]));
}
