import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyses, driverEvents, fairValueHistory, fairValues, kpiDrivers, narratives, priceMoves, signalChanges, signals, signalStates, type Strength } from "@/db/schema/analysis";
import * as silver from "@/db/schema/silver";
import { fetches as bronze } from "@/db/schema/bronze";
import { valuationSyntheses } from "@/db/schema/valuation";
import { goldFinancialLines, financialMetrics } from "@/db/schema/financials";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { priceDriver, reversal, seedNote, seedPriceDrivers } from "@/test/price-drivers";
import { analysis, NO_TRUSTED_DRIVER } from "./dimensions/analysis";
import { movesText } from "./dimensions/analysis/facts";
import { marketReactionDim } from "./dimensions/market-reaction";
import { analysisPrompt, holdsNarrative, parseAnalysis } from "./dimensions/analysis/prompt";
import { kpiReversalDim } from "./dimensions/kpi-reversal";
import { dimensionsFor, stagesFor, STAGES, DIMENSIONS, ON_DEMAND_DIMENSIONS } from "./registry";
import { driversAgainst, eventsBehind, parseTurning, readingOf, signalFrom, signalsDim, SIGNAL_SYSTEM, type Turning } from "./dimensions/signals";
import { watchlist } from "./dimensions/watchlist";
import { runDimension } from "./runner";
import type { SourceContext } from "./types";

const REPO_ROOT = resolve(__dirname, "../../..");
const SYMBOL = "101160.KQ";
const PD_CYCLE = `${SYMBOL}:kpi:revenue`;
const PD_CASH = `${SYMBOL}:kpi:net-cash`;

/** Step C as the model answers it: side, confidence, and one belief per Price Driver that explains the narrative (P1 = Revenue, P2 = Net cash). */
const answerOf = (side: "long" | "short", labels = ["P1", "P2"], confidence: Strength = "strong") => ({
  side,
  confidence,
  sideWhy: side === "long" ? "The price sits a quarter under the fair value while sales dip." : "The price prices a recovery the figures do not show.",
  narrative: "The market prices Worldex as a cyclical parts maker.",
  narrativeDetail: "Its margins held while sales dipped.",
  beliefs: [
    { priceDriver: "P1", belief: "The market believes chip makers will keep cutting parts orders." },
    { priceDriver: "P2", belief: "The market sees the net cash as idle." },
    // A reason the model invents (no Price Driver of the list): dropped, never a belief.
    { priceDriver: "P9", belief: "Rates stay high." },
  ].filter((b) => b.priceDriver === "P9" || labels.includes(b.priceDriver)),
});

let calls: string[] = [];
let analysisPrompts: string[] = [];
let reversalPrompts: string[] = [];
let signalPrompts: string[] = [];
/** Step E's answer: is the narrative turning? */
let turning: { turning: Strength; lead: string | null; why: string } = { turning: "strong", lead: "P2", why: "Net cash turns: the buyback puts 10% of the idle cash to work." };
let answer: ReturnType<typeof answerOf> = answerOf("long");
/** What the reversal judge says of the cash driver (the cycle driver never turns here). */
let cash: { stance: "against" | "with" | "none"; strength: "strong" | "weak" | "none" } = { stance: "against", strength: "strong" };
const fake: Complete = async ({ prompt, system }) => {
  if (system.includes("one-line signal notes")) {
    calls.push("note");
    expect(prompt).toContain("ONE short sentence");
    expect(prompt).not.toMatch(/Fair value \d/);
    return { text: prompt.includes("to Strong BUY") ? "BUY: a buyback trust turns the cash story." : "Signal moved.", model: "fake" };
  }
  if (system === SIGNAL_SYSTEM) {
    calls.push("signal");
    signalPrompts.push(prompt);
    return { text: JSON.stringify(turning), model: "fake" };
  }
  if (system.includes("TURNS AGAINST that story")) {
    calls.push("reversal");
    reversalPrompts.push(prompt);
    const mine = prompt.includes("Price Driver (kpi, strong confidence): Net cash") ? cash : { stance: "none" as const, strength: "none" as const };
    // The buyback (event L1 of the prompt) is the leading indicator of the cash driver.
    return { text: JSON.stringify({ intrinsic: { state: mine.stance === "against" ? "reversing-down" : "flat", period: null, why: "Cash went to a buyback." }, leading: { probability: mine.stance === "against" ? "high" : "none", events: mine.stance === "against" ? ["L1", "L9"] : [], why: "A buyback trust was filed." }, durability: "structural", magnitude: null, pricedIn: "none", stance: mine.stance, strength: mine.strength, direction: mine.stance === "none" ? null : "down", headline: "Buyback returns 10% of cash", why: "The buyback puts the idle cash to work.", citations: [] }), model: "fake" };
  }
  analysisPrompts.push(prompt);
  calls.push("analysis");
  return { text: JSON.stringify(answer), model: "fake" };
};

const ctx = (): SourceContext => ({ env: { REPO_ROOT, CLAUDE_OAUTH_TOKEN: "t" }, fetch: (async () => new Response("", { status: 404 })) as typeof fetch, complete: fake });

let db: Db;
let close: () => Promise<void>;
const line = (periodEnd: string, l: string, value: number, statement: "income" | "balance" = "income") => ({ symbol: SYMBOL, periodType: "year" as const, periodEnd, line: l, statement, value, currency: "KRW", label: l, consolidated: true, sources: ["dart", "yahoo"], alternatives: [] });

beforeEach(async () => {
  calls = [];
  analysisPrompts = [];
  reversalPrompts = [];
  signalPrompts = [];
  turning = { turning: "strong", lead: "P2", why: "Net cash turns: the buyback puts 10% of the idle cash to work." };
  answer = answerOf("long");
  cash = { stance: "against", strength: "strong" };
  ({ db, close } = await testDb());
  await runDimension(db, watchlist, { trigger: "test", ctx: ctx() });
  await db.insert(goldFinancialLines).values([line("2024-12", "revenue", 306.8e9), line("2025-12", "revenue", 291.8e9), line("2025-12", "cash", 143e9, "balance")]);
  await db.insert(financialMetrics).values(["2024-12", "2025-12"].map((p, i) => ({ symbol: SYMBOL, periodType: "year" as const, periodEnd: p, metric: "operating-margin", value: 0.2 - i * 0.01, unit: "ratio" as const, currency: null, formula: "x", inputs: [], sources: ["dart"] })));
  await db.insert(gold.quotes).values({ symbol: SYMBOL, date: "2026-11-04", close: 30000, currency: "KRW", sources: ["naver"] });
  // The Fair Value is the valuation pyramid's (valuation.test.ts); the analysis reads it.
  await db.insert(fairValues).values({ symbol: SYMBOL, value: 40000, currency: "KRW", low: 35000, high: 46000, method: "EV/EBITDA 60%, Listed peers 40%", label: "Mostly EV/EBITDA", author: "claude", claudeValue: 40000, inputs: [] });
  await db.insert(fairValueHistory).values({ id: `${SYMBOL}|2026-10-01`, symbol: SYMBOL, day: "2026-10-01", value: 38000, low: 33000, high: 44000, currency: "KRW" });
});
afterEach(async () => close());

/** The trusted Price Drivers `kpi-drivers` found: Revenue (strong, a stored series) and Net cash (strong); Headcount is not trusted. */
async function trustPriceDrivers() {
  await seedPriceDrivers(db, [
    priceDriver(SYMBOL, 1, "Revenue", { series: "line:revenue", measure: { source: "series", label: "Revenue, years", periodType: "year", unit: "currency", currency: "KRW", providers: ["dart"] }, periods: [{ period: "2025-12", periodType: "year", value: 291.8e9, prior: 306.8e9, change: -0.049, changeKind: "relative", significant: true, why: "sales fell 5%", releaseId: null, releaseDay: "2026-02-10", cite: null }], tests: { changes: 2, followed: 2, against: 0, moves: 3, explained: 2, explainedMoveIds: [`${SYMBOL}:2026-02-10`] } }),
    priceDriver(SYMBOL, 2, "Net cash"),
    priceDriver(SYMBOL, 3, "Headcount", { level: "none" }),
  ]);
}

/** A filing the reversal reads: a recent event of the ticker (gold.driver_events). */
async function seedBuyback(daysAgo = 2) {
  const day = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const id = `${SYMBOL}|filing:6f1d1a52-1111-4a3b-9c1d-000000000001`;
  await db.insert(driverEvents).values({ id, symbol: SYMBOL, kind: "filing", sourceId: "6f1d1a52-1111-4a3b-9c1d-000000000001", day, title: "Share buyback trust", url: "https://dart/x", stock: null, benchReturn: null, beta: null, reaction: null, z: null, bench: "KOSDAQ", moveId: null });
  return id;
}

describe("step C, the narrative: side, confidence and the Price Drivers that explain it (docs/architecture.md)", () => {
  it("no trusted Price Driver: no call, a failed fetch saying why, never a silent skip", async () => {
    await seedPriceDrivers(db, [priceDriver(SYMBOL, 1, "Headcount", { level: "none" })]);
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    const [row] = await db.select().from(bronze).where(and(eq(bronze.dimension, "analysis"), eq(bronze.subject, SYMBOL)));
    expect(row.error).toBe(NO_TRUSTED_DRIVER);
    expect(row.error).toContain("no trusted price driver yet");
    expect(calls).toEqual([]);
    expect(await db.select().from(narratives)).toEqual([]);
  });

  it("ONE call reads the price, the fair value and its range, Thierry's notes and the Price Drivers; it stores the side, the confidence and one belief ON each Price Driver that explains it", async () => {
    await trustPriceDrivers();
    await seedNote(db, SYMBOL, "I see Worldex as mispriced on its cash pile.");
    // A news item of the year: the narrative never reads it (the Reversal does).
    await db.insert(gold.filings).values({ id: "6f1d1a52-3333-4a3b-9c1d-000000000001", symbol: SYMBOL, registry: "dart", filingKey: "h1", form: null, title: "Q3 results notice", filedAt: new Date(), url: null, language: "ko", sources: ["dart"] });
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    const p = analysisPrompts[0];
    // Every Price Driver with its kind, measure, changes, confidence and step B's two tests; a noise candidate never.
    expect(p).toContain("P1 [a company KPI, strong confidence] Revenue. Revenue moves this business. When it goes up, the share price should go up.");
    expect(p).toContain("Measured as: Revenue, years.");
    expect(p).toContain("12 months to Dec-25: 291.80B KRW (-4.9% on a year earlier), a change that matters: sales fell 5%");
    expect(p).toContain("Confidence: strong. The stock trades on revenue.");
    expect(p).toContain("Tests: A) of 2 significant changes, 2 were followed by a significant unbiased 1-week move the expected way, 0 were not; B) it changed on the first day of 2 of the 3 significant 1-week moves.");
    expect(p).not.toMatch(/fundamental week/);
    // Thierry's own view, an input the model weighs.
    expect(p).toContain("I see Worldex as mispriced on its cash pile.");
    expect(p).toContain("P2 [a company KPI, strong confidence] Net cash.");
    expect(p).not.toContain("Headcount");
    // The price, the fair value (base, low, high) and how it moved; no news, no chart menu.
    expect(p).toContain("Quote: 30000 KRW");
    expect(p).toContain("Fair value (weighted from several valuation methods): 40000 KRW, range 35000 to 46000");
    expect(p).toContain("Fair value over time (base, range): 2026-10-01 38000 (33000.00 to 44000.00)");
    expect(p).not.toContain("Q3 results notice");
    expect(p).not.toContain("Stored chart series");
    expect(p).toContain('"side": "long" | "short"');
    expect(p).toContain('"confidence": "strong" | "weak" | "noise"');
    expect(p).toContain("one per Price Driver that EXPLAINS the narrative (among P1, P2; at least one)");

    expect(await db.select().from(narratives)).toMatchObject([{ id: `${SYMBOL}:long`, side: "long", confidence: "strong", sideWhy: "The price sits a quarter under the fair value while sales dip.", text: "The market prices Worldex as a cyclical parts maker.", detail: "Its margins held while sales dipped." }]);
    // One belief per Price Driver that explains it, on the Price Driver itself; the invented one is dropped; the noise candidate has none.
    const pds = await db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, SYMBOL));
    expect(Object.fromEntries(pds.map((k) => [k.name, k.marketBelief]))).toEqual({ Revenue: "The market believes chip makers will keep cutting parts orders.", "Net cash": "The market sees the net cash as idle.", Headcount: null });
    expect(calls).toEqual(["analysis"]);
    // Same inputs: never asked again, even after Thierry said something new (his notes are outside the hash).
    await seedNote(db, SYMBOL, "A later thought.");
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis"]);
  });

  it("the side is the model's call, no coded rule: a price ABOVE the fair value range answered long stores long", async () => {
    await trustPriceDrivers();
    // 50,000 sits above the range 35,000 to 46,000; the model still answers long, with its stated reason.
    await db.update(gold.quotes).set({ close: 50000 }).where(eq(gold.quotes.symbol, SYMBOL));
    answer = answerOf("long");
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(narratives)).map((n) => [n.id, n.side])).toEqual([[`${SYMBOL}:long`, "long"]]);
    expect((await db.select().from(analyses)).map((a) => a.side)).toEqual(["long"]);
    // His game is explained to the model, never enforced: a long priced above its value is not a trade, depart only with a reason.
    expect(analysisPrompts[0]).toContain("Quote: 50000 KRW");
    const [row] = await db.select().from(bronze).where(and(eq(bronze.dimension, "analysis"), eq(bronze.subject, SYMBOL)));
    expect(row.error).toBeNull();
    // The other way: a price BELOW the range can carry an optimistic story; one narrative per ticker, wherever the price sits.
    answer = answerOf("short");
    await db.update(gold.quotes).set({ close: 30000 }).where(eq(gold.quotes.symbol, SYMBOL));
    calls = [];
    analysisPrompts = [];
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis"]);
    expect((await db.select().from(narratives)).map((n) => [n.id, n.side, n.sideWhy])).toEqual([[`${SYMBOL}:short`, "short", "The price prices a recovery the figures do not show."]]);
    // The previous version is handed back to keep word for word, beliefs by label.
    expect(analysisPrompts[0]).toContain("Your previous answer:");
    expect(analysisPrompts[0]).toContain("Keep it WORD FOR WORD");
    expect(analysisPrompts[0]).toContain('"priceDriver": "P1"');
  });

  it("which Price Drivers explain it is the model's call: one left out simply has no belief; a noise narrative carries none and clears step D's old readings", async () => {
    await trustPriceDrivers();
    answer = answerOf("long", ["P2"], "weak");
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis"]);
    expect(await db.select().from(narratives)).toMatchObject([{ side: "long", confidence: "weak" }]);
    const beliefs = async () => Object.fromEntries((await db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, SYMBOL))).map((k) => [k.name, k.marketBelief]));
    expect(await beliefs()).toEqual({ Revenue: null, "Net cash": "The market sees the net cash as idle.", Headcount: null });
    // Step C answers noise: no story explains the gap. The narrative row says so; no belief; the readings made against the old story go.
    await db.update(kpiDrivers).set({ reversal: reversal("long"), signal: "strong", signalWhy: "old" }).where(eq(kpiDrivers.id, PD_CASH));
    await db.update(kpiDrivers).set({ level: "weak" }).where(eq(kpiDrivers.id, PD_CYCLE));
    answer = { ...answerOf("long", ["P1", "P2"], "noise"), narrative: "No clear story explains where Worldex trades." };
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    const [n] = await db.select().from(narratives);
    expect(n).toMatchObject({ confidence: "noise", text: "No clear story explains where Worldex trades." });
    expect(holdsNarrative(n)).toBe(false);
    expect(await beliefs()).toEqual({ Revenue: null, "Net cash": null, Headcount: null });
    expect((await db.select().from(kpiDrivers).where(eq(kpiDrivers.id, PD_CASH)))[0]).toMatchObject({ reversal: null, signal: null, signalWhy: null });
  });

  it("an unreadable answer is asked once more, then fails loud", async () => {
    await trustPriceDrivers();
    answer = { ...answerOf("long"), confidence: "certain" as never };
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis", "analysis"]);
    expect(analysisPrompts[1]).toContain('It could not be read (analysis: confidence "certain" is not strong, weak or noise)');
    const [row] = await db.select().from(bronze).where(and(eq(bronze.dimension, "analysis"), eq(bronze.subject, SYMBOL)));
    expect(row.error).toContain('confidence "certain"');
    expect(await db.select().from(narratives)).toEqual([]);
  });

  it("a news item or a reversal never re-writes the narrative; a change in a Price Driver does", async () => {
    await trustPriceDrivers();
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    await seedBuyback();
    await db.update(kpiDrivers).set({ reversal: reversal("long") }).where(eq(kpiDrivers.id, PD_CASH));
    calls = [];
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);
    await db.update(kpiDrivers).set({ level: "weak" }).where(eq(kpiDrivers.id, PD_CASH));
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis"]);
    expect(await db.select().from(analyses)).toHaveLength(2);
    // The rewrite states the belief again, on the Price Driver.
    expect((await db.select().from(kpiDrivers).where(eq(kpiDrivers.id, PD_CASH)))[0].marketBelief).toBe("The market sees the net cash as idle.");
  });

  it("the whole chain C -> D -> E: the narrative, each Price Driver read against it, then step E's own stored judgment gives the signal", async () => {
    await trustPriceDrivers();
    await seedNote(db, SYMBOL, "I see Worldex as mispriced on its cash pile.");
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    calls = [];
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    // Step D has read nothing yet: step E is not asked, no signal, the baseline.
    expect(calls).toEqual([]);
    expect((await db.select().from(signals).where(eq(signals.symbol, SYMBOL)))[0]).toMatchObject({ signal: "none", strength: "noise" });
    expect(await db.select().from(signalChanges)).toHaveLength(0);

    const buyback = await seedBuyback();
    await runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
    // D: one reading per Price Driver, each against the narrative and THAT driver's belief.
    expect(calls).toEqual(["reversal", "reversal"]);
    expect(reversalPrompts[0]).toContain("The narrative (side long: the PESSIMISTIC story");
    expect(reversalPrompts[0]).toContain("held with strong confidence");
    expect(reversalPrompts[1]).toContain("What the market believes about this Price Driver: The market sees the net cash as idle.");
    expect(reversalPrompts[1]).toContain("Share buyback trust");
    expect(reversalPrompts[1]).toContain("I see Worldex as mispriced on its cash pile.");
    const pds = await db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, SYMBOL));
    expect(Object.fromEntries(pds.map((k) => [k.name, k.reversal ? `${k.reversal.stance}:${k.reversal.strength}:${k.reversal.turn}` : null]))).toEqual({ Revenue: "none:none:null", "Net cash": "against:strong:inflection", Headcount: null });
    // The leading indicator keeps the known label only (L9 dropped).
    expect(pds.find((k) => k.id === PD_CASH)!.reversal!.leading.events.map((e) => e.id)).toEqual([buyback]);

    // E: ONE call, given C and D (and Thierry's inputs), stored as its own judgment.
    calls = [];
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["signal", "note"]);
    const sp = signalPrompts[0];
    expect(sp).toContain("Step C, the narrative (side long: the PESSIMISTIC story");
    expect(sp).toContain("held with strong confidence): The market prices Worldex as a cyclical parts maker.");
    expect(sp).toContain("Step D, each Price Driver read against the narrative:");
    expect(sp).toContain("P1 Revenue (strong confidence that the price trades on it).");
    expect(sp).toContain("  Reading: noise.");
    expect(sp).toContain("P2 Net cash (strong confidence that the price trades on it).");
    expect(sp).toContain("  The market believes: The market sees the net cash as idle.");
    expect(sp).toContain("  Reading: in REVERSAL against the narrative, strong. The buyback puts the idle cash to work.");
    expect(sp).toContain("I see Worldex as mispriced on its cash pile.");
    expect(sp).not.toContain("Headcount");
    const stored = await db.select().from(silver.judgments).where(eq(silver.judgments.subjectKind, "signal"));
    expect(stored).toMatchObject([{ subjectId: SYMBOL, verdict: "strong", reason: "Net cash turns: the buyback puts 10% of the idle cash to work." }]);
    expect(stored[0].questionKey).toMatch(/^signal@v1:/);
    const [s] = await db.select().from(signals).where(eq(signals.symbol, SYMBOL));
    // A pessimistic narrative turning = BUY, at step E's confidence; why = E's sentence; its ids = the events the leading Price Driver's reversal read.
    expect(s).toMatchObject({ signal: "BUY", strength: "strong", side: "long", fairValue: 40000, quote: 30000, evidenceIds: [buyback], why: "Net cash turns: the buyback puts 10% of the idle cash to work." });
    expect(s.theses).toEqual([{ side: "long", signal: "strong", effect: "reversal", strength: "strong", why: "Net cash turns: the buyback puts 10% of the idle cash to work.", since: null }]);
    expect(s.gapPct).toBeCloseTo(-0.25, 6);
    const [change] = await db.select().from(signalChanges);
    expect(change).toMatchObject({ symbol: SYMBOL, fromSignal: "none", toSignal: "BUY", toStrength: "strong", updateNote: "BUY: a buyback trust turns the cash story.", evidenceIds: [buyback] });

    // Stored once per input: the same C and D ask nothing, a new input of Thierry's neither.
    calls = [];
    await seedNote(db, SYMBOL, "A later thought.");
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);

    // A note written by an older prompt is written again once.
    await db.update(signalStates).set({ updateNote: "A long paragraph of fair value arithmetic.", noteVersion: null }).where(eq(signalStates.baseline, 0));
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["note"]);

    // The signal is E's call, not a rule on D: the same reversal, and E answers weak, then noise.
    turning = { turning: "weak", lead: "P2", why: "The buyback is small against the cash pile." };
    await db.delete(silver.judgments).where(eq(silver.judgments.subjectKind, "signal"));
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(signals).where(eq(signals.symbol, SYMBOL)))[0]).toMatchObject({ signal: "BUY", strength: "weak", why: "The buyback is small against the cash pile." });
    turning = { turning: "noise", lead: null, why: "One buyback does not turn the cyclical story." };
    await db.delete(silver.judgments).where(eq(silver.judgments.subjectKind, "signal"));
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(signals).where(eq(signals.symbol, SYMBOL)))[0]).toMatchObject({ signal: "none", strength: "noise", side: null, evidenceIds: [], why: "One buyback does not turn the cyclical story." });

    // A new D reading (the driver now in continuation) is a new input: E is asked again.
    cash = { stance: "with", strength: "strong" };
    await db.update(narratives).set({ version: "v-next" });
    await runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
    calls = [];
    signalPrompts = [];
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toContain("signal");
    expect(signalPrompts[0]).toContain("  Reading: in CONTINUATION of the narrative, strong.");
  });

  it("D and E run only when C holds the narrative with weak or strong confidence", async () => {
    await trustPriceDrivers();
    answer = answerOf("long", ["P1", "P2"], "noise");
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    await seedBuyback();
    calls = [];
    await runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);
    expect(await db.select().from(bronze).where(eq(bronze.dimension, "kpi-reversal"))).toEqual([]);
    expect((await db.select().from(signals).where(eq(signals.symbol, SYMBOL)))[0]).toMatchObject({ signal: "none", strength: "noise", side: null });
  });

  it("the prompt asks the architecture's question and explains the game, never a coded rule", () => {
    const p = analysisPrompt("facts", "PRICE DRIVERS BLOCK", ["P1", "P2", "P3"]);
    expect(p).toContain("PRICE DRIVERS BLOCK");
    expect(p).toContain("The side and the confidence are YOUR call");
    expect(p).toContain("never add a reason of your own");
    expect(p).toContain("one per Price Driver that EXPLAINS the narrative (among P1, P2, P3; at least one)");
    expect(p).not.toContain("Your previous answer");
    expect(p).not.toContain("category");
    expect(p).not.toContain("exhibits");
  });

  it("parses side, confidence and one belief per known label; an unknown label or a repeat is dropped; a bad side or confidence fails loud", () => {
    const labels = new Map([["P1", "X:kpi:a"], ["P2", "X:kpi:b"]]);
    const b = (priceDriver: string) => ({ priceDriver, belief: `About ${priceDriver}` });
    const a = parseAnalysis(JSON.stringify({ side: "short", sideWhy: "why", confidence: "weak", narrative: "n", beliefs: [b("P2"), b("P7"), b("P2"), b("P1")] }), labels);
    expect(a).toMatchObject({ side: "short", sideWhy: "why", confidence: "weak" });
    expect(a.beliefs!.map((x) => [x.belief, x.kpiDriverId])).toEqual([["About P2", "X:kpi:b"], ["About P1", "X:kpi:a"]]);
    expect(() => parseAnalysis(JSON.stringify({ side: "both", confidence: "weak", narrative: "n", beliefs: [b("P1")] }), labels)).toThrow(/not long or short/);
    expect(() => parseAnalysis(JSON.stringify({ side: "long", narrative: "n", beliefs: [b("P1")] }), labels)).toThrow(/not strong, weak or noise/);
    expect(() => parseAnalysis(JSON.stringify({ side: "long", confidence: "strong", narrative: "n", beliefs: [b("P9")] }), labels)).toThrow(/names no Price Driver/);
    // Noise: no narrative explains the gap, so no Price Driver explains it either.
    expect(parseAnalysis(JSON.stringify({ side: "long", confidence: "noise", narrative: "n", beliefs: [b("P1")] }), labels).beliefs).toEqual([]);
  });

  it("reads every significant unbiased move with the events of its week, no verdict on any of them", async () => {
    const move = (day: string, z: number) => ({ id: `${SYMBOL}:${day}`, symbol: SYMBOL, startDay: day, endDay: day, lastStart: day, bench: "KOSDAQ", days: 1, currency: "KRW", closeBefore: 1000, closeEnd: 1200, returnPct: 0.2, benchReturn: 0.01, abnormal: 0.19, z, beta: 1, direction: "up" as const });
    await db.insert(priceMoves).values([move("2026-06-01", 5.1), move("2026-03-10", 3)]);
    await db.insert(driverEvents).values({ id: `${SYMBOL}|news:n1`, symbol: SYMBOL, kind: "news", sourceId: "n1", day: "2026-03-10", title: "Korean chip parts makers fall on rate fears", url: null, stock: 0.2, benchReturn: 0.01, beta: 1, reaction: 0.19, z: 3, bench: "KOSDAQ", moveId: `${SYMBOL}:2026-03-10` });
    const m = await movesText(db, SYMBOL, new Date("2026-11-17T00:00:00Z"));
    expect(m.text).toContain("- 2026-06-01: stock +20.0%, KOSDAQ +1.0% (5.1x its usual 1-week move). Events that week: none stored");
    // An industry or market-wide news that week is listed like any other: nothing is filtered out.
    expect(m.text).toContain("Events that week: 2026-03-10 Korean chip parts makers fall on rate fears");
    expect(m.text).not.toMatch(/caused by the market|business cause/);
  });
});

describe("step E, the signal: the narrative reversal is its own LLM judgment", () => {
  const pd = (rank: number, name: string, r: ReturnType<typeof reversal> | null) => ({ id: `X:kpi:${rank}`, name, rank, reversal: r });
  const t = (strength: Strength, kpiDriverId: string | null = "X:kpi:1", why = "Profit turns up."): Turning => ({ strength, why, kpiDriverId });
  it("a pessimistic narrative turning = BUY at step E's confidence; an optimistic one = SELL; noise or no reading = no signal", () => {
    expect(signalFrom("long", t("weak"))).toEqual({ signal: "BUY", strength: "weak", side: "long", kpiDriverId: "X:kpi:1", why: "Profit turns up.", effect: "reversal" });
    expect(signalFrom("short", t("strong"))).toMatchObject({ signal: "SELL", strength: "strong", side: "short" });
    const none = { signal: "none", strength: "noise", side: null, kpiDriverId: null, effect: "noise" };
    expect(signalFrom("long", t("noise", null, "Nothing turns."))).toEqual({ ...none, why: "Nothing turns." });
    expect(signalFrom("long", null)).toEqual({ ...none, why: null });
    expect(signalFrom(null, t("strong"))).toMatchObject(none);
  });
  it("the answer, typed: strong | weak | noise, the lead by its label (an unknown one dropped), a bad word fails loud", () => {
    const labels = new Map([["P1", "X:kpi:1"]]);
    expect(parseTurning(JSON.stringify({ turning: "strong", lead: "P1", why: "w" }), labels)).toEqual({ strength: "strong", why: "w", kpiDriverId: "X:kpi:1" });
    expect(parseTurning(JSON.stringify({ turning: "weak", lead: "P9", why: "w" }), labels)).toEqual({ strength: "weak", why: "w", kpiDriverId: null });
    expect(parseTurning(JSON.stringify({ turning: "noise", lead: "P1", why: "w" }), labels).kpiDriverId).toBeNull();
    expect(() => parseTurning(JSON.stringify({ turning: "maybe", why: "w" }), labels)).toThrow(/strong, weak or noise/);
    expect(SIGNAL_SYSTEM).toContain("Decide yourself, never by counting");
  });
  it("what the outputs draw: the Price Drivers step D read in reversal against the narrative, strong before weak, then by rank", () => {
    const drivers = [pd(1, "A", reversal("long", { strength: "weak" })), pd(2, "B", reversal("long")), pd(3, "C", reversal("long")), pd(4, "D", reversal("long", { stance: "with" })), pd(5, "E", reversal("short"))];
    expect(driversAgainst("long", drivers).map((k) => k.name)).toEqual(["B", "C", "A"]);
  });
  it("no rule on the price: a BUY above the fair value stands when step E says the narrative turns", () => {
    const r = readingOf({ value: 100, currency: "USD", method: "m" }, { close: 105, currency: "USD", date: "2026-11-20" }, "long", t("strong"), ["e1"]);
    expect(r).toMatchObject({ signal: "BUY", strength: "strong", side: "long", evidenceIds: ["e1"] });
    expect(r.gapPct).toBeCloseTo(0.05, 6);
    expect(readingOf(null, null, "long", t("noise"), ["e1"])).toMatchObject({ signal: "none", evidenceIds: [], theses: [{ side: "long", signal: "noise", effect: "noise" }] });
  });
  it("the signal's ids are the events the leading Price Driver's reversal read, newest first", () => {
    const e = (id: string, day: string) => ({ id, day, kind: "news" as const, title: id, sourceId: id, url: null });
    expect(eventsBehind({ reversal: reversal("long", { leading: { probability: "high", why: "w", events: [e("a", "2026-10-01"), e("b", "2026-11-01")] } }) })).toEqual(["b", "a"]);
    expect(eventsBehind(undefined)).toEqual([]);
  });
});

describe("Fair Value History (Kevin 2026-11-09)", () => {
  it("the dimension writes the fair value history (last synthesis of each day); no per-news reaction any more", async () => {
    const synth = (at: string, base: number) => ({ symbol: SYMBOL, inputHash: at, result: { currency: "KRW", low: base * 0.9, base, high: base * 1.1, weights: [], label: "l", summary: "s", report: "r" }, model: "m", bronzeId: crypto.randomUUID(), createdAt: new Date(at) });
    await db.insert(valuationSyntheses).values([synth("2026-11-06T10:00:00Z", 38000), synth("2026-11-06T20:00:00Z", 39000), synth("2026-11-08T10:00:00Z", 40000)]);
    await runDimension(db, marketReactionDim, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(fairValueHistory)).map((h) => [h.day, h.value]).sort()).toEqual([["2026-11-06", 39000], ["2026-11-08", 40000]]);
  });
});

describe("speed (Kevin 2026-11-06)", () => {
  it("every dimension sits in exactly one stage, after the ones it reads", () => {
    expect(STAGES.flat().sort()).toEqual(DIMENSIONS.map((d) => d.name).sort());
    const at = (n: string) => STAGES.findIndex((s) => s.includes(n));
    for (const [before, after] of [["company-profile", "news"], ["price", "financials"], ["filings", "financials"], ["consensus", "peers"], ["peers", "valuation"], ["valuation", "analysis"], ["valuation", "market-reaction"], ["market-reaction", "kpi-drivers"], ["kpi-drivers", "analysis"], ["analysis", "kpi-reversal"], ["kpi-reversal", "signals"], ["price", "intraday-price"], ["intraday-price", "financials"], ["intraday-price", "market-reaction"], ["intraday-price", "signals"], ["signals", "signal-alerts"]]) expect(at(before)).toBeLessThan(at(after));
    expect(stagesFor(dimensionsFor("from:valuation")).map((s) => s.map((d) => d.name))).toEqual([["valuation"], ["market-reaction"], ["kpi-drivers"], ["analysis"], ["kpi-reversal"], ["signals"], ["signal-alerts"], ["emphasis"]]);
    // ONE chain in the order of docs/architecture.md: common objects, A + B, C, D, E; nothing else beside them.
    expect(ON_DEMAND_DIMENSIONS).not.toContain("kpi-drivers");
    expect(dimensionsFor("core").map((d) => d.name)).toEqual(expect.arrayContaining(["kpi-drivers", "analysis", "kpi-reversal", "signals"]));
    for (const gone of ["narrative-state", "driver-confidence", "thesis", "evidence", "narrative-since", "move-causes"]) expect(DIMENSIONS.map((d) => d.name)).not.toContain(gone);
    expect(stagesFor(dimensionsFor("market-reaction,kpi-drivers,analysis,kpi-reversal,signals")).map((s) => s.map((d) => d.name))).toEqual([["market-reaction"], ["kpi-drivers"], ["analysis"], ["kpi-reversal"], ["signals"]]);
  });
  it("the Sandbox writers never run in the daily collect", () => {
    for (const d of ["sandbox-posts", "sandbox-visuals", "sandbox-image-fix", "sandbox-review"]) expect(dimensionsFor("all").map((x) => x.name)).not.toContain(d);
  });
});

