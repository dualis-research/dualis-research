import { cache } from "react";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { driverEvents, kpiDrivers, priceMoveCauses, priceMoves } from "@/db/schema/analysis";
import { goldNewsLinks } from "@/db/schema/news";
import { priceBars } from "@/db/schema/gold";
import { localIndex } from "@/collectors/benchmark";
import { KPI_YEARS } from "@/collectors/dimensions/kpi-drivers";
import { moveWindows } from "@/collectors/dimensions/market-reaction/moves";
import { withBold } from "./emphasis";
import { moveArrows } from "./move-arrows";

/** A ticker's KPI drivers (Kevin + Thierry 2026-11-19), rank order. */
export const kpiDriversOf = cache(async (symbol: string) => withBold(await getDb().select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank))));

/** One KPI driver (its item panel). */
export async function kpiDriver(id: string) {
  return withBold((await getDb().select().from(kpiDrivers).where(eq(kpiDrivers.id, id)))[0] ?? null);
}

const sinceDay = () => new Date(Date.now() - KPI_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);

/**
 * The share price of 3 years as traded and with its local market's move taken out (price x (index then / index now)
 * ^ beta, beta = the latest 5-day window's, as step 2 measures it), and the 5th trading day after any day.
 */
export const cleanPrice = cache(async (symbol: string) => {
  const db = getDb();
  const index = localIndex(symbol);
  const [stock, idx] = await Promise.all([
    db.select({ date: priceBars.date, close: priceBars.close }).from(priceBars).where(eq(priceBars.symbol, symbol)).orderBy(asc(priceBars.date)),
    db.select({ date: priceBars.date, close: priceBars.close }).from(priceBars).where(eq(priceBars.symbol, index.symbol)).orderBy(asc(priceBars.date)),
  ]);
  const since = sinceDay();
  const beta = moveWindows(stock.slice(-300), idx).at(-1)?.beta ?? 1;
  const byDate = new Map(idx.map((x) => [x.date, x.close]));
  const shown = stock.filter((x) => x.date >= since && byDate.has(x.date));
  const base = shown[0] ? byDate.get(shown[0].date)! : 1;
  const price = shown.map((x) => ({ date: x.date, raw: x.close, clean: x.close * (base / byDate.get(x.date)!) ** beta }));
  // The 5 trading days measured after a day: from the first close on or after it to the 5th.
  const windowEnd = (d: string) => {
    const i = shown.findIndex((x) => x.date >= d);
    return i === -1 ? d : shown[Math.min(shown.length - 1, i + 4)].date;
  };
  return { price, beta, indexName: index.name, windowEnd };
});

/**
 * The proof structure of a ticker (PROOF-STRUCTURE-1123): every event of 3 years (industry news marked), every unusual
 * week with its ONE verdict and the items it rests on, the candidates with their tests and reversals, the price chart.
 */
export const proofData = cache(async (symbol: string) => {
  const db = getDb();
  const since = sinceDay();
  const [events, moves, causes, kpis, chart, industry] = await Promise.all([
    db.select().from(driverEvents).where(eq(driverEvents.symbol, symbol)).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select().from(priceMoves).where(and(eq(priceMoves.symbol, symbol), gte(priceMoves.endDay, since))).orderBy(asc(priceMoves.startDay)),
    db.select().from(priceMoveCauses).where(eq(priceMoveCauses.symbol, symbol)),
    kpiDriversOf(symbol),
    cleanPrice(symbol),
    db.select({ id: goldNewsLinks.newsItemId }).from(goldNewsLinks).where(and(eq(goldNewsLinks.symbol, symbol), sql`'industry' = any(${goldNewsLinks.matchKinds})`, sql`not ('name' = any(${goldNewsLinks.matchKinds}))`, sql`not ('alias' = any(${goldNewsLinks.matchKinds}))`, sql`not ('symbol' = any(${goldNewsLinks.matchKinds}))`)),
  ]);
  const from = chart.price[0]?.date ?? events[0]?.day ?? since;
  const weeks = moves.filter((m) => m.startDay >= from);
  return { events, arrows: moveArrows(weeks, causes), kpis, chart, industryNews: new Set(industry.map((x) => String(x.id))) };
});
export type ProofData = Awaited<ReturnType<typeof proofData>>;
