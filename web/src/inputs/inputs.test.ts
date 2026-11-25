import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => h.db }));

import { gatherFacts } from "@/collectors/dimensions/analysis/facts";
import { judgePrompt } from "@/collectors/dimensions/daily-email";
import { watchlist } from "@/collectors/dimensions/watchlist";
import { runDimension } from "@/collectors/runner";
import { callConsoleTool } from "@/connector/console-tools";
import { handleRpc, INSTRUCTIONS } from "@/connector/mcp";
import { callResearchTool } from "@/connector/research-tools";
import { getInput, inputCounts, listInputs } from "@/console/queries";
import { driverEvents, fairValues, kpiDrivers, narratives, signals } from "@/db/schema/analysis";
import { fetches } from "@/db/schema/bronze";
import { goldDailyDigests } from "@/db/schema/daily-email";
import { companyProfiles, quotes } from "@/db/schema/gold";
import { runs } from "@/db/schema/ops";
import { portfolioPositions } from "@/db/schema/portfolio";
import { goldThierryInputs, thierryInputs } from "@/db/schema/thierry-inputs";
import type { Db } from "@/db/types";
import { testDb } from "@/test/db";
import { viewsOf } from "./notes";
import { INPUTS_DIMENSION, INPUTS_SOURCE } from "./record";

const REPO_ROOT = resolve(__dirname, "../../..");
// Fake everything: the repo is public. CCLD is in the fixture's analysis scope, 1161.HK in its portfolio.
const SYM = "CCLD";
let db: Db;
let close: () => Promise<void>;
const deps = () => ({ userId: "user_1", write: <T,>(fn: (d: Db) => Promise<T>) => fn(db) });
const push = (events: unknown) => callConsoleTool("record_inputs", { events }, deps());

beforeAll(async () => {
  ({ db, close } = await testDb());
  h.db = db;
  await runDimension(db, watchlist, { trigger: "test", ctx: { env: { REPO_ROOT }, fetch: (() => { throw new Error("no network"); }) as unknown as typeof fetch } });
  await db.insert(companyProfiles).values({ symbol: SYM, name: "Fakeco Health", currency: "USD", provenance: {} }).onConflictDoUpdate({ target: companyProfiles.symbol, set: { name: "Fakeco Health", currency: "USD" } });
});
afterAll(() => close());

describe("record_inputs", () => {
  it("refuses a wrong push with the reason, and keeps it in bronze", async () => {
    await expect(push([])).rejects.toThrow(/1 to 50 events/);
    await expect(push(Array.from({ length: 51 }, () => ({ kind: "info", scope: "general", text: "x" })))).rejects.toThrow(/At most 50/);
    await expect(push([{ kind: "rumour", scope: "general", text: "x" }])).rejects.toThrow(/events\[0\]\.kind must be one of/);
    await expect(push([{ kind: "view", scope: "sector", text: "x" }])).rejects.toThrow(/scope must be one of/);
    await expect(push([{ kind: "view", scope: "ticker", text: "x" }])).rejects.toThrow(/symbol is required/);
    await expect(push([{ kind: "view", scope: "watchlist", symbol: "CCLD", text: "x" }])).rejects.toThrow(/goes with scope ticker/);
    await expect(push([{ kind: "view", scope: "general", text: "   " }])).rejects.toThrow(/text is required/);
    await expect(push([{ kind: "file", scope: "general", text: "figures" }])).rejects.toThrow(/fileName is required/);
    await expect(push([{ kind: "info", scope: "general", text: "x", saidAt: "yesterday" }])).rejects.toThrow(/ISO date-time/);
    await expect(push([{ kind: "info", scope: "general", text: "x", answer: "y" }])).rejects.toThrow(/unknown field answer/);
    expect(await db.select().from(thierryInputs)).toHaveLength(0);
    const bronze = await db.select().from(fetches).where(eq(fetches.dimension, INPUTS_DIMENSION));
    expect(bronze).toHaveLength(10);
    expect(bronze.every((b) => b.source === INPUTS_SOURCE && b.error && b.request.userId === "user_1")).toBe(true);
    expect((await db.select().from(runs).where(eq(runs.dimension, INPUTS_DIMENSION))).every((r) => r.status === "failed")).toBe(true);
  });

  const events = [
    { kind: "question", scope: "ticker", symbol: " ccld ", text: "Why did the margin fall in the first half?", saidAt: "2026-11-20T09:30:20Z" },
    { kind: "view", scope: "ticker", symbol: "CCLD", text: "I think the market misses the recurring revenue.", saidAt: "2026-11-21T10:00:00Z" },
    { kind: "file", scope: "ticker", symbol: "ZZZZ", fileName: "model.xlsx", text: "Revenue 2026: 120\nEBITDA 2026: 30", saidAt: "2026-11-19T08:00:00Z" },
    { kind: "info", scope: "watchlist", text: "I only want small caps under 500M on the list.", saidAt: "2026-11-18T08:00:00Z" },
  ];

  it("saves each event in his words, says which tickers are on his watchlist, and rebuilds gold with the company name", async () => {
    const r = await push(events);
    expect(r!.text).toBe("Saved 4 inputs (CCLD x2, ZZZZ x1, watchlist x1). On his watchlist: CCLD. Not on his watchlist: ZZZZ.");
    const silver = await db.select().from(thierryInputs);
    expect(silver).toHaveLength(4);
    expect(silver.every((s) => s.userId === "user_1" && s.bronzeIds.length === 1)).toBe(true);
    const gold = await listInputs();
    expect(gold.map((g) => [g.kind, g.symbol, g.company, g.onWatchlist])).toEqual([
      ["view", "CCLD", "Fakeco Health", true],
      ["question", "CCLD", "Fakeco Health", true],
      ["file", "ZZZZ", null, false],
      ["info", null, null, false],
    ]);
    expect(gold[2].text).toBe("Revenue 2026: 120\nEBITDA 2026: 30");
    expect(gold[2].fileName).toBe("model.xlsx");
    const [ok] = (await db.select().from(fetches).where(eq(fetches.dimension, INPUTS_DIMENSION))).filter((b) => !b.error);
    expect((ok.request.events as unknown[]).length).toBe(4);
  });

  it("is idempotent: the same event pushed again (same minute) stays one row carrying both pushes", async () => {
    const again = [{ ...events[0], symbol: "CCLD", saidAt: "2026-11-20T09:30:55Z" }, events[1], events[1]];
    expect((await push(again))!.text).toMatch(/^Saved 2 inputs \(CCLD x2\)/);
    const silver = await db.select().from(thierryInputs);
    expect(silver).toHaveLength(4);
    expect(silver.filter((s) => s.symbol === "CCLD").every((s) => s.bronzeIds.length === 2)).toBe(true);
    expect(await db.select().from(goldThierryInputs)).toHaveLength(4);
    // A minute later is another event.
    await push([{ ...events[0], symbol: "CCLD", saidAt: "2026-11-20T09:31:00Z" }]);
    expect(await db.select().from(goldThierryInputs)).toHaveLength(5);
  });

  it("takes two pushes at once (a backfill sent in parallel)", async () => {
    const one = (text: string) => push([{ kind: "info", scope: "general", text, saidAt: "2026-11-01T08:00:00Z" }]);
    await Promise.all([one("First parallel note."), one("Second parallel note.")]);
    const gold = await db.select().from(goldThierryInputs);
    expect(gold.filter((g) => g.text.endsWith("parallel note."))).toHaveLength(2);
    await db.delete(thierryInputs).where(eq(thierryInputs.scope, "general"));
    await push([events[1]]);
    expect(await db.select().from(goldThierryInputs)).toHaveLength(5);
  });

  it("defaults saidAt to now", async () => {
    const before = Date.now();
    await push([{ kind: "info", scope: "portfolio", text: "I trimmed the position last week." }]);
    const [row] = await listInputs({ kind: "info", limit: 1 });
    expect(row.scope).toBe("portfolio");
    expect(row.saidAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("the Inputs page reads", () => {
  it("lists newest first, filters by kind and ticker, counts per kind and opens one input", async () => {
    expect((await listInputs({ kind: "question" })).map((r) => r.text)).toEqual(["Why did the margin fall in the first half?", "Why did the margin fall in the first half?"]);
    expect(await listInputs({ symbol: "ZZZZ" })).toHaveLength(1);
    expect(await inputCounts()).toEqual({ question: 2, view: 1, file: 1, info: 2 });
    const [first] = await listInputs({ limit: 1 });
    expect((await getInput(first.id))!.text).toBe(first.text);
    expect(await getInput("nope")).toBeNull();
  });
});

describe("read tools", () => {
  beforeAll(async () => {
    const now = new Date("2026-11-22T00:00:00Z");
    await db.insert(quotes).values({ symbol: SYM, date: "2026-11-21", close: 3.2, currency: "USD", sources: ["fake"] });
    await db.insert(fairValues).values({ symbol: SYM, value: 4.5, low: 3.8, high: 5.4, currency: "USD", label: "weighted from 3 methods", author: "claude", inputs: [] });
    await db.insert(narratives).values({ id: `${SYM}:long`, symbol: SYM, side: "long", sideWhy: "The price sits under every method.", text: "The market believes growth is over.", detail: "Revenue fell two years in a row.", version: "v", asOf: now });
    await db.insert(kpiDrivers).values([
      { id: `${SYM}:kpi:net-income`, symbol: SYM, rank: 1, name: "Net income", why: "It pays the debt.", expected: "up", level: "strong", reason: "The price followed 4 of 5 changes.", asOf: now,
        marketBelief: "The market thinks profit will keep falling.", reversal: { intrinsic: { state: "reversing-up", why: "H1 up 40%", period: "2026-06" }, leading: { probability: "medium", why: "A new contract.", events: [{ id: `${SYM}|news:e1`, day: "2026-11-20", kind: "news", title: "Fakeco wins a hospital contract", sourceId: "e1", url: "https://news.test/e1" }] }, strength: "weak", direction: "up", why: "Net income turned up for the first time in two years.", side: "long", stance: "against", turn: "inflection" } },
      { id: `${SYM}:kpi:noise`, symbol: SYM, rank: 2, name: "Headcount", why: "x", expected: "up", level: "none", asOf: now },
    ]);
    await db.insert(signals).values({ symbol: SYM, signal: "BUY", strength: "weak", side: "long", why: "Net income: turned up.", theses: [], fairValue: 4.5, currency: "USD", quote: 3.2, quoteDate: "2026-11-21", gapPct: -0.29, evidenceIds: [], since: new Date("2026-11-20T00:00:00Z") });
    await db.insert(driverEvents).values({ id: `${SYM}|news:e1`, symbol: SYM, kind: "news", sourceId: "e1", day: "2026-11-20", title: "Fakeco wins a hospital contract", url: "https://news.test/e1", bench: "S&P 500" });
    await db.insert(portfolioPositions).values({ symbol: "1161.HK", direction: "long", status: "open", reportedReturn: -0.05, reportedReturnAsOf: "2026-11-04", provenance: {} });
    await db.insert(goldDailyDigests).values([
      { day: "2026-11-21", items: [{ symbol: SYM, company: "Fakeco Health", kind: "filing", title: "8-K", url: "https://sec.test/8k", publisher: "sec", at: "2026-11-20T21:00:00.000Z", summary: "**Fakeco** raises **guidance**.", why: "Earnings move up.", importance: 8 }], sendStatus: "sent" },
      { day: "2026-11-22", items: [] },
    ]);
  });

  it("get_ticker gives the signal, narrative, fair value, quote, trusted Price Drivers with their belief, reversal and the events it read", async () => {
    const text = (await callResearchTool("get_ticker", { symbol: "ccld" }))!.text;
    expect(text).toContain("Fakeco Health (CCLD): on the watchlist.");
    expect(text).toContain("Signal: BUY, weak inflection, since 2026-11-20. Net income: turned up.");
    expect(text).toContain("Last quote: 3.20 USD (2026-11-21).");
    expect(text).toContain("Fair value: 4.50 USD (low 3.80, high 5.40), weighted from 3 methods.");
    expect(text).toContain("a pessimistic story, an inflection would be a BUY): The market believes growth is over.");
    expect(text).toContain("Detail: Revenue fell two years in a row.");
    expect(text).toContain("1. Net income: strong confidence, The price followed 4 of 5 changes. What the market believes: The market thinks profit will keep falling. Reversal: Weak inflection (Reversing up). Net income turned up for the first time in two years.");
    expect(text).not.toContain("Headcount");
    expect(text).toContain("   - 2026-11-20 news: Fakeco wins a hospital contract https://news.test/e1");
  });

  it("get_ticker says so for a ticker off the watchlist or not analysed", async () => {
    expect((await callResearchTool("get_ticker", { symbol: "ZZZZ" }))!.text).toMatch(/not on Thierry's watchlist/);
    expect((await callResearchTool("get_ticker", { symbol: "1161.HK" }))!.text).toMatch(/Not analysed yet/);
    await expect(callResearchTool("get_ticker", {})).rejects.toThrow(/symbol is required/);
  });

  it("get_watchlist lists every active ticker, analysed or not", async () => {
    const text = (await callResearchTool("get_watchlist", {}))!.text;
    expect(text).toContain("CCLD | Fakeco Health | analysed | BUY, weak inflection | 3.20 USD (2026-11-21)");
    expect(text).toMatch(/1161\.HK \| .*\(portfolio\) \| not analysed \| not analysed \| none/);
  });

  it("get_portfolio gives each position as published", async () => {
    const text = (await callResearchTool("get_portfolio", {}))!.text;
    expect(text).toMatch(/- 1161\.HK .*: long, open, entry price never published, last quote none, published return -5\.0% as of 2026-11-04/);
  });

  it("get_daily_email gives the latest digest or one day's", async () => {
    expect((await callResearchTool("get_daily_email", {}))!.text).toBe("2026-11-22: nothing material happened on the watchlist, no email was sent.");
    const text = (await callResearchTool("get_daily_email", { day: "2026-11-21" }))!.text;
    expect(text).toContain("Morning email of 2026-11-21 (sent)");
    expect(text).toContain("Fakeco Health (CCLD)\n- filing 2026-11-20: **Fakeco** raises **guidance**. Why it matters: Earnings move up. https://sec.test/8k");
    expect((await callResearchTool("get_daily_email", { day: "2026-01-01" }))!.text).toMatch(/No morning email was built for 2026-01-01/);
    await expect(callResearchTool("get_daily_email", { day: "today" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("list_inputs gives his own pushed events, newest first, filtered", async () => {
    const text = (await callResearchTool("list_inputs", { symbol: "CCLD", kind: "view" }))!.text;
    expect(text).toBe("1 input, newest first (said at | kind | about | his words):\n- 2026-11-21 10:00 UTC | view | CCLD Fakeco Health | I think the market misses the recurring revenue.");
    expect((await callResearchTool("list_inputs", { kind: "file" }))!.text).toContain("file « model.xlsx » | ZZZZ | Revenue 2026: 120");
    expect((await callResearchTool("list_inputs", { symbol: "NONE" }))!.text).toBe("No input pushed yet on NONE.");
    await expect(callResearchTool("list_inputs", { limit: 500 })).rejects.toThrow(/1 to 100/);
  });

  it("goes through the MCP server, the user's id recorded", async () => {
    const r = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_inputs", arguments: { limit: 1 } } }, { author: "Kevin", userId: "user_1" })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].text).toMatch(/^1 input, newest first/);
    expect(INSTRUCTIONS).toMatch(/ALWAYS and on your own[\s\S]*record_inputs/);
  });
});

describe("the judges read his notes", () => {
  it("the analysis prompt carries his notes, and its hash does not move when he adds one", async () => {
    const before = await gatherFacts(db, SYM);
    expect(before.text).toContain("Thierry's own notes on this company");
    expect(before.text).toContain("- 2026-11-21 view: I think the market misses the recurring revenue.");
    expect(before.text).toContain("- 2026-11-18 info (watchlist): I only want small caps under 500M on the list.");
    expect(before.text).not.toContain("model.xlsx"); // another ticker's file
    await push([{ kind: "analysis", scope: "ticker", symbol: SYM, text: "At 8x EBITDA the downside is covered by the contracts.", saidAt: "2026-11-23T08:00:00Z" }]);
    const after = await gatherFacts(db, SYM);
    expect(after.text).toContain("- 2026-11-23 analysis: At 8x EBITDA the downside is covered by the contracts.");
    expect(after.hash).toBe(before.hash);
  });

  it("the morning email's judge sees his newest views and analyses on the ticker, never his questions", async () => {
    const views = (await viewsOf(db, [SYM, "ZZZZ"])).get(SYM)!;
    expect(views).toEqual(["2026-11-23 analysis: At 8x EBITDA the downside is covered by the contracts.", "2026-11-21 view: I think the market misses the recurring revenue."]);
    const prompt = judgePrompt({ symbol: SYM, company: "Fakeco Health", about: null, items: [], told: [], views });
    expect(prompt).toContain("The analyst's own views on this company (his words, newest first):\n- 2026-11-23 analysis: At 8x EBITDA");
    expect(judgePrompt({ symbol: SYM, company: "Fakeco Health", about: null, items: [], told: [] })).not.toContain("own views");
  });
});
