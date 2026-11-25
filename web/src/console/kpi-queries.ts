import { cache } from "react";
import { and, asc, eq, gte, like, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { driverEvents, kpiDrivers, narratives, priceMoves, signals } from "@/db/schema/analysis";
import { goldNewsLinks } from "@/db/schema/news";
import { priceBars } from "@/db/schema/gold";
import { judgments } from "@/db/schema/silver";
import { REVERSAL_SUBJECT_KIND } from "@/collectors/dimensions/kpi-reversal";
import { localIndex } from "@/collectors/benchmark";
import { KPI_YEARS } from "@/collectors/dimensions/kpi-drivers";
import { moveWindows } from "@/collectors/dimensions/market-reaction/moves";
import { withBold } from "./emphasis";
import { moveArrows } from "./move-arrows";
import { readingSince, readingVerdict, type Reading } from "./reversal-since";

/** A ticker's Price Driver Candidates and Price Drivers, rank order. */
export const kpiDriversOf = cache(async (symbol: string) => withBold(await getDb().select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank))));

/** One KPI driver (its item panel). */
export async function kpiDriver(id: string) {
  return withBold((await getDb().select().from(kpiDrivers).where(eq(kpiDrivers.id, id)))[0] ?? null);
}

const sinceDay = () => new Date(Date.now() - KPI_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);

/**
 * The share price of 3 years as traded and with its local market's move taken out (price x (index then / index now)
 * ^ beta, beta = the latest 5-day window's, as market-reaction measures it), and the 5th trading day after any day.
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
 * Steps A to E of a ticker as stored (docs/architecture.md): the events of 3 years (industry news marked) and the
 * significant unbiased moves each with its events (A), the candidates with their tests and confidence (B), the
 * narrative with its side, confidence and one belief per Price Driver that explains it (C), each Price Driver's reading
 * against it (D, on the rows), and the signal (E); plus the price chart.
 */
export const proofData = cache(async (symbol: string) => {
  const db = getDb();
  const since = sinceDay();
  const [events, moves, kpis, chart, industry, [story], [signal], readings] = await Promise.all([
    db.select().from(driverEvents).where(eq(driverEvents.symbol, symbol)).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select().from(priceMoves).where(and(eq(priceMoves.symbol, symbol), gte(priceMoves.endDay, since))).orderBy(asc(priceMoves.startDay)),
    kpiDriversOf(symbol),
    cleanPrice(symbol),
    db.select({ id: goldNewsLinks.newsItemId }).from(goldNewsLinks).where(and(eq(goldNewsLinks.symbol, symbol), sql`'industry' = any(${goldNewsLinks.matchKinds})`, sql`not ('name' = any(${goldNewsLinks.matchKinds}))`, sql`not ('alias' = any(${goldNewsLinks.matchKinds}))`, sql`not ('symbol' = any(${goldNewsLinks.matchKinds}))`)),
    db.select().from(narratives).where(eq(narratives.symbol, symbol)),
    db.select({ signal: signals.signal, strength: signals.strength, why: signals.why, evidenceIds: signals.evidenceIds, since: signals.since }).from(signals).where(eq(signals.symbol, symbol)),
    // Every step D reading of this ticker's Price Drivers (subject `<symbol>:<driver name>`), for « since ».
    db.select({ subjectId: judgments.subjectId, verdict: judgments.verdict, at: judgments.createdAt }).from(judgments).where(and(eq(judgments.subjectKind, REVERSAL_SUBJECT_KIND), like(judgments.subjectId, `${symbol}:%`), like(judgments.questionKey, "kpi-reversal@%"))),
  ]);
  // Each Price Driver the narrative rests on, under its own name, with the narrative's one belief about it.
  const pds = kpis.filter((k) => k.level === "strong" || k.level === "weak").sort((a, b) => (a.level === b.level ? a.rank - b.rank : a.level === "strong" ? -1 : 1));
  const narrative = story
    ? await withBold({ side: story.side, confidence: story.confidence, text: story.text, detail: story.detail, sideWhy: story.sideWhy, beliefs: pds.filter((k) => k.marketBelief).map((k) => ({ id: k.id, name: k.name, belief: k.marketBelief })) })
    : null;
  const bySubject = new Map<string, Reading[]>();
  for (const r of readings) bySubject.set(r.subjectId, [...(bySubject.get(r.subjectId) ?? []), { verdict: r.verdict, at: r.at }]);
  // Since when step D reads each Price Driver as it does now (its unbroken run of identical readings).
  const reversalSince = new Map(kpis.map((k) => [k.id, readingSince(bySubject.get(`${symbol}:${k.name}`) ?? [], readingVerdict(k.reversal))]));
  const from = chart.price[0]?.date ?? events[0]?.day ?? since;
  const weeks = moves.filter((m) => m.startDay >= from);
  return { events, arrows: moveArrows(weeks, events), kpis, narrative, signal: signal ? await withBold(signal) : null, reversalSince, chart, industryNews: new Set(industry.map((x) => String(x.id))) };
});
export type ProofData = Awaited<ReturnType<typeof proofData>>;
