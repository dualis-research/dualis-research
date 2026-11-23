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
import { eventRows, kpiChange, kpiPeriods, kpiValue, measureKpi, parseFormula, periodWords } from "./steps";

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
export const VERDICT_QUESTION = "kpi-verdict@v1";
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
  "You read ONLY the table you are given: every event of 3 years (results release, news, filing), whether the KPI moved significantly then (at least twice its usual change on the same period a year earlier, measured at the release that first reported it), whether the share price moved significantly in the 5 trading days after (at least twice its usual 5-day move once its own market is taken out), and the result computed from both: confirms (both, the way the KPI should move the price), invalidates (the KPI moved, the price did not or went the other way), other cause (the price moved, the KPI did not: never against the KPI).",
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
          ? `KPI ${periodWords(p.periodType, p.period)}: ${kpiValue(r.from, measure)} a year earlier -> ${kpiValue(r.to, measure)} (${kpiChange(r.change, p.changeKind)}${r.ratio === null ? ", too short a history to say how unusual" : `, ${r.ratio.toFixed(1)}x its usual change`}), ${r.kpiMoved ? "moved" : "did not move"}`
          : "KPI: not reported at this moment";
      const price = `price ${signedPct(r.reaction)} beyond the ${bench} over 5 trading days${r.z === null ? "" : ` (${Math.abs(r.z).toFixed(1)}x its usual move)`}, ${r.priceMoved ? "moved" : "did not move"}`;
      return `${r.day} ${KIND[r.kind]}: ${r.title.replace(/\s+/g, " ")}. ${kpi}; ${price}. Result: ${RESULT[r.result]}.`;
    })
    .join("\n");
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
  const since = new Date(Date.now() - KPI_YEARS * 365.25 * DAY).toISOString().slice(0, 7);
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
    const periods = measured ? kpiPeriods(measured.points, measured.measure, releases, since, cites) : [];
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
