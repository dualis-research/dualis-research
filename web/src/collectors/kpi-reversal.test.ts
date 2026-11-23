import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driverEvents, fairValues, kpiDrivers, narrativeDrivers, narratives, type GoldDriverEvent, type GoldKpiDriver } from "@/db/schema/analysis";
import { fetches as bronze } from "@/db/schema/bronze";
import { documentPages, documents } from "@/db/schema/documents";
import * as gold from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { priceDriver, seedPriceDrivers } from "@/test/price-drivers";
import { keepPrintedCitations, kpiReversalDim, pagesToRead, parseReversal, REVERSAL_SYSTEM, type ReversalContext } from "./dimensions/kpi-reversal";
import { runDimension } from "./runner";
import type { SourceContext } from "./types";

/**
 * Reversals, the step after the narrative (Kevin 2026-11-24): each trusted Price Driver read against the narrative and
 * its side; five states; durability, magnitude, priced in and citations ported from the old driver judge.
 */

const SYMBOL = "1161.HK";
const DOC = "6f1d1a52-7777-4a3b-9c1d-000000000001";
const PAGE_TEXT = "Results of operations\nRevenue from beauty services rose 9.6% as bookings for the Lunar New Year were full.\nNet profit for the six months fell 47% on a one-off rent provision.";
const today = new Date().toISOString().slice(0, 10);
const event = (id: string, title: string): GoldDriverEvent => ({ id: `${SYMBOL}|news:${id}`, symbol: SYMBOL, kind: "news", sourceId: id, day: today, title, url: `https://example.com/${id}`, stock: null, benchReturn: null, beta: null, reaction: null, z: null, bench: "Hang Seng", moveId: null, rebuiltAt: new Date() });

const ANSWER = {
  intrinsic: { state: "reversing-up", period: "2025-03", why: "Net income rose to 60M after two falling halves." },
  leading: { probability: "high", events: ["L1", "L9"], why: "Lunar New Year bookings are full." },
  durability: "structural",
  magnitude: { figure: "Net income", from: "HK$32M, 6 months to Mar-24", to: "HK$60M, 6 months to Mar-25", change: "+88%", size: "material" },
  pricedIn: "none",
  stance: "against",
  strength: "strong",
  direction: "up",
  headline: "H1 net income up 88%",
  why: "Profit turns up while the market prices a decline.",
  citations: [{ doc: "D1", page: 2, quote: "bookings for the Lunar New Year were full" }, { doc: "D1", page: 2, quote: "Profit tripled on a new flagship" }, { doc: "D9", page: 2, quote: "bookings for the Lunar New Year were full" }],
};
const ctxOf = (over: Partial<ReversalContext> = {}): ReversalContext => ({ level: "strong", side: "long", labels: new Map([["L1", event("n1", "Lunar New Year bookings full")]]), periods: new Set(["2025-03"]), measured: true, ...over });

describe("kpi-reversal@v2: the answer, typed", () => {
  it("reads the five states, durability, magnitude, priced in, the stance against the narrative and the turn's word", () => {
    const { reversal: r, cited } = parseReversal(JSON.stringify(ANSWER), ctxOf());
    expect(r).toMatchObject({ intrinsic: { state: "reversing-up", period: "2025-03" }, durability: "structural", magnitude: { figure: "Net income", change: "+88%", size: "material" }, pricedIn: "none", stance: "against", side: "long", strength: "strong", turn: "inflection", direction: "up", headline: "H1 net income up 88%" });
    // Unknown event labels are dropped; the citations come back as written, checked on their page by the caller.
    expect(r.leading.events.map((e) => e.title)).toEqual(["Lunar New Year bookings full"]);
    expect(r.citations).toEqual([]);
    expect(cited).toHaveLength(3);
    for (const state of ["continuing-to-rise", "continuing-to-fall", "reversing-up", "reversing-down", "flat"]) expect(parseReversal(JSON.stringify({ ...ANSWER, intrinsic: { ...ANSWER.intrinsic, state } }), ctxOf()).reversal.intrinsic.state).toBe(state);
    // The words of v1 are no longer an answer.
    expect(() => parseReversal(JSON.stringify({ ...ANSWER, intrinsic: { ...ANSWER.intrinsic, state: "reversing" } }), ctxOf())).toThrow(/intrinsic state/);
    expect(() => parseReversal(JSON.stringify({ ...ANSWER, stance: "maybe" }), ctxOf())).toThrow(/stance/);
  });

  it("a strong turn needs a strong-confidence driver: clamped to weak for a weak one", () => {
    expect(parseReversal(JSON.stringify(ANSWER), ctxOf({ level: "weak" })).reversal).toMatchObject({ strength: "weak", stance: "against", turn: "inflection" });
  });

  it("the word comes from the judge's stance and the narrative's side, never from the direction", () => {
    // The same rising figure against an optimistic story is a crack when the judge says so.
    expect(parseReversal(JSON.stringify(ANSWER), ctxOf({ side: "short" })).reversal).toMatchObject({ turn: "crack", direction: "up" });
    // With the story, or nowhere: no reversal, whatever strength was written.
    expect(parseReversal(JSON.stringify({ ...ANSWER, stance: "with" }), ctxOf()).reversal).toMatchObject({ stance: "with", strength: "none", turn: null });
    expect(parseReversal(JSON.stringify({ ...ANSWER, stance: "none" }), ctxOf()).reversal).toMatchObject({ strength: "none", turn: null });
  });

  it("a policy or an industry fact has no figure: no magnitude, no period", () => {
    const r = parseReversal(JSON.stringify(ANSWER), ctxOf({ measured: false, periods: new Set() })).reversal;
    expect(r.magnitude).toBeNull();
    expect(r.intrinsic.period).toBeNull();
    expect(parseReversal(JSON.stringify({ ...ANSWER, durability: "forever" }), ctxOf()).reversal.durability).toBe("n-a");
  });

  it("the game is in the prompt: strong = structural AND material, the judge decides the stance, beliefs move with facts", () => {
    expect(REVERSAL_SYSTEM).toContain("strong needs a structural AND material change");
    expect(REVERSAL_SYSTEM).toContain("a temporary or small change is weak at most");
    expect(REVERSAL_SYSTEM).toContain("never a mechanical rule from the direction");
    expect(REVERSAL_SYSTEM).toContain("over weeks and months");
    for (const s of ["continuing-to-rise", "continuing-to-fall", "reversing-up", "reversing-down", "flat"]) expect(REVERSAL_SYSTEM).toContain(s);
  });
});

describe("kpi-reversal dimension", () => {
  let db: Db;
  let close: () => Promise<void>;
  let prompts: string[] = [];
  let answer: Record<string, unknown> = ANSWER;
  const fake: Complete = async ({ prompt }) => {
    prompts.push(prompt);
    return { text: JSON.stringify(answer), model: "fake" };
  };
  const ctx = (): SourceContext => ({ env: { CLAUDE_OAUTH_TOKEN: "t" }, fetch, complete: fake });
  const run = () => runDimension(db, kpiReversalDim, { trigger: "test", ctx: ctx() });
  const pds = () => db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, SYMBOL)).orderBy(kpiDrivers.rank);

  beforeEach(async () => {
    prompts = [];
    answer = ANSWER;
    ({ db, close } = await testDb());
    await db.insert(silver.tickers).values({ symbol: SYMBOL, market: "HK", sources: ["repo"], bronzeIds: [] });
    await db.insert(gold.quotes).values({ symbol: SYMBOL, date: today, close: 1.0, currency: "HKD", sources: ["yahoo"] });
    await db.insert(fairValues).values({ symbol: SYMBOL, value: 1.5, currency: "HKD", low: 1.3, high: 1.8, method: "x", label: "x", author: "claude", claudeValue: 1.5, inputs: [] });
    await db.insert(driverEvents).values(event("n1", "Lunar New Year bookings full"));
    await db.insert(documents).values({ id: DOC, symbol: SYMBOL, registry: "hkex", kind: "results-release", form: null, title: "Interim results 2025", filedAt: new Date(), language: "en", viewUrl: "https://example.com/r.pdf", format: "pdf", pageCount: 3, sources: ["hkex"] });
    await db.insert(documentPages).values([{ documentId: DOC, page: 1, text: "Contents\n1\n2\n3" }, { documentId: DOC, page: 2, text: PAGE_TEXT }]);
    const measure: GoldKpiDriver["measure"] = { source: "series", label: "Net income, half years", periodType: "half", unit: "currency", currency: "HKD", providers: ["hkex"] };
    await seedPriceDrivers(db, [
      priceDriver(SYMBOL, 1, "Net income", { measure, periods: [{ period: "2024-03", periodType: "half", value: 32e6, prior: 60e6, change: -0.47, changeKind: "relative", significant: true, why: "profit fell 47%", releaseId: null, releaseDay: "2024-05-28", cite: null }, { period: "2025-03", periodType: "half", value: 60e6, prior: 32e6, change: 0.875, changeKind: "relative", significant: true, why: "profit nearly doubled", releaseId: null, releaseDay: "2025-05-28", cite: null }] }),
      priceDriver(SYMBOL, 2, "Commercial rent levels", { kind: "industry", level: "weak", expected: "down" }),
      priceDriver(SYMBOL, 3, "Store count", { level: "none" }),
    ]);
  });
  afterEach(async () => close());

  const writeNarrative = async (side: "long" | "short" = "long") => {
    await db.insert(narratives).values({ id: `${SYMBOL}:${side}`, symbol: SYMBOL, side, sideWhy: "The price sits a third under the fair value.", text: "The market prices Water Oasis as a flat, mature chain.", detail: null, version: "v1", asOf: new Date() });
    await db.insert(narrativeDrivers).values({ id: `${SYMBOL}:${side}:1`, symbol: SYMBOL, side, rank: 1, category: "Business economics", title: "Profit is seen as stuck after the rent shock", summary: "The market assumes profit stays low.", text: "Net income halved in 2024.", kpiDriverId: `${SYMBOL}:kpi:net-income`, version: "v1" });
  };

  it("without a narrative: a failed fetch saying so, no call", async () => {
    await run();
    const [row] = await db.select().from(bronze).where(eq(bronze.dimension, "kpi-reversal"));
    expect(row.error).toMatch(/^no narrative yet/);
    expect(prompts).toEqual([]);
  });

  it("reads each trusted Price Driver against the narrative, its values, the recent events, the documents and the price; stores the reversal and its bottom line", async () => {
    await writeNarrative();
    await run();
    // One call per trusted driver (strong and weak), none for the untrusted one.
    expect(prompts).toHaveLength(2);
    const p = prompts[0];
    expect(p).toContain("The narrative (side long: the PESSIMISTIC story");
    expect(p).toContain("The market prices Water Oasis as a flat, mature chain.");
    expect(p).toContain("What the market believes about this Price Driver (Business economics): Profit is seen as stuck after the rent shock.");
    expect(p).toContain("Price Driver (kpi, strong confidence): Net income.");
    expect(p).toContain("6 months to Mar-25 [2025-03]: 60.0M HKD (+87.5% on a year earlier), judged a change that matters: profit nearly doubled");
    expect(p).toContain(`L1 ${today} News: Lunar New Year bookings full`);
    expect(p).toContain("[D1 page 2] Interim results 2025");
    expect(p).toContain("price 1.00 HKD, fair value 1.50 (range 1.30 to 1.80)");
    expect(p).toContain("Month-end closes");
    // The narrative does not speak of the rent driver yet: said so, never invented.
    expect(prompts[1]).toContain("The narrative does not speak of this Price Driver yet.");
    expect(prompts[1]).toContain("No figure: a policy or an industry fact");
    const [income, rent, stores] = await pds();
    // A quote not printed on its page, and one from a document the judge was not shown, are dropped.
    expect(income.reversal).toMatchObject({ stance: "against", strength: "strong", turn: "inflection", side: "long", durability: "structural", pricedIn: "none", intrinsic: { state: "reversing-up", period: "2025-03" }, citations: [{ documentId: DOC, page: 2, quote: "bookings for the Lunar New Year were full", title: "Interim results 2025" }] });
    expect(income.reversal!.judgedAt).toBeTruthy();
    expect(income).toMatchObject({ signal: "strong", signalWhy: "Profit turns up while the market prices a decline.", direction: "up" });
    // The weak-confidence driver's strong turn is weak at most; it has no figure, so no magnitude.
    expect(rent.reversal).toMatchObject({ strength: "weak", magnitude: null });
    expect(rent.signal).toBe("weak");
    expect(stores.reversal).toBeNull();
  });

  it("is stable on fundamentals: a price tick asks nothing, a real move asks again with the judge's own last reading; a new narrative asks again", async () => {
    await writeNarrative();
    await run();
    expect(prompts[0]).not.toContain("Your last reading");
    // +1%: the same 5% bucket.
    prompts = [];
    await db.update(gold.quotes).set({ close: 1.01 });
    await run();
    expect(prompts).toEqual([]);
    expect((await pds())[0].reversal).toMatchObject({ stance: "against", strength: "strong" });
    // +12%: asked again, the last reading handed back outside the key.
    await db.update(gold.quotes).set({ close: 1.12 });
    answer = { ...ANSWER, pricedIn: "partly" };
    await run();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(`Your last reading, on ${today}: reversing up, against the story, strength strong, structural. Profit turns up while the market prices a decline.`);
    expect((await pds())[0].reversal).toMatchObject({ pricedIn: "partly" });
    // The narrative rewritten (another version): every driver is read against the new words.
    prompts = [];
    await db.update(narratives).set({ version: "v2" });
    await run();
    expect(prompts).toHaveLength(2);
    expect((await db.select().from(silver.judgments).where(eq(silver.judgments.subjectKind, "kpi-reversal"))).length).toBe(6);
  });
});

describe("citations (ported from the old driver judge)", () => {
  it("drops a citation whose quote is not printed on its page, or whose document the judge was not shown", async () => {
    const { db, close } = await testDb();
    await db.insert(documents).values({ id: DOC, symbol: SYMBOL, registry: "hkex", kind: "results-release", form: null, title: "Interim results 2025", filedAt: new Date(), language: "en", viewUrl: null, format: "pdf", pageCount: 3, sources: ["hkex"] });
    await db.insert(documentPages).values([{ documentId: DOC, page: 1, text: "Contents\n1\n2\n3" }, { documentId: DOC, page: 2, text: PAGE_TEXT }]);
    const pages = await pagesToRead(db, SYMBOL);
    // The table of contents is no results page; page 2 is.
    expect(pages.map((p) => [p.label, p.page.page])).toEqual([["D1", 2]]);
    const kept = await keepPrintedCitations(db, [{ doc: "D1", page: 2, quote: "bookings for the Lunar New Year were full" }, { doc: "D1", page: 2, quote: "Profit tripled on a new flagship" }, { doc: "D9", page: 2, quote: "bookings for the Lunar New Year were full" }], pages);
    expect(kept).toEqual([{ documentId: DOC, page: 2, quote: "bookings for the Lunar New Year were full", title: "Interim results 2025", filedAt: expect.any(String) }]);
    await close();
  });
});
