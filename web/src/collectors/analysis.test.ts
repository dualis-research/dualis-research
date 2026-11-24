import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyses, evidence, exhibits, fairValueHistory, fairValues, kpiDrivers, marketReactions, narrativeDrivers, narrativeRationales, narratives, priceMoveCauses, priceMoves, researchReports, signalChanges, signals, signalStates } from "@/db/schema/analysis";
import { fetches as bronze } from "@/db/schema/bronze";
import { valuationSyntheses } from "@/db/schema/valuation";
import { goldFinancialLines, financialMetrics } from "@/db/schema/financials";
import * as gold from "@/db/schema/gold";
import { theses } from "@/db/schema/thesis";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { priceDriver, reversal, seedPriceDrivers } from "@/test/price-drivers";
import { analysis, NO_TRUSTED_DRIVER } from "./dimensions/analysis";
import { movesText } from "./dimensions/analysis/facts";
import { fairValueAt, marketReactionDim, reactionLine, reactionOf } from "./dimensions/market-reaction";
import { analysisPrompt, parseAnalysis } from "./dimensions/analysis/prompt";
import { narrativeSinceDim, sinceChoices } from "./dimensions/narrative-since";
import { batchSubject, evidenceDim, parseBatch, parseBatchSubject, parseEvidenceSubject, verdictRank } from "./dimensions/evidence";
import { kpiReversalDim } from "./dimensions/kpi-reversal";
import { dimensionsFor, stagesFor, STAGES, DIMENSIONS, ON_DEMAND_DIMENSIONS } from "./registry";
import { driversAgainst, readingOf, signalFrom, signalsDim } from "./dimensions/signals";
import { watchlist } from "./dimensions/watchlist";
import { runDimension } from "./runner";
import type { SourceContext } from "./types";

const REPO_ROOT = resolve(__dirname, "../../..");
const SYMBOL = "101160.KQ";
const PD_CYCLE = `${SYMBOL}:kpi:revenue`;
const PD_CASH = `${SYMBOL}:kpi:net-cash`;

/** The narrative as the model writes it: its side, and one driver per Price Driver (P1 = Revenue, P2 = Net cash). */
const answerOf = (side: "long" | "short", drivers = ["P1", "P2"]) => ({
  side,
  sideWhy: side === "long" ? "The price sits a quarter under the fair value while sales dip." : "The price prices a recovery the figures do not show.",
  narrative: "The market prices Worldex as a cyclical parts maker.",
  narrativeDetail: "Its margins held while sales dipped.",
  drivers: [
    { priceDriver: "P1", category: "Industry & cycle", title: "Memory capex drives etch parts demand", summary: "Chip makers buy fewer parts when they cut spending.", text: "Revenue fell 5% in 2025.", exhibits: [{ title: "Revenue by year", chart: "bar", series: ["line:revenue", "line:not-stored"], takeaway: "Sales dipped in 2025." }] },
    { priceDriver: "P2", category: "Balance sheet & capital", title: "Net cash is seen as idle", text: "Net cash of KRW 100B.", exhibits: [{ title: "Invented", chart: "line", series: ["metric:made-up"], takeaway: "x" }, { title: "Operating margin", chart: "line", series: ["metric:operating-margin"], takeaway: "Margins held." }] },
    // A reason the model invents (no Price Driver of the list): dropped, never a driver.
    { priceDriver: "P9", category: "Macro & policy", title: "Rates stay high", text: "x", exhibits: [] },
  ].filter((d) => d.priceDriver === "P9" || drivers.includes(d.priceDriver)),
});

let calls: string[] = [];
let lastEvidencePrompt = "";
let analysisPrompts: string[] = [];
let reversalPrompts: string[] = [];
let answer: ReturnType<typeof answerOf> = answerOf("long");
/** What the reversal judge says of the cash driver (the cycle driver never turns here). */
let cash: { stance: "against" | "with" | "none"; strength: "strong" | "weak" | "none" } = { stance: "against", strength: "strong" };
const fake: Complete = async ({ prompt, system }) => {
  if (system.includes("one-line signal notes")) {
    calls.push("note");
    expect(prompt).toContain("ONE short sentence");
    expect(prompt).not.toMatch(/Fair value \d/);
    return { text: prompt.includes("to BUY (strong inflection)") ? "BUY: a buyback trust turns the cash story." : "Signal moved.", model: "fake" };
  }
  if (system.includes("equity research reports")) {
    calls.push("report");
    return { text: "## Executive Summary\nWorldex — fair value KRW 40,000.\n[EXHIBIT 1]", model: "fake" };
  }
  if (system.includes("WHY the market holds")) {
    calls.push("rationale");
    return { text: JSON.stringify({ summary: "The market sees a cyclical parts maker after a 2025 dip.", claims: [{ text: "Revenue fell to KRW 291.8B in 2025.", drivers: [1, 7], sources: [{ type: "exhibit", ref: "1", label: "Revenue" }, { type: "bogus", ref: "x" }] }], exhibits: [{ title: "Share price", chart: "line", series: ["line:revenue", "nope"], takeaway: "Back to a year ago." }, { title: "Invented", chart: "bar", series: ["nope"], takeaway: "x" }] }), model: "fake" };
  }
  if (system.includes("TURNS AGAINST that story")) {
    calls.push("reversal");
    reversalPrompts.push(prompt);
    const mine = prompt.includes("Price Driver (kpi, strong confidence): Net cash") ? cash : { stance: "none" as const, strength: "none" as const };
    return { text: JSON.stringify({ intrinsic: { state: mine.stance === "against" ? "reversing-down" : "flat", period: null, why: "Cash went to a buyback." }, leading: { probability: "none", events: [], why: "Nothing recent says more." }, durability: "structural", magnitude: null, pricedIn: "none", stance: mine.stance, strength: mine.strength, direction: mine.stance === "none" ? null : "down", headline: "Buyback returns 10% of cash", why: "The buyback puts the idle cash to work.", citations: [] }), model: "fake" };
  }
  const verdict = (v: string, reason: string) => ({ text: JSON.stringify({ verdict: v, probability: 0.8, cited_sentence: "buyback", reason }), model: "fake" });
  if (prompt.includes("Since which month has the market held THIS story")) {
    calls.push("since");
    expect(prompt).toContain("vs today's fair value");
    // The story took hold 2 months ago.
    return verdict(sinceChoices()[4], "The price fell below fair value two months ago.");
  }
  if (prompt.includes("For EACH item below and EACH driver")) {
    lastEvidencePrompt = prompt;
    calls.push("evidence");
    // The buyback reverses the cash reason (driver 2) and is noise for the cycle reason (driver 1).
    const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
    return { text: JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ n: i + 1, pricedIn: "none", drivers: { "1": { tag: "noise", p: 0.8, why: "Nothing on the cycle.", cited: null }, "2": { tag: "reversal:strong", p: 0.8, why: "A buyback trust returns cash.", cited: "buyback" } } })) }), model: "fake" };
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
  await db.insert(theses).values({ symbol: SYMBOL, narrative: "A generic chip-parts supplier." }).onConflictDoUpdate({ target: theses.symbol, set: { narrative: "A generic chip-parts supplier." } });
});
afterEach(async () => close());

/** The trusted Price Drivers `kpi-drivers` found: Revenue (strong, a stored series) and Net cash (strong); Headcount is not trusted. */
async function trustPriceDrivers() {
  await seedPriceDrivers(db, [
    priceDriver(SYMBOL, 1, "Revenue", { series: "line:revenue", measure: { source: "series", label: "Revenue, years", periodType: "year", unit: "currency", currency: "KRW", providers: ["dart"] }, periods: [{ period: "2025-12", periodType: "year", value: 291.8e9, prior: 306.8e9, change: -0.049, changeKind: "relative", significant: true, why: "sales fell 5%", releaseId: null, releaseDay: "2026-02-10", cite: null }], tests: { changes: 2, followed: 2, against: 0, moves: 3, fundamentalMoves: 2, explained: 2, explainedMoveIds: [`${SYMBOL}:2026-02-10`], both: 2, bothAgree: 2 } }),
    priceDriver(SYMBOL, 2, "Net cash"),
    priceDriver(SYMBOL, 3, "Headcount", { level: "none" }),
  ]);
}

describe("analysis dimension: ONE narrative written on the trusted Price Drivers (Kevin 2026-11-24)", () => {
  it("no trusted Price Driver: no call, a failed fetch saying why, never a silent skip", async () => {
    await seedPriceDrivers(db, [priceDriver(SYMBOL, 1, "Headcount", { level: "none" })]);
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    const [row] = await db.select().from(bronze).where(and(eq(bronze.dimension, "analysis"), eq(bronze.subject, SYMBOL)));
    expect(row.error).toBe(NO_TRUSTED_DRIVER);
    expect(row.error).toContain("no trusted price driver yet");
    expect(calls).toEqual([]);
    expect(await db.select().from(narratives)).toEqual([]);
  });

  it("the call receives the trusted Price Drivers, the price, the fair value and its history; its drivers ARE those Price Drivers; once per input", async () => {
    await trustPriceDrivers();
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    const p = analysisPrompts[0];
    // Every trusted Price Driver with its kind, measure, changes, confidence and tests A, B and C; the untrusted one never.
    expect(p).toContain("P1 [a company KPI, strong confidence] Revenue. Revenue moves this business. When it goes up, the share price should go up.");
    expect(p).toContain("Measured as: Revenue, years.");
    expect(p).toContain("12 months to Dec-25: 291.80B KRW (-4.9% on a year earlier), a change that matters: sales fell 5%");
    expect(p).toContain("Confidence: strong. The stock trades on revenue.");
    expect(p).toContain("Tests: A) 2 of 2 big changes were followed by the price the expected way in a fundamental week, 0 were not; B) it changed in 2 of the 2 fundamental weeks (3 unusual weeks in all); C) 2 events where both moved, 2 the expected way.");
    expect(p).toContain("P2 [a company KPI, strong confidence] Net cash.");
    expect(p).not.toContain("Headcount");
    // The price, the fair value (base, low, high) and how it moved.
    expect(p).toContain("Quote: 30000 KRW");
    expect(p).toContain("Fair value (weighted from several valuation methods): 40000 KRW, range 35000 to 46000");
    expect(p).toContain("Fair value over time (base, range): 2026-10-01 38000 (33000.00 to 44000.00)");
    expect(p).toContain('"side": "long" | "short"');
    expect(p).toContain("exactly one per Price Driver (P1, P2)");

    const [fv] = await db.select().from(fairValues).where(eq(fairValues.symbol, SYMBOL));
    expect(fv).toMatchObject({ value: 40000, label: "Mostly EV/EBITDA" });
    expect(await db.select().from(narratives)).toMatchObject([{ id: `${SYMBOL}:long`, side: "long", sideWhy: "The price sits a quarter under the fair value while sales dip.", text: "The market prices Worldex as a cyclical parts maker.", detail: "Its margins held while sales dipped." }]);
    const drivers = (await db.select().from(narrativeDrivers).where(eq(narrativeDrivers.symbol, SYMBOL))).sort((a, b) => a.rank - b.rank);
    // One Narrative Driver per trusted Price Driver, pointing to it, with the category the model assigned; the invented reason is gone.
    expect(drivers.map((d) => [d.rank, d.category, d.kpiDriverId])).toEqual([[1, "Industry & cycle", PD_CYCLE], [2, "Balance sheet & capital", PD_CASH]]);
    expect(drivers[0].summary).toBe("Chip makers buy fewer parts when they cut spending.");
    // The unusual weeks its Price Driver explains (test B, by code).
    expect(drivers[0].moveIds).toEqual([`${SYMBOL}:2026-02-10`]);
    const ex = (await db.select().from(exhibits).where(eq(exhibits.symbol, SYMBOL))).sort((a, b) => a.number - b.number);
    // The unknown series key and the invented exhibit are dropped; the numbers come from gold.
    expect(ex.map((e) => [e.number, e.driverId, e.series.map((s) => s.key)])).toEqual([[1, `${SYMBOL}:long:1`, ["line:revenue"]], [2, `${SYMBOL}:long:2`, ["metric:operating-margin"]], [3, `${SYMBOL}:long:rationale`, ["line:revenue"]]]);
    expect(ex[0].points).toEqual([{ period: "2024-12", values: { "line:revenue": 306.8e9 } }, { period: "2025-12", values: { "line:revenue": 291.8e9 } }]);
    const [report] = await db.select().from(researchReports);
    expect(report.markdown).not.toMatch(/[—–]/);
    expect(report.markdown).toContain("not investment advice");
    expect(calls).toEqual(["analysis", "rationale", "report"]);
    // Narrative Rationale: claims with valid drivers and sources only; its exhibit numbered after the drivers'.
    const [rat] = await db.select().from(narrativeRationales);
    expect(rat.claims).toEqual([{ text: "Revenue fell to KRW 291.8B in 2025.", drivers: [1], sources: [{ type: "exhibit", ref: "1", label: "Revenue" }] }]);
    // Same inputs: never asked again.
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis", "rationale", "report"]);
  });

  it("the side is the model's call, no code rule: a price BELOW the fair value range can carry an optimistic story", async () => {
    await trustPriceDrivers();
    // 30,000 sits under the range 35,000 to 46,000: the deleted rule forced the long thesis here.
    answer = answerOf("short");
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(narratives)).map((n) => [n.id, n.side, n.sideWhy])).toEqual([[`${SYMBOL}:short`, "short", "The price prices a recovery the figures do not show."]]);
    expect((await db.select().from(narrativeDrivers)).map((d) => d.id).sort()).toEqual([`${SYMBOL}:short:1`, `${SYMBOL}:short:2`]);
    expect((await db.select().from(analyses)).map((a) => a.side)).toEqual(["short"]);
    // One narrative per ticker, never two in parallel, wherever the price sits.
    await db.update(gold.quotes).set({ close: 41000 }).where(eq(gold.quotes.symbol, SYMBOL));
    calls = [];
    analysisPrompts = [];
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls.filter((c) => c === "analysis")).toHaveLength(1);
    expect(await db.select().from(narratives)).toHaveLength(1);
    // The previous version is handed back to keep word for word.
    expect(analysisPrompts[0]).toContain("Your previous version of this narrative");
    expect(analysisPrompts[0]).toContain("Keep it WORD FOR WORD");
    expect(analysisPrompts[0]).toContain('"priceDriver": "P1"');
  });

  it("a Price Driver left out is asked once more, then fails loud; a driver without a chart of its own gets its Price Driver's series", async () => {
    await trustPriceDrivers();
    answer = answerOf("long", ["P2"]);
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis", "analysis"]);
    expect(analysisPrompts[1]).toContain("Price Drivers P1 had no narrative driver.");
    const [row] = await db.select().from(bronze).where(and(eq(bronze.dimension, "analysis"), eq(bronze.subject, SYMBOL)));
    expect(row.error).toBe("Price Drivers P1 have no narrative driver");
    expect(await db.select().from(narratives)).toEqual([]);
    // Its own figure as its chart when the model gave none it could bind.
    const full = answerOf("long");
    answer = { ...full, drivers: full.drivers.map((d) => ({ ...d, exhibits: [] })) };
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(exhibits)).filter((e) => !e.driverId.endsWith("rationale")).map((e) => [e.driverId, e.title, e.series.map((s) => s.key)])).toEqual([[`${SYMBOL}:long:1`, "Revenue", ["line:revenue"]]]);
  });

  it("a news item never re-writes the narrative (news stay out of the hash); a change in a Price Driver does", async () => {
    await trustPriceDrivers();
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    await db.insert(gold.filings).values({ id: "6f1d1a52-3333-4a3b-9c1d-000000000001", symbol: SYMBOL, registry: "dart", filingKey: "h1", form: null, title: "Q3 results", filedAt: new Date(), url: null, language: "ko", sources: ["dart"] });
    // Its reversal is read after the narrative: never a reason to rewrite it either.
    await db.update(kpiDrivers).set({ reversal: reversal("long") }).where(eq(kpiDrivers.id, PD_CASH));
    calls = [];
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);
    await db.update(kpiDrivers).set({ level: "weak" }).where(eq(kpiDrivers.id, PD_CASH));
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["analysis", "rationale", "report"]);
    // Same words = same version: the judgments built on the narrative stay valid.
    expect(new Set((await db.select().from(analyses)).map((a) => a.side))).toEqual(new Set(["long"]));
    expect(await db.select().from(analyses)).toHaveLength(2);
  });

  it("the whole chain: narrative, reversals against it, evidence per driver, then the signal; the first signal is the baseline", async () => {
    await trustPriceDrivers();
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    // No reversal read yet: no signal, the baseline.
    expect((await db.select().from(signals).where(eq(signals.symbol, SYMBOL)))[0]).toMatchObject({ signal: "none", strength: "noise" });
    expect(await db.select().from(signalChanges)).toHaveLength(0);

    const filingId = "6f1d1a52-1111-4a3b-9c1d-000000000001";
    await db.insert(gold.filings).values({ id: filingId, symbol: SYMBOL, registry: "dart", filingKey: "r1", form: null, title: "Share buyback trust", filedAt: new Date(), url: "https://dart/x", language: "ko", sources: ["dart"] });
    // A filing older than the 12-month window is not judged.
    await db.insert(gold.filings).values({ id: "6f1d1a52-1111-4a3b-9c1d-000000000002", symbol: SYMBOL, registry: "dart", filingKey: "r0", form: null, title: "Old notice", filedAt: new Date(Date.now() - 400 * 86_400_000), url: null, language: "ko", sources: ["dart"] });
    calls = [];
    await runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
    // One reading per trusted Price Driver, each against the narrative the analysis just wrote.
    expect(calls).toEqual(["reversal", "reversal"]);
    expect(reversalPrompts[0]).toContain("The narrative (side long: the PESSIMISTIC story");
    expect(reversalPrompts[1]).toContain("What the market believes about this Price Driver (Balance sheet & capital): Net cash is seen as idle.");
    const pds = await db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, SYMBOL));
    expect(Object.fromEntries(pds.map((k) => [k.name, k.reversal ? `${k.reversal.stance}:${k.reversal.strength}:${k.reversal.turn}` : null]))).toEqual({ Revenue: "none:none:null", "Net cash": "against:strong:inflection", Headcount: null });

    calls = [];
    await runDimension(db, evidenceDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["evidence"]);
    const all = await db.select().from(evidence);
    expect(all).toHaveLength(1);
    const [e] = all;
    // One verdict per driver; the item's top line is its strongest verdict.
    expect(e.verdicts.map((v) => [v.driverId, v.effect, v.strength, v.pricedIn])).toEqual([[`${SYMBOL}:long:1`, "noise", "noise", "none"], [`${SYMBOL}:long:2`, "reversal", "strong", "none"]]);
    expect(e).toMatchObject({ id: `${SYMBOL}|filing:${filingId}`, headline: "Share buyback trust", filingIds: [filingId], driverId: `${SYMBOL}:long:2`, effect: "reversal", strength: "strong", exhibitId: `${SYMBOL}:long:2:1` });
    expect(lastEvidencePrompt).toContain("pessimistic narrative: the PESSIMISTIC story");
    expect(lastEvidencePrompt).toContain("fair value 40000 (range 35000 to 46000)");

    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    const [s] = await db.select().from(signals).where(eq(signals.symbol, SYMBOL));
    // A pessimistic story + a Price Driver turning against it = BUY, at that reversal's strength, with the news behind it.
    expect(s).toMatchObject({ signal: "BUY", strength: "strong", side: "long", fairValue: 40000, quote: 30000, evidenceIds: [e.id], why: "Net cash: The buyback puts the idle cash to work." });
    expect(s.theses).toEqual([{ side: "long", signal: "strong", effect: "reversal", strength: "strong", why: "Net cash: The buyback puts the idle cash to work.", since: null }]);
    expect(s.gapPct).toBeCloseTo(-0.25, 6);
    const [change] = await db.select().from(signalChanges);
    expect(change).toMatchObject({ symbol: SYMBOL, fromSignal: "none", toSignal: "BUY", toStrength: "strong", updateNote: "BUY: a buyback trust turns the cash story." });

    // A note written by an older prompt is written again once.
    await db.update(signalStates).set({ updateNote: "A long paragraph of fair value arithmetic.", noteVersion: null }).where(eq(signalStates.baseline, 0));
    calls = [];
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["note"]);
    expect((await db.select().from(signalChanges))[0].updateNote).toBe("BUY: a buyback trust turns the cash story.");
    calls = [];
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);

    // The judge now reads the driver as going WITH the story: nothing against it, no signal.
    cash = { stance: "with", strength: "strong" };
    await db.update(narratives).set({ version: "v-next" });
    await runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(signals).where(eq(signals.symbol, SYMBOL)))[0]).toMatchObject({ signal: "none", strength: "noise", side: null, evidenceIds: [] });
  });

  it("an item is judged again only for the driver whose words changed", async () => {
    await trustPriceDrivers();
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    await db.insert(gold.filings).values({ id: "6f1d1a52-4444-4a3b-9c1d-000000000001", symbol: SYMBOL, registry: "dart", filingKey: "s1", form: null, title: "Share buyback trust", filedAt: new Date(), url: null, language: "ko", sources: ["dart"] });
    await runDimension(db, evidenceDim, { trigger: "test", ctx: ctx() });
    const before = (await db.select().from(evidence))[0].verdicts.find((v) => v.rank === 2)!.judgmentId;
    await db.update(narrativeDrivers).set({ text: "Revenue fell 5% in 2025 as memory makers cut capex." }).where(eq(narrativeDrivers.id, `${SYMBOL}:long:1`));
    calls = [];
    await runDimension(db, evidenceDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["evidence"]);
    const [e] = await db.select().from(evidence);
    expect(e.verdicts.find((v) => v.rank === 2)!.judgmentId).toBe(before);
    expect(e.verdicts).toHaveLength(2);
    calls = [];
    await runDimension(db, evidenceDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);
  });

  it("the prompt: the side is the model's call, the drivers are the Price Drivers and nothing else", () => {
    const p = analysisPrompt("facts", "PRICE DRIVERS BLOCK", ["P1", "P2", "P3"]);
    expect(p).toContain("PRICE DRIVERS BLOCK");
    expect(p).toContain("The side is YOUR call");
    expect(p).toContain("No rule decides it for you");
    expect(p).toContain("never add a reason of your own, never leave a Price Driver out");
    expect(p).toContain("exactly one per Price Driver (P1, P2, P3)");
    expect(p).not.toContain("Your previous version");
  });

  it("parses the side and one driver per known label; an unknown label or a repeat is dropped, a bad category or side fails loud", () => {
    const labels = new Map([["P1", "X:kpi:a"], ["P2", "X:kpi:b"]]);
    const d = (priceDriver: string, category = "Consensus expectations") => ({ priceDriver, category, title: `About ${priceDriver}`, text: "t", exhibits: [] });
    const a = parseAnalysis(JSON.stringify({ side: "short", sideWhy: "why", narrative: "n", drivers: [d("P2"), d("P7"), d("P2"), d("P1")] }), labels);
    expect(a).toMatchObject({ side: "short", sideWhy: "why" });
    expect(a.drivers.map((x) => [x.title, x.kpiDriverId])).toEqual([["About P2", "X:kpi:b"], ["About P1", "X:kpi:a"]]);
    expect(() => parseAnalysis(JSON.stringify({ side: "short", narrative: "n", drivers: [d("P1", "Expectations")] }), labels)).toThrow(/not a Driver Category/);
    expect(() => parseAnalysis(JSON.stringify({ side: "both", narrative: "n", drivers: [d("P1")] }), labels)).toThrow(/not long or short/);
    expect(() => parseAnalysis(JSON.stringify({ side: "long", narrative: "n", drivers: [d("P9")] }), labels)).toThrow(/no narrative driver names a Price Driver/);
  });

  it("still reads the moves the market made on the business, as context (INFLECTION-1117)", async () => {
    const move = (day: string, z: number, kind: "fundamental" | "macro", fact: string) => ({ m: { id: `${SYMBOL}:${day}`, symbol: SYMBOL, startDay: day, endDay: day, lastStart: day, bench: "KOSDAQ", days: 1, currency: "KRW", closeBefore: 1000, closeEnd: 1200, returnPct: 0.2, benchReturn: 0.01, abnormal: 0.19, z, beta: 1, direction: "up" as const }, c: { id: `${SYMBOL}:${day}`, symbol: SYMBOL, kind, fact, category: kind === "fundamental" ? ("Business economics" as const) : null, cites: [], candidates: 1, confidence: 0.8, judgmentId: null } });
    const rows = [move("2026-06-01", 5.1, "fundamental", "First-half orders doubled on two multi-year contracts."), move("2026-03-10", 3, "macro", "The KOSDAQ fell on rate fears.")];
    await db.insert(priceMoves).values(rows.map((r) => r.m));
    await db.insert(priceMoveCauses).values(rows.map((r) => r.c));
    const m = await movesText(db, SYMBOL, new Date("2026-11-17T00:00:00Z"));
    expect(m.text).toContain("[move 2026-06-01]");
    expect(m.text).toContain("First-half orders doubled");
    expect(m.text).not.toContain("rate fears");
    expect(m.text).toContain("Also 1 significant move caused by the market at large or by trading");
  });
});

describe("Too old (Kevin 2026-11-06)", () => {
  it("news from before the month the current story took hold are Too old: never judged, never under a driver, never a signal", async () => {
    await trustPriceDrivers();
    await runDimension(db, analysis, { trigger: "test", ctx: ctx() });
    await db.insert(gold.priceBars).values([{ symbol: SYMBOL, date: new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10), open: 40000, high: 40000, low: 40000, close: 40000, volume: 1, sources: ["naver"], alternatives: [] }, { symbol: SYMBOL, date: new Date().toISOString().slice(0, 10), open: 30000, high: 30000, low: 30000, close: 30000, volume: 1, sources: ["naver"], alternatives: [] }]);
    // Its local index (KOSDAQ): the significant moves are measured against it.
    await db.insert(gold.priceBars).values([100, 0].map((d) => ({ symbol: "^KQ11", date: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), close: 800, sources: ["yahoo"], alternatives: [] })) as never);
    calls = [];
    await runDimension(db, narrativeSinceDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["since"]);
    calls = [];
    await runDimension(db, narrativeSinceDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual([]);

    const recent = "6f1d1a52-2222-4a3b-9c1d-000000000001";
    const old = "6f1d1a52-2222-4a3b-9c1d-000000000002";
    await db.insert(gold.filings).values([
      { id: recent, symbol: SYMBOL, registry: "dart", filingKey: "n1", form: null, title: "Share buyback trust", filedAt: new Date(), url: null, language: "ko", sources: ["dart"] },
      { id: old, symbol: SYMBOL, registry: "dart", filingKey: "n0", form: null, title: "New debt agreement", filedAt: new Date(Date.now() - 120 * 86_400_000), url: null, language: "ko", sources: ["dart"] },
    ]);
    calls = [];
    await runDimension(db, evidenceDim, { trigger: "test", ctx: ctx() });
    expect(calls).toEqual(["evidence"]);
    expect(lastEvidencePrompt).toContain("Share buyback trust");
    expect(lastEvidencePrompt).not.toContain("New debt agreement");
    const rows = await db.select().from(evidence);
    const tooOld = rows.find((r) => r.id === `${SYMBOL}|filing:${old}`)!;
    expect(tooOld).toMatchObject({ effect: "too-old", strength: "noise", driverId: null, verdicts: [] });
    expect(tooOld.why).toMatch(/^Before \w+ \d{4}, when the market adopted its current story/);
    expect(rows.find((r) => r.id === `${SYMBOL}|filing:${recent}`)).toMatchObject({ effect: "reversal", strength: "strong" });

    // The signal's news are the reversals judged on the turning driver: a Too old item is never one.
    await runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
    await runDimension(db, signalsDim, { trigger: "test", ctx: ctx() });
    const [s] = await db.select().from(signals).where(eq(signals.symbol, SYMBOL));
    expect(s.evidenceIds).toEqual([`${SYMBOL}|filing:${recent}`]);
  });
});

describe("the signal (Kevin 2026-11-24): the narrative's side x the strongest reversal against it", () => {
  const pd = (rank: number, name: string, r: ReturnType<typeof reversal> | null) => ({ id: `X:kpi:${rank}`, name, rank, reversal: r });
  it("a pessimistic story + a Price Driver turning against it = BUY at that reversal's strength; an optimistic one = SELL", () => {
    expect(signalFrom("long", [pd(1, "Net income", reversal("long", { strength: "weak", why: "Profit turns up." }))])).toMatchObject({ signal: "BUY", strength: "weak", side: "long", kpiDriverId: "X:kpi:1", why: "Net income: Profit turns up." });
    expect(signalFrom("short", [pd(1, "Store sales", reversal("short"))])).toMatchObject({ signal: "SELL", strength: "strong", side: "short" });
  });
  it("the strongest one against the narrative is the signal: strong before weak, then by rank", () => {
    const drivers = [pd(1, "A", reversal("long", { strength: "weak" })), pd(2, "B", reversal("long")), pd(3, "C", reversal("long"))];
    expect(driversAgainst("long", drivers).map((k) => k.name)).toEqual(["B", "C", "A"]);
    expect(signalFrom("long", drivers)).toMatchObject({ signal: "BUY", strength: "strong", kpiDriverId: "X:kpi:2" });
  });
  it("nothing against the narrative = no signal: with it, none, not read yet, read against another side, or a v1 reading without a stance", () => {
    const none = { signal: "none", strength: "noise", side: null, kpiDriverId: null };
    expect(signalFrom("long", [pd(1, "A", reversal("long", { stance: "with", strength: "none", turn: null }))])).toMatchObject({ ...none, effect: "continuation" });
    expect(signalFrom("long", [pd(1, "A", reversal("long", { stance: "none", strength: "none", turn: null }))])).toMatchObject({ ...none, effect: "noise" });
    expect(signalFrom("long", [pd(1, "A", null)])).toMatchObject(none);
    // Read against the story's old side (the narrative flipped since): not a turn against today's story.
    expect(signalFrom("short", [pd(1, "A", reversal("long"))])).toMatchObject(none);
    expect(signalFrom("long", [pd(1, "A", { ...reversal("long"), stance: undefined, side: undefined })])).toMatchObject(none);
    expect(signalFrom(null, [pd(1, "A", reversal("long"))])).toMatchObject(none);
    expect(signalFrom("long", [])).toMatchObject({ ...none, why: null });
  });
  it("no rule on the price: the side is the analysis' call, so a BUY above the fair value stands when the judges say so", () => {
    const r = readingOf({ value: 100, currency: "USD", method: "m" }, { close: 105, currency: "USD", date: "2026-11-20" }, "long", [pd(1, "A", reversal("long"))], ["e1"]);
    expect(r).toMatchObject({ signal: "BUY", strength: "strong", side: "long", evidenceIds: ["e1"] });
    expect(r.gapPct).toBeCloseTo(0.05, 6);
    expect(readingOf(null, null, "long", [], ["e1"])).toMatchObject({ signal: "none", evidenceIds: [], theses: [{ side: "long", signal: "noise", effect: "noise" }] });
  });
  it("subject grammar and verdict order", () => {
    expect(parseEvidenceSubject("101160.KQ|news:abc-1#long:2")).toEqual({ symbol: "101160.KQ", kind: "news", id: "abc-1", side: "long", rank: 2 });
    expect(parseBatchSubject(batchSubject("CCLD", "short", [{ kind: "news", id: "a:1" }, { kind: "filing", id: "b" }]))).toEqual({ symbol: "CCLD", side: "short", items: [{ kind: "news", id: "a:1" }, { kind: "filing", id: "b" }] });
    const order = (["continuation:weak", "reversal:weak", "noise:noise", "continuation:strong", "reversal:strong"] as const).map((t) => t.split(":") as [string, string]);
    expect([...order].sort((a, b) => verdictRank({ effect: a[0] as never, strength: a[1] as never }) - verdictRank({ effect: b[0] as never, strength: b[1] as never })).map((x) => x.join(":"))).toEqual(["reversal:strong", "continuation:strong", "reversal:weak", "continuation:weak", "noise:noise"]);
  });
});

describe("Market Reaction (Kevin 2026-11-09)", () => {
  const bars = [
    { date: "2026-10-30", close: 18.42 },
    { date: "2026-11-02", close: 17.98 },
    { date: "2026-11-03", close: 19.03 },
    { date: "2026-11-04", close: 20.51 },
    { date: "2026-11-05", close: 23.36 },
    { date: "2026-11-06", close: 23.85 },
  ];
  const bench = bars.map((b) => ({ date: b.date, close: 100 }));
  const history = [{ day: "2026-11-06", value: 22.43, low: 17.05, high: 31.23 }];
  it("what the price did around a news item vs the S&P 500, and the fair value then (the first one when the news is older) and now", () => {
    const r = reactionOf({ id: "NVRI|news:x", symbol: "NVRI", day: "2026-11-05" }, bars, bench, history, { day: "2026-11-09", value: 23.8, low: 18.34, high: 27.45 }, "USD");
    expect(r).toMatchObject({ beforeDay: "2026-11-04", closeBefore: 20.51, closeNext: 23.36, closeNow: 23.85, benchNext: 0, fvDay: "2026-11-06", fvThen: 22.43, fvNow: 23.8 });
    expect(r.returnNext).toBeCloseTo(0.139, 3);
    expect(reactionLine(r)).toContain("23.85 today (+16.3% since, S&P 500 +0.0%)");
    expect(reactionLine(r)).toContain("fair value then 22.43 (range 17.05 to 31.23) (first computed 2026-11-06)");
    expect(fairValueAt(history, "2026-11-07")?.value).toBe(22.43);
  });
  it("the minute view: the price when the news came out and now, 5-minute bars during a session, the close when shut", () => {
    const at = new Date("2026-11-05T15:12:00Z");
    const minute = {
      eventAt: at,
      atEvent: { price: 21, date: "2026-11-05", at: new Date("2026-11-05T15:10:00Z"), source: "intraday" as const },
      now: { price: 23.1, date: "2026-11-09", at: new Date("2026-11-09T15:05:00Z"), source: "intraday" as const },
      benchAtEvent: { price: 100, date: "2026-11-04", at: new Date("2026-11-04T21:00:00Z"), source: "close" as const },
      benchNow: { price: 101, date: "2026-11-09", at: new Date("2026-11-09T15:05:00Z"), source: "intraday" as const },
    };
    const r = reactionOf({ id: "NVRI|news:x", symbol: "NVRI", day: "2026-11-05" }, bars, bench, history, null, "USD", minute);
    expect(r.returnSinceEvent).toBeCloseTo(0.1);
    expect(r.benchSinceEvent).toBeCloseTo(0.01);
    expect(reactionLine(r)).toMatch(/^When it came out \(2026-11-05 15:12 UTC\) the price was 21\.00 \(2026-11-05 15:10 UTC\), now 23\.10 \(2026-11-09 15:05 UTC\): \+10\.0% since, S&P 500 \+1\.0%\. Daily closes: Price: 20\.51 the close before/);
    const shut = reactionOf({ id: "NVRI|news:x", symbol: "NVRI", day: "2026-11-05" }, bars, bench, history, null, "USD", { ...minute, atEvent: { price: 20.51, date: "2026-11-04", at: new Date("2026-11-04T21:00:00Z"), source: "close" } });
    expect(reactionLine(shut)).toContain("the price was 20.51 (2026-11-04 close, market shut)");
    expect(reactionLine(reactionOf({ id: "NVRI|news:x", symbol: "NVRI", day: "2026-11-05" }, bars, bench, history, null, "USD"))).toMatch(/^Price: /);
  });
  it("the dimension writes the fair value history (last synthesis of each day) and one reaction per news item and filing", async () => {
    const synth = (at: string, base: number) => ({ symbol: SYMBOL, inputHash: at, result: { currency: "KRW", low: base * 0.9, base, high: base * 1.1, weights: [], label: "l", summary: "s", report: "r" }, model: "m", bronzeId: crypto.randomUUID(), createdAt: new Date(at) });
    await db.insert(valuationSyntheses).values([synth("2026-11-06T10:00:00Z", 38000), synth("2026-11-06T20:00:00Z", 39000), synth("2026-11-08T10:00:00Z", 40000)]);
    await db.insert(gold.filings).values({ id: "6f1d1a52-4444-4a3b-9c1d-000000000001", symbol: SYMBOL, registry: "dart", filingKey: "m1", form: null, title: "Q3", filedAt: new Date(), url: null, language: "ko", sources: ["dart"] });
    await runDimension(db, marketReactionDim, { trigger: "test", ctx: ctx() });
    expect((await db.select().from(fairValueHistory)).map((h) => [h.day, h.value]).sort()).toEqual([["2026-11-06", 39000], ["2026-11-08", 40000]]);
    expect(await db.select().from(marketReactions)).toMatchObject([{ id: `${SYMBOL}|filing:6f1d1a52-4444-4a3b-9c1d-000000000001`, fvNow: 40000 }]);
  });
});

describe("speed (Kevin 2026-11-06)", () => {
  it("a batch answer missing an item x driver pair fails loud", () => {
    expect(() => parseBatch(JSON.stringify({ items: [{ n: 1, drivers: { "1": { tag: "noise" } } }] }), 2, [1])).toThrow(/2#1/);
    expect(parseBatch(JSON.stringify({ items: [{ n: 1, drivers: { "1": { tag: "reversal:weak", p: 2, why: "x" } } }] }), 1, [1]).get("1#1")).toEqual({ tag: "reversal:weak", p: 0.5, why: "x", cited: null, pricedIn: null });
  });
  it("every dimension sits in exactly one stage, after the ones it reads", () => {
    expect(STAGES.flat().sort()).toEqual(DIMENSIONS.map((d) => d.name).sort());
    const at = (n: string) => STAGES.findIndex((s) => s.includes(n));
    for (const [before, after] of [["company-profile", "news"], ["price", "financials"], ["filings", "financials"], ["consensus", "peers"], ["peers", "valuation"], ["valuation", "analysis"], ["valuation", "market-reaction"], ["move-causes", "analysis"], ["market-reaction", "evidence"], ["market-reaction", "move-causes"], ["move-causes", "kpi-drivers"], ["kpi-drivers", "analysis"], ["analysis", "kpi-reversal"], ["kpi-reversal", "signals"], ["analysis", "evidence"], ["analysis", "narrative-since"], ["narrative-since", "evidence"], ["evidence", "signals"], ["price", "intraday-price"], ["intraday-price", "financials"], ["intraday-price", "market-reaction"], ["intraday-price", "signals"], ["signals", "signal-alerts"]]) expect(at(before)).toBeLessThan(at(after));
    expect(stagesFor(dimensionsFor("from:valuation")).map((s) => s.map((d) => d.name))).toEqual([["valuation"], ["market-reaction"], ["move-causes"], ["kpi-drivers"], ["analysis"], ["kpi-reversal", "narrative-since"], ["evidence"], ["signals"], ["signal-alerts"], ["emphasis"]]);
    // kpi-drivers runs inside the normal chain (its judgments are stored once per input), and the chain rebuilds one ticker end to end.
    expect(ON_DEMAND_DIMENSIONS).not.toContain("kpi-drivers");
    expect(dimensionsFor("core").map((d) => d.name)).toEqual(expect.arrayContaining(["kpi-drivers", "analysis", "kpi-reversal", "signals"]));
    for (const gone of ["narrative-state", "driver-confidence"]) expect(DIMENSIONS.map((d) => d.name)).not.toContain(gone);
    expect(stagesFor(dimensionsFor("market-reaction,move-causes,kpi-drivers,analysis,kpi-reversal,signals")).map((s) => s.map((d) => d.name))).toEqual([["market-reaction"], ["move-causes"], ["kpi-drivers"], ["analysis"], ["kpi-reversal"], ["signals"]]);
  });
  it("the Sandbox writers never run in the daily collect", () => {
    for (const d of ["sandbox-posts", "sandbox-visuals", "sandbox-image-fix", "sandbox-review"]) expect(dimensionsFor("all").map((x) => x.name)).not.toContain(d);
  });
});

