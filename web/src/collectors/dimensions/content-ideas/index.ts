import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { kpiDrivers, narratives, signalChanges, signals } from "@/db/schema/analysis";
import { reversalHeadline, reversalWord } from "@/content/reversal-words";
import { kpiChange, kpiValue, periodWords } from "../kpi-drivers/steps";
import { type BronzeFetch, fetches } from "@/db/schema/bronze";
import * as content from "@/db/schema/content";
import { companyProfiles, tickers } from "@/db/schema/gold";
import type { Db } from "@/db/types";
import { rebuildGoldIdeas, utcDay } from "@/content/ideas";
import { rebuildPublished } from "@/content/published";
import type { Dimension, PromoteResult, Source } from "../../types";
import {
  IDEAS_PROMPT_VERSION,
  ideasPrompt,
  ideasSystem,
  type Offered,
  type PastPost,
  parseIdeas,
  parseScores,
  SCORES_PROMPT_VERSION,
  scoresPrompt,
  scoresSystem,
  type TickerBrief,
} from "./prompt";

export const IDEAS_DIMENSION = "content-ideas";
export const CLAUDE_SOURCE = "claude";
/** What the Ideas read: Signal Changes of the last two weeks, the publication history of three months. */
const RECENT_DAYS = 14;
const HISTORY_DAYS = 90;
const HISTORY_MAX = 40;
/** Events offered per ticker: the ones its Price Drivers' reversals read, newest first. */
const EVENTS_PER_TICKER = 8;
/** Reported periods shown per Price Driver: the figures a post compares. */
const PERIODS_SHOWN = 4;

/**
 * Every analysed ticker in words, with what an Idea may cite (Kevin 2026-11-24, one chain): the signal, the Signal
 * Changes, each trusted Price Driver (what the market believes about it, its reversal, its latest reported figures) and
 * the events its reversal reads. Never the fair value (Thierry 2026-11-16: not confident in our fair values; an Idea is
 * published, so it rests on reported figures).
 */
export async function tickerBriefs(db: Db, now = new Date()): Promise<TickerBrief[]> {
  const scope = await db.select().from(tickers).where(eq(tickers.analysed, true)).orderBy(asc(tickers.symbol));
  const symbols = scope.map((t) => t.symbol);
  if (symbols.length === 0) return [];
  const since = new Date(now.getTime() - RECENT_DAYS * 86400_000);
  const [names, sigs, narrs, pds, changes] = await Promise.all([
    db.select({ symbol: companyProfiles.symbol, name: companyProfiles.name }).from(companyProfiles).where(inArray(companyProfiles.symbol, symbols)),
    db.select().from(signals).where(inArray(signals.symbol, symbols)),
    db.select().from(narratives).where(inArray(narratives.symbol, symbols)),
    db.select().from(kpiDrivers).where(inArray(kpiDrivers.symbol, symbols)).orderBy(asc(kpiDrivers.rank)),
    db.select().from(signalChanges).where(and(inArray(signalChanges.symbol, symbols), gte(signalChanges.at, since))).orderBy(desc(signalChanges.at)),
  ]);
  const nameOf = new Map(names.map((n) => [n.symbol, n.name]));
  return scope.map((t) => {
    const name = nameOf.get(t.symbol) ?? null;
    const who = name ?? t.symbol;
    const offered: Offered[] = [];
    const s = sigs.find((x) => x.symbol === t.symbol);
    const n = narrs.find((x) => x.symbol === t.symbol);
    if (s) {
      const call = s.signal === "none" ? "no signal" : `${s.signal}, ${s.strength}`;
      offered.push({ ref: `signal:${t.symbol}`, kind: "signal", symbol: t.symbol, label: `${who}: ${call}`, detail: `Signal: ${call}. Narrative: ${n?.text ?? "not written yet"}` });
    }
    for (const c of changes.filter((x) => x.symbol === t.symbol)) {
      const label = `${who}: signal ${c.fromSignal} ${c.fromStrength} to ${c.toSignal} ${c.toStrength} on ${utcDay(c.at)}`;
      offered.push({ ref: `change:${c.id}`, kind: "change", symbol: t.symbol, label, detail: `${label}. ${c.updateNote ?? ""}`.trim() });
    }
    const trusted = pds.filter((k) => k.symbol === t.symbol && (k.level === "strong" || k.level === "weak"));
    for (const k of trusted) {
      const r = k.reversal;
      const figures = k.measure ? k.periods.slice(-PERIODS_SHOWN).map((p) => `${periodWords(p.periodType, p.period)} ${kpiValue(p.value, k.measure!)} (${kpiChange(p.change, p.changeKind)} on a year earlier)`).join("; ") : null;
      const detail = [
        `Price Driver: ${k.name} (${k.level} confidence).`,
        k.marketBelief ? `What the market believes: ${k.marketBelief}` : null,
        figures ? `Reported: ${figures}.` : null,
        r ? `Now: ${reversalWord(r).word}${reversalHeadline(r) ? `, ${reversalHeadline(r)}` : ""}. ${r.why}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      offered.push({ ref: `driver:${k.id}`, kind: "driver", symbol: t.symbol, label: k.name, detail });
    }
    // The events the reversals read: each news item is read once, by the Reversal, and an Idea may rest on it.
    const events = [...new Map(trusted.flatMap((k) => (k.reversal?.leading.events ?? []).map((e) => [e.id, { e, k }] as const))).values()].sort((a, b) => b.e.day.localeCompare(a.e.day));
    for (const { e, k } of events.slice(0, EVENTS_PER_TICKER)) {
      const title = e.title.replace(/\s+/g, " ");
      offered.push({ ref: `event:${e.id}`, kind: "event", symbol: t.symbol, label: title, detail: `${e.day} ${e.kind}: ${title}. Read by the reversal of ${k.name}: ${k.reversal?.leading.why ?? ""}`.trim() });
    }
    return { symbol: t.symbol, name, inPortfolio: t.inPortfolio, position: t.position, offered };
  });
}

/** Publication history, newest first (gold.content_published). */
export async function pastPosts(db: Db, now = new Date()): Promise<PastPost[]> {
  const rows = await db
    .select()
    .from(content.goldContentPublished)
    .where(gte(content.goldContentPublished.publishedAt, new Date(now.getTime() - HISTORY_DAYS * 86400_000)))
    .orderBy(desc(content.goldContentPublished.publishedAt))
    .limit(HISTORY_MAX);
  return rows.map((p) => ({ format: p.format, title: p.title, tickers: p.tickers, publishedAt: p.publishedAt.toISOString() }));
}

type IdeasRequest = { promptVersion: string; model: string; day: string; symbols: string[]; offered: Offered[]; prompt: string };
type ScoresRequest = { promptVersion: string; model: string; ideasBronzeId: string; ideaCount: number; prompt: string };

/** Two kinds of subject: `ideas:<day>` (the day's proposal) and `scores:<bronze id of a proposal>` (its scores). */
export const claudeIdeas: Source = {
  name: CLAUDE_SOURCE,
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  async fetch(subject, ctx) {
    if (!ctx.complete) throw new Error("no LLM in the collector context");
    if (!ctx.db) throw new Error("no database in the collector context");
    const now = new Date();
    if (subject.startsWith("ideas:")) {
      const day = subject.slice("ideas:".length);
      const briefs = await tickerBriefs(ctx.db, now);
      if (briefs.length === 0) throw new Error("no analysed ticker: nothing to propose");
      const offered = briefs.flatMap((b) => b.offered);
      const prompt = ideasPrompt(briefs, await pastPosts(ctx.db, now), day);
      const { text, model } = await ctx.complete({ system: ideasSystem(), prompt });
      const request: IdeasRequest = { promptVersion: IDEAS_PROMPT_VERSION, model, day, symbols: briefs.map((b) => b.symbol), offered, prompt };
      try {
        parseIdeas(text, offered, request.symbols);
      } catch (err) {
        return { request, httpStatus: null, payloadText: text, error: `answer is not usable ideas: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { request, httpStatus: null, payloadText: text };
    }
    if (subject.startsWith("scores:")) {
      const ideasBronzeId = subject.slice("scores:".length);
      const ideas = await proposedIdeas(ctx.db, ideasBronzeId);
      const prompt = scoresPrompt(ideas, await pastPosts(ctx.db, now), utcDay(now));
      const { text, model } = await ctx.complete({ system: scoresSystem(), prompt });
      const request: ScoresRequest = { promptVersion: SCORES_PROMPT_VERSION, model, ideasBronzeId, ideaCount: ideas.length, prompt };
      try {
        parseScores(text, ideas.length);
      } catch (err) {
        return { request, httpStatus: null, payloadText: text, error: `answer is not a full score grid: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { request, httpStatus: null, payloadText: text };
    }
    throw new Error(`unknown subject ${subject}`);
  },
};

/** The Ideas a stored proposal (bronze row) holds, in rank order. */
async function proposedIdeas(db: Db, bronzeId: string) {
  const [row] = await db.select().from(fetches).where(eq(fetches.id, bronzeId));
  if (!row || row.error) throw new Error(`proposal ${bronzeId} not found or failed`);
  const req = row.request as IdeasRequest;
  return parseIdeas(row.payloadText ?? "", req.offered, req.symbols);
}

/** Today's proposal when none succeeded yet; else the scores of any proposal still without a full score grid. */
export async function pickIdeaSubjects(db: Db): Promise<string[]> {
  await rebuildPublished(db);
  const day = utcDay(new Date());
  const ok = await db
    .select({ id: fetches.id, subject: fetches.subject })
    .from(fetches)
    .where(and(eq(fetches.dimension, IDEAS_DIMENSION), isNull(fetches.error), gte(fetches.fetchedAt, new Date(Date.now() - 3 * 86400_000))));
  const proposals = ok.filter((r) => r.subject.startsWith("ideas:"));
  const scored = new Set(ok.filter((r) => r.subject.startsWith("scores:")).map((r) => r.subject.slice("scores:".length)));
  const out = proposals.filter((p) => !scored.has(p.id)).map((p) => `scores:${p.id}`);
  if (!proposals.some((p) => p.subject === `ideas:${day}`)) out.unshift(`ideas:${day}`);
  return out;
}

/** Round 1: score the proposals this run just made. */
async function expandToScores(_db: Db, soFar: BronzeFetch[], round: number): Promise<string[]> {
  if (round !== 1) return [];
  return soFar.filter((f) => !f.error && f.subject.startsWith("ideas:")).map((f) => `scores:${f.id}`);
}

/** Bronze proposals -> silver.content_ideas; bronze score grids -> silver.content_idea_scores; then gold.content_ideas. */
export async function promoteIdeas(db: Db, rows: BronzeFetch[]): Promise<PromoteResult> {
  let n = 0;
  const ok = rows.filter((r) => !r.error && r.source === CLAUDE_SOURCE);
  for (const f of ok.filter((r) => r.subject.startsWith("ideas:"))) {
    const req = f.request as IdeasRequest;
    const ideas = parseIdeas(f.payloadText ?? "", req.offered, req.symbols);
    const inserted = await db
      .insert(content.contentIdeas)
      .values(ideas.map((i, rank) => ({ generationBronzeId: f.id, rank: rank + 1, day: req.day, symbol: i.symbol, title: i.title, angle: i.angle, sourceRefs: i.sources, model: req.model, sources: [CLAUDE_SOURCE], bronzeIds: [f.id] })))
      .onConflictDoNothing()
      .returning({ id: content.contentIdeas.id });
    n += inserted.length;
  }
  for (const f of ok.filter((r) => r.subject.startsWith("scores:"))) {
    const req = f.request as ScoresRequest;
    const ideas = await db.select().from(content.contentIdeas).where(eq(content.contentIdeas.generationBronzeId, req.ideasBronzeId)).orderBy(asc(content.contentIdeas.rank));
    if (ideas.length !== req.ideaCount) throw new Error(`proposal ${req.ideasBronzeId}: ${ideas.length} ideas in silver, ${req.ideaCount} scored`);
    const scores = parseScores(f.payloadText ?? "", req.ideaCount);
    await db
      .insert(content.contentIdeaScores)
      .values(scores.map((s) => ({ ideaId: ideas[s.idea - 1].id, format: s.format as content.SilverContentDraft["format"], score: s.score, why: s.why, model: req.model, sources: [CLAUDE_SOURCE], bronzeIds: [f.id] })))
      .onConflictDoNothing();
  }
  await rebuildGoldIdeas(db);
  return { silverRowsBySource: { [CLAUDE_SOURCE]: n } };
}

export const contentIdeas: Dimension = {
  name: IDEAS_DIMENSION,
  description: "Ideas worth a post, proposed once a day from the signals, the Price Drivers (belief, reversal, reported figures) and the events their reversals read, and scored per channel and format against what was already published.",
  sources: [claudeIdeas],
  subjects: (db: Db) => pickIdeaSubjects(db),
  expand: expandToScores,
  promote: promoteIdeas,
};
