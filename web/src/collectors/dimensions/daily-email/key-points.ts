import { and, eq, isNull } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { dailyItemTexts, dailyItemVerdicts } from "@/db/schema/daily-email";
import type { Db } from "@/db/types";
import { firstJsonObject } from "@/llm/judge";
import type { FetchOutcome, Source, SourceContext } from "../../types";
import { parseItemSubject, textKind } from "./article";
import { noDash } from "./render";
import { watched } from "./watched";

/**
 * Key points (NEWS-KEY-POINTS-1124, Kevin: « Key summary en 3 bullet points de la news dans le mail »): ONE Claude call
 * per material item writes exactly 3 bullets from the item's TEXT (silver.daily_item_texts), never from its headline;
 * stored once on its verdict (`key_points`). No text = no call, no bullets. An answer with another count fails loud
 * (the bronze row carries it) and the next run asks again.
 */
export const KEY_POINTS_SOURCE = "key-points";
export const POINTS = 3;

export const pointsSubject = (symbol: string, kind: string, itemId: string) => `${symbol}|points|${kind}|${itemId}`;

const SYSTEM = [
  "You read a news article or a company filing for an equity analyst and give him its key points.",
  `Write exactly ${POINTS} bullets on what the text itself says: the facts, figures, who, when. Each bullet one plain sentence of at most 20 words, the most important first.`,
  "Only what the text states: never an opinion, advice, a price target, upside or what the analyst should do. Plain English, never a dash.",
  "If the text is not this article at all (a cookie or subscription wall, a list of other stories), answer {\"points\": []}.",
  `Answer with JSON only, no prose, no code fence: {"points": ["...", "...", "..."]}.`,
].join(" ");

export function pointsPrompt(company: string, symbol: string, title: string, text: string): string {
  return [`Company: ${company} (${symbol})`, `Headline: ${title}`, "", "Text:", text].join("\n");
}

/** The answer -> exactly POINTS bullets (dashes stripped, the copy rule). Throws on any other count. */
export function parsePoints(text: string): string[] {
  const o = JSON.parse(firstJsonObject(text)) as { points?: unknown };
  const points = Array.isArray(o.points) ? o.points.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => noDash(p.trim())) : [];
  if (points.length !== POINTS || (Array.isArray(o.points) && o.points.length !== POINTS)) {
    throw new Error(`key points: expected exactly ${POINTS} bullets, got ${Array.isArray(o.points) ? o.points.length : "none"}: ${text.slice(0, 200)}`);
  }
  return points;
}

export const keyPointsSource: Source = {
  name: KEY_POINTS_SOURCE,
  requiredEnv: [],
  covers: (subject) => subject.split("|")[1] === "points",
  concurrency: 3,
  async fetch(subject: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.complete) throw new Error("key points need the LLM");
    const { symbol, kind, itemId } = parseItemSubject(subject);
    const request = { symbol, kind, itemId };
    const [t] = await ctx.db!.select().from(dailyItemTexts).where(and(eq(dailyItemTexts.kind, textKind(kind)), eq(dailyItemTexts.itemId, itemId), eq(dailyItemTexts.status, "ok")));
    if (!t?.text) return { request, httpStatus: null, error: "no text read for this item: no key points" };
    const [v] = await ctx.db!.select({ title: dailyItemVerdicts.title }).from(dailyItemVerdicts).where(and(eq(dailyItemVerdicts.symbol, symbol), eq(dailyItemVerdicts.kind, kind), eq(dailyItemVerdicts.itemId, itemId)));
    const company = (await watched(ctx.db!)).find((w) => w.symbol === symbol)?.name ?? symbol;
    const r = await ctx.complete({ system: SYSTEM, prompt: pointsPrompt(company, symbol, v?.title ?? "", t.text) });
    try {
      return { request, httpStatus: null, payload: { points: parsePoints(r.text), model: r.model } };
    } catch (err) {
      return { request, httpStatus: null, payloadText: r.text, error: (err as Error).message };
    }
  },
};

/** bronze answers -> the verdict's `key_points`, once: a verdict that already holds bullets keeps them. */
export async function writeKeyPoints(db: Db, fetches: BronzeFetch[]): Promise<number> {
  let written = 0;
  for (const f of fetches.filter((r) => r.source === KEY_POINTS_SOURCE && !r.error && r.payload)) {
    const { symbol, kind, itemId } = parseItemSubject(f.subject);
    const { points } = f.payload as { points: string[] };
    written += (
      await db
        .update(dailyItemVerdicts)
        .set({ keyPoints: points })
        .where(and(eq(dailyItemVerdicts.symbol, symbol), eq(dailyItemVerdicts.kind, kind), eq(dailyItemVerdicts.itemId, itemId), isNull(dailyItemVerdicts.keyPoints)))
        .returning({ s: dailyItemVerdicts.symbol })
    ).length;
  }
  return written;
}
