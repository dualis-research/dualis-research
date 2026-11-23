import { cache } from "react";
import { and, asc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { driverEvents, kpiDrivers, priceMoves, type GoldKpiDriver } from "@/db/schema/analysis";
import { priceBars } from "@/db/schema/gold";
import { localIndex } from "@/collectors/benchmark";
import { KPI_YEARS, periodWords } from "@/collectors/dimensions/kpi-drivers";
import { moveWindows } from "@/collectors/dimensions/market-reaction/moves";
import { withBold } from "./emphasis";

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

/** Steps 1 to 3 for the Analysis page: every event, every significant move of 3 years, the candidate KPIs. */
export const driverFindings = cache(async (symbol: string) => {
  const db = getDb();
  const since = sinceDay();
  const [events, moves, kpis, chart] = await Promise.all([
    db.select().from(driverEvents).where(eq(driverEvents.symbol, symbol)).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select().from(priceMoves).where(and(eq(priceMoves.symbol, symbol), gte(priceMoves.endDay, since))).orderBy(asc(priceMoves.startDay)),
    kpiDriversOf(symbol),
    cleanPrice(symbol),
  ]);
  return { events, moves, kpis, chart };
});

/**
 * What the KPI driver panel draws: the KPI per period (step 4) over the share price (step 2's view), and a numbered
 * line per event that moved something (step 5), in date order: the same numbers as the rows under the chart.
 */
export async function kpiDriverChart(k: Pick<GoldKpiDriver, "symbol" | "periods" | "rows" | "measure">) {
  const c = await cleanPrice(k.symbol);
  const kpi = k.periods.map((p) => ({ date: `${p.period}-28`, period: periodWords(p.periodType, p.period), value: p.value }));
  const moved = k.rows.filter((r) => r.result !== "nothing").sort((a, b) => a.day.localeCompare(b.day) || a.eventId.localeCompare(b.eventId));
  const number = new Map(moved.map((r, i) => [r.eventId, i + 1]));
  const verdict = (r: (typeof moved)[number]) => (r.result === "confirms" ? "confirms" : r.result === "invalidates" ? "invalidates" : "neutral") as "confirms" | "invalidates" | "neutral";
  const markers = moved.map((r, i) => ({ n: i + 1, date: r.day, end: c.windowEnd(r.day), verdict: verdict(r) }));
  return { ...c, kpi, unit: k.measure?.unit ?? ("ratio" as const), currency: k.measure?.currency ?? null, markers, number };
}
