import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BronzeFetch } from "@/db/schema/bronze";
import * as gold from "@/db/schema/gold";
import { goldNewsItems, newsItems, newsMentions, translations } from "@/db/schema/news";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { rebuildGoldFilings } from "./dimensions/filings";
import { rebuildGoldNews } from "./dimensions/news/gold";
import { MAX_CALLS_PER_RUN, needsTranslation, pendingTitles, readTitles, TITLES_PER_CALL, translateDim, translateSource } from "./dimensions/translate";

const CHINESE = "東方電熱子公司通過億緯鋰能審廠驗證";
const ENGLISH = "Water Oasis expects FY2026 profit of HK$165-175 million";
const FILING = "通函 - 一般性授權";

describe("translate helpers", () => {
  it("picks titles written in a non-Latin script only", () => {
    expect(needsTranslation(CHINESE)).toBe(true);
    expect(needsTranslation("월덱스 실적")).toBe(true);
    expect(needsTranslation("決算短信")).toBe(true);
    expect(needsTranslation(ENGLISH)).toBe(false);
    expect(needsTranslation("Sa Sa International « Purse Day » 2026 – press conference")).toBe(false);
  });

  it("keeps the ids the answer gave a string, leaves the others pending", () => {
    const items = [
      { kind: "news" as const, itemId: "a", title: CHINESE },
      { kind: "filing" as const, itemId: "b", title: FILING },
    ];
    expect(readTitles(items, JSON.stringify({ "1": "Dongfang Electric Heating unit passes EVE Energy factory audit" }))).toEqual([{ ...items[0], english: "Dongfang Electric Heating unit passes EVE Energy factory audit" }]);
  });
});

describe("translate dimension", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await testDb());
    await db.insert(silver.tickers).values({ symbol: "1161.HK", market: "HK", sources: ["test"], bronzeIds: [] });
    const [zh, en] = await db
      .insert(newsItems)
      .values([
        { title: CHINESE, titleKey: "zh", url: "https://example.com/zh", urls: ["https://example.com/zh"], urlKeys: ["example.com/zh"], publishedAt: new Date("2026-10-29T00:00:00Z"), sources: ["google-news"], bronzeIds: [] },
        { title: ENGLISH, titleKey: "en", url: "https://example.com/en", urls: ["https://example.com/en"], urlKeys: ["example.com/en"], publishedAt: new Date("2026-11-20T00:00:00Z"), sources: ["google-news"], bronzeIds: [] },
      ])
      .returning();
    await db.insert(newsMentions).values([zh, en].map((n) => ({ newsItemId: n.id, tickerSymbol: "1161.HK", matchKind: "name" as const, matchedTerm: "Water Oasis", sources: ["google-news"], bronzeIds: [] })));
    await db.insert(silver.filings).values({ symbol: "1161.HK", registry: "hkex", filingKey: "f1", title: FILING, filedAt: new Date("2026-10-30T00:00:00Z"), language: "zh", sources: ["hkex"], bronzeIds: [] });
    await rebuildGoldNews(db);
    await rebuildGoldFilings(db, ["1161.HK"]);
  });
  afterEach(async () => close());

  it("translates each non-English title once and gold serves the English with the original beside it", async () => {
    let calls = 0;
    const complete: Complete = async ({ prompt }) => {
      calls++;
      const titles = JSON.parse(prompt.slice(prompt.indexOf("{"))) as Record<string, string>;
      return { model: "fake", text: JSON.stringify(Object.fromEntries(Object.entries(titles).map(([id, t]) => [id, t === CHINESE ? "Dongfang Electric Heating unit passes EVE Energy factory audit" : "Circular - general mandate"]))) };
    };
    const ctx = { env: {}, fetch, db, complete };
    expect((await pendingTitles(db)).map((t) => t.title)).toEqual([FILING, CHINESE]);
    const subjects = await translateDim.subjects(db, ctx);
    expect(subjects).toHaveLength(1);
    const outcome = await translateSource.fetch(subjects[0], ctx);
    await translateDim.promote(db, [{ id: "00000000-0000-4000-8000-000000000001", ...outcome, error: null } as unknown as BronzeFetch], ctx);
    expect(calls).toBe(1);

    const news = await db.select().from(goldNewsItems);
    expect(news.find((n) => n.titleOriginal === CHINESE)?.title).toBe("Dongfang Electric Heating unit passes EVE Energy factory audit");
    expect(news.find((n) => n.title === ENGLISH)?.titleOriginal).toBeNull();
    const [filing] = await db.select().from(gold.filings);
    expect(filing).toMatchObject({ title: "Circular - general mandate", titleOriginal: FILING });

    // A later rebuild of news keeps the English; nothing is asked again.
    await rebuildGoldNews(db);
    expect((await db.select().from(goldNewsItems)).find((n) => n.titleOriginal === CHINESE)?.title).toBe("Dongfang Electric Heating unit passes EVE Energy factory audit");
    expect(await pendingTitles(db)).toEqual([]);
    expect(await db.select().from(translations)).toHaveLength(2);
  });

  it("caps the calls of one run", async () => {
    const many = Array.from({ length: TITLES_PER_CALL * (MAX_CALLS_PER_RUN + 2) }, (_, i) => ({ title: `${CHINESE} ${i}`, titleKey: `k${i}`, url: `https://example.com/${i}`, urls: [`https://example.com/${i}`], urlKeys: [`example.com/${i}`], sources: ["google-news"], bronzeIds: [] }));
    for (let i = 0; i < many.length; i += 200) {
      const rows = await db.insert(newsItems).values(many.slice(i, i + 200)).returning();
      await db.insert(newsMentions).values(rows.map((n) => ({ newsItemId: n.id, tickerSymbol: "1161.HK", matchKind: "name" as const, matchedTerm: "Water Oasis", sources: ["google-news"], bronzeIds: [] })));
    }
    await rebuildGoldNews(db);
    const subjects = await translateDim.subjects(db, { env: {}, fetch, db });
    expect(subjects).toHaveLength(MAX_CALLS_PER_RUN);
  });
});
