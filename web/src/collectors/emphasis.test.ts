import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { narratives } from "@/db/schema/analysis";
import type { BronzeFetch } from "@/db/schema/bronze";
import { emphasis, goldEmphasis } from "@/db/schema/emphasis";
import type { Db } from "@/db/types";
import { emphasisKey, proseOf, sameWords, stringsOf, swapStrings } from "@/emphasis/emphasis";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { batchesOf, emphasisDim, emphasisSource, MAX_BATCHES_PER_RUN, pendingTexts, readAnswer } from "./dimensions/emphasis";

const NARRATIVE = "The market sees Water Oasis as a flat, mature beauty chain with no way to grow.";
const DETAIL = "Revenue stalled for three years while the stock trades at six times earnings, below its peers.";

describe("emphasis helpers", () => {
  it("accepts a bold copy only when its words are the original's", () => {
    expect(sameWords(NARRATIVE, "The market sees **Water Oasis** as a **flat, mature** beauty chain with **no way to grow**.")).toBe(true);
    expect(sameWords(NARRATIVE, "The market sees **Water Oasis** as a flat beauty chain with no way to grow.")).toBe(false);
  });

  it("reads only the listed prose fields, nested json included, long enough", () => {
    const row = { headline: "A news headline that is long enough to count here", why: NARRATIVE, rows: [{ why: DETAIL, title: "short" }], reason: "too short" };
    expect(proseOf(row, new Set(["why", "reason"]))).toEqual([NARRATIVE, DETAIL]);
  });

  it("swaps every string that has a bold copy, keeps Dates, Maps and the rest", () => {
    const at = new Date("2026-11-23T00:00:00Z");
    const map = new Map([["a", 1]]);
    const v = { narrative: { text: NARRATIVE, asOf: at }, drivers: [{ text: DETAIL }], reactions: map };
    expect(stringsOf(v)).toEqual(new Set([NARRATIVE, DETAIL]));
    const out = swapStrings(v, new Map([[NARRATIVE, "**bold**"]]));
    expect(out.narrative.text).toBe("**bold**");
    expect(out.narrative.asOf).toBe(at);
    expect(out.drivers[0].text).toBe(DETAIL);
    expect(out.reactions).toBe(map);
  });

  it("cuts the backlog into capped calls", () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ key: String(i), text: "x".repeat(100) }));
    const batches = batchesOf(items);
    expect(batches.length).toBe(MAX_BATCHES_PER_RUN);
    expect(batches.every((b) => b.length <= 30)).toBe(true);
  });

  it("keeps a copy that changed a word as a failure, never shown", () => {
    const rows = readAnswer(
      [
        { key: "a", text: NARRATIVE },
        { key: "b", text: DETAIL },
      ],
      JSON.stringify({ "1": NARRATIVE.replace("Water Oasis", "**Water Oasis**"), "2": "Revenue fell." }),
    );
    expect(rows[0]).toMatchObject({ ok: true, emphasized: NARRATIVE.replace("Water Oasis", "**Water Oasis**") });
    expect(rows[1]).toMatchObject({ ok: false });
  });
});

describe("emphasis dimension", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await testDb());
    await db.insert(narratives).values({ id: "1161.HK:long", symbol: "1161.HK", side: "long", text: NARRATIVE, detail: DETAIL, version: "v1", asOf: new Date() });
  });
  afterEach(async () => close());

  it("asks each text once and serves the bold copy by its key", async () => {
    const complete: Complete = async ({ prompt }) => {
      const texts = JSON.parse(prompt.slice(prompt.indexOf("{"))) as Record<string, string>;
      return { model: "fake", text: JSON.stringify(Object.fromEntries(Object.entries(texts).map(([id, t]) => [id, t.replace(/^(\S+ \S+)/, "**$1**")]))) };
    };
    const ctx = { env: {}, fetch, db, complete };
    const subjects = await emphasisDim.subjects(db, ctx);
    expect(subjects).toHaveLength(1);
    const outcome = await emphasisSource.fetch(subjects[0], ctx);
    const fetchRow = { id: "00000000-0000-4000-8000-000000000001", ...outcome, error: null } as unknown as BronzeFetch;
    await emphasisDim.promote(db, [fetchRow], ctx);

    const gold = await db.select().from(goldEmphasis);
    expect(new Map(gold.map((g) => [g.key, g.emphasized])).get(emphasisKey(NARRATIVE))).toBe(`**The market** sees Water Oasis as a flat, mature beauty chain with no way to grow.`);
    expect(await db.select().from(emphasis)).toHaveLength(2);
    // Nothing left to ask: the next run makes no call.
    expect(await pendingTexts(db)).toEqual([]);
    expect(await emphasisDim.subjects(db, ctx)).toEqual([]);
  });
});
