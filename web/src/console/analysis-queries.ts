import { cache } from "react";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  fairValues,
  narratives,
  signalChanges,
  signals,
  type GoldFairValue,
  type GoldNarrative,
  type GoldSignal,
  type GoldSignalChange,
  type ThesisSide,
  driverEvents,
  priceMoves,
} from "@/db/schema/analysis";
import { goldMethodValuations, valuationMethods, valuationReports } from "@/db/schema/valuation";
import { financialMetrics, goldFinancialLines, valuations, type GoldFinancialLine, type GoldFinancialMetric, type GoldValuation } from "@/db/schema/financials";
import { companyProfiles, tickers } from "@/db/schema/gold";
import { withBold } from "./emphasis";

/**
 * The analysis read contract (gold only), for the console UI. Names = Kevin's business objects: Signal, Signal Change,
 * Fair Value, Quote, Narrative, Update Note; steps A to E of the analysis (docs/architecture.md) are read by
 * `kpi-queries.ts`.
 */

/** Signals list: one row per active ticker with its signal, strength, fair value + method, quote and gap. */
export async function listAnalysisSignals() {
  return getDb()
    .select({
      symbol: signals.symbol,
      name: companyProfiles.name,
      market: tickers.market,
      position: tickers.position,
      inPortfolio: tickers.inPortfolio,
      signal: signals.signal,
      strength: signals.strength,
      fairValue: signals.fairValue,
      fairValueMethod: signals.fairValueMethod,
      fairValueLabel: signals.fairValueLabel,
      currency: signals.currency,
      quote: signals.quote,
      quoteDate: signals.quoteDate,
      gapPct: signals.gapPct,
      since: signals.since,
      evidenceIds: signals.evidenceIds,
    })
    .from(signals)
    .innerJoin(tickers, eq(tickers.symbol, signals.symbol))
    .leftJoin(companyProfiles, eq(companyProfiles.symbol, signals.symbol))
    .orderBy(asc(signals.symbol));
}
export type AnalysisSignalRow = Awaited<ReturnType<typeof listAnalysisSignals>>[number];

/** Signal Changes, newest first, each with its Update Note. */
export async function listSignalChanges(limit = 100): Promise<GoldSignalChange[]> {
  return getDb().select().from(signalChanges).orderBy(desc(signalChanges.at)).limit(limit);
}

export type TickerAnalysis = {
  symbol: string;
  /** The side of the ticker's one narrative (long = pessimistic, short = optimistic), decided by the analysis. */
  side: ThesisSide | null;
  signal: GoldSignal | null;
  fairValue: GoldFairValue | null;
  /** text = ONE sentence; detail = the longer why; sideWhy = why the story reads pessimistic or optimistic; confidence = step C's (null = not read yet). */
  narrative: { text: string; detail: string | null; sideWhy: string | null; confidence: GoldNarrative["confidence"]; asOf: Date } | null;
  signalChanges: GoldSignalChange[];
};

/** The ticker's signal, fair value, narrative and Signal Changes: reads in parallel, once per request. */
export const getTickerAnalysis = cache(async (symbol: string): Promise<TickerAnalysis> => {
  const db = getDb();
  const [[signal], [fairValue], [narrative], changes] = await Promise.all([
    db.select().from(signals).where(eq(signals.symbol, symbol)),
    db.select().from(fairValues).where(eq(fairValues.symbol, symbol)),
    db.select().from(narratives).where(eq(narratives.symbol, symbol)),
    db.select().from(signalChanges).where(eq(signalChanges.symbol, symbol)).orderBy(desc(signalChanges.at)),
  ]);
  return withBold({
    symbol,
    side: narrative?.side ?? null,
    signal: signal ?? null,
    fairValue: fairValue ?? null,
    narrative: narrative ? { text: narrative.text, detail: narrative.detail, sideWhy: narrative.sideWhy, confidence: narrative.confidence, asOf: narrative.asOf } : null,
    signalChanges: changes,
  });
});

/** Financial statements of a ticker (level C figure panel): every line with sources, derived metrics, valuation. */
export async function getFinancials(symbol: string): Promise<{ lines: GoldFinancialLine[]; metrics: GoldFinancialMetric[]; valuation: GoldValuation | null }> {
  const db = getDb();
  const [lines, metrics, [valuation]] = await Promise.all([
    db.select().from(goldFinancialLines).where(and(eq(goldFinancialLines.symbol, symbol))).orderBy(asc(goldFinancialLines.periodEnd)),
    db.select().from(financialMetrics).where(eq(financialMetrics.symbol, symbol)).orderBy(asc(financialMetrics.periodEnd)),
    db.select().from(valuations).where(eq(valuations.symbol, symbol)),
  ]);
  return { lines, metrics, valuation: valuation ?? null };
}

/** The fair value pyramid of one ticker: the Valuation Report, every Method Valuation (catalogue order), the Fair Value. */
export const getValuation = cache(async (symbol: string) => {
  const db = getDb();
  const [[report], methods, catalogue, [fairValue]] = await Promise.all([
    db.select().from(valuationReports).where(eq(valuationReports.symbol, symbol)),
    db.select().from(goldMethodValuations).where(eq(goldMethodValuations.symbol, symbol)),
    db.select().from(valuationMethods).orderBy(asc(valuationMethods.rank)),
    db.select().from(fairValues).where(eq(fairValues.symbol, symbol)),
  ]);
  const byId = new Map(methods.map((m) => [m.method, m]));
  return withBold({
    report: report ?? null,
    fairValue: fairValue ?? null,
    methods: catalogue.flatMap((c) => {
      const m = byId.get(c.id);
      return m ? [{ ...m, name: c.name, family: c.family, description: c.description, weight: report?.weights.find((w) => w.method === c.id) ?? null }] : [];
    }),
  });
});
export type Valuation = Awaited<ReturnType<typeof getValuation>>;

/** A significant unbiased 1-week move as the price chart marks it (Analysis page): when and how much. */
export type MoveMarker = { id: string; startDay: string; endDay: string; returnPct: number; benchReturn: number | null };

/** The significant price moves of a ticker for the chart markers: a few columns only. */
export async function priceMoveMarkers(symbol: string): Promise<MoveMarker[]> {
  return getDb()
    .select({ id: priceMoves.id, startDay: priceMoves.startDay, endDay: priceMoves.endDay, returnPct: priceMoves.returnPct, benchReturn: priceMoves.benchReturn })
    .from(priceMoves)
    .where(eq(priceMoves.symbol, symbol))
    .orderBy(asc(priceMoves.startDay));
}

/** One significant move and the events whose week it was (the `move:` item panel). */
export async function getPriceMove(id: string) {
  const db = getDb();
  const [[move], events] = await Promise.all([db.select().from(priceMoves).where(eq(priceMoves.id, id)), db.select().from(driverEvents).where(eq(driverEvents.moveId, id)).orderBy(asc(driverEvents.day), asc(driverEvents.id))]);
  return move ? { move, events } : null;
}
