import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driverEvents, priceMoves, stockStory } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { promoteStory, tellStory } from "./dimensions/stock-story";

/** Step F · Stock story (Thierry, call 2026-11-26): the significant moves grouped into episodes the AI explains. */
const SYMBOL = "1161.HK";
let db: Db;
let close: () => Promise<void>;

const move = (start: string, end: string, abnormal: number) => ({ id: `${SYMBOL}:${start}`, symbol: SYMBOL, startDay: start, endDay: end, lastStart: start, days: 5, currency: "HKD", closeBefore: 1, closeEnd: 1, returnPct: abnormal, benchReturn: 0.01, abnormal, z: 2.5, beta: 1, direction: (abnormal > 0 ? "up" : "down") as "up" | "down", bench: "Hang Seng" });
const event = (id: string, day: string, moveId: string | null, title: string) => ({ id: `${SYMBOL}|news:${id}`, symbol: SYMBOL, kind: "news" as const, sourceId: id, day, title, url: null, stock: 0, benchReturn: 0, beta: 1, reaction: 0, z: 0, bench: "Hang Seng", moveId });
const bar = (symbol: string, date: string, close: number) => ({ symbol, date, open: close, high: close, low: close, close, volume: 0, sources: ["yahoo"], alternatives: [] });

beforeEach(async () => {
  ({ db, close } = await testDb());
  const now = new Date();
  const y = now.getUTCFullYear();
  await db.insert(priceMoves).values([move(`${y - 2}-05-13`, `${y - 2}-05-20`, -0.2), move(`${y - 2}-05-27`, `${y - 2}-06-03`, -0.1), move(`${y - 1}-03-03`, `${y - 1}-03-10`, 0.12)]);
  await db.insert(driverEvents).values([event("a", `${y - 2}-05-13`, `${SYMBOL}:${y - 2}-05-13`, "Water Oasis issues a profit warning"), event("b", `${y - 1}-03-03`, `${SYMBOL}:${y - 1}-03-03`, "Unrelated chatter")]);
  await db.insert(gold.priceBars).values([bar(SYMBOL, `${y - 2}-05-10`, 2), bar(SYMBOL, `${y - 2}-06-03`, 1.4), bar(SYMBOL, `${y - 1}-03-01`, 1.5), bar(SYMBOL, `${y - 1}-03-10`, 1.68), bar("^HSI", `${y - 2}-05-10`, 100), bar("^HSI", `${y - 2}-06-03`, 99)] as never);
});
afterEach(async () => close());

describe("step F, the story of the stock", () => {
  it("groups the moves one story explains, leaves an unexplained one out, computes the figures, asks once", async () => {
    const prompts: string[] = [];
    const complete: Complete = async ({ prompt }) => {
      prompts.push(prompt);
      return { text: JSON.stringify({ episodes: [{ moves: ["M1", "M2"], cause: "company", title: "Profit warning on mainland stores", summary: "A profit warning sank the stock, which kept falling the next week.", events: ["E1", "E9"] }] }), model: "m" };
    };
    const p = await tellStory(db, complete, SYMBOL);
    expect(prompts[0]).toContain("E1");
    expect(prompts[0]).toContain("Water Oasis issues a profit warning");
    expect(p.episodes).toHaveLength(1);
    const [e] = p.episodes;
    expect(e.moveIds).toHaveLength(2);
    expect(e.eventIds).toEqual([`${SYMBOL}|news:a`]);
    expect(e.returnPct).toBeCloseTo(1.4 / 2 - 1);
    expect(e.benchReturn).toBeCloseTo(-0.01);
    await promoteStory(db, [{ error: null, payload: p } as never]);
    const rows = await db.select().from(stockStory).where(eq(stockStory.symbol, SYMBOL));
    expect(rows.map((r) => [r.cause, r.title])).toEqual([["company", "Profit warning on mainland stores"]]);
    // Same moves and events: the stored answer is read back, no second call.
    await tellStory(db, complete, SYMBOL);
    expect(prompts).toHaveLength(1);
  });

  it("a move in two episodes is unreadable: asked once more, then loud", async () => {
    const complete: Complete = async () => ({ text: JSON.stringify({ episodes: [{ moves: ["M1"], cause: "company", title: "t", summary: "s", events: [] }, { moves: ["M1"], cause: "macro", title: "t", summary: "s", events: [] }] }), model: "m" });
    await expect(tellStory(db, complete, SYMBOL)).rejects.toThrow(/two episodes/);
  });
});
