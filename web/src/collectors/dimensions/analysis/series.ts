import { eq } from "drizzle-orm";
import type { ExhibitSeries } from "@/db/schema/analysis";
import { consensus } from "@/db/schema/consensus";
import { financialMetrics, goldFinancialLines } from "@/db/schema/financials";
import type { Db } from "@/db/types";
import { LINES, type LineKey } from "../financials/lines";

/**
 * The stored series of a ticker (gold), what a Price Driver is measured on and the judges read: every number comes
 * from here, never from the model. Keys:
 *   line:<line> / hline:<line> / qline:<line>   reported line, fiscal years / half years / quarters (gold.financial_lines)
 *   metric:<m> / hmetric:<m> / qmetric:<m>   derived metric, fiscal years / half years / quarters (gold.financial_metrics)
 *   consensus:<m> / actual:<m>        analyst mean vs reported actual per fiscal year (gold.consensus)
 *   qconsensus:<m> / qactual:<m>      same per quarter
 *   price                             month-end close, 5 years
 */
export type StoredSeries = ExhibitSeries & { periodType: "year" | "half" | "quarter" | "month"; points: Map<string, number> };

const titleCase = (s: string) => s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const METRIC_NAMES: Record<string, string> = {
  revenue: "Revenue (derived)",
  ebitda: "EBITDA",
  fcf: "Free cash flow",
  "net-debt": "Net debt",
  "gross-margin": "Gross margin",
  "operating-margin": "Operating margin",
  "net-margin": "Net margin",
  "ebitda-margin": "EBITDA margin",
  "fcf-margin": "FCF margin",
  "revenue-growth": "Revenue growth",
  "operating-income-growth": "Operating income growth",
  "market-cap": "Market cap",
  ev: "Enterprise value",
  "ev-ebitda": "EV/EBITDA",
  pe: "P/E",
  "backlog-to-revenue": "Backlog / last 12 months revenue",
  "backlog-growth": "Backlog growth",
  "remaining-performance-obligations-to-revenue": "Remaining performance obligations / last 12 months revenue",
  "remaining-performance-obligations-growth": "Remaining performance obligations growth",
  "book-to-bill": "Book-to-bill",
  "net-debt-to-ebitda": "Net debt / EBITDA",
  "total-debt-to-ebitda": "Total debt / EBITDA",
  "interest-cover": "Interest cover (operating income / interest expense)",
};

export async function seriesCatalog(db: Db, symbol: string): Promise<Map<string, StoredSeries>> {
  const out = new Map<string, StoredSeries>();
  const put = (key: string, base: Omit<StoredSeries, "key" | "points" | "sources">, period: string, value: number, sources: string[]) => {
    const s = out.get(key) ?? { key, ...base, sources: [], points: new Map<string, number>() };
    s.points.set(period, value);
    s.sources = [...new Set([...s.sources, ...sources])].sort();
    out.set(key, s);
  };
  for (const l of await db.select().from(goldFinancialLines).where(eq(goldFinancialLines.symbol, symbol))) {
    if (l.line === "share-price") {
      put("price", { label: "Share price (month-end close)", unit: "per-share", currency: l.currency, periodType: "month" }, l.periodEnd, l.value, l.sources);
      continue;
    }
    if (l.periodType === "month") continue;
    const name = l.line.startsWith("segment:") ? `Segment revenue: ${l.line.split(":").slice(2).join(":")}` : (LINES[l.line as LineKey]?.name ?? titleCase(l.line));
    const unit = /^eps-/.test(l.line) ? "per-share" : /^shares-/.test(l.line) ? "count" : "currency";
    const prefix = { year: "line", half: "hline", quarter: "qline" }[l.periodType];
    const suffix = { year: "", half: " (half-yearly)", quarter: " (quarterly)" }[l.periodType];
    put(`${prefix}:${l.line}`, { label: `${name}${suffix}`, unit, currency: unit === "count" ? null : l.currency, periodType: l.periodType }, l.periodEnd, l.value, l.sources);
  }
  for (const m of await db.select().from(financialMetrics).where(eq(financialMetrics.symbol, symbol))) {
    const name = METRIC_NAMES[m.metric] ?? titleCase(m.metric);
    const prefix = { year: "metric", half: "hmetric", quarter: "qmetric" }[m.periodType];
    const suffix = { year: "", half: " (half-yearly)", quarter: " (quarterly)" }[m.periodType];
    put(`${prefix}:${m.metric}`, { label: `${name}${suffix}`, unit: m.unit, currency: m.currency, periodType: m.periodType }, m.periodEnd, m.value, m.sources);
  }
  for (const c of await db.select().from(consensus).where(eq(consensus.symbol, symbol))) {
    const q = c.periodType === "quarter";
    const name = titleCase(c.metric);
    const unit = c.metric === "eps" ? "per-share" : "currency";
    const srcOf = (stat: string) => c.provenance[stat]?.sources ?? [];
    if (c.mean !== null) put(`${q ? "qconsensus" : "consensus"}:${c.metric}`, { label: `${name}, analyst mean${q ? " (quarterly)" : ""}`, unit, currency: c.currency, periodType: c.periodType }, c.periodEnd, c.mean, srcOf("mean"));
    if (c.actual !== null) put(`${q ? "qactual" : "actual"}:${c.metric}`, { label: `${name}, reported${q ? " (quarterly)" : ""}`, unit, currency: c.currency, periodType: c.periodType }, c.periodEnd, c.actual, srcOf("actual"));
  }
  return out;
}

/**
 * The finest period a company reports for a figure since a date: a yearly key (`metric:`, `line:`) falls back on its
 * quarterly twin (`qmetric:`), else its half-yearly one (`hmetric:`, a company reporting every six months), when that
 * twin has at least 2 points since then; else the key itself.
 */
export function finestSeries(catalog: Map<string, StoredSeries>, key: string, since: string): StoredSeries | undefined {
  if (key.startsWith("metric:") || key.startsWith("line:")) {
    for (const p of ["q", "h"]) {
      const twin = catalog.get(`${p}${key}`);
      if (twin && [...twin.points.keys()].filter((d) => d >= since).length >= 2) return twin;
    }
  }
  return catalog.get(key);
}
