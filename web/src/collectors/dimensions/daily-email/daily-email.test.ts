import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kpiDrivers, narratives } from "@/db/schema/analysis";
import { reversal } from "@/test/price-drivers";
import { fetches } from "@/db/schema/bronze";
import { dailyEmailSends, dailyItemTexts, dailyItemVerdicts, goldDailyDigests, urgentAlertSends } from "@/db/schema/daily-email";
import * as silver from "@/db/schema/silver";
import { companyProfiles, filings as goldFilings } from "@/db/schema/gold";
import { goldNewsItems, goldNewsLinks, newsItems } from "@/db/schema/news";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { runDimension } from "../../runner";
import type { SourceContext } from "../../types";
import { watchlist } from "../watchlist";
import { newsAlertDim } from "../news-alert";
import { capPerCompany, dailyEmailDim, MAILER_URL, orderDigest, parseVerdicts } from ".";
import { impactsOf } from "./drivers";
import { decodeRequestBody, extractArticle, googleArticleId, linksToTry, MAX_TEXT_TRIES, parseDecodedUrl, signatureOf } from "./article";
import { parsePoints } from "./key-points";
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
let pointCalls: string[];
let pointsCount: number;
let pageFetches: string[];

/** An article page the fake web serves: a nav, a short caption, and two real paragraphs. */
const articlePage = (title: string) => `<html><body><nav><p>Home Markets Companies World Opinion and much more navigation text here</p></nav>
<article><h1>${title}</h1><p>Photo: a shop.</p><p>Monro, Inc. said on Tuesday that third quarter sales rose 12% to $340 million, helped by tire demand across its 1,260 stores.</p>
<p>Chief executive Mike Broderick said margins improved by 150 basis points and the company raised its full year outlook for comparable store sales.</p>
<p>The company will pay a quarterly dividend of 28 cents a share on December 20 to holders of record on December 6, it said in a statement.</p></article>
<footer><p>Copyright 2026 News Test. All rights reserved. Terms of use and privacy policy apply here.</p></footer></body></html>`;

/** Fake Claude: an item is material when its title says « results », « price war » or « profit warning » (that one critical); everything else is noise. */
const complete: Complete = async ({ system, prompt }) => {
  if (/key points/.test(system ?? "")) {
    pointCalls.push(prompt);
    return { text: JSON.stringify({ points: ["Sales rose **12%** to $340 million — on tire demand.", "Margins improved by 150 basis points.", "Quarterly dividend of 28 cents paid December 20."].slice(0, pointsCount) }), model: "fake" };
  }
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

/** The fake web: the mailer, article pages on news.test, a filing on sec.test, a Google News link decoded to news.test. */
const web = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url !== MAILER_URL) {
    pageFetches.push(url);
    if (url.startsWith("https://news.google.com/rss/articles/")) return new Response('<div jscontroller="aLI87" data-n-a-id="X" data-n-a-ts="1795516417" data-n-a-sg="SIG123"></div>', { status: 200 });
    if (url.startsWith("https://news.google.com/_/DotsSplashUi/data/batchexecute")) {
      const body = decodeURIComponent(String(init!.body));
      if (!body.includes('"Fbv4je"')) return new Response(")]}'\n[]", { status: 400 });
      return new Response(`)]}'\n\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://news.test/decoded", 1]), null, null, null, "generic"]])}\n`, { status: 200 });
    }
    // The free reader renders a walled page (KEYPOINTS-FALLBACK-1126); a bot challenge stays a challenge.
    if (url.startsWith("https://r.jina.ai/")) {
      expect((init!.headers as Record<string, string>)["X-Return-Format"]).toBe("html");
      const inner = url.slice("https://r.jina.ai/".length);
      if (/walled|netfail/.test(inner)) return new Response(`<form id="form1">${articlePage("Monro")}</form>`, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("<html><body><h1>Checking your browser</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.startsWith("https://news.test/broken")) return new Response("gone", { status: 404 });
    if (url.startsWith("https://news.test/walled")) return new Response("Forbidden", { status: 403 });
    if (url.startsWith("https://news.test/challenge")) return new Response("Forbidden", { status: 403 });
    if (url.startsWith("https://news.test/netfail")) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_OVERFLOW" } });
    if (url.startsWith("https://news.test/")) return new Response(articlePage("Monro"), { status: 200, headers: { "content-type": "text/html" } });
    if (url.startsWith("https://sec.test/")) return new Response(`<html><body><p>Item 2.02 Results of Operations. ${"Proficient Auto Logistics reported revenue of $102 million for the quarter. ".repeat(8)}</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  }
  expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer mail-secret");
  const body = JSON.parse(String(init!.body)) as Sent;
  sent.push(body);
  return new Response(JSON.stringify({ results: body.to.map((to) => ({ to, status: "sent" })) }), { status: 200 });
}) as typeof fetch;

const ctx = (env: Record<string, string> = {}): SourceContext => ({
  env: { REPO_ROOT, MAIL_TOKEN: "mail-secret", MAIL_RECIPIENTS: RECIPIENTS, COLLECT_TRIGGER: "schedule", GOOGLE_PACE: "0", ...env },
  fetch: ((input: string | URL | Request, init?: RequestInit) => web(input, init)) as typeof fetch,
  complete,
});

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await testDb());
  sent = [];
  claudeCalls = 0;
  prompts = [];
  pointCalls = [];
  pointsCount = 3;
  pageFetches = [];
  await runDimension(db, watchlist, { trigger: "test", ctx: { env: { REPO_ROOT }, fetch: (() => { throw new Error("no network"); }) as unknown as typeof fetch } });
  for (const p of [
    { symbol: "MNRO", name: "Monro, Inc.", description: "Auto service and tire shops.", logoUrl: "https://logos.test/MNRO.png" },
    { symbol: "PAL", name: "Proficient Auto Logistics", description: null, logoUrl: null },
  ]) {
    await db.insert(companyProfiles).values({ ...p, provenance: {} }).onConflictDoUpdate({ target: companyProfiles.symbol, set: p });
  }
});
afterEach(async () => close());

async function addNews(symbol: string, title: string, kinds: string[], at: Date, url?: string) {
  const id = crypto.randomUUID();
  await db.insert(goldNewsItems).values({ id, title, url: url ?? `https://news.test/${id}`, publisher: "Reuters", publishedAt: at, firstSeenAt: at, sources: ["google-news"], symbols: [symbol], markets: ["US"] });
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
  const SIREN = "🚨 Critical: Monro, Inc. (MNRO): Summary of Monro issues a profit warning";

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
    expect(sent[0].html).toContain(">CRITICAL<");
    expect(sent[0].html).not.toMatch(/urgent/i);
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
    expect(sent[0].subject).toBe("[TEST] 🚨 Critical: Proficient Auto Logistics (PAL): Summary of Tire chains start a price war");
    expect((await db.select().from(urgentAlertSends)).map((r) => [r.mode, r.status])).toEqual([["test", "sent"]]);
  });

  it("test mode with nothing material shows the latest verdict", async () => {
    await addNews("MNRO", "Fed holds rates", ["name"], hoursAgo(2));
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx({ URGENT_ALERT_MODE: "test", COLLECT_TRIGGER: "manual" }) });
    expect(sent.map((s) => s.subject)).toEqual(["[TEST] 🚨 Critical: Monro, Inc. (MNRO): Fed holds rates"]);
  });

  it("the digest keeps the 3 most important items of a company, however many hourly batches judged them", async () => {
    for (const n of [2, 7, 4, 9, 6]) {
      await addNews("MNRO", `Monro results ${n}`, ["name"], hoursAgo(n));
      await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    }
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    const [digest] = await db.select().from(goldDailyDigests);
    expect(digest.items.map((i) => i.importance)).toEqual([9, 7, 6]);
    expect(digest.items.map((i) => i.level)).toEqual(["high", "high", "high"]);
    expect(capPerCompany([{ symbol: "A", importance: 1 }, { symbol: "A", importance: 5 }, { symbol: "B", importance: 2 }], 1)).toEqual([{ symbol: "A", importance: 5 }, { symbol: "B", importance: 2 }]);
  });

  it("the urgent subject stays short and the email has no fixed width a phone cannot hold", () => {
    const { subject, html, text } = renderUrgent("2026-11-24", { symbol: "1161.HK", company: "Water Oasis Group", kind: "filing", title: "t", url: "https://hkex.test/a.pdf", publisher: "hkex", at: null, summary: `**Profit warning**: ${"half-year profit expected to fall sharply ".repeat(5)}`, why: "Earnings — the core of the case." }, MARK);
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(subject).toMatch(/^🚨 Critical: Water Oasis Group \(1161\.HK\): Profit warning: half-year/);
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

  it("a HIGH or CRITICAL tag before each item of that level, none for medium or low (Kevin 2026-11-26)", () => {
    const item = (level: "low" | "medium" | "high" | "critical", summary: string) => ({ symbol: "X", company: "X Co", kind: "news" as const, title: "t", url: null, publisher: null, at: null, summary, why: "", level });
    const { html, text } = renderEmail("2026-11-26", [item("critical", "Profit warning."), item("high", "Big order."), item("medium", "New plant."), item("low", "Small hire.")], MARK);
    expect(text).toContain("[CRITICAL] Company news: Profit warning.");
    expect(text).toContain("[HIGH] Company news: Big order.");
    expect(text).toContain("\nCompany news: New plant.");
    expect(text).toContain("\nCompany news: Small hire.");
    expect(html.match(/>CRITICAL<\/span>/g)).toHaveLength(1);
    expect(html.match(/>HIGH<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain(">MEDIUM<");
    // Key points on high and critical only (Kevin 2026-11-26): a medium item keeps its sentence alone.
    const pts = ["p1", "p2", "p3"];
    const withPoints = renderEmail("2026-11-26", [{ ...item("high", "Big order."), keyPoints: pts }, { ...item("medium", "New plant."), keyPoints: ["m1", "m2", "m3"] }], MARK);
    expect(withPoints.text).toContain("  • p1");
    expect(withPoints.text).not.toContain("m1");
    expect(withPoints.html.match(/KEY POINTS/g)).toHaveLength(1);
    // The urgent email already carries its big red label: no second tag on its item.
    const urgent = renderUrgent("2026-11-26", item("critical", "Profit warning."), MARK);
    expect(urgent.html.match(/>CRITICAL<\/span>/g)).toHaveLength(1);
    expect(urgent.text).not.toContain("[CRITICAL]");
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

describe("key points (NEWS-KEY-POINTS-1124)", () => {
  it("decodes a Google News link: its id, the signature on the redirect page, the RPC body and the publisher URL in the answer", () => {
    expect(googleArticleId("https://news.google.com/rss/articles/CBMiAbc_d-1?oc=5")).toBe("CBMiAbc_d-1");
    expect(googleArticleId("https://news.google.com/articles/XYZ")).toBe("XYZ");
    expect(googleArticleId("https://www.reuters.com/a/b")).toBeNull();
    expect(signatureOf('<div data-n-a-id="X" data-n-a-ts="1795516417" data-n-a-sg="AdwtSY"></div>')).toEqual({ signature: "AdwtSY", timestamp: 1795516417 });
    expect(signatureOf("<html>consent page</html>")).toBeNull();
    const body = decodeURIComponent(decodeRequestBody("CBMiAbc", 1795516417, "AdwtSY"));
    expect(body).toContain('"Fbv4je"');
    expect(body).toContain('garturlreq');
    expect(body).toContain('\\"CBMiAbc\\",1795516417,\\"AdwtSY\\"');
    const answer = `)]}'\n\n123\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.kmbc.com/article/x/74446784\\",1]",null,null,null,"generic"],["di",12]]\n25\n[["e",4,null,null,138]]`;
    expect(parseDecodedUrl(answer)).toBe("https://www.kmbc.com/article/x/74446784");
    expect(parseDecodedUrl(`)]}'\n[["er",null,null,null,null,400]]`)).toBeNull();
  });

  it("extracts the article: JSON-LD body first, else the article's paragraphs without navigation; nothing on an empty page", () => {
    const text = extractArticle(articlePage("Monro"))!;
    expect(text).toContain("third quarter sales rose 12%");
    expect(text).toContain("quarterly dividend of 28 cents");
    expect(text).not.toContain("navigation");
    expect(text).not.toContain("Copyright");
    expect(text).not.toContain("Photo: a shop.");
    const ld = `<script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "NewsArticle", articleBody: "Water Oasis said first half revenue rose 9% to HK$420 million. ".repeat(8) }] })}</script><p>Subscribe now to read the rest of this story today please.</p>`;
    expect(extractArticle(ld)).toMatch(/^Water Oasis said first half revenue rose 9%/);
    expect(extractArticle("<html><body><div id=app></div><p>Please enable JavaScript to view this page properly.</p></body></html>")).toBeNull();
  });

  it("refuses an answer that is not exactly 3 bullets; strips dashes", () => {
    expect(() => parsePoints(JSON.stringify({ points: ["a", "b"] }))).toThrow("exactly 3");
    expect(() => parsePoints(JSON.stringify({ points: ["a", "b", "c", "d"] }))).toThrow("exactly 3");
    expect(() => parsePoints("no json")).toThrow();
    // A text with no content of its own (page scripts, a wall): no bullets, stored as none, never asked again.
    expect(parsePoints(JSON.stringify({ points: [] }))).toEqual([]);
    expect(parsePoints(JSON.stringify({ points: ["Sales rose — 12%.", "b", "c"] }))).toEqual(["Sales rose, 12%.", "b", "c"]);
  });

  it("reads each material item's text (a Google News link decoded first), writes 3 key points once, shows them in the email", async () => {
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5), "https://news.google.com/rss/articles/CBMiAbc?oc=5");
    await addNews("MNRO", "Fed holds rates", ["name"], hoursAgo(6));
    await db.insert(goldFilings).values({ id: crypto.randomUUID(), symbol: "PAL", registry: "sec", filingKey: "k1", form: "8-K", title: "Results of operations", filedAt: hoursAgo(20), url: "https://sec.test/8k", language: "en", sources: ["sec-edgar"] });

    const report = await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(report.status).toBe("succeeded");
    // Only the material items are read: never the macro one.
    expect(pageFetches.filter((u) => !u.startsWith("https://news.google.com"))).toEqual(expect.arrayContaining(["https://news.test/decoded", "https://sec.test/8k"]));
    expect(pageFetches.filter((u) => !u.startsWith("https://news.google.com"))).toHaveLength(2);
    const texts = await db.select().from(dailyItemTexts);
    expect(texts.map((t) => [t.kind, t.status, t.url]).sort()).toEqual([["filing", "ok", "https://sec.test/8k"], ["news", "ok", "https://news.test/decoded"]]);
    // The writer reads the TEXT, not only the headline.
    expect(pointCalls).toHaveLength(2);
    expect(pointCalls.join("\n")).toContain("third quarter sales rose 12% to $340 million");
    expect(pointCalls.join("\n")).toContain("revenue of $102 million");
    const points = (await db.select().from(dailyItemVerdicts)).filter((v) => v.material).map((v) => v.keyPoints);
    expect(points.every((p) => p?.length === 3)).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("KEY POINTS");
    expect(sent[0].html).toContain("<li");
    expect(sent[0].html).toContain("Sales rose 12% to $340 million, on tire demand.");
    expect(sent[0].text).toContain("  • Margins improved by 150 basis points.");
    expect(sent[0].text).not.toMatch(/[—–]/);
    expect(sent[0].html).not.toContain("Price Drivers");

    // Stored once: the next runs never read or write them again.
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(pointCalls).toHaveLength(2);
    expect(pageFetches.filter((u) => !u.startsWith("https://news.google.com"))).toHaveLength(2);
  });

  it("no text read = no key points (never from the headline), tried 3 times then given up", async () => {
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5), "https://news.test/broken");
    const report = await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ DAILY_EMAIL_MODE: "test" }) });
    expect(report.status).toBe("partial");
    expect(pointCalls).toHaveLength(0);
    expect(sent[0].html).not.toContain("KEY POINTS");
    expect(sent[0].text).toContain("Monro third quarter results beat");
    for (let i = 0; i < 4; i++) await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    const [t] = await db.select().from(dailyItemTexts);
    expect([t.status, t.attempts, t.why]).toEqual(["failed", MAX_TEXT_TRIES, "HTTP 404 from https://news.test/broken"]);
    expect(pageFetches.filter((u) => u === "https://news.test/broken")).toHaveLength(MAX_TEXT_TRIES);
    expect(pointCalls).toHaveLength(0);
  });

  it("a walled page (403) or a refused connection is read through the free reader, in the same run (KEYPOINTS-FALLBACK-1126)", async () => {
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5), "https://news.test/walled");
    await addNews("PAL", "Proficient results beat", ["name"], hoursAgo(5), "https://news.test/netfail");
    const report = await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ DAILY_EMAIL_MODE: "test" }) });
    expect(report.status).toBe("succeeded");
    const texts = await db.select().from(dailyItemTexts);
    expect(texts.map((t) => [t.status, t.method, t.url, t.attempts]).sort()).toEqual([
      ["ok", "reader", "https://news.test/netfail", 1],
      ["ok", "reader", "https://news.test/walled", 1],
    ]);
    expect(pointCalls.join("\n")).toContain("third quarter sales rose 12% to $340 million");
    expect(sent[0].html).toContain("KEY POINTS");
    const tried = (await db.select().from(fetches)).filter((f) => f.source === "article").map((f) => (f.request as { tried: string[] }).tried.join(" | "));
    expect(tried.sort()).toEqual(["HTTP 403 from https://news.test/walled", "fetch failed (UND_ERR_HEADERS_OVERFLOW) from https://news.test/netfail"]);
  });

  it("the critical email carries its key points when the text is readable only through the reader: every way is tried before it leaves", async () => {
    await addNews("MNRO", "Monro issues a profit warning", ["name"], hoursAgo(1), "https://news.test/walled");
    await runDimension(db, newsAlertDim, { trigger: "test", ctx: ctx() });
    expect(sent.map((s) => s.subject)).toEqual(["🚨 Critical: Monro, Inc. (MNRO): Summary of Monro issues a profit warning"]);
    expect(sent[0].html).toContain("KEY POINTS");
    expect(sent[0].text).toContain("  • Margins improved by 150 basis points.");
  });

  it("an unreadable link: the item's other links are tried, then the feed's own summary; never the headline", async () => {
    // Other links of the same article (Yahoo, Finnhub, Google News each carry their own): a readable one wins.
    const a = await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5), "https://news.test/challenge/a");
    await db.insert(newsItems).values({ id: a, title: "Monro third quarter results beat", titleKey: "monro", url: "https://news.test/challenge/a", urls: ["https://news.test/challenge/a", "https://news.test/copy"], urlKeys: [], sources: ["yahoo", "finnhub"], bronzeIds: [] });
    // No link readable: a feed summary long enough to hold the story is the text; a short one is not.
    const b = await addNews("PAL", "Proficient results beat", ["name"], hoursAgo(5), "https://news.test/challenge/b");
    const summary = "Proficient Auto Logistics said quarterly revenue rose 18% to $102 million as volumes recovered across its car haul network. ".repeat(3);
    await db.insert(newsItems).values({ id: b, title: "Proficient results beat", titleKey: "pal", url: "https://news.test/challenge/b", urls: ["https://news.test/challenge/b"], urlKeys: [], summary, sources: ["yahoo"], bronzeIds: [] });
    await addNews("MNRO", "Monro price war results", ["name"], hoursAgo(5), "https://news.test/challenge/c");
    await db.insert(newsItems).values({ id: (await db.select().from(goldNewsItems)).find((n) => n.title === "Monro price war results")!.id, title: "Monro price war results", titleKey: "mpw", url: "https://news.test/challenge/c", urls: ["https://news.test/challenge/c"], urlKeys: [], summary: "Too short to tell.", sources: ["yahoo"], bronzeIds: [] });

    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ DAILY_EMAIL_MODE: "test" }) });
    const texts = new Map((await db.select().from(dailyItemTexts)).map((t) => [t.itemId, t]));
    expect([texts.get(a)!.status, texts.get(a)!.method, texts.get(a)!.url]).toEqual(["ok", "article", "https://news.test/copy"]);
    expect([texts.get(b)!.status, texts.get(b)!.method, texts.get(b)!.text]).toEqual(["ok", "feed-summary", summary.trim()]);
    const c = [...texts.values()].find((t) => t.itemId !== a && t.itemId !== b)!;
    expect(c.status).toBe("failed");
    expect(c.why).toBe("HTTP 403 from https://news.test/challenge/c; reader: no article text on the page (0 characters: a paywall or a page built by script?) (https://news.test/challenge/c); feed summary too short (18 characters)");
    expect(pointCalls.join("\n")).toContain("quarterly revenue rose 18% to $102 million");
    expect(pointCalls.join("\n")).not.toContain("Too short to tell.");
  });

  it("publisher links are tried before Google News ones (each costs two rate-limited calls)", () => {
    expect(linksToTry("https://news.google.com/rss/articles/X", ["https://news.google.com/rss/articles/X", "https://a.test/1", "https://finnhub.io/api/news?id=1"])).toEqual(["https://a.test/1", "https://finnhub.io/api/news?id=1", "https://news.google.com/rss/articles/X"]);
    expect(linksToTry(null, [])).toEqual([]);
  });

  it("an answer with 2 bullets stores nothing and fails loud in bronze", async () => {
    pointsCount = 2;
    await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5));
    const report = await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx({ DAILY_EMAIL_MODE: "test" }) });
    expect(report.status).toBe("partial");
    expect((await db.select().from(dailyItemVerdicts)).find((v) => v.material)!.keyPoints).toBeNull();
    const failed = (await db.select().from(fetches)).filter((f) => f.source === "key-points");
    expect(failed.map((f) => f.error)).toEqual([expect.stringContaining("expected exactly 3 bullets, got 2")]);
    expect(sent[0].html).not.toContain("KEY POINTS");
  });
});

describe("Price Driver impact (NEWS-KEY-POINTS-1124): the emails read step D, they judge nothing", () => {
  const ev = (id: string) => ({ id: `MNRO|news:${id}`, day: "2026-11-24", kind: "news" as const, title: "t", sourceId: id, url: null });
  /**
   * MNRO as the analysis left it: a pessimistic narrative; Net income (strong) read in strong reversal with the item as
   * its leading indicator; Store count (weak) read in weak continuation, the item being one of its changes; Tire prices
   * (strong) read in reversal on OTHER events; Rent (noise) not a Price Driver.
   */
  async function withDrivers(id: string, stance: "against" | "with" = "against") {
    const now = new Date();
    await db.insert(narratives).values({ id: "MNRO:long", symbol: "MNRO", side: "long", confidence: "strong", text: "The market thinks Monro is shrinking.", version: "v1", asOf: now });
    const row = { kpiMoved: true, changeUp: true, kind: "news" as const, title: "t", sourceId: id, url: null, period: null, from: null, to: null, change: null, kpiWhy: null, stock: null, reaction: null, z: null, moveId: null, priceMoved: false, result: "invalidates" as const, cite: null, day: "2026-11-24" };
    await db.insert(kpiDrivers).values([
      { id: "MNRO:k1", symbol: "MNRO", rank: 1, name: "Net income", level: "strong", why: "w", expected: "up", asOf: now, reversal: reversal("long", { stance, turn: stance === "against" ? "inflection" : null, leading: { probability: "high", why: "w", events: [ev(id)] } }) },
      { id: "MNRO:k2", symbol: "MNRO", rank: 2, name: "Store count", level: "weak", why: "w", expected: "up", asOf: now, rows: [{ ...row, eventId: `MNRO|news:${id}` }], reversal: reversal("long", { stance: "with", strength: "weak", turn: null }) },
      { id: "MNRO:k3", symbol: "MNRO", rank: 3, name: "Tire prices", level: "strong", why: "w", expected: "up", asOf: now, reversal: reversal("long", { leading: { probability: "high", why: "w", events: [ev("another-item")] } }) },
      { id: "MNRO:k4", symbol: "MNRO", rank: 4, name: "Rent", level: "none", why: "w", expected: "down", asOf: now, rows: [{ ...row, eventId: `MNRO|news:${id}` }] },
    ]);
  }

  it("shows each Price Driver whose step D reading read the item (a change of it, or its leading indicator), in the console's words, with no LLM call of its own", async () => {
    const id = await addNews("MNRO", "Monro third quarter results beat", ["name"], hoursAgo(5));
    await addNews("MNRO", "Fed holds rates", ["name"], hoursAgo(6));
    await withDrivers(id);
    const before = claudeCalls;
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    // The judge of the items ran (one call), nothing else was asked about the Price Drivers; no judgment stored.
    expect(claudeCalls).toBe(before + 1);
    expect(await db.select().from(silver.judgments)).toEqual([]);
    expect((await db.select().from(fetches)).map((f) => f.source).filter((x) => x === "evidence")).toEqual([]);
    expect(sent[0].text).toContain("  Price Drivers: Net income (strong): Strong BUY · Store count (weak): Weak continuation");
    expect(sent[0].html).toContain("Price Drivers:");
    expect(sent[0].html).not.toContain("Tire prices");
    expect(sent[0].html).not.toContain("Rent");
    const [digest] = await db.select().from(goldDailyDigests);
    expect(digest.items[0].drivers).toEqual([
      { name: "Net income", confidence: "strong", effect: "reversal", strength: "strong", words: "Strong BUY" },
      { name: "Store count", confidence: "weak", effect: "continuation", strength: "weak", words: "Weak continuation" },
    ]);
  });

  it("no step D reading read the item = no line; a filing matches its release; a crack on an optimistic narrative reads as one", async () => {
    await addNews("PAL", "Proficient results beat", ["name"], hoursAgo(5));
    await runDimension(db, dailyEmailDim, { trigger: "test", ctx: ctx() });
    expect(sent[0].html).not.toContain("Price Drivers");

    const k = { name: "Backlog", level: "weak" as const, rank: 1, measure: null, periods: [], rows: [], reversal: reversal("short", { strength: "weak", leading: { probability: "medium", why: "w", events: [{ ...ev("x"), id: "X|release:doc-1" }] } }) };
    expect(impactsOf(["X|filing:doc-1", "X|release:doc-1"], [k])).toEqual([{ name: "Backlog", confidence: "weak", effect: "reversal", strength: "weak", words: "Weak SELL" }]);
    expect(impactsOf(["X|news:other"], [k])).toEqual([]);
    // Noise (stance none) shows nothing.
    expect(impactsOf(["X|release:doc-1"], [{ ...k, reversal: { ...k.reversal, stance: "none" as const, strength: "none" as const } }])).toEqual([]);

    const { html, text } = renderUrgent("2026-11-24", { symbol: "X", company: "X Co", kind: "news", title: "t", url: null, publisher: null, at: null, summary: "s", why: "", level: "critical", keyPoints: ["a", "b", "c"], drivers: [{ name: "Backlog", confidence: "weak", effect: "reversal", strength: "weak", words: "Weak SELL" }] }, MARK);
    expect(text).toContain("  Price Drivers: Backlog (weak): Weak SELL");
    expect(text).toContain("  • a");
    expect(html).toContain("Weak SELL");
  });
});
