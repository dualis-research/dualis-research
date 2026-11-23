import { resolve } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetches } from "@/db/schema/bronze";
import { goldNewsLinks, newsItems, newsMentions } from "@/db/schema/news";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { analyseEveryTicker, testDb } from "@/test/db";
import { runDimension } from "../../runner";
import type { SourceContext } from "../../types";
import { companyProfile } from "../company-profile";
import { watchlist } from "../watchlist";
import { localTerms } from "./local-terms";
import { historyMonths, historyQuery, NEWS_HISTORY_DIMENSION, newsHistory, parseSubject } from "./history";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const SYMBOL = "1161.HK";
const env = { REPO_ROOT, NEWS_HISTORY_SPACING_MS: "0" };

const rss = (items: { title: string; link: string; date: string; source?: string }[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate>${i.source ? `<source url="https://x">${i.source}</source>` : ""}</item>`)
    .join("")}</channel></rss>`;

type Opts = { failOnce?: Set<string>; full?: string };
let googleCalls: { q: string; hl: string | null }[] = [];

/** Fake Yahoo (names) + Google News: answers per term and window; `failOnce` = queries that 429 until retried next run. */
function fakeFetch(opts: Opts = {}) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.startsWith("/v8/finance/chart/")) {
      const symbol = decodeURIComponent(url.pathname.split("/").pop()!);
      return json({ chart: { result: [{ meta: { longName: symbol === SYMBOL ? "Water Oasis Group Limited" : `${symbol} Corp`, fullExchangeName: "X", currency: "HKD" } }] } });
    }
    if (url.host === "query.wikidata.org") {
      if (!url.searchParams.get("query")!.includes('"1161"')) return json({ results: { bindings: [] } });
      const row = (lang: string, value: string) => ({ item: { value: "http://www.wikidata.org/entity/Q10942607" }, exLabel: { value: "Hong Kong Stock Exchange" }, local: { value, "xml:lang": lang } });
      return json({ results: { bindings: [row("zh", "奧思集團"), row("ja", "オアシス")] } });
    }
    if (url.host.includes("financialmodelingprep")) return json([]);
    if (url.pathname === "/api/v1/stock/profile2") return json({});
    if (url.host === "news.google.com") {
      const q = url.searchParams.get("q")!;
      googleCalls.push({ q, hl: url.searchParams.get("hl") });
      if (opts.failOnce?.has(q)) return new Response("Too Many Requests", { status: 429 });
      if (q === '"奧思集團" after:2024-05-01 before:2024-06-01') {
        return new Response(rss([{ title: "奧思集團盈警曾挫兩成 - 香港01", link: "https://www.hk01.com/a/1", date: "2024-05-20T07:00:00Z", source: "香港01" }]));
      }
      if (q === opts.full) {
        // A full page: 100 items, so the window must be split.
        return new Response(rss(Array.from({ length: 100 }, (_, k) => ({ title: `莎莎 story ${k} of the month`, link: `https://x.hk/${k}`, date: "2024-06-10T00:00:00Z" }))));
      }
      if (q.startsWith('"莎莎國際" after:2024-06-')) {
        return new Response(rss([{ title: "莎莎全年多賺2.8倍 - 星島頭條", link: `https://std.hk/${q.length}`, date: "2024-06-20T07:00:00Z", source: "星島頭條" }]));
      }
      return new Response(rss([]));
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
}

const complete: Complete = async ({ system, prompt }) =>
  system.includes("reads its home press")
    ? { text: JSON.stringify({ industry: prompt.includes("奧思集團") ? ["莎莎國際"] : ["wrong"], reason: "Hong Kong press." }), model: "fake" }
    : { text: JSON.stringify({ terms: ["Hong Kong skincare retail"], reason: "Its space." }), model: "fake" };
/** History runs on the one HK ticker (COLLECT_ONLY); the setup dimensions on the whole fixture watchlist. */
const ctx = (opts?: Opts, only = SYMBOL): SourceContext => ({ env: { ...env, ...(only ? { COLLECT_ONLY: only } : {}) }, fetch: fakeFetch(opts), complete });

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  googleCalls = [];
  ({ db, close } = await testDb());
  await runDimension(db, watchlist, { trigger: "test", ctx: ctx({}, "") });
  await analyseEveryTicker(db);
  await runDimension(db, companyProfile, { trigger: "test", ctx: ctx({}, "") });
});
afterEach(async () => close());

const months = () => historyMonths(new Date()).length;

describe("news history", () => {
  it("local names are the Wikidata labels of the market's language, never Claude's", async () => {
    expect(await localTerms(db, SYMBOL, complete)).toEqual({ names: ["奧思集團"], industry: ["莎莎國際"] });
    expect(await localTerms(db, "MNRO", complete)).toEqual({ names: [], industry: [] });
  });

  it("months: whole calendar months that ended, 3 years back", () => {
    const m = historyMonths(new Date("2026-11-23T10:00:00Z"));
    expect(m.at(-1)).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(m[0]).toEqual({ from: "2023-11-01", to: "2023-12-01" });
    expect(m).toHaveLength(36);
  });

  it("query: exact phrase + date operators; a one-word Latin alias carries the ticker", () => {
    expect(historyQuery({ symbol: SYMBOL, kind: "alias", term: "奧思集團" }, "2024-05-01", "2024-06-01")).toBe('"奧思集團" after:2024-05-01 before:2024-06-01');
    expect(historyQuery({ symbol: "CNRD", kind: "alias", term: "Conrad" }, "2024-05-01", "2024-06-01")).toBe('"Conrad" CNRD after:2024-05-01 before:2024-06-01');
    expect(parseSubject("1161.HK|industry|2024-05-01|2024-06-01|a|b")).toEqual({ symbol: SYMBOL, kind: "industry", from: "2024-05-01", to: "2024-06-01", term: "a|b" });
  });

  it("reads every term x month once, in the local edition, and lands the articles in silver and gold", async () => {
    const report = await runDimension(db, newsHistory, { trigger: "test", ctx: ctx() });
    expect(report.status).toBe("succeeded");
    // 4 terms: English name, local name, English industry, local industry.
    expect(report.sources[0].requested).toBe(4 * months());
    const zh = googleCalls.find((c) => c.q.startsWith('"奧思集團"'));
    expect(zh?.hl).toBe("zh-HK");

    const [item] = await db.select().from(newsItems).where(eq(newsItems.titleKey, "奧思集團盈警曾挫兩成"));
    expect(item.publishedAt?.toISOString()).toBe("2024-05-20T07:00:00.000Z");
    expect(item.sources).toEqual(["google-news"]);
    const mentions = await db.select().from(newsMentions).where(eq(newsMentions.newsItemId, item.id));
    expect(mentions.map((m) => [m.tickerSymbol, m.matchKind, m.matchedTerm])).toEqual([[SYMBOL, "alias", "奧思集團"]]);
    const links = await db.select().from(goldNewsLinks).where(eq(goldNewsLinks.symbol, SYMBOL));
    expect(links.length).toBe(2);
    expect(links.find((l) => l.newsItemId !== item.id)?.matchKinds).toEqual(["industry"]);

    // A second run asks nothing: every window was read.
    googleCalls = [];
    const again = await runDimension(db, newsHistory, { trigger: "test", ctx: ctx() });
    expect(again.sources.reduce((n, s) => n + s.requested, 0)).toBe(0);
    expect(googleCalls).toHaveLength(0);
  });

  it("a 429 is retried, then recorded as a failed window and asked again on the next run only", async () => {
    const q = '"奧思集團" after:2024-05-01 before:2024-06-01';
    const first = await runDimension(db, newsHistory, { trigger: "test", ctx: ctx({ failOnce: new Set([q]) }) });
    expect(first.status).toBe("partial");
    expect(googleCalls.filter((c) => c.q === q)).toHaveLength(3);
    expect(await db.select().from(newsItems).where(eq(newsItems.titleKey, "奧思集團盈警曾挫兩成"))).toHaveLength(0);

    googleCalls = [];
    const second = await runDimension(db, newsHistory, { trigger: "test", ctx: ctx() });
    expect(second.sources[0].requested).toBe(1);
    expect(googleCalls.map((c) => c.q)).toEqual([q]);
    expect(await db.select().from(newsItems).where(eq(newsItems.titleKey, "奧思集團盈警曾挫兩成"))).toHaveLength(1);
    const failed = await db.select().from(fetches).where(and(eq(fetches.dimension, NEWS_HISTORY_DIMENSION), eq(fetches.subject, `${SYMBOL}|alias|2024-05-01|2024-06-01|奧思集團`)));
    expect(failed.map((f) => Boolean(f.error)).sort()).toEqual([false, true]);
  });

  it("a window that fills Google's page is split until it does not", async () => {
    await runDimension(db, newsHistory, { trigger: "test", ctx: ctx({ full: '"莎莎國際" after:2024-06-01 before:2024-07-01' }) });
    const asked = googleCalls.map((c) => c.q).filter((q) => q.startsWith('"莎莎國際" after:2024-06-'));
    expect(asked).toEqual(['"莎莎國際" after:2024-06-01 before:2024-07-01', '"莎莎國際" after:2024-06-01 before:2024-06-16', '"莎莎國際" after:2024-06-16 before:2024-07-01']);
    const [row] = await db.select().from(fetches).where(and(eq(fetches.dimension, NEWS_HISTORY_DIMENSION), eq(fetches.subject, `${SYMBOL}|industry|2024-06-01|2024-07-01|莎莎國際`), isNull(fetches.error)));
    expect((row.payload as { answers: unknown[] }).answers).toHaveLength(2);
  });

});
