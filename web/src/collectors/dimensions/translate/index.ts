import { and, eq, isNull, sql } from "drizzle-orm";
import * as gold from "@/db/schema/gold";
import { goldNewsItems, translations } from "@/db/schema/news";
import type { Db } from "@/db/types";
import { firstJsonObject } from "@/llm/judge";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { rebuildGoldFilings } from "../filings";
import { rebuildGoldNews } from "../news/gold";

/**
 * English titles (Kevin 2026-11-25: « all non English news (title, content) must be translated in EN. Included in the
 * emails for Thierry (daily, critical) »). Every news item and filing whose title is written in a non-Latin script
 * (Chinese, Japanese, Korean, Cyrillic, Arabic, Thai...: the local press and registries of the markets we follow) is
 * translated ONCE by Claude, many titles per call; silver.translations keeps each one, and the gold rebuild of news and
 * filings serves the English title with the original beside it. Every reader of a title (console, morning and critical
 * emails, the analysis steps) reads gold, so it reads English. The article TEXT the emails summarise is written into
 * English by the email's own prompts.
 */

export const TRANSLATE_DIMENSION = "translate";
export const TRANSLATE_VERSION = "translate@v1";

/** A title needs translating when it carries a letter of a non-Latin script. */
const FOREIGN = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Greek}]/u;
export const needsTranslation = (title: string): boolean => FOREIGN.test(title);

/** Titles per call, and calls per run: the news-history backlog drains over runs, never the whole subscription at once. */
export const TITLES_PER_CALL = 80;
export const MAX_CALLS_PER_RUN = 6;

export type TitleItem = { kind: "news" | "filing"; itemId: string; title: string };

/** Every gold title written in a non-Latin script with no translation of that exact title yet, newest first. */
export async function pendingTitles(db: Db): Promise<TitleItem[]> {
  const [news, filed, done] = await Promise.all([
    db.select({ id: goldNewsItems.id, title: goldNewsItems.title, at: sql<Date>`coalesce(${goldNewsItems.publishedAt}, ${goldNewsItems.firstSeenAt})` }).from(goldNewsItems).where(isNull(goldNewsItems.titleOriginal)),
    db.select({ id: gold.filings.id, title: gold.filings.title, at: gold.filings.filedAt }).from(gold.filings).where(isNull(gold.filings.titleOriginal)),
    db.select({ kind: translations.kind, itemId: translations.itemId, original: translations.original }).from(translations),
  ]);
  const have = new Set(done.map((d) => `${d.kind}|${d.itemId}|${d.original}`));
  const items = [
    ...news.map((n) => ({ kind: "news" as const, itemId: String(n.id), title: n.title, at: new Date(n.at).getTime() })),
    ...filed.map((f) => ({ kind: "filing" as const, itemId: String(f.id), title: f.title, at: f.at.getTime() })),
  ];
  return items
    .filter((i) => needsTranslation(i.title) && !have.has(`${i.kind}|${i.itemId}|${i.title}`))
    .sort((a, b) => b.at - a.at)
    .map(({ kind, itemId, title }) => ({ kind, itemId, title }));
}

export const SYSTEM = [
  "You translate news headlines and stock exchange filing titles about listed companies into English, for an equity analyst.",
  "Keep company names in their usual English form when one exists (else transliterate), keep tickers, numbers, currencies and dates exact.",
  "Plain, faithful English, the length of the original: no comment, no explanation.",
  'Answer with JSON only, no prose, no code fence: {"<id>": "<English title>", ...}, one entry per id given.',
].join(" ");

export const titlesPrompt = (items: TitleItem[]): string => `Titles (JSON):\n${JSON.stringify(Object.fromEntries(items.map((t, i) => [String(i + 1), t.title])))}`;

/** One translation per title of a call; an id with no string is left pending (asked again next run). */
export function readTitles(items: TitleItem[], answer: string): (TitleItem & { english: string })[] {
  const obj = JSON.parse(firstJsonObject(answer)) as Record<string, unknown>;
  return items.flatMap((t, i) => {
    const got = obj[String(i + 1)];
    return typeof got === "string" && got.trim() ? [{ ...t, english: got.trim() }] : [];
  });
}

/** This run's calls, by subject, filled by `subjects` and read by the source. */
const planned = new Map<string, TitleItem[]>();

export const translateSource: Source = {
  name: "claude",
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  concurrency: 2,
  async fetch(subject: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.complete) throw new Error("translate: no LLM in the collector context (cli.ts sets ctx.complete)");
    const items = planned.get(subject);
    if (!items) throw new Error(`translate: ${subject} was not planned in this run`);
    const { text, model } = await ctx.complete({ system: SYSTEM, prompt: titlesPrompt(items) });
    return { request: { version: TRANSLATE_VERSION, items: items.length }, httpStatus: null, payload: { items, answer: text, model } };
  },
};

export const translateDim: Dimension = {
  name: TRANSLATE_DIMENSION,
  description: "English titles: every non-English news or filing title translated once by Claude; gold serves the English.",
  sources: [translateSource],
  async subjects(db) {
    planned.clear();
    const pending = await pendingTitles(db);
    for (let i = 0; i < pending.length && planned.size < MAX_CALLS_PER_RUN; i += TITLES_PER_CALL) {
      const batch = pending.slice(i, i + TITLES_PER_CALL);
      planned.set(`batch:${batch[0].kind}:${batch[0].itemId}:${batch.length}`, batch);
    }
    return [...planned.keys()];
  },
  async promote(db, fetches): Promise<PromoteResult> {
    let n = 0;
    for (const f of fetches) {
      if (f.error) continue;
      const p = f.payload as { items: TitleItem[]; answer: string; model: string };
      let rows: ReturnType<typeof readTitles>;
      try {
        rows = readTitles(p.items, p.answer);
      } catch (e) {
        // An unreadable answer: its titles stay pending and are asked again next run.
        console.warn(`[translate] unreadable answer for ${p.items.length} titles: ${(e as Error).message}`);
        continue;
      }
      if (rows.length === 0) continue;
      await db
        .insert(translations)
        .values(rows.map((r) => ({ kind: r.kind, itemId: r.itemId, original: r.title, english: r.english, model: p.model, bronzeId: f.id })))
        .onConflictDoUpdate({ target: [translations.kind, translations.itemId], set: { original: sql`excluded.original`, english: sql`excluded.english`, model: sql`excluded.model`, bronzeId: sql`excluded.bronze_id`, createdAt: sql`now()` } });
      n += rows.length;
    }
    if (n > 0) {
      await rebuildGoldNews(db);
      const symbols = await db.selectDistinct({ symbol: gold.filings.symbol }).from(gold.filings).innerJoin(translations, and(eq(translations.kind, "filing"), eq(translations.itemId, sql`${gold.filings.id}::text`)));
      if (symbols.length) await rebuildGoldFilings(db, symbols.map((s) => s.symbol));
    }
    return { silverRowsBySource: { claude: n } };
  },
};
