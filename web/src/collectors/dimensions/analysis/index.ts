import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { fetches as bronze, type BronzeFetch } from "@/db/schema/bronze";
import { analyses, kpiDrivers, narratives, type AnalysisAnswer, type Strength, type ThesisSide } from "@/db/schema/analysis";
import type { Db } from "@/db/types";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { analysedSymbols } from "../watchlist";
import { fnv, gatherFacts } from "./facts";
import { priceDriversText, trustedDrivers } from "./price-drivers";
import { ANALYSIS_SYSTEM, ANALYSIS_VERSION, analysisPrompt, beliefsOf, parseAnalysis, type PreviousThesis } from "./prompt";
import { comparablePrice, thesisId } from "./thesis";

export * from "./thesis";
export * from "./price-drivers";

export const ANALYSIS_DIMENSION = "analysis";
const SOURCE = "claude";
const PARALLEL = 4;

export type AnalysisPayload = { version: string; side: ThesisSide; confidence?: Strength; inputHash: string; analysis: AnalysisAnswer; model: string; quote: { close: number; date: string; currency: string | null } | null };

/** Reason an analysed ticker gets no narrative call when no candidate earned a strong or weak confidence. */
export const NO_TRUSTED_DRIVER = "no trusted price driver yet (kpi-drivers gave none a strong or weak confidence): no narrative is written";

/** A narrative written under the one-narrative contract (its answer carries the side); one written before step C had a confidence shows it as not read yet. */
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
    // The narrative rests on the Price Drivers only (step B): none = nothing to write on, never an invented reason.
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
      ? { side: previous.analysis.side, sideWhy: previous.analysis.sideWhy ?? null, confidence: previous.analysis.confidence ?? null, narrative: previous.analysis.narrative, narrativeDetail: previous.analysis.narrativeDetail ?? null, beliefs: beliefsOf(previous.analysis).map((b) => ({ priceDriver: labelOf.get(b.kpiDriverId) ?? null, belief: b.belief })) }
      : null;
    const prompt = analysisPrompt(facts.text, pds.text, [...labels.keys()], prev);
    const first = await ctx.complete({ system: ANALYSIS_SYSTEM, prompt });
    let answer: AnalysisAnswer;
    try {
      answer = parseAnalysis(first.text, labels);
    } catch (err) {
      // One repair ask on an unreadable answer; a second failure is loud (the fetch fails with the reason).
      const again = await ctx.complete({ system: ANALYSIS_SYSTEM, prompt: `${prompt}\n\nYour previous answer:\n${first.text}\n\nIt could not be read (${(err as Error).message.slice(0, 200)}). Answer again, same JSON, every field of the format.` });
      answer = parseAnalysis(again.text, labels);
    }
    const payload: AnalysisPayload = { version: ANALYSIS_VERSION, side: answer.side!, confidence: answer.confidence, inputHash, analysis: answer, model: first.model, quote: facts.quote };
    return { request: { inputHash, version: ANALYSIS_VERSION, side: answer.side, confidence: answer.confidence, priceDrivers: trusted.length }, httpStatus: null, payload };
  },
};

export const analysis: Dimension = {
  name: ANALYSIS_DIMENSION,
  description:
    "Step C (docs/architecture.md). Per ticker, given the current price, the fair value and its range, Thierry's notes and the Price Drivers: does the market hold a narrative that explains why the stock sits below its fair value (pessimistic) or above it (optimistic), with what confidence (strong, weak, noise), and which Price Drivers explain it, one sentence each (stored on the Price Driver). The model decides side and confidence, no coded rule. Kept word for word unless the facts change; once per input hash. No Price Driver = no call, a failed fetch saying so.",
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
    // `report` stays a NOT NULL column of the history: written empty.
    await db.insert(analyses).values({ symbol, side: p.side, inputHash: p.inputHash, analysis: p.analysis, rationale: null, report: "", model: p.model, bronzeId: f.id, quote: p.quote?.close ?? null, quoteDate: p.quote?.date ?? null, createdAt: f.fetchedAt });
    n++;
  }
  await rebuildAnalysisGold(db);
  return { silverRowsBySource: { [SOURCE]: n } };
}

/** Version of a narrative = hash of its words: a rewrite with the same words keeps every judgment built on it. */
export const thesisVersion = (a: AnalysisAnswer) => fnv([a.narrative, a.confidence ?? "", ...beliefsOf(a).map((b) => `${b.kpiDriverId}|${b.belief}`)].join("\n"));

/**
 * Gold from the latest narrative of each analysed ticker: `gold.narratives` (side, why, confidence, sentence, detail)
 * and, for each Price Driver that explains it, its belief on `gold.kpi_drivers.market_belief`. A noise narrative has
 * no step D: its Price Drivers lose the reversal read against an older story.
 */
export async function rebuildAnalysisGold(db: Db): Promise<void> {
  const symbols = await analysedSymbols(db);
  const latest = new Map<string, typeof analyses.$inferSelect & { side: ThesisSide }>();
  for (const a of await db.select().from(analyses).orderBy(analyses.createdAt)) if (isCurrent(a)) latest.set(a.symbol, a);
  const nar: (typeof narratives.$inferInsert)[] = [];
  const beliefs: { symbol: string; id: string; belief: string }[] = [];
  for (const symbol of symbols) {
    const a = latest.get(symbol);
    if (!a) continue;
    nar.push({ id: thesisId(symbol, a.side), symbol, side: a.side, sideWhy: a.analysis.sideWhy ?? null, confidence: a.analysis.confidence ?? null, text: a.analysis.narrative, detail: a.analysis.narrativeDetail ?? null, version: thesisVersion(a.analysis), asOf: a.createdAt });
    for (const b of beliefsOf(a.analysis)) beliefs.push({ symbol, id: b.kpiDriverId, belief: b.belief });
  }
  // Only a narrative step C read as noise: one written before step C had a confidence keeps its readings until it is read again.
  const noStepD = nar.filter((n) => n.confidence === "noise").map((n) => n.symbol);
  await db.transaction(async (tx) => {
    await tx.delete(narratives);
    if (nar.length) await tx.insert(narratives).values(nar);
    if (nar.length) await tx.update(kpiDrivers).set({ marketBelief: null }).where(inArray(kpiDrivers.symbol, nar.map((x) => x.symbol)));
    for (const b of beliefs) await tx.update(kpiDrivers).set({ marketBelief: b.belief }).where(and(eq(kpiDrivers.id, b.id), eq(kpiDrivers.symbol, b.symbol)));
    if (noStepD.length) await tx.update(kpiDrivers).set({ reversal: null, signal: null, signalWhy: null }).where(inArray(kpiDrivers.symbol, noStepD));
  });
}
