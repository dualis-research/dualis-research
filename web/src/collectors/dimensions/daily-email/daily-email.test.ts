import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dailyEmailSends, dailyItemVerdicts, goldDailyDigests, urgentAlertSends } from "@/db/schema/daily-email";
import { companyProfiles, filings as goldFilings } from "@/db/schema/gold";
import { goldNewsItems, goldNewsLinks } from "@/db/schema/news";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { runDimension } from "../../runner";
import type { SourceContext } from "../../types";
import { watchlist } from "../watchlist";
import { newsAlertDim } from "../news-alert";
import { capPerCompany, dailyEmailDim, MAILER_URL, orderDigest, parseVerdicts } from ".";
import { renderEmail, renderUrgent, SUBJECT_MAX } from "./render";

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

/** Fake Claude: an item is material when its title says « results », « price war » or « profit warning » (that one critical); everything else is noise. */
const complete: Complete = async ({ prompt }) => {
  claudeCalls += 1;
  prompts.push(prompt);
  const items = prompt
    .split("\n")
    .filter((l) => /^i\d+ \|/.test(l))
    .map((l) => {
      const id = l.split(" |")[0];
      const critical = /profit warning/i.test(l);
      const material = critical || /results|price war/i.test(l);
      const importance = material ? (critical ? 10 : /price war/i.test(l) ? 9 : 5) : null;
      const n = /results (\d)/.exec(l);
      return { id, material, summary: material ? `Summary of **${l.split(" | ").at(-1)}**` : null, why: material ? "It moves revenue — a lot." : "Macro.", importance: n ? Number(n[1]) : importance, level: critical ? "critical" : material ? "high" : "low" };
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
    expect(prompts[1]).toContain("- Summary of **Monro third quarter results beat**");
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

describe("urgent alert (news-alert, every hour)", () => {
  const SIREN = "🚨 Urgent: Monro, Inc. (MNRO): Summary of Monro issues a profit warning";

  it("emails a critical item once, at once; never a high one, never the morning digest", async () => {
    await addNews("MNRO", "Monro issues a profit warning", ["name"], hoursAgo(1));
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(2));
    await addNews("PAL", "Tire chains start a price war", ["industry"], hoursAgo(2));

    const report = await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    expect(report.status).toBe("succeeded");
    expect((await db.select().from(dailyItemVerdicts)).map((v) => v.level).sort()).toEqual(["critical", "high", "high"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["kevin@example.test", "thierry@example.test"]);
    expect(sent[0].subject).toBe(SIREN);
    expect(sent[0].html).toContain(">URGENT<");
    expect(sent[0].html).toContain("<strong>Monro issues a profit warning</strong>");
    expect(sent[0].html).toContain("It moves revenue, a lot.");
    expect(sent[0].html).toContain('src="https://logos.test/MNRO.png"');
    expect(sent[0].html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(sent[0].html).not.toContain("price war");
    expect(sent[0].text).not.toMatch(/[—–]/);
    expect(sent[0].text).toContain("Not investment advice.");
    // No digest built or sent by the hourly run.
    expect(await db.select().from(goldDailyDigests)).toHaveLength(0);
    expect(await db.select().from(dailyEmailSends)).toHaveLength(0);

    // The next hour, and the 02:00 run after it: nothing judged again, never a second urgent email; the digest goes out.
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    expect(claudeCalls).toBe(2);
    expect(sent).toHaveLength(1);
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(claudeCalls).toBe(2);
    expect(sent.map((s) => s.subject)).toEqual([SIREN, expect.stringMatching(/^Your watchlist, /)]);
    expect(sent[1].text).toContain("profit warning");
    expect((await db.select().from(urgentAlertSends)).map((r) => [r.symbol, r.mode, r.status])).toEqual([["MNRO", "full", "sent"]]);
  });

  it("the 02:00 run alerts a critical item it judged itself; a manual run never alerts", async () => {
    await addNews("MNRO", "Monro issues a profit warning", ["name"], hoursAgo(1));
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx({ COLLECT_TRIGGER: "manual" }) });
    expect(sent).toHaveLength(0);
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(sent.map((s) => s.subject)).toEqual([SIREN, expect.stringMatching(/^Your watchlist, /)]);
  });

  it("a critical verdict older than 6 hours is never alerted; a failed send is tried again by the next run", async () => {
    const id = await addNews("MNRO", "Monro issues a profit warning", ["name"], hoursAgo(1));
    const down: SourceContext = { ...ctx(), fetch: (async () => new Response("down", { status: 500 })) as unknown as typeof fetch };
    const report = await runDimension(db, newsAlertDim, { trigger: "test", ctx: down });
    expect(report.status).toBe("failed");
    expect(report.error).toContain("urgent email not sent");
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    expect(sent).toHaveLength(1);
    expect((await db.select().from(urgentAlertSends)).map((r) => r.status).sort()).toEqual(["failed", "sent"]);

    await db.delete(urgentAlertSends);
    await db.update(dailyItemVerdicts).set({ createdAt: hoursAgo(7) }).where(eq(dailyItemVerdicts.itemId, id));
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    expect(sent).toHaveLength(1);
  });

  it("test mode: no critical item, the most important material one goes to Kevin only, marked [TEST], never recorded as its alert", async () => {
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(2));
    await addNews("PAL", "Tire chains start a price war", ["industry"], hoursAgo(2));
    await addNews("PAL", "Fed holds rates", ["name"], hoursAgo(2));
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx({ URGENT_ALERT_MODE: "test", COLLECT_TRIGGER: "manual" }) });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["kevin@example.test"]);
    expect(sent[0].subject).toBe("[TEST] 🚨 Urgent: Proficient Auto Logistics (PAL): Summary of Tire chains start a price war");
    expect((await db.select().from(urgentAlertSends)).map((r) => [r.mode, r.status])).toEqual([["test", "sent"]]);
  });

  it("test mode with nothing material shows the latest verdict", async () => {
    await addNews("MNRO", "Fed holds rates", ["name"], hoursAgo(2));
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx({ URGENT_ALERT_MODE: "test", COLLECT_TRIGGER: "manual" }) });
    expect(sent.map((s) => s.subject)).toEqual(["[TEST] 🚨 Urgent: Monro, Inc. (MNRO): Fed holds rates"]);
  });

  it("the digest keeps the 3 most important items of a company, however many hourly batches judged them", async () => {
    for (const n of [2, 7, 4, 9, 6]) {
      await addNews("MNRO", `Monro results ${n}`, ["name"], hoursAgo(n));
      await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    }
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    const [digest] = await db.select().from(goldDailyDigests);
    expect(digest.items.map((i) => i.importance)).toEqual([9, 7, 6]);
    expect(capPerCompany([{ symbol: "A", importance: 1 }, { symbol: "A", importance: 5 }, { symbol: "B", importance: 2 }], 1)).toEqual([{ symbol: "A", importance: 5 }, { symbol: "B", importance: 2 }]);
  });

  it("the urgent subject stays short and the email has no fixed width a phone cannot hold", () => {
    const { subject, html, text } = renderUrgent("2026-11-24", { symbol: "1161.HK", company: "Water Oasis Group", kind: "filing", title: "t", url: "https://hkex.test/a.pdf", publisher: "hkex", at: null, summary: `**Profit warning**: ${"half-year profit expected to fall sharply ".repeat(5)}`, why: "Earnings — the core of the case." }, MARK);
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(subject).toMatch(/^🚨 Urgent: Water Oasis Group \(1161\.HK\): Profit warning: half-year/);
    expect(subject).not.toContain("**");
    expect(text).toContain("Why it matters: Earnings, the core of the case.");
    expect(html).toContain("https://hkex.test/a.pdf");
    const widths = [...html.matchAll(/(?<!max-)width(?:="|:)(\d+)(?:px|")/g)].map((m) => Number(m[1]));
    expect(Math.max(...widths)).toBeLessThanOrEqual(36);
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
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: false, why: "x", level: "low" }] }), 2)).toThrow("misses i2");
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: true }] }), 1)).toThrow("no summary");
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: true, summary: "x" }] }), 1)).toThrow("no importance");
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: true, summary: "x", importance: 9 }] }), 1)).toThrow("no level");
    expect(() => parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: false, level: "urgent" }] }), 1)).toThrow("no level");
    expect(parseVerdicts(JSON.stringify({ items: [{ id: "i1", material: true, summary: "x", importance: 9, level: "critical" }, { id: "i2", material: false, level: "medium" }] }), 2).map((v) => v.level)).toEqual(["critical", "low"]);
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
