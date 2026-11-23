import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dailyEmailSends, dailyItemVerdicts, goldDailyDigests } from "@/db/schema/daily-email";
import { companyProfiles, filings as goldFilings } from "@/db/schema/gold";
import { goldNewsItems, goldNewsLinks } from "@/db/schema/news";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { runDimension } from "../../runner";
import type { SourceContext } from "../../types";
import { watchlist } from "../watchlist";
import { dailyEmailDim, MAILER_URL, orderDigest, parseVerdicts } from ".";
import { renderEmail } from "./render";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const RECIPIENTS = JSON.stringify([
  { email: "kevin@example.test", role: "test" },
  { email: "thierry@example.test", role: "client" },
]);
const MARK = "https://assets.test";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

type Sent = { to: string[]; subject: string; text: string; html: string };
let sent: Sent[];
let claudeCalls: number;
let prompts: string[];

/** Fake Claude: an item is material when its title says « results » or « price war »; everything else is noise. */
const complete: Complete = async ({ prompt }) => {
  claudeCalls += 1;
  prompts.push(prompt);
  const items = prompt
    .split("\n")
    .filter((l) => /^i\d+ \|/.test(l))
    .map((l) => {
      const id = l.split(" |")[0];
      const material = /results|price war/i.test(l);
      const importance = material ? (/price war/i.test(l) ? 9 : 5) : null;
      return { id, material, summary: material ? `Summary of ${l.split(" | ").at(-1)}` : null, why: material ? "It moves revenue — a lot." : "Macro.", importance };
    });
  return { text: JSON.stringify({ items }), model: "fake" };
};

const mailer = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(String(input)).toBe(MAILER_URL);
  expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer mail-secret");
  const body = JSON.parse(String(init!.body)) as Sent;
  sent.push(body);
  return new Response(JSON.stringify({ results: body.to.map((to) => ({ to, status: "sent" })) }), { status: 200 });
}) as typeof fetch;

const ctx = (env: Record<string, string> = {}): SourceContext => ({
  env: { REPO_ROOT, MAIL_TOKEN: "mail-secret", MAIL_RECIPIENTS: RECIPIENTS, COLLECT_TRIGGER: "schedule", ...env },
  fetch: mailer,
  complete,
});

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await testDb());
  sent = [];
  claudeCalls = 0;
  prompts = [];
  await runDimension(db, watchlist, { trigger: "test", ctx: { env: { REPO_ROOT }, fetch: (() => { throw new Error("no network"); }) as unknown as typeof fetch } });
  for (const p of [
    { symbol: "MNRO", name: "Monro, Inc.", description: "Auto service and tire shops.", logoUrl: "https://logos.test/MNRO.png" },
    { symbol: "PAL", name: "Proficient Auto Logistics", description: null, logoUrl: null },
  ]) {
    await db.insert(companyProfiles).values({ ...p, provenance: {} }).onConflictDoUpdate({ target: companyProfiles.symbol, set: p });
  }
});
afterEach(async () => close());

async function addNews(symbol: string, title: string, kinds: string[], at: Date) {
  const id = crypto.randomUUID();
  await db.insert(goldNewsItems).values({ id, title, url: `https://news.test/${id}`, publisher: "Reuters", publishedAt: at, firstSeenAt: at, sources: ["google-news"], symbols: [symbol], markets: ["US"] });
  await db.insert(goldNewsLinks).values({ newsItemId: id, symbol, market: "US", publishedAt: at, firstSeenAt: at, matchKinds: kinds, matchedTerms: kinds.includes("industry") ? ["tire chains"] : [symbol], sources: ["google-news"], matches: [] });
  return id;
}

describe("daily-email dimension", () => {
  it("judges each new item once, emails only the material ones with their links, once a day", async () => {
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5));
    await addNews("MNRO", "Fed holds rates", ["name"], hoursAgo(6));
    await addNews("MNRO", "Tire chains start a price war", ["industry"], hoursAgo(7));
    await addNews("PAL", "Old results from last month", ["name"], hoursAgo(24 * 10));
    await addNews("PAL", "Results from the day before yesterday", ["name"], hoursAgo(30));
    await db.insert(goldFilings).values({ id: crypto.randomUUID(), symbol: "PAL", registry: "sec", filingKey: "k1", form: "8-K", title: "Results of operations", filedAt: hoursAgo(20), url: "https://sec.test/8k", language: "en", sources: ["sec-edgar"] });

    const report = await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(report.status).toBe("succeeded");
    expect(claudeCalls).toBe(2); // MNRO and PAL; news older than 24 h never asked
    expect(prompts.join("\n")).not.toContain("day before yesterday");

    const verdicts = await db.select().from(dailyItemVerdicts);
    expect(verdicts.map((v) => [v.symbol, v.kind, v.material]).sort()).toEqual([
      ["MNRO", "industry", true],
      ["MNRO", "news", false],
      ["MNRO", "news", true],
      ["PAL", "filing", true],
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["kevin@example.test", "thierry@example.test"]);
    expect(sent[0].subject).toMatch(/^Your watchlist, \w{3} \d+$/);
    expect(sent[0].html).toContain('src="https://mailer.dualisresearch.com/mark-white.png"');
    expect(sent[0].html).toContain('src="https://mailer.dualisresearch.com/icons/industry.png"');
    expect(sent[0].html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(sent[0].html).toContain('src="https://logos.test/MNRO.png"');
    expect(sent[0].html).toContain("https://sec.test/8k");
    expect(sent[0].html).not.toContain("Reuters");
    expect(sent[0].text).not.toContain("Fed holds rates");
    // Most important first: the industry price war (9) before Monro's results (5), Monro before PAL (5).
    const lines = sent[0].text.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("price war")).toBeLessThan(at("Monro third quarter"));
    expect(at("Monro, Inc.")).toBeLessThan(at("Proficient Auto"));
    expect(sent[0].text).not.toMatch(/[—–]/);
    expect(sent[0].text).toContain("Not investment advice.");

    const [digest] = await db.select().from(goldDailyDigests);
    expect(digest.items).toHaveLength(3);
    expect(digest.sendStatus).toBe("sent");

    // Same day again: nothing new to judge, no second email.
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(claudeCalls).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it("a later item of the same ticker is judged knowing what was already told", async () => {
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5));
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    await addNews("MNRO", "Monro results: more coverage of the same beat", ["name"], hoursAgo(1));
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Already told");
    expect(prompts[1]).toContain("Already told to the analyst");
    expect(prompts[1]).toContain("- Summary of Monro third quarter results beat");
  });

  it("nothing material: a digest with no item, no email", async () => {
    await addNews("MNRO", "Fed holds rates", ["name"], hoursAgo(5));
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(claudeCalls).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(dailyEmailSends)).toHaveLength(0);
    const [digest] = await db.select().from(goldDailyDigests);
    expect(digest.items).toEqual([]);
    expect(digest.subject).toBeNull();
  });

  it("test mode reaches Kevin only and never counts as the day's email; a manual run never sends", async () => {
    await addNews("MNRO", "Monro results", ["name"], hoursAgo(5));
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ DAILY_EMAIL_MODE: "test", COLLECT_TRIGGER: "manual" }) });
    expect(sent.map((s) => s.to)).toEqual([["kevin@example.test"]]);

    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ COLLECT_TRIGGER: "manual" }) });
    expect(sent).toHaveLength(1);

    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(sent.map((s) => s.to)).toEqual([["kevin@example.test"], ["kevin@example.test", "thierry@example.test"]]);
    const modes = (await db.select().from(dailyEmailSends)).map((s) => s.mode).sort();
    expect(modes).toEqual(["full", "test"]);
  });

  it("a role with no recipient fails the run loudly", async () => {
    await addNews("MNRO", "Monro results", ["name"], hoursAgo(5));
    const report = await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ MAIL_RECIPIENTS: JSON.stringify([{ email: "k@x.test", role: "test" }]) }) });
    expect(report.status).toBe("failed");
    expect(report.error).toContain("no client recipient");
    expect(sent).toHaveLength(0);
  });
});

describe("daily-email parsing and words", () => {
  it("bold key words in HTML, plain in text, never a dash", () => {
    const { html, text } = renderEmail("2026-11-24", [
      { symbol: "X", company: "X Co", kind: "industry", title: "t", url: null, publisher: null, at: null, summary: "**Rival** cuts prices — **10%**.", why: "" },
    ], MARK);
    expect(html).toContain("<strong>Rival</strong> cuts prices, <strong>10%</strong>.");
    expect(text).toContain("Industry: Rival cuts prices, 10%.");
  });

  it("orders companies by their most important item, then each company's items", () => {
    const rank = new Map([["A", 0], ["B", 1], ["C", 2]]);
    const items = [
      { symbol: "A", importance: 3, n: "a3" },
      { symbol: "B", importance: 8, n: "b8" },
      { symbol: "A", importance: 6, n: "a6" },
      { symbol: "B", importance: 2, n: "b2" },
      { symbol: "C", importance: null, n: "c0" },
    ];
    expect(orderDigest(items, rank).map((i) => i.n)).toEqual(["b8", "b2", "a6", "a3", "c0"]);
  });

  it("refuses an answer that skips an item", () => {
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: false, why: "x" }] }), 2)).toThrow("misses i2");
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: true }] }), 1)).toThrow("no summary");
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: true, summary: "x" }] }), 1)).toThrow("no importance");
  });

  it("one company, a filing line, the disclaimer last", () => {
    const { subject, text } = renderEmail("2026-11-24", [
      { symbol: "1161.HK", company: "Water Oasis Group", kind: "filing", title: "Interim results", url: "https://hkex.test/a.pdf", publisher: "hkex", at: null, summary: "Half-year **revenue rose 9%**.", why: "Services keep growing." },
    ], MARK);
    expect(subject).toBe("Your watchlist, Nov 24");
    expect(text.split("\n").at(-1)).toMatch(/^Not investment advice\./);
    expect(text).toContain("Filing: Half-year revenue rose 9%. https://hkex.test/a.pdf");
  });
});
