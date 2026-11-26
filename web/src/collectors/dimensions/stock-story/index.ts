import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { driverEvents, priceMoves, STORY_CAUSES, stockStory, type StoryCause } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import { notesText } from "@/inputs/notes";
import type { Complete } from "@/llm/complete";
import { firstJsonObject } from "@/llm/judge";
import { stripDashes } from "@/llm/dashes";
import { HISTORY_YEARS } from "../../history";
import { localIndex } from "../../benchmark";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { fnv } from "../analysis/facts";
import { KIND, once, withNotes } from "../kpi-drivers";
import { analysedSymbols } from "../watchlist";

/**
 * Step F · Stock story (Thierry, call 2026-11-26; Kevin: the last step, after the Signal). The price of `HISTORY_YEARS`
 * told as episodes: the AI reads every significant unbiased 1-week move with the events of its week and its market's own
 * move, groups the moves one story explains (a move may start an episode the next ones only carry on), and writes each
 * episode's cause (company, industry, or macro: Thierry's own reading, the signal never uses it), a title of a few words
 * and one sentence. A move it cannot explain gets no episode. ONE stored judgment per ticker and input (the moves and
 * their events; Thierry's inputs are in the prompt, outside the key). Data in, words out: the code computes every figure.
 */
export const STORY_DIMENSION = "stock-story";
export const STORY_QUESTION = "stock-story@v1";
export const STORY_SUBJECT_KIND = "stock-story";
/** Events of one move shown to the AI: its first ones by day (a week rarely carries more that matter). */
const EVENTS_PER_MOVE = 8;

export const STORY_SYSTEM = [
  "You are the equity research associate of a small-cap long/short analyst. He wants to see, on one chart, the story of a stock: what moved its price and when.",
  "You are given every significant 1-week move of the share price over the years (at least twice its usual 1-week move once its own market is taken out), labelled M1, M2..., oldest first, each with how much its market moved over the same days and the events of its week (results releases, company news, industry news, filings), labelled E1, E2...",
  "Cut the history into episodes. An episode = one story that explains one or several moves: the move it starts with and the moves that only carry it on (the market took time to price the same news). Its cause: company (a fact about the company), industry (a fact about its industry, competitors, suppliers, customers) or macro (the whole market or the economy moved it: its market's own move is large and in the same direction, or the events are about rates, a war, an index). A move no event and no market move explains gets NO episode: leave it out. Never invent a reason the events do not give.",
  "title = at most 8 words, the fact itself (« Profit warning on mainland China stores »). summary = ONE sentence of at most 25 words saying what happened and how the price took it. events = the labels of the events the story rests on (none for a macro episode with no event). Each move sits in at most one episode.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"episodes": [{"moves": ["M3", "M4"], "cause": "company" | "industry" | "macro", "title": string, "summary": string, "events": ["E12"]}]}',
].join("\n");

export type StoryEpisode = { startDay: string; endDay: string; cause: StoryCause; title: string; summary: string; moveIds: string[]; eventIds: string[]; returnPct: number | null; benchReturn: number | null; bench: string };
export type StoryPayload = { symbol: string; episodes: StoryEpisode[] };

const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
type Bar = { date: string; close: number };
/** The close of the last trading day before `day`, and the close on `day` (or the last one before it). */
const closeBefore = (bars: Bar[], day: string) => [...bars].reverse().find((b) => b.date < day)?.close ?? null;
const closeOn = (bars: Bar[], day: string) => [...bars].reverse().find((b) => b.date <= day)?.close ?? null;
const ret = (bars: Bar[], from: string, to: string) => {
  const a = closeBefore(bars, from);
  const b = closeOn(bars, to);
  return a && b ? b / a - 1 : null;
};

/** One ticker: the moves, their events, the AI's episodes; every figure from the stored closes. */
export async function tellStory(db: Db, complete: Complete, symbol: string, now = new Date()): Promise<StoryPayload> {
  const since = new Date(Date.UTC(now.getUTCFullYear() - HISTORY_YEARS, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  const index = localIndex(symbol);
  const [moves, events, stock, idx, [profile], notes] = await Promise.all([
    db.select().from(priceMoves).where(and(eq(priceMoves.symbol, symbol), gte(priceMoves.startDay, since))).orderBy(asc(priceMoves.startDay)),
    db.select().from(driverEvents).where(and(eq(driverEvents.symbol, symbol), isNotNull(driverEvents.moveId))).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select({ date: gold.priceBars.date, close: gold.priceBars.close }).from(gold.priceBars).where(and(eq(gold.priceBars.symbol, symbol), gte(gold.priceBars.date, since))).orderBy(asc(gold.priceBars.date)),
    db.select({ date: gold.priceBars.date, close: gold.priceBars.close }).from(gold.priceBars).where(and(eq(gold.priceBars.symbol, index.symbol), gte(gold.priceBars.date, since))).orderBy(asc(gold.priceBars.date)),
    db.select().from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol)),
    notesText(db, symbol),
  ]);
  if (moves.length === 0) return { symbol, episodes: [] };
  const company = `${symbol}${profile?.name ? ` (${profile.name})` : ""}${profile?.industry ? `, ${profile.industry}` : ""}. ${profile?.description ?? ""}`.trim();
  const moveLabel = new Map(moves.map((m, i) => [`M${i + 1}`, m]));
  const eventLabel = new Map<string, (typeof events)[number]>();
  const blocks = moves.map((m, i) => {
    const mine = events.filter((e) => e.moveId === m.id).slice(0, EVENTS_PER_MOVE);
    const lines = mine.map((e) => {
      const label = `E${eventLabel.size + 1}`;
      eventLabel.set(label, e);
      return `  ${label} ${e.day} ${KIND[e.kind]}: ${e.title.replace(/\s+/g, " ")}`;
    });
    const span = m.startDay === m.endDay ? m.startDay : `${m.startDay} to ${m.endDay}`;
    return [`M${i + 1} ${span}: the stock ${pct(m.returnPct)}, the ${m.bench} ${pct(m.benchReturn)}, ${pct(m.abnormal)} once the market is taken out (${m.z.toFixed(1)}x its usual move)`, ...(lines.length ? lines : ["  no event stored that week"])].join("\n");
  });
  const key = `${STORY_QUESTION}:${fnv(moves.map((m) => `${m.id}|${m.endDay}|${events.filter((e) => e.moveId === m.id).map((e) => e.id).join(",")}`).join("\n"))}`;
  const prompt = [`Company: ${company}`, "", "Significant 1-week moves, oldest first:", blocks.join("\n"), ...withNotes(notes)].join("\n");
  const episodes = await once(db, complete, STORY_SUBJECT_KIND, symbol, key, `${STORY_QUESTION}: the story of ${symbol}`, STORY_SYSTEM, prompt, (text) => {
    const obj = JSON.parse(firstJsonObject(text)) as { episodes?: unknown };
    if (!Array.isArray(obj.episodes)) throw new Error(`stock-story: no episodes array: ${text.slice(0, 200)}`);
    const used = new Set<string>();
    const out: StoryEpisode[] = [];
    for (const x of obj.episodes as Record<string, unknown>[]) {
      const ms = (Array.isArray(x.moves) ? x.moves : []).map((l) => moveLabel.get(String(l))).filter((m): m is (typeof moves)[number] => !!m);
      const cause = String(x.cause) as StoryCause;
      if (ms.length === 0 || !STORY_CAUSES.includes(cause) || typeof x.title !== "string" || !x.title.trim() || typeof x.summary !== "string" || !x.summary.trim()) throw new Error(`stock-story: an episode without moves, cause, title or summary: ${JSON.stringify(x).slice(0, 200)}`);
      for (const m of ms) {
        if (used.has(m.id)) throw new Error(`stock-story: move ${m.startDay} sits in two episodes`);
        used.add(m.id);
      }
      ms.sort((a, b) => a.startDay.localeCompare(b.startDay));
      const startDay = ms[0].startDay;
      const endDay = ms.reduce((d, m) => (m.endDay > d ? m.endDay : d), ms[0].endDay);
      const eventIds = (Array.isArray(x.events) ? x.events : []).map((l) => eventLabel.get(String(l))?.id).filter((id): id is string => !!id);
      out.push({ startDay, endDay, cause, title: stripDashes(x.title.trim()), summary: stripDashes(x.summary.trim()), moveIds: ms.map((m) => m.id), eventIds, returnPct: ret(stock, startDay, endDay), benchReturn: ret(idx, startDay, endDay), bench: ms[0].bench });
    }
    return out.sort((a, b) => a.startDay.localeCompare(b.startDay));
  });
  return { symbol, episodes };
}

export const storySource: Source = {
  name: "claude",
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("stock-story: needs the database");
    if (!ctx.complete) return { request: { symbol }, httpStatus: null, error: "no LLM in this context" };
    const payload = await tellStory(ctx.db, ctx.complete, symbol);
    return { request: { symbol, step: "F: the story of the stock, episodes of its significant moves" }, httpStatus: null, payload };
  },
};

/** gold.stock_story = each ticker's latest successful story, rebuilt whole. */
export async function promoteStory(db: Db, fetches: BronzeFetch[]): Promise<PromoteResult> {
  let rows = 0;
  for (const f of fetches) {
    if (f.error || !f.payload) continue;
    const p = f.payload as StoryPayload;
    await db.transaction(async (tx) => {
      await tx.delete(stockStory).where(eq(stockStory.symbol, p.symbol));
      if (p.episodes.length) await tx.insert(stockStory).values(p.episodes.map((e) => ({ id: `${p.symbol}:${e.startDay}`, symbol: p.symbol, ...e })));
    });
    rows += p.episodes.length;
  }
  // The judgment itself lives in silver.judgments (`once`); gold is rebuilt from the answer.
  return { silverRowsBySource: { claude: rows } };
}

export const stockStoryDim: Dimension = {
  name: STORY_DIMENSION,
  description: "Step F (Thierry 2026-11-26): the story of the stock over 10 years, its significant moves grouped into episodes the AI explains (company, industry or macro), one title and one sentence each, stored once per input.",
  sources: [storySource],
  subjects: analysedSymbols,
  promote: (db, fetches) => promoteStory(db, fetches),
};
