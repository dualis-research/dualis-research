import { and, desc, eq, isNull } from "drizzle-orm";
import { fetches as bronze, type BronzeFetch } from "@/db/schema/bronze";
import { analyses, exhibits, narrativeDrivers, narrativeRationales, narratives, researchReports, type AnalysisAnswer, type GoldKpiDriver, type RationaleAnswer, type ThesisSide } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { analysedSymbols } from "../watchlist";
import { stripDashes } from "../thesis/structure";
import { fnv, gatherFacts } from "./facts";
import { priceDriversText, trustedDrivers } from "./price-drivers";
import { ANALYSIS_SYSTEM, ANALYSIS_VERSION, RATIONALE_SYSTEM, REPORT_SYSTEM, analysisPrompt, missingDrivers, parseAnalysis, parseRationale, rationalePrompt, reportPrompt, type PreviousThesis } from "./prompt";
import { exhibitData, seriesCatalog, type StoredSeries } from "./series";
import { comparablePrice, driverIdOf, thesisId } from "./thesis";

export * from "./thesis";
export * from "./price-drivers";

export const ANALYSIS_DIMENSION = "analysis";
const SOURCE = "claude";
const PARALLEL = 4;
export const DISCLAIMER = "This report is for information only and is not investment advice. Figures come from company filings and data providers as collected; check the sources before acting.";

export type AnalysisPayload = { version: string; side: ThesisSide; inputHash: string; analysis: AnalysisAnswer; rationale: RationaleAnswer | null; report: string; model: string; quote: { close: number; date: string; currency: string | null } | null };

/**
 * Keeps only exhibit series that exist in the stored catalogue with 2+ points (an exhibit left with none is dropped).
 * A driver left with no chart whose Price Driver is a stored series gets that series as its chart: its own figure.
 */
export function bindExhibits(a: AnalysisAnswer, catalog: Map<string, StoredSeries>, drivers: Map<string, Pick<GoldKpiDriver, "name" | "series">> = new Map()): AnalysisAnswer {
  const has = (k: string) => (catalog.get(k)?.points.size ?? 0) >= 2;
  return {
    ...a,
    drivers: a.drivers.map((d) => {
      const bound = d.exhibits.map((e) => ({ ...e, series: e.series.filter(has) })).filter((e) => e.series.length > 0 && e.title);
      const own = d.kpiDriverId ? drivers.get(d.kpiDriverId) : undefined;
      if (bound.length === 0 && own?.series && has(own.series)) bound.push({ title: own.name, chart: "bar", series: [own.series], takeaway: d.summary ?? d.title });
      return { ...d, exhibits: bound };
    }),
  };
}

/** Exhibit numbers across the ticker, in driver order: what `[EXHIBIT n]` in the report points to. */
export const numberedExhibits = (a: AnalysisAnswer) => a.drivers.flatMap((d, di) => d.exhibits.map((e, ei) => ({ driver: di + 1, rank: ei + 1, ...e }))).map((e, i) => ({ ...e, number: i + 1 }));

/** Reason an analysed ticker gets no narrative call when no candidate earned a strong or weak confidence. */
export const NO_TRUSTED_DRIVER = "no trusted price driver yet (kpi-drivers gave none a strong or weak confidence): no narrative is written";

/** The latest narrative written under the one-narrative contract (analysis@v10+: its answer carries the side). */
const isCurrent = (a: Pick<typeof analyses.$inferSelect, "analysis" | "side">): a is typeof a & { side: ThesisSide } => !!a.side && a.analysis.side === a.side;

export const analysisSource: Source = {
  name: SOURCE,
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  concurrency: PARALLEL,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("analysis: needs the database");
    // The price and the fair value are inputs of the narrative and of its side: without both, no call, said by name.
    const market = await comparablePrice(ctx.db, symbol);
    if ("reason" in market) return { request: { symbol }, httpStatus: null, error: `no narrative: ${market.reason}` };
    const facts = await gatherFacts(ctx.db, symbol);
    if (!facts.hasFinancials) return { request: { symbol }, httpStatus: null, error: "no financial statements collected for this ticker (no annual revenue, reported or derivable)" };
    // The Narrative Drivers ARE the trusted Price Drivers: none trusted = nothing to write on, never an invented reason.
    const trusted = await trustedDrivers(ctx.db, symbol);
    if (trusted.length === 0) return { request: { symbol }, httpStatus: null, error: NO_TRUSTED_DRIVER };
    const pds = priceDriversText(trusted);
    const labels = new Map([...pds.labels].map(([l, k]) => [l, k.id]));
    const inputHash = fnv(`${ANALYSIS_VERSION}\n${facts.hash}\n${pds.hash}`);
    const [prior] = await ctx.db
      .select({ id: bronze.id, payload: bronze.payload })
      .from(bronze)
      .where(and(eq(bronze.dimension, ANALYSIS_DIMENSION), eq(bronze.subject, symbol), isNull(bronze.error)))
      .orderBy(desc(bronze.fetchedAt))
      .limit(1);
    if ((prior?.payload as AnalysisPayload | undefined)?.inputHash === inputHash) return { request: { inputHash, reusedFrom: prior.id }, httpStatus: null, payload: prior.payload };
    if (!ctx.complete) throw new Error("analysis: no LLM in the collector context (cli.ts sets ctx.complete)");

    // The narrative's last version: kept word for word unless the facts changed what the market believes.
    const previous = (await ctx.db.select({ analysis: analyses.analysis, side: analyses.side }).from(analyses).where(eq(analyses.symbol, symbol)).orderBy(desc(analyses.createdAt)).limit(5)).find(isCurrent);
    const labelOf = new Map([...labels].map(([l, id]) => [id, l]));
    const prev: PreviousThesis | null = previous
      ? {
          side: previous.analysis.side,
          sideWhy: previous.analysis.sideWhy ?? null,
          narrative: previous.analysis.narrative,
          narrativeDetail: previous.analysis.narrativeDetail ?? null,
          drivers: previous.analysis.drivers.map((d) => ({ priceDriver: (d.kpiDriverId && labelOf.get(d.kpiDriverId)) || null, category: d.category, title: d.title, summary: d.summary ?? null, text: d.text })),
        }
      : null;
    const prompt = analysisPrompt(facts.text, pds.text, [...labels.keys()], prev);
    const first = await ctx.complete({ system: ANALYSIS_SYSTEM, prompt });
    let answer = parseAnalysis(first.text, labels);
    let missing = missingDrivers(answer, labels);
    if (missing.length) {
      // The contract: one Narrative Driver per Price Driver. One more ask, quoting the miss; a second miss fails loud.
      const again = await ctx.complete({ system: ANALYSIS_SYSTEM, prompt: `${prompt}\n\nYour previous answer:\n${first.text}\n\nPrice Drivers ${missing.join(", ")} had no narrative driver. Answer again, same JSON, exactly one driver per Price Driver, each naming its label in "priceDriver".` });
      answer = parseAnalysis(again.text, labels);
      missing = missingDrivers(answer, labels);
      if (missing.length) return { request: { inputHash }, httpStatus: null, payload: { answer: again.text }, error: `Price Drivers ${missing.join(", ")} have no narrative driver` };
    }
    const byId = new Map(trusted.map((k) => [k.id, k]));
    answer = bindExhibits(answer, facts.catalog, byId);
    // The unusual weeks each Price Driver explains (test B, counted by code): what made it a driver.
    answer = { ...answer, drivers: answer.drivers.map((d) => ({ ...d, moveIds: byId.get(d.kpiDriverId ?? "")?.tests?.explainedMoveIds ?? [] })) };
    const numbered = numberedExhibits(answer);
    // Narrative Rationale: why the market holds the story, every claim citing its sources; its charts bound like the drivers'.
    const r = await ctx.complete({ system: RATIONALE_SYSTEM, prompt: rationalePrompt(`${facts.text}\n\n${pds.text}`, answer, numbered) });
    const parsed = parseRationale(r.text, answer.drivers.length);
    const rationale: RationaleAnswer = { ...parsed, exhibits: parsed.exhibits.map((e) => ({ ...e, series: e.series.filter((k) => (facts.catalog.get(k)?.points.size ?? 0) >= 2) })).filter((e) => e.series.length > 0 && e.title) };
    const [profile] = await ctx.db.select({ name: gold.companyProfiles.name }).from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol));
    const report = await ctx.complete({ system: REPORT_SYSTEM, prompt: reportPrompt(`${facts.text}\n\n${pds.text}`, answer, numbered, profile?.name ?? symbol) });
    const payload: AnalysisPayload = { version: ANALYSIS_VERSION, side: answer.side!, inputHash, analysis: answer, rationale, report: stripDashes(report.text.trim()), model: first.model, quote: facts.quote };
    return { request: { inputHash, version: ANALYSIS_VERSION, side: answer.side, priceDrivers: trusted.length }, httpStatus: null, payload };
  },
};

export const analysis: Dimension = {
  name: ANALYSIS_DIMENSION,
  description:
    "Per ticker, ONE narrative written on its trusted Price Drivers (kpi-drivers, strong or weak confidence), reading the reported numbers, the price, the Fair Value and its history: the model decides the side of the story (pessimistic or optimistic), writes one Narrative Driver per Price Driver (never one it invents), the Narrative Rationale and the Research Report. Kept word for word unless the facts change; once per input hash. No trusted Price Driver = no call, a failed fetch saying so.",
  sources: [analysisSource],
  subjects: analysedSymbols,
  promote: promoteAnalysis,
};

export async function promoteAnalysis(db: Db, fetches: BronzeFetch[]): Promise<PromoteResult> {
  let n = 0;
  for (const f of fetches.filter((x) => !x.error && !(x.request as { reusedFrom?: string }).reusedFrom)) {
    const p = f.payload as AnalysisPayload;
    const symbol = f.subject;
    const [exists] = await db.select({ id: analyses.id }).from(analyses).where(and(eq(analyses.symbol, symbol), eq(analyses.side, p.side), eq(analyses.inputHash, p.inputHash)));
    if (exists) continue;
    await db.insert(analyses).values({ symbol, side: p.side, inputHash: p.inputHash, analysis: p.analysis, rationale: p.rationale ?? null, report: p.report, model: p.model, bronzeId: f.id, quote: p.quote?.close ?? null, quoteDate: p.quote?.date ?? null, createdAt: f.fetchedAt });
    n++;
  }
  await rebuildAnalysisGold(db);
  return { silverRowsBySource: { [SOURCE]: n } };
}

/** Version of a thesis = hash of its words: a rewrite with the same words keeps every judgment built on it. */
export const thesisVersion = (a: AnalysisAnswer) => fnv([a.narrative, ...a.drivers.map((d) => `${d.category}|${d.title}|${d.text}`)].join("\n"));

/**
 * Gold from the latest narrative of each analysed ticker (the Fair Value is the `valuation` dimension's). Analyses
 * written before the one-narrative contract (two theses, a coded side, drivers of their own) are history: never shown.
 */
export async function rebuildAnalysisGold(db: Db): Promise<void> {
  const symbols = await analysedSymbols(db);
  const latest = new Map<string, typeof analyses.$inferSelect & { side: ThesisSide }>();
  for (const a of await db.select().from(analyses).orderBy(analyses.createdAt)) if (isCurrent(a)) latest.set(a.symbol, a);
  const nar: (typeof narratives.$inferInsert)[] = [];
  const drv: (typeof narrativeDrivers.$inferInsert)[] = [];
  const exh: (typeof exhibits.$inferInsert)[] = [];
  const rep: (typeof researchReports.$inferInsert)[] = [];
  const rat: (typeof narrativeRationales.$inferInsert)[] = [];
  for (const symbol of symbols) {
    const a = latest.get(symbol);
    if (!a) continue;
    const side = a.side;
    const catalog = await seriesCatalog(db, symbol);
    const [profile] = await db.select({ name: gold.companyProfiles.name }).from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol));
    const id = thesisId(symbol, side);
    const version = thesisVersion(a.analysis);
    nar.push({ id, symbol, side, sideWhy: a.analysis.sideWhy ?? null, text: a.analysis.narrative, detail: a.analysis.narrativeDetail ?? null, version, asOf: a.createdAt });
    const exhibitIds: string[] = [];
    a.analysis.drivers.forEach((d, i) => drv.push({ id: driverIdOf(symbol, side, i + 1), symbol, side, rank: i + 1, category: d.category, title: d.title, summary: d.summary ?? null, text: d.text, kpiDriverId: d.kpiDriverId ?? null, moveIds: d.moveIds ?? [], version }));
    for (const e of numberedExhibits(a.analysis)) {
      const data = exhibitData(catalog, e.series);
      if (!data) continue;
      const driverId = driverIdOf(symbol, side, e.driver);
      const exId = `${driverId}:${e.rank}`;
      exhibitIds.push(exId);
      exh.push({ id: exId, symbol, driverId, rank: e.rank, number: e.number, title: e.title, chart: e.chart, series: data.series, points: data.points, takeaway: e.takeaway, sources: data.sources });
    }
    if (a.rationale) {
      const first = numberedExhibits(a.analysis).length;
      const ids: string[] = [];
      a.rationale.exhibits.forEach((e, i) => {
        const data = exhibitData(catalog, e.series);
        if (!data) return;
        const exId = `${id}:rationale:${i + 1}`;
        ids.push(exId);
        exh.push({ id: exId, symbol, driverId: `${id}:rationale`, rank: i + 1, number: first + i + 1, title: e.title, chart: e.chart, series: data.series, points: data.points, takeaway: e.takeaway, sources: data.sources });
      });
      rat.push({ id, symbol, side, summary: a.rationale.summary, claims: a.rationale.claims, exhibitIds: ids, version, asOf: a.createdAt });
    }
    rep.push({ id, symbol, side, title: `${profile?.name ?? symbol} (${symbol}): Research Report`, markdown: `${a.report}\n\n_${DISCLAIMER}_`, exhibitIds, version, asOf: a.createdAt, model: a.model });
  }
  await db.transaction(async (tx) => {
    for (const table of [narratives, narrativeDrivers, exhibits, researchReports, narrativeRationales]) await tx.delete(table);
    if (nar.length) await tx.insert(narratives).values(nar);
    if (drv.length) await tx.insert(narrativeDrivers).values(drv);
    if (exh.length) await tx.insert(exhibits).values(exh);
    if (rep.length) await tx.insert(researchReports).values(rep);
    if (rat.length) await tx.insert(narrativeRationales).values(rat);
  });
}
