import { and, desc, eq, like } from "drizzle-orm";
import {
  DURABILITIES,
  kpiDrivers,
  narratives,
  KPI_LEVELS,
  PRICED_IN,
  REVERSAL_STANCES,
  REVERSAL_STATES,
  type DriverReversal,
  type Durability,
  type GoldDriverEvent,
  type GoldKpiDriver,
  type GoldNarrative,
  type KpiLevel,
  type Magnitude,
  type PricedIn,
  type ReversalStance,
  type ReversalState,
  type ThesisSide,
} from "@/db/schema/analysis";
import type { BronzeFetch } from "@/db/schema/bronze";
import * as gold from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { firstJsonObject } from "@/llm/judge";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { fnv } from "../analysis/facts";
import { NO_TRUSTED_DRIVER } from "../analysis";
import { holdsNarrative } from "../analysis/prompt";
import { notesText } from "@/inputs/notes";
import { trustedDrivers } from "../analysis/price-drivers";
import { marketKey, marketLine, narrativeOf, pathLines, priceAndFairValue, SIDE } from "../analysis/thesis";
import { DAY, KIND, storedEvents, withNotes } from "../kpi-drivers";
import { kpiChange, kpiValue, periodWords } from "../kpi-drivers/steps";
import { stripDashes } from "@/llm/dashes";
import { READ_LATEST } from "@/content/reversal-words";
import { analysedSymbols } from "../watchlist";
import { keepPrintedCitations, pagesKey, pagesText, pagesToRead, rawCitations, type RawCitation, type ReadPages } from "./documents";

export * from "./documents";

/**
 * Step D of the architecture (docs/architecture.md), only when step C's narrative confidence is weak or strong: for
 * each Price Driver, the AI reads the narrative and its side, the driver's latest values, the events of the last 180
 * days (industry included: a leading indicator counts) and the company's recent documents, and says whether the driver
 * is in CONTINUATION (weak | strong) of the narrative, in REVERSAL against it (weak | strong; an inflection on a
 * pessimistic story, a crack on an optimistic one), or noise; with its own direction, whether the change lasts, how big
 * it is and how much the price already moved. The judge decides every word; no threshold, no rule from `expected`.
 * Stable on fundamentals (Kevin 2026-11-12): the key holds the facts and the price and fair value in 5% buckets, never
 * today's date or the live price, and the judge reads its own last reading (outside the key). Thierry's inputs are in
 * the prompt, outside the key.
 */

export const REVERSAL_DIMENSION = "kpi-reversal";
/**
 * v4 (Kevin 2026-11-25, step D): continuation (weak | strong), reversal (weak | strong) or noise, read against the
 * narrative; the strength is the judge's on both sides (no clamp by code). v3 gave a strength to a reversal only.
 */
export const REVERSAL_QUESTION = "kpi-reversal@v4";
export const REVERSAL_SUBJECT_KIND = "kpi-reversal";
/** The recent events a leading indicator is read in (news, filings, industry included). */
export const LEADING_DAYS = 180;

export const REVERSAL_SYSTEM = [
  "You are the equity research associate of a small-cap long/short analyst. A Price Driver is a fundamental fact the market has been shown to trade this stock on (a company KPI, a policy, or a qualitative industry fact). The market tells ONE story about the stock, the narrative you are given, with its side: long = a PESSIMISTIC story, short = an OPTIMISTIC story. The analyst's edge: catch the moment a Price Driver TURNS AGAINST that story before the price reacts: an inflection when the story is pessimistic, a crack when it is optimistic.",
  "Read it as a fundamental investor does: what the market believes about a business moves with facts about the business, over weeks and months, never with a day's price.",
  "1) intrinsic: the driver's OWN direction on its latest reported value (up = the KPI rises, or the policy or industry fact turns more favourable to the company). state = continuing-to-rise or continuing-to-fall (it keeps going the way of the periods before), reversing-up or reversing-down (its latest change breaks the direction of the periods before it, or swings by a size that changes the story; up or down = where it goes NOW), flat (no change that matters). period = the period label you read it on (copied exactly), null for a policy or industry fact. why = at most 20 words, with the figures.",
  "2) leading: among the recent events listed (news, filings, the industry included), is there a leading indicator that the driver will change SOON, before the next report prints it (bookings full ahead of the next half's revenue; a competitor closing stores ahead of market share; a policy under consideration)? probability = high / medium / low that the driver turns within the next report, none when no event says anything about it. events = the labels you read it in, copied exactly ([] when none). why = at most 20 words, naming the event's fact.",
  "3) durability: structural = the change lasts as the market projects earnings forward, the business running with no extraordinary circumstance (normalized earnings); temporary = it does not: a one-off contract, a volatile input price, demand pulled forward, over-earning after cutting costs the business needs, a one-off charge; n-a when nothing turns. magnitude = the driver's own figure that changed: from and to with their periods, the change, and size: material (big enough to move the stock: a backlog that doubles) or small (a 3% difference); null when it has no figure or nothing moved.",
  "4) pricedIn: how much of the driver's turn the price has ALREADY moved, read from the price path and where the price sits against the fair value: none, partly, fully.",
  "5) bottom line, against the narrative. stance: read the narrative and what it says the market believes about THIS driver, then say whether the driver (on its own value, or through a leading indicator the analyst would act on) is in REVERSAL against that belief (against: on a pessimistic story things get better than the market believes, on an optimistic one they get worse), in CONTINUATION of it (with: the story gets stronger), or noise (none: nothing moves, or it does not bear on the story). It is your reading of the story's words, never a mechanical rule from the direction. strength = how strong that reversal or continuation is, strong or weak: strong needs a structural AND material change on a driver the market clearly trades on (a weak-confidence driver rarely gives a strong one); a temporary or small change is weak at most; a move of the market at large, a rate, a commodity or trading is noise; noise whenever stance is none. direction = which way the driver itself goes (up or down), null when nothing moves. headline = the driver's state in 4 to 5 words with its key number, like a chart label (« H1 net income down 47% »), null when nothing moves. why = ONE plain sentence of at most 15 words a reader understands at once: the business cause and the figure.",
  "citations = the sentences of the company documents given that your reading rests on, copied EXACTLY as printed, with the label and page each sits on ([] when no document says it).",
  "Leverage is read against earnings (net debt / EBITDA, interest cover), never against the market cap. Decide yourself, as the analyst would; never a fixed threshold. No em dash. JSON only, no prose, no code fence:",
  '{"intrinsic": {"state": "continuing-to-rise" | "continuing-to-fall" | "reversing-up" | "reversing-down" | "flat", "period": string | null, "why": string}, "leading": {"probability": "high" | "medium" | "low" | "none", "events": ["L3"], "why": string}, "durability": "structural" | "temporary" | "n-a", "magnitude": {"figure": "Net income", "from": "HK$60M, 6 months to Mar-24", "to": "HK$32M, 6 months to Mar-25", "change": "-47%", "size": "material" | "small"} | null, "pricedIn": "none" | "partly" | "fully", "stance": "against" | "with" | "none", "strength": "strong" | "weak" | "noise", "direction": "up" | "down" | null, "headline": string | null, "why": string, "citations": [{"doc": "D1", "page": 3, "quote": "<exact words>"}]}',
].join("\n");

const words = (x: unknown, what: string) => {
  if (typeof x !== "string" || !x.trim()) throw new Error(`kpi-reversal: no ${what}`);
  return stripDashes(x.trim());
};
const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "null" ? stripDashes(v.trim()) : null);

export type ReversalContext = {
  /** The narrative side the reading was made against. */
  side: ThesisSide;
  /** Recent events by the label the prompt gave them (`L1`..): unknown labels are dropped, never guessed. */
  labels: Map<string, GoldDriverEvent>;
  /** The driver's period keys: a period the answer names is kept only when it is one of them. */
  periods: Set<string>;
  /** False for a policy or an industry fact: it has no figure, so no magnitude. */
  measured: boolean;
};

/** The answer, typed; its citations as written (`keepPrintedCitations` then checks each on its page). Shape errors fail loud. */
export function parseReversal(text: string, ctx: ReversalContext): { reversal: DriverReversal; cited: RawCitation[] } {
  const obj = JSON.parse(firstJsonObject(text)) as Record<string, unknown>;
  const i = (obj.intrinsic ?? {}) as Record<string, unknown>;
  const l = (obj.leading ?? {}) as Record<string, unknown>;
  if (!REVERSAL_STATES.includes(i.state as ReversalState)) throw new Error(`kpi-reversal: intrinsic state "${String(i.state)}" is not one of ${REVERSAL_STATES.join(", ")}`);
  if (l.probability !== "high" && l.probability !== "medium" && l.probability !== "low" && l.probability !== "none") throw new Error(`kpi-reversal: leading probability "${String(l.probability)}"`);
  // The architecture's word is « noise »; the stored strength keeps `none`.
  if (obj.strength === "noise") obj.strength = "none";
  if (!KPI_LEVELS.includes(obj.strength as KpiLevel)) throw new Error(`kpi-reversal: strength "${String(obj.strength)}" is not strong, weak or noise`);
  if (!REVERSAL_STANCES.includes(obj.stance as ReversalStance)) throw new Error(`kpi-reversal: stance "${String(obj.stance)}" is not one of ${REVERSAL_STANCES.join(", ")}`);
  const stance = obj.stance as ReversalStance;
  // The strength is the judge's, of the continuation or of the reversal; noise carries none.
  const strength: KpiLevel = stance === "none" ? "none" : (obj.strength as KpiLevel);
  const events = (Array.isArray(l.events) ? l.events : []).map((x) => ctx.labels.get(String(x))).filter((e): e is GoldDriverEvent => !!e);
  const m = obj.magnitude && typeof obj.magnitude === "object" ? (obj.magnitude as Record<string, unknown>) : null;
  const magnitude: Magnitude | null = ctx.measured && m && str(m.figure) ? { figure: str(m.figure)!, from: str(m.from), to: str(m.to), change: str(m.change), size: m.size === "material" ? "material" : "small" } : null;
  return {
    reversal: {
      intrinsic: { state: i.state as ReversalState, why: words(i.why, "intrinsic why"), period: typeof i.period === "string" && ctx.periods.has(i.period) ? i.period : null },
      leading: { probability: l.probability, why: words(l.why, "leading why"), events: [...new Map(events.map((e) => [e.id, { id: e.id, day: e.day, kind: e.kind, title: e.title, sourceId: e.sourceId, url: e.url }])).values()] },
      strength,
      direction: obj.direction === "up" || obj.direction === "down" ? obj.direction : null,
      why: words(obj.why, "bottom line"),
      side: ctx.side,
      stance,
      turn: stance === "against" && strength !== "none" ? SIDE[ctx.side].turn : null,
      headline: str(obj.headline),
      durability: DURABILITIES.includes(obj.durability as Durability) ? (obj.durability as Durability) : "n-a",
      magnitude,
      pricedIn: PRICED_IN.includes(obj.pricedIn as PricedIn) ? (obj.pricedIn as PricedIn) : null,
      citations: [],
    },
    cited: rawCitations(obj.citations),
  };
}

const STATE_WORDS: Record<string, string> = { "continuing-to-rise": "continuing to rise", "continuing-to-fall": "continuing to fall", "reversing-up": "reversing up", "reversing-down": "reversing down", flat: "flat" };

/** The judge's own last reading of this driver (any version of the question: a version bump keeps its memory), as one line for its prompt, or null. */
export async function lastReversalReading(db: Db, subjectId: string): Promise<string | null> {
  const j = silver.judgments;
  const [row] = await db.select({ raw: j.raw, createdAt: j.createdAt }).from(j).where(and(eq(j.subjectKind, REVERSAL_SUBJECT_KIND), eq(j.subjectId, subjectId), like(j.questionKey, "kpi-reversal@%"))).orderBy(desc(j.createdAt)).limit(1);
  if (!row) return null;
  try {
    const o = JSON.parse(firstJsonObject((row.raw as { text: string }).text)) as Record<string, unknown>;
    const state = String((o.intrinsic as Record<string, unknown> | undefined)?.state ?? "");
    return `Your last reading, on ${row.createdAt.toISOString().slice(0, 10)}: ${STATE_WORDS[state] ?? state}, ${String(o.stance)} the story, strength ${String(o.strength)}${typeof o.durability === "string" && o.durability !== "n-a" ? `, ${o.durability}` : ""}. ${typeof o.why === "string" ? o.why : ""}`.trim();
  } catch {
    return null;
  }
}

export type ReversalInput = {
  symbol: string;
  company: string;
  narrative: Pick<GoldNarrative, "side" | "text" | "detail" | "version"> & { confidence?: GoldNarrative["confidence"] };
  /** What the narrative says the market believes about this Price Driver (`gold.kpi_drivers.market_belief`; null before the narrative named it). */
  belief: string | null;
  k: GoldKpiDriver;
  events: GoldDriverEvent[];
  pages: ReadPages;
  market: Awaited<ReturnType<typeof priceAndFairValue>>;
  path: string;
  /** Thierry's inputs on the ticker: in the prompt, outside the key. */
  notes?: string | null;
  now?: Date;
};

/** What the judge reads of the driver itself: a KPI's latest periods, or a policy / industry fact's changes. */
function ownLines(k: GoldKpiDriver): string {
  const m = k.measure;
  if (m) {
    const shown = k.periods.slice(-READ_LATEST);
    return shown.length
      ? shown.map((p) => `${periodWords(p.periodType, p.period)} [${p.period}]: ${kpiValue(p.value, m)} (${kpiChange(p.change, p.changeKind)} on a year earlier)${p.significant ? `, judged a change that matters${p.why ? `: ${p.why}` : ""}` : ""}; first disclosed ${p.releaseDay ?? "in no stored event"}`).join("\n")
      : "No reported value.";
  }
  return k.rows.filter((r) => r.kpiMoved === true).slice(-READ_LATEST).map((r) => `${r.day}: ${r.changeUp ? "more favourable" : "less favourable"}${r.kpiWhy ? `, ${r.kpiWhy}` : ""} (${r.title.replace(/\s+/g, " ")})`).join("\n") || "No change found in 3 years.";
}

/**
 * One Price Driver read against the narrative (step D): one stored reading per input (the narrative, the driver's
 * values, the recent events, the pages read, the price and fair value in 5% buckets). Today's date, the live price and
 * the judge's own last reading are in the prompt, never in the key.
 */
export async function reversalOf(db: Db, complete: Complete, x: ReversalInput): Promise<DriverReversal> {
  const { k, narrative: n } = x;
  const now = x.now ?? new Date();
  const level: KpiLevel = k.level ?? "none";
  const since = new Date(now.getTime() - LEADING_DAYS * DAY).toISOString().slice(0, 10);
  const recent = x.events.filter((e) => e.day >= since);
  const labels = new Map(recent.map((e, i) => [`L${i + 1}`, e]));
  const recentText = recent.map((e, i) => `L${i + 1} ${e.day} ${KIND[e.kind]}: ${e.title.replace(/\s+/g, " ")}`).join("\n");
  const w = SIDE[n.side];
  const facts = [
    `Company: ${x.company}`,
    `The narrative (side ${n.side}: ${w.story}; held with ${n.confidence ?? "unread"} confidence): ${n.text}${n.detail ? ` ${n.detail}` : ""}`,
    x.belief ? `What the market believes about this Price Driver: ${x.belief}` : "The narrative does not rest on this Price Driver.",
    `Reversal against this story: ${w.reversal}. Continuation of it: ${w.continuation}.`,
    "",
    `Price Driver (${k.kind}, ${level} confidence): ${k.name}. ${k.why} When it goes up, the share price should go ${k.expected}.`,
    k.measure ? `Measured as: ${k.measure.label}.` : "No figure: a policy or an industry fact (magnitude = null).",
    "",
    k.measure ? "Its latest reported values, oldest first:" : "When it changed, oldest first:",
    ownLines(k),
    "",
    `Events of the last ${LEADING_DAYS} days, oldest first:`,
    recentText || "none",
  ].join("\n");
  const subjectId = `${x.symbol}:${k.name}`;
  const last = await lastReversalReading(db, subjectId);
  const prompt = [
    facts,
    "",
    `Today: ${now.toISOString().slice(0, 10)}. ${marketLine(x.market)}`,
    "The price path and the fair value over time:",
    x.path,
    "",
    "Company documents (the pages where management explains the period):",
    pagesText(x.pages),
    ...(last ? ["", last] : []),
    ...withNotes(x.notes ?? null),
  ].join("\n");
  const key = `${REVERSAL_QUESTION}:${fnv(`${n.version}|${facts}|${pagesKey(x.pages)}`)}:${fnv(marketKey(x.market))}`;
  const ctx: ReversalContext = { side: n.side, labels, periods: new Set(k.periods.map((p) => p.period)), measured: !!k.measure };
  const j = silver.judgments;
  const read = async (text: string, at: Date): Promise<DriverReversal> => {
    const { reversal, cited } = parseReversal(text, ctx);
    return { ...reversal, citations: await keepPrintedCitations(db, cited, x.pages), judgedAt: at.toISOString() };
  };
  const [hit] = await db.select().from(j).where(and(eq(j.subjectKind, REVERSAL_SUBJECT_KIND), eq(j.subjectId, subjectId), eq(j.questionKey, key)));
  if (hit) return read((hit.raw as { text: string }).text, hit.createdAt);
  let r = await complete({ system: REVERSAL_SYSTEM, prompt });
  let parsed: DriverReversal;
  try {
    parsed = await read(r.text, now);
  } catch (err) {
    // One repair ask on an unreadable answer (as kpi-drivers does); a second failure is loud.
    r = await complete({ system: REVERSAL_SYSTEM, prompt: `${prompt}\n\nYour previous answer could not be read (${(err as Error).message.slice(0, 200)}). Answer again with valid JSON only, every field of the format.` });
    parsed = await read(r.text, now);
  }
  await db.insert(j).values({ subjectKind: REVERSAL_SUBJECT_KIND, subjectId, questionKey: key, question: `${REVERSAL_QUESTION}: is « ${k.name} » of ${x.symbol} turning against the narrative?`, verdict: `${parsed.stance}:${parsed.strength}`, probability: 1, citedSentence: null, reason: parsed.why, model: r.model, raw: { text: r.text }, createdAt: now }).onConflictDoNothing();
  return parsed;
}

export type ReversalPayload = { symbol: string; side: ThesisSide; version: string; reversals: { id: string; name: string; reversal: DriverReversal }[] };

/** Every trusted Price Driver of one ticker, read against its narrative. */
export async function judgeReversals(db: Db, complete: Complete, symbol: string, narrative: GoldNarrative, trusted: GoldKpiDriver[], now = new Date()): Promise<ReversalPayload> {
  const [{ events }, pages, market, path, [profile], notes] = await Promise.all([
    storedEvents(db, symbol),
    pagesToRead(db, symbol, now),
    priceAndFairValue(db, symbol),
    pathLines(db, symbol, now),
    db.select().from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol)),
    notesText(db, symbol),
  ]);
  const company = `${symbol}${profile?.name ? ` (${profile.name})` : ""}${profile?.industry ? `, ${profile.industry}` : ""}. ${profile?.description ?? ""}`.trim();
  const reversals: ReversalPayload["reversals"] = [];
  for (const k of trusted) {
    reversals.push({ id: k.id, name: k.name, reversal: await reversalOf(db, complete, { symbol, company, narrative, belief: k.marketBelief ?? null, k, events, pages, market, path, notes, now }) });
  }
  return { symbol, side: narrative.side, version: narrative.version, reversals };
}

export const reversalSource: Source = {
  name: "claude",
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("kpi-reversal: needs the database");
    if (!ctx.complete) throw new Error("kpi-reversal: no LLM in the collector context (cli.ts sets ctx.complete)");
    const trusted = await trustedDrivers(ctx.db, symbol);
    if (trusted.length === 0) return { request: { symbol }, httpStatus: null, error: NO_TRUSTED_DRIVER.replace(": no narrative is written", ": no reversal to read") };
    const narrative = await narrativeOf(ctx.db, symbol);
    if (!narrative) return { request: { symbol, priceDrivers: trusted.length }, httpStatus: null, error: "no narrative yet: step C writes it on the Price Drivers, a reversal is read against it" };
    // Step D runs only on a narrative held with weak or strong confidence (`reversalSubjects` leaves the others out).
    if (!holdsNarrative(narrative)) return { request: { symbol, confidence: narrative.confidence }, httpStatus: null, error: `narrative confidence ${narrative.confidence ?? "not read yet"}: no reversal is read (step D needs weak or strong)` };
    return { request: { symbol, side: narrative.side, version: narrative.version, priceDrivers: trusted.length }, httpStatus: null, payload: await judgeReversals(ctx.db, ctx.complete, symbol, narrative, trusted) };
  },
};

/** gold.kpi_drivers: each trusted driver's reversal and its bottom line (`signal`, `signalWhy`, `direction`), from this run's latest answer. */
export async function promoteReversals(db: Db, fetches: BronzeFetch[]): Promise<number> {
  const latest = new Map<string, ReversalPayload>();
  for (const f of fetches.filter((x) => !x.error).sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())) latest.set(f.subject, f.payload as ReversalPayload);
  let n = 0;
  for (const p of latest.values()) {
    for (const r of p.reversals) {
      await db
        .update(kpiDrivers)
        .set({ reversal: r.reversal, signal: r.reversal.stance === "against" ? r.reversal.strength : "none", signalWhy: r.reversal.why, ...(r.reversal.direction ? { direction: r.reversal.direction } : {}) })
        .where(and(eq(kpiDrivers.id, r.id), eq(kpiDrivers.symbol, p.symbol)));
      n++;
    }
  }
  return n;
}

/** Step D's subjects: the analysed tickers whose narrative step C holds with weak or strong confidence. */
export async function reversalSubjects(db: Db): Promise<string[]> {
  const [symbols, held] = await Promise.all([analysedSymbols(db), db.select({ symbol: narratives.symbol, confidence: narratives.confidence }).from(narratives)]);
  const ok = new Set(held.filter(holdsNarrative).map((n) => n.symbol));
  return symbols.filter((s) => ok.has(s));
}

export const kpiReversalDim: Dimension = {
  name: REVERSAL_DIMENSION,
  description:
    "Step D (docs/architecture.md), only when the narrative's confidence is weak or strong. Per Price Driver, read against the narrative and its side: continuation (weak or strong), reversal (weak or strong; an inflection or a crack) or noise; with its own direction on its latest value (continuing to rise or fall, reversing up or down, flat), a leading indicator in the events of the last 180 days, whether the change lasts and how big it is, how much the price already moved, and quotes from the company's documents checked on their page. Once per input; the key holds the facts and the price and fair value in 5% buckets.",
  sources: [reversalSource],
  subjects: reversalSubjects,
  promote: async (db, fetches): Promise<PromoteResult> => ({ silverRowsBySource: { claude: await promoteReversals(db, fetches) } }),
};
