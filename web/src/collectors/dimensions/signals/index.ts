import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { driverEvents, fairValues, liveBenchmark, livePositions, signalChanges, signalEvents, signalStates, signals, type GoldKpiDriver, type GoldNarrative, type SignalKind, type Strength, type ThesisReading, type ThesisSide } from "@/db/schema/analysis";
import * as silver from "@/db/schema/silver";
import { firstJsonObject } from "@/llm/judge";
import { notesText } from "@/inputs/notes";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { majorUnit } from "../financials/derive";
import { stripDashes } from "@/llm/dashes";
import { analysedSymbols } from "../watchlist";
import { fnv } from "../analysis/facts";
import { trustedDrivers } from "../analysis/price-drivers";
import { holdsNarrative } from "../analysis/prompt";
import { withNotes } from "../kpi-drivers";
import { narrativeOf, SIDE } from "../analysis/thesis";
import { latestPrice, positionsFromReadings, priceKnownAt } from "@/console/live-test";
import { BENCHMARK } from "../../benchmark";
import { latestTicks, mergeTicks, ticksKnownAt } from "../intraday-price/read";
import type { Bar } from "@/console/portfolio-series";

export const SIGNALS_DIMENSION = "signals";
/** Event ids kept on a signal (what the leading Price Driver's reversal reads). */
const MAX_EVIDENCE = 10;

export type SignalReading = {
  signal: SignalKind;
  strength: Strength;
  side: ThesisSide | null;
  why: string | null;
  theses: ThesisReading[];
  evidenceIds: string[];
  /** The Price Driver whose reversal carries the turn, as step E named it (`gold.kpi_drivers.id`), null when none. */
  kpiDriverId?: string | null;
  fairValue: number | null;
  fairValueMethod: string | null;
  fairValueLabel?: string | null;
  currency: string | null;
  quote: number | null;
  quoteDate: string | null;
  gapPct: number | null;
};

/** What step E reads of a Price Driver: step B's confidence, step C's belief, step D's reading. */
export type ReversingDriver = Pick<GoldKpiDriver, "id" | "name" | "rank" | "reversal"> & Partial<Pick<GoldKpiDriver, "level" | "kind" | "marketBelief">>;

const STRENGTH_RANK = { strong: 0, weak: 1, none: 2 } as const;
/** The Price Drivers step D read in reversal against the narrative of this side, strongest first (what the outputs draw). */
export function driversAgainst<T extends ReversingDriver>(side: ThesisSide, drivers: T[]): (T & { reversal: NonNullable<T["reversal"]> })[] {
  return drivers
    .filter((k): k is T & { reversal: NonNullable<T["reversal"]> } => !!k.reversal && k.reversal.stance === "against" && k.reversal.side === side && (k.reversal.strength === "strong" || k.reversal.strength === "weak"))
    .sort((a, b) => STRENGTH_RANK[a.reversal.strength] - STRENGTH_RANK[b.reversal.strength] || a.rank - b.rank);
}

/**
 * Step E of the architecture (docs/architecture.md), the Narrative Reversal: ONE stored LLM judgment per ticker and
 * input. Given step C (the narrative, its side, its confidence, what the market believes about each Price Driver) and
 * step D (each Price Driver's continuation, reversal or noise), is the narrative turning? strong | weak | noise.
 * The Signal is its output: a pessimistic narrative turning = BUY, an optimistic one = SELL, at that confidence.
 */
export const SIGNAL_QUESTION = "signal@v1";
export const SIGNAL_SUBJECT_KIND = "signal";
export type Turning = { strength: Strength; why: string | null; kpiDriverId: string | null };

export const SIGNAL_SYSTEM = [
  "You are the equity research associate of a small-cap long/short analyst. The market tells ONE story about a stock, the narrative, with its side: long = a PESSIMISTIC story (the stock sits below its fair value), short = an OPTIMISTIC story (above it). His edge: catch the moment that narrative TURNS, before the price does.",
  "You are given the narrative, how confidently the market is thought to hold it, and each Price Driver of the stock: how confident we are that the price trades on it, what the market believes about it, and its latest reading against the narrative: in reversal against it (weak or strong), in continuation of it (weak or strong), or noise, with whether the change lasts, how big it is and how much the price already moved.",
  "Question: is the narrative turning? Weigh it as the analyst would: a reversal on the Price Driver the story rests on most says more than one on a side driver; Price Drivers in continuation pull the other way; a reversal the price has fully moved on is no longer ahead of the market; a narrative held with weak confidence turns less surely than one held with strong confidence. Decide yourself, never by counting.",
  "turning = strong (the narrative is clearly turning: act), weak (it may be turning: watch), noise (it is not, or nothing says so). lead = the label of the Price Driver whose reversal carries the turn, copied exactly, null when turning is noise. why = ONE plain sentence of at most 20 words a reader understands at once, naming that Price Driver and its figure. No fair value, no rating, no horizon.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"turning": "strong" | "weak" | "noise", "lead": "P1" | null, "why": string}',
].join("\n");

const TURNINGS: readonly Strength[] = ["strong", "weak", "noise"];

/** Step E's answer, typed; an unknown lead label is dropped, never guessed. Shape errors fail loud. */
export function parseTurning(text: string, labels: Map<string, string>): Turning {
  const o = JSON.parse(firstJsonObject(text)) as Record<string, unknown>;
  if (!TURNINGS.includes(o.turning as Strength)) throw new Error(`signals: turning "${String(o.turning)}" is not strong, weak or noise`);
  if (typeof o.why !== "string" || !o.why.trim()) throw new Error("signals: no why");
  const strength = o.turning as Strength;
  return { strength, why: stripDashes(o.why.trim()), kpiDriverId: strength === "noise" ? null : (labels.get(String(o.lead ?? "").trim()) ?? null) };
}

const STATE_WORDS: Record<string, string> = { "continuing-to-rise": "continuing to rise", "continuing-to-fall": "continuing to fall", "reversing-up": "reversing up", "reversing-down": "reversing down", flat: "flat" };
const READING = { against: "in REVERSAL against the narrative", with: "in CONTINUATION of the narrative", none: "noise" } as const;

/** One Price Driver as step E reads it: steps B, C and D on it. */
function driverLine(label: string, k: ReversingDriver): string {
  const r = k.reversal!;
  const stance = r.stance ?? "none";
  const m = r.magnitude;
  return [
    `${label} ${k.name} (${k.level ?? "unread"} confidence that the price trades on it).`,
    `  The market believes: ${k.marketBelief ?? "the narrative does not rest on it."}`,
    `  Reading: ${READING[stance]}${stance === "none" ? "" : `, ${r.strength}`}. ${r.why}`,
    `  Its own value: ${STATE_WORDS[r.intrinsic.state] ?? r.intrinsic.state}. ${r.intrinsic.why}`,
    `  Leading indicator: ${r.leading.probability}. ${r.leading.why}`,
    `  ${[r.durability && r.durability !== "n-a" ? r.durability : null, m ? `${m.figure}${m.from && m.to ? ` ${m.from} to ${m.to}` : ""}${m.change ? ` (${m.change})` : ""}, ${m.size}` : null, r.pricedIn ? `priced in: ${r.pricedIn}` : null].filter((x) => x !== null).join("; ") || "No size read."}`,
  ].join("\n");
}

export type TurningInput = { symbol: string; company: string; narrative: Pick<GoldNarrative, "side" | "text" | "detail" | "confidence" | "version">; drivers: ReversingDriver[]; notes?: string | null; now?: Date };

/**
 * Step E for one ticker: null (no call) when step C holds no narrative with weak or strong confidence, or step D read
 * no Price Driver against it; else the stored judgment for these exact C and D readings, asked once. Thierry's inputs
 * are in the prompt, outside the key.
 */
export async function turningOf(db: Db, complete: Complete | undefined, x: TurningInput): Promise<Turning | null> {
  if (!holdsNarrative(x.narrative)) return null;
  const read = x.drivers.filter((k) => !!k.reversal && k.reversal.side === x.narrative.side && k.reversal.stance !== undefined);
  if (read.length === 0) return null;
  const labels = new Map(read.map((k, i) => [`P${i + 1}`, k.id]));
  const w = SIDE[x.narrative.side];
  const facts = [
    `Company: ${x.company}`,
    `Step C, the narrative (side ${x.narrative.side}: ${w.story}; held with ${x.narrative.confidence} confidence): ${x.narrative.text}${x.narrative.detail ? ` ${x.narrative.detail}` : ""}`,
    `A reversal against it: ${w.reversal}. A continuation of it: ${w.continuation}.`,
    "",
    "Step D, each Price Driver read against the narrative:",
    ...read.map((k, i) => driverLine(`P${i + 1}`, k)),
  ].join("\n");
  const key = `${SIGNAL_QUESTION}:${fnv(`${x.narrative.version}|${facts}`)}`;
  const j = silver.judgments;
  const [hit] = await db.select().from(j).where(and(eq(j.subjectKind, SIGNAL_SUBJECT_KIND), eq(j.subjectId, x.symbol), eq(j.questionKey, key)));
  if (hit) return parseTurning((hit.raw as { text: string }).text, labels);
  if (!complete) throw new Error("signals: step E needs the LLM (cli.ts sets ctx.complete)");
  const prompt = [facts, ...withNotes(x.notes ?? null), "", "Is the narrative turning?"].join("\n");
  let r = await complete({ system: SIGNAL_SYSTEM, prompt });
  let parsed: Turning;
  try {
    parsed = parseTurning(r.text, labels);
  } catch (err) {
    // One repair ask on an unreadable answer; a second failure is loud.
    r = await complete({ system: SIGNAL_SYSTEM, prompt: `${prompt}\n\nYour previous answer could not be read (${(err as Error).message.slice(0, 200)}). Answer again with valid JSON only, every field of the format.` });
    parsed = parseTurning(r.text, labels);
  }
  await db.insert(j).values({ subjectKind: SIGNAL_SUBJECT_KIND, subjectId: x.symbol, questionKey: key, question: `${SIGNAL_QUESTION}: is the narrative of ${x.symbol} turning?`, verdict: parsed.strength, probability: 1, citedSentence: null, reason: parsed.why, model: r.model, raw: { text: r.text }, createdAt: x.now ?? new Date() }).onConflictDoNothing();
  return parsed;
}

/**
 * The Signal = step E's output: a pessimistic narrative turning gives a BUY, an optimistic one a SELL, at E's confidence;
 * noise, or no step E reading, = no signal. No rule on the price, the fair value or the Price Drivers here.
 */
export function signalFrom(side: ThesisSide | null, turning: Turning | null): { signal: SignalKind; strength: Strength; side: ThesisSide | null; why: string | null; kpiDriverId: string | null; effect: ThesisReading["effect"] } {
  if (!side || !turning || turning.strength === "noise") return { signal: "none", strength: "noise", side: null, why: turning?.why ?? null, kpiDriverId: null, effect: "noise" };
  return { signal: SIDE[side].signal, strength: turning.strength, side, why: turning.why, kpiDriverId: turning.kpiDriverId, effect: "reversal" };
}

export function readingOf(
  fv: { value: number; currency: string | null; method: string | null; label?: string | null } | null,
  quote: { close: number; currency: string | null; date: string } | null,
  side: ThesisSide | null,
  turning: Turning | null,
  evidenceIds: string[] = [],
): SignalReading {
  const q = quote ? majorUnit(quote.close, quote.currency) : null;
  const comparable = !!fv && !!q && (!fv.currency || !q.currency || fv.currency === q.currency);
  const gapPct = comparable && fv!.value > 0 ? q!.price / fv!.value - 1 : null;
  const { effect, ...s } = signalFrom(side, turning);
  const theses: ThesisReading[] = side ? [{ side, signal: s.strength, effect, strength: s.strength, why: s.why, since: null }] : [];
  return { ...s, evidenceIds: s.signal === "none" ? [] : evidenceIds.slice(0, MAX_EVIDENCE), theses, fairValue: fv?.value ?? null, fairValueMethod: fv?.method ?? null, fairValueLabel: fv?.label ?? null, currency: fv?.currency ?? null, quote: q?.price ?? null, quoteDate: quote?.date ?? null, gapPct };
}

/** The events behind a signal: those the leading Price Driver's reversal (step D) cites as its leading indicator (`gold.driver_events` ids), newest first. */
export function eventsBehind(k: Pick<GoldKpiDriver, "reversal"> | undefined): string[] {
  return [...(k?.reversal?.leading.events ?? [])].sort((a, b) => b.day.localeCompare(a.day)).map((e) => e.id);
}

export const SIGNAL_SOURCE = "claude";
export const signalSource: Source = {
  name: SIGNAL_SOURCE,
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("signals: needs the database");
    const [[fv], [quote], narrative, drivers, [profile], notes] = await Promise.all([
      ctx.db.select().from(fairValues).where(eq(fairValues.symbol, symbol)),
      ctx.db.select().from(gold.quotes).where(eq(gold.quotes.symbol, symbol)),
      narrativeOf(ctx.db, symbol),
      trustedDrivers(ctx.db, symbol),
      ctx.db.select().from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol)),
      notesText(ctx.db, symbol),
    ]);
    const company = `${symbol}${profile?.name ? ` (${profile.name})` : ""}${profile?.industry ? `, ${profile.industry}` : ""}. ${profile?.description ?? ""}`.trim();
    // A narrative written before step C gave a confidence: the signal waits for it (a failed fetch, the stored signal stays).
    if (narrative && !narrative.confidence) return { request: { symbol }, httpStatus: null, error: "the narrative has no confidence yet (written before step C read it): the signal waits for the next analysis run" };
    const turning = narrative ? await turningOf(ctx.db, ctx.complete, { symbol, company, narrative, drivers, notes }) : null;
    // The signal's side is the narrative's only when step E read it turning.
    const side = narrative && turning ? narrative.side : null;
    const evidenceIds = eventsBehind(drivers.find((k) => k.id === turning?.kpiDriverId));
    const reading = readingOf(fv ?? null, quote ? { close: quote.close, currency: quote.currency, date: quote.date } : null, side, turning, evidenceIds);
    return {
      request: { symbol, step: "E: given the narrative (C) and each Price Driver's reading (D), is the narrative turning?", side: narrative?.side ?? null, confidence: narrative?.confidence ?? null, turning: turning?.strength ?? "not asked", drivers: drivers.map((k) => `${k.name}: ${k.reversal ? `${k.reversal.stance ?? "not read against the narrative"} ${k.reversal.strength}` : "no reading"}`) },
      httpStatus: null,
      payload: reading,
    };
  },
};

export const signalsDim: Dimension = {
  name: SIGNALS_DIMENSION,
  description: "Step E (docs/architecture.md). Per ticker, ONE stored judgment: given the narrative (C) and each Price Driver's continuation, reversal or noise (D), is the narrative turning? strong, weak or noise. The Signal is its output: a pessimistic narrative turning gives a BUY, an optimistic one a SELL; noise = no signal. Each change after the first reading = a Signal Change with an Update Note.",
  sources: [signalSource],
  subjects: analysedSymbols,
  promote: (db, fetches, ctx) => promoteSignals(db, fetches, ctx.complete),
};

const sameState = (a: { signal: string; strength: string }, b: { signal: string; strength: string }) => a.signal === b.signal && a.strength === b.strength;

/** Bump when the Update Note prompt changes: every past note is written again once (Kevin 2026-11-06: one sentence). */
export const NOTE_VERSION = "note@v2";

export { signalWords } from "@/content/signal-words";
import { signalWords } from "@/content/signal-words";

export const NOTE_SYSTEM = "You write one-line signal notes for a small-cap long/short analyst. Plain English, subject verb complement, one sentence, at most 20 words. No em dash.";

async function updateNote(db: Db, complete: Complete, symbol: string, from: { signal: string; strength: string }, to: { signal: string; strength: string; evidenceIds: string[]; why?: string | null }): Promise<{ text: string; model: string }> {
  const items = to.evidenceIds.length ? await db.select({ day: driverEvents.day, title: driverEvents.title }).from(driverEvents).where(inArray(driverEvents.id, to.evidenceIds)) : [];
  const [profile] = await db.select({ name: gold.companyProfiles.name }).from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol));
  const prompt = [
    `${profile?.name ?? symbol} (${symbol}): the signal moved from ${signalWords(from.signal, from.strength)} to ${signalWords(to.signal, to.strength)}.`,
    // Step E's own why (absent when an old note is written again).
    to.why ? `Why: ${to.why}` : null,
    "The events behind it:",
    ...(items.length ? items.sort((a, b) => b.day.localeCompare(a.day)).slice(0, 5).map((e) => `- ${e.day}: ${e.title.replace(/\s+/g, " ")}`) : ["- none"]),
    "",
    "Write the note: ONE short sentence saying what moved the signal, e.g. \"Q3 beat eases the doubt on the 2026 guide.\" No figures from the fair value, no calculation, no rating, no horizon.",
  ]
    .filter((x) => x !== null)
    .join("\n");
  const r = await complete({ system: NOTE_SYSTEM, prompt });
  return { text: stripDashes(r.text.trim()), model: r.model };
}

/**
 * silver.signal_states: a new row only when a ticker's signal or strength changes; its first row is the baseline
 * (no Signal Change, no note). gold.signals = current state; gold.signal_changes = every later change with its note.
 */
export async function promoteSignals(db: Db, fetches: BronzeFetch[], complete: Complete | undefined, now = new Date()): Promise<PromoteResult> {
  const latest = new Map<string, BronzeFetch>();
  for (const f of fetches.filter((x) => !x.error).sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())) latest.set(f.subject, f);
  let changes = 0;
  for (const [symbol, f] of latest) {
    const reading = f.payload as SignalReading;
    const [last] = await db.select().from(signalStates).where(eq(signalStates.symbol, symbol)).orderBy(desc(signalStates.at)).limit(1);
    if (last && sameState(last, reading)) continue;
    let note: { text: string; model: string } | null = null;
    if (last) {
      if (!complete) throw new Error("signals: a Signal Change needs the LLM for its Update Note (cli.ts sets ctx.complete)");
      note = await updateNote(db, complete, symbol, last, reading);
      changes++;
    }
    await db.insert(signalStates).values({ symbol, signal: reading.signal, strength: reading.strength, evidenceIds: reading.evidenceIds, gapPct: reading.gapPct, at: now, baseline: last ? 0 : 1, updateNote: note?.text ?? null, model: note?.model ?? null, noteVersion: note ? NOTE_VERSION : null });
  }
  // Notes written by an older prompt are written again once, against the state they came from.
  const history = await db.select().from(signalStates).orderBy(signalStates.symbol, signalStates.at);
  for (let i = 1; i < history.length; i++) {
    const [a, b] = [history[i - 1], history[i]];
    if (a.symbol !== b.symbol || b.baseline === 1 || b.noteVersion === NOTE_VERSION) continue;
    if (!complete) throw new Error("signals: rewriting an Update Note needs the LLM (cli.ts sets ctx.complete)");
    const note = await updateNote(db, complete, b.symbol, a, b);
    await db.update(signalStates).set({ updateNote: note.text, model: note.model, noteVersion: NOTE_VERSION }).where(eq(signalStates.id, b.id));
  }
  await rebuildSignalsGold(db, latest);
  return { silverRowsBySource: { [SIGNAL_SOURCE]: changes } };
}

async function rebuildSignalsGold(db: Db, latest: Map<string, BronzeFetch>): Promise<void> {
  const states = await db.select().from(signalStates).orderBy(signalStates.at);
  const bySymbol = new Map<string, (typeof states)[number][]>();
  for (const s of states) bySymbol.set(s.symbol, [...(bySymbol.get(s.symbol) ?? []), s]);
  const current: (typeof signals.$inferInsert)[] = [];
  const changes: (typeof signalChanges.$inferInsert)[] = [];
  for (const [symbol, list] of bySymbol) {
    const f = latest.get(symbol);
    const last = list.at(-1)!;
    if (f) {
      const r = f.payload as SignalReading;
      current.push({ symbol, signal: r.signal, strength: r.strength, side: r.side, why: r.why, theses: r.theses, fairValue: r.fairValue, fairValueMethod: r.fairValueMethod, fairValueLabel: r.fairValueLabel ?? null, currency: r.currency, quote: r.quote, quoteDate: r.quoteDate, gapPct: r.gapPct, evidenceIds: r.evidenceIds, since: last.at });
    }
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      changes.push({ id: b.id, symbol, fromSignal: a.signal, toSignal: b.signal, fromStrength: a.strength, toStrength: b.strength, at: b.at, updateNote: b.updateNote, evidenceIds: b.evidenceIds });
    }
  }
  const { events, positions, benchmark } = await liveTestRows(db, bySymbol);
  await db.transaction(async (tx) => {
    await tx.delete(signalEvents);
    if (events.length) await tx.insert(signalEvents).values(events);
    await tx.delete(livePositions);
    if (positions.length) await tx.insert(livePositions).values(positions);
    await tx.delete(liveBenchmark);
    if (benchmark) await tx.insert(liveBenchmark).values(benchmark);
    if (current.length) {
      await tx.delete(signals);
      await tx.insert(signals).values(current);
    }
    await tx.delete(signalChanges);
    if (changes.length) await tx.insert(signalChanges).values(changes);
  });
}


/**
 * Live test (Kevin 2026-11-09): every signal reading as an event (first one included), the positions following the
 * signal would have held (`positionsFromReadings`) and the S&P 500 bought at the first signal. Prices = the 5-minute bar
 * already closed at each signal, else the last close printed (a weekend signal trades at Friday's close). Reads closes
 * from a week before the first reading and only the 5-minute bars those moments need (Neon egress rule).
 */
async function liveTestRows(db: Db, bySymbol: Map<string, (typeof signalStates.$inferSelect)[]>) {
  const events: (typeof signalEvents.$inferInsert)[] = [];
  for (const [symbol, list] of bySymbol)
    list.forEach((s, i) => events.push({ id: s.id, symbol, at: s.at, signal: s.signal, strength: s.strength, fromSignal: list[i - 1]?.signal ?? null, fromStrength: list[i - 1]?.strength ?? null, updateNote: s.updateNote }));
  const traded = [...bySymbol].filter(([, list]) => list.some((s) => s.signal !== "none")).map(([symbol]) => symbol);
  if (!traded.length) return { events, positions: [], benchmark: null };
  const startAt = new Date(Math.min(...[...bySymbol.values()].map((list) => list[0].at.getTime())));
  const from = new Date(startAt.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const moments = [...traded.flatMap((symbol) => bySymbol.get(symbol)!.map((s) => ({ symbol, at: s.at }))), { symbol: BENCHMARK, at: startAt }];
  const [tickers, rows, quotes, known, latest] = await Promise.all([
    db.select({ symbol: gold.tickers.symbol, market: gold.tickers.market }).from(gold.tickers).where(inArray(gold.tickers.symbol, traded)),
    db
      .select({ symbol: gold.priceBars.symbol, date: gold.priceBars.date, close: gold.priceBars.close })
      .from(gold.priceBars)
      .where(and(inArray(gold.priceBars.symbol, [...traded, BENCHMARK]), gte(gold.priceBars.date, from)))
      .orderBy(asc(gold.priceBars.date)),
    db.select({ symbol: gold.quotes.symbol, currency: gold.quotes.currency }).from(gold.quotes).where(inArray(gold.quotes.symbol, traded)),
    ticksKnownAt(db, moments),
    latestTicks(db, [...traded, BENCHMARK]),
  ]);
  const ticks = mergeTicks(known, latest);
  const market = new Map(tickers.map((t) => [t.symbol, t.market as string]));
  const currency = new Map(quotes.map((q) => [q.symbol, q.currency]));
  const bars = new Map<string, Bar[]>();
  for (const b of rows) bars.set(b.symbol, [...(bars.get(b.symbol) ?? []), { date: b.date, close: b.close }]);
  const positions: (typeof livePositions.$inferInsert)[] = [];
  for (const symbol of traded) {
    const m = market.get(symbol);
    // A ticker dropped from the watchlist keeps its events; with no market there is no close time to trade at.
    if (!m) continue;
    for (const p of positionsFromReadings(symbol, bySymbol.get(symbol)!, bars.get(symbol) ?? [], m, ticks.get(symbol) ?? [])) positions.push({ ...p, currency: currency.get(symbol) ?? null });
  }
  const spx = bars.get(BENCHMARK) ?? [];
  const base = priceKnownAt(spx, ticks.get(BENCHMARK) ?? [], startAt, "US");
  const mark = latestPrice(spx, ticks.get(BENCHMARK) ?? [], "US");
  const benchmark: typeof liveBenchmark.$inferInsert | null =
    base && mark
      ? { symbol: BENCHMARK, startAt, baseDate: base.date, basePrice: base.price, baseAt: base.at, baseSource: base.source, markDate: mark.date, markPrice: mark.price, markAt: mark.at, markSource: mark.source, rebuiltAt: new Date() }
      : null;
  return { events, positions, benchmark };
}
