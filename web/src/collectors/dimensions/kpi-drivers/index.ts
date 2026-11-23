import { and, asc, eq, inArray } from "drizzle-orm";
import { CANDIDATE_KINDS, driverEvents, KPI_LEVELS, kpiDrivers, priceMoveCauses, priceMoves, weekVerdict, type CandidateKind, type DocCitation, type DriverTests, type GoldDriverEvent, type GoldPriceMove, type KpiEventRow, type KpiLevel, type KpiMeasure, type KpiPeriod, type WeekVerdict } from "@/db/schema/analysis";
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
import { stripDashes } from "../thesis/structure";
import { analysedSymbols } from "../watchlist";
import { changeRows, driverTests, eventRows, kpiChange, kpiPeriods, kpiValue, measureKpi, parseFormula, periodEnd, periodWords, type CandidateChange, type JudgedMove } from "./steps";

export * from "./steps";

/**
 * Price Drivers, the proof structure of Kevin + Thierry's whiteboard (2026-11-23; PROOF-STRUCTURE-1123): steps 1 (events),
 * 2 (unusual weeks), 3 (which event explains which week) and 4 (one verdict per week: fundamental / market / unknown) are
 * stored by `market-reaction` and `move-causes`; here, per ticker:
 * 5) Price Driver Candidates (AI) READ in the events of the unusual weeks: a company KPI, a policy or an industry fact;
 * when each changed (code for a KPI, its moves judged by the AI; the AI for a policy or industry fact);
 * confidence (AI, `kpi-verdict@v4`) from tests A (each big change -> a fundamental week?), B (each unusual week -> did it
 * change?) and C (the events where both moved), every event's row beside them.
 * The narrative (`analysis`) is then written on the trusted ones, and each one's reversal is read against it (`kpi-reversal`).
 */

export const KPI_DIMENSION = "kpi-drivers";
export const KPI_YEARS = 3;
/**
 * v4 (meeting 2026-11-23): Price Driver Candidates read in the events that came with an unbiased move (each cites
 * where it was read), of three kinds: kpi / policy / industry. v3 listed only the company's KPIs from its reports.
 */
export const CANDIDATES_QUESTION = "kpi-candidates@v4";
/** Step 4 of a policy or industry candidate (no figure): which events carry a change of it, and which way. */
export const CHANGES_QUESTION = "candidate-changes@v1";
/** Step 4 when nothing stored measures the KPI: its value read in each report, the quote checked on its page. */
export const READ_QUESTION = "kpi-read@v1";
/** Step 1b: does an event announce, before its report, figures of the period that report covers (a profit warning)? */
export const ANNOUNCES_QUESTION = "event-announces@v1";
/** Step 4: which periods' changes matter, and which event first disclosed each (the AI's assessment, never a threshold). */
export const MOVES_QUESTION = "kpi-moves@v1";
/** v4 (PROOF-STRUCTURE-1123): the confidence weighs tests A, B and C, on the weeks step 4 judged fundamental; no turn (section 3 owns it). */
export const VERDICT_QUESTION = "kpi-verdict@v4";
/** Step 4 reads 5 years of the KPI (Kevin 2026-11-23); the events stay 3 years. */
export const KPI_HISTORY_YEARS = 5;
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

/** Steps 1 to 4 as stored: the events, the unusual weeks each with its ONE verdict (move-causes), oldest first. */
export async function storedEvents(db: Db, symbol: string): Promise<{ events: GoldDriverEvent[]; moves: (GoldPriceMove & { week: WeekVerdict })[] }> {
  const [events, moves, causes] = await Promise.all([
    db.select().from(driverEvents).where(eq(driverEvents.symbol, symbol)).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select().from(priceMoves).where(eq(priceMoves.symbol, symbol)).orderBy(asc(priceMoves.startDay)),
    db.select({ id: priceMoveCauses.id, kind: priceMoveCauses.kind }).from(priceMoveCauses).where(eq(priceMoveCauses.symbol, symbol)),
  ]);
  const kind = new Map(causes.map((c) => [c.id, c.kind]));
  return { events, moves: moves.map((m) => ({ ...m, week: weekVerdict(kind.get(m.id)) })) };
}

/** The releases of step 1 with their best results pages, labelled R1.. oldest first. */
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
async function once<T>(db: Db, complete: Complete, kind: string, subjectId: string, key: string, question: string, system: string, prompt: string, parse: (text: string) => Promise<T> | T): Promise<T> {
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
  "You are the equity research associate of a small-cap long/short analyst. You look for the PRICE DRIVERS of one stock: the fundamental facts the market trades it on. Fundamental = the company AND its industry (competitors, suppliers, any material trend in its space); macro (oil, rates, currencies, war, the whole market) is not.",
  "You are given every event of 3 years (results release, news, filing) that came with an unusual move of the share price once its market is taken out, labelled M1, M2... Read them: what fundamental fact changed at each, that the market reacted to? Each such fact is a Price Driver Candidate, not proven yet.",
  "A candidate is one of three kinds: kpi = a figure of the company (reported, or computed from what it reports: capacity utilization ~ revenue / PP&E for a manufacturer, same-store sales for a retailer, backlog for a contractor); policy = a rule that bears on the business (a subsidy, a tariff, a licence, a regulation), generalizable beyond one event; industry = a qualitative fact of its industry (an overhang lifting, a competitor failing, demand shifting). Never a price, a valuation multiple, a commodity, a rate or an index.",
  "Also add the KPIs its business model makes obvious, even when no event shows one (found = []). Any number: none when nothing fundamental drives it, twenty if there are twenty. One candidate per fact, named in a few words that stay true over years (« Hong Kong store revenue », never a dated event).",
  "expected = which way the share price should go when the candidate goes UP (a KPI rises; a policy or industry fact turns more favourable): up, or down (costs, debt, inventory days).",
  "found = the M labels where you read it, copied exactly. For a kpi: series = the stored series key that holds it, copied exactly from the list (null when none does); formula = when no key holds it, a formula of stored keys copied exactly, operators / * + - between spaces, numbers allowed (« line:inventory / line:cost-of-revenue * 365 »), else null; both null = read in the reports. For a policy or industry candidate: series and formula null.",
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
  "You give the confidence level of ONE hypothesis for a small-cap long/short analyst: « this candidate (a company KPI, a policy or a qualitative industry fact) drives this stock's price ».",
  "You read ONLY what you are given. Every unusual week of 3 years (the stock moved at least twice its usual 5-day move once its own market is taken out) already carries ONE verdict: fundamental (a fact of the company or its industry moved it), market (the market at large or trading itself) or unknown (no item explains it). Only a fundamental week counts as the price moving for this candidate.",
  "The table lists every event of 3 years (results release, news, filing): whether the candidate changed significantly then (a KPI: its change on the same period a year earlier, judged big enough to matter, at the event that first disclosed it; a policy or industry fact: the event carries a change of it), the price over the 5 trading days after with the verdict on its week, and the result: confirms (both, the way the candidate should move the price), invalidates (the candidate changed, the price did not move in a fundamental week or went the other way), other cause (a fundamental week, the candidate did not change: never against it).",
  "Then the three tests. A) each big change of the candidate: did the price follow the expected way in a fundamental week? A big change the price ignored says the market does not trade on it. B) each unusual week: fundamental or not, and did the candidate change in it? A driver that explains several fundamental weeks is worth more; fundamental weeks it does not explain only mean other drivers exist, never against it. C) the events where the candidate changed AND the price moved in a fundamental week: the expected way or not.",
  "level: decide it yourself, as the analyst would, never by counting. Weigh each moment: how big the change was, how clear the price move was, whether the event's title says another fact moved the price, how recent it is. A small cap's price is noisy: one contrary moment can be noise, a clean, large change the price ignored says much more. strong = the market clearly trades the stock on this candidate; weak = it does sometimes, or the evidence is thin; none = it does not.",
  "reason = ONE plain sentence, at most 15 words, a reader understands at once: how the stock reacts to this candidate. When some moments went against it, the same sentence says whether that is normal (another fact moved the price those days) or a real doubt. No dates, no list of figures, no labels.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"level": "strong" | "weak" | "none", "reason": string}',
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
  "You read a company's events of 3 years (results releases, news, filings) for an equity analyst, about ONE candidate price driver that is not a figure: a policy or a qualitative industry fact.",
  "For each event that carries a CHANGE of that candidate (it is passed, dropped, eased, tightened, starts, ends, gets clearly better or worse), say which way: up = more favourable to the company, down = less. An event that only mentions it, or repeats what was known, carries no change: leave it out. Never use the share price.",
  "why = at most 12 words: what changed.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"changes": [{"event": "E4", "change": "up" | "down", "why": string}]}',
].join("\n");

/** Step 4 of a policy or industry candidate: one stored reading of which events change it (titles only, never the price). */
export async function judgeChanges(db: Db, complete: Complete, symbol: string, company: string, k: KpiCandidate, events: GoldDriverEvent[]): Promise<Map<string, CandidateChange>> {
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
    [`Company: ${company}`, `Candidate (${k.kind}): ${k.name}. ${k.why}`, "", "Every event, oldest first:", lines.join("\n")].join("\n"),
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

/** Step 4 read in the reports: one value per report that prints it, kept only when its quote is printed on its page. */
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

export function parseVerdict(text: string): Verdict {
  const obj = JSON.parse(firstJsonObject(text)) as Record<string, unknown>;
  if (!KPI_LEVELS.includes(obj.level as KpiLevel)) throw new Error(`kpi-drivers: level "${String(obj.level)}" is not one of ${KPI_LEVELS.join(", ")}`);
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
  "Each period of 5 years is listed with its value, the same period a year earlier and the change. Decide yourself, as the analyst would, whether each change is big enough to matter to the market (his rule of thumb: « if the backlog doubles, it matters; a 3% difference, who cares »). Weigh it against this KPI's own history and what it is (a margin, a revenue line, a share count); never apply a fixed threshold.",
  "first = the event that first told the market THIS KPI's change for that period: an announcement listed before the report only when what it announces carries this KPI (a profit warning carries profit and margins, rarely revenue), else the report. Copy its label exactly.",
  "why = at most 12 words, the size in plain words (« net profit fell 47%, its largest drop in 5 years »).",
  "No em dash. JSON only, no prose, no code fence:",
  '{"periods": [{"period": "P1", "moved": boolean, "why": string, "first": "R3" | "A2"}]}',
].join("\n");

export const KIND = { release: "Results release", news: "News", filing: "Filing" } as const;
const RESULT = { confirms: "confirms", invalidates: "invalidates", "other-cause": "other cause", nothing: "nothing moved" } as const;

/** The step-5 table as the verdict reads it: one line per event, the KPI and the price measured, the result. */
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
      const price = `price ${signedPct(r.reaction)} beyond the ${bench} over 5 trading days${r.z === null ? "" : ` (${Math.abs(r.z).toFixed(1)}x its usual move)`}, ${r.week ? `an unusual week judged ${r.week}` : "no unusual week"}`;
      return `${r.day} ${KIND[r.kind]}: ${r.title.replace(/\s+/g, " ")}. ${kpi}; ${price}. Result: ${RESULT[r.result]}.`;
    })
    .join("\n");
}

/** Tests A, B and C as the confidence reads them, B listing each unusual week with its verdict and the event that changed the candidate in it. */
export function testsText(tests: DriverTests, rows: KpiEventRow[], moves: (JudgedMove & Pick<GoldPriceMove, "startDay" | "endDay" | "abnormal" | "z" | "bench">)[]): string {
  const changedIn = new Map<string, KpiEventRow>();
  for (const r of rows) if (r.kpiMoved === true && r.moveId && !changedIn.has(r.moveId)) changedIn.set(r.moveId, r);
  const moveLines = moves.map((m) => {
    const r = changedIn.get(m.id);
    return `- ${m.startDay} to ${m.endDay}: ${signedPct(m.abnormal)} beyond the ${m.bench} (${Math.abs(m.z).toFixed(1)}x its usual move), week judged ${m.week ?? "unknown"}. Candidate changed in it: ${r ? `yes, ${r.day} ${r.title.replace(/\s+/g, " ")}` : "no"}.`;
  });
  return [
    `A) ${tests.changes} big changes of the candidate: the price followed the expected way in a fundamental week ${tests.followed} times, did not or went against it ${tests.against} times.`,
    `B) ${tests.moves} unusual weeks, ${tests.fundamentalMoves} judged fundamental: the candidate changed in ${tests.explained} of those.`,
    ...moveLines,
    `C) ${tests.both} events where the candidate changed and the price moved in a fundamental week: ${tests.bothAgree} the expected way, ${tests.both - tests.bothAgree} the other way.`,
  ].join("\n");
}

type Announcement = { announces: boolean; what: string | null };

/**
 * Step 1b: a stored reading of each news item and filing that comes before a report (within 120 days, after the one
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
 * Step 4, the AI half: which periods' changes matter for this KPI and which event first disclosed each (its report, or
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
      release ? `  Report: ${label(release.id, "R")} ${release.day} ${release.title.replace(/\s+/g, " ")}` : "  Report: none stored (older than 3 years)",
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
    [`Company: ${company}`, `KPI: ${k.name}. ${k.why}`, `Measured as: ${measure.label}.`, "", "Every period with a year earlier to compare, oldest first:", lines.join("\n")].join("\n"),
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

/** The confidence from the event table and tests A, B and C, then its sentence cut to 15 words. */
async function verdictOf(db: Db, complete: Complete, symbol: string, k: KpiCandidate, table: string, tests: string): Promise<Verdict> {
  const verdict = await once(
    db,
    complete,
    "kpi-verdict",
    `${symbol}:${k.name}`,
    `${VERDICT_QUESTION}:${fnv(`${k.name}|${k.kind}|${k.expected}|${table}|${tests}`)}`,
    `${VERDICT_QUESTION}: does « ${k.name} » move ${symbol}?`,
    VERDICT_SYSTEM,
    [`Candidate (${k.kind}): ${k.name}. When it goes up, the share price should go ${k.expected}.`, "", `Every event of the last ${KPI_YEARS} years, oldest first:`, table, "", "The three tests:", tests].join("\n"),
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

/** One ticker end to end: candidates, when each changed, the event table, tests A, B and C and the confidence, on the stored steps 1 to 4. */
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
  // Step 3: read in the events that came with an unbiased move (a release with its best pages, news and filings by title).
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
  const candidates = await once(
    db,
    complete,
    "kpi-candidates",
    symbol,
    `${CANDIDATES_QUESTION}:${fnv(movingText)}:${fnv(keys.join("|"))}`,
    `${CANDIDATES_QUESTION}: which price driver candidates for ${symbol}?`,
    CANDIDATES_SYSTEM,
    [`Company: ${company}`, "", "Stored series:", keys.join("\n") || "none", "", "Every event with an unusual price move, oldest first:", movingText || "none"].join("\n"),
    (text) => parseCandidates(text, catalog, labels),
  );
  // Step 1b, once per event: the announcements that carry a period's figures before its report.
  const announced = await announcementsOf(db, complete, events);
  const drivers: KpiDriverResult[] = [];
  const windowStart = events[0]?.day ?? since;
  const windowMoves = moves.filter((m) => m.startDay >= windowStart);
  for (const k of candidates) {
    if (k.kind !== "kpi") {
      // When a policy or industry fact changed: the events that change it, crossed with the price.
      const changes = await judgeChanges(db, complete, symbol, company, k, events);
      const rows = changeRows(events, changes, k.expected, moves);
      const tests = driverTests(rows, windowMoves);
      const verdict = await verdictOf(db, complete, symbol, k, tableText(rows, null, [], bench), testsText(tests, rows, windowMoves));
      const last = [...rows].reverse().find((r) => r.kpiMoved === true);
      drivers.push({ ...k, ...verdict, measure: null, periods: [], rows, tests, direction: last ? (last.changeUp ? "up" : "down") : null });
      continue;
    }
    // Step 4: from what is stored, else read in the reports.
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
    const periods = measured ? await judgeKpiMoves(db, complete, symbol, company, k, computed, measured.measure, events, announced) : [];
    // Step 5.
    const rows = eventRows(events, periods, k.expected, moves);
    // Confidence, from the table and tests A, B and C only.
    const tests = driverTests(rows, windowMoves);
    const verdict = await verdictOf(db, complete, symbol, k, tableText(rows, measured?.measure ?? null, periods, bench), testsText(tests, rows, windowMoves));
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
    if (events.length === 0) return { request: { symbol }, httpStatus: null, error: "no events stored: market-reaction writes them (steps 1 and 2)" };
    if (releases === 0) return { request: { symbol, events: events.length }, httpStatus: null, error: "no results report stored for the last 3 years" };
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
 * gold.kpi_drivers of every ticker answered in this run, from its latest payload. A driver's reversal is `kpi-reversal`'s
 * (it runs after the narrative): a trusted driver keeps the one it had until that stage reads it again; one that is no
 * longer trusted loses it.
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
  description: "Price drivers of each stock (PROOF-STRUCTURE-1123): candidates (a KPI, a policy or an industry fact) read in the events of the unusual weeks (AI), when each changed (code for a KPI, AI for the others), every event of 3 years crossed with the candidate and the weeks judged fundamental (code), confidence from tests A, B and C (AI). The narrative is written on the trusted ones (analysis), then each one's reversal is read against it (kpi-reversal).",
  sources: [kpiSource],
  subjects: analysedSymbols,
  promote: async (db, fetches): Promise<PromoteResult> => ({ silverRowsBySource: { claude: await promoteKpis(db, fetches) } }),
};

export async function kpiDriversOf(db: Db, symbol: string) {
  return db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank));
}
