import { cache } from "react";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { kpiDrivers, type KpiTestRow } from "@/db/schema/analysis";
import { priceBars } from "@/db/schema/gold";
import { localIndex } from "@/collectors/benchmark";
import { finestSeries, seriesCatalog } from "@/collectors/dimensions/analysis/series";
import { betaBefore, KPI_YEARS } from "@/collectors/dimensions/kpi-drivers";
import { withBold } from "./emphasis";

/** A ticker's KPI drivers (Kevin + Thierry 2026-11-19), rank order. */
export const kpiDriversOf = cache(async (symbol: string) => withBold(await getDb().select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank))));

/** One KPI driver (its item panel). */
export async function kpiDriver(id: string) {
  return withBold((await getDb().select().from(kpiDrivers).where(eq(kpiDrivers.id, id)))[0] ?? null);
}

/**
 * What the KPI driver panel draws (Kevin 2026-11-23): the KPI's stored series (or its approximation « a / b » from two
 * stored series), 3 years of the share price as traded and with its local market's move taken out (price x
 * (index then / index now) ^ beta, beta measured over the last year), and every tested moment that confirmed or
 * invalidated, numbered in date order (the same numbers as the lists under the chart).
 */
export async function kpiDriverChart(k: { symbol: string; series: string | null; approximation: string | null; rows: KpiTestRow[] }) {
  const db = getDb();
  const index = localIndex(k.symbol);
  const [catalog, stock, idx] = await Promise.all([
    seriesCatalog(db, k.symbol),
    db.select({ date: priceBars.date, close: priceBars.close }).from(priceBars).where(eq(priceBars.symbol, k.symbol)).orderBy(asc(priceBars.date)),
    db.select({ date: priceBars.date, close: priceBars.close }).from(priceBars).where(eq(priceBars.symbol, index.symbol)).orderBy(asc(priceBars.date)),
  ]);
  const since = new Date(Date.now() - KPI_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const ratio = k.approximation?.match(/^\s*([\w:.-]+)\s*\/\s*([\w:.-]+)\s*$/);
  const finest = (key: string) => finestSeries(catalog, key, since);
  const top = k.series ? finest(k.series) : ratio ? finest(ratio[1]) : undefined;
  const bottom = ratio ? finest(ratio[2]) : undefined;
  const kpi = top
    ? [...top.points]
        .map(([date, v]) => ({ date, value: bottom ? (bottom.points.get(date) ? v / bottom.points.get(date)! : NaN) : v }))
        .filter((x) => x.date >= since && Number.isFinite(x.value))
        .sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const unit = bottom ? ("multiple" as const) : (top?.unit ?? ("ratio" as const));
  const beta = betaBefore(stock, idx, stock.at(-1)?.date ?? since);
  const byDate = new Map(idx.map((x) => [x.date, x.close]));
  const shown = stock.filter((x) => x.date >= since && byDate.has(x.date));
  const base = shown[0] ? byDate.get(shown[0].date)! : 1;
  const price = shown.map((x) => ({ date: x.date, raw: x.close, clean: x.close * (base / byDate.get(x.date)!) ** beta }));
  const tested = [...k.rows].filter((r) => r.verdict !== "neutral").sort((a, b) => a.day.localeCompare(b.day));
  const number = new Map(tested.map((r, i) => [`${r.step ?? "B1"}:${r.releaseId}`, i + 1]));
  const markers = tested.map((r, i) => ({ n: i + 1, date: r.day, verdict: r.verdict as "confirms" | "invalidates" }));
  return { kpi, unit, currency: top?.currency ?? null, price, beta, indexName: index.name, markers, number };
}
