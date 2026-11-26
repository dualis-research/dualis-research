import { and, asc, eq, inArray } from "drizzle-orm";
import { CANDIDATE_KINDS, driverEvents, KPI_LEVELS, kpiDrivers, priceMoves, type CandidateKind, type DocCitation, type DriverTests, type GoldDriverEvent, type GoldPriceMove, type KpiEventRow, type KpiLevel, type KpiMeasure, type KpiPeriod } from "@/db/schema/analysis";
import { documentPages } from "@/db/schema/documents";
import * as gold from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { BronzeFetch } from "@/db/schema/bronze";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { firstJsonObject } from "@/llm/judge";
import type { Dimension, FetchOutcome, PromoteResult, Source, SourceContext } from "../../types";
import { fnv } from "../analysis/facts";
import { seriesCatalog, type StoredSeries } from "../analysis/series";
import { verifyQuote } from "../filing-documents/read";
import { stripDashes } from "@/llm/dashes";
import { notesText } from "@/inputs/notes";
import { analysedSymbols } from "../watchlist";
import { changeRows, driverTests, eventRows, kpiChange, kpiPeriods, kpiValue, measureKpi, parseFormula, periodEnd, periodWords, type CandidateChange, type JudgedMove } from "./steps";
import { HISTORY_YEARS } from "@/collectors/history";

export * from "./steps";

/**
 * Steps A and B of the architecture (docs/architecture.md, Kevin 2026-11-25), per ticker, on the events and the
 * significant unbiased 1-week moves `market-reaction` stored:
 * A) Price Driver Candidates: each event whose week was a significant unbiased move is READ by the AI, which deduces the
 *    fundamental KPIs (or repeatable policies, industry facts) that may have driven it. Every such move is valid: no
 *    « fundamental or market? » filter (rejected).
 * B) Price Drivers: when each candidate changed (code for a KPI, its changes judged by the AI; the AI for a policy or
 *    industry fact), then two tests counted by code (each significant move: did the candidate change on its first day?
 *    each significant change: was the week after a significant move?), all given to the AI, which decides the
 *    confidence strong | weak | noise (stored `none`).
 * Thierry's inputs on the ticker are in every prompt, outside every key (context, never an override).
 */

export const KPI_DIMENSION = "kpi-drivers";
export const KPI_YEARS = HISTORY_YEARS;
/**
 * v5 (Kevin 2026-11-25, step A): candidates are deduced ONLY from the events whose week was a significant unbiased
 * move, every such move valid (an industry news included, no macro filter); no KPI added from the business model alone.
 * v6 (Kevin 2026-11-26): whatever the company reports as a figure is a kpi; policy / industry only for what no figure
 * measures. v5's prompt gave « a dividend cut » as its example of a policy, so Water Oasis's dividend per share was read
 * as a figure-less policy, its changes looked for in news titles only, and it tested 0-0.
 */
export const CANDIDATES_QUESTION = "kpi-candidates@v6";
/** A policy or industry candidate (no figure): which events carry a change of it, and which way. */
export const CHANGES_QUESTION = "candidate-changes@v1";
/** When nothing stored measures the KPI: its value read in each report, the quote checked on its page. */
export const READ_QUESTION = "kpi-read@v1";
/** Does an event announce, before its report, figures of the period that report covers (a profit warning)? */
export const ANNOUNCES_QUESTION = "event-announces@v1";
/** Which periods' changes matter, and which event first disclosed each (the AI's assessment, never a threshold). */
export const MOVES_QUESTION = "kpi-moves@v1";
/** v6 (Kevin 2026-11-25, step B): the two tests on every significant unbiased move, no week verdict; strong | weak | noise. */
export const VERDICT_QUESTION = "kpi-verdict@v6";
/** A KPI is read over the same 10 years as the events (Thierry 2026-11-26, `HISTORY_YEARS`). */
export const KPI_HISTORY_YEARS = HISTORY_YEARS;
/** The verdict's sentence cut to at most 15 words, same meaning (a meta-task on the finished text). v2: v1 echoed its own instruction once (Water Oasis, Hong Kong and Macau revenue). */
export const REASON_QUESTION = "kpi-reason@v2";
export const REASON_SYSTEM = "You shorten ONE verdict an analyst wrote about a company KPI. Keep its facts and its conclusion (does the stock trade on this KPI, and what moved the price instead), in AT MOST 15 words, plain English. Never describe the task, never ask a question. No dates, no em dash. Answer with the shortened sentence only.";
/** Pages of each report the AI reads (the results discussion first) and how much of each page. */
const PAGES_PER_RELEASE = 2;
const PAGE_CHARS = 3_500;
export const DAY = 86_400_000;

export type KpiCandidate = { name: string; kind: CandidateKind; why: string; expected: "up" | "down"; series: string | null; approximation: string | null; foundIn: string[] };
type Release = { id: string; documentId: string; label: string; day: string; title: string; pages: { page: number; text: string }[] };
type Verdict = { level: KpiLevel; reason: string };

const signedPct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

/** The common objects as stored: the events and the significant unbiased 1-week moves, oldest first. */
export async function storedEvents(db: Db, symbol: string): Promise<{ events: GoldDriverEvent[]; moves: GoldPriceMove[] }> {
  const [events, moves] = await Promise.all([
    db.select().from(driverEvents).where(eq(driverEvents.symbol, symbol)).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select().from(priceMoves).where(eq(priceMoves.symbol, symbol)).orderBy(asc(priceMoves.startDay)),
  ]);
  return { events, moves };
}

/** The releases among the events with their best results pages, labelled R1.. oldest first. */
async function releasesWithPages(db: Db, events: GoldDriverEvent[]): Promise<Release[]> {
  const rel = events.filter((e) => e.kind === "release");
  if (rel.length === 0) return [];
  const pages = await db.select().from(documentPages).where(inArray(documentPages.documentId, rel.map((e) => e.sourceId))).orderBy(asc(documentPages.page));
  return rel.map((e, i) => ({ id: e.id, documentId: e.sourceId, label: `R${i + 1}`, day: e.day, title: e.title, pages: bestPages(pages.filter((p) => p.documentId === e.sourceId)) }));
}

/** The pages most likely to discuss results and KPIs: the ones dense in figures and results words, in page order. */
function bestPages(pages: { page: number; text: string }[]): { page: number; text: string }[] {
  const words = /(results|revenue|sales|margin|order|backlog|utiliz|capacity|매출|영업이익|수주|가동률|실적|売上|営業利益|受注)/gi;
  const score = (t: string) => (t.match(words)?.length ?? 0) + Math.min(20, (t.match(/\d[\d,.]{2,}/g)?.length ?? 0) / 5);
  return [...pages]
    .sort((a, b) => score(b.text) - score(a.text))
    .slice(0, PAGES_PER_RELEASE)
    .sort((a, b) => a.page - b.page)
    .map((p) => ({ page: p.page, text: p.text.slice(0, PAGE_CHARS) }));
}

/**
 * One stored LLM answer per (kind, subject, key): asked once, read back after. Stored only once it parses: an answer
 * that skips a release would otherwise be read back and fail every run after (Worldex, 2026-11-19).
 */
export async function once<T>(db: Db, complete: Complete, kind: string, subjectId: string, key: string, question: string, system: string, prompt: string, parse: (text: string) => Promise<T> | T): Promise<T> {
  const [hit] = await db.select().from(silver.judgments).where(and(eq(silver.judgments.subjectKind, kind), eq(silver.judgments.subjectId, subjectId), eq(silver.judgments.questionKey, key)));
  if (hit) return parse((hit.raw as { text: string }).text);
  let r = await complete({ system, prompt });
  let parsed: T;
  try {
    parsed = await parse(r.text);
  } catch (err) {
    // One repair ask, like the analysis (Worldex 2026-11-20: a 3-year answer came back as unreadable JSON); a second
    // failure is loud, with the answer's size and end so the cause shows (cut off, or an unescaped quote).
    const first = (err as Error).message;
    r = await complete({ system, prompt: `${prompt}\n\nYour previous answer could not be read (${first.slice(0, 200)}). Answer again with valid JSON only: escape every double quote inside a string, keep each why short.` });
    try {
      parsed = await parse(r.text);
    } catch (again) {
      throw new Error(`${(again as Error).message.slice(0, 200)} (answer ${r.text.length} chars, ends: ${JSON.stringify(r.text.slice(-120))})`);
    }
  }
  await db.insert(silver.judgments).values({ subjectKind: kind, subjectId, questionKey: key, question, verdict: "answered", probability: 1, citedSentence: null, reason: null, model: r.model, raw: { text: r.text } }).onConflictDoNothing();
  return parsed;
}

const releasesText = (rs: Release[]) => rs.map((r) => [`${r.label} ${r.day}: ${r.title}`, ...r.pages.map((p) => `  [${r.label} page ${p.page}]\n${p.text}`)].join("\n")).join("\n\n");

export const CANDIDATES_SYSTEM = [
  "You are the equity research associate of a small-cap long/short analyst. You look for the PRICE DRIVER CANDIDATES of one stock: the fundamental KPIs that may drive its price.",
  "You are given every event of 10 years (results release, company news, industry news, filing) whose following week was a significant UNBIASED move of the share price (the market's own move is already taken out), labelled M1, M2... If the unbiased price moved, a price driver moved it: every event listed is valid, an industry news as much as a company one. Never set one aside as macro, market noise or unexplained.",
  "Read each event and deduce the fundamental KPIs that may have driven the move. A candidate is one of three kinds: kpi = a figure of the company (reported, or computed from what it reports: capacity utilization ~ revenue / PP&E for a manufacturer, same-store sales for a retailer, backlog for a contractor); policy = a decision that can happen again and bears on the business, of a kind no figure the company reports measures (a subsidy, a tariff, a licence, a regulation); industry = a qualitative fact of its industry that reaches its figures later (an overhang lifting, a competitor failing, demand shifting). Whatever the company reports as a figure, in its statements or its text (an amount, a per-share amount, a ratio, a count), is a kpi, even when a decision sets it. Never the share price or a valuation multiple.",
  "Every event listed is named by at least one candidate (found). One candidate per fact, named in a few words that stay true over years (« Hong Kong store revenue », never a dated event); several events often share one candidate.",
  "expected = which way the share price should go when the candidate goes UP (a KPI rises; a policy or industry fact turns more favourable): up, or down (costs, debt, inventory days).",
  "found = the M labels where you read it, copied exactly. For a kpi: series = the stored series key that holds it, copied exactly from the list (null when none does; a figure listed both as reported and normalized, one-off items removed, is measured on the normalized one: a one-off is not a change of the business); formula = when no key holds it, a formula of stored keys copied exactly, operators / * + - between spaces, numbers allowed (« line:inventory / line:cost-of-revenue * 365 »), else null; both null = read in the reports. For a policy or industry candidate: series and formula null.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"candidates": [{"name": "Operating margin", "kind": "kpi" | "policy" | "industry", "why": "<at most 15 words: why it moves this business>", "expected": "up" | "down", "found": ["M2"], "series": "metric:operating-margin" | null, "formula": string | null}]}',
].join("\n");

export const READ_SYSTEM = [
  "You read ONE figure in a company's reports for an equity analyst: the KPI named below, as each report prints it.",
  "For every report listed, the value of that KPI for the period the report covers, ONLY when the pages shown print it (or print the two figures it is computed from: then give the computed value and quote one of them). Skip a report that does not.",
  "period = the period's last month YYYY-MM; periodType = half for six months, year for twelve, quarter for three; value = a plain number (a percentage as a percentage: 12.5 for 12.5%); unit = percent | amount | count | multiple; quote = the EXACT words of the page that print it.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"values": [{"report": "R1", "page": 3, "period": "2025-03", "periodType": "half", "value": 12.5, "unit": "percent", "currency": "HKD" | null, "quote": "<exact words>"}]}',
].join("\n");

export const VERDICT_SYSTEM = [
  "You give the confidence level of ONE hypothesis for a small-cap long/short analyst: « this Price Driver Candidate (a company KPI, a policy or a qualitative industry fact) is a Price Driver of this stock ».",
  "You read ONLY what you are given. A significant move = a 1-week (5 trading days) move of the stock at least twice its usual one once its own market is taken out (the unbiased move). Every significant unbiased move is a real move of the price: none is set aside as market or macro.",
  "The table lists every event of 10 years (results release, news, filing): whether the candidate changed significantly then (a KPI: its change on the same period a year earlier, judged big enough to matter, at the event that first disclosed it; a policy or industry fact: the event carries a change of it), the unbiased price move over the 1 week after, and the result: confirms (the candidate changed and a significant move followed the expected way), invalidates (it changed, no significant move followed or it went the other way), other cause (a significant move, the candidate did not change: never against it).",
  "Then the two tests. A) each significant change of the candidate: was the 1 week after it a significant unbiased move, the expected way? A big change the price ignored says the market does not trade on it. B) each significant 1-week move: did the candidate change on the first day of that week? A candidate that explains several moves is worth more; moves it does not explain only mean other drivers exist, never against it.",
  "level: decide it yourself, as the analyst would, never by counting. Weigh each moment: how big the change was, how clear the price move was, whether the event's title says another fact moved the price, how recent it is. A small cap's price is noisy: one contrary moment can be noise, a clean, large change the price ignored says much more. strong = the market clearly trades the stock on this candidate; weak = it does sometimes, or the evidence is thin; noise = it does not.",
  "reason = ONE plain sentence, at most 15 words, a reader understands at once: how the stock reacts to this candidate. When some moments went against it, the same sentence says whether that is normal (another fact moved the price those days) or a real doubt. No dates, no list of figures, no labels.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"level": "strong" | "weak" | "noise", "reason": string}',
].join("\n");

export function parseCandidates(text: string, catalog: Map<string, StoredSeries>, labels: Map<string, string> = new Map()): KpiCandidate[] {
  const obj = JSON.parse(firstJsonObject(text)) as { candidates?: unknown };
  if (!Array.isArray(obj.candidates)) throw new Error(`kpi-drivers: answer has no candidates array: ${text.slice(0, 200)}`);
  return obj.candidates.flatMap((k) => {
    const x = k as Record<string, unknown>;
    if (typeof x.name !== "string" || !x.name.trim() || typeof x.why !== "string") return [];
    if (x.expected !== "up" && x.expected !== "down") throw new Error(`kpi-drivers: expected "${String(x.expected)}" for ${x.name}, not up or down`);
    if (!CANDIDATE_KINDS.includes(x.kind as CandidateKind)) throw new Error(`kpi-drivers: kind "${String(x.kind)}" for ${x.name}, not one of ${CANDIDATE_KINDS.join(", ")}`);
    const kind = x.kind as CandidateKind;
    const series = kind === "kpi" && typeof x.series === "string" && catalog.has(x.series) ? x.series : null;
    const formula = kind === "kpi" && !series && typeof x.formula === "string" && parseFormula(x.formula, catalog) ? stripDashes(x.formula.trim()) : null;
    // Unknown labels are dropped, never guessed.
    const foundIn = Array.isArray(x.found) ? [...new Set(x.found.map((l) => labels.get(String(l))).filter((id): id is string => !!id))] : [];
    return [{ name: stripDashes(x.name.trim()), kind, why: stripDashes(x.why.trim()), expected: x.expected, series, approximation: formula, foundIn }];
  });
}

export const CHANGES_SYSTEM = [
  "You read a company's events of 10 years (results releases, news, filings) for an equity analyst, about ONE candidate price driver that is not a figure: a policy or a qualitative industry fact.",
  "For each event that carries a CHANGE of that candidate (it is passed, dropped, eased, tightened, starts, ends, gets clearly better or worse), say which way: up = more favourable to the company, down = less. An event that only mentions it, or repeats what was known, carries no change: leave it out. Never use the share price.",
  "why = at most 12 words: what changed.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"changes": [{"event": "E4", "change": "up" | "down", "why": string}]}',
].join("\n");

/** A policy or industry candidate: one stored reading of which events change it (titles only, never the price). `notes` = Thierry's inputs, in the prompt, outside the key. */
export async function judgeChanges(db: Db, complete: Complete, symbol: string, company: string, k: KpiCandidate, events: GoldDriverEvent[], notes: string | null = null): Promise<Map<string, CandidateChange>> {
  const lines = events.map((e, i) => `E${i + 1} ${e.day} ${KIND[e.kind]}: ${e.title.replace(/\s+/g, " ")}`);
  const ids = new Map(events.map((e, i) => [`E${i + 1}`, e.id]));
  const found = await once(
    db,
    complete,
    "candidate-changes",
    `${symbol}:${k.name}`,
    `${CHANGES_QUESTION}:${fnv(`${k.name}|${k.kind}|${lines.join("\n")}`)}`,
    `${CHANGES_QUESTION}: when did « ${k.name} » change for ${symbol}?`,
    CHANGES_SYSTEM,
    [`Company: ${company}`, `Candidate (${k.kind}): ${k.name}. ${k.why}`, "", "Every event, oldest first:", lines.join("\n"), ...withNotes(notes)].join("\n"),
    (text) => {
      const obj = JSON.parse(firstJsonObject(text)) as { changes?: unknown };
      if (!Array.isArray(obj.changes)) throw new Error(`kpi-drivers: changes answer has no changes array: ${text.slice(0, 200)}`);
      return (obj.changes as Record<string, unknown>[]).flatMap((c) => {
        const id = ids.get(String(c.event));
        if (!id || (c.change !== "up" && c.change !== "down")) return [];
        return [{ id, up: c.change === "up", why: typeof c.why === "string" && c.why.trim() ? stripDashes(c.why.trim()) : null }];
      });
    },
  );
  return new Map(found.map((c) => [c.id, { up: c.up, why: c.why }]));
}

/** A KPI read in the reports: one value per report that prints it, kept only when its quote is printed on its page. */
export async function parseRead(db: Db, text: string, releases: Release[]): Promise<{ measure: KpiMeasure; points: Map<string, number>; cites: Map<string, DocCitation> } | null> {
  const obj = JSON.parse(firstJsonObject(text)) as { values?: unknown };
  if (!Array.isArray(obj.values)) throw new Error(`kpi-drivers: read answer has no values array: ${text.slice(0, 200)}`);
  const byLabel = new Map(releases.map((r) => [r.label, r]));
  const kept: { type: KpiPeriod["periodType"]; period: string; value: number; unit: string; currency: string | null; cite: DocCitation }[] = [];
  for (const v of obj.values as Record<string, unknown>[]) {
    const r = byLabel.get(String(v.report));
    if (!r || typeof v.page !== "number" || typeof v.value !== "number" || typeof v.quote !== "string" || typeof v.period !== "string" || !/^\d{4}-\d{2}$/.test(v.period)) continue;
    if (v.periodType !== "half" && v.periodType !== "year" && v.periodType !== "quarter") continue;
    if (!(await verifyQuote(db, r.documentId, v.page, v.quote))) continue;
    kept.push({ type: v.periodType, period: v.period, value: v.unit === "percent" ? v.value / 100 : v.value, unit: String(v.unit), currency: typeof v.currency === "string" ? v.currency : null, cite: { documentId: r.documentId, page: v.page, quote: v.quote, title: r.title, filedAt: r.day } });
  }
  // The finest period type printed at least twice; a period printed by several reports keeps the first one.
  const type = (["quarter", "half", "year"] as const).find((t) => new Set(kept.filter((k) => k.type === t).map((k) => k.period)).size >= 2);
  if (!type) return null;
  const mine = kept.filter((k) => k.type === type);
  const points = new Map<string, number>();
  const cites = new Map<string, DocCitation>();
  for (const k of mine) {
    if (points.has(k.period)) continue;
    points.set(k.period, k.value);
    cites.set(k.period, k.cite);
  }
  const unit = mine[0].unit === "percent" ? "ratio" : mine[0].unit === "multiple" ? "multiple" : mine[0].unit === "count" ? "count" : "currency";
  return { measure: { source: "reports", label: `Read in the reports, ${type === "half" ? "half years" : type === "year" ? "years" : "quarters"}`, periodType: type, unit, currency: unit === "currency" ? mine[0].currency : null, providers: ["reports"] }, points, cites };
}

/** Thierry's inputs as the last block of a prompt (never part of a key): context the model weighs, never an override. */
export const withNotes = (notes: string | null): string[] => (notes ? ["", notes] : []);

export function parseVerdict(text: string): Verdict {
  const obj = JSON.parse(firstJsonObject(text)) as Record<string, unknown>;
  // The architecture's word is « noise »; the stored level keeps `none`.
  if (obj.level === "noise") obj.level = "none";
  if (!KPI_LEVELS.includes(obj.level as KpiLevel)) throw new Error(`kpi-drivers: level "${String(obj.level)}" is not strong, weak or noise`);
  if (typeof obj.reason !== "string" || !obj.reason.trim()) throw new Error("kpi-drivers: no reason");
  return { level: obj.level as KpiLevel, reason: stripDashes(obj.reason.trim()) };
}

export const ANNOUNCES_SYSTEM = [
  "You read company announcements for an equity analyst. For each one, say whether it discloses, BEFORE the report named beside it, figures of the period that report covers: a profit warning or positive profit alert, inside information on the results, a dividend announcement carrying the period's result, a business update with the period's sales.",
  "announces = true only when the announcement itself carries figures or a direction of that period's results; a board meeting date, a share buyback, a monthly return of equity, a change of director announce nothing. what = at most 12 words, the figure or direction it gives (« net profit for the six months expected to fall about 30% »), null when it announces nothing.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"events": [{"event": "E1", "announces": true, "what": string | null}]}',
].join("\n");

export const MOVES_SYSTEM = [
  "You judge, for a small-cap long/short analyst, when ONE fundamental KPI of a company really moved.",
  "Each period of 10 years is listed with its value, the same period a year earlier and the change. Decide yourself, as the analyst would, whether each change is big enough to matter to the market (his rule of thumb: « if the backlog doubles, it matters; a 3% difference, who cares »). Weigh it against this KPI's own history and what it is (a margin, a revenue line, a share count); never apply a fixed threshold.",
  "first = the event that first told the market THIS KPI's change for that period: an announcement listed before the report only when what it announces carries this KPI (a profit warning carries profit and margins, rarely revenue), else the report. Copy its label exactly.",
  "why = at most 12 words, the size in plain words (« net profit fell 47%, its largest drop in 10 years »).",
  "No em dash. JSON only, no prose, no code fence:",
  '{"periods": [{"period": "P1", "moved": boolean, "why": string, "first": "R3" | "A2"}]}',
].join("\n");

export const KIND = { release: "Results release", news: "News", filing: "Filing" } as const;
const RESULT = { confirms: "confirms", invalidates: "invalidates", "other-cause": "other cause", nothing: "nothing moved" } as const;

/** The event table as the confidence reads it: one line per event, the candidate and the price measured, the result. */
export function tableText(rows: KpiEventRow[], measure: KpiMeasure | null, periods: KpiPeriod[], bench: string): string {
  const byPeriod = new Map(periods.map((p) => [p.period, p]));
  return rows
    .map((r) => {
      const p = r.period ? byPeriod.get(r.period) : undefined;
      const kpi =
        p && measure
          ? `KPI ${periodWords(p.periodType, p.period)}: ${kpiValue(r.from, measure)} a year earlier -> ${kpiValue(r.to, measure)} (${kpiChange(r.change, p.changeKind)}), ${r.kpiMoved ? "moved" : "did not move"}${r.kpiWhy ? `: ${r.kpiWhy}` : ""}`
          : r.kpiMoved === true
            ? `Candidate changed ${r.changeUp ? "up (more favourable)" : "down (less favourable)"}${r.kpiWhy ? `: ${r.kpiWhy}` : ""}`
            : measure
              ? "KPI: not reported at this moment"
              : "Candidate: no change";
      const price = `price ${signedPct(r.reaction)} beyond the ${bench} over 5 trading days${r.z === null ? "" : ` (${Math.abs(r.z).toFixed(1)}x its usual move)`}, ${r.priceMoved ? "a significant unbiased move" : "no significant move"}`;
      return `${r.day} ${KIND[r.kind]}: ${r.title.replace(/\s+/g, " ")}. ${kpi}; ${price}. Result: ${RESULT[r.result]}.`;
    })
    .join("\n");
}

/** The two tests as the confidence reads them, B listing each significant move and the event that changed the candidate in it. */
export function testsText(tests: DriverTests, rows: KpiEventRow[], moves: (JudgedMove & Pick<GoldPriceMove, "startDay" | "endDay" | "abnormal" | "z" | "bench">)[]): string {
  const changedIn = new Map<string, KpiEventRow>();
  for (const r of rows) if (r.kpiMoved === true && r.moveId && !changedIn.has(r.moveId)) changedIn.set(r.moveId, r);
  const moveLines = moves.map((m) => {
    const r = changedIn.get(m.id);
    return `- ${m.startDay} to ${m.endDay}: ${signedPct(m.abnormal)} beyond the ${m.bench} (${Math.abs(m.z).toFixed(1)}x its usual move). Candidate changed on its first day: ${r ? `yes, ${r.day} ${r.title.replace(/\s+/g, " ")}` : "no"}.`;
  });
  return [
    `A) ${tests.changes} significant changes of the candidate: a significant unbiased move followed the expected way in the week after ${tests.followed} times, none did or it went against it ${tests.against} times.`,
    `B) ${tests.moves} significant unbiased 1-week moves: the candidate changed on the first day of ${tests.explained} of them.`,
    ...moveLines,
  ].join("\n");
}

type Announcement = { announces: boolean; what: string | null };

/**
 * A stored reading of each news item and filing that comes before a report (within 120 days, after the one
 * before it): does it announce figures of the period that report covers? One judgment per event, asked in one call
 * for every event not read yet; read back after.
 */
export async function announcementsOf(db: Db, complete: Complete, events: GoldDriverEvent[]): Promise<Map<string, Announcement & { releaseId: string }>> {
  const releases = events.filter((e) => e.kind === "release");
  const candidates = events.flatMap((e) => {
    if (e.kind === "release") return [];
    const next = releases.find((r) => r.day > e.day);
    if (!next || Date.parse(next.day) - Date.parse(e.day) > 120 * DAY) return [];
    return [{ e, next }];
  });
  const key = (c: (typeof candidates)[number]) => `${ANNOUNCES_QUESTION}:${c.next.id}`;
  const out = new Map<string, Announcement & { releaseId: string }>();
  if (candidates.length === 0) return out;
  const stored = await db
    .select()
    .from(silver.judgments)
    .where(and(eq(silver.judgments.subjectKind, "event-announces"), inArray(silver.judgments.subjectId, candidates.map((c) => c.e.id))));
  const hit = new Map(stored.map((j) => [`${j.subjectId}|${j.questionKey}`, j.raw as Announcement]));
  const missing = candidates.filter((c) => !hit.has(`${c.e.id}|${key(c)}`));
  for (let i = 0; i < missing.length; i += 40) {
    const batch = missing.slice(i, i + 40);
    const prompt = batch.map((c, j) => `E${j + 1} ${c.e.day} ${KIND[c.e.kind]}: ${c.e.title.replace(/\s+/g, " ")}. Next report: ${c.next.day} ${c.next.title.replace(/\s+/g, " ")}.`).join("\n");
    const r = await complete({ system: ANNOUNCES_SYSTEM, prompt });
    const obj = JSON.parse(firstJsonObject(r.text)) as { events?: unknown };
    if (!Array.isArray(obj.events)) throw new Error(`kpi-drivers: announcements answer has no events array: ${r.text.slice(0, 200)}`);
    const byLabel = new Map((obj.events as Record<string, unknown>[]).map((x) => [String(x.event), x]));
    const rows = batch.map((c, j) => {
      const x = byLabel.get(`E${j + 1}`);
      if (!x || typeof x.announces !== "boolean") throw new Error(`kpi-drivers: no announcement reading for E${j + 1} (${c.e.title.slice(0, 60)})`);
      const a: Announcement = { announces: x.announces, what: x.announces && typeof x.what === "string" && x.what.trim() ? stripDashes(x.what.trim()) : null };
      hit.set(`${c.e.id}|${key(c)}`, a);
      return { subjectKind: "event-announces", subjectId: c.e.id, questionKey: key(c), question: `${ANNOUNCES_QUESTION}: does « ${c.e.title.slice(0, 120)} » announce figures of « ${c.next.title.slice(0, 120)} »?`, verdict: a.announces ? "yes" : "no", probability: 1, citedSentence: null, reason: a.what, model: r.model, raw: a };
    });
    await db.insert(silver.judgments).values(rows).onConflictDoNothing();
  }
  for (const c of candidates) out.set(c.e.id, { ...hit.get(`${c.e.id}|${key(c)}`)!, releaseId: c.next.id });
  return out;
}

/**
 * The AI half of « when a KPI changed »: which periods' changes matter for this KPI and which event first disclosed each (its report, or
 * an announcement before it). Asked once per KPI and figures; a period the answer skips, or an unknown label, is loud.
 */
export async function judgeKpiMoves(
  db: Db,
  complete: Complete,
  symbol: string,
  company: string,
  k: KpiCandidate,
  periods: KpiPeriod[],
  measure: KpiMeasure,
  events: GoldDriverEvent[],
  announced: Map<string, Announcement & { releaseId: string }>,
  notes: string | null = null,
): Promise<KpiPeriod[]> {
  const asked = periods.filter((p) => p.change !== null);
  if (asked.length === 0) return periods;
  const byId = new Map(events.map((e) => [e.id, e]));
  const labels = new Map<string, string>();
  const label = (id: string, prefix: "R" | "A") => {
    if (!labels.has(id)) labels.set(id, `${prefix}${[...labels.values()].filter((l) => l.startsWith(prefix)).length + 1}`);
    return labels.get(id)!;
  };
  const lines = asked.map((p, i) => {
    const release = p.releaseId ? byId.get(p.releaseId) : undefined;
    const before = release ? [...announced].filter(([id, a]) => a.announces && a.releaseId === release.id && Date.parse(byId.get(id)!.day) > periodEnd(p.period)).map(([id, a]) => ({ e: byId.get(id)!, a })) : [];
    return [
      `P${i + 1} ${periodWords(p.periodType, p.period)}: ${kpiValue(p.value, measure)} vs ${kpiValue(p.prior, measure)} a year earlier (${kpiChange(p.change, p.changeKind)}).`,
      release ? `  Report: ${label(release.id, "R")} ${release.day} ${release.title.replace(/\s+/g, " ")}` : `  Report: none stored (older than ${KPI_YEARS} years)`,
      ...before.map(({ e, a }) => `  Announced before it: ${label(e.id, "A")} ${e.day} ${KIND[e.kind]}: ${e.title.replace(/\s+/g, " ")} (it announces: ${a.what})`),
    ].join("\n");
  });
  const byLabel = new Map([...labels].map(([id, l]) => [l, id]));
  const answer = await once(
    db,
    complete,
    "kpi-moves",
    `${symbol}:${k.name}`,
    `${MOVES_QUESTION}:${fnv(`${k.name}|${lines.join("\n")}`)}`,
    `${MOVES_QUESTION}: when did « ${k.name} » of ${symbol} really move?`,
    MOVES_SYSTEM,
    [`Company: ${company}`, `KPI: ${k.name}. ${k.why}`, `Measured as: ${measure.label}.`, "", "Every period with a year earlier to compare, oldest first:", lines.join("\n"), ...withNotes(notes)].join("\n"),
    (text) => {
      const obj = JSON.parse(firstJsonObject(text)) as { periods?: unknown };
      if (!Array.isArray(obj.periods)) throw new Error(`kpi-drivers: moves answer has no periods array: ${text.slice(0, 200)}`);
      const got = new Map((obj.periods as Record<string, unknown>[]).map((x) => [String(x.period), x]));
      return asked.map((p, i) => {
        const x = got.get(`P${i + 1}`);
        if (!x || typeof x.moved !== "boolean") throw new Error(`kpi-drivers: no reading of P${i + 1} (${p.period}) for ${k.name}`);
        const first = typeof x.first === "string" ? byLabel.get(x.first) : undefined;
        return { period: p.period, moved: x.moved, why: typeof x.why === "string" && x.why.trim() ? stripDashes(x.why.trim()) : null, first: first ?? p.releaseId };
      });
    },
  );
  const by = new Map(answer.map((a) => [a.period, a]));
  return periods.map((p) => {
    const a = by.get(p.period);
    if (!a) return p;
    const first = a.first ? byId.get(a.first) : undefined;
    return { ...p, significant: a.moved, why: a.why, releaseId: first?.id ?? p.releaseId, releaseDay: first?.day ?? p.releaseDay };
  });
}

export type KpiDriverResult = KpiCandidate & Verdict & { measure: KpiMeasure | null; periods: KpiPeriod[]; rows: KpiEventRow[]; tests: DriverTests; direction: "up" | "down" | null };
export type KpiPayload = { symbol: string; drivers: KpiDriverResult[] };

/** The confidence from the event table and the two tests, then its sentence cut to 15 words. */
async function verdictOf(db: Db, complete: Complete, symbol: string, k: KpiCandidate, table: string, tests: string, notes: string | null): Promise<Verdict> {
  const verdict = await once(
    db,
    complete,
    "kpi-verdict",
    `${symbol}:${k.name}`,
    `${VERDICT_QUESTION}:${fnv(`${k.name}|${k.kind}|${k.expected}|${table}|${tests}`)}`,
    `${VERDICT_QUESTION}: does « ${k.name} » move ${symbol}?`,
    VERDICT_SYSTEM,
    [`Candidate (${k.kind}): ${k.name}. When it goes up, the share price should go ${k.expected}.`, "", `Every event of the last ${KPI_YEARS} years, oldest first:`, table, "", "The two tests:", tests, ...withNotes(notes)].join("\n"),
    parseVerdict,
  );
  // The judge writes ~25 words against a 15-word ask (2026-11-23): a second call shortens the finished sentence.
  verdict.reason = await once(
    db,
    complete,
    "kpi-reason",
    `${symbol}:${k.name}`,
    `${REASON_QUESTION}:${fnv(verdict.reason)}`,
    `${REASON_QUESTION}: the verdict on « ${k.name} » in 15 words`,
    REASON_SYSTEM,
    `Verdict to shorten: ${verdict.reason}`,
    (text) => {
      const t = stripDashes(text.trim().replace(/^["«\s]+|["»\s]+$/g, ""));
      if (!t) throw new Error("kpi-drivers: empty short reason");
      return t;
    },
  );
  return verdict;
}

/** One ticker, steps A and B: the candidates read in the events of the significant moves, when each changed, the event table, the two tests and the confidence. */
export async function judgeKpis(db: Db, complete: Complete, symbol: string): Promise<KpiPayload> {
  const { events, moves } = await storedEvents(db, symbol);
  const releases = await releasesWithPages(db, events);
  const catalog = await seriesCatalog(db, symbol);
  const [profile] = await db.select().from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol));
  const company = `${symbol}${profile?.name ? ` (${profile.name})` : ""}${profile?.industry ? `, ${profile.industry}` : ""}. ${profile?.description ?? ""}`.trim();
  const keys = [...catalog.values()].filter((s) => /^(line|hline|qline|metric|hmetric|qmetric):/.test(s.key)).map((s) => `${s.label} [${s.key}]`);
  const docKey = fnv(releases.map((r) => r.id).join(","));
  const since = new Date(Date.now() - KPI_HISTORY_YEARS * 365.25 * DAY).toISOString().slice(0, 7);
  const bench = events[0]?.bench ?? moves[0]?.bench ?? "market";
  // Thierry's inputs on this ticker: in every prompt below, in no key.
  const notes = await notesText(db, symbol);
  // Step A: every event whose week was a significant unbiased move (a release with its best pages, news and filings by title).
  const moving = events.filter((e) => e.moveId !== null);
  const labels = new Map(moving.map((e, i) => [`M${i + 1}`, e.id]));
  const pagesOf = new Map(releases.map((r) => [r.id, r]));
  const movingText = moving
    .map((e, i) => {
      const head = `M${i + 1} ${e.day} ${KIND[e.kind]}: ${e.title.replace(/\s+/g, " ")} (the stock moved ${signedPct(e.reaction)} beyond the ${e.bench} in 5 trading days)`;
      const r = pagesOf.get(e.id);
      return r ? [head, ...r.pages.map((p) => `  [M${i + 1} page ${p.page}]\n${p.text}`)].join("\n") : head;
    })
    .join("\n\n");
  // No event came with a significant unbiased move: nothing to read, no candidate, no call.
  const candidates = moving.length === 0 ? [] : await once(
    db,
    complete,
    "kpi-candidates",
    symbol,
    `${CANDIDATES_QUESTION}:${fnv(movingText)}:${fnv(keys.join("|"))}`,
    `${CANDIDATES_QUESTION}: which price driver candidates for ${symbol}?`,
    CANDIDATES_SYSTEM,
    [`Company: ${company}`, "", "Stored series:", keys.join("\n") || "none", "", "Every event whose week was a significant unbiased price move, oldest first:", movingText || "none", ...withNotes(notes)].join("\n"),
    (text) => parseCandidates(text, catalog, labels),
  );
  // Once per event: the announcements that carry a period's figures before its report.
  const announced = await announcementsOf(db, complete, events);
  const drivers: KpiDriverResult[] = [];
  const windowStart = events[0]?.day ?? since;
  const windowMoves = moves.filter((m) => m.startDay >= windowStart);
  for (const k of candidates) {
    if (k.kind !== "kpi") {
      // When a policy or industry fact changed: the events that change it, crossed with the price.
      const changes = await judgeChanges(db, complete, symbol, company, k, events, notes);
      const rows = changeRows(events, changes, k.expected, moves);
      const tests = driverTests(rows, windowMoves);
      const verdict = await verdictOf(db, complete, symbol, k, tableText(rows, null, [], bench), testsText(tests, rows, windowMoves), notes);
      const last = [...rows].reverse().find((r) => r.kpiMoved === true);
      drivers.push({ ...k, ...verdict, measure: null, periods: [], rows, tests, direction: last ? (last.changeUp ? "up" : "down") : null });
      continue;
    }
    // The KPI's values: from what is stored, else read in the reports.
    let measured = measureKpi(catalog, k, since);
    let cites = new Map<string, DocCitation>();
    if (!measured) {
      const read = await once(
        db,
        complete,
        "kpi-read",
        `${symbol}:${k.name}`,
        `${READ_QUESTION}:${docKey}:${fnv(k.name)}`,
        `${READ_QUESTION}: « ${k.name} » of ${symbol} in each report`,
        READ_SYSTEM,
        [`Company: ${company}`, `KPI: ${k.name}. ${k.why}`, "", "Reports, oldest first:", releasesText(releases)].join("\n"),
        (text) => parseRead(db, text, releases),
      );
      if (read) {
        cites = read.cites;
        measured = { measure: read.measure, points: read.points };
      }
    }
    const computed = measured ? kpiPeriods(measured.points, measured.measure, releases, since, cites) : [];
    const periods = measured ? await judgeKpiMoves(db, complete, symbol, company, k, computed, measured.measure, events, announced, notes) : [];
    const rows = eventRows(events, periods, k.expected, moves);
    // Step B: the confidence, from the table and the two tests.
    const tests = driverTests(rows, windowMoves);
    const verdict = await verdictOf(db, complete, symbol, k, tableText(rows, measured?.measure ?? null, periods, bench), testsText(tests, rows, windowMoves), notes);
    const last = [...periods].reverse().find((p) => p.change !== null);
    drivers.push({ ...k, ...verdict, measure: measured?.measure ?? null, periods, rows, tests, direction: last ? (last.change! >= 0 ? "up" : "down") : null });
  }
  return { symbol, drivers };
}

export const kpiSource: Source = {
  name: "claude",
  requiredEnv: ["CLAUDE_OAUTH_TOKEN"],
  covers: () => true,
  async fetch(symbol: string, ctx: SourceContext): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("kpi-drivers: needs the database");
    if (!ctx.complete) throw new Error("kpi-drivers: no LLM in the collector context (cli.ts sets ctx.complete)");
    const { events } = await storedEvents(ctx.db, symbol);
    const releases = events.filter((e) => e.kind === "release").length;
    if (events.length === 0) return { request: { symbol }, httpStatus: null, error: "no events stored: market-reaction writes them" };
    return { request: { symbol, events: events.length, releases }, httpStatus: null, payload: await judgeKpis(ctx.db, ctx.complete, symbol) };
  },
};

/** A KPI's id from its name (toronto-v10 2026-11-23: a rank id pointed at another KPI after a re-run, links broke). */
export function stableId(symbol: string, name: string, taken: Set<string>): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kpi";
  let id = `${symbol}:kpi:${slug}`;
  for (let n = 2; taken.has(id); n++) id = `${symbol}:kpi:${slug}-${n}`;
  taken.add(id);
  return id;
}

/**
 * gold.kpi_drivers of every ticker answered in this run, from its latest payload. What the market believes about a driver
 * is the narrative's (step C, `analysis`) and its reversal is step D's (`kpi-reversal`; both run after): a trusted driver keeps the ones
 * it had until those stages write again; one that is no longer trusted loses them.
 */
export async function promoteKpis(db: Db, fetches: BronzeFetch[]): Promise<number> {
  const latest = new Map<string, KpiPayload>();
  for (const f of fetches.filter((x) => !x.error).sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())) latest.set(f.subject, f.payload as KpiPayload);
  let n = 0;
  for (const [symbol, p] of latest) {
    const before = new Map((await db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol))).map((k) => [k.id, k]));
    const ids = new Set<string>();
    const rows = p.drivers.map((d, i) => {
      const id = stableId(symbol, d.name, ids);
      const kept = d.level === "none" ? undefined : before.get(id);
      return {
        id,
        symbol,
        rank: i + 1,
        name: d.name,
        kind: d.kind ?? "kpi",
        foundIn: d.foundIn ?? [],
        tests: d.tests ?? null,
        why: d.why,
        expected: d.expected,
        series: d.series,
        approximation: d.approximation,
        measure: d.measure,
        periods: d.periods,
        level: d.level,
        reason: d.reason,
        rows: d.rows,
        confirmed: d.rows.filter((r) => r.result === "confirms").length,
        invalidated: d.rows.filter((r) => r.result === "invalidates").length,
        signal: kept?.signal ?? null,
        signalWhy: kept?.signalWhy ?? null,
        marketBelief: kept?.marketBelief ?? null,
        reversal: kept?.reversal ?? null,
        direction: kept?.reversal?.direction ?? d.direction,
        asOf: new Date(),
      };
    });
    await db.transaction(async (tx) => {
      await tx.delete(kpiDrivers).where(eq(kpiDrivers.symbol, symbol));
      if (rows.length) await tx.insert(kpiDrivers).values(rows);
    });
    n += rows.length;
  }
  return n;
}

export const kpiDriversDim: Dimension = {
  name: KPI_DIMENSION,
  description: "Steps A and B (docs/architecture.md). A: every event whose week was a significant unbiased move is read by the AI, which deduces the Price Driver Candidates (a KPI, a repeatable policy or an industry fact); no fundamental-or-market filter on the moves. B: when each candidate changed (code for a KPI, AI for the others), each significant move and each significant change crossed (code), then the AI's confidence that it is a Price Driver: strong, weak or noise.",
  sources: [kpiSource],
  subjects: analysedSymbols,
  promote: async (db, fetches): Promise<PromoteResult> => ({ silverRowsBySource: { claude: await promoteKpis(db, fetches) } }),
};

export async function kpiDriversOf(db: Db, symbol: string) {
  return db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank));
}
