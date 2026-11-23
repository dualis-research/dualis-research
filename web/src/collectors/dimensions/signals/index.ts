import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { evidence, fairValues, liveBenchmark, livePositions, narrativeDrivers, signalChanges, signalEvents, signalStates, signals, type GoldEvidence, type GoldKpiDriver, type SignalKind, type Strength, type ThesisReading, type ThesisSide } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { majorUnit } from "../financials/derive";
import { stripDashes } from "../thesis/structure";
import { analysedSymbols } from "../watchlist";
import { trustedDrivers } from "../analysis/price-drivers";
import { narrativeOf, SIDE } from "../analysis/thesis";
import { latestPrice, positionsFromReadings, priceKnownAt } from "@/console/live-test";
import { BENCHMARK } from "../../benchmark";
import { latestTicks, mergeTicks, ticksKnownAt } from "../intraday-price/read";
import type { Bar } from "@/console/portfolio-series";

export const SIGNALS_DIMENSION = "signals";
/** Evidence ids kept on a signal (its strongest reversals). */
const MAX_EVIDENCE = 10;

export type SignalReading = {
  signal: SignalKind;
  strength: Strength;
  side: ThesisSide | null;
  why: string | null;
  theses: ThesisReading[];
  evidenceIds: string[];
  /** The Price Driver whose reversal against the narrative gives the signal (`gold.kpi_drivers.id`), null when none. */
  kpiDriverId?: string | null;
  fairValue: number | null;
  fairValueMethod: string | null;
  fairValueLabel?: string | null;
  currency: string | null;
  quote: number | null;
  quoteDate: string | null;
  gapPct: number | null;
};

/** What the signal reads of a trusted Price Driver: its reversal against the narrative (kpi-reversal). */
export type ReversingDriver = Pick<GoldKpiDriver, "id" | "name" | "rank" | "reversal">;

const STRENGTH_RANK = { strong: 0, weak: 1, none: 2 } as const;
/** The trusted Price Drivers whose reversal the judge read as going AGAINST the narrative of this side, strongest first. */
export function driversAgainst<T extends ReversingDriver>(side: ThesisSide, drivers: T[]): (T & { reversal: NonNullable<T["reversal"]> })[] {
  return drivers
    .filter((k): k is T & { reversal: NonNullable<T["reversal"]> } => !!k.reversal && k.reversal.stance === "against" && k.reversal.side === side && (k.reversal.strength === "strong" || k.reversal.strength === "weak"))
    .sort((a, b) => STRENGTH_RANK[a.reversal.strength] - STRENGTH_RANK[b.reversal.strength] || a.rank - b.rank);
}

/**
 * The signal (Kevin 2026-11-24), from the narrative's side (the analysis decided it) and each trusted Price Driver's
 * reversal (kpi-reversal decided whether it goes against the narrative, and how strongly): the strongest one against it
 * IS the signal, a pessimistic story giving a BUY and an optimistic one a SELL, at that reversal's strength. None
 * against it = no signal. No rule on the price or the fair value: both judges read them.
 */
export function signalFrom(side: ThesisSide | null, drivers: ReversingDriver[]): { signal: SignalKind; strength: Strength; side: ThesisSide | null; why: string | null; kpiDriverId: string | null; effect: ThesisReading["effect"] } {
  if (!side) return { signal: "none", strength: "noise", side: null, why: null, kpiDriverId: null, effect: "noise" };
  const [top] = driversAgainst(side, drivers);
  if (top) return { signal: SIDE[side].signal, strength: top.reversal.strength as Strength, side, why: `${top.name}: ${top.reversal.why}`, kpiDriverId: top.id, effect: "reversal" };
  const withIt = drivers.find((k) => k.reversal?.stance === "with" && k.reversal.side === side);
  return { signal: "none", strength: "noise", side: null, why: drivers.length ? "No price driver is turning against the narrative." : null, kpiDriverId: null, effect: withIt ? "continuation" : "noise" };
}

export function readingOf(
  fv: { value: number; currency: string | null; method: string | null; label?: string | null } | null,
  quote: { close: number; currency: string | null; date: string } | null,
  side: ThesisSide | null,
  drivers: ReversingDriver[],
  evidenceIds: string[] = [],
): SignalReading {
  const q = quote ? majorUnit(quote.close, quote.currency) : null;
  const comparable = !!fv && !!q && (!fv.currency || !q.currency || fv.currency === q.currency);
  const gapPct = comparable && fv!.value > 0 ? q!.price / fv!.value - 1 : null;
  const { effect, ...s } = signalFrom(side, drivers);
  const theses: ThesisReading[] = side ? [{ side, signal: s.strength, effect, strength: s.strength, why: s.why, since: null }] : [];
  return { ...s, evidenceIds: s.signal === "none" ? [] : evidenceIds.slice(0, MAX_EVIDENCE), theses, fairValue: fv?.value ?? null, fairValueMethod: fv?.method ?? null, fairValueLabel: fv?.label ?? null, currency: fv?.currency ?? null, quote: q?.price ?? null, quoteDate: quote?.date ?? null, gapPct };
}

/** A tag's rank: strong before weak (the news behind a signal, strongest first). */
const tagRank = (s: string) => (s === "strong" ? 0 : s === "weak" ? 1 : 2);
/** The news and filings judged as a reversal of the Narrative Driver that speaks of this Price Driver, strongest then newest first. */
export function evidenceBehind(rows: GoldEvidence[], narrativeDriverId: string | null): string[] {
  if (!narrativeDriverId) return [];
  return rows
    .flatMap((e) => e.verdicts.filter((v) => v.driverId === narrativeDriverId && v.effect === "reversal").map((v) => ({ e, v })))
    .sort((a, b) => tagRank(a.v.strength) - tagRank(b.v.strength) || b.e.eventAt.getTime() - a.e.eventAt.getTime())
    .map((x) => x.e.id);
}

export const rulesSource: Source = {
  name: "rules",
  requiredEnv: [],
  covers: () => true,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("signals: needs the database");
    const [[fv], [quote], narrative, drivers] = await Promise.all([
      ctx.db.select().from(fairValues).where(eq(fairValues.symbol, symbol)),
      ctx.db.select().from(gold.quotes).where(eq(gold.quotes.symbol, symbol)),
      narrativeOf(ctx.db, symbol),
      trustedDrivers(ctx.db, symbol),
    ]);
    const side = narrative?.side ?? null;
    const top = signalFrom(side, drivers);
    let evidenceIds: string[] = [];
    if (top.kpiDriverId) {
      const [[nd], rows] = await Promise.all([
        ctx.db.select({ id: narrativeDrivers.id }).from(narrativeDrivers).where(and(eq(narrativeDrivers.symbol, symbol), eq(narrativeDrivers.kpiDriverId, top.kpiDriverId))),
        ctx.db.select().from(evidence).where(eq(evidence.symbol, symbol)),
      ]);
      evidenceIds = evidenceBehind(rows, nd?.id ?? null);
    }
    const reading = readingOf(fv ?? null, quote ? { close: quote.close, currency: quote.currency, date: quote.date } : null, side, drivers, evidenceIds);
    return { request: { symbol, rule: "the strongest trusted Price Driver whose reversal goes against the narrative is the signal; none = no signal", side, drivers: drivers.map((k) => `${k.name}: ${k.reversal ? `${k.reversal.stance ?? "not read against the narrative"} ${k.reversal.strength}` : "no reversal read"}`) }, httpStatus: null, payload: reading };
  },
};

export const signalsDim: Dimension = {
  name: SIGNALS_DIMENSION,
  description: "Signal per ticker from its narrative's side and its trusted Price Drivers' reversals: the strongest one going against the narrative is the signal (a pessimistic story gives a BUY, an optimistic one a SELL), at its strength; none = no signal. Each change after the first reading = a Signal Change with an Update Note.",
  sources: [rulesSource],
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
  const items = to.evidenceIds.length ? (await db.select().from(evidence).where(eq(evidence.symbol, symbol))).filter((e) => to.evidenceIds.includes(e.id)) : [];
  const [profile] = await db.select({ name: gold.companyProfiles.name }).from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol));
  const prompt = [
    `${profile?.name ?? symbol} (${symbol}): the signal moved from ${signalWords(from.signal, from.strength)} to ${signalWords(to.signal, to.strength)}.`,
    // The reading's own why: the Price Driver turning against the narrative (absent when an old note is written again).
    to.why ? `The price driver behind it: ${to.why}` : null,
    "The news behind it:",
    ...(items.length ? items.slice(0, 5).map((e) => `- ${e.eventDay}: ${e.headline}`) : ["- none"]),
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
  return { silverRowsBySource: { rules: changes } };
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
