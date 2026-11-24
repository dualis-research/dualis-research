import { cache } from "react";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { companyProfiles, quotes, tickers } from "@/db/schema/gold";
import { consensus, consensusCoverage } from "@/db/schema/consensus";
import { goldDailyDigests } from "@/db/schema/daily-email";
import { runSources, runs } from "@/db/schema/ops";
import { goldThierryInputs, type InputKind } from "@/db/schema/thierry-inputs";

/** Console reads: gold for business data, ops for run health. Never bronze or silver. */

export type TickerRow = Awaited<ReturnType<typeof listTickers>>[number];

export async function listTickers() {
  return getDb()
    .select({
      symbol: tickers.symbol,
      market: tickers.market,
      inPortfolio: tickers.inPortfolio,
      position: tickers.position,
      aliases: tickers.aliases,
      thesisNote: tickers.thesisNote,
      name: companyProfiles.name,
      exchange: companyProfiles.exchange,
      currency: companyProfiles.currency,
      sector: companyProfiles.sector,
      industry: companyProfiles.industry,
      marketCap: companyProfiles.marketCap,
      logoUrl: companyProfiles.logoUrl,
      lastClose: quotes.close,
      changePct: quotes.changePct,
      quoteCurrency: quotes.currency,
      quoteDate: quotes.date,
    })
    .from(tickers)
    .leftJoin(companyProfiles, eq(companyProfiles.symbol, tickers.symbol))
    .leftJoin(quotes, eq(quotes.symbol, tickers.symbol))
    .orderBy(desc(tickers.inPortfolio), asc(tickers.symbol));
}

/** One ticker with its profile and last quote: three reads at once, made once per request (layout + page share it). */
export const getTicker = cache(async (symbol: string) => {
  const db = getDb();
  const [[ticker], [profile], [quote]] = await Promise.all([
    db.select().from(tickers).where(eq(tickers.symbol, symbol)),
    db.select().from(companyProfiles).where(eq(companyProfiles.symbol, symbol)),
    db.select().from(quotes).where(eq(quotes.symbol, symbol)),
  ]);
  if (!ticker) return null;
  return { ticker, profile: profile ?? null, quote: quote ?? null };
});

/** Analyst consensus vs actual per (period, metric), newest period first (gold.consensus). */
export async function consensusOf(symbol: string) {
  return getDb()
    .select()
    .from(consensus)
    .where(eq(consensus.symbol, symbol))
    .orderBy(desc(consensus.periodEnd), asc(consensus.periodType), asc(consensus.metric));
}

/** Per (source, ticker), what the latest consensus run got (Data page). */
export async function listConsensusCoverage() {
  return getDb().select().from(consensusCoverage).orderBy(asc(consensusCoverage.symbol), asc(consensusCoverage.source));
}

export async function listRuns(limit = 50) {
  return getDb().select().from(runs).orderBy(desc(runs.startedAt)).limit(limit);
}

/** The latest run of one dimension, however old (the Data page's card for a dimension that is not in the last 50 runs). */
export async function latestRunOf(dimension: string) {
  const [row] = await getDb().select().from(runs).where(eq(runs.dimension, dimension)).orderBy(desc(runs.startedAt)).limit(1);
  return row ?? null;
}

export async function sourcesOfRuns(runIds: string[]) {
  if (runIds.length === 0) return [];
  return getDb().select().from(runSources).where(inArray(runSources.runId, runIds)).orderBy(asc(runSources.source));
}

export async function getRun(id: string) {
  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return null;
  const sources = await db.select().from(runSources).where(eq(runSources.runId, id)).orderBy(asc(runSources.source));
  return { run, sources };
}

/** Latest finished-or-running run per dimension. */
export async function latestRunPerDimension() {
  const recent = await listRuns(100);
  const seen = new Map<string, (typeof recent)[number]>();
  for (const r of recent) if (!seen.has(r.dimension)) seen.set(r.dimension, r);
  return [...seen.values()];
}

export async function lastRun() {
  const [run] = await getDb().select().from(runs).orderBy(desc(runs.startedAt)).limit(1);
  return run ?? null;
}

/** Thierry's inputs pushed by his Claude (gold.thierry_inputs), newest first. */
export async function listInputs({ symbol, kind, limit = 300 }: { symbol?: string; kind?: InputKind; limit?: number } = {}) {
  return getDb()
    .select()
    .from(goldThierryInputs)
    .where(and(symbol ? eq(goldThierryInputs.symbol, symbol) : undefined, kind ? eq(goldThierryInputs.kind, kind) : undefined))
    .orderBy(desc(goldThierryInputs.saidAt), asc(goldThierryInputs.id))
    .limit(limit);
}

export async function getInput(id: string) {
  const [row] = await getDb().select().from(goldThierryInputs).where(eq(goldThierryInputs.id, id));
  return row ?? null;
}

/** How many inputs of each kind (the tabs of the Inputs page). */
export async function inputCounts(): Promise<Record<string, number>> {
  const rows = await getDb().select({ kind: goldThierryInputs.kind, n: count() }).from(goldThierryInputs).groupBy(goldThierryInputs.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

/** The morning email's digest of one Astana day (YYYY-MM-DD), or the latest one built. */
export async function dailyDigest(day?: string) {
  const db = getDb();
  const [row] = day ? await db.select().from(goldDailyDigests).where(eq(goldDailyDigests.day, day)) : await db.select().from(goldDailyDigests).orderBy(desc(goldDailyDigests.day)).limit(1);
  return row ?? null;
}

/** The analysis read contract (Signal, Fair Value, Narrative, Drivers, Exhibits, Evidence, Report): `analysis-queries.ts`. */
export * from "./analysis-queries";
