import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { driverEvents, fairValueHistory, priceMoves, type FxConversion, type GoldDriverEvent, type GoldFairValueHistory, type GoldPriceMove } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import { valuationSyntheses } from "@/db/schema/valuation";
import type { Db } from "@/db/types";
import { localIndex } from "../../benchmark";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { majorUnit } from "../financials/derive";
import { fxReader } from "../fx";
import { analysedSymbols } from "../watchlist";
import type { Bar, FvPoint } from "./compute";
import { findMoves, moveWindows } from "./moves";
import { pricedEvents, rawEventsOf } from "./events";

export * from "./compute";
export * from "./moves";
export * from "./events";

/**
 * The common objects of the analysis (docs/architecture.md), pure code over stored data, no fetch, no LLM: the fair
 * value as it stood each day (one point a day, from every valuation synthesis), every significant unbiased 1-week move
 * (the stock's 5 trading days with its own market taken out), and every event of 3 years (release, company news,
 * industry news, filing) with the 1 week after it and the significant move it sits in. Runs after `valuation`, before
 * step A (`kpi-drivers`).
 */

export const MARKET_REACTION_DIMENSION = "market-reaction";

type Payload = { history: Omit<GoldFairValueHistory, "rebuiltAt">[]; moves?: Omit<GoldPriceMove, "rebuiltAt">[]; events?: Omit<GoldDriverEvent, "rebuiltAt">[] };

/** Closes from `days` ago, oldest first, in major units. */
async function closes(db: Db, symbol: string, currency: string | null, days: number): Promise<Bar[]> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const bars = await db.select({ date: gold.priceBars.date, close: gold.priceBars.close }).from(gold.priceBars).where(and(eq(gold.priceBars.symbol, symbol), gte(gold.priceBars.date, from))).orderBy(asc(gold.priceBars.date));
  return bars.map((b) => ({ date: b.date, close: majorUnit(b.close, currency).price }));
}

/** The moves read every stored close (5 years) plus the year their first z-score needs. */
const MOVE_HISTORY_DAYS = 6 * 366;
/** One read of each index per run (keyed on the run's fetch function), not one per ticker. */
const runBench = new WeakMap<typeof fetch, Map<string, Promise<Bar[]>>>();
function indexBars(db: Db, f: typeof fetch, symbol: string): Promise<Bar[]> {
  let m = runBench.get(f);
  if (!m) runBench.set(f, (m = new Map()));
  let p = m.get(symbol);
  if (!p) m.set(symbol, (p = closes(db, symbol, null, MOVE_HISTORY_DAYS)));
  return p;
}

/** The fair value each day: the last synthesis of the day (silver.valuation_syntheses keeps every one). */
export async function fairValuePoints(db: Db, symbol: string): Promise<(FvPoint & { currency: string | null })[]> {
  // Egress: the four figures only, never the stored report text.
  const r = valuationSyntheses.result;
  const rows = await db
    .select({ createdAt: valuationSyntheses.createdAt, base: sql<string | null>`${r}->>'base'`, low: sql<string | null>`${r}->>'low'`, high: sql<string | null>`${r}->>'high'`, currency: sql<string | null>`${r}->>'currency'` })
    .from(valuationSyntheses)
    .where(eq(valuationSyntheses.symbol, symbol))
    .orderBy(asc(valuationSyntheses.createdAt));
  const num = (v: string | null) => (v === null ? null : Number(v));
  const byDay = new Map<string, FvPoint & { currency: string | null }>();
  for (const x of rows) {
    const base = num(x.base);
    if (base === null || !(base > 0)) continue;
    const day = x.createdAt.toISOString().slice(0, 10);
    byDay.set(day, { day, value: base, low: num(x.low), high: num(x.high), currency: x.currency });
  }
  return [...byDay.values()];
}

/**
 * Each day's fair value in the quote currency (a CAD valuation of a USD listing), at that day's stored rate: the
 * judges compare it with the price, so both must be in one unit. A pair with no stored rate keeps its own currency.
 */
export async function inQuoteCurrency(db: Db, points: (FvPoint & { currency: string | null })[], to: string | null): Promise<(FvPoint & { currency: string | null; conversion: FxConversion | null })[]> {
  const fx = fxReader(db);
  return Promise.all(
    points.map(async (p) => {
      if (!to || !p.currency || p.currency === to) return { ...p, conversion: null };
      const r = await fx(p.currency, to, p.day);
      if (!r) return { ...p, conversion: null };
      const k = r.rate;
      return { ...p, value: p.value * k, low: p.low === null ? null : p.low * k, high: p.high === null ? null : p.high * k, currency: to, conversion: { from: p.currency, to, rate: k, date: r.date, source: r.source, value: p.value, low: p.low, high: p.high } };
    }),
  );
}

export const marketReactionSource: Source = {
  name: "rules",
  requiredEnv: [],
  covers: () => true,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("market-reaction: needs the database");
    const db = ctx.db;
    const [q] = await db.select().from(gold.quotes).where(eq(gold.quotes.symbol, symbol));
    const currency = q?.currency ?? null;
    const local = localIndex(symbol);
    const [longBars, localBars, rawPoints, rawEvents] = await Promise.all([closes(db, symbol, currency, MOVE_HISTORY_DAYS), indexBars(db, ctx.fetch, local.symbol), fairValuePoints(db, symbol), rawEventsOf(db, symbol)]);
    const major = currency ? majorUnit(1, currency).currency : null;
    const points = await inQuoteCurrency(db, rawPoints, major);
    const history = points.map((p) => ({ id: `${symbol}|${p.day}`, symbol, day: p.day, value: p.value, low: p.low, high: p.high, currency: p.currency, conversion: p.conversion }));
    // One definition of a significant unbiased move: against the stock's OWN market.
    // A ticker with no closes yet has no move to find; one with closes but no index to measure them against is a gap, said loud.
    if (longBars.length > 1 && localBars.length === 0) throw new Error(`market-reaction: no closes stored for ${local.name} (${local.symbol}), the price dimension fetches it`);
    const windows = moveWindows(longBars, localBars);
    const found = findMoves(symbol, longBars, localBars, local.name, windows);
    const moves = found.map((m) => ({ ...m, currency: major }));
    const events = pricedEvents(symbol, rawEvents, windows, found, local.name);
    const payload: Payload = { history, moves, events };
    return { request: { symbol, bars: longBars.length, moves: moves.length, events: events.length, index: local.symbol }, httpStatus: null, payload };
  },
};

export const marketReactionDim: Dimension = {
  name: MARKET_REACTION_DIMENSION,
  description: "Per analysed ticker: the fair value as it stood each day (base, low, high); every significant price move (a 5-trading-day move, its local market taken out, at least twice its usual one); and every release, news item and filing of 3 years with its own 5-day move and the move it sits in. Code only, from stored data.",
  sources: [marketReactionSource],
  subjects: analysedSymbols,
  promote: async (db, fetches): Promise<PromoteResult> => ({ silverRowsBySource: { rules: await promoteMarketReactions(db, fetches) } }),
};

/** Gold from this run's latest answer per ticker: its rows replace the ticker's old ones. */
export async function promoteMarketReactions(db: Db, fetches: BronzeFetch[]): Promise<number> {
  const latest = new Map<string, Payload>();
  for (const f of fetches.filter((x) => !x.error).sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())) latest.set(f.subject, f.payload as Payload);
  const symbols = [...latest.keys()];
  if (symbols.length === 0) return 0;
  const history = [...latest.values()].flatMap((p) => p.history);
  const moves = [...latest.values()].flatMap((p) => p.moves ?? []);
  const events = [...latest.values()].flatMap((p) => p.events ?? []);
  await db.transaction(async (tx) => {
    await tx.delete(fairValueHistory).where(inArray(fairValueHistory.symbol, symbols));
    if (history.length) await tx.insert(fairValueHistory).values(history);
    await tx.delete(priceMoves).where(inArray(priceMoves.symbol, symbols));
    for (let i = 0; i < moves.length; i += 500) await tx.insert(priceMoves).values(moves.slice(i, i + 500));
    await tx.delete(driverEvents).where(inArray(driverEvents.symbol, symbols));
    for (let i = 0; i < events.length; i += 500) await tx.insert(driverEvents).values(events.slice(i, i + 500));
  });
  return history.length + moves.length + events.length;
}
