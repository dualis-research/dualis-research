import { inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as analysis from "@/db/schema/analysis";
import * as content from "@/db/schema/content";
import { emphasis, goldEmphasis } from "@/db/schema/emphasis";
import * as valuation from "@/db/schema/valuation";
import type { Db } from "@/db/types";
import { EMPHASIS_SYSTEM, EMPHASIS_VERSION, emphasisKey, emphasisPrompt, proseOf, sameWords } from "@/emphasis/emphasis";
import { firstJsonObject } from "@/llm/judge";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";

/**
 * Bold for skimming (Kevin 2026-11-23: « add bold wherever necessary to make the reading faster for the human »,
 * « Same in ALL text the AI writes, check everywhere »). A second, separate Claude pass over every text the console
 * shows that Claude wrote (narratives, drivers, reasons, explanations, verdicts, valuation and research reports, Ideas):
 * it returns the same text with its key words in `**…**`, once per exact text (`emphasisKey`). The writers and their
 * stored texts stay as they are, so no judgment key, thesis version or published post changes; the console swaps the
 * bold copy in where it shows the text. Texts first seen at the top of a panel go first.
 */

export const EMPHASIS_DIMENSION = "emphasis";

/** Where Claude's prose lives, first-sight texts first; the fields are the prose ones (never a title or a quote). */
export const EMPHASIS_SOURCES: readonly { table: PgTable; fields: readonly string[] }[] = [
  { table: analysis.narratives, fields: ["text", "detail"] },
  { table: analysis.narrativeDrivers, fields: ["summary", "text"] },
  { table: analysis.narrativeStates, fields: ["why", "headline", "reason", "explanation"] },
  { table: analysis.driverConfidence, fields: ["reason", "why"] },
  { table: analysis.kpiDrivers, fields: ["why", "reason", "signalWhy"] },
  { table: analysis.signals, fields: ["why"] },
  { table: analysis.signalChanges, fields: ["updateNote"] },
  { table: analysis.signalEvents, fields: ["updateNote"] },
  { table: analysis.narrativeRationales, fields: ["summary", "text"] },
  { table: analysis.exhibits, fields: ["takeaway"] },
  { table: analysis.priceMoveCauses, fields: ["fact"] },
  { table: analysis.evidence, fields: ["why"] },
  { table: valuation.goldMethodValuations, fields: ["reason", "why", "summary", "report"] },
  { table: valuation.valuationReports, fields: ["summary", "markdown", "why"] },
  { table: analysis.researchReports, fields: ["markdown"] },
  { table: valuation.peers, fields: ["why"] },
  { table: content.goldContentIdeas, fields: ["angle", "why"] },
];

/** One call reads at most this many characters (a research report alone may fill it) and this many texts. */
const BATCH_CHARS = 9000;
const BATCH_TEXTS = 30;
/** Calls per run: the backlog of old texts drains over a few runs, so one run never spends the Claude subscription. */
export const MAX_BATCHES_PER_RUN = 25;

type Item = { key: string; text: string };

/** Every prose text of the sources, once, first-sight first, that has no stored bold copy yet. */
export async function pendingTexts(db: Db): Promise<Item[]> {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const s of EMPHASIS_SOURCES) {
    const fields = new Set(s.fields);
    for (const row of await db.select().from(s.table)) {
      for (const text of proseOf(row, fields)) {
        const key = emphasisKey(text);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ key, text });
      }
    }
  }
  const done = new Set<string>();
  for (let i = 0; i < items.length; i += 1000) {
    const keys = items.slice(i, i + 1000).map((x) => x.key);
    for (const r of await db.select({ key: emphasis.key }).from(emphasis).where(inArray(emphasis.key, keys))) done.add(r.key);
  }
  return items.filter((x) => !done.has(x.key));
}

/** Pending texts cut into calls, at most `MAX_BATCHES_PER_RUN`. */
export function batchesOf(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let cur: Item[] = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length > 0 && (cur.length >= BATCH_TEXTS || chars + it.text.length > BATCH_CHARS)) {
      out.push(cur);
      if (out.length >= MAX_BATCHES_PER_RUN) return out;
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length > 0 && out.length < MAX_BATCHES_PER_RUN) out.push(cur);
  return out;
}

/** This run's batches, by subject (`batch:<first key>:<count>`), filled by `subjects` and read by the source. */
const planned = new Map<string, Item[]>();

export const emphasisSource: Source = {
  name: "claude",
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  concurrency: 3,
  async fetch(subject: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.complete) throw new Error("emphasis: no LLM in the collector context (cli.ts sets ctx.complete)");
    const items = planned.get(subject);
    if (!items) throw new Error(`emphasis: ${subject} was not planned in this run`);
    const ids = items.map((it, i) => ({ id: String(i + 1), text: it.text }));
    const { text, model } = await ctx.complete({ system: EMPHASIS_SYSTEM, prompt: emphasisPrompt(ids) });
    return { request: { version: EMPHASIS_VERSION, keys: items.map((i) => i.key) }, httpStatus: null, payload: { items, answer: text, model } };
  },
};

/** One silver row per text of a call: the bold copy when it kept every character, else a failure with its reason. */
export function readAnswer(items: Item[], answer: string): { key: string; text: string; emphasized: string | null; ok: boolean; error: string | null }[] {
  const obj = JSON.parse(firstJsonObject(answer)) as Record<string, unknown>;
  return items.map((it, i) => {
    const got = obj[String(i + 1)];
    if (typeof got !== "string") return { ...it, emphasized: null, ok: false, error: "no text returned for this id" };
    if (!sameWords(it.text, got)) return { ...it, emphasized: got, ok: false, error: "the bold copy changed characters besides the ** marks" };
    return { ...it, emphasized: got, ok: true, error: null };
  });
}

export async function rebuildEmphasisGold(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(goldEmphasis);
    await tx.execute(sql`insert into gold.emphasis (key, emphasized) select key, emphasized from silver.emphasis where ok and emphasized is not null and emphasized <> text`);
  });
}

export const emphasisDim: Dimension = {
  name: EMPHASIS_DIMENSION,
  description: "Bold for skimming: a second Claude pass puts the key words of every text Claude wrote for the console in bold, once per text.",
  sources: [emphasisSource],
  async subjects(db) {
    planned.clear();
    for (const b of batchesOf(await pendingTexts(db))) planned.set(`batch:${b[0].key}:${b.length}`, b);
    return [...planned.keys()];
  },
  async promote(db, fetches): Promise<PromoteResult> {
    let n = 0;
    for (const f of fetches) {
      if (f.error) continue;
      const p = f.payload as { items: Item[]; answer: string; model: string };
      let rows: ReturnType<typeof readAnswer>;
      try {
        rows = readAnswer(p.items, p.answer);
      } catch (e) {
        // An unreadable answer: every text of the call stays pending and is asked again next run.
        console.warn(`[emphasis] unreadable answer for ${p.items.length} texts: ${(e as Error).message}`);
        continue;
      }
      await db.insert(emphasis).values(rows.map((r) => ({ ...r, model: p.model, bronzeId: f.id }))).onConflictDoNothing();
      n += rows.length;
    }
    await rebuildEmphasisGold(db);
    return { silverRowsBySource: { claude: n } };
  },
};
