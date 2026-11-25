import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { quoteStamp } from "../intraday-price";
import { consensus } from "@/db/schema/consensus";
import { driverEvents, fairValues, priceMoves } from "@/db/schema/analysis";
import { revenueStreams, valuations, type GoldRevenueStream } from "@/db/schema/financials";
import { valuationReports } from "@/db/schema/valuation";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import { notesText } from "@/inputs/notes";
import { seriesCatalog, type StoredSeries } from "./series";
import { fairValueHistoryLine } from "./thesis";

/**
 * Everything one analysis reads about a ticker, as plain text for the model, all from gold.
 * The quote enters the hash only as a 15% bucket: a daily price tick never re-asks, a real move does.
 */
export type AnalysisFacts = { symbol: string; text: string; hash: string; catalog: Map<string, StoredSeries>; quote: { close: number; date: string; currency: string | null } | null; currency: string | null; hasFinancials: boolean };

/** How far back the narrative reads the significant unbiased moves, and how many at most (the largest). */
export const MOVE_YEARS = 3;
export const MOVES_SHOWN = 30;
/** Events shown per move. */
const EVENTS_PER_MOVE = 3;
const signedPct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

/**
 * The significant unbiased 1-week moves of the stock (`gold.price_moves`), each with the events whose week it was
 * (`gold.driver_events`): what the market reacted to, as stored, no verdict on any of them (docs/architecture.md: a
 * significant unbiased move is always valid). Null when no move is stored.
 */
export async function movesText(db: Db, symbol: string, now = new Date()): Promise<{ text: string | null }> {
  const since = new Date(Date.UTC(now.getUTCFullYear() - MOVE_YEARS, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  const [moves, events] = await Promise.all([
    db.select().from(priceMoves).where(and(eq(priceMoves.symbol, symbol), gte(priceMoves.startDay, since))).orderBy(desc(priceMoves.startDay)),
    db.select({ moveId: driverEvents.moveId, day: driverEvents.day, title: driverEvents.title, z: driverEvents.z }).from(driverEvents).where(and(eq(driverEvents.symbol, symbol), isNotNull(driverEvents.moveId))),
  ]);
  if (moves.length === 0) return { text: null };
  const shown = [...moves].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, MOVES_SHOWN).sort((a, b) => b.startDay.localeCompare(a.startDay));
  const lines = shown.map((m) => {
    const span = m.startDay === m.endDay ? m.startDay : `${m.startDay} to ${m.endDay}`;
    const mine = events.filter((e) => e.moveId === m.id).sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0)).slice(0, EVENTS_PER_MOVE);
    return `- ${span}: stock ${signedPct(m.returnPct)}, ${m.bench} ${signedPct(m.benchReturn)} (${Math.abs(m.z).toFixed(1)}x its usual 1-week move). Events that week: ${mine.length ? mine.map((e) => `${e.day} ${e.title.replace(/\s+/g, " ")}`).join("; ") : "none stored"}`;
  });
  return { text: [`Significant unbiased 1-week price moves of the last ${MOVE_YEARS} years (at least twice the stock's usual 1-week move once its own market is taken out), newest first:`, lines.join("\n")].join("\n") };
}

/** 291764969976 -> "291.8B"; 0.234 -> "23.4%". */
export function fmt(v: number | null | undefined, unit: string = "currency"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  if (unit === "ratio") return `${(v * 100).toFixed(1)}%`;
  if (unit === "multiple") return `${v.toFixed(1)}x`;
  if (unit === "per-share") return v >= 100 ? v.toFixed(0) : v.toFixed(2);
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/** FNV-1a, two seeds, 16 hex chars: pure (the console bundle lists dimensions). */
export function fnv(text: string): string {
  const one = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return one(2166136261) + one(0x9747b28c);
}

const TABLE_LINES = ["line:revenue", "line:gross-profit", "line:operating-income", "line:depreciation-amortization", "metric:ebitda", "line:net-income", "line:eps-diluted", "line:eps-basic", "metric:operating-margin", "metric:ebitda-margin", "metric:revenue-growth", "line:cfo", "line:capex", "metric:fcf", "line:dividends-paid", "line:buybacks", "line:cash", "line:total-debt", "metric:net-debt", "line:equity", "line:shares-outstanding", "metric:ev-ebitda", "metric:pe"];
const QUARTER_LINES = ["qline:revenue", "qline:operating-income", "qline:net-income", "qmetric:operating-margin"];
/**
 * What the company reports about its business beside the statements, when it does (a table drops absent rows): the
 * order book and new orders, each against revenue. Whether one matters, and whether the price saw it, is the model's call.
 */
const OPERATING_KEYS = ["line:backlog", "metric:backlog-growth", "metric:backlog-to-revenue", "line:remaining-performance-obligations", "metric:remaining-performance-obligations-growth", "metric:remaining-performance-obligations-to-revenue", "line:order-intake", "metric:book-to-bill"];
const OPERATING_QUARTER_KEYS = OPERATING_KEYS.map((k) => `q${k}`);
/**
 * Leverage the way an investor reads it: debt against the earnings that service it (net debt and total debt over the
 * EBITDA of the 12 months to that date, interest cover), beside the debt and cash they come from. Absent rows drop.
 */
const BALANCE_KEYS = ["line:total-debt", "line:cash", "metric:net-debt", "metric:ebitda", "metric:net-debt-to-ebitda", "metric:total-debt-to-ebitda", "line:interest-expense", "metric:interest-cover"];
const BALANCE_QUARTER_KEYS = BALANCE_KEYS.filter((k) => k !== "metric:ebitda").map((k) => `q${k}`);
const HALF_LINES = ["hline:revenue", "hline:gross-profit", "hline:operating-income", "hline:net-income", "hmetric:operating-margin", "hmetric:net-margin", "hmetric:revenue-growth"];

const pct = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const periodName = (r: Pick<GoldRevenueStream, "periodType" | "periodEnd">) => (r.periodType === "year" ? `FY ${r.periodEnd}` : `${r.periodType === "half" ? "6 months" : "3 months"} to ${r.periodEnd}`);

/**
 * Every revenue stream the filings report (gold.revenue_streams), the total first: the last 3 fiscal years and the
 * interim periods after them, each with its growth on the same period a year earlier, its share of total revenue,
 * and the last 12 months at an interim end. Facts only: what they mean is the model's call.
 */
export function streamsText(rows: GoldRevenueStream[]): string | null {
  if (rows.length === 0) return null;
  const byLine = new Map<string, GoldRevenueStream[]>();
  for (const r of rows) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
  const latestYear = (rs: GoldRevenueStream[]) => rs.filter((r) => r.periodType === "year").sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const lines = [...byLine.entries()].sort(([a, ra], [b, rb]) => (a === "revenue" ? -1 : b === "revenue" ? 1 : ra[0].axis.localeCompare(rb[0].axis) || (latestYear(rb)?.value ?? 0) - (latestYear(ra)?.value ?? 0)));
  const out = ["Revenue by stream (each period against the same period a year earlier; share = of total revenue that period; LTM = last 12 months):"];
  for (const [, rs] of lines) {
    const years = rs.filter((r) => r.periodType === "year").sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-3);
    const lastYear = years.at(-1)?.periodEnd ?? "";
    const interim = rs.filter((r) => r.periodType !== "year" && r.periodEnd > minusYear(lastYear)).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.periodType.localeCompare(b.periodType));
    const cells = [...years, ...interim].map((r) => {
      const notes = [pct(r.growth), r.shareOfTotal !== null ? `${(r.shareOfTotal * 100).toFixed(0)}% of total` : null].filter(Boolean).join(", ");
      const ltm = r.ltmValue !== null ? `; LTM ${fmt(r.ltmValue)}${r.ltmGrowth !== null ? ` (${pct(r.ltmGrowth)} on the LTM a year earlier)` : ""} = ${r.ltmFormula}` : "";
      return `${periodName(r)} ${fmt(r.value)}${notes ? ` (${notes})` : ""}${ltm}`;
    });
    out.push(`- ${rs[0].axis === "total" ? rs[0].name : `${rs[0].axis}: ${rs[0].name}`}: ${cells.join(" | ")}`);
  }
  // How much of the total each axis covers in its latest period: streams that do not add up are said so.
  const axes = [...new Set(rows.filter((r) => r.axis !== "total").map((r) => r.axis))];
  const coverage = axes.map((axis) => {
    const r = rows.filter((x) => x.axis === axis && x.axisCoverage !== null).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
    return r ? `${axis} streams add up to ${(r.axisCoverage! * 100).toFixed(0)}% of total revenue (${periodName(r)})` : null;
  });
  if (coverage.some(Boolean)) out.push(`Coverage: ${coverage.filter(Boolean).join("; ")}.`);
  return out.join("\n");
}
/**
 * The reported numbers a judge of the story reads: the last fiscal years,
 * quarters and half years, and revenue by stream. A results filing arrives as a title; these are its figures.
 */
export async function figuresText(db: Db, symbol: string): Promise<string> {
  const catalog = await seriesCatalog(db, symbol);
  const streams = await db.select().from(revenueStreams).where(eq(revenueStreams.symbol, symbol));
  const keys = (prefix: string) => ["revenue", "operating-income", "net-income"].map((l) => `${prefix}:${l}`).filter((k) => catalog.has(k));
  return [
    "The company's reported figures:",
    keys("line").length ? `Fiscal years:\n${table(catalog, keys("line"), 4)}` : "Fiscal years: none collected.",
    keys("qline").length ? `Last quarters:\n${table(catalog, keys("qline"), 4)}` : null,
    keys("hline").length ? `Last half years:\n${table(catalog, keys("hline"), 4)}` : null,
    operatingText(catalog),
    balanceText(catalog),
    streamsText(streams),
  ]
    .filter((x) => x !== null)
    .join("\n");
}

/** The order book and new orders the company reports, fiscal years then quarters; null when it reports none. */
function operatingText(catalog: Map<string, StoredSeries>): string | null {
  const years = OPERATING_KEYS.filter((k) => catalog.has(k));
  const quarters = OPERATING_QUARTER_KEYS.filter((k) => catalog.has(k));
  if (years.length + quarters.length === 0) return null;
  return [
    "Operating figures the company reports (backlog = at the period end; x = times the revenue of the 12 months to that date):",
    years.length ? table(catalog, years, 4) : null,
    quarters.length ? `Quarters:\n${table(catalog, quarters, 4)}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

/** Debt, cash and leverage against earnings, fiscal years then quarters; null when nothing is reported. */
export function balanceText(catalog: Map<string, StoredSeries>): string | null {
  const years = BALANCE_KEYS.filter((k) => catalog.has(k));
  const quarters = BALANCE_QUARTER_KEYS.filter((k) => catalog.has(k));
  if (years.length + quarters.length === 0) return null;
  return [
    "Balance sheet and leverage (debt and cash at the period end; Net debt / EBITDA and Total debt / EBITDA = times the EBITDA of the 12 months to that date, a negative net debt = more cash than debt; interest cover = operating income / interest expense over the same 12 months):",
    years.length ? table(catalog, years, 4) : null,
    quarters.length ? `Quarters:\n${table(catalog, quarters, 4)}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

const minusYear = (ym: string) => (ym ? `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}` : "");

export function table(catalog: Map<string, StoredSeries>, keys: string[], last: number): string {
  const rows = keys.map((k) => catalog.get(k)).filter((s): s is StoredSeries => !!s);
  if (rows.length === 0) return "none";
  const periods = [...new Set(rows.flatMap((s) => [...s.points.keys()]))].sort().slice(-last);
  return [`period | ${periods.join(" | ")}`, ...rows.map((s) => `${s.label} [${s.key}] | ${periods.map((p) => fmt(s.points.get(p), s.unit)).join(" | ")}`)].join("\n");
}

export async function gatherFacts(db: Db, symbol: string): Promise<AnalysisFacts> {
  const [ticker] = await db.select().from(gold.tickers).where(eq(gold.tickers.symbol, symbol));
  const [profile] = await db.select().from(gold.companyProfiles).where(eq(gold.companyProfiles.symbol, symbol));
  const [quote] = await db.select().from(gold.quotes).where(eq(gold.quotes.symbol, symbol));
  const [valuation] = await db.select().from(valuations).where(eq(valuations.symbol, symbol));
  const cons = await db.select().from(consensus).where(eq(consensus.symbol, symbol));
  const [fairValue] = await db.select().from(fairValues).where(eq(fairValues.symbol, symbol));
  const [vreport] = await db.select({ summary: valuationReports.summary }).from(valuationReports).where(eq(valuationReports.symbol, symbol));
  const catalog = await seriesCatalog(db, symbol);
  const currency = valuation?.currency ?? profile?.currency ?? null;
  const streams = await db.select().from(revenueStreams).where(eq(revenueStreams.symbol, symbol));
  const halves = HALF_LINES.filter((k) => catalog.has(k));
  const price = catalog.get("price");
  const closes = price ? [...price.points].sort((a, b) => a[0].localeCompare(b[0])).slice(-24) : [];
  const upcoming = cons.filter((c) => c.mean !== null && c.periodType === "year").sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

  const stable = [
    `Company: ${profile?.name ?? symbol} (${symbol}), market ${ticker?.market ?? "?"}, ${[profile?.sector, profile?.industry].filter(Boolean).join(" / ") || "sector unknown"}.`,
    profile?.description ? `Description: ${profile.description.slice(0, 600)}` : null,
    `Analyst position: ${ticker?.position ?? "watch"}${ticker?.inPortfolio ? ", in his portfolio" : ""}.`,
    ticker?.thesisNote ? `Analyst's note: ${ticker.thesisNote}` : null,
    "",
    `Reported financials, fiscal years (${currency ?? "currency unknown"}; B = billion, M = million):`,
    table(catalog, TABLE_LINES, 6),
    "",
    "Last quarters:",
    table(catalog, QUARTER_LINES, 6),
    halves.length ? `\nLast half years:\n${table(catalog, halves, 6)}` : null,
    operatingText(catalog) ? `\n${operatingText(catalog)}` : null,
    streams.length ? `\n${streamsText(streams)}` : null,
    "",
    valuation
      ? `Valuation from gold: EV/EBITDA over fiscal years ${valuation.evEbitdaYears.join(", ") || "none"}: low ${fmt(valuation.evEbitdaLow, "multiple")}, median ${fmt(valuation.evEbitdaMedian, "multiple")}, high ${fmt(valuation.evEbitdaHigh, "multiple")}. Latest shares outstanding ${fmt(valuation.sharesOutstanding)}; net debt ${fmt(valuation.netDebt)} (${valuation.inputs["total-debt"]?.period ?? "n/a"}); EBITDA ${fmt(valuation.ebitda)} (${valuation.ebitdaBasis ?? "n/a"}).`
      : "Valuation: no financial statements collected.",
    upcoming.length ? `Analyst consensus (fiscal years): ${upcoming.map((c) => `${c.metric} ${c.periodEnd}: mean ${fmt(c.mean, c.metric === "eps" ? "per-share" : "currency")}, ${c.analysts ?? "?"} analysts${c.actual !== null ? `, reported ${fmt(c.actual, c.metric === "eps" ? "per-share" : "currency")}` : ""}`).join("; ")}.` : "Analyst consensus: none published for free.",
    "",
    closes.length ? `Price path, month-end closes (${price!.currency ?? ""}): ${closes.map(([m, v]) => `${m} ${fmt(v, "per-share")}`).join("; ")}` : "Price path: none collected.",
    "Analyst consensus history: only the current consensus is collected (no revisions).",
  ]
    .filter((x) => x !== null)
    .join("\n");

  // Leverage against earnings reaches the model now, outside the hash: the analysis rewrite that reads it is one
  // ANALYSIS_VERSION bump (INFLECTION-1117 PR-D), never a second wave of rewrites from this block alone.
  const leverage = balanceText(catalog);
  // The significant unbiased moves and their events: out of the hash (a new move never rewrites the story by itself).
  const moves = await movesText(db, symbol);

  // What Thierry himself asked, thinks and knows (pushed by his Claude, gold.thierry_inputs): out of the hash, an input the model weighs at the next rewrite, never a reason to rewrite and never an override.
  const notes = await notesText(db, symbol);

  const q = quote ? { close: quote.close, date: quote.date, currency: quote.currency, stamp: quoteStamp(quote) } : null;
  const fvLine = fairValue
    ? `Fair value (weighted from several valuation methods): ${fmt(fairValue.value, "per-share")} ${fairValue.currency ?? ""}${fairValue.low !== null && fairValue.high !== null ? `, range ${fmt(fairValue.low, "per-share")} to ${fmt(fairValue.high, "per-share")}` : ""}; ${fairValue.method ?? ""}.${vreport ? ` ${vreport.summary}` : ""}`
    : "Fair value: none yet (no valuation ran).";
  // How the fair value moved (the model weighs it when it decides the side of the story): out of the hash, its bucket is in.
  const fvHistory = await fairValueHistoryLine(db, symbol);
  const fvBucket = fairValue && fairValue.value > 0 ? Math.round(Math.log(fairValue.value) / Math.log(1.15)) : "none";
  const priceLine = q ? `Quote: ${fmt(q.close, "per-share")} ${q.currency ?? ""} (${q.stamp}); market cap at that price ${valuation?.marketCap ? fmt(valuation.marketCap) : "n/a"}, EV/EBITDA now ${fmt(valuation?.evEbitda, "multiple")}.` : "Quote: none.";
  const bucket = q && q.close > 0 ? Math.round(Math.log(q.close) / Math.log(1.15)) : "none";
  return {
    symbol,
    text: `${priceLine}\n${fvLine}\n${fvHistory}\n${stable}${leverage ? `\n\n${leverage}` : ""}${moves.text ? `\n\n${moves.text}` : ""}${notes ? `\n\n${notes}` : ""}`,
    hash: fnv(`${stable}\nprice-bucket:${bucket}\nfair-value-bucket:${fvBucket}`),
    catalog,
    quote: q,
    currency,
    // Annual revenue, reported or derived from what the company reported (gross profit + cost of revenue, 4 quarters).
    hasFinancials: catalog.has("line:revenue") || catalog.has("metric:revenue"),
  };
}
