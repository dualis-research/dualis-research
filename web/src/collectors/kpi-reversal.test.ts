import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driverEvents, fairValues, kpiDrivers, narratives, type GoldDriverEvent, type GoldKpiDriver } from "@/db/schema/analysis";
import { fetches as bronze } from "@/db/schema/bronze";
import { documentPages, documents } from "@/db/schema/documents";
import * as gold from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { priceDriver, seedNote, seedPriceDrivers } from "@/test/price-drivers";
import { keepPrintedCitations, kpiReversalDim, pagesToRead, parseReversal, REVERSAL_SYSTEM, type ReversalContext } from "./dimensions/kpi-reversal";
import { runDimension } from "./runner";
import type { SourceContext } from "./types";

/**
 * Step D of docs/architecture.md: only when the narrative's confidence is weak or strong, each Price Driver read
 * against it: continuation (weak | strong), reversal (weak | strong) or noise; five states of its own value; a leading
 * indicator; durability, magnitude, priced in, citations checked on their page.
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
const ctxOf = (over: Partial<ReversalContext> = {}): ReversalContext => ({ side: "long", labels: new Map([["L1", event("n1", "Lunar New Year bookings full")]]), periods: new Set(["2025-03"]), measured: true, ...over });

describe("kpi-reversal@v4: the answer, typed", () => {
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

  it("continuation (weak | strong), reversal (weak | strong) or noise: the strength is the judge's on both sides, never clamped by code", () => {
    // The same rising figure against an optimistic story is a crack when the judge says so.
    expect(parseReversal(JSON.stringify(ANSWER), ctxOf({ side: "short" })).reversal).toMatchObject({ stance: "against", strength: "strong", turn: "crack", direction: "up" });
    // In continuation of the story: its own strength, and no turn word.
    expect(parseReversal(JSON.stringify({ ...ANSWER, stance: "with" }), ctxOf()).reversal).toMatchObject({ stance: "with", strength: "strong", turn: null });
    expect(parseReversal(JSON.stringify({ ...ANSWER, stance: "with", strength: "weak" }), ctxOf()).reversal).toMatchObject({ stance: "with", strength: "weak", turn: null });
    // Noise carries no strength, whatever was written; the architecture's word « noise » is read as none.
    expect(parseReversal(JSON.stringify({ ...ANSWER, stance: "none" }), ctxOf()).reversal).toMatchObject({ stance: "none", strength: "none", turn: null });
    expect(parseReversal(JSON.stringify({ ...ANSWER, stance: "against", strength: "noise" }), ctxOf()).reversal).toMatchObject({ strength: "none", turn: null });
    expect(() => parseReversal(JSON.stringify({ ...ANSWER, strength: "huge" }), ctxOf())).toThrow(/strong, weak or noise/);
  });

  it("a policy or an industry fact has no figure: no magnitude, no period", () => {
    const r = parseReversal(JSON.stringify(ANSWER), ctxOf({ measured: false, periods: new Set() })).reversal;
    expect(r.magnitude).toBeNull();
    expect(r.intrinsic.period).toBeNull();
    expect(parseReversal(JSON.stringify({ ...ANSWER, durability: "forever" }), ctxOf()).reversal.durability).toBe("n-a");
  });

  it("the game is in the prompt: strong = structural AND material, the judge decides the stance, beliefs move with facts", () => {
    expect(REVERSAL_SYSTEM).toContain("strong needs a structural AND material change");
    expect(REVERSAL_SYSTEM).toContain("in REVERSAL against that belief");
    expect(REVERSAL_SYSTEM).toContain("in CONTINUATION of it");
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

  const writeNarrative = async (side: "long" | "short" = "long", confidence: "strong" | "weak" | "noise" | null = "strong") => {
    await db.insert(narratives).values({ id: `${SYMBOL}:${side}`, symbol: SYMBOL, side, confidence, sideWhy: "The price sits a third under the fair value.", text: "The market prices Water Oasis as a flat, mature chain.", detail: null, version: "v1", asOf: new Date() });
    // The narrative's one belief about the Net income Price Driver, stored on it (analysis).
    await db.update(kpiDrivers).set({ marketBelief: "The market assumes profit stays stuck after the rent shock." }).where(eq(kpiDrivers.id, `${SYMBOL}:kpi:net-income`));
  };

  it("runs ONLY when step C holds the narrative with weak or strong confidence: no narrative, a noise one or one not read yet = no subject, no call", async () => {
    await run();
    expect(await db.select().from(bronze).where(eq(bronze.dimension, "kpi-reversal"))).toEqual([]);
    await writeNarrative("long", "noise");
    await run();
    await db.update(narratives).set({ confidence: null });
    await run();
    expect(await db.select().from(bronze).where(eq(bronze.dimension, "kpi-reversal"))).toEqual([]);
    expect(prompts).toEqual([]);
    expect((await pds()).map((k) => k.reversal)).toEqual([null, null, null]);
    // Weak is enough.
    await db.update(narratives).set({ confidence: "weak" });
    await run();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("held with weak confidence");
  });

  it("reads each Price Driver against the narrative, its values, the recent events (a leading indicator), the documents, the price and Thierry's inputs; stores the reading and its bottom line", async () => {
    await writeNarrative();
    await seedNote(db, SYMBOL, "Bookings looked full when I visited the Central store.");
    await run();
    // One call per trusted driver (strong and weak), none for the untrusted one.
    expect(prompts).toHaveLength(2);
    const p = prompts[0];
    expect(p).toContain("The narrative (side long: the PESSIMISTIC story");
    expect(p).toContain("The market prices Water Oasis as a flat, mature chain.");
    expect(p).toContain("What the market believes about this Price Driver: The market assumes profit stays stuck after the rent shock.");
    expect(p).toContain("Price Driver (kpi, strong confidence): Net income.");
    expect(p).toContain("6 months to Mar-25 [2025-03]: 60.0M HKD (+87.5% on a year earlier), judged a change that matters: profit nearly doubled");
    expect(p).toContain(`L1 ${today} News: Lunar New Year bookings full`);
    expect(p).toContain("[D1 page 2] Interim results 2025");
    expect(p).toContain("price 1.00 HKD, fair value 1.50 (range 1.30 to 1.80)");
    expect(p).toContain("Month-end closes");
    expect(p).toContain("Bookings looked full when I visited the Central store.");
    // The narrative does not rest on the rent driver: said so, never invented.
    expect(prompts[1]).toContain("The narrative does not rest on this Price Driver.");
    expect(prompts[1]).toContain("No figure: a policy or an industry fact");
    const [income, rent, stores] = await pds();
    // A quote not printed on its page, and one from a document the judge was not shown, are dropped.
    expect(income.reversal).toMatchObject({ stance: "against", strength: "strong", turn: "inflection", side: "long", durability: "structural", pricedIn: "none", intrinsic: { state: "reversing-up", period: "2025-03" }, citations: [{ documentId: DOC, page: 2, quote: "bookings for the Lunar New Year were full", title: "Interim results 2025" }] });
    expect(income.reversal!.judgedAt).toBeTruthy();
    expect(income).toMatchObject({ signal: "strong", signalWhy: "Profit turns up while the market prices a decline.", direction: "up" });
    // The strength is the judge's (no clamp for a weak-confidence driver); it has no figure, so no magnitude.
    expect(rent.reversal).toMatchObject({ strength: "strong", magnitude: null });
    expect(rent.signal).toBe("strong");
    // The leading indicator the reading cites (an unknown label dropped).
    expect(income.reversal!.leading).toMatchObject({ probability: "high", events: [{ id: `${SYMBOL}|news:n1` }] });
    expect(stores.reversal).toBeNull();
  });

  it("is stable on fundamentals: a price tick asks nothing, a real move asks again with the judge's own last reading; a new narrative asks again", async () => {
    await writeNarrative();
    await run();
    expect(prompts[0]).not.toContain("Your last reading");
    // +1%: the same 5% bucket; a new input of Thierry's is in no key either.
    prompts = [];
    await db.update(gold.quotes).set({ close: 1.01 });
    await seedNote(db, SYMBOL, "A later thought.");
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
    // A continuation keeps its strength on the reading; the driver's reversal column (`signal`) is none.
    answer = { ...ANSWER, stance: "with", strength: "weak" };
    await db.update(gold.quotes).set({ close: 1.3 });
    await run();
    expect((await pds())[0]).toMatchObject({ signal: "none", reversal: { stance: "with", strength: "weak", turn: null } });
    await db.update(gold.quotes).set({ close: 1.12 });
    answer = { ...ANSWER, pricedIn: "partly" };
    await run();
    // The narrative rewritten (another version): every driver is read against the new words.
    prompts = [];
    await db.update(narratives).set({ version: "v2" });
    await run();
    expect(prompts).toHaveLength(2);
    expect((await db.select().from(silver.judgments).where(eq(silver.judgments.subjectKind, "kpi-reversal"))).length).toBe(8);
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
