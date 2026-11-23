import { and, asc, eq, inArray } from "drizzle-orm";
import { driverEvents, KPI_LEVELS, kpiDrivers, priceMoves, type DocCitation, type GoldDriverEvent, type GoldPriceMove, type KpiEventRow, type KpiLevel, type KpiMeasure, type KpiPeriod } from "@/db/schema/analysis";
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
import { eventRows, kpiChange, kpiPeriods, kpiValue, measureKpi, parseFormula, periodEnd, periodWords } from "./steps";

export * from "./steps";

/**
 * KPI Drivers in six stored steps (DRIVERS-SIX-STEPS-1123, Kevin 2026-11-23: « visible en étapes… pour qu'un humain
 * puisse voir tout de suite s'il y a une erreur à un endroit du raisonnement »). Steps 1 (events) and 2 (when the stock
 * moved) are code in `market-reaction` (gold.driver_events, gold.price_moves); here, per ticker:
 * 3) candidates (AI, once per set of reports): the fundamental KPIs of THIS business, each with its expected direction
 *    (KPI up => price up or down) and how it is measured (a stored series key, or a formula of stored keys);
 * 4) when the KPI moved (code, `steps.ts`; the AI reads its value in the reports only when nothing stored measures it);
 * 5) event by event (code, `steps.ts`): confirms / invalidates / other cause / nothing;
 * 6) verdict (AI, from the step-5 table only): strong / weak / none, one sentence, and whether it turns now.
 */

export const KPI_DIMENSION = "kpi-drivers";
export const KPI_YEARS = 3;
/** v3 (DRIVERS-SIX-STEPS-1123): each KPI with its expected direction and a formula of stored keys when no series holds it. */
export const CANDIDATES_QUESTION = "kpi-candidates@v3";
/** Step 4 when nothing stored measures the KPI: its value read in each report, the quote checked on its page. */
export const READ_QUESTION = "kpi-read@v1";
/** Step 6: the verdict from the step-5 table only (the AI decides, never a count rule: Kevin 2026-11-19). */
/** Step 1b: does an event announce, before its report, figures of the period that report covers (a profit warning)? */
export const ANNOUNCES_QUESTION = "event-announces@v1";
/** Step 4: which periods' changes matter, and which event first disclosed each (the AI's assessment, never a threshold). */
export const MOVES_QUESTION = "kpi-moves@v1";
/** v2: step 4 is the AI's assessment of size, the first disclosure may be an announcement. */
export const VERDICT_QUESTION = "kpi-verdict@v2";
/** Step 4 reads 5 years of the KPI (Kevin 2026-11-23); the events stay 3 years. */
export const KPI_HISTORY_YEARS = 5;
/** The verdict's sentence cut to at most 15 words, same meaning (a meta-task on the finished text). v2: v1 echoed its own instruction once (Water Oasis, Hong Kong and Macau revenue). */
export const REASON_QUESTION = "kpi-reason@v2";
export const REASON_SYSTEM = "You shorten ONE verdict an analyst wrote about a company KPI. Keep its facts and its conclusion (does the stock trade on this KPI, and what moved the price instead), in AT MOST 15 words, plain English. Never describe the task, never ask a question. No dates, no em dash. Answer with the shortened sentence only.";
/** Pages of each report the AI reads (the results discussion first) and how much of each page. */
const PAGES_PER_RELEASE = 2;
const PAGE_CHARS = 3_500;
const DAY = 86_400_000;

export type KpiCandidate = { name: string; why: string; expected: "up" | "down"; series: string | null; approximation: string | null };
type Release = { id: string; documentId: string; label: string; day: string; title: string; pages: { page: number; text: string }[] };
type Verdict = { level: KpiLevel; reason: string; signal: KpiLevel | null; signalWhy: string | null };

const signedPct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

/** Step 1 + 2 as stored by market-reaction, oldest first. */
export async function storedEvents(db: Db, symbol: string): Promise<{ events: GoldDriverEvent[]; moves: GoldPriceMove[] }> {
  const [events, moves] = await Promise.all([
    db.select().from(driverEvents).where(eq(driverEvents.symbol, symbol)).orderBy(asc(driverEvents.day), asc(driverEvents.id)),
    db.select().from(priceMoves).where(eq(priceMoves.symbol, symbol)).orderBy(asc(priceMoves.startDay)),
  ]);
  return { events, moves };
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
  "You are the equity research associate of a small-cap long/short analyst. He trusts only fundamental KPIs: figures about the business that the market trades the stock on.",
  "List every KPI that drives THIS business, from its business model and from what management itself writes in its reports (the KPIs it reports, discusses and explains results with).",
  "Know what drives each kind of business (capacity utilization for a manufacturer, same-store sales for a retailer, backlog for a contractor, net interest margin for a bank...). When the company does not report one, say how to compute it from what is stored (capacity utilization ~ revenue / PP&E).",
  "Any number of KPIs: none when nothing fundamental drives it, twenty if there are twenty. Only the company's OWN figures (reported, or computed from what it reports): never an external series (a customer's or the industry's numbers, a commodity, a rate, a currency, an index), never a price or a valuation multiple.",
  "expected = which way the share price should go when the KPI goes UP: up (revenue, margin) or down (costs, debt, inventory days).",
  "series = the stored series key that holds it, copied exactly from the list (null when none does); formula = when no key holds it, a formula of stored keys copied exactly, operators / * + - between spaces, numbers allowed (« line:inventory / line:cost-of-revenue * 365 »), else null; both null = read in the reports.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"kpis": [{"name": "Operating margin", "why": "<at most 15 words: why it moves this business>", "expected": "up" | "down", "series": "metric:operating-margin" | null, "formula": string | null}]}',
].join("\n");

export const READ_SYSTEM = [
  "You read ONE figure in a company's reports for an equity analyst: the KPI named below, as each report prints it.",
  "For every report listed, the value of that KPI for the period the report covers, ONLY when the pages shown print it (or print the two figures it is computed from: then give the computed value and quote one of them). Skip a report that does not.",
  "period = the period's last month YYYY-MM; periodType = half for six months, year for twelve, quarter for three; value = a plain number (a percentage as a percentage: 12.5 for 12.5%); unit = percent | amount | count | multiple; quote = the EXACT words of the page that print it.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"values": [{"report": "R1", "page": 3, "period": "2025-03", "periodType": "half", "value": 12.5, "unit": "percent", "currency": "HKD" | null, "quote": "<exact words>"}]}',
].join("\n");

export const VERDICT_SYSTEM = [
  "You give the verdict on ONE hypothesis for a small-cap long/short analyst: « this fundamental KPI of the company moves this stock ».",
  "You read ONLY the table you are given: every event of 3 years (results release, news, filing), whether the KPI moved significantly then (its change on the same period a year earlier, judged big enough to matter, at the event that first disclosed it: the report, or an announcement before it such as a profit warning), whether the share price moved significantly in the 5 trading days after (at least twice its usual 5-day move once its own market is taken out), and the result computed from both: confirms (both, the way the KPI should move the price), invalidates (the KPI moved, the price did not or went the other way), other cause (the price moved, the KPI did not: never against the KPI).",
  "level: decide it yourself, as the analyst would, never by counting. Weigh each moment: how big the KPI move was, how clear the price move was, whether the event's title says another fact moved the price, how recent it is. A small cap's price is noisy: one contrary moment can be noise, a clean, large KPI move the price ignored says much more. strong = the market clearly trades the stock on this KPI; weak = it does sometimes, or the evidence is thin; none = it does not.",
  "reason = ONE plain sentence, at most 15 words, a reader understands at once: how the stock reacts to this KPI. When some moments went against it, the same sentence says whether that is normal (another fact moved the price those days) or a real doubt. No dates, no list of figures, no labels.",
  "signal (only when level is strong or weak, else null): does the KPI turn NOW, at the latest release, by enough to change the story, with the price not reacting yet? strong (only for a strong KPI) / weak / none. signalWhy = one sentence with the figure.",
  "No em dash. JSON only, no prose, no code fence:",
  '{"level": "strong" | "weak" | "none", "reason": string, "signal": "strong" | "weak" | "none" | null, "signalWhy": string | null}',
].join("\n");

export function parseCandidates(text: string, catalog: Map<string, StoredSeries>): KpiCandidate[] {
  const obj = JSON.parse(firstJsonObject(text)) as { kpis?: unknown };
  if (!Array.isArray(obj.kpis)) throw new Error(`kpi-drivers: answer has no kpis array: ${text.slice(0, 200)}`);
  return obj.kpis.flatMap((k) => {
    const x = k as Record<string, unknown>;
    if (typeof x.name !== "string" || !x.name.trim() || typeof x.why !== "string") return [];
    if (x.expected !== "up" && x.expected !== "down") throw new Error(`kpi-drivers: expected "${String(x.expected)}" for ${x.name}, not up or down`);
    const series = typeof x.series === "string" && catalog.has(x.series) ? x.series : null;
    const formula = !series && typeof x.formula === "string" && parseFormula(x.formula, catalog) ? stripDashes(x.formula.trim()) : null;
    return [{ name: stripDashes(x.name.trim()), why: stripDashes(x.why.trim()), expected: x.expected, series, approximation: formula }];
  });
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
  const level = obj.level as KpiLevel;
  const asked = level !== "none" && KPI_LEVELS.includes(obj.signal as KpiLevel) ? (obj.signal as KpiLevel) : null;
  // A strong turn needs a KPI the market has shown it trades on (Kevin 2026-11-19): a weak KPI's turn is weak at most.
  const signal = asked === "strong" && level !== "strong" ? "weak" : asked;
  return { level, reason: stripDashes(obj.reason.trim()), signal, signalWhy: signal && typeof obj.signalWhy === "string" ? stripDashes(obj.signalWhy.trim()) : null };
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

const KIND = { release: "Results release", news: "News", filing: "Filing" } as const;
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
          : "KPI: not reported at this moment";
      const price = `price ${signedPct(r.reaction)} beyond the ${bench} over 5 trading days${r.z === null ? "" : ` (${Math.abs(r.z).toFixed(1)}x its usual move)`}, ${r.priceMoved ? "moved" : "did not move"}`;
      return `${r.day} ${KIND[r.kind]}: ${r.title.replace(/\s+/g, " ")}. ${kpi}; ${price}. Result: ${RESULT[r.result]}.`;
    })
    .join("\n");
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

export type KpiDriverResult = KpiCandidate & Verdict & { measure: KpiMeasure | null; periods: KpiPeriod[]; rows: KpiEventRow[]; direction: "up" | "down" | null };
export type KpiPayload = { symbol: string; drivers: KpiDriverResult[] };

/** One ticker end to end, steps 3 to 6 on the stored steps 1 and 2. */
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
  // Step 3.
  const candidates = await once(
    db,
    complete,
    "kpi-candidates",
    symbol,
    `${CANDIDATES_QUESTION}:${docKey}:${fnv(keys.join("|"))}`,
    `${CANDIDATES_QUESTION}: which fundamental KPIs drive ${symbol}?`,
    CANDIDATES_SYSTEM,
    [`Company: ${company}`, "", "Stored series:", keys.join("\n") || "none", "", "Its latest reports (best pages):", releasesText(releases.slice(-4))].join("\n"),
    (text) => parseCandidates(text, catalog),
  );
  // Step 1b, once per event: the announcements that carry a period's figures before its report.
  const announced = await announcementsOf(db, complete, events);
  const drivers: KpiDriverResult[] = [];
  for (const k of candidates) {
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
    // Step 6, from the table only.
    const table = tableText(rows, measured?.measure ?? null, periods, bench);
    const verdict = await once(
      db,
      complete,
      "kpi-verdict",
      `${symbol}:${k.name}`,
      `${VERDICT_QUESTION}:${fnv(`${k.name}|${k.expected}|${table}`)}`,
      `${VERDICT_QUESTION}: does « ${k.name} » move ${symbol}?`,
      VERDICT_SYSTEM,
      [`KPI: ${k.name}. When it goes up, the share price should go ${k.expected}.`, "", `Every event of the last ${KPI_YEARS} years, oldest first:`, table].join("\n"),
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
    const last = [...periods].reverse().find((p) => p.change !== null);
    drivers.push({ ...k, ...verdict, measure: measured?.measure ?? null, periods, rows, direction: last ? (last.change! >= 0 ? "up" : "down") : null });
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

/** gold.kpi_drivers of every ticker answered in this run, from its latest payload. */
export async function promoteKpis(db: Db, fetches: BronzeFetch[]): Promise<number> {
  const latest = new Map<string, KpiPayload>();
  for (const f of fetches.filter((x) => !x.error).sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime())) latest.set(f.subject, f.payload as KpiPayload);
  let n = 0;
  for (const [symbol, p] of latest) {
    const ids = new Set<string>();
    const rows = p.drivers.map((d, i) => ({
      id: stableId(symbol, d.name, ids),
      symbol,
      rank: i + 1,
      name: d.name,
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
      signal: d.signal,
      signalWhy: d.signalWhy,
      direction: d.direction,
      asOf: new Date(),
    }));
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
  description: "Fundamental KPIs that move each stock, in stored steps: candidates with their expected direction and how each is measured (AI), when each KPI moved (code), every event of 3 years crossed with the KPI's and the price's moves (code: confirms / invalidates / other cause / nothing), then the verdict from that table (AI) and whether it turns now.",
  sources: [kpiSource],
  subjects: analysedSymbols,
  promote: async (db, fetches): Promise<PromoteResult> => ({ silverRowsBySource: { claude: await promoteKpis(db, fetches) } }),
};

export async function kpiDriversOf(db: Db, symbol: string) {
  return db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank));
}
